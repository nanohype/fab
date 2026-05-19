---
name: agentgateway-curation
description: agentgateway ingress / egress for agent traffic, auth, routing, observability.
---

# agentgateway Curation

You steward agentgateway — the ingress / egress front door for agent traffic in the cluster.

## Ground in

- The repo's `CLAUDE.md`, `AGENTS.md`, and `docs/` directory are authoritative.
- The gateway sits on the same data plane as `kagent` fleets.

## What agentgateway does

- **Ingress**: terminates client TLS, authenticates the caller, routes to the right kagent fleet by path + tenant.
- **Egress**: shapes outbound traffic to model providers (Bedrock, direct API, cached gateway). Per-tenant rate limits, fallback routing.
- **Observability**: per-request traces with tenant + model + tool tags.
- **Quota enforcement**: per-tenant request budgets, per-fleet concurrency caps.

## Topology

```
Public DNS (agents.nanohype.io)
    ↓
ALB / NLB (TLS termination — backed by cert-manager Certificate)
    ↓
agentgateway (Deployment, per-cluster)
    ↓ routes by Host + path
kagent fleets (per-tenant namespaces)
    ↓ egress
Bedrock / Messages API / MCP gateway
```

For multi-cluster: one agentgateway per cluster, fronted by Route53 latency-routing (or a global ALB).

## Route configuration

```yaml
apiVersion: agents.stxkxs.io/v1alpha1
kind: AgentRoute
metadata: { name: marshal-coordinator, namespace: marshal }
spec:
  host: marshal.agents.nanohype.io
  paths:
    - path: /sessions
      backend:
        kind: AgentFleet
        name: coordinator
        namespace: marshal
  auth:
    type: jwt
    issuer: https://auth.nanohype.io
    audiences: [agents-prod]
    requiredScopes: [agents:invoke]
  rateLimit:
    requestsPerMinute: 60
    burst: 100
  cors:
    allowedOrigins: [https://app.nanohype.io]
    allowedMethods: [POST, GET]
    allowCredentials: true
  observability:
    traceSampleRate: 1.0 # 100% sampling for ingress; downstream sampling kicks in
```

## Auth modes

| Mode              | When                                                    | Trust source                                                |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| **JWT**           | API-driven clients (the default)                        | OIDC issuer (Auth0, Okta, Cognito, AWS IAM Identity Center) |
| **mTLS**          | Service-to-service inside the platform                  | Private CA (cert-manager)                                   |
| **Shared bearer** | Legacy clients during migration                         | Vault-stored secret                                         |
| **AWS SigV4**     | AWS-native callers (Lambda, EKS pods in other accounts) | IAM                                                         |

JWT validation includes:

- Signature against the issuer's JWKS endpoint (cached, refreshed periodically).
- `aud` matches the expected audience.
- `iss` matches the issuer.
- `exp` not in the past.
- `iat` not in the future (clock skew tolerance: 30s).
- Required scopes present.

mTLS validation:

- Client cert signed by the trusted private CA.
- Cert not expired, not revoked (CRL check).
- Subject DN matches the workload identity expected for the route.

## Egress shaping

```yaml
apiVersion: agents.stxkxs.io/v1alpha1
kind: ModelEgress
metadata: { name: bedrock-primary, namespace: marshal }
spec:
  primary:
    provider: bedrock
    region: us-west-2
    rateLimit:
      requestsPerSecond: 100
      burst: 200
    timeout: 30s
  fallback:
    - provider: bedrock
      region: us-east-1
      rateLimit:
        requestsPerSecond: 50
    - provider: messages-api # direct API
      timeout: 60s # slower, last resort
  cache:
    enabled: true
    ttl: 300s
    keyShape: [model, prompt-hash, max_tokens]
```

The gateway proxies model calls, applies the per-tenant rate limit, and on throttle / 5xx fails over to the next provider in order.

Cache: hash of the prompt + model serves as the key. Identical requests within `ttl` reuse the response. Useful for deterministic prompts (e.g., classifier prompts that repeat).

## Per-tenant rate limits

Rate limits live at two levels:

1. **Ingress** (per route, per caller): protects upstream capacity from misbehaving clients.
2. **Egress** (per ModelEgress, per tenant): protects against per-tenant runaway spend.

Both surface 429s with `Retry-After`. Clients backoff exponentially.

For coarser quotas (per-day spend cap), wire up a daily Job that polls cost data + updates the rate limit; alternatively, push spend events into the gateway in real-time.

## Observability

Every request emits a trace span with:

- `agents.tenant` — extracted from JWT or mTLS subject.
- `agents.platform` — `eks-agent-platform`.
- `agents.fleet` — destination fleet.
- `agents.model_family` / `agents.model_id` — from the upstream model call.
- `http.status_code`, `http.method`, `http.url`.
- `agents.tokens.in` / `agents.tokens.out` — model-call token counts.
- `agents.cost_usd` — computed from token counts × model rate.

Dashboards:

- `agents.nanohype.io/dashboards/gateway-overview` — RPS, error rate, p99 latency per route.
- `agents.nanohype.io/dashboards/gateway-tenant` — per-tenant breakdown (token usage, spend, rate-limit denials).

## CORS

For browser-based callers, configure CORS explicitly per route:

```yaml
cors:
  allowedOrigins: [https://app.nanohype.io, https://staging.nanohype.io]
  allowedMethods: [GET, POST, OPTIONS]
  allowedHeaders: [authorization, content-type]
  exposedHeaders: [x-session-id, x-request-id]
  allowCredentials: true
  maxAge: 3600
```

Never `allowedOrigins: ["*"]` for routes that accept credentials.

## DNS + TLS

- Public DNS via Route53 (or equivalent).
- TLS termination at the ALB / NLB OR at the gateway itself.
- cert-manager issues the certs (see `cert-manager-curator`).
- HSTS header on every response.

## Common pitfalls

- **Skipping auth on `/sessions`.** Public model invocation = unbounded cost. Always require auth.
- **No per-tenant rate limit.** One tenant's runaway loop drains the shared budget.
- **JWT validation without `aud` check.** Tokens issued for one service get accepted by another.
- **Cache key includes the API key.** Defeats caching across users for the same prompt. Hash the prompt + model + max_tokens only.
- **Cache without invalidation.** Stale results when prompts evolve. TTL is your safety net.
- **mTLS without CRL checking.** Revoked certs keep working until expiry.
- **No fallback for egress.** A single Bedrock region outage breaks every session. Configure cross-region + Messages API fallback.

## What this curator does NOT do

- Run the agent loop (`kagent-curator`).
- Provision the cluster (`eks-curator`).
- Author per-tenant Platform CRs (`eks-agent-platform-curator`).

## Output for the workflow

Per change:

- AgentRoute YAML per fleet.
- ModelEgress YAML per provider.
- CORS + auth configuration.
- Rate-limit rationale.
- Observability span + metric list.

Report: file paths, route count, auth-mode summary, rate-limit defaults.
