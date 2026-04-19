/**
 * Search IR — algebraic tree representing a Fastmail search expression.
 *
 * Modules manipulate this tree rather than a string, so transformations
 * don't have to reason about quoting or precedence.
 *
 * The renderer (render.ts) is the sole place we turn the IR into the
 * Fastmail search string that lands in the emitted JSON.
 */

export type SearchNode =
  | { kind: 'and'; children: SearchNode[] }
  | { kind: 'or'; children: SearchNode[] }
  | { kind: 'not'; child: SearchNode }
  | { kind: 'field'; field: SearchField; value: string }
  | { kind: 'header'; name: string; value: string }
  | { kind: 'phrase'; value: string }
  | { kind: 'raw'; value: string };

export type SearchField =
  | 'from'
  | 'to'
  | 'cc'
  | 'bcc'
  | 'subject'
  | 'body'
  | 'with'
  | 'list';

export const and = (...children: SearchNode[]): SearchNode => ({
  kind: 'and',
  children,
});

export const or = (...children: SearchNode[]): SearchNode => ({
  kind: 'or',
  children,
});

export const not = (child: SearchNode): SearchNode => ({ kind: 'not', child });

export const field = (f: SearchField, value: string): SearchNode => ({
  kind: 'field',
  field: f,
  value,
});

export const header = (name: string, value: string): SearchNode => ({
  kind: 'header',
  name,
  value,
});

export const phrase = (value: string): SearchNode => ({ kind: 'phrase', value });

export const raw = (value: string): SearchNode => ({ kind: 'raw', value });

/** Flatten nested same-kind groups. `and(a, and(b, c))` → `and(a, b, c)`. */
export function flatten(node: SearchNode): SearchNode {
  if (node.kind === 'and' || node.kind === 'or') {
    const flatChildren: SearchNode[] = [];
    for (const child of node.children) {
      const f = flatten(child);
      if (f.kind === node.kind) flatChildren.push(...f.children);
      else flatChildren.push(f);
    }
    if (flatChildren.length === 1) return flatChildren[0]!;
    return { kind: node.kind, children: flatChildren };
  }
  if (node.kind === 'not') return { kind: 'not', child: flatten(node.child) };
  return node;
}
