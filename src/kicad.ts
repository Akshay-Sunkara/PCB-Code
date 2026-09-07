/*
  the macos helper for editors kicad's api can't reach (the schematic editor, for
  now) :) it's an applescript that raises the right kicad window, then clicks
  file > save or file > revert and confirms the dialog, so the agent can do the
  same save -> edit -> revert dance it does for boards. the cli writes it to
  ~/.pcbcode/kicad-reload.applescript on startup and the prompt tells the agent
  how to call it. needs accessibility permission for your terminal app once.
  usage: osascript ~/.pcbcode/kicad-reload.applescript "Schematic Editor" revert
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RELOAD_SCRIPT = path.join(os.homedir(), ".pcbcode", "kicad-reload.applescript");

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

export const ensureReloadScript = () => {
  if (process.platform !== "darwin") return;
  try {
    fs.mkdirSync(path.dirname(RELOAD_SCRIPT), { recursive: true });
    if (!fs.existsSync(RELOAD_SCRIPT) || fs.readFileSync(RELOAD_SCRIPT, "utf8") !== SCRIPT) fs.writeFileSync(RELOAD_SCRIPT, SCRIPT);
  } catch {}
};
