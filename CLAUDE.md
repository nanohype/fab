# fab — Claude Code Instructions

## What this project is

A TypeScript CLI that deploys and orchestrates a team of 83 Claude managed agents via the Anthropic Managed Agents API. The roster is organized around factory phases — workflow code in `src/workflows.ts` fans out across phase-scoped multiagent sessions. There is no top-level coordinator agent; Managed Agents caps a multiagent roster at 20 unique agents and does not nest coordinators, so each phase runs as its own session and workflow code orchestrates across them.

Naming convention (see [`docs/roster.md`](docs/roster.md)):

- **`-curator`** — stewards knowledge of a system / service / platform (e.g., `aws-curator`, `landing-zone-curator`, `claude-curator`).
- **`-engineer`** — produces code or config with a tool / framework / language (e.g., `react-engineer`, `opentofu-engineer`, `helm-engineer`).
- **process names** — gate / checkpoint roles (`pr-reviewer`, `build-verifier`, `artifact-auditor`, `release-manager`, `external-reviewer`).

Groups (`group` field):

- **factory** — Discovery, Design, Build, Verify, Ship. Output is shippable artifacts. Gets `FACTORY_PREAMBLE` injected by `buildSystemPrompt`.
- **firm** — Operate, Customer, Business (Sales / Marketing / Lead Gen), System Curators, Staff.
- **lab** — meta: external-reviewer (cold-context rubric calibration), prompt-optimizer, learner.

## Architecture

- `src/types.ts` — all interfaces (agents, sessions, events, state, workflows). `TeamGroup` + `TeamRole` unions here.
- `src/api.ts` — `AnthropicAgents` class wrapping the managed agents REST API. Includes SSE reconnection with `Last-Event-ID`, pagination helper (`listAll`), and fast-model support.
- `src/runtime.ts` + `src/runtimes/` — `AgentRuntime` interface + four implementations: `managed-agents.ts` against the REST API; `sdk.ts` against `@anthropic-ai/claude-agent-sdk` (API-billed); `sdk-k8s.ts` dispatching each role-session as its own isolated pod on the eks-agent-platform substrate; `claude-cli.ts` driving the `claude -p` subprocess per role session (subscription-billable via the user's existing Claude Code login). `src/runtimes/sdk-events.ts` holds the shared SDK message → `AgentEvent` translator; `src/runtimes/role-session.ts` is the in-pod entrypoint (`fab role-session`) that `sdk-k8s` dispatches. `src/k8s.ts` is a minimal `fetch`-based in-cluster Kubernetes client. `src/runtimes/index.ts` exports `createRuntime(api)` which resolves the transport from `FAB_RUNTIME` (default `managed-agents`). Parity trade-offs documented in [`docs/transports.md`](docs/transports.md).
- `src/inference.ts` — the inference-backend seam. `resolveInferenceBackend()` reads `FAB_INFERENCE` (`api` default | `bedrock`); `resolveModelId()` maps canonical model ids to AWS Bedrock ids. Consumed only by the `sdk` runtime, which hosts the agent loop in-process and can therefore point the Agent SDK at Bedrock.
- `src/sandbox.ts` — the sandbox seam. `resolveSandboxMode()` reads `FAB_SANDBOX` (`cloud` default | `self-hosted`); `environmentConfig()` builds the `createEnvironment` config. Consumed by `deploy` and `getMemoryResource` — `self-hosted` points the Managed Agents environment at adopter-hosted workers and skips native Memory (unsupported with self-hosted sandboxes).
- `src/team.ts` — barrel that aggregates per-phase modules under `src/team/<phase>/<area>.ts`. Each module declares ≤ 8 specialists.
- `src/prompts.ts` — `buildSystemPrompt()` augmentation layer: appends journal, self-eval, repo, sprint, revision, and factory-production-standards preamble sections based on state + group. The Build Verification Protocol dispatches language-specific commands via `LANGUAGE_TOOLCHAIN[state.projectLanguage]`.
- `src/standards.ts` — factory production policies. Two layers: (1) **public bar** loaded at module init from the vendored `standards/*.json` (`LANGUAGE_TOOLCHAIN` only at present; future structured facts join via the same loader); (2) **private choreography** declared here as markdown blobs: `FOUR_PHASE_CONTRACT`, `VERSION_CURRENCY_POLICY`, `EVIDENCE_CONTRACT`, `QUALITY_RUBRIC` (dimension weights + per-role assignments + N/A criteria — the depth behind the public dimension names), `IAC_BY_TARGET`, `PLATFORM_TENANT_CONTRACT`, `LLM_POLICY`, `PRODUCTION_BAR` (9 dimensions with the specific REJECT criteria), `COMMIT_PR_POLICY`, `MERGE_GATE_CONTRACT`, `FACTORY_PREAMBLE` (assembled), `CODE_GATE_ROLES`, `DOCS_GATE_ROLES`. The public bar JSON is the [Platform Reference](../nanohype/docs/platform-reference.md); external clients see the guardrails, only fab knows the depth.
- `src/gate.ts` — pure helpers `parseGateVerdict`, `mergeGateVerdicts`, `applySelfReviewDowngrade` (merge-gate revision loop), plus `parseQualityGrades` + `compareGrades` (external-reviewer calibration). Verdicts without `TRANSCRIPTS:` + `CITATIONS:` blocks are auto-downgraded to REJECT per `EVIDENCE_CONTRACT`.
- `src/mcp.ts` — MCP server registry. Third-party servers (github, linear, slack, notion, sentry, figma, hunter) hit public endpoints directly. Gateway-hosted services (hubspot, gdrive, analytics, gcalendar, gcse, stripe) route through `${MCP_GATEWAY_BASE_URL}/mcp/{service}`. Auth is injected by the vault at session time (no inline headers).
- `src/skills.ts` — loads domain skills from the overlay chain (env → user → project → bundled) with nanohype brief templates as a default fallback when no overlay base exists
- `src/overlay.ts` — overlay resolver. Exports `resolveSkillPath`, `loadSkillWithOverlay`, `appendOverlays`. Priority: `$FAB_SKILLS_DIR` > `~/.fab/skills/` > `<cwd>/.fab/skills/` > bundled `fab/skills/`. Two override styles: `<skill>.md` (replace) and `<skill>.append.md` (concatenate). See [`skills/README.md`](skills/README.md) for the user-facing explanation
- `src/workflows.ts` — 18 built-in workflows tagged `factory | firm | lab`, with parallel groups, review gates, revision support, and workflow-level merge gates (`gateProfile: 'code' | 'docs'`). `streamWithAdvisor` is the shared stream consumer. `runMergeGate` is the merge-gate finalizer.
- `src/repl.ts` — interactive REPL with `/quit`, `/status`, `/threads`, `/switch`. Prompts for tool confirmation when `always_ask` policy fires.
- `src/advisor.ts` — `ADVISOR_TOOL` (Opus 4.6 escalation) + `callAdvisor()`. Per-session call-budgeted.
- `src/usage.ts` — token aggregation and cost estimation (local reporting)
- `src/state.ts` — local `.fab-state.json` persistence
- `src/stream.ts` — SSE event formatting for terminal output. Handles all event types including MCP tool use, thread events, and session status rescheduled/terminated.
- `src/bin/fab.ts` — CLI entry point. `advisorToolsFor(role)` gates the Opus advisor tool to phase leads + key gate roles (`intake-analyst`, `product`, `design-lead`, `agent-engineer`, `pr-reviewer`, `release-manager`, `ops-sre`, `cs-success`, `sales-lead`, `marketing-lead`, `chief-of-staff`, `external-reviewer`).
- `fab.schema.json` — intake contract JSON schema for external agents

## Conventions

- Zero required runtime dependencies — managed-agents mode uses native fetch + Node 24+. `@anthropic-ai/claude-agent-sdk` is an optional dependency consumed only when `FAB_RUNTIME=sdk`.
- TypeScript strict mode, ES2022 target, Node16 module resolution
- Raw arg parsing (no yargs/commander)
- 2-space indent everywhere
- ESLint + Prettier configured
- Tests with Vitest in `__tests__/`

## Factory Production Standards

Every factory agent (30 roles with `group: 'factory'`) receives `FACTORY_PREAMBLE` as a system-prompt section via `buildSystemPrompt`. The preamble defines the non-negotiable policies every factory deliverable must obey. Source of truth: `src/standards.ts`. Never inline these policies in role prompts — reference by name ("see PRODUCTION_BAR") so there's one place to edit.

- **Language dispatch** — `LANGUAGE_TOOLCHAIN` maps each supported language (typescript, go, python, rust, java, kotlin, csharp) to `install / build / lint / test / docs` commands + manifest + lockfile + `versionLookup` + registry. Every factory command is dispatched through this map — no `npm run X` baked in. `constraints.language` in the intake brief drives the resolution; `buildSystemPrompt` reads `state.projectLanguage` and emits the right commands in the Build Verification Protocol.
- **Four-phase contract** (`FOUR_PHASE_CONTRACT`) — every project exposes **build, lint, test, docs** as distinct executable phases that exit 0 from a clean checkout. CI runs all four as separate jobs. `build-verifier` runs all four plus `install` and a version-currency check, captures per-command stdout/stderr/exit as `TRANSCRIPTS:` evidence, and REJECTs on any failure.
- **Latest versions first** (`VERSION_CURRENCY_POLICY`) — every manifest entry is checked against its language registry (npm, proxy.golang.org, PyPI, crates.io, Maven Central, NuGet) at build-verifier time. Entries ≥1 major stale without an adjacent `@pin <reason>` annotation = REJECT. EOL language runtimes (Python ≤3.9, Node ≤18 post-2025-04, Go ≤1.20) = REJECT regardless of `@pin`. Intake-analyst enforces this at brief-submission time too.
- **Evidence on verdicts** (`EVIDENCE_CONTRACT`) — every gate verdict carries two appendix blocks: `TRANSCRIPTS:` (captured output per command run) and `CITATIONS:` (`{claim, file, line_range, quoted_fragment}` — fragment must appear verbatim at the cited location). APPROVE/REQUEST_CHANGES without both blocks = auto-downgraded to REJECT at the pipeline layer by `parseGateVerdict` in `gate.ts`. REJECT verdicts may ship without evidence (the point there is to fail fast).
- **Quality rubric** (`QUALITY_RUBRIC`) — 9 dimensions imported from `/quality-check`, each assigned to one gate role. Every verdict ends with a `QUALITY_GRADES:` block scoped to the role's dimensions. pr-reviewer grades architecture/patterns/frontend/code_quality; qa-security grades security/systems; build-verifier grades testing/devops/version_currency; artifact-auditor grades documentation/consistency. The `external-reviewer` role (lab group) grades all 9 cold (no internal verdicts, no prior context) as a calibration check — `compareGrades` blocks release on >1-letter drift between internal and external per dimension.
- **IaC by deploy_target** — k8s-native is the default: Helm chart + ApplicationSet entry into `nanohype/eks-gitops`/`aks-gitops` + `Platform` CR on `eks-agent-platform`. Cloud substrate gaps land as new components in `nanohype/landing-zone` (OpenTofu/Terragrunt). Cluster addons land in the gitops repo. Escape hatches (require architecture-artifact justification): `aws-lambda`→AWS CDK, `fly`→fly.toml, `vercel`→vercel.json, `cloudflare`→Wrangler. AWS CDK is reachable only via the `aws-lambda` escape hatch — the default AWS path is k8s-native (EKS via landing-zone + eks-gitops + eks-agent-platform).
- **Platform tenant contract** (`PLATFORM_TENANT_CONTRACT`) — every k8s-native deliverable ships as a Platform tenant: `<app>/chart/` Helm chart with per-env values, `<app>/gitops/applicationset-entry.yaml`, `<app>/platform.yaml` (CR), optional `agentfleet.yaml` for AI workloads. Required OTel resource attrs: `agents.tenant`, `agents.platform`, plus `agents.model_family` + `agents.model_id` for AI workloads. The Platform reconciler owns IRSA scaffolding; agents do NOT scaffold IAM roles inline.
- **LLM policy** — Claude-primary via AWS Bedrock. SDK per language (TS `@aws-sdk/client-bedrock-runtime`, Python `boto3`, Go `aws-sdk-go-v2/service/bedrockruntime`, Rust `aws-sdk-bedrockruntime`, Java `software.amazon.awssdk:bedrockruntime`, C# `AWSSDK.BedrockRuntime`). IAM-role auth. Default `claude-sonnet-4-6`, opus for complex reasoning, haiku for classification. Prompt caching mandatory.
- **Production bar** (9 dimensions, non-negotiable) — tests, observability, security, reliability, cost, docs, CI, code-shape, versions. See `PRODUCTION_BAR` in standards.ts for full text.
- **Commit + PR policy** — CLI pre-creates `feat/<slug>` branch on the target repo; every role commits one commit via github MCP `push_files`; release-manager opens the PR only after the merge gate approves AND external-reviewer calibration aligns. PR description includes a **Scope ledger** section (Planned / Delivered / Deferred from `scope-ledger.json`) — release notes generated from `Planned ∩ Delivered ∩ actual diff`, never free-text.
- **Merge gate** — factory PRs block on 4-role sign-off with evidence (pr-reviewer + qa-security + build-verifier + artifact-auditor — code gate) or 2-role (artifact-auditor + qa-security — docs gate). After approval, `external-reviewer` runs cold-context calibration. Any REJECT → fail; any REQUEST_CHANGES → revise (3 attempts); all APPROVE + calibration within ±1 letter → release-manager opens the PR with verdicts + grades in the body.

## Key patterns

- **Prompt augmentation**: per-phase modules under `src/team/` declare base prompts, `prompts.ts` appends dynamic sections (including `FACTORY_PREAMBLE` for factory roles from `standards.ts`). Deploy calls `buildSystemPrompt(member, state)`. Never modify system prompts in `src/team/` for state-dependent content — put it in `prompts.ts`. Never inline production policies — put them in `standards.ts`.
- **Runner-driven delegation**: `executeWorkflow` invokes each role in its own session via the `AgentRuntime` abstraction (`runtime.runRoleSession`) — a fresh session backed by that role's deployed agent, the configured repos + vaults, and the role's own system prompt. There is no coordinator agent; workflow code routes between sessions. External-reviewer calibration is naturally cold because a new session starts with no prior context. Advisor (Opus) and per-role models are used correctly because each role runs on its own deployed agent.
- **Repo fail-fast**: on code-producing workflows, `executeWorkflow` halts up front if no primary repo is configured or the GitHub branch pre-create fails. Silent degradation produces ambiguous behaviour ("agent created a random repo" / "agent stumbled into the wrong tree via `ls`"). The clear error message directs the user to `fab repo add <github-url> --token <github-pat>`.
- **Merge gate flow**: code-producing workflows (feature-build, mobile-ship, infra-setup, security-audit, perf-review, incident, automate, launch-prep) declare `gateProfile: 'code'`. Doc-only workflows (content-engine) declare `gateProfile: 'docs'`. `executeWorkflow` in `workflows.ts` parses `constraints.language` from the intake JSON and persists it via `setProjectLanguage`, then pre-creates the feature branch. After the main workflow loop, `runMergeGate` iterates the gate roles (each in its own session), parses each `GATE_VERDICT` (with evidence enforcement via `parseGateVerdict`), merges via `mergeGateVerdicts`, loops up to 3 times on revise. On APPROVE (code profile only), `runExternalCalibration` invokes `external-reviewer` in its own cold session — `compareGrades` detects >1-letter drift per dimension and blocks with a synthesized REJECT naming the diverged role. release-manager only opens the PR when gate and calibration both pass, and its pre-push synthesis (intake-to-merge traceability + gate correlation spot-check) clears.
- **Self-review downgrade**: if a PR diff touches a gate role's own definition file, that vote downgrades to advisory via `applySelfReviewDowngrade`. Remaining roles must approve unanimously.
- **Intake briefs**: `fab.schema.json` defines the brief shape; `docs/INTAKE_GUIDE.md` defines the quality bar (anatomy of each section, anti-patterns from past failures, two annotated examples, pre-flight checklist). Anyone authoring a brief — human or agent — applies the guide's rubric. The `intake-analyst` role loads the guide, applies the checklist, enriches recoverable gaps, and blocks unrecoverable ones with specific questions to the caller before the workflow proceeds.
- **State batching**: `deploy()` loads state once, mutates in memory, writes once at the end. Other commands use individual helper functions from `state.ts`.
- **MCP servers always included**: the registry in `mcp.ts` provides default URLs. Env vars override, never gate.
- **Stream termination**: `streamWithAdvisor` breaks on `session.status_idle`, `session.error`, and `session.status_terminated`. It continues through `session.status_rescheduled` (transient retry).
- **Advisor access is scoped**: only phase leads + key gate roles get the `consult_advisor` tool (see `ADVISOR_ROLES` in `src/advisor.ts`). All specialist roles are excluded to keep Opus distribution in check. Per-session call cap is 3 (default) via `StreamOptions.maxAdvisorCalls`.
- **Memory is native**: `deploy` provisions one shared Managed Agents Memory store (`state.memory.storeId`); `runRoleSession` attaches it to every session via `resources`, mounted at `/mnt/memory/`. There is no memory MCP server and no `buildSystemPrompt` memory section. Managed-agents transport only — `sdk` / `claude-cli` have no shared memory.

## Environment

Required:

- `ANTHROPIC_API_KEY`

Required if using the gateway (switchboard services):

- `MCP_GATEWAY_BASE_URL` — API Gateway endpoint from `cdk deploy` output
- `MCP_GATEWAY_TOKEN` — bearer from `/mcp-gateway/gateway-bearer-token` in Secrets Manager

Optional per-server URL overrides: `MCP_GITHUB_URL`, `MCP_LINEAR_URL`, `MCP_SLACK_URL`, `MCP_NOTION_URL`, `MCP_SENTRY_URL`, `MCP_FIGMA_URL`, `MCP_HUNTER_URL`, `MCP_HUBSPOT_URL`, `MCP_GDRIVE_URL`, `MCP_GCALENDAR_URL`, `MCP_ANALYTICS_URL`, `MCP_GCSE_URL`, `MCP_STRIPE_URL`.

## Running

```sh
npm install
npm run build        # tsc
npm test             # vitest
npm run lint         # tsc --noEmit + eslint
npm run format:check # prettier
```

`Dockerfile` builds a runtime image (entrypoint `node dist/bin/fab.js`); `deploy/` holds example k8s manifests for running workflows as Jobs with Bedrock inference via an IRSA ServiceAccount. CI builds the image on every PR.

## Style

- 2-space indent for TypeScript, JSON, YAML, Markdown
- LF line endings
- No trailing whitespace
