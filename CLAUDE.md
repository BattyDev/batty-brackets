# CLAUDE.md — Batty Brackets

The guidance for this project lives in **[AGENTS.md](AGENTS.md)**, kept in one
file so it can't drift out of sync between tools. Read it first.

The short version:

- No build step. Serve statically, `python3 -m http.server 8000`, then
  `/brackets/`.
- `node test/run.mjs` runs everything. The browser half silently skips without
  Playwright installed, so confirm which half ran before calling a UI change
  verified.
- Two real constraints: no service keys in `config.js`, and don't get the
  accessibility suites to green by weakening them.
- Everything else in AGENTS.md is description of how the code stands today, not
  a rulebook. Changing the architecture is a tradeoff to argue, not a line you
  can't cross.
