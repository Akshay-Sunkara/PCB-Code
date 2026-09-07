/*
  the proxy! this little server is the only thing that ever sees the real openai
  key :) users sign up with an email and get a pcb_ token, the cli sends that
  token instead of a key, and we forward each request to openai with the real key
  while streaming the answer straight back. every user has a token budget (50k by
  default) tracked in a sqlite file, counted from the usage numbers openai reports
  in each response. once the budget is gone they get a friendly note and a 429.
  there's an admin endpoint (separate ADMIN_KEY) so you can raise someone's limit
  after they email you. no dependencies, just node 22+. keep the key safe! <3

  env: OPENAI_API_KEY (required), ADMIN_KEY (required), PORT (8787),
       PCBCODE_DB (./pcbcode.db), TOKEN_LIMIT (50000), MODEL (gpt-6-astra)
*/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

const envPath = path.join(import.meta.dirname, "..", ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!OPENAI_API_KEY || !ADMIN_KEY) {
  console.error("set OPENAI_API_KEY and ADMIN_KEY (in .env or the environment)");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN_LIMIT = Number(process.env.TOKEN_LIMIT ?? 50_000);
const MODEL = process.env.MODEL ?? "gpt-6-astra";
const BLOCKED_MESSAGE = "hey! you hit the rate limit. contact me @ akshaysunkara68@berkeley.edu to talk about using it more.";
const MAX_BODY = 20 * 1024 * 1024;

const db = new DatabaseSync(process.env.PCBCODE_DB ?? path.join(import.meta.dirname, "pcbcode.db"));
db.exec(`create table if not exists users (
  email text primary key,
  token_hash text unique not null,
  token_limit integer not null,
  used integer not null default 0,
  created text not null,
  last_seen text
)`);

const hash = (t) => createHash("sha256").update(t).digest("hex");
const now = () => new Date().toISOString();

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const bearer = (req) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();

const signups = new Map();
const tooManySignups = (ip) => {
  const t = Date.now();
  const recent = (signups.get(ip) ?? []).filter((x) => t - x < 60 * 60 * 1000);
  recent.push(t);
  signups.set(ip, recent);
  return recent.length > 5;
};

const signup = async (req, res) => {
  const ip = req.socket.remoteAddress ?? "?";
  if (tooManySignups(ip)) return json(res, 429, { error: { message: "too many signups from this address, try again later" } });
  let email;
  try { email = String(JSON.parse(await readBody(req)).email ?? "").trim().toLowerCase(); } catch { email = ""; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: { message: "please send a valid email" } });
  if (db.prepare("select 1 from users where email = ?").get(email))
    return json(res, 409, { error: { message: "this email already has a token. contact me @ akshaysunkara68@berkeley.edu if you lost it." } });
  const token = "pcb_" + randomBytes(24).toString("hex");
  db.prepare("insert into users (email, token_hash, token_limit, created) values (?, ?, ?, ?)").run(email, hash(token), TOKEN_LIMIT, now());
  json(res, 201, { token, limit: TOKEN_LIMIT });
};

const usageFromSse = (text) => {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5));
      if (ev.type === "response.completed") total += ev.response?.usage?.total_tokens ?? 0;
    } catch {}
  }
  return total;
};

const proxy = async (req, res, user) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: { message: "invalid json" } }); }
  body.model = MODEL;
  delete body.user;

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const headers = {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-pcbcode-used": String(user.used),
    "x-pcbcode-limit": String(user.token_limit),
  };
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();

  let captured = "";
  const stream = Readable.fromWeb(upstream.body);
  stream.on("data", (chunk) => { captured += chunk; res.write(chunk); });
  stream.on("end", () => {
    res.end();
    let tokens = 0;
    if (headers["content-type"].includes("text/event-stream")) tokens = usageFromSse(captured);
    else { try { tokens = JSON.parse(captured).usage?.total_tokens ?? 0; } catch {} }
    if (tokens > 0) db.prepare("update users set used = used + ?, last_seen = ? where email = ?").run(tokens, now(), user.email);
  });
  stream.on("error", () => res.end());
  req.on("close", () => stream.destroy());
};

const admin = async (req, res, url) => {
  if (bearer(req) !== ADMIN_KEY) return json(res, 401, { error: { message: "bad admin key" } });
  if (req.method === "GET" && url.pathname === "/admin/users")
    return json(res, 200, db.prepare("select email, token_limit as \"limit\", used, created, last_seen from users order by created").all());
  if (req.method === "POST" && url.pathname === "/admin/users") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: { message: "invalid json" } }); }
    const email = String(b.email ?? "").trim().toLowerCase();
    const row = db.prepare("select * from users where email = ?").get(email);
    if (!row) return json(res, 404, { error: { message: "no such user" } });
    if (b.limit !== undefined) db.prepare("update users set token_limit = ? where email = ?").run(Number(b.limit), email);
    if (b.used !== undefined) db.prepare("update users set used = ? where email = ?").run(Number(b.used), email);
    return json(res, 200, db.prepare("select email, token_limit as \"limit\", used from users where email = ?").get(email));
  }
  json(res, 404, { error: { message: "not found" } });
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/signup") return await signup(req, res);
    if (url.pathname.startsWith("/admin/")) return await admin(req, res, url);
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const token = bearer(req);
      const user = token.startsWith("pcb_") ? db.prepare("select * from users where token_hash = ?").get(hash(token)) : null;
      if (!user) return json(res, 401, { error: { message: "unknown token. run pcbcode again to sign up." } });
      if (user.used >= user.token_limit)
        return json(res, 429, { error: { message: BLOCKED_MESSAGE, type: "quota_exceeded" } }, { "x-pcbcode-used": String(user.used), "x-pcbcode-limit": String(user.token_limit) });
      return await proxy(req, res, user);
    }
    json(res, 404, { error: { message: "not found" } });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: { message: "server error" } });
    else res.end();
  }
}).listen(PORT, () => console.log(`pcb code proxy listening on :${PORT} (model ${MODEL}, limit ${TOKEN_LIMIT})`));
