#!/usr/bin/env node

import { AnthropicAgents } from '../api.js';
import { TEAM } from '../team.js';
import { formatEvent } from '../stream.js';
import { startRepl } from '../repl.js';
import {
  loadState,
  saveState,
  addSkill,
  clearState,
  clearSkills,
  getAgentByRole,
  getEnvironmentId,
  getRepos,
  addRepo,
  removeRepo,
  getMemoryConfig,
  setMemoryConfig,
  getJournalConfig,
  setJournalConfig,
  getModelOverrides,
  setModelOverride,
  clearModelOverride,
  getSprintConfig,
  setSprintConfig,
  clearSprint,
  addSprintItem,
  getVaultIds,
  addVaultId,
  removeVaultId,
  getBudgetLimit,
  setBudgetLimit,
} from '../state.js';
import { getAllSkillDefs, getSkillDef, loadSkillContent, previewSkillContent, resolveNanohypePath } from '../skills.js';
import { resolveMcpServers } from '../mcp.js';
import { buildSystemPrompt } from '../prompts.js';
import { getWorkflow, listWorkflows, executeWorkflow, reviseWorkflow, streamWithAdvisor } from '../workflows.js';
import { resolveRuntimeKind } from '../runtimes/index.js';
import { ADVISOR_TOOL, hasAdvisorAccess } from '../advisor.js';
import { aggregateUsage, formatUsageReport } from '../usage.js';
import { loadPerf, formatPerfReport } from '../perf.js';
import { deliverResult } from '../webhook.js';
import type {
  AgentCreateParams,
  GateResult,
  GitRepoResource,
  Session,
  SkillReference,
  SprintConfig,
  TeamRole,
} from '../types.js';

// ── Arg parsing ─────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  sub: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = { command: '', sub: '', positional: [], flags: {} };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result.flags[key] = args[++i];
      } else {
        result.flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result.flags[key] = args[++i];
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else if (!result.sub) {
      result.sub = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────

function requireKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set');
    process.exit(1);
  }
  return key;
}

/**
 * Construct the Managed Agents client. In managed-agents mode the API key
 * is mandatory — the client is exercised against the REST API. In local /
 * claude-cli mode the client is constructed but never invoked (the
 * runtimes don't touch the REST API), so a missing key is acceptable.
 * Returning a placeholder here lets `executeWorkflow`'s `createRuntime(api)`
 * call accept the same argument shape across all three runtimes.
 */
function client(): AnthropicAgents {
  const kind = resolveRuntimeKind();
  if (kind === 'managed-agents') {
    return new AnthropicAgents(requireKey());
  }
  const key = process.env.ANTHROPIC_API_KEY ?? 'unused-in-non-managed-runtime';
  return new AnthropicAgents(key);
}

async function createSession(api: AnthropicAgents, agentId: string, title?: string): Promise<Session> {
  const envId = await getEnvironmentId();
  if (!envId) {
    console.error('No environment configured. Run: fab deploy');
    process.exit(1);
  }
  const repos = await getRepos();
  const vaults = await getVaultIds();
  return api.createSession({
    agent: agentId,
    environment_id: envId,
    ...(title && { title }),
    ...(repos.length > 0 && { resources: repos }),
    ...(vaults.length > 0 && { vault_ids: vaults }),
  });
}

/**
 * Deploy a single agent. Updates if the role exists in state, creates if it doesn't.
 * Errors if an existing agent ID can't be found on the platform — never silently creates a duplicate.
 */
async function deployAgent(
  api: AnthropicAgents,
  state: import('../types.js').FabState,
  role: TeamRole,
  params: AgentCreateParams,
): Promise<import('../types.js').Agent> {
  const existing = state.agents.find((a) => a.role === role);

  if (existing) {
    // Fetch live version — don't trust stale state
    const live = await api.getAgent(existing.agentId);
    const agent = await api.updateAgent(existing.agentId, live.version, params);
    console.log(`  ${padRole(role)} ${agent.id} (updated v${agent.version})`);
    return agent;
  }

  // No existing agent in state — require --allow-create flag
  if (!deployAllowCreate) {
    console.error(`  ${padRole(role)} NOT FOUND in state — skipping (use --allow-create to create new agents)`);
    throw new Error(`Agent ${role} not in state. Use --allow-create to create.`);
  }
  const agent = await api.createAgent(params);
  console.log(`  ${padRole(role)} ${agent.id} (created)`);
  return agent;
}

// ── Commands ────────────────────────────────────────────────────────

function advisorToolsFor(role: import('../types.js').TeamRole): [typeof ADVISOR_TOOL] | [] {
  return hasAdvisorAccess(role) ? [ADVISOR_TOOL] : [];
}

let deployAllowCreate = false;

async function deploy(args: ParsedArgs): Promise<void> {
  const dryRun = !!args.flags['dry-run'];
  const api = dryRun ? null : client();
  const skipSkills = !!args.flags['skip-skills'];
  const fastMode = !!args.flags['fast'];
  deployAllowCreate = !!args.flags['allow-create'];
  const nanohypePath = resolveNanohypePath(
    typeof args.flags['nanohype-path'] === 'string' ? args.flags['nanohype-path'] : undefined,
  );

  if (dryRun) {
    console.log('DRY RUN — printing payloads, nothing will be sent\n');
  } else {
    console.log('Deploying fab...\n');
  }

  // Reuse existing environment or create one
  const state = await loadState();
  const overrides = state.modelOverrides;

  if (!dryRun) {
    if (state.environmentId) {
      try {
        await api!.getEnvironment(state.environmentId);
        console.log(`  environment:    ${state.environmentId} (existing)\n`);
      } catch {
        // Environment was deleted — create new
        const env = await api!.createEnvironment({
          name: `fab-${Date.now()}`,
          config: {
            type: 'cloud',
            networking: { type: 'unrestricted' },
            packages: { npm: ['typescript', '@nanohype/sdk'], pip: ['pandas'] },
          },
        });
        state.environmentId = env.id;
        console.log(`  environment:    ${env.id} (created)\n`);
      }
    } else {
      const env = await api!.createEnvironment({
        name: `fab-${Date.now()}`,
        config: {
          type: 'cloud',
          networking: { type: 'unrestricted' },
          packages: { npm: ['typescript', '@nanohype/sdk'], pip: ['pandas'] },
        },
      });
      state.environmentId = env.id;
      console.log(`  environment:    ${env.id} (created)\n`);
    }
  }

  // Upload skills (unless skipped)
  const skillRefs: Record<string, SkillReference> = {};
  const failedSkills: string[] = [];
  if (!skipSkills) {
    if (dryRun) console.log('── Skills ──\n');
    else console.log('  uploading skills...');

    for (const [role, def] of getAllSkillDefs()) {
      const { content, referenceFiles } = await loadSkillContent(role, nanohypePath);
      const skillPayload = {
        name: def.name,
        description: def.description,
        content,
        reference_files: referenceFiles.length > 0 ? referenceFiles : undefined,
      };

      if (dryRun) {
        const existingId = state.skillIds[role];
        console.log(`${role}:${existingId ? ` (update ${existingId})` : ' (create)'}`);
        console.log(JSON.stringify(skillPayload, null, 2));
        console.log('');
      } else {
        try {
          const existingId = state.skillIds[role];
          if (existingId) {
            // Verify skill exists, then create a new version
            await api!.getSkill(existingId);
            await api!.updateSkillVersion(existingId, skillPayload);
            skillRefs[role] = { type: 'custom', skill_id: existingId, version: 'latest' };
            console.log(`  ${padRole(role)} skill:${existingId} (updated)`);
          } else {
            // Create new skill
            const skill = await api!.createSkill(skillPayload);
            state.skillIds[role] = skill.id;
            skillRefs[role] = { type: 'custom', skill_id: skill.id, version: 'latest' };
            console.log(`  ${padRole(role)} skill:${skill.id} (created)`);
          }
        } catch (err) {
          failedSkills.push(role);
          console.error(`  ${padRole(role)} skill failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (!dryRun) console.log('');
  }

  // Deploy agents — create or update (idempotent)
  if (dryRun) console.log('── Agents ──\n');

  for (const member of TEAM) {
    const { servers, tools } = resolveMcpServers(member.mcpServers);
    const skills: SkillReference[] = [];
    if (skillRefs[member.role]) skills.push(skillRefs[member.role]);

    const modelId = overrides[member.role] ?? member.model;
    const params: AgentCreateParams = {
      name: member.name,
      model: fastMode ? { id: modelId, speed: 'fast' } : modelId,
      description: member.description,
      system: buildSystemPrompt(member, state),
      mcp_servers: servers,
      tools: [
        {
          type: 'agent_toolset_20260401',
          default_config: {
            enabled: true,
            permission_policy: { type: 'always_allow' },
          },
        },
        ...tools,
        ...advisorToolsFor(member.role),
      ],
      ...(skills.length > 0 && { skills }),
      metadata: { fab_role: member.role },
    };

    if (dryRun) {
      const existing = state.agents.find((a) => a.role === member.role);
      console.log(`${member.role}:${existing ? ` (update ${existing.agentId} v${existing.version})` : ' (create)'}`);
      console.log(JSON.stringify(params, null, 2));
      console.log('');
    } else {
      const agent = await deployAgent(api!, state, member.role, params);
      state.agents = state.agents.filter((a) => a.role !== member.role);
      state.agents.push({
        role: member.role,
        agentId: agent.id,
        version: agent.version,
        deployedAt: agent.updated_at ?? agent.created_at,
      });
    }
  }

  if (dryRun) {
    console.log('\n── Done (dry run) ──');
    return;
  }

  // Single state write for the entire deploy
  await saveState(state);

  const skillCount = Object.keys(skillRefs).length;
  console.log(`\nDeployed — ${state.agents.length} agents, ${skillCount} skills`);
  if (failedSkills.length > 0) {
    console.error(`\nWARNING: ${failedSkills.length} skills failed to upload: ${failedSkills.join(', ')}`);
    console.error('These agents were deployed without their domain skills.');
    process.exit(1);
  }
}

async function status(): Promise<void> {
  const state = await loadState();
  if (state.agents.length === 0) {
    console.log('No fab deployed. Run: fab deploy');
    return;
  }

  const api = client();
  const roleW = Math.max(...state.agents.map((a) => a.role.length));

  console.log(`${'ROLE'.padEnd(roleW)}  ${'AGENT ID'.padEnd(30)}  STATUS`);
  for (const entry of state.agents) {
    try {
      const agent = await api.getAgent(entry.agentId);
      const archived = agent.archived_at ? 'archived' : 'active';
      console.log(`${entry.role.padEnd(roleW)}  ${entry.agentId.padEnd(30)}  ${archived}`);
    } catch {
      console.log(`${entry.role.padEnd(roleW)}  ${entry.agentId.padEnd(30)}  unreachable`);
    }
  }
}

async function teardown(): Promise<void> {
  const state = await loadState();
  if (state.agents.length === 0) {
    console.log('No fab deployed.');
    return;
  }

  const api = client();
  console.log('Archiving fab...\n');

  for (const entry of state.agents) {
    try {
      await api.archiveAgent(entry.agentId);
      console.log(`  archived ${entry.role} (${entry.agentId})`);
    } catch (err) {
      console.error(`  failed ${entry.role}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await clearState();
  console.log('\nArchived.');
}

async function session(args: ParsedArgs): Promise<void> {
  const roleName = args.sub || args.positional[0];
  if (!roleName) {
    console.error('Usage: fab session <role> [--title "..."]');
    console.error(
      'Common roles: intake-analyst, product, design-lead, react-engineer, agent-engineer, pr-reviewer, release-manager',
    );
    process.exit(1);
  }

  const entry = await getAgentByRole(roleName as TeamRole);
  if (!entry) {
    console.error(`No deployed agent for role: ${roleName}`);
    console.error('Run: fab deploy');
    process.exit(1);
    return;
  }

  const api = client();
  const title = typeof args.flags.title === 'string' ? args.flags.title : undefined;
  const sess = await createSession(api, entry.agentId, title);
  console.log(`Session created: ${sess.id}`);
  console.log(`Agent: ${entry.role} (${entry.agentId})`);
  console.log(`Status: ${sess.status}`);
}

async function send(args: ParsedArgs): Promise<void> {
  const sessionId = args.sub;
  const message = args.positional.join(' ');
  if (!sessionId || !message) {
    console.error('Usage: fab send <session-id> <message...>');
    process.exit(1);
  }

  const api = client();
  await api.sendMessage(sessionId, message);
  console.log('Message sent. Streaming response...\n');
  await streamWithAdvisor(api, sessionId);
}

async function stream(args: ParsedArgs): Promise<void> {
  const sessionId = args.sub;
  if (!sessionId) {
    console.error('Usage: fab stream <session-id>');
    process.exit(1);
  }

  const api = client();
  console.log(`Streaming session ${sessionId}...\n`);
  await streamWithAdvisor(api, sessionId);
}

async function events(args: ParsedArgs): Promise<void> {
  const sessionId = args.sub;
  if (!sessionId) {
    console.error('Usage: fab events <session-id>');
    process.exit(1);
  }

  const api = client();
  const result = await api.listEvents(sessionId);

  for (const event of result.data) {
    const formatted = formatEvent(event);
    if (formatted) console.log(formatted);
  }
}

async function threads(args: ParsedArgs): Promise<void> {
  const sessionId = args.sub;
  if (!sessionId) {
    console.error('Usage: fab threads <session-id>');
    process.exit(1);
  }

  const api = client();
  const result = await api.listThreads(sessionId);

  if (result.data.length === 0) {
    console.log('No threads.');
    return;
  }

  for (const thread of result.data) {
    console.log(`${thread.id}  agent:${thread.agent_id}  ${thread.status}`);
  }
}

async function listSessions(): Promise<void> {
  const api = client();
  const result = await api.listSessions();

  if (result.data.length === 0) {
    console.log('No sessions.');
    return;
  }

  const idW = Math.max(10, ...result.data.map((s) => s.id.length));
  console.log(`${'SESSION ID'.padEnd(idW)}  ${'STATUS'.padEnd(12)}  ${'AGENT'.padEnd(20)}  TITLE`);
  for (const s of result.data) {
    console.log(`${s.id.padEnd(idW)}  ${s.status.padEnd(12)}  ${(s.agent?.name ?? '?').padEnd(20)}  ${s.title ?? ''}`);
  }
}

async function listAgents(): Promise<void> {
  const api = client();
  const result = await api.listAgents();

  if (result.data.length === 0) {
    console.log('No agents.');
    return;
  }

  const idW = Math.max(8, ...result.data.map((a) => a.id.length));
  const nameW = Math.max(4, ...result.data.map((a) => a.name.length));
  console.log(`${'AGENT ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  ${'MODEL'.padEnd(20)}  VER`);
  for (const a of result.data) {
    console.log(`${a.id.padEnd(idW)}  ${a.name.padEnd(nameW)}  ${a.model.id.padEnd(20)}  ${a.version}`);
  }
}

// ── Adopt command ───────────────────────────────────────────────────

async function adopt(args: ParsedArgs): Promise<void> {
  const agentId = args.sub;
  const role = args.positional[0] as TeamRole | undefined;

  if (!agentId || !role) {
    console.error('Usage: fab adopt <agent-id> <role>');
    process.exit(1);
    return;
  }

  // Verify the agent exists on the platform
  const api = client();
  const agent = await api.getAgent(agentId);

  const state = await loadState();
  state.agents = state.agents.filter((a) => a.role !== role);
  state.agents.push({
    role,
    agentId: agent.id,
    version: agent.version,
    deployedAt: agent.created_at,
  });
  await saveState(state);

  console.log(`Adopted ${agent.name ?? agent.id} as ${role} (v${agent.version})`);
  console.log('Next deploy will update this agent with fab config.');
}

// ── Standup command ─────────────────────────────────────────────────

async function standup(args: ParsedArgs): Promise<void> {
  const api = client();

  // Route through chief-of-staff for cross-team rollup; fall back to --session
  // when the caller wants to continue an existing rollup thread.
  let sessionId = typeof args.flags.session === 'string' ? args.flags.session : undefined;

  if (!sessionId) {
    const entry = await getAgentByRole('chief-of-staff');
    if (!entry) {
      console.error('No deployed chief-of-staff. Run: fab deploy');
      process.exit(1);
      return;
    }
    const sess = await createSession(api, entry.agentId, 'standup');
    sessionId = sess.id;
  }

  const standupPrompt = `Run a team standup. Query each of your team members and compile a unified status report.

For each team member, ask them:
1. What are you currently working on?
2. What's blocked or needs attention?
3. What do you need from other team members?

Format the report as a structured standup with each role as a section. Be concise — bullet points, not paragraphs.`;

  console.log('Running standup...\n');
  await api.sendMessage(sessionId, standupPrompt);
  await streamWithAdvisor(api, sessionId);
}

// ── Usage command ───────────────────────────────────────────────────

async function usage(args: ParsedArgs): Promise<void> {
  const api = client();
  const state = await loadState();

  let since: Date | undefined;
  const sinceStr = typeof args.flags.since === 'string' ? args.flags.since : undefined;
  if (sinceStr) {
    since = new Date(sinceStr);
    if (isNaN(since.getTime())) {
      console.error(`Invalid date: ${sinceStr}`);
      process.exit(1);
    }
  }

  const report = await aggregateUsage(api, state, since);
  console.log(formatUsageReport(report, sinceStr));
}

// ── Workflow commands ───────────────────────────────────────────────

async function workflow(args: ParsedArgs): Promise<void> {
  const name = args.sub;
  const prompt = args.positional.join(' ');

  if (!name || !prompt) {
    console.error('Usage: fab workflow <name> <prompt...>');
    console.error(`\nAvailable workflows:`);
    for (const w of listWorkflows()) {
      console.error(`  ${w.name.padEnd(20)} ${w.description}`);
    }
    process.exit(1);
  }

  const wf = getWorkflow(name);
  if (!wf) {
    console.error(`Unknown workflow: ${name}`);
    console.error(
      `Available: ${listWorkflows()
        .map((w) => w.name)
        .join(', ')}`,
    );
    process.exit(1);
    return;
  }

  // Workflows run through their per-phase multiagent sessions (workflows.ts
  // owns the routing). The CLI-side session here only exists for the optional
  // `--session` continuation flag — if the caller wants to keep the previous
  // workflow's session alive across invocations.
  const sessionId = typeof args.flags.session === 'string' ? args.flags.session : undefined;

  // ── Intake analysis gate ────────────────────────────────────────
  const skipIntake = !!args.flags['skip-intake'];
  let enrichedPrompt = prompt;

  if (!skipIntake) {
    const intakeEntry = await getAgentByRole('intake-analyst');
    if (intakeEntry) {
      const api = client();
      console.log(`\x1b[2mRunning intake analysis...\x1b[0m\n`);
      const intakeSess = await createSession(api, intakeEntry.agentId, `intake: ${name}`);
      await api.sendMessage(
        intakeSess.id,
        `Validate and enrich this intake for the "${name}" workflow. Return the validated intake as a structured block downstream phases can parse directly.\n\nINTAKE:\n${prompt}`,
      );
      const intakeOutput = await streamWithAdvisor(api, intakeSess.id);
      if (intakeOutput.trim()) {
        enrichedPrompt = `INTAKE ANALYSIS (from intake-analyst):\n${intakeOutput}\n\nORIGINAL INTAKE:\n${prompt}`;
      }
    }
  }

  const noGates = !!args.flags['no-gates'];
  const sequential = !!args.flags.sequential;

  const onGate = noGates
    ? undefined
    : async (_step: import('../workflows.js').WorkflowStep, _idx: number, _output: string): Promise<GateResult> => {
        const rl = await import('node:readline');
        const iface = rl.createInterface({ input: process.stdin, output: process.stderr });
        return new Promise((resolve) => {
          iface.question('[a]pprove / [r]evise / re[j]ect > ', (answer) => {
            iface.close();
            const a = answer.trim().toLowerCase();
            if (a === 'r' || a === 'revise') {
              const rl2 = rl.createInterface({ input: process.stdin, output: process.stderr });
              rl2.question('Revision feedback: ', (fb) => {
                rl2.close();
                resolve({ decision: 'revise', feedback: fb.trim() });
              });
            } else if (a === 'j' || a === 'reject') {
              resolve({ decision: 'reject' });
            } else {
              resolve({ decision: 'approve' });
            }
          });
        });
      };

  await executeWorkflow(client(), sessionId ?? '', wf, enrichedPrompt, { onGate, noGates, sequential });
  if (sessionId) console.log(`\nSession: ${sessionId}`);
}

async function workflows(): Promise<void> {
  const wfs = listWorkflows();
  const nameW = Math.max(4, ...wfs.map((w) => w.name.length));
  console.log(`${'NAME'.padEnd(nameW)}  DESCRIPTION`);
  for (const w of wfs) {
    console.log(`${w.name.padEnd(nameW)}  ${w.description}`);
  }
}

// ── Chat REPL ──────────────────────────────────────────────────────

async function chat(args: ParsedArgs): Promise<void> {
  const roleName = args.sub || args.positional[0];
  if (!roleName) {
    console.error('Usage: fab chat <role> [--session <id>] [--title "..."]');
    process.exit(1);
  }

  const api = client();
  const role = roleName as TeamRole;
  let sessionId = typeof args.flags.session === 'string' ? args.flags.session : undefined;

  if (!sessionId) {
    const entry = await getAgentByRole(role);
    if (!entry) {
      console.error(`No deployed agent for role: ${role}\nRun: fab deploy`);
      process.exit(1);
      return;
    }
    const title = typeof args.flags.title === 'string' ? args.flags.title : undefined;
    const sess = await createSession(api, entry.agentId, title);
    sessionId = sess.id;
  }

  await startRepl({
    api,
    sessionId,
    role,
    onSwitch: async (newRole: TeamRole) => {
      const entry = await getAgentByRole(newRole);
      if (!entry) throw new Error(`No deployed agent for role: ${newRole}`);
      const sess = await createSession(api, entry.agentId);
      return { sessionId: sess.id };
    },
  });
}

// ── Skills commands ─────────────────────────────────────────────────

async function skills(args: ParsedArgs): Promise<void> {
  const sub = args.sub;

  switch (sub) {
    case 'upload':
      await skillsUpload(args);
      break;
    case 'show':
      await skillsShow(args);
      break;
    case 'teardown':
      await skillsTeardown();
      break;
    default:
      await skillsList();
  }
}

async function skillsList(): Promise<void> {
  const api = client();
  const result = await api.listSkills();

  if (result.data.length === 0) {
    console.log('No skills uploaded.');
    return;
  }

  const idW = Math.max(8, ...result.data.map((s) => s.id.length));
  const nameW = Math.max(4, ...result.data.map((s) => s.name.length));
  console.log(`${'SKILL ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  VER`);
  for (const s of result.data) {
    console.log(`${s.id.padEnd(idW)}  ${s.name.padEnd(nameW)}  ${s.version}`);
  }
}

async function skillsUpload(args: ParsedArgs): Promise<void> {
  const api = client();
  const nanohypePath = resolveNanohypePath(
    typeof args.flags['nanohype-path'] === 'string' ? args.flags['nanohype-path'] : undefined,
  );

  const target = args.positional[0];
  const all = !!args.flags.all;

  if (!target && !all) {
    console.error('Usage: fab skills upload <role> [--nanohype-path ...]\n       fab skills upload --all');
    process.exit(1);
  }

  const roles = all ? getAllSkillDefs().map(([role]) => role) : [target as TeamRole];

  for (const role of roles) {
    const def = getSkillDef(role);
    if (!def) {
      console.error(`Unknown role: ${role}`);
      continue;
    }

    const { content, referenceFiles } = await loadSkillContent(role, nanohypePath);
    const skill = await api.createSkill({
      name: def.name,
      description: def.description,
      content,
      reference_files: referenceFiles.length > 0 ? referenceFiles : undefined,
    });
    await addSkill(role, skill.id);
    console.log(`${padRole(role)} ${skill.id}`);
  }
}

async function skillsShow(args: ParsedArgs): Promise<void> {
  const role = args.positional[0] as TeamRole | undefined;
  if (!role) {
    console.error('Usage: fab skills show <role>');
    process.exit(1);
  }

  const def = getSkillDef(role);
  if (!def) {
    console.error(`Unknown role: ${role}`);
    process.exit(1);
  }

  const nanohypePath = resolveNanohypePath(
    typeof args.flags['nanohype-path'] === 'string' ? args.flags['nanohype-path'] : undefined,
  );

  const content = await previewSkillContent(role, nanohypePath);
  console.log(content);
}

async function skillsTeardown(): Promise<void> {
  const state = await loadState();
  const ids = Object.entries(state.skillIds);

  if (ids.length === 0) {
    console.log('No skills deployed.');
    return;
  }

  const api = client();
  for (const [role, id] of ids) {
    try {
      await api.archiveSkill(id);
      console.log(`  archived ${role} skill (${id})`);
    } catch (err) {
      console.error(`  failed ${role}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await clearSkills();
  console.log('\nSkills archived.');
}

// ── Memory command ──────────────────────────────────────────────────

async function memory(args: ParsedArgs): Promise<void> {
  if (args.flags.disable) {
    await setMemoryConfig({ enabled: false });
    console.log('Company memory disabled.');
  } else if (args.flags.enable) {
    await setMemoryConfig({ enabled: true });
    console.log('Company memory enabled.');
  } else if (typeof args.flags.path === 'string') {
    await setMemoryConfig({ path: args.flags.path });
    console.log(`Memory path: ${args.flags.path}`);
  } else {
    const config = await getMemoryConfig();
    console.log(`Company memory: ${config.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Path: ${config.path}`);
  }
}

// ── Journal command ─────────────────────────────────────────────────

async function journal(args: ParsedArgs): Promise<void> {
  if (args.flags.disable) {
    await setJournalConfig({ enabled: false });
    console.log('Agent journals disabled.');
  } else if (args.flags.enable) {
    await setJournalConfig({ enabled: true });
    console.log('Agent journals enabled.');
  } else if (typeof args.flags.path === 'string') {
    await setJournalConfig({ basePath: args.flags.path });
    console.log(`Journal base path: ${args.flags.path}`);
  } else {
    const config = await getJournalConfig();
    console.log(`Agent journals: ${config.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Base path: ${config.basePath}`);
  }
}

// ── Repo command ────────────────────────────────────────────────────

async function repo(args: ParsedArgs): Promise<void> {
  const sub = args.sub;

  if (sub === 'add') {
    const url = args.positional[0];
    const token = typeof args.flags.token === 'string' ? args.flags.token : process.env.GITHUB_TOKEN;
    if (!url || !token) {
      console.error('Usage: fab repo add <github-url> --token <github-pat> [--branch <branch>] [--path <mount-path>]');
      console.error('Or set GITHUB_TOKEN env var.');
      process.exit(1);
    }
    const branch = typeof args.flags.branch === 'string' ? args.flags.branch : undefined;
    const mountPath = typeof args.flags.path === 'string' ? args.flags.path : undefined;
    const resource: GitRepoResource = {
      type: 'github_repository',
      url,
      authorization_token: token,
      ...(mountPath && { mount_path: mountPath }),
      ...(branch && { checkout: { type: 'branch', name: branch } }),
    };
    await addRepo(resource);
    console.log(`Added: ${url}${mountPath ? ` → ${mountPath}` : ''}${branch ? ` (${branch})` : ''}`);
  } else if (sub === 'remove') {
    const url = args.positional[0];
    if (!url) {
      console.error('Usage: fab repo remove <github-url>');
      process.exit(1);
    }
    await removeRepo(url);
    console.log(`Removed: ${url}`);
  } else {
    const repos = await getRepos();
    if (repos.length === 0) {
      console.log('No repos configured. Run: fab repo add <github-url>');
      return;
    }
    for (const r of repos) {
      const branch = r.checkout ? ` (${r.checkout.name})` : '';
      console.log(`${r.url} → ${r.mount_path}${branch}`);
    }
  }
}

// ── Vault command ───────────────────────────────────────────────────

async function vault(args: ParsedArgs): Promise<void> {
  const sub = args.sub;

  if (sub === 'setup') {
    await vaultSetup();
  } else if (sub === 'add') {
    const id = args.positional[0];
    if (!id) {
      console.error('Usage: fab vault add <vault-id>');
      process.exit(1);
    }
    await addVaultId(id);
    console.log(`Added vault: ${id}`);
  } else if (sub === 'remove') {
    const id = args.positional[0];
    if (!id) {
      console.error('Usage: fab vault remove <vault-id>');
      process.exit(1);
    }
    await removeVaultId(id);
    console.log(`Removed vault: ${id}`);
  } else {
    const vaults = await getVaultIds();
    if (vaults.length === 0) {
      console.log('No vaults configured. Run: fab vault setup');
      return;
    }
    for (const v of vaults) {
      console.log(`  ${v}`);
    }
  }
}

async function vaultSetup(): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  // Read .env.vault.local
  const envPath = join(process.cwd(), '.env.vault.local');
  let envContent: string;
  try {
    envContent = await readFile(envPath, 'utf-8');
  } catch {
    console.error('No .env.vault.local found. Copy .env.vault to .env.vault.local and fill in your tokens.');
    console.error('See docs/VAULT_SETUP.md for instructions.');
    process.exit(1);
    return;
  }

  // Parse env file
  const env: Record<string, string> = {};
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val) env[key] = val;
  }

  const api = client();
  const { getRegistry } = await import('../mcp.js');
  const registry = getRegistry();

  // Create vault
  const vaultName = env.VAULT_NAME || 'fab';
  console.log(`Creating vault: ${vaultName}\n`);
  const vault = await api.createVault(vaultName);
  console.log(`  vault: ${vault.id}\n`);

  // Add to state
  await addVaultId(vault.id);

  // ── Static bearer credentials ──────────────────────────────────
  // Only third-party MCP servers (direct URLs). Gateway-routed services
  // (hubspot, gdrive, analytics, gcalendar, gcse, stripe) authenticate via
  // the gateway bearer in mcp.ts headers — their service-level credentials
  // live in the mcp-gateway's Secrets Manager, not in this vault.
  const credentials: { name: string; serverName: string; token: string }[] = [];

  if (env.GITHUB_TOKEN) credentials.push({ name: 'GitHub', serverName: 'github', token: env.GITHUB_TOKEN });
  if (env.LINEAR_API_KEY) credentials.push({ name: 'Linear', serverName: 'linear', token: env.LINEAR_API_KEY });
  if (env.SENTRY_AUTH_TOKEN) credentials.push({ name: 'Sentry', serverName: 'sentry', token: env.SENTRY_AUTH_TOKEN });
  if (env.FIGMA_TOKEN) credentials.push({ name: 'Figma', serverName: 'figma', token: env.FIGMA_TOKEN });
  if (env.HUNTER_API_KEY) credentials.push({ name: 'Hunter', serverName: 'hunter', token: env.HUNTER_API_KEY });

  for (const cred of credentials) {
    const serverDef = registry[cred.serverName];
    if (!serverDef) continue;
    try {
      const result = await api.createCredential(vault.id, cred.name, {
        type: 'static_bearer',
        mcp_server_url: serverDef.defaultUrl,
        token: cred.token,
      });
      console.log(`  ${cred.name.padEnd(15)} ${result.id}`);
    } catch (err) {
      console.error(`  ${cred.name.padEnd(15)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Notion (OAuth required) ───────────────────────────────────
  if (env.NOTION_OAUTH_ACCESS_TOKEN) {
    const notionDef = registry.notion;
    if (notionDef) {
      try {
        if (env.NOTION_OAUTH_REFRESH_TOKEN && env.NOTION_OAUTH_CLIENT_ID && env.NOTION_OAUTH_CLIENT_SECRET) {
          const result = await api.createCredential(vault.id, 'Notion', {
            type: 'mcp_oauth',
            mcp_server_url: notionDef.defaultUrl,
            access_token: env.NOTION_OAUTH_ACCESS_TOKEN,
            refresh: {
              token_endpoint: 'https://api.notion.com/v1/oauth/token',
              client_id: env.NOTION_OAUTH_CLIENT_ID,
              scope: env.NOTION_OAUTH_SCOPES || 'notion',
              refresh_token: env.NOTION_OAUTH_REFRESH_TOKEN,
              token_endpoint_auth: { type: 'client_secret_basic', client_secret: env.NOTION_OAUTH_CLIENT_SECRET },
            },
          });
          console.log(`  ${'Notion (OAuth)'.padEnd(15)} ${result.id}`);
        } else {
          const result = await api.createCredential(vault.id, 'Notion', {
            type: 'static_bearer',
            mcp_server_url: notionDef.defaultUrl,
            token: env.NOTION_OAUTH_ACCESS_TOKEN,
          });
          console.log(`  ${'Notion'.padEnd(15)} ${result.id}`);
        }
      } catch (err) {
        console.error(`  ${'Notion'.padEnd(15)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Slack (OAuth required) ────────────────────────────────────
  if (env.SLACK_ACCESS_TOKEN) {
    const slackDef = registry.slack;
    if (slackDef) {
      try {
        if (env.SLACK_REFRESH_TOKEN && env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET) {
          const result = await api.createCredential(vault.id, 'Slack', {
            type: 'mcp_oauth',
            mcp_server_url: slackDef.defaultUrl,
            access_token: env.SLACK_ACCESS_TOKEN,
            refresh: {
              token_endpoint: 'https://slack.com/api/oauth.v2.access',
              client_id: env.SLACK_CLIENT_ID,
              scope:
                env.SLACK_SCOPES ||
                'identify,users:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,search:read,chat:write,files:read,files:write',
              refresh_token: env.SLACK_REFRESH_TOKEN,
              token_endpoint_auth: { type: 'client_secret_post', client_secret: env.SLACK_CLIENT_SECRET },
            },
          });
          console.log(`  ${'Slack (OAuth)'.padEnd(15)} ${result.id}`);
        } else {
          const result = await api.createCredential(vault.id, 'Slack', {
            type: 'static_bearer',
            mcp_server_url: slackDef.defaultUrl,
            token: env.SLACK_ACCESS_TOKEN,
          });
          console.log(`  ${'Slack'.padEnd(15)} ${result.id}`);
        }
      } catch (err) {
        console.error(`  ${'Slack'.padEnd(15)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── MCP Gateway (shared bearer across switchboard + memory) ───
  // Same token authorizes every gateway-hosted MCP URL. We create one
  // static_bearer credential per service URL so the vault can inject
  // Authorization: Bearer <token> when agents call each server.
  const gatewayBase = env.MCP_GATEWAY_BASE_URL || process.env.MCP_GATEWAY_BASE_URL;
  const gatewayToken = env.MCP_GATEWAY_TOKEN || process.env.MCP_GATEWAY_TOKEN;
  if (gatewayBase && gatewayToken) {
    const services: { label: string; url: string }[] = [
      { label: 'Gateway hubspot', url: `${gatewayBase}/mcp/hubspot` },
      { label: 'Gateway gdrive', url: `${gatewayBase}/mcp/gdrive` },
      { label: 'Gateway analytics', url: `${gatewayBase}/mcp/analytics` },
      { label: 'Gateway gcal', url: `${gatewayBase}/mcp/gcal` },
      { label: 'Gateway gcse', url: `${gatewayBase}/mcp/gcse` },
      { label: 'Gateway stripe', url: `${gatewayBase}/mcp/stripe` },
      { label: 'Gateway memory', url: `${gatewayBase}/memory` },
    ];
    for (const svc of services) {
      try {
        const result = await api.createCredential(vault.id, svc.label, {
          type: 'static_bearer',
          mcp_server_url: svc.url,
          token: gatewayToken,
        });
        console.log(`  ${svc.label.padEnd(20)} ${result.id}`);
      } catch (err) {
        console.error(`  ${svc.label.padEnd(20)} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`\nVault ${vault.id} configured. Sessions will use it automatically.`);
}

// ── Model command ───────────────────────────────────────────────────

async function model(args: ParsedArgs): Promise<void> {
  const sub = args.sub;

  if (sub === 'set') {
    const role = args.positional[0] as TeamRole;
    const modelId = args.positional[1];
    if (!role || !modelId) {
      console.error('Usage: fab model set <role> <model-id>');
      process.exit(1);
    }
    await setModelOverride(role, modelId);
    console.log(`${role} → ${modelId}`);
  } else if (sub === 'clear') {
    const role = args.positional[0] as TeamRole;
    if (!role) {
      console.error('Usage: fab model clear <role>');
      process.exit(1);
    }
    await clearModelOverride(role);
    console.log(`${role} → default`);
  } else {
    const overrides = await getModelOverrides();
    const roleW = 18;
    console.log(`${'ROLE'.padEnd(roleW)}  MODEL`);
    for (const member of TEAM) {
      const model = overrides[member.role] ?? member.model;
      const tag = overrides[member.role] ? ' (override)' : '';
      console.log(`${member.role.padEnd(roleW)}  ${model}${tag}`);
    }
  }
}

// ── Perf command ────────────────────────────────────────────────────

async function perf(): Promise<void> {
  const data = await loadPerf();
  console.log(formatPerfReport(data));
}

// ── Budget command ──────────────────────────────────────────────────

async function budget(args: ParsedArgs): Promise<void> {
  const sub = args.sub;

  if (sub === 'set') {
    const val = parseFloat(args.positional[0]);
    if (isNaN(val) || val <= 0) {
      console.error('Usage: fab budget set <dollars>');
      process.exit(1);
    }
    await setBudgetLimit(val);
    console.log(`Budget limit: $${val.toFixed(2)} per session`);
  } else if (sub === 'clear') {
    await setBudgetLimit(null);
    console.log('Budget limit: unlimited');
  } else {
    const limit = await getBudgetLimit();
    console.log(`Budget limit: ${limit !== null ? '$' + limit.toFixed(2) + ' per session' : 'unlimited'}`);
  }
}

// ── Export command ──────────────────────────────────────────────────

async function exportSession(args: ParsedArgs): Promise<void> {
  const sessionId = args.sub;
  if (!sessionId) {
    console.error('Usage: fab export <session-id> [--output <dir>]');
    process.exit(1);
  }

  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');

  const api = client();
  const outputDir = typeof args.flags.output === 'string' ? args.flags.output : `./export-${sessionId.slice(-8)}`;

  // Paginate through all events
  let page: string | null = null;
  const files: { path: string; content: string }[] = [];

  do {
    const url = `/v1/sessions/${sessionId}/events?limit=100&order=asc${page ? `&page=${page}` : ''}`;
    const result = await (
      api as unknown as {
        get: (p: string) => Promise<{
          data: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
          next_page: string | null;
        }>;
      }
    ).get(url);

    for (const event of result.data) {
      if (event.type === 'agent.tool_use' && event.name === 'write' && event.input) {
        const filePath = String(event.input.file_path ?? event.input.path ?? '');
        const content = String(event.input.content ?? '');
        if (filePath && content) {
          files.push({ path: filePath, content });
        }
      }
    }
    page = result.next_page;
  } while (page);

  if (files.length === 0) {
    console.log('No file artifacts found in session.');
    return;
  }

  // Write files locally
  for (const file of files) {
    // Normalize: /workspace/artifacts/product/prd.md → product/prd.md
    const relativePath = file.path.replace(/^\/workspace\/artifacts\//, '').replace(/^\/workspace\//, '');
    const dest = join(outputDir, relativePath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf-8');
  }

  console.log(`Exported ${files.length} files to ${outputDir}/`);
}

// ── Revise command ──────────────────────────────────────────────────

async function revise(args: ParsedArgs): Promise<void> {
  const sessionId = args.sub;
  const feedback = args.positional.join(' ');
  if (!sessionId || !feedback) {
    console.error('Usage: fab revise <session-id> <feedback...>');
    process.exit(1);
  }
  await reviseWorkflow(client(), sessionId, feedback);
}

// ── Scaffold command ────────────────────────────────────────────────

async function scaffold(args: ParsedArgs): Promise<void> {
  const description = [args.sub, ...args.positional].filter(Boolean).join(' ');
  if (!description) {
    console.error('Usage: fab scaffold <product description...>');
    console.error('\nExample:');
    console.error('  fab scaffold "RAG-powered search for enterprise document management"');
    process.exit(1);
  }

  const api = client();
  const entry = await getAgentByRole('chief-of-staff');
  if (!entry) {
    console.error('No deployed chief-of-staff. Run: fab deploy');
    process.exit(1);
    return;
  }

  const deployTarget = typeof args.flags.deploy === 'string' ? args.flags.deploy : 'fly';
  const timeline = typeof args.flags.timeline === 'string' ? args.flags.timeline : '4 weeks';
  const clientName = typeof args.flags.client === 'string' ? args.flags.client : undefined;

  const intake = {
    goal: `Build a complete product: ${description}`,
    workflow: 'launch-prep',
    constraints: {
      timeline,
      deploy_target: deployTarget,
      budget: 'moderate',
    },
    context: {
      product: description,
      problem: description,
      ...(clientName && { client: clientName }),
    },
    artifacts: [
      'prd',
      'okr-framework',
      'design-system',
      'architecture',
      'test-plan',
      'runbook',
      'campaign',
      'proposal',
      'onboarding-playbook',
      'battle-cards',
    ],
  };

  const webhookUrl = typeof args.flags.webhook === 'string' ? args.flags.webhook : undefined;
  const sess = await createSession(api, entry.agentId, `scaffold: ${description.slice(0, 60)}`);
  console.log(`Session: ${sess.id}\n`);

  await api.sendMessage(sess.id, JSON.stringify(intake, null, 2));
  const output = await streamWithAdvisor(api, sess.id);

  if (webhookUrl) {
    await deliverResult(webhookUrl, { session_id: sess.id, status: 'complete', output });
  }

  console.log(`Session: ${sess.id}`);
  console.log('Run `fab revise <session-id> <feedback>` to iterate.');
}

// ── Sprint commands ─────────────────────────────────────────────────

async function sprint(args: ParsedArgs): Promise<void> {
  const sub = args.sub;

  switch (sub) {
    case 'start': {
      const api = client();
      const entry = await getAgentByRole('chief-of-staff');
      if (!entry) {
        console.error('No deployed chief-of-staff. Run: fab deploy');
        process.exit(1);
        return;
      }
      const cadence = (
        typeof args.flags.cadence === 'string' ? args.flags.cadence : 'weekly'
      ) as SprintConfig['cadence'];
      const sess = await createSession(api, entry.agentId, `sprint`);
      const config: SprintConfig = {
        sessionId: sess.id,
        cadence,
        nextStandup: new Date().toISOString(),
        backlog: [],
        currentSprint: 1,
      };
      await setSprintConfig(config);
      console.log(`Sprint started (${cadence})`);
      console.log(`Session: ${sess.id}`);
      break;
    }
    case 'standup': {
      const config = await getSprintConfig();
      if (!config) {
        console.error('No active sprint. Run: fab sprint start');
        process.exit(1);
        return;
      }
      const api = client();
      const backlogSummary =
        config.backlog.length > 0
          ? config.backlog.map((i) => `- [${i.status}] ${i.description} (${i.assignedTo})`).join('\n')
          : '(empty backlog)';

      const prompt = `Sprint ${config.currentSprint} standup (${config.cadence}).

Current backlog:
${backlogSummary}

Run a team standup. Query each agent for status. Report blocked items and recommended next actions.`;

      await api.sendMessage(config.sessionId, prompt);
      await streamWithAdvisor(api, config.sessionId);
      break;
    }
    case 'add': {
      const desc = args.positional.join(' ');
      const role = (typeof args.flags.role === 'string' ? args.flags.role : 'engineering') as TeamRole;
      if (!desc) {
        console.error('Usage: fab sprint add <description> [--role <role>]');
        process.exit(1);
      }
      await addSprintItem({
        id: `item-${Date.now()}`,
        description: desc,
        assignedTo: role,
        status: 'backlog',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      console.log(`Added to backlog: ${desc} (${role})`);
      break;
    }
    case 'status': {
      const config = await getSprintConfig();
      if (!config) {
        console.log('No active sprint.');
        return;
      }
      console.log(`Sprint ${config.currentSprint} (${config.cadence})`);
      console.log(`Session: ${config.sessionId}\n`);
      if (config.backlog.length === 0) {
        console.log('Backlog is empty.');
      } else {
        for (const item of config.backlog) {
          console.log(`  [${item.status.padEnd(11)}] ${item.description} (${item.assignedTo})`);
        }
      }
      break;
    }
    case 'end': {
      await clearSprint();
      console.log('Sprint ended.');
      break;
    }
    default:
      console.error('Usage: fab sprint <start|standup|add|status|end>');
      process.exit(1);
  }
}

// ── Help ────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`fab — manage a startup team of Claude managed agents

USAGE
  fab deploy [--dry-run] [--skip-skills] [--nanohype-path ...]
                                       Deploy the full startup team (9 agents + skills)
  fab recover                       Rebuild state from API (agents, skills, environments, vaults)
  fab adopt <agent-id> [role]       Import an existing agent into the fab
  fab status                        Show deployed agent status
  fab teardown                      Archive all deployed agents

  fab session <role> [--title ...]  Create a session with a team member
  fab send <session-id> <message>   Send a message and stream the response
  fab stream <session-id>           Stream events from a running session
  fab events <session-id>           List past events from a session
  fab threads <session-id>          List agent threads in a session

  fab chat <role> [--session <id>]   Interactive chat with a team member

  fab standup [--session <id>]      Run a team standup via chief-of-staff
  fab workflow <name> <prompt...>   Run a multi-agent workflow [--no-gates] [--sequential]
  fab workflows                     List available workflows
  fab revise <session-id> <feedback>  Send revision feedback to a completed workflow
  fab usage [--since <date>]        Token usage and cost report
  fab budget [set|clear] <dollars>  Per-session cost limit
  fab export <session-id>           Extract artifacts to local disk
  fab perf                          Agent performance metrics

  fab scaffold <description...>     Full product scaffold [--deploy] [--timeline] [--client] [--webhook <url>]

  fab memory [--enable|--disable]   Company memory config
  fab journal [--enable|--disable]  Agent journal config
  fab repo [add|remove] <url>       Git repo mounting
  fab vault [add|remove] <id>       MCP auth vaults
  fab model [set|clear] <role>      Model routing per role

  fab sprint start [--cadence ...]  Start sprint mode
  fab sprint standup                Run sprint standup
  fab sprint add <desc> [--role]    Add backlog item
  fab sprint status                 Show sprint state
  fab sprint end                    End sprint

  fab skills                        List uploaded skills
  fab skills upload <role|--all>    Upload skill for a role (or all)
  fab skills show <role>            Preview skill content locally
  fab skills teardown               Archive all deployed skills

  fab agents                        List all agents
  fab sessions                      List all sessions

ROLES
  intake-analyst, product, design-lead, react-engineer, next-engineer,
  mobile-engineer, node-engineer, python-engineer, go-engineer,
  rag-engineer, agent-engineer, eval-engineer, bedrock-curator,
  claude-curator, postgres-engineer, opensearch-engineer, dynamodb-curator,
  aws-curator, gcp-curator, azure-curator, opentofu-engineer,
  terragrunt-engineer, landing-zone-curator, eks-curator, gke-curator,
  aks-curator, kubernetes-engineer, helm-engineer, kustomize-engineer,
  karpenter-curator, argocd-curator, eks-gitops-curator, kyverno-engineer,
  cert-manager-curator, secrets-engineer, observability-engineer,
  keda-engineer, eks-agent-platform-curator, kagent-curator,
  agentgateway-curator, kubebuilder-engineer, pr-reviewer, qa-security,
  build-verifier, artifact-auditor, compliance-curator, release-manager,
  deploy-engineer, migration-engineer, ops-sre, ops-incident, ops-finops,
  ops-automation, cs-success, cs-support, cs-renewals, sales-lead,
  sales-solutions, sales-ops, marketing-lead, content-engineer,
  seo-engineer, brand-strategist, lead-research-curator, lead-outbound,
  lead-events, github-curator, jira-curator, notion-curator, slack-curator,
  linear-curator, figma-curator, stripe-curator, chief-of-staff,
  legal-curator, data-analyst, external-reviewer, prompt-optimizer, learner

ENVIRONMENT
  ANTHROPIC_API_KEY      Required. Your Anthropic API key.
  NANOHYPE_PATH          Path to nanohype repo (default: ../nanohype)

  MCP servers are always included with default URLs.
  Set env vars to override:
  MCP_GITHUB_URL  MCP_LINEAR_URL  MCP_SLACK_URL   MCP_NOTION_URL
  MCP_FIGMA_URL   MCP_SENTRY_URL  MCP_PAGERDUTY_URL  MCP_HUBSPOT_URL
  MCP_ANALYTICS_URL  MCP_GDRIVE_URL  MCP_STRIPE_URL

EXAMPLES
  fab deploy
  fab skills show product
  fab session product --title "Q2 planning"
  fab send sess_abc123 "Plan the v2 launch"`);
}

// ── Recover ────────────────────────────────────────────────────────

async function recover(): Promise<void> {
  const api = client();
  const state = await loadState();

  console.log('Recovering state from API...\n');

  // ── Agents: match by metadata.fab_role ──────────────────────
  const agentsRes = await api.listAgents(100);
  const matched: { role: TeamRole; agentId: string; version: number; deployedAt: string }[] = [];
  const orphans: { id: string; name: string; role: string; version: number }[] = [];
  const seenRoles = new Set<string>();

  // Sort by updated_at descending so we pick the latest version of each role
  const sorted = agentsRes.data
    .filter((a) => a.archived_at === null && a.metadata?.fab_role)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  for (const agent of sorted) {
    const role = agent.metadata.fab_role;
    if (seenRoles.has(role)) {
      orphans.push({ id: agent.id, name: agent.name, role, version: agent.version });
      continue;
    }
    seenRoles.add(role);
    matched.push({
      role: role as TeamRole,
      agentId: agent.id,
      version: agent.version,
      deployedAt: agent.updated_at,
    });
  }

  state.agents = matched;

  console.log(`  agents:       ${matched.length} matched`);
  if (orphans.length > 0) {
    console.log(`  orphans:      ${orphans.length} (duplicate roles — latest version kept)`);
    for (const o of orphans) {
      console.log(`    ${o.role.padEnd(22)} ${o.id} v${o.version} (orphan)`);
    }
  }

  // ── Environments: pick the one named "fab" or most recent ──
  const envsRes = await api.listEnvironments(20);
  const activeEnvs = envsRes.data.filter((e) => e.archived_at === null);
  const fabEnv = activeEnvs.find((e) => e.name === 'fab') ?? activeEnvs[0];
  if (fabEnv) {
    state.environmentId = fabEnv.id;
    console.log(`  environment:  ${fabEnv.id} (${fabEnv.name})`);
  } else {
    console.log('  environment:  none found');
  }

  // ── Skills: match by name to SKILL_DEFS ─────────────────────────
  const skillsRes = await api.listSkills(100);
  const skillDefs = getAllSkillDefs();
  const skillNameToRole = new Map<string, TeamRole>();
  for (const [role, def] of skillDefs) {
    skillNameToRole.set(def.name, role);
  }

  let skillCount = 0;
  for (const skill of skillsRes.data) {
    const role = skillNameToRole.get(skill.display_title);
    if (role) {
      state.skillIds[role] = skill.id;
      skillCount++;
    }
  }
  console.log(`  skills:       ${skillCount} matched`);

  // ── Vaults: list active vaults ──────────────────────────────────
  const vaultsRes = await api.listVaults();
  const activeVaults = vaultsRes.data.filter((v) => v.archived_at === null);
  state.vaultIds = activeVaults.map((v) => v.id);
  console.log(
    `  vaults:       ${activeVaults.length} (${activeVaults.map((v) => v.display_name).join(', ') || 'none'})`,
  );

  await saveState(state);
  console.log(`\nState recovered to .fab-state.json`);

  if (orphans.length > 0) {
    console.log(`\nTo archive orphaned agents:`);
    for (const o of orphans) {
      console.log(`  fab teardown-agent ${o.id}  # ${o.role} v${o.version}`);
    }
  }
}

// ── Utilities ───────────────────────────────────────────────────────

function padRole(role: string): string {
  return (role + ':').padEnd(18);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.flags.help || args.flags.h || !args.command) {
    printHelp();
    process.exit(args.command ? 0 : 1);
  }

  try {
    switch (args.command) {
      case 'deploy':
        await deploy(args);
        break;
      case 'status':
        await status();
        break;
      case 'teardown':
        await teardown();
        break;
      case 'session':
        await session(args);
        break;
      case 'send':
        await send(args);
        break;
      case 'stream':
        await stream(args);
        break;
      case 'events':
        await events(args);
        break;
      case 'threads':
        await threads(args);
        break;
      case 'chat':
        await chat(args);
        break;
      case 'standup':
        await standup(args);
        break;
      case 'workflow':
        await workflow(args);
        break;
      case 'workflows':
        await workflows();
        break;
      case 'usage':
        await usage(args);
        break;
      case 'memory':
        await memory(args);
        break;
      case 'journal':
        await journal(args);
        break;
      case 'repo':
        await repo(args);
        break;
      case 'model':
        await model(args);
        break;
      case 'adopt':
        await adopt(args);
        break;
      case 'budget':
        await budget(args);
        break;
      case 'export':
        await exportSession(args);
        break;
      case 'perf':
        await perf();
        break;
      case 'vault':
        await vault(args);
        break;
      case 'scaffold':
        await scaffold(args);
        break;
      case 'revise':
        await revise(args);
        break;
      case 'sprint':
        await sprint(args);
        break;
      case 'skills':
        await skills(args);
        break;
      case 'recover':
        await recover();
        break;
      case 'agents':
        await listAgents();
        break;
      case 'sessions':
        await listSessions();
        break;
      default:
        console.error(`Unknown command: ${args.command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
