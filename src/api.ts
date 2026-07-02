import type {
  Agent,
  AgentCreateParams,
  AgentEvent,
  Environment,
  EnvironmentCreateParams,
  MemoryStore,
  MemoryStoreCreateParams,
  Paginated,
  Session,
  SessionCreateParams,
  Skill,
  SkillCreateParams,
  UserEvent,
} from './types.js';

const BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const BETA = 'managed-agents-2026-04-01,skills-2025-10-02';

export class AnthropicAgents {
  private headers: Record<string, string>;

  constructor(apiKey: string) {
    this.headers = {
      'X-Api-Key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-beta': BETA,
      'Content-Type': 'application/json',
    };
  }

  // ── Agents ──────────────────────────────────────────────────────

  async createAgent(params: AgentCreateParams): Promise<Agent> {
    return this.post('/v1/agents', params);
  }

  async getAgent(id: string, version?: number): Promise<Agent> {
    const qs = version ? `?version=${version}` : '';
    return this.get(`/v1/agents/${id}${qs}`);
  }

  async listAgents(limit = 20, page?: string): Promise<Paginated<Agent>> {
    const qs = page ? `&page=${encodeURIComponent(page)}` : '';
    return this.get(`/v1/agents?limit=${limit}&include_archived=false${qs}`);
  }

  async listAgentVersions(id: string, limit = 20): Promise<Paginated<Agent>> {
    return this.get(`/v1/agents/${id}/versions?limit=${limit}`);
  }

  async archiveAgent(id: string): Promise<Agent> {
    return this.post(`/v1/agents/${id}/archive`, {});
  }

  async updateAgent(
    id: string,
    version: number,
    params: Partial<AgentCreateParams>,
  ): Promise<Agent> {
    return this.post(`/v1/agents/${id}`, { version, ...params });
  }

  // ── Environments ───────────────────────────────────────────────

  async createEnvironment(params: EnvironmentCreateParams): Promise<Environment> {
    return this.post('/v1/environments', params);
  }

  async getEnvironment(id: string): Promise<Environment> {
    return this.get(`/v1/environments/${id}`);
  }

  async listEnvironments(limit = 20, page?: string): Promise<Paginated<Environment>> {
    const qs = page ? `&page=${encodeURIComponent(page)}` : '';
    return this.get(`/v1/environments?limit=${limit}${qs}`);
  }

  async archiveEnvironment(id: string): Promise<Environment> {
    return this.post(`/v1/environments/${id}/archive`, {});
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.del(`/v1/environments/${id}`);
  }

  // ── Skills ──────────────────────────────────────────────────────

  async createSkill(params: SkillCreateParams): Promise<Skill> {
    // Skills API requires multipart/form-data with files[] field
    const skillMd = params.content;
    const form = new FormData();

    // Pack SKILL.md into a directory structure: skill-name/SKILL.md
    const dirName = params.name;
    const blob = new Blob([skillMd], { type: 'text/markdown' });
    form.append('files[]', blob, `${dirName}/SKILL.md`);

    // Add reference files if any
    if (params.reference_files) {
      for (const ref of params.reference_files) {
        const refBlob = new Blob([ref.content], { type: 'text/markdown' });
        form.append('files[]', refBlob, `${dirName}/${ref.name}`);
      }
    }

    // Multipart request — don't set Content-Type (fetch sets boundary automatically)
    const { 'Content-Type': _ct, ...headersWithoutCT } = this.headers;
    const res = await fetch(`${BASE}/v1/skills`, {
      method: 'POST',
      headers: headersWithoutCT,
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /v1/skills failed (${res.status}): ${text}`);
    }

    const skill = (await res.json()) as Skill;

    // Create the first version with the same files
    const versionForm = new FormData();
    versionForm.append(
      'files[]',
      new Blob([skillMd], { type: 'text/markdown' }),
      `${dirName}/SKILL.md`,
    );
    if (params.reference_files) {
      for (const ref of params.reference_files) {
        versionForm.append(
          'files[]',
          new Blob([ref.content], { type: 'text/markdown' }),
          `${dirName}/${ref.name}`,
        );
      }
    }

    const vRes = await fetch(`${BASE}/v1/skills/${skill.id}/versions`, {
      method: 'POST',
      headers: headersWithoutCT,
      body: versionForm,
      signal: AbortSignal.timeout(30_000),
    });

    if (!vRes.ok) {
      const text = await vRes.text();
      throw new Error(`POST /v1/skills/${skill.id}/versions failed (${vRes.status}): ${text}`);
    }

    return skill;
  }

  async updateSkillVersion(skillId: string, params: SkillCreateParams): Promise<void> {
    const dirName = params.name;
    const form = new FormData();
    form.append(
      'files[]',
      new Blob([params.content], { type: 'text/markdown' }),
      `${dirName}/SKILL.md`,
    );
    if (params.reference_files) {
      for (const ref of params.reference_files) {
        form.append(
          'files[]',
          new Blob([ref.content], { type: 'text/markdown' }),
          `${dirName}/${ref.name}`,
        );
      }
    }

    const { 'Content-Type': _ct, ...headersWithoutCT } = this.headers;
    const res = await fetch(`${BASE}/v1/skills/${skillId}/versions`, {
      method: 'POST',
      headers: headersWithoutCT,
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST /v1/skills/${skillId}/versions failed (${res.status}): ${text}`);
    }
  }

  async getSkill(id: string): Promise<Skill> {
    return this.get(`/v1/skills/${id}`);
  }

  async listSkills(limit = 50, page?: string): Promise<Paginated<Skill>> {
    const qs = page ? `&page=${encodeURIComponent(page)}` : '';
    return this.get(`/v1/skills?limit=${limit}${qs}`);
  }

  async archiveSkill(id: string): Promise<Skill> {
    return this.post(`/v1/skills/${id}/archive`, {});
  }

  // ── Vaults ──────────────────────────────────────────────────────

  async createVault(
    displayName: string,
    metadata?: Record<string, string>,
  ): Promise<{ id: string; display_name: string }> {
    return this.post('/v1/vaults', { display_name: displayName, ...(metadata && { metadata }) });
  }

  async listVaults(): Promise<
    Paginated<{ id: string; display_name: string; archived_at: string | null }>
  > {
    return this.get('/v1/vaults?limit=50&include_archived=false');
  }

  async archiveVault(id: string): Promise<unknown> {
    return this.post(`/v1/vaults/${id}/archive`, {});
  }

  async createCredential(
    vaultId: string,
    displayName: string,
    auth:
      | { type: 'static_bearer'; mcp_server_url: string; token: string }
      | {
          type: 'mcp_oauth';
          mcp_server_url: string;
          access_token: string;
          expires_at?: string;
          refresh?: {
            token_endpoint: string;
            client_id: string;
            scope?: string;
            refresh_token: string;
            token_endpoint_auth: { type: string; client_secret?: string };
          };
        },
  ): Promise<{ id: string }> {
    return this.post(`/v1/vaults/${vaultId}/credentials`, { display_name: displayName, auth });
  }

  async listCredentials(
    vaultId: string,
  ): Promise<
    Paginated<{ id: string; display_name: string; auth: { type: string; mcp_server_url: string } }>
  > {
    return this.get(`/v1/vaults/${vaultId}/credentials?limit=50`);
  }

  // ── Memory Stores ───────────────────────────────────────────────

  async createMemoryStore(params: MemoryStoreCreateParams): Promise<MemoryStore> {
    return this.post('/v1/memory_stores', params);
  }

  async getMemoryStore(id: string): Promise<MemoryStore> {
    return this.get(`/v1/memory_stores/${id}`);
  }

  // ── Sessions ────────────────────────────────────────────────────

  async createSession(params: SessionCreateParams): Promise<Session> {
    return this.post('/v1/sessions', params);
  }

  async getSession(id: string): Promise<Session> {
    return this.get(`/v1/sessions/${id}`);
  }

  async listSessions(limit = 20, page?: string): Promise<Paginated<Session>> {
    const qs = page ? `&page=${encodeURIComponent(page)}` : '';
    return this.get(`/v1/sessions?limit=${limit}${qs}`);
  }

  async archiveSession(id: string): Promise<Session> {
    return this.post(`/v1/sessions/${id}/archive`, {});
  }

  async deleteSession(id: string): Promise<void> {
    await this.del(`/v1/sessions/${id}`);
  }

  // ── Events ──────────────────────────────────────────────────────

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const events: UserEvent[] = [{ type: 'user.message', content: [{ type: 'text', text }] }];
    await this.post(`/v1/sessions/${sessionId}/events`, { events });
  }

  async interrupt(sessionId: string): Promise<void> {
    const events: UserEvent[] = [{ type: 'user.interrupt' }];
    await this.post(`/v1/sessions/${sessionId}/events`, { events });
  }

  async confirmTool(
    sessionId: string,
    toolUseId: string,
    result: 'allow' | 'deny',
    threadId?: string,
  ): Promise<void> {
    const event: UserEvent = {
      type: 'user.tool_confirmation',
      tool_use_id: toolUseId,
      result,
      ...(threadId && { session_thread_id: threadId }),
    };
    await this.post(`/v1/sessions/${sessionId}/events`, { events: [event] });
  }

  async sendCustomToolResult(
    sessionId: string,
    customToolUseId: string,
    content: string,
    isError = false,
  ): Promise<void> {
    const event: UserEvent = {
      type: 'user.custom_tool_result',
      custom_tool_use_id: customToolUseId,
      content: [{ type: 'text', text: content }],
      is_error: isError || undefined,
    };
    await this.post(`/v1/sessions/${sessionId}/events`, { events: [event] });
  }

  async listEvents(
    sessionId: string,
    limit = 100,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<Paginated<AgentEvent>> {
    return this.get(`/v1/sessions/${sessionId}/events?limit=${limit}&order=${order}`);
  }

  // ── Pagination ────────────────────────────────────────────────

  /**
   * Follow pagination cursors to fetch all pages of a list endpoint.
   * Pass a function that calls one of the list methods with limit and optional page params.
   */
  async listAll<T>(fetchPage: (page?: string) => Promise<Paginated<T>>): Promise<T[]> {
    const all: T[] = [];
    let page: string | undefined;
    do {
      const result = await fetchPage(page);
      all.push(...result.data);
      page = result.next_page ?? undefined;
    } while (page);
    return all;
  }

  // ── Streaming ─────────────────────────────────────────────────

  async *stream(sessionId: string, timeoutMs = 300_000): AsyncGenerator<AgentEvent> {
    yield* this.streamSSE(`/v1/sessions/${sessionId}/events/stream`, timeoutMs);
  }

  // ── Threads (multiagent) ──────────────────────────────────────

  async listThreads(
    sessionId: string,
  ): Promise<Paginated<{ id: string; agent_id: string; status: string }>> {
    return this.get(`/v1/sessions/${sessionId}/threads`);
  }

  async *streamThread(
    sessionId: string,
    threadId: string,
    timeoutMs = 300_000,
  ): AsyncGenerator<AgentEvent> {
    yield* this.streamSSE(`/v1/sessions/${sessionId}/threads/${threadId}/events/stream`, timeoutMs);
  }

  private async *streamSSE(
    path: string,
    timeoutMs: number,
    maxRetries = 3,
  ): AsyncGenerator<AgentEvent> {
    let lastEventId: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        const streamHeaders: Record<string, string> = { ...this.headers };
        if (lastEventId) {
          streamHeaders['Last-Event-ID'] = lastEventId;
        }

        const res = await fetch(`${BASE}${path}`, {
          headers: streamHeaders,
          signal,
        });

        if (!res.ok) {
          const body = await res.text();
          const status = res.status;
          if ((status === 429 || status >= 500) && attempt < maxRetries) {
            // Equal jitter on the capped exponential backoff so retrying clients
            // don't reconnect in lockstep (thundering herd).
            const delay = Math.round(
              Math.min(1000 * 2 ** attempt, 10_000) * (0.5 + Math.random() * 0.5),
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`Stream failed (${status}): ${body}`);
        }

        if (!res.body) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk as BufferSource, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('id: ')) {
              lastEventId = line.slice(4).trim();
              continue;
            }
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6).trim();
            if (!json || json === '[DONE]') continue;
            try {
              const event = JSON.parse(json) as AgentEvent;
              if ('id' in event && typeof event.id === 'string') {
                lastEventId = event.id;
              }
              yield event;
            } catch {
              process.stderr.write(`warning: malformed SSE event: ${json.slice(0, 100)}\n`);
            }
          }
        }

        // Stream ended normally
        return;
      } catch (err) {
        // AbortError from timeout — don't retry
        if (err instanceof DOMException && err.name === 'AbortError') throw err;

        // Network error — retry if attempts remain
        if (attempt < maxRetries) {
          // Equal jitter on the capped exponential backoff so retrying clients
          // don't reconnect in lockstep (thundering herd).
          const delay = Math.round(
            Math.min(1000 * 2 ** attempt, 10_000) * (0.5 + Math.random() * 0.5),
          );
          process.stderr.write(
            `warning: stream disconnected, reconnecting in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...\n`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.withRetry('GET', path, async () => {
      const res = await fetch(`${BASE}${path}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new HttpError(`GET ${path} failed (${res.status}): ${body}`, res.status);
      }
      return res.json() as Promise<T>;
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.withRetry('POST', path, async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(`POST ${path} failed (${res.status}): ${text}`, res.status);
      }
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : (undefined as T);
    });
  }

  private async del(path: string): Promise<void> {
    return this.withRetry('DELETE', path, async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: 'DELETE',
        headers: this.headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new HttpError(`DELETE ${path} failed (${res.status}): ${body}`, res.status);
      }
    });
  }

  /**
   * Retry transient failures (429, 500, 502, 503, 504) with exponential backoff.
   * Client errors (4xx except 429) are not retried.
   */
  private async withRetry<T>(
    _method: string,
    _path: string,
    fn: () => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 0;
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt === maxRetries) throw err;
        const delay = Math.round(
          Math.min(1000 * 2 ** attempt, 10_000) * (0.5 + Math.random() * 0.5),
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error('unreachable');
  }
}

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
