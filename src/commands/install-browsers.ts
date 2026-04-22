import type { CommandModule } from 'yargs';
import { installBrowsers } from '../sync/browser.ts';

const handler: CommandModule['handler'] = async () => {
  await installBrowsers();
};

export const command: CommandModule = {
  command: 'install-browsers',
  describe: 'Download Chromium via playwright-core (required for sync on fresh machines)',
  handler,
};
