/**
 * Static rule validation:
 *   - At least one action is truthy (mirrors Fastmail's Rule.hasAction).
 *   - fileIn names a known folder (warning or error under --strict).
 *   - Rendered search string round-trips through Fastmail's own parseSearch:
 *       - parses without leaving unconsumed input,
 *       - produces a tree that re-prints to a stable string (idempotent),
 *       - contains no forbidden fields (`in:`, `inMailbox:`, `attached:`).
 */

import type { Logger } from '../logger.ts';
import type { PartialRule } from '../types.ts';
import type { LoadedMeta } from './meta.ts';
import { parseSearch, fullyConsumed } from '../fastmail/parseSearch.ts';
import { forbiddenFields } from '../fastmail/valid-fields.ts';
import { walk } from './search-ir.ts';
import { render } from './render.ts';

export interface ValidateOptions {
  strict: boolean;
  log: Logger;
}

const ACTION_KEYS = [
  'skipInbox',
  'markRead',
  'markFlagged',
  'showNotification',
  'fileIn',
  'redirectTo',
  'snoozeUntil',
  'discard',
  'markSpam',
  'stop',
] as const;

function hasAction(rule: PartialRule): boolean {
  const a = rule.actions;
  if (a.fileIn) return true;
  if (a.redirectTo && a.redirectTo.length > 0) return true;
  if (a.snoozeUntil) return true;
  return (
    !!a.skipInbox ||
    !!a.markRead ||
    !!a.markFlagged ||
    !!a.showNotification ||
    !!a.discard ||
    !!a.markSpam ||
    !!a.stop
  );
}

/**
 * Round-trip the rendered search through parseSearch. Throws on any failure
 * mode Fastmail would silently mishandle.
 */
function validateSearchString(ruleName: string, searchStr: string): void {
  if (!fullyConsumed(searchStr)) {
    throw new Error(
      `Rule "${ruleName}": search string is not fully parseable by Fastmail's grammar. Likely an unbalanced group or unescaped special char. Input: ${searchStr}`,
    );
  }
  const tree = parseSearch(searchStr);
  if (!tree) {
    throw new Error(
      `Rule "${ruleName}": search string parses to an empty tree. Input: ${searchStr}`,
    );
  }
  for (const node of walk(tree)) {
    if (node.kind === 'field' && forbiddenFields.has(node.field)) {
      throw new Error(
        `Rule "${ruleName}": search uses forbidden field "${node.field}:" — Fastmail strips these silently at rule import.`,
      );
    }
  }
  // Idempotence: rendering the parsed tree and re-parsing must be a fixed
  // point — guarantees Fastmail's grammar reads the string as we intended.
  const rendered = render(tree);
  const reparsed = parseSearch(rendered);
  if (!reparsed || render(reparsed) !== rendered) {
    throw new Error(
      `Rule "${ruleName}": search failed round-trip re-parse. Original=${searchStr} | rendered=${rendered}`,
    );
  }
}

export function validateRule(
  rule: PartialRule,
  meta: LoadedMeta,
  opts: ValidateOptions,
  renderedSearch: string,
): void {
  if (!hasAction(rule)) {
    throw new Error(
      `Rule "${rule.name}" (${rule.meta.file}) has no actions (needs at least one of: ${ACTION_KEYS.join(', ')})`,
    );
  }

  if (!rule.hasOwnMatchers && !rule.matchAll) {
    throw new Error(
      `Rule "${rule.name}" (${rule.meta.file}) has no own matchers (only inherited from defaults / archetype / module). Add 'match_all: true' to confirm this is intentional.`,
    );
  }

  const domain = rule.matchers.domain;
  const domainValues: string[] = [];
  if (typeof domain === 'string') domainValues.push(domain);
  else if (Array.isArray(domain)) domainValues.push(...domain);
  else if (domain && typeof domain === 'object') {
    domainValues.push(...(domain.any ?? []), ...(domain.all ?? []));
  }
  for (const v of domainValues) {
    if (v.startsWith('@')) {
      throw new Error(
        `Rule "${rule.name}" (${rule.meta.file}): domain value "${v}" starts with '@' — write it bare ("${v.slice(1)}"); the '@' is added during rendering.`,
      );
    }
  }

  if (!rule.search) {
    throw new Error(`Rule "${rule.name}" has no search tree (internal error)`);
  }

  validateSearchString(rule.name, renderedSearch);

  const fileIn = rule.actions.fileIn;
  if (fileIn && meta.config.folders && !meta.config.folders.includes(fileIn)) {
    const msg = `Rule "${rule.name}" references unknown folder "${fileIn}" (not in meta/config.yaml folders list)`;
    if (opts.strict) throw new Error(msg);
    opts.log.warn(msg);
  }
}
