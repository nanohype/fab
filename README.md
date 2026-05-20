# jaunty

Open-source reference factory for orchestrating Claude agents into a production-grade software pipeline. Clone it, configure your skills overlay, and run your factory — the system is the recipe.

A TypeScript CLI orchestrating 83 Claude agents organized around factory phases:

- **Discovery → Design → Build → Verify → Ship** — the factory pipeline.
- **Operate → Customer → Business → Staff → Lab** — runs the firm + meta work.

Naming convention: `-curator` (knowledge stewardship) vs `-engineer` (production with tools) vs process names for gate roles. See [`docs/roster.md`](docs/roster.md) for the full roster.

**Dual transports:**

- **Managed Agents** (default) — Anthropic-hosted REST API. Sessions on Anthropic infrastructure.
- **Local** — `@anthropic-ai/claude-agent-sdk` in-process. Run workflows against your local filesystem.

Pick by setting `JAUNTY_RUNTIME=managed-agents | local`. Trade-offs documented in [`docs/transports.md`](docs/transports.md).

`src/team.ts` is the barrel re-exporting per-phase modules. `src/workflows.ts` is the source of truth for built-in workflows. **`skills/` is the bundled baseline of agent instructions** — quality-check rubric, factory preamble, intake guide, 31 curator/engineer baselines — that any user can override via the [skill overlay](skills/README.md) without forking.

> **The system, customized.** Jaunty ships baseline skills that produce solid output out of the box. Your personal recipe — your sharper quality-check, your tuned voice, your taste — drops into `~/.jaunty/skills/` and overlays on top. No fork, no permission, no migration when jaunty updates.

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
jaunty vault setup            # walks through credential capture
```

## Deploy

```sh
jaunty deploy                 # creates environment, uploads skills, deploys the full roster
jaunty deploy --dry-run       # prints all API payloads without sending
jaunty status                 # show deployed agent status
jaunty agents                 # list deployed agents and their model overrides
```

## Interact

```sh
jaunty chat <role>                            # interactive REPL — e.g., `jaunty chat product`
jaunty send <session-id> <message>            # one-shot message + stream
jaunty workflow <name> "<intake-json or goal>"
jaunty stream <session-id>                    # tail an in-flight session
jaunty standup                                # cross-team rollup via chief-of-staff
```

## Local transport

```sh
export JAUNTY_RUNTIME=local
# Skip `jaunty deploy` — local mode builds the role system prompt per-session.
# Install the Agent SDK if it's not already present (it's an optional dependency):
npm install @anthropic-ai/claude-agent-sdk
jaunty workflow feature-build '<intake-json>'
```

## Claude CLI transport (subscription-billable)

If you want jaunty to bill against your existing Claude Code subscription instead of the API, drive the `claude` CLI as a subprocess per role session:

```sh
# Ensure your Claude Code login is active
claude setup-token

# Switch transport
export JAUNTY_RUNTIME=claude-cli
jaunty workflow feature-build '<intake-json>'
```

The subprocess inherits `~/.claude/CLAUDE.md`, hooks, user-level skills, and auto-memory by default. Set `JAUNTY_CLAUDE_BARE=1` for clean-slate runs (note: bare mode forces `ANTHROPIC_API_KEY` auth and disables subscription billing). Full parity matrix in [`docs/transports.md`](docs/transports.md).

`jaunty workflows` lists the built-in workflows; each has its own role sequence and (for code-producing workflows) a merge-gate finalizer. See `src/workflows.ts` for the full catalog.

## Configuration

```sh
jaunty memory                                 # company memory (MCP-backed)
jaunty journal                                # per-agent journals
jaunty repo add https://github.com/org/repo --branch main --token <pat>
jaunty model set <role> <model-id>
jaunty budget set <usd>                       # per-session advisor budget
```

## Sprint mode

```sh
jaunty sprint start --cadence weekly
jaunty sprint add "Implement search API" --role engineering
jaunty sprint standup
jaunty sprint status
jaunty sprint end
```

## Skills

Each agent is loaded with a domain skill derived from nanohype brief templates:

```sh
jaunty skills show <role>
jaunty skills upload --all
```

## Inspection / operations

```sh
jaunty sessions                               # list sessions
jaunty threads <session-id>                   # list threads
jaunty events <session-id>                    # raw SSE event stream
jaunty usage                                  # token + cost rollups
jaunty perf                                   # latency + reliability stats
jaunty export <session-id> > transcript.json
jaunty recover <session-id>                   # resume an interrupted stream
jaunty adopt <agent-id>                       # adopt an externally-created agent into state
```

## Intake contract

The coordinator accepts structured JSON conforming to `jaunty.schema.json`. Any external agent can read the schema and construct a valid first message:

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
