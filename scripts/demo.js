#!/usr/bin/env node
// Start / stop / inspect the whole demo with one command, on Windows, macOS or
// Linux.   node scripts/demo.js <command>      (or:  npm run up | down | ...)
//
//   up [--tunnel]   start the Docker network, the policy server and the four apps
//   down [--all]    stop the apps (and with --all also the Docker network)
//   status          show what is running
//   reset           wipe all four dashboards back to empty (the dashboards' Reset button)
//   test            run the 99-check end-to-end suite (it RESETS the demo first and last)
//
// --tunnel starts a free Cloudflare quick tunnel so the Buyer's "Discover
// offers" (a call into the shared public catalog) can get its answer back.
// Everything else — direct trades, the aggregator, the DISCOM — works without it.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const DEVKIT = path.join(ROOT, "network", "DEG-repo", "devkits", "p2p-trading-ies-wave2");
const INSTALL = path.join(DEVKIT, "install");
const POLICY_DIR = path.join(DEVKIT, "policies");
const RUN = path.join(ROOT, ".run");
const PIDS = path.join(RUN, "pids.json");

const APPS = [
  { name: "seller", dir: "seller-app", port: 4002, label: "Seller Platform     " },
  { name: "buyer", dir: "buyer-app", port: 4001, label: "Buyer Platform      " },
  { name: "aggregator", dir: "aggregator-app", port: 4003, label: "Aggregator Platform " },
  { name: "grid", dir: "grid-app", port: 4004, label: "Grid/DISCOM Platform" },
];
// Host ports published by the onix containers + router — we wait for these.
const ONIX_PORTS = [
  { port: 8081, what: "onix-buyerapp" },
  { port: 18082, what: "onix-sellerapp" },
  { port: 18084, what: "onix-aggregatorapp" },
  { port: 18085, what: "onix-gridapp" },
  { port: 9000, what: "beckn-router (Caddy)" },
];
const POLICY_PORT = 8099;

const say = (m = "") => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(m) { console.error("\n✗ " + m + "\n"); process.exit(1); }

const portOpen = (port, host = "127.0.0.1") => new Promise((resolve) => {
  const s = net.connect({ port, host, timeout: 800 });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("timeout", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(false));
});
const httpStatus = (url) => new Promise((resolve) => {
  const req = http.get(url, { timeout: 2500 }, (res) => { res.resume(); resolve(res.statusCode); });
  req.once("timeout", () => { req.destroy(); resolve(0); });
  req.once("error", () => resolve(0));
});
async function waitUntil(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(1000); }
  say(`  (timed out waiting for ${label})`);
  return false;
}

const loadPids = () => { try { return JSON.parse(fs.readFileSync(PIDS, "utf8")); } catch (_) { return {}; } };
const savePids = (p) => { fs.mkdirSync(RUN, { recursive: true }); fs.writeFileSync(PIDS, JSON.stringify(p, null, 2)); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

function startDetached(name, cmd, args, cwd, env = {}) {
  fs.mkdirSync(RUN, { recursive: true });
  const fd = fs.openSync(path.join(RUN, name + ".log"), "a");
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  const pids = loadPids(); pids[name] = child.pid; savePids(pids);
  return child.pid;
}

function composeCmd() {
  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0) return ["docker", ["compose"]];
  if (spawnSync("docker-compose", ["version"], { stdio: "ignore" }).status === 0) return ["docker-compose", []];
  return null;
}
function dockerReady() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

// ------------------------------------------------------------------ up
async function up() {
  const wantTunnel = process.argv.includes("--tunnel");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) die(`Node.js 22.5+ is required (you have ${process.versions.node}).`);
  if (!fs.existsSync(path.join(DEVKIT, "install", "docker-compose.yml"))) die("The devkit isn't set up yet. Run:  npm run setup");
  for (const a of APPS) if (!fs.existsSync(path.join(ROOT, a.dir, "node_modules"))) die(`${a.dir} has no node_modules. Run:  npm run setup`);
  if (spawnSync("docker", ["--version"], { stdio: "ignore" }).status !== 0) die("Docker is not installed. Install Docker Desktop (Windows/macOS) or Docker Engine + the compose plugin (Linux).");
  if (!dockerReady()) die("Docker is installed but its daemon is not running. Start Docker Desktop (or the docker service), wait until it says it is running, then re-run.");
  const compose = composeCmd();
  if (!compose) die("Docker Compose v2 was not found (`docker compose version` failed).");

  say("\n[1/4] Starting the Beckn/onix network in Docker (first run pulls ~1 GB of images — be patient)…");
  const r = spawnSync(compose[0], [...compose[1], "up", "-d"], { cwd: INSTALL, stdio: "inherit" });
  if (r.status !== 0) {
    die("`docker compose up -d` failed. Common causes:\n" +
        "  • a host port is already in use (this stack publishes 8081, 8083-8086, 9000, 18082, 18084, 18085, 3003, 3004) —\n" +
        "    free it, or change the left-hand number in network/DEG-repo/devkits/p2p-trading-ies-wave2/install/docker-compose.yml\n" +
        "    (and set the matching ONIX_*_URL env var for the app that talks to it — see README);\n" +
        "  • no internet / a corporate proxy blocking Docker image pulls (configure Docker Desktop's proxy settings).");
  }
  say("  waiting for the adapters to listen…");
  for (const o of ONIX_PORTS) {
    const ok = await waitUntil(() => portOpen(o.port), 120000, `${o.what} on :${o.port}`);
    if (!ok) die(`${o.what} never started listening on port ${o.port}. Check:  docker compose -f "${path.join(INSTALL, "docker-compose.yml")}" logs ${o.what.split(" ")[0]}`);
  }

  say("\n[2/4] Policy file server (serves the locally-amended contract policy to the adapters)…");
  if (await portOpen(POLICY_PORT)) say(`  already listening on :${POLICY_PORT}`);
  else {
    startDetached("policy-server", process.execPath, [path.join(__dirname, "policy-server.js"), POLICY_DIR, String(POLICY_PORT)], ROOT);
    if (!(await waitUntil(() => portOpen(POLICY_PORT), 15000, "policy server"))) die("The policy server did not start — see .run/policy-server.log");
    say(`  started on :${POLICY_PORT}`);
  }

  say("\n[3/4] Public tunnel for the Buyer's network Discover" + (wantTunnel ? "" : " (skipped — use `npm run up -- --tunnel` to enable)"));
  const bapFile = path.join(ROOT, "buyer-app", "public-bap-uri.txt");
  if (wantTunnel) await startTunnel(bapFile);
  else if (!process.env.PUBLIC_BAP_URI && !fs.existsSync(bapFile)) say("  Buyer \"Discover offers\" will stay empty until you enable it; everything else works. You can always buy directly by offer ID.");

  say("\n[4/4] Starting the four apps…");
  const pids = loadPids();
  for (const a of APPS) {
    if (pids[a.name] && alive(pids[a.name]) && (await httpStatus(`http://localhost:${a.port}/api/health`)) === 200) { say(`  ${a.label} already running on :${a.port}`); continue; }
    if (await portOpen(a.port)) die(`Port ${a.port} (${a.dir}) is in use by something that is not this demo's app. Free it and re-run.`);
    startDetached(a.name, process.execPath, ["server.js"], path.join(ROOT, a.dir));
    const ok = await waitUntil(async () => (await httpStatus(`http://localhost:${a.port}/api/health`)) === 200, 40000, a.dir);
    if (!ok) die(`${a.dir} did not become healthy — see .run/${a.name}.log`);
    say(`  ${a.label} up on :${a.port}`);
  }

  say("\n✓ Demo is running. Open (ideally side by side):");
  for (const a of APPS) say(`    ${a.label}  http://localhost:${a.port}`);
  say("\n  Reset to a clean slate any time:  npm run reset     Stop everything:  npm run down\n");
}

async function startTunnel(bapFile) {
  if (process.env.PUBLIC_BAP_URI) { say("  using PUBLIC_BAP_URI from the environment"); return; }
  if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0) {
    say("  cloudflared is not installed, so no tunnel was started. Install it (free, no account needed for quick tunnels):");
    say("    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    return;
  }
  const logFile = path.join(RUN, "tunnel.log");
  fs.mkdirSync(RUN, { recursive: true });
  try { fs.unlinkSync(logFile); } catch (_) {}
  startDetached("tunnel", "cloudflared", ["tunnel", "--url", "http://localhost:8081", "--no-autoupdate"], ROOT);
  let url = null;
  await waitUntil(async () => {
    try { const m = fs.readFileSync(path.join(RUN, "tunnel.log"), "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { url = m[0]; return true; } } catch (_) {}
    return false;
  }, 45000, "cloudflared to print its public URL");
  if (!url) return say("  the tunnel did not report a URL — see .run/tunnel.log");
  fs.writeFileSync(bapFile, url + "\n");
  say(`  tunnel: ${url}  → written to buyer-app/public-bap-uri.txt`);
}

// ------------------------------------------------------------------ down
async function down() {
  const pids = loadPids();
  for (const [name, pid] of Object.entries(pids)) {
    if (alive(pid)) { try { process.kill(pid); say(`  stopped ${name} (pid ${pid})`); } catch (e) { say(`  could not stop ${name}: ${e.message}`); } }
  }
  savePids({});
  if (process.argv.includes("--all")) {
    const compose = composeCmd();
    if (compose) { say("  stopping the Docker network…"); spawnSync(compose[0], [...compose[1], "down"], { cwd: INSTALL, stdio: "inherit" }); }
  }
  say("✓ Stopped." + (process.argv.includes("--all") ? "" : "  (The Docker containers keep running; add --all to stop them too.)"));
}

// ------------------------------------------------------------------ status
async function status() {
  say("\nApps:");
  for (const a of APPS) {
    const s = await httpStatus(`http://localhost:${a.port}/api/health`);
    say(`  ${s === 200 ? "✓" : "✗"} ${a.label} http://localhost:${a.port}  ${s === 200 ? "healthy" : "NOT running"}`);
  }
  say(`  ${(await portOpen(POLICY_PORT)) ? "✓" : "✗"} policy server        :${POLICY_PORT}`);
  say("\nOnix network:");
  for (const o of ONIX_PORTS) say(`  ${(await portOpen(o.port)) ? "✓" : "✗"} ${o.what.padEnd(24)} :${o.port}`);
  const bap = path.join(ROOT, "buyer-app", "public-bap-uri.txt");
  say("\nBuyer network-Discover tunnel: " + (fs.existsSync(bap) ? fs.readFileSync(bap, "utf8").trim() + "  (may be stale if cloudflared was restarted)" : "not configured (optional)"));
  say();
}

// ------------------------------------------------------------------ reset / test
async function reset() {
  try {
    const res = await fetch("http://localhost:4004/api/reset-all", { method: "POST" });
    const j = await res.json();
    say(j.ok ? "✓ All four dashboards reset." : "Partly reset: " + JSON.stringify(j.results));
  } catch (e) { die("Could not reach the Grid app on :4004 — is the demo running? (" + e.message + ")"); }
}

function test() {
  const env = { ...process.env };
  const hasTunnel = env.PUBLIC_BAP_URI || fs.existsSync(path.join(ROOT, "buyer-app", "public-bap-uri.txt"));
  if (!hasTunnel) { env.NO_TUNNEL = "1"; say("(no tunnel configured — the suite will skip the shared-network Discover step)"); }
  say("Running the end-to-end suite. NOTE: it resets all four dashboards first and last.\n");
  const r = spawnSync(process.execPath, [path.join(ROOT, "tests", "e2e.js")], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}

const cmd = process.argv[2];
const table = { up, down, status, reset, test };
if (!table[cmd]) { say("Usage: node scripts/demo.js <up [--tunnel] | down [--all] | status | reset | test>"); process.exit(cmd ? 1 : 0); }
Promise.resolve(table[cmd]()).catch((e) => die(e.stack || String(e)));
