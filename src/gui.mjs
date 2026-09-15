#!/usr/bin/env node
/* ==========================================================================
   att-gui.mjs — the desktop client

   This is a launcher, not an application: it finds the client's own window
   (gui.hta) beside the executable and opens it in the Windows HTML host.

   Why an HTA window and not a browser page: the request was a client you download
   and open that has its own interface, and a browser tab is not that. Why not
   Electron: adding hundreds of megabytes of runtime to a tool whose entire subject
   is that files are too big would be its own joke. The Windows HTML host gives a
   real window — title bar, taskbar entry, no address bar, no tabs — with full
   control over how it looks, at the cost of writing ES5 and flexbox, because the
   engine underneath is Trident.

   Build: tools/build-exe.mjs gui   →  att-gui.exe  (+ gui.hta beside it)
   ========================================================================== */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(process.execPath);
const VERSION = "0.2.0";

/* Look for the window beside the executable first — that is how the installer lays
   it out — then in the places a development checkout keeps it. */
const CANDIDATES = [
  join(HERE, "gui.hta"),
  join(HERE, "att-gui.hta"),
  join(HERE, "..", "src", "gui.hta"),
  join(HERE, "..", "dist", "gui.hta"),
  join(HERE, "..", "..", "src", "gui.hta")
];

const hta = CANDIDATES.find((p) => existsSync(p));

if (!hta) {
  console.error("");
  console.error("  attachmenttoolarge client " + VERSION);
  console.error("");
  console.error("  Could not find gui.hta, which is the client's window.");
  console.error("  It should sit next to this executable. Looked in:");
  for (const p of CANDIDATES) console.error("    " + p);
  console.error("");
  console.error("  The command-line tools still work on their own, for example:");
  console.error('    att-split "C:\\path\\to\\big-file.xlsx" --limit 20MB');
  console.error("");
  process.exit(1);
}

console.log("");
console.log("  attachmenttoolarge client " + VERSION);
console.log("  opening the window: " + hta);
console.log("  (the command-line tools sit in the same folder and do the same work)");
console.log("");

const host = join(process.env.SystemRoot || "C:\\Windows", "System32", "mshta.exe");

/* Do not exit before the child exists. spawn() is asynchronous, so unref() plus an
   immediate process.exit() can kill the window before it is ever created — which is
   exactly what the first version of this launcher did. Wait for the spawn event. */
let child;
try {
  child = spawn(host, [hta], { detached: true, stdio: "ignore", windowsHide: false });
} catch (e) {
  console.error("  Could not open the window: " + e.message);
  console.error("  You can open it by hand: mshta \"" + hta + "\"");
  process.exit(1);
}
child.on("error", (e) => {
  console.error("  Could not open the window: " + e.message);
  console.error("  You can open it by hand: mshta \"" + hta + "\"");
  process.exit(1);
});
child.on("spawn", () => {
  child.unref();
  process.exit(0);
});
