# Kwegereza API — Backend

Node.js + TypeScript + Express + Prisma. This is the real, tested authoritative
backend: registration, leader/admin approval, RBAC, and account blocking with
instant session invalidation.

## Run it

```bash
npm install
cp .env.example .env
npx prisma migrate dev --name init
npx prisma generate
npx tsx prisma/seed.ts     # creates the demo Admin + Leader accounts below
npm run dev                # http://localhost:4000
```

Demo accounts created by the seed script:

| Role   | Email                  | Password       |
|--------|-------------------------|----------------|
| Admin  | admin@kwegereza.rw      | Admin@12345    |
| Leader | leader@kwegereza.rw     | Leader@12345   |

## Dev database

Uses SQLite (`prisma/dev.db`) for zero-setup local development — no Postgres
install required to try this out. Switching to Postgres for production is a
one-line change in `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")
}
```
(Role/status also become real Postgres enums instead of validated strings —
see the comment at the top of schema.prisma.)

## What's actually implemented and tested

- `POST /api/auth/register` — creates a STUDENT with status `PENDING`. Never
  auto-activates an account.
- `POST /api/auth/login` — rejects any non-ACTIVE status with the matching
  Kinyarwanda message (pending/blocked/suspended/rejected/inactive).
- `GET  /api/auth/me` — re-validates the user against the database on every
  call (not just the JWT signature), so a blocked user is rejected immediately.
- `POST /api/auth/logout`
- `GET  /api/students` — paginated, searchable, filterable listing (admin/leader
  with `student.view`).
- `GET  /api/students/pending` — "Abanyeshuri Bategereje Kwemezwa" queue.
- `POST /api/students/:id/approve` / `/reject` / `/block` / `/unblock` — each
  writes an AuditLog row, and block/reject bump `tokenVersion` so any existing
  session dies on its very next request.

RBAC is enforced only in the backend (`requireRole`, `requirePermission`
middleware) — the frontend hiding a button is a UX nicety, never the actual
gate.

## Verified test run (see chat transcript for the full 13-step log)

1. Register → PENDING → login rejected (403) ✅
2. Leader lists pending queue, approves → student can log in ✅
3. Leader without `student.block` tries to block → 403 ✅
4. Admin (has `student.block`) blocks the student ✅
5. Same student's **already-issued token** immediately rejected (401) ✅
6. Fresh login attempt while blocked also rejected (403) ✅

## Not yet built (future phases)

Realtime chat, live audio classrooms (WebRTC), push notifications, analytics,
Ifaida/Dars content management, S3 media storage, Redis/BullMQ. Each is its
own substantial phase — see the roadmap in the project chat.

## Phase 7/8 — Realtime chat (added)

Real Socket.IO layer mounted on the same HTTP server as Express. Auth happens
at the socket handshake (same DB re-check as HTTP: status + tokenVersion), so
a blocked user cannot open a socket at all.

**The anti-duplicate-message design**, directly from the spec's "no duplicate
chat messages" requirement:
- Every message carries a client-generated `clientMessageId`.
- `Message` has a DB-level `@@unique([senderId, clientMessageId])` constraint.
- If the same id is submitted twice, Prisma throws a unique-violation (P2002)
  which the server catches, fetches the ORIGINAL row, and returns it — no
  second row is ever created, and the room is only broadcast to on the branch
  that actually inserted a new row.

New endpoints:
- `POST /api/chat/start` — find-or-create a 1:1 conversation
- `GET  /api/chat/conversations` — my conversations + last message preview
- `GET  /api/chat/conversations/:id/messages` — history (participant-only)
- `POST /api/chat/conversations/:id/read` — mark read
- `GET  /api/users/search?q=` — find someone to start a chat with

Socket events: `conversation:join`, `message:send` (ack-based, idempotent),
`message:new`, `typing:start`/`typing:stop`/`typing:update`,
`presence:update`.

### Run the live chat correctness test

With the server running:
```bash
npx tsx scripts/test-chat.ts
```
This is the spec's "CHAT TEST" made real: two independent socket connections
(Browser A / Browser B), one message sent, a deliberate duplicate resend, a
disconnect+reconnect, and a fresh history fetch — asserting the count is
exactly 1 at every single step. Currently: **15/15 checks passing.**

## Phase 10 — Live audio classrooms (added)

Real signaling layer for host/participant audio classrooms, star-topology
(host is the hub — SFU-ready: swapping the relay for an SFU later doesn't
change any client-facing event name).

New DB models: `LiveClass` (status SCHEDULED/LIVE/ENDED, host, timestamps),
`LiveClassAttendance` (who joined/left, for the analytics phase later).

New REST endpoints:
- `POST /api/live-classes` — start a class (`classroom.host` permission required)
- `GET  /api/live-classes/active` — list what's live right now
- `POST /api/live-classes/:id/end` — host or admin only

New socket events: `classroom:join`, `:raise-hand`, `:lower-hand`,
`:approve-speaker`, `:revoke-speaker`, `:mute-all`, `:remove-participant`,
`:end`, plus `webrtc:offer` / `:answer` / `:ice-candidate` as an opaque,
host-hub-enforced signaling relay.

**Rules enforced server-side, not just in the UI:**
- Students always join `MUTED`, camera concept has no auto-enable path at all
  — there's simply no code path that lets a participant become `APPROVED`
  except the host explicitly calling `classroom:approve-speaker`.
- Every host-only action (`approve-speaker`, `revoke-speaker`, `mute-all`,
  `remove-participant`, `end`) checks `state.hostId === userId` — a
  non-host's attempt is rejected, tested with a real STUDENT-role account.
- WebRTC signaling is rejected unless one side of the exchange is the host
  (no participant-to-participant relay), matching the star topology.

### Run the live signaling test
```bash
npx tsx scripts/test-liveclass.ts
```
Registers and approves a real STUDENT account, has them try to start a class
(rejected, 403), then walks through join → mute-by-default → raise hand →
host approval → WebRTC offer relay → mute-all → remove → end, checking the
server's actual behavior at every step. Currently: **20/20 checks passing.**

### Honest limitation

This test verifies the **signaling protocol and permission state machine** —
it does not and cannot verify actual audio transmission, because that
requires a real browser with real microphone hardware, which this sandboxed
environment doesn't have. The frontend (`LiveClassPage.jsx`) uses real
browser WebRTC APIs (`getUserMedia`, `RTCPeerConnection`) wired to this
tested signaling layer, so it's built to actually work — but audio itself
needs to be tried by a real person in two real browser tabs to be confirmed
end-to-end. Please test it and let me know what you find.

## Phase 9 — Push notifications (added)

Real Web Push (VAPID keys are actually generated and configured — see `.env`),
plus an in-app notification center and realtime delivery over the existing
Socket.IO connection.

**One event = one notification**, enforced the same way as chat message
idempotency: `Notification` has `@@unique([userId, eventKey])`. Every feature
that notifies someone builds an `eventKey` from something that's naturally
unique to that real-world occurrence:
- Account approval → keyed by user id + exact approval timestamp
- A live class starting → keyed by the class id (a class can only start once)
- A chat message → keyed by the message id + recipient id

**Chat notification intelligence**: a message only triggers a push/notification
for participants who are NOT currently viewing that conversation (checked via
whether their socket has joined the `conv:{id}` room) — someone actively
looking at the chat already saw it arrive live, so they don't also get pushed.

New DB models: `PushSubscription` (per-device, upserted by endpoint),
`Notification` (type, title, body, url, eventKey, read).

New endpoints:
- `GET  /api/push/vapid-public-key`
- `POST /api/push/subscribe` / `/unsubscribe`
- `GET  /api/notifications` (includes `meta.unreadCount`)
- `POST /api/notifications/:id/read` / `/read-all`

### Run the live test
```bash
npx tsx scripts/test-notifications.ts
```
Covers: VAPID key is real, an approval creates exactly one notification and
it's visible via REST, marking read/all-read works, a duplicate dispatch with
the same eventKey does NOT create a second row, push subscription CRUD
actually persists/removes from the database, and a live class starting
delivers a real-time `notification:new` event to another connected user.
Currently: **17/17 checks passing.**

### Honest limitation

Same category as the live-class audio limitation: this proves the
subscription is stored correctly and that `sendPushToUser()` is invoked with
real VAPID-signed payloads — it does not prove a notification appears on an
actual phone or desktop, because that requires a real browser calling
`pushManager.subscribe()` (which only exists in a real browser context) and
a person to look at their screen. Please test the "Emeza ubutumwa" prompt in
the notification bell yourself and let me know what you see.

## Phase 11 — Analytics + activity tracking (added)

Real, measured numbers only — no fabricated statistics, per the spec's
explicit rule. New DB models: `Session` (real start/heartbeat/end timestamps,
duration computed once at close from actual elapsed time) and `ActivityEvent`
(a curated allow-list of meaningful events: LOGIN, LOGOUT, PAGE_VIEW,
CHAT_OPEN, BOOK_DOWNLOAD, CLASS_JOIN, CLASS_LEAVE — never raw mouse movement
or an open pipe for arbitrary client-supplied event names).

New endpoints:
- `POST /api/activity/track` — client-reported events, allow-listed server-side
- `POST /api/activity/heartbeat` — keeps a session's "last seen" timestamp current
- `GET  /api/analytics/overview?range=daily|weekly|monthly|yearly|lifetime`
  (default weekly, `analytics.view` permission required)
- `GET  /api/analytics/students/:id` — per-student time + event breakdown

### Honest scope limitation

Video/audio watch-time, exam attempts, and Dars/Ifaida read-time from the
spec are **not** included here, on purpose — those content types don't exist
as real backend entities yet (that's Phase 6, content management, still
unbuilt). Adding numbers for them now would mean fabricating data, which the
spec explicitly forbids. What IS tracked here — login sessions, chat opens,
book downloads, live-class attendance — is 100% real and measured, tracked
back to the actual database rows/timestamps that produced it.

### Run the live test
```bash
npx tsx scripts/test-analytics.ts
```
The strongest check in this suite: it logs a student in, waits a real ~2.5
seconds, logs them out, then asserts the computed session duration is within
5 seconds of the actual wall-clock time that passed — not "some positive
number", the actual measured value. Also checks: unlisted event types are
rejected (422), a plain STUDENT can't read the dashboard (403), and event
counts exactly match the events fired in the test. Currently: **16/16
checks passing.** All four suites together (chat + live-class +
notifications + analytics): **68/68 passing.**

## Phase 4/RBAC-hardening — Role & permission assignment (added)

The spec's centerpiece: "Admin can assign role and permission to a new
user/leader" — plus the full "RBAC — CRITICAL" and "Dynamic Sidebar"
sections made real, not just written down.

New canonical permission list: `src/utils/permissionCatalog.ts` — all 34
permissions exactly as named in the spec, grouped by category. Nothing
outside this list can ever be stored on a user (validated server-side,
unknown strings are silently dropped).

New endpoints, ALL gated on `requireRole("ADMIN")` — not permission-driven,
because assigning roles/permissions is a system-authority action the spec
lists only under what ADMIN can do:
- `GET   /api/admin/permissions-catalog`
- `GET   /api/admin/users` — every user, searchable/filterable/paginated
- `PATCH /api/admin/users/:id/role` — STUDENT ⇄ LEADER only (never touches
  or creates ADMIN accounts through this API, on purpose)
- `PATCH /api/admin/users/:id/permissions` — set a leader's full permission
  set in one call
- `POST  /api/admin/users/:id/block` / `/unblock` — generalized across any
  non-admin role

Also added: `GET /api/students/:id` (the spec's "REBA" view-detail action),
completing the exact 4-action set (REBA/EMEZA/REANGA/HAGARIKA) the Approval
Center now has.

**Live enforcement without re-login**: because `authenticate` middleware
already re-reads the user fresh from the database on every single request
(see Phase 3), a permission grant or role change takes effect on the user's
very next API call — using their existing token, no logout required. A
realtime `account:updated` ping additionally tells their browser to
silently refresh its own copy of the session, so the sidebar visibly
updates too, not just the backend's enforcement.

### Run the live test
```bash
npx tsx scripts/test-rbac.ts
```
The single most important check in this suite: it grants a freshly-promoted
leader `classroom.host` and *nothing else*, then — reusing the SAME token
issued before the grant — confirms they can now host a class but are still
rejected from `student.approve`-gated routes. That's "RBAC — CRITICAL" and
"live enforcement" proven in one test, not asserted. Also verifies: a leader
(even with every student permission) cannot promote anyone or read the
permission catalog — admin-only, no exceptions; demoting a leader wipes
their permissions; admin accounts can't be role-changed or blocked through
this API at all. Currently: **17/17 checks passing.** All five suites
together (chat + live-class + notifications + analytics + RBAC): **85/85
passing.**

## Phase 6 — Ifaida content management (added)

The content-management gap I'd previously flagged as honestly unbuilt (in
the analytics phase's scope notes) — now real. A leader-only writing area
with a full draft → publish lifecycle, exactly matching the spec's
"IFAIDA WRITING" / "IFAIDA EDITOR" / "IFAIDA DRAFTS" / "IFAIDA PERMISSIONS"
sections.

New DB model: `Ifaida` (title, description, content, author, category,
coverImage, status DRAFT/PUBLISHED, publishedAt).

New endpoints — every write action gated on its OWN specific permission,
not a blanket "can write Ifaida" flag:
- `GET  /api/ifaida/published` / `/published/:id` — public, no auth (matches
  the existing public Inyandiko page's guest-accessible behavior)
- `GET  /api/ifaida/mine` / `/mine/:id` — a leader's own posts, requires
  `ifaida.create` OR `ifaida.update`
- `POST /api/ifaida` — requires `ifaida.create`
- `PATCH /api/ifaida/:id` — requires `ifaida.update` AND must be the author (or admin)
- `DELETE /api/ifaida/:id` — requires `ifaida.delete`
- `POST /api/ifaida/:id/publish` / `/unpublish` — requires `ifaida.publish` specifically

**Real XSS protection** (`src/utils/sanitize.ts`): strips `<script>`,
`<iframe>`, inline event handlers (`onerror=`, `onclick=`, ...), and
`javascript:` URLs from every piece of rich-text content before it's stored.
Honest limitation: this is a regex-based stripper, not a full DOM-parsing
allow-list sanitizer (like DOMPurify) — it covers the realistic threat
surface for content typed through our own toolbar editor, but wouldn't be
sufficient if the editor ever accepted arbitrary pasted external HTML at
scale.

### Run the live test
```bash
npx tsx scripts/test-ifaida.ts
```
Walks the full lifecycle: a leader with zero ifaida permissions can't even
create a draft (403); create → the draft is genuinely invisible to the
public (both the list AND a direct URL to it return nothing/404); simulated
autosave edits with a **real XSS payload** (`<script>alert(1)</script>` plus
an `onerror=` attribute) — confirms the malicious parts are stripped while
legitimate formatting survives; a different leader (even holding
`ifaida.update`) can't touch someone else's draft; publish requires
`ifaida.publish` specifically, separate from update; published post becomes
publicly visible with sanitized content and a real computed reading time;
unpublish removes it from public view again; delete requires `ifaida.delete`
specifically. Currently: **24/24 checks passing.** All six suites together:
**109/109 passing.**
