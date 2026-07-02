import { createInterface, type Interface } from 'node:readline';
import type { AnthropicAgents } from './api.js';
import type { TeamRole } from './types.js';
import { streamWithAdvisor, type StreamOptions } from './workflows.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

interface ReplOptions {
  api: AnthropicAgents;
  sessionId: string;
  role: TeamRole;
  onSwitch?: (newRole: TeamRole) => Promise<{ sessionId: string }>;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  let { sessionId, role } = options;
  const { api, onSwitch } = options;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  const promptStr = () => `${CYAN}${role}${RESET}${DIM}>${RESET} `;

  console.log(`${DIM}Session: ${sessionId}${RESET}`);
  console.log(
    `${DIM}Type /quit to exit, /status for session info, /switch <role> to change agent${RESET}\n`,
  );

  const askQuestion = (rl: Interface, prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });
  };

  // Interactive tool confirmation — prompts the user instead of auto-allowing
  const streamOpts: StreamOptions = {
    onToolConfirm: async (toolName, toolInput) => {
      const inputStr = JSON.stringify(toolInput);
      const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '...' : inputStr;
      process.stdout.write(
        `\n${YELLOW}${BOLD}Tool requires confirmation:${RESET} ${BOLD}${toolName}${RESET}${DIM}(${preview})${RESET}\n`,
      );
      const answer = await askQuestion(rl, `${YELLOW}allow?${RESET} ${DIM}(y/n)${RESET} `);
      return answer.toLowerCase().startsWith('y') ? 'allow' : 'deny';
    },
  };

  let running = true;

  while (running) {
    const input = await askQuestion(rl, promptStr());

    if (!input) continue;

    // Handle special commands
    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, { api, sessionId, role, rl });
      if (handled === 'quit') {
        running = false;
        continue;
      }
      if (handled === 'switch' && onSwitch) {
        const newRole = input.split(/\s+/)[1] as TeamRole;
        if (newRole) {
          try {
            const result = await onSwitch(newRole);
            sessionId = result.sessionId;
            role = newRole;
            console.log(`${DIM}Switched to ${newRole} — session: ${sessionId}${RESET}\n`);
          } catch (err) {
            console.error(`Switch failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      continue;
    }

    // Send message and stream response (with advisor support + tool confirmation)
    try {
      await api.sendMessage(sessionId, input);
      process.stdout.write('\n');
      await streamWithAdvisor(api, sessionId, streamOpts);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  rl.close();
}

interface SlashContext {
  api: AnthropicAgents;
  sessionId: string;
  role: TeamRole;
  rl: Interface;
}

async function handleSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<'quit' | 'switch' | 'handled'> {
  const [cmd] = input.split(/\s+/);

  switch (cmd) {
    case '/quit':
    case '/exit':
    case '/q':
      return 'quit';

    case '/status': {
      try {
        const sess = await ctx.api.getSession(ctx.sessionId);
        console.log(`${DIM}Session: ${sess.id}`);
        console.log(`Status: ${sess.status}`);
        console.log(`Agent: ${ctx.role}`);
        console.log(
          `Tokens: ${sess.usage.input_tokens} in / ${sess.usage.output_tokens} out${RESET}\n`,
        );
      } catch (err) {
        console.error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 'handled';
    }

    case '/threads': {
      try {
        const result = await ctx.api.listThreads(ctx.sessionId);
        if (result.data.length === 0) {
          console.log(`${DIM}No threads.${RESET}\n`);
        } else {
          for (const t of result.data) {
            console.log(`${DIM}${t.id}  agent:${t.agent_id}  ${t.status}${RESET}`);
          }
          console.log('');
        }
      } catch (err) {
        console.error(`Threads failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 'handled';
    }

    case '/switch': {
      const newRole = input.split(/\s+/)[1];
      if (!newRole) {
        console.error('Usage: /switch <role>\n');
        return 'handled';
      }
      return 'switch';
    }

    default:
      console.error(`Unknown command: ${cmd}\n`);
      return 'handled';
  }
}
