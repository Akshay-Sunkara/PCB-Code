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

## set up kicad so edits reload

this lets pcb code save and reload files inside kicad, so you never lose work while it edits.

1. open kicad.
2. click the **kicad** menu (left of file) and choose **preferences**, or press cmd+comma.
3. pick **plugins** in the left column.
4. tick **enable kicad api** and click ok.
5. keep the pcb editor open on your board while pcb code works.

pcb code installs the kicad python client on its own the first time it needs it, into `~/.pcbcode/venv`. nothing else to set up. if the api is off, it still edits the file on disk and asks you to accept kicad's reload prompt instead.
