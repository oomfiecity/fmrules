# fmrules — Specification

A file format and directory layout for version-controlling Fastmail rules as
YAML.

---

## Contents

1. [Purpose](#1-purpose)
2. [Non-goals](#2-non-goals)
3. [Concepts](#3-concepts)
4. [Directory layout](#4-directory-layout)
5. [Manifest format](#5-manifest-format)
6. [Rule file format](#6-rule-file-format)
7. [Snippet file format](#7-snippet-file-format)
8. [Condition grammar](#8-condition-grammar)
9. [Extends semantics](#9-extends-semantics)
10. [Action vocabulary](#10-action-vocabulary)
11. [Compilation model](#11-compilation-model)
12. [Error surface](#12-error-surface)
13. [Examples](#13-examples)

---

## 1. Purpose

`fmrules` is a YAML-based format for defining, organizing, and
version-controlling a user's Fastmail rules. It targets a single person
managing their own rules across time, with git as the system of record.

The format is designed for:

- **Readable diffs.** Adding, removing, or reordering a rule should produce a
  small, obvious diff.
- **Refactoring.** Shared fragments of rule conditions (domains, sender
  patterns, addresses) can be extracted into reusable snippets.
- **Explicit structure.** Every behavior is stated in the file. Nothing is
  implicit or inferred from context.
- **Review by future-you.** A rule read in isolation should be understandable
  without cross-referencing other files.

---

## 2. Non-goals

The format deliberately does not support any of the following. These are
permanent exclusions, not "not yet" items.

- **Saved searches.** This project defines rules only. Fastmail's saved-search
  feature is out of scope.
- **Parameterized snippets.** Snippets are static fragments. If you need two
  variants, write two snippets.
- **Conditionals and environment switches.** No "this rule only on weekdays."
  If a rule needs to be off, set `enabled: false`.
- **String interpolation or computed values.** YAML values are literal.
- **Snippet composition.** Snippets cannot extend other snippets, and rules
  cannot extend other rules. Only rules extending snippets — one level, no
  recursion.
- **Shared action bundles.** Actions are inline on each rule. Copy-paste is the
  correct answer if two rules share actions; there is no `action_set` concept.
- **Bidirectional sync.** YAML is the source of truth. Changes made in
  Fastmail's web interface will be overwritten by the next compile-and-sync
  (see §11.2 on drift).
- **Importing existing Fastmail rules.** The reverse direction — reading
  rules from a Fastmail account and producing YAML — is not defined by this
  spec but is a prerequisite to safe first use against an existing account
  (see §11.3).
- **Retroactive rule application.** Fastmail does not support applying rules
  to existing messages or folders; rules fire only at delivery. A future
  sync tool might simulate this by fetching matching messages and applying
  actions directly, but that is out of scope for the spec and not available
  from Fastmail itself.
- **Relative dates.** Only absolute `YYYY-MM-DD` values are accepted in date
  conditions. Fastmail freezes relative search values (`1w`, `1m`, `1y`) into
  absolute timestamps at filter-creation time, so "last month" written in a
  rule means "last month as of the day the rule was written" — not a rolling
  window. Rather than bake that surprise into the spec, relative forms are
  rejected outright.
- **YAML anchors and aliases.** The `&` and `*` YAML reuse features are
  forbidden. Reuse goes through the snippet mechanism; permitting YAML-level
  reuse would create a second, less-visible path.
- **Fastmail features outside rules.** Labels, identities, contacts, VIP
  lists, contact groups, and the rest of Fastmail's configuration are out of
  scope. Rules refer to these by name; they are not defined here.
- **Conditions Fastmail's rule system doesn't support.** The Fastmail rule
  evaluator strips or rejects several search constructs when converting a
  search to a rule filter. Notable rejections: label matching (`in:<label>`,
  `has:userlabels`), memo matching (`memo:`, `has:memo`), attachment-body
  search (`attached:`), read/unread state (`is:read`), draft state
  (`is:draft`), and custom IMAP keywords (`keyword:`, `flag:`). These
  operators are valid in Fastmail search but silently drop when compiled into
  a rule; `fmrules` refuses to accept them so the YAML never claims behavior
  Fastmail won't honor.
- **Suffix matching on attachment filenames.** Fastmail's search engine does
  not support suffix matching on `filename:`, so matching attachments by
  extension (e.g. `.zip`, `.eml`) is not expressible except via `filetype`
  (if the extension falls into one of the seven supported categories) or
  `mimetype`. `.pdf` is covered by `filetype: pdf`; `.zip` and `.eml` are
  not expressible without `mimetype`.
- **Label-name validation.** Labels are referenced by name (e.g.
  `add_label: "Work/Clients/BigCo"`) but are not defined anywhere in
  `fmrules`. The compiler cannot tell a typo from a new label — a rule that
  misspells an existing label name will silently create a new label
  hierarchy in Fastmail on first sync. Audit `add_label` values when
  creating or renaming labels.
- **Contact group validation.** The same applies to `from_in_group` and
  `to_in_group`, which reference Fastmail contact groups by name. A typo
  silently fails to match anything — the rule compiles, syncs, and then
  never fires. Unlike the label case this fails safe (matching nothing
  is usually better than matching something unintended), but it's still
  a silent failure. Audit group-name strings when renaming groups.

---

## 3. Concepts

Three nouns. Nothing else exists at the top level of this project.

**Rule.** A named pair of (conditions, actions). When a message matches the
conditions, Fastmail applies the actions. Rules have an explicit enabled
state, an explicit continue/stop flag, and a position in a global
application order.

**Snippet.** A reusable fragment of rule conditions. A snippet is not a rule;
it cannot run on its own, has no actions, and contains only a condition
tree. Snippets exist solely to be referenced by rules via `extends`.

**Manifest.** A single file at the project root that declares the global rule
application order. The manifest is the table of contents. It determines
which rule files exist and in what sequence Fastmail applies them.

The grammar also has two deliberate escape hatches, used sparingly: the
bare value `when: always` (§6) for rules that match every message
unconditionally, and the `raw:` leaf condition (§8.7) for passing a
literal Fastmail search query through the compiler when the structured
grammar doesn't cover a case. Both are narrow — most rules don't need
either — but a reader should know the edges of the format exist before
diving into §8.

### On rule execution context

Fastmail's rule engine runs **on delivery**: when a new message arrives,
every enabled rule evaluates in `manifest.yml` order against that message.
Fastmail does not currently support applying rules retroactively to
existing messages or folders.

This means `conv_followed`, `conv_muted`, `msg_pinned`, and `msg_replied`
are only true at delivery time if the state was established *before* the
message arrived — typically because the message joins an existing
conversation whose state you've already set (e.g. a reply arriving in a
conversation you've followed, or a new message in a thread you've muted).
These predicates are narrower than search-context usage might suggest, but
they remain meaningful for conversation-scoped rules.

A future `fmrules sync` might selectively apply changed or new rules to
existing messages as an external operation — fetching matching messages
and applying actions directly via JMAP — but that capability is out of
scope for this spec and not available from Fastmail's rule engine itself.

### On labels

Fastmail lets users display their messages as either labels or folders, but
internally the concept is unified — every message has zero or more labels,
and label names may contain `/` to nest visually. This spec uses the term
**label** exclusively. A rule that "moves" a message is really adding a
label plus removing the Inbox label; this spec models that as two separate
actions (`add_label` and `archive`), because they compose cleanly and match
Fastmail's underlying storage.

Label paths use `/` to separate nesting levels, matching Fastmail's on-disk
representation. A rule's `add_label` value is the full absolute path:
`"Work"` creates a top-level label; `"Inbox/Gunzel Shop"` creates one
nested under the Inbox label; `"Work/Clients/BigCo"` creates a
two-deep nesting. Users can add labels at any level, including directly
under the root — the Inbox label is not an automatic parent. Label names
are case-sensitive; `"Work"` and `"work"` refer to distinct labels.

Note that rule **conditions** cannot inspect a message's labels (Fastmail
strips `in:<label>` from rule filters). Rules match on message content and
metadata, not on labels applied by earlier rules.

---

## 4. Directory layout

```
fmrules/
  manifest.yml
  rules/
    00-spam-and-blocks.yml
    10-work-routing.yml
    20-newsletters.yml
    30-receipts.yml
    90-catchall.yml
  snippets/
    domains/
      work.yml
      known-vendors.yml
    patterns/
      automated-senders.yml
    addresses/
      mine.yml
```

- Every `.yml` file under `rules/` (at any depth) is a rule file.
- Every `.yml` file under `snippets/` (at any depth) is a snippet file.
- The compiler discovers files by walking these two directories.
- Files outside `rules/` and `snippets/` are ignored.
- The numeric prefixes on rule filenames (`00-`, `10-`, `90-`) are a
  convention for visual grouping in file explorers. They are **not**
  load-bearing — rule application order comes from `manifest.yml`, not
  from filename sort order.

**File extension.** Only `.yml` is processed. Files with other extensions
are ignored, but the compiler emits a warning (not an error) when it finds
`.yaml` files under `rules/` or `snippets/`, since that's almost certainly
a typo for `.yml`.

**Hidden files and other non-`.yml` entries.** Files with names beginning
with `.` (hidden files — `.DS_Store`, `.gitignore`, editor swap files, and
so on), and any other non-`.yml` files under `rules/` or `snippets/`, are
ignored silently. The `.yaml`-specific warning above is the only
non-`.yml` case the compiler calls out.

**Path separators.** All paths in the project — in `manifest.yml`, in
`extends:`, and anywhere else — use forward slashes (`/`). Backslashes
are rejected.

**Symlinks.** The compiler does not follow symbolic links under `rules/`
or `snippets/`. A symlinked directory is skipped with a warning; a
symlinked file is also skipped with a warning. A silent skip on
symlinked files would make the common mistake invisible — a user who
symlinks `snippets/shared.yml` into the project would see "snippet not
found" errors from every extending rule with no obvious connection back
to the symlink. Warning on both makes the cause surfaceable.

**Case-sensitive paths.** Paths in `manifest.yml` and `extends:` must
match on-disk filenames with exact case, even on case-insensitive
filesystems (macOS default, Windows). A manifest entry `rules/foo.yml`
referring to an on-disk file `rules/Foo.yml` is a compile error. This
keeps projects portable across platforms — a project that compiles on
macOS must also compile on Linux without renaming.

---

## 5. Manifest format

The manifest is `manifest.yml` at the project root. It has two required
keys:

```yaml
version: 1
order:
  - rules/00-spam-and-blocks.yml
  - rules/10-work-routing.yml
  - rules/20-newsletters.yml
  - rules/30-receipts.yml
  - rules/90-catchall.yml
```

- `version` must be `1`. Reserved for future format revisions.
- `order` is an ordered list of paths to rule files, relative to the
  project root. Paths include the `.yml` extension.

**Validation rules.** The compiler enforces the following at load time:

- Every path listed in `order` must exist on disk.
- Every path listed in `order` must be under `rules/`.
- Every `.yml` file under `rules/` must appear in `order`.
- No path may appear in `order` more than once.
- The manifest may not contain keys other than `version` and `order`.

Any violation is a compile error. This means the filesystem and manifest
cannot drift: if you add a rule file, you must list it in the manifest;
if you remove a rule file, you must remove its entry.

**Empty projects are legal.** A project with `order: []` and no files
under `rules/` compiles successfully and emits no rules. This is the
"start of a new project" state, or the "I've turned off all my rules"
state.

---

## 6. Rule file format

A rule file defines one or more rules under a top-level `rules:` key.
Every rule file uses this shape, even when it contains a single rule.

```yaml
# rules/30-receipts.yml
rules:
  - name: archive-receipts
    enabled: true
    continue: true
    when:
      all:
        - extends:
            - snippets/domains/known-vendors.yml
        - subject: { contains: receipt }
    actions:
      - add_label: "Archive/Receipts"
      - archive: true
      - mark_read: true
```

A rule file with multiple rules lists them in order:

```yaml
# rules/20-stripe.yml
rules:
  - name: stripe-receipts
    enabled: true
    continue: false
    when:
      all:
        - from: { domain_or_subdomain: "stripe.com" }
        - subject: { contains: receipt }
    actions:
      - add_label: "Finance/Stripe"
      - archive: true

  - name: stripe-disputes
    enabled: true
    continue: false
    when:
      all:
        - from: { domain_or_subdomain: "stripe.com" }
        - subject: { contains: dispute }
    actions:
      - add_label: "Finance/Stripe/Disputes"
      - pin: true
      - notify: true
```

Within a file, rules apply in the order they appear in the `rules:` list.
File-to-file order comes from `manifest.yml`. The combined effect is a
single flat chain: file A's rules, then file B's rules, and so on.

### 6.1 Rule fields

Each rule in the `rules:` list is a dictionary with these keys:

| Key | Required | Type | Description |
|---|---|---|---|
| `name` | yes | string | Human-readable name; non-empty, must not contain `#`, subject to the uniqueness rule below |
| `enabled` | yes | boolean | Whether the rule is active; disabled rules are validated but not emitted |
| `continue` | yes | boolean | If `true`, later rules still apply after this one matches |
| `when` | yes | condition group or `always` | The match conditions |
| `actions` | yes | list | Actions applied on match, must be non-empty |

**Required by design.** Every field is required, even when the value is a
boolean default. Writing `continue: false` makes "this rule terminates the
chain" visible to the next reader of the file, rather than being inferred
from absence.

**Name uniqueness.** For any given name:

- At most one rule may have `enabled: true`.
- At most one rule may have `enabled: false`.

That is, a name may appear on up to two rules: one enabled, one
disabled. It may not appear on two enabled rules, or on two disabled
rules. This captures the predecessor pattern (keep an old version
disabled for reference while the new one takes over) without allowing
unbounded accumulation of disabled copies.

The enabled-side rule is load-bearing: Fastmail uses `name` as its
primary rule identifier, so two enabled rules sharing a name would
collide at the Fastmail level. The disabled-side rule is a taste call,
not a correctness requirement — disabled rules never reach Fastmail and
can't collide there. But three disabled `foo` rules in the same project
create a different problem: version-control diffs become ambiguous
("which old `foo` is being revived?"), and any future tooling that
addresses rules by name (debugging, selective sync, rule-fired logs)
has to disambiguate among stale copies. Capping at one disabled entry
per name forces intentional archival — delete the stale ones, keep the
one predecessor worth documenting.

To enable a previously-disabled rule, first disable or rename the rule
currently using the same name.

**Disabled rules are not emitted.** A rule with `enabled: false` is
still parsed, validated, and subject to every constraint in this spec —
a disabled rule must be structurally valid, just like an enabled one.
But the compiler does not emit it to Fastmail. `enabled: false` is a
pure YAML-side documentation and staging mechanism; Fastmail never sees
the rule at all.

This means:

- Disabled rules cannot collide with enabled ones at the Fastmail level
  (both generated names and synthetic expansion names come only from
  enabled rules).
- A disabled rule can't "take effect" in Fastmail by any route other
  than flipping its `enabled:` to `true` in YAML and recompiling.
- A bootstrap importer reading rules from Fastmail will only ever see
  the enabled set — disabled rules are a YAML concept, not a Fastmail
  concept.

**Reserved character.** Rule `name` values must not contain the `#`
character. The compiler reserves `#` as the delimiter in synthetic names
for multi-label expansion (§10.4) — `foo#2`, `foo#3`, etc. Forbidding `#`
in user-provided names guarantees that synthetic names cannot collide with
real ones.

Note that `#` is also YAML's comment marker. These two spellings look
similar but behave differently:

```yaml
rules:
  - name: "foo#bar"           # rejected: # inside the quoted name string
  - name: foo#bar             # rejected: YAML 1.2 requires whitespace before
                              #   a # for it to be a comment; no whitespace
                              #   here, so the scalar is "foo#bar" and the
                              #   validator rejects it
  - name: foo                 # accepted: the trailing "# rename" is a YAML
                              #   comment, stripped before the validator
                              #   sees the value
```

The quoted and unquoted-no-whitespace forms are both rejected as
embedded `#`; only the YAML-comment form is accepted.

**Character set.** Beyond the `#` restriction, rule names may contain
any printable UTF-8 string — letters in any script, digits, spaces,
emoji, punctuation. Control characters (ASCII 0x00–0x1F and 0x7F) and
tab characters are rejected; they would break error output and
downstream tooling that assumes single-line names. There is no
length cap imposed by `fmrules`; implementations may rely on Fastmail's
own length limits rather than duplicating them.

**Matching every message.** A rule that should fire on every incoming
message uses the bare value `when: always`:

```yaml
rules:
  - name: catchall-label
    enabled: true
    continue: true
    when: always
    actions:
      - add_label: "All mail"
```

`always` is the only non-dictionary value `when:` accepts, and it can only
appear at the root of `when:` — not nested inside a combinator.

**Interaction between `continue` and terminal actions.** Fastmail does not
permit a rule to continue if it ends the message's journey through the
inbox. Therefore `continue: true` is a compile error when combined with any
of:

- `archive: true`
- `delete_to_trash: true`
- `send_to_spam: true`

`add_label` does not trigger this constraint (adding a label leaves the
message in the inbox), so labeling rules can freely continue. `snooze_until`
is also compatible with `continue: true` — snooze moves the message
temporarily but does not terminate Fastmail's rule chain.

---

## 7. Snippet file format

A snippet file contains exactly one thing: a condition group. The top-level
key must be a combinator (`all`, `any`, or `not`).

```yaml
# snippets/domains/known-vendors.yml
any:
  - from: { domain_or_subdomain: "stripe.com" }
  - from: { domain_or_subdomain: "aws.amazon.com" }
  - from: { domain_or_subdomain: "github.com" }
```

Snippets have no `rules`, `name`, `enabled`, `continue`, `when`, or
`actions` keys. If any of these appear in a snippet file, the compiler
errors. Snippets also cannot contain the `always` construct — it is
root-of-rule-only.

**Snippets must not contain `extends`.** A snippet references no other
file. This is enforced structurally so there is no depth limit, no cycle
risk, and no question of what resolves first. If two snippets share
content, duplicate it — the explicit cost is lower than the cost of a
reference graph.

**Snippets cannot be "bare" conditions.** A snippet wrapping a single
condition still uses a combinator:

```yaml
# snippets/domains/single-vendor.yml  -- correct
all:
  - from: { domain: "specific-vendor.com" }
```

```yaml
# snippets/domains/single-vendor.yml  -- WRONG, compile error
from: { domain: "specific-vendor.com" }
```

Requiring a combinator at the top keeps substitution uniform — a snippet
is always a valid drop-in for wherever a condition group is expected.

---

## 8. Condition grammar

### 8.1 Field cheat sheet

The condition grammar covers four shapes. This table indexes every
condition field by the section that defines it.

| I want to match... | Field | Section |
|---|---|---|
| Every message, unconditionally | `when: always` | §6 |
| A sender address | `from` | 8.3 |
| A recipient address (To/Cc/Bcc/DeliveredTo) | `to` | 8.3 |
| A recipient address (To only, excluding Cc/Bcc) | `to_only` | 8.3 |
| A Cc-only recipient | `cc` | 8.3 |
| A Bcc-only recipient | `bcc` | 8.3 |
| The envelope delivery address | `delivered_to` | 8.3 |
| Subject, body, or anywhere | `subject`, `body`, `anywhere` | 8.3 |
| Attachment filename | `attachment_name` | 8.3 |
| Mailing-list identifier (exact) | `list_id` | 8.3 |
| Has any attachment | `has_attachment` | 8.4 |
| Has any mailing-list header | `has_list_id` | 8.4 |
| Sent at high priority | `priority` | 8.4 |
| Sender is in your contacts | `from_in_contacts` | 8.4 |
| Sender is in your VIP list | `from_in_vips` | 8.4 |
| Sender is in a named contact group | `from_in_group` | 8.4 |
| Any recipient is in your contacts | `to_in_contacts` | 8.4 |
| Any recipient is in your VIP list | `to_in_vips` | 8.4 |
| Any recipient is in a named contact group | `to_in_group` | 8.4 |
| You are following the thread | `conv_followed` | 8.4 |
| You have muted the thread | `conv_muted` | 8.4 |
| Message is flagged / pinned | `msg_pinned` | 8.4 |
| Message has a reply | `msg_replied` | 8.4 |
| Message is larger / smaller than a size | `larger_than`, `smaller_than` | 8.4 |
| Attachment is a specific category (pdf, image, etc.) | `filetype` | 8.4 |
| Attachment has a specific MIME type | `mimetype` | 8.4 |
| An arbitrary header exists / matches | `header` | 8.5 |
| Message date is before / after / on a date | `date` | 8.6 |
| Arbitrary Fastmail search query | `raw` | 8.7 |
| Combine conditions | `all`, `any`, `not` | 8.2 |

### 8.2 Combinators

Three combinators, spelled out explicitly — no implicit AND or OR anywhere
in the grammar.

```yaml
all:          # every listed condition must match
  - <condition>
  - <condition>

any:          # at least one listed condition must match
  - <condition>
  - <condition>

not:          # the wrapped condition must not match
  <condition>
```

`all` and `any` take a list. `not` takes a single condition group. An empty
`all: []` or `any: []` is a compile error. `not:` wrapping multiple
conditions is a compile error — write `not: { all: [...] }` or
`not: { any: [...] }` explicitly.

Combinators nest freely:

```yaml
when:
  all:
    - from: { domain: "client.com" }
    - any:
        - subject: { contains: urgent }
        - subject: { contains: asap }
    - not:
        any:
          - subject: { contains: "out of office" }
          - has_list_id: true
```

### 8.3 Phrase-match fields

Phrase-match fields operate on text content. They require a match-type
dictionary specifying how the phrase is compared.

| Field | Matches against |
|---|---|
| `from` | the From header |
| `to` | the To, Cc, Bcc, **or** DeliveredTo header (Fastmail's `to:`) |
| `to_only` | the To header only (Fastmail's `tonotcc:`) |
| `cc` | the Cc header |
| `bcc` | the Bcc header |
| `delivered_to` | the envelope delivery address (Fastmail's `deliveredto:`) |
| `subject` | the subject line |
| `body` | the message body |
| `anywhere` | From, To, Cc, Bcc, Subject, or Body |
| `attachment_name` | attachment filenames |
| `list_id` | the `List-Id` header (accepts only `equals` — see paragraph below) |

The `to` field is broader than its UI label of "To/Cc/Bcc" suggests —
Fastmail's `to:` operator also includes the DeliveredTo envelope address.
Use `to_only` for the narrow "recipient is in the To header only" case,
matching Fastmail's `tonotcc:` search operator. Because `to` is this
broad — covering four header fields — prefer `to_only` when you
specifically mean the To header. Writing `to:` when you mean `to_only:`
is one of the more common authoring mistakes.

`delivered_to` is useful for routing mail sent to a specific alias or
masked email.

Match types for text fields (`subject`, `body`, `anywhere`,
`attachment_name`):

| Match type | Semantics |
|---|---|
| `contains` | Stemmed substring match (Fastmail default) |
| `equals` | Exact match, no stemming |
| `prefix` | Matches anything beginning with the given value |

The `body` field matches whatever Fastmail's `body:` search operator
matches — the specifics of how Fastmail handles HTML-vs-plaintext
bodies, quoted replies, and forwarded content are Fastmail's
responsibility and not defined here. Test against a real account if
body-matching edge cases affect a rule's correctness.

```yaml
- subject: { contains: urgent }       # matches "urgent", "urgently", etc.
- subject: { equals: "Urgent" }       # exact match
- subject: { prefix: "RE:" }          # matches "RE:", "RE: foo", etc.
- attachment_name: { prefix: "scan_" }
```

Match types for address fields (`from`, `to`, `to_only`, `cc`, `bcc`,
`delivered_to`):

| Match type | Semantics |
|---|---|
| `contains` | Stemmed substring match on the header value |
| `prefix` | Matches anything beginning with the given value |
| `address` | Match this exact email address (ignores display name) |
| `domain` | Matches addresses with exactly this domain |
| `domain_or_subdomain` | Matches this domain and any subdomain |

```yaml
- from: { address: "alice@example.com" }
- from: { domain: "example.com" }               # matches @example.com only
- from: { domain_or_subdomain: "example.com" }  # also matches @mail.example.com
- from: { contains: "Alice" }                   # matches display name "Alice Smith"
```

Address fields do **not** offer an `equals` match type. The distinction
between "the exact email address" and "the exact header value including
display name" isn't one Fastmail's filter engine exposes cleanly, so the
spec offers `address` for exact address match and leaves display-name
matching to `contains`.

A phrase-match field must always use a dictionary. Writing `subject:
urgent` (bare value) is a compile error; it must be `subject: { contains:
urgent }`. Exactly one match type per field per condition.

**Note on suffix matching.** Fastmail's search engine does not support
suffix matching on any of these fields — there is no `suffix` match type
here. Suffix matching is available only on `header:` fields (§8.5). If you
need to match addresses ending with a specific domain, use `domain` or
`domain_or_subdomain`.

**`list_id` accepts only the `equals` match type.** Fastmail's rule
engine matches `List-Id` by exact comparison against a normalized header
value — leading `<` and trailing `>` are stripped before comparison, so
`list_id: { equals: "announce.example.com" }` matches a
`List-Id: <announce.example.com>` header correctly. Users should write
the inner identifier without angle brackets. For substring or prefix
matching against `List-Id`, use `header:` (§8.5) directly.

```yaml
- list_id: { equals: "announcements.example.com" }
```

### 8.4 Predicate fields

Predicate fields take a bare value, not a match-type dictionary. They are
either boolean (the property is or isn't present), take a small enum, or
take a simple value.

| Field | Value | Meaning |
|---|---|---|
| `priority` | `high` | Sender marked the message as high priority |
| `has_attachment` | `true` | Message has one or more attachments |
| `has_list_id` | `true` | Message has any `List-Id` header |
| `from_in_contacts` | `true` | Sender is in your contacts |
| `from_in_vips` | `true` | Sender is in your VIP list |
| `from_in_group` | group name (string) | Sender is in the named contact group |
| `to_in_contacts` | `true` | Any recipient is in your contacts |
| `to_in_vips` | `true` | Any recipient is in your VIP list |
| `to_in_group` | group name (string) | Any recipient is in the named contact group |
| `conv_followed` | `true` | You are following the conversation |
| `conv_muted` | `true` | You have muted the conversation |
| `msg_pinned` | `true` | Message is pinned (flagged) |
| `msg_replied` | `true` | Message has been replied to (answered) |
| `larger_than` | size string | Message is strictly larger than the given size |
| `smaller_than` | size string | Message is strictly smaller than the given size |
| `filetype` | filetype enum | An attachment is of the named category |
| `mimetype` | MIME string | An attachment has the given MIME type |

**Enum values are lowercase.** All enum-valued predicate fields
(`priority`, `filetype`, day values inside `snooze_until`) accept only
lowercase values. `priority: High` and `filetype: PDF` are compile errors;
write `priority: high` and `filetype: pdf`.

**Size strings** accept this grammar:

- An integer or decimal number (digits, optional decimal point, more
  digits): `"10"`, `"10.5"`, `"0.25"`
- Optional whitespace between the number and the unit
- An optional unit: `B`, `KB`, `MB`, `GB` (case-insensitive)
- No leading sign. Negative sizes are a compile error.

Valid: `"500KB"`, `"10MB"`, `"10 MB"`, `"10.5MB"`, `"1GB"`, `"500"`
(bare bytes). Invalid: `"-5MB"`, `"10 XB"`, `"1.2.3MB"`, `"10M"`.

Both `larger_than` and `smaller_than` are **strict** — a message of
exactly the given size matches neither. Note that this differs from the
date predicates in §8.6, whose exact boundary semantics are determined
by Fastmail rather than by `fmrules`.

**`priority`** accepts only the value `high`. Fastmail's rule system does
not support matching `normal` or `low` priority.

**`filetype`** enum values, matching Fastmail's UI:

| Value |
|---|
| `image` |
| `pdf` |
| `document` |
| `spreadsheet` |
| `presentation` |
| `email` |
| `calendar` |

The exact MIME types each category covers are Fastmail's own
categorization, not defined by `fmrules`. If precision matters (e.g. you
care whether `document` includes OpenDocument or only Word formats), use
`mimetype` instead. Extensions outside these seven categories (`.zip`,
`.eml`, etc.) are only expressible via `mimetype` — `attachment_name` does
not support suffix matching (§8.3).

**`mimetype`** takes any MIME type string directly:

```yaml
- mimetype: "application/pdf"
- mimetype: "image/png"
```

Examples:

```yaml
- priority: high
- has_attachment: true
- from_in_vips: true
- from_in_group: "Family"
- conv_muted: true
- larger_than: "10MB"
- filetype: pdf
```

**Negation of predicates.** For boolean predicates, "does not have" is
written with the combinator, not a false-valued field:

```yaml
- not: { has_attachment: true }         # correct
- has_attachment: false                 # WRONG, compile error
```

This keeps a single consistent spelling for negation across the grammar.
Group-membership and size predicates negate the same way:

```yaml
- not: { from_in_group: "High school" }
- not: { larger_than: "10MB" }          # message size <= 10 MB
```

Note that `not: { larger_than: "10MB" }` is **not** identical to
`smaller_than: "10MB"`: the first matches messages ≤ 10 MB (inclusive),
the second matches messages < 10 MB (strict). Harmless at realistic sizes
but worth knowing.

### 8.5 Headers

Arbitrary header matching uses the `header` field. It takes a dictionary
with a `name:` key and exactly one match-type key.

| Match type | Semantics |
|---|---|
| `exists` | The header is present (value: `true`) |
| `equals` | Header value matches exactly |
| `contains` | Header value contains the given substring |
| `prefix` | Header value begins with the given value |
| `suffix` | Header value ends with the given value |

```yaml
- header: { name: "X-Mailer", exists: true }
- header: { name: "X-Priority", equals: "1" }
- header: { name: "X-Campaign-Id", contains: "promo" }
- header: { name: "Return-Path", suffix: "@bounce.example.com" }
```

**Header names are case-insensitive** (per RFC 5322). `header: { name:
"x-mailer" }` matches `X-Mailer:`, `x-mailer:`, or `X-MAILER:` equivalently.
The spec normalizes to whatever case is written; the match ignores case.

"Header does not exist" is written with `not:`:

```yaml
- not: { header: { name: "List-Unsubscribe", exists: true } }
```

Headers are the only field type that supports `suffix`.

### 8.6 Dates

The `date` field matches against the message's date at **calendar-day
granularity** — times within a day are not expressible and not compared.
It takes a dictionary with any combination of `after:`, `before:`, and
`equals:` keys, subject to constraints.

| Match type | Semantics |
|---|---|
| `after` | Message is on this date or later (see boundary note below) |
| `before` | Message is on this date or earlier (see boundary note below) |
| `equals` | Message is on this date |

**Value format.** Absolute dates only, in ISO format `YYYY-MM-DD`:

```yaml
- date: { after: "2025-01-01" }
- date: { before: "2025-12-31" }
- date: { equals: "2025-06-15" }
- date: { after: "2025-03-01", before: "2025-05-31" }   # range
```

**No relative values.** Expressions like `"1w"`, `"1m"`, or `"1y"` are
rejected. See §2 for the rationale: Fastmail freezes such expressions to
absolute timestamps at filter-creation time, producing a window that
doesn't track the calendar. Writing absolute dates makes the behavior
explicit and unsurprising.

**Combination rules.** `equals` cannot be combined with `after` or
`before`. `after` and `before` may be combined to form a range. At least
one of the three match-type keys is required.

**Boundary behavior is Fastmail-defined.** The exact semantics at day
boundaries — whether `after: "2025-01-01"` includes or excludes messages
received at `2025-01-01T00:00:00`, and similarly for `before:` at
end-of-day — are determined by Fastmail's filter engine, not by this
spec. The summary column in the match-type table above reflects the
typical user-intent reading ("on this date or later / earlier"), but
implementations and authors should test boundary cases against a real
account if day-boundary semantics matter to a specific rule.

This is the one place the spec intentionally hedges rather than pinning
behavior down. The dates-are-Fastmail-defined posture contrasts with
size predicates (§8.4), which are **strict** by explicit `fmrules`
specification — a message of exactly the given size matches neither
`larger_than` nor `smaller_than`.

### 8.7 The `raw:` escape hatch

For anything the structured grammar doesn't cover, `raw:` takes a literal
Fastmail search query as a string:

```yaml
- raw: 'header:"X-Custom:value"'
```

The compiler does not parse or validate the string — it passes it through
verbatim. `raw:` sits at the same level as other leaf conditions and can
appear inside any combinator, including `not:`.

**Stripped-operator scan.** The compiler performs a shallow textual scan
of every `raw:` value for operators Fastmail's rule system is known to
strip or reject. A match triggers a compile error. The scanned tokens
are:

- `in:`
- `has:userlabels`
- `has:memo`
- `memo:`
- `attached:`
- `is:read`, `is:seen`, `is:unread`, `is:unseen`
- `is:draft`, `is:undraft`
- `keyword:`
- `flag:`

**Token boundary.** A token matches when both of these hold:

- **Preceding context:** start-of-string, or any non-word character
  (anything other than an **ASCII** letter, digit, or underscore). This
  matches what Fastmail's operator lexer treats as a token boundary.
  Non-ASCII letters (Unicode word characters in other scripts) are
  treated as non-word characters by the scan, which can produce false
  positives for strings mixing Unicode text with stripped-looking
  tokens — in practice rare enough not to worry about. Word-character
  examples include `a-z`, `A-Z`, `0-9`, `_`.
- **Following context:** depends on the token:
  - For tokens ending in `:` (`in:`, `memo:`, `attached:`, `keyword:`,
    `flag:`): no constraint — whatever follows is the token's argument,
    and the presence of the token itself is the rejection trigger.
  - For complete tokens (`has:userlabels`, `has:memo`, `is:read`,
    `is:seen`, `is:unread`, `is:unseen`, `is:draft`, `is:undraft`):
    end-of-string or a non-word character (using the same ASCII
    definition as the preceding-context rule).

This catches unprefixed (`in:foo`), negated (`-in:foo`, `NOT in:foo`),
parenthesized (`(in:foo OR ...)`), and quoted (`subject:"has:memo"`)
forms. It does **not** match token prefixes of longer words —
`is:drafted` does not match `is:draft` because the following character
(`e`) is a word character.

**Scan caveats.** The scan is textual, not parser-aware. It will flag a
`raw:` value that contains any of these tokens, including cases where the
token is inside a quoted phrase — for example,
`raw: 'subject:"has:memo"'` (searching for the literal text `has:memo`
inside subject lines) is rejected even though Fastmail would not strip
the token in that position. This is a deliberate trade-off: false
positives are annoying, but the far more common failure mode is a user
copying a search expression from Fastmail's web interface and pasting it
into `raw:`, only to have it silently misbehave.

**No bypass mechanism.** The spec intentionally does not offer a
`raw_unchecked:` or similar escape from the scan. Users who genuinely
need to match a stripped-looking literal token (e.g. "find messages
whose body contains the text `is:read`") will find, on investigation,
that Fastmail's search parser itself treats these tokens specially
regardless of whether they appear in a quoted phrase — so there is
typically no Fastmail-side expression for the literal-token match
either. The scan isn't taking away a capability; it's flagging an
expression that wouldn't have worked anyway. In the rare case where
a structured-field expression approximates the intent, use that; the
broader space of "I really want to search for the literal string
`is:read`" is a limitation of Fastmail's own query language, not of
`fmrules`.

Use `raw:` sparingly. Anything in `raw:` is opaque to refactoring and
error checking.

### 8.8 Condition count limit

A rule may contain at most 50 leaf conditions after extends resolution.
Fastmail's UI enforces this limit, and the compiler mirrors it as a hard
error — a rule that would compile to more than 50 conditions fails at
compile time rather than silently being truncated or rejected on upload.

The count is of **leaf** conditions, not combinators — `all: [A, B, C]`
is three, not four. Conditions pulled in via `extends` count toward the
total of the rule that extends them.

**`raw:` counts as one leaf** regardless of its internal complexity. A
`raw:` value containing `'X AND Y AND Z AND ...'` with many operators
still counts as a single leaf condition at `fmrules` compile time.
Fastmail's own evaluator will expand the raw string into its internal
representation — and may reject the resulting rule at sync time if the
*expanded* condition count exceeds Fastmail's limit. The compiler's
compile-time check cannot see inside `raw:` values, so using large raw
expressions alongside many structured conditions risks a sync-time
rejection with no compile-time warning.

### 8.9 Field collisions

A field may not appear twice as a direct child of the same `all:`
combinator. `all: [from: X, from: Y]` is always false — a message has one
From header, which cannot equal two distinct values — so the compiler
flags it as a bug rather than accepting a dead rule.

This rule applies uniformly to:

- Literal conditions within a single `all:` combinator
- Snippets and sibling conditions that resolve to the same `all:` after
  extends flattening (§9)
- Multiple snippets in one `extends:` list whose conditions flatten into
  the same `all:`

Field collision is **not** an error inside `any:` — `any: [from: X,
from: Y]` is a valid disjunction ("sender is X or Y"). Nor is it an
error when the conflicting fields are at different nesting depths
(`all: [from: X, any: [from: Y, from: Z]]` is fine — the outer `from:
X` and the inner `from:`s are not siblings).

---

## 9. Extends semantics

`extends` pulls in conditions from one or more snippet files. It appears
only inside rule files — snippet files cannot contain `extends`.

```yaml
# inside a rule file
when:
  all:
    - extends:
        - snippets/domains/work.yml
        - snippets/addresses/mine.yml
    - subject: { contains: urgent }
```

**Rules.**

- `extends` is always a list, even for a single entry.
- Every path in the list is relative to the project root and includes
  `.yml`.
- Every path must be under `snippets/`.
- No path may appear more than once in a single `extends:` list.
- `extends` can appear inside any combinator, including `not:`.
- A rule cannot extend another rule. A snippet cannot extend anything.
  There is no transitive resolution — extends is exactly one level deep,
  always.

**`extends` inside `not:` is limited to one snippet.** `not:` takes a
single condition group; an `extends:` list of length > 1 inside `not:`
would resolve to two or more condition groups, with no defined
combinator between them. Rather than invent one, the spec rejects this
shape. Writing `not: { extends: [a.yml, b.yml] }` is a compile error.
The author must choose an intended combinator explicitly:

```yaml
- not:
    all:            # or any:, whichever was meant
      - extends: [snippets/a.yml]
      - extends: [snippets/b.yml]
```

Or, equivalently, duplicate the snippet contents into a single snippet.
Note that "combine the two snippets" here means literal duplication —
snippets cannot reference other snippets, so there is no
snippet-composition feature to reach for.

### 9.1 Flattening

When a snippet's top-level combinator matches the surrounding combinator
(both `all:`, or both `any:`), the snippet's children merge as direct
siblings of the surrounding combinator. Otherwise, the snippet is
substituted as a single nested condition group.

Flattening applies to `all:` and `any:` only. `not:` is unary and has no
list for children to flatten into; a snippet extended inside `not:`
remains wrapped.

**Example with flattening.** A rule whose outer combinator is `all:`,
extending a snippet whose top-level combinator is also `all:`:

```yaml
# snippets/addresses/work-senders.yml
all:
  - from: { domain: "company.com" }
  - not: { from: { prefix: "noreply@" } }
```

```yaml
# inside a rule
when:
  all:
    - extends:
        - snippets/addresses/work-senders.yml
    - subject: { contains: urgent }
```

After resolution, the rule's `when:` has three direct children of `all:`:
the snippet's `from: { domain: ... }`, the snippet's `not: { ... }`, and
the rule's own `subject: { ... }`.

**Example without flattening.** A rule's `all:` extending a snippet whose
top-level combinator is `any:`:

```yaml
# snippets/domains/work.yml
any:
  - from: { domain_or_subdomain: "company.com" }
  - from: { domain_or_subdomain: "client.com" }
```

```yaml
# inside a rule
when:
  all:
    - extends:
        - snippets/domains/work.yml
    - subject: { contains: urgent }
```

After resolution, the rule's `all:` has two direct children: the `any:`
group from the snippet (wrapped, unflattened) and the sibling `subject:`.

**Example with mixed-combinator `extends:` list.** Each listed snippet is
flattened independently based on its own top-level combinator against the
surrounding combinator:

```yaml
# snippets/domains/work.yml has top-level any:
# snippets/patterns/strict-filter.yml has top-level all:
```

```yaml
when:
  all:
    - extends:
        - snippets/domains/work.yml          # any: — does not flatten
        - snippets/patterns/strict-filter.yml # all: — flattens
    - subject: { contains: urgent }
```

After resolution, the outer `all:` has three direct children: the
unflattened `any:` group from `work.yml`, every child of `strict-filter.yml`
merged as direct siblings (flattened), and the rule's `subject:`. Mixed
flattening within one `extends:` list is the normal case, not a surprise.

### 9.2 Collision checking after flattening

The field-collision rule (§8.9) applies after extends flattening. A
collision is triggered when the same field appears twice as direct
children of the same `all:` combinator — whether both came from the
rule, both from a single snippet, or one from each.

Example of a collision:

```yaml
# snippets/addresses/only-alice.yml
all:
  - from: { address: "alice@example.com" }
```

```yaml
# rules/example.yml — compile error
rules:
  - name: collision-example
    enabled: true
    continue: true
    when:
      all:
        - extends:
            - snippets/addresses/only-alice.yml    # contributes from:
        - from: { address: "bob@example.com" }     # collides — same all:
    actions:
      - add_label: "Mail"
```

Both `from:` conditions end up as direct children of the outer `all:`
(flattening applies: `all:` into `all:`). The compiler errors because a
single message cannot satisfy both.

To express "mail from either Alice or Bob," use `any:` instead:

```yaml
when:
  any:
    - extends:
        - snippets/addresses/only-alice.yml
    - from: { address: "bob@example.com" }
```

In `any:`, both `from:` conditions remain as direct children — no
collision, because disjunction of two senders is a valid and useful
expression.

---

## 10. Action vocabulary

Actions are a list of single-key maps. The key names the action; the value
is either `true` (for argumentless actions) or an argument.

### 10.1 Action table

| YAML | Value | Fastmail effect |
|---|---|---|
| `mark_read: true` | none | Mark as read |
| `pin: true` | none | Pin (mark flagged) |
| `notify: true` | none | Show notification |
| `add_label: "Label/Path"` | label path string | Apply the named label |
| `archive: true` | none | Remove the Inbox label (combine with `add_label` to move to a label) |
| `send_copy_to: "addr@x.com"` | email address string | Forward a copy |
| `snooze_until: { ... }` | schedule (see §10.2) | Snooze the message |
| `delete_to_trash: true` | none | Send to trash |
| `send_to_spam: true` | none | Send to spam |

**Terminal actions** are `archive`, `delete_to_trash`, and `send_to_spam`.
A rule containing any of these cannot also have `continue: true` (§6).
`snooze_until` is not terminal — it moves the message temporarily but
Fastmail's rule chain continues.

**Label path format.** Values passed to `add_label` must be non-empty
strings containing no leading or trailing whitespace, no leading or
trailing `/`, and no empty or whitespace-only path segments (i.e. no
`//` and no `"A/ /B"`). Paths like `""`, `"Work/"`, `"Work//BigCo"`,
`"Work/ /BigCo"`, and `"  Work  "` are compile errors. Valid paths:
`"Work"`, `"Inbox/Gunzel Shop"`, `"Finance/2025/Q4"`.

**Nested-under-Inbox labels and `archive`.** A label path beginning with
`"Inbox/"` creates or applies a label whose display nests visually
under Inbox, but the Inbox label itself is still its own separate top-
level label (§3). Combining `add_label: "Inbox/Foo"` with `archive:
true` produces a message state where the `Inbox/Foo` label is applied
but the top-level `Inbox` label is removed. The message will still
appear under the "Inbox > Foo" view in Fastmail's UI (because it has
the `Inbox/Foo` label), but not at the top of the inbox (because
`Inbox` was removed). This composes cleanly and is usually what users
want when they write the combination — but it's a slightly surprising
interaction worth calling out.

### 10.2 `snooze_until` schedule

`snooze_until` takes a dictionary with one required key and one optional
key, mirroring Fastmail's JSON representation directly:

```yaml
- snooze_until:
    time: "08:00"                      # required: HH:MM in 24-hour time
    days: [mon, tue, wed, thu, fri]    # optional: restrict to these days
```

If `days` is omitted, the message snoozes to the next occurrence of `time`
on any day. If `days` is present, the message snoozes to the next
occurrence of `time` on one of the listed days.

Valid day values: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` (all
lowercase).

**`time` format.** Exactly `HH:MM` in 24-hour notation: two digits, colon,
two digits. `HH` must be `00`–`23`; `MM` must be `00`–`59`. Values like
`"8:00"` (missing zero-pad), `"08:00:30"` (seconds), `"24:00"` (hour out
of range), and `"8:00 AM"` (12-hour form) are compile errors.

**Timezone.** `time` is evaluated in the account's configured Fastmail
timezone. The spec does not support per-rule timezone overrides.

**Past-time behavior.** When `days` is specified, the current day is in
the list, and `time` has already passed today, which occurrence Fastmail
picks is a server-side decision the spec does not pin down. Authors can
assume "next future occurrence of `time` on a listed day" as the intent
but shouldn't write rules whose correctness depends on this exact
boundary.

Common Fastmail presets expressed in this format:

| Fastmail preset | YAML |
|---|---|
| 8:00 AM | `{ time: "08:00" }` |
| 1:00 PM | `{ time: "13:00" }` |
| 6:00 PM | `{ time: "18:00" }` |
| weekdays at 8:00 AM | `{ time: "08:00", days: [mon, tue, wed, thu, fri] }` |
| Monday at 8:00 AM | `{ time: "08:00", days: [mon] }` |
| Saturday at 8:00 AM | `{ time: "08:00", days: [sat] }` |

### 10.3 Rules on action lists

- An empty `actions:` list is a compile error.
- An action key may appear at most once per rule, **except**:
  - `send_copy_to` may repeat for multiple forwards. Fastmail natively
    supports multiple forwards per rule (stored as an array), so
    repeated `send_copy_to` actions all land on a single Fastmail rule —
    no expansion is needed for them.
  - `add_label` may repeat to apply multiple labels (see §10.4 for the
    compilation-time expansion this implies).
- Duplicate values in repeated `send_copy_to` or `add_label` are compile
  errors — `add_label: "Work"` listed twice in the same rule is almost
  certainly a typo, not intentional.
- Argumentless actions must use the value `true`. `mark_read: false` is a
  compile error — to not mark a message read, omit the action.
- At most one of `{archive, delete_to_trash, send_to_spam}` per rule.
  These three specify mutually exclusive destinations for the message.
- The order of actions within the YAML list is cosmetic, except within
  repeated `add_label` entries (where list order determines which
  expansion rule carries which label, §10.4). A user writing
  `send_copy_to: "a"` before `archive: true` should not read the order
  as a time sequence — Fastmail's rule engine decides the internal
  ordering of action effects.

### 10.4 Multi-label expansion

Fastmail rules support at most one label per rule. `fmrules` permits
multiple `add_label` actions in one YAML rule, and the compiler expands
this into the required number of Fastmail rules at compile time.

#### Two-label example

Input:

```yaml
rules:
  - name: archive-and-tag-invoices
    enabled: true
    continue: false
    when:
      all:
        - from: { domain: "bigclient.com" }
        - subject: { contains: invoice }
    actions:
      - add_label: "Finance"
      - add_label: "Clients/BigClient"
      - archive: true
      - mark_read: true
      - pin: true
```

Expands to two Fastmail rules, sharing the same conditions and sitting
consecutively in the rule chain:

1. First generated rule: `add_label: "Finance"` plus `mark_read: true`
   and `pin: true` (the non-label, non-terminal actions). `continue:
   true` so the next generated rule runs.
2. Second generated rule: `add_label: "Clients/BigClient"` plus `archive:
   true` (the terminal action). `continue: false` (inherits the user's
   `continue:` value, which must be `false` because archive is terminal).

#### Three-label example with side effects

Input:

```yaml
rules:
  - name: triage-high-priority-client
    enabled: true
    continue: false
    when:
      all:
        - from: { domain: "bigclient.com" }
        - subject: { contains: urgent }
    actions:
      - add_label: "Work"
      - add_label: "Clients/BigClient"
      - add_label: "Priority/High"
      - notify: true
      - send_copy_to: "assistant@myaccount.com"
      - snooze_until:
          time: "08:00"
          days: [mon, tue, wed, thu, fri]
      - archive: true
```

Expands to three Fastmail rules:

1. First generated rule: `add_label: "Work"`, `notify: true`,
   `send_copy_to: "assistant@myaccount.com"`. `continue: true`.
2. Second generated rule (middle): `add_label: "Clients/BigClient"`
   only. `continue: true`.
3. Third generated rule (last): `add_label: "Priority/High"` plus
   `snooze_until: {...}` plus `archive: true` (the terminal action).
   `continue: false`.

Note that `notify:` and `send_copy_to:` fire **once per message**, not
once per label. They are placed on the first generated rule and nowhere
else. This is almost always what you want — a single forwarded copy and a
single notification per arrival — but it's worth being explicit about: if
you expected a notification for each label, that's not what happens.

`send_copy_to:` is placed on the first generated rule purely as a
convention — forwards are global effects, not per-label, and nothing
about forward semantics is sensitive to whether labels have been applied.
The same convention extends to `mark_read:`, `pin:`, and `notify:` —
all are global, per-message effects rather than per-label ones, and
could in principle go on either the first or the last generated rule
without changing user-visible behavior. The spec places them all on
the first generated rule for consistency, so the expansion partition
is simple to describe and predict: "first-rule actions" all land on the
first generated rule together, in one group.

`snooze_until:` is placed on the last generated rule for the opposite
reason: defensively, to ensure all labels are applied before any
state-changing action. Fastmail's rule chain is not known to halt on
snooze, but last-generated placement costs nothing and protects against
the edge case if it ever does.

#### Two-label example without a terminal action

A rule that applies multiple labels and then stops the chain, without
archiving, trashing, or spamming:

```yaml
rules:
  - name: tag-bugs-and-stop
    enabled: true
    continue: false
    when:
      all:
        - from: { domain_or_subdomain: "bugtracker.example.com" }
    actions:
      - add_label: "Bugs"
      - add_label: "Incoming"
```

Expands to two Fastmail rules:

1. First generated rule: `add_label: "Bugs"`. `continue: true` so the
   next generated rule runs.
2. Second generated rule (last): `add_label: "Incoming"`.
   `continue: false` — inherits the user's value. The chain stops here;
   no subsequent rule in `manifest.yml` order will evaluate against this
   message.

This pattern — tag with several labels and stop — exercises the case
where `continue: false` coexists with pure labeling and no terminal
action. It's legal and sometimes what you want.

#### Expansion rules

- Actions are partitioned into three categories by their placement in
  the generated rules:
  - **Label actions:** every `add_label`.
  - **First-rule actions:** `mark_read`, `pin`, `notify`, `send_copy_to`
    (possibly multiple). These land on the first generated rule.
  - **Last-rule actions:** at most one of `archive`, `delete_to_trash`,
    `send_to_spam` (the terminal actions), plus `snooze_until` if
    present. These land on the last generated rule.
- If there are zero `add_label` actions, the rule produces **one** Fastmail
  rule carrying all the other actions verbatim. No expansion occurs.
- If there are one or more `add_label` actions, expansion produces one
  Fastmail rule per label:
  - The **first generated rule** carries the first `add_label` plus every
    first-rule action.
  - The **last generated rule** carries the last `add_label` plus every
    last-rule action.
  - Any `add_label` between the first and last becomes its own intermediate
    generated rule with exactly one label and nothing else.
  - When there is only one `add_label`, the first and last generated rule
    are the same rule — it carries every action.
- All generated rules share the YAML rule's conditions verbatim.
- All generated rules except the last have `continue: true`. The last
  generated rule takes the user's `continue:` value from the YAML. This
  is consistent because if a terminal action is present, the user's
  `continue:` value must already be `false` (§6).
- Side-effect actions fire exactly once because they are placed on a
  single generated rule.

**Generated rule names.** When a YAML rule with `name: foo` expands into
N Fastmail rules, they are named `foo`, `foo#2`, `foo#3`, ..., `foo#N` in
emit order. The first generated rule keeps the original name; each
subsequent rule appends `#` followed by its position in the expansion.
Because user-provided names cannot contain `#` (§6.1), synthetic names
cannot collide with real ones. When a rule expands to just one Fastmail
rule (zero or one `add_label`), no suffix is added.

This expansion is entirely a compilation concern — at the YAML level, the
rule is a single object. A diff that changes the set of labels changes
one file.

---

## 11. Compilation model

The compiler is a one-way generator. YAML is the source of truth.

**Input.** A project directory containing `manifest.yml`, `rules/`, and
`snippets/`.

### 11.1 Parsing conventions

Several cross-cutting rules apply to how files are loaded and values
parsed. These are invariants of the format, not features of individual
sections.

**File encoding.** All `.yml` files are UTF-8. Other encodings are
rejected.

**YAML version.** The compiler uses YAML 1.2 with the core schema. YAML
1.1's coercion of `yes`/`no`/`on`/`off` to booleans is **not** applied —
`enabled: yes` parses as the string `"yes"` and fails the type check.
Write booleans as `true` and `false`.

**YAML anchors and aliases.** The `&` and `*` YAML reuse features are
forbidden anywhere in the project. Reuse goes through the snippet
mechanism; permitting YAML-level reuse would create a second, less-visible
path to the same goal.

**Unknown keys are errors at every nesting level.** The spec lists the
legal keys in each section; any key not listed is a compile error,
regardless of depth. This applies to rule files, snippet files, the
manifest, match-type dictionaries, action arguments, and any other
dictionary in the format. Writing `from: { domain: "x.com", region:
"US" }` errors on `region:`; writing `snooze_until: { time: "08:00",
timezone: "UTC" }` errors on `timezone:`.

**Enum values are lowercase.** All enum-valued fields accept only
lowercase values. Mixed or uppercase values are compile errors.

**String whitespace.** Leading and trailing whitespace is silently
stripped from all string values during load, with one exception:
`add_label` values error on any leading or trailing whitespace (§10.1).

### 11.2 Compilation phases

The compiler runs five phases. Validation is spread across phases 2–4
because some checks depend on information that only becomes available
after extends resolution or multi-label expansion. Errors from any phase
are collected; the compiler reports all of them and exits non-zero
rather than halting at the first failure.

1. **Load.** Parse all YAML files under `rules/` and `snippets/`. Parse
   `manifest.yml`. Parse errors are collected per file.
2. **Validate (per-file).** Enforce every rule in this spec that does
   not require cross-file resolution — manifest shape, rule-file shape,
   snippet-file shape, condition grammar, action grammar, path validity,
   unknown keys, type checks, enum ranges, name uniqueness, and every
   item in §12 not explicitly deferred to later phases. Applied to every
   rule in every file, enabled or disabled.
3. **Resolve (and validate post-resolution).** For each enabled rule,
   resolve `extends` references by substituting snippet condition trees
   inline, applying flattening (§9.1). After flattening, enforce the
   field-collision check (§8.9, §9.2). Collision errors are collected
   alongside any remaining phase-2 errors.
4. **Expand (and validate post-expansion).** For each enabled rule with
   multiple `add_label` actions, generate the consecutive Fastmail rules
   described in §10.4. After expansion, enforce the 50-leaf-condition
   cap (§8.8) against each resolved-and-expanded rule. Cap errors are
   collected alongside any remaining errors from earlier phases.
5. **Emit.** If any errors were collected in phases 1–4, the compiler
   exits non-zero and produces no output. Otherwise, for each generated
   rule from an enabled source rule, in the order given by `manifest.yml`
   (and within each file, the order in the `rules:` list) with expansion
   preserved, emit a representation of the corresponding Fastmail rule.
   Disabled rules are not emitted. The exact wire format is an
   implementation detail.

The practical consequence for implementers: the validator must be
structured to continue after phase 2 even when phase-2 errors exist, so
that phase-3 and phase-4 errors can be surfaced in the same compiler
run. This is what lets the §12 error enumeration describe a single
"all errors reported" model rather than "first error halts."

**Error output format.** Every error the compiler emits must include the
source file path, and where possible the line number within that file.
"Where possible" is meaningful: YAML parsers report line numbers
reliably for syntax errors (unbalanced brackets, malformed values, etc.),
but semantic errors raised *after* YAML parses successfully — missing
required keys, type mismatches, cross-file collisions — often do not
carry meaningful line information through to the validator. Implementers
should surface line numbers when the parser makes them available and not
fabricate them when it doesn't.

For errors that arise from the interaction of multiple files (extends
collisions, manifest-vs-filesystem drift, cross-file name duplication),
the error must name every file involved. The specific formatting (JSON,
human-readable, colored, etc.) is an implementation choice.

**Comments are not round-tripped.** YAML `#` comments in rule and snippet
files are for human readers only — they are not stored anywhere in
Fastmail and do not appear in the emitted rules. If you want notes visible
in the Fastmail UI, use a descriptive rule `name`.

**What the compiler does not do.**

- The compiler does not read existing rules from the user's Fastmail
  account.
- The compiler does not detect drift between YAML and the user's account.
- The compiler does not delete rules from the user's account that are
  absent from the YAML. (A separate sync tool, out of scope for this
  spec, may do that.)
- The compiler does not validate that labels named in `add_label` exist
  in the user's Fastmail account (§2).

### 11.3 Drift

Because the compiler is one-way, any change made through Fastmail's web
interface — adding a rule, editing a rule's conditions, disabling a rule
— will be **overwritten by the next compile-and-sync**. The YAML always
wins.

This is the single largest foot-gun of the format. A user who edits a
rule in the Fastmail web UI and then compiles from YAML will lose that
edit without warning from the compiler itself.

The spec does not solve this. The expected mitigation lives in the
(out-of-scope) sync tool: before pushing compiled rules, the sync tool
should fetch the current rules from Fastmail, diff them against what the
YAML would produce, and warn the user about any rules in Fastmail that
would be deleted or modified by the sync. This is a tooling concern; the
format itself is correct whether or not such a tool exists.

In practice: **make YAML edits the only way rules change.** Treat the
Fastmail web UI as read-only for rules once an `fmrules` project is in
use.

### 11.4 Bootstrap

The reverse direction — reading rules from a Fastmail account and
emitting them as YAML — is not defined by this spec. But it is a
prerequisite to safe first use against an account that already contains
rules: without a bootstrap importer, starting from an empty YAML project
against a non-empty Fastmail account will delete every existing rule on
first sync.

Until a bootstrap tool exists, `fmrules` should only be used against
accounts whose rules are either empty or fully represented in the YAML
project. Users migrating an existing rule set to `fmrules` must either
translate their rules by hand or wait for an importer.

This acknowledgment belongs here rather than in a non-goals list because
the bootstrap direction is not *opposed* to the spec — it's a missing
piece in the broader workflow that consumers of this spec should know
to build.

### 11.5 Emit target

The compiler emits Fastmail's rule representation — the format Fastmail's
own rule import/export accepts. The exact wire encoding (JMAP method
calls, Fastmail's JSON export format, or something else) is an
implementation detail of the compiler, not the spec.

This subsection names the target because several constraints elsewhere
in the spec are defensible only in terms of Fastmail's rule format:

- The 50-leaf-condition cap (§8.8) mirrors Fastmail's UI limit.
- Multi-label expansion (§10.4) exists because each emitted rule has at
  most one label destination.
- The terminal-action-and-`continue` exclusion (§6) mirrors Fastmail's
  rule-chain semantics.
- The `raw:` stripped-operator scan (§8.7) lists operators Fastmail's
  rule filter conversion drops silently.

**`when: always`.** A rule matching every message is emitted as a
no-condition rule: Fastmail currently represents an always-match as an
empty filter with the literal search string `*`. The compiler emits this
form so catchall rules round-trip cleanly through Fastmail's UI and
JSON export. Implementers should verify against Fastmail's present-day
API if the representation changes in a future version.

**Bootstrap round-tripping.** Because the emit target is Fastmail's own
format, a future bootstrap importer (§11.4) has a defined input: read
rules from the account, detect multi-label expansion patterns
(consecutive rules with identical conditions and names of the form
`foo`, `foo#2`, `foo#3`, ...), and reconstruct fmrules YAML. The round
trip is lossy only where fmrules is stricter than Fastmail — e.g. a
Fastmail rule whose search contains `is:read` would fail the §8.7 scan
and require manual translation.

---

## 12. Error surface

The compiler must produce clear, actionable errors for every violation.
This section enumerates them. Implementations may phrase messages however
they like; the enumeration below defines the cases that must be detected.

### 12.1 Manifest errors

- `manifest.yml` missing or unreadable
- Not valid YAML
- Missing `version` key
- `version` not equal to `1`
- Missing `order` key
- `order` not a list
- `order` contains a path not under `rules/`
- `order` contains a path that does not exist on disk
- `order` contains a path without the `.yml` extension
- `order` contains a path with backslashes
- `order` contains a path whose case does not match the on-disk filename
  exactly (§4, Case-sensitive paths)
- `order` contains the same path more than once
- A file exists under `rules/` that is not listed in `order`
- Manifest contains any top-level key other than `version` or `order`

### 12.2 Rule file errors

- Not valid YAML
- Top-level key is not `rules:`, or additional top-level keys present
- `rules:` is not a list
- `rules:` is an empty list
- A rule is missing one or more of: `name`, `enabled`, `continue`,
  `when`, `actions`
- `name` is empty
- `name` contains the reserved character `#`
- Two or more enabled rules share the same `name`
- Two or more disabled rules share the same `name`
- `enabled` is not a boolean
- `continue` is not a boolean
- `continue: true` combined with any of `archive`, `delete_to_trash`, or
  `send_to_spam`
- `when` is a value other than `always` or a valid condition group
- Rule compiles to more than 50 leaf conditions after extends resolution
  (§8.8)
- Unknown key in a rule or in any nested dictionary
- `actions` is an empty list
- Unknown action name
- Argumentless action given a value other than `true`
- `add_label` value is not a string
- `add_label` value is empty, contains leading/trailing whitespace, has
  leading or trailing `/`, or contains empty or whitespace-only path
  segments (e.g. `"Work//BigCo"` or `"Work/ /BigCo"`)
- Duplicate values in repeated `add_label` or `send_copy_to` entries
- `send_copy_to` value is not a string or is an empty string
- `snooze_until` not a dictionary, missing `time`, `time` not exactly
  `HH:MM` in the 00:00–23:59 range, `days` not a list, any entry in
  `days` not in the valid-day set (all lowercase), or `days` containing
  duplicate entries
- Action key appears more than once (except `send_copy_to` and
  `add_label`)
- More than one of `{archive, delete_to_trash, send_to_spam}`

### 12.3 Snippet file errors

- Not valid YAML
- Top-level key is not `all`, `any`, or `not`
- Unknown top-level key present (including `rules`, `name`, `enabled`,
  `continue`, `when`, `actions`, or `extends`)
- Unknown key in any nested dictionary
- Contains `always` (root-of-rule-only)

### 12.4 Condition errors

- Unknown field name
- Phrase-match field given a bare value instead of a match-type
  dictionary
- Phrase-match field given an unknown match type
- Phrase-match field given more than one match type
- Address field given an `equals` match type (not supported; use `address`)
- Predicate field given a dictionary or an invalid enum value
- Predicate enum value given in non-lowercase form (e.g. `priority: High`,
  `filetype: PDF`)
- Boolean predicate given a value other than `true`
- `priority` given a value other than `high`
- `filetype` given a value outside the enum
- `mimetype` value is not a string or is an empty string
- Size predicate (`larger_than`, `smaller_than`) given an unparseable
  size, a negative size, or a size with multiple decimal points
- `list_id` not given as a match-type dictionary, or given a match type
  other than `equals`, or `equals` value is not a string or is empty
- `from_in_group` or `to_in_group` value is empty
- `header` missing `name:` or lacking exactly one match-type key
- `date` missing any match-type key, or combining `equals` with `after`
  or `before`
- `date` range inverted: `after:` date is later than `before:` date
- `date` value is not a valid absolute `YYYY-MM-DD`
- `date` value uses a relative form (`1d`, `1w`, `1m`, `1y`) — rejected
  per §2
- Combinator with an empty list (`all: []`, `any: []`)
- `not:` wrapping a list or multiple conditions
- `always` appearing anywhere other than the root `when:` of a rule
- Field collision: same field appearing twice as direct children of an
  `all:` combinator, after extends flattening (§8.9, §9.2)

### 12.5 Extends errors

- `extends` appears in a snippet file
- `extends` value is not a list
- `extends` list is empty
- `extends` list contains the same path more than once
- `extends` with more than one entry appearing inside `not:`
- Target path does not exist
- Target path is not under `snippets/`
- Target path case does not match the on-disk filename exactly (§4,
  Case-sensitive paths)
- Target path is missing the `.yml` extension
- Target path contains backslashes

### 12.6 `raw:` errors

- `raw:` value is not a string or is an empty string
- `raw:` value contains a stripped operator per §8.7 (`in:`,
  `has:userlabels`, `has:memo`, `memo:`, `attached:`, `is:read`/`seen`/
  `unread`/`unseen`, `is:draft`/`undraft`, `keyword:`, `flag:`), detected
  using the token-boundary rules in §8.7

### 12.7 Project-wide errors

- File under `rules/` or `snippets/` is not UTF-8
- File under `rules/` or `snippets/` uses YAML anchors (`&`) or aliases
  (`*`)
- YAML document uses constructs outside YAML 1.2 core schema (e.g. a
  value parses as a boolean only under YAML 1.1 coercion)

### 12.8 Warnings (not errors)

- `.yaml` file found under `rules/` or `snippets/` (ignored; probably a
  typo for `.yml`)
- Symbolic link found under `rules/` or `snippets/` (file or directory;
  skipped without following, per §4)
- Snippet file exists under `snippets/` but is not referenced by any
  rule's `extends:` (enabled or disabled) — the snippet is orphaned and
  can likely be deleted. Disabled rules still count as references; a
  snippet used only by a disabled rule is not considered orphaned, even
  if that disabled rule is itself unreferenced. The reachability
  condition is purely "some rule extends this snippet," not "some rule
  that actually fires extends this snippet."

---

## 13. Examples

### 13.1 Minimal rule

```yaml
# rules/00-block-sender.yml
rules:
  - name: block-noisy-sender
    enabled: true
    continue: false
    when:
      all:
        - from: { address: "spammer@example.com" }
    actions:
      - delete_to_trash: true
```

### 13.2 Rule using a snippet

```yaml
# snippets/domains/work.yml
any:
  - from: { domain_or_subdomain: "mycompany.com" }
  - from: { domain_or_subdomain: "client-one.com" }
  - from: { domain_or_subdomain: "client-two.com" }
```

```yaml
# rules/10-work-inbox.yml
rules:
  - name: label-work-mail
    enabled: true
    continue: true
    when:
      all:
        - extends:
            - snippets/domains/work.yml
    actions:
      - add_label: "Work"
```

### 13.3 Nested combinators and negation

```yaml
# snippets/patterns/automated-senders.yml
any:
  - from: { prefix: "noreply@" }
  - from: { prefix: "no-reply@" }
  - from: { prefix: "notifications@" }
  - from: { prefix: "auto-" }
```

```yaml
# rules/15-client-urgent.yml
rules:
  - name: client-urgent-routing
    enabled: true
    continue: false
    when:
      all:
        - extends:
            - snippets/domains/work.yml
        - any:
            - subject: { contains: urgent }
            - subject: { contains: asap }
            - priority: high
        - not:
            any:
              - extends:
                  - snippets/patterns/automated-senders.yml
              - subject: { contains: "out of office" }
              - has_list_id: true
    actions:
      - add_label: "Priority/Clients"
      - pin: true
      - notify: true
```

### 13.4 Multiple rules in one file

```yaml
# rules/20-stripe.yml
rules:
  - name: stripe-receipts
    enabled: true
    continue: false
    when:
      all:
        - from: { domain_or_subdomain: "stripe.com" }
        - subject: { contains: receipt }
    actions:
      - add_label: "Finance/Stripe"
      - archive: true

  - name: stripe-disputes
    enabled: true
    continue: false
    when:
      all:
        - from: { domain_or_subdomain: "stripe.com" }
        - subject: { contains: dispute }
    actions:
      - add_label: "Finance/Stripe/Disputes"
      - pin: true
      - notify: true

  - name: stripe-other
    enabled: true
    continue: true
    when:
      all:
        - from: { domain_or_subdomain: "stripe.com" }
    actions:
      - add_label: "Finance/Stripe"
```

### 13.5 Multi-label with filetype and forwards

```yaml
# rules/25-archive-invoices.yml
rules:
  - name: archive-invoices-and-forward
    enabled: true
    continue: false
    when:
      all:
        - subject: { contains: invoice }
        - has_attachment: true
        - filetype: pdf
    actions:
      - add_label: "Archive/Invoices"
      - add_label: "Finance"
      - archive: true
      - send_copy_to: "bookkeeper@myaccount.com"
      - send_copy_to: "accountant@firm.com"
      - mark_read: true
```

The compiler expands this into two Fastmail rules:

- First rule: `add_label: "Archive/Invoices"`, both forwards, `mark_read`.
  `continue: true` so the next generated rule runs.
- Second rule: `add_label: "Finance"` plus `archive: true` (the terminal
  action lands on the last generated rule). `continue: false`.

### 13.6 Header-based classification with weekday snooze

```yaml
# rules/30-bank-alerts.yml
rules:
  - name: classify-bank-alerts
    enabled: true
    continue: true
    when:
      all:
        - header: { name: "From", suffix: "@notifications.mybank.com" }
        - any:
            - header: { name: "X-Alert-Type", equals: "transaction" }
            - header: { name: "X-Alert-Type", equals: "balance" }
    actions:
      - add_label: "Account alerts"
      - snooze_until:
          time: "08:00"
          days: [mon, tue, wed, thu, fri]
```

### 13.7 Size-based filter

```yaml
# rules/40-large-attachments.yml
rules:
  - name: corral-large-attachments
    enabled: true
    continue: true
    when:
      all:
        - has_attachment: true
        - larger_than: "10MB"
    actions:
      - add_label: "Large attachments"
```

### 13.8 Disabled rule kept for reference

```yaml
# rules/90-mute-that-list.yml
rules:
  - name: mute-annoying-list
    # Disabled 2026-02 — sender cleaned up their list hygiene,
    # keeping the rule around in case the noise resumes.
    enabled: false
    continue: false
    when:
      all:
        - list_id: { equals: "announcements.example.com" }
    actions:
      - delete_to_trash: true
```

### 13.9 Contact-group routing

```yaml
# rules/50-family.yml
rules:
  - name: family-inbox
    enabled: true
    continue: true
    when:
      all:
        - from_in_group: "Family"
        - not: { from_in_group: "High school" }
    actions:
      - add_label: "Personal/Family"
      - notify: true
```

### 13.10 Date-scoped rule

```yaml
# rules/55-seasonal-campaign.yml
rules:
  - name: tag-spring-campaign-replies
    enabled: true
    continue: true
    when:
      all:
        - subject: { contains: "Re: Spring campaign" }
        - date:
            after: "2025-03-01"
            before: "2025-05-31"
    actions:
      - add_label: "Campaigns/Spring 2025"
```

### 13.11 Catchall with `always`

```yaml
# rules/95-catchall-archive.yml
rules:
  - name: weekly-archive-everything-else
    enabled: true
    continue: false
    when: always
    actions:
      - add_label: "All mail"
```

### 13.12 VIP routing

```yaml
# rules/05-vip.yml
rules:
  - name: vip-priority
    enabled: true
    continue: true
    when:
      all:
        - from_in_vips: true
    actions:
      - pin: true
      - notify: true
      - add_label: "VIP"
```

---

## Appendix: a minimal starter project

```
fmrules/
  manifest.yml
  rules/
    00-blocks.yml
    10-work.yml
    20-newsletters.yml
  snippets/
    domains/
      work.yml
```

```yaml
# manifest.yml
version: 1
order:
  - rules/00-blocks.yml
  - rules/10-work.yml
  - rules/20-newsletters.yml
```

Each rule file has a top-level `rules:` key containing a list of one or
more rules; each rule declares `name`, `enabled`, `continue`, `when`, and
`actions`. The `work.yml` snippet declares a single `any:` combinator
listing the user's work domains.
