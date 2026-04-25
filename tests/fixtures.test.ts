/**
 * Fixture-driven pipeline tests.
 *
 * Each directory under tests/fixtures/valid/ is a full fmrules project;
 * running the pipeline must produce zero errors, and the emitted
 * mailrules.json becomes a snapshot asserted against the committed
 * golden (reference/mailrules.json) on subsequent runs.
 *
 * Directories under tests/fixtures/invalid/ are named `<section>-<slug>`
 * (e.g. `12-4-date-relative`); the leading section tag is extracted and
 * required to appear in at least one of the reported errors.
 *
 * Directories under tests/fixtures/warnings/ must compile cleanly (no
 * errors) but surface at least one warning.
 *
 * Snapshot convention: the first run of a valid fixture writes
 * `<fixture>/reference/mailrules.json`. Commit it. Subsequent runs
 * compare byte-for-byte. The `created`/`updated` timestamps are
 * normalized to a fixed string before comparison.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runPipeline } from '../src/compile/pipeline.ts';
import { createContext } from '../src/context.ts';

const FIXTURES = path.resolve(import.meta.dir, 'fixtures');

function silentContext(cwd: string) {
  return createContext({
    cwd,
    quiet: true,
    color: false,
  });
}

function normalizeTimestamps(json: string): string {
  return json
    .replace(/"created":\s*"[^"]+"/g, '"created": "TIMESTAMP"')
    .replace(/"updated":\s*"[^"]+"/g, '"updated": "TIMESTAMP"');
}

function listFixtures(kind: 'valid' | 'invalid' | 'warnings'): string[] {
  const dir = path.join(FIXTURES, kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith('.') && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
}

function sectionTagFromName(name: string): string {
  const m = name.match(/^(\d+)-(\d+)-/);
  if (!m) throw new Error(`invalid fixture name ${name} — must start with <chapter>-<section>-`);
  return `${m[1]}.${m[2]}`;
}

describe('valid fixtures compile cleanly and snapshot-match', () => {
  for (const name of listFixtures('valid')) {
    test(name, async () => {
      const cwd = path.join(FIXTURES, 'valid', name);
      const ctx = silentContext(cwd);
      const result = await runPipeline(ctx, { checkOnly: false, useLockfile: false, out: 'mailrules.json' });
      expect(result.errors).toHaveLength(0);
      expect(result.emittedCount).toBeGreaterThanOrEqual(0);

      const outPath = path.join(cwd, 'mailrules.json');
      const produced = normalizeTimestamps(fs.readFileSync(outPath, 'utf8'));

      const referenceDir = path.join(cwd, 'reference');
      const referencePath = path.join(referenceDir, 'mailrules.json');
      if (!fs.existsSync(referencePath)) {
        fs.mkdirSync(referenceDir, { recursive: true });
        fs.writeFileSync(referencePath, produced, 'utf8');
        // First run: no comparison. Subsequent runs will compare.
      } else {
        const reference = fs.readFileSync(referencePath, 'utf8');
        expect(produced).toEqual(reference);
      }
    });
  }
});

describe('invalid fixtures fail with the expected §-tag', () => {
  for (const name of listFixtures('invalid')) {
    test(name, async () => {
      const cwd = path.join(FIXTURES, 'invalid', name);
      const ctx = silentContext(cwd);
      const result = await runPipeline(ctx, { checkOnly: true, useLockfile: false });
      const expectedTag = sectionTagFromName(name);
      expect(result.errors.length).toBeGreaterThan(0);
      const tags = result.errors.map((e) => e.tag);
      expect(tags).toContain(expectedTag);
    });
  }
});

describe('warnings fixtures compile cleanly and surface a warning', () => {
  for (const name of listFixtures('warnings')) {
    test(name, async () => {
      const cwd = path.join(FIXTURES, 'warnings', name);
      const ctx = silentContext(cwd);
      const result = await runPipeline(ctx, { checkOnly: true, useLockfile: false });
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  }
});
