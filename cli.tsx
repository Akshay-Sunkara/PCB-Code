/*
  welcome to pcb code! this is the front door :) all it does is mount the app.
  run it with `pcbcode [folder]` after linking, or straight up with
  `npx tsx cli.tsx [folder]`. you need node 22+, an OPENAI_API_KEY either in
  your environment or in a .env file right next to this one, and that's it.
  everything interesting lives in src/ -- go peek! <3
*/
import React from "react";
import { render } from "ink";
import { App } from "./src/app.js";

render(<App />);
