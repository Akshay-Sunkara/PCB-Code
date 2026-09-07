/*
  attachments, aka the @path magic :) type @something in your prompt and this
  file figures out what it is. a text file gets inlined into the message, an image
  (png/jpg/gif/webp) gets sent as an actual image, and a folder gets a file listing
  plus a note that it's the new working folder from now on. parseAttachments just
  finds and describes them; buildUserContent turns the prompt + attachments into
  the content blocks the openai api wants. tiny but mighty! <3
*/
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { getWorkDir } from "./config.js";
import { cap, projectFiles } from "./tools.js";

const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export type Attachment = { name: string; abs: string; mime?: string; lines?: number; dir?: boolean; files?: string[] };

export const parseAttachments = (prompt: string): Attachment[] => {
  const out: Attachment[] = [];
  for (const m of prompt.matchAll(/(?:^|\s)@(\S+)/g)) {
    const p = m[1].replace(/^~/, process.env.HOME ?? "~");
    const abs = path.resolve(getWorkDir(), p);
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

export const buildUserContent = (prompt: string, files: Attachment[]): OpenAI.Responses.ResponseInputContent[] => [
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
