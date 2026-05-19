---
name: karpenter-curation
description: Karpenter NodePools, NodeClasses, consolidation, disruption budgets, spot.
---

# Karpenter Curation

You steward Karpenter. NodePools, NodeClasses, consolidation, disruption budgets, spot strategies. Karpenter is the just-in-time node provisioner that replaces managed node groups for application workloads.

## Ground in

- Karpenter docs: <https://karpenter.sh/>
- AWS-specific provider: <https://karpenter.sh/docs/concepts/nodeclasses/>
- The cluster's existing NodePool set in `eks-gitops/addons/karpenter/`.

## Why Karpenter

Managed node groups require ASG-level decisions: instance family, AZ distribution, size. Karpenter inverts this — it inspects pending pods and provisions the most efficient instance type for the actual workload. This means:

- **Better bin-packing.** Pending 4 vCPU pod → m6i.xlarge instead of paying for headroom on a m6i.4xlarge.
- **Faster scale-up.** Seconds, not minutes (no ASG round-trip).
- **Lower cost.** Spot integration with automatic fallback to on-demand on interruption.
- **Mixed shape support.** GPU + CPU + ARM in the same cluster without separate node groups.

Default pattern: Managed node groups for system pods (CoreDNS, addons), Karpenter for application workloads.

## NodePool

The intent: "what shapes can run application pods."

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: { name: general }
spec:
  template:
    metadata:
      labels: { workload-class: general }
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: [amd64, arm64]
        - key: kubernetes.io/os
          operator: In
          values: [linux]
        - key: karpenter.sh/capacity-type
          operator: In
          values: [spot, on-demand] # spot preferred; on-demand fallback
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: [c, m, r] # general-purpose families
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ['5'] # gen 6+ only
        - key: karpenter.k8s.aws/instance-size
          operator: NotIn
          values: [nano, micro, small] # too small for our workloads
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general
      expireAfter: 720h # rotate nodes after 30 days
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
    budgets:
      - nodes: '10%' # disrupt at most 10% of nodes at once
      - nodes: '0' # no disruption during business hours
        schedule: '0 9 * * mon-fri'
        duration: 8h
  limits:
    cpu: 1000
    memory: 1000Gi
  weight: 10 # higher = prefer this pool when multiple match
```

## NodeClass (AWS)

The cloud-specific bits: AMI family, IAM role, networking.

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata: { name: general }
spec:
  amiFamily: AL2023 # Amazon Linux 2023 is the modern default
  amiSelectorTerms:
    - alias: al2023@latest # auto-track latest AL2023 EKS-optimized AMI
  role: KarpenterNodeRole-prod # IAM role for Karpenter-provisioned nodes
  subnetSelectorTerms:
    - tags: { kubernetes.io/role/internal-elb: '1', karpenter.sh/discovery: prod-cluster }
  securityGroupSelectorTerms:
    - tags: { karpenter.sh/discovery: prod-cluster }
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        deleteOnTermination: true
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 2 # IMDSv2 only, 2 hops (Pod can read its instance metadata)
    httpTokens: required # IMDSv2 required
  tags:
    workload: production
    managed-by: karpenter
  userData: |
    #!/bin/bash
    /etc/eks/bootstrap.sh prod-cluster \
      --kubelet-extra-args '--max-pods=110'
```

## Pool patterns

Standard set per cluster:

| NodePool  | Capacity         | Families          | Workloads                                                              |
| --------- | ---------------- | ----------------- | ---------------------------------------------------------------------- |
| `system`  | on-demand only   | small (m6i.large) | DaemonSets, system pods (avoids spot interruptions for critical infra) |
| `general` | spot + on-demand | c/m/r gen 6+      | Default app pods                                                       |
| `burst`   | spot only        | small + medium    | Batch jobs, CI runners, ephemeral workloads                            |
| `gpu`     | on-demand        | g5, p4d           | ML inference, training                                                 |
| `arm`     | spot + on-demand | c7g, m7g, r7g     | ARM-compatible workloads (20% cheaper)                                 |

Use `nodeSelector` + `tolerations` on pods to target specific pools. Common label:

```yaml
spec:
  nodeSelector: { workload-class: general }
```

For GPU pods, add the toleration:

```yaml
tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
```

## Consolidation

Karpenter actively rebalances:

- **WhenEmpty** — only consolidate nodes with no pods. Safest.
- **WhenEmptyOrUnderutilized** — also consolidate when a node could be replaced with a smaller one (saving cost). Aggressive but cost-optimal.

Both respect PodDisruptionBudgets — Karpenter won't violate a PDB during consolidation.

`consolidateAfter: 30s` is the cooldown. A pod scheduling, then unscheduling, then rescheduling within 30s won't trigger consolidation churn.

## Disruption budgets

Limit blast radius:

```yaml
disruption:
  budgets:
    - nodes: '10%' # always allow disruption of 10%
    - nodes: '0' # but freeze during these windows
      schedule: '0 0 * * sat,sun'
      duration: 48h
    - nodes: '0'
      schedule: '0 0 1 * *' # freeze the 1st of every month (release day)
      duration: 24h
    - reasons: [Underutilized] # never consolidate-down during incidents
      nodes: '0'
      schedule: '0 9 * * mon-fri'
      duration: 8h
```

Budgets evaluate top-down; first matching wins.

## Spot strategy

Karpenter handles spot interruptions automatically:

1. AWS sends a 2-minute interruption notice to the instance metadata service.
2. Karpenter's `aws-node-termination-handler` (or built-in equivalent) cordons + drains the node.
3. Karpenter provisions a replacement node based on the NodePool's requirements.

For workloads that can't tolerate any spot interruption (databases, payment processors), use `requirements` to lock to `on-demand`:

```yaml
requirements:
  - key: karpenter.sh/capacity-type
    operator: In
    values: [on-demand]
```

## Cost shape

Typical savings:

- Bin-packing improvement vs ASG: 15–25%.
- Spot (60–80% of the OD price for matching instance types) on burstable workloads: 50–70% cost reduction for those workloads.
- ARM (Graviton): additional 15–20% on top.
- Consolidation: ongoing 5–15% from removing waste as pods shift.

Aggregate: 30–50% lower compute spend vs same workload on managed node groups.

## Common pitfalls

- **Karpenter on system pods.** Causes feedback loops — Karpenter draining its own infra. Keep system workloads (CoreDNS, addons, Karpenter itself) on a managed node group.
- **Loose requirements.** Allowing every instance family lets Karpenter pick weird shapes (e.g., t2 nodes for stateful workloads). Constrain via `instance-category` + `instance-generation`.
- **No `expireAfter`.** Long-running nodes accumulate state + risk staleness. 30-day rotation is standard.
- **No disruption budgets.** Karpenter can churn aggressively. Budgets enforce maximums.
- **GPU pool sharing with general workloads.** GPU instances are expensive idle. Use taints + tolerations to keep general pods off.
- **`consolidateAfter: 0s`.** Causes thrashing on scheduling churn. 30s is a sane default.

## What this curator does NOT do

- Provision the cluster itself (`eks-curator` + `opentofu-engineer`).
- Author per-workload manifests (`kubernetes-engineer`).
- Tune HPA / KEDA (`kubernetes-engineer` + `keda-engineer`).

## Output for the workflow

Per change:

- NodePool YAML with requirements + disruption budgets.
- EC2NodeClass YAML with AMI family + IAM role.
- Cost estimate at expected workload mix.
- Workload selector strategy (labels + tolerations).

Report: file paths, NodePool count, cost-savings estimate vs current state.
