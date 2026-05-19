# Transports

Fab runs the same role definitions + workflow code against three transports:

- **`managed-agents`** (default) — Anthropic-hosted REST API. Sessions and sandboxes live on Anthropic infrastructure.
- **`local`** — `@anthropic-ai/claude-agent-sdk` in-process. Sessions run in your local process; tools touch your cwd.
- **`claude-cli`** — `claude -p` subprocess per role session. Drives the Claude Code CLI binary directly; bills against the user's existing Claude Code login (subscription-billable today).

Pick the transport via `FAB_RUNTIME=managed-agents | local | claude-cli` at startup. The default is `managed-agents` to match the production behavior the rest of nanohype was built around.

## How to switch

```sh
# Default — Managed Agents
fab deploy
fab workflow feature-build '<intake-json>'

# Local — Claude Agent SDK (API-billed)
export FAB_RUNTIME=local
fab workflow feature-build '<intake-json>'

# Claude CLI — subprocess (subscription-billed via your `claude` login)
export FAB_RUNTIME=claude-cli
fab workflow feature-build '<intake-json>'
```

In **local** and **claude-cli** modes you do not run `fab deploy`. The role's system prompt is built on the fly from `src/team/<phase>/...` + `prompts.ts` for each session.

- **Local** uses `@anthropic-ai/claude-agent-sdk` (optional dependency — `npm install @anthropic-ai/claude-agent-sdk` if it wasn't auto-installed).
- **Claude CLI** uses the `claude` binary on your `PATH` (override via `FAB_CLAUDE_PATH`). Ensure you're logged in via `claude` or `claude setup-token` so the subprocess inherits your auth.

## Parity matrix

| Dimension                     | Managed Agents                                                                        | Local (Agent SDK)                                                                                              | Claude CLI                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auth source**               | `ANTHROPIC_API_KEY` (API account)                                                     | `ANTHROPIC_API_KEY` (API account); subscription support lands 2026-06-15                                       | Existing `claude` login — subscription credit today                                                                                                    |
| **Billing**                   | API per-token                                                                         | API per-token                                                                                                  | Claude Code subscription (or `--bare` + API key)                                                                                                       |
| **Sessions**                  | Anthropic-hosted, durable, listable via API. Long-running async OK.                   | In-memory `Query` objects. End when the process exits.                                                         | Subprocess per role. Session id persists across invocations via `--resume`.                                                                            |
| **Tools**                     | `agent_toolset_20260401` — managed sandbox. Cloud-mounted git resources.              | Claude Code toolset (Read / Write / Edit / Bash / Grep / Glob / WebSearch / WebFetch). Cwd-mounted filesystem. | Same Claude Code toolset as Local. Each subprocess inherits the local filesystem.                                                                      |
| **System prompt**             | Uploaded at deploy time; baked into the agent.                                        | Rebuilt per session from `buildSystemPrompt`.                                                                  | Built per session; passed as `--append-system-prompt`.                                                                                                 |
| **Session resume**            | First-class via `client.beta.sessions.*`.                                             | Reopens a fresh `query()` with `options.resume`. Cannot attach to an already-running process.                  | `claude -p --resume <session-id>` opens a fresh subprocess against the same session.                                                                   |
| **Multi-turn within session** | Send subsequent events via REST.                                                      | Stream input via the SDK's `AsyncIterable<SDKUserMessage>`.                                                    | Pipe JSON user messages to subprocess stdin (`--input-format stream-json`).                                                                            |
| **Tool confirmation**         | `always_ask` / `always_allow` per tool config.                                        | SDK permission modes (`bypassPermissions` in workflow runs).                                                   | `--permission-mode bypassPermissions` for workflows. `always_ask` mid-workflow not surfaced.                                                           |
| **Custom tool results**       | First-class events (`user.custom_tool_result`).                                       | Handled internally by the SDK's tool loop.                                                                     | Same — Claude Code handles tool results internally. Workflow code doesn't depend on the event.                                                         |
| **Memory**                    | Memory MCP server on the gateway. Per-role `agentId`.                                 | Same MCP server URL via SDK `mcpServers` option.                                                               | Same MCP server URL via `--mcp-config <file>`. Gateway bearer flows in via the config's `headers.Authorization`.                                       |
| **MCP servers**               | Server registry in `src/mcp.ts`. Vault-mediated auth at session time.                 | SDK accepts `mcpServers` option directly. Auth flows through env / vaults.                                     | Fab generates a per-session JSON config file passed to `--mcp-config`. Auth flows through `MCP_GATEWAY_TOKEN` + per-server env vars.                   |
| **Threading**                 | `session_thread_id` is part of every event. Multi-thread coordinators expose threads. | SDK does not surface threading distinctly — assistant messages have `parent_tool_use_id` for subagent context. | Same as Local — no first-class threading event surface.                                                                                                |
| **Multiagent coordinators**   | Native `multiagent: { type: "coordinator" }` (20-agent cap, 1-level deep).            | Subagents via `Agent` tool + `agents` option.                                                                  | Same as Local; the Task / Agent tool inside `claude -p` dispatches subagents.                                                                          |
| **Cost tracking**             | `span.model_request_end` per request; uploaded to dashboard.                          | `total_cost_usd` in result message.                                                                            | `total_cost_usd` in result message. Tagged `source: 'claude-cli'`.                                                                                     |
| **Advisor escalation**        | Opus call via `consult_advisor` custom tool.                                          | Same tool path; SDK invokes the custom tool, fab handles the Opus call.                                        | Same — the tool is part of the role's system prompt; fab intercepts.                                                                                   |
| **Budget enforcement**        | Session interrupt on budget breach.                                                   | Same interrupt path via SDK `Query.interrupt()`.                                                               | `SIGINT` to the subprocess via `proc.kill('SIGINT')`. Claude Code emits a result before exiting.                                                       |
| **Git resources**             | Cloud-mounted via session `resources`.                                                | Operate against your local cwd.                                                                                | Same as Local — cwd is the working filesystem. Repos mounted via `--add-dir`.                                                                          |
| **Vaults**                    | First-class via `vault_ids` on session create.                                        | No vault concept; env vars supply credentials to MCP servers directly.                                         | Same as Local — the per-session MCP config inlines the gateway bearer.                                                                                 |
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

## What's the same across all three

- **Roster.** All three transports run the 83 roles from `src/team/`.
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
| Local prototyping; iterating on role prompts                                                   | Local                                                            |
| API-billed local-mode with the cleanest subprocess overhead                                    | Local                                                            |
| You want fab to bill against your Claude Pro/Max subscription instead of the API               | Claude CLI                                                       |
| Every role session should be visible / replayable in `claude /resume`                          | Claude CLI (with `FAB_CLAUDE_EXTRA_ARGS` overriding persistence) |
| You need your personal `~/.claude` config (hooks, skills, auto-memory) to flow into every role | Claude CLI                                                       |
| Air-gapped or bring-your-own-cloud (Bedrock / Vertex / Foundry) without Managed Agents         | Local or Claude CLI                                              |
| CI/CD pipelines that work directly on the runner's filesystem                                  | Local or Claude CLI                                              |

A common pattern: prototype with `FAB_RUNTIME=claude-cli` to iterate fast on your subscription credit, then ship workflows against Managed Agents for production.

## Known constraints

- **`--bare` is incompatible with subscription auth.** `--bare` forces `ANTHROPIC_API_KEY` and skips OAuth / keychain. If you want both bare mode AND subscription billing, that's a contradiction — pick one. Default (non-bare) flow is what carries subscription auth through.
- **Claude CLI parallelism.** A workflow with a 5-role parallel group spawns 5 `claude` subprocesses simultaneously. Memory + filehandle footprint is non-trivial but bounded by group size. Watch `ps aux | grep claude` if you're running on a small machine.
- **Cost dashboard granularity.** Managed Agents emits a cost event per model request (`span.model_request_end`). Local + Claude CLI emit one cost event per role session (the result message). The dashboard aggregates them differently — per-session bars vs per-request scatter.
- **Subscription auth and the Agent SDK.** Anthropic ships official Agent SDK + subscription auth on 2026-06-15. When that lights up, `LocalRuntime` may pick up subscription billing automatically (no code change). `ClaudeCliRuntime` remains useful for the subprocess-isolation use case (per-role hooks, debugging via `claude /resume`) and as a fallback if the SDK + subscription path has gaps.
