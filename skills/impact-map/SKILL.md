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
node "TOOL/impact.js" "PROJECT" --lang LANG --out "PROJECT/.impact/impact-map.html" --json "PROJECT/.impact/graph.json"
```

LANG is the language the user talks to you in: `ar` for Arabic, `en` for English (other languages: use `en`). It sets the language of the page and of what the tool prints.
Use the same `--lang` every time you rebuild in this project. If the user asks for the other language, rebuild with it.

Then tell them, in their language and in plain words:
- the file path, and how to open it (Windows: `start "" "<path>"`, macOS: `open`, Linux: `xdg-open`). Offer to open it.
- the counts the tool printed, and EVERY "ملاحظة / note" line it printed (skipped files, dynamic loading, unsupported languages). Do not hide those.
- two tabs: "Project map" / "خريطة المشروع" (pick a part on the map; under it "لو عدّلته" and "لو حذفته" sit side by side; the "كل التفاصيل" button shows every function as its own box; wheel to zoom, drag to move) and "Permissions" / "الصلاحيات" (the permissions map).
- suggest adding `.impact/` to `.gitignore`.

## 2. A specific question: "what breaks if I change / delete X?"

Build the graph if `PROJECT/.impact/graph.json` is missing or older than the code (same command as above), then:

```
node "TOOL/analyzer/query.js" "PROJECT/.impact/graph.json" "X"            # changing X
node "TOOL/analyzer/query.js" "PROJECT/.impact/graph.json" "X" --delete   # deleting X
```

X is a function name or a file path. Read the answer out in plain words: what depends on it directly, what may be affected further,
and what is safe. If it says X matches several parts, ask which one.

The output ends with a `Confidence:` line (HIGH / MEDIUM / LOW) and its reasons. Always tell the user the level and the reasons in plain
words. If it is MEDIUM or LOW, say what to check before acting (the files named in the reasons), and never present "nothing depends on it"
as settled when the confidence is LOW.

## 3. "What permissions did I give you?"

```
node "TOOL/approvals/approvals.js" --project "PROJECT" --lang LANG
```

It reads `PROJECT/.claude/settings.json` and `settings.local.json` and says what each standing permission can do at its worst.
Summarise in plain words: which are dangerous, and what Claude can now do without asking.
Say clearly: it only sees STANDING permissions. A one-time "Yes" is not saved anywhere, so it cannot be listed. The user's personal
settings file is not read; if they want it included they must copy it somewhere you can read and pass `--user-settings <copy>`.

## 4. Keep the map in the loop (when the user asks: "keep the map updated", "use the map before you change anything", "استعن بالخريطة", or runs /impact-map-keep)

This turns the map into a safety check that Claude uses on every change, so nothing gets broken by accident.

**Before** you edit in a way that can affect other code (changing a function's inputs or behaviour, renaming, moving, or deleting):
1. Make sure the graph is fresh: if `PROJECT/.impact/graph.json` is missing or older than the code, rebuild (section 1 command).
2. Ask the map about the target (section 2: `query.js`, with `--delete` for deletions).
3. Tell the user in one or two plain sentences: who depends on it directly, and the **Confidence** level with its reasons.
4. Act on it:
   - Direct dependents exist: update them in the same change, or tell the user which ones need attention before you finish.
   - Deleting: if anything depends on it, or Confidence is MEDIUM or LOW, do not delete until the user confirms. Name the files to look at.
   - Confidence MEDIUM or LOW: read the files named in the reasons before deciding. The map cannot see those links.
5. Small edits that stay inside one function and keep its inputs and outputs the same do not need a check.

**After** you finish a change (a batch of edits, not every line): rebuild the map and `graph.json` with the same command so the page matches the code.
Say something only if the picture changed (a new part, a removed part, a new dependency). Then run the project's tests if it has them.

Never say "safe". Say what the map sees and what it cannot see. The map helps you decide; it does not replace running the code.

**Standing rule block for `CLAUDE.md`** (used by `/impact-map-keep`; keep the two marker lines exactly):

```
<!-- impact-map:start -->
## Impact map (kept up to date)
This project has an impact map (plugin `impact-map`). Follow these rules on every task, without being asked:
- Before changing how a function behaves, renaming, moving, or deleting anything: run the impact-map skill's query for it, tell me who depends on it and the confidence level.
- Never delete something that other code depends on, or when the confidence is medium or low, until I confirm.
- After a batch of changes: rebuild the map (`.impact/impact-map.html`) so it matches the code, and run the tests.
- The map is an estimate, not a guarantee: say what it cannot see.
<!-- impact-map:end -->
```

## Rules

- This is an estimate from reading the code, not a guarantee. Say so when the answer matters (before a deletion).
- Never claim something is "safe to delete". Say "nothing in the map depends on it", and mention what the map cannot see
  (dynamic loading, other languages, code outside this folder, files that read other files as data or run them as commands).
- Python, Java, Kotlin and other languages are not read. If the tool says it found no JS/TS functions, tell the user that.
- Do not change the user's code as part of this skill. It only reads.
