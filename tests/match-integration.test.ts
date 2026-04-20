import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createContext } from '../src/context.ts';
import { matchEmail } from '../src/match/index.ts';
import { parseEml, parseEmailJson } from '../src/match/email.ts';

const FIXTURE_DIR = path.join(import.meta.dir, 'fixtures', 'match-integration');
const EMAIL_DIR = path.join(import.meta.dir, 'fixtures', 'emails');

function ctx() {
  return createContext({ cwd: FIXTURE_DIR, quiet: true });
}

describe('match end-to-end', () => {
  test('a receipt email matches the receipts + any rules; never-matches stays out; stateful is undetermined', async () => {
    const eml = await fs.readFile(path.join(EMAIL_DIR, 'simple.eml'), 'utf8');
    const email = parseEml(eml);
    const report = await matchEmail(ctx(), email);

    const matchedNames = report.matched.map((e) => e.name).sort();
    expect(matchedNames).toEqual(['Anthropic any', 'Anthropic receipts']);

    const undeterminedNames = report.undetermined.map((e) => e.name);
    expect(undeterminedNames).toContain('Stateful — only matches when read');

    const noMatchNames = report.noMatch.map((e) => e.name);
    expect(noMatchNames).toContain('GitHub PRs');
    expect(noMatchNames).toContain('Never matches');

    expect(report.totalRules).toBe(5);
    expect(report.evaluatedRules).toBe(5);
  });

  test('a github email matches only the GitHub rule', async () => {
    const eml = await fs.readFile(path.join(EMAIL_DIR, 'multipart.eml'), 'utf8');
    const email = parseEml(eml);
    const report = await matchEmail(ctx(), email);

    const matchedNames = report.matched.map((e) => e.name).sort();
    expect(matchedNames).toEqual(['GitHub PRs']);
  });

  test('rule filter limits evaluation to a single rule by name', async () => {
    const eml = await fs.readFile(path.join(EMAIL_DIR, 'simple.eml'), 'utf8');
    const email = parseEml(eml);
    const report = await matchEmail(ctx(), email, { ruleFilter: 'Anthropic receipts' });

    expect(report.evaluatedRules).toBe(1);
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0]?.name).toBe('Anthropic receipts');
  });

  test('with-trace populates per-leaf trace entries on each evaluation', async () => {
    const eml = await fs.readFile(path.join(EMAIL_DIR, 'simple.eml'), 'utf8');
    const email = parseEml(eml);
    const report = await matchEmail(ctx(), email, { withTrace: true });

    const receiptsRule = report.matched.find((e) => e.name === 'Anthropic receipts');
    expect(receiptsRule?.trace).toBeDefined();
    expect(receiptsRule!.trace!.length).toBeGreaterThan(0);
  });

  test('canonical JSON input produces the same matches as the .eml form', async () => {
    const email = parseEmailJson({
      headers: {
        From: 'Anthropic Receipts <receipts@anthropic.com>',
        To: 'user@example.com',
        Subject: 'Your receipt from Anthropic',
      },
      body: 'Thank you for your payment.',
    });
    const report = await matchEmail(ctx(), email);
    const matchedNames = report.matched.map((e) => e.name).sort();
    expect(matchedNames).toEqual(['Anthropic any', 'Anthropic receipts']);
  });

  test('undetermined entries carry a reason', async () => {
    const eml = await fs.readFile(path.join(EMAIL_DIR, 'simple.eml'), 'utf8');
    const email = parseEml(eml);
    const report = await matchEmail(ctx(), email);
    const stateful = report.undetermined.find((e) => e.name === 'Stateful — only matches when read');
    expect(stateful?.reason).toBeDefined();
    expect(stateful?.reason ?? '').toContain('is:read');
  });
});
