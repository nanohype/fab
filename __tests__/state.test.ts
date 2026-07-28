import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import {
  loadState,
  saveState,
  clearState,
  getMemoryResource,
  setMemoryConfig,
  addAgent,
  getAgentByRole,
  addSkill,
  getSkillByRole,
  clearSkills,
  setEnvironmentId,
  getEnvironmentId,
  getJournalConfig,
  setJournalConfig,
  getRepos,
  addRepo,
  removeRepo,
  getPrimaryRepo,
  getModelOverrides,
  setModelOverride,
  clearModelOverride,
  getSprintConfig,
  setSprintConfig,
  clearSprint,
  addSprintItem,
  updateSprintItem,
  getBudgetLimit,
  setBudgetLimit,
  getVaultIds,
  addVaultId,
  removeVaultId,
  getProjectLanguage,
  setProjectLanguage,
  setSourceDirs,
} from '../src/state.js';
import type { FabState, TeamRole } from '../src/types.js';

const STATE_FILE = process.env.FAB_STATE_FILE!;

async function cleanup() {
  try {
    await unlink(STATE_FILE);
  } catch {
    /* ignore */
  }
}

describe('state', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('loadState returns defaults when no file exists', async () => {
    const state = await loadState();
    expect(state.agents).toEqual([]);
    expect(state.skillIds).toEqual({});
    expect(state.environmentId).toBeNull();
    expect(state.memory.enabled).toBe(true);
    expect(state.journal.enabled).toBe(true);
    expect(state.repos).toEqual([]);
    expect(state.modelOverrides).toEqual({});
    expect(state.sprint).toBeNull();
    expect(state.sourceDirs).toEqual([]);
  });

  it('saveState + loadState roundtrip preserves all fields', async () => {
    const state: FabState = {
      agents: [{ role: 'product', agentId: 'agent_123', version: 1, deployedAt: '2026-04-08' }],
      skillIds: { product: 'skill_456' },
      environmentId: 'env_789',
      memory: { enabled: false, storeId: 'memstore_test' },
      journal: { enabled: true, basePath: '/workspace/.fab/journal' },
      repos: [
        {
          type: 'github_repository',
          url: 'https://github.com/test/repo',
          mount_path: '/workspace/repo',
          authorization_token: 'ghp_test_token',
        },
      ],
      modelOverrides: { 'node-engineer': 'claude-opus-4-8' },
      sprint: null,
      vaultIds: [],
      budgetLimit: null,
      projectLanguage: 'typescript',
      sourceDirs: ['src/api'],
    };

    await saveState(state);
    const loaded = await loadState();

    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0].agentId).toBe('agent_123');
    expect(loaded.skillIds.product).toBe('skill_456');
    expect(loaded.environmentId).toBe('env_789');
    expect(loaded.memory.enabled).toBe(false);
    expect(loaded.memory.storeId).toBe('memstore_test');
    expect(loaded.repos).toHaveLength(1);
    expect(loaded.modelOverrides['node-engineer']).toBe('claude-opus-4-8');
    expect(loaded.sourceDirs).toEqual(['src/api']);
  });

  it('clearState resets to defaults', async () => {
    await saveState({
      agents: [{ role: 'pr-reviewer', agentId: 'agent_x', version: 2, deployedAt: '2026-04-08' }],
      skillIds: { 'pr-reviewer': 'skill_y' },
      environmentId: 'env_z',
      memory: { enabled: true, storeId: null },
      journal: { enabled: true, basePath: '/workspace/.fab/journal' },
      repos: [],
      modelOverrides: {},
      sprint: null,
      vaultIds: [],
      budgetLimit: null,
      projectLanguage: 'typescript',
      sourceDirs: [],
    });

    await clearState();
    const state = await loadState();

    expect(state.agents).toEqual([]);
  });

  it('loadState merges loaded state onto defaults for partial state files', async () => {
    const partial = JSON.stringify({ agents: [], skillIds: {} });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(STATE_FILE, partial, 'utf-8');

    const state = await loadState();
    expect(state.memory.enabled).toBe(true);
    expect(state.journal.enabled).toBe(true);
    expect(state.repos).toEqual([]);
    expect(state.sprint).toBeNull();
  });

  it('state file is valid JSON', async () => {
    await saveState({
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
    });

    const raw = await readFile(STATE_FILE, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('loadState throws on a corrupt state file instead of silently resetting', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(STATE_FILE, '{ not valid json', 'utf-8');
    await expect(loadState()).rejects.toThrow(/corrupt/i);
  });

  it('getMemoryResource returns null without a store and a resource once one is set', async () => {
    expect(await getMemoryResource()).toBeNull();
    await setMemoryConfig({ storeId: 'memstore_xyz' });
    const res = await getMemoryResource();
    expect(res?.type).toBe('memory_store');
    expect(res?.memory_store_id).toBe('memstore_xyz');
  });
});

/**
 * The accessor families. `loadState`/`saveState` were covered; the two dozen
 * helpers built on them were not, and they are what every command actually
 * calls. Each one is a read-modify-write against the same file, so the two
 * properties worth asserting are that the write lands and that it does not
 * clobber a neighbouring key.
 */
describe('state accessors', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('records a deployed agent and finds it by role', async () => {
    await addAgent({
      role: 'pr-reviewer' as TeamRole,
      agentId: 'agent_1',
      version: 1,
      deployedAt: '2026-07-20T00:00:00Z',
    });
    const found = await getAgentByRole('pr-reviewer' as TeamRole);
    expect(found).toMatchObject({ agentId: 'agent_1', version: 1 });
    expect(await getAgentByRole('backend' as TeamRole)).toBeUndefined();
  });

  it('maps skills to roles and clears them wholesale', async () => {
    await addSkill('pr-reviewer' as TeamRole, 'skill_1');
    await addSkill('backend' as TeamRole, 'skill_2');
    expect(await getSkillByRole('pr-reviewer' as TeamRole)).toBe('skill_1');

    await clearSkills();
    expect(await getSkillByRole('pr-reviewer' as TeamRole)).toBeUndefined();
    expect(await getSkillByRole('backend' as TeamRole)).toBeUndefined();
  });

  it('round-trips the environment id, including its absence', async () => {
    expect(await getEnvironmentId()).toBeNull();
    await setEnvironmentId('env_1');
    expect(await getEnvironmentId()).toBe('env_1');
  });

  it('merges a partial journal config onto what is already there', async () => {
    await setJournalConfig({ basePath: '/journals' });
    await setJournalConfig({ enabled: true });
    expect(await getJournalConfig()).toMatchObject({ enabled: true, basePath: '/journals' });
  });

  it('replaces a repo entry rather than duplicating it on re-add', async () => {
    // `fab repo add` on an already-configured URL is a token rotation, not a
    // second checkout. Appending would leave the stale token in the resource
    // list handed to every session.
    const repo = {
      type: 'github_repository' as const,
      url: 'https://github.com/nanohype/fab',
      authorization_token: 'ghp_old',
    };
    await addRepo(repo);
    await addRepo({ ...repo, authorization_token: 'ghp_new' });

    const repos = await getRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].authorization_token).toBe('ghp_new');
  });

  it('removes a repo by url and leaves the others', async () => {
    await addRepo({
      type: 'github_repository',
      url: 'https://github.com/nanohype/fab',
      authorization_token: 'a',
    });
    await addRepo({
      type: 'github_repository',
      url: 'https://github.com/nanohype/portal',
      authorization_token: 'b',
    });
    await removeRepo('https://github.com/nanohype/fab');

    const repos = await getRepos();
    expect(repos.map((r) => r.url)).toEqual(['https://github.com/nanohype/portal']);
  });

  it('parses the primary repo into the fields the GitHub API needs', async () => {
    await addRepo({
      type: 'github_repository',
      url: 'https://github.com/nanohype/fab',
      authorization_token: 'ghp_x',
      checkout: { type: 'branch', name: 'develop' },
    });

    expect(await getPrimaryRepo()).toEqual({
      owner: 'nanohype',
      repo: 'fab',
      token: 'ghp_x',
      defaultBranch: 'develop',
    });
  });

  it("defaults the primary repo's branch to main when no checkout is pinned", async () => {
    await addRepo({
      type: 'github_repository',
      url: 'https://github.com/nanohype/fab',
      authorization_token: 'ghp_x',
    });
    expect((await getPrimaryRepo())?.defaultBranch).toBe('main');
  });

  it('returns null for the primary repo when none is configured', async () => {
    expect(await getPrimaryRepo()).toBeNull();
  });

  it('sets and clears a per-role model override', async () => {
    await setModelOverride('pr-reviewer' as TeamRole, 'claude-opus-4-8');
    expect(await getModelOverrides()).toEqual({ 'pr-reviewer': 'claude-opus-4-8' });

    await clearModelOverride('pr-reviewer' as TeamRole);
    expect(await getModelOverrides()).toEqual({});
  });

  it('tracks a sprint and updates one item without touching its neighbours', async () => {
    await setSprintConfig({
      sessionId: 'sess_1',
      cadence: 'weekly',
      nextStandup: '2026-07-27T00:00:00Z',
      backlog: [],
      currentSprint: 1,
    });
    await addSprintItem({
      id: 'item_1',
      description: 'ship the gate',
      assignedTo: 'pr-reviewer' as TeamRole,
      status: 'backlog',
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    });
    await addSprintItem({
      id: 'item_2',
      description: 'write the docs',
      assignedTo: 'backend' as TeamRole,
      status: 'backlog',
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    });

    await updateSprintItem('item_1', { status: 'done' });

    const sprint = await getSprintConfig();
    expect(sprint?.backlog.find((i) => i.id === 'item_1')?.status).toBe('done');
    expect(sprint?.backlog.find((i) => i.id === 'item_2')?.status).toBe('backlog');
  });

  it('clears a sprint back to none', async () => {
    await setSprintConfig({
      sessionId: 'sess_1',
      cadence: 'daily',
      nextStandup: '2026-07-21T00:00:00Z',
      backlog: [],
      currentSprint: 1,
    });
    await clearSprint();
    expect(await getSprintConfig()).toBeNull();
  });

  it('distinguishes an unset budget from a zero one', async () => {
    // null means "no ceiling"; 0 means "stop immediately". Collapsing them
    // would turn a deliberate freeze into unlimited spend.
    expect(await getBudgetLimit()).toBeNull();
    await setBudgetLimit(0);
    expect(await getBudgetLimit()).toBe(0);
    await setBudgetLimit(25);
    expect(await getBudgetLimit()).toBe(25);
    await setBudgetLimit(null);
    expect(await getBudgetLimit()).toBeNull();
  });

  it('adds vault ids without duplicating, and removes them', async () => {
    await addVaultId('vault_1');
    await addVaultId('vault_1');
    expect(await getVaultIds()).toEqual(['vault_1']);

    await addVaultId('vault_2');
    await removeVaultId('vault_1');
    expect(await getVaultIds()).toEqual(['vault_2']);
  });

  it('round-trips the project language that drives the toolchain', async () => {
    // buildSystemPrompt reads this to emit build/lint/test/docs commands, so a
    // lost value means an agent is told to run the wrong toolchain entirely.
    await setProjectLanguage('go');
    expect(await getProjectLanguage()).toBe('go');
  });

  it('stores the configured source directories', async () => {
    await setSourceDirs(['src', 'lib']);
    expect((await loadState()).sourceDirs).toEqual(['src', 'lib']);
  });

  it('keeps unrelated keys intact across a write', async () => {
    await setEnvironmentId('env_1');
    await setProjectLanguage('rust');
    await addVaultId('vault_1');

    const state = await loadState();
    expect(state.environmentId).toBe('env_1');
    expect(state.projectLanguage).toBe('rust');
    expect(state.vaultIds).toEqual(['vault_1']);
  });
});
