#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { command as compile } from './commands/compile.ts';
import { command as check } from './commands/check.ts';
import { command as sync } from './commands/sync.ts';
import { command as login } from './commands/login.ts';
import { command as installBrowsers } from './commands/install-browsers.ts';

// Stamped at build time by `scripts/build.ts` via Bun.build's `define`.
// Falls back to `dev` when running source directly (`bun run src/cli.ts`),
// so an unbuilt invocation never claims a real version.
declare const __FMRULES_VERSION__: string | undefined;
const VERSION = typeof __FMRULES_VERSION__ === 'string' ? __FMRULES_VERSION__ : 'dev';

await yargs(hideBin(process.argv))
  .scriptName('fmrules')
  .usage('$0 <command> [options]')
  .options({
    cwd: { type: 'string', describe: 'Project root (contains manifest.yml, rules/, snippets/)' },
    verbose: { type: 'count', alias: 'v', describe: 'Increase log verbosity' },
    quiet: { type: 'boolean', alias: 'q', default: false, describe: 'Suppress non-error output' },
    color: { type: 'boolean', default: true, describe: 'Enable ANSI colors' },
  })
  .command(compile)
  .command(check)
  .command(sync)
  .command(login)
  .command(installBrowsers)
  .demandCommand(1, 'Specify a subcommand (compile | check | sync | login | install-browsers)')
  .strict()
  .help()
  .alias('help', 'h')
  .version(VERSION)
  .parseAsync();
