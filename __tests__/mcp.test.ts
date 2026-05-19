import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveMcpServers, getRegistry } from '../src/mcp.js';

describe('mcp', () => {
  it('getRegistry returns all servers', () => {
    const registry = getRegistry();
    expect(Object.keys(registry)).toContain('github');
    expect(Object.keys(registry)).toContain('linear');
    expect(Object.keys(registry)).toContain('slack');
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(9);
  });

  it('resolveMcpServers returns servers and tools for known names', () => {
    const { servers, tools } = resolveMcpServers(['github', 'linear']);
    expect(servers).toHaveLength(2);
    expect(tools).toHaveLength(2);
    expect(servers[0].name).toBe('github');
    expect(servers[0].type).toBe('url');
    expect(servers[0].url).toBeTruthy();
    expect(tools[0].type).toBe('mcp_toolset');
  });

  it('resolveMcpServers skips unknown names', () => {
    const { servers } = resolveMcpServers(['github', 'nonexistent']);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('github');
  });

  it('resolveMcpServers uses default URL when env var not set', () => {
    const { servers } = resolveMcpServers(['github']);
    const registry = getRegistry();
    expect(servers[0].url).toBe(registry.github.defaultUrl);
  });

  describe('env var override', () => {
    const original = process.env.MCP_GITHUB_URL;

    beforeEach(() => {
      process.env.MCP_GITHUB_URL = 'https://custom.github.mcp/sse';
    });

    afterEach(() => {
      if (original === undefined) {
        delete process.env.MCP_GITHUB_URL;
      } else {
        process.env.MCP_GITHUB_URL = original;
      }
    });

    it('uses env var when set', () => {
      const { servers } = resolveMcpServers(['github']);
      expect(servers[0].url).toBe('https://custom.github.mcp/sse');
    });
  });

  it('returns empty arrays for empty input', () => {
    const { servers, tools } = resolveMcpServers([]);
    expect(servers).toHaveLength(0);
    expect(tools).toHaveLength(0);
  });
});
