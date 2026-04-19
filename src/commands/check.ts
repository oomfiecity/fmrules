import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { runPipeline } from '../compile/pipeline.ts';

const builder = (y: Argv) =>
  y.options({
    strict: { type: 'boolean', default: false, describe: 'Treat warnings as errors' },
    rule: { type: 'string', describe: 'Limit check to rules matching this name (glob)' },
    format: { choices: ['human', 'json'] as const, default: 'human' as const },
  });

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    rules: argv.rules as string,
    meta: argv.meta as string,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });
  try {
    await runPipeline(ctx, {
      checkOnly: true,
      strict: argv.strict as boolean,
      filterRule: argv.rule as string | undefined,
      format: argv.format as 'human' | 'json',
    });
    ctx.log.info('All rules passed validation.');
  } catch (err) {
    ctx.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
};

export const command: CommandModule = {
  command: 'check',
  describe: 'Validate YAML sources without emitting',
  builder,
  handler,
};
