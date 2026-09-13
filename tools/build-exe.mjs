#!/usr/bin/env node
/* ==========================================================================
   Build the six att-tools executables.

   For each tool:
     esbuild  → one bundled CommonJS file (SEA only reliably supports CJS)
     Node SEA → a blob with the limits database inlined
     postject → inject the blob into a copy of the Node runtime
     then run the produced exe and assert it really works

   Usage:  node tools/build-exe.mjs               all six
           node tools/build-exe.mjs split limits  only those
           node tools/build-exe.mjs --no-verify
   ========================================================================== */
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["split", "join", "info", "limits", "ndr", "share"];
const isWin = process.platform === "win32";
const EXT = isWin ? ".exe" : "";
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const NODE_BIN = process.execPath;
const BUILD = join(ROOT, "build");
const DIST = join(ROOT, "dist");

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const which = wanted.length ? wanted : ALL;
const verify = !flags.includes("--no-verify");

const c = (code, s) => (process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", cwd: ROOT, shell: false, ...opts });
const npm = (pkgs) => {
  const cli = join(dirname(NODE_BIN), "node_modules", "npm", "bin", "npm-cli.js");
  const args = ["install", "--no-audit", "--no-fund", "--save-dev", ...pkgs];
  // Windows cannot spawn npm.cmd directly (Node ≥18.20 requires shell for .cmd/.bat),
  // so prefer npm's JS entry point.
  return existsSync(cli)
    ? run(NODE_BIN, [cli, ...args], { timeout: 300000 })
    : run(isWin ? "npm.cmd" : "npm", args, { shell: isWin, timeout: 300000 });
};

mkdirSync(BUILD, { recursive: true });
mkdirSync(DIST, { recursive: true });

/* ---------- dependencies ---------- */
console.log(`\n${c(1, "att-tools")} · building ${which.length} executable(s) for ${process.platform}-${process.arch} · Node ${process.version}\n`);

const postject = join(ROOT, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postject)) {
  console.log("[deps] installing postject …");
  const r = npm(["postject"]);
  if (!existsSync(postject)) { console.error(c(31, "could not install postject: ") + (r.error?.message || r.stderr || r.stdout || "").slice(0, 300)); process.exit(1); }
}
let esbuild = null;
try { esbuild = await import("esbuild"); }
catch {
  console.log("[deps] installing esbuild …");
  const r = npm(["esbuild"]);
  try { esbuild = await import("esbuild"); }
  catch { console.error(c(31, "could not install esbuild: ") + (r.error?.message || r.stderr || "").slice(0, 300)); process.exit(1); }
}

const LIMITS_JSON = readFileSync(join(ROOT, "data", "limits.json"), "utf8");
const results = [];
let failed = 0;

/* ---------- pass 1: build every requested executable ---------- */
/* Two passes on purpose: att-split's smoke test rejoins its own output with att-join,
   so every executable must exist before verification starts. */
for (const name of which) {
  const entry = join(ROOT, "src", `${name}.mjs`);
  const bundle = join(BUILD, `att-${name}.cjs`);
  const blob = join(BUILD, `att-${name}.blob`);
  const seaConfig = join(BUILD, `sea-${name}.json`);
  const out = join(DIST, `att-${name}${EXT}`);

  console.log(`${c(36, "▶")} build att-${name}`);
  if (!existsSync(entry)) { console.log(`    ${c(31, "missing")} ${entry}`); failed++; results.push({ name, ok: false }); continue; }

  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    legalComments: "none",
    logLevel: "error",
    define: { __ATT_LIMITS__: LIMITS_JSON }     // single-file exes have no data/ folder next to them
  });

  writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2) + "\n", "utf8");
  const sea = run(NODE_BIN, ["--experimental-sea-config", seaConfig]);
  if (!existsSync(blob)) { console.log(`    ${c(31, "SEA blob failed")}: ${(sea.stderr || sea.stdout || "").slice(0, 200)}`); failed++; results.push({ name, ok: false }); continue; }

  rmSync(out, { force: true });
  copyFileSync(NODE_BIN, out);
  // macOS: the copied runtime is code-signed, and injecting a blob invalidates that
  // signature — Node's SEA docs require stripping it before postject runs.
  if (process.platform === "darwin") {
    const cs = run("codesign", ["--remove-signature", out]);
    if (cs.status !== 0) console.log("    (codesign --remove-signature failed; continuing anyway)");
  }
  const inject = run(NODE_BIN, [postject, out, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SENTINEL]);
  if (inject.status !== 0) { console.log(`    ${c(31, "inject failed")}: ${(inject.stderr || inject.stdout || "").slice(0, 200)}`); failed++; results.push({ name, ok: false }); continue; }

  console.log(`    ${c(32, "built")}  ${(statSync(out).size / 1048576).toFixed(1)} MB`);
  results.push({ name, ok: true, sizeMB: (statSync(out).size / 1048576).toFixed(1) });
}

/* ---------- pass 2: run each executable ---------- */
if (verify) {
  console.log("");
  for (const r of results.filter((r) => r.ok)) {
    const name = r.name;
    const out = join(DIST, `att-${name}${EXT}`);
    console.log(`${c(36, "▶")} verify att-${name}`);

    const v = run(out, ["--version"]);
    const h = run(out, ["--help"]);
    const runs = v.status === 0 && /^0\.1\.0/.test((v.stdout || "").trim()) && h.status === 0 && /Usage/.test(h.stdout || "");
    if (!runs) {
      failed++; r.ok = false;
      console.log(`    ${c(31, "FAIL")}  ${(v.stderr || v.stdout || "").split("\n")[0].slice(0, 90)}`);
      continue;
    }

    const work = join(BUILD, `verify-${name}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const file = join(work, "check.bin");
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024 + 777, 0x5a));

    let smoke = true, detail = "runs";
    if (name === "split") {
      const sp = run(out, [file, "--limit", "1MB", "--json"]);
      let j = null; try { j = JSON.parse(sp.stdout); } catch {}
      smoke = sp.status === 0 && j?.shards?.length === 4;
      detail = j ? `${j.shards.length} shards` : "no json";
      if (smoke) {
        const joinExe = join(DIST, `att-join${EXT}`);
        // --out is required here: the source file is still sitting in the same folder,
        // and att-join refuses to overwrite it (by design).
        const jn = run(joinExe, [join(work, "check.bin.att.json"), "--out", join(work, "rebuilt.bin"), "--json"]);
        let jj = null; try { jj = JSON.parse(jn.stdout); } catch {}
        smoke = jn.status === 0 && jj?.ok === true;
        detail += jj?.ok ? " · rejoin verified" : ` · rejoin failed (exit ${jn.status})`;
      }
    } else if (name === "join") {
      run(join(DIST, `att-split${EXT}`), [file, "--limit", "1MB", "--json"]);
      const jn = run(out, [join(work, "check.bin.att.json"), "--out", join(work, "rebuilt.bin"), "--json"]);
      let jj = null; try { jj = JSON.parse(jn.stdout); } catch {}
      smoke = jn.status === 0 && jj?.ok === true;
      detail = jj?.ok ? `rebuilt ${jj.bytes} bytes` : "rejoin failed";
    } else if (name === "info") {
      const r = run(out, [file, "--json"]);
      let j = null; try { j = JSON.parse(r.stdout); } catch {}
      smoke = r.status === 0 && j?.bytes > 0 && j?.encodedBytes > j?.bytes;
      detail = j ? `${j.human} → ${j.encodedHuman}` : "no json";
    } else if (name === "limits") {
      const r = run(out, ["--validate"]);
      smoke = r.status === 0 && /no problems/.test(r.stdout || "");
      detail = "database valid";
    } else if (name === "ndr") {
      const r = run(out, ["-", "--json"], { input: "550 5.3.4 Message size exceeds fixed maximum message size" });
      let j = null; try { j = JSON.parse(r.stdout); } catch {}
      smoke = r.status === 0 && j?.findings?.length >= 1;
      detail = j ? j.findings[0].title.slice(0, 28) : "no json";
    } else if (name === "share") {
      const r = run(out, ["--help"]);
      smoke = r.status === 0 && /--once/.test(r.stdout || "");
      detail = "usage lists the expiry and budget flags";
    }
    rmSync(work, { recursive: true, force: true });
    if (!smoke) failed++;
    r.ok = smoke;
    console.log(`    ${smoke ? c(32, "PASS") : c(31, "FAIL")}  ${r.sizeMB} MB · ${detail}`);
  }
}

/* ---------- summary ---------- */
console.log("");
console.log(c(1, "Summary"));
for (const r of results) {
  const file = join(DIST, `att-${r.name}${EXT}`);
  const hash = existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "—";
  console.log(`  ${r.ok ? c(32, "✓") : c(31, "✗")}  att-${r.name}${EXT.padEnd(4)}  ${String(r.sizeMB || "?").padStart(5)} MB  sha256 ${hash}…`);
}
console.log("");
console.log(`  ${results.filter((r) => r.ok).length}/${which.length} built · output in ${DIST}`);
console.log(c(2, "  Each exe carries the Node runtime, hence the size. No dependencies on the target machine."));
console.log("");
process.exit(failed ? 1 : 0);
