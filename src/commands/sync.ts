import type { Argv, CommandModule } from 'yargs';
import { syncRules } from '../sync/ui.ts';
import { downloadLatestRules, loadLocalRules, type LatestRules } from '../sync/release.ts';

const builder = (y: Argv) =>
  y.options({
    file: {
      type: 'string',
      describe: 'Local path to a mailrules.json to sync',
    },
    repo: {
      type: 'string',
      describe: 'GitHub owner/repo to fetch the latest mailrules.json release from',
      default: process.env.GITHUB_REPO,
    },
    auth: {
      type: 'string',
      describe: 'Path to Fastmail storage state',
      default: process.env.FASTMAIL_AUTH_PATH ?? './auth.json',
    },
    chromium: {
      type: 'string',
      describe: 'Path to a Chromium executable (overrides auto-detect)',
    },
    headed: {
      type: 'boolean',
      describe: 'Show the browser during sync',
      default: false,
    },
  });

const handler: CommandModule['handler'] = async (argv) => {
  const file = argv.file as string | undefined;
  const repo = argv.repo as string | undefined;

  if (file && repo) {
    console.error('Pass exactly one of --file or --repo, not both.');
    process.exit(1);
  }
  if (!file && !repo) {
    console.error('Pass one of --file <path> or --repo <owner/name> (or set GITHUB_REPO).');
    process.exit(1);
  }

  let rules: LatestRules;
  if (file) {
    console.log(`Loading rules from ${file}...`);
    rules = await loadLocalRules(file);
  } else {
    console.log(`Downloading latest mailrules from ${repo}...`);
    rules = await downloadLatestRules(repo as string);
  }
  console.log(`Source has ${rules.count} rules.`);

  const syncOpts = {
    auth: argv.auth as string,
    chromium: argv.chromium as string | undefined,
    headed: argv.headed as boolean,
    rules,
  };

  for (let retries = 0; retries < 5; retries++) {
    try {
      await syncRules(syncOpts);
      return;
    } catch (error) {
      const isLastTry = retries === 4;
      console.error(`Attempt ${retries + 1} failed: ${error}`);
      if (isLastTry) {
        console.error('Failed after 5 retries.');
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
};

export const command: CommandModule = {
  command: 'sync',
  describe: 'Delete all Fastmail filters, then import mailrules.json from a local file or a GitHub release',
  builder,
  handler,
};
