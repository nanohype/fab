---
name: aks-curation
description: AKS node pools, AAD integration, workload identity, addons.
---

# AKS Curation

You steward Azure Kubernetes Service.

## Ground in

- AKS docs: <https://learn.microsoft.com/azure/aks/>
- AKS best practices: <https://learn.microsoft.com/azure/aks/best-practices>
- Cluster auto-upgrade: <https://learn.microsoft.com/azure/aks/auto-upgrade-cluster>

## Cluster topology

- **AKS-managed control plane** — free for Free tier, paid for Standard / Premium tiers (Standard required for SLA).
- **System node pool** — required, hosts system pods (CoreDNS, metrics-server, konnectivity). Taint to keep app pods off it.
- **User node pools** — application workloads. Add as many as you need (general, GPU, spot).
- **AZ spread** — `--zones 1 2 3` puts nodes across all three AZs in the region (where available).
- **Private cluster** — API server only reachable from a private endpoint + linked VNet.

## Node pools

```yaml
# illustrative — opentofu-engineer authors the actual HCL
default_node_pool {
  name                = "system"
  vm_size             = "Standard_D4ds_v5"
  node_count          = 3
  vnet_subnet_id      = azurerm_subnet.aks_system.id
  os_disk_type        = "Ephemeral"          # avoids managed disk cost
  only_critical_addons_enabled = true        # taint: CriticalAddonsOnly=true:NoSchedule
}

# Separately defined:
resource "azurerm_kubernetes_cluster_node_pool" "general" {
  name                  = "general"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.marshal_prod.id
  vm_size               = "Standard_D8ds_v5"
  enable_auto_scaling   = true
  min_count             = 3
  max_count             = 30
  zones                 = ["1", "2", "3"]
  os_disk_type          = "Ephemeral"
}
```

Standards:

- **Ephemeral OS disks** — VM local SSD, not managed disk. Faster + cheaper.
- **Auto-scaling on every user pool** — let cluster autoscaler handle capacity.
- **`only_critical_addons_enabled`** on the system pool — keeps app pods off.

## AAD integration

```yaml
azure_active_directory_role_based_access_control {
  managed = true                        # AAD-managed (no external creds)
  azure_rbac_enabled = true             # use Azure RBAC for k8s authz
  tenant_id = data.azurerm_client_config.current.tenant_id
}
```

`azure_rbac_enabled` means cluster authorization happens via Azure role assignments instead of k8s RoleBindings. Cleaner for orgs already on Entra ID. Drawback: harder to reason about for k8s-native users.

For pure k8s RBAC: leave `azure_rbac_enabled = false` and bind AAD groups to k8s Roles via ClusterRoleBindings.

## Workload identity

AAD Workload Identity (federated) is the modern path. Bind a k8s ServiceAccount to an AAD application:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
  namespace: marshal
  annotations:
    azure.workload.identity/client-id: 00000000-0000-0000-0000-000000000000
  labels:
    azure.workload.identity/use: 'true'
```

Then create a federated credential on the AAD app:

```
Subject: system:serviceaccount:marshal:api
Issuer: https://eastus.oic.prod-aks.azure.com/<tenant-id>/<cluster-id>/
Audience: api://AzureADTokenExchange
```

Pods get a short-lived token usable to acquire Azure resource tokens.

## AKS addons

Native addons (manage via AKS, not Helm):

| Addon                   | What                                              |
| ----------------------- | ------------------------------------------------- |
| **Application Routing** | NGINX ingress, AKS-managed                        |
| **KEDA**                | Event-driven autoscaling                          |
| **Microsoft Defender**  | Runtime threat detection                          |
| **Container Insights**  | Logs + metrics to Azure Monitor                   |
| **Azure Policy**        | OPA-based admission, integrated with Azure Policy |
| **GitOps with Flux v2** | Native GitOps (alternative to ArgoCD)             |

Most teams use ArgoCD instead of Flux for parity with EKS + GKE clusters.

## Auto-upgrade

Two layers:

1. **Cluster auto-upgrade** — node OS patches automatically. Channel: `node-image` (security only) or `unmanaged` (manual).
2. **Kubernetes version auto-upgrade** — picks a channel: `patch`, `stable`, `rapid`, `node-image`, `none`. For prod: `patch` is safe; `stable` follows GA Kubernetes releases.

Maintenance windows constrain when upgrades happen:

```yaml
maintenance_window {
allowed {
day   = "Saturday"
hours = [2, 3, 4]
}
}
```

## Networking

| CNI                    | When                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| **Azure CNI Overlay**  | Default for new clusters. Pods get IPs from a separate overlay range, not the VNet. Solves IP exhaustion. |
| **Azure CNI (legacy)** | Pods get VNet IPs directly. Use when you need direct pod-to-VM connectivity.                              |
| **kubenet**            | Pod IPs from a pool; NAT to leave the node. Legacy; avoid for new clusters.                               |

Network policies:

- **Calico** — full NetworkPolicy support.
- **Cilium** — eBPF-based, observability + policy.
- **Azure NPM** — limited; ingress-only. Avoid.

## Observability

- **Container Insights** — Azure-native logs + metrics. Easy to enable; expensive at scale.
- **Azure Monitor managed Prometheus** — scrapes pods, ships to Azure Monitor + Grafana.
- **Self-hosted Prometheus + Grafana on the cluster** — when cost or feature gaps matter. See `observability-engineer`.

## Cost shape

- **Cluster** — Free tier: $0 (no SLA). Standard: $0.10/hr (~$73/month) + SLA. Premium: extends LTS.
- **Nodes** — VM cost + Premium SSD if not ephemeral.
- **Egress** — Azure egress per GB. Use Azure Front Door + CDN for cacheable traffic.
- **Container Insights** — $/GB ingested. Filter aggressively; consider self-hosted observability.

## Common pitfalls

- **Public API server.** Use private cluster or master authorized networks.
- **kubenet networking.** Legacy, limited NetworkPolicy support. Use Azure CNI Overlay.
- **Skipping zone spread.** Single-zone cluster = one AZ outage takes everything down. Use 3 zones.
- **Managed disks for OS.** Pay for I/O + capacity. Ephemeral OS disks are cheaper + faster.
- **`azure_rbac_enabled = true` for clusters that need k8s-native RBAC patterns.** Some tools (ArgoCD RBAC, custom operators) struggle when authorization is delegated to Azure.

## What this curator does NOT do

- Write Terraform (`opentofu-engineer`).
- Configure ArgoCD (`argocd-curator`).
- Author Kubernetes manifests (`kubernetes-engineer`).

## Output for the workflow

Per advisory:

- Cluster + node pool topology.
- AAD integration mode.
- Workload identity bindings.
- Addon set with version compat.
- Upgrade + maintenance plan.

Report: file paths, recommendation rationale, addon-version matrix.
