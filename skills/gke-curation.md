---
name: gke-curation
description: GKE Standard vs Autopilot, node pools, workload identity, GKE addons.
---

# GKE Curation

You steward Google Kubernetes Engine.

## Ground in

- GKE best practices: <https://cloud.google.com/kubernetes-engine/docs/best-practices>
- GKE workshop: <https://gke-workshop.com/> (or current Google reference)
- Release notes: <https://cloud.google.com/kubernetes-engine/docs/release-notes>

## Standard vs Autopilot

|                          | Standard                                    | Autopilot                                                          |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| **Node management**      | You configure node pools                    | Google manages nodes entirely                                      |
| **Billing**              | Per-node, regardless of pod density         | Per-pod (CPU + memory + ephemeral storage)                         |
| **Customization**        | Full control: machine type, kernel, drivers | Limited: predefined classes (general-purpose, balanced, scale-out) |
| **Privileged workloads** | Allowed                                     | Blocked                                                            |
| **DaemonSets**           | Standard                                    | Limited (only Google-approved)                                     |
| **GPU workloads**        | Yes                                         | Yes (newer Autopilot versions)                                     |
| **Spot**                 | Yes                                         | Yes (Spot Pods)                                                    |

Default to **Autopilot** for new workloads. Switch to Standard only when you need:

- Custom node configuration (kernel modules, GPU drivers, large local SSDs).
- Privileged DaemonSets (CSI drivers from third parties, observability agents that need host access).
- Cost optimization beyond Autopilot's pricing model (very dense pod packing).

## Cluster setup (Standard)

```yaml
# illustrative — opentofu-engineer authors the actual HCL
resource "google_container_cluster" "marshal_prod" {
  name     = "marshal-prod-us-central1"
  location = "us-central1"           # regional cluster — control plane in 3 zones
  # Don't manage the default node pool; create explicit ones
  remove_default_node_pool = true
  initial_node_count = 1

  workload_identity_config { workload_pool = "marshal-prod.svc.id.goog" }

  release_channel { channel = "REGULAR" }

  network = google_compute_network.shared.id
  subnetwork = google_compute_subnetwork.gke.id
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  network_policy { enabled = true; provider = "CALICO" }

  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = "10.0.0.0/8"
      display_name = "internal"
    }
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = true
  }
}
```

Always:

- **Regional cluster** (control plane HA across 3 zones).
- **Workload Identity** enabled (`workload_pool`).
- **Private nodes** (no public IPs on workers).
- **Master authorized networks** (kubectl access from approved CIDRs only).
- **Release channel** = REGULAR for prod (stable but recent); RAPID for dev.

## Node pools (Standard)

Split by purpose:

```
node-pool: system        # n2-standard-4, 2 nodes, taints: system-only
node-pool: general       # n2-standard-8, 3-20 nodes, autoscale
node-pool: spot          # spot instances, scale-to-zero capable
node-pool: gpu           # n1-standard-8 + 1 nvidia-t4, on-demand
```

`taints` on the system pool keep application workloads off it. Critical addons get the matching `tolerations`.

## Release channels

| Channel     | When updates land          | Stability                     |
| ----------- | -------------------------- | ----------------------------- |
| **RAPID**   | Within weeks of upstream   | New features early; more bugs |
| **REGULAR** | A month or two after RAPID | Production default            |
| **STABLE**  | After REGULAR has soaked   | Slowest moving                |

Use REGULAR for prod. RAPID for dev to catch issues early.

## Workload Identity

Replace any GCP service account key with workload identity binding:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
  namespace: marshal
  annotations:
    iam.gke.io/gcp-service-account: marshal-api@marshal-prod.iam.gserviceaccount.com
```

Then grant the GSA's IAM roles on the specific resources it needs.

## GKE addons

- **HPA + VPA** — Horizontal + Vertical Pod Autoscaling. VPA can resize requests in-place on supported clusters.
- **Image streaming** — pull container images on-demand, faster pod startup for large images.
- **GKE backup** — managed cluster + PV backup, restore to any GKE cluster.
- **Cloud Service Mesh** (managed Istio / ASM) — service mesh without operating the control plane.
- **Config Sync** — GitOps native to GKE (alternative to ArgoCD; usually we use ArgoCD instead).
- **Policy Controller** (managed Gatekeeper) — OPA-based admission policies; alternative to Kyverno.

## Observability

- **Cloud Logging** ingests container stdout/stderr by default.
- **Cloud Monitoring managed Prometheus** for metrics — scrapes pods + emits to Cloud Monitoring.
- **OpenTelemetry collector** for traces; export to Cloud Trace or third-party.
- **GKE Dataplane V2** uses eBPF for networking, with flow logs visible in Cloud Logging.

## Cluster upgrade procedure

1. **Read release notes** for the target version.
2. **Dev first.** RAPID-channel dev clusters get the upgrade automatically.
3. **Staging.** REGULAR-channel auto-upgrade window. Use maintenance window to control timing.
4. **Prod.** REGULAR-channel. Auto-upgrade gated by maintenance windows + exclusion windows for blackout dates.
5. **Surge upgrades.** `maxSurge: 1, maxUnavailable: 0` for node pools to keep capacity during upgrade.

## Cost shape

- **Autopilot** — billed per-pod CPU/memory/disk. No idle waste.
- **Standard** — billed per-node + per-control-plane (regional cluster: $73/month for the control plane).
- **Network costs** — egress to the internet adds up. Use Cloud CDN for cacheable traffic.
- **Persistent disks** — pay for provisioned capacity, not used. Right-size aggressively.

## Common pitfalls

- **Zonal cluster for prod.** One AZ outage = total outage. Regional clusters are mandatory.
- **Public master endpoint.** Use private endpoints + bastion or Identity-Aware Proxy.
- **Skipping master authorized networks.** Without this, the API server is reachable from anywhere with a token.
- **One node pool for everything.** System pods compete with application pods for resources. Separate pools by purpose.
- **GKE workload identity not enabled at cluster creation.** Enabling later requires cluster recreation.

## What this curator does NOT do

- Write Terraform (`opentofu-engineer`).
- Configure cluster addons (`eks-gitops-curator` equivalent for GKE — typically Config Sync or ArgoCD setup).
- Author Kubernetes manifests (`kubernetes-engineer`).

## Output for the workflow

Per advisory:

- Standard vs Autopilot recommendation.
- Node pool layout if Standard.
- Workload identity binding.
- Release channel + upgrade plan.
- Addon set.

Report: file paths, recommendation rationale, upgrade plan if applicable.
