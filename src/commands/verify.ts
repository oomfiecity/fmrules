/**
 * `fmrules verify` — check rules against live mailbox content, server-side,
 * without changing anything.
 *
 * For each rule (optionally narrowed with --rule), this asks Fastmail's
 * search engine which messages in the scope mailbox the rule's condition
 * would claim, and reports counts plus samples. A rule that matches zero
 * messages is surfaced as a warning — usually the fastest signal that a
 * newly written or updated rule's matchers don't mean what the author
 * intended.
 *
 * This is a read-only operation: no Email/set is ever issued.
 */

import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { evaluateRules, describeActions, collectRuleLabels } from '../live/engine.ts';
import type { EmailSummary } from '../live/jmap.ts';

const builder = (y: Argv) =>
  y.options({
    auth: { type: 'string', describe: 'Path to Fastmail storage state', default: process.env.FASTMAIL_AUTH_PATH ?? './auth.json' },
    chromium: { type: 'string', describe: 'Path to a Chromium executable (overrides auto-detect)' },
    headed: { type: 'boolean', describe: 'Show the browser during verification', default: false },
    mailbox: { type: 'string', describe: 'Mailbox to verify against (name)', default: 'Inbox' },
    after: { type: 'string', describe: 'Only consider messages received after this date (YYYY-MM-DD, UTC day boundaries)' },
    before: { type: 'string', describe: 'Only consider messages received before this date (YYYY-MM-DD, UTC day boundaries)' },
    rule: { type: 'string', describe: 'Verify only rules whose name contains this substring' },
    limit: { type: 'number', describe: 'Sample matches shown per rule', default: 5 },
  });

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });

  const result = await evaluateRules(ctx, {
    auth: argv.auth as string,
    chromium: argv.chromium as string | undefined,
    headed: argv.headed as boolean,
    mailbox: argv.mailbox as string,
    after: argv.after as string | undefined,
    before: argv.before as string | undefined,
    rule: argv.rule as string | undefined,
  });

  try {
    const { matches, scopeIds } = result;

    // Pre-flight: labels rules reference but the account lacks. Read-only
    // report — apply/sync will create them.
    const mailboxByLower = new Map(result.mailboxes.map((m) => [m.name.toLowerCase(), m]));
    for (const label of collectRuleLabels(matches.map((m) => m.rule))) {
      const mb = mailboxByLower.get(label.toLowerCase());
      if (!mb) {
        ctx.log.warn(
          `label "${label}" does not exist on the account — ` +
            'rules filing into it will not label correctly until created (apply/sync create it automatically).',
        );
      } else if (mb.name !== label) {
        ctx.log.warn(
          `label case mismatch: rules say "${label}", account has "${mb.name}" — ` +
            'filing targets the existing mailbox, but delivery-time rule evaluation may differ. ' +
            'Consider normalising one side.',
        );
      }
    }

    ctx.log.info(`Verifying ${matches.length} rule(s) against ${scopeIds.length} message(s).\n`);

    const sampleIds = matches.flatMap((m) => m.matched.slice(0, (argv.limit as number) ?? 5));
    const emails = sampleIds.length
      ? await result.session.getEmails(sampleIds, ['id', 'from', 'subject', 'receivedAt'])
      : [];
    const byId = new Map<string, EmailSummary>(emails.map((e) => [e.id, e]));

    let zeroMatches = 0;
    for (const { rule, matched, unsupported } of matches) {
      const stop = rule.continueFlag ? '' : ' · stops chain';
      ctx.log.info(`${matched.length}  ${rule.name}  [${describeActions(rule.actions)}${stop}]`);
      for (const u of unsupported) ctx.log.warn(`  ↳ not server-evaluable: ${u}`);
      if (matched.length === 0) {
        zeroMatches++;
        ctx.log.warn(`  ↳ matches nothing in scope — check the matchers if this is unexpected`);
        continue;
      }
      const limit = (argv.limit as number) ?? 5;
      for (const id of matched.slice(0, limit)) {
        const e = byId.get(id);
        if (!e) continue;
        const from = (e.from ?? []).map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ');
        const date = e.receivedAt ? e.receivedAt.slice(0, 10) : '?';
        ctx.log.info(`  · ${date}  ${from} — ${(e.subject ?? '(no subject)').slice(0, 90)}`);
      }
      if (matched.length > limit) ctx.log.info(`  … and ${matched.length - limit} more`);
    }

    if (zeroMatches > 0) {
      ctx.log.warn(`\n${zeroMatches} rule(s) matched nothing in scope.`);
    }
  } finally {
    await result.session.close();
  }
};

export const command: CommandModule = {
  command: 'verify',
  describe: 'Check rules against live mailbox content server-side (read-only)',
  builder,
  handler,
};
