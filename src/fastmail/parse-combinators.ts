/**
 * Minimal shim for Fastmail's overture/parse combinators — only the pieces
 * used by parseSearch.js. Not a general combinator library.
 *
 * Each combinator consumes the leading unparsed tail of ParseResult.input
 * and, on match, appends a token tuple [name, string] to ParseResult.tokens,
 * advances the cursor, and returns true. No-match returns false and leaves
 * state untouched.
 */

export type Token = [string, string];

export class ParseResult {
  readonly input: string;
  pos: number;
  tokens: Token[];

  constructor(input: string) {
    this.input = input;
    this.pos = 0;
    this.tokens = [];
  }

  get tail(): string {
    return this.input.slice(this.pos);
  }
}

export type Pattern = (p: ParseResult) => boolean;

export function define(name: string, regex: RegExp): Pattern {
  return (p: ParseResult) => {
    const m = regex.exec(p.tail);
    if (!m || m.index !== 0) return false;
    const matched = m[0];
    if (matched.length === 0) {
      // Zero-length match — record the token but don't advance, otherwise
      // repeat() would infinite-loop. parseSearch.js uses this exactly once
      // (`wordPlaceholder`) and relies on a single emission.
      p.tokens.push([name, matched]);
      return true;
    }
    p.tokens.push([name, matched]);
    p.pos += matched.length;
    return true;
  };
}

export function sequence(patterns: Array<Pattern | null>): Pattern {
  return (p: ParseResult) => {
    const savedPos = p.pos;
    const savedLen = p.tokens.length;
    for (const pat of patterns) {
      if (!pat) throw new Error('sequence: null pattern (unfilled recursive slot)');
      if (!pat(p)) {
        p.pos = savedPos;
        p.tokens.length = savedLen;
        return false;
      }
    }
    return true;
  };
}

export function firstMatch(patterns: Pattern[]): Pattern {
  return (p: ParseResult) => {
    for (const pat of patterns) {
      if (pat(p)) return true;
    }
    return false;
  };
}

export function optional(pattern: Pattern): Pattern {
  return (p: ParseResult) => {
    pattern(p);
    return true;
  };
}

export function repeat(pattern: Pattern, min: number): Pattern {
  return (p: ParseResult) => {
    let count = 0;
    while (true) {
      const savedPos = p.pos;
      const savedLen = p.tokens.length;
      if (!pattern(p)) break;
      if (p.pos === savedPos) {
        // Zero-length match inside repeat — bail to avoid infinite loop.
        p.tokens.length = savedLen;
        break;
      }
      count += 1;
    }
    return count >= min;
  };
}
