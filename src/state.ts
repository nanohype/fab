import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  JauntyState,
  DeployedAgent,
  GitRepoResource,
  JournalConfig,
  Language,
  MemoryConfig,
  SprintConfig,
  SprintItem,
  TeamRole,
} from './types.js';
import { parseGitHubUrl } from './git.js';

// Anchored to the project root, not cwd — survives cd
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(PROJECT_ROOT, '.jaunty-state.json');

const EMPTY: JauntyState = {
  agents: [],
  skillIds: {},
  environmentId: null,
  memory: { enabled: true, path: '/workspace/.jaunty/memory.md' },
  journal: { enabled: true, basePath: '/workspace/.jaunty/journal' },
  repos: [],
  modelOverrides: {},
  sprint: null,
  vaultIds: [],
  budgetLimit: null,
  projectLanguage: 'typescript',
};

export async function loadState(): Promise<JauntyState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<JauntyState>;
    // Merge with defaults so partial state files (missing optional fields)
    // load cleanly without forcing the caller to populate every field.
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveState(state: JauntyState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ── Agents ──────────────────────────────────────────────────────────

export async function addAgent(agent: DeployedAgent): Promise<JauntyState> {
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

export async function addSkill(role: TeamRole, skillId: string): Promise<JauntyState> {
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

export async function setEnvironmentId(id: string): Promise<JauntyState> {
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

export async function getMemoryConfig(): Promise<MemoryConfig> {
  const state = await loadState();
  return state.memory;
}

export async function setMemoryConfig(config: Partial<MemoryConfig>): Promise<JauntyState> {
  const state = await loadState();
  state.memory = { ...state.memory, ...config };
  await saveState(state);
  return state;
}

// ── Journals ────────────────────────────────────────────────────────

export async function getJournalConfig(): Promise<JournalConfig> {
  const state = await loadState();
  return state.journal;
}

export async function setJournalConfig(config: Partial<JournalConfig>): Promise<JauntyState> {
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

export async function addRepo(repo: GitRepoResource): Promise<JauntyState> {
  const state = await loadState();
  state.repos = state.repos.filter((r) => r.url !== repo.url);
  state.repos.push(repo);
  await saveState(state);
  return state;
}

export async function removeRepo(url: string): Promise<JauntyState> {
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

export async function setModelOverride(role: TeamRole, model: string): Promise<JauntyState> {
  const state = await loadState();
  state.modelOverrides[role] = model;
  await saveState(state);
  return state;
}

export async function clearModelOverride(role: TeamRole): Promise<JauntyState> {
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

export async function setSprintConfig(config: SprintConfig): Promise<JauntyState> {
  const state = await loadState();
  state.sprint = config;
  await saveState(state);
  return state;
}

export async function clearSprint(): Promise<JauntyState> {
  const state = await loadState();
  state.sprint = null;
  await saveState(state);
  return state;
}

export async function addSprintItem(item: SprintItem): Promise<JauntyState> {
  const state = await loadState();
  if (!state.sprint) throw new Error('No active sprint');
  state.sprint.backlog.push(item);
  await saveState(state);
  return state;
}

export async function updateSprintItem(id: string, update: Partial<SprintItem>): Promise<JauntyState> {
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

export async function setBudgetLimit(limit: number | null): Promise<JauntyState> {
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

export async function addVaultId(id: string): Promise<JauntyState> {
  const state = await loadState();
  if (!state.vaultIds.includes(id)) state.vaultIds.push(id);
  await saveState(state);
  return state;
}

export async function removeVaultId(id: string): Promise<JauntyState> {
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

export async function setProjectLanguage(language: Language): Promise<JauntyState> {
  const state = await loadState();
  state.projectLanguage = language;
  await saveState(state);
  return state;
}

// ── Reset ───────────────────────────────────────────────────────────

export async function clearState(): Promise<void> {
  await saveState({ ...EMPTY });
}
