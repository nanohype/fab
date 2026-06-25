# fab

Open-source reference factory for orchestrating Claude agents into a production-grade software pipeline. Clone it, configure your skills overlay, and run your factory — the system is the recipe.

A TypeScript CLI orchestrating 84 Claude agents organized around factory phases:

- **Discovery → Design → Build → Verify → Ship** — the factory pipeline.
- **Operate → Customer → Business → Staff → Lab** — runs the firm + meta work.

Naming convention: `-curator` (knowledge stewardship) vs `-engineer` (production with tools) vs process names for gate roles. See [`docs/roster.md`](docs/roster.md) for the full roster.

**Four transports, one env var.** Pick where Claude executes with `FAB_RUNTIME`:

- **`managed-agents`** (default) — Anthropic-hosted REST API. Sessions on Anthropic infrastructure.
- **`sdk`** — `@anthropic-ai/claude-agent-sdk` running the agent loop in fab's own process.
- **`sdk-k8s`** — the `sdk` loop, each role-session dispatched as its own isolated pod (see [Kubernetes-dispatched sessions](#kubernetes-dispatched-sessions-sdk-k8s)).
- **`claude-cli`** — `claude -p` per role-session, billed against your Claude subscription.

Trade-offs documented in [`docs/transports.md`](docs/transports.md).

`src/team.ts` is the barrel re-exporting per-phase modules. `src/workflows.ts` is the source of truth for built-in workflows. **`skills/` is the bundled baseline of agent instructions** — quality-check rubric, factory preamble, intake guide, 31 curator/engineer baselines — that any user can override via the [skill overlay](skills/README.md) without forking.

> **The system, customized.** Fab ships baseline skills that produce solid output out of the box. Your personal recipe — your sharper quality-check, your tuned voice, your taste — drops into `~/.fab/skills/` and overlays on top. No fork, no permission, no migration when fab updates.

## Setup

```sh
npm install
npm run build
export ANTHROPIC_API_KEY=sk-ant-...
```

The switchboard services (HubSpot, Drive, Calendar, Analytics, CSE, Stripe) route through an HTTP MCP gateway you operate — one endpoint fronting those services behind a shared bearer token. fab doesn't ship the gateway; if you run one, point fab at it:

```sh
export MCP_GATEWAY_BASE_URL=https://<your-gateway-host>
export MCP_GATEWAY_TOKEN=<shared-bearer-token>
```

Without these, the switchboard services are skipped. The third-party servers (GitHub, Linear, Slack, Notion, Sentry, Figma, Hunter) hit their public endpoints directly and need no gateway. The vault holds per-agent credentials that the gateway injects at session creation time:

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

Set `FAB_SANDBOX=self-hosted` before `fab deploy` to run the agent tool sandbox on infrastructure you host — see [`docs/transports.md`](docs/transports.md#self-hosted-sandbox).

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

Set `FAB_INFERENCE=bedrock` to serve inference from AWS Bedrock instead of the Anthropic API — see [`docs/transports.md`](docs/transports.md#inference-backend).

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

## Running in a cluster

A `Dockerfile` and example manifests under `deploy/` run fab workflows as Kubernetes Jobs. The in-cluster path uses the `sdk` runtime with inference served from AWS Bedrock — the agent loop runs in the pod, and Bedrock auth comes from an IRSA-bound ServiceAccount rather than a static key.

```sh
# Build and push the image
docker build -t <registry>/fab:<tag> .
docker push <registry>/fab:<tag>

# Create the namespace + IRSA ServiceAccount (set the role ARN first)
kubectl apply -f deploy/serviceaccount.yaml

# Run a workflow as a Job (set the image, workflow, and intake JSON)
kubectl apply -f deploy/job.yaml
```

The IRSA role is an AWS resource: provision it in your cloud-infra layer with `bedrock:InvokeModel` permission on the Claude models you use, and put its ARN in `deploy/serviceaccount.yaml`. See [`docs/transports.md`](docs/transports.md#inference-backend) for the inference backend.

That path runs every role-session in one fab pod. For per-session pod isolation, see below.

## Kubernetes-dispatched sessions (sdk-k8s)

`FAB_RUNTIME=sdk-k8s` runs the same `sdk` agent loop but dispatches each role-session as its own isolated pod. fab creates an `AgentSandbox` resource; the [eks-agent-platform](https://github.com/nanohype/eks-agent-platform) operator turns it into a hardened, single-use pod — Pod Security `restricted`, default-deny networking, the tainted sandbox node pool, the Platform's tenant IRSA role, and an optional gVisor/Kata RuntimeClass. Paired with `FAB_INFERENCE=bedrock` it is the regulated-enterprise end state: every role-session a separately-isolated pod, inferring on your own Bedrock.

It must run inside the cluster. Apply `deploy/rbac.yaml` for the AgentSandbox + pod-log permissions, set `NODE_EXTRA_CA_CERTS` to the cluster CA on fab's pod, and configure the dispatch target:

```sh
export FAB_RUNTIME=sdk-k8s
export FAB_K8S_NAMESPACE=eks-agent-platform   # namespace holding the Platform CR
export FAB_K8S_SESSION_IMAGE=<registry>/fab:<tag>
export FAB_K8S_PLATFORM=<platform-name>
export FAB_K8S_RUNTIME_CLASS=gvisor           # optional isolation dial
```

Full details in [`docs/transports.md`](docs/transports.md#per-session-pod-isolation-sdk-k8s).

Set `FAB_OPERATOR=<human>` to bind each dispatched session's AWS and Kubernetes actions to a named human (STS `SourceIdentity` + apiserver impersonation), instead of the anonymous tenant IRSA role — see [`docs/attribution.md`](docs/attribution.md).

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
