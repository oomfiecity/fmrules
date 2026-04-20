/**
 * Tri-state evaluator: SearchNode + Email → true / false / unknown.
 *
 * Match semantics (assumptions documented in README — case-insensitive
 * substring throughout, `raw` nodes treated as `unknown` since they may
 * carry state-dependent operators that aren't knowable from the email
 * alone). `and`/`or` short-circuit with tri-state: any false collapses
 * `and` to false, any true collapses `or` to true.
 */

import type { SearchNode } from '../compile/search-ir.ts';
import { allHeaderValues, getHeader, type Email } from './email.ts';

export type Tri = 'true' | 'false' | 'unknown';

export interface TraceEntry {
  op: string;
  outcome: Tri;
  reason: string;
}

export interface EvalResult {
  result: Tri;
  trace: TraceEntry[];
}

export function evaluate(node: SearchNode, email: Email, withTrace = false): EvalResult {
  const trace: TraceEntry[] = [];
  // Always build the trace internally so callers can derive a reason for
  // `unknown` results without re-evaluating; only return it when asked.
  const result = evalNode(node, email, trace);
  return { result, trace: withTrace ? trace : [] };
}

/** Internal: same evaluation but always returning trace, for callers that need it. */
export function evaluateWithTrace(node: SearchNode, email: Email): EvalResult {
  const trace: TraceEntry[] = [];
  const result = evalNode(node, email, trace);
  return { result, trace };
}

function evalNode(node: SearchNode, email: Email, trace: TraceEntry[] | null): Tri {
  switch (node.kind) {
    case 'and':
      return evalAnd(node.children, email, trace);
    case 'or':
      return evalOr(node.children, email, trace);
    case 'not': {
      const inner = evalNode(node.child, email, trace);
      const out: Tri = inner === 'unknown' ? 'unknown' : inner === 'true' ? 'false' : 'true';
      pushTrace(trace, 'not', out, `child=${inner}`);
      return out;
    }
    case 'field':
      return evalField(node.field, node.value, email, trace);
    case 'header':
      return evalHeader(node.name, node.value, email, trace);
    case 'phrase':
      return evalPhrase(node.value, email, trace);
    case 'raw':
      pushTrace(trace, 'raw', 'unknown', `opaque expression: ${node.value}`);
      return 'unknown';
  }
}

function evalAnd(children: SearchNode[], email: Email, trace: TraceEntry[] | null): Tri {
  let saw = 'true' as Tri;
  for (const c of children) {
    const r = evalNode(c, email, trace);
    if (r === 'false') {
      pushTrace(trace, 'and', 'false', 'short-circuit on false child');
      return 'false';
    }
    if (r === 'unknown') saw = 'unknown';
  }
  pushTrace(trace, 'and', saw, `all children resolved (${saw})`);
  return saw;
}

function evalOr(children: SearchNode[], email: Email, trace: TraceEntry[] | null): Tri {
  let saw = 'false' as Tri;
  for (const c of children) {
    const r = evalNode(c, email, trace);
    if (r === 'true') {
      pushTrace(trace, 'or', 'true', 'short-circuit on true child');
      return 'true';
    }
    if (r === 'unknown') saw = 'unknown';
  }
  pushTrace(trace, 'or', saw, `all children resolved (${saw})`);
  return saw;
}

function evalField(
  field: string,
  value: string,
  email: Email,
  trace: TraceEntry[] | null,
): Tri {
  const op = `${field}:${value}`;
  switch (field) {
    case 'from': {
      const r = anyContains(allHeaderValues(email, 'from'), value);
      pushTrace(trace, op, triFromBool(r), `From: ${getHeader(email, 'from') ?? '(missing)'}`);
      return triFromBool(r);
    }
    case 'to': {
      const haystacks = [
        ...allHeaderValues(email, 'to'),
        ...allHeaderValues(email, 'cc'),
        ...allHeaderValues(email, 'bcc'),
      ];
      const r = anyContains(haystacks, value);
      pushTrace(trace, op, triFromBool(r), `To/Cc/Bcc joined`);
      return triFromBool(r);
    }
    case 'cc': {
      const r = anyContains(allHeaderValues(email, 'cc'), value);
      pushTrace(trace, op, triFromBool(r), `Cc: ${getHeader(email, 'cc') ?? '(missing)'}`);
      return triFromBool(r);
    }
    case 'bcc': {
      const r = anyContains(allHeaderValues(email, 'bcc'), value);
      pushTrace(trace, op, triFromBool(r), `Bcc: ${getHeader(email, 'bcc') ?? '(missing)'}`);
      return triFromBool(r);
    }
    case 'subject': {
      const r = anyContains(allHeaderValues(email, 'subject'), value);
      pushTrace(trace, op, triFromBool(r), `Subject: ${getHeader(email, 'subject') ?? '(missing)'}`);
      return triFromBool(r);
    }
    case 'body': {
      const r = containsCi(email.body, value);
      pushTrace(trace, op, triFromBool(r), `body length=${email.body.length}`);
      return triFromBool(r);
    }
    case 'with': {
      const allValues: string[] = [];
      for (const vs of email.headers.values()) allValues.push(...vs);
      allValues.push(email.body);
      const r = anyContains(allValues, value);
      pushTrace(trace, op, triFromBool(r), 'all headers + body');
      return triFromBool(r);
    }
    case 'list': {
      const r = anyContains(allHeaderValues(email, 'list-id'), value);
      pushTrace(trace, op, triFromBool(r), `List-Id: ${getHeader(email, 'list-id') ?? '(missing)'}`);
      return triFromBool(r);
    }
    default:
      pushTrace(trace, op, 'unknown', `unknown field: ${field}`);
      return 'unknown';
  }
}

function evalHeader(name: string, value: string, email: Email, trace: TraceEntry[] | null): Tri {
  const op = `header:"${name}:${value}"`;
  const r = anyContains(allHeaderValues(email, name), value);
  pushTrace(trace, op, triFromBool(r), `${name}: ${getHeader(email, name) ?? '(missing)'}`);
  return triFromBool(r);
}

function evalPhrase(value: string, email: Email, trace: TraceEntry[] | null): Tri {
  const op = `"${value}"`;
  const subject = getHeader(email, 'subject') ?? '';
  const r = containsCi(subject, value) || containsCi(email.body, value);
  pushTrace(trace, op, triFromBool(r), 'subject ∪ body');
  return triFromBool(r);
}

function anyContains(haystacks: string[], needle: string): boolean {
  for (const h of haystacks) {
    if (containsCi(h, needle)) return true;
  }
  return false;
}

function containsCi(haystack: string, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function triFromBool(b: boolean): Tri {
  return b ? 'true' : 'false';
}

function pushTrace(trace: TraceEntry[] | null, op: string, outcome: Tri, reason: string): void {
  if (trace) trace.push({ op, outcome, reason });
}
