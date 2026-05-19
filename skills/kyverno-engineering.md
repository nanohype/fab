---
name: kyverno-engineering
description: Kyverno policies — admission control, validation, mutation, generation, image verification.
---

# Kyverno Engineering

You write Kyverno policies. ClusterPolicies, Policies, PolicyExceptions, image verification. Kyverno is the policy-as-code engine that enforces production-bar rules at admission time.

## Ground in

- Kyverno docs: <https://kyverno.io/docs/>
- Policy library: <https://kyverno.io/policies/>
- Policy testing: <https://kyverno.io/docs/cli/test/>
- The cluster's existing policy set in `eks-gitops/addons/kyverno-policies/`.

## Policy types

| Type                   | When                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| **validate**           | Reject resources that violate a rule. The default.                            |
| **mutate**             | Inject defaults / labels / sidecars. Use sparingly — mutation hides intent.   |
| **generate**           | Create companion resources (e.g., NetworkPolicy when a namespace is created). |
| **image verification** | Verify signatures + attestations (Cosign / Notation).                         |
| **cleanup**            | Delete resources matching a TTL or label.                                     |

Preference: validate > generate > mutate. Mutation only when validation can't express the intent (e.g., default labels for backward compat).

## Standard policy set

Every nanohype cluster ships with:

| Policy                            | Type         | What                                                           |
| --------------------------------- | ------------ | -------------------------------------------------------------- |
| `require-image-digest`            | validate     | Block `:latest` and tag-only references; require sha256 digest |
| `require-resource-limits`         | validate     | Block Pods without requests + limits                           |
| `require-pod-security-baseline`   | validate     | Enforce Pod Security Standards `baseline` profile              |
| `require-pod-security-restricted` | validate     | Enforce `restricted` profile in prod namespaces                |
| `require-non-root`                | validate     | `runAsNonRoot: true` on every container                        |
| `require-readonly-rootfs`         | validate     | `readOnlyRootFilesystem: true` on every container              |
| `disallow-host-namespaces`        | validate     | No `hostNetwork`, `hostPID`, `hostIPC`                         |
| `disallow-privileged`             | validate     | No `privileged: true`; no `allowPrivilegeEscalation: true`     |
| `disallow-capabilities`           | validate     | Drop `ALL`; only specific capabilities may be added            |
| `require-pdb`                     | validate     | Multi-replica Deployments must have a matching PDB             |
| `require-network-policy`          | validate     | Pods must be selected by at least one NetworkPolicy            |
| `require-image-signature`         | image-verify | Sign-only images from approved publishers                      |
| `auto-create-network-policy`      | generate     | Inject default-deny NetworkPolicy in new namespaces            |

## Policy structure

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-image-digest
  annotations:
    policies.kyverno.io/title: Require image digest
    policies.kyverno.io/category: Best Practices
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    policies.kyverno.io/description: |
      Pods must reference images by digest (sha256:...), not tag.
      Tags are mutable; digests are not.
spec:
  validationFailureAction: Enforce # Audit for soft-rollout, Enforce when ready
  background: true # Also scan existing resources
  rules:
    - name: require-digest
      match:
        any:
          - resources:
              kinds: [Pod]
              operations: [CREATE, UPDATE]
      exclude:
        any:
          - resources:
              namespaces: [kube-system, kube-public, kyverno]
      validate:
        message: |
          Container images must reference a digest (sha256:...).
          Found: "{{ request.object.spec.containers[].image }}"
        pattern:
          spec:
            containers:
              - image: '*@sha256:*'
```

## Validation failure actions

- **`Audit`** — log violations to the policy report; don't block. Use during rollout to see who'd break.
- **`Enforce`** — block on violation. Switch from Audit to Enforce after one quiet week.

Per-policy `validationFailureAction` is the lever.

## Match + exclude scoping

`match.any` / `match.all` decide whether the rule applies. `exclude.any` / `exclude.all` carve out exceptions.

```yaml
match:
  any:
    - resources:
        kinds: [Deployment, StatefulSet]
        namespaces: ['prod-*']
exclude:
  any:
    - resources:
        labels:
          policy.kyverno.io/exception: 'approved-CVE-2024-12345'
```

Wildcards in namespace selectors give env-scoping. Label-based exclude lets approved exceptions opt out without changing the policy.

## PolicyExceptions

For controlled exceptions: a `PolicyException` lets a specific resource bypass a specific policy for a limited time.

```yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata: { name: legacy-deployment-pdb-exception, namespace: legacy-app }
spec:
  exceptions:
    - policyName: require-pdb
      ruleNames: [check-pdb]
  match:
    any:
      - resources:
          kinds: [Deployment]
          names: [legacy-monolith]
  conditions:
    - key: "{{ time_since('', '2025-01-01T00:00:00Z', '') }}"
      operator: LessThan
      value: 90d
```

Exceptions live in the namespace they apply to, get reviewed at expiration, and never become permanent. The `conditions` block enforces an expiration date.

## Image verification

Use Cosign signatures for prod registries:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata: { name: verify-image-signatures }
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-signed-by-nanohype
      match:
        any:
          - resources: { kinds: [Pod] }
      verifyImages:
        - imageReferences:
            - 'ghcr.io/nanohype/*'
          mutateDigest: true # rewrite tag → digest
          attestors:
            - entries:
                - keys:
                    publicKeys: |
                      -----BEGIN PUBLIC KEY-----
                      ...
                      -----END PUBLIC KEY-----
          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys: { publicKeys: '...' }
```

`mutateDigest: true` rewrites tags to digests, so even if upstream allows `:latest`, the running pod has the digest baked in.

## Generation policies

Inject companion resources at create time:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata: { name: auto-create-default-deny }
spec:
  rules:
    - name: generate-default-deny
      match:
        any: [{ resources: { kinds: [Namespace] } }]
      generate:
        synchronize: true # Kyverno keeps the generated resource in sync
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny
        namespace: '{{ request.object.metadata.name }}'
        data:
          spec:
            podSelector: {}
            policyTypes: [Ingress, Egress]
```

`synchronize: true` means deleting the generated NetworkPolicy will resurrect it. Tenants can't bypass the rule by deleting their default-deny.

## Testing

Kyverno CLI tests policies against fixture resources:

```yaml
# tests/require-image-digest/test.yaml
name: require-image-digest
policies: [../require-image-digest.yaml]
resources: [resources.yaml]
results:
  - policy: require-image-digest
    rule: require-digest
    resource: bad-pod
    kind: Pod
    result: fail
  - policy: require-image-digest
    rule: require-digest
    resource: good-pod
    kind: Pod
    result: pass
```

Run: `kyverno test ./tests/`. CI rejects PRs where tests fail.

## Performance considerations

- Kyverno admission webhooks add latency. Keep policies under ~50; combine rules within policies where possible.
- `background: true` re-scans existing resources on policy changes. Heavy. Schedule policy rollouts during quiet windows.
- Image verification scales by signature lookup count. Cache aggressively (`imageVerifyCacheEnabled: true`).

## Common pitfalls

- **Skipping `Audit` mode.** Going straight to Enforce on day one breaks existing workloads. Always Audit first.
- **Overly broad `match`.** Matching `kinds: [Pod]` without excluding system namespaces blocks the cluster from booting on first apply.
- **Mutation without intent.** Mutation hides what's actually deployed. Validate is clearer; mutation only for explicit defaulting.
- **PolicyExceptions without expiration.** Exceptions become permanent. Always include a `conditions` block with a date check.
- **Forgetting `webhookTimeoutSeconds`.** Image verification can be slow; default 10s is sometimes too short.

## Output for the workflow

Per policy:

- Policy + matching `tests/` fixtures.
- `kyverno test` clean.
- Audit mode for one week before flip to Enforce.
- README documenting what the policy enforces + how to request exceptions.

Report: policy paths, test results, Audit/Enforce status per policy, PolicyException counts.
