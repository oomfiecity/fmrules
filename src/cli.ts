#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { command as compile } from './commands/compile.ts';
import { command as check } from './commands/check.ts';
import { command as migrate } from './commands/migrate.ts';
import { command as match } from './commands/match.ts';
import { command as revert } from './commands/revert.ts';
import { command as sync } from './commands/sync.ts';
import { command as login } from './commands/login.ts';
import { command as installBrowsers } from './commands/install-browsers.ts';

await yargs(hideBin(process.argv))
  .scriptName('fmrules')
  .usage('$0 <command> [options]')
  .options({
    rules: { type: 'string', default: 'rules', describe: 'Rules source directory' },
    meta: { type: 'string', default: 'meta', describe: 'Meta directory' },
    cwd: { type: 'string', describe: 'Run as if in this directory' },
    verbose: { type: 'count', alias: 'v', describe: 'Increase log verbosity' },
    quiet: { type: 'boolean', alias: 'q', default: false, describe: 'Suppress non-error output' },
    color: { type: 'boolean', default: true, describe: 'Enable ANSI colors' },
  })
  .command(compile)
  .command(check)
  .command(migrate)
  .command(match)
  .command(revert)
  .command(sync)
  .command(login)
  .command(installBrowsers)
  .demandCommand(1, 'Specify a subcommand (compile | check | migrate | match | revert | sync | login | install-browsers)')
  .strict()
  .help()
  .alias('help', 'h')
  .version()
  .parseAsync();
