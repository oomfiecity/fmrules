import { describe, expect, test } from 'bun:test';
import { and, field, header, not, or, phrase, raw } from '../src/compile/search-ir.ts';
import { evaluate } from '../src/match/eval.ts';
import type { Email } from '../src/match/email.ts';

function emailFrom(headers: Record<string, string | string[]>, body = ''): Email {
  const map = new Map<string, string[]>();
  for (const [k, v] of Object.entries(headers)) {
    map.set(k.toLowerCase(), Array.isArray(v) ? v : [v]);
  }
  return { headers: map, body };
}

const sample = emailFrom(
  {
    From: 'Anthropic <receipts@anthropic.com>',
    To: 'user@example.com, friend@example.com',
    Cc: 'cc@example.com',
    Subject: 'Your receipt from Anthropic',
    'List-Id': '<octocat/repo.github.com>',
    'X-Custom': 'tracking-id-42',
  },
  'Thank you for your payment. Receipt total: $20.',
);

describe('field operators', () => {
  test('from substring CI matches', () => {
    expect(evaluate(field('from', 'anthropic.com'), sample).result).toBe('true');
    expect(evaluate(field('from', 'ANTHROPIC.com'), sample).result).toBe('true');
  });

  test('from miss returns false', () => {
    expect(evaluate(field('from', 'gmail.com'), sample).result).toBe('false');
  });

  test('to searches To/Cc/Bcc', () => {
    expect(evaluate(field('to', 'friend@example.com'), sample).result).toBe('true');
    expect(evaluate(field('to', 'cc@example.com'), sample).result).toBe('true');
    expect(evaluate(field('to', 'nobody@example.com'), sample).result).toBe('false');
  });

  test('cc only searches Cc', () => {
    expect(evaluate(field('cc', 'cc@example.com'), sample).result).toBe('true');
    expect(evaluate(field('cc', 'friend@example.com'), sample).result).toBe('false');
  });

  test('subject substring CI', () => {
    expect(evaluate(field('subject', 'receipt'), sample).result).toBe('true');
    expect(evaluate(field('subject', 'invoice'), sample).result).toBe('false');
  });

  test('body substring CI', () => {
    expect(evaluate(field('body', 'thank you'), sample).result).toBe('true');
    expect(evaluate(field('body', 'refund'), sample).result).toBe('false');
  });

  test('with searches all headers + body', () => {
    expect(evaluate(field('with', 'tracking-id-42'), sample).result).toBe('true');
    expect(evaluate(field('with', 'Receipt total'), sample).result).toBe('true');
    expect(evaluate(field('with', 'never-appears'), sample).result).toBe('false');
  });

  test('list matches angle-bracketed List-Id', () => {
    expect(evaluate(field('list', '<octocat/repo.github.com>'), sample).result).toBe('true');
    expect(evaluate(field('list', '<other.example.com>'), sample).result).toBe('false');
  });

  test('domain sugar (from:@domain.com)', () => {
    expect(evaluate(field('from', '@anthropic.com'), sample).result).toBe('true');
    expect(evaluate(field('from', '@example.org'), sample).result).toBe('false');
  });

  test('unknown field returns unknown', () => {
    expect(evaluate(field('seen', 'true'), sample).result).toBe('unknown');
  });
});

describe('header / phrase / raw', () => {
  test('header CI on name + value', () => {
    expect(evaluate(header('X-Custom', 'tracking-id'), sample).result).toBe('true');
    expect(evaluate(header('x-custom', 'TRACKING-ID'), sample).result).toBe('true');
    expect(evaluate(header('X-Missing', 'x'), sample).result).toBe('false');
  });

  test('phrase searches subject ∪ body', () => {
    expect(evaluate(phrase('receipt'), sample).result).toBe('true'); // in subject
    expect(evaluate(phrase('payment'), sample).result).toBe('true'); // in body
    expect(evaluate(phrase('refund'), sample).result).toBe('false');
  });

  test('raw is always unknown', () => {
    expect(evaluate(raw('is:flagged'), sample).result).toBe('unknown');
    expect(evaluate(raw('anything-at-all'), sample).result).toBe('unknown');
  });
});

describe('logical operators', () => {
  test('not flips true/false; preserves unknown', () => {
    expect(evaluate(not(field('from', 'anthropic.com')), sample).result).toBe('false');
    expect(evaluate(not(field('from', 'gmail.com')), sample).result).toBe('true');
    expect(evaluate(not(raw('is:read')), sample).result).toBe('unknown');
  });

  test('and: all true → true', () => {
    expect(
      evaluate(and(field('from', 'anthropic.com'), field('subject', 'receipt')), sample).result,
    ).toBe('true');
  });

  test('and: any false → false (short-circuit)', () => {
    expect(evaluate(and(field('from', 'gmail.com'), raw('is:read')), sample).result).toBe('false');
    expect(evaluate(and(raw('is:read'), field('from', 'gmail.com')), sample).result).toBe('false');
  });

  test('and: true + unknown → unknown', () => {
    expect(evaluate(and(field('from', 'anthropic.com'), raw('is:read')), sample).result).toBe(
      'unknown',
    );
  });

  test('or: any true → true (short-circuit)', () => {
    expect(evaluate(or(raw('is:read'), field('from', 'anthropic.com')), sample).result).toBe('true');
  });

  test('or: all false → false', () => {
    expect(
      evaluate(or(field('from', 'gmail.com'), field('subject', 'invoice')), sample).result,
    ).toBe('false');
  });

  test('or: false + unknown → unknown', () => {
    expect(evaluate(or(field('from', 'gmail.com'), raw('is:read')), sample).result).toBe('unknown');
  });

  test('nested AND/OR composition', () => {
    const tree = and(
      field('from', 'anthropic.com'),
      or(field('subject', 'receipt'), field('subject', 'invoice')),
      not(field('body', 'cancelled')),
    );
    expect(evaluate(tree, sample).result).toBe('true');
  });
});

describe('trace', () => {
  test('emits per-leaf entries when withTrace=true', () => {
    const r = evaluate(and(field('from', 'anthropic.com'), field('subject', 'receipt')), sample, true);
    expect(r.result).toBe('true');
    expect(r.trace.length).toBeGreaterThan(0);
    expect(r.trace.some((e) => e.op === 'from:anthropic.com' && e.outcome === 'true')).toBe(true);
  });

  test('omits trace when withTrace=false', () => {
    const r = evaluate(field('from', 'anthropic.com'), sample, false);
    expect(r.trace).toEqual([]);
  });

  test('unknown trace entry surfaces reason for raw nodes', () => {
    const r = evaluate(raw('is:flagged'), sample, true);
    expect(r.result).toBe('unknown');
    expect(r.trace[0]?.reason).toContain('is:flagged');
  });
});

describe('missing headers', () => {
  test('from on empty email returns false (not unknown)', () => {
    const empty = emailFrom({}, '');
    expect(evaluate(field('from', 'x'), empty).result).toBe('false');
    expect(evaluate(field('subject', 'x'), empty).result).toBe('false');
  });
});
