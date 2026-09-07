/*
  paste helpers :) big multi-line pastes get folded into a "[Pasted text #1 +12
  lines]" placeholder in the input so the prompt stays readable, and expand back
  to the full text when you hit enter. ctrl+v grabs an image off the macos
  clipboard (via osascript, no extra tools) and drops a "[Image #1]" placeholder
  that turns into a real image attachment on send. a pasted path to a file that
  exists becomes an @path attachment, which is what happens when you drag a file
  into the terminal. small things that make it feel like claude code! ^_^
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type Pending = { pastes: Map<number, string>; images: Map<number, string> };

export const newPending = (): Pending => ({ pastes: new Map(), images: new Map() });

export const PLACEHOLDER = /\[(?:Pasted text|Image) #(\d+)(?: \+\d+ lines)?\]$/;

export const readClipboardImage = (): string | null => {
  if (process.platform !== "darwin") return null;
  const file = path.join(os.tmpdir(), `pcbcode-clip-${Date.now()}.png`);
  try {
    execFileSync("osascript", [
      "-e", `set f to POSIX file "${file}"`,
      "-e", "set d to the clipboard as «class PNGf»",
      "-e", "set fh to open for access f with write permission",
      "-e", "write d to fh",
      "-e", "close access fh",
    ], { stdio: "ignore", timeout: 5000 });
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? file : null;
  } catch {
    return null;
  }
};

export const asDroppedPath = (text: string): string | null => {
  const p = text.trim().replace(/\\ /g, " ").replace(/^['"]|['"]$/g, "");
  if (!p || /\s/.test(p) === false && !p.includes("/") && !p.startsWith("~")) return null;
  const abs = path.resolve(p.replace(/^~/, os.homedir()));
  return fs.existsSync(abs) ? abs : null;
};

export const expand = (value: string, pending: Pending) =>
  value.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, n) => pending.pastes.get(Number(n)) ?? m);
