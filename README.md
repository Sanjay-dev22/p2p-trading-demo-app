# P2P Energy Trading — Live Demo App

Two real web apps — a **Seller Platform** and a **Buyer Platform** — trade
real solar energy over a real, local [Beckn Protocol](https://becknprotocol.io/)
network running on your own machine in Docker. Every message (`publish`,
`init`, `confirm`, settlement) is a genuine, signed, policy-checked call —
nothing is scripted or faked. You click; the network really responds.

**This guide assumes you have never used Docker, Node.js, or this project
before, and are starting on a completely empty computer.** Follow it in
order, top to bottom, without skipping steps. Every command below is
written to be copy-pasted exactly as shown.

---

## Before you start: how to read this guide

- Every gray code box below is something you **type or paste into a
  terminal window**, then press Enter.
- **Windows:** use **Git Bash**, not Command Prompt and not PowerShell.
  Git Bash gets installed automatically in the next step. All commands in
  this guide are written for it.
- **Mac:** use the built-in **Terminal** app (search for "Terminal" with
  Spotlight, ⌘+Space).
- **Never double-click a `.sh` script file in File Explorer / Finder.**
  On Windows especially, double-clicking opens a console window that runs
  the script and then **closes itself instantly**, whether it succeeded
  or failed — you can't read what happened, and it looks broken even when
  it isn't. Every command in this guide is meant to be typed into a
  terminal window that you opened yourself and that stays open.
- If any command's output includes the words `error`, `not found`,
  `cannot find`, or `refused`, **stop and check the Troubleshooting
  section at the bottom** before continuing — don't keep running later
  steps on top of a failed one.

---

## Step 1 — Install the three prerequisites

You need three programs installed. If you're not sure whether you already
have one, run its check command anyway — it's harmless.

### 1a. Git

Download and install from **https://git-scm.com/downloads** (accept all
default options during install — on Windows this is also what installs
Git Bash).

Check it worked (open a **new** terminal window first, so it picks up the
fresh install):
```bash
git --version
```
You should see something like `git version 2.4x.x`. If you see
`command not found` / `'git' is not recognized`, the install didn't
finish, or you need to close and reopen your terminal.

### 1b. Node.js

Download the **LTS** version from **https://nodejs.org** and install it
(default options).

Check:
```bash
node --version
npm --version
```
You need Node **v18 or newer** (v20 or v22 are fine too). If the number
before the first dot is 16 or lower, uninstall and reinstall the LTS
version from the link above.

### 1c. Docker Desktop

Download from **https://www.docker.com/products/docker-desktop/** and
install it. **After installing, you must open the Docker Desktop
application** (Start Menu / Applications) **and wait until it says
"Docker Desktop is running"** in its own window — a whale icon in your
system tray/menu bar turning steady (not animating) is the same signal.
This step is easy to miss and is the single most common reason the next
steps fail.

Check, once Docker Desktop is fully started:
```bash
docker --version
docker compose version
```
Both must print a version number, not an error. If you get a "cannot
connect to the Docker daemon" error, Docker Desktop isn't running yet —
open it and wait, then try again.

---

## Step 2 — Create a folder and download this project

Pick one place on your computer for this — your Desktop is simplest. The
commands below create a folder there called `p2p-trading-demo` and
download this project into it.

```bash
cd ~/Desktop
mkdir p2p-trading-demo
cd p2p-trading-demo
git clone https://github.com/Sanjay-dev22/p2p-trading-demo-app.git .
```

**Every command in the rest of this guide assumes your terminal's current
folder is this exact `p2p-trading-demo` folder.** If a later command
fails with "no such file or directory," you've likely changed folders (or
opened a new terminal window, which always starts back at your home
folder) — run this to get back, then retry:
```bash
cd ~/Desktop/p2p-trading-demo
```
You can check where you currently are at any time with:
```bash
pwd
```

---

## Step 3 — Start the real Beckn network (Docker)

This starts 14 small containers on your own machine: the two trading
platforms' protocol adapters, a router, two settlement ledgers, and their
supporting caches. Nothing here talks to the internet except two real,
already-live services this project depends on (a schema registry and a
policy registry) — everything else is fully local.

```bash
cd network/devkits/p2p-trading-ies-wave2/install
docker compose up -d
```

The first time you run this, Docker needs to download the container
images — this can take a few minutes depending on your internet
connection. You'll see a wall of text; that's normal.

**Check everything actually started:**
```bash
docker compose ps
```
You should see 14 rows. Every row's `STATUS` column should say `Up ...`
(the redis and sandbox-ledger rows will additionally say `(healthy)` after
about 15-20 seconds — if you check immediately they may briefly say
`(health: starting)`, which is fine; just wait and re-run the command).
If any row is missing, or says `Exited`, see Troubleshooting.

Leave this terminal window open (or close it — unlike the app servers in
the next step, these are background containers and keep running either
way). Go back to your project folder for the next step:
```bash
cd ~/Desktop/p2p-trading-demo
```

---

## Step 4 — Install and start the Seller Platform

Open a terminal window (or use your current one) and run:
```bash
cd ~/Desktop/p2p-trading-demo/seller-app
npm install
```
This downloads the small number of libraries the app needs — takes under
a minute. You'll see a line like `added 105 packages` when it's done.

Now start it:
```bash
npm start
```
You should see:
```
Seller Platform listening on http://localhost:4002
  → talking to onix-sellerapp at http://localhost:8082
  → webhook target for onix: http://host.docker.internal:4002/api/webhook
```
**This command does not finish or return you to the prompt — that's
correct.** It means the server is running and waiting. **Leave this
terminal window open** for the rest of the demo. Do not close it, and do
not press Ctrl+C in it (that would stop the server).

---

## Step 5 — Install and start the Buyer Platform

**Open a second, brand-new terminal window** (do not reuse the one from
Step 4 — it's busy running the seller server). In the new window:
```bash
cd ~/Desktop/p2p-trading-demo/buyer-app
npm install
npm start
```
You should see:
```
Buyer Platform listening on http://localhost:4001
  → talking to onix-buyerapp at http://localhost:8081
  → webhook target for onix: http://host.docker.internal:4001/api/bap-webhook
```
Same as before — leave this window open too.

You should now have **two terminal windows open, both quietly running**
(neither shows a prompt to type into), plus the Docker containers from
Step 3 running in the background. That's the whole system, fully up.

---

## Step 6 — Open the two dashboards

In your web browser, open these two pages, ideally in two separate
windows side by side:

- **Seller Platform:** http://localhost:4002
- **Buyer Platform:** http://localhost:4001

Each should show a small "● live" indicator near the top — that's a
WebSocket connection back to its own server, confirming everything's
wired up.

---

## Step 7 — Run the actual demo

1. **On the Seller page:** type a quantity and price (or use the
   defaults), click **Publish offer**. A toast confirms it — this really
   just called `catalog/publish` on the real network.
2. Note the offer ID that appears under "Active & settled trades" section
   header... actually it's easiest to copy it from the **Incoming
   requests** area once a request lands, but for your *first* purchase
   you'll need it from the publish confirmation. The easiest way: open
   `http://localhost:4002/api/offers` in a new browser tab — it shows the
   raw offer list including the `id` field, e.g. `offer-demo-a1b2c3d4`.
3. **On the Buyer page:** paste that offer ID into the "Buy directly"
   form, adjust quantity/price to match (or less), leave "Trade as" on
   **Allowed discom**, click **Buy**. This sends a real, signed `init`.
4. **Back on the Seller page:** within a second or two, the request
   appears live under "Incoming requests." Click **Accept**.
5. Watch both pages — with no further clicks, the trade flips to
   **Active** on both sides within a couple of seconds (the two servers
   are automatically exchanging the rest of the protocol handshake for
   you).
6. **On the Seller page:** click **Mark as delivered** on the now-active
   trade. Both pages flip to **Settled**, showing a real computed ₹
   amount (delivered kWh × price — the exact delivered amount is
   randomized slightly, mimicking a real meter reading that never
   perfectly matches what was requested).
7. **The rejected-trade demo** (the most convincing part to show a
   skeptical audience): publish a fresh offer, then on the Buyer page set
   "Trade as" to **Blocked discom (watch it get rejected)** before
   clicking Buy. You'll see a real, live rejection with a specific,
   human-readable reason — the same real policy engine genuinely refusing
   this one, not a canned error message.

---

## Stopping everything / running it again later

To stop: press Ctrl+C in each of the two `npm start` terminal windows,
then:
```bash
cd ~/Desktop/p2p-trading-demo/network/devkits/p2p-trading-ies-wave2/install
docker compose down
```

To run again later, repeat from Step 3 onward (Docker images are already
downloaded, so it'll be fast this time; `npm install` doesn't need to be
re-run unless you deleted the `node_modules` folders).

To reset the apps to an empty state (clear all offers/trades) without
uninstalling anything:
```bash
cd ~/Desktop/p2p-trading-demo
rm -f seller-app/seller-app.db* buyer-app/buyer-app.db*
```
Do this while both `npm start` processes are stopped, then start them
again.

---

## Troubleshooting

**"no such file or directory" / "cannot find path"**
You're in the wrong folder. Run `pwd` to see where you are, then `cd` back
to the expected folder shown at the top of each step (all paths are
relative to `~/Desktop/p2p-trading-demo`, the folder created in Step 2).

**A tiny black window flashed open and instantly closed**
This happens if a `.sh` file gets double-clicked instead of run from an
already-open terminal. Nothing in this guide should be double-clicked —
if you did that by accident, just ignore it and continue by typing the
equivalent command from this guide into your terminal instead.

**`docker compose up -d` fails with "Cannot connect to the Docker
daemon"**
Docker Desktop isn't running. Open the Docker Desktop application and
wait for it to fully start (see Step 1c), then retry.

**`docker compose ps` shows a container as `Exited` or missing**
Run `docker compose logs <container-name>` (e.g. `docker compose logs
onix-sellerapp`) to see why. The most common cause is trying to start it
a second time while an old copy is still half-running — run
`docker compose down` then `docker compose up -d` again.

**A port is "already in use" / "address already in use"**
Something is already using one of the ports this project needs (4001,
4002, 8081-8086, or 9000). Usually this means a previous run wasn't fully
stopped. Stop both `npm start` terminals (Ctrl+C) and run
`docker compose down` from Step 3's folder, then start again from Step 3.

**`npm start` prints an error immediately and returns to the prompt**
The server crashed on startup — read the error message above the prompt.
The most common cause is Step 3 not being done yet (the app can't reach
the network) — make sure `docker compose ps` shows all 14 containers
`Up` before starting the apps.

**A "Buy" or "Publish" click shows a rejected/error toast you didn't
expect**
Read the message in the toast — it's the real network's real answer, not
a bug message. If it mentions a policy violation, that's the intended
"rejected trade" behavior from Step 7 §7 firing on the wrong persona; if
it's something else, check both terminal windows from Steps 4-5 for a
red error line and see what it says.

**Nothing above matches what you're seeing**
Copy the exact text from your terminal (both the command you ran and
everything printed after it) — that's the most useful thing to share when
asking for help.

---

## For the curious: what's actually real here

- Read `p2p-trading-app/DEMO-APP-PLAN.md`-equivalent design notes are
  folded into `seller-app/beckn.js` and `buyer-app/beckn.js` as comments —
  every payload field shape is copied from the upstream devkit's own
  verified example fixtures, not invented.
- The two `.rego`-based policy checks (which discom is allowed to trade,
  and the settlement math) are fetched live from a real registry
  (`api.dedi.global`) at the moment each message is processed — they are
  not hardcoded anywhere in this repo.
- `network/` in this repo is a trimmed-down copy of the upstream
  [`beckn/DEG`](https://github.com/beckn/DEG) `p2p-trading-ies-wave2`
  devkit — only the pieces needed to run (no test-runner scripts, no
  Python, no `sparse-checkout`) so there is nothing else to install beyond
  the three prerequisites in Step 1.
