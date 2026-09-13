#!/usr/bin/env node
/* att-info — will this file actually send?
   The server measures the *encoded* message, not your file. This does that maths
   and then checks it against every service in the limits database. */
import { existsSync, statSync } from "node:fs";
import {
  VERSION, human, encodedSize, loadLimits, parseArgs, parseSize, say, die, banner,
  dim, bold, cyan, green, red, jsonOut, pad, BIN
} from "./core.mjs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const NAME = BIN("att-info");

if (flags.version) { say(VERSION); process.exit(0); }
if (flags.help || !positional.length) {
  banner(NAME, "will it send?");
  say(bold("  Usage"));
  say(`    ${NAME} <file> [options]`);
  say("");
  say(bold("  Options"));
  say("    --json          machine-readable output");
  say("    --limit 20MB    check against a specific limit instead of the whole database");
  say("");
  say(dim("  Base64 inflates a payload by about 33%. A 24 MB file looks like 32 MB to the server."));
  say(dim("  That single step is where most people get this wrong."));
  process.exit(0);
}

const file = positional[0];
if (!existsSync(file)) die(`File not found: ${file}`);
const size = statSync(file).size;
const enc = encodedSize(size);
const data = loadLimits();
const limitArg = flags.limit ? String(flags.limit) : null;

const services = data ? data.services : [];
const verdicts = services
  .filter((s) => s.limitMB !== null)
  .map((s) => {
    const limit = s.limitMB * 1024 * 1024;
    return { id: s.id, name: s.name, limitMB: s.limitMB, fits: enc <= limit, overBy: enc > limit ? enc - limit : 0 };
  });

if (flags.json) {
  jsonOut({
    file: BIN(file).length ? file.split(/[\\/]/).pop() : file,
    bytes: size, human: human(size),
    encodedBytes: enc, encodedHuman: human(enc),
    overheadPercent: size > 0 ? Math.round((enc / size - 1) * 100) : 0,
    shardsAt20MB: Math.ceil(enc / (20 * 1024 * 1024)),
    verdicts, updatedAt: data ? data.updatedAt : null
  });
  process.exit(0);
}

banner(NAME, "will it send?");
say(`  ${bold(file.split(/[\\/]/).pop())}`);
say(`  File size       ${human(size)}  ${dim(`(${size} bytes)`)}`);
say(`  Encoded size    ${red(human(enc))}  ${dim(`(Base64 inflates it ${size > 0 ? Math.round((enc / size - 1) * 100) : 0}% — this is what the server sees)`)}`);
if (limitArg) {
  const lim = parseSize(limitArg);
  if (!lim || lim < 1024) die(`Invalid --limit: ${limitArg}`);
  const fits = enc <= lim;
  say(`  Against ${human(lim)}  ${fits ? green("fits") : red(`over by ${human(enc - lim)}`)}`);
} else {
  const parts = Math.ceil(enc / (20 * 1024 * 1024));
  say(`  At 20 MB        ${parts > 1 ? red(`needs ${parts} shards`) : green("one message is enough")}`);
}
say("");

if (verdicts.length) {
  say(bold("  Will it send?"));
  for (const v of verdicts) {
    const label = pad(v.name, 42);
    say(`    ${v.fits ? green("✓") : red("✗")}  ${label}${v.fits ? dim(`limit ${v.limitMB} MB`) : red(`limit ${v.limitMB} MB · over by ${human(v.overBy)}`)}`);
  }
  for (const s of services.filter((s) => s.limitMB === null)) {
    say(`    ${dim("–")}  ${pad(s.name, 42)}${dim("no client-side limit")}`);
  }
  say("");
  if (data) say(dim(`  Data verified ${data.updatedAt}. Defaults change; check the official docs and measure your own limits.`));
}

if (enc > 20 * 1024 * 1024) {
  say("");
  say(`  ${green("Try:")} ${cyan(`att-split "${file.split(/[\\/]/).pop()}" --limit 20MB`)}`);
  say(dim("  Whole-file splitting, SHA-256 per shard, and a rebuild script the recipient can double-click."));
}
