/*
  tools! this is what the model can actually *do* :) there are three: bash (runs a
  shell command inside the working folder with a timeout and gets killed on esc),
  grep (regex search across project files, skipping binaries and huge stuff), and
  openai's built-in web search which needs no code on our side at all. each tool
  hands back the full output for the model plus a short summary and a little
  preview for the screen. the label helper turns a call into the "Bash(...)" style
  line you see in the transcript. go tools go! \o/
*/
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { BASH_TIMEOUT, MAX_OUTPUT, getWorkDir } from "./config.js";

export type ToolOutcome = { output: string; summary: string; body?: string };

export const TOOLS: OpenAI.Responses.Tool[] = [
  {
    type: "function", name: "bash", strict: false,
    description: "Run a shell command in the project folder and return its output. Use it to list, read, create, and edit files, and to run kicad-cli, git, or builds.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string", description: "Short description of what the command does, shown to the user" },
      },
      required: ["command"],
    },
  },
  {
    type: "function", name: "grep", strict: false,
    description: "Search file contents in the project folder with a regular expression. Returns file:line:text matches.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        glob: { type: "string", description: "Only search files matching this glob, default **/*" },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  { type: "web_search" },
];

export const cap = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… (${s.length - MAX_OUTPUT} more chars truncated)` : s);

const isBinary = (abs: string) => fs.readFileSync(abs).subarray(0, 1024).includes(0);

export const projectFiles = (glob = "**/*", root = getWorkDir()) =>
  fs
    .globSync(glob, { cwd: root, exclude: (f: string) => f.startsWith("node_modules") || f.startsWith(".git") })
    .filter((f) => fs.statSync(path.join(root, f)).isFile())
    .sort();

export const runGrep = (a: { pattern: string; glob?: string; ignore_case?: boolean }): ToolOutcome => {
  const re = new RegExp(a.pattern, a.ignore_case ? "i" : "");
  const hits: string[] = [];
  const filesHit = new Set<string>();
  for (const f of projectFiles(a.glob || "**/*")) {
    const abs = path.join(getWorkDir(), f);
    if (fs.statSync(abs).size > 2_000_000 || isBinary(abs)) continue;
    fs.readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
      if (hits.length < 500 && re.test(line)) { hits.push(`${f}:${i + 1}:${line.trim().slice(0, 200)}`); filesHit.add(f); }
    });
  }
  return {
    output: cap(hits.join("\n") || "No matches found."),
    summary: `Found ${hits.length} match${hits.length === 1 ? "" : "es"} in ${filesHit.size} file${filesHit.size === 1 ? "" : "s"}`,
  };
};

export const runBash = (a: { command: string }, signal: AbortSignal): Promise<ToolOutcome> =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-lc", a.command], { cwd: getWorkDir(), env: process.env });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), BASH_TIMEOUT);
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const text = out.trimEnd();
      const lines = text ? text.split("\n") : [];
      const shown = lines.slice(0, 5).join("\n") + (lines.length > 5 ? `\n… +${lines.length - 5} lines` : "");
      resolve({
        output: cap(text || "(no output)") + (code ? `\n[exit code ${code}]` : ""),
        summary: lines.length ? lines[0] : "(no output)",
        body: lines.length > 1 ? shown.split("\n").slice(1).join("\n") : undefined,
      });
    });
  });

export const label = (name: string, args: any) =>
  name === "bash" ? `Bash(${String(args.command).split("\n")[0].slice(0, 80)})`
  : name === "grep" ? `Grep(${args.pattern}${args.glob ? ` in ${args.glob}` : ""})`
  : name;
