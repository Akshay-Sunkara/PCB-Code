# pcb code

an ai agent for kicad that lives in your terminal and looks like claude code.
it reads, edits, and reloads your schematic and board files by talking to kicad directly.

## install

you need node 22 or newer and python 3.

```
git clone https://github.com/Akshay-Sunkara/PCB-Code.git
cd PCB-Code
npm install
echo 'OPENAI_API_KEY=sk-...' > .env
ln -s "$PWD/pcbcode.js" ~/.local/bin/pcbcode
```

the last line puts a `pcbcode` command on your path. if `~/.local/bin` isn't on your path, use any folder that is, or run `npx tsx cli.tsx` from this folder instead.

## set up kicad

this lets pcb code save and reload files inside kicad so you never lose work.

1. open kicad.
2. click the **kicad** menu (left of file) and choose **preferences**, or press cmd+comma.
3. pick **plugins** in the left column.
4. tick **enable kicad api** and click ok.
5. keep the pcb editor open on your board while pcb code works.

pcb code installs the kicad python client on its own the first time it needs it, into `~/.pcbcode/venv`. nothing else to set up.

## use it

```
cd ~/path/to/your/kicad/project
pcbcode
```

or point it at a folder from anywhere with `pcbcode ~/path/to/project`.

then just type what you want, like "change c1 to 100nf" or "add a pull-up on the reset line".

- attach a file or image with `@path/to/file`, or attach a folder with `@path/to/folder` to switch where it works
- `shift+tab` toggles between auto mode (commands run freely) and ask mode (you approve each command)
- `esc` interrupts a response
- `ctrl+c` quits

## limits

every user gets 50k tokens. the counter is shown at the bottom right. when it runs out, pcb code stops and shows a note with how to reach me. cloning the repo again won't reset it.
