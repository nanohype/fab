# Transports

Fab runs the same role definitions + workflow code against four transports:

- **`managed-agents`** (default) — Anthropic-hosted REST API. Sessions and sandboxes live on Anthropic infrastructure.
- **`sdk`** — `@anthropic-ai/claude-agent-sdk` running the agent loop in fab's own process. Sessions run in-process; tools touch the working directory.
- **`sdk-k8s`** — the `sdk` agent loop, but each role-session dispatched as its own isolated pod on the eks-agent-platform substrate. See [Per-session pod isolation](#per-session-pod-isolation-sdk-k8s).
- **`claude-cli`** — `claude -p` subprocess per role session. Drives the Claude Code CLI binary directly; bills against the user's existing Claude Code login (subscription-billable today).

Pick the transport via `FAB_RUNTIME=managed-agents | sdk | sdk-k8s | claude-cli` at startup. The default is `managed-agents` to match the production behavior the rest of nanohype was built around.

## How to switch

```sh
# Default — Managed Agents
fab deploy
fab workflow feature-build '<intake-json>'

# SDK — Claude Agent SDK (API-billed)
export FAB_RUNTIME=sdk
fab workflow feature-build '<intake-json>'

# Claude CLI — subprocess (subscription-billed via your `claude` login)
export FAB_RUNTIME=claude-cli
fab workflow feature-build '<intake-json>'
```

In **sdk** and **claude-cli** modes you do not run `fab deploy`. The role's system prompt is built on the fly from `src/team/<phase>/...` + `prompts.ts` for each session.

- **SDK** uses `@anthropic-ai/claude-agent-sdk` (optional dependency — `npm install @anthropic-ai/claude-agent-sdk` if it wasn't auto-installed).
- **Claude CLI** uses the `claude` binary on your `PATH` (override via `FAB_CLAUDE_PATH`). Ensure you're logged in via `claude` or `claude setup-token` so the subprocess inherits your auth.

## Parity matrix

| Dimension                     | Managed Agents                                                                        | SDK                                                                                                            | Claude CLI                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auth source**               | `ANTHROPIC_API_KEY` (API account)                                                     | `ANTHROPIC_API_KEY` (API account); subscription support lands 2026-06-15                                       | Existing `claude` login — subscription credit today                                                                                                    |
| **Billing**                   | API per-token                                                                         | API per-token                                                                                                  | Claude Code subscription (or `--bare` + API key)                                                                                                       |
| **Sessions**                  | Anthropic-hosted, durable, listable via API. Long-running async OK.                   | In-memory `Query` objects. End when the process exits.                                                         | Subprocess per role. Session id persists across invocations via `--resume`.                                                                            |
| **Tools**                     | `agent_toolset_20260401` — managed sandbox. Cloud-mounted git resources.              | Claude Code toolset (Read / Write / Edit / Bash / Grep / Glob / WebSearch / WebFetch). Cwd-mounted filesystem. | Same Claude Code toolset as the SDK runtime. Each subprocess inherits the local filesystem.                                                            |
| **System prompt**             | Uploaded at deploy time; baked into the agent.                                        | Rebuilt per session from `buildSystemPrompt`.                                                                  | Built per session; passed as `--append-system-prompt`.                                                                                                 |
| **Session resume**            | First-class via `client.beta.sessions.*`.                                             | Reopens a fresh `query()` with `options.resume`. Cannot attach to an already-running process.                  | `claude -p --resume <session-id>` opens a fresh subprocess against the same session.                                                                   |
| **Multi-turn within session** | Send subsequent events via REST.                                                      | Stream input via the SDK's `AsyncIterable<SDKUserMessage>`.                                                    | Pipe JSON user messages to subprocess stdin (`--input-format stream-json`).                                                                            |
| **Tool confirmation**         | `always_ask` / `always_allow` per tool config.                                        | SDK permission modes (`bypassPermissions` in workflow runs).                                                   | `--permission-mode bypassPermissions` for workflows. `always_ask` mid-workflow not surfaced.                                                           |
| **Custom tool results**       | First-class events (`user.custom_tool_result`).                                       | Handled internally by the SDK's tool loop.                                                                     | Same — Claude Code handles tool results internally. Workflow code doesn't depend on the event.                                                         |
| **Memory**                    | Native Managed Agents Memory store, attached per session, mounted at `/mnt/memory/`.  | No shared memory — the memory tool or none.                                                                    | No shared memory — the memory tool or none.                                                                                                            |
| **MCP servers**               | Server registry in `src/mcp.ts`. Vault-mediated auth at session time.                 | SDK accepts `mcpServers` option directly. Auth flows through env / vaults.                                     | Fab generates a per-session JSON config file passed to `--mcp-config`. Auth flows through `MCP_GATEWAY_TOKEN` + per-server env vars.                   |
| **Threading**                 | `session_thread_id` is part of every event. Multi-thread coordinators expose threads. | SDK does not surface threading distinctly — assistant messages have `parent_tool_use_id` for subagent context. | Same as the SDK runtime — no first-class threading event surface.                                                                                      |
| **Multiagent coordinators**   | Native `multiagent: { type: "coordinator" }` (20-agent cap, 1-level deep).            | Subagents via `Agent` tool + `agents` option.                                                                  | Same as the SDK runtime; the Task / Agent tool inside `claude -p` dispatches subagents.                                                                |
| **Cost tracking**             | `span.model_request_end` per request, summed for in-session budget enforcement.       | `total_cost_usd` in result message.                                                                            | `total_cost_usd` in result message.                                                                                                                    |
| **Advisor escalation**        | Opus call via `consult_advisor` custom tool.                                          | Same tool path; SDK invokes the custom tool, fab handles the Opus call.                                        | Same — the tool is part of the role's system prompt; fab intercepts.                                                                                   |
| **Budget enforcement**        | Session interrupt on budget breach.                                                   | Same interrupt path via SDK `Query.interrupt()`.                                                               | `SIGINT` to the subprocess via `proc.kill('SIGINT')`. Claude Code emits a result before exiting.                                                       |
| **Git resources**             | Cloud-mounted via session `resources`.                                                | Operate against your local cwd.                                                                                | Same as the SDK runtime — cwd is the working filesystem. Repos mounted via `--add-dir`.                                                                |
| **Vaults**                    | First-class via `vault_ids` on session create.                                        | No vault concept; env vars supply credentials to MCP servers directly.                                         | Same as the SDK runtime — the per-session MCP config inlines the gateway bearer.                                                                       |
| **Deploy step**               | `fab deploy` uploads skills + agents to Anthropic.                                    | Not needed.                                                                                                    | Not needed.                                                                                                                                            |
| **User config inheritance**   | N/A — runs in Anthropic's sandbox.                                                    | N/A — SDK runs against the API directly.                                                                       | Subprocess inherits `~/.claude/CLAUDE.md`, hooks, user-level skills, auto-memory by default. Opt out with `FAB_CLAUDE_BARE=1`.                         |
| **Process overhead**          | None — REST calls.                                                                    | None — in-process.                                                                                             | ~1-2s subprocess startup per role. Parallel groups spawn concurrently.                                                                                 |
| **Session visibility**        | Listed via `claude.beta.sessions.list()`.                                             | Not listed anywhere external.                                                                                  | Not listed (sessions use `--no-session-persistence`); enable persistence via `FAB_CLAUDE_EXTRA_ARGS` if you want them in your `claude /resume` picker. |

## Configuration knobs

Claude CLI runtime accepts these env vars on top of the standard fab set:

| Env var                  | Default                | Effect                                                                                                                                                                           |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAB_RUNTIME=claude-cli` | unset                  | Select this runtime                                                                                                                                                              |
| `FAB_CLAUDE_BARE`        | unset                  | Pass `--bare` for a clean-slate subprocess (skip user CLAUDE.md, hooks, auto-memory, OAuth). Forces `ANTHROPIC_API_KEY` auth — subscription path is incompatible with bare mode. |
| `FAB_CLAUDE_PATH`        | `claude` (PATH lookup) | Override the binary path                                                                                                                                                         |
| `FAB_CLAUDE_EXTRA_ARGS`  | unset                  | Space-separated extra flags appended to every spawn (escape hatch for power users)                                                                                               |
| `FAB_CLAUDE_MCP_DIR`     | `os.tmpdir()`          | Directory for per-session MCP config JSON files                                                                                                                                  |

## Inference backend

The `sdk` runtime hosts the agent loop in fab's own process, so it can point the underlying Agent SDK at a non-Anthropic inference backend. `FAB_INFERENCE` selects it — orthogonal to `FAB_RUNTIME`, and read only by the `sdk` runtime. `managed-agents` always infers on Anthropic infrastructure; `claude-cli` inherits the user's Claude Code configuration.

| `FAB_INFERENCE` | Backend       | Notes                                                                                                                              |
| --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `api` (default) | Anthropic API | Billed per token against `ANTHROPIC_API_KEY`.                                                                                      |
| `bedrock`       | AWS Bedrock   | Inference served from the adopter's AWS account. The agent loop still runs in fab's process; no inference token reaches Anthropic. |

```sh
export FAB_RUNTIME=sdk
export FAB_INFERENCE=bedrock
export AWS_REGION=us-east-1
fab workflow feature-build '<intake-json>'
```

Under `bedrock` the `sdk` runtime sets `CLAUDE_CODE_USE_BEDROCK` for the Agent SDK and resolves AWS credentials through the standard chain — environment variables, shared config, IRSA, or instance role. Role model ids map to their Bedrock equivalents automatically (`claude-sonnet-4-6` → `anthropic.claude-sonnet-4-6`); a role pointed at a full Bedrock id, including a cross-region inference-profile id, passes through untouched. The AWS account must have [Bedrock model access](https://console.aws.amazon.com/bedrock/home#/modelaccess) granted for the Claude models in use.

The advisor escalation (`consult_advisor`) calls the Anthropic API directly regardless of `FAB_INFERENCE`.

## Self-hosted sandbox

By default the `managed-agents` transport runs each session's tool sandbox on Anthropic-managed containers. `FAB_SANDBOX=self-hosted` instead points the environment at sandbox workers you host — Anthropic dispatches tool-execution work to them, and agent code never leaves your infrastructure.

| `FAB_SANDBOX`     | Sandbox                      | Notes                                                                                                                                                                                                            |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud` (default) | Anthropic-managed containers | The standard managed sandbox.                                                                                                                                                                                    |
| `self-hosted`     | Workers you host             | `fab deploy` creates a `self_hosted` environment; you run the workers (the `eks-agent-platform` SandboxPool substrate). Native Memory is skipped — Anthropic does not yet support it with self-hosted sandboxes. |

`FAB_SANDBOX` is read only by the `managed-agents` transport.

## Per-session pod isolation (sdk-k8s)

`FAB_RUNTIME=sdk-k8s` runs the same `sdk` agent loop, but dispatches each role-session as its own isolated pod instead of running them all in fab's process. fab creates an `AgentSandbox` custom resource; the [eks-agent-platform](https://github.com/nanohype/eks-agent-platform) operator turns it into a hardened, single-use pod — Pod Security `restricted`, a default-deny NetworkPolicy, the dedicated tainted node pool, the Platform's tenant IRSA ServiceAccount, and an optional gVisor/Kata RuntimeClass. The pod runs `fab role-session` — the unmodified `sdk` loop — and its event stream comes back as pod-log JSON lines that fab tails and re-emits. To the workflow layer it is just another session.

Paired with `FAB_INFERENCE=bedrock` this is the regulated-enterprise end state: every role-session a separately-isolated pod, inferring on the adopter's own Bedrock, with each hardening dial available as configuration. The session is one-way — the `sdk` role-loop never needs follow-up input — so a remote session only streams events out; an interrupt deletes the CR.

`sdk-k8s` must run inside the cluster.

| Env var                 | Default | Effect                                                                                     |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `FAB_RUNTIME=sdk-k8s`   | unset   | Select this runtime                                                                        |
| `FAB_K8S_NAMESPACE`     | —       | Namespace holding the Platform CR — also where fab creates the `AgentSandbox` CRs          |
| `FAB_K8S_SESSION_IMAGE` | —       | The fab container image each session pod runs                                              |
| `FAB_K8S_PLATFORM`      | —       | The Platform the role-sessions run under; its tenant IRSA role scopes their Bedrock access |
| `FAB_K8S_RUNTIME_CLASS` | unset   | RuntimeClass for the session pod — `gvisor` or `kata` for kernel-level isolation           |

`FAB_INFERENCE` and `AWS_REGION` are forwarded onto each session pod so the in-pod loop infers against the same backend as the dispatcher.

The operator runs the session pods in the Platform's tenant namespace (`tenants-<platform>`), distinct from the namespace the `AgentSandbox` CRs live in. `deploy/rbac.yaml` grants fab's ServiceAccount both — the AgentSandbox + Platform reads in the management namespace, the pod-log reads in the tenant namespace. fab also needs to trust the cluster's API-server CA: set `NODE_EXTRA_CA_CERTS` to `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` on its pod.

**Known limitation:** a dropped pod-log stream ends the session — fab emits a synthetic `session.error` rather than resuming from an offset, so a long-running role-session is more exposed to a transient API-server disconnect than the in-process `sdk` runtime. Log-stream reconnect (`sinceTime` + event-id de-dup) is a planned hardening.

## What's the same across all transports

- **Roster.** All four transports run the same roles from `src/team/`.
- **Workflows.** `src/workflows.ts` is transport-agnostic. The same revision-loop, merge-gate, and external-reviewer calibration code runs in every mode.
- **Skill overlay.** The overlay chain (`$FAB_SKILLS_DIR` → `~/.fab/skills/` → `<cwd>/.fab/skills/` → bundled `fab/skills/`) resolves identically.
- **Gate logic.** `src/gate.ts` — pure functions, no transport coupling.
- **FACTORY_PREAMBLE.** Production standards (version-currency, evidence contract, IaC, LLM policy, production bar, merge gate) inject into every factory role's system prompt regardless of transport.

## When to pick which

| Use case                                                                                       | Pick                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Production workflows running unattended                                                        | Managed Agents                                                   |
| Long-running async sessions                                                                    | Managed Agents                                                   |
| Distributed team where session state must outlive a single machine                             | Managed Agents                                                   |
| Prototyping; iterating on role prompts                                                         | SDK                                                              |
| API-billed in-process runs with the cleanest overhead                                          | SDK                                                              |
| You want fab to bill against your Claude Pro/Max subscription instead of the API               | Claude CLI                                                       |
| Every role session should be visible / replayable in `claude /resume`                          | Claude CLI (with `FAB_CLAUDE_EXTRA_ARGS` overriding persistence) |
| You need your personal `~/.claude` config (hooks, skills, auto-memory) to flow into every role | Claude CLI                                                       |
| Air-gapped or bring-your-own-cloud (Bedrock / Vertex / Foundry) without Managed Agents         | SDK or Claude CLI                                                |
| CI/CD pipelines that work directly on the runner's filesystem                                  | SDK or Claude CLI                                                |

A common pattern: prototype with `FAB_RUNTIME=claude-cli` to iterate fast on your subscription credit, then ship workflows against Managed Agents for production.

## Known constraints

- **`--bare` is incompatible with subscription auth.** `--bare` forces `ANTHROPIC_API_KEY` and skips OAuth / keychain. If you want both bare mode AND subscription billing, that's a contradiction — pick one. Default (non-bare) flow is what carries subscription auth through.
- **Claude CLI parallelism.** A workflow with a 5-role parallel group spawns 5 `claude` subprocesses simultaneously. Memory + filehandle footprint is non-trivial but bounded by group size. Watch `ps aux | grep claude` if you're running on a small machine.
- **Subscription auth and the Agent SDK.** Anthropic ships official Agent SDK + subscription auth on 2026-06-15. When that lights up, `SdkRuntime` may pick up subscription billing automatically (no code change). `ClaudeCliRuntime` remains useful for the subprocess-isolation use case (per-role hooks, debugging via `claude /resume`) and as a fallback if the SDK + subscription path has gaps.
