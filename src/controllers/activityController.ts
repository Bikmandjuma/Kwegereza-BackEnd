import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { heartbeatSession, trackEvent } from "../utils/activity.js";
import { prisma } from "../utils/prisma.js";
import { getRangeStart } from "./studentController.js";

// Events the client is allowed to report directly. Anything not on this list
// is rejected activity tracking is meaningful, curated events only, never
// an open pipe for arbitrary client-supplied event names (and definitely
// never mouse-movement-level noise).
const ALLOWED_CLIENT_EVENTS = new Set(["PAGE_VIEW", "CHAT_OPEN", "BOOK_DOWNLOAD"]);

const ALLOWED_TIME_CATEGORIES = new Set([
  "HOME",
  "ABOUT",
  "EXAM",
  "BOOKS",
  "DARS",
  "LIVE_CLASS",
  "CHAT",
  "ifaida",
  "ANNOUNCEMENTS",
  "ADMIN",
  "OTHER",
]);

export const track = asyncHandler(async (req: Request, res: Response) => {
  const { type, meta } = req.body ?? {};
  if (!ALLOWED_CLIENT_EVENTS.has(type)) {
    sendError(res, 422, "Ubu bwoko bw'igikorwa ntibwemewe.");
    return;
  }
  await trackEvent(req.user!.id, type, meta ?? {});
  sendResponse(res, 201, null);
});

export const heartbeat = asyncHandler(async (req: Request, res: Response) => {
  await heartbeatSession(req.user!.id);
  sendResponse(res, 200, null);
});

/**
 * Records N seconds spent on one activity category called periodically by
 * usePageTimeTracker (every ~20s while the tab is actually visible/focused,
 * plus once more on unmount/unload), never once per second. A hard cap on
 * `seconds` per call keeps a single malformed/malicious request from
 * inflating one day's bucket by an absurd amount.
 */
export const recordTime = asyncHandler(async (req: Request, res: Response) => {
  const { category, seconds } = req.body ?? {};
  const normalizedCategory = String(category ?? "").toUpperCase();
  const wholeSeconds = Math.floor(Number(seconds));

  if (!ALLOWED_TIME_CATEGORIES.has(normalizedCategory)) {
    sendError(res, 422, "Ubu bwoko bw'igikorwa ntibwemewe.");
    return;
  }
  if (!Number.isFinite(wholeSeconds) || wholeSeconds <= 0 || wholeSeconds > 120) {
    sendError(res, 422, "Umubare w'amasegonda ntusobanutse.");
    return;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  await prisma.activityTime.upsert({
    where: { userId_category_date: { userId: req.user!.id, category: normalizedCategory, date: today } },
    update: { seconds: { increment: wholeSeconds } },
    create: { userId: req.user!.id, category: normalizedCategory, date: today, seconds: wholeSeconds },
  });

  sendResponse(res, 200, null);
});

// GET /api/activity/logs merges two tables that were never queryable
// together before: AuditLog (deliberate admin/content actions who
// approved a student, who created or published a book, etc., written via
// writeAudit()) and ActivityEvent (routine activity logins, chat opens,
// book downloads, written via trackEvent()). Neither table alone is "all
// activities happen on system" the way both together are. Since Prisma
// can't UNION across two different models in one query, this fetches a
// generous slice from each, normalizes both into one shape, sorts by
// recency, then trims to the requested page a real limitation for deep
// historical paging, but the right tradeoff for what this screen actually
// is: a recent-activity feed, not a data warehouse.
export const listActivityLogs = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 30));
  const fetchSize = page * perPage + perPage; // enough of each source to cover this page after merging

  const [auditRows, eventRows] = await Promise.all([
    prisma.auditLog.findMany({
      take: fetchSize,
      orderBy: { createdAt: "desc" },
      include: { actor: true, target: true },
    }),
    prisma.activityEvent.findMany({
      take: fetchSize,
      orderBy: { createdAt: "desc" },
      include: { user: true },
    }),
  ]);

  const merged = [
    ...auditRows.map((r) => ({
      id: `audit:${r.id}`,
      // userName/type/userRole match RecentActivityFeed.jsx's existing
      // expected shape (it already renders ActivityEvent-sourced items
      // fed to it from AnalyticsDashboardPage.jsx) reusing that
      // component's UI and timeAgo() logic here rather than forking a
      // second, near-identical renderer for AuditLog-sourced rows.
      type: r.actionType,
      userName: r.actor?.fullName ?? "—",
      userRole: r.actor?.role ?? null,
      actorId: r.actorId,
      targetId: r.targetId,
      targetName: r.target?.fullName ?? null,
      meta: JSON.parse(r.meta || "{}"),
      createdAt: r.createdAt,
    })),
    ...eventRows.map((r) => ({
      id: `event:${r.id}`,
      type: r.type,
      userName: r.user?.fullName ?? "—",
      userRole: r.user?.role ?? null,
      actorId: r.userId,
      targetId: null,
      targetName: null,
      meta: JSON.parse(r.meta || "{}"),
      createdAt: r.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const total = merged.length; // an approximation bounded by fetchSize, not a true grand total acceptable for a recent-activity feed
  const start = (page - 1) * perPage;
  const pageRows = merged.slice(start, start + perPage);

  sendResponse(res, 200, pageRows, null, { page, perPage, total, totalPages: Math.ceil(total / perPage) || 1 });
});

/**
 * A student's own performance dashboard ("Ibikorwa"): time on app, video
 * watch time, audio listen time, and exam marks, filterable
 * daily/weekly/monthly/yearly/lifetime every logged-in user can see
 * their OWN numbers here (no permission gate beyond being authenticated),
 * same data sources the admin-facing StudentTimeModal already uses
 * (ActivityTime, Session, DarsPlayEvent) plus ExamAttempt for marks.
 *
 * The bucketed `series` is what actually draws the graph: daily buckets
 * for daily/weekly/monthly (24 hourly buckets for "daily" specifically,
 * since a single day has nothing to plot day-by-day), monthly buckets for
 * yearly/lifetime (lifetime's chart is capped to the most recent 12
 * months for readability; the CARDS above it still show true unbounded
 * lifetime totals, only the graph's x-axis is capped).
 */
export const getMyDashboard = asyncHandler(async (req: Request, res: Response) => {
  const range = String(req.query.range ?? "weekly");
  const userId = req.user!.id;
  const rangeStart = getRangeStart(range);
  const now = new Date();

  const [byCategory, sessions, videoEvents, audioEvents, examAttempts] = await Promise.all([
    prisma.activityTime.groupBy({
      by: ["category"],
      where: { userId, ...(rangeStart ? { date: { gte: rangeStart } } : {}) },
      _sum: { seconds: true },
    }),
    prisma.session.findMany({
      where: { userId, ...(rangeStart ? { startedAt: { gte: rangeStart } } : {}) },
      select: { startedAt: true, lastHeartbeatAt: true, durationSeconds: true },
    }),
    prisma.darsPlayEvent.findMany({
      where: { userId, dars: { type: "VIDEO" }, ...(rangeStart ? { playedAt: { gte: rangeStart } } : {}) },
      select: { watchSeconds: true, playedAt: true },
    }),
    prisma.darsPlayEvent.findMany({
      where: { userId, dars: { type: "AUDIO" }, ...(rangeStart ? { playedAt: { gte: rangeStart } } : {}) },
      select: { watchSeconds: true, playedAt: true },
    }),
    prisma.examAttempt.findMany({
      where: { userId, status: "SUBMITTED", ...(rangeStart ? { submittedAt: { gte: rangeStart } } : {}) },
      include: { exam: true },
      orderBy: { submittedAt: "desc" },
    }),
  ]);

  const totalPlatformSeconds = sessions.reduce((sum, s) => {
    if (s.durationSeconds != null) return sum + s.durationSeconds;
    return sum + Math.max(0, Math.floor((s.lastHeartbeatAt.getTime() - s.startedAt.getTime()) / 1000));
  }, 0);
  const videoSeconds = videoEvents.reduce((sum, e) => sum + (e.watchSeconds ?? 0), 0);
  const audioSeconds = audioEvents.reduce((sum, e) => sum + (e.watchSeconds ?? 0), 0);

  const scores = examAttempts.filter((a) => a.scorePercent != null).map((a) => a.scorePercent as number);
  const avgScorePercent = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const passedCount = examAttempts.filter((a) => a.passed).length;

  const series = buildDashboardSeries(range, rangeStart, now, sessions, videoEvents, audioEvents, examAttempts);

  sendResponse(res, 200, {
    range,
    totals: {
      appSeconds: totalPlatformSeconds,
      videoSeconds,
      audioSeconds,
      examsCount: examAttempts.length,
      avgScorePercent,
      passedCount,
    },
    byCategory: byCategory
      .map((c) => ({ category: c.category, seconds: c._sum.seconds ?? 0 }))
      .sort((a, b) => b.seconds - a.seconds),
    series,
    recentExams: examAttempts.slice(0, 5).map((a) => ({
      id: a.id,
      examTitle: a.exam.title,
      scorePercent: a.scorePercent,
      passed: a.passed,
      submittedAt: a.submittedAt,
    })),
  });
});

type SeriesBucket = { label: string; appSeconds: number; videoSeconds: number; audioSeconds: number; avgScore: number | null };

function sessionSeconds(s: { startedAt: Date; lastHeartbeatAt: Date; durationSeconds: number | null }): number {
  if (s.durationSeconds != null) return s.durationSeconds;
  return Math.max(0, Math.floor((s.lastHeartbeatAt.getTime() - s.startedAt.getTime()) / 1000));
}

function buildDashboardSeries(
  range: string,
  rangeStart: Date | null,
  now: Date,
  sessions: { startedAt: Date; lastHeartbeatAt: Date; durationSeconds: number | null }[],
  videoEvents: { watchSeconds: number | null; playedAt: Date }[],
  audioEvents: { watchSeconds: number | null; playedAt: Date }[],
  examAttempts: { scorePercent: number | null; submittedAt: Date | null }[]
): SeriesBucket[] {
  const byHour = range === "daily";
  const byMonth = range === "yearly" || range === "lifetime";

  // Window for the CHART specifically (lifetime's cards are unbounded,
  // but its graph is capped to the last 12 months, same as yearly).
  const chartStart = byHour
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    : byMonth
    ? new Date(now.getFullYear(), now.getMonth() - 11, 1)
    : (rangeStart ?? now);

  const buckets = new Map<string, { scores: number[] } & SeriesBucket>();
  const keyFor = (d: Date) =>
    byHour
      ? `${d.getUTCHours()}:00`
      : byMonth
      ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      : d.toISOString().slice(0, 10);

  // Pre-seed every bucket in the window so the graph shows real zeros
  // instead of gaps where nothing happened that day/hour/month.
  if (byHour) {
    for (let h = 0; h < 24; h++) {
      buckets.set(`${h}:00`, { label: `${h}:00`, appSeconds: 0, videoSeconds: 0, audioSeconds: 0, avgScore: null, scores: [] });
    }
  } else if (byMonth) {
    const cursor = new Date(chartStart);
    while (cursor <= now) {
      const key = keyFor(cursor);
      buckets.set(key, { label: key, appSeconds: 0, videoSeconds: 0, audioSeconds: 0, avgScore: null, scores: [] });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    const cursor = new Date(chartStart);
    while (cursor <= now) {
      const key = keyFor(cursor);
      buckets.set(key, { label: key, appSeconds: 0, videoSeconds: 0, audioSeconds: 0, avgScore: null, scores: [] });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  function addTo(date: Date, field: "appSeconds" | "videoSeconds" | "audioSeconds", seconds: number) {
    const key = keyFor(date);
    const bucket = buckets.get(key);
    if (bucket) bucket[field] += seconds;
  }

  for (const s of sessions) addTo(s.startedAt, "appSeconds", sessionSeconds(s));
  for (const e of videoEvents) addTo(e.playedAt, "videoSeconds", e.watchSeconds ?? 0);
  for (const e of audioEvents) addTo(e.playedAt, "audioSeconds", e.watchSeconds ?? 0);
  for (const a of examAttempts) {
    if (a.scorePercent == null || !a.submittedAt) continue;
    const bucket = buckets.get(keyFor(a.submittedAt));
    if (bucket) bucket.scores.push(a.scorePercent);
  }

  return Array.from(buckets.values()).map((b) => ({
    label: b.label,
    appSeconds: b.appSeconds,
    videoSeconds: b.videoSeconds,
    audioSeconds: b.audioSeconds,
    avgScore: b.scores.length ? Math.round(b.scores.reduce((x, y) => x + y, 0) / b.scores.length) : null,
  }));
}
