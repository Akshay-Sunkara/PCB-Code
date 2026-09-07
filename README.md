# pcb code

an ai agent for kicad that lives in your terminal and looks like claude code.
it reads, edits, and reloads your schematic and board files by talking to kicad directly.

## install

you need node 22 or newer and python 3. tested on macos.

```
npm install -g pcbcode
```

the first time you run it, it asks for your email and gives you a token. that's your account. no openai key needed, requests go through my proxy.

heads up: pcb code runs shell commands that the model writes, inside your project folder. it starts in ask mode, so you approve each command until you turn that off.

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

to run from a clone of this repo instead, `npm install` then `npm run dev` in the folder.

then just type what you want, like "change c1 to 100nf" or "add a pull-up on the reset line".

- attach a file or image with `@path/to/file`, or attach a folder with `@path/to/folder` to switch where it works
- `shift+tab` toggles between ask mode (you approve each command, the default) and auto mode (commands run freely)
- `esc` interrupts a response
- `ctrl+c` quits

## limits

every user gets 50k tokens. the counter is shown at the bottom right. when it runs out, pcb code stops and shows a note with how to reach me. the count lives on the server, so reinstalling or cloning again won't reset it.

## running your own proxy

the proxy in `server/` is what holds the openai key. to run it yourself:

```
echo 'OPENAI_API_KEY=sk-...' > .env
echo 'ADMIN_KEY=something-long-and-random' >> .env
npm run server
```

it listens on port 8787 and keeps users in `server/pcbcode.db`. point the cli at it with `PCBCODE_PROXY_URL=http://localhost:8787 pcbcode`, or change the default in `src/account.ts`. `TOKEN_LIMIT`, `MODEL`, and `PORT` are env overrides.

to raise someone's limit after they email you:

```
curl -X POST http://localhost:8787/admin/users -H 'authorization: Bearer YOUR_ADMIN_KEY' \
  -H 'content-type: application/json' -d '{"email":"them@example.com","limit":200000}'
```

`GET /admin/users` with the same header lists everyone.

## deploying the proxy to fly.io

this is how the hosted proxy at `pcbcode-proxy.fly.dev` is run. the repo already has the `dockerfile` and `fly.toml`.

```
brew install flyctl
fly auth login
fly apps create pcbcode-proxy
fly volumes create pcbcode_data --region sjc --size 1 -a pcbcode-proxy --yes
fly secrets set OPENAI_API_KEY=sk-... ADMIN_KEY=something-long-and-random -a pcbcode-proxy
fly deploy --ha=false -a pcbcode-proxy
```

if the first deploy says it couldn't provision ips, run `fly ips allocate-v4 --shared -a pcbcode-proxy` and `fly ips allocate-v6 -a pcbcode-proxy`. then check `https://pcbcode-proxy.fly.dev/health`.

after that, every code change to `server/` ships with `fly deploy --ha=false -a pcbcode-proxy`. `fly logs -a pcbcode-proxy` shows what's happening. the admin curl above works the same against the fly url.

## releasing a new version of the cli

```
npm run build
npm version patch
npm publish --access public
git push --follow-tags
```

`npm publish` needs two-factor on your npm account, so run it from your own terminal where npm can open the browser. the build is bundled into `dist/cli.js` by esbuild, and only `dist`, the readme, and the license go into the package.
