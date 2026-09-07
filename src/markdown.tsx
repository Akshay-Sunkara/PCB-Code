/*
  a teeny markdown renderer for the terminal :) it understands **bold**, `code`,
  and fenced ``` blocks, and that's it on purpose! the interesting bit is that it
  wraps lines by hand instead of letting ink do it. ink keeps the space at a wrap
  point when styled text breaks across lines, which leaves a weird stray space at
  the start of the next line (we noticed it on a bold "pacific daylight time"
  once, ha!). so we split into styled runs, wrap word by word to the width we're
  given, drop the space at each break, and hand ink lines that already fit. neat!
*/
import React from "react";
import { Box, Text } from "ink";

export type Run = { text: string; bold?: boolean; code?: boolean };

const parseInline = (line: string): Run[] =>
  line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((p) =>
    p.startsWith("**") ? { text: p.slice(2, -2), bold: true }
    : p.startsWith("`") ? { text: p.slice(1, -1), code: true }
    : { text: p },
  );

export const wrapRuns = (runs: Run[], width: number): Run[][] => {
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
        if (space) continue;
      }
      if (space && len === 0) continue;
      let w = word;
      while (w.length > width) {
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

const toRuns = (text: string): Run[][] => {
  let fence = false;
  const out: Run[][] = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) { fence = !fence; continue; }
    out.push(fence ? [{ text: line, code: true }] : parseInline(line));
  }
  return out;
};

export const Markdown = ({ text, width }: { text: string; width: number }) => (
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

export const Wrapped = ({ text, width, bold, cursor }: { text: string; width: number; bold?: boolean; cursor?: boolean }) => {
  const lines = wrapRuns([{ text }], Math.max(10, width));
  return (
    <Box flexDirection="column">
      {lines.map((runs, i) => (
        <Text key={i} bold={bold}>
          {runs.map((r) => r.text).join("")}
          {cursor && i === lines.length - 1 && <Text inverse> </Text>}
        </Text>
      ))}
    </Box>
  );
};
