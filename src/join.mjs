#!/usr/bin/env node
/* att-join — verify every shard, then rebuild the original file.
   Refuses to write anything if any shard is missing or corrupt. */
import { openSync, closeSync, writeSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join as pjoin, resolve } from "node:path";
import {
  VERSION, MANIFEST_SUFFIX, PART_TAG, human, sha256OfFile, parseArgs, say, die,
  banner, dim, bold, cyan, green, red, jsonOut, BIN
} from "./core.mjs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const NAME = BIN("att-join");

if (flags.version) { say(VERSION); process.exit(0); }
if (flags.help || !positional.length) {
  banner(NAME, "verify shards and rebuild the original file");
  say(bold("  Usage"));
  say(`    ${NAME} <manifest.att.json | any shard> [options]`);
  say("");
  say(bold("  Options"));
  say("    --out FILE    output name (default: the original name recorded in the manifest)");
  say("    --force       overwrite an existing output file");
  say("    --json        machine-readable output");
  say("");
  say(dim("  Every shard is checked against its SHA-256 before a single byte is written."));
  process.exit(0);
}

const target = positional[0];
if (!existsSync(target)) die(`Not found: ${target}`);

function findManifest(t) {
  if (t.endsWith(MANIFEST_SUFFIX) && existsSync(t)) return resolve(t);
  const dir = dirname(resolve(t));
  const base = basename(t);
  const idx = base.indexOf(PART_TAG);
  const stem = idx >= 0 ? base.slice(0, idx) : base;
  const candidate = pjoin(dir, stem + MANIFEST_SUFFIX);
  return existsSync(candidate) ? candidate : null;
}

const manifestPath = findManifest(target);
if (!manifestPath) die(`No manifest (*${MANIFEST_SUFFIX}) found. Keep it in the same folder as the shards.`);

let m;
try { m = JSON.parse(readFileSync(manifestPath, "utf8")); }
catch (e) { die(`Cannot read the manifest: ${manifestPath}\n${e.message}`); }

const dir = dirname(manifestPath);
const outPath = flags.out ? resolve(String(flags.out)) : pjoin(dir, m.original.name);
if (existsSync(outPath) && !flags.force) {
  die(`Output file already exists: ${outPath}\n      add --force to overwrite, or use --out to choose another name.`);
}

const report = [];
let missing = 0, corrupt = 0;
for (const s of m.shards) {
  const p = pjoin(dir, s.name);
  if (!existsSync(p)) { missing++; report.push({ ...s, status: "missing" }); continue; }
  const { hex, bytes } = sha256OfFile(p);
  if (bytes !== s.bytes || hex !== s.sha256) { corrupt++; report.push({ ...s, status: "corrupt", actual: hex, actualBytes: bytes }); }
  else report.push({ ...s, status: "ok" });
}

if (missing || corrupt) {
  if (flags.json) jsonOut({ ok: false, missing, corrupt, shards: report });
  else {
    console.error(red("✗ Shard verification failed. Aborted — no corrupt file was written."));
    for (const r of report) {
      if (r.status === "missing") console.error(`    ${red("missing")}  ${r.name}`);
      if (r.status === "corrupt") console.error(`    ${red("corrupt")}  ${r.name}  ${dim("expected " + r.sha256.slice(0, 12) + "… actual " + String(r.actual).slice(0, 12) + "…")}`);
    }
    console.error(dim(`\n  ${missing} missing, ${corrupt} corrupt. Ask the sender to resend those shards, then run this again.`));
  }
  process.exit(1);
}

const fd = openSync(outPath, "w");
const hasher = createHash("sha256");
let written = 0;
try {
  for (const s of m.shards) {
    const data = readFileSync(pjoin(dir, s.name));
    writeSync(fd, data);
    hasher.update(data);
    written += data.length;
  }
} finally { closeSync(fd); }

const finalHash = hasher.digest("hex");
const ok = finalHash === m.original.sha256 && written === m.original.bytes;

if (flags.json) {
  jsonOut({ ok, out: outPath, bytes: written, sha256: finalHash, expected: m.original.sha256, shards: m.shards.length });
  process.exit(ok ? 0 : 1);
}

banner(NAME, "rebuilt");
if (ok) {
  say(`${green("✓")} Reassembled: ${bold(outPath)}`);
  say(`  all ${m.shards.length} shards verified · ${human(written)}`);
  say(`  SHA-256  ${dim(finalHash)}`);
  process.exit(0);
}
console.error(red("✗ Hash mismatch after rebuilding — the file may have been damaged in transit."));
console.error(`  expected ${m.original.sha256}`);
console.error(`  actual   ${finalHash}`);
process.exit(1);
