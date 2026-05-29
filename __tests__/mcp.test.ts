import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveMcpServers, getRegistry, parseTunnelRegistry } from '../src/mcp.js';

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

  describe('FAB_MCP_TUNNEL seam', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('parseTunnelRegistry returns empty for an unset spec', () => {
      expect(parseTunnelRegistry(undefined)).toEqual({});
      expect(parseTunnelRegistry('')).toEqual({});
    });

    it('parseTunnelRegistry parses comma-separated name=url pairs', () => {
      const registry = parseTunnelRegistry('wiki=https://wiki.tnl.example/mcp,kb=https://kb.tnl.example/mcp');
      expect(Object.keys(registry)).toEqual(['wiki', 'kb']);
      expect(registry.wiki.defaultUrl).toBe('https://wiki.tnl.example/mcp');
      expect(registry.kb.name).toBe('kb');
      expect(registry.wiki.description).toMatch(/tunnel/i);
    });

    it('parseTunnelRegistry skips malformed entries', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const registry = parseTunnelRegistry('ok=https://ok.tnl.example/mcp,no-equals,=https://noname.example,empty=');
      expect(Object.keys(registry)).toEqual(['ok']);
      expect(stderr).toHaveBeenCalled();
    });

    it('resolveMcpServers resolves a tunnel server registered via FAB_MCP_TUNNEL', () => {
      vi.stubEnv('FAB_MCP_TUNNEL', 'wiki=https://wiki.tnl.example/mcp');
      const { servers, tools } = resolveMcpServers(['wiki']);
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ type: 'url', name: 'wiki', url: 'https://wiki.tnl.example/mcp' });
      expect(tools[0]).toMatchObject({ type: 'mcp_toolset', mcp_server_name: 'wiki' });
    });

    it('getRegistry includes tunnel servers alongside the static registry', () => {
      vi.stubEnv('FAB_MCP_TUNNEL', 'wiki=https://wiki.tnl.example/mcp');
      const registry = getRegistry();
      expect(Object.keys(registry)).toContain('github');
      expect(Object.keys(registry)).toContain('wiki');
    });

    it('parseTunnelRegistry rejects non-https URLs', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const registry = parseTunnelRegistry(
        'plain=http://wiki.tnl.example/mcp,localfile=file:///etc/passwd,js=javascript:alert(1)',
      );
      expect(Object.keys(registry)).toEqual([]);
      expect(stderr).toHaveBeenCalled();
    });

    it('parseTunnelRegistry rejects entries whose value is not a parseable URL', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const registry = parseTunnelRegistry('bad=not a url,ok=https://ok.tnl.example/mcp');
      expect(Object.keys(registry)).toEqual(['ok']);
      expect(stderr).toHaveBeenCalled();
    });

    it('parseTunnelRegistry refuses to shadow a built-in server name', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const registry = parseTunnelRegistry('github=https://attacker.example/mcp');
      expect(registry.github).toBeUndefined();
      expect(stderr).toHaveBeenCalled();
    });

    it('a FAB_MCP_TUNNEL entry cannot override a built-in server', () => {
      vi.stubEnv('FAB_MCP_TUNNEL', 'github=https://attacker.example/mcp');
      const { servers } = resolveMcpServers(['github']);
      expect(servers).toHaveLength(1);
      expect(servers[0].url).toBe(getRegistry().github.defaultUrl);
      expect(servers[0].url).not.toBe('https://attacker.example/mcp');
    });
  });
});
