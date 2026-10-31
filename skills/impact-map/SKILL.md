---
name: impact-map
description: Use when the user asks for a map of their project, what depends on what, what would be affected or break if they change or delete something, or what permissions they have given Claude Code ("خريطة الأثر", "شو بيتأثر لو حذفت", "impact map", "what breaks if"). Builds a local HTML map of the project and answers impact questions from it.
---

# Impact Map

Builds a map of the user's JavaScript / TypeScript / React / HTML project (parts, what depends on what) and a second map of the
permissions they gave Claude Code. Everything runs locally. Nothing is uploaded.

The tool lives in the plugin folder: the folder two levels above this skill's base directory (the folder that contains `impact.js`).
Call it TOOL. If unsure, find it: `find ~/.claude/plugins -name impact.js -path "*impact-map*"` (on Windows PowerShell:
`Get-ChildItem -Recurse -Filter impact.js $HOME\.claude\plugins`). Needs Node.js 18 or newer.

PROJECT is the folder the user is working in (the current directory), or the folder they name.

## 1. They want the map (or a general overview)

```
node "TOOL/impact.js" "PROJECT" --out "PROJECT/.impact/impact-map.html" --json "PROJECT/.impact/graph.json"
```

Then tell them, in their language and in plain words:
- the file path, and how to open it (Windows: `start "" "<path>"`, macOS: `open`, Linux: `xdg-open`). Offer to open it.
- the counts the tool printed, and EVERY "ملاحظة / note" line it printed (skipped files, dynamic loading, unsupported languages). Do not hide those.
- two tabs: "خريطة المشروع" (pick a part on the map; under it "لو عدّلته" and "لو حذفته" sit side by side; the "كل التفاصيل" button shows every function as its own box; wheel to zoom, drag to move) and "الصلاحيات" (the permissions map).
- suggest adding `.impact/` to `.gitignore`.

## 2. A specific question: "what breaks if I change / delete X?"

Build the graph if `PROJECT/.impact/graph.json` is missing or older than the code (same command as above), then:

```
node "TOOL/analyzer/query.js" "PROJECT/.impact/graph.json" "X"            # changing X
node "TOOL/analyzer/query.js" "PROJECT/.impact/graph.json" "X" --delete   # deleting X
```

X is a function name or a file path. Read the answer out in plain words: what depends on it directly, what may be affected further,
and what is safe. If it says X matches several parts, ask which one.

## 3. "What permissions did I give you?"

```
node "TOOL/approvals/approvals.js" --project "PROJECT"
```

It reads `PROJECT/.claude/settings.json` and `settings.local.json` and says what each standing permission can do at its worst.
Summarise in plain words: which are dangerous, and what Claude can now do without asking.
Say clearly: it only sees STANDING permissions. A one-time "Yes" is not saved anywhere, so it cannot be listed. The user's personal
settings file is not read; if they want it included they must copy it somewhere you can read and pass `--user-settings <copy>`.

## Rules

- This is an estimate from reading the code, not a guarantee. Say so when the answer matters (before a deletion).
- Never claim something is "safe to delete". Say "nothing in the map depends on it", and mention what the map cannot see
  (dynamic loading, other languages, code outside this folder, files that read other files as data or run them as commands).
- Python, Java, Kotlin and other languages are not read. If the tool says it found no JS/TS functions, tell the user that.
- Do not change the user's code as part of this skill. It only reads.
