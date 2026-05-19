import type { AgentEvent } from './types.js';

// ── Terminal formatting ─────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;
const c = (code: string) => (isTTY ? code : '');

const DIM = c('\x1b[2m');
const BOLD = c('\x1b[1m');
const RESET = c('\x1b[0m');
const GREEN = c('\x1b[32m');
const YELLOW = c('\x1b[33m');
const RED = c('\x1b[31m');
const CYAN = c('\x1b[36m');
const MAGENTA = c('\x1b[35m');

export function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'agent.message': {
      const text = event.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      return text;
    }

    case 'agent.tool_use':
      return `${DIM}${CYAN}tool:${RESET} ${BOLD}${event.name}${RESET}${DIM}(${truncate(JSON.stringify(event.input), 120)})${RESET}`;

    case 'agent.tool_result': {
      const text = event.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (event.is_error) {
        return `${RED}error:${RESET} ${truncate(text, 200)}`;
      }
      return `${DIM}result: ${truncate(text, 200)}${RESET}`;
    }

    case 'agent.custom_tool_use':
      return `${DIM}${CYAN}custom_tool:${RESET} ${BOLD}${event.name}${RESET}${DIM}(${truncate(JSON.stringify(event.input), 120)})${RESET}`;

    case 'agent.mcp_tool_use':
      return `${DIM}${CYAN}mcp:${RESET} ${BOLD}${event.server_name}/${event.name}${RESET}${DIM}(${truncate(JSON.stringify(event.input), 120)})${RESET}`;

    case 'agent.mcp_tool_result': {
      const text = event.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (event.is_error) {
        return `${RED}mcp error:${RESET} ${truncate(text, 200)}`;
      }
      return `${DIM}mcp result: ${truncate(text, 200)}${RESET}`;
    }

    case 'agent.thinking':
      return `${DIM}${MAGENTA}thinking...${RESET}`;

    case 'agent.thread_context_compacted':
      return `${DIM}${YELLOW}context compacted${RESET}`;

    case 'agent.thread_message_sent':
      return `${DIM}${CYAN}→ thread ${event.session_thread_id}${RESET}`;

    case 'agent.thread_message_received':
      return `${DIM}${CYAN}← thread ${event.session_thread_id}${RESET}`;

    case 'session.status_running':
      return `${GREEN}running${RESET}`;

    case 'session.status_idle': {
      const reason = event.stop_reason?.type ?? 'unknown';
      return `${YELLOW}idle${RESET} ${DIM}(${reason})${RESET}`;
    }

    case 'session.status_rescheduled':
      return `${YELLOW}rescheduled${RESET} ${DIM}(transient error — retrying)${RESET}`;

    case 'session.status_terminated':
      return `${RED}terminated${RESET} ${DIM}(unrecoverable error)${RESET}`;

    case 'session.thread_created':
      return `${CYAN}thread:${RESET} ${event.session_thread_id}`;

    case 'session.thread_idle':
      return `${DIM}thread idle:${RESET} ${event.session_thread_id}`;

    case 'session.error':
      return `${RED}error:${RESET} ${event.error.message}`;

    default:
      return `${DIM}${(event as { type: string }).type}${RESET}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
