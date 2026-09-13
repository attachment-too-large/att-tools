# att-tools

> Six small, sharp tools for the **attachment too large** problem — from the
> [Attachment Too Large Society](https://github.com/attachment-too-large).
>
> Zero dependencies. Single-file executables. Every one of them is tested by
> running it, not by reading it.

## Download

Grab the executable for your platform from the [latest release](../../releases/latest):

| Tool | What it does |
| --- | --- |
| **`att-split`** | Cut a file into shards that fit under a limit, with a manifest and a rebuild script the recipient can double-click |
| **`att-join`** | Verify every shard against its SHA-256, then rebuild the original — refuses to write anything if a shard is missing or corrupt |
| **`att-info`** | Will it send? Does the Base64 arithmetic (a 24 MB file looks like 32 MB to the server) and checks it against every service |
| **`att-limits`** | Query the attachment-limits database, or validate it |
| **`att-ndr`** | Translate a bounce message into English: who blocked it, how big, what to do next |
| **`att-share`** | When a link really is the only option: serve one file behind a random token, with an expiry and a download budget, then stop |

No Node, no runtime, no installer. Each executable carries what it needs.

## Quick examples

```bash
# Will a 24.7 MB spreadsheet get through?
att-info "Q3-report_v7_final-FINAL.xlsx"
#   File size       24.7 MB
#   Encoded size    33.8 MB  (Base64 inflates it 37% — this is what the server sees)
#   At 20 MB        needs 2 shards
#   ✗  Outlook.com                     limit 20 MB · over by 13.8 MB
#   ✓  Exchange Online (365 default)   limit 35 MB

# So split it, at 20 MB a shard
att-split "Q3-report_v7_final-FINAL.xlsx" --limit 20MB
#   ✓ Cut into 2 shards, 20.0 MB max each
#   …att-part-001  20.0 MB   cd52d81e25f372e6…
#   …att-part-002   4.70 MB  cdeb5d17f2cfce2e…
#   Rebuilding on the recipient's side: double-click …att-reassemble.cmd

# The recipient ran it. Verify what came back:
att-join "Q3-report_v7_final-FINAL.xlsx.att.json"

# Something bounced. Find out what actually happened:
att-ndr bounce.txt          # or: cat bounce.txt | att-ndr -

# Must send a link? Serve it yourself, for one download, then it stops:
att-share big-file.zip --once --hours 2
```

Every tool takes `--help`, `--version` and `--json` where it makes sense.

## Why the executables are ~90 MB

They are Node's single-executable-application format: a copy of the Node runtime with
the tool's code injected. That is the price of "download and run, nothing to install".
If you already have Node 18+, run the sources instead — they are the same code:

```bash
node src/split.mjs --help
```

## The limits database

`data/limits.json` is deliberately plain JSON so it can be read, diffed and cited.
Every record carries a `verifiedAt` date, and unlimited entries have to explain
themselves in `note`:

```json
{
  "id": "outlook.com",
  "name": "Outlook.com",
  "limitMB": 20,
  "kind": "attachment",
  "note": "Above this it suggests sending a share link instead.",
  "verifiedAt": "2025-11-14"
}
```

Validate it after editing:

```bash
att-limits --validate        # exits non-zero on duplicates or missing fields
att-limits outlook           # filter by keyword
att-limits --json            # for scripts
```

## Building from source

```bash
node tools/test.mjs                 # 45+ checks against src/
node tools/build-exe.mjs            # all six executables into dist/
node tools/build-exe.mjs split info # or just some of them
node tools/test.mjs --exe           # the same checks against the built executables
```

`build-exe.mjs` bundles each tool to CommonJS, inlines the limits database, injects it into
the Node runtime with [postject](https://github.com/nodejs/postject), and then **runs the
result**: `--version`, `--help`, and one real operation per tool (split → rejoin with hash
comparison, encoded-size maths, database validation, bounce translation).

## A note on the recipient

Splitting is only useful if the other end can put the file back together.
`att-split` therefore writes three rebuild scripts next to the shards:

- `*.att-reassemble.cmd` — Windows, double-click it
- `*.att-reassemble.ps1` — the actual work (written **with a UTF-8 BOM**, because Windows
  PowerShell 5.1 reads BOM-less scripts as ANSI and mangles non-ASCII filenames)
- `*.att-reassemble.sh` — macOS/Linux, `sh` it

None of them need `att-join`, Node, or an internet connection. They verify the SHA-256
before declaring success.

## Licence and honesty

MIT. These tools are real and tested; the *society* that publishes them is fictional, and
neither is affiliated with Microsoft. Product names, error codes and default size limits are
quoted from public documentation for technical discussion — defaults change, so measure your
own limits and check the official docs.
