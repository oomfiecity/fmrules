import type { Argv, CommandModule } from 'yargs';
import { loginFlow } from '../sync/ui.ts';

const builder = (y: Argv) =>
  y.options({
    auth: {
      type: 'string',
      describe: 'Path to save Fastmail storage state',
      default: process.env.FASTMAIL_AUTH_PATH ?? './auth.json',
    },
    chromium: {
      type: 'string',
      describe: 'Path to a Chromium executable (overrides auto-detect)',
    },
  });

const handler: CommandModule['handler'] = async (argv) => {
  await loginFlow({
    auth: argv.auth as string,
    chromium: argv.chromium as string | undefined,
  });
};

export const command: CommandModule = {
  command: 'login',
  describe: 'Open a browser to sign in to Fastmail, then save the session to auth.json',
  builder,
  handler,
};
