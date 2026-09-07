/*
  hey! this is the settings drawer for pcb code :)
  there's no openai key in here on purpose! requests go to the pcb code proxy with
  your personal token (see account.ts), and the proxy holds the real key. this
  file builds that client, and keeps track of which folder we're working in. the
  working folder starts as the one you passed on the command line (or wherever
  you launched from) and can change later when you attach a folder with @path.
  colors, spinner frames, the silly cooking verbs, and a couple of limits live
  here as well. enjoy! \o/
*/
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { PROXY_URL } from "./account.js";

export const MODEL = "gpt-6-astra";

export const makeClient = (token: string) => new OpenAI({ apiKey: token, baseURL: `${PROXY_URL}/v1`, maxRetries: 0 });

let workDir = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
  console.error(`Not a folder: ${workDir}`);
  process.exit(1);
}

export const getWorkDir = () => workDir;
export const setWorkDir = (dir: string) => { workDir = dir; };

export const ORANGE = "#D97757";
export const BAR = "#2A2A2A";
export const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
export const VERBS = ["Sautéed", "Baked", "Simmered", "Brewed", "Whisked", "Roasted", "Cooked", "Stewed"];
export const MAX_OUTPUT = 30_000;
export const BASH_TIMEOUT = 120_000;
