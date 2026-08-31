import type { Argv, CommandModule } from 'yargs';
import { syncRules } from '../sync/ui.ts';
import { downloadLatestRules, loadLocalRules, type LatestRules } from '../sync/release.ts';
import { createContext } from '../context.ts';
import { JmapSession } from '../live/jmap.ts';
import { ensureLabelsExist } from '../live/engine.ts';

/** Unique fileIn label names referenced by a mailrules.json buffer. */
function labelsInRules(buffer: Buffer): string[] {
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .map((r) => (r as { fileIn?: string | null }).fileIn)
          .filter((l): l is string => typeof l === 'string'),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Fastmail's filter import does not create labels that rules reference —
 * a rule filing into a missing label silently loses the label. Create any
 * missing labels before the import runs.
 */
async function ensureLabels(auth: string, chromium: string | undefined, rules: LatestRules): Promise<string[]> {
  const labels = labelsInRules(rules.buffer);
  if (labels.length === 0) return [];
  const session = await JmapSession.connect({ auth, chromium });
  try {
    return await ensureLabelsExist(session, labels);
  } finally {
    await session.close();
  }
}

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
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });
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
  ctx.log.info(`Source has ${rules.count} rules.`);

  // Pre-flight: create labels the rules file into before import.
  const createdLabels = await ensureLabels(
    argv.auth as string,
    argv.chromium as string | undefined,
    rules,
  );
  if (createdLabels.length > 0) {
    ctx.log.info(`Created missing label(s): ${createdLabels.join(', ')}`);
  }

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
