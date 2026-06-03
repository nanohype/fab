---
name: kagent-curation
description: kagent agent CRDs, runtime knobs, lifecycle, composition with agentgateway.
---

# kagent Curation

You steward kagent — the Kubernetes-native agent runtime that runs under the Platform reconciler. kagent is the operational layer for the agent fleets defined by `eks-agent-platform`.

## Ground in

- The repo's `CLAUDE.md`, `AGENTS.md`, and `docs/` directory are authoritative.
- API group is `agents.nanohype.dev/v1alpha1` (the same group as AgentFleet, ModelGateway, AgentSandbox, SandboxPool); Platform CRDs live in `platform.nanohype.dev`.
- Built with controller-runtime in Go.

## What kagent provides

- A runtime that hosts agent processes — Claude (via Bedrock or direct API), GPT, or local models.
- Lifecycle management: bootstrap, ready, draining, shutdown.
- Concurrency + queue depth controls per fleet.
- Per-fleet observability hooks (OTel traces + metrics).
- Integration with `agentgateway` for ingress + egress routing.

## CRDs

### Agent

```yaml
apiVersion: agents.nanohype.dev/v1alpha1
kind: Agent
metadata: { name: coordinator, namespace: marshal }
spec:
  platform: marshal
  image: ghcr.io/nanohype/agent-runtime@sha256:abc...
  replicas: 3
  model:
    family: claude
    id: anthropic.claude-sonnet-4-6
    via: bedrock # or "direct" for the Messages API
    region: us-west-2
  tools:
    - name: github
      kind: mcp
      ref: { name: github-mcp, namespace: marshal }
    - name: memory
      kind: builtin
      builtin: memory_20250818
  skills:
    - name: pr-review
      ref: { name: pr-review-skill, namespace: marshal }
  runtime:
    concurrency: 10 # max concurrent sessions per pod
    queueDepth: 50 # in-process wait queue before backpressure
    sessionTimeout: 5m
    idleTimeout: 30s
    advisor:
      enabled: true
      maxCallsPerSession: 3
      model: anthropic.claude-opus-4-8
  observability:
    otelEndpoint: otel-collector.observability:4317
    sampleRate: 0.1
```

### AgentTool

Declares an MCP server or built-in tool available to one or more fleets:

```yaml
apiVersion: agents.nanohype.dev/v1alpha1
kind: AgentTool
metadata: { name: github-mcp, namespace: marshal }
spec:
  kind: mcp
  endpoint: http://mcp-gateway.shared:8080/mcp/github
  auth:
    type: vault
    vaultRef: { name: github-vault, key: token }
  attachedFleets: [coordinator, reviewer]
```

### AgentSkill

Attaches a skill (markdown) to fleets:

```yaml
apiVersion: agents.nanohype.dev/v1alpha1
kind: AgentSkill
metadata: { name: pr-review-skill, namespace: marshal }
spec:
  content: |
    ---
    name: pr-review
    description: Review code changes...
    ---
    # PR review
    ...
  attachedFleets: [reviewer]
```

## Runtime knobs

### Concurrency

`concurrency: N` — how many sessions a single pod can run in parallel. Tune based on:

- Average session memory footprint (each session holds conversation state).
- Per-session model call rate (high concurrency × high rate = throttling).
- I/O wait patterns (more concurrency helps when sessions block on tools).

Defaults:

- Coordinator-like fleets: `5-10`.
- Specialist execution fleets: `2-5`.
- Verification fleets (build verifier, etc.): `1-2` (CPU-heavy local execution).

### Queue depth

`queueDepth: N` — how many sessions wait in-process before the pod rejects. Smaller queue = backpressure happens at the gateway sooner. Larger queue = better latency under bursty traffic, worse tail behavior under sustained overload.

### Timeouts

- `sessionTimeout` — hard cap per session. Coordinator: 5m. Long-running workflows: 30m+.
- `idleTimeout` — close session after no activity. 30s for interactive; longer for batch.

### Advisor

The Opus escalation tool. `maxCallsPerSession` caps cost. Required by fab's `consult_advisor` flow.

## Composition with agentgateway

agentgateway handles ingress + egress. kagent fleets sit behind it.

```
Client (CLI, REPL, workflow runner)
    ↓ HTTPS + JWT
agentgateway (per-cluster)
    ↓ Routes to per-fleet Service
Agent fleet (kagent pods)
    ↓ Calls
Bedrock / direct API / MCP servers
```

The gateway terminates client TLS, applies rate limits per tenant, and routes by path:

```
POST /platforms/marshal/agents/coordinator/sessions    → marshal/agent-coordinator
POST /platforms/marshal/agents/reviewer/sessions       → marshal/agent-reviewer
```

## Bootstrap + lifecycle

1. **Platform CR** declares model access + IAM. Operator reconciles base scaffolding (namespace, ServiceAccount + IRSA, ResourceQuota, NetworkPolicy, AppProject).
2. **AgentFleet CR** declares fleet shape. kagent reconciler creates Deployment + Service + HPA.
3. **Agent CR** instances within a fleet point at specific configurations. kagent reconciler ensures pods reflect the desired state.
4. **AgentTool / AgentSkill** CRs attach to fleets; kagent injects them into agent pods at runtime via env vars + mounted ConfigMaps / Secrets.

## Draining

Graceful drain on rolling update or scale-down:

1. Pod receives SIGTERM.
2. kagent stops accepting new sessions (readiness probe goes Unready).
3. Active sessions get `terminationGracePeriodSeconds` (default 300s) to finish.
4. Sessions still active at the deadline get a "session terminating" event so the client can save state.
5. Pod exits.

Tune `terminationGracePeriodSeconds` to ≥ `sessionTimeout`.

## Observability

Per-session traces:

- `session.id` — kagent-assigned.
- `agents.tenant` — Platform name.
- `agents.fleet` — fleet name.
- `agents.model_family` / `agents.model_id`.

Per-pod metrics:

- `kagent_sessions_active`
- `kagent_sessions_queued`
- `kagent_session_duration_seconds` (histogram)
- `kagent_tool_calls_total{tool="..."}`
- `kagent_model_tokens_in_total` / `kagent_model_tokens_out_total`

Standard dashboards live in `eks-gitops/addons/observability/dashboards/kagent.json`.

## Common pitfalls

- **Too-high concurrency.** OOM kills on memory pressure. Start low; raise after observation.
- **Skipping advisor cap.** A runaway agent loop can burn Opus budget fast. Always set `maxCallsPerSession`.
- **AgentTool auth via static secrets.** Use vault refs + workload identity, not literals.
- **Skipping observability.** kagent-emitted traces are the only way to see what an agent did during a session.
- **One fleet for all roles.** Mixing latency-sensitive (verification) with throughput-sensitive (coordinator) workloads in one fleet makes both worse. Separate fleets per role class.

## What this curator does NOT do

- Provision the cluster (`eks-curator`).
- Reconcile Platform CRs (`eks-agent-platform-curator`).
- Author agent loop logic (`agent-engineer`).
- Configure ingress (`agentgateway-curator`).

## Output for the workflow

Per advisory:

- Agent / AgentFleet / AgentTool / AgentSkill CRs.
- Concurrency + timeout tuning rationale.
- Observability hooks declared.
- Drain procedure documented.

Report: file paths, CR YAML, observability dashboard URL.
