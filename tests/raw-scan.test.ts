import { describe, expect, test } from 'bun:test';
import { scanStrippedOperators } from '../src/compile/raw-scan.ts';

describe('raw-scan (§8.7)', () => {
  test('flags bare stripped operators', () => {
    expect(scanStrippedOperators('in:Inbox').map((h) => h.token)).toEqual(['in:']);
    expect(scanStrippedOperators('has:memo').map((h) => h.token)).toEqual(['has:memo']);
    expect(scanStrippedOperators('is:read').map((h) => h.token)).toEqual(['is:read']);
    expect(scanStrippedOperators('keyword:important').map((h) => h.token)).toEqual(['keyword:']);
  });

  test('flags negated forms', () => {
    expect(scanStrippedOperators('-in:foo').map((h) => h.token)).toEqual(['in:']);
    expect(scanStrippedOperators('NOT is:read').map((h) => h.token)).toEqual(['is:read']);
  });

  test('flags parenthesized forms', () => {
    expect(scanStrippedOperators('(in:foo OR x)').map((h) => h.token)).toEqual(['in:']);
  });

  test('flags quoted form (spec says this is intentional)', () => {
    // subject:"has:memo" — token inside a quoted phrase. Spec §8.7 says
    // this is deliberately flagged; false positives are preferable to
    // the more common paste-from-Fastmail-search failure mode.
    expect(scanStrippedOperators('subject:"has:memo"').map((h) => h.token)).toEqual(['has:memo']);
  });

  test('does not flag non-matching prefix of complete token', () => {
    // is:drafted → `is:draft` is a prefix, but the character after is a
    // word char (e), so the complete-token rule rejects the match.
    expect(scanStrippedOperators('is:drafted')).toEqual([]);
  });

  test('does not flag when preceded by a word char', () => {
    // foois:read — the `i` in `is:read` is preceded by `o` (word char),
    // so the preceding-context rule rejects the match.
    expect(scanStrippedOperators('foois:read')).toEqual([]);
  });

  test('does not flag non-stripped operators', () => {
    expect(scanStrippedOperators('from:alice@x.com')).toEqual([]);
    expect(scanStrippedOperators('subject:urgent')).toEqual([]);
    expect(scanStrippedOperators('has:attachment')).toEqual([]);
  });

  test('handles empty string', () => {
    expect(scanStrippedOperators('')).toEqual([]);
  });

  test('flags is:unread / is:unseen / is:seen', () => {
    const toks = (s: string) => scanStrippedOperators(s).map((h) => h.token);
    expect(toks('is:unread')).toEqual(['is:unread']);
    expect(toks('is:unseen')).toEqual(['is:unseen']);
    expect(toks('is:seen')).toEqual(['is:seen']);
    expect(toks('is:undraft')).toEqual(['is:undraft']);
  });
});
