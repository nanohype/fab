# Fab skills

This directory holds the quality-check rubric and the per-role curation and engineering baselines. Each file is resolved by name through the overlay chain: `quality-check` for the gate roles, the external reviewer and an interactive quality check, and every other file for the role whose SkillDef `name` in `src/skills.ts` matches it, attached on the `managed-agents` transport.

These are **baselines**. They're shipped with fab so the system works out of the box. If you want your factory to feel like _yours_, drop your own files into the **overlay** chain — your files win, no fork needed.

## The overlay chain

When fab loads a skill named `<skill>`, it walks four locations in priority order. **First match wins** as the base:

| Priority    | Location                          | When to use                                                           |
| ----------- | --------------------------------- | --------------------------------------------------------------------- |
| 1 (highest) | `$FAB_SKILLS_DIR/<skill>.md`      | One-off override for a specific invocation (CI, scripts, experiments) |
| 2           | `~/.fab/skills/<skill>.md`        | Your personal recipe across every project                             |
| 3           | `<cwd>/.fab/skills/<skill>.md`    | Per-project tuning checked into the project's repo                    |
| 4 (lowest)  | `<fab-package>/skills/<skill>.md` | Bundled baseline (this directory)                                     |

For example: the `pr-reviewer` role loads the skill named `pr-review`. If `~/.fab/skills/pr-review.md` exists, it's used. Otherwise the role's default loader builds it.

Role skills attach only on `managed-agents`, resolved when `fab deploy` or `fab skills upload` runs; the `sdk`, `claude-cli` and `sdk-k8s` transports load no role skill.

The quality-check rubric resolves on the machine that builds the prompt: fab's own process for the `sdk` and `claude-cli` transports, the deploying machine at `fab deploy` for `managed-agents`, and the session pod for `sdk-k8s`, where only the layers inside the session image apply.

## Two override styles

**Replace** (`<skill>.md`): the entire baseline is swapped out. Use when your recipe is its own thing.

**Append** (`<skill>.append.md`): your file's content is concatenated onto the resolved base. Use when you want to add voice, anti-patterns, or constraints without rewriting the baseline. Append files from **every** layer are collected and concatenated low-priority-first — so the project's appends come before the user's appends come before the env's.

Example, by file:

```
~/.fab/skills/quality-check.append.md        ← DEEPENS the quality-check rubric
~/.fab/skills/pr-review.append.md            ← ADDS review rules to the pr-reviewer skill
<my-project>/.fab/skills/prd-brief.append.md ← project-specific addenda to the product role's PRD brief
```

## What's bundled

| File                    | What it is                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality-check.md`      | The quality-check rubric: the published standards pass (§0), ten dimension sections (lens, canonical reading, pattern-to-solution map, frames, anti-pattern and good-pattern greps), the report format and a bibliography |
| `<tool>-curation.md`    | The skill baseline for the `<tool>-curator` role (for example `aws-curation.md` for `aws-curator`)                                                                                                                        |
| `<area>-engineering.md` | The skill baseline for the `<area>-engineer` role (for example `helm-engineering.md` for `helm-engineer`)                                                                                                                 |

`__tests__/skills.test.ts` holds every bundled file other than this README and `quality-check.md` to a SkillDef name, so a baseline no role loads fails the suite. Roles with no bundled baseline build their skill from their SkillDef: a nanohype brief template for `brief` skills, the SkillDef description for `generated` ones.

Two things agents read are not skills and do not live here: the factory preamble is assembled in `src/standards.ts` (`FACTORY_PREAMBLE`), and the brief-authoring rubric is `docs/INTAKE_GUIDE.md`.

## How the quality-check rubric reaches graders

The rubric is one resolved body, read by two kinds of grader:

- **fab's gate roles and external reviewer.** `buildSystemPrompt` adds a Quality rubric depth section (`src/rubric.ts`) to every merge-gate role and to `external-reviewer`: the resolved base from `## 0. Apply the published standards` up to `## Output format`, then every `quality-check.append.md`. Each gate role grades only the dimensions `QUALITY_DIMENSION_OWNERS` in `src/standards.ts` assigns it and emits the block its role prompt declares; the external reviewer grades all ten. A replacement `quality-check.md` keeps the `## 0. Apply the published standards` heading; without it, building a gate role's prompt fails with an error naming the file.
- **An interactive quality check** (a `/quality-check` skill that loads this rubric). It reads the whole resolved base, report format included, plus every append.

The two read the same definitions through different graders and instructions, so an interactive grade and a factory grade can differ. `PRODUCTION_BAR` in `src/standards.ts` is a factory pass/fail bar, not a grade cap: a PRODUCTION_BAR failure is a REJECT verdict, and grade caps come only from the rubric.

## Quick start: write your first overlay

```sh
mkdir -p ~/.fab/skills
# Add a personal anti-pattern checklist to the quality-check rubric
cat > ~/.fab/skills/quality-check.append.md <<'EOF'

## Personal anti-patterns (append)

- `async function fooHandler` with no `try/catch` — unhandled rejection
- Any `console.log` in production code — should be the structured logger
- Hardcoded model IDs anywhere outside the LLM gateway
EOF
```

Every gate-role and external-reviewer prompt built after that carries those three rules after the rubric's dimension sections (for `managed-agents`, from the next `fab deploy`), and an interactive quality check applies them too.

## Debug / inspect

```sh
fab skills show <role>                                                # prints a role's resolved skill
ls -la ${FAB_SKILLS_DIR:+"$FAB_SKILLS_DIR"} ~/.fab/skills ./.fab/skills # lists the overlay files in each layer
```

## Brief-skill overlay caveat

Brief skills (`prd-brief`, `design-review-brief`, etc.) load by default from `nanohype/templates/brief-*/skeleton/brief.md` with placeholder substitution (`__PROBLEM_STATEMENT__` etc.). If you **replace** a brief via the overlay, you're responsible for keeping the placeholder slots intact — otherwise substitution fails. If you only want to add notes to a brief, prefer the `.append.md` form (placeholders aren't affected).

## See also

- [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md) — the org-wide view of the stack fab produces work on
- [`fab/CLAUDE.md`](../CLAUDE.md) — Claude Code instructions for working inside this repo
- [`fab/src/overlay.ts`](../src/overlay.ts) — the resolver
- [`fab/src/rubric.ts`](../src/rubric.ts) — the rubric depth section the graders receive
- [`fab/__tests__/overlay.test.ts`](../__tests__/overlay.test.ts) — tests covering priority, append, missing-file
