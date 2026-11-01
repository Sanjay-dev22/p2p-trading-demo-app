#!/usr/bin/env node
// One-time setup for a fresh machine. Does exactly three things:
//   1. Fetches the upstream beckn/DEG devkit at a PINNED commit (sparse: only
//      devkits/p2p-trading-ies-wave2) into network/DEG-repo/.
//   2. Copies network/overlay/ on top of it -- this is every change we made to
//      the devkit (the two extra onix adapters for the Aggregator and the
//      Grid/DISCOM, routing + Caddy + docker-compose changes, the locally
//      amended contract policy). See network/README.md for what each file is.
//   3. Runs `npm ci` in each of the four apps.
//
// Usage:  node scripts/setup.js [--skip-npm]
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NET = path.join(ROOT, "network");
const DEG = path.join(NET, "DEG-repo");
const OVERLAY = path.join(NET, "overlay");
const UPSTREAM = "https://github.com/beckn/DEG.git";
// The exact upstream commit this overlay was built and tested against.
const PINNED_SHA = "54a5c7b2a97bd1122022dc0f0c9986ea225942b7";
const SPARSE_DIRS = ["devkits/p2p-trading-ies-wave2"];
const APPS = ["seller-app", "buyer-app", "aggregator-app", "grid-app"];
const skipNpm = process.argv.includes("--skip-npm");

const say = (m) => console.log(m);
function fail(m) { console.error("\n✗ " + m + "\n"); process.exit(1); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) fail(`Could not run "${cmd}": ${r.error.message}. Is it installed and on your PATH?`);
  if (r.status !== 0) fail(`"${cmd} ${args.join(" ")}" failed (exit ${r.status}).`);
}
function out(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---- prerequisites
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) fail(`Node.js 22.5 or newer is required (the apps use the built-in node:sqlite). You have ${process.versions.node}.`);
if (!out("git", ["--version"])) fail("git is not installed or not on your PATH.");
if (!fs.existsSync(OVERLAY)) fail(`${OVERLAY} is missing — is this a complete clone of the repository?`);

// ---- 1. upstream devkit at the pinned commit
say("\n[1/3] Upstream beckn/DEG devkit (pinned " + PINNED_SHA.slice(0, 7) + ")");
if (fs.existsSync(path.join(DEG, ".git"))) {
  const head = out("git", ["rev-parse", "HEAD"], { cwd: DEG });
  if (head === PINNED_SHA) say("  already at the pinned commit — skipping the download.");
  else say(`  network/DEG-repo exists but is at ${head ? head.slice(0, 7) : "an unknown commit"}, not the pinned one. Delete network/DEG-repo and re-run for a clean copy; continuing with what is there.`);
} else {
  fs.mkdirSync(DEG, { recursive: true });
  run("git", ["init", "-q"], { cwd: DEG });
  run("git", ["remote", "add", "origin", UPSTREAM], { cwd: DEG });
  run("git", ["sparse-checkout", "init", "--cone"], { cwd: DEG });
  run("git", ["sparse-checkout", "set", ...SPARSE_DIRS], { cwd: DEG });
  say("  downloading (sparse, a few MB)…");
  run("git", ["fetch", "--depth", "1", "--filter=blob:none", "origin", PINNED_SHA], { cwd: DEG });
  run("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD"], { cwd: DEG });
}

// ---- 2. overlay
say("\n[2/3] Applying our devkit overlay (extra onix adapters, routing, compose, policy)");
const copied = [];
(function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { fs.copyFileSync(s, d); copied.push(path.relative(OVERLAY, s).replace(/\\/g, "/")); }
  }
})(OVERLAY, DEG);
copied.forEach((f) => say("  + " + f));
// docker-compose bind-mounts this; make sure it exists as OUR directory rather
// than being auto-created by Docker as root.
fs.mkdirSync(path.join(DEG, "specification", "policies"), { recursive: true });
// Likewise the (empty) schema cache directory the adapters mount at /app/schemas.
fs.mkdirSync(path.join(DEG, "devkits", "p2p-trading-ies-wave2", "schemas"), { recursive: true });

const must = [
  "devkits/p2p-trading-ies-wave2/install/docker-compose.yml",
  "devkits/p2p-trading-ies-wave2/config/local-p2p-trading-gridapp.yaml",
  "devkits/p2p-trading-ies-wave2/config/local-p2p-trading-aggregatorapp.yaml",
  "devkits/p2p-trading-ies-wave2/policies/p2p-trading-ies-wave2-contractpolicy-local-amended.rego",
  "devkits/p2p-trading-ies-wave2/schemas",
];
for (const f of must) if (!fs.existsSync(path.join(DEG, f))) fail(`Expected ${f} after setup but it is missing.`);

// ---- 3. dependencies
if (skipNpm) say("\n[3/3] npm install skipped (--skip-npm)");
else {
  say("\n[3/3] Installing each app's npm dependencies");
  for (const app of APPS) {
    say(`  ${app}`);
    const hasLock = fs.existsSync(path.join(ROOT, app, "package-lock.json"));
    run("npm", [hasLock ? "ci" : "install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: path.join(ROOT, app), shell: true });
  }
}

say("\n✓ Setup complete.  Next:  npm run up      (then open http://localhost:4003 etc.)\n");
