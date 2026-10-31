# Impact: keep the human in control of what an AI assistant builds and does

Two parts, one engine.

```
analyzer/   fnmap.js, analyze.py   reads a project: functions, who calls whom, which request hits which server route
map/        glitch-template.html   the interactive map: pick a part, choose edit or delete, see what is affected
hook/       permission_hook.js     a Claude Code PreToolUse hook: green / yellow / red, plain Arabic reasons,
                                   and, for edits to code, who depends on the function being changed
tests/      corpora + scoring      real and independently written tool calls, labelled blind
```

## Approvals view: what you allowed, and how far it reaches

`approvals/approvals.js` reads a project's `.claude/settings.json` / `settings.local.json` (and a user settings file if given)
and says, in plain Arabic, what each standing permission can do at its worst, and what Claude can now do without asking.
The map page has a second mode, "الصلاحيات" (hacker look: black background, neon green). Same map: every part shows what its own code can do
(NET, STO, KEY, AI, DB, CLIP, SND, SRV, found by scanning each function's lines, spot-checked by hand against worker.js and index.html) and turns
red or amber when the permissions you gave Claude would let it misuse that capability. The page published with this repo shows EXAMPLE approvals only.

Checked on 70 rules written by an independent agent and rated by two independent reviewers (tool frozen before rating):
of 39 rules both reviewers called red, the first version flagged 33 and, after general fixes (same data, so not independent), 37.
Remaining differences: bare `Edit`/`Write` (kept yellow), unknown programs (yellow, "unknown"), `rm -rf node_modules` and
similar exact commands (red; reviewers yellow). Not done yet: running it on a real user's accumulated approvals, and "where it reached"
from real activity (needs the hook's log or Claude Code transcripts).

## Install the hook (Claude Code)

`.claude/settings.json` in the project:

```json
{ "hooks": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "node /path/to/impact/hook/permission_hook.js" } ] } ] } }
```

- green  -> allowed silently
- yellow -> allowed, written to `.impact/activity.jsonl`
- red    -> Claude Code asks, with a plain sentence such as "رح يمسح 24 ملف (1.2 MB) من build. ما في تراجع"

## What was measured (and what was not)

Hold-out set: 60 tool calls written by an independent agent for a normal working day, labelled by two
independent reviewers (one cautious, one pragmatic), hook frozen (md5 in tests/hook_frozen.md5) before the set existed.

- both reviewers said red: 10, hook asked on 10. Either said red: 14, hook asked on 14.
- unnecessary interrupts: 2 of 46 calls neither reviewer called red (both `npx eslint` / `npx jest`).
- hook interrupts 27% of calls; reviewers 23% and 17%.
- On the first, tuned-on data: 2 of 29 red calls were let through (a bare `> file` truncation, and spawning a sub-agent).

Not measured: running inside a real Claude Code session (authentication failed in the test sandbox), edits with
function-impact lookups on real projects, MCP tools beyond 3 cases, anything with real users.
The reviewers are the same model family as the author of the hook, so shared blind spots are likely.

## Change after the freeze

One change was made after the hook was frozen: secret-path matching now normalises Windows backslashes. Both score runs were repeated and gave identical numbers (92-call set 75/92, hold-out 10/10 and 14/14, 2 unnecessary interrupts). The md5 in tests/hook_frozen.md5 is the pre-change file.

## Known gaps

- `npx` is always red, even when the tool is already in node_modules/.bin.
- Scripts that delete files (even their own temp folders) are red: the hook cannot tell where.
- MCP tools are judged by name only; a per-user allow-list is the real fix.
- Chained shell tricks beyond the cases tested (aliases, functions, `eval` of built strings) are only caught as "unknown -> red".
- The message shown is plain text in Claude Code's own prompt; no custom screen.
