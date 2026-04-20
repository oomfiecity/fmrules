import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  allHeaderValues,
  detectFormat,
  getHeader,
  parseEmail,
  parseEmailJson,
  parseEml,
} from '../src/match/email.ts';

const fixtureDir = path.join(import.meta.dir, 'fixtures', 'emails');
const read = (name: string) => fs.readFile(path.join(fixtureDir, name), 'utf8');

describe('parseEml: simple', () => {
  test('extracts headers and body from a plain message', async () => {
    const eml = await read('simple.eml');
    const email = parseEml(eml);
    expect(getHeader(email, 'from')).toContain('receipts@anthropic.com');
    expect(getHeader(email, 'subject')).toBe('Your receipt from Anthropic');
    expect(email.body).toContain('Thank you for your payment');
    expect(email.body).toContain('Receipt total: $20.00');
  });

  test('header lookup is case-insensitive', async () => {
    const email = parseEml(await read('simple.eml'));
    expect(getHeader(email, 'FROM')).toBe(getHeader(email, 'from'));
    expect(getHeader(email, 'Subject')).toBe(getHeader(email, 'subject'));
  });
});

describe('parseEml: multipart', () => {
  test('takes the first text/plain part as body', async () => {
    const email = parseEml(await read('multipart.eml'));
    expect(email.body).toContain('A new pull request was opened in octocat/repo');
    expect(email.body).not.toContain('<html>');
    expect(getHeader(email, 'list-id')).toBe('<octocat/repo.github.com>');
  });
});

describe('parseEml: encodings', () => {
  test('quoted-printable body decodes UTF-8 sequences', async () => {
    const email = parseEml(await read('quoted-printable.eml'));
    expect(email.body).toContain('café');
    expect(email.body).toContain('Soft-wrapped at column 76 to keep the line short.');
  });

  test('base64 body decodes', async () => {
    const email = parseEml(await read('base64-body.eml'));
    expect(email.body).toContain('Hello, world!');
    expect(email.body).toContain('This body is base64-encoded.');
  });
});

describe('parseEml: header folding', () => {
  test('folded subject is unfolded into a single value', async () => {
    const email = parseEml(await read('folded-headers.eml'));
    const subject = getHeader(email, 'subject');
    expect(subject).toContain('This subject is intentionally long enough');
    expect(subject).toContain('to require folding across two lines');
    expect(subject?.includes('\n')).toBe(false);
  });

  test('folded references header preserves all message-ids', async () => {
    const email = parseEml(await read('folded-headers.eml'));
    const refs = getHeader(email, 'references') ?? '';
    expect(refs).toContain('msg-1@example.com');
    expect(refs).toContain('msg-2@example.com');
    expect(refs).toContain('msg-3@example.com');
  });
});

describe('parseEml: MIME-encoded headers', () => {
  test('Base64 MIME-word subject decodes', async () => {
    const email = parseEml(await read('mime-word-subject.eml'));
    const subject = getHeader(email, 'subject') ?? '';
    expect(subject).toContain('This is');
    expect(subject).toContain('a encoded subject');
  });

  test('Q-encoded MIME-word decodes', async () => {
    const email = parseEml(await read('mime-word-subject.eml'));
    const xq = getHeader(email, 'x-q-subject') ?? '';
    expect(xq).toContain('Q-encoded café');
  });
});

describe('parseEmailJson', () => {
  test('canonical shape: scalar headers + body', () => {
    const email = parseEmailJson({
      headers: { From: 'a@b.com', Subject: 'Hi', 'List-Id': '<x.example.com>' },
      body: 'Hello',
    });
    expect(getHeader(email, 'from')).toBe('a@b.com');
    expect(getHeader(email, 'list-id')).toBe('<x.example.com>');
    expect(email.body).toBe('Hello');
  });

  test('multi-valued headers via array', () => {
    const email = parseEmailJson({
      headers: { Received: ['from-1', 'from-2'] },
      body: '',
    });
    expect(allHeaderValues(email, 'received')).toEqual(['from-1', 'from-2']);
  });

  test('omitted body defaults to empty string', () => {
    const email = parseEmailJson({ headers: { From: 'a@b.com' } });
    expect(email.body).toBe('');
  });

  test('rejects non-object input', () => {
    expect(() => parseEmailJson(null)).toThrow();
    expect(() => parseEmailJson('string')).toThrow();
  });

  test('rejects missing headers', () => {
    expect(() => parseEmailJson({ body: 'x' })).toThrow();
  });

  test('rejects non-string header values', () => {
    expect(() => parseEmailJson({ headers: { X: 42 } })).toThrow();
    expect(() => parseEmailJson({ headers: { X: [42] } })).toThrow();
  });
});

describe('detectFormat', () => {
  test('extension wins', () => {
    expect(detectFormat('foo.json', '...')).toBe('json');
    expect(detectFormat('foo.eml', '...')).toBe('eml');
    expect(detectFormat('foo.mbox', '...')).toBe('eml');
  });

  test('content sniff for stdin / unknown extension', () => {
    expect(detectFormat(null, '   { "headers": {} }')).toBe('json');
    expect(detectFormat(null, 'From: a@b.com\nSubject: x\n\nbody')).toBe('eml');
  });
});

describe('parseEmail (integration of detect + parse)', () => {
  test('round-trips canonical JSON via parseEmail', async () => {
    const json = JSON.stringify({ headers: { From: 'x@y.com' }, body: 'b' });
    const email = parseEmail(json, 'json');
    expect(getHeader(email, 'from')).toBe('x@y.com');
  });

  test('round-trips eml via parseEmail', async () => {
    const eml = await read('simple.eml');
    const email = parseEmail(eml, 'eml');
    expect(getHeader(email, 'subject')).toBe('Your receipt from Anthropic');
  });
});
