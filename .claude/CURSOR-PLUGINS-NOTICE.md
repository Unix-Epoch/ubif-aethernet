# Adapted from cursor/plugins

These skills and agents are adapted from https://github.com/cursor/plugins (MIT License, Copyright (c) 2026 Cursor; full text in `CURSOR-PLUGINS-LICENSE`).

| Here | Source |
|:--|:--|
| `skills/thermos`, `agents/thermo-nuclear-*` | `thermos/` |
| `skills/thermo-nuclear-review`, `skills/thermo-nuclear-code-quality-review` | `thermos/skills/` |
| `skills/verify-this`, `skills/fix-merge-conflicts`, `skills/what-did-i-get-done` | `cursor-team-kit/skills/` |

Changes: Cursor `Task` calls became Claude `Agent` calls, `gh`/`glab` PR reads point to the GitHub MCP tools in cloud sessions, Cursor-only helpers (`control-cli`, `control-ui`) were replaced, and review scope skips `dist/`.
