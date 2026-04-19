/**
 * Lockfile reconciliation — preserves `created` timestamps across recompiles.
 *
 * Match order:
 *   1. Fingerprint hit — reuse `created`, keep `updated` if content unchanged
 *      (emitted rule is byte-identical to its lockfile entry).
 *   2. Name hit — treat as edit; reuse `created`, refresh fingerprint.
 *   3. Neither — new rule; keep `created = now`.
 *
 * Orphaned lockfile entries (no matching emitted rule) are dropped.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context } from '../context.ts';
import type { EmittedRule } from '../types.ts';
import { ruleFingerprint } from '../util/fingerprint.ts';

export type LockfileMap = Record<string, LockfileEntry>;

export interface LockfileEntry {
  name: string;
  created: string;
  updated: string;
}

export interface ReconcileResult {
  rules: EmittedRule[];
  lockfile: LockfileMap;
}

export function reconcileLockfile(
  rules: EmittedRule[],
  prev: LockfileMap,
  nowIso: string,
): ReconcileResult {
  const byName = new Map<string, { fingerprint: string; entry: LockfileEntry }>();
  for (const [fp, entry] of Object.entries(prev)) {
    byName.set(entry.name, { fingerprint: fp, entry });
  }

  const nextLockfile: LockfileMap = {};
  const reconciled: EmittedRule[] = [];

  for (const rule of rules) {
    const fp = ruleFingerprint(rule);
    const fpHit = prev[fp];
    const nameHit = byName.get(rule.name);

    let created: string;
    let updated: string;
    if (fpHit) {
      created = fpHit.created;
      updated = fpHit.updated;
    } else if (nameHit) {
      created = nameHit.entry.created;
      updated = nowIso;
    } else {
      created = nowIso;
      updated = nowIso;
    }

    reconciled.push({ ...rule, created, updated });
    nextLockfile[fp] = { name: rule.name, created, updated };
  }

  return { rules: reconciled, lockfile: nextLockfile };
}

export async function writeLockfile(ctx: Context, lockfile: LockfileMap): Promise<void> {
  const dir = ctx.paths.meta;
  await fs.mkdir(dir, { recursive: true });
  const sorted = Object.keys(lockfile)
    .sort()
    .reduce<LockfileMap>((acc, k) => {
      acc[k] = lockfile[k]!;
      return acc;
    }, {});
  const full = path.join(dir, 'lockfile.json');
  await fs.writeFile(full, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}
