/**
 * Field-name sets sourced from Fastmail's parseSearch.js (search grammar)
 * and extended with project-specific rejects.
 *
 * validFields: fields Fastmail's parser normalizes. Anything else becomes
 *   a plain `word` at parse time, which is not what the author wrote.
 * booleanTypes: the `is:*` boolean keywords we allow through (rules can
 *   reference `is:flagged` etc.).
 * forbiddenFields: fields Fastmail's rule import silently strips at the
 *   server side (`in:`/`inMailbox:` — mailbox filters don't apply to rule
 *   engines — and attachment-body matches we don't trust). Reject at
 *   compile time instead of shipping broken rules.
 */

export const validFields: ReadonlySet<string> = new Set([
  'in',
  'filename',
  'filetype',
  'list',
  'msgid',
  'header',
  'priority',
  'after',
  'before',
  'date',
  'minsize',
  'maxsize',
  'fromin',
  'toin',
  'hasKeyword',
  'notKeyword',
  'allInThreadHaveKeyword',
  'someInThreadHaveKeyword',
  'noneInThreadHaveKeyword',
  'from',
  'deliveredto',
  'masked',
  'with',
  'tonotcc',
  'to',
  'cc',
  'bcc',
  'subject',
  'body',
  'attached',
  'memo',
]);

export const booleanTypes: ReadonlySet<string> = new Set([
  'seen',
  'flagged',
  'draft',
  'answered',
  'muted',
  'followed',
]);

export const forbiddenFields: ReadonlySet<string> = new Set([
  'in',
  'inMailbox',
  'attached',
]);
