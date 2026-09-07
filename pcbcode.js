#!/usr/bin/env node
// Launcher so `pcbcode [folder]` works from anywhere after `npm link`.
import { spawn } from "node:child_process";
import path from "node:path";

const here = import.meta.dirname;
const child = spawn(
  path.join(here, "node_modules", ".bin", "tsx"),
  [path.join(here, "cli.tsx"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
