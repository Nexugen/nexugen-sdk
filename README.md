# Nexugen SDK and Pilot API: how to use it

The `nexugen` package lets your own code do what you do in the Nexugen dashboard:
- build and edit apps, and deploy them;
- above all, drive **Pilot**, the assistant that runs an app with you.

It's a small TypeScript/JavaScript package with no dependencies. It runs on Node 18+, Deno, Bun and edge runtimes (Vercel, Cloudflare Workers). Under it is the plain HTTP API at `https://nexugen.app/api/v1`, which any language can call directly (see "Without the SDK" below).

Source: https://github.com/Nexugen/nexugen-sdk. Full endpoint reference: https://nexugen.app/dashboard/docs#api

---

## 1. Get an API key

1. Open **Settings > API** in the dashboard (https://nexugen.app/dashboard/settings/api).
2. Name the key, then tick what it may do:
   - **Allow writes**: start builds and edits, deploy, change settings.
   - **Ask Pilot**: run Pilot turns in your apps. They use credits, as in the dashboard; free monthly Pilot tasks count first.
   - **Approve Pilot's changes**: approve, reject or undo changes Pilot proposes.
   - **Watch Pilot's screen**: stream Pilot's live screen, and make links to embed it on your own site.
   - **Use the app on Pilot's screen**: click and type in the app on that screen, as you. Includes watching.
3. Copy the key (`nxg_...`). It is shown **once**. If you lose it, revoke it and make another.

Good practice: give the script that *asks* Pilot one key, and keep **Approve** on a separate key held by a person or a trusted service. That way a script can never approve its own changes.

Keep keys out of source code. Put them in an environment variable:

```bash
export NEXUGEN_API_KEY=nxg_...
```

---

## 2. Install

```bash
npm install nexugen
```

```ts
import { Nexugen } from 'nexugen';

const nx = new Nexugen();                       // reads NEXUGEN_API_KEY
// or: new Nexugen({ apiKey: 'nxg_...' })

const me = await nx.me();
console.log(me.user.email, me.credits.remaining, me.key.permissions);
```

Your app's **project id** is in the dashboard URL: `nexugen.app/dashboard/projects/<projectId>`.

---

## 3. Ask Pilot

### Stream a turn (see it work live)

```ts
const pilot = nx.pilot('PROJECT_ID');

for await (const ev of pilot.ask('How many orders are waiting to ship?')) {
  switch (ev.type) {
    case 'text':     console.log(ev.text); break;                       // the whole reply so far
    case 'activity': console.log('•', ev.activity.label, ev.activity.state); break;
    case 'change':   console.log('change:', ev.change.status, ev.change.summary); break;
    case 'done':     console.log('Final:', ev.text); break;
    case 'error':    console.error('Pilot error:', ev.message); break;
  }
}
```

The events, in order:

| Event | What it means |
|---|---|
| `turn.started` | The turn exists. Carries `turnId`. |
| `text` | Pilot's reply so far. Each one replaces the last; it is not a fragment to append. |
| `activity` | Pilot started or finished using a tool (reading records, opening the app, etc.). |
| `change` | Pilot made a change, or proposed one that waits for approval (`status: "proposed"`). |
| `done` | Finished. Final `text`, plus `changeIds`, `editJobIds`, `messageId`. |
| `error` / `cancelled` | Stopped with an error, or because someone cancelled it. |

If your connection drops mid-turn, the SDK reconnects by itself and carries on from the last event it saw. The turn keeps running on Nexugen either way.

### Just get the answer

```ts
const result = await pilot.askAndWait('How many members are behind this cycle?');
console.log(result.reply);     // "4 members are behind: ..."
console.log(result.changes);   // any changes it made or proposed
```

### Start it now, collect it later

```ts
const { turnId } = await pilot.askAsync('Tidy up product names that are all caps');
// ...later, or from another process:
const result = await pilot.turns.get(turnId);   // status: running | completed | failed | cancelled
```

Or skip polling and use the `pilot.turn.completed` webhook (section 7).

### Stop a turn

```ts
const turn = pilot.ask('Go through every order from last month and ...');
// ...
await turn.cancel();            // or: pilot.turns.cancel(turnId)
```

Anything it already changed stays, and can be undone.

### Give Pilot a file

```ts
import { readFile } from 'node:fs/promises';
const file = new Blob([await readFile('price-list.csv')], { type: 'text/csv' });
const att = await pilot.attach(file, 'price-list.csv');
await pilot.askAndWait('Update prices from the attached list', { attachmentIds: [att.attachment.id] });
```

Pilot takes images, spreadsheets (CSV, Excel), PDFs and text files, up to 20 MB each.

### Pilot for your whole account (not one app)

```ts
const answer = await nx.accountPilot.askAndWait('Which of my apps had the most visitors this week?');
```

---

## 4. Approving, rejecting and undoing changes

Some changes wait for the owner, exactly as in the dashboard: bulk changes, deletions, and anything on an outside system. **There is no API flag that skips approval.** A waiting change arrives as a `change` event with `status: "proposed"` and as a `pilot.change.pending` webhook.

```ts
const approver = new Nexugen({ apiKey: process.env.NEXUGEN_APPROVE_KEY }); // key with "Approve Pilot's changes"
const p = approver.pilot('PROJECT_ID');

const { changes } = await p.changes.list({ status: 'proposed' });
for (const c of changes) console.log(c.id, c.summary, c.preview);

await p.changes.approve(changes[0].id);
await p.changes.reject('chg_...');
await p.changes.undo('chg_...');      // a change that was already made
```

---

## 5. Pilot's screen: watch it, or put it on your site

Pilot works in your app on a live screen, the same one you see beside the chat in the dashboard. A key with **Watch Pilot's screen** can stream it, or make a link to show it in an `<iframe>` on your own site.

### Embed it (an iframe)

Make the link on your server when the page loads, then drop it in:

```ts
const link = await nx.pilot('PROJECT_ID').screen.embed({
  ttlSeconds: 3600,                     // default 1 hour, max 24 hours
  origins: ['https://example.com'],     // sites allowed to frame it; leave out for any
});
// link.url -> https://nexugen.app/embed/pilot-screen/eyJ...
```

```html
<iframe src="https://nexugen.app/embed/pilot-screen/eyJ..." width="960" height="640"
        style="border:0" allow="fullscreen"></iframe>
```

It shows the app with Pilot's cursor, clicks, highlights and step captions, on desktop or inside a phone frame, and waits quietly while Pilot is not on the screen. Add `?chrome=0` to the URL to hide the address bar, `?theme=light` for a light background.

- Watch-only by default. `control: true` lets viewers click and type in the app **as you**; it needs a key with **Use the app on Pilot's screen** and lasts an hour at most.
- Anyone with the link can watch until it expires, so don't store links or put them in public pages. Revoking the key turns off every link it made, at once.
- Passwords and keys on the page are painted over in every frame. While someone is signing in on the screen, nothing is shown at all.

### Watch it from code

```ts
const screen = nx.pilot('PROJECT_ID').screen;

await screen.open({ device: 'phone' });         // or let Pilot open it when it needs to
console.log(await screen.status());              // { open: true, private: false, origin: ... }

for await (const ev of screen.watch({ follow: true, signal })) {
  if (ev.type === 'frame') await writeFile('latest.jpg', Buffer.from(ev.jpeg, 'base64'));
  if (ev.type === 'page') console.log('now on', ev.url, ev.device);
  if (ev.type === 'overlay' && ev.overlay.type === 'caption') console.log('Pilot:', ev.overlay.text);
}
```

`watch()` yields `frame` (a JPEG, about 9 a second while something moves), `page` (address, device, size), `overlay` (Pilot's cursor, clicks, drawings, captions, and who has control) and `closed`. With `follow: true` it waits for the screen to open again instead of ending.

### Use the app on it

With **Use the app on Pilot's screen**:

```ts
await screen.takeControl();
await screen.click(640, 220);          // page pixels, as in the last page event's viewport
await screen.type('hello@example.com');
await screen.press('Enter');
await screen.handBack();               // Pilot takes over again when asked something
```

---

## 6. Other things you can do

```ts
// History and what needs attention
const state = await pilot.state();                 // suggestions, recent changes, free tasks left
const page = await pilot.messages({ limit: 50 });  // conversation history

// Apps
const { projects } = await nx.projects.list();
const { project, build } = await nx.build({ name: 'Sunrise Bakery', prompt: 'An online bakery with ordering and delivery slots...' });
await nx.projects.edit('PROJECT_ID', 'Add a dark mode toggle to the header');
await nx.projects.deploy('PROJECT_ID');

// Follow a build or edit to the end
const { sessions } = await nx.sessions.list({ projectId: 'PROJECT_ID', active: true });
const finished = await nx.sessions.wait(sessions[0].id);

// Anything else in the API reference
const domains = await nx.request('GET', '/projects/PROJECT_ID/domains');
```

---

## 7. Webhooks (Nexugen calls you)

Register a URL under **Settings > API and webhooks**, or from code:

```ts
const { endpoint } = await nx.webhooks.create({
  url: 'https://example.com/nexugen-hook',
  events: ['pilot.change.pending', 'pilot.turn.completed'],   // empty = everything
});
console.log(endpoint.secret);   // shown once; store it as NEXUGEN_WEBHOOK_SECRET
```

Pilot events:

| Event | When |
|---|---|
| `pilot.turn.completed` | Pilot finished a turn (reply, changes, `viaApi`) |
| `pilot.turn.failed` | A turn stopped with an error |
| `pilot.change.pending` | A change is waiting for approval |
| `pilot.change.applied` | A change was made (directly or after approval) |
| `pilot.change.undone` | A change was undone |

Also: `project.created`, `build.started`, `build.failed`, `edit.completed`, `deploy.succeeded`.

Verify every delivery before trusting it. Pass the **raw** body, not parsed JSON:

```ts
import express from 'express';
import { verifyWebhook } from 'nexugen';

const app = express();
app.post('/nexugen-hook', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const delivery = await verifyWebhook({ secret: process.env.NEXUGEN_WEBHOOK_SECRET!, body: req.body, headers: req.headers as any });
    if (delivery.event === 'pilot.change.pending') {
      // e.g. post to Slack: "Pilot wants to: <summary>. Approve?"
    }
    res.sendStatus(200);
  } catch {
    res.sendStatus(401);
  }
});
```

Deliveries are signed (`x-nexugen-signature: sha256=...` over `timestamp.body`). Anything older than 5 minutes is rejected, so a captured request can't be replayed.

---

## 8. Errors and limits

Every failure throws a `NexugenError` with `status`, `code` and a readable `message`:

```ts
import { NexugenError } from 'nexugen';
try {
  await pilot.askAndWait('...');
} catch (e) {
  if (e instanceof NexugenError) {
    if (e.code === 'credits_exhausted') { /* top up */ }
    if (e.code === 'turn_in_progress') { /* Pilot is still on your last message */ }
    if (e.code === 'insufficient_permission') { /* the key lacks a scope */ }
  }
}
```

| Code | Meaning |
|---|---|
| `insufficient_permission` | The key lacks the scope (write, Ask Pilot, Approve, or one of the screen scopes). |
| `credits_exhausted` | No credits or free Pilot tasks left. |
| `turn_in_progress` | One Pilot turn at a time per person per app; the last one is still running. |
| `rate_limited` | Over the key's per-minute limit (100 by default). The SDK retries these. |
| `not_found` | No such project, turn or change, or the key's owner can't see it. |
| `turn_expired` | A turn's live event replay is kept 5 minutes after it ends; use `turns.get` instead. |

The SDK retries network errors, 429s and 5xx on reads and on any request that carries an idempotency key, which it adds automatically to everything that starts work. A retried "ask" joins the same turn instead of starting a second one.

A key acts as its owner. Project access, team sharing, credits and plan limits apply exactly as in the dashboard. Keys pasted into a message to Pilot are hidden before Pilot sees them, and secrets never come back in a reply.

---

## 9. Without the SDK (any language, curl)

```bash
# Stream a turn (server-sent events)
curl -N -X POST https://nexugen.app/api/v1/projects/$PROJECT_ID/pilot/turns \
  -H "Authorization: Bearer $NEXUGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "message": "How many orders are waiting to ship?" }'

# One JSON answer instead of a stream
curl -X POST "https://nexugen.app/api/v1/projects/$PROJECT_ID/pilot/turns?wait=true" \
  -H "Authorization: Bearer $NEXUGEN_API_KEY" -H "Content-Type: application/json" \
  -d '{ "message": "How many members are behind?" }'

# Resume a dropped stream from the last event id you saw
curl -N https://nexugen.app/api/v1/projects/$PROJECT_ID/pilot/turns/$TURN_ID/events \
  -H "Authorization: Bearer $NEXUGEN_API_KEY" -H "Last-Event-ID: 7"

# Approve a change (key with "Approve Pilot's changes")
curl -X POST https://nexugen.app/api/v1/projects/$PROJECT_ID/pilot/changes/$CHANGE_ID/approve \
  -H "Authorization: Bearer $NEXUGEN_APPROVE_KEY"
```

All Pilot endpoints:

| Method | Path | Scope |
|---|---|---|
| POST | `/projects/:id/pilot/turns` (`?wait=true`, `?async=true`) | Ask Pilot |
| GET | `/projects/:id/pilot/turns/:turnId` | read |
| GET | `/projects/:id/pilot/turns/:turnId/events` | read |
| POST | `/projects/:id/pilot/turns/:turnId/cancel` | Ask Pilot |
| GET | `/projects/:id/pilot` | read |
| GET | `/projects/:id/pilot/messages` | read |
| GET | `/projects/:id/pilot/changes` | read |
| POST | `/projects/:id/pilot/changes/:changeId/approve` (or `reject`, `undo`) | Approve |
| POST | `/projects/:id/pilot/attachments` | Ask Pilot |
| GET | `/projects/:id/pilot/clips/:messageId` | read |
| POST | `/pilot/turns`, GET `/pilot/turns/:turnId`, `.../events`, POST `.../cancel` | account-wide Pilot |
| POST | `/pilot/changes/:changeId/approve` (or `reject`) | Approve |
| GET | `/projects/:id/pilot/screen` (server-sent events) | Watch screen |
| GET | `/projects/:id/pilot/screen/status` | Watch screen |
| POST | `/projects/:id/pilot/screen/open`, `/close` | Watch screen |
| POST | `/projects/:id/pilot/screen/embeds` | Watch screen (Use the app, for `control`) |
| POST | `/projects/:id/pilot/screen/input` | Use the app on the screen |

---

## 10. Example: a nightly "what needs me" report

```ts
import { Nexugen } from 'nexugen';

const nx = new Nexugen();
const { projects } = await nx.projects.list({ limit: 50 });

for (const p of projects) {
  const r = await nx.pilot(p.id).askAndWait(
    'In two sentences: what needs my attention in this app today? Do not change anything.',
  ).catch((e) => ({ reply: `(skipped: ${e.message})` }));
  console.log(`## ${p.name}\n${r.reply}\n`);
}
```

Each of those is a Pilot turn and uses credits (free monthly tasks first).
