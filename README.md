# Impact: keep the human in control of what an AI assistant builds and does

Two parts, one engine.

```
analyzer/   fnmap.js, analyze.py   reads a project: functions, who calls whom, which request hits which server route
map/        glitch-template.html   the interactive map: pick a part, choose edit or delete, see what is affected
hook/       permission_hook.js     a Claude Code PreToolUse hook: green / yellow / red, plain Arabic reasons,
                                   and, for edits to code, who depends on the function being changed
tests/      corpora + scoring      real and independently written tool calls, labelled blind
```

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

## Known gaps

- `npx` is always red, even when the tool is already in node_modules/.bin.
- Scripts that delete files (even their own temp folders) are red: the hook cannot tell where.
- MCP tools are judged by name only; a per-user allow-list is the real fix.
- Chained shell tricks beyond the cases tested (aliases, functions, `eval` of built strings) are only caught as "unknown -> red".
- The message shown is plain text in Claude Code's own prompt; no custom screen.
