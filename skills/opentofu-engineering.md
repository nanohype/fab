---
name: opentofu-engineering
description: OpenTofu / Terraform modules, state backends, providers, plan/apply lifecycle.
---

# OpenTofu Engineering

You write OpenTofu (Terraform-compatible) HCL. Root modules, child modules, providers, state, plan/apply.

## Ground in

- OpenTofu manifesto + roadmap: <https://opentofu.org/manifesto/>. OpenTofu is the BSL fork; the language is HCL2, identical to Terraform.
- Module standard: <https://opentofu.org/docs/language/modules/develop/structure/>.
- Provider versioning: <https://opentofu.org/docs/language/providers/requirements/>.
- HashiCorp's "Definition of done" for modules still applies — README, examples/, tests/, CHANGELOG.

## Module structure

```
modules/<scope>/<resource>/
├── main.tf           # primary resource graph
├── variables.tf      # typed inputs with descriptions + validation
├── outputs.tf        # outputs with descriptions
├── versions.tf       # required_providers + required_version
├── README.md         # generated from terraform-docs
├── examples/
│   └── basic/        # working consumer example
└── tests/            # OpenTofu test framework (.tftest.hcl)
```

## Core practices

- **Typed inputs.** Every variable declares `type` (`string` / `number` / `bool` / `list(string)` / `map(object({...}))` / etc.) plus `description`. Required variables omit `default`; optional variables explicitly default. Use `validation` blocks for shape constraints (`error_message` required).
- **Pinned providers.** `required_providers` block names every provider with an explicit version constraint (`~> 5.0` is acceptable; floating `>= 5.0` is not). `required_version` pins the OpenTofu CLI version range too.
- **State backend.** Pick per cloud convention. AWS: S3 + DynamoDB locking (`use_lockfile = true` with the new lockfile-based locking; DynamoDB is the legacy path). GCP: GCS with object-versioning. Azure: AzureRM with blob locking. Never commit state to git.
- **Workspaces vs separate state.** Workspaces share backend config and are awkward at scale. Prefer one state file per environment + per logical stack (matches Terragrunt composition).
- **Resource tagging.** Every cloud resource carries `workload`, `environment`, `owner`, `cost_center` tags. Tags drive cost reports + ownership routing. Use `default_tags` on the provider block for AWS to avoid copy-paste.
- **Naming.** `<workload>-<env>-<resource>` for cloud resource names. The module emits computed names; callers don't construct them.
- **Outputs.** Output what downstream stacks need. Mark sensitive outputs with `sensitive = true`. Outputs are an API contract — breaking changes need a major version bump.

## Plan / apply lifecycle

1. **PR opens.** CI runs `tofu init -backend=false` + `tofu validate` + `tofu fmt -check` + `tflint` + `checkov` (or `trivy`).
2. **Plan job.** CI runs `tofu init` + `tofu plan -out=tfplan` against the target backend. Plan output posted as PR comment.
3. **Review.** Plan is the load-bearing review artifact. Approver reads the plan, not just the HCL diff. Drift surfaces here.
4. **Merge gate.** Fab's `build-verifier` runs the plan as part of the four-phase contract. REJECT on plan errors.
5. **Apply.** Only after merge gate approval. Runs from CI with OIDC-federated cloud creds (no long-lived secrets). Records run-id + apply log in artifact bucket.
6. **Drift detection.** Scheduled `tofu plan` against `main` weekly. Drift → ticket + plan output attached.

## Provider patterns

- **AWS:** `aws` provider with `assume_role` block for cross-account. `default_tags` on every region. Pin to a known stable version; upgrade intentionally per a release-note review.
- **GCP:** `google` + `google-beta` providers. Use `impersonate_service_account` for cross-project, never key files.
- **Azure:** `azurerm` provider with `features {}` block. Subscription bound at provider level; for multi-sub stacks use provider aliases.
- **Kubernetes provider:** `kubernetes` only for substrate scaffolding (namespaces, ServiceAccounts, base CRDs). Application manifests belong in the gitops repo, not Terraform.

## Module README contract

terraform-docs generates the README. Every module ships:

- One-paragraph summary of what the module provisions.
- Usage example (HCL block calling the module).
- Inputs table: name, description, type, default, required.
- Outputs table: name, description.
- Resources table: full type list.
- Linked Providers table.

Run `terraform-docs markdown table --output-file README.md` as a pre-commit hook so README + module stay in sync.

## Common pitfalls

- **Mutable defaults.** `default = []` on a `list(string)` is fine. `default = {}` on a complex object hides required fields — prefer required + explicit empty pass.
- **`count` vs `for_each`.** `count` reorders on removal — every later resource gets destroyed and recreated. Use `for_each` with a keyed map.
- **`depends_on` over implicit deps.** OpenTofu inspects HCL for implicit dependencies; explicit `depends_on` is a smell that hides graph problems.
- **`local-exec` provisioners.** Avoid. They run only on the apply machine, not as part of the resource lifecycle. If you need procedural work, write a separate tool and wire its output via `data` sources.
- **Hardcoded ARNs / IDs.** Lookups via `data` sources or outputs, never strings. Hardcoded values break in disaster recovery.

## Output for the workflow

The merge gate consumes:

- `tofu plan` output (captured as `TRANSCRIPTS:` evidence).
- README + examples (`artifact-auditor` checks they exist and match HCL).
- CHANGELOG with version bump.

When you finish a module, report: module path, plan summary (resources to add / change / destroy), README path, example path.
