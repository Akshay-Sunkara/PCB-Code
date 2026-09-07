/*
  your account, the tiny version :) pcb code doesn't ship an openai key. instead
  the first run asks for your email, calls the proxy's signup endpoint, and gets a
  pcb_ token back. that token (and your email) lives in ~/.pcbcode/config.json so
  you only do this once per machine. if you already have a token from somewhere,
  you can paste it instead of an email. PCBCODE_PROXY_URL points at a different
  proxy, handy for running one locally. the proxy is where the real quota lives,
  this file just remembers who you are. hi! \o/
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROXY_URL = (process.env.PCBCODE_PROXY_URL ?? "https://pcbcode-proxy.fly.dev").replace(/\/$/, "");
export const BLOCKED_MESSAGE = "hey! you hit the rate limit. contact me @ akshaysunkara68@berkeley.edu to talk about using it more.";

const FILE = path.join(os.homedir(), ".pcbcode", "config.json");

export type Account = { token: string; email?: string };

export const loadAccount = (): Account | null => {
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return typeof a.token === "string" && a.token.startsWith("pcb_") ? a : null;
  } catch {
    return null;
  }
};

export const saveAccount = (a: Account) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(a, null, 2));
};

export const signup = async (email: string): Promise<Account> => {
  const res = await fetch(`${PROXY_URL}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `signup failed (${res.status})`);
  return { token: body.token, email };
};

export const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
