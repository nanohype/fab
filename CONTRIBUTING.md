# Contributing

This file covers what's specific to contributing to fab. The org-wide ground
rules (PR flow, style, no DCO) live in the
[org CONTRIBUTING](https://github.com/nanohype/.github/blob/main/CONTRIBUTING.md);
this document builds on them. [`CLAUDE.md`](CLAUDE.md) is the local law — the
architecture map, the conventions, and where every kind of change belongs.
[`AGENTS.md`](AGENTS.md) is the agent-facing entry point.

## The zero-runtime-deps constraint

Fab ships with **zero required runtime dependencies**. The default
`managed-agents` transport runs on native `fetch` and Node 24+ — nothing else.
`@anthropic-ai/claude-agent-sdk` is the single `optionalDependencies` entry,
consumed only when `FAB_RUNTIME=sdk` (or `sdk-k8s`) is selected, and the code
must degrade with a clear error when it's absent.

This is a hard constraint, not a preference. A PR that adds a required
`dependencies` entry will be asked to implement the pattern directly instead
(the same reason there's no yargs/commander — arg parsing is raw, the
Kubernetes client in `src/k8s.ts` is minimal `fetch`). If you genuinely think
something clears the bar, open an issue and make the case before writing the
code.

## Four-transport parity

Fab runs the same role definitions and workflow code against four transports —
`managed-agents` (default), `sdk`, `sdk-k8s`, and `claude-cli`, selected via
`FAB_RUNTIME`. The contract for changes:

- Anything that touches session behavior (prompts, tools, MCP servers, budget
  enforcement, resume, memory) must be considered against **all four**
  runtimes in `src/runtimes/`, not just the one you tested on.
- Full parity isn't always possible — the transports have real capability
  differences. When behavior diverges, the divergence is **documented, not
  silent**: update the parity matrix in
  [`docs/transports.md`](docs/transports.md) in the same PR.
- Shared translation logic lives in `src/runtimes/sdk-events.ts`; don't fork
  event handling per runtime when the SDK-shaped runtimes can share it.

## Skills and the overlay system

`skills/` holds the **baselines** — the markdown fab ships to its agents so
the system works out of the box. Personal taste doesn't belong here: the
overlay chain (`$FAB_SKILLS_DIR` → `~/.fab/skills/` → `<cwd>/.fab/skills/` →
bundled `skills/`, with `<skill>.md` replace and `<skill>.append.md`
concatenate semantics, resolved by `src/overlay.ts`) exists precisely so
adopters can layer their own recipes without forking. See
[`skills/README.md`](skills/README.md).

So: a contribution to `skills/` must make the **baseline** better for every
adopter — sharper structure, clearer criteria, fixed drift. If it encodes
your personal preferences, keep it in your overlay.

Factory policies follow the same one-place rule: production policies live in
`src/standards.ts` (referenced by name from prompts, never inlined), and the
public-bar JSON under `src/standards/` is a vendored copy whose canonical
source is the [nanohype repo](https://github.com/nanohype/nanohype) — change
it there first.

## Running the checks

The four phases plus formatting, from a clean checkout — all must exit 0:

```sh
npm install
npm run build          # tsc + vendored-standards copy into dist/
npm run lint           # tsc --noEmit (src + tests) + eslint
npm test               # vitest
npm run docs           # typedoc
npm run format:check   # prettier, org identity
```

Coverage is a gate, not a report:

```sh
npm run test:coverage  # vitest + v8 coverage floors
```

The floors live in `vitest.config.ts` and measure the whole `src/` surface —
modules with zero tests still count against them. They're set just below
measured actuals and ratchet up as coverage grows; if your change drops
coverage below a floor, add tests rather than lowering the threshold.
Lowering a floor is a reviewed decision with a written reason, not a fix.

CI runs every phase as a separate required job — build, lint, test, docs,
format, plus a hard `npm audit` gate and a signed container build. None is
advisory.

## Tests

Tests live in `__tests__/` and run with Vitest. The codebase is written to be
testable without a live API: time and clocks are injectable, runtimes sit
behind the `AgentRuntime` interface, and gate logic (`src/gate.ts`) is pure
functions. Follow that pattern — a change that can only be verified against a
live Anthropic session will be asked to grow a seam.

## Reporting

Bugs and ideas → issues on this repo. Security →
[private vulnerability reporting](https://github.com/nanohype/.github/blob/main/SECURITY.md),
never a public issue.
