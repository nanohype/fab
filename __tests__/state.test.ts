import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import {
  loadState,
  saveState,
  clearState,
  getMemoryResource,
  setMemoryConfig,
} from '../src/state.js';
import type { FabState } from '../src/types.js';

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
