/**
 * `fmrules sync` — replace all Fastmail rules with a mailrules.json.
 *
 * Driven via JMAP (Rule/set), not the web UI: UI automation proved flaky
 * (SPA re-render strict-mode races, select-all races, reload stalls)
 * while every JMAP operation has been reliable. The flow:
 *
 *   1. Pre-create any labels the rules file into (Fastmail's import does
 *      not create them).
 *   2. Shape-check the file and require every incoming rule to carry a
 *      structured `filter` (compile output from fmrules ≥ 4.1.2). Abort
 *      BEFORE destroying anything if any rule can't be created — never
 *      wipe-then-fail on a malformed or filterless file.
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
export function labelsInRules(buffer: Buffer): string[] {
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
 * Parse and shape-check a mailrules.json buffer. Every entry must be an
 * object with a non-empty "name" string — a malformed file must fail
 * here, in pre-flight, never after the existing rules are destroyed.
 */
export function parseRules(buffer: Buffer): MailRule[] {
  const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('mailrules.json is not a rule array.');
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`mailrules.json entry ${i} is not a rule object.`);
    }
    const rule = entry as Record<string, unknown>;
    if (typeof rule.name !== 'string' || rule.name.length === 0) {
      throw new Error(`mailrules.json entry ${i} has no "name" string.`);
    }
    return rule as MailRule;
  });
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
    ctx.log.error('Pass exactly one of --file or --repo, not both.');
    process.exit(1);
  }
  if (!file && !repo) {
    ctx.log.error('Pass one of --file <path> or --repo <owner/name> (or set GITHUB_REPO).');
    process.exit(1);
  }

  let rules: LatestRules;
  if (file) {
    ctx.log.info(`Loading rules from ${file}...`);
    rules = await loadLocalRules(file);
  } else {
    ctx.log.info(`Downloading latest mailrules from ${repo}...`);
    rules = await downloadLatestRules(repo as string);
  }
  ctx.log.info(`Source has ${rules.count} rules.`);

  const session = await JmapSession.connect({
    auth: argv.auth as string,
    chromium: argv.chromium as string | undefined,
    headed: argv.headed as boolean,
  });
  let ok = true;
  try {
    // Pre-flight 1: create labels the rules file into (Fastmail's rule
    // import does not create them; a rule firing into a missing label
    // silently loses the label).
    const createdLabels = await ensureLabelsExist(session, labelsInRules(rules.buffer));
    if (createdLabels.length > 0) {
      ctx.log.info(`Created missing label(s): ${createdLabels.join(', ')}`);
    }

    // Pre-flight 2: shape-check the file, then require every rule to
    // carry a structured filter. Aborting here keeps the existing rules
    // intact when the file can't be fully imported — the old flow wiped
    // first and failed after.
    const parsed = parseRules(rules.buffer);
    const filterless = parsed.filter((r) => r.filter == null);
    if (filterless.length > 0) {
      ctx.log.error(
        `${filterless.length} rule(s) have no structured filter — they use condition form(s) with no ` +
          'structured equivalent (`when: always`, VIP/contact-group membership, or `raw:` forms beyond `with:`) ' +
          'and cannot be JMAP-imported: ' +
          `${filterless.slice(0, 3).map((r) => r.name).join(', ')}` +
          (filterless.length > 3 ? '…' : ''),
      );
      ok = false;
    } else {
      // Destroy existing rules.
      const existing: JmapRule[] = await session.getRules();
      if (existing.length > 0) {
        const destroyed = await session.destroyRules(existing.map((r) => r.id));
        ctx.log.info(`Deleted ${destroyed.length} existing rule(s).`);
      } else {
        ctx.log.info('No existing rules to delete.');
      }

      // Create the new set; verify against the server's confirmation.
      // fileIn names → mailbox ids over ALL mailboxes (case-insensitive),
      // the same name space ensureLabelsExist just validated against — a
      // name that passes pre-flight must also resolve here, or the
      // failure would land after the destroy step.
      const mailboxes = await session.getMailboxes();
      const labelIds = new Map(mailboxes.map((m) => [m.name.toLowerCase(), m.id]));
      const created = await session.createRules(parsed as Record<string, unknown>[], labelIds);
      if (created !== rules.count) {
        throw new Error(`Imported ${created} rules, expected ${rules.count}.`);
      }
      ctx.log.info(`Imported ${created} rules. Import confirmed.`);
    }
  } finally {
    await session.close();
  }
  if (!ok) process.exit(1);
};

export const command: CommandModule = {
  command: 'sync',
  describe: 'Replace all Fastmail rules with a mailrules.json (local file or GitHub release), via JMAP',
  builder,
  handler,
};
