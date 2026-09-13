#!/usr/bin/env node
/* att-ndr — translate a bounce message into English.
   Give it a .eml/.txt, or pipe it in:  cat bounce.txt | att-ndr - */
import { existsSync, readFileSync } from "node:fs";
import {
  VERSION, parseArgs, say, die, banner, dim, bold, cyan, green, red, yellow, jsonOut, BIN
} from "./core.mjs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const NAME = BIN("att-ndr");

if (flags.version) { say(VERSION); process.exit(0); }
if (flags.help) {
  banner(NAME, "translate a bounce message");
  say(bold("  Usage"));
  say(`    ${NAME} <bounce.txt|bounce.eml>     read a file`);
  say(`    cat bounce.txt | ${NAME} -          read stdin`);
  say("");
  say(bold("  Options"));
  say("    --json     machine-readable output");
  say("");
  say(dim("  It names the gate that blocked you, and says what to do next."));
  process.exit(0);
}

let text = "";
const src = positional[0];
if (src && src !== "-") {
  if (!existsSync(src)) die(`Bounce file not found: ${src}`);
  text = readFileSync(src, "utf8");
} else {
  try { text = readFileSync(0, "utf8"); } catch { text = ""; }
}
if (!text.trim()) die(`No input. Usage: ${NAME} <bounce-file>, or cat bounce.txt | ${NAME} -`, 2);

const KNOWLEDGE = [
  {
    re: /5\.3\.4/i,
    title: "550 5.3.4 · Message size exceeds fixed maximum message size",
    who: "your side (submission server or outbound gateway)",
    mean: "The message exceeded the size your own server allows and was stopped before it left.",
    todo: ["Redo the arithmetic on the encoded size (+33%): your figure is usually smaller than the server's",
           "Split it: att-split <file> --limit 20MB",
           "If it must go as one message, ask an admin to raise the outbound limit"]
  },
  {
    re: /5\.2\.3/i,
    title: "552 5.2.3 · Message size exceeds fixed maximum message size (recipient side)",
    who: "the recipient's side",
    mean: "It left your server and the recipient's mailbox or gateway refused it. You cannot change their settings, only the size.",
    todo: ["Split it", "Or use a shared location you both accept and put the link in the body"]
  },
  {
    re: /0x80040610/i,
    title: "0x80040610 · rejected at submission",
    who: "when the Outlook client submits to the server",
    mean: "Total message size exceeded the per-user limit. Attachments plus encoding inflation grow faster than you expect.",
    todo: ["Use att-info <file> to see the real encoded size", "Split it"]
  },
  {
    re: /0x8004210B/i,
    title: "0x8004210B · timed out while sending",
    who: "the transfer between client and server",
    mean: "Usually a timeout rather than a size rejection: a large attachment plus a slow uplink, the classic pairing.",
    todo: ["Split it so each message finishes sooner", "Retry on a more stable connection"]
  },
  {
    re: /5\.7\.(0|1)/i,
    title: "550 5.7.x · policy or security block",
    who: "the gateway's compliance or anti-spam policy",
    mean: "This is policy, not size: attachment type, encryption requirements, sender reputation.",
    todo: ["Read the policy name quoted in the bounce", "Switch to a link or get whitelisted — do not waste effort on size"]
  },
  {
    re: /(message size exceeds|exceeds the maximum message size|attachment.{0,20}too large|file you're attaching is bigger)/i,
    title: "Generic \"message too large\" notice (no error code given)",
    who: "unknown; usually whichever gate is smallest",
    mean: "A gateway rewrote the bounce and lost the error code. Only measurement will find the real limit.",
    todo: ["Send 5 MB, then double, and note the first size that bounces", "Write the result into your internal docs with today's date"]
  }
];

const all = KNOWLEDGE.filter((k) => k.re.test(text));
const specific = all.filter((k) => !/^Generic/.test(k.title));
const shown = specific.length ? specific : all;

const codes = [...new Set([...text.matchAll(/\b([245]\d\d[ .-]?\d\.\d+\.\d+)/g)].map((m) => m[1]))];
const hexCodes = [...new Set([...text.matchAll(/0x[0-9A-Fa-f]{8}/g)].map((m) => m[0]))];
const sizes = [...new Set([...text.matchAll(/(\d[\d.,]*)\s*(KB|MB|GB|kilobytes|megabytes|gigabytes)/gi)].map((m) => `${m[1]} ${m[2]}`))].slice(0, 6);

if (flags.json) {
  jsonOut({
    codes, hexCodes, sizeHints: sizes,
    findings: shown.map((k) => ({ title: k.title, who: k.who, meaning: k.mean, next: k.todo }))
  });
  process.exit(0);
}

banner(NAME, "bounce, translated");
if (codes.length) say(`  Codes             ${codes.map(cyan).join("  ")}`);
if (hexCodes.length) say(`  Hex codes         ${hexCodes.map(cyan).join("  ")}`);
if (sizes.length) say(`  Sizes mentioned   ${sizes.join(" / ")}`);
say("");

if (!shown.length) {
  say(yellow("  We do not recognise this bounce."));
  say(dim("  Send us the raw bounce — do not rewrite it — and we will add it to the table."));
  process.exit(0);
}

shown.forEach((k, i) => {
  say(`  ${bold(k.title)}`);
  say(`    Who blocked it   ${k.who}`);
  say(`    What it means    ${k.mean}`);
  say(`    Next`);
  k.todo.forEach((t) => say(`      · ${t}`));
  if (i < shown.length - 1) say("");
});

if (shown.some((k) => /5\.3\.4|0x80040610|Generic/.test(k.title))) {
  say("");
  say(dim("  Remember: the server measures the encoded size, roughly 33% larger than the file."));
  say(`  Run ${cyan("att-info <file>")} before deciding how many shards.`);
}
