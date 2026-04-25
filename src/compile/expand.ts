/**
 * Phase 4 — multi-label expansion (SPEC(10).md §10.4) and the 50-leaf
 * condition cap (§8.8).
 *
 * A single YAML rule with N `add_label` values becomes N Fastmail rules
 * sharing identical conditions. The partitioning table below is the only
 * hedge seam for §10.4 (multi-label chain state propagation): adjust it
 * if Fastmail's rule chain ever halts on snooze or similar.
 *
 * Hedge (§10.4): action placement policy
 * ──────────────────────────────────────
 *   - First rule:   mark_read, pin, notify, send_copy_to (one-shot side
 *                   effects). Placed together so "first-rule actions" is
 *                   one group by construction.
 *   - Middle rules: one label each, nothing else.
 *   - Last rule:    snooze_until, archive/delete_to_trash/send_to_spam
 *                   (defensively placed after all labels are applied, so
 *                   if Fastmail ever halts on one of these we haven't lost
 *                   label work).
 *
 * If Fastmail's behavior ever becomes clear and we want to change this,
 * FIRST_RULE_ACTIONS / LAST_RULE_ACTIONS below are the only table to edit.
 */

import type { Actions, Condition, Rule, When } from '../types.ts';
import type { ErrorCollector } from './errors.ts';

/** Actions that land on the FIRST generated rule in a multi-label expansion. */
const FIRST_RULE_ACTIONS = ['mark_read', 'pin', 'notify', 'send_copy_to'] as const;
/** Actions that land on the LAST generated rule. */
const LAST_RULE_ACTIONS = ['snooze_until', 'archive', 'delete_to_trash', 'send_to_spam'] as const;

export interface ExpandedRule {
  /** Fastmail-side name (first rule keeps the YAML name; siblings get foo#2, foo#3, ...). */
  name: string;
  /** The originating YAML rule. */
  source: Rule;
  /** Resolved condition tree (shared among all siblings in one expansion). */
  when: When;
  /** Post-expansion condition tree resolved — may be null when source is `always`. */
  resolvedCondition: Condition | null;
  /** Actions specific to this generated rule. */
  actions: Actions;
  /** `continue` value for this generated rule. All but the last use `true`; the last inherits the YAML value. */
  continueFlag: boolean;
  /** Index within the expansion, 0-based. */
  indexInExpansion: number;
  /** Total siblings generated from this YAML rule. */
  expansionSize: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Action partitioning

export interface Partition {
  firstRuleActions: Actions;
  lastRuleActions: Actions;
}

function partitionActions(actions: Actions): Partition {
  const first: Actions = {};
  const last: Actions = {};
  const a = actions as Record<string, unknown>;
  for (const k of FIRST_RULE_ACTIONS) {
    if (k in a) (first as Record<string, unknown>)[k] = a[k];
  }
  for (const k of LAST_RULE_ACTIONS) {
    if (k in a) (last as Record<string, unknown>)[k] = a[k];
  }
  return { firstRuleActions: first, lastRuleActions: last };
}

// ────────────────────────────────────────────────────────────────────────────
// Leaf-count cap (§8.8)

export function countLeaves(when: When): number {
  if (when.kind === 'always') return 0;
  return countCondLeaves(when);
}

function countCondLeaves(node: Condition): number {
  switch (node.kind) {
    case 'all':
    case 'any': {
      let total = 0;
      for (const c of node.children) total += countCondLeaves(c);
      return total;
    }
    case 'not':
      return countCondLeaves(node.child);
    case 'extends':
      // Should have been resolved by phase 3. Defensive: count as 0.
      return 0;
    default:
      // Every leaf — including `raw:` — counts as 1 per §8.8.
      return 1;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Expansion

/**
 * Expand one resolved rule into one-or-more generated rules. The input
 * `resolvedCondition` is the output of phase 3 (or null when when=always).
 *
 * Errors are pushed to the collector. Returns an empty array if the
 * resulting rule (or one of its expansions) breaches the §8.8 cap.
 */
export function expandRule(
  rule: Rule,
  resolvedCondition: Condition | null,
  errors: ErrorCollector,
): ExpandedRule[] {
  const leafCount =
    rule.when.kind === 'always' ? 0 : resolvedCondition ? countCondLeaves(resolvedCondition) : 0;
  if (leafCount > 50) {
    errors.error({
      file: rule.sourceFile,
      tag: '12.2',
      message: `rule "${rule.name}" has ${leafCount} leaf conditions after extends resolution — exceeds Fastmail's limit of 50 (§8.8).`,
    });
    return [];
  }

  const labels = rule.actions.add_label ?? [];
  const { firstRuleActions, lastRuleActions } = partitionActions(rule.actions);

  // Zero labels: single Fastmail rule carrying all actions.
  if (labels.length === 0) {
    const combinedActions: Actions = { ...firstRuleActions, ...lastRuleActions };
    return [
      {
        name: rule.name,
        source: rule,
        when: rule.when,
        resolvedCondition,
        actions: combinedActions,
        continueFlag: rule.continue,
        indexInExpansion: 0,
        expansionSize: 1,
      },
    ];
  }

  // One or more labels → N Fastmail rules.
  const out: ExpandedRule[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const isFirst = i === 0;
    const isLast = i === labels.length - 1;

    const actions: Actions = { add_label: [label] };
    if (isFirst) Object.assign(actions, firstRuleActions);
    if (isLast) Object.assign(actions, lastRuleActions);

    // When the expansion has exactly one label, first == last, so
    // Object.assign above handles both branches cleanly.

    out.push({
      name: i === 0 ? rule.name : `${rule.name}#${i + 1}`,
      source: rule,
      when: rule.when,
      resolvedCondition,
      actions,
      // All but the last: continue = true. Last: inherit the YAML value.
      continueFlag: isLast ? rule.continue : true,
      indexInExpansion: i,
      expansionSize: labels.length,
    });
  }
  return out;
}
