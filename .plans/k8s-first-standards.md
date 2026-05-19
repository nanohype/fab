# K8s-first factory standards

Tactical plan for Phase 2.1 + 2.2 of master plan (`/Users/bs/.claude/plans/so-i-want-to-snazzy-sun.md`).

Status: NOT STARTED.

## Files to edit

- `src/standards.ts` — primary
- `src/prompts.ts` — if any IaC-target language flows through there
- `CLAUDE.md` — production-standards summary

## `src/standards.ts` changes

### `IAC_BY_TARGET`

Current shape (from fab CLAUDE.md):

> aws→AWS CDK (TS/Python/Go/Java/C#), gcp→Pulumi (TS/Python/Go/C#), k8s→Helm+Kustomize, fly→fly.toml, vercel→vercel.json, cloudflare→Wrangler, serverless→SAM/Serverless. Terraform is NOT the default on AWS.

New shape:

```
default:    k8s (Helm chart in <app>/chart/ + ApplicationSet entry into nanohype/eks-gitops or aks-gitops + Platform CR on eks-agent-platform)
substrate:  OpenTofu/Terragrunt against nanohype/landing-zone (slow-moving cloud infra)
escape hatches (opt-in, require explicit constraint in intake brief):
  aws-lambda:    AWS CDK (TS/Python/Go) — Lambda / edge / serverless cases only
  fly:           fly.toml — edge-co-located workloads
  vercel:        vercel.json — static + edge functions
  cloudflare:    Wrangler — edge workers / KV / D1
```

### New constant: `PLATFORM_TENANT_CONTRACT`

Defines the shape any factory-produced k8s app must take:

- Helm chart in `<app>/chart/` (Chart.yaml, values.yaml, values-{dev,staging,production}.yaml, templates/)
- ApplicationSet entry in `<app>/gitops/applicationset-entry.yaml`
- `Platform` CR (`agents.stxkxs.io/v1alpha1`) declaring tenant boundary, IRSA needs, ResourceQuota, NetworkPolicy
- Optional `AgentFleet` CR if AI workload
- OTel resource attributes (`agents.tenant`, `agents.platform`)
- IRSA via Platform reconciler — agents do NOT scaffold IAM roles inline

### `LANGUAGE_TOOLCHAIN`

Confirm Helm + kustomize commands available in build/lint/test/docs phases. Add if missing:

- `build`: `helm template chart/`
- `lint`: `helm lint chart/`
- `test`: `helm test` (where appropriate) + chart-testing (`ct`)
- `docs`: `helm-docs` or equivalent

These supplement the language toolchain (Helm charts coexist with TS/Go/Python apps).

### `FACTORY_PREAMBLE` reassembly

Reassemble to include `PLATFORM_TENANT_CONTRACT`. Verify the preamble still concatenates in stable order.

## `CLAUDE.md` updates

Update the "Production Standards" section bullets that mention IaC. Specifically the "IaC by deploy_target" line should reflect the new defaults.

Add a bullet on `PLATFORM_TENANT_CONTRACT`.

## Role-prompt sweep

Roles whose prompts likely reference IaC patterns:

- `cloud-architect` — search for CDK references
- `platform-engineer`
- `release-manager`
- `build-verifier`
- `qa-security` — IAM / IRSA review prompts

```sh
grep -n "CDK\|aws-cdk\|cdk-constructs" src/team.ts src/prompts.ts src/standards.ts
```

Where a role's base prompt in `team.ts` hardcodes "use AWS CDK," replace with "use the platform-tenant contract — Helm chart + Platform CR. AWS CDK only via explicit escape-hatch constraint."

## Test updates

```sh
npm test
```

Tests in `__tests__/` that assert on `IAC_BY_TARGET` shape or `FACTORY_PREAMBLE` content need updates.

## Verification

```sh
npm run build
npm run lint           # tsc --noEmit + eslint
npm test
npm run format:check
```

Plus a manual eyeball:

- `node -e "import('./dist/standards.js').then(s => console.log(s.IAC_BY_TARGET))"` — confirm shape
- `grep -n "PLATFORM_TENANT_CONTRACT" src/` — wired into preamble
- `grep -rn "CDK" src/` — only intentional references (escape hatch) remain
