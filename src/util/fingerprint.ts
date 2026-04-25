import { createHash } from 'node:crypto';
import type { EmittedRule } from '../types.ts';

/**
 * Stable content fingerprint of an emitted Fastmail rule.
 * Excludes `created` and `updated` (presentation, not content).
 * The hash is keyed on the post-expansion rule — one YAML rule with N
 * labels produces N distinct fingerprints (one per generated name).
 */
export function ruleFingerprint(rule: EmittedRule): string {
  const canonical = {
    name: rule.name,
    search: rule.search,
    combinator: rule.combinator,
    markRead: rule.markRead,
    markFlagged: rule.markFlagged,
    showNotification: rule.showNotification,
    redirectTo: rule.redirectTo,
    fileIn: rule.fileIn,
    skipInbox: rule.skipInbox,
    snoozeUntil: rule.snoozeUntil,
    discard: rule.discard,
    markSpam: rule.markSpam,
    stop: rule.stop,
    previousFileInName: rule.previousFileInName,
    isEnabled: rule.isEnabled ?? true,
  };
  const hash = createHash('sha256');
  hash.update(JSON.stringify(canonical));
  return hash.digest('hex');
}
