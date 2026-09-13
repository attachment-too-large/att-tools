#!/usr/bin/env node
/* att-share — when you genuinely must send a link.
   Serves exactly one file behind a random token, with an expiry and a download
   budget, then shuts itself down. No account, no cloud, no upload.
   (This is the real implementation of the "link-shim" project on the site.) */
import { createServer } from "node:http";
import { createReadStream, statSync, existsSync, readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import {
  VERSION, human, parseArgs, say, die, banner, dim, bold, cyan, green, red,
  yellow, jsonOut, sha256OfFile, BIN
} from "./core.mjs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const NAME = BIN("att-share");

if (flags.version) { say(VERSION); process.exit(0); }
if (flags.help || !positional.length) {
  banner(NAME, "share one file over a local link");
  say(bold("  Usage"));
  say(`    ${NAME} <file> [options]`);
  say("");
  say(bold("  Options"));
  say("    --port 8787        port to listen on (0 = pick a free one)");
  say("    --bind 127.0.0.1   or 0.0.0.0 to let others on your network reach it");
  say("    --hours 24         link expires after this many hours");
  say("    --max-downloads 1  how many downloads the link allows");
  say("    --once             shorthand for --max-downloads 1");
  say("    --json             print one JSON line with the URL, then keep serving");
  say("");
  say(bold("  Why this exists"));
  say(dim("    Sometimes a link really is the only thing that works — a recipient who"));
  say(dim("    never opens attachments, a mailbox with no room. This serves the file from"));
  say(dim("    your own machine, to one random address, for a limited time, and then stops."));
  say(dim("    Nothing is uploaded anywhere."));
  process.exit(0);
}

const file = positional[0];
if (!existsSync(file)) die(`File not found: ${file}`);
const st = statSync(file);
if (!st.isFile()) die(`Not a regular file: ${file}`);

const PORT = parseInt(String(flags.port ?? "8787"), 10);
const BIND = String(flags.bind ?? "127.0.0.1");
const HOURS = parseFloat(String(flags.hours ?? "24"));
const MAX = flags.once ? 1 : parseInt(String(flags["max-downloads"] ?? "0"), 10);

if (!Number.isFinite(PORT) || PORT < 0 || PORT > 65535) die(`Invalid --port: ${flags.port}`);
if (!Number.isFinite(HOURS) || HOURS <= 0) die(`Invalid --hours: ${flags.hours}`);
if (!Number.isFinite(MAX) || MAX < 0) die(`Invalid --max-downloads: ${flags["max-downloads"]}`);

const token = randomBytes(18).toString("base64url");
const urlPath = `/${token}/${encodeURIComponent(basename(file))}`;
const expiresAt = Date.now() + HOURS * 3600 * 1000;
const sum = sha256OfFile(file).hex;

let downloads = 0;
let bytesSent = 0;
const log = [];

const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  const ip = (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");

  const deny = (code, why) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${code} ${why}\n`);
    if (code === 404) return;                       // do not leak why a token failed
    log.push({ at: new Date().toISOString(), ip, path, code, why });
    if (!flags.json) say(`  ${red(String(code))}  ${ip}  ${why}`);
  };

  if (Date.now() > expiresAt) { deny(410, "link expired"); return; }
  if (MAX && downloads >= MAX) { deny(410, "download budget used up"); return; }
  if (decodeURIComponent(path) !== urlPath) { deny(404, "not found"); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { deny(405, "method not allowed"); return; }

  downloads++;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": st.size,
    "Content-Disposition": `attachment; filename="${basename(file).replace(/"/g, "")}"`,
    "X-SHA256": sum,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") { res.end(); return; }

  const started = Date.now();
  const stream = createReadStream(file);
  stream.on("data", (chunk) => { bytesSent += chunk.length; });
  stream.on("error", () => { deny(500, "read error"); });
  stream.on("end", () => {
    const entry = { at: new Date().toISOString(), ip, bytes: st.size, ms: Date.now() - started };
    log.push(entry);
    if (!flags.json) say(`  ${green("200")}  ${ip}  sent ${human(st.size)} in ${entry.ms} ms  (${downloads}${MAX ? "/" + MAX : ""})`);
    if (MAX && downloads >= MAX) {
      say("");
      say(green("✓ Download complete. Budget used up — shutting down."));
      finish(0);
    }
  });
  stream.pipe(res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") die(`Port ${PORT} is already in use. Try --port 0 to pick a free one.`);
  die(`Server error: ${e.message}`);
});

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

function finish(code) {
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500);
}

server.listen(PORT, BIND, () => {
  const port = server.address().port;
  const host = BIND === "0.0.0.0" ? (lanAddresses()[0] || "127.0.0.1") : "127.0.0.1";
  const url = `http://${host}:${port}${urlPath}`;
  const expires = new Date(expiresAt).toISOString().replace("T", " ").slice(0, 16);

  if (flags.json) {
    say(JSON.stringify({ ok: true, url, path: urlPath, file: basename(file), bytes: st.size, sha256: sum, expiresAt: new Date(expiresAt).toISOString(), maxDownloads: MAX || null }));
  } else {
    banner(NAME, "one file, one link, one clock");
    say(`  File        ${bold(basename(file))}  ${human(st.size)}`);
    say(`  SHA-256     ${dim(sum)}`);
    say(`  Link        ${cyan(url)}`);
    say(`  Expires     ${expires}  ${dim(`(${HOURS} h)`)}`);
    say(`  Downloads   ${MAX ? MAX : "unlimited"}${MAX ? dim("  · the server stops itself when used up") : ""}`);
    say("");
    say(dim("  Anyone with the link can fetch the file while it lasts. Treat the link like the file."));
    say(dim("  Ctrl+C to stop early."));
    say("");
  }
});

process.on("SIGINT", () => {
  say("");
  say(`  Served ${downloads} download(s), ${human(bytesSent)} in total.`);
  finish(0);
});
