import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Nexugen, NexugenError, verifyWebhook } from '../src/index.ts';

const sse = (events: Array<[number, object]>, end = true) => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const [id, data] of events) c.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`));
      if (end) c.close(); else setTimeout(() => c.error(new Error('socket hang up')), 20);
    },
  });
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('streams a turn, then fetches the final result', async () => {
  const calls: string[] = [];
  const nx = new Nexugen({
    apiKey: 'nxg_test', baseUrl: 'https://x.test/api/v1',
    fetch: async (url, init) => {
      const u = String(url);
      calls.push(`${init?.method} ${u.replace('https://x.test/api/v1', '')} ${(init?.headers as Record<string, string>)['idempotency-key'] ? 'idem' : ''}`.trim());
      if (u.endsWith('/pilot/turns')) {
        return new Response(sse([[1, { type: 'turn.started', turnId: 't1' }], [2, { type: 'text', text: 'Hi' }], [3, { type: 'done', text: 'Hi there' }]]), { headers: { 'content-type': 'text/event-stream', 'x-pilot-turn-id': 't1' } });
      }
      return json({ turnId: 't1', status: 'completed', reply: 'Hi there', changes: [], changeIds: [], editJobIds: [], messageId: 'm', projectId: 'p1', error: null, startedAt: null, endedAt: null });
    },
  });
  const turn = nx.pilot('p1').ask('hello');
  const types: string[] = [];
  for await (const ev of turn) types.push(`${ev.id}:${ev.type}`);
  assert.deepEqual(types, ['1:turn.started', '2:text', '3:done']);
  const result = await turn.final();
  assert.equal(result.reply, 'Hi there');
  assert.deepEqual(calls, ['POST /projects/p1/pilot/turns idem', 'GET /projects/p1/pilot/turns/t1']);
});

test('resumes with Last-Event-ID after the stream drops', async () => {
  let resumedFrom = '';
  const nx = new Nexugen({
    apiKey: 'nxg_test', baseUrl: 'https://x.test/api/v1',
    fetch: async (url, init) => {
      if (String(url).endsWith('/events')) {
        resumedFrom = (init?.headers as Record<string, string>)['last-event-id'];
        return new Response(sse([[3, { type: 'done', text: 'ok' }]]), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(sse([[1, { type: 'turn.started', turnId: 't2' }], [2, { type: 'text', text: 'o' }]], false), { headers: { 'content-type': 'text/event-stream', 'x-pilot-turn-id': 't2' } });
    },
  });
  const seen: number[] = [];
  for await (const ev of nx.pilot('p1').ask('x')) seen.push(ev.id);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(resumedFrom, '2');
});

test('maps errors to NexugenError with the API code', async () => {
  const nx = new Nexugen({ apiKey: 'nxg_test', maxRetries: 0, fetch: async () => json({ error: 'Needs a key that may approve.', code: 'insufficient_permission' }, 403) });
  await assert.rejects(nx.pilot('p1').changes.approve('c1'), (e: unknown) => e instanceof NexugenError && e.code === 'insufficient_permission' && e.status === 403);
});

test('retries 429 on idempotent requests', async () => {
  let n = 0;
  const nx = new Nexugen({ apiKey: 'nxg_test', fetch: async () => (++n === 1 ? json({ error: 'slow down', code: 'rate_limited' }, 429, { 'retry-after': '0' }) : json({ changes: [] })) });
  await nx.pilot('p1').changes.list();
  assert.equal(n, 2);
});

test('verifies webhook signatures the way the platform signs them', async () => {
  const secret = 'whsec_abc';
  const body = JSON.stringify({ event: 'pilot.turn.completed', createdAt: 'now', data: { turnId: 't' } });
  const ts = String(Date.now());
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const ok = await verifyWebhook({ secret, body, headers: { 'x-nexugen-timestamp': ts, 'x-nexugen-signature': `sha256=${sig}` } });
  assert.equal(ok.event, 'pilot.turn.completed');
  await assert.rejects(verifyWebhook({ secret, body: body + ' ', headers: { 'x-nexugen-timestamp': ts, 'x-nexugen-signature': `sha256=${sig}` } }));
  await assert.rejects(verifyWebhook({ secret, body, headers: { 'x-nexugen-timestamp': String(Date.now() - 600_000), 'x-nexugen-signature': `sha256=${sig}` } }));
});

const named = (events: Array<[string, object]>) => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const [event, data] of events) c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      c.close();
    },
  });
};

test('watches the screen: frames, pages, overlays, then closed', async () => {
  const nx = new Nexugen({
    apiKey: 'nxg_test', baseUrl: 'https://x.test/api/v1',
    fetch: async (url) => {
      assert.equal(String(url), 'https://x.test/api/v1/projects/p1/pilot/screen');
      return new Response(named([
        ['page', { url: 'https://shop.test/orders', device: 'phone', viewport: { width: 390, height: 844 } }],
        ['frame', { jpeg: 'QUJD', w: 390, h: 844 }],
        ['overlay', { type: 'cursor', x: 10, y: 20, ms: 400 }],
        ['closed', { reason: 'no-screen' }],
        ['frame', { jpeg: 'AFTER', w: 1, h: 1 }],
      ]), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const seen = [];
  for await (const ev of nx.pilot('p1').screen.watch()) seen.push(ev);
  assert.deepEqual(seen.map((e) => e.type), ['page', 'frame', 'overlay', 'closed']);
  assert.deepEqual(seen[1], { type: 'frame', jpeg: 'QUJD', width: 390, height: 844 });
  assert.equal((seen[0] as { device: string }).device, 'phone');
  assert.equal((seen[2] as { overlay: { type: string } }).overlay.type, 'cursor');
});

test('follow waits for the screen to come back, until aborted', async () => {
  let connects = 0;
  const ac = new AbortController();
  const nx = new Nexugen({
    apiKey: 'nxg_test', baseUrl: 'https://x.test/api/v1',
    fetch: async () => {
      connects++;
      return new Response(named(connects === 1 ? [['closed', { reason: 'no-screen' }]] : [['frame', { jpeg: 'Wg==', w: 2, h: 2 }]]), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const types: string[] = [];
  for await (const ev of nx.pilot('p1').screen.watch({ follow: true, signal: ac.signal })) {
    types.push(ev.type);
    if (ev.type === 'frame') ac.abort();
  }
  assert.deepEqual(types, ['closed', 'frame']);
  assert.equal(connects, 2);
});

test('makes embed links and sends input, mapping a missing scope to NexugenError', async () => {
  const bodies: Array<[string, unknown]> = [];
  const nx = new Nexugen({
    apiKey: 'nxg_test', baseUrl: 'https://x.test/api/v1', maxRetries: 0,
    fetch: async (url, init) => {
      const path = String(url).replace('https://x.test/api/v1', '');
      bodies.push([path, init?.body ? JSON.parse(String(init.body)) : undefined]);
      if (path.endsWith('/embeds')) return json({ url: 'https://nexugen.app/embed/pilot-screen/abc.def', expiresAt: '2026-10-16T13:00:00.000Z', control: false, origins: ['https://example.com'] }, 201);
      return json({ error: 'needs a key that may use the app', code: 'insufficient_permission' }, 403);
    },
  });
  const link = await nx.pilot('p1').screen.embed({ ttlSeconds: 600, origins: ['https://example.com'] });
  assert.match(link.url, /\/embed\/pilot-screen\//);
  await assert.rejects(nx.pilot('p1').screen.click(100, 200), (e: unknown) => e instanceof NexugenError && e.code === 'insufficient_permission');
  assert.deepEqual(bodies, [
    ['/projects/p1/pilot/screen/embeds', { ttlSeconds: 600, origins: ['https://example.com'] }],
    ['/projects/p1/pilot/screen/input', { kind: 'click', x: 100, y: 200 }],
  ]);
});
