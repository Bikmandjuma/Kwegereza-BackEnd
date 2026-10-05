# Kwegereza API — main backend

Node.js + TypeScript + Express + Prisma + MySQL. This is the authoritative
backend for the Kwegereza Islam Umuryango platform: accounts and roles,
books/dars/ifaida content, exams (with camera-based proctoring), the
in-app chat system (including gender-scoped group rooms), guest support
chat, notifications (in-app + real web push), and the internal API the
separate LiveClass service depends on for everything it needs to persist.

## Prerequisites

- Node.js 18+
- A MySQL database (local install, or any hosted MySQL)

## Install and run

```bash
npm install
cp .env.example .env     # fill in every value -- see the comments in that file
npx prisma generate
npx prisma migrate deploy   # applies every migration in prisma/migrations/
npm run dev                  # https://api.kwegereza.org
```

There is no seed script in this repo as of this README; create your first
account through the normal registration flow, then promote it to
`ADMIN`/`SUPER_ADMIN` directly in the database (`role` column on `User`)
to get into the admin panel for the first time.

## Required environment variables (see `.env.example` for the full list)

- `DATABASE_URL` — your MySQL connection string
- `JWT_SECRET` — must match the exact same value configured on the
  LiveClass service
- `INTERNAL_API_SECRET` — must also match the LiveClass service's own
  value; this is what authenticates its server-to-server calls into
  `/api/internal/*` (see `src/routes/internalRoutes.ts`) — never expose
  this to any frontend
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — for web
  push notifications
- `GMAIL_USER` / `GMAIL_APP_PASSWORD` — for transactional email (a Gmail
  App Password, not your regular Gmail password)
- `GOOGLE_CLIENT_ID` — for "Sign in with Google" registration
- `CORS_ORIGIN` — the frontend's real origin

## Build for production

```bash
npm run build   # compiles TypeScript to dist/
npm start        # runs the compiled output
```

## What this service owns

Everything in this project's own `prisma/schema.prisma` — users, roles
and permissions, books, dars, ifaida, exams and exam attempts (including
uploaded proctoring recordings), announcements, the in-app chat system
(1:1 DMs and the auto-joined gender rooms), guest support chat,
notifications and push subscriptions, and live-class *records*
(attendance, scheduling) even though the live-class *real-time media* is
handled entirely by the separate LiveClass service — see that project's
own README for how the two talk to each other without it ever needing a
direct database connection.

## Related services

- `Kwegereza-web` — the React frontend. Needs `VITE_API_URL` pointed at
  this service and `VITE_LIVE_API_URL` pointed at the LiveClass service.
- `Kwegereza-LiveClass` — the standalone live-class service (audio +
  screen share via LiveKit). Has no database of its own; everything it
  needs comes from this backend's internal API.
