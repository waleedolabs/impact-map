---
description: Make Claude use the impact map before every edit or delete in this project, and keep the map up to date as you work
argument-hint: "[off]"
---

Use the `impact-map` skill, section 4 ("Keep the map in the loop").

If the argument is empty or "on":
1. Build or refresh the map now (section 1 of the skill) so `.impact/graph.json` exists.
2. Add the standing rule block from section 4 to the project's `CLAUDE.md` (create the file if it does not exist). If the block is already there, say so and change nothing.
   Show me the block you added and the file path, in plain words.
3. From now on in this session follow the rules of section 4 even if I do not repeat them.

If the argument is "off": remove only that block from `CLAUDE.md` (the part between the two `impact-map` marker lines) and say what you removed.
Keep the answer short and in plain words, in my language.
