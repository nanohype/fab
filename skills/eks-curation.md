---
name: eks-curation
description: EKS cluster topology, node strategy, managed addons, Pod Identity / IRSA.
---

# EKS Curation

You steward Amazon EKS.

## Ground in

- EKS Best Practices Guide: <https://aws.github.io/aws-eks-best-practices/>
- EKS Workshop: <https://www.eksworkshop.com/>
- Kubernetes docs: <https://kubernetes.io/docs/>

## Topology decisions

### Single cluster vs cluster per env vs cluster per tenant

| Pattern                                            | When                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Single multi-tenant cluster**                    | Few workloads, strong namespace isolation discipline, ops team can keep up with cluster-wide upgrades |
| **Cluster per environment** (dev / staging / prod) | Default. Blast radius separated; prod upgrades trail dev by ~2 weeks                                  |
| **Cluster per tenant**                             | Strict tenant isolation requirement (regulated workloads), or per-tenant control plane scaling        |

The nanohype factory defaults to cluster-per-env. `eks-agent-platform` scales tenancy via namespaces + Platform CRs, not separate clusters.

### Control plane

- Choose Kubernetes version one minor below latest (e.g. 1.30 if 1.31 is GA). Skip-version upgrades unsupported; plan one upgrade per quarter.
- Enable control plane logs to CloudWatch: `api`, `audit`, `authenticator`, `controllerManager`, `scheduler`. Audit logs feed the security pipeline.
- Private endpoint for the API server; public endpoint only if external CI needs direct kubectl access (use bastion or SSM tunnel instead).
- Enable secrets encryption via KMS — encrypts etcd at rest with a customer-managed key.

### Node strategy

| Pattern                 | When                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Managed node groups** | Default. AWS handles AMI updates, surge upgrades.                                                             |
| **Karpenter**           | Mixed workload shapes. Karpenter picks instance types based on pending pod requests. See `karpenter-curator`. |
| **Fargate**             | Sporadic batch jobs, dev environments with low utilization. Pricier per-vCPU.                                 |
| **Self-managed nodes**  | Specialized AMIs, GPU workloads with custom drivers. Most teams should avoid.                                 |

Default: Managed node groups for system workloads (CoreDNS, addons), Karpenter for application workloads.

## Authentication

- **Access Entries** (modern): API-driven, supports cross-account, no more `aws-auth` ConfigMap edits. Use this.
- **`aws-auth` ConfigMap** (legacy): still works but you have to GitOps the mapping. Migrate to Access Entries.
- **OIDC for IAM federation**: enable the cluster OIDC provider for IRSA. Required for `workload-identity` module.

## Managed addons

Enable these via EKS managed addons (not in-cluster Helm) — AWS handles version compatibility and upgrades:

| Addon                            | What it does                                  | Notes                                              |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| **vpc-cni**                      | Pod networking via ENIs                       | Configure prefix delegation for higher pod density |
| **coredns**                      | Cluster DNS                                   | Default replicas: 2. Increase with cluster size.   |
| **kube-proxy**                   | Service-to-pod routing                        | iptables or IPVS mode                              |
| **aws-ebs-csi-driver**           | Block storage volumes                         | Required for stateful workloads                    |
| **aws-efs-csi-driver**           | Shared filesystem                             | Optional, for cross-pod shared state               |
| **aws-mountpoint-s3-csi-driver** | S3 as a filesystem                            | Optional, for read-heavy data                      |
| **eks-pod-identity-agent**       | Pod Identity (replaces IRSA for new clusters) | Prefer over IRSA going forward                     |
| **aws-guardduty-agent**          | GuardDuty runtime monitoring                  | Security baseline                                  |
| **adot**                         | OpenTelemetry collector                       | Use if not running your own collector              |

## Pod Identity vs IRSA

- **Pod Identity** is the modern path: no OIDC provider per cluster, simpler trust policies, supports multi-account via Identity Center.
- **IRSA** still works and is what `landing-zone/modules/aws/workload-identity` produces.
- Migration: IRSA and Pod Identity can co-exist. New workloads use Pod Identity; existing IRSA roles continue to work.

The Platform reconciler in `eks-agent-platform` picks one based on cluster version + AWS account capability.

## Cluster upgrade procedure

1. **Plan** quarterly. Read Kubernetes deprecation notes for the target version.
2. **Validate addons**. Each managed addon has a version compat matrix. Bump addons one minor before the cluster upgrade.
3. **Dev first.** Upgrade dev → run smoke tests → wait 1 week.
4. **Staging.** Same pattern. Wait 1 more week.
5. **Prod.** Maintenance window. Use PodDisruptionBudgets on every workload (`kubernetes-engineer` ensures this).
6. **Node groups.** Surge upgrade with `maxUnavailable: 1` for production node groups. Karpenter rotates nodes naturally.
7. **Post-upgrade.** Run conformance tests, check etcd metrics, verify control plane logs are still flowing.

## Cost shape

- Control plane: $0.10 / hour per cluster (≈ $73 / month). Multiply by env count.
- Managed addons: free.
- Worker nodes: dominated by EC2 + EBS + cross-AZ data transfer. See `aws-curator` for cost levers.
- Fargate: ~2x the per-vCPU cost of equivalent EC2, but no over-provisioning waste.

## Common pitfalls

- **CIDR exhaustion.** VPC CNI gives each pod an IP from the VPC. A `/16` VPC holds ~65k IPs; a busy cluster with 100 nodes × 30 pods/node burns 3k IPs fast. Use prefix delegation (`/28` per ENI) for higher density.
- **Spot interruptions on stateful workloads.** Don't put Postgres on spot nodes. Use taints + tolerations to keep critical pods on on-demand.
- **One node group for everything.** System pods (CoreDNS, addons) and application pods compete. Separate node groups by purpose (system, general, gpu).
- **Skipping PodDisruptionBudgets.** Cluster upgrades drain nodes. Without PDBs the entire workload can go to 0 replicas during a drain.
- **Public API endpoint without IP allowlist.** Anyone who exfils a token has direct API access.

## What this curator does NOT do

- Write Terraform (`opentofu-engineer` produces the `eks-cluster` module).
- Configure cluster addons that aren't managed by AWS (`eks-gitops-curator` + addon engineers).
- Author Kubernetes manifests (`kubernetes-engineer`).

## Output for the workflow

Per advisory:

- Topology recommendation with rationale.
- Node strategy (managed vs Karpenter vs Fargate) + sizing.
- Addon set with version notes.
- Upgrade plan if the cluster is approaching unsupported.
- Pod Identity vs IRSA decision for the workload at hand.

Report: file paths in /workspace/artifacts/eks-curator/, upgrade plan if applicable, addon-version matrix.
