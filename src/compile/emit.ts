/**
 * Convert a PartialRule into the final mailrules.json shape.
 * Timestamps (created/updated) are set here to `now`; lockfile
 * reconciliation overwrites `created` when a match is found.
 */

import type { EmittedRule, PartialRule } from '../types.ts';

export function toEmitted(
  rule: PartialRule,
  search: string,
  combinator: 'all' | 'any',
  nowIso: string,
): EmittedRule {
  const a = rule.actions;
  return {
    name: rule.name,
    ...(rule.isEnabled !== undefined ? { isEnabled: rule.isEnabled } : {}),
    combinator,
    conditions: null,
    search,
    markRead: a.markRead ?? false,
    markFlagged: a.markFlagged ?? false,
    showNotification: a.showNotification ?? false,
    redirectTo: a.redirectTo ?? null,
    fileIn: a.fileIn ?? null,
    skipInbox: a.skipInbox ?? false,
    snoozeUntil: a.snoozeUntil ?? null,
    discard: a.discard ?? false,
    markSpam: a.markSpam ?? false,
    stop: a.stop ?? false,
    previousFileInName: null,
    created: nowIso,
    updated: nowIso,
  };
}
