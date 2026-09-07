# pcb code

an ai agent for kicad that lives in your terminal and looks like claude code.
it reads, edits, and reloads your schematic and board files by talking to kicad directly.

## install

you need node 22 or newer.

```
npm install -g pcbcode
```

then open your kicad project folder and run it:

```
cd ~/path/to/your/kicad/project
pcbcode
```

the first time you run it, it asks for your email and gives you a token. that's your account. no openai key needed.
