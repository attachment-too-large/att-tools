#!/usr/bin/env node
/* ==========================================================================
   att-gui.mjs — the desktop client's front end

   A local web UI rather than a windowed toolkit, for one honest reason: this is a
   zero-dependency project, and shipping Electron or Qt would add hundreds of
   megabytes to a tool whose entire point is that 20 MB is already too much.

   So the client is a small HTTP server that binds 127.0.0.1 on a random port,
   requires a session key, and drives the command-line tools that sit beside it.
   Nothing leaves the machine; there is no telemetry, no cloud, no account.

   Build: tools/build-exe.mjs gui   →  att-gui.exe
   ========================================================================== */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";


const HERE = dirname(process.execPath);
const VERSION = "0.2.0";


/* The limits database is read from beside the executable, never bundled: inside a SEA
   there is no source tree, and import.meta.url is not even defined in the CJS bundle,
   so anything built on it throws at startup (which is exactly what happened here). */
let LIMITS = { services: [], updatedAt: "not found next to the client" };
for (const candidate of [join(HERE, "data", "limits.json"), join(HERE, "..", "data", "limits.json"), join(HERE, "..", "..", "data", "limits.json")]) {
  try {
    if (existsSync(candidate)) { LIMITS = JSON.parse(readFileSync(candidate, "utf8")); break; }
  } catch { /* keep the empty default; the page says so rather than lying */ }
}
/* The tools live next to this executable once installed. Look in the usual places
   so a development checkout works too. */
function toolPath(name) {
  const candidates = [
    join(HERE, name + ".exe"),
    join(HERE, "..", "dist", name + ".exe"),
    join(HERE, name)
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

/** Run one of the command-line tools and hand back its parsed JSON. */
function runTool(name, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolvePromise) => {
    const exe = toolPath(name);
    if (!exe) {
      resolvePromise({ ok: false, error: "Could not find " + name + ".exe next to the client. Install the tools into the same folder, or run them from the command line." });
      return;
    }
    const child = spawn(exe, args, { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = out.trim();
      try {
        resolvePromise(JSON.parse(trimmed));
      } catch {
        resolvePromise({ ok: code === 0, error: code === 0 ? undefined : (err.trim() || trimmed || "exit " + code), raw: trimmed.slice(0, 2000) });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ ok: false, error: String(e.message) }); });
  });
}

const PAGE = (key) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>attachmenttoolarge — desktop client</title>
<style>
  :root { --bg:#0a0d10; --panel:#12161a; --line:#2a333b; --ink:#e8eef2; --dim:#7c8b96;
          --acc:#4fd1a5; --gold:#c9a961; --bad:#e0242b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 Consolas,"Cascadia Mono",ui-monospace,monospace; }
  header { display:flex; align-items:center; gap:14px; padding:16px 22px;
           border-bottom:4px solid var(--gold); background:var(--panel); }
  header b { font-size:17px; letter-spacing:1px; }
  header span { color:var(--dim); font-size:12px; }
  main { max-width:1080px; margin:0 auto; padding:26px 22px 60px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  @media (max-width:820px) { .row { grid-template-columns:1fr; } }
  .card { background:var(--panel); border:3px solid var(--line); padding:18px; }
  .card h2 { margin:0 0 4px; font-size:15px; letter-spacing:1px; color:var(--acc); }
  .card p.hint { margin:0 0 14px; color:var(--dim); font-size:12px; }
  label { display:block; margin:12px 0 4px; font-size:12px; color:var(--dim); }
  input, select, button { font:inherit; }
  input, select { width:100%; padding:10px; background:#0d1114; color:var(--ink);
                  border:2px solid var(--line); }
  input:focus, select:focus { outline:none; border-color:var(--acc); }
  button { margin-top:16px; padding:11px 18px; background:var(--acc); color:#06231b;
           border:2px solid var(--acc); font-weight:700; letter-spacing:.5px; cursor:pointer; }
  button:hover { background:var(--gold); border-color:var(--gold); }
  button:disabled { background:#2a333b; border-color:#2a333b; color:var(--dim); cursor:progress; }
  pre { margin:16px 0 0; padding:14px; background:#0d1114; border-left:5px solid var(--acc);
        white-space:pre-wrap; word-break:break-word; font-size:13px; min-height:44px; }
  pre.bad { border-left-color:var(--bad); }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:6px 0;
        border-bottom:1px dashed var(--line); font-size:13px; }
  .kv span:last-child { color:var(--gold); }
  footer { color:var(--dim); font-size:11px; padding:18px 22px; border-top:2px solid var(--line); }
</style></head><body>
<header>
  <svg width="30" height="30" viewBox="0 0 512 512"><path d="M96 16 H496 V416 L416 496 H16 V96 Z" fill="#12161a" stroke="#2a333b" stroke-width="14"/><path d="M188 392 V152 A46 46 0 0 1 280 152 V372" fill="none" stroke="#4fd1a5" stroke-width="30"/><path d="M216 152 A18 18 0 0 1 252 152 V352" fill="none" stroke="#4fd1a5" stroke-width="20"/><path d="M188 152 H280" stroke="#c9a961" stroke-width="18"/></svg>
  <div><b>attachmenttoolarge</b> <span>desktop client v${VERSION} · this machine only · nothing is uploaded</span></div>
</header>
<main>
  <div class="row">
    <section class="card">
      <h2>CUT A FILE</h2>
      <p class="hint">Give a full path. Each piece is written next to the original, with a manifest
      of SHA-256 hashes and three rebuild scripts the recipient can double-click.</p>
      <label for="sp">File to cut</label>
      <input id="sp" placeholder="C:\\Users\\you\\Desktop\\Q3-report_v7_final.xlsx">
      <label for="lim">Maximum size per piece</label>
      <select id="lim">
        <option value="20MB">20 MB — the Outlook.com wall</option>
        <option value="35MB">35 MB — Exchange Online default</option>
        <option value="10MB">10 MB — the cautious one</option>
        <option value="25MB">25 MB — Gmail</option>
      </select>
      <button data-act="split">Cut it up</button>
      <pre data-out="split">Waiting.</pre>
    </section>
    <section class="card">
      <h2>PUT IT BACK</h2>
      <p class="hint">Point at the folder that holds the pieces — or at any single piece. Every
      shard is verified against its hash before one byte is written.</p>
      <label for="jn">Folder or any piece</label>
      <input id="jn" placeholder="C:\\Users\\you\\Downloads">
      <label for="out">Write the rebuilt file as (optional)</label>
      <input id="out" placeholder="leave empty for the original name">
      <button data-act="join">Rebuild it</button>
      <pre data-out="join">Waiting.</pre>
    </section>
  </div>

  <section class="card" style="margin-top:18px">
    <h2>THE LIMITS IT KNOWS ABOUT</h2>
    <p class="hint">Every row records where the number came from and when it was checked.</p>
    <div data-limits></div>
  </section>
</main>
<footer>MIT · the Attachment Too Large Society · the command-line tools are the same engine, driven by this page</footer>
<script>
  const KEY = ${JSON.stringify(key)};
  const limits = ${JSON.stringify(LIMITS)};
  const box = document.querySelector("[data-limits]");
  box.innerHTML = (limits.services || []).map(s =>
    '<div class="kv"><span>' + s.name + ' — ' + (s.context || "") + '</span><span>' +
    (s.attachmentLimitHuman || s.attachmentLimit || "?") + '</span></div>').join("")
    + '<div class="kv"><span>checked</span><span>' + (limits.updatedAt || "unknown") + '</span></div>';

  document.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const out = document.querySelector('[data-out="' + act + '"]');
      const body = act === "split"
        ? { file: document.getElementById("sp").value, limit: document.getElementById("lim").value }
        : { path: document.getElementById("jn").value, out: document.getElementById("out").value };
      btn.disabled = true;
      out.className = "";
      out.textContent = act === "split" ? "Cutting…" : "Verifying and rebuilding…";
      try {
        const r = await fetch("/api/" + act + "?k=" + encodeURIComponent(KEY), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const j = await r.json();
        if (j.error) { out.className = "bad"; out.textContent = j.error; }
        else {
          out.textContent = act === "split"
            ? "Done. " + (j.files || []).length + " files written to " + j.outDir + "\\n\\n" +
              (j.files || []).map(f => "  " + f).join("\\n")
            : "Verified and rebuilt.\\n\\n  " + j.output + "\\n  " + j.bytes + " bytes\\n  every shard matched its SHA-256";
        }
      } catch (e) { out.className = "bad"; out.textContent = "Could not reach the client: " + e.message; }
      btn.disabled = false;
    });
  });
</script>
</body></html>`;

/* ---------- the server ---------- */
/* Options exist for testing and for anyone who wants a fixed address:
     --port 8791     listen on a known port instead of a random one
     --key  hex      use a known session key
     --no-open       do not launch a browser                                 */
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const KEY = String(flag("key", randomBytes(16).toString("hex")));
const PORT = parseInt(String(flag("port", "0")), 10);
const NO_OPEN = argv.includes("--no-open");
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };

  if (url.pathname === "/" ) {
    if (url.searchParams.get("k") !== KEY) return send(403, "text/plain", "Wrong session key. Use the address the client printed.");
    return send(200, "text/html; charset=utf-8", PAGE(KEY));
  }
  if (url.searchParams.get("k") !== KEY) return send(403, "application/json", JSON.stringify({ error: "wrong session key" }));

  if (req.method === "POST" && (url.pathname === "/api/split" || url.pathname === "/api/join")) {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return send(400, "application/json", JSON.stringify({ error: "bad request body" })); }
      if (url.pathname === "/api/split") {
        const file = resolve(String(body.file || ""));
        if (!body.file || !existsSync(file)) return send(200, "application/json", JSON.stringify({ error: "No such file: " + file }));
        if (!statSync(file).isFile()) return send(200, "application/json", JSON.stringify({ error: "That is a folder, not a file. Point it at the file you want to cut." }));
        const r = await runTool("att-split", [file, "--limit", String(body.limit || "20MB"), "--json"]);
        const files = readdirSync(dirname(file)).filter((n) => n.startsWith(basename(file) + ".att"));
        return send(200, "application/json", JSON.stringify({ ...r, files }));
      }
      const target = resolve(String(body.path || ""));
      if (!body.path || !existsSync(target)) return send(200, "application/json", JSON.stringify({ error: "No such path: " + target }));
      const args = [target, "--json"];
      if (body.out) args.push("--out", resolve(String(body.out)), "--force");
      const r = await runTool("att-join", args);
      return send(200, "application/json", JSON.stringify(r));
    });
    return;
  }
  send(404, "application/json", JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/?k=${KEY}`;
  console.log("");
  console.log("  attachmenttoolarge — desktop client " + VERSION);
  console.log("  " + url);
  console.log("");
  console.log("  Open that address if the browser did not. Nothing leaves this machine.");
  console.log("  Press Ctrl+C to stop.");
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  if (!NO_OPEN) { try { spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref(); } catch { /* the user can paste the URL */ } }
});
