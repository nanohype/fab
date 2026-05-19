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
// gcal, gcse, stripe. Memory server at /memory (not under /mcp/).
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
  // ── Semantic memory (mcp-gateway memory Lambda, /memory route) ──
  // Exposes MCP tools: memory_store, memory_query, memory_list, memory_delete.
  memory: {
    name: 'memory',
    description: 'Semantic memory — store/query learnings by similarity with tags and TTL',
    defaultUrl: `${GATEWAY_BASE}/memory`,
    envOverride: 'MCP_MEMORY_URL',
  },
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Resolve MCP server names into McpServer configs and their tool entries.
 * Servers are always included — env vars override the default URL.
 */
export function resolveMcpServers(serverNames: string[]): { servers: McpServer[]; tools: Tool[] } {
  const servers: McpServer[] = [];
  const tools: Tool[] = [];

  for (const name of serverNames) {
    const def = REGISTRY[name];
    if (!def) continue;

    const url = process.env[def.envOverride] || def.defaultUrl;

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
  return REGISTRY;
}
