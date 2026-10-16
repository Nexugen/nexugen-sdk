// nexugen: a typed client for the Nexugen API (https://nexugen.app/dashboard/docs#api).
//
// No dependencies: plain fetch, Web Streams and Web Crypto, so it runs on Node 18+, Deno,
// Bun and edge runtimes alike.

export const DEFAULT_BASE_URL = 'https://nexugen.app/api/v1';

export interface NexugenOptions {
  /** An API key from Settings > API (nxg_...). Defaults to process.env.NEXUGEN_API_KEY. */
  apiKey?: string;
  /** Defaults to https://nexugen.app/api/v1. */
  baseUrl?: string;
  /** Retries for network errors, 429 and 5xx on safe or idempotent requests. Default 2. */
  maxRetries?: number;
  /** A fetch implementation, for runtimes without a global one or for tests. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Sent as Idempotency-Key. POSTs that start work get one automatically. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Every non-2xx answer. `code` is the API's machine-readable reason (see the docs' Errors section). */
export class NexugenError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, details?: unknown, retryAfter: number | null = null) {
    super(message);
    this.name = 'NexugenError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------------------
// Pilot types
// ---------------------------------------------------------------------------------------

export type PilotChangeStatus = 'proposed' | 'applying' | 'applied' | 'rejected' | 'undone' | 'failed';

export interface PilotChange {
  id: string;
  projectId: string | null;
  kind: string;
  status: PilotChangeStatus;
  summary: string;
  preview: unknown;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
  error: string | null;
}

export interface PilotActivity {
  tool: string;
  label: string;
  state: 'running' | 'done' | 'failed';
  detail?: string;
  changeId?: string;
  editJobId?: string;
  [k: string]: unknown;
}

/** The package version, sent in the user agent. */
export const SDK_VERSION = '0.3.0';

// ---- Pilot's screen ----

export type ScreenDevice = 'desktop' | 'phone';

/** Pilot's cursor, a click, a drawing on the page, a step caption, or a change of hands. */
export type ScreenOverlay =
  | { type: 'cursor'; x: number; y: number; ms?: number; action?: string }
  | { type: 'ripple'; x: number; y: number }
  | { type: 'highlight' | 'circle' | 'arrow' | 'box' | 'underline'; box: { x: number; y: number; w: number; h: number }; label?: string }
  | { type: 'caption' | 'step'; text: string; step?: number; total?: number }
  | { type: 'clear' }
  | { type: 'control'; on: boolean }
  | { type: 'private'; on: boolean; reason: string | null }
  | { type: string; [key: string]: unknown };

export type ScreenEvent =
  /** One picture of the app. `jpeg` is base64: `Buffer.from(ev.jpeg, 'base64')` in Node. */
  | { type: 'frame'; jpeg: string; width: number; height: number }
  /** The page changed: its address, desktop or phone, and its size in page pixels. */
  | { type: 'page'; url?: string; device?: ScreenDevice; viewport?: { width: number; height: number } }
  | { type: 'overlay'; overlay: ScreenOverlay }
  /** The stream ended: the screen closed, the link expired, or it was not available. */
  | { type: 'closed'; reason: string; message?: string };

export type ScreenInput =
  | { kind: 'control'; on: boolean }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; dy: number };

export interface ScreenStatus {
  open: boolean;
  private?: boolean;
  origin?: string;
  mode?: 'app' | 'provider';
  signedIn?: boolean;
}

export interface ScreenEmbed {
  url: string;
  expiresAt: string;
  control: boolean;
  origins: string[];
}

export type PilotEvent =
  | { id: number; type: 'turn.started'; turnId: string; projectId: string | null }
  /** `text` is the whole reply so far, not a fragment. */
  | { id: number; type: 'text'; text: string }
  | { id: number; type: 'activity'; activity: PilotActivity }
  | { id: number; type: 'change'; change: PilotChange }
  | { id: number; type: 'done'; text: string; changeIds?: string[]; editJobIds?: string[]; messageId?: string; usedScreen?: boolean; clipping?: boolean }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'cancelled'; message: string };

export type PilotTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface PilotTurnResult {
  turnId: string;
  projectId: string | null;
  status: PilotTurnStatus;
  reply: string | null;
  error: string | null;
  changes: PilotChange[];
  changeIds: string[];
  editJobIds: string[];
  messageId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AskOptions {
  attachmentIds?: string[];
  /** Account-wide Pilot only: the app the question is about. */
  projectId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Reconnect attempts if the stream drops mid-turn. Default 5. */
  maxReconnects?: number;
}

// ---------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------

export class Nexugen {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  readonly projects: Projects;
  readonly sessions: Sessions;
  readonly webhooks: Webhooks;

  constructor(options: NexugenOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const apiKey = options.apiKey ?? env?.NEXUGEN_API_KEY;
    if (!apiKey) throw new Error('Nexugen: pass apiKey or set NEXUGEN_API_KEY. Create a key under Settings > API.');
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? env?.NEXUGEN_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 2;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error('Nexugen: no fetch available. Pass one in options.fetch.');
    this.fetchImpl = f.bind(globalThis);
    this.projects = new Projects(this);
    this.sessions = new Sessions(this);
    this.webhooks = new Webhooks(this);
  }

  /** Pilot inside one app. */
  pilot(projectId: string): ProjectPilot {
    return new ProjectPilot(this, projectId);
  }

  /** The account-wide Pilot: questions about your account and apps. */
  get accountPilot(): AccountPilot {
    return new AccountPilot(this);
  }

  /** The account behind the key: user, plan, credits and the key's own scopes. */
  me(): Promise<{ user: Record<string, unknown>; credits: { used: number; limit: number; remaining: number }; key: { id: string; name: string; prefix: string; permissions: string[]; rateLimitPerMinute: number } }> {
    return this.request('GET', '/me');
  }

  /** Create a project and start a full build from a prompt. */
  build(input: { name: string; prompt: string; description?: string; framework?: string; projectType?: string; visibility?: string }): Promise<{ project: { id: string; [k: string]: unknown }; build: { queued: boolean; projectId: string; jobId: string | null } }> {
    return this.request('POST', '/builds', { body: input, idempotencyKey: newIdempotencyKey() });
  }

  /** A raw call to any endpoint, for what the typed helpers do not cover yet. */
  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const type = res.headers.get('content-type') || '';
    return (type.includes('json') ? await res.json() : await res.text()) as T;
  }

  /** The Response itself, after retries and error mapping (for streams and downloads). */
  async raw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'user-agent': `nexugen-sdk-js/${SDK_VERSION}`,
      ...opts.headers,
    };
    let body: BodyInit | undefined;
    if (opts.body instanceof FormData) body = opts.body;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const retryable = method === 'GET' || method === 'HEAD' || !!opts.idempotencyKey;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: opts.signal });
      } catch (e) {
        if (opts.signal?.aborted || !retryable || attempt >= this.maxRetries) throw e;
        await sleep(backoff(attempt), opts.signal);
        continue;
      }
      if (res.ok) return res;
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      if (retryable && attempt < this.maxRetries && (res.status === 429 || res.status >= 500)) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(retryAfter ? retryAfter * 1000 : backoff(attempt), opts.signal);
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown; details?: unknown };
      const message = typeof data.error === 'string' ? data.error : `Nexugen API ${res.status}`;
      throw new NexugenError(res.status, typeof data.code === 'string' ? data.code : `http_${res.status}`, message, data.details ?? data, retryAfter);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Pilot
// ---------------------------------------------------------------------------------------

/**
 * A running turn. Iterate it for events as they happen, or await `.final()` for the result.
 * If the connection drops, iteration reconnects with Last-Event-ID and carries on; the turn
 * itself keeps running on Nexugen either way.
 */
export class PilotTurn implements AsyncIterable<PilotEvent> {
  turnId: string | null = null;
  private readonly start: () => Promise<Response>;
  private readonly basePath: string;
  private consumed = false;
  private finalResult: PilotTurnResult | null = null;

  private readonly client: Nexugen;
  private readonly opts: AskOptions;

  constructor(client: Nexugen, basePath: string, start: () => Promise<Response>, opts: AskOptions) {
    this.client = client;
    this.basePath = basePath;
    this.start = start;
    this.opts = opts;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PilotEvent> {
    if (this.consumed) throw new Error('A PilotTurn can be iterated once. Use turns.events(turnId) to read it again.');
    this.consumed = true;
    let res: Response | null = await this.start();
    this.turnId = res.headers.get('x-pilot-turn-id');
    let lastId = 0;
    let reconnects = 0;
    const max = this.opts.maxReconnects ?? 5;
    for (;;) {
      let ended = false;
      try {
        for await (const ev of parseEventStream(res!.body!)) {
          lastId = ev.id || lastId;
          if (ev.type === 'turn.started' && typeof ev.turnId === 'string') this.turnId = ev.turnId;
          yield ev;
          if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') ended = true;
        }
      } catch (e) {
        if (this.opts.signal?.aborted) throw e;
      }
      if (ended) return;
      if (!this.turnId || reconnects >= max) throw new NexugenError(0, 'stream_lost', 'The turn\'s stream closed before the turn finished.');
      reconnects++;
      await sleep(backoff(reconnects - 1), this.opts.signal);
      res = await this.client.raw('GET', `${this.basePath}/${this.turnId}/events`, {
        headers: { 'last-event-id': String(lastId) },
        signal: this.opts.signal,
      });
    }
  }

  /** The reply text as it grows: each value is the whole reply so far. */
  async *text(): AsyncGenerator<string> {
    for await (const ev of this) if (ev.type === 'text') yield ev.text;
  }

  /** Wait for the turn to end and return its result (consumes the stream if nobody else did). */
  async final(): Promise<PilotTurnResult> {
    if (this.finalResult) return this.finalResult;
    if (!this.consumed) for await (const _ of this) { /* drain */ }
    if (!this.turnId) throw new NexugenError(0, 'no_turn', 'The turn never started.');
    this.finalResult = await this.client.request<PilotTurnResult>('GET', `${this.basePath}/${this.turnId}`);
    return this.finalResult;
  }

  /** Stop the turn. Changes it already made are kept and can be undone. */
  async cancel(): Promise<PilotTurnResult> {
    if (!this.turnId) throw new Error('The turn has not started yet: iterate it or await final() first.');
    return this.client.request<PilotTurnResult>('POST', `${this.basePath}/${this.turnId}/cancel`);
  }
}

abstract class PilotBase {
  protected readonly client: Nexugen;
  protected readonly root: string;

  constructor(client: Nexugen, root: string) {
    this.client = client;
    this.root = root;
  }

  /** Ask Pilot something. Returns a turn to iterate or `.final()`. */
  ask(message: string, opts: AskOptions = {}): PilotTurn {
    const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
    const body = this.turnBody(message, opts);
    return new PilotTurn(this.client, `${this.root}/turns`, () =>
      this.client.raw('POST', `${this.root}/turns`, { body, idempotencyKey, signal: opts.signal, headers: { accept: 'text/event-stream' } }), opts);
  }

  /** Ask and wait for the result in one call (no stream). */
  askAndWait(message: string, opts: Omit<AskOptions, 'maxReconnects'> = {}): Promise<PilotTurnResult> {
    return this.client.request('POST', `${this.root}/turns`, {
      query: { wait: true }, body: this.turnBody(message, opts), idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(), signal: opts.signal,
    });
  }

  /** Start a turn and return at once; follow it with turns.get or the pilot.turn.completed webhook. */
  askAsync(message: string, opts: Omit<AskOptions, 'maxReconnects'> = {}): Promise<{ turnId: string; status: PilotTurnStatus; url: string; events: string }> {
    return this.client.request('POST', `${this.root}/turns`, {
      query: { async: true }, body: this.turnBody(message, opts), idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(), signal: opts.signal,
    });
  }

  get turns() {
    const base = `${this.root}/turns`;
    const client = this.client;
    return {
      get: (turnId: string) => client.request<PilotTurnResult>('GET', `${base}/${turnId}`),
      cancel: (turnId: string) => client.request<PilotTurnResult & { cancelled: boolean }>('POST', `${base}/${turnId}/cancel`),
      /** Replay a turn's events after `afterId` and follow it live (kept 5 minutes after it ends). */
      events: async function* (turnId: string, afterId = 0, signal?: AbortSignal): AsyncGenerator<PilotEvent> {
        const res = await client.raw('GET', `${base}/${turnId}/events`, { headers: { 'last-event-id': String(afterId) }, signal });
        yield* parseEventStream(res.body!);
      },
    };
  }

  protected abstract turnBody(message: string, opts: AskOptions): Record<string, unknown>;
}

export class ProjectPilot extends PilotBase {
  readonly projectId: string;

  constructor(client: Nexugen, projectId: string) {
    super(client, `/projects/${encodeURIComponent(projectId)}/pilot`);
    this.projectId = projectId;
  }

  protected turnBody(message: string, opts: AskOptions) {
    return { message, ...(opts.attachmentIds?.length ? { attachmentIds: opts.attachmentIds } : {}) };
  }

  /** What Pilot can do in this app, what needs attention now, recent changes and free tasks left. */
  state(): Promise<{ app: Record<string, unknown>; suggestions: unknown[]; changes: PilotChange[]; freeTasks: unknown; busy: boolean; messages: unknown[] }> {
    return this.client.request('GET', this.root);
  }

  messages(query: { since?: string; until?: string; cursor?: string; limit?: number } = {}): Promise<{ messages: unknown[]; hasOlder: boolean; nextCursor: string | null; changes: PilotChange[] }> {
    return this.client.request('GET', `${this.root}/messages`, { query });
  }

  get changes() {
    const root = this.root;
    const client = this.client;
    const act = (action: 'approve' | 'reject' | 'undo') => (changeId: string, opts: { idempotencyKey?: string } = {}) =>
      client.request<{ change: PilotChange }>('POST', `${root}/changes/${encodeURIComponent(changeId)}/${action}`, { idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey() });
    return {
      list: (query: { status?: PilotChangeStatus; limit?: number } = {}) => client.request<{ changes: PilotChange[] }>('GET', `${root}/changes`, { query }),
      /** Needs a key with the pilot:approve scope. */
      approve: act('approve'),
      reject: act('reject'),
      undo: act('undo'),
    };
  }

  /** Upload a file for the next turn; pass the returned id in attachmentIds. */
  attach(file: Blob, name = 'file'): Promise<{ attachment: { id: string; name: string; mime: string; size: number; url: string | null } }> {
    const form = new FormData();
    form.append('file', file, name);
    return this.client.request('POST', `${this.root}/attachments`, { body: form });
  }

  /** Pilot's live screen in this app: watch it, open it, use it, or embed it on your site. */
  get screen(): PilotScreen {
    return new PilotScreen(this.client, `${this.root}/screen`);
  }

  /**
   * Pilot for your users: the assistant inside this app for the people who use it. It
   * answers their questions and does what they ask with their own access, each change
   * confirmed by them. Off until you turn it on; it spends your credits up to a monthly
   * limit. Turning it on reads the app, adds the chat to it and redeploys. Needs a key
   * that can write to change it.
   */
  get forUsers(): AppAssistant {
    return new AppAssistant(this.client, `/projects/${encodeURIComponent(this.projectId)}/app-assistant`);
  }
}

export interface AppAssistantSettings {
  greeting?: string;
  /** Credits a month it may spend. */
  monthlyCap?: number;
  /** fast: lowest cost. smart: for complex apps. */
  model?: 'fast' | 'smart';
  audience?: 'everyone' | 'signed-in';
  /** May it click and type on the app's pages, not only call its actions. */
  pageActions?: boolean;
  /** Extra sites it may run on beyond the app's own addresses. */
  origins?: string[];
}

export interface AppAssistantState {
  exists: boolean;
  enabled: boolean;
  publicKey?: string;
  /** The tag, for adding it by hand. */
  snippet?: string;
  scan?: { status: 'none' | 'scanning' | 'ready' | 'failed'; error: string | null; at: string | null };
  map?: { summary: string; roles: string[]; pages: number; whoami: boolean; actions: Array<{ name: string; label: string; method: string; path: string; kind: 'read' | 'write'; audience: 'public' | 'user' | 'admin'; on: boolean }> };
  settings?: AppAssistantSettings;
  install?: { file: string | null; installed: boolean };
  origins?: string[];
  usage?: { credits: number; cap: number; questions: number };
  recent?: Array<{ id: string; question: string; answer: string | null; actions: unknown[]; credits: number; createdAt: string; visitor: string }>;
}

export class AppAssistant {
  private readonly client: Nexugen;
  private readonly root: string;
  constructor(client: Nexugen, root: string) {
    this.client = client;
    this.root = root;
  }
  private act(body: Record<string, unknown>) { return this.client.request<AppAssistantState>('POST', this.root, { body }); }
  get(): Promise<AppAssistantState> { return this.client.request('GET', this.root); }
  enable() { return this.act({ action: 'enable' }); }
  disable() { return this.act({ action: 'disable' }); }
  /** Read the app again (it also does this by itself after the app's code changes). */
  rescan() { return this.act({ action: 'scan' }); }
  /** Add the tag to the app again, if it went missing. */
  install() { return this.act({ action: 'install' }); }
  settings(settings: AppAssistantSettings) { return this.act({ action: 'settings', settings }); }
  /** Switch one of the app's actions on or off for the assistant. */
  toggle(name: string, on: boolean) { return this.act({ action: 'toggle', name, on }); }
}

/**
 * Pilot's live screen: the app as Pilot sees and drives it, the same screen the owner sees
 * beside the chat in the dashboard. Needs a key with the pilot:screen scope; using the app
 * on it (`input`, `click`, `type`...) needs pilot:control.
 */
export class PilotScreen {
  private readonly client: Nexugen;
  private readonly root: string;

  constructor(client: Nexugen, root: string) {
    this.client = client;
    this.root = root;
  }

  /** Whether the screen is open, on which site, and whether it is private right now. */
  status(): Promise<ScreenStatus> {
    return this.client.request('GET', `${this.root}/status`);
  }

  /** Open the screen on the app (or switch device) without asking Pilot anything. */
  open(opts: { where?: string; device?: ScreenDevice } = {}): Promise<{ ok: true }> {
    return this.client.request('POST', `${this.root}/open`, { body: opts });
  }

  close(): Promise<{ ok: true }> {
    return this.client.request('POST', `${this.root}/close`);
  }

  /**
   * Watch the screen. Yields frames (about 9 a second while something moves), page changes,
   * Pilot's cursor and drawings, and `closed` when the screen goes away. With `follow`,
   * waits for it to open again instead of ending, until `signal` aborts.
   * No frames are sent while someone is signing in on the screen.
   */
  async *watch(opts: { signal?: AbortSignal; follow?: boolean } = {}): AsyncGenerator<ScreenEvent> {
    for (;;) {
      let closed = false;
      try {
        const res = await this.client.raw('GET', this.root, { signal: opts.signal, headers: { accept: 'text/event-stream' } });
        if (!res.body) throw new NexugenError(502, 'no_stream', 'The screen sent no stream.');
        for await (const ev of parseScreenStream(res.body)) {
          yield ev;
          if (ev.type === 'closed') { closed = true; break; }
        }
      } catch (e) {
        if (opts.signal?.aborted) return;
        if (!opts.follow || (e instanceof NexugenError && e.status < 500 && e.status !== 429)) throw e;
      }
      if (!opts.follow || opts.signal?.aborted) return;
      await sleep(closed ? 2500 : 3000, opts.signal).catch(() => undefined);
      if (opts.signal?.aborted) return;
    }
  }

  /**
   * A link to a page showing the screen, for an <iframe> on your own site. Watch-only unless
   * `control` (needs pilot:control, an hour at most). `origins` limits the sites that may
   * frame it. The link stops at `expiresAt`, or as soon as this key is revoked.
   */
  embed(opts: { ttlSeconds?: number; control?: boolean; origins?: string[] } = {}): Promise<ScreenEmbed> {
    return this.client.request('POST', `${this.root}/embeds`, { body: opts });
  }

  /** Use the app on the screen yourself, as the owner. Needs pilot:control. */
  input(input: ScreenInput): Promise<{ ok: true }> {
    return this.client.request('POST', `${this.root}/input`, { body: input });
  }

  /** Take the screen from Pilot (your input goes to the app until you hand it back). */
  takeControl() { return this.input({ kind: 'control', on: true }); }
  handBack() { return this.input({ kind: 'control', on: false }); }
  /** x and y in page pixels, as in the `viewport` of the last page event. */
  click(x: number, y: number) { return this.input({ kind: 'click', x, y }); }
  type(text: string) { return this.input({ kind: 'type', text }); }
  /** A key such as "Enter", "Tab", "Escape", "ArrowDown". */
  press(key: string) { return this.input({ kind: 'key', key }); }
  scroll(dy: number) { return this.input({ kind: 'scroll', dy }); }
}

export class AccountPilot extends PilotBase {
  constructor(client: Nexugen) {
    super(client, '/pilot');
  }

  protected turnBody(message: string, opts: AskOptions) {
    return { message, ...(opts.projectId ? { projectId: opts.projectId } : {}) };
  }

  get changes() {
    const client = this.client;
    const act = (action: 'approve' | 'reject') => (changeId: string) =>
      client.request<{ change: PilotChange }>('POST', `/pilot/changes/${encodeURIComponent(changeId)}/${action}`, { idempotencyKey: newIdempotencyKey() });
    return { approve: act('approve'), reject: act('reject') };
  }

  /**
   * Connect an app Nexugen does not host, so Pilot can run it: its database, a store
   * platform or a website. Credentials are tested, then saved encrypted; they never come
   * back. Use the returned projectId with `nx.pilot(projectId)`. Needs a key that can write.
   */
  connectApp(input: ConnectAppInput): Promise<{ ok: boolean; projectId: string; name?: string; message?: string }> {
    return this.client.request('POST', '/pilot/apps', { body: { ...input, action: 'connect' } });
  }

  /** Check a connection without saving anything. */
  testApp(input: ConnectAppInput): Promise<{ ok: boolean; message: string; name: string | null }> {
    return this.client.request('POST', '/pilot/apps', { body: { ...input, action: 'test' } });
  }
}

export type ConnectAppInput = { name?: string } & (
  | { kind: 'database'; connectionString: string; siteUrl?: string; adminUrl?: string }
  | { kind: 'platform'; provider: 'woocommerce'; siteUrl: string; consumerKey: string; consumerSecret: string }
  | { kind: 'platform'; provider: 'shopify'; shopDomain: string; accessToken: string }
  | { kind: 'platform'; provider: 'wordpress'; siteUrl: string; username: string; appPassword: string }
  | { kind: 'platform'; provider: 'stripe'; apiKey: string; siteUrl?: string }
  | { kind: 'website'; siteUrl: string; adminUrl?: string; loginEmail?: string; loginPassword?: string }
);

// ---------------------------------------------------------------------------------------
// Projects and sessions (thin, typed wrappers; anything else via client.request)
// ---------------------------------------------------------------------------------------

export class Projects {
  private readonly client: Nexugen;
  constructor(client: Nexugen) {
    this.client = client;
  }
  list(query: { page?: number; limit?: number; status?: string; search?: string } = {}) {
    return this.client.request<{ projects: Array<{ id: string; name: string; [k: string]: unknown }>; pagination: { page: number; limit: number; total: number; totalPages: number } }>('GET', '/projects', { query });
  }
  get(id: string, opts: { includeContent?: boolean } = {}) {
    return this.client.request<{ project: { id: string; [k: string]: unknown } }>('GET', `/projects/${encodeURIComponent(id)}`, { query: { includeContent: opts.includeContent } });
  }
  /** Ask the agent to change the project; runs in the background (follow it via sessions). */
  edit(id: string, instruction: string, opts: { asProposal?: boolean; pushToGitHub?: boolean; runBuildValidation?: boolean; quoteLarge?: boolean } = {}) {
    return this.client.request<{ queued: boolean; projectId: string; editJobId: string | null; sessionId: string | null; needsConfirmation?: boolean; quote?: unknown }>(
      'POST', `/projects/${encodeURIComponent(id)}/edits`, { body: { instruction, ...opts }, idempotencyKey: newIdempotencyKey() });
  }
  rebuild(id: string, prompt: string, opts: { mode?: 'full' | 'incremental' | 'debug' } = {}) {
    return this.client.request<{ queued: boolean; projectId: string; jobId: string | null }>('POST', `/projects/${encodeURIComponent(id)}/build`, { body: { prompt, ...opts }, idempotencyKey: newIdempotencyKey() });
  }
  deploy(id: string) {
    return this.client.request<Record<string, unknown>>('POST', `/projects/${encodeURIComponent(id)}/self-host-deploy`);
  }
}

export class Sessions {
  private readonly client: Nexugen;
  constructor(client: Nexugen) {
    this.client = client;
  }
  list(query: { projectId?: string; active?: boolean; limit?: number } = {}) {
    return this.client.request<{ sessions: Array<{ id: string; status: string; [k: string]: unknown }> }>('GET', '/sessions', { query: { ...query, active: query.active ? 1 : undefined } });
  }
  get(id: string) {
    return this.client.request<{ session: { id: string; status: string; [k: string]: unknown } }>('GET', `/sessions/${encodeURIComponent(id)}`);
  }
  events(id: string, query: { after?: number; limit?: number } = {}) {
    return this.client.request<{ events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }> }>('GET', `/sessions/${encodeURIComponent(id)}/events`, { query });
  }
  /** Poll a run until it ends (DONE, FAILED or CANCELLED). */
  async wait(id: string, opts: { intervalMs?: number; signal?: AbortSignal } = {}) {
    for (;;) {
      const { session } = await this.get(id);
      if (['DONE', 'FAILED', 'CANCELLED'].includes(session.status)) return session;
      await sleep(opts.intervalMs ?? 5000, opts.signal);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------

export interface WebhookDelivery<T = Record<string, unknown>> {
  event: string;
  createdAt: string;
  data: T;
}

export class Webhooks {
  private readonly client: Nexugen;
  constructor(client: Nexugen) {
    this.client = client;
  }

  list() { return this.client.request('GET', '/webhooks'); }
  create(input: { url: string; events?: string[]; description?: string }) { return this.client.request<{ endpoint: { id: string; url: string; events: string[]; secret: string } }>('POST', '/webhooks', { body: input }); }
  remove(id: string) { return this.client.request('DELETE', '/webhooks', { query: { id } }); }

  /** See verifyWebhook. */
  verify = verifyWebhook;
}

/**
 * Check a delivery came from Nexugen and is fresh, then parse it. Pass the raw body exactly as
 * received (before any JSON parsing). Throws when the signature or timestamp is wrong.
 */
export async function verifyWebhook<T = Record<string, unknown>>(input: {
  secret: string;
  body: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  /** How old a delivery may be. Default 5 minutes. */
  toleranceMs?: number;
}): Promise<WebhookDelivery<T>> {
  const header = (name: string): string => {
    if (input.headers instanceof Headers) return input.headers.get(name) ?? '';
    const v = input.headers[name] ?? input.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] ?? '' : v ?? '';
  };
  const timestamp = header('x-nexugen-timestamp');
  const signature = header('x-nexugen-signature').replace(/^sha256=/, '');
  if (!timestamp || !signature) throw new Error('Not a Nexugen webhook: signature headers missing.');
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > (input.toleranceMs ?? 5 * 60_000)) throw new Error('Webhook timestamp is too old or invalid.');
  const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.body}`);
  if (!timingSafeEqual(expected, signature)) throw new Error('Webhook signature does not match.');
  return JSON.parse(input.body) as WebhookDelivery<T>;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Parse a server-sent event stream of Pilot events (`id:` + JSON `data:`). */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<PilotEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        let id = 0;
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || 0;
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        try {
          const parsed = JSON.parse(data.join('\n'));
          if (parsed && typeof parsed.type === 'string') yield { ...parsed, id } as PilotEvent;
        } catch { /* not an event */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse the screen's server-sent events (`event:` names with JSON `data:`). */
export async function* parseScreenStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ScreenEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        let d: Record<string, unknown>;
        try { d = JSON.parse(data.join('\n')); } catch { continue; }
        if (event === 'frame' && typeof d.jpeg === 'string') yield { type: 'frame', jpeg: d.jpeg, width: Number(d.w) || 0, height: Number(d.h) || 0 };
        else if (event === 'page') yield { type: 'page', ...(d as object) } as ScreenEvent;
        else if (event === 'overlay') yield { type: 'overlay', overlay: d as ScreenOverlay };
        else if (event === 'closed') yield { type: 'closed', reason: String(d.reason ?? 'closed'), ...(typeof d.message === 'string' ? { message: d.message } : {}) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

export default Nexugen;
