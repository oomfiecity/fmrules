/**
 * Minimal email representation used by the `fmrules match` evaluator.
 * Both the .eml parser and the canonical-JSON parser produce this shape.
 *
 * Headers are keyed lowercase (RFC 5322 names are case-insensitive) and
 * each maps to its values in order of appearance. `body` is a single
 * decoded string — first text/plain part for multipart .eml, otherwise
 * the body verbatim. The JSON shape carries `body` directly.
 */

export interface Email {
  headers: Map<string, string[]>;
  body: string;
}

export function getHeader(email: Email, name: string): string | undefined {
  return email.headers.get(name.toLowerCase())?.[0];
}

export function allHeaderValues(email: Email, name: string): string[] {
  return email.headers.get(name.toLowerCase()) ?? [];
}

function appendHeader(headers: Map<string, string[]>, name: string, value: string): void {
  const key = name.toLowerCase();
  const list = headers.get(key);
  if (list) list.push(value);
  else headers.set(key, [value]);
}

// ─── .eml parser ────────────────────────────────────────────────────────────

export function parseEml(input: string): Email {
  const normalized = input.replace(/\r\n/g, '\n');
  const blank = normalized.indexOf('\n\n');
  const headerBlock = blank === -1 ? normalized : normalized.slice(0, blank);
  const bodyBlock = blank === -1 ? '' : normalized.slice(blank + 2);

  const headers = parseHeaderBlock(headerBlock);
  const body = extractBody(headers, bodyBlock);
  return { headers, body };
}

function parseHeaderBlock(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const lines = block.split('\n');
  let current: { name: string; value: string } | null = null;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (/^[ \t]/.test(line) && current) {
      // continuation line — RFC 5322 §2.2.3, fold using a single space
      current.value += ' ' + line.replace(/^[ \t]+/, '');
      continue;
    }
    if (current) {
      appendHeader(headers, current.name, decodeMimeWords(current.value));
      current = null;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trimStart();
    current = { name, value };
  }
  if (current) appendHeader(headers, current.name, decodeMimeWords(current.value));
  return headers;
}

function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charsetRaw: string, encRaw: string, dataRaw: string) => {
      const charset = charsetRaw.toLowerCase();
      const enc = encRaw.toUpperCase();
      try {
        if (enc === 'B') {
          return makeDecoder(charset).decode(base64ToBytes(dataRaw));
        }
        // Q encoding: underscores → spaces, =XX hex bytes
        const bytes: number[] = [];
        for (let i = 0; i < dataRaw.length; i++) {
          const ch = dataRaw[i]!;
          if (ch === '_') bytes.push(0x20);
          else if (ch === '=' && i + 2 < dataRaw.length) {
            bytes.push(parseInt(dataRaw.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(ch.charCodeAt(0));
          }
        }
        return makeDecoder(charset).decode(new Uint8Array(bytes));
      } catch {
        return dataRaw;
      }
    },
  );
}

function makeDecoder(charset: string): TextDecoder {
  // TextDecoder accepts more encodings at runtime than its TS type
  // suggests; fall back to utf-8 if the label is unknown.
  try {
    return new TextDecoder(charset as never);
  } catch {
    return new TextDecoder('utf-8');
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, '');
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extractBody(headers: Map<string, string[]>, raw: string): string {
  const ctype = headers.get('content-type')?.[0] ?? 'text/plain';
  const ctypeLc = ctype.toLowerCase();
  if (ctypeLc.startsWith('multipart/')) {
    const boundary = extractBoundary(ctype);
    if (!boundary) return raw;
    return extractFirstTextPart(raw, boundary) ?? '';
  }
  const enc = (headers.get('content-transfer-encoding')?.[0] ?? '').toLowerCase();
  return decodeBody(raw, enc, ctypeLc);
}

function extractBoundary(ctype: string): string | null {
  const m = /boundary\s*=\s*("([^"]+)"|([^;\s]+))/i.exec(ctype);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

function extractFirstTextPart(body: string, boundary: string): string | null {
  const parts = body.split('--' + boundary);
  // first segment is preamble, last is closing "--" or epilogue
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.startsWith('--')) continue;
    const trimmed = part.replace(/^\n/, '');
    const blank = trimmed.indexOf('\n\n');
    if (blank === -1) continue;
    const partHeaders = parseHeaderBlock(trimmed.slice(0, blank));
    const partBody = trimmed.slice(blank + 2).replace(/\n$/, '');
    const ctype = (partHeaders.get('content-type')?.[0] ?? 'text/plain').toLowerCase();
    if (ctype.startsWith('multipart/')) {
      const innerBoundary = extractBoundary(partHeaders.get('content-type')![0]!);
      if (innerBoundary) {
        const inner = extractFirstTextPart(partBody, innerBoundary);
        if (inner !== null) return inner;
      }
      continue;
    }
    if (ctype.startsWith('text/plain')) {
      const enc = (partHeaders.get('content-transfer-encoding')?.[0] ?? '').toLowerCase();
      return decodeBody(partBody, enc, ctype);
    }
  }
  return null;
}

function decodeBody(raw: string, enc: string, ctype: string): string {
  const charset = extractCharset(ctype) ?? 'utf-8';
  if (enc === 'base64') {
    try {
      return makeDecoder(charset).decode(base64ToBytes(raw));
    } catch {
      return raw;
    }
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(raw, charset);
  }
  return raw;
}

function extractCharset(ctype: string): string | null {
  const m = /charset\s*=\s*("([^"]+)"|([^;\s]+))/i.exec(ctype);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

function decodeQuotedPrintable(s: string, charset: string): string {
  // Soft line breaks: "=\n" → ""
  const joined = s.replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!;
    if (ch === '=' && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // utf-8 encode the literal char
    const code = ch.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else {
      const enc = new TextEncoder().encode(ch);
      for (const b of enc) bytes.push(b);
    }
  }
  try {
    return makeDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return joined;
  }
}

// ─── Canonical JSON parser ──────────────────────────────────────────────────

export interface EmailJson {
  headers: Record<string, string | string[]>;
  body?: string;
}

export function parseEmailJson(input: unknown): Email {
  if (typeof input !== 'object' || input === null) {
    throw new Error('email JSON must be an object');
  }
  const obj = input as Record<string, unknown>;
  const headersRaw = obj.headers;
  if (typeof headersRaw !== 'object' || headersRaw === null || Array.isArray(headersRaw)) {
    throw new Error('email JSON: `headers` must be an object');
  }
  const headers = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headersRaw)) {
    if (typeof value === 'string') {
      appendHeader(headers, name, value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v !== 'string') {
          throw new Error(`email JSON: header "${name}" must be string or string[]`);
        }
        appendHeader(headers, name, v);
      }
    } else {
      throw new Error(`email JSON: header "${name}" must be string or string[]`);
    }
  }
  const body = obj.body;
  if (body !== undefined && typeof body !== 'string') {
    throw new Error('email JSON: `body` must be a string');
  }
  return { headers, body: body ?? '' };
}

// ─── Auto-detect ────────────────────────────────────────────────────────────

/** Sniff JSON vs eml by extension or first non-whitespace byte. */
export function detectFormat(path: string | null, content: string): 'json' | 'eml' {
  if (path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.eml') || lower.endsWith('.mbox')) return 'eml';
  }
  for (const ch of content) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return ch === '{' ? 'json' : 'eml';
  }
  return 'eml';
}

export function parseEmail(content: string, format: 'json' | 'eml'): Email {
  if (format === 'json') return parseEmailJson(JSON.parse(content));
  return parseEml(content);
}
