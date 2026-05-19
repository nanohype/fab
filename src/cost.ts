// ── Cost event uploader ─────────────────────────────────────────────
//
// Posts token usage and spend events to the mcp-gateway dashboard's
// cost-ingest endpoint. Enabled when MCP_GATEWAY_BASE_URL and
// MCP_GATEWAY_TOKEN are set. Silent no-op otherwise — cost tracking
// is optional.
//
// Dashboard route (protohype/mcp-gateway): POST /dashboard/api/cost
// Authorizer: same bearer token as switchboard/memory.

export interface CostEvent {
  sessionId: string;
  agentId?: string;
  agentRole?: string;
  workflow?: string;
  model: string;
  speed?: 'standard' | 'fast';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  source: 'managed_agents' | 'advisor' | 'claude-cli' | 'local';
  timestamp: string;
}

function gatewayUrl(): string | null {
  const base = process.env.MCP_GATEWAY_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/dashboard/api/cost`;
}

function gatewayToken(): string | null {
  return process.env.MCP_GATEWAY_TOKEN ?? null;
}

/**
 * Upload a cost event to the dashboard. Best-effort — logs to stderr on failure
 * but never throws, so cost tracking cannot break a workflow.
 */
export async function uploadCostEvent(event: CostEvent): Promise<void> {
  const url = gatewayUrl();
  const token = gatewayToken();
  if (!url || !token) return;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`cost upload failed (${res.status}): ${body.slice(0, 200)}\n`);
    }
  } catch (err) {
    process.stderr.write(`cost upload error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
