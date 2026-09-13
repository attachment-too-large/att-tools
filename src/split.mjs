#!/usr/bin/env node
/* att-split — cut a file into shards that fit under a mail attachment limit.
   Writes a manifest (SHA-256 per shard) plus double-clickable rebuild scripts. */
import { openSync, readSync, closeSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join as pjoin, resolve } from "node:path";
import {
  VERSION, MANIFEST_SUFFIX, PART_TAG, human, parseSize, sha256OfFile, sha256OfBuffer,
  parseArgs, say, die, banner, dim, bold, cyan, green, jsonOut, pad, BIN
} from "./core.mjs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const NAME = BIN("att-split");

if (flags.version) { say(VERSION); process.exit(0); }
if (flags.help || !positional.length) {
  banner(NAME, "split a file so it fits under an attachment limit");
  say(bold("  Usage"));
  say(`    ${NAME} <file> [options]`);
  say("");
  say(bold("  Options"));
  say("    --limit 20MB   maximum size per shard (default 20MB; KB/MB/GB are 1024-based)");
  say("    --out DIR      where to write the shards (default: next to the source file)");
  say("    --json         machine-readable output");
  say("    --dry-run      report what would happen, write nothing");
  say("");
  say(bold("  What you get"));
  say("    <file>.att-part-001 …   the shards, ready to attach to separate messages");
  say("    <file>.att.json         manifest with the SHA-256 of every shard");
  say("    <file>.att-reassemble.cmd / .ps1 / .sh   rebuild scripts — the recipient needs nothing");
  say("");
  say(dim(`  Example: ${NAME} "Q3-report_v7_final-FINAL.xlsx" --limit 20MB`));
  process.exit(0);
}

const file = positional[0];
if (!existsSync(file)) die(`File not found: ${file}`);

const limitBytes = parseSize(flags.limit || "20MB");
if (!limitBytes || limitBytes < 1024) die(`Invalid --limit: ${flags.limit}`);

const srcSize = statSync(file).size;
if (srcSize === 0) die("The file is empty. Nothing to cut.");

const src = sha256OfFile(file);
const base = basename(file);
const outDir = flags.out ? resolve(String(flags.out)) : dirname(resolve(file));
const count = Math.ceil(srcSize / limitBytes);

if (flags["dry-run"]) {
  const plan = { file: base, bytes: srcSize, limitBytes, shardCount: count, outDir, sha256: src.hex };
  if (flags.json) jsonOut(plan);
  else {
    banner(NAME, "dry run");
    say(`  ${base}  ${human(srcSize)}  →  ${bold(String(count))} shards of at most ${human(limitBytes)}`);
    say(dim(`  would write to ${outDir}`));
  }
  process.exit(0);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const pad0 = String(count).length < 3 ? 3 : String(count).length;
const shards = [];
const fd = openSync(file, "r");
const buf = Buffer.allocUnsafe(limitBytes);
try {
  for (let i = 0; i < count; i++) {
    const target = i * limitBytes;
    let filled = 0;
    while (filled < limitBytes) {
      const n = readSync(fd, buf, filled, limitBytes - filled, target + filled);
      if (n <= 0) break;
      filled += n;
    }
    const partName = `${base}${PART_TAG}${String(i + 1).padStart(pad0, "0")}`;
    const data = buf.subarray(0, filled);
    writeFileSync(pjoin(outDir, partName), data);
    shards.push({ index: i + 1, name: partName, bytes: filled, sha256: sha256OfBuffer(data) });
  }
} finally { closeSync(fd); }

const manifest = {
  tool: NAME, version: VERSION, createdAt: new Date().toISOString(),
  original: { name: base, bytes: srcSize, sha256: src.hex },
  limitBytes, limitHuman: human(limitBytes), shardCount: shards.length, shards
};
const manifestName = `${base}${MANIFEST_SUFFIX}`;
writeFileSync(pjoin(outDir, manifestName), JSON.stringify(manifest, null, 2), "utf8");

const scriptBase = base.replace(/[\\/:*?"<>|]/g, "_");
const files = {
  ps1: `${scriptBase}.att-reassemble.ps1`,
  cmd: `${scriptBase}.att-reassemble.cmd`,
  sh: `${scriptBase}.att-reassemble.sh`
};

/* The .ps1 carries a UTF-8 BOM on purpose: Windows PowerShell 5.1 reads BOM-less
   scripts as ANSI and mangles non-ASCII filenames. The .cmd stays pure ASCII and
   finds the script with a wildcard, because cmd.exe reads batch files as ANSI too. */
writeFileSync(pjoin(outDir, files.ps1), "\uFEFF" + ps1(manifest), "utf8");
writeFileSync(pjoin(outDir, files.cmd), cmd(files.ps1), "utf8");
writeFileSync(pjoin(outDir, files.sh), sh(manifest), "utf8");

if (flags.json) {
  jsonOut({ ok: true, outDir, manifest: manifestName, limitBytes, limitHuman: manifest.limitHuman, shardCount: shards.length, shards, scripts: files });
  process.exit(0);
}

banner(NAME, "shards written");
say(`${green("✓")} Cut into ${bold(String(shards.length))} shards, ${manifest.limitHuman} max each`);
say("");
for (const s of shards) say(`  ${cyan(s.name)}  ${pad(human(s.bytes), 10)} ${dim(s.sha256.slice(0, 16) + "…")}`);
say("");
say(`  Original  ${bold(base)}  ${human(srcSize)}`);
say(`  SHA-256   ${dim(src.hex)}`);
say(`  Manifest  ${cyan(manifestName)}  ${dim("(verifies every shard when rebuilding)")}`);
say("");
say(bold("  Rebuilding on the recipient's side"));
say(`    Windows      double-click ${cyan(files.cmd)}`);
say(`    macOS/Linux  ${cyan(`sh ${files.sh}`)}`);
say("");
say(dim(`  Shards and manifest are in ${outDir}`));
say(dim("  Nothing was uploaded. Splitting happens entirely on this machine."));

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function ps1(m) {
  const parts = m.shards.map((s) => `  ${psQuote(s.name)}`).join(",\n");
  return `# Rebuild script for "${m.original.name}" — generated by ${NAME} v${m.version}
# Usage: right-click → Run with PowerShell, or run .\\${m.original.name}.att-reassemble.ps1
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$parts = @(
${parts}
)
$out = ${psQuote(m.original.name)}
$expected = ${psQuote(m.original.sha256)}

Write-Host "Rebuilding $out ($($parts.Count) shards)…" -ForegroundColor Cyan
$stream = [System.IO.File]::Create((Join-Path $PSScriptRoot $out))
try {
  foreach ($p in $parts) {
    $path = Join-Path $PSScriptRoot $p
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing shard: $p" }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $stream.Write($bytes, 0, $bytes.Length)
  }
} finally { $stream.Close() }

$actual = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $out) -Algorithm SHA256).Hash.ToLower()
if ($actual -eq $expected) {
  Write-Host "✓ Verified. File is complete: $out" -ForegroundColor Green
} else {
  Write-Host "✗ Verification failed. The file may be incomplete:" -ForegroundColor Red
  Write-Host "  expected $expected"
  Write-Host "  actual   $actual"
  exit 1
}
`;
}
function cmd(ps1Name) {
  return `@echo off
rem Double-click this file to rebuild the attachment.
rem The real work is done by the PowerShell script sitting next to it.
set "ATT_PS1="
for %%f in ("%~dp0*.att-reassemble.ps1") do if not defined ATT_PS1 set "ATT_PS1=%%f"
if not defined ATT_PS1 (
  echo Reassemble script not found next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%ATT_PS1%"
echo.
pause
`;
}
function sh(m) {
  const parts = m.shards.map((s) => `'${s.name.replace(/'/g, "'\\''")}'`).join(" ");
  return `#!/bin/sh
# Rebuild script for "${m.original.name}" — generated by ${NAME} v${m.version}
set -e
cd "$(dirname "$0")"
out='${m.original.name.replace(/'/g, "'\\''")}'
expected='${m.original.sha256}'

echo "Rebuilding $out (${m.shards.length} shards)…"
cat ${parts} > "$out"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$out" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$out" | awk '{print $1}')
else
  echo "(no sha256sum on this machine — skipping verification)"; exit 0
fi

if [ "$actual" = "$expected" ]; then
  echo "✓ Verified. File is complete: $out"
else
  echo "✗ Verification failed. Expected $expected, got $actual"; exit 1
fi
`;
}
