/*
  the token meter :) every user gets a budget of tokens (50k by default) and once
  it's gone, pcb code politely stops and tells you how to get in touch. the count
  lives in ~/.pcbcode/usage.json, outside the repo on purpose, so cloning the
  project again doesn't hand out a fresh budget. we count the real usage numbers
  the api reports (input + output, tool loops included), not a guess. set
  PCBCODE_TOKEN_LIMIT to a small number to try the block without burning 50k, or
  to 0 to switch the limit off entirely. fair's fair! ^_^
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".pcbcode", "usage.json");
const raw = Number(process.env.PCBCODE_TOKEN_LIMIT ?? 50_000);
export const LIMIT = Number.isFinite(raw) ? raw : 50_000;
export const BLOCKED_MESSAGE = "hey! you hit the rate limit. contact me @ akshaysunkara68@berkeley.edu to talk about using it more.";

export const getUsed = (): number => {
  try {
    return Number(JSON.parse(fs.readFileSync(FILE, "utf8")).used) || 0;
  } catch {
    return 0;
  }
};

export const addUsage = (tokens: number) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ used: getUsed() + tokens, updated: new Date().toISOString() }));
};

export const isBlocked = () => LIMIT > 0 && getUsed() >= LIMIT;

export const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
