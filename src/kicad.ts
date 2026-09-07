/*
  the kicad side helpers :) two files the cli writes to ~/.pcbcode on startup so
  the agent has one reliable way to save and reload inside kicad:

  kicad-helper.py  the front door. run it with the venv python. "status" says
                   which editors are open (asked over the kicad api, not lock
                   files), "save sch|pcb" and "revert sch|pcb" pick the right
                   route: the api for the board (and the schematic on kicad 11+),
                   or the applescript below for the schematic on kicad 10. before
                   ui scripting it checks macos accessibility and, if missing,
                   pops the system prompt and opens the settings pane naming the
                   terminal app that needs ticking.
  kicad-reload.applescript  macos only. raises the right kicad window, clicks
                   file > save or file > revert and confirms the dialog.

  usage: $KIPY ~/.pcbcode/kicad-helper.py revert sch
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".pcbcode");
export const RELOAD_SCRIPT = path.join(DIR, "kicad-reload.applescript");
export const HELPER_SCRIPT = path.join(DIR, "kicad-helper.py");

const SCRIPT = `on run argv
  set suffix to item 1 of argv
  set mode to item 2 of argv
  if mode is "save" then
    set menuName to "Save"
  else
    set menuName to "Revert"
  end if
  tell application "KiCad" to activate
  delay 0.3
  tell application "System Events"
    tell process "kicad"
      set target to missing value
      set targetName to ""
      repeat with w in windows
        try
          if name of w ends with suffix then
            set target to w
            set targetName to name of w
          end if
        end try
      end repeat
      if target is missing value then return "no window ending in '" & suffix & "' is open"
      perform action "AXRaise" of target
      delay 0.3
      click menu item menuName of menu "File" of menu bar 1
      if mode is "save" then
        delay 0.5
        return "saved " & targetName
      end if
      repeat 40 times
        delay 0.1
        repeat with w in windows
          try
            if exists button "Yes" of w then
              click button "Yes" of w
              return "reloaded " & targetName
            end if
          end try
        end repeat
      end repeat
      return "revert clicked but no confirmation appeared for " & targetName
    end tell
  end tell
end run
`;

const HELPER = `#!/usr/bin/env python3
"""
pcb code's kicad helper :) one command that knows how to save and reload the
board and the schematic no matter which door is open. the cli writes it to
~/.pcbcode/kicad-helper.py on startup. run it with the venv python so kipy is
importable, but it degrades gracefully when it is not.

  kicad-helper.py status              what is open, what works, what is missing
  kicad-helper.py save    sch|pcb     save from kicad so disk matches memory
  kicad-helper.py revert  sch|pcb     reload from disk (revert) inside kicad
  kicad-helper.py accessibility       check macos accessibility, prompt if needed

exit codes: 0 done, 1 could not do it (message says why), 2 nothing to do
(the editor is not open, so the file loads fresh when the user opens it).
"""
import json
import os
import subprocess
import sys

HOME = os.path.expanduser("~")
RELOAD_SCRIPT = os.path.join(HOME, ".pcbcode", "kicad-reload.applescript")
SUFFIX = {"sch": "Schematic Editor", "pcb": "PCB Editor"}
LOCK_EXT = {"sch": ".kicad_sch", "pcb": ".kicad_pcb"}
ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"


def say(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- kicad api --

class Api:
    """thin wrapper around kipy that answers 'is this editor open' reliably"""

    def __init__(self):
        self.error = None
        self.kicad = None
        self.version = None
        try:
            from kipy import KiCad
            self.kicad = KiCad()
            self.version = self.kicad.get_version()
        except ImportError:
            self.error = "kipy is not installed in ~/.pcbcode/venv"
        except Exception as e:  # ConnectionError from kipy, socket errors, etc
            self.error = f"{type(e).__name__}: {e}"

    @property
    def on(self):
        return self.kicad is not None

    def major(self):
        return self.version.major if self.version else 0

    def doc(self, kind):
        """returns the open document of that kind, or None when the editor is closed"""
        if not self.on:
            return None
        from kipy.proto.common.types.base_types_pb2 import DOCTYPE_PCB, DOCTYPE_SCHEMATIC
        t = DOCTYPE_PCB if kind == "pcb" else DOCTYPE_SCHEMATIC
        try:
            docs = list(self.kicad.get_open_documents(t))
        except Exception:
            # "no handler available" means no editor of that kind registered with
            # the api server, which is exactly "that editor is not open"
            return None
        return docs[0] if docs else None

    def editor(self, kind):
        """kipy object with save() and revert(), or None"""
        d = self.doc(kind)
        if d is None:
            return None
        if kind == "pcb":
            from kipy.board import Board
            return Board(self.kicad._client, d)
        if self.major() >= 11:
            from kipy.schematic import Schematic
            return Schematic(self.kicad._client, d)
        return None  # kicad 10 exposes the schematic editor but cannot save/revert it


# ------------------------------------------------------------ mac helpers ----

def host_app():
    """walk up the process tree to the .app that owns this terminal, for the
    accessibility instructions (that is the app macos wants ticked)"""
    pid = os.getpid()
    for _ in range(12):
        try:
            out = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        except Exception:
            break
        if not out:
            break
        ppid, _, comm = out.partition(" ")
        comm = comm.strip()
        if ".app/" in comm and "/Frameworks/" not in comm:
            name = comm.split(".app/")[0].rsplit("/", 1)[-1]
            if name not in ("Python", "python3", "node"):
                return name
        try:
            pid = int(ppid)
        except ValueError:
            break
        if pid <= 1:
            break
    return "your terminal app"


def jxa(expr):
    r = subprocess.run(["osascript", "-l", "JavaScript", "-e", expr], capture_output=True, text=True)
    return r.stdout.strip(), r.stderr.strip()


def accessibility_trusted():
    out, _ = jxa("ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()")
    return out == "true"


def accessibility_prompt():
    """asks macos to show its own 'X would like to control this computer' dialog
    (only appears the first time), and opens the accessibility pane either way"""
    jxa("ObjC.import('ApplicationServices'); $.AXIsProcessTrustedWithOptions("
        "$.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')))")
    subprocess.run(["open", ACCESSIBILITY_PANE], capture_output=True)


def ensure_accessibility():
    if accessibility_trusted():
        return True
    app = host_app()
    accessibility_prompt()
    say(f"macOS is blocking UI scripting for {app}. I opened System Settings > Privacy & Security > Accessibility: "
        f"turn on {app} there (add it with + if it is not listed), then run this again. "
        f"If it was already ticked, restart {app} so the permission takes effect.")
    return False


def lock_open(kind):
    """fallback when the api is off: kicad keeps ~name.ext.lck next to open files"""
    for f in os.listdir("."):
        if f.startswith("~") and f.endswith(LOCK_EXT[kind] + ".lck"):
            return True
    return False


def applescript(kind, mode):
    if not os.path.exists(RELOAD_SCRIPT):
        say(f"missing {RELOAD_SCRIPT}; restart pcbcode to recreate it")
        return 1
    if not ensure_accessibility():
        return 1
    r = subprocess.run(["osascript", RELOAD_SCRIPT, SUFFIX[kind], mode], capture_output=True, text=True)
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    if r.returncode != 0 or "assistive access" in err or "-25211" in err or "-1719" in err:
        app = host_app()
        say(f"UI scripting failed: {err or out}. Check that {app} is ticked under System Settings > Privacy & Security > Accessibility, then retry.")
        return 1
    if out.startswith("no window"):
        say(f"the {SUFFIX[kind]} is not open; the file loads fresh from disk when the user opens it")
        return 2
    if out.startswith("revert clicked but"):
        say(out + ". KiCad may have shown a different dialog; ask the user to confirm the reload in KiCad.")
        return 1
    say(out)
    return 0


# ------------------------------------------------------------- commands ------

def cmd_status():
    api = Api()
    info = {
        "platform": sys.platform,
        "api": "on" if api.on else f"off ({api.error})",
        "kicad": str(api.version) if api.version else None,
        "pcb_editor": "open" if api.doc("pcb") else ("closed" if api.on else ("open (lock file)" if lock_open("pcb") else "closed (no lock file)")),
        "schematic_editor": "open" if api.doc("sch") else ("closed" if api.on else ("open (lock file)" if lock_open("sch") else "closed (no lock file)")),
        "schematic_via_api": bool(api.on and api.major() >= 11),
        "accessibility": "trusted" if sys.platform == "darwin" and accessibility_trusted() else "not trusted",
        "host_app": host_app() if sys.platform == "darwin" else None,
    }
    say(json.dumps(info, indent=2))
    return 0


def cmd_edit(mode, kind):
    if kind not in SUFFIX:
        say("second argument must be sch or pcb")
        return 1
    api = Api()
    if api.on:
        ed = api.editor(kind)
        if ed is not None:
            getattr(ed, mode)()
            say(f"{'saved' if mode == 'save' else 'reloaded'} the {SUFFIX[kind]} through the KiCad API")
            return 0
        if api.doc(kind) is None:
            say(f"the {SUFFIX[kind]} is not open; the file loads fresh from disk when the user opens it")
            return 2
        # kicad 10 schematic: open, but the api cannot save or revert it yet
    elif not lock_open(kind):
        say(f"KiCad API is off ({api.error}) and there is no lock file, so the {SUFFIX[kind]} is not open; "
            f"the file loads fresh from disk when the user opens it")
        return 2
    else:
        say(f"note: KiCad API is off ({api.error}); falling back to UI scripting. "
            f"Enabling it (KiCad Preferences > Plugins > Enable KiCad API) makes board reloads silent.")
    if sys.platform != "darwin":
        say(f"the {SUFFIX[kind]} is open but I cannot reload it from here (API cannot reach it and there is no UI scripting on this OS). "
            f"Ask the user to use File > {'Save' if mode == 'save' else 'Revert'} in KiCad.")
        return 1
    return applescript(kind, mode)


def cmd_accessibility():
    if sys.platform != "darwin":
        say("not macOS, nothing to check")
        return 0
    if accessibility_trusted():
        say(f"accessibility is granted for {host_app()}")
        return 0
    ensure_accessibility()
    return 1


def main(argv):
    if len(argv) < 2 or argv[1] not in ("status", "save", "revert", "accessibility"):
        say(__doc__)
        return 1
    if argv[1] == "status":
        return cmd_status()
    if argv[1] == "accessibility":
        return cmd_accessibility()
    if len(argv) < 3:
        say(f"usage: kicad-helper.py {argv[1]} sch|pcb")
        return 1
    return cmd_edit(argv[1], argv[2])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

const writeIfChanged = (file: string, content: string) => {
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) fs.writeFileSync(file, content);
};

export const ensureReloadScript = () => {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    writeIfChanged(HELPER_SCRIPT, HELPER);
    if (process.platform === "darwin") writeIfChanged(RELOAD_SCRIPT, SCRIPT);
  } catch {}
};
