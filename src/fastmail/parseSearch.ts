/**
 * Adapted from Fastmail's open-source parseSearch.js. Used here solely
 * as a validator: we parse the rendered search string, normalize the
 * resulting tree, and `.print()` it back. If the round-trip fails or
 * the parse is non-strict (leaves input unconsumed), the search string
 * would be mis-interpreted by Fastmail's rule engine and we reject it.
 *
 * Omissions from the original:
 *   - `getSearchOperators` / `walkOperators` (metrics — not needed).
 *   - `emailRegExp` import (only used by walkOperators).
 *   - `Array.prototype.last` polyfill (rewritten to `arr[arr.length - 1]`).
 *
 * Source file: fastmail-oss-excerpts/parseSearch.js.
 */

import {
  define,
  firstMatch,
  optional,
  ParseResult,
  repeat,
  sequence,
  type Pattern,
} from './parse-combinators.ts';

// --- Search Grammar

const bool = define(
  'bool',
  /^is:(?:un|not)?(?:read|seen|pinned|flagged|starred|draft|answered|replied|muted|followed)\b/i,
);
const upperBool = define(
  'bool',
  /^(?:UN)?(?:READ|SEEN|PINNED|FLAGGED|DRAFT|ANSWERED|REPLIED)\b/,
);
const hasAtt = define('hasAtt', /^has:att(?:achment)?\b/i);
const upperHasAtt = define('hasAtt', /^HASATT\b/);
const noAtt = define('noAtt', /^has:noatt(?:achment)?\b/i);
const upperNoAtt = define('noAtt', /^(?:HAS)?NOATT\b/);
const userLabels = define('userLabels', /^has:userlabels\b/);
const hasMemo = define('hasmemo', /^has:(?:no)?memo\b/);

const op = define('op', /^(?:AND|OR|NOT)\b/);
const word = define('word', /^(?:[^\s\(\)\{\}\\]|\\.|\([^\s\(\)\{\}\\]+\))+/);
const wordPlaceholder = define('word', /^$/);
const fieldTok = define('field', /^[a-zA-Z]+:/);
const whitespace = define('whitespace', /^\s+/);

const phrase = firstMatch([
  sequence([
    define('begin:phrase', /^"/),
    define('phrase', /^(?:[^"\\]|\\.)*/),
    define('end:phrase', /^(?:"|$)/),
  ]),
  sequence([
    define('begin:phrase', /^'/),
    define('phrase', /^(?:[^'\\]|\\.)*/),
    define('end:phrase', /^(?:'|$)/),
  ]),
  sequence([
    define('begin:phrase', /^\+/),
    define('phrase', /^(?:[^\s\(\)\{\}\\]|\\.)+/),
  ]),
]);

const andGroupPatterns: Array<Pattern | null> = [
  define('begin:and', /^\(/),
  null,
  define('end', /^\)/),
];
const andGroup = sequence(andGroupPatterns);

const orGroupPatterns: Array<Pattern | null> = [
  define('begin:or', /^\{/),
  null,
  define('end', /^\}/),
];
const orGroup = sequence(orGroupPatterns);

const notTermPatterns: Array<Pattern | null> = [define('notop', /^\-/), null];
const notTerm = sequence(notTermPatterns);

const searchTerm: Pattern = firstMatch([
  bool,
  upperBool,
  hasAtt,
  upperHasAtt,
  noAtt,
  upperNoAtt,
  userLabels,
  hasMemo,
  op,
  notTerm,
  sequence([
    fieldTok,
    optional(whitespace),
    firstMatch([phrase, andGroup, orGroup, word, wordPlaceholder]),
  ]),
  phrase,
  andGroup,
  orGroup,
  word,
]);
notTermPatterns[1] = searchTerm;

const search = sequence([
  optional(whitespace),
  searchTerm,
  repeat(sequence([whitespace, searchTerm]), 0),
  optional(whitespace),
]);
andGroupPatterns[1] = search;
orGroupPatterns[1] = search;

// --- Parse tree

type TreeNodeType =
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'field'
  | 'word'
  | 'phrase'
  | 'seen'
  | 'flagged'
  | 'draft'
  | 'answered'
  | 'muted'
  | 'followed'
  | 'attachment'
  | 'userLabels'
  | 'hasmemo'
  | 'memo';

interface NormaliseOptions {
  singularNot?: boolean;
}

const boolNames: Record<string, string> = {
  read: 'seen',
  pinned: 'flagged',
  starred: 'flagged',
  replied: 'answered',
};

const fieldNames: Record<string, string> = {
  label: 'in',
  folder: 'in',
  flag: 'hasKeyword',
  keyword: 'hasKeyword',
  allkeyword: 'allInThreadHaveKeyword',
  somekeyword: 'someInThreadHaveKeyword',
  nonekeyword: 'noneInThreadHaveKeyword',
  since: 'after',
  newer: 'after',
  newer_than: 'after',
  modifiedafter: 'after',
  until: 'before',
  older: 'before',
  older_than: 'before',
  modifiedbefore: 'before',
  bigger: 'minsize',
  larger: 'minsize',
  size: 'minsize',
  smaller: 'maxsize',
  modified: 'date',
  rfc822msgid: 'msgid',
};

export class SearchTreeNode {
  type: TreeNodeType | string;
  value: string | boolean | null;
  children: SearchTreeNode[] | null;
  start: number;
  end: number;
  parent: SearchTreeNode | null;

  constructor(
    type: TreeNodeType | string,
    value: string | boolean | null,
    children: SearchTreeNode[] | null,
    start: number,
    end = 0,
  ) {
    this.type = type;
    this.value = value;
    this.children = children && children.length ? children : children;
    this.start = start;
    this.end = end;
    this.parent = null;
  }

  normalise(singularNot?: boolean): SearchTreeNode | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: SearchTreeNode | null = this;
    let children = node.children;
    const type = node.type;
    let isBinaryOperator = false;

    if (children) {
      isBinaryOperator = type === 'AND' || type === 'OR';
      if (isBinaryOperator) {
        children = node.children = normaliseBinaryOp(
          type,
          children,
          [],
          new Set<string>(),
          singularNot,
        );
      }
      if (!children || !children.length) {
        node = null;
      } else if (!isBinaryOperator) {
        const first = children[0]!.normalise(singularNot);
        if (!first) {
          node = null;
        } else {
          children[0] = first;
          if (type === 'NOT') {
            if (first.type === 'OR') {
              node.children = first.children;
            } else if (first.type === 'NOT') {
              node = first.children![0]!;
            } else if (typeof first.value === 'boolean') {
              first.start = node.start;
              node = first;
              node.value = !node.value;
            }
          }
        }
      } else if (children.length === 1) {
        node = children[0]!.normalise(singularNot);
      } else if (!singularNot && type === 'AND' && children.every(isNot)) {
        node.type = 'NOT';
        node.children = children.reduce<SearchTreeNode[]>((acc, n) => {
          if (n.children) acc.push(...n.children);
          return acc;
        }, []);
      }
      for (const child of (node && node.children) || []) {
        child.parent = node;
      }
    }
    return node;
  }

  print(isRecursive = false): string {
    let type = this.type;
    const value = this.value;
    const children = this.children;
    switch (type) {
      case 'flagged':
        return 'is:' + (value ? '' : 'un') + 'pinned';
      case 'seen':
        return 'is:' + (value ? '' : 'un') + 'read';
      case 'answered':
        return 'is:' + (value ? '' : 'un') + type;
      case 'draft':
      case 'muted':
      case 'followed':
        return 'is:' + (value ? '' : 'not') + type;
      case 'hasmemo':
        type = 'memo';
      // falls through
      case 'attachment':
        return 'has:' + (value ? '' : 'no') + type;
      case 'word':
        return String(value);
      case 'phrase':
        return JSON.stringify(value);
      case 'field':
        return value + ':' + children![0]!.print(true);
      case 'NOT': {
        const result = (children ?? [])
          .map((child) => 'NOT ' + child.print(true))
          .join(' ');
        return isRecursive ? '(' + result + ')' : result;
      }
      case 'OR':
      case 'AND': {
        const parts = (children ?? []).map((child) => child.print(true));
        const result = type === 'OR' ? parts.join(' OR ') : parts.join(' ');
        return isRecursive ? '(' + result + ')' : result;
      }
    }
    return '';
  }
}

function isNot(node: SearchTreeNode): boolean {
  return node.type === 'NOT';
}

function normaliseBinaryOp(
  type: string,
  children: SearchTreeNode[],
  newChildren: SearchTreeNode[],
  seen: Set<string>,
  singularNot?: boolean,
): SearchTreeNode[] {
  for (const c of children) {
    const node = c.normalise(singularNot);
    if (!node) continue;
    if (node.type === type) {
      normaliseBinaryOp(type, node.children ?? [], newChildren, seen, singularNot);
    } else {
      const str = node.print();
      if (seen.has(str)) continue;
      seen.add(str);
      newChildren.push(node);
    }
  }
  return newChildren;
}

function fromTokens(tokens: Array<[string, string]>): SearchTreeNode {
  const parents: SearchTreeNode[] = [];
  let parent = new SearchTreeNode('AND', null, [], 0);
  let nextTerms: SearchTreeNode[] | null = null;

  let pos = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    let str = token[1];
    const length = str.length;
    const children: SearchTreeNode[] = nextTerms ?? parent.children!;
    nextTerms = null;
    let type: string | undefined;
    let value: string | boolean | null = null;
    switch (token[0]) {
      case 'bool': {
        const results =
          /^(?:is:)?(un|not)?(read|seen|pinned|flagged|starred|draft|answered|replied|muted|followed)/.exec(
            str.toLowerCase(),
          );
        if (!results) continue;
        const key = results[2]!;
        type = boolNames[key] ?? key;
        value = !results[1];
        break;
      }
      case 'hasAtt':
        type = 'attachment';
        value = true;
        break;
      case 'noAtt':
        type = 'attachment';
        value = false;
        break;
      case 'userLabels':
        type = 'userLabels';
        value = true;
        break;
      case 'hasmemo':
        type = 'hasmemo';
        value = str.length === 8;
        break;
      case 'word':
        type = 'word';
        value = str;
        break;
      case 'phrase':
        type = 'phrase';
        value = str.replace(/\\(.)/g, '$1');
        break;
      case 'begin:and':
        parents.push(parent);
        {
          const next = new SearchTreeNode('AND', null, [], pos);
          children.push(next);
          parent = next;
        }
        pos += length;
        continue;
      case 'begin:or':
        parents.push(parent);
        {
          const next = new SearchTreeNode('OR', null, [], pos);
          children.push(next);
          parent = next;
        }
        pos += length;
        continue;
      case 'end': {
        const last = parent.children && parent.children.length
          ? parent.children[parent.children.length - 1]!
          : null;
        parent.end = (last ? last.end : pos) + length;
        parent = parents.pop()!;
        pos += length;
        continue;
      }
      case 'field':
        type = 'field';
        value = str.slice(0, -1).toLowerCase();
        value = fieldNames[value] ?? value;
        nextTerms = [];
        break;
      case 'notop':
        str = 'NOT';
      // falls through
      case 'op':
        if (str === 'AND') {
          pos += length;
          continue;
        }
        nextTerms = [];
        if (str === 'OR' && children.length) {
          nextTerms.push(children.pop()!);
        }
        type = str;
        value = null;
        break;
      default:
        nextTerms = children;
        pos += length;
        continue;
    }
    let start = pos;
    let end = pos + length;
    if (type === 'phrase') {
      start -= 1;
      const nextToken = tokens[i + 1];
      if (nextToken && nextToken[0] === 'end:phrase' && nextToken[1]) {
        end += 1;
      }
    }
    if (nextTerms && nextTerms.length) {
      start = nextTerms[0]!.start;
    }
    children.push(new SearchTreeNode(type, value, nextTerms, start, end));
    if (children !== parent.children) {
      let node: SearchTreeNode | null = parent.children
        ? parent.children[parent.children.length - 1]!
        : null;
      while (node) {
        node.end = end;
        node = node.children && node.children.length
          ? node.children[node.children.length - 1]!
          : null;
      }
    }
    pos += length;
  }
  const last = parent.children && parent.children.length
    ? parent.children[parent.children.length - 1]!
    : null;
  parent.end = last ? last.end : 0;
  return parent;
}

export function parseSearch(
  input: string,
  opts: NormaliseOptions = {},
): SearchTreeNode | null {
  const p = new ParseResult(input.replace(/[\u201C\u201D]/g, '"'));
  search(p);
  const tree = fromTokens(p.tokens);
  return tree.normalise(opts.singularNot);
}

/**
 * True if the parser consumed the full input. If `false` the search string
 * is partially understood (unbalanced `()` / `{}`, stray chars) — Fastmail
 * would silently truncate it.
 */
export function fullyConsumed(input: string): boolean {
  const p = new ParseResult(input.replace(/[\u201C\u201D]/g, '"'));
  search(p);
  return p.pos === p.input.length;
}

/** Walk tree yielding every node (pre-order). */
export function* walk(node: SearchTreeNode | null): Generator<SearchTreeNode> {
  if (!node) return;
  yield node;
  if (node.children) {
    for (const c of node.children) yield* walk(c);
  }
}
