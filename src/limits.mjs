#!/usr/bin/env node
/* att-limits — query the attachment-limits database, or validate it.
   The database is a plain JSON file so it can be reviewed, diffed and cited. */
import {
  VERSION, loadLimits, parseArgs, say, die, banner, dim, bold, cyan, green, red,
  yellow, jsonOut, pad, BIN
} from "./core.mjs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const NAME = BIN("att-limits");
const data = loadLimits();

if (flags.version) { say(VERSION); process.exit(0); }
if (flags.help || (!positional.length && !flags.validate && !flags.json && !flags.all)) {
  banner(NAME, "attachment limits by mail service");
  say(bold("  Usage"));
  say(`    ${NAME} [keyword]        list limits, optionally filtered`);
  say(`    ${NAME} --validate       check the database for duplicates and missing fields`);
  say(`    ${NAME} --json           machine-readable output`);
  say("");
  say(bold("  Examples"));
  say(`    ${NAME} outlook`);
  say(`    ${NAME} --json | jq '.services[] | select(.limitMB > 20)'`);
  process.exit(0);
}

if (!data) die("No limits database found. Expected data/limits.json next to the executable (or inlined at build time).");

/* ---------- validate ---------- */
if (flags.validate) {
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(data.services) || !data.services.length) problems.push("services[] is missing or empty");
  for (const s of data.services || []) {
    const where = s && s.id ? s.id : "(no id)";
    if (!s.id) problems.push(`${where}: missing id`);
    if (!s.name) problems.push(`${where}: missing name`);
    if (seen.has(s.id)) problems.push(`${where}: duplicate id`);
    seen.add(s.id);
    if (s.limitMB !== null && typeof s.limitMB !== "number") problems.push(`${where}: limitMB must be a number or null`);
    if (s.limitMB === null && !s.note) problems.push(`${where}: unlimited entries must explain themselves in note`);
    if (!s.verifiedAt) problems.push(`${where}: missing verifiedAt`);
    if (s.verifiedAt && !/^\d{4}-\d{2}(-\d{2})?$/.test(s.verifiedAt)) problems.push(`${where}: verifiedAt should look like YYYY-MM or YYYY-MM-DD`);
    if (s.minMB && s.maxMB && s.minMB > s.maxMB) problems.push(`${where}: minMB greater than maxMB`);
  }
  if (!data.updatedAt) problems.push("updatedAt is missing at the top level");

  if (flags.json) jsonOut({ ok: !problems.length, checked: (data.services || []).length, problems });
  else {
    banner(NAME, "validate");
    if (!problems.length) {
      say(`${green("✓")} ${(data.services || []).length} services · no problems · updatedAt ${data.updatedAt}`);
    } else {
      say(`${red("✗")} ${problems.length} problem(s) in ${(data.services || []).length} services:`);
      problems.forEach((p) => say(`   · ${p}`));
    }
  }
  process.exit(problems.length ? 1 : 0);
}

/* ---------- query ---------- */
const q = (positional[0] || "").toLowerCase();
let list = data.services || [];
if (q) {
  list = list.filter((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.note || "").toLowerCase().includes(q));
  if (!list.length) die(`No service matches "${q}". Run ${NAME} to see them all.`);
}

if (flags.json) {
  jsonOut({ updatedAt: data.updatedAt, count: list.length, services: list });
  process.exit(0);
}

banner(NAME, `data verified ${data.updatedAt}`);
const width = Math.max(...list.map((s) => s.name.length)) + 2;
for (const s of list) {
  const limit = s.limitMB === null
    ? dim("no limit")
    : (s.minMB ? yellow(`${s.minMB}–${s.maxMB} MB`) : green(`${s.limitMB} MB`));
  say(`  ${pad(s.name, width)}${pad(limit, 14)}${dim(s.note || "")}`);
}
say("");
say(dim("  Note: messages are Base64 encoded in transit, inflating size by about 33%."));
say(dim(`  Unsure? Run att-info <file> — it does the arithmetic on the encoded size.`));
