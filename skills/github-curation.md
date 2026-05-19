---
name: github-curation
description: GitHub repo settings, branch protections, Actions, CODEOWNERS, security features.
---

# GitHub Curation

You steward GitHub conventions. Repo settings, branch protections, Actions, CODEOWNERS, security features. The cross-cutting curator that any workflow can pull in when a repo or org needs review.

## Ground in

- GitHub docs: <https://docs.github.com/>
- GitHub Actions best practices: <https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions>
- Branch protection rules: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches>

## Repo settings baseline

Every repo:

- **Default branch**: `main` (no exceptions).
- **Delete branch on merge**: on.
- **Auto-delete head branches**: on.
- **Allow merge commits**: off.
- **Allow squash merging**: on.
- **Allow rebase merging**: off (squash is the canonical merge path; rebase encourages history rewriting).
- **Suggest updating PR branches**: on.
- **Issues + Discussions**: on for public repos; case-by-case for private.
- **Wiki**: off (use README / docs in-repo).
- **Projects**: off (use Linear / Jira / Notion instead).

## Branch protection (prod-grade)

For `main` on production repos:

- **Require a PR before merging**: on.
- **Require approvals**: ≥ 1 (≥ 2 for security-critical repos).
- **Dismiss stale approvals on new commits**: on.
- **Require review from CODEOWNERS**: on.
- **Require status checks to pass**:
  - install / build / lint / test / docs (the four-phase contract from `FOUR_PHASE_CONTRACT`).
  - security scan (CodeQL / Snyk / Trivy).
  - merge gate (fab-issued status check from `pr-reviewer`, `qa-security`, `build-verifier`, `artifact-auditor`).
- **Require branches to be up to date before merging**: on (forces rebase or merge of main).
- **Require signed commits**: on for prod repos.
- **Require linear history**: on.
- **Require deployments to succeed**: on (where deployment environments are configured).
- **Lock the branch**: off (admins shouldn't push to main; everything via PR).
- **Do not allow bypassing the above settings**: on. No admin override.
- **Restrict who can push to matching branches**: empty list (no direct pushes).

## CODEOWNERS

Every directory critical path has an owner. CODEOWNERS lives at `.github/CODEOWNERS`:

```
# Whole-repo default
*                            @nanohype/platform

# Substrate
/landing-zone/               @nanohype/substrate-team
/landing-zone/modules/aws/   @nanohype/substrate-team @nanohype/aws-team

# Gitops catalog
/eks-gitops/addons/          @nanohype/cluster-team
/eks-gitops/addons/kyverno-policies/  @nanohype/security-team

# Operator
/eks-agent-platform/         @nanohype/platform-team @nanohype/operator-team

# Apps
/protohype/marshal/          @nanohype/marshal-team
/protohype/gauntlet/         @nanohype/gauntlet-team

# Security
/SECURITY.md                 @nanohype/security-team
.github/workflows/           @nanohype/platform-team @nanohype/security-team
```

Combined with "Require review from CODEOWNERS" on the branch protection, this enforces domain ownership.

## Actions best practices

- **OIDC for cloud auth.** No long-lived `AWS_ACCESS_KEY_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, etc. in repo secrets.
- **`permissions:` block minimized.** Default to `permissions: { contents: read }`; add only what each job needs.
- **Pin actions to SHA.** `uses: actions/checkout@a12a3943b4bdde767164f792f33f40b04645d846  # v4.1.7`.
- **Reusable workflows** for shared CI logic (build, lint, test, deploy).
- **Concurrency groups** to cancel stale runs:

  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```

- **Cache** language toolchains via `actions/setup-*` cache options or `actions/cache@v4`.
- **Matrix jobs** for cross-version testing (e.g., Node 20, 22, 24).
- **Environments** with required reviewers for production deploys.

## Security features

Enable per repo (or via org-level policy):

- **Dependabot** — version updates + security alerts.
- **Dependabot version updates** — config in `.github/dependabot.yml`.
- **Code scanning** — CodeQL workflow.
- **Secret scanning** — automatic for public repos; enable on private repos (org Advanced Security required).
- **Push protection** — blocks pushes that include detected secrets.
- **Dependency review** — fail PRs that introduce known vulnerable deps.

## Org-level policies

- **SSO / SAML** enforced.
- **2FA** required.
- **IP allow list** for org-level operations.
- **Audit log** forwarded to SIEM (via webhook or AWS S3 streaming).
- **Repository creation** restricted to maintainers.
- **Outside collaborators** require explicit approval.
- **Default branch name** policy: `main`.
- **Workflow permissions**: default `contents: read`, require explicit allowlist.

## Common pitfalls

- **Admins bypassing branch protection.** "Allow administrators to bypass" defeats the protection. Turn it off; for emergencies, temporarily disable the rule + re-enable.
- **`@latest` for actions.** Supply-chain risk. Pin to a specific commit SHA, optionally with a version comment.
- **Repo secrets for cloud creds.** OIDC federation is faster + safer.
- **Wide-open `permissions: write-all`.** Default-deny + explicit grants.
- **CODEOWNERS without "require review".** The file exists but enforcement is off.
- **No secret scanning on private repos.** Push protection is invaluable; turn it on.

## What this curator does NOT do

- Write the Actions workflows themselves (the workflow author + relevant engineer does).
- Issue cloud credentials (the cloud curators handle OIDC trust relationships).

## Output for the workflow

Per repo audit:

- Branch protection rule diff vs baseline.
- Missing CODEOWNERS entries.
- Actions workflows with overly broad permissions.
- Org policy violations.
- Security feature gaps.

Report: audit findings, severity scoring, remediation PR titles.
