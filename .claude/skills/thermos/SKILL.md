---
name: thermos
description: "Run both thermo-nuclear reviews (bugs/security and code quality) as parallel subagents, then synthesize their findings. Use for thermos, double thermo review, or a combined deep branch audit."
disable-model-invocation: true
---

# Thermos

Run the two thermo review passes as parallel background subagents, then synthesize their results.

## Workflow

1. Determine the review scope from the request, the PR, or the current branch. Default base is `origin/main` (`git fetch origin main` first).
2. Gather `git diff origin/main...HEAD` and the full contents of each changed file. Leave out `dist/` and other build output; review `src/`, the workers and `build.py` instead.
3. In one message, launch both with the Agent tool and `run_in_background: true`, passing each the same prompt with `### Git / diff output` and `### Changed file contents` sections:
   - `subagent_type: "thermo-nuclear-review"` for bugs, breakages, security, devex regressions and feature-gate leaks.
   - `subagent_type: "thermo-nuclear-code-quality-review"` for maintainability, structure, file-size growth, spaghetti and abstractions.
4. After both finish, synthesize: findings first, deduplicated across reviewers. Weight overlapping findings more heavily, resolve disagreements with your own judgment, and keep summaries brief.

Surface the unified verdict, the highest-signal findings with `file:line` evidence, and any remaining uncertainty. Do not restate each reviewer's report wholesale.
