/*
  welcome to pcb code! this is the front door :) all it does is mount the app.
  run it with `pcbcode [folder]` after linking, or straight up with
  `npx tsx cli.tsx [folder]`. you need node 22+ and that's it. the first run asks
  for your email and sets you up with a token, no openai key required.
  everything interesting lives in src/ -- go peek! <3
*/
import React from "react";
import { render } from "ink";
import { App } from "./src/app.js";
import { ensureReloadScript } from "./src/kicad.js";

ensureReloadScript();

render(<App />);
