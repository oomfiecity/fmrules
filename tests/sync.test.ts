import { describe, expect, test } from 'bun:test';
import { labelsInRules, parseRules } from '../src/commands/sync.ts';

describe('parseRules — pre-flight shape validation', () => {
  test('rejects non-array JSON', () => {
    expect(() => parseRules(Buffer.from('{"rules": 1}'))).toThrow('not a rule array');
  });

  test('rejects non-object entries', () => {
    expect(() => parseRules(Buffer.from(JSON.stringify([42])))).toThrow('entry 0 is not a rule object');
  });

  test('rejects entries without a name', () => {
    expect(() => parseRules(Buffer.from(JSON.stringify([{ filter: {} }])))).toThrow('entry 0 has no "name"');
  });

  test('rejects empty-string names', () => {
    expect(() => parseRules(Buffer.from(JSON.stringify([{ name: '' }])))).toThrow('entry 0 has no "name"');
  });

  test('accepts well-shaped entries (filter checked separately by the sync pre-flight)', () => {
    const buf = Buffer.from(JSON.stringify([{ name: 'a', filter: {} }, { name: 'b', filter: null }]));
    expect(parseRules(buf)).toHaveLength(2);
  });

  test('propagates JSON syntax errors', () => {
    expect(() => parseRules(Buffer.from('not json'))).toThrow();
  });
});

describe('labelsInRules', () => {
  test('unique fileIn names; null/missing ignored', () => {
    const buf = Buffer.from(
      JSON.stringify([
        { name: 'a', fileIn: 'Receipts' },
        { name: 'b', fileIn: 'Receipts' },
        { name: 'c', fileIn: null },
        { name: 'd' },
      ]),
    );
    expect(labelsInRules(buf)).toEqual(['Receipts']);
  });

  test('non-array JSON yields []', () => {
    expect(labelsInRules(Buffer.from('{"a": 1}'))).toEqual([]);
  });

  test('unparseable buffer yields [] (label pre-flight must not crash on a bad file)', () => {
    expect(labelsInRules(Buffer.from('not json'))).toEqual([]);
  });
});
