import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContext } from '../src/context.ts';
import { runPipeline } from '../src/compile/pipeline.ts';
import type { EmittedRule } from '../src/types.ts';

const FIXTURES_DIR = path.resolve(import.meta.dir, 'fixtures');

interface Fixture {
  name: string;
  dir: string;
}

const FIXTURES: Fixture[] = [
  { name: 'basic', dir: path.join(FIXTURES_DIR, 'basic') },
  { name: 'multi-value', dir: path.join(FIXTURES_DIR, 'multi-value') },
  { name: 'spam-kill', dir: path.join(FIXTURES_DIR, 'spam-kill') },
  { name: 'fan-out', dir: path.join(FIXTURES_DIR, 'fan-out') },
  { name: 'list-with-text', dir: path.join(FIXTURES_DIR, 'list-with-text') },
  { name: 'global-archetypes', dir: path.join(FIXTURES_DIR, 'global-archetypes') },
  { name: 'match-tree', dir: path.join(FIXTURES_DIR, 'match-tree') },
  { name: 'domain', dir: path.join(FIXTURES_DIR, 'domain') },
  { name: 'nested-matchers', dir: path.join(FIXTURES_DIR, 'nested-matchers') },
  { name: 'match-all', dir: path.join(FIXTURES_DIR, 'match-all') },
];

/**
 * Compile a fixture into a temp dir so we don't pollute the fixture
 * directory or touch its committed lockfile.
 */
async function compileFixture(
  fixtureDir: string,
): Promise<{ tmp: string; rules: EmittedRule[]; lockfile: Record<string, unknown> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fmrules-'));
  // Copy fixture meta + rules into the tmp dir.
  await fs.cp(fixtureDir, tmp, { recursive: true });
  // Delete any committed lockfile so the compile starts fresh.
  try {
    await fs.rm(path.join(tmp, 'meta', 'lockfile.json'));
  } catch {}

  const ctx = createContext({ cwd: tmp, quiet: true });
  await runPipeline(ctx, { out: 'mailrules.json', useLockfile: true, pretty: true });

  const rulesRaw = await fs.readFile(path.join(tmp, 'mailrules.json'), 'utf8');
  const lockRaw = await fs.readFile(path.join(tmp, 'meta', 'lockfile.json'), 'utf8');
  return {
    tmp,
    rules: JSON.parse(rulesRaw),
    lockfile: JSON.parse(lockRaw),
  };
}

/** Strip timestamps for expected-output comparison. */
function strip(rules: EmittedRule[]): Omit<EmittedRule, 'created' | 'updated'>[] {
  return rules.map(({ created: _c, updated: _u, ...rest }) => rest);
}

const tmpsToCleanup: string[] = [];
afterAll(async () => {
  for (const t of tmpsToCleanup) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe('fixture compile — each fixture compiles without errors', () => {
  for (const fx of FIXTURES) {
    test(fx.name, async () => {
      const { tmp, rules } = await compileFixture(fx.dir);
      tmpsToCleanup.push(tmp);
      expect(rules.length).toBeGreaterThan(0);
      // Every emitted rule has a non-empty search and at least one action.
      for (const r of rules) {
        expect(typeof r.search).toBe('string');
        expect(r.search.length).toBeGreaterThan(0);
        const hasAction =
          r.markRead ||
          r.markFlagged ||
          r.showNotification ||
          r.skipInbox ||
          r.discard ||
          r.markSpam ||
          r.stop ||
          !!r.fileIn ||
          !!r.redirectTo ||
          !!r.snoozeUntil;
        expect(hasAction).toBe(true);
      }
    });
  }
});

describe('fixture compile — expected outputs', () => {
  test('basic: SimpleLogin OR group is parenthesized when AND-joined', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'basic'));
    tmpsToCleanup.push(tmp);
    expect(rules.length).toBe(3);
    // The first rule has subject: "Secure..." AND (from OR header).
    expect(rules[0]!.search).toContain('(from:anthropic.com OR header:"X-SimpleLogin-Original-From:anthropic.com")');
    // Archetype-applied folder.
    expect(rules[1]!.fileIn).toBe('Account alerts');
    // Spam-kill actions propagate.
    expect(rules[2]!.markSpam).toBe(true);
    expect(rules[2]!.discard).toBe(true);
    expect(rules[2]!.stop).toBe(true);
  });

  test('multi-value: array `from` becomes OR group', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'multi-value'));
    tmpsToCleanup.push(tmp);
    const receipts = rules.find((r) => r.name === 'Multi-sender receipts')!;
    expect(receipts.search).toContain('from:alice@shop.com');
    expect(receipts.search).toContain('from:bob@shop.com');
    expect(receipts.search).toContain(' OR ');
    const rawEscape = rules.find((r) => r.name === 'Raw escape hatch')!;
    expect(rawEscape.search).toContain('is:flagged');
  });

  test('spam-kill: no fileIn required when discard/markSpam present', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'spam-kill'));
    tmpsToCleanup.push(tmp);
    expect(rules[0]!.fileIn).toBeNull();
    expect(rules[0]!.discard).toBe(true);
    expect(rules[0]!.markSpam).toBe(true);
  });

  test('list-with-text: new matchers render correctly', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'list-with-text'));
    tmpsToCleanup.push(tmp);
    const radicale = rules.find((r) => r.name === 'Radicale list spam')!;
    expect(radicale.search).toBe('list:<Radicale.Kozea.github.com>');
    const wrapped = rules.find((r) => r.name === 'List already wrapped')!;
    expect(wrapped.search).toBe('list:<foo.example.com>');
    const multi = rules.find((r) => r.name === 'Multiple lists')!;
    expect(multi.search).toBe('list:<first.example.com> OR list:<second.example.com>');
    const paddle = rules.find((r) => r.name === 'Paddle receipts via with')!;
    expect(paddle.search).toBe('subject:Receipt with:paddle');
    const withMulti = rules.find((r) => r.name === 'With multiple')!;
    expect(withMulti.search).toBe('with:stripe OR with:braintree');
    const textPhrase = rules.find((r) => r.name === 'Text phrase')!;
    expect(textPhrase.search).toBe('"PO Box pickup"');
    const textMulti = rules.find((r) => r.name === 'Text multiple phrases')!;
    expect(textMulti.search).toBe('to:alerts@example.com (shipped OR dispatched)');
  });

  test('global-archetypes: global archetype applies; local shadows global', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'global-archetypes'));
    tmpsToCleanup.push(tmp);
    const spam = rules.find((r) => r.name === 'Uses global spam-kill')!;
    expect(spam.markRead).toBe(true);
    expect(spam.markSpam).toBe(true);
    expect(spam.stop).toBe(true);
    const shadowed = rules.find((r) => r.name === 'Local shadows global')!;
    expect(shadowed.fileIn).toBe('Spam');
  });

  test('match-tree: any/all compose into OR/AND groups', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'match-tree'));
    tmpsToCleanup.push(tmp);
    const cross = rules.find((r) => r.name === 'Cross-field OR')!;
    expect(cross.search).toBe(
      'from:vendor.com (subject:Invoice OR subject:Receipt OR body:"Your order")',
    );
    const nested = rules.find((r) => r.name === 'Nested any under all')!;
    expect(nested.search).toBe(
      'from:vendor.com (subject:Autopay OR subject:Payment) (body:failed OR body:declined)',
    );
    const single = rules.find((r) => r.name === 'Single-leaf match')!;
    expect(single.search).toBe('from:vendor.com from:vendor.co.uk');
    const textList = rules.find((r) => r.name === 'Match with text and list')!;
    expect(textList.search).toBe('promotional OR list:<marketing.example.com>');
  });

  test('domain: renders as from:@value, lists OR-join, AND with siblings', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'domain'));
    tmpsToCleanup.push(tmp);
    const single = rules.find((r) => r.name === 'Single domain')!;
    expect(single.search).toBe('from:@example.com');
    const multi = rules.find((r) => r.name === 'Multiple domains')!;
    expect(multi.search).toBe('from:@one.example.com OR from:@two.example.com');
    const sibling = rules.find((r) => r.name === 'Domain plus subject')!;
    expect(sibling.search).toBe('subject:Receipt from:@vendor.com');
  });

  test('nested-matchers: any/all and legacy plural sugar both compile', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'nested-matchers'));
    tmpsToCleanup.push(tmp);
    const subjAny = rules.find((r) => r.name === 'Subject any nested')!;
    expect(subjAny.search).toBe(
      'from:shop.com (subject:Order OR subject:Receipt OR subject:Invoice)',
    );
    const subjAll = rules.find((r) => r.name === 'Subject all nested')!;
    expect(subjAll.search).toBe('from:tickets.com subject:confirm subject:refund');
    const combined = rules.find((r) => r.name === 'Subject any and all combined')!;
    expect(combined.search).toBe(
      'from:shop.com (subject:Receipt OR subject:Invoice) subject:paid',
    );
    const fromAny = rules.find((r) => r.name === 'From list nested')!;
    expect(fromAny.search).toBe('from:a.com OR from:b.com');
    const pluralSugar = rules.find((r) => r.name === 'Plural sugar still works')!;
    expect(pluralSugar.search).toBe(
      'from:shop.com (subject:Order OR subject:Receipt)',
    );
    const allSugar = rules.find((r) => r.name === 'All sugar still works')!;
    expect(allSugar.search).toBe('from:shop.com subject:paid subject:receipt');
    const merged = rules.find((r) => r.name === 'Sugar and singular merge in one layer')!;
    expect(merged.search).toBe(
      'from:shop.com (subject:Confirmation OR subject:Order OR subject:Receipt)',
    );
  });

  test('match-all: catchall with explicit opt-in compiles using inherited matchers', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'match-all'));
    tmpsToCleanup.push(tmp);
    const catchall = rules.find((r) => r.name === 'Catchall opt-in')!;
    expect(catchall.search).toBe('from:vendor.com');
  });

  test('match-all: missing opt-in errors out', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fmrules-mismatch-'));
    tmpsToCleanup.push(tmp);
    await fs.cp(path.join(FIXTURES_DIR, 'match-all'), tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'rules', 'catchall.yaml'),
      `defaults:\n  from: vendor.com\n\nrules:\n  - name: Forgot the matcher\n    file_in: Tickets\n`,
      'utf8',
    );
    const ctx = createContext({ cwd: tmp, quiet: true });
    expect(runPipeline(ctx, { out: 'mailrules.json', useLockfile: false, pretty: true })).rejects.toThrow(/no own matchers/);
  });

  test('fan-out: one source rule → N emitted, adjacent sortOrder', async () => {
    const { tmp, rules } = await compileFixture(path.join(FIXTURES_DIR, 'fan-out'));
    tmpsToCleanup.push(tmp);
    expect(rules.length).toBe(3);
    const names = rules.map((r) => r.name);
    expect(names).toEqual([
      'Receipts fan-out [Order]',
      'Receipts fan-out [Receipt]',
      'Receipts fan-out [Invoice]',
    ]);
  });
});

describe('lockfile idempotency', () => {
  test('compiling the same inputs twice yields byte-identical output', async () => {
    // Compile once.
    const { tmp } = await compileFixture(path.join(FIXTURES_DIR, 'basic'));
    tmpsToCleanup.push(tmp);
    const firstJson = await fs.readFile(path.join(tmp, 'mailrules.json'), 'utf8');
    const firstLock = await fs.readFile(path.join(tmp, 'meta', 'lockfile.json'), 'utf8');

    // Compile again in the same tmp dir (lockfile from first run is present).
    const ctx2 = createContext({ cwd: tmp, quiet: true });
    await runPipeline(ctx2, { out: 'mailrules.json', useLockfile: true, pretty: true });
    const secondJson = await fs.readFile(path.join(tmp, 'mailrules.json'), 'utf8');
    const secondLock = await fs.readFile(path.join(tmp, 'meta', 'lockfile.json'), 'utf8');

    expect(secondJson).toBe(firstJson);
    expect(secondLock).toBe(firstLock);
  });
});
