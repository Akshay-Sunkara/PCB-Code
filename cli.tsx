// Run with:
//   npm init -y && npm pkg set type=module && npm i ink react openai tsx
//   echo 'OPENAI_API_KEY=sk-...' > .env
//   npx tsx cli.tsx
import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

process.loadEnvFile(path.join(import.meta.dirname, ".env"));
const client = new OpenAI();
const MODEL = "gpt-6-astra";

// Working folder: `pcbcode /path/to/project`, else the folder you launched from.
// Attaching a folder with @path in a prompt switches it for the rest of the session.
let workDir = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
  console.error(`Not a folder: ${workDir}`);
  process.exit(1);
}

const system = () => `You are PCB Code, a concise assistant for KiCad and electronics design.
You are working inside the project folder ${workDir}. Work out of that folder: run commands there and use paths relative to it.
Use bash to read, create, and edit files, run kicad-cli, git, and anything else; use grep to search file contents; use web search for anything outside the project.
Read a file (for example with cat -n) before editing it. Edit with small, targeted commands such as sed, python, or a heredoc, and keep edits minimal.
KiCad files (.kicad_sch, .kicad_pcb, .kicad_pro) are S-expressions; keep parentheses balanced.

Editing files that KiCad has open:
- Before editing a KiCad file, check for a lock file named ~<filename>.lck next to it (ls -a). If it exists the file is open in KiCad. Never delete lock files.
- If the file is open, always use this sequence so nothing is lost whether or not KiCad has unsaved changes:
  1. Save from KiCad through its IPC API so the file on disk matches what KiCad has in memory:
     python3 -c "from kipy import KiCad; KiCad().get_board().save()"
  2. Edit the file on disk. Write atomically: write to a temp file in the same folder, then mv it over the original.
  3. Reload in KiCad through the API so it picks up the edit:
     python3 -c "from kipy import KiCad; KiCad().get_board().revert()"
  Do this save-edit-revert sequence every time; saving first is a no-op if there were no unsaved changes.
- First check that the API is usable with: python3 -c "from kipy import KiCad; KiCad().get_board()". If that fails, tell the user the cause: kipy missing (fix: pip3 install kicad-python) or the IPC server off (fix: KiCad Preferences > Plugins > Enable IPC API server, then restart KiCad). Then fall back to: edit the file on disk, and only if KiCad is running bring it to the front with pgrep -f KiCad.app >/dev/null && osascript -e 'tell application "KiCad" to activate', and tell the user to accept the reload prompt and not to save in KiCad before reloading. Never launch KiCad yourself.
- The API works for boards (.kicad_pcb). For schematics (.kicad_sch), try the same calls with get_schematic() if the client supports it; otherwise use the fallback route.
- After changing a schematic, remind the user to run Update PCB from Schematic in KiCad.

Files and folders the user attached with @ are already described in the message.`;

const ORANGE = "#D97757";
const BAR = "#2A2A2A"; // background of the user prompt bar
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const VERBS = ["Sautéed", "Baked", "Simmered", "Brewed", "Whisked", "Roasted", "Cooked", "Stewed"];
const MAX_OUTPUT = 30_000; // chars of tool output sent back to the model
const BASH_TIMEOUT = 120_000;

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS: OpenAI.Responses.Tool[] = [
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

const cap = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… (${s.length - MAX_OUTPUT} more chars truncated)` : s);
const isBinary = (abs: string) => fs.readFileSync(abs).subarray(0, 1024).includes(0);

const projectFiles = (glob = "**/*", root = workDir) =>
  fs
    .globSync(glob, { cwd: root, exclude: (f: string) => f.startsWith("node_modules") || f.startsWith(".git") })
    .filter((f) => fs.statSync(path.join(root, f)).isFile())
    .sort();

type ToolOutcome = { output: string; summary: string; body?: string };

const runGrep = (a: { pattern: string; glob?: string; ignore_case?: boolean }): ToolOutcome => {
  const re = new RegExp(a.pattern, a.ignore_case ? "i" : "");
  const hits: string[] = [];
  const filesHit = new Set<string>();
  for (const f of projectFiles(a.glob || "**/*")) {
    const abs = path.join(workDir, f);
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

const runBash = (a: { command: string }, signal: AbortSignal): Promise<ToolOutcome> =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-lc", a.command], { cwd: workDir, env: process.env });
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

const label = (name: string, args: any) =>
  name === "bash" ? `Bash(${String(args.command).split("\n")[0].slice(0, 80)})`
  : name === "grep" ? `Grep(${args.pattern}${args.glob ? ` in ${args.glob}` : ""})`
  : name;

// ── Attachments: @path in the prompt ──────────────────────────────────────────
const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

type Attachment = { name: string; abs: string; mime?: string; lines?: number; dir?: boolean; files?: string[] };

const parseAttachments = (prompt: string): Attachment[] => {
  const out: Attachment[] = [];
  for (const m of prompt.matchAll(/(?:^|\s)@(\S+)/g)) {
    const p = m[1].replace(/^~/, process.env.HOME ?? "~");
    const abs = path.resolve(workDir, p);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      out.push({ name: m[1], abs, dir: true, files: projectFiles("**/*", abs) });
      continue;
    }
    const mime = IMAGE_EXT[path.extname(abs).toLowerCase()];
    out.push(mime ? { name: m[1], abs, mime } : { name: m[1], abs, lines: fs.readFileSync(abs, "utf8").split("\n").length });
  }
  return out;
};

const buildUserContent = (prompt: string, files: Attachment[]): OpenAI.Responses.ResponseInputContent[] => [
  { type: "input_text", text: prompt },
  ...files.map<OpenAI.Responses.ResponseInputContent>((f) => {
    if (f.dir) {
      const list = f.files!.slice(0, 200).join("\n") + (f.files!.length > 200 ? `\n… ${f.files!.length - 200} more` : "");
      return { type: "input_text", text: `<folder path="${f.abs}">\n${list || "(empty)"}\n</folder>\nThis folder is now the working folder. Work out of it.` };
    }
    if (f.mime) return { type: "input_image", detail: "auto", image_url: `data:${f.mime};base64,${fs.readFileSync(f.abs).toString("base64")}` };
    return { type: "input_text", text: `<file path="${f.name}">\n${cap(fs.readFileSync(f.abs, "utf8"))}\n</file>` };
  }),
];

// ── Display model ─────────────────────────────────────────────────────────────
type Item =
  | { kind: "user"; text: string; attachments: Attachment[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string; summary: string; body?: string; error?: boolean }
  | { kind: "done"; verb: string; seconds: number; done: string };

type Approval = { command: string; note?: string; resolve: (choice: "yes" | "always" | "no") => void };

const useColumns = () => {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns || 80);
  useEffect(() => {
    const onResize = () => setCols(stdout.columns || 80);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return cols;
};

const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// ── Minimal markdown: **bold** and `code`, wrapped by hand ────────────────────
// Ink wraps styled text without trimming, which leaves a stray space at the start
// of a continued line when a bold phrase breaks. Wrapping here avoids that.
type Run = { text: string; bold?: boolean; code?: boolean };

const parseInline = (line: string): Run[] =>
  line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((p) =>
    p.startsWith("**") ? { text: p.slice(2, -2), bold: true }
    : p.startsWith("`") ? { text: p.slice(1, -1), code: true }
    : { text: p },
  );

const wrapRuns = (runs: Run[], width: number): Run[][] => {
  const lines: Run[][] = [[]];
  let len = 0;
  const cur = () => lines[lines.length - 1];
  for (const run of runs) {
    for (const word of run.text.split(/(\s+)/)) {
      if (!word) continue;
      const space = /^\s+$/.test(word);
      if (len > 0 && len + word.length > width) {
        lines.push([]);
        len = 0;
        if (space) continue; // the space at a wrap point disappears
      }
      if (space && len === 0) continue; // never start a line with whitespace
      let w = word;
      while (w.length > width) { // hard-break words longer than a line
        cur().push({ ...run, text: w.slice(0, width) });
        lines.push([]);
        w = w.slice(width);
        len = 0;
      }
      cur().push({ ...run, text: w });
      len += w.length;
    }
  }
  return lines;
};

// Fenced ``` blocks are shown verbatim in cyan; everything else gets inline parsing.
const toRuns = (text: string): Run[][] => {
  let fence = false;
  const out: Run[][] = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) { fence = !fence; continue; }
    out.push(fence ? [{ text: line, code: true }] : parseInline(line));
  }
  return out;
};

const Markdown = ({ text, width }: { text: string; width: number }) => (
  <Box flexDirection="column">
    {toRuns(text).flatMap((line, li) =>
      wrapRuns(line, Math.max(10, width)).map((runs, wi) => (
        <Text key={`${li}-${wi}`}>
          {runs.length ? runs.map((r, i) => <Text key={i} bold={r.bold} color={r.code ? "cyan" : undefined}>{r.text}</Text>) : " "}
        </Text>
      )),
    )}
  </Box>
);

// ── Welcome box ───────────────────────────────────────────────────────────────
const Welcome = ({ cwd }: { cwd: string }) => (
  <Box borderStyle="round" borderColor={ORANGE} paddingX={1} flexDirection="column">
    <Text>
      <Text color={ORANGE}>✻</Text> Welcome to <Text bold>PCB Code</Text>!
    </Text>
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text dimColor>An open-source project that brings AI into your KiCad workflow.</Text>
      <Text dimColor>Try it out and share any feedback! Attach files or folders with @path.</Text>
    </Box>
    <Box marginTop={1} marginLeft={2}>
      <Text dimColor>cwd: {cwd.replace(process.env.HOME ?? "", "~")}</Text>
    </Box>
  </Box>
);

// ── Chat turns ────────────────────────────────────────────────────────────────
const UserMessage = ({ text, attachments }: { text: string; attachments: Attachment[] }) => (
  <Box flexDirection="column">
    <Box width="100%" backgroundColor={BAR}>
      <Text bold>{"❯ "}</Text>
      <Text bold>{text}</Text>
    </Box>
    {attachments.map((a, i) => (
      <Box key={i} marginLeft={2}>
        <Text dimColor>⎿  Attached {a.dir ? "folder " : ""}{a.name}{a.dir ? ` (${a.files!.length} files, now the working folder)` : a.mime ? " (image)" : ` (${a.lines} lines)`}</Text>
      </Box>
    ))}
  </Box>
);

const AssistantMessage = ({ text, cols }: { text: string; cols: number }) => (
  <Box>
    <Box width={2} flexShrink={0}><Text>●</Text></Box>
    <Box flexGrow={1}><Markdown text={text.trim()} width={cols - 4} /></Box>
  </Box>
);

const ToolMessage = ({ item }: { item: Extract<Item, { kind: "tool" }> }) => (
  <Box flexDirection="column">
    <Box>
      <Text color={item.error ? "red" : "green"}>● </Text>
      <Text bold>{item.label}</Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>⎿  </Text>
      <Text dimColor={!item.error} color={item.error ? "red" : undefined}>{item.summary}</Text>
    </Box>
    {item.body && <Box marginLeft={5}><Text dimColor>{item.body}</Text></Box>}
  </Box>
);

const DoneLine = ({ verb, seconds, done }: { verb: string; seconds: number; done: string }) => (
  <Text dimColor>✻ {verb} for {seconds}s · done {done}</Text>
);

// ── Spinner line ("Thinking…") ────────────────────────────────────────────────
const Spinner = ({ tokens }: { tokens: number }) => {
  const [frame, setFrame] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const a = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120);
    const b = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  return (
    <Box>
      <Text color={ORANGE}>{FRAMES[frame]} </Text>
      <Text color={ORANGE}>Thinking… </Text>
      <Text dimColor>({seconds}s · ↓ {tok} tokens · esc to interrupt)</Text>
    </Box>
  );
};

// ── Approval prompt (only in ask mode) ────────────────────────────────────────
const OPTIONS = ["Yes", "Yes, allow all commands during this session (shift+tab)", "No, and tell PCB Code what to do differently (esc)"];

const ApprovalPrompt = ({ approval, choice }: { approval: Approval; choice: number }) => (
  <Box borderStyle="round" borderColor={ORANGE} paddingX={1} flexDirection="column">
    <Text bold>Bash command</Text>
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      <Text>{approval.command}</Text>
      {approval.note && <Text dimColor>{approval.note}</Text>}
    </Box>
    <Box marginTop={1}><Text>Do you want to proceed?</Text></Box>
    {OPTIONS.map((o, i) => (
      <Text key={i} color={i === choice ? ORANGE : undefined}>{i === choice ? "❯ " : "  "}{i + 1}. {o}</Text>
    ))}
  </Box>
);

// ── Prompt input ──────────────────────────────────────────────────────────────
const Rule = ({ cols }: { cols: number }) => <Text dimColor>{"─".repeat(Math.max(0, cols - 2))}</Text>;

const Input = ({ value, cols, auto }: { value: string; cols: number; auto: boolean }) => (
  <Box flexDirection="column">
    <Rule cols={cols} />
    <Box>
      <Text>{"❯ "}</Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
    <Rule cols={cols} />
    <Box marginLeft={2}>
      {auto ? <Text color={ORANGE}>⏵⏵ auto mode on</Text> : <Text dimColor>⏸ ask before commands</Text>}
      <Text dimColor> (shift+tab to cycle)</Text>
    </Box>
  </Box>
);

// ── App ───────────────────────────────────────────────────────────────────────
const App = () => {
  const cols = useColumns();
  const [value, setValue] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null); // null = idle
  const [tokens, setTokens] = useState(0);
  const [auto, setAuto] = useState(true);
  const [cwd, setCwd] = useState(workDir);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [choice, setChoice] = useState(0);
  const autoRef = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const convo = useRef<OpenAI.Responses.ResponseInputItem[]>([]);

  const push = (item: Item) => setItems((it) => [...it, item]);

  const toggleAuto = () => { autoRef.current = !autoRef.current; setAuto(autoRef.current); };

  const confirm = async (command: string, note?: string) => {
    if (autoRef.current) return;
    const answer = await new Promise<"yes" | "always" | "no">((resolve) => { setChoice(0); setApproval({ command, note, resolve }); });
    setApproval(null);
    if (answer === "always") toggleAuto();
    if (answer === "no") throw new Error("User declined to run this command.");
  };

  const runTool = async (name: string, args: any, signal: AbortSignal): Promise<ToolOutcome> => {
    if (name === "grep") return runGrep(args);
    if (name === "bash") {
      await confirm(args.command, args.description);
      return runBash(args, signal);
    }
    throw new Error(`Unknown tool ${name}`);
  };

  const send = async (prompt: string) => {
    const attachments = parseAttachments(prompt);
    const folder = attachments.filter((a) => a.dir).at(-1);
    if (folder) { workDir = folder.abs; setCwd(workDir); }
    push({ kind: "user", text: prompt, attachments });
    convo.current.push({ role: "user", content: buildUserContent(prompt, attachments) });
    setStreaming("");
    setTokens(0);
    abort.current = new AbortController();
    const { signal } = abort.current;
    const started = Date.now();
    let total = 0;

    try {
      while (true) {
        let text = "";
        const calls: OpenAI.Responses.ResponseFunctionToolCall[] = [];
        const stream = await client.responses.create(
          { model: MODEL, instructions: system(), input: convo.current, tools: TOOLS, stream: true },
          { signal },
        );
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            text += event.delta;
            setStreaming(text);
            setTokens(total + Math.round(text.length / 4));
          } else if (event.type === "response.output_item.done" && event.item.type === "function_call") {
            calls.push(event.item);
          } else if (event.type === "response.output_item.done" && event.item.type === "web_search_call") {
            const action: any = event.item.action ?? {};
            if (action.type === "open_page") push({ kind: "tool", label: `Fetch(${action.url ?? ""})`, summary: "Opened page" });
            else if (action.type === "find") push({ kind: "tool", label: `Find("${action.pattern ?? ""}" in ${action.url ?? ""})`, summary: "Searched page" });
            else push({ kind: "tool", label: `Web Search("${action.query ?? ""}")`, summary: "Did 1 search" });
            // Built-in tool calls must stay in the transcript so the model keeps its context.
            convo.current.push(event.item as any);
          }
        }
        if (signal.aborted) text += text ? "\n[interrupted]" : "[interrupted]";
        if (text.trim()) {
          push({ kind: "assistant", text });
          convo.current.push({ role: "assistant", content: text });
        }
        setStreaming("");
        if (signal.aborted || calls.length === 0) break;

        for (const call of calls) {
          convo.current.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
          const args = JSON.parse(call.arguments || "{}");
          let output: string;
          try {
            const r = await runTool(call.name, args, signal);
            push({ kind: "tool", label: label(call.name, args), summary: r.summary, body: r.body });
            output = r.output;
          } catch (err: any) {
            output = `Error: ${err.message}`;
            push({ kind: "tool", label: label(call.name, args), summary: err.message, error: true });
          }
          convo.current.push({ type: "function_call_output", call_id: call.call_id, output });
        }
      }
    } catch (err: any) {
      if (!signal.aborted) push({ kind: "assistant", text: `Error: ${err?.message ?? err}` });
    }

    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    push({ kind: "done", verb: VERBS[Math.floor(Math.random() * VERBS.length)], seconds, done: clock() });
    setStreaming(null);
  };

  useInput((input, key) => {
    if (key.tab && key.shift) {
      if (approval) approval.resolve("always");
      else toggleAuto();
      return;
    }
    if (approval) {
      if (key.escape || input === "3" || input === "n") approval.resolve("no");
      else if (key.return) approval.resolve(choice === 0 ? "yes" : choice === 1 ? "always" : "no");
      else if (input === "1" || input === "y") approval.resolve("yes");
      else if (input === "2" || input === "a") approval.resolve("always");
      else if (key.upArrow) setChoice((c) => Math.max(0, c - 1));
      else if (key.downArrow) setChoice((c) => Math.min(OPTIONS.length - 1, c + 1));
      return;
    }
    if (key.escape) {
      abort.current?.abort();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;

    // A paste arrives as one chunk, so walk it and treat any newline as Enter.
    let next = value;
    for (const ch of input) {
      if (ch === "\r" || ch === "\n") {
        if (next.trim() && streaming === null) send(next.trim());
        next = "";
      } else {
        next += ch;
      }
    }
    setValue(next);
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Welcome cwd={cwd} />

      <Box flexDirection="column" marginTop={1} gap={1}>
        {items.map((m, i) =>
          m.kind === "user" ? <UserMessage key={i} text={m.text} attachments={m.attachments} />
          : m.kind === "assistant" ? <AssistantMessage key={i} text={m.text} cols={cols} />
          : m.kind === "tool" ? <ToolMessage key={i} item={m} />
          : <DoneLine key={i} verb={m.verb} seconds={m.seconds} done={m.done} />,
        )}
        {streaming !== null && streaming && <AssistantMessage text={streaming} cols={cols} />}
        {streaming !== null && !approval && <Spinner tokens={tokens} />}
      </Box>

      <Box marginTop={1}>
        {approval ? <ApprovalPrompt approval={approval} choice={choice} /> : <Input value={value} cols={cols} auto={auto} />}
      </Box>
    </Box>
  );
};

render(<App />);
