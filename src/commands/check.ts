import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { printErrors, runPipeline } from '../compile/pipeline.ts';

const builder = (y: Argv) => y;

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });
  const result = await runPipeline(ctx, { checkOnly: true });
  printErrors(ctx, result);
  if (result.errors.length > 0) {
    ctx.log.error(`${result.errors.length} error(s) — check failed.`);
    process.exit(1);
  }
  ctx.log.info(`Checked ${result.emittedCount} rule(s) across ${result.files.length} file(s).`);
};

export const command: CommandModule = {
  command: 'check',
  describe: 'Validate YAML sources without emitting',
  builder,
  handler,
};
