/*
  the brain of the show :) this is the main ink component. it owns the transcript,
  the text you're typing, the streaming reply, the token counter, and whether we're
  in auto mode (run commands freely) or ask mode (approval box for every command,
  toggle with shift+tab). send() is the agent loop: it packs your prompt and any
  @attachments, streams the model's answer, runs whatever tools it asked for, feeds
  the results back, and keeps going until the model is done talking. esc aborts
  the current turn, and pasted text with newlines gets submitted line by line so
  drag-and-drop paths just work. lots going on but it's all in one place! \o/
*/
import React, { useRef, useState } from "react";
import { Box, Static, useInput } from "ink";
import OpenAI from "openai";
import { MODEL, VERBS, getWorkDir, makeClient, setWorkDir } from "./config.js";
import { system } from "./prompt.js";
import { TOOLS, label, runBash, runGrep, type ToolOutcome } from "./tools.js";
import { buildUserContent, parseAttachments } from "./attachments.js";
import { BLOCKED_MESSAGE, fmt, loadAccount, saveAccount, signup, type Account } from "./account.js";
import {
  ApprovalPrompt, AssistantMessage, DoneLine, Input, OPTIONS, Signup, Spinner, ToolMessage, UserMessage, Welcome, useColumns,
  type Approval, type Item,
} from "./components.js";

const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export const App = () => {
  const cols = useColumns();
  const [value, setValue] = useState("");
  const [items, setItems] = useState<Item[]>([{ kind: "welcome", cwd: getWorkDir() }]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [tokens, setTokens] = useState(0);
  const [auto, setAuto] = useState(false);
  const [account, setAccount] = useState<Account | null>(loadAccount());
  const [signupError, setSignupError] = useState<string | undefined>();
  const [signingUp, setSigningUp] = useState(false);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(0);
  const client = useRef(account ? makeClient(account.token) : null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [choice, setChoice] = useState(0);
  const autoRef = useRef(false);
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

  const finishSignup = async (input: string) => {
    setSigningUp(true);
    setSignupError(undefined);
    try {
      const a = input.startsWith("pcb_") ? { token: input } : await signup(input);
      saveAccount(a);
      client.current = makeClient(a.token);
      setAccount(a);
    } catch (err: any) {
      setSignupError(err?.message ?? String(err));
    }
    setSigningUp(false);
  };

  const send = async (prompt: string) => {
    if (!client.current) return;
    const attachments = parseAttachments(prompt);
    const folder = attachments.filter((a) => a.dir).at(-1);
    if (folder) setWorkDir(folder.abs);
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
        const { data: stream, response } = await client.current
          .responses.create({ model: MODEL, instructions: system(), input: convo.current, tools: TOOLS, stream: true }, { signal })
          .withResponse();
        const seenBefore = Number(response.headers.get("x-pcbcode-used") ?? used);
        setLimit(Number(response.headers.get("x-pcbcode-limit") ?? limit));
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            text += event.delta;
            setStreaming(text);
            setTokens(total + Math.round(text.length / 4));
          } else if (event.type === "response.completed") {
            setUsed(seenBefore + (event.response.usage?.total_tokens ?? 0));
          } else if (event.type === "response.output_item.done" && event.item.type === "function_call") {
            calls.push(event.item);
          } else if (event.type === "response.output_item.done" && event.item.type === "web_search_call") {
            const action: any = event.item.action ?? {};
            if (action.type === "open_page") push({ kind: "tool", label: `Fetch(${action.url ?? ""})`, summary: "Opened page" });
            else if (action.type === "find") push({ kind: "tool", label: `Find("${action.pattern ?? ""}" in ${action.url ?? ""})`, summary: "Searched page" });
            else push({ kind: "tool", label: `Web Search("${action.query ?? ""}")`, summary: "Did 1 search" });
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
      if (err?.status === 429) {
        push({ kind: "assistant", text: err?.error?.message ?? BLOCKED_MESSAGE });
        setUsed(Number(err?.headers?.get?.("x-pcbcode-used") ?? used));
        setLimit(Number(err?.headers?.get?.("x-pcbcode-limit") ?? limit));
      } else if (!signal.aborted) push({ kind: "assistant", text: `Error: ${err?.message ?? err}` });
    }

    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    push({ kind: "done", verb: VERBS[Math.floor(Math.random() * VERBS.length)], seconds, done: clock() });
    setStreaming(null);
  };

  useInput((input, key) => {
    if (!account) {
      if (signingUp) return;
      if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
      if (key.ctrl || key.meta || key.tab || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      let next = value;
      for (const ch of input) {
        if (ch === "\r" || ch === "\n") { if (next.trim()) finishSignup(next.trim()); next = ""; }
        else next += ch;
      }
      setValue(next);
      return;
    }
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
    <>
      <Static items={items}>
        {(m, i) => (
          <Box key={i} flexDirection="column" paddingX={1} marginTop={m.kind === "welcome" ? 1 : 0} marginBottom={m.kind === "done" ? 2 : 1}>
            {m.kind === "welcome" ? <Welcome cwd={m.cwd} />
            : m.kind === "user" ? <UserMessage text={m.text} attachments={m.attachments} cols={cols} />
            : m.kind === "assistant" ? <AssistantMessage text={m.text} cols={cols} />
            : m.kind === "tool" ? <ToolMessage item={m} />
            : <DoneLine verb={m.verb} seconds={m.seconds} done={m.done} />}
          </Box>
        )}
      </Static>

      <Box flexDirection="column" paddingX={1} paddingBottom={1} gap={1}>
        {streaming !== null && streaming && <AssistantMessage text={streaming} cols={cols} />}
        {streaming !== null && !approval && <Spinner tokens={tokens} />}
        {!account ? <Signup value={value} error={signupError} busy={signingUp} />
        : approval ? <ApprovalPrompt approval={approval} choice={choice} />
        : <Input value={value} cols={cols} auto={auto} used={used} limit={limit} />}
      </Box>
    </>
  );
};
