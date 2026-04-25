/**
 * Scan a `raw:` search string for operators Fastmail's rule filter strips
 * silently (SPEC(10).md §8.7). A hit is a compile error — the broader
 * rationale lives in the spec; in brief: Fastmail drops these when a
 * saved search is converted into a rule, so letting them reach
 * mailrules.json means the user's rule claims behavior Fastmail will
 * not honor.
 *
 * Token-boundary rules (§8.7):
 *   - Preceding context: start-of-string OR a non-ASCII-word character
 *     (not [a-zA-Z0-9_]).
 *   - For tokens ending in ":" (e.g. `in:`, `memo:`): no following-context
 *     constraint — the colon and whatever follows is the token argument.
 *   - For complete tokens (e.g. `has:userlabels`, `is:read`): the character
 *     AFTER the token must be end-of-string or a non-word character
 *     (same ASCII-word definition). Prevents flagging `is:drafted` as
 *     containing `is:draft`.
 *
 * The scan is deliberately conservative: it flags tokens even inside
 * quoted phrases (e.g. `subject:"has:memo"`), because the more common
 * failure mode is paste-from-Fastmail-search that silently misbehaves.
 * No bypass mechanism — see §8.7.
 */

/** Tokens ending with `:` — argument follows, no following-context check. */
const PREFIX_TOKENS = ['in:', 'memo:', 'attached:', 'keyword:', 'flag:'];

/** Complete tokens — must end at word boundary (end-of-string or non-word). */
const COMPLETE_TOKENS = [
  'has:userlabels',
  'has:memo',
  'is:read',
  'is:seen',
  'is:unread',
  'is:unseen',
  'is:draft',
  'is:undraft',
];

const WORD_CHAR = /[A-Za-z0-9_]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Scan a raw search string. Returns every token hit with its character offset. */
export function scanStrippedOperators(input: string): { token: string; offset: number }[] {
  const hits: { token: string; offset: number }[] = [];
  const n = input.length;

  // Combine both lists for one forward sweep; each position we test every
  // candidate. The input strings we see are small, so a trivial O(n*k) is fine.
  for (let i = 0; i < n; i++) {
    // Preceding-context check: start-of-string OR previous char is non-word.
    if (i > 0 && isWordChar(input[i - 1])) continue;

    for (const tok of PREFIX_TOKENS) {
      if (input.startsWith(tok, i)) {
        hits.push({ token: tok, offset: i });
      }
    }
    for (const tok of COMPLETE_TOKENS) {
      if (input.startsWith(tok, i)) {
        const after = input[i + tok.length];
        if (!isWordChar(after)) {
          hits.push({ token: tok, offset: i });
        }
      }
    }
  }
  return hits;
}
