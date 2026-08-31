/**
 * `fmrules sync` — replace all Fastmail rules with a mailrules.json.
 *
 * Driven via JMAP (Rule/set), not the web UI: UI automation proved flaky
 * (SPA re-render strict-mode races, select-all races, reload stalls)
 * while every JMAP operation has been reliable. The flow:
 *
 *   1. Pre-create any labels the rules file into (Fastmail's import does
 *      not create them).
 *   2. Validate every incoming rule has a structured `filter` (compile
 *      output from fmrules ≥ 4.1.2). Abort BEFORE destroying anything if
 *      any rule can't be created — never wipe-then-fail.
 *   3. Destroy all existing rules, create the new set, verify the count
 *      against the server's confirmation.
 */

import type { Argv, CommandModule } from 'yargs';
import { downloadLatestRules, loadLocalRules, type LatestRules } from '../sync/release.ts';
import { createContext } from '../context.ts';
import { JmapSession, type JmapRule } from '../live/jmap.ts';
import { ensureLabelsExist } from '../live/engine.ts';

interface MailRule extends Record<string, unknown> {
  name: string;
  filter?: unknown;
}

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

function parseRules(buffer: Buffer): MailRule[] {
  const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('mailrules.json is not a rule array.');
  return parsed as MailRule[];
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
      describe: 'Show the browser while the session is open',
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

  const session = await JmapSession.connect({
    auth: argv.auth as string,
    chromium: argv.chromium as string | undefined,
    headed: argv.headed as boolean,
  });
  try {
    // Pre-flight 1: create labels the rules file into (Fastmail's rule
    // import does not create them; a rule firing into a missing label
    // silently loses the label).
    const createdLabels = await ensureLabelsExist(session, labelsInRules(rules.buffer));
    if (createdLabels.length > 0) {
      ctx.log.info(`Created missing label(s): ${createdLabels.join(', ')}`);
    }

    // Pre-flight 2: every rule must carry a structured filter. Aborting
    // here keeps the existing rules intact when the file can't be fully
    // imported — the old flow wiped first and failed after.
    const parsed = parseRules(rules.buffer);
    const filterless = parsed.filter((r) => r.filter == null);
    if (filterless.length > 0) {
      ctx.log.error(
        `${filterless.length} rule(s) have no structured filter — recompile ` +
          'mailrules.json with fmrules ≥ 4.1.2. Rules that use conditions with no ' +
          `structured form cannot be JMAP-imported: ${filterless.slice(0, 3).map((r) => r.name).join(', ')}` +
          (filterless.length > 3 ? '…' : ''),
      );
      process.exit(1);
    }

    // Destroy existing rules.
    const existing: JmapRule[] = await session.getRules();
    if (existing.length > 0) {
      const destroyed = await session.destroyRules(existing.map((r) => r.id));
      ctx.log.info(`Deleted ${destroyed.length} existing rule(s).`);
    } else {
      ctx.log.info('No existing rules to delete.');
    }

    // Create the new set; verify against the server's confirmation.
    // fileIn names → mailbox ids (labels were ensured above, so the map
    // is complete).
    const mailboxes = await session.getMailboxes();
    const labelIds = new Map(
      mailboxes.filter((m) => m.role === null).map((m) => [m.name.toLowerCase(), m.id]),
    );
    const created = await session.createRules(parsed as Record<string, unknown>[], labelIds);
    if (created !== rules.count) {
      throw new Error(`Imported ${created} rules, expected ${rules.count}.`);
    }
    ctx.log.info(`Imported ${created} rules. Import confirmed.`);
  } finally {
    await session.close();
  }
};

export const command: CommandModule = {
  command: 'sync',
  describe: 'Replace all Fastmail rules with a mailrules.json (local file or GitHub release), via JMAP',
  builder,
  handler,
};
