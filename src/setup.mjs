#!/usr/bin/env node
/* ==========================================================================
   att-setup.mjs — the installer

   It deliberately does not carry the tools inside itself. Embedding eight 88 MB
   executables would make a 700 MB installer for a program whose entire subject is
   that big files are a nuisance. Instead it installs the tools that sit beside it:

     · copies every att-*.exe and *.hta into %LOCALAPPDATA%\attachmenttoolarge\bin
     · adds that folder to the user PATH (no administrator needed, user scope only)
     · creates a Start Menu entry and a desktop shortcut for the client
     · writes an uninstaller and registers it in Add/Remove programs
     · registers nothing else, phones nobody, and can be undone from that entry

   The uninstaller is a PowerShell script with a two-line .cmd in front of it. That
   split is not decoration: cmd.exe re-reads a batch file as it runs, so a batch file
   cannot delete the folder it lives in — the first version tried, and every step
   after the deletion silently never ran. PowerShell reads the whole script up front,
   so it can remove its own home and finish the job.

   Build: tools/build-exe.mjs setup   →  att-setup.exe
   ========================================================================== */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const VERSION = "0.2.0";
const QUIET = process.argv.includes("--quiet");   // no final pause, for scripted installs
const HERE = dirname(process.execPath);
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const TARGET = join(LOCAL, "attachmenttoolarge");
const BIN = join(TARGET, "bin");
const START_MENU = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
                        "Microsoft", "Windows", "Start Menu", "Programs", "attachmenttoolarge");
const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\attachmenttoolarge";

const say = (s) => console.log(s);
const ok = (s) => console.log("  \u2713 " + s);
const bad = (s) => console.log("  \u2717 " + s);
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");

/* ---------- a shortcut without any dependency: ask Windows itself ---------- */
function shortcut(linkPath, targetPath, args, icon, workdir) {
  const ps = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + linkPath.replace(/'/g, "''") + "');",
    "$s.TargetPath = '" + targetPath.replace(/'/g, "''") + "';",
    args ? "$s.Arguments = '" + args.replace(/'/g, "''") + "';" : "",
    workdir ? "$s.WorkingDirectory = '" + workdir.replace(/'/g, "''") + "';" : "",
    icon ? "$s.IconLocation = '" + icon.replace(/'/g, "''") + "';" : "",
    "$s.Description = 'attachmenttoolarge';",
    "$s.Save();"
  ].filter(Boolean).join(" ");
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000 }).status === 0;
}

function addToUserPath(folder) {
  const ps = "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
    "if (($p -split ';' | Where-Object { $_.TrimEnd('\\') -eq '" + folder.replace(/'/g, "''").replace(/\\/g, "\\\\") + "' }).Count -eq 0) { " +
    "[Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';')) + ';" + folder + "'), 'User'); 'added' } else { 'present' }";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000 });
  return (r.stdout || "").trim();
}

/* ---------- what to install ---------- */
const payload = readdirSync(HERE).filter((n) =>
  /^(att-.*\.exe|.*\.hta)$/i.test(n) && !/^att-(setup|uninstall)\.(exe|cmd|ps1)$/i.test(n));

say("");
say("  attachmenttoolarge " + VERSION + " — installer");
say("");
say("  It will install into:  " + BIN);
say("  And add that folder to your user PATH (no administrator rights needed).");
say("");

if (!payload.length) {
  bad("Nothing to install: no att-*.exe found next to the installer.");
  bad("Put the installer in the same folder as the tools and run it again.");
  process.exit(1);
}
say("  Found " + payload.length + " file(s): " + payload.join(", "));
say("");

mkdirSync(BIN, { recursive: true });
mkdirSync(START_MENU, { recursive: true });

let copied = 0;
for (const name of payload) {
  try {
    copyFileSync(join(HERE, name), join(BIN, name));
    copied++;
    const mb = statSync(join(BIN, name)).size / 1048576;
    ok(name + (mb >= 0.1 ? "  (" + mb.toFixed(1) + " MB)" : ""));
  } catch (e) {
    bad(name + " — " + e.message);
  }
}
if (!copied) { bad("Nothing was copied. Is an older copy still running?"); process.exit(1); }

/* ---------- shortcuts ---------- */
const client = join(BIN, "att-gui.exe");
if (existsSync(client)) {
  if (shortcut(join(START_MENU, "attachmenttoolarge client.lnk"), client, "", client + ",0", BIN)) {
    ok("Start Menu entry for the client");
  }
  const desk = join(homedir(), "Desktop", "attachmenttoolarge.lnk");
  if (!existsSync(desk) && shortcut(desk, client, "", client + ",0", BIN)) ok("desktop shortcut");
}

/* ---------- the uninstaller ----------
   PowerShell, not batch, for the reason in the header comment: it has to delete the
   folder it is running from, and only an interpreter that reads the script whole can
   do that and still finish. */
const uninstallPs1 = `
$ErrorActionPreference = "SilentlyContinue"
$root = Join-Path $env:LOCALAPPDATA "attachmenttoolarge"
$bin  = Join-Path $root "bin"

Write-Host ""
Write-Host "  Removing attachmenttoolarge ${VERSION} ..."

Get-Process att-gui -ErrorAction SilentlyContinue | Stop-Process -Force

# the PATH entry, compared with and without a trailing backslash
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if ($p) {
  $gone = $bin.TrimEnd("\\")
  $kept = @($p -split ";" | Where-Object { $_ -and ($_.TrimEnd("\\") -ne $gone) })
  [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")
  Write-Host "  PATH entry removed."
}

Remove-Item (Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\attachmenttoolarge") -Recurse -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "attachmenttoolarge.lnk") -Force
Remove-Item "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\attachmenttoolarge" -Recurse -Force

Write-Host "  Shortcuts and the registry entry are gone."
Remove-Item $root -Recurse -Force
if (Test-Path $root) { Write-Host "  Could not remove $root — close the client and try again." }
else { Write-Host "  Folder removed: $root" }
Write-Host ""
Write-Host "  Done. Nothing of attachmenttoolarge is left behind."
Write-Host ""
`;
writeFileSync(join(TARGET, "att-uninstall.ps1"), crlf(uninstallPs1), "utf8");

/* The .cmd exists so the entry in Add/Remove programs is double-clickable. Two lines,
   no quoting games: everything that matters is in the .ps1 beside it. */
const uninstallCmd = `@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0att-uninstall.ps1"
`;
writeFileSync(join(TARGET, "att-uninstall.cmd"), crlf(uninstallCmd), "utf8");
ok("uninstaller written (att-uninstall.cmd + att-uninstall.ps1)");

const regAdd = [
  ["DisplayName", "attachmenttoolarge " + VERSION],
  ["Publisher", "The Attachment Too Large Society"],
  ["DisplayVersion", VERSION],
  ["InstallLocation", TARGET],
  ["UninstallString", join(TARGET, "att-uninstall.cmd")],
  ["NoModify", "1"], ["NoRepair", "1"]
];
for (const [k, v] of regAdd) {
  spawnSync("reg", ["add", REG_KEY, "/v", k, "/t", "REG_SZ", "/d", v, "/f"], { windowsHide: true });
}
ok("registered in Add/Remove programs (per user)");

/* ---------- PATH ---------- */
const pathResult = addToUserPath(BIN);
ok("PATH: " + (pathResult === "added" ? "added — open a new terminal to use the tools by name" : "already present"));

say("");
say("  Installed " + copied + " file(s) in " + BIN);
say("");
say("  Try it — open a new terminal, then:");
say("      att-split \"C:\\path\\to\\big-file.xlsx\" --limit 20MB");
say("      att-join \"C:\\path\\to\\big-file.xlsx.att.json\"");
say("");
say("  Or open the client from the Start Menu: it needs gui.hta to sit beside att-gui.exe,");
say("  which is how this installer lays it out.");
say("");
say("  Everything is per-user and reversible: run att-uninstall.cmd in that folder,");
say("  or use the entry in Add/Remove programs.");
say("");
if (!QUIET) {
  console.log("  Press Enter to close.");
  try { spawn("cmd", ["/c", "pause>nul"], { stdio: "inherit", windowsHide: false }); } catch { /* no console */ }
}
