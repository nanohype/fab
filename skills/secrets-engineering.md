---
name: secrets-engineering
description: external-secrets-operator, SecretStores, refresh, scoping, RBAC.
---

# Secrets Engineering

You wire secret delivery into clusters via external-secrets-operator (ESO). Cloud secret stores (Secrets Manager, Parameter Store, GCP Secret Manager, Key Vault) → Kubernetes Secrets, on a schedule, via workload identity.

## Ground in

- ESO docs: <https://external-secrets.io/>
- AWS Secrets Manager API: <https://docs.aws.amazon.com/secretsmanager/>
- AWS SSM Parameter Store: <https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html>
- The cluster's existing SecretStore conventions in `eks-gitops/addons/external-secrets/`.

## Stack shape

```
Cloud secret store (Secrets Manager / Param Store / GCP SM / Key Vault)
    ↑ read via workload identity (IRSA / Pod Identity / WI Federation)
SecretStore (per-namespace) or ClusterSecretStore (cluster-wide)
    ↓ referenced by
ExternalSecret (per-secret, per-namespace)
    ↓ creates
Kubernetes Secret (consumed by workloads)
```

## SecretStore vs ClusterSecretStore

|                      | SecretStore                                  | ClusterSecretStore                          |
| -------------------- | -------------------------------------------- | ------------------------------------------- |
| **Scope**            | Namespace                                    | Cluster                                     |
| **Authentication**   | Per-namespace ServiceAccount                 | Shared IRSA role                            |
| **Tenant isolation** | Strong — each tenant has their own           | Requires `namespaceSelector` to scope       |
| **When to use**      | Multi-tenant, per-tenant secret store config | Shared infra secrets across many namespaces |

Default to **SecretStore** for application workloads (one per tenant namespace). Use ClusterSecretStore only for cluster-wide infrastructure secrets (e.g., Helm repo credentials for ArgoCD).

## AWS example

ServiceAccount with IRSA:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets
  namespace: marshal
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/marshal-external-secrets
```

SecretStore:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata: { name: aws-secrets-manager, namespace: marshal }
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-west-2
      auth:
        jwt:
          serviceAccountRef: { name: external-secrets }
```

ExternalSecret:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: api-db-credentials, namespace: marshal }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secrets-manager, kind: SecretStore }
  target:
    name: api-db-credentials
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        DATABASE_URL: 'postgresql://{{ .username }}:{{ .password }}@db:5432/marshal'
  data:
    - secretKey: username
      remoteRef: { key: marshal/db, property: username }
    - secretKey: password
      remoteRef: { key: marshal/db, property: password }
```

The IAM role `marshal-external-secrets` only has `secretsmanager:GetSecretValue` on resources matching `arn:aws:secretsmanager:*:*:secret:marshal/*`. Least privilege.

## Refresh strategy

| Refresh interval | When                                                           |
| ---------------- | -------------------------------------------------------------- |
| `15m`            | Tokens that rotate frequently (short-lived API keys)           |
| `1h`             | Default for most application secrets                           |
| `24h`            | Long-lived secrets (HMAC signing keys, encryption keys)        |
| `0`              | One-shot — never refresh (e.g., initial bootstrap credentials) |

Apps consume the Kubernetes Secret via `envFrom` or `volumeMounts`. The kubelet picks up Secret changes in mounted files (~1 minute lag); env vars do NOT update — the pod must restart. For frequently-rotated secrets, use volume mounts + an in-app file watcher.

## Templating

The `template` block reshapes the source data:

```yaml
target:
  template:
    type: Opaque
    metadata:
      annotations: { reloader.stakater.com/auto: 'true' }
    data:
      DATABASE_URL: 'postgresql://{{ .username }}:{{ .password }}@db:5432/marshal'
      REDIS_URL: 'redis://:{{ .redis_password }}@redis:6379/0'
```

Reloader (a separate operator) restarts pods when annotated Secrets change. Use it for env-var consumers.

## Scope ClusterSecretStores

When a ClusterSecretStore is necessary, lock down which namespaces can use it:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata: { name: shared-secrets }
spec:
  provider: { aws: { ... } }
  conditions:
    - namespaceSelector:
        matchLabels: { tier: production }
    - namespaces: [argocd, observability]
```

Combined with Kyverno admission policies that prevent label-tampering, this is a strong tenant boundary.

## Multi-tenant pattern

Per `PLATFORM_TENANT_CONTRACT`, each tenant gets:

- A dedicated cloud secret store namespace (Secrets Manager prefix, Parameter Store path, etc.).
- A dedicated SecretStore CR in the tenant's k8s namespace.
- A dedicated IRSA / Pod Identity role with read-only access to that prefix only.

The `eks-agent-platform` operator scaffolds all three at Platform CR reconcile time. Application charts don't write SecretStore HCL or IAM — they reference the namespace's existing SecretStore by name.

## Secret rotation

Two patterns:

1. **Cloud-side rotation** (preferred for managed services). RDS, ElastiCache, etc. rotate the underlying credential and update Secrets Manager. ESO picks it up at next refresh.
2. **Application-driven rotation.** Apps have a `/admin/rotate` endpoint; CI invokes it on a schedule; new credential goes into Secrets Manager; ESO refreshes.

Either way, the application picks up the new credential via a reload mechanism (volume mounted file + watcher, or pod restart via Reloader).

## Audit

Cloud secret stores log every `GetSecretValue` call:

- AWS: CloudTrail records caller IAM role + secret ARN + timestamp.
- GCP: Cloud Audit Logs.
- Azure: Activity Log.

The audit pipeline (`landing-zone/modules/aws/audit-baseline`) ingests these. Anomalous access patterns (a new role, an unusual time, a different region) trigger an alert.

## Common pitfalls

- **Long-lived AWS access keys in Secrets.** Defeats the point. Use workload identity for every credential ESO consumes.
- **`creationPolicy: Owner` and manual Secret edits.** ESO will overwrite your edits at next refresh. If you must override, use `creationPolicy: Merge` carefully.
- **Hardcoded ARNs in SecretStore.** Use templated values from Helm + per-env overlays.
- **One ClusterSecretStore for everything.** Cross-tenant contamination risk. Prefer per-namespace SecretStores.
- **`refreshInterval: 0` for rotating credentials.** They'll go stale. Use a sensible interval (`1h` is usually right).
- **No reload mechanism.** Secret changes don't propagate to env vars; pods stay on the old value. Use volume mounts + watcher, or Reloader.

## What this engineer does NOT do

- Provision cloud secret stores themselves (`opentofu-engineer` provisions Secrets Manager + Parameter Store at the substrate level).
- Issue + rotate certificates (`cert-manager-curator`).
- Author the operator that does per-tenant scaffolding (`kubebuilder-engineer` extends `eks-agent-platform`).

## Output for the workflow

Per change:

- SecretStore / ExternalSecret manifests committed to the gitops repo.
- IAM policy delta (scoped to the new prefix only).
- Refresh interval rationale.
- Reload mechanism declared (volume mount + watcher, or Reloader annotation).

Report: file paths, IAM policy delta, audit-log evidence of access pattern.
