import { describe, expect, test } from 'bun:test';
import { parseSearch, fullyConsumed, walk } from '../src/fastmail/parseSearch.ts';
import { forbiddenFields } from '../src/fastmail/valid-fields.ts';

describe('parseSearch — accepted shapes', () => {
  test.each([
    ['from:x', 'from:x'],
    ['from:anthropic.com', 'from:anthropic.com'],
    ['subject:"hello world"', 'subject:"hello world"'],
    ['header:"X-Foo:bar"', 'header:"X-Foo:bar"'],
    // Top-level OR group prints bare; parens only appear nested.
    ['(from:a OR from:b)', 'from:a OR from:b'],
    ['from:x (from:a OR from:b)', 'from:x (from:a OR from:b)'],
  ])('parses %p round-trip', (input, expected) => {
    expect(fullyConsumed(input)).toBe(true);
    const tree = parseSearch(input);
    expect(tree).not.toBeNull();
    expect(tree!.print()).toBe(expected);
  });
});

describe('parseSearch — normalization', () => {
  test('prefix dash normalizes to NOT keyword on print', () => {
    const tree = parseSearch('-from:spam.com');
    expect(tree!.print()).toBe('NOT from:spam.com');
  });
});

describe('parseSearch — forbidden field detection', () => {
  test('walks to find in: field', () => {
    const tree = parseSearch('in:Inbox from:x');
    const fields = [...walk(tree)]
      .filter((n) => n.type === 'field')
      .map((n) => n.value);
    expect(fields).toContain('in');
    expect(forbiddenFields.has('in')).toBe(true);
  });

  test('walks to find attached: field', () => {
    const tree = parseSearch('attached:secret.pdf');
    const fields = [...walk(tree)]
      .filter((n) => n.type === 'field')
      .map((n) => n.value);
    expect(fields).toContain('attached');
    expect(forbiddenFields.has('attached')).toBe(true);
  });
});

describe('parseSearch — unparseable input', () => {
  test('unbalanced paren leaves input unconsumed', () => {
    expect(fullyConsumed('(from:x')).toBe(false);
  });

  test('stray closing brace leaves input unconsumed', () => {
    expect(fullyConsumed('from:x }')).toBe(false);
  });
});
