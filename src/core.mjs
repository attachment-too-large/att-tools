/* ==========================================================================
   att-tools — shared core
   Zero dependencies: Node built-ins only. Bundled into every tool's executable.
   ========================================================================== */
import { openSync, readSync, closeSync, statSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join as pjoin, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const MANIFEST_SUFFIX = ".att.json";
export const PART_TAG = ".att-part-";

/* Works from source, from a bundled CJS build, and from a single-file exe. */
function detectHere() {
  try { if (typeof __dirname === "string" && __dirname) return __dirname; } catch { /* ignore */ }
  try { return dirname(fileURLToPath(import.meta.url)); } catch { /* ignore */ }
  return dirname(process.execPath);
}
export const HERE = detectHere();
export const LIMITS_FILE = resolve(HERE, "..", "data", "limits.json");

/* ---------- colour & output ---------- */
export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const col = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
export const dim = (s) => col("2", s);
export const bold = (s) => col("1", s);
export const red = (s) => col("31", s);
export const green = (s) => col("32", s);
export const yellow = (s) => col("33", s);
export const cyan = (s) => col("36", s);

export const say = (...a) => console.log(...a);
export function die(msg, code = 1) { console.error(red("Error: ") + msg); process.exit(code); }

/* ---------- sizes ---------- */
export function human(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + " " + units[i];
}

/** "20MB" / "1.5GiB" / "512k" / bytes → integer bytes (KB/MB/GB are 1024-based). */
export function parseSize(text) {
  if (typeof text === "number") return Math.round(text);
  const m = String(text).trim().match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "b").toLowerCase().replace(/ib$/, "b").replace(/bytes?$/, "b");
  const mult = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }[unit];
  if (!mult) return null;
  return Math.round(n * mult);
}

/** What the server actually measures: Base64 plus line breaks plus headers. */
export function encodedSize(bytes) {
  const b64 = Math.ceil(bytes / 3) * 4;
  const crlf = Math.ceil(b64 / 76) * 2;
  return b64 + crlf + 2048;
}

/* ---------- hashing ---------- */
export function sha256OfFile(path) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return { hex: hash.digest("hex"), bytes: size };
}

export const sha256OfBuffer = (buf) => createHash("sha256").update(buf).digest("hex");

/* ---------- limits data (inlined at build time for single-file exes) ---------- */
export function loadLimits() {
  if (typeof __ATT_LIMITS__ !== "undefined" && __ATT_LIMITS__) return __ATT_LIMITS__;
  if (!existsSync(LIMITS_FILE)) return null;
  try { return JSON.parse(readFileSync(LIMITS_FILE, "utf8")); } catch { return null; }
}

/* ---------- args ---------- */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a === "-j") flags.json = true;
    else positional.push(a);
  }
  return { positional, flags };
}

/* ---------- display helpers ---------- */
export function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}
export function pad(s, width) {
  const visible = displayWidth(String(s).replace(/\u001b\[[0-9;]*m/g, ""));
  return String(s) + " ".repeat(Math.max(0, width - visible));
}

/** Standard header for every tool. */
export function banner(title, subtitle) {
  say("");
  say(bold(title) + dim(`  v${VERSION}`) + (subtitle ? dim("  ·  " + subtitle) : ""));
  say(dim("attachmenttoolarge · the Attachment Too Large Society · MIT"));
  say("");
}

export function jsonOut(obj) { say(JSON.stringify(obj, null, 2)); }

export const BIN = (name) => basename(process.argv[1] || name).replace(/\.(exe|cmd|mjs|cjs|js)$/i, "");
