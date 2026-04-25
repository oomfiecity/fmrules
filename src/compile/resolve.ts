/**
 * Phase 3 — resolve `extends:` references into inline condition subtrees
 * and apply the flattening rule from SPEC(10).md §9.1.
 *
 * Flattening (§9.1):
 *   - When the surrounding combinator is `all` and the snippet's top-level
 *     combinator is `all`, the snippet's children merge as direct siblings
 *     of the surrounding `all`. Same for `any` × `any`.
 *   - Mixed combinators: the snippet is substituted as a single nested
 *     condition group (no flattening).
 *   - `not:` is unary; a snippet extended inside `not:` always remains wrapped.
 *   - Multiple snippets in one `extends:` list are flattened independently,
 *     each against the same surrounding combinator.
 *
 * Missing-snippet and case-mismatch errors are surfaced here (§12.5).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Condition, Project, Rule, SnippetFile } from '../types.ts';
import type { ErrorCollector } from './errors.ts';

type Combinator = 'all' | 'any';

/**
 * Verify that `relPath` matches on-disk filename case exactly. Used to
 * catch case-insensitive-FS pitfalls per §4. Returns null if file is
 * missing entirely, the on-disk path if present (same string on exact
 * match, a different string when case differs).
 */
async function onDiskPath(cwd: string, relPath: string): Promise<string | null> {
  const parts = relPath.split('/');
  let current = cwd;
  const seen: string[] = [];
  for (const part of parts) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    seen.push(hit);
    current = path.join(current, hit);
  }
  return seen.join('/');
}

/**
 * Main entry. Mutates nothing — returns a new condition tree with
 * extends substituted. Records errors into the collector. The rule's
 * `sourceFile` is used as the error origin.
 */
export async function resolveRuleConditions(
  rule: Rule,
  project: Project,
  cwd: string,
  errors: ErrorCollector,
): Promise<Condition | null> {
  if (rule.when.kind === 'always') {
    // `always` has nothing to resolve.
    return null;
  }
  return resolveNode(rule.when, rule.sourceFile, project.snippets, cwd, errors, /*outer*/ null);
}

/**
 * `outer` is the surrounding combinator context, used to decide whether
 * a snippet extended here should be flattened. `null` means the node is
 * the top-level of `when:` — no flattening target.
 */
async function resolveNode(
  node: Condition,
  ruleFile: string,
  snippets: Map<string, SnippetFile>,
  cwd: string,
  errors: ErrorCollector,
  outer: Combinator | null,
): Promise<Condition | null> {
  if (node.kind === 'extends') {
    // An `extends:` appearing at an unexpected level is handled by the
    // wrapping combinator branches. Reaching here means `extends:` was
    // the root of `when:` — wrap in a single-child carrier for the caller
    // to handle consistently.
    const subs = await substituteExtends(node.paths, ruleFile, snippets, cwd, errors, outer);
    if (subs === null) return null;
    if (subs.length === 1) return subs[0] ?? null;
    // No outer combinator to flatten into — must not happen because
    // `extends` only appears inside a combinator per §9. Caller enforces.
    errors.error({
      file: ruleFile,
      tag: '12.5',
      message: `extends: used outside a combinator (internal — should not happen).`,
    });
    return null;
  }

  if (node.kind === 'all' || node.kind === 'any') {
    const children: Condition[] = [];
    for (const child of node.children) {
      if (child.kind === 'extends') {
        const subs = await substituteExtends(child.paths, ruleFile, snippets, cwd, errors, node.kind);
        if (subs !== null) children.push(...subs);
        continue;
      }
      const resolved = await resolveNode(child, ruleFile, snippets, cwd, errors, node.kind);
      if (resolved !== null) children.push(resolved);
    }
    return { kind: node.kind, children };
  }

  if (node.kind === 'not') {
    // §9: extends inside not: — keep wrapped (no flattening, because not: is unary).
    // The len>1 case is already rejected in phase 2.
    const child = node.child;
    if (child.kind === 'extends') {
      const subs = await substituteExtends(child.paths, ruleFile, snippets, cwd, errors, /* outer */ null);
      if (subs === null) return null;
      if (subs.length !== 1) {
        errors.error({
          file: ruleFile,
          tag: '12.5',
          message: `not: extends with multiple snippets (internal — should not reach resolve).`,
        });
        return null;
      }
      return { kind: 'not', child: subs[0]! };
    }
    const resolved = await resolveNode(child, ruleFile, snippets, cwd, errors, /* outer */ null);
    if (!resolved) return null;
    return { kind: 'not', child: resolved };
  }

  // Leaf — nothing to resolve.
  return node;
}

/**
 * Substitute an extends list at a specific site.
 *
 *   - outer = null → wrap each snippet as-is (not inside a combinator).
 *   - outer matches the snippet's top-level → flatten the snippet's children.
 *   - outer mismatched → substitute the whole snippet as one nested group.
 */
async function substituteExtends(
  paths: string[],
  ruleFile: string,
  snippets: Map<string, SnippetFile>,
  cwd: string,
  errors: ErrorCollector,
  outer: Combinator | null,
): Promise<Condition[] | null> {
  const out: Condition[] = [];
  let anyFailed = false;
  for (const p of paths) {
    const snippet = snippets.get(p);
    if (!snippet) {
      // Check case-mismatch to give a pointed error vs "missing".
      const onDisk = await onDiskPath(cwd, p);
      if (onDisk && onDisk !== p) {
        errors.error({
          file: ruleFile,
          tag: '12.5',
          message: `extends: "${p}" case does not match on-disk filename "${onDisk}". Paths are case-sensitive (§4).`,
        });
      } else {
        errors.error({
          file: ruleFile,
          tag: '12.5',
          message: `extends: snippet "${p}" does not exist.`,
        });
      }
      anyFailed = true;
      continue;
    }

    const root = snippet.root;
    if (outer !== null && (root.kind === 'all' || root.kind === 'any') && root.kind === outer) {
      out.push(...root.children);
    } else {
      out.push(root);
    }
  }
  if (anyFailed) return null;
  return out;
}
