// Raw CLI argument parser — no yargs/commander (see CLAUDE.md).

export interface ParsedArgs {
  command: string;
  sub: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Flags that never take a value. The parser must not consume the next
// token as their value — otherwise a boolean flag placed before a
// positional silently swallows it.
const BOOLEAN_FLAGS = new Set([
  'dry-run',
  'skip-skills',
  'fast',
  'allow-create',
  'skip-intake',
  'no-gates',
  'sequential',
  'enable',
  'disable',
  'all',
  'help',
  'h',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = { command: '', sub: '', positional: [], flags: {} };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!BOOLEAN_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result.flags[key] = args[++i];
      } else {
        result.flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      if (!BOOLEAN_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result.flags[key] = args[++i];
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else if (!result.sub) {
      result.sub = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}
