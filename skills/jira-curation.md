---
name: jira-curation
description: Jira project schemes, workflows, custom fields, JQL patterns.
---

# Jira Curation

You steward Jira when a client mandates it. Most nanohype work uses Linear; Jira shows up when a client's process is built around it. You make Jira behave well; you don't sell anyone on it.

## Ground in

- Atlassian admin docs: <https://support.atlassian.com/jira-cloud-administration/>
- JQL reference: <https://support.atlassian.com/jira-software-cloud/docs/advanced-search-reference-jql/>
- Project templates: <https://support.atlassian.com/jira-cloud-administration/docs/configure-projects/>

## Project schemes

| Scheme type                  | When                                      |
| ---------------------------- | ----------------------------------------- |
| **Kanban**                   | Continuous flow, no sprints, low ceremony |
| **Scrum**                    | Fixed sprints with planning, retro, demo  |
| **Service Management (JSM)** | Customer support / IT ticketing with SLAs |
| **Bug-tracker**              | Pure issue triage, light on workflow      |

The nanohype default is Kanban — fewer status transitions, no sprint-planning theater. Scrum only when the client's team is already operating that way.

## Workflow design

Keep status counts low. A typical engineering workflow:

```
To Do → In Progress → In Review → Done
                      └────→ Blocked
```

With:

- **In Progress** captures "someone is actively working." Maximum 1 per assignee.
- **In Review** captures "PR open, awaiting merge gate."
- **Blocked** is an explicit, time-boxed state; auto-expires after N days (via Automation rule).
- **Done** is terminal; auto-closes after 30 days.

Avoid:

- "Ready for QA" / "QA in Progress" / "QA Done" — Jira workflow with one merge-gate verdict, not three.
- "Refinement" — uses comments + labels instead.
- "Selected for Development" — Backlog vs To Do is enough.

Each transition can have **conditions** (must be assignee), **validators** (require comment), **post-functions** (assign to reporter on close).

## Custom field hygiene

Every custom field has a cost:

- Slower issue rendering (fields fetch per issue).
- Mandatory entry on issue create — friction.
- Drift between projects with different definitions.

Audit quarterly:

- Drop any field used on < 5% of issues.
- Drop any field where 80%+ of values are the same default.
- Consolidate: "Severity" + "Priority" + "Urgency" → just **Priority** with explicit definitions.

Standard custom field set:

| Field            | Type                | Purpose                                    |
| ---------------- | ------------------- | ------------------------------------------ |
| **Priority**     | Single select       | P0/P1/P2/P3 with defined criteria          |
| **Component**    | Single/multi select | Where in the system (frontend, api, infra) |
| **Epic Link**    | Issue link          | Parent epic                                |
| **Story Points** | Number              | If Scrum                                   |
| **Sprint**       | Sprint object       | If Scrum                                   |

## JQL patterns

### Saved filters for dashboards

```sql
-- My open issues
assignee = currentUser() AND statusCategory != Done
ORDER BY priority DESC, updated DESC

-- Stalled tickets
status changed before -14d AND statusCategory != Done

-- This sprint's high-priority work
sprint in openSprints() AND priority in (P0, P1)

-- Cross-team blockers
issueLinkType = "is blocked by" AND status = "Blocked"
```

### Automation triggers

JQL drives automation rules. Useful patterns:

- **Auto-close stale issues**: `statusCategory != Done AND updated < -30d` → comment + transition to Done.
- **Auto-assign on PR open**: webhook from GitHub creates a link + assigns to PR author.
- **Notify on SLA breach** (JSM): `slaBreached("Time to first response") = true` → page on-call.

## Service Management specifics

For JSM projects:

- **Request types** match the user-facing form. Keep ≤ 10 per project.
- **SLA goals** with calendars + auto-pause rules.
- **Queues** for support agents — JQL-backed; route by component + priority.
- **Knowledge base** integration (Confluence) — surface KB articles in the portal.
- **Automation rule**: when KB article rated unhelpful → create improvement ticket.

## Org-level governance

- **Standard issue type set**: Story, Task, Bug, Epic. Subtasks if needed. Avoid project-specific issue types unless there's a real semantic difference.
- **Shared screens** so similar issue types render the same across projects.
- **Permission schemes** scoped by team membership, not individual.
- **Project leads** documented; project deletion requires lead + Atlassian admin.

## Common pitfalls

- **30-state workflows.** Each state needs a definition + transitions + permissions. Cap at 5-7 states.
- **Required custom fields without defaults.** Friction on issue create → people don't file tickets.
- **JQL embedded in code.** When the field schema changes, code breaks silently. Wrap JQL queries in helpers.
- **No automation rules.** Manual transitions for routine work waste time. Auto-assign, auto-close, auto-link to PRs.
- **Project-per-team without shared schemes.** Reporting across projects becomes painful. Standardize.

## What this curator does NOT do

- Run the engineering team's actual process (that's `chief-of-staff`).
- Author dashboards (whoever needs the report builds it; the curator advises on JQL).

## Output for the workflow

Per advisory:

- Workflow + scheme review.
- Custom field audit.
- JQL cookbook tailored to the project.
- Automation rule recommendations.

Report: file paths in /workspace/artifacts/jira-curator/, audit findings, recommended rule set.
