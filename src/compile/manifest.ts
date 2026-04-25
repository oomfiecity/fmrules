/**
 * Validate manifest.yml and reconcile against the rules/ filesystem.
 *
 * Every check in SPEC(10).md §12.1 lives here, plus the case-sensitive
 * path check from §4.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Manifest } from '../types.ts';
import type { ErrorCollector } from './errors.ts';
import type { RawFile } from './load.ts';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walk the project tree at `cwd` and check every listed `order` entry's
 * case matches on-disk exactly (§4, case-sensitive paths). Required even
 * on case-insensitive filesystems so projects stay portable.
 */
async function onDiskNameOf(cwd: string, relPath: string): Promise<string | null> {
  const parts = relPath.split('/');
  let current = cwd;
  const seen: string[] = [];
  for (const part of parts) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    seen.push(hit);
    current = path.join(current, hit);
  }
  return seen.join('/');
}

/**
 * Parse + validate the manifest. Returns a normalized Manifest on success,
 * null on any error (errors are pushed to the collector). `ruleRelPaths`
 * is the set of rule files that exist on disk under `rules/` — used to
 * enforce the "every file must appear in order, every order entry must
 * exist" reconciliation.
 */
export async function buildManifest(
  raw: RawFile,
  cwd: string,
  ruleRelPaths: Set<string>,
  errors: ErrorCollector,
): Promise<Manifest | null> {
  const v = raw.value;

  if (!isPlainObject(v)) {
    errors.error({
      file: 'manifest.yml',
      tag: '12.1',
      message: 'manifest.yml must be a mapping with `version` and `order` keys.',
    });
    return null;
  }

  // Allowed keys only.
  for (const key of Object.keys(v)) {
    if (key !== 'version' && key !== 'order') {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `Unknown top-level key "${key}". manifest.yml accepts only \`version\` and \`order\`.`,
      });
    }
  }

  if (!('version' in v)) {
    errors.error({ file: 'manifest.yml', tag: '12.1', message: 'Missing required key `version`.' });
  } else if (v.version !== 1) {
    errors.error({
      file: 'manifest.yml',
      tag: '12.1',
      message: `\`version\` must be \`1\` (got ${JSON.stringify(v.version)}).`,
    });
  }

  if (!('order' in v)) {
    errors.error({ file: 'manifest.yml', tag: '12.1', message: 'Missing required key `order`.' });
    return null;
  }
  const order = v.order;
  if (!Array.isArray(order)) {
    errors.error({ file: 'manifest.yml', tag: '12.1', message: '`order` must be a list.' });
    return null;
  }

  // Per-entry validation.
  const seen = new Set<string>();
  const validPaths: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const entry = order[i];
    const loc = `order[${i}]`;
    if (typeof entry !== 'string') {
      errors.error({ file: 'manifest.yml', tag: '12.1', message: `${loc} must be a string.` });
      continue;
    }
    if (entry.includes('\\')) {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `${loc}: paths must use forward slashes (\\ is not allowed).`,
      });
      continue;
    }
    if (!entry.endsWith('.yml')) {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `${loc}: "${entry}" must end in .yml.`,
      });
      continue;
    }
    if (!entry.startsWith('rules/')) {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `${loc}: "${entry}" must be under rules/.`,
      });
      continue;
    }
    if (seen.has(entry)) {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `${loc}: "${entry}" appears more than once.`,
      });
      continue;
    }
    seen.add(entry);

    const onDisk = await onDiskNameOf(cwd, entry);
    if (onDisk === null) {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `${loc}: "${entry}" does not exist on disk.`,
      });
      continue;
    }
    if (onDisk !== entry) {
      errors.error({
        file: 'manifest.yml',
        tag: '12.1',
        message: `${loc}: "${entry}" case does not match on-disk filename "${onDisk}". Paths are case-sensitive (§4).`,
      });
      continue;
    }
    validPaths.push(entry);
  }

  // Reconcile: every file under rules/ must appear in order.
  for (const rel of Array.from(ruleRelPaths).sort()) {
    if (!seen.has(rel)) {
      errors.error({
        file: ['manifest.yml', rel],
        tag: '12.1',
        message: `${rel} exists on disk but is not listed in manifest.yml \`order\`. Add it or delete the file.`,
      });
    }
  }

  // We always return a (possibly partial) Manifest so downstream phases can
  // still process the valid files; the driver inspects `errors.hasErrors()`
  // to decide whether to emit output.
  return { order: validPaths };
}
