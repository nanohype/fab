# Fab skills

Skills are the markdown files fab ships to its agents — the production-bar preamble, the quality-check rubric, the per-role briefs, the intake guide. Anything an agent reads as "instructions" goes here.

This directory holds **baselines**. They're shipped with fab so the system works out of the box. If you want your factory to feel like _yours_, drop your own files into the **overlay** chain — your files win, no fork needed.

## The overlay chain

When fab loads a skill named `<skill>`, it walks four locations in priority order. **First match wins** as the base:

| Priority    | Location                          | When to use                                                           |
| ----------- | --------------------------------- | --------------------------------------------------------------------- |
| 1 (highest) | `$FAB_SKILLS_DIR/<skill>.md`      | One-off override for a specific invocation (CI, scripts, experiments) |
| 2           | `~/.fab/skills/<skill>.md`        | Your personal recipe across every project                             |
| 3           | `<cwd>/.fab/skills/<skill>.md`    | Per-project tuning checked into the project's repo                    |
| 4 (lowest)  | `<fab-package>/skills/<skill>.md` | Bundled baseline (this directory)                                     |

For example: fab looks for `quality-check.md`. If `~/.fab/skills/quality-check.md` exists, it's used. Otherwise the bundled baseline (`fab/skills/quality-check.md`) wins.

## Two override styles

**Replace** (`<skill>.md`): the entire baseline is swapped out. Use when your recipe is its own thing.

**Append** (`<skill>.append.md`): your file's content is concatenated onto the resolved base. Use when you want to add voice, anti-patterns, or constraints without rewriting the baseline. Append files from **every** layer are collected and concatenated low-priority-first — so the project's appends come before the user's appends come before the env's.

Example, by file:

```
~/.fab/skills/quality-check.md            ← REPLACES the baseline
~/.fab/skills/factory-preamble.append.md  ← ADDS voice rules to the bundled preamble
<my-project>/.fab/skills/brief-prd.append.md  ← project-specific brief addenda
```

## What's bundled today

| File                                                                     | What it is                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality-check.md`                                                       | The deepened quality-check rubric — named architects, books, pattern-to-solution catalog, domain-specific frames, anti-pattern grep list, bibliography                                                                      |
| `factory-preamble.md`                                                    | The assembled production-bar preamble (IaC contract + Platform tenant contract + LLM policy + production bar + four-phase contract + version currency + evidence contract + quality rubric + commit/PR policy + merge gate) |
| `intake-guide.md`                                                        | The brief-authoring rubric — anatomy of a strong brief with strong/weak examples                                                                                                                                            |
| `brief-prd.md`, `brief-design-review.md`, `brief-test-strategy.md`, etc. | Thin pointer files for non-engineering role briefs that resolve to the `nanohype/templates/brief-*` catalog by default; overlayable                                                                                         |

## Quick start: write your first overlay

```sh
mkdir -p ~/.fab/skills
# Add a personal anti-pattern checklist that runs after every quality-check
cat > ~/.fab/skills/quality-check.append.md <<'EOF'

## Personal anti-patterns (append)

- `async function fooHandler` with no `try/catch` — unhandled rejection
- Any `console.log` in production code — should be the structured logger
- Hardcoded model IDs anywhere outside the LLM gateway
EOF
```

Next time fab loads the quality-check skill for any role, those three rules get appended onto the baseline.

## Debug / inspect

```sh
# Coming in a follow-up: `fab skills resolve <skill>` prints the resolution chain
# Today: just `ls -la $FAB_SKILLS_DIR ~/.fab/skills $(pwd)/.fab/skills`
```

## Brief-skill overlay caveat

Brief skills (`brief-prd`, `brief-design-review`, etc.) load by default from `nanohype/templates/brief-*/skeleton/brief.md` with placeholder substitution (`__PROBLEM_STATEMENT__` etc.). If you **replace** a brief via the overlay, you're responsible for keeping the placeholder slots intact — otherwise substitution fails. If you only want to add notes to a brief, prefer the `.append.md` form (placeholders aren't affected).

## See also

- [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md) — the org-wide view of the stack fab produces work on
- [`fab/CLAUDE.md`](../CLAUDE.md) — Claude Code instructions for working inside this repo
- [`fab/src/overlay.ts`](../src/overlay.ts) — the resolver
- [`fab/__tests__/overlay.test.ts`](../__tests__/overlay.test.ts) — tests covering priority, append, missing-file
