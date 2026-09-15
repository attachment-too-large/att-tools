#!/usr/bin/env node
/* ==========================================================================
   att-setup.mjs — the installer

   It deliberately does not carry the tools inside itself. Embedding six 88 MB
   executables would make a 530 MB installer for a program whose entire subject is
   that big files are a nuisance. Instead it installs the tools that sit beside it:

     · copies every att-*.exe into %LOCALAPPDATA%\attachmenttoolarge\bin
     · adds that folder to the user PATH (no administrator needed, user scope only)
     · creates a Start Menu entry and an optional desktop shortcut for the client
     · writes an uninstaller and registers it in Add/Remove programs
     · registers nothing else, phones nobody, and can be undone with att-uninstall.exe

   Build: tools/build-exe.mjs setup   →  att-setup.exe
   ========================================================================== */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
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
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000 });
  return r.status === 0;
}

function addToUserPath(folder) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
    "if ($p -notlike '*" + folder + "*') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';" + folder + "'), 'User'); 'added' } else { 'present' }"
  ], { encoding: "utf8", timeout: 30000 });
  return (r.stdout || "").trim();
}

/* ---------- what to install ---------- */
const payload = readdirSync(HERE).filter((n) => /^att-.*\.exe$/i.test(n) && !/^att-(setup|uninstall)\.exe$/i.test(n));

say("");
say("  attachmenttoolarge " + VERSION + " — installer");
say("");
say("  It will install into:  " + BIN);
say("  And add to your user PATH (no administrator rights needed).");
say("");

if (!payload.length) {
  bad("No att-*.exe found next to the installer. Put the installer in the same folder as the tools.");
  process.exit(1);
}
say("  Found " + payload.length + " tools: " + payload.join(", "));
say("");

mkdirSync(BIN, { recursive: true });
mkdirSync(START_MENU, { recursive: true });

let copied = 0;
for (const name of payload) {
  try {
    copyFileSync(join(HERE, name), join(BIN, name));
    copied++;
    ok(name + "  (" + (statSync(join(BIN, name)).size / 1048576).toFixed(1) + " MB)");
  } catch (e) {
    bad(name + " — " + e.message);
  }
}
if (!copied) { bad("Nothing was copied. Is a previous version still running?"); process.exit(1); }

/* ---------- shortcuts ---------- */
const client = join(BIN, "att-gui.exe");
const i = join(BIN, "att-split.exe");
if (existsSync(client)) {
  shortcut(join(START_MENU, "attachmenttoolarge client.lnk"), client, "", client + ",0", BIN);
  ok("Start Menu entry for the client");
  const desk = join(homedir(), "Desktop", "attachmenttoolarge.lnk");
  if (!existsSync(desk)) { shortcut(desk, client, "", client + ",0", BIN); ok("desktop shortcut"); }
}

/* ---------- a real uninstaller, so this is not a one-way door ---------- */
const uninstaller = `@echo off
setlocal
set "BIN=%LOCALAPPDATA%\attachmenttoolarge\bin"
set "ROOT=%LOCALAPPDATA%\attachmenttoolarge"
set "SM=%APPDATA%\Microsoft\Windows\Start Menu\Programs\attachmenttoolarge"

echo Removing attachmenttoolarge %VERSION% ...
taskkill /IM att-gui.exe /F >nul 2>&1

rem PATH first, with the real folder name, matched through the environment so no escaping is involved
powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('Path','User'); $n=(($p -split ';') | Where-Object { $_ -and ($_ -ne $env:BIN) }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User')"

rmdir /s /q "%SM%" >nul 2>&1
del "%USERPROFILE%\Desktop\attachmenttoolarge.lnk" >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\attachmenttoolarge" /f >nul 2>&1

echo The tools, the PATH entry, the shortcuts and the registry entry are gone.
rem The folder is removed by a detached process, because a batch file cannot delete
rem the directory it is still being read from — doing it inline killed the rest of
rem this script, which is how the PATH entry survived the first version of it.
start "" cmd /c "timeout /t 2 >nul & rmdir /s /q "%ROOT%""
echo This window can be closed.
`
/* cmd.exe needs CRLF. A batch file written with bare LF line endings is parsed as
   garbage — "'m' is not recognized" — which is exactly how the first version of this
   uninstaller failed: it looked like a PATH bug and was a line-ending bug. */
writeFileSync(join(TARGET, "att-uninstall.cmd"), uninstaller.replace(/\r?\n/g, "\r\n"), "utf8");

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
say("  Installed " + copied + " tools in " + BIN);
say("");
say("  Try it — open a new terminal, then:");
say("      att-split \"C:\\path\\to\\big-file.xlsx\" --limit 20MB");
say("      att-join \"C:\\path\\to\\big-file.xlsx.att.json\"");
say("");
say("  Or double-click the client in the Start Menu.");
say("");
say("  Everything is per-user and reversible: run att-uninstall.cmd in that folder.");
say("");
if (!QUIET) {
  console.log("  Press Enter to close.");
  try { spawn("cmd", ["/c", "pause>nul"], { stdio: "inherit", windowsHide: false }); } catch { /* no console */ }
}
