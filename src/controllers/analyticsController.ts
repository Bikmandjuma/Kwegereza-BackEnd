import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { getOnlineUserCount } from "../realtime/socket.js";

const RANGE_DAYS: Record<string, number | null> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  yearly: 365,
  lifetime: null,
};

function rangeStart(range: string): Date | null {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS.weekly;
  if (days === null) return null; // lifetime = no lower bound
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Real, measured session duration only. A still-open session's duration is
 * approximated as (lastHeartbeatAt - startedAt) — the most recent heartbeat
 * IS real evidence the user was active until at least that moment, so this
 * is a measured lower bound, not a guess. A closed session uses its stored
 * durationSeconds, computed once at close time from real timestamps.
 */
function sumSessionSeconds(
  sessions: { startedAt: Date; lastHeartbeatAt: Date; endedAt: Date | null; durationSeconds: number | null }[]
) {
  return sessions.reduce((total, s) => {
    if (s.durationSeconds != null) return total + s.durationSeconds;
    return total + Math.max(0, Math.round((s.lastHeartbeatAt.getTime() - s.startedAt.getTime()) / 1000));
  }, 0);
}

/**
 * Real day-by-day counts for the last 7 calendar days. Bucketed in JS from
 * actual rows rather than a SQL date-trunc, since SQLite (this dev
 * datasource) doesn't have a portable date-trunc Prisma can target — but the
 * numbers themselves are 100% real, not sampled or interpolated.
 */
function buildDailySeries(
  events: { type: string; createdAt: Date }[],
  messages: { createdAt: Date }[]
) {
  const days: { date: string; label: string; logins: number; messages: number; classJoins: number }[] = [];
  const dayKeys: string[] = [];
  const WEEKDAY = ["Ku.", "Mb.", "Ka.", "Gtu.", "Kan.", "Gnu.", "Gnb."]; // Kinyarwanda weekday abbreviations

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayKeys.push(key);
    days.push({ date: key, label: WEEKDAY[d.getDay()], logins: 0, messages: 0, classJoins: 0 });
  }

  const indexOf = new Map(dayKeys.map((k, i) => [k, i]));

  for (const e of events) {
    const key = e.createdAt.toISOString().slice(0, 10);
    const idx = indexOf.get(key);
    if (idx === undefined) continue;
    if (e.type === "LOGIN") days[idx].logins++;
    if (e.type === "CLASS_JOIN") days[idx].classJoins++;
  }
  for (const m of messages) {
    const key = m.createdAt.toISOString().slice(0, 10);
    const idx = indexOf.get(key);
    if (idx !== undefined) days[idx].messages++;
  }

  return days;
}

export const getOverview = asyncHandler(async (req: Request, res: Response) => {
  const range = String(req.query.range ?? "weekly");
  if (!(range in RANGE_DAYS)) {
    sendError(res, 422, "range igomba kuba: daily, weekly, monthly, yearly, cyangwa lifetime.");
    return;
  }
  const since = rangeStart(range);
  const createdFilter = since ? { createdAt: { gte: since } } : {};
  const sessionFilter = since ? { startedAt: { gte: since } } : {};

  const [
    totalStudents,
    totalLeaders,
    activeStudentIds,
    eventGroups,
    sessions,
    liveClassesHosted,
    liveClassAttendances,
    messagesSent,
    last7DaysEvents,
    last7DaysMessages,
    recentActivity,
  ] = await Promise.all([
    prisma.user.count({ where: { role: "STUDENT", status: "ACTIVE" } }),
    prisma.user.count({ where: { role: "LEADER", status: "ACTIVE" } }),
    prisma.activityEvent.findMany({
      where: { ...createdFilter, user: { role: "STUDENT" } },
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.activityEvent.groupBy({
      by: ["type"],
      where: createdFilter,
      _count: { _all: true },
    }),
    prisma.session.findMany({
      where: sessionFilter,
      select: { startedAt: true, lastHeartbeatAt: true, endedAt: true, durationSeconds: true },
    }),
    prisma.liveClass.count({ where: since ? { startedAt: { gte: since } } : {} }),
    prisma.liveClassAttendance.findMany({
      where: since ? { joinedAt: { gte: since } } : {},
      select: { joinedAt: true, leftAt: true },
    }),
    prisma.message.count({ where: createdFilter }),
    prisma.activityEvent.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      select: { type: true, createdAt: true },
    }),
    prisma.message.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      select: { createdAt: true },
    }),
    prisma.activityEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { user: { select: { fullName: true, role: true } } },
    }),
  ]);

  const attendanceSeconds = liveClassAttendances.reduce((total, a) => {
    const end = a.leftAt ?? new Date();
    return total + Math.max(0, Math.round((end.getTime() - a.joinedAt.getTime()) / 1000));
  }, 0);

  sendResponse(res, 200, {
    range,
    totalStudents,
    totalLeaders,
    onlineNow: getOnlineUserCount(),
    activeStudents: activeStudentIds.length,
    platformTimeSeconds: sumSessionSeconds(sessions),
    liveClassesHosted,
    liveClassAttendanceSeconds: attendanceSeconds,
    messagesSent,
    eventCounts: Object.fromEntries(eventGroups.map((g) => [g.type, g._count._all])),
    dailySeries: buildDailySeries(last7DaysEvents, last7DaysMessages),
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      type: a.type,
      userName: a.user.fullName,
      userRole: a.user.role,
      createdAt: a.createdAt,
    })),
  });
});

export const getStudentDetail = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({ where: { id } });
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umunyeshuri ntaboneka.");
    return;
  }

  const [sessions, eventGroups, attendances] = await Promise.all([
    prisma.session.findMany({
      where: { userId: id },
      select: { startedAt: true, lastHeartbeatAt: true, endedAt: true, durationSeconds: true },
    }),
    prisma.activityEvent.groupBy({ by: ["type"], where: { userId: id }, _count: { _all: true } }),
    prisma.liveClassAttendance.findMany({ where: { userId: id }, select: { joinedAt: true, leftAt: true } }),
  ]);

  const attendanceSeconds = attendances.reduce((total, a) => {
    const end = a.leftAt ?? new Date();
    return total + Math.max(0, Math.round((end.getTime() - a.joinedAt.getTime()) / 1000));
  }, 0);

  sendResponse(res, 200, {
    student: { id: student.id, fullName: student.fullName, email: student.email },
    totalPlatformTimeSeconds: sumSessionSeconds(sessions),
    liveClassAttendanceSeconds: attendanceSeconds,
    eventCounts: Object.fromEntries(eventGroups.map((g) => [g.type, g._count._all])),
  });
});
