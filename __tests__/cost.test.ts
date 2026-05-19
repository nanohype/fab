import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { uploadCostEvent } from '../src/cost.js';

describe('cost uploader', () => {
  const origEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  it('no-ops when gateway env vars are not set', async () => {
    delete process.env.MCP_GATEWAY_BASE_URL;
    delete process.env.MCP_GATEWAY_TOKEN;

    await uploadCostEvent({
      sessionId: 's1',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      source: 'managed_agents',
      timestamp: '2026-04-11T00:00:00Z',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops when token is set but base URL is missing', async () => {
    delete process.env.MCP_GATEWAY_BASE_URL;
    process.env.MCP_GATEWAY_TOKEN = 'token';

    await uploadCostEvent({
      sessionId: 's1',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      source: 'managed_agents',
      timestamp: '2026-04-11T00:00:00Z',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to /dashboard/api/cost with Bearer auth when configured', async () => {
    process.env.MCP_GATEWAY_BASE_URL = 'https://gateway.example.com';
    process.env.MCP_GATEWAY_TOKEN = 'test-token';

    await uploadCostEvent({
      sessionId: 's1',
      agentRole: 'eng-backend',
      workflow: 'feature-build',
      model: 'claude-sonnet-4-6',
      speed: 'standard',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0105,
      source: 'managed_agents',
      timestamp: '2026-04-11T00:00:00Z',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example.com/dashboard/api/cost');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.sessionId).toBe('s1');
    expect(body.source).toBe('managed_agents');
    expect(body.costUsd).toBe(0.0105);
  });

  it('strips trailing slash from base URL', async () => {
    process.env.MCP_GATEWAY_BASE_URL = 'https://gateway.example.com/';
    process.env.MCP_GATEWAY_TOKEN = 'token';

    await uploadCostEvent({
      sessionId: 's1',
      model: 'claude-opus-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.005,
      source: 'advisor',
      timestamp: '2026-04-11T00:00:00Z',
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example.com/dashboard/api/cost');
  });

  it('never throws on upload failure', async () => {
    process.env.MCP_GATEWAY_BASE_URL = 'https://gateway.example.com';
    process.env.MCP_GATEWAY_TOKEN = 'token';
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(
      uploadCostEvent({
        sessionId: 's1',
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
        source: 'managed_agents',
        timestamp: '2026-04-11T00:00:00Z',
      }),
    ).resolves.toBeUndefined();
  });
});
