#!/usr/bin/env node
// Tiny static file server for the one locally-amended contract policy (.rego).
// The onix containers fetch it from http://host.docker.internal:8099/<file>
// (see network/README.md for why the policy is served locally). Replaces the
// `python -m http.server 8099` the original runbook needed, so Python is not
// a prerequisite.
//   node scripts/policy-server.js <directory> [port]
const http = require("http");
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || ".");
const port = Number(process.argv[3]) || 8099;

http.createServer((req, res) => {
  // Only ever serve a plain .rego file that sits directly in <directory>.
  const name = path.basename(decodeURIComponent((req.url || "/").split("?")[0]));
  if (!name.endsWith(".rego")) { res.writeHead(404); return res.end("not found"); }
  fs.readFile(path.join(dir, name), (err, body) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  });
}).listen(port, "0.0.0.0", () => console.log(`policy server: serving ${dir} on :${port}`));
