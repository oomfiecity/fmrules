import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { runPipeline } from '../compile/pipeline.ts';

const builder = (y: Argv) =>
  y.options({
    out: { type: 'string', alias: 'o', default: 'mailrules.json' },
    'dry-run': { type: 'boolean', default: false },
    lockfile: { type: 'boolean', default: true },
    pretty: { type: 'boolean', default: true },
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
      out: argv.out as string,
      dryRun: argv['dry-run'] as boolean,
      useLockfile: argv.lockfile as boolean,
      pretty: argv.pretty as boolean,
    });
  } catch (err) {
    ctx.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
};

export const command: CommandModule = {
  command: 'compile',
  describe: 'Compile YAML sources into mailrules.json',
  builder,
  handler,
};
