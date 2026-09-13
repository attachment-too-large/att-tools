#!/usr/bin/env node
/* ==========================================================================
   att-tools — test suite
   Runs every tool for real: split → join with hash comparison, corruption and
   missing-shard handling, double-click rebuild scripts, the Base64 maths,
   database validation, bounce translation, and a one-shot share link.

   Usage:  node tools/test.mjs            (tests the sources in src/)
           node tools/test.mjs --exe      (tests the built executables in dist/)
   ========================================================================== */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USE_EXE = process.argv.includes("--exe");
const TOOLS = ["split", "join", "info", "limits", "ndr", "share"];

let failed = 0, total = 0;
const ok = (name, pass, detail = "") => {
  total++;
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(40)} ${detail}`);
};

function tool(name) {
  if (USE_EXE) {
    const exe = join(ROOT, "dist", `att-${name}${process.platform === "win32" ? ".exe" : ""}`);
    return { cmd: exe, args: [], exists: existsSync(exe) };
  }
  return { cmd: process.execPath, args: [join(ROOT, "src", `${name}.mjs`)], exists: true };
}
function run(name, args, opts = {}) {
  const t = tool(name);
  if (!t.exists) return { code: 127, out: "", err: `missing ${name}` };
  const r = spawnSync(t.cmd, [...t.args, ...args], { encoding: "utf8", input: opts.input, cwd: opts.cwd || ROOT, timeout: opts.timeout || 120000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const rm = (p) => { try { unlinkSync(p); } catch { /* absent */ } };

const work = mkdtempSync(join(tmpdir(), "att-tools-"));
process.on("uncaughtException", (e) => {
  console.error("\nTest runner crashed:", e.message);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

console.log(`att-tools test suite · ${USE_EXE ? "built executables" : "sources"}\n`);

/* ---------- 1. every tool answers ---------- */
console.log("=== 1. All six tools respond ===");
for (const name of TOOLS) {
  const v = run(name, ["--version"]);
  ok(`att-${name} --version`, v.code === 0 && /^0\.1\.0/.test(v.out.trim()), v.out.trim() || v.err.split("\n")[0]);
  const h = run(name, ["--help"]);
  ok(`att-${name} --help`, h.code === 0 && /Usage/.test(h.out), (h.out.match(/Usage/) ? "prints usage" : h.err.split("\n")[0]));
}

/* ---------- 2. split / join round trip ---------- */
console.log("\n=== 2. Split and rebuild ===");
const SIZE = 5 * 1024 * 1024 + 12345;
const src = join(work, "report_v7_final-FINAL.bin");
{
  const buf = Buffer.allocUnsafe(SIZE);
  let seed = 20260101;
  for (let i = 0; i < SIZE; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; buf[i] = seed & 0xff; }
  writeFileSync(src, buf);
}
const srcHash = sha(src);

{
  const s = run("split", [src, "--limit", "2MB", "--json"]);
  let j = null; try { j = JSON.parse(s.out); } catch {}
  ok("split returns 0", s.code === 0, "exit=" + s.code);
  ok("split makes 3 shards", j?.shards?.length === 3, j ? j.shards.length + " shards" : "no json");
  ok("shard bytes add up", j && j.shards.reduce((a, x) => a + x.bytes, 0) === SIZE, j ? String(j.shards.reduce((a, x) => a + x.bytes, 0)) : "-");
  ok("manifest written", j && existsSync(join(work, j.manifest)), j?.manifest || "-");
  const scripts = readdirSync(work).filter((f) => f.includes("reassemble"));
  ok("three rebuild scripts", scripts.length === 3, scripts.join(" "));

  const manifest = join(work, "report_v7_final-FINAL.bin.att.json");
  const out = join(work, "rebuilt.bin");
  const jn = run("join", [manifest, "--out", out]);
  ok("join returns 0", jn.code === 0, "exit=" + jn.code);
  ok("rebuilt file is identical", existsSync(out) && sha(out) === srcHash, existsSync(out) ? sha(out).slice(0, 16) + "…" : "missing");
}

/* ---------- 3. corruption and missing shards ---------- */
console.log("\n=== 3. Corruption and missing shards ===");
{
  const manifest = join(work, "report_v7_final-FINAL.bin.att.json");
  const shard2 = readdirSync(work).find((f) => f.includes(".att-part-002"));
  const shardPath = join(work, shard2);
  const original = readFileSync(shardPath);
  const damaged = Buffer.from(original);
  damaged[64] ^= 0xff;
  writeFileSync(shardPath, damaged);
  const out = join(work, "should-not-exist.bin");
  rm(out);
  const r = run("join", [manifest, "--out", out]);
  ok("corrupt shard → exit 1", r.code === 1, "exit=" + r.code);
  ok("corrupt shard → writes nothing", !existsSync(out), existsSync(out) ? "WROTE A FILE" : "nothing written");
  ok("names the corrupt shard", /corrupt/.test(r.err) && r.err.includes(shard2), (r.err.split("\n").find((l) => l.includes(shard2)) || "").trim().slice(0, 44));

  writeFileSync(shardPath, original);
  const shard3 = readdirSync(work).find((f) => f.includes(".att-part-003"));
  const saved = readFileSync(join(work, shard3));
  unlinkSync(join(work, shard3));
  const r3 = run("join", [manifest, "--out", join(work, "nope.bin")]);
  ok("missing shard → exit 1", r3.code === 1 && /missing/.test(r3.err), (r3.err.match(/missing.*/) || [""])[0].trim().slice(0, 40));
  writeFileSync(join(work, shard3), saved);
}

/* ---------- 4. the recipient's double-click ---------- */
console.log("\n=== 4. Recipient rebuilds it with nothing installed ===");
if (process.platform === "win32") {
  const target = join(work, "report_v7_final-FINAL.bin");
  const ps1 = readdirSync(work).find((f) => f.endsWith(".att-reassemble.ps1"));
  const cmdFile = readdirSync(work).find((f) => f.endsWith(".att-reassemble.cmd"));
  rm(target);
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(work, ps1)], { encoding: "utf8", cwd: work, timeout: 120000 });
  ok(".ps1 rebuilds and verifies", existsSync(target) && sha(target) === srcHash, (ps.stdout || "").trim().split("\n").pop()?.slice(0, 46) || "exit=" + ps.status);
  rm(target);
  const cm = spawnSync("cmd.exe", ["/c", join(work, cmdFile)], { encoding: "utf8", cwd: work, input: "\r\n", timeout: 120000 });
  ok(".cmd double-click rebuilds", existsSync(target) && sha(target) === srcHash, ((cm.stdout || "").includes("Verified") ? "verified" : "exit=" + cm.status));
  const shText = readFileSync(join(work, readdirSync(work).find((f) => f.endsWith(".att-reassemble.sh"))), "utf8");
  ok(".sh carries hash verification", /sha256sum/.test(shText) && /expected=/.test(shText), "ok");
} else {
  ok("POSIX rebuild script exists", readdirSync(work).some((f) => f.endsWith(".att-reassemble.sh")), "skipped windows checks");
}

/* ---------- 5. info: the Base64 maths ---------- */
console.log("\n=== 5. att-info does the encoded-size maths ===");
{
  const big = join(work, "quarterly.bin");
  writeFileSync(big, Buffer.alloc(Math.round(24.7 * 1024 * 1024), 0x41));
  const r = run("info", [big, "--json"]);
  let j = null; try { j = JSON.parse(r.out); } catch {}
  ok("info --json parses", !!j, j ? `${j.human} → ${j.encodedHuman}` : "no json");
  ok("overhead is 30–40%", j && j.overheadPercent >= 30 && j.overheadPercent <= 40, j ? j.overheadPercent + "%" : "-");
  ok("Outlook.com verdict: does not fit", j?.verdicts?.some((v) => v.id === "outlook.com" && v.fits === false), "24.7 MB → 33.8 MB encoded");
  ok("a 35 MB service still fits", j?.verdicts?.some((v) => v.fits === true), j ? j.verdicts.filter((v) => v.fits).map((v) => v.id).join(",") : "-");
  ok("suggests 2 shards at 20 MB", j?.shardsAt20MB === 2, String(j?.shardsAt20MB));
  const plain = run("info", [big]);
  ok("human output suggests att-split", /att-split/.test(plain.out), (plain.out.match(/att-split.*/) || [""])[0].trim().slice(0, 40));
}

/* ---------- 6. limits ---------- */
console.log("\n=== 6. att-limits: query and validate ===");
{
  const all = run("limits", ["--json"]);
  let j = null; try { j = JSON.parse(all.out); } catch {}
  ok("lists the database", j && j.count >= 5, j ? j.count + " services" : "no json");
  const one = run("limits", ["outlook"]);
  ok("keyword filter works", /Outlook\.com/.test(one.out) && /20 MB/.test(one.out), (one.out.match(/Outlook\.com.*/) || [""])[0].trim().slice(0, 40));
  const val = run("limits", ["--validate"]);
  ok("database validates", val.code === 0 && /no problems/.test(val.out), "7 services, 0 problems");
  const valJson = run("limits", ["--validate", "--json"]);
  let vj = null; try { vj = JSON.parse(valJson.out); } catch {}
  ok("validation is machine-readable", vj?.ok === true && vj.checked > 0, vj ? `${vj.checked} checked` : "-");
}

/* ---------- 7. ndr ---------- */
console.log("\n=== 7. att-ndr translates bounces ===");
{
  const r = run("ndr", ["-"], { input: "Remote Server returned '550 5.3.4 Message size exceeds fixed maximum message size'\nAttachment size: 24.7 MB\n" });
  ok("recognises 550 5.3.4", /5\.3\.4/.test(r.out) && /your side/.test(r.out), "names who blocked it");
  ok("extracts sizes", /24\.7 MB/.test(r.out), "24.7 MB");
  ok("offers a next step", /att-split/.test(r.out), "att-split …");
  const rc = run("ndr", ["-"], { input: "0x80040610 the message exceeds the size limit" });
  ok("recognises 0x80040610", /0x80040610/.test(rc.out), "hex code");
  const rj = run("ndr", ["-", "--json"], { input: "550 5.3.4 too large" });
  let j = null; try { j = JSON.parse(rj.out); } catch {}
  ok("ndr --json parses", j?.findings?.length >= 1, j ? j.findings[0].title.slice(0, 34) : "no json");
  const ru = run("ndr", ["-"], { input: "hello, this is not a bounce at all" });
  ok("unknown input says so", /do not recognise/.test(ru.out), "says so honestly");
}

/* ---------- 8. share: a real one-shot link ---------- */
console.log("\n=== 8. att-share serves one file, once ===");
{
  const payload = join(work, "share-me.bin");
  const bytes = randomBytes(256 * 1024);
  writeFileSync(payload, bytes);
  const want = createHash("sha256").update(bytes).digest("hex");

  const t = tool("share");
  const child = spawnSync(t.cmd, [...t.args, payload, "--port", "0", "--once", "--json"], {
    encoding: "utf8", cwd: ROOT, timeout: 30000
  });
  // --once with no downloader will block; instead start it detached and fetch it ourselves.
  // Simplest portable approach: run it in the background and read the announced URL from a file.
  const urlFile = join(work, "share-url.txt");
  const { spawn } = await import("node:child_process");
  const proc = spawn(t.cmd, [...t.args, payload, "--port", "0", "--once"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => { out += d.toString(); });
  proc.stderr.on("data", (d) => { out += d.toString(); });

  const waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
    return false;
  };
  const gotUrl = await waitFor(() => /http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\S+/.test(out));
  const url = (out.match(/http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\S+/) || [])[0];
  ok("share announces a URL", gotUrl && !!url, url ? url.replace(/\/[^/]+\/[^/]+$/, "/<token>/<file>") : (out.split("\n")[0] || "no output").slice(0, 50));

  if (url) {
    // undici's fetch is flaky against a just-spawned child in some environments;
    // node:http is lower level and deterministic.
    const httpGet = (u) => new Promise((res2) => {
      import("node:http").then(({ get }) => {
        const req = get(u, (r) => {
          const chunks = [];
          r.on("data", (ch) => chunks.push(ch));
          r.on("end", () => res2({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", (e) => res2({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.code || e.message }));
        req.setTimeout(8000, () => { req.destroy(); res2({ status: 0, headers: {}, body: Buffer.alloc(0), error: "timeout" }); });
      });
    });

    // Rewrite only the token segment — a naive regex here would eat the "//" in "http://".
    const parsed = new URL(url);
    const wrongUrl = parsed.origin + "/wrongtoken/" + parsed.pathname.split("/").pop();

    let wrong = await httpGet(wrongUrl);
    for (let i = 0; i < 3 && wrong.status === 0; i++) {           // retry: the child may still be warming up
      await new Promise((r) => setTimeout(r, 400));
      wrong = await httpGet(wrongUrl);
    }
    ok("wrong token → 404", wrong.status === 404, `HTTP ${wrong.status}${wrong.error ? " (" + wrong.error + ")" : ""}`);

    const res = await httpGet(url);
    ok("link serves the file", res.status === 200 && res.body.length === bytes.length, `HTTP ${res.status} · ${res.body.length} bytes`);
    ok("served bytes are correct", createHash("sha256").update(res.body).digest("hex") === want, "sha256 matches");
    ok("content-disposition set", /attachment/.test(res.headers["content-disposition"] || ""), res.headers["content-disposition"] || "-");

    const used = await waitFor(() => proc.exitCode !== null, 8000);
    ok("shuts down after one download", used, "process exited");
  } else {
    proc.kill();
  }
  try { proc.kill(); } catch {}
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
