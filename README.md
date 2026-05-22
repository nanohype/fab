# fab

Open-source reference factory for orchestrating Claude agents into a production-grade software pipeline. Clone it, configure your skills overlay, and run your factory — the system is the recipe.

A TypeScript CLI orchestrating 83 Claude agents organized around factory phases:

- **Discovery → Design → Build → Verify → Ship** — the factory pipeline.
- **Operate → Customer → Business → Staff → Lab** — runs the firm + meta work.

Naming convention: `-curator` (knowledge stewardship) vs `-engineer` (production with tools) vs process names for gate roles. See [`docs/roster.md`](docs/roster.md) for the full roster.

**Dual transports:**

- **Managed Agents** (default) — Anthropic-hosted REST API. Sessions on Anthropic infrastructure.
- **SDK** — `@anthropic-ai/claude-agent-sdk` running the agent loop in fab's own process.

Pick by setting `FAB_RUNTIME=managed-agents | sdk`. Trade-offs documented in [`docs/transports.md`](docs/transports.md).

`src/team.ts` is the barrel re-exporting per-phase modules. `src/workflows.ts` is the source of truth for built-in workflows. **`skills/` is the bundled baseline of agent instructions** — quality-check rubric, factory preamble, intake guide, 31 curator/engineer baselines — that any user can override via the [skill overlay](skills/README.md) without forking.

> **The system, customized.** Fab ships baseline skills that produce solid output out of the box. Your personal recipe — your sharper quality-check, your tuned voice, your taste — drops into `~/.fab/skills/` and overlays on top. No fork, no permission, no migration when fab updates.

## Setup

```sh
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...
```

If you'll use any switchboard service (HubSpot, Drive, Calendar, Analytics, CSE, Stripe), the semantic memory server, or the cost dashboard, also point at the `mcp-gateway` deployment in protohype:

```sh
export MCP_GATEWAY_BASE_URL=https://<api-id>.execute-api.us-west-2.amazonaws.com
export MCP_GATEWAY_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id /mcp-gateway/gateway-bearer-token \
  --query SecretString --output text)
```

The vault holds per-agent credentials that the gateway injects at session creation time:

```sh
fab vault setup            # walks through credential capture
```

## Deploy

```sh
fab deploy                 # creates environment, uploads skills, deploys the full roster
fab deploy --dry-run       # prints all API payloads without sending
fab status                 # show deployed agent status
fab agents                 # list deployed agents and their model overrides
```

## Interact

```sh
fab chat <role>                            # interactive REPL — e.g., `fab chat product`
fab send <session-id> <message>            # one-shot message + stream
fab workflow <name> "<intake-json or goal>"
fab stream <session-id>                    # tail an in-flight session
fab standup                                # cross-team rollup via chief-of-staff
```

## SDK transport

```sh
export FAB_RUNTIME=sdk
# Skip `fab deploy` — the sdk runtime builds the role system prompt per-session.
# Install the Agent SDK if it's not already present (it's an optional dependency):
npm install @anthropic-ai/claude-agent-sdk
fab workflow feature-build '<intake-json>'
```

## Claude CLI transport (subscription-billable)

If you want fab to bill against your existing Claude Code subscription instead of the API, drive the `claude` CLI as a subprocess per role session:

```sh
# Ensure your Claude Code login is active
claude setup-token

# Switch transport
export FAB_RUNTIME=claude-cli
fab workflow feature-build '<intake-json>'
```

The subprocess inherits `~/.claude/CLAUDE.md`, hooks, user-level skills, and auto-memory by default. Set `FAB_CLAUDE_BARE=1` for clean-slate runs (note: bare mode forces `ANTHROPIC_API_KEY` auth and disables subscription billing). Full parity matrix in [`docs/transports.md`](docs/transports.md).

`fab workflows` lists the built-in workflows; each has its own role sequence and (for code-producing workflows) a merge-gate finalizer. See `src/workflows.ts` for the full catalog.

## Configuration

```sh
fab memory                                 # company memory (MCP-backed)
fab journal                                # per-agent journals
fab repo add https://github.com/org/repo --branch main --token <pat>
fab model set <role> <model-id>
fab budget set <usd>                       # per-session advisor budget
```

## Sprint mode

```sh
fab sprint start --cadence weekly
fab sprint add "Implement search API" --role engineering
fab sprint standup
fab sprint status
fab sprint end
```

## Skills

Each agent is loaded with a domain skill derived from nanohype brief templates:

```sh
fab skills show <role>
fab skills upload --all
```

## Inspection / operations

```sh
fab sessions                               # list sessions
fab threads <session-id>                   # list threads
fab events <session-id>                    # raw SSE event stream
fab usage                                  # token + cost rollups
fab perf                                   # latency + reliability stats
fab export <session-id> > transcript.json
fab recover <session-id>                   # resume an interrupted stream
fab adopt <agent-id>                       # adopt an externally-created agent into state
```

## Intake contract

The coordinator accepts structured JSON conforming to `fab.schema.json`. Any external agent can read the schema and construct a valid first message:

```json
{
  "goal": "Build a RAG-powered search for enterprise docs",
  "workflow": "feature-build",
  "constraints": { "timeline": "4 weeks", "deploy_target": "aws", "language": "typescript" },
  "context": { "client": "Acme Corp", "existing_systems": ["PostgreSQL", "S3"] }
}
```

See `docs/INTAKE_GUIDE.md` for the brief authoring rubric (section anatomy, anti-patterns, examples, pre-flight checklist) — the `intake-analyst` role applies this guide to every incoming brief.

## Development

```sh
npm run build                                  # tsc
npm test                                       # vitest
npm run lint                                   # typecheck + eslint
npm run format:check                           # prettier
```

Node ≥ 24. TypeScript strict mode, ESM, Node16 module resolution. Tests live in `__tests__/` and are type-checked via `tsconfig.test.json`.
