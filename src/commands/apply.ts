/**
 * `fmrules apply` — retroactively apply rules to messages already in a
 * mailbox (default: the whole Inbox), via JMAP.
 *
 * Fastmail's rule engine only fires at delivery — this command is the
 * out-of-band operation SPEC(10).md §2 anticipated: it evaluates each
 * rule's condition through Fastmail's search engine, then performs the
 * rule's actions directly with Email/set — labels, read state, archive,
 * spam, trash — honouring the rule chain (stop flags, manifest order).
 *
 * Actions that only make sense at delivery (notify, forward, snooze) are
 * reported and skipped.
 *
 * Mutation safety: updates are sent as RFC 8620 PatchObject slash-path
 * patches (see live/jmap.ts updateEmails) — the same form Fastmail's own
 * web client uses — so server-managed keywords ($maskedemail) are never
 * touched and no whole-map replacement ever occurs. Use --dry-run to see
 * the plan without changing anything; --yes is required to actually
 * mutate.
 */

import type { Argv, CommandModule } from 'yargs';
import { createContext } from '../context.ts';
import { evaluateRules, computeUpdates, describeActions, collectRuleLabels, ensureLabelsExist, labelMailboxIds } from '../live/engine.ts';
import type { EmailSummary } from '../live/jmap.ts';

const builder = (y: Argv) =>
  y.options({
    auth: { type: 'string', describe: 'Path to Fastmail storage state', default: process.env.FASTMAIL_AUTH_PATH ?? './auth.json' },
    chromium: { type: 'string', describe: 'Path to a Chromium executable (overrides auto-detect)' },
    headed: { type: 'boolean', describe: 'Show the browser during apply', default: false },
    mailbox: { type: 'string', describe: 'Mailbox to apply rules to (name)', default: 'Inbox' },
    after: { type: 'string', describe: 'Only apply to messages received after this date (YYYY-MM-DD, UTC day boundaries)' },
    before: { type: 'string', describe: 'Only apply to messages received before this date (YYYY-MM-DD, UTC day boundaries)' },
    rule: { type: 'string', describe: 'Apply only rules whose name contains this substring' },
    'dry-run': { type: 'boolean', describe: 'Report what would change without mutating', default: false },
    yes: { type: 'boolean', describe: 'Required to actually mutate the account', default: false },
  });

const handler: CommandModule['handler'] = async (argv) => {
  const ctx = createContext({
    cwd: argv.cwd as string | undefined,
    verbose: argv.verbose as number,
    quiet: argv.quiet as boolean,
    color: argv.color as boolean,
  });
  const dryRun = argv['dry-run'] as boolean;
  const yes = argv.yes as boolean;

  const result = await evaluateRules(ctx, {
    auth: argv.auth as string,
    chromium: argv.chromium as string | undefined,
    headed: argv.headed as boolean,
    mailbox: argv.mailbox as string,
    after: argv.after as string | undefined,
    before: argv.before as string | undefined,
    rule: argv.rule as string | undefined,
  });

  let refused = false;
  try {
    const { session, matches, scopeIds, scopeMailbox } = result;
    const junk = result.mailboxes.find((m) => m.role === 'junk');
    const trash = result.mailboxes.find((m) => m.role === 'trash');
    if (!junk || !trash) throw new Error('Account has no junk/trash mailbox — cannot apply spam/trash actions.');

    // Label pre-flight: Fastmail's rule engine/import does not create
    // labels. Create any referenced-but-missing labels before mutating so
    // no message is ever archived without its label.
    const referencedLabels = collectRuleLabels(matches.map((m) => m.rule));
    const mailboxNames = new Set(result.mailboxes.map((m) => m.name.toLowerCase()));
    const missingLabels = referencedLabels.filter((l) => !mailboxNames.has(l.toLowerCase()));
    let mailboxes = result.mailboxes;
    if (missingLabels.length > 0 && dryRun) {
      ctx.log.info(`Would create missing label(s): ${missingLabels.join(', ')}`);
      // The plan must count the label-adds those rules would perform, so
      // dry-run resolves would-be-created labels to placeholder ids.
      // The placeholders are never sent — dry-run issues no Email/set.
      mailboxes = [
        ...result.mailboxes,
        ...missingLabels.map((name) => ({ id: `would-create:${name}`, name, role: null, parentId: null })),
      ];
    } else if (missingLabels.length > 0) {
      const created = await ensureLabelsExist(session, missingLabels);
      ctx.log.info(`Created missing label(s): ${created.join(', ')}`);
      mailboxes = await session.getMailboxes();
    }

    // Mailbox ids referenced by actions (case-insensitive — file into
    // the account's existing mailbox whatever its case).
    const labelIds = labelMailboxIds(mailboxes, collectRuleLabels(matches.map((m) => m.rule)));

    const actionable = matches.filter((m) => m.matched.length > 0);
    const totalClaimed = actionable.reduce((n, m) => n + m.matched.length, 0);
    ctx.log.info(
      `${dryRun ? 'Plan (dry run)' : 'Applying'}: ${actionable.length} rule(s) claim ${totalClaimed} of ${scopeIds.length} message(s) in "${scopeMailbox.name}".`,
    );
    if (!dryRun && !yes) {
      ctx.log.error('Refusing to mutate without --yes. Re-run with --yes (or --dry-run to preview).');
      // Not process.exit here — the finally below must close the session.
      refused = true;
    }

    if (!refused) {
      // Current state for every claimed message (patch computation needs it).
      const claimed = [...new Set(actionable.flatMap((m) => m.matched))];
      const state = new Map<string, { mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }>();
      for (let i = 0; i < claimed.length; i += 100) {
        const emails: EmailSummary[] = await session.getEmails(claimed.slice(i, i + 100), ['id', 'mailboxIds', 'keywords']);
        for (const e of emails) {
          state.set(e.id, {
            mailboxIds: e.mailboxIds ?? {},
            keywords: e.keywords ?? {},
          });
        }
      }
  
      const warnings: string[] = [];
      let mutated = 0;
      for (const { rule, matched } of actionable) {
        const label = rule.actions.add_label?.[0];
        const updates = computeUpdates(
          rule.actions,
          matched,
          state,
          {
            label: label ? labelIds.get(label) : undefined,
            scope: scopeMailbox.id,
            junk: junk.id,
            trash: trash.id,
          },
          warnings,
        );
        ctx.log.info(`${rule.name}: ${matched.length} matched, ${Object.keys(updates).length} to change  [${describeActions(rule.actions)}]`);
        if (dryRun || Object.keys(updates).length === 0) continue;
  
        await session.updateEmails(updates);
        mutated += Object.keys(updates).length;
        // Apply the patch to the cached state so later rules see the mutations.
        for (const [id, u] of Object.entries(updates)) {
          const cached = state.get(id)!;
          for (const [key, val] of Object.entries(u)) {
            if (key.startsWith('mailboxIds/')) {
              const mb = key.slice('mailboxIds/'.length);
              if (val === null) delete cached.mailboxIds[mb];
              else cached.mailboxIds[mb] = true;
            } else if (key.startsWith('keywords/')) {
              const kw = key.slice('keywords/'.length);
              if (val === null) delete cached.keywords[kw];
              else cached.keywords[kw] = true;
            }
          }
        }
      }
  
      for (const w of [...new Set(warnings)]) ctx.log.warn(w);
      ctx.log.info(
        dryRun
          ? `Dry run complete — nothing was changed.`
          : `Applied: ${mutated} message(s) changed across ${actionable.length} rule(s).`,
      );
    }
  } finally {
    await result.session.close();
  }
  if (refused) process.exit(1);
};

export const command: CommandModule = {
  command: 'apply',
  describe: 'Retroactively apply rules to an existing mailbox via JMAP',
  builder,
  handler,
};
