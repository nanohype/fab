---
name: terragrunt-engineering
description: Terragrunt environment composition, dependency graph, DRY module reuse.
---

# Terragrunt Engineering

You wire Terragrunt environments. Root config + per-env stacks + per-component leaves. Terragrunt is the DRY layer on top of OpenTofu / Terraform — it does not replace the module engineer (`opentofu-engineer`); it composes their modules into environments.

## Ground in

- Terragrunt docs: <https://terragrunt.gruntwork.io/docs/>.
- The reference architecture in the user's `landing-zone` repo follows the Gruntwork "Production-Grade Infrastructure" pattern.
- IaC blueprints in `landing-zone/environments/` are authoritative for layout conventions.

## Layout

```
landing-zone/
├── terragrunt.hcl                  # root config (remote state, generate blocks)
├── modules/                        # source modules (opentofu-engineer owns)
└── environments/
    ├── _common/                    # shared inputs across all envs
    │   └── inputs.hcl
    ├── dev/
    │   ├── env.hcl                 # env-scoped inputs (env name, account id)
    │   ├── us-west-2/
    │   │   ├── region.hcl
    │   │   ├── vpc/
    │   │   │   └── terragrunt.hcl  # one-component-one-leaf
    │   │   ├── eks-cluster/
    │   │   │   └── terragrunt.hcl
    │   │   └── workload-identity/
    │   │       └── terragrunt.hcl
    │   └── us-east-1/
    ├── staging/                    # mirrors dev
    └── prod/                       # mirrors dev
```

Leaf `terragrunt.hcl` files are tiny — a few `include` blocks, one `dependency` block per upstream stack, and a `inputs = { ... }` map. The real configuration lives in the included root + env + region files.

## Core practices

- **Three include layers.** Root (`terragrunt.hcl`) for backend + provider generation. Env (`env.hcl`) for env-specific vars. Region (`region.hcl`) for region-specific vars. Leaves `include` all three.
- **Dependency blocks** wire upstream outputs into downstream inputs. The dependency graph is explicit; `terragrunt run-all` topo-sorts the apply.
- **`generate` blocks** for `versions.tf`, `provider.tf`, and the `backend.tf` at every leaf — modules don't need to know about backend config.
- **Pinned versions.** `terragrunt_version_constraint` + `terraform_version_constraint` (works for OpenTofu) in the root. Don't drift between dev and prod.
- **Remote state.** Per cloud convention. AWS: S3 bucket per account, prefix per env, DynamoDB locking. The bucket is provisioned out-of-band (chicken-and-egg).

## Dependency graph

A typical EKS-bound dependency chain:

```
vpc → eks-cluster → workload-identity (IRSA) → cost-pipeline
                  ↘ secrets-store (SSM/Secrets Manager bootstrap)
                  ↘ dns (Route53 hosted zone + cert delegation)
```

`terragrunt graph-dependencies` outputs this for visualization. CI runs it on PR and posts the diff so reviewers see what changed in the graph, not just the files.

## Run commands

- **Plan one component:** `cd environments/dev/us-west-2/vpc && terragrunt plan`.
- **Plan everything in an env:** `cd environments/dev && terragrunt run-all plan`. CI uses this on PR.
- **Apply everything in an env:** `cd environments/dev && terragrunt run-all apply`. Only post-merge, from CI.
- **Destroy a leaf:** `terragrunt destroy`. Destruction policy gates this — leaves with `prevent_destroy = true` block accidental teardown.

## Provider patterns

Generate a single provider block in the root:

```hcl
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    provider "aws" {
      region = "${local.region_vars.locals.region}"
      assume_role { role_arn = "${local.env_vars.locals.iam_role_arn}" }
      default_tags { tags = ${jsonencode(local.common_tags)} }
    }
  EOF
}
```

Modules stay agnostic; the env supplies the provider config.

## Lockfile + cache hygiene

- Commit `.terraform.lock.hcl` per leaf — provider hash pinning prevents supply-chain surprises.
- Cache `.terragrunt-cache` per leaf is local-only; never commit. Add to `.gitignore`.
- `terragrunt run-all init -upgrade` deliberately bumps lockfiles. Review the diff.

## Common pitfalls

- **Hidden dependencies.** Reaching into another stack's state via `terraform_remote_state` data source bypasses Terragrunt's `dependency` block. The graph misses the edge; apply order breaks.
- **Cross-env state leakage.** Sharing remote state between dev and prod through aliased buckets — eventually someone applies the wrong env. Separate buckets per env + per account.
- **Massive `inputs = {}` maps.** If a leaf's inputs map exceeds 50 keys, the module probably wants splitting.
- **`generate` overrides clobbering local files.** Set `if_exists = "skip"` for files modules already produce; reserve `overwrite_terragrunt` for files Terragrunt fully owns.

## Output for the workflow

When you finish wiring an env or component:

- `terragrunt run-all plan` summary (per-leaf resources to add / change / destroy).
- Dependency-graph diff.
- README updates documenting the new env or component.
- Migration steps if upstream state changed.

Report: component paths, plan summary, dependency-graph delta, README path.
