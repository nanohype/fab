import type { McpServer, Tool } from './types.js';

// ── MCP Server Registry ─────────────────────────────────────────────
//
// Every server is always included in agent configs. URLs resolve in
// order: env var override → default. Set env vars in .env or export
// them to point at your own MCP server instances.

interface McpServerDef {
  name: string;
  description: string;
  defaultUrl: string;
  envOverride: string;
  headers?: Record<string, string>;
}

// ── Gateway helpers (mcp-gateway — /mcp/{service} routes) ──────
//
// The mcp-gateway deployment (protohype/mcp-gateway) hosts MCP services
// behind a single API Gateway at /mcp/{service}/{proxy+} with a shared
// bearer token authorizer. Switchboard services: hubspot, gdrive, analytics,
// gcal, gcse, stripe.
//
// Auth: the gateway bearer lives in the vault as one static_bearer credential
// per gateway URL. The managed-agents runtime injects the Authorization header
// when agents call each server — no headers embedded here.
//
// Required env: MCP_GATEWAY_BASE_URL (URL is not a secret; token is in vault)

const GATEWAY_BASE = process.env.MCP_GATEWAY_BASE_URL ?? 'http://localhost:3001';

function switchboardService(service: string): { defaultUrl: string } {
  return { defaultUrl: `${GATEWAY_BASE}/mcp/${service}` };
}

const REGISTRY: Record<string, McpServerDef> = {
  // ── Confirmed live third-party MCP servers ──────────────────────
  github: {
    name: 'github',
    description: 'Code, PRs, issues, CI',
    defaultUrl: 'https://api.githubcopilot.com/mcp/',
    envOverride: 'MCP_GITHUB_URL',
  },
  linear: {
    name: 'linear',
    description: 'Project management, issues, roadmap',
    defaultUrl: 'https://mcp.linear.app/mcp',
    envOverride: 'MCP_LINEAR_URL',
  },
  slack: {
    name: 'slack',
    description: 'Team communication, channels',
    defaultUrl: 'https://mcp.slack.com/mcp',
    envOverride: 'MCP_SLACK_URL',
  },
  notion: {
    name: 'notion',
    description: 'Knowledge base, documentation',
    defaultUrl: 'https://mcp.notion.com/mcp',
    envOverride: 'MCP_NOTION_URL',
  },
  sentry: {
    name: 'sentry',
    description: 'Error tracking, performance',
    defaultUrl: 'https://mcp.sentry.io/mcp/',
    envOverride: 'MCP_SENTRY_URL',
  },
  figma: {
    name: 'figma',
    description: 'Design files, components, inspection',
    defaultUrl: 'https://mcp.figma.com/mcp',
    envOverride: 'MCP_FIGMA_URL',
  },
  hunter: {
    name: 'hunter',
    description: 'Email finding, verification, domain search',
    defaultUrl: 'https://mcp.hunter.io/mcp',
    envOverride: 'MCP_HUNTER_URL',
  },
  // ── mcp-gateway switchboard ────────────────────────────────────
  // Routes at /mcp/{service} with Authorization: Bearer <token>.
  hubspot: {
    name: 'hubspot',
    description: 'CRM, sales pipeline, customer health',
    envOverride: 'MCP_HUBSPOT_URL',
    ...switchboardService('hubspot'),
  },
  gdrive: {
    name: 'gdrive',
    description: 'Documents, proposals, assets',
    envOverride: 'MCP_GDRIVE_URL',
    ...switchboardService('gdrive'),
  },
  analytics: {
    name: 'analytics',
    description: 'Traffic, conversion, metrics',
    envOverride: 'MCP_ANALYTICS_URL',
    ...switchboardService('analytics'),
  },
  gcalendar: {
    name: 'gcalendar',
    description: 'Calendar, scheduling, events',
    envOverride: 'MCP_GCALENDAR_URL',
    ...switchboardService('gcal'),
  },
  gcse: {
    name: 'gcse',
    description: 'Google Custom Search, web research',
    envOverride: 'MCP_GCSE_URL',
    ...switchboardService('gcse'),
  },
  stripe: {
    name: 'stripe',
    description: 'Billing, subscriptions',
    envOverride: 'MCP_STRIPE_URL',
    ...switchboardService('stripe'),
  },
};

// ── MCP tunnel seam ─────────────────────────────────────────────────
//
// A private MCP server — one running inside an adopter's own network —
// is reached by Claude through an MCP tunnel (the `mcp-tunnel` addon in
// eks-gitops). The tunnel gives the server an ordinary https URL, so the
// connector call is the same as for any public server. FAB_MCP_TUNNEL
// registers such servers by name so roles can reference them and the
// vault supplies their upstream auth, matched by URL.
//
// Each entry must use an https URL and must not reuse a built-in server
// name (so a tunnel can never silently shadow github/linear/etc.).
// Entries that violate either rule are skipped with a warning.
//
// Format: comma-separated `name=url` pairs, e.g.
//   FAB_MCP_TUNNEL="wiki=https://wiki.acme.tunnel.example/mcp,kb=https://kb.acme.tunnel.example/mcp"

const TUNNEL_ENV = 'FAB_MCP_TUNNEL';

/**
 * Parse a FAB_MCP_TUNNEL spec into MCP server definitions. Entries that are
 * malformed (not `name=url`), reuse a built-in server name, or carry a
 * non-https / unparseable URL are skipped with a warning rather than failing
 * the whole run.
 */
export function parseTunnelRegistry(spec: string | undefined): Record<string, McpServerDef> {
  const registry: Record<string, McpServerDef> = {};
  if (!spec) return registry;

  for (const entry of spec.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = eq === -1 ? '' : trimmed.slice(0, eq).trim();
    const url = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    if (!name || !url) {
      process.stderr.write(`[mcp] ignoring malformed ${TUNNEL_ENV} entry (expected name=url): ${trimmed}\n`);
      continue;
    }
    // A tunnel must never shadow a built-in server — that would redirect a
    // role's `github`/`linear`/etc. to an operator-supplied URL.
    if (Object.hasOwn(REGISTRY, name)) {
      process.stderr.write(`[mcp] ignoring ${TUNNEL_ENV} entry "${name}": name collides with a built-in server\n`);
      continue;
    }
    // The tunnel hands out an ordinary https URL; reject anything that isn't a
    // parseable https URL (blocks http://, file://, javascript:, and garbage).
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      process.stderr.write(`[mcp] ignoring ${TUNNEL_ENV} entry "${name}": not a valid URL: ${url}\n`);
      continue;
    }
    if (parsed.protocol !== 'https:') {
      process.stderr.write(
        `[mcp] ignoring ${TUNNEL_ENV} entry "${name}": tunnel URLs must use https (got "${parsed.protocol}"): ${url}\n`,
      );
      continue;
    }
    registry[name] = {
      name,
      description: 'Private MCP server via MCP tunnel',
      defaultUrl: url,
      envOverride: '',
    };
  }
  return registry;
}

/** The static registry plus any FAB_MCP_TUNNEL private servers. */
function fullRegistry(): Record<string, McpServerDef> {
  return { ...REGISTRY, ...parseTunnelRegistry(process.env[TUNNEL_ENV]) };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Resolve MCP server names into McpServer configs and their tool entries.
 * Servers are always included — env vars override the default URL.
 */
export function resolveMcpServers(serverNames: string[]): { servers: McpServer[]; tools: Tool[] } {
  const registry = fullRegistry();
  const servers: McpServer[] = [];
  const tools: Tool[] = [];

  for (const name of serverNames) {
    const def = registry[name];
    if (!def) continue;

    const url = (def.envOverride && process.env[def.envOverride]) || def.defaultUrl;

    const headers = def.headers;
    servers.push({ type: 'url', name: def.name, url, ...(headers && { headers }) });
    tools.push({
      type: 'mcp_toolset',
      mcp_server_name: def.name,
      default_config: {
        enabled: true,
        permission_policy: { type: 'always_allow' },
      },
    });
  }

  return { servers, tools };
}

/**
 * Get the full registry for display (e.g., help text, config commands).
 */
export function getRegistry(): Record<string, McpServerDef> {
  return fullRegistry();
}
