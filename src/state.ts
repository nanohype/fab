import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  FabState,
  DeployedAgent,
  GitRepoResource,
  JournalConfig,
  Language,
  MemoryConfig,
  MemoryStoreResource,
  SprintConfig,
  SprintItem,
  TeamRole,
} from './types.js';
import { parseGitHubUrl } from './git.js';
import { resolveSandboxMode } from './sandbox.js';

/**
 * Absolute path to the state file. Defaults to ~/.fab/state.json — a
 * stable per-user location that survives `cd`, reinstalls, and npx cache
 * churn. Override with FAB_STATE_FILE (used by tests; an escape hatch).
 */
export function stateFilePath(): string {
  return process.env.FAB_STATE_FILE ?? join(homedir(), '.fab', 'state.json');
}

const EMPTY: FabState = {
  agents: [],
  skillIds: {},
  environmentId: null,
  memory: { enabled: true, storeId: null },
  journal: { enabled: true, basePath: '/workspace/.fab/journal' },
  repos: [],
  modelOverrides: {},
  sprint: null,
  vaultIds: [],
  budgetLimit: null,
  projectLanguage: 'typescript',
  sourceDirs: [],
};

export async function loadState(): Promise<FabState> {
  const file = stateFilePath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    // A missing file is a fresh start. Any other read error is real —
    // don't mask it by silently resetting state.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
  try {
    // Merge onto defaults so partial state files (missing optional
    // fields) load cleanly without populating every field.
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<FabState>) };
  } catch {
    throw new Error(
      `State file is corrupt: ${file}\n` +
        'Fix or remove it, then re-run — `fab recover` rebuilds it from the API.',
    );
  }
}

export async function saveState(state: FabState): Promise<void> {
  const file = stateFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ── Agents ──────────────────────────────────────────────────────────

export async function addAgent(agent: DeployedAgent): Promise<FabState> {
  const state = await loadState();
  state.agents = state.agents.filter((a) => a.role !== agent.role);
  state.agents.push(agent);
  await saveState(state);
  return state;
}

export async function getAgentByRole(role: TeamRole): Promise<DeployedAgent | undefined> {
  const state = await loadState();
  return state.agents.find((a) => a.role === role);
}

// ── Skills ──────────────────────────────────────────────────────────

export async function addSkill(role: TeamRole, skillId: string): Promise<FabState> {
  const state = await loadState();
  state.skillIds[role] = skillId;
  await saveState(state);
  return state;
}

export async function getSkillByRole(role: TeamRole): Promise<string | undefined> {
  const state = await loadState();
  return state.skillIds[role];
}

export async function clearSkills(): Promise<void> {
  const state = await loadState();
  state.skillIds = {};
  await saveState(state);
}

// ── Environment ─────────────────────────────────────────────────────

export async function setEnvironmentId(id: string): Promise<FabState> {
  const state = await loadState();
  state.environmentId = id;
  await saveState(state);
  return state;
}

export async function getEnvironmentId(): Promise<string | null> {
  const state = await loadState();
  return state.environmentId;
}

// ── Memory ──────────────────────────────────────────────────────────

/** Name of the shared factory memory store; also its mount directory under /mnt/memory/. */
export const MEMORY_STORE_NAME = 'fab-factory-memory';

export async function getMemoryConfig(): Promise<MemoryConfig> {
  const state = await loadState();
  return state.memory;
}

export async function setMemoryConfig(config: Partial<MemoryConfig>): Promise<FabState> {
  const state = await loadState();
  state.memory = { ...state.memory, ...config };
  await saveState(state);
  return state;
}

/**
 * The memory-store resource to attach to a role session, or null when
 * memory is disabled or no store has been provisioned yet (run `fab deploy`).
 */
export async function getMemoryResource(): Promise<MemoryStoreResource | null> {
  // Managed Agents Memory is not supported with self-hosted sandboxes.
  if (resolveSandboxMode() === 'self-hosted') return null;
  const state = await loadState();
  if (!state.memory.enabled || !state.memory.storeId) return null;
  return {
    type: 'memory_store',
    memory_store_id: state.memory.storeId,
    access: 'read_write',
    instructions: `Factory memory is mounted at /mnt/memory/${MEMORY_STORE_NAME}/. Write durable learnings, decisions, and patterns under a directory named for your role; read /shared/ and other roles' directories when they bear on the task. Keep entries concise — decisions and learnings, not transcripts.`,
  };
}

// ── Journals ────────────────────────────────────────────────────────

export async function getJournalConfig(): Promise<JournalConfig> {
  const state = await loadState();
  return state.journal;
}

export async function setJournalConfig(config: Partial<JournalConfig>): Promise<FabState> {
  const state = await loadState();
  state.journal = { ...state.journal, ...config };
  await saveState(state);
  return state;
}

// ── Repos ───────────────────────────────────────────────────────────

export async function getRepos(): Promise<GitRepoResource[]> {
  const state = await loadState();
  return state.repos;
}

export async function addRepo(repo: GitRepoResource): Promise<FabState> {
  const state = await loadState();
  state.repos = state.repos.filter((r) => r.url !== repo.url);
  state.repos.push(repo);
  await saveState(state);
  return state;
}

export async function removeRepo(url: string): Promise<FabState> {
  const state = await loadState();
  state.repos = state.repos.filter((r) => r.url !== url);
  await saveState(state);
  return state;
}

/**
 * Primary repo as a structured {owner, repo, token, defaultBranch} suitable
 * for direct GitHub API calls. Returns null when no repos are configured.
 */
export async function getPrimaryRepo(): Promise<{
  owner: string;
  repo: string;
  token: string;
  defaultBranch: string;
} | null> {
  const repos = await getRepos();
  if (repos.length === 0) return null;
  const r = repos[0];
  const { owner, repo } = parseGitHubUrl(r.url);
  return {
    owner,
    repo,
    token: r.authorization_token,
    defaultBranch: r.checkout?.name ?? 'main',
  };
}

// ── Model Overrides ─────────────────────────────────────────────────

export async function getModelOverrides(): Promise<Record<string, string>> {
  const state = await loadState();
  return state.modelOverrides;
}

export async function setModelOverride(role: TeamRole, model: string): Promise<FabState> {
  const state = await loadState();
  state.modelOverrides[role] = model;
  await saveState(state);
  return state;
}

export async function clearModelOverride(role: TeamRole): Promise<FabState> {
  const state = await loadState();
  const { [role]: _removed, ...rest } = state.modelOverrides;
  state.modelOverrides = rest;
  await saveState(state);
  return state;
}

// ── Sprint ──────────────────────────────────────────────────────────

export async function getSprintConfig(): Promise<SprintConfig | null> {
  const state = await loadState();
  return state.sprint;
}

export async function setSprintConfig(config: SprintConfig): Promise<FabState> {
  const state = await loadState();
  state.sprint = config;
  await saveState(state);
  return state;
}

export async function clearSprint(): Promise<FabState> {
  const state = await loadState();
  state.sprint = null;
  await saveState(state);
  return state;
}

export async function addSprintItem(item: SprintItem): Promise<FabState> {
  const state = await loadState();
  if (!state.sprint) throw new Error('No active sprint');
  state.sprint.backlog.push(item);
  await saveState(state);
  return state;
}

export async function updateSprintItem(id: string, update: Partial<SprintItem>): Promise<FabState> {
  const state = await loadState();
  if (!state.sprint) throw new Error('No active sprint');
  const item = state.sprint.backlog.find((i) => i.id === id);
  if (!item) throw new Error(`Sprint item not found: ${id}`);
  Object.assign(item, update, { updatedAt: new Date().toISOString() });
  await saveState(state);
  return state;
}

// ── Budget ──────────────────────────────────────────────────────

export async function getBudgetLimit(): Promise<number | null> {
  const state = await loadState();
  return state.budgetLimit;
}

export async function setBudgetLimit(limit: number | null): Promise<FabState> {
  const state = await loadState();
  state.budgetLimit = limit;
  await saveState(state);
  return state;
}

// ── Vaults ──────────────────────────────────────────────────────

export async function getVaultIds(): Promise<string[]> {
  const state = await loadState();
  return state.vaultIds;
}

export async function addVaultId(id: string): Promise<FabState> {
  const state = await loadState();
  if (!state.vaultIds.includes(id)) state.vaultIds.push(id);
  await saveState(state);
  return state;
}

export async function removeVaultId(id: string): Promise<FabState> {
  const state = await loadState();
  state.vaultIds = state.vaultIds.filter((v) => v !== id);
  await saveState(state);
  return state;
}

// ── Project language ────────────────────────────────────────────────

export async function getProjectLanguage(): Promise<Language> {
  const state = await loadState();
  return state.projectLanguage;
}

export async function setProjectLanguage(language: Language): Promise<FabState> {
  const state = await loadState();
  state.projectLanguage = language;
  await saveState(state);
  return state;
}

// ── Source directories ──────────────────────────────────────────────

export async function setSourceDirs(dirs: string[]): Promise<FabState> {
  const state = await loadState();
  state.sourceDirs = dirs;
  await saveState(state);
  return state;
}

// ── Reset ───────────────────────────────────────────────────────────

export async function clearState(): Promise<void> {
  await saveState({ ...EMPTY });
}
