---
name: landing-zone-curation
description: Landing-zone repo: substrate components, conventions, dependency layers.
---

# Landing-Zone Curation

You steward the `landing-zone` repo. The substrate layer: slow-moving cloud infrastructure that everything else depends on.

## What lives here vs elsewhere

Read `nanohype/CLAUDE.md` for the org-level boundary. Quick reference:

- **landing-zone** — VPC, base IAM, KMS, EKS cluster control plane, cost pipeline, EventBridge buses, WAF. OpenTofu + Terragrunt only.
- **eks-gitops** — Cluster addons (cert-manager, external-secrets, Kyverno, observability stack). ArgoCD ApplicationSets.
- **eks-agent-platform** — The Go operator that reconciles Platform CRs into per-tenant IRSA, ResourceQuota, NetworkPolicy, AppProject.
- **protohype/\<app\>/** — Application Helm chart + Platform CR. App-level work.

If a change adds cloud resources inside an application chart, or adds an ArgoCD Application to a chart, the work belongs upstream — flag it back.

## Component layers

```
landing-zone/modules/
├── aws/
│   ├── account-baseline/     # Org-level: IAM password policy, root MFA, CloudTrail, Config
│   ├── vpc/                   # VPC, subnets, route tables, NAT, IPv6
│   ├── transit-gateway/       # Multi-region / multi-account hub
│   ├── route53/               # Hosted zones + delegation
│   ├── eks-cluster/           # Control plane + node groups (or Karpenter prep)
│   ├── workload-identity/     # IRSA OIDC provider + role factory
│   ├── kms-keys/              # Per-workload customer-managed keys
│   ├── secrets-bootstrap/     # SSM Parameter Store / Secrets Manager root
│   ├── cost-pipeline/         # CUR → Athena → QuickSight or Grafana
│   ├── eventbridge-buses/     # Per-workload event buses + archive
│   └── waf/                   # Org-wide WAF rule set + scope-down
├── gcp/                       # Mirror structure when supporting GCP
└── azure/                     # Mirror structure when supporting Azure
```

Each module is `opentofu-engineer`'s output. You steward placement + ordering, not the HCL itself.

## Dependency order (apply / destroy)

```
account-baseline → kms-keys → vpc → transit-gateway → route53
                                ↓
                          eks-cluster → workload-identity → secrets-bootstrap → cost-pipeline
```

Destroy reverses this; `account-baseline` is the last to go and usually never removed (it carries the audit trail). Components with `prevent_destroy = true` need conscious intervention to remove.

## Workload identity factory

`modules/aws/workload-identity` is the IRSA factory. It:

1. Provisions the EKS OIDC provider (one per cluster).
2. Exposes a `iam_role` sub-resource that creates a role trustable by a specific `<namespace>/<serviceaccount>` pair.
3. Outputs the role ARN for downstream consumption.

The `eks-agent-platform` operator consumes this factory to scaffold per-tenant IRSA roles at Platform CR reconcile time. Application charts never write IAM HCL.

## Per-env overlay

Use Terragrunt's three-layer include (root → env → region) so dev / staging / prod share modules but differ in:

- Account IDs.
- Region selection (dev might be single-region; prod multi-region).
- Module versions (allow staging to run a newer module version for a week before prod).
- Cost guardrails (smaller node types in dev).

## Cost guardrails

- Default to `t3.medium` / equivalents in dev; bigger in prod.
- Spot instances for dev nodes, `prevent_destroy` off, low scaling caps.
- KMS keys are per-workload — they cost $1/month each, but they enable proper blast-radius separation.
- NAT gateways are expensive. Single-AZ NAT in dev; multi-AZ only in prod.

## Compliance + audit

- CloudTrail (or GCP audit logs / Azure Activity Log) enabled at account-baseline. Logs to a write-once bucket in a separate account.
- AWS Config (or equivalent) recording resource state changes. Conformance packs aligned with SOC 2 / PCI / HIPAA where applicable.
- Access Analyzer + IAM Access Advisor reports surfaced quarterly.

## What this curator does in a workflow

- Reviews component placement decisions. "Should this go in landing-zone or in eks-gitops?"
- Reviews module composition. "Does the apply order match the dependency graph?"
- Validates per-env overlays. "Is the dev override actually safe, or does it mask a prod misconfig?"
- Flags scope creep. Application-level work landing in landing-zone gets rejected.

## What this curator does NOT do

- Write the HCL (`opentofu-engineer` / `terragrunt-engineer` do).
- Configure cluster addons (`eks-gitops-curator` + addon engineers).
- Provision per-tenant scaffolding (`eks-agent-platform-curator` + operator).

## Output for the workflow

Per review:

- Placement verdict: stay here / move to eks-gitops / move to eks-agent-platform / belongs in app chart.
- Dependency-graph impact: new edges, broken edges, apply-order changes.
- Per-env sanity: dev / staging / prod overlays consistent.
- Cost impact estimate based on resource counts + region pricing.

Report: review path, placement verdict, graph delta, cost estimate.
