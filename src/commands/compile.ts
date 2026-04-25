import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { printErrors, runPipeline } from '../compile/pipeline.ts';

const builder = (y: Argv) =>
  y.options({
    out: { type: 'string', alias: 'o', default: 'mailrules.json' },
    lockfile: { type: 'boolean', default: true, describe: 'Read/write meta/lockfile.json (disable with --no-lockfile)' },
    'dry-run': { type: 'boolean', default: false, describe: "Don't write files; print an add/change/remove summary" },
  });

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });
  const result = await runPipeline(ctx, {
    out: argv.out as string,
    useLockfile: argv.lockfile as boolean,
    dryRun: argv['dry-run'] as boolean,
  });
  printErrors(ctx, result);
  if (result.errors.length > 0) {
    ctx.log.error(`${result.errors.length} error(s) — compile failed; no output written.`);
    process.exit(1);
  }
  if (!argv['dry-run']) {
    ctx.log.info(`Wrote ${result.emittedCount} rule(s) to ${argv.out as string}.`);
  }
};

export const command: CommandModule = {
  command: 'compile',
  describe: 'Compile YAML sources into mailrules.json',
  builder,
  handler,
};
