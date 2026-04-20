# fmrules

YAML-authoring tool that compiles Fastmail mail rules into `mailrules.json`. Bun/TypeScript CLI plus a composite GitHub Action for downstream rule repos.

## Commands

| Command | What it does |
|---|---|
| `fmrules check` | Validate YAML sources without emitting. |
| `fmrules compile` | Emit `mailrules.json` + `meta/lockfile.json`. |
| `fmrules migrate` | Codemod legacy YAML shapes (plural / `_all` matchers → nested). |
| `fmrules match` | Report which rules in this repo would match an email. |

Global flags (all commands): `--rules`, `--meta`, `--cwd`, `--verbose`/`-v`, `--quiet`/`-q`, `--color`.

## `fmrules match`

Given an email, evaluate every rule in the current repo's source YAML against it using the `SearchNode` IR built by the compile pipeline. Returns a tri-state per rule: matched, no-match, or undetermined (when the rule contains state-dependent operators like `is:read` that aren't knowable from the email alone).

### Usage

```
fmrules match <path>             # auto-detect .eml vs .json by extension/sniff
fmrules match --stdin            # read from stdin
fmrules match --json <path>      # force JSON parsing
fmrules match --eml <path>       # force .eml parsing
fmrules match --output json      # JSON output (default: human)
fmrules match --trace            # per-leaf evaluation trace
fmrules match --rule <name>      # restrict to a single rule
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | At least one rule matched. |
| `1` | No rule matched (some may be undetermined — read JSON for nuance). |
| `2` | Error (file not found, invalid input, pipeline failure). |

### Canonical JSON input

```json
{
  "headers": { "From": "a@b.com", "Subject": "...", "List-Id": "<x.example.com>" },
  "body": "plain text body"
}
```

Header values may be `string` or `string[]`. Header names are case-insensitive on read. `body` is optional (defaults to `""`).

### JSON output schema

```json
{
  "email": { "from": "...", "subject": "...", "listId": null },
  "totalRules": 5,
  "evaluatedRules": 5,
  "matched": [
    { "name": "Anthropic receipts", "file": "anthropic.yaml", "result": "true",
      "trace": [ { "op": "from:anthropic.com", "outcome": "true", "reason": "..." } ] }
  ],
  "undetermined": [
    { "name": "...", "file": "...", "result": "unknown", "reason": "raw: opaque expression: is:read" }
  ],
  "noMatch": 2
}
```

`trace` is only emitted when `--trace` is passed.

### Match semantics (assumptions)

| Operator | Matches when |
|---|---|
| `from:X` | `From` header contains `X` (substring, case-insensitive). |
| `to:X` | `To` ∪ `Cc` ∪ `Bcc` contains `X`. |
| `cc:X` / `bcc:X` | The respective header contains `X`. |
| `subject:X` | `Subject` contains `X`. |
| `body:X` | Body text contains `X`. |
| `with:X` | Any header value or body contains `X`. |
| `list:<X>` | `List-Id` header contains `<X>` (angle-bracketed canonical form). |
| `header:"Name:value"` | `headers[Name]` (case-insensitive) contains `value`. |
| Bare phrase | `Subject` ∪ body contains the phrase. |
| `raw` (e.g. `is:read`, `has:attachment`) | **Always undetermined** — these depend on mailbox state, not email content. |

Substring matching is **case-insensitive** throughout. This matches the Fastmail convention but is unverified against the live engine; if the agent reports false negatives, revisit.
