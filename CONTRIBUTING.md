# Contributing / المساهمة

Thanks for trying Impact Map. The most useful thing you can do right now is **tell us where the map was wrong**.

## Reporting a wrong result (the most valuable report)
Open an issue and include:
- what you asked ("what breaks if I delete `x.js`?") and what the map said (including the **confidence** level);
- what actually broke, and which file/line (a failing test or error message is perfect);
- the project type (plain Node, Express, React, TypeScript...). Do not paste secrets or private code; a minimal example is better.

Misses that the confidence level already flagged (medium/low) are expected: say so, but they still help us tune the reasons.

## Running the checks
```
node tests/selftest.js                       # everything works together on the bundled demo project
node tests/file_level_check.js <project>     # deletes each file for real in a copy and compares with the map
claude plugin validate .                     # the plugin manifest is valid
```

## Code
- No build step, no dependencies to install (acorn and acorn-jsx are bundled in `vendor/`).
- The analyzer is `analyzer/fnmap.js`, grouping is `analyzer/group.js`, confidence is `analyzer/confidence.js`, the page is `map/template.html`.
- Keep results deterministic. If you change grouping or analysis, show that results on a few real projects did not get worse (the pages and numbers in `README.md` should stay true).
- Say what is measured and what is a guess. Please do not add claims the tests do not back.

## Limits worth knowing
JavaScript/TypeScript only; the map is an estimate, not a guarantee; one-time permission approvals in Claude Code are not stored anywhere we can read.
