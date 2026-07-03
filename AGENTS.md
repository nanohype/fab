# fab — agent entry point

You're an AI client (or the author of one) about to drive the factory or extend it — run a workflow, author an intake brief, pick a transport, pass the merge gate, add a role or skill. This file gets you running. For how fab fits the wider stack, read the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

fab is the open-source reference factory orchestrator: a zero-runtime-dependency TypeScript CLI (Node ≥24, ESM, `@nanohype/fab`, Apache-2.0) that drives 80 Claude agents through a production-grade pipeline — Discovery → Design → Build → Verify → Ship.

## The mental model

- **80 agents in three groups** (each `TeamMember.group`): **factory** (Discovery/Design/Build/Verify/Ship — ships artifacts, gets `FACTORY_PREAMBLE`), **firm** (Operate/Customer/Business/System-Curators/Staff — runs the business, ungated), **lab** (external-reviewer/prompt-optimizer/learner — calibration + meta).
- **Naming convention:** `-curator` = knowledge stewardship (advises/reviews), `-engineer` = production with a tool/language, process names (no suffix) = gate roles (`pr-reviewer`, `build-verifier`, `artifact-auditor`, `release-manager`, `external-reviewer`).
- **No coordinator agent.** `src/workflows.ts` is the top-level router; it runs each role in its own session via `runtime.runRoleSession`. Managed Agents caps a multiagent roster at 20 unique agents and won't nest coordinators, so each phase runs as its own session and workflow code orchestrates across them.
- Full hierarchy + model tiering in [`docs/roster.md`](docs/roster.md); roles are declared per phase in `src/team/<phase>/<area>.ts` (≤8 specialists each, re-exported by `src/team.ts`).

## Drive a workflow

CLI bin `fab` → `dist/bin/fab.js` (entry `src/bin/fab.ts`):

```sh
fab deploy [--dry-run]                  # managed-agents only: env + skills + roster + Memory store
fab repo add <github-url> --token <pat> # REQUIRED before any code workflow (or it fails fast)
fab workflow <name> '<intake-json | goal>'
fab workflows                           # list the 18 built-ins
fab chat <role> | send <id> <msg> | stream <id> | sessions | events <id> | usage | perf
```

18 built-in workflows (enum in `fab.schema.json`, defs in `src/workflows.ts`): `launch-prep`, `feature-build`, `mobile-ship`, `infra-setup`, `security-audit`, `perf-review`, `ux-review`, `data-quality`, `lead-gen`, `deal-close`, `market-push`, `content-engine`, `partnership`, `customer-onboard`, `renewal`, `sprint-plan`, `incident`, `automate`.

**Repo fail-fast:** code-producing workflows halt up front if no primary repo is configured or the `feat/<slug>` branch pre-create fails — the error points you at `fab repo add`. Don't skip it.

## The intake contract — author a valid brief

The first user message must conform to `fab.schema.json` (`$id https://nanohype.dev/fab/intake`). Only `goal` is required.

- `goal` — the outcome, not the process.
- `workflow` — one of the 18 (omit to let routing decide).
- `constraints` — `timeline`, `deploy_target` (`aws`|`fly`|`vercel`|`cloudflare`|`k8s`), `budget`, **`language`** (`typescript`|`go`|`python`|`rust`|`java`|`kotlin`|`csharp` — **required for the code-producing workflows**, it dispatches `LANGUAGE_TOOLCHAIN`), `language_versions` (latest-stable-first; EOL runtimes rejected), `model`.
- `context` — `client` (no `Acme Corp` placeholders), `product` (slugged into the branch), `problem`, `audience`, `success_criteria[]` (**must be falsifiable** — `<3s p50`, not "fast"), `security_requirements[]`, `out_of_scope[]`, `existing_systems[]`, `competitors[]`.
- `roles[]`, `artifacts[]`, `source_dirs[]` (soft-scope to a subtree).

The quality bar per field lives in [`docs/INTAKE_GUIDE.md`](docs/INTAKE_GUIDE.md) — anyone authoring a brief applies it; the `intake-analyst` role enriches recoverable gaps and blocks unrecoverable ones with specific questions before the workflow proceeds. `fab.schema.json` carries a worked example.

## Pick a transport (`FAB_RUNTIME`) and inference (`FAB_INFERENCE`)

`src/runtimes/index.ts#createRuntime` resolves the transport (unknown values throw). All four run the **same** roster, workflows, gate logic, skill overlay, and `FACTORY_PREAMBLE`:

- **`managed-agents`** (default) — Anthropic-hosted REST API; durable/listable sessions, native Memory at `/mnt/memory/`; needs `fab deploy`; billed per-token on `ANTHROPIC_API_KEY`.
- **`sdk`** — `@anthropic-ai/claude-agent-sdk` (optional dep) runs the loop in fab's process; no deploy; no shared memory.
- **`sdk-k8s`** — the sdk loop, each role-session dispatched as its own isolated pod via an `AgentSandbox` CR the eks-agent-platform operator hardens (restricted PSS, default-deny NetworkPolicy, tenant IRSA SA, optional gVisor/Kata). In-cluster only.
- **`claude-cli`** — drives `claude -p` per session; subscription-billable via your Claude Code login (`claude setup-token`).

`FAB_INFERENCE` is **orthogonal** and read **only by the `sdk` runtime**: `api` (default) | `bedrock` (`CLAUDE_CODE_USE_BEDROCK`, AWS cred chain incl. Pod Identity, no token reaches Anthropic) | `anthropic-aws` (Claude Platform on AWS). `sdk-k8s` + `bedrock` is the regulated-enterprise end state. Parity matrix in [`docs/transports.md`](docs/transports.md).

## The merge gate — how a code workflow ships

Code workflows declare `gateProfile: 'code'`; doc-only declare `'docs'`. Flow (`runMergeGate` in `src/workflows.ts`, helpers in `src/gate.ts`):

1. **Four-phase pre-hook** — install→build→lint→test→docs from a clean checkout via `LANGUAGE_TOOLCHAIN`; any non-zero exit auto-REJECTs _before_ any LLM gate role runs.
2. **Gate roles** in their own sessions: code = `pr-reviewer` + `qa-security` + `build-verifier` + `artifact-auditor`; docs = `artifact-auditor` + `qa-security`.
3. **Evidence contract** — every verdict ends with `GATE_VERDICT`, `TRANSCRIPTS:` (per-command stdout/stderr/exit), `CITATIONS:` (`{claim, file, line_range, quoted_fragment}` verbatim), `QUALITY_GRADES:`. `parseGateVerdict` auto-downgrades any APPROVE/REQUEST_CHANGES missing transcripts+citations to REJECT.
4. **Merge** (`mergeGateVerdicts`): any REJECT → fail; any REQUEST_CHANGES → revise (≤3 attempts); all APPROVE → calibration.
5. **External calibration** — `external-reviewer` runs cold (intake + tree only), grades all 9 dimensions; `compareGrades` blocks release on >1-letter drift per dimension.
6. **Self-review downgrade** — if the diff touches a gate role's own definition, that vote goes advisory.
7. `release-manager` opens the PR only after gate + calibration pass; the body carries a Scope ledger (Planned/Delivered/Deferred).

## Factory production standards (`FACTORY_PREAMBLE`)

Every `group:'factory'` role gets `FACTORY_PREAMBLE` injected by `buildSystemPrompt` (`src/prompts.ts`). **Source of truth is `src/standards.ts` — never inline these in role prompts; reference by name.** Two layers: the public bar from vendored `src/standards/*.json`, and private markdown contracts (`FOUR_PHASE_CONTRACT`, `VERSION_CURRENCY_POLICY`, `EVIDENCE_CONTRACT`, `QUALITY_RUBRIC`, `IAC_BY_TARGET`, `PLATFORM_TENANT_CONTRACT`, `LLM_POLICY`, `PRODUCTION_BAR`, `COMMIT_PR_POLICY`, `MERGE_GATE_CONTRACT`). The load-bearing ones:

- **Four-phase contract** — build/lint/test/docs are distinct phases exiting 0 from a clean checkout; CI runs all four.
- **Latest-versions-first** — a manifest entry ≥1 major stale without an adjacent `@pin <reason>` is a REJECT; EOL runtimes REJECT regardless.
- **Language dispatch** — every factory command flows through `LANGUAGE_TOOLCHAIN[language]`, never a baked-in `npm run X`.
- **IaC by `deploy_target`** — k8s-native is default: a Helm chart + an ApplicationSet entry into `nanohype/eks-gitops` + a `Platform` CR on `eks-agent-platform`. Cloud-substrate gaps land in `landing-zone`; cluster addons in the gitops repo. `aws-lambda`/`fly`/`vercel`/`cloudflare` are escape hatches needing architecture justification.
- **Platform-tenant contract** — ship `<app>/chart/`, `<app>/gitops/applicationset-entry.yaml`, `<app>/platform.yaml` (+ optional `agentfleet.yaml`); required OTel attrs `agents.tenant`/`agents.platform`; the reconciler owns IRSA — agents never scaffold IAM inline.
- **LLM policy** — Claude via Bedrock, IAM auth, default `claude-sonnet-4-6`, prompt caching mandatory.

## Extend fab

- **Add/edit a role** — declare it in `src/team/<phase>/<area>.ts` (set `group`, `model`, optional `effort`); put state-dependent prompt content in `src/prompts.ts`, never in `src/team/`; never inline production policy — it goes in `src/standards.ts`.
- **Skill overlay (the no-fork extension point)** — `src/overlay.ts` resolves a skill through `$FAB_SKILLS_DIR → ~/.fab/skills/ → <cwd>/.fab/skills/ → bundled fab/skills/`, first match wins. `<skill>.md` **replaces** the baseline; `<skill>.append.md` **concatenates** (every layer, low-priority-first). See [`skills/README.md`](skills/README.md).
- **MCP (`src/mcp.ts`)** — third-party servers (github, linear, slack, notion, sentry, figma, hunter) hit public endpoints directly; switchboard services (hubspot, gdrive, gcalendar, analytics, gcse, stripe) route through `${MCP_GATEWAY_BASE_URL}/mcp/{service}` behind `MCP_GATEWAY_TOKEN` (a gateway you operate; skipped if unset). Private servers reach in via `FAB_MCP_TUNNEL` (paired with the `mcp-tunnel` eks-gitops addon). Auth is vault-injected at session time — never inline headers.
- **Programmatic API** — `src/index.ts` exports a typed SDK surface (`AnthropicAgents`, `TEAM`, `executeWorkflow`/`getWorkflow`/`listWorkflows`, `buildSystemPrompt`, `resolveMcpServers`, gate/usage/quality helpers).

## Run in a cluster + per-session attribution

`Dockerfile` builds a runtime image (entry `node dist/bin/fab.js`); `deploy/` holds example manifests. `deploy/job.yaml` runs one workflow as a Job with `FAB_RUNTIME=sdk` + `FAB_INFERENCE=bedrock` — the loop runs in the pod and Bedrock auth comes from a Pod-Identity-bound ServiceAccount, not a static key. For per-session pod isolation use `FAB_RUNTIME=sdk-k8s` (apply `deploy/rbac.yaml`; set `FAB_K8S_NAMESPACE`/`FAB_K8S_SESSION_IMAGE`/`FAB_K8S_PLATFORM`).

**Attribution** (`src/attribution.ts`, [`docs/attribution.md`](docs/attribution.md)) — set `FAB_OPERATOR=<human>` and each session binds its AWS actions (a session role carrying the operator as STS `SourceIdentity`) and Kubernetes actions (an impersonating kubeconfig) to that named human instead of the anonymous tenant role. Computes both bindings before mutating env (fails closed); a no-op when unset (the default).

## Build, test, conventions

```sh
npm install
npm run build        # tsc + scripts/copy-standards.mjs (vendors standards JSON into dist)
npm test             # vitest run
npm run lint         # typecheck (src + __tests__ via tsconfig.test.json) then eslint
npm run format:check # prettier
```

Node ≥24, TS strict, ESM, Node16 resolution. Raw arg parsing (no yargs/commander). Zero required runtime deps; `@anthropic-ai/claude-agent-sdk` is an optional dep used only by `sdk`/`sdk-k8s`. Tests live in `__tests__/` and are type-checked separately. CI builds the image on every PR.

## Pointers

- [`docs/roster.md`](docs/roster.md) — the 80-role hierarchy, naming, gate roles, model tiering.
- [`docs/INTAKE_GUIDE.md`](docs/INTAKE_GUIDE.md) — the brief-authoring rubric (apply before submitting an intake).
- [`docs/transports.md`](docs/transports.md) — the four-transport parity matrix + inference backends.
- [`docs/attribution.md`](docs/attribution.md) — operator binding + the platform IAM/RBAC it needs.
- `fab.schema.json` — the intake contract. `src/workflows.ts` / `src/standards.ts` — the workflow + standards sources of truth.
- `CLAUDE.md` — Claude Code instructions for working _inside_ this repo.
- Sibling entry points: `eks-gitops`, `cloudgov`, `kx`.
