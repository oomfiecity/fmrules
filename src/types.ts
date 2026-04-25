/**
 * Types for the fmrules compiler, mirroring SPEC(10).md.
 *
 * Three layers:
 *   1. Raw YAML shapes (Manifest, RuleFile, SnippetFile, Rule, Condition, Action)
 *      — authored by the user, validated in phase 2.
 *   2. Resolved rule (Rule with all `extends:` substituted and flattened, ready for expansion).
 *   3. Emitted Fastmail rule (EmittedRule) — the wire shape written to mailrules.json.
 */

// --- Condition grammar (§8) ------------------------------------------------

export type PhraseMatchType = 'contains' | 'equals' | 'prefix';
export type AddressMatchType = 'contains' | 'prefix' | 'address' | 'domain' | 'domain_or_subdomain';
export type HeaderMatchType = 'exists' | 'equals' | 'contains' | 'prefix' | 'suffix';

export type FileType = 'image' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'email' | 'calendar';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** One phrase-matcher leaf (subject/body/anywhere/attachment_name). */
export interface PhraseLeaf {
  kind: 'phrase';
  field: 'subject' | 'body' | 'anywhere' | 'attachment_name';
  match: PhraseMatchType;
  value: string;
}

/** One address-matcher leaf (from/to/to_only/cc/bcc/delivered_to). */
export interface AddressLeaf {
  kind: 'address';
  field: 'from' | 'to' | 'to_only' | 'cc' | 'bcc' | 'delivered_to';
  match: AddressMatchType;
  value: string;
}

/** List-Id exact match (§8.3). */
export interface ListIdLeaf {
  kind: 'list_id';
  value: string;
}

/** Size predicates. Strict comparison (§8.4). Size is in bytes. */
export interface SizeLeaf {
  kind: 'size';
  op: 'larger_than' | 'smaller_than';
  bytes: number;
  /** Original author-written spelling, kept for error messages. */
  raw: string;
}

/** Predicate leaf — booleans, enums, contact groups (§8.4). */
export type PredicateLeaf =
  | { kind: 'priority'; value: 'high' }
  | { kind: 'has_attachment' }
  | { kind: 'has_list_id' }
  | { kind: 'from_in_contacts' }
  | { kind: 'from_in_vips' }
  | { kind: 'from_in_group'; group: string }
  | { kind: 'to_in_contacts' }
  | { kind: 'to_in_vips' }
  | { kind: 'to_in_group'; group: string }
  | { kind: 'conv_followed' }
  | { kind: 'conv_muted' }
  | { kind: 'msg_pinned' }
  | { kind: 'msg_replied' }
  | { kind: 'filetype'; value: FileType }
  | { kind: 'mimetype'; value: string };

/** Header match (§8.5). */
export type HeaderLeaf =
  | { kind: 'header_exists'; name: string }
  | { kind: 'header_equals'; name: string; value: string }
  | { kind: 'header_contains'; name: string; value: string }
  | { kind: 'header_prefix'; name: string; value: string }
  | { kind: 'header_suffix'; name: string; value: string };

/** Date match (§8.6). */
export interface DateLeaf {
  kind: 'date';
  after?: string;    // YYYY-MM-DD
  before?: string;   // YYYY-MM-DD
  equals?: string;   // YYYY-MM-DD (mutually exclusive with after/before)
}

/** Raw escape hatch (§8.7). */
export interface RawLeaf {
  kind: 'raw';
  value: string;
}

export type Leaf =
  | PhraseLeaf
  | AddressLeaf
  | ListIdLeaf
  | SizeLeaf
  | PredicateLeaf
  | HeaderLeaf
  | DateLeaf
  | RawLeaf;

/** Combinator + leaf tree (§8.2). */
export type Condition =
  | { kind: 'all'; children: Condition[] }
  | { kind: 'any'; children: Condition[] }
  | { kind: 'not'; child: Condition }
  | { kind: 'extends'; paths: string[] }
  | Leaf;

/** Root of `when:` — either `always` or a condition tree. */
export type When = { kind: 'always' } | Condition;

// --- Actions (§10) ---------------------------------------------------------

export interface SnoozeSchedule {
  time: string;       // HH:MM 24-hour
  days?: Weekday[];
}

export interface Actions {
  mark_read?: true;
  pin?: true;
  notify?: true;
  add_label?: string[];          // may repeat; §10.4 expansion
  archive?: true;                // terminal
  send_copy_to?: string[];       // may repeat
  snooze_until?: SnoozeSchedule;
  delete_to_trash?: true;        // terminal
  send_to_spam?: true;           // terminal
}

// --- Rule / file shapes ----------------------------------------------------

export interface Rule {
  name: string;
  enabled: boolean;
  continue: boolean;
  when: When;
  actions: Actions;
  /** Source-file path (relative to cwd), for error reporting. */
  sourceFile: string;
  /** 0-based index within the source file's `rules:` list, for error reporting. */
  sourceIndex: number;
}

export interface RuleFile {
  path: string;                  // relative to cwd, e.g. "rules/10-work.yml"
  rules: Rule[];
}

export interface SnippetFile {
  path: string;                  // relative to cwd, e.g. "snippets/domains/work.yml"
  root: Condition;               // top-level combinator (all|any|not)
}

export interface Manifest {
  order: string[];               // rule file paths, relative to cwd
}

export interface Project {
  manifest: Manifest;
  ruleFiles: RuleFile[];
  snippets: Map<string, SnippetFile>;  // keyed by path (e.g. "snippets/foo.yml")
}

// --- Emitted shape ---------------------------------------------------------

export interface EmittedSnooze {
  time: string;
  days: Weekday[] | null;
}

/**
 * Shape written to mailrules.json. Matches Fastmail's Rule import/export schema.
 * Action field order here mirrors the emitted JSON for byte-stable diffs.
 */
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
  snoozeUntil: EmittedSnooze | null;
  discard: boolean;
  markSpam: boolean;
  stop: boolean;
  previousFileInName: string | null;
  created: string;
  updated: string;
}
