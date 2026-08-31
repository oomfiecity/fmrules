/**
 * Live JMAP session — browser-mediated access to Fastmail's JMAP endpoint.
 *
 * Fastmail's JMAP API is authenticated by a bearer session token plus the
 * API session cookie, both of which only exist inside an authenticated
 * browser context. `fmrules login` saves that context as a Playwright
 * storage state; this module replays it, captures the bearer token from
 * the web app's own traffic, and issues JMAP requests from within the page
 * so cookies ride along.
 *
 * Used by the `verify`, `apply` and `sync` commands. The former two are
 * the out-of-band retroactive-application tool SPEC(10).md §2 anticipated
 * ("fetching matching messages and applying actions directly"), operating
 * per the model in §3 "On rule execution context".
 */

import { launch } from '../sync/browser.ts';

const JMAP_URL_HINT = 'jmap/api';

/**
 * The web client's full capability list. The session speaks for many
 * features (mail, rules, contacts, …) and the exact capability that
 * gates a given method isn't always the obvious one — e.g. Rule/get
 * rejects a minimal [core, mail, rules] list. Sending the complete set
 * the app itself negotiates sidesteps the guessing entirely.
 */
const USING = [
  'urn:ietf:params:jmap:vacationresponse',
  'https://www.fastmail.com/dev/contacts',
  'https://www.fastmail.com/dev/filenode',
  'https://www.fastmail.com/dev/customer',
  'https://www.fastmail.com/dev/auth',
  'https://www.fastmail.com/dev/calendars',
  'urn:ietf:params:jmap:contacts',
  'urn:ietf:params:jmap:submission',
  'https://www.fastmail.com/dev/performance',
  'https://www.fastmail.com/dev/blob2',
  'urn:ietf:params:jmap:mail',
  'https://www.fastmail.com/dev/backup',
  'https://www.fastmail.com/dev/rules',
  'urn:ietf:params:jmap:webpush-vapid',
  'https://www.fastmail.com/dev/jscalendarbis',
  'urn:ietf:params:jmap:quota',
  'https://www.fastmail.com/dev/user',
  'https://www.fastmail.com/dev/files',
  'urn:ietf:params:jmap:core',
  'https://www.fastmail.com/dev/mail',
  'https://www.fastmail.com/dev/notes',
  'urn:ietf:params:jmap:blob',
  'urn:ietf:params:jmap:calendars',
  'urn:ietf:params:jmap:principals',
  'https://www.fastmail.com/dev/compress',
];

export interface JmapSessionOptions {
  /** Path to the Fastmail storage state written by `fmrules login`. */
  auth: string;
  /** Override Chromium executable path (passed through to the launcher). */
  chromium?: string;
  /** Show the browser while the session is open. */
  headed?: boolean;
}

export interface JmapMailbox {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
}

/** A Fastmail rule (filter) in the server's Rule/get shape. */
export interface JmapRule {
  id: string;
  name: string;
  isEnabled?: boolean;
  [key: string]: unknown;
}

/** One [name, arguments, clientCallId] tuple. */
export type JmapMethodCall = [string, Record<string, unknown>, string];
export type JmapMethodResponse = [string, Record<string, unknown>, string];

export interface EmailSummary {
  id: string;
  from: { name?: string | null; email: string }[] | null;
  to: { name?: string | null; email: string }[] | null;
  subject: string | null;
  receivedAt: string | null;
  mailboxIds: Record<string, boolean> | null;
  keywords: Record<string, boolean> | null;
  size: number | null;
}

interface Pageish {
  evaluate: <T, A = unknown>(fn: (arg: A) => Promise<T>, arg?: A) => Promise<T>;
  on: (event: string, fn: (req: JmapRequest) => void) => void;
  waitForTimeout: (ms: number) => Promise<void>;
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
}

interface JmapRequest {
  url: () => string;
  method: () => string;
  headers: () => Record<string, string>;
  postDataBuffer: () => Buffer | null;
}

export class JmapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JmapError';
  }
}

export class JmapSession {
  private constructor(
    private readonly browser: { close: () => Promise<void> },
    private readonly page: Pageish,
    private readonly url: string,
    private readonly token: string,
    readonly accountId: string,
  ) {}

  /**
   * Launch a browser with the saved session, load the mail app, and wait
   * for the web client to issue its first JMAP request (from which we
   * capture the endpoint URL and bearer token).
   */
  static async connect(opts: JmapSessionOptions): Promise<JmapSession> {
    const browser = await launch({ chromium: opts.chromium, headed: opts.headed ?? false });
    let session: JmapSession | null = null;
    try {
      const context = await browser.newContext({ storageState: opts.auth });
      const page = (await context.newPage()) as unknown as Pageish;

      let url: string | null = null;
      let token: string | null = null;
      page.on('request', (req) => {
        if (!token && req.url().includes(JMAP_URL_HINT) && req.method() === 'POST') {
          token = req.headers()['authorization'] ?? null;
          url = req.url();
        }
      });

      await page.goto('https://app.fastmail.com/mail', { waitUntil: 'domcontentloaded' });
      const deadline = Date.now() + 30_000;
      while (!token && Date.now() < deadline) await page.waitForTimeout(500);
      if (!token || !url) {
        throw new JmapError(
          'Could not capture a JMAP session token from the Fastmail web client. ' +
            'The storage state may be expired — run `fmrules login` and try again.',
        );
      }

      const accountId = await discoverAccountId(page);
      session = new JmapSession(browser, page, url, token, accountId);
      // Sanity-check the session before handing it back.
      await session.request([['Core/echo', { hello: 'fmrules' }, 'c0']]);
      return session;
    } catch (err) {
      // The session hands ownership of the browser to its caller only on
      // success; on any failure (including a sanity-check throw after
      // the session was constructed) nothing else will close it.
      await browser.close();
      throw err;
    }
  }

  /** Issue one JMAP request; throws with detail if any method errors. */
  async request(methodCalls: JmapMethodCall[]): Promise<JmapMethodResponse[]> {
    const res = (await this.page.evaluate(
      async ({ url, token, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            authorization: token,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
        return JSON.parse(text);
      },
      { url: this.url, token: this.token, body: { using: USING, methodCalls } },
    )) as { methodResponses: JmapMethodResponse[] };

    for (const [name, data] of res.methodResponses) {
      if (name === 'error') {
        throw new JmapError(`JMAP error: ${JSON.stringify(data).slice(0, 300)}`);
      }
    }
    return res.methodResponses;
  }

  /** All mailboxes (folders and labels are unified — SPEC(10).md "On labels"). */
  async getMailboxes(): Promise<JmapMailbox[]> {
    const res = await this.request([['Mailbox/get', { accountId: this.accountId, ids: null }, 'm0']]);
    const list = (res[0]![1] as { list?: JmapMailbox[] }).list;
    return list ?? [];
  }

  /** Query email ids matching a structured filter, paginating to completion. */
  async queryEmailIds(filter: unknown, opts: { limit?: number } = {}): Promise<string[]> {
    const cap = opts.limit ?? Infinity;
    const ids: string[] = [];
    let total = Infinity;
    for (let position = 0; position < Math.min(total, cap); position += 1000) {
      const res = await this.request([
        [
          'Email/query',
          {
            accountId: this.accountId,
            filter,
            sort: [{ property: 'receivedAt', isAscending: false }],
            collapseThreads: false,
            position,
            limit: Math.min(1000, cap - position),
            calculateTotal: true,
          },
          'q0',
        ],
      ]);
      const data = res[0]![1] as { ids: string[]; total?: number };
      total = data.total ?? ids.length + data.ids.length;
      ids.push(...data.ids);
      if (data.ids.length === 0) break;
    }
    return ids;
  }

  /** Fetch full email records in chunks (JMAP caps ids-per-get). */
  async getEmails(ids: string[], properties: string[]): Promise<EmailSummary[]> {
    const out: EmailSummary[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.request([
        ['Email/get', { accountId: this.accountId, ids: chunk, properties }, 'g0'],
      ]);
      const data = res[0]![1] as { list?: EmailSummary[] };
      if (!data.list) throw new JmapError('Email/get returned no list');
      out.push(...data.list);
    }
    return out;
  }

  /**
   * Apply Email/set updates in RFC 8620 PatchObject form (slash-path keys
   * like `mailboxIds/<id>` / `keywords/$seen`), which is how Fastmail's own
   * web client mutates messages. Whole-map `mailboxIds`/`keywords` values
   * REPLACE the entire map — lossy for unmentioned keywords and forbidden
   * for server-managed ones ($maskedemail) — so callers must emit patches.
   */
  async updateEmails(updates: Record<string, Record<string, unknown>>): Promise<void> {
    const entries = Object.entries(updates);
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = Object.fromEntries(entries.slice(i, i + 200));
      const res = await this.request([
        ['Email/set', { accountId: this.accountId, update: chunk }, 's0'],
      ]);
      const data = res[0]![1] as { notUpdated?: Record<string, unknown> };
      if (data.notUpdated && Object.keys(data.notUpdated).length > 0) {
        throw new JmapError(
          `Email/set failed for ${Object.keys(data.notUpdated).length} message(s): ` +
            JSON.stringify(data.notUpdated).slice(0, 300),
        );
      }
    }
  }

  /**
   * Create a mailbox that presents as a label (Fastmail labels are
   * mailboxes with `showAsLabel: true`). Used by the label pre-flight in
   * apply/sync — Fastmail's filter import does NOT create labels that
   * rules reference, so they must exist before rules file mail into them.
   */
  async createLabel(name: string): Promise<JmapMailbox> {
    const res = await this.request([
      ['Mailbox/set', { accountId: this.accountId, create: { k1: { name, showAsLabel: true } } }, 'm0'],
    ]);
    const data = res[0]![1] as {
      created?: Record<string, JmapMailbox>;
      notCreated?: Record<string, unknown>;
    };
    const mailbox = data.created?.['k1'];
    if (!mailbox) {
      throw new JmapError(`Could not create label "${name}": ${JSON.stringify(data.notCreated ?? {}).slice(0, 300)}`);
    }
    return mailbox;
  }

  /** All rules (filters) on the account. */
  async getRules(): Promise<JmapRule[]> {
    const res = await this.request([['Rule/get', { accountId: this.accountId, ids: null }, 'r0']]);
    return (res[0]![1] as { list: JmapRule[] }).list ?? [];
  }

  /** Destroy rules by id. Returns the ids actually destroyed. */
  async destroyRules(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const res = await this.request([['Rule/set', { accountId: this.accountId, destroy: ids }, 'r0']]);
    const data = res[0]![1] as { destroyed?: Record<string, string>; notDestroyed?: Record<string, unknown> };
    if (data.notDestroyed && Object.keys(data.notDestroyed).length > 0) {
      throw new JmapError(
        `Rule/set destroy failed for ${Object.keys(data.notDestroyed).length} rule(s): ` +
          JSON.stringify(data.notDestroyed).slice(0, 300),
      );
    }
    return Object.values(data.destroyed ?? {});
  }

  /**
   * Create rules from mailrules.json entries (the Fastmail import shape).
   * Timestamps are stripped — the server stamps its own on create — and
   * `fileIn` label names are translated to mailbox ids, which the web
   * client's import dialog does client-side before its Rule/set.
   * Returns the created count as confirmed by the server.
   */
  async createRules(
    rules: Record<string, unknown>[],
    mailboxIdsByLabelName: Map<string, string>,
  ): Promise<number> {
    if (rules.length === 0) return 0;
    const create: Record<string, Record<string, unknown>> = {};
    for (const [i, rule] of rules.entries()) {
      const payload: Record<string, unknown> = { ...rule };
      delete payload.created;
      delete payload.updated;
      if (payload.fileIn != null) {
        const id = mailboxIdsByLabelName.get(String(payload.fileIn).toLowerCase());
        if (!id) {
          throw new JmapError(
            `label "${String(payload.fileIn)}" has no mailbox on this account — ` +
              'create it before importing rules that file into it.',
          );
        }
        payload.fileIn = id;
      }
      create[`k${i}`] = payload;
    }
    const res = await this.request([['Rule/set', { accountId: this.accountId, create }, 'r0']]);
    const data = res[0]![1] as { created?: Record<string, unknown>; notCreated?: Record<string, unknown> };
    if (data.notCreated && Object.keys(data.notCreated).length > 0) {
      throw new JmapError(
        `Rule/set create failed for ${Object.keys(data.notCreated).length} rule(s): ` +
          JSON.stringify(data.notCreated).slice(0, 300),
      );
    }
    return Object.keys(data.created ?? {}).length;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/**
 * The account id the web client operates on. Read from the app's saved
 * session in localStorage (primaryAccounts for the mail capability), with a
 * fallback to the account id embedded in the URL the app redirected to.
 */
async function discoverAccountId(page: Pageish): Promise<string> {
  const fromStorage = await page.evaluate<string | null>(async () => {
    try {
      const raw = localStorage.getItem('sessions');
      if (!raw) return null;
      const sessions = JSON.parse(raw) as unknown[];
      for (const s of sessions) {
        const primary = (s as { primaryAccounts?: Record<string, string> }).primaryAccounts;
        if (primary && primary['urn:ietf:params:jmap:mail']) return primary['urn:ietf:params:jmap:mail'];
      }
      return null;
    } catch {
      return null;
    }
  });
  if (fromStorage) return fromStorage;

  const fromUrl = await page.evaluate<string | null>(async () => {
    try {
      const search = (globalThis as { location?: { search: string } }).location?.search ?? '';
      const m = search.match(/[?&]u=([a-z0-9]+)/i);
      return m ? `u${m[1]}` : null;
    } catch {
      return null;
    }
  });
  if (fromUrl) return fromUrl;

  throw new JmapError('Could not determine the JMAP account id.');
}
