/**
 * In-memory rule representation used throughout the compile pipeline.
 * Matchers live as structured fields + SearchIR, not as strings, so
 * modules can inspect and rewrite any part of a rule cleanly.
 *
 * This differs from the final emitted JSON shape (see emit.ts).
 */

import type { SearchNode } from './compile/search-ir.ts';

/**
 * Rule-level match tree — cross-field OR / AND composition.
 * `any:` branches OR-join; `all:` branches AND-join. Leaves are
 * single-value matchers.
 */
export type MatchTree =
  | { any: MatchTree[] }
  | { all: MatchTree[] }
  | { from: string }
  | { to: string }
  | { subject: string }
  | { body: string }
  | { with: string }
  | { list: string }
  | { text: string }
  | { header: { name: string; value: string } }
  | { raw: string };

export interface Actions {
  skipInbox?: boolean;
  markRead?: boolean;
  markFlagged?: boolean;
  showNotification?: boolean;
  fileIn?: string | null;
  redirectTo?: string[] | null;
  snoozeUntil?: { date: string } | null;
  discard?: boolean;
  markSpam?: boolean;
  stop?: boolean;
}

/**
 * Canonical matcher value. `any` OR-joins; `all` AND-joins; both → AND of
 * the two groups. Bare string and bare list are equivalent to `{any: [v]}`
 * / `{any: [...]}` and are accepted as authoring sugar.
 */
export type MatcherValue =
  | string
  | string[]
  | { any?: string[]; all?: string[] };

/**
 * Matcher fields as they appeared in YAML, normalized to the canonical
 * shape. Modules can edit these directly.
 *
 * Plurals (`subjects`, `bodies`) and `_all` suffixes are normalized away
 * by pickMatchers — the internal Matchers only carries the singular form.
 * Distinct fields are AND-joined at the top level by buildSearch.
 */
export interface Matchers {
  from?: MatcherValue;
  to?: MatcherValue;
  subject?: MatcherValue;
  body?: MatcherValue;
  header?: { name: string; value: string } | Array<{ name: string; value: string }>;
  match?: MatchTree;
  list?: MatcherValue;
  with?: MatcherValue;
  text?: MatcherValue;
  domain?: MatcherValue;
  searchRaw?: string;
}

export interface ModuleRef {
  name: string;
  args?: unknown;
}

export interface SourceMeta {
  /** Source file path (relative to cwd). */
  file: string;
  /** 0-based index of the rule within its file's `rules:` list. */
  fileIndex: number;
  /** 0-based offset among siblings produced by fan-out modules (0 if not fanned). */
  fanoutIndex: number;
}

/**
 * The working representation threaded through the pipeline.
 * `search` is populated by buildSearch from matchers.
 */
export interface PartialRule {
  name: string;
  isEnabled?: boolean;
  combinator?: 'all' | 'any';
  /** True iff the rule's own body contributed at least one matcher field
   * (pre-merge, pre-module). Used to enforce `match_all: true` on catchalls
   * that rely entirely on inherited matchers. */
  hasOwnMatchers: boolean;
  /** Author opt-in declaring this rule's empty own-matchers is intentional. */
  matchAll?: boolean;
  matchers: Matchers;
  /**
   * Additional search IR fragments contributed by modules. Each entry is
   * AND-joined with the matcher-derived tree when buildSearch runs.
   * Modules that produce non-field-shaped expressions (e.g. OR groups over
   * headers) push here instead of mutating `matchers`.
   */
  extraSearch?: SearchNode[];
  /** Set by buildSearch; modules generally don't touch this. */
  search?: SearchNode;
  actions: Actions;
  sortOrder?: number;
  meta: SourceMeta;
  /** Resolved chain of modules (post-dedup, post-subtract). */
  moduleChain?: ModuleRef[];
}

/** Shape emitted to mailrules.json. Matches Fastmail's Rule schema. */
export interface EmittedRule {
  name: string;
  isEnabled?: boolean;
  combinator: 'all' | 'any';
  conditions: null;
  search: string;
  markRead: boolean;
  markFlagged: boolean;
  showNotification: boolean;
  redirectTo: string[] | null;
  fileIn: string | null;
  skipInbox: boolean;
  snoozeUntil: { date: string } | null;
  discard: boolean;
  markSpam: boolean;
  stop: boolean;
  previousFileInName: string | null;
  created: string;
  updated: string;
}
