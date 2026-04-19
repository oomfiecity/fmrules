import { describe, expect, test } from 'bun:test';
import { buildSearch } from '../src/compile/build-search.ts';
import type { PartialRule } from '../src/types.ts';

describe('buildSearch — rule-scoped errors', () => {
  test('empty match.any includes rule name and file', () => {
    const rule: PartialRule = {
      name: 'empty-any',
      hasOwnMatchers: true,
      matchers: { match: { any: [] } },
      actions: { fileIn: 'Inbox' },
      meta: { file: 'anywhere.yaml', fileIndex: 0, fanoutIndex: 0 },
    };
    expect(() => buildSearch(rule)).toThrow(
      /Rule "empty-any" \(anywhere\.yaml\): match\.any cannot be empty/,
    );
  });

  test('no-matchers error includes rule name and file', () => {
    const rule: PartialRule = {
      name: 'no-matchers',
      hasOwnMatchers: false,
      matchers: {},
      actions: { fileIn: 'Inbox' },
      meta: { file: 'empty.yaml', fileIndex: 0, fanoutIndex: 0 },
    };
    expect(() => buildSearch(rule)).toThrow(
      /Rule "no-matchers" \(empty\.yaml\): has no matchers/,
    );
  });
});
