/**
 * Lockfile reconciliation — preserves `created` timestamps across compiles.
 *
 * Keyed on the post-expansion Fastmail rule fingerprint. Match order:
 *   1. Fingerprint hit — rule is byte-identical to last compile; reuse both
 *      `created` and `updated` (the rule hasn't changed, no reason to bump).
 *   2. Name hit — rule was edited but kept its name; reuse `created`,
 *      refresh `updated` to now.
 *   3. Neither — new rule; both timestamps = now.
 *
 * Orphaned lockfile entries (no matching emitted rule) are dropped.
 *
 * Generated names (foo, foo#2, foo#3 from §10.4 expansion) give the
 * name-hit fallback a stable anchor: editing one label in a three-label
 * YAML rule misses fingerprint for that specific generated rule but
 * name-hits, so `created` is preserved.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
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
  const byName = new Map<string, LockfileEntry>();
  for (const entry of Object.values(prev)) {
    byName.set(entry.name, entry);
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
      created = nameHit.created;
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

export async function writeLockfile(cwd: string, lockfile: LockfileMap): Promise<void> {
  const dir = path.join(cwd, 'meta');
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

/**
 * Read meta/lockfile.json. Missing file → `{}`. Tolerates entries without
 * `updated` (defaults to `created`), so a lockfile written by the previous
 * major version still compiles cleanly on first run.
 */
export async function readLockfileOptional(cwd: string): Promise<LockfileMap> {
  const p = path.join(cwd, 'meta', 'lockfile.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, Partial<LockfileEntry>>;
    const out: LockfileMap = {};
    for (const [fp, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.created !== 'string') continue;
      out[fp] = {
        name: entry.name,
        created: entry.created,
        updated: entry.updated ?? entry.created,
      };
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}
