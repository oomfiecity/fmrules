/**
 * Convert a PartialRule into the final mailrules.json shape.
 * Timestamps (created/updated) are set here to `now`; lockfile
 * reconciliation overwrites `created` when a match is found.
 *
 * Action defaults are driven by `ACTION_FIELDS`: emission order follows the
 * registry row order, and the default is `null` for nullable shapes and
 * `false` for booleans.
 */

import { ACTION_FIELDS, type FieldSpec } from '../schema/fields.ts';
import type { EmittedRule, PartialRule } from '../types.ts';

function defaultFor(f: FieldSpec, value: unknown): unknown {
  if (value !== undefined) return value;
  if (f.nullable) return null;
  if (f.shape === 'bool') return false;
  throw new Error(`No default for action field "${f.yaml}" (shape: ${f.shape})`);
}

export function toEmitted(
  rule: PartialRule,
  search: string,
  combinator: 'all' | 'any',
  nowIso: string,
): EmittedRule {
  const out: Record<string, unknown> = {
    name: rule.name,
    // `isEnabled` is omitted when undefined. Fastmail's server treats the
    // missing field as "enabled" — `ruleFingerprint` at util/fingerprint.ts
    // encodes the same assumption via `?? true`. Explicit `false` emits;
    // explicit `true` emits but is semantically equivalent to omission.
    ...(rule.isEnabled !== undefined ? { isEnabled: rule.isEnabled } : {}),
    combinator,
    conditions: null,
    search,
  };
  const actions = rule.actions as unknown as Record<string, unknown>;
  for (const f of ACTION_FIELDS) {
    out[f.internal] = defaultFor(f, actions[f.internal]);
  }
  out.previousFileInName = null;
  out.created = nowIso;
  out.updated = nowIso;
  return out as unknown as EmittedRule;
}
