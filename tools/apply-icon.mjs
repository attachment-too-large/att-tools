#!/usr/bin/env node
/* ==========================================================================
   apply-icon.mjs — put our own icon on the built executables

   Node's SEA pipeline has no icon step: the executables come out wearing the plain
   Node icon. Windows reads icons from the PE resource table, so this walks the
   resource entries and replaces the icon group with the flat technical mark in
   assets/icon.ico.

   Usage: node tools/apply-icon.mjs [exe …]      (default: every exe in dist/)
   ========================================================================== */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICO = join(ROOT, "assets", "icon.ico");

let ResEdit;
try { ResEdit = await import("resedit"); }
catch {
  console.error("resedit is not installed. Run: npm install --save-dev resedit");
  process.exit(1);
}

const wanted = process.argv.slice(2);
const targets = wanted.length
  ? wanted.map((p) => resolve(p))
  : readdirSync(join(ROOT, "dist")).filter((n) => n.endsWith(".exe")).map((n) => join(ROOT, "dist", n));

if (!targets.length) { console.error("No .exe files to stamp."); process.exit(1); }

const iconFile = ResEdit.Data.IconFile.from(readFileSync(ICO));
const icons = iconFile.icons.map((i) => i.data);
console.log(`Stamping ${targets.length} executable(s) with ${icons.length} icon sizes from assets/icon.ico\n`);

let done = 0;
for (const exe of targets) {
  try {
    const before = statSync(exe).size;
    const data = readFileSync(exe);
    const nt = ResEdit.NtExecutable.from(data, { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(nt);
    /* 1 = the first icon group, 1033 = en-US. replaceIconsForResource will add the
       group when the executable has none, which is the case for a fresh SEA. */
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
    res.outputResource(nt);
    const out = Buffer.from(nt.generate());
    writeFileSync(exe, out);
    console.log(`  ✓ ${exe.split(/[\\/]/).pop()}  ${(before / 1048576).toFixed(1)} → ${(out.length / 1048576).toFixed(1)} MB`);
    done++;
  } catch (e) {
    console.error(`  ✗ ${exe}: ${e.message}`);
  }
}
console.log(`\n${done}/${targets.length} stamped.`);
process.exit(done === targets.length ? 0 : 1);
