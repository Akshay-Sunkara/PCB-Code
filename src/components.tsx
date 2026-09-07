/*
  all the little ink components that make pcb code look like, well, that :) the
  welcome box, the gray bar your prompt sits on, the bullet for replies, the tool
  call lines with their "⎿" results, the spinner that counts seconds and tokens
  while we wait, the "sautéed for 3s" sign-off, the approval box you only see in
  ask mode, and the input line with the rules above and below it. plus the shared
  types for transcript items and pending approvals, and a hook that tracks how
  wide the terminal is so the rules stretch edge to edge. pure looks, no logic! ^_^
*/
import React, { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { BAR, FRAMES, ORANGE } from "./config.js";
import { Markdown, Wrapped } from "./markdown.js";
import type { Attachment } from "./attachments.js";
import { fmt } from "./usage.js";

export type Item =
  | { kind: "welcome"; cwd: string }
  | { kind: "user"; text: string; attachments: Attachment[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string; summary: string; body?: string; error?: boolean }
  | { kind: "done"; verb: string; seconds: number; done: string };

export type Approval = { command: string; note?: string; resolve: (choice: "yes" | "always" | "no") => void };

export const OPTIONS = ["Yes", "Yes, allow all commands during this session (shift+tab)", "No, and tell PCB Code what to do differently (esc)"];

export const useColumns = () => {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns || 80);
  useEffect(() => {
    const onResize = () => setCols(stdout.columns || 80);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return cols;
};

export const Welcome = ({ cwd }: { cwd: string }) => (
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

export const UserMessage = ({ text, attachments, cols }: { text: string; attachments: Attachment[]; cols: number }) => (
  <Box flexDirection="column">
    <Box width="100%" backgroundColor={BAR}>
      <Box width={2} flexShrink={0}><Text bold>❯</Text></Box>
      <Box flexGrow={1}><Wrapped text={text} width={cols - 4} bold /></Box>
    </Box>
    {attachments.map((a, i) => (
      <Box key={i} marginLeft={2}>
        <Text dimColor>⎿  Attached {a.dir ? "folder " : ""}{a.name}{a.dir ? ` (${a.files!.length} files, now the working folder)` : a.mime ? " (image)" : ` (${a.lines} lines)`}</Text>
      </Box>
    ))}
  </Box>
);

export const AssistantMessage = ({ text, cols }: { text: string; cols: number }) => (
  <Box>
    <Box width={2} flexShrink={0}><Text>●</Text></Box>
    <Box flexGrow={1}><Markdown text={text.trim()} width={cols - 4} /></Box>
  </Box>
);

export const ToolMessage = ({ item }: { item: Extract<Item, { kind: "tool" }> }) => (
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

export const DoneLine = ({ verb, seconds, done }: { verb: string; seconds: number; done: string }) => (
  <Text dimColor>✻ {verb} for {seconds}s · done {done}</Text>
);

export const Spinner = ({ tokens }: { tokens: number }) => {
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

export const ApprovalPrompt = ({ approval, choice }: { approval: Approval; choice: number }) => (
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

const Rule = ({ cols }: { cols: number }) => <Text dimColor>{"─".repeat(Math.max(0, cols - 2))}</Text>;

export const Input = ({ value, cols, auto, used, limit }: { value: string; cols: number; auto: boolean; used: number; limit: number }) => (
  <Box flexDirection="column">
    <Rule cols={cols} />
    <Box>
      <Box width={2} flexShrink={0}><Text>❯</Text></Box>
      <Box flexGrow={1}><Wrapped text={value} width={cols - 4} cursor /></Box>
    </Box>
    <Rule cols={cols} />
    <Box marginLeft={2} justifyContent="space-between">
      <Box>
        {auto ? <Text color={ORANGE}>⏵⏵ auto mode on</Text> : <Text dimColor>⏸ ask before commands</Text>}
        <Text dimColor> (shift+tab to cycle)</Text>
      </Box>
      {limit > 0 && <Text dimColor>{fmt(used)} / {fmt(limit)} tokens</Text>}
    </Box>
  </Box>
);
