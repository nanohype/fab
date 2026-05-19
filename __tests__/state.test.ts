import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState, saveState, clearState } from '../src/state.js';
import type { FabState } from '../src/types.js';

const STATE_FILE = join(process.cwd(), '.fab-state.json');

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
  });

  it('saveState + loadState roundtrip preserves all fields', async () => {
    const state: FabState = {
      agents: [{ role: 'product', agentId: 'agent_123', version: 1, deployedAt: '2026-04-08' }],
      skillIds: { product: 'skill_456' },
      environmentId: 'env_789',
      memory: { enabled: false, path: '/custom/memory.md' },
      journal: { enabled: true, basePath: '/workspace/.fab/journal' },
      repos: [
        {
          type: 'github_repository',
          url: 'https://github.com/test/repo',
          mount_path: '/workspace/repo',
          authorization_token: 'ghp_test_token',
        },
      ],
      modelOverrides: { 'node-engineer': 'claude-opus-4-6' },
      sprint: null,
      vaultIds: [],
      budgetLimit: null,
      projectLanguage: 'typescript',
    };

    await saveState(state);
    const loaded = await loadState();

    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0].agentId).toBe('agent_123');
    expect(loaded.skillIds.product).toBe('skill_456');
    expect(loaded.environmentId).toBe('env_789');
    expect(loaded.memory.enabled).toBe(false);
    expect(loaded.memory.path).toBe('/custom/memory.md');
    expect(loaded.repos).toHaveLength(1);
    expect(loaded.modelOverrides['node-engineer']).toBe('claude-opus-4-6');
  });

  it('clearState resets to defaults', async () => {
    await saveState({
      agents: [{ role: 'pr-reviewer', agentId: 'agent_x', version: 2, deployedAt: '2026-04-08' }],
      skillIds: { 'pr-reviewer': 'skill_y' },
      environmentId: 'env_z',
      memory: { enabled: true, path: '/workspace/.fab/memory.md' },
      journal: { enabled: true, basePath: '/workspace/.fab/journal' },
      repos: [],
      modelOverrides: {},
      sprint: null,
      vaultIds: [],
      budgetLimit: null,
      projectLanguage: 'typescript',
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
      memory: { enabled: true, path: '/workspace/.fab/memory.md' },
      journal: { enabled: true, basePath: '/workspace/.fab/journal' },
      repos: [],
      modelOverrides: {},
      sprint: null,
      vaultIds: [],
      budgetLimit: null,
      projectLanguage: 'typescript',
    });

    const raw = await readFile(STATE_FILE, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
