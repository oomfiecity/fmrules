/**
 * Live rule evaluation engine — shared by `fmrules verify` (report only)
 * and `fmrules apply` (retroactively apply actions via JMAP).
 *
 * Model (SPEC(10).md "On rule execution context" + §11.3):
 *   - Rules evaluate in manifest order, exactly as they would at delivery.
 *   - A matching rule contributes its actions; when its Fastmail `stop`
 *     flag is set (YAML `continue: false`), the message is not offered to
 *     later rules.
 *   - Matching is delegated to Fastmail's search engine via structured
 *     Email/query filters (see filter.ts), so semantics — stemming, header
 *     substring matching, address handling — are the server's own.
 *
 * Mutations use whole-map replacement: Fastmail's Email/set replaces the
 * complete `mailboxIds` and `keywords` maps, so the engine always fetches
 * current state first and writes back complete desired maps.
 */

import type { Context } from '../context.ts';
import { runPipeline } from '../compile/pipeline.ts';
import type { ExpandedRule } from '../compile/expand.ts';
import type { Actions } from '../types.ts';
import { JmapSession, type JmapMailbox } from './jmap.ts';
import { renderFilter } from './filter.ts';

export interface LiveEngineOptions {
  auth: string;
  chromium?: string;
  headed?: boolean;
  /** Mailbox to evaluate against, by name (default "Inbox"). */
  mailbox?: string;
  /** Restrict scope to messages received after this date (YYYY-MM-DD). */
  after?: string;
  /** Restrict scope to messages received before this date (YYYY-MM-DD). */
  before?: string;
  /** Evaluate only rules whose name contains this substring. */
  rule?: string;
}

export interface RuleMatch {
  rule: ExpandedRule;
  /** Message ids this rule claims (matched and not stopped earlier). */
  matched: string[];
  /** Leaves the server could not evaluate (rule reported, not skipped silently). */
  unsupported: string[];
}

export interface EngineResult {
  session: JmapSession;
  scopeMailbox: JmapMailbox;
  scopeIds: string[];
  matches: RuleMatch[];
  mailboxes: JmapMailbox[];
}

function midnightIso(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

/**
 * Connect, load rules, and evaluate every rule's match set against the
 * scope mailbox. Does NOT mutate anything — apply() layers mutations on
 * top of the same evaluation.
 */
export async function evaluateRules(ctx: Context, opts: LiveEngineOptions): Promise<EngineResult> {
  const pipeline = await runPipeline(ctx, { checkOnly: true });
  if (pipeline.errors.length > 0) {
    throw new Error(
      `${pipeline.errors.length} compile error(s) — fix the rules before live evaluation. Run \`fmrules check\` for detail.`,
    );
  }
  const allRules = pipeline.expandedRules ?? [];
  const rules = opts.rule
    ? allRules.filter((r) => r.name.toLowerCase().includes(opts.rule!.toLowerCase()))
    : allRules;
  if (rules.length === 0) {
    throw new Error(`No rules match --rule "${opts.rule}".`);
  }

  const session = await JmapSession.connect({ auth: opts.auth, chromium: opts.chromium, headed: opts.headed });
  try {
    const mailboxes = await session.getMailboxes();
    const scopeMailbox = findMailbox(mailboxes, opts.mailbox ?? 'Inbox');
    if (!scopeMailbox) {
      throw new Error(`Mailbox "${opts.mailbox ?? 'Inbox'}" not found on the account.`);
    }

    const scopeConditions: unknown[] = [{ inMailbox: scopeMailbox.id }];
    if (opts.after) scopeConditions.push({ after: midnightIso(opts.after) });
    if (opts.before) scopeConditions.push({ before: midnightIso(opts.before) });
    const scopeFilter =
      scopeConditions.length === 1
        ? scopeConditions[0]
        : { operator: 'AND', conditions: scopeConditions };
    ctx.log.info(`Querying scope (${opts.mailbox ?? 'Inbox'}${opts.after ? `, after ${opts.after}` : ''}${opts.before ? `, before ${opts.before}` : ''})...`);
    const scopeIds = await session.queryEmailIds(scopeFilter);
    ctx.log.info(`Scope: ${scopeIds.length} message(s).`);
    const scopeSet = new Set(scopeIds);

    // Chain evaluation. `stopped` holds ids claimed by a rule with
    // continue=false (Fastmail stop=true); those ids are never offered to
    // later rules. When --rule narrows the set, chain state is tracked as
    // if the full ruleset ran (other rules still claim their messages
    // first), which keeps single-rule verification faithful.
    const stopped = new Set<string>();
    const matches: RuleMatch[] = [];

    for (const rule of allRules) {
      const selected = rules.includes(rule);
      const { condition, unsupported } = renderFilter(rule.when, rule.resolvedCondition);
      let matchedIds: string[] = [];

      if (unsupported.length > 0 && condition === null) {
        // Entirely unevaluable (e.g. only a group-membership leaf).
        if (selected) matches.push({ rule, matched: [], unsupported });
      } else {
        const conditions: unknown[] = [{ inMailbox: scopeMailbox.id }];
        if (condition !== null) conditions.push(condition);
        const filter =
          conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
        const ids = await session.queryEmailIds(filter);
        matchedIds = ids.filter((id) => scopeSet.has(id) && !stopped.has(id));
        if (selected) matches.push({ rule, matched: matchedIds, unsupported });
      }

      if (selected && unsupported.length > 0) {
        ctx.log.warn(
          `Rule "${rule.name}": ${unsupported.length} condition leaf/leaves cannot be evaluated server-side; ` +
            'matches shown are for the remainder of the condition only.',
        );
      }

      if (!rule.continueFlag) {
        for (const id of matchedIds) stopped.add(id);
      }
    }

    return { session, scopeMailbox, scopeIds, matches, mailboxes };
  } catch (err) {
    await session.close();
    throw err;
  }
}

/**
 * Compute PatchObject updates (RFC 8620 slash-path form — the same form
 * Fastmail's web client uses) for a rule's actions over a batch of
 * messages. Patch form is essential: whole-map `mailboxIds`/`keywords`
 * replacement is both lossy (unmentioned keywords drop — the canary
 * proved it) and forbidden for server-managed keywords like
 * $maskedemail on Apple hide-my-email messages. Patches touch only the
 * keys each action needs and never the rest.
 */
export function computeUpdates(
  actions: Actions,
  ids: string[],
  current: Map<string, { mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }>,
  mailboxIds: {
    label?: string;
    scope: string;
    junk: string;
    trash: string;
  },
  warnings: string[],
): Record<string, Record<string, unknown>> {
  const updates: Record<string, Record<string, unknown>> = {};
  if (ids.length === 0) return updates;

  if (actions.add_label && actions.add_label.length > 0 && !mailboxIds.label) {
    warnings.push(`label "${actions.add_label[0]}" does not exist on the account — labels skipped`);
  }

  for (const id of ids) {
    const state = current.get(id);
    if (!state) continue;
    const patch: Record<string, unknown> = {};

    if (actions.add_label?.[0] && mailboxIds.label) {
      if (!state.mailboxIds[mailboxIds.label]) {
        patch[`mailboxIds/${mailboxIds.label}`] = true;
      }
    }
    if (actions.mark_read && !state.keywords['$seen']) {
      patch['keywords/$seen'] = true;
    }
    if (actions.pin && !state.keywords['$flagged']) {
      patch['keywords/$flagged'] = true;
    }
    if (actions.archive && state.mailboxIds[mailboxIds.scope]) {
      patch[`mailboxIds/${mailboxIds.scope}`] = null;
    }
    // Moves to junk/trash: null every current mailbox, add the target.
    // Only when not already there (an already-spammed message would
    // otherwise re-move and count as changed forever).
    if (actions.send_to_spam) {
      const inJunkOnly =
        Object.keys(state.mailboxIds).length === 1 && state.mailboxIds[mailboxIds.junk] === true;
      if (!inJunkOnly) {
        for (const mb of Object.keys(state.mailboxIds)) patch[`mailboxIds/${mb}`] = null;
        patch[`mailboxIds/${mailboxIds.junk}`] = true;
      }
    }
    if (actions.delete_to_trash) {
      const inTrashOnly =
        Object.keys(state.mailboxIds).length === 1 && state.mailboxIds[mailboxIds.trash] === true;
      if (!inTrashOnly) {
        for (const mb of Object.keys(state.mailboxIds)) patch[`mailboxIds/${mb}`] = null;
        patch[`mailboxIds/${mailboxIds.trash}`] = true;
      }
    }

    if (Object.keys(patch).length > 0) {
      updates[id] = patch;
    }
  }
  return updates;
}

/** Every label name referenced by a set of rules' add_label actions. */
export function collectRuleLabels(rules: readonly ExpandedRule[]): string[] {
  return [
    ...new Set(
      rules
        .map((r) => r.actions.add_label?.[0])
        .filter((l): l is string => typeof l === 'string'),
    ),
  ];
}

/**
 * Ensure every referenced label exists on the account, creating missing
 * ones (as labels). Returns the names created. Fastmail's rule import
 * does not create labels, and a rule firing into a missing label either
 * fails or silently drops the label — so both `sync` (before import) and
 * `apply` (before mutating) call this.
 */
export async function ensureLabelsExist(session: JmapSession, names: string[]): Promise<string[]> {
  const mailboxes = await session.getMailboxes();
  const existing = new Set(mailboxes.map((m) => m.name.toLowerCase()));
  const created: string[] = [];
  for (const name of names) {
    if (!existing.has(name.toLowerCase())) {
      await session.createLabel(name);
      created.push(name);
    }
  }
  return created;
}

/**
 * Case-insensitive label-name → mailbox-id lookup. Mailbox names on the
 * account may differ in case from the YAML (e.g. rules say "Account
 * Alerts", account has "Account alerts"); filing must target the
 * existing mailbox rather than assume exact-case equality.
 */
export function labelMailboxIds(mailboxes: readonly JmapMailbox[], names: string[]): Map<string, string> {
  const byLower = new Map(mailboxes.map((m) => [m.name.toLowerCase(), m.id]));
  const out = new Map<string, string>();
  for (const name of names) {
    const id = byLower.get(name.toLowerCase());
    if (id) out.set(name, id);
  }
  return out;
}

/** Human-readable one-liner for a rule's actions (report output). */
export function describeActions(actions: Actions): string {
  const parts: string[] = [];
  if (actions.add_label?.[0]) parts.push(`label "${actions.add_label[0]}"`);
  if (actions.mark_read) parts.push('mark read');
  if (actions.pin) parts.push('pin');
  if (actions.archive) parts.push('archive');
  if (actions.send_to_spam) parts.push('spam');
  if (actions.delete_to_trash) parts.push('trash');
  if (actions.snooze_until) parts.push('snooze (not retroactive)');
  if (actions.notify) parts.push('notify (not retroactive)');
  if (actions.send_copy_to) parts.push('forward (not retroactive)');
  return parts.length > 0 ? parts.join(', ') : 'no actions';
}

function findMailbox(mailboxes: JmapMailbox[], name: string): JmapMailbox | undefined {
  const byName = mailboxes.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  const roles: Record<string, string> = {
    inbox: 'inbox',
    archive: 'archive',
    spam: 'junk',
    junk: 'junk',
    trash: 'trash',
    drafts: 'drafts',
    sent: 'sent',
  };
  const role = roles[name.toLowerCase()];
  return role ? mailboxes.find((m) => m.role === role) : undefined;
}
