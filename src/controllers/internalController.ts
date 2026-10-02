import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { trackEvent } from "../utils/activity.js";
import { notifyAllActiveUsersExcept } from "../utils/notify.js";

/**
 * Every route here exists ONLY for the LiveClass service to call
 * server-to-server (see requireInternalSecret) -- never the frontend.
 * Each one mirrors exactly what that service used to do with its own
 * direct Prisma access, now centralized here so it never needs its own
 * database connection at all. Nothing here does end-user authorization
 * (checking "is THIS caller allowed to do this") -- that already
 * happened on the LiveClass service, which validated the real user's
 * JWT and role/permissions before ever making one of these calls; this
 * layer trusts that and just performs the operation.
 */

function publicUserForAuth(u: any) {
  // Exactly the fields the LiveClass service's own auth middleware and
  // socket connection handler need to decide "is this still a valid,
  // active session" -- nothing more (no passwordHash, no googleId).
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    status: u.status,
    permissions: u.permissions,
    tokenVersion: u.tokenVersion,
    gender: u.gender,
  };
}

export const getUserForAuth = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) {
    sendError(res, 404, "Konti ntiboneka.");
    return;
  }
  sendResponse(res, 200, publicUserForAuth(user));
});

export const getActiveUserEmailsExcept = asyncHandler(async (req: Request, res: Response) => {
  const exclude = String(req.query.except ?? "");
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE", id: { not: exclude } },
    select: { email: true },
  });
  sendResponse(res, 200, { emails: users.map((u) => u.email) });
});

export const notifyAllActiveExcept = asyncHandler(async (req: Request, res: Response) => {
  const { excludeUserId, type, title, body, url, eventKey } = req.body ?? {};
  if (!excludeUserId || !type || !title || !body || !eventKey) {
    sendError(res, 422, "Ibisabwa byose ntibyatanzwe (excludeUserId, type, title, body, eventKey).");
    return;
  }
  const { createdCount } = await notifyAllActiveUsersExcept(excludeUserId, (userId) => ({
    userId,
    type,
    title,
    body,
    url,
    eventKey,
  }));
  sendResponse(res, 200, { createdCount });
});

export const trackActivity = asyncHandler(async (req: Request, res: Response) => {
  const { userId, type, meta } = req.body ?? {};
  if (!userId || !type) {
    sendError(res, 422, "userId na type birakenewe.");
    return;
  }
  await trackEvent(userId, type, meta ?? {});
  sendResponse(res, 200, null);
});

function publicLiveClass(c: any) {
  return {
    id: c.id,
    title: c.title,
    hostId: c.hostId,
    hostName: c.host?.fullName,
    status: c.status,
    locked: c.locked,
    scheduledFor: c.scheduledFor,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    createdAt: c.createdAt,
  };
}

export const createLiveClassInternal = asyncHandler(async (req: Request, res: Response) => {
  const { title, hostId, status, scheduledFor, startedAt } = req.body ?? {};
  if (!title || !hostId || !status) {
    sendError(res, 422, "title, hostId, na status birakenewe.");
    return;
  }
  const created = await prisma.liveClass.create({
    data: {
      title,
      hostId,
      status,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      startedAt: startedAt ? new Date(startedAt) : null,
    },
    include: { host: true },
  });
  sendResponse(res, 201, publicLiveClass(created));
});

export const getLiveClassInternal = asyncHandler(async (req: Request, res: Response) => {
  const liveClass = await prisma.liveClass.findUnique({
    where: { id: req.params.id },
    include: { host: true },
  });
  if (!liveClass) {
    sendError(res, 404, "Isomo ntaboneka.");
    return;
  }
  sendResponse(res, 200, publicLiveClass(liveClass));
});

export const listLiveClassesInternal = asyncHandler(async (req: Request, res: Response) => {
  const { status, scheduledBefore, scheduledAfter } = req.query;
  const where: any = {};
  if (status) where.status = String(status);
  if (scheduledBefore || scheduledAfter) {
    where.scheduledFor = {};
    if (scheduledAfter) where.scheduledFor.gte = new Date(String(scheduledAfter));
    if (scheduledBefore) where.scheduledFor.lte = new Date(String(scheduledBefore));
  }
  const classes = await prisma.liveClass.findMany({ where, include: { host: true }, orderBy: { createdAt: "desc" } });
  sendResponse(res, 200, classes.map(publicLiveClass));
});

export const updateLiveClassInternal = asyncHandler(async (req: Request, res: Response) => {
  const data: any = {};
  const { status, locked, scheduledFor, startedAt, endedAt } = req.body ?? {};
  if (status !== undefined) data.status = status;
  if (locked !== undefined) data.locked = locked;
  if (scheduledFor !== undefined) data.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
  if (startedAt !== undefined) data.startedAt = startedAt ? new Date(startedAt) : null;
  if (endedAt !== undefined) data.endedAt = endedAt ? new Date(endedAt) : null;

  try {
    const updated = await prisma.liveClass.update({ where: { id: req.params.id }, data, include: { host: true } });
    sendResponse(res, 200, publicLiveClass(updated));
  } catch {
    sendError(res, 404, "Isomo ntaboneka.");
  }
});

export const deleteLiveClassInternal = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.liveClassAttendance.deleteMany({ where: { liveClassId: id } }),
      prisma.liveClass.delete({ where: { id } }),
    ]);
    sendResponse(res, 200, null);
  } catch {
    sendError(res, 404, "Isomo ntaboneka.");
  }
});

export const createAttendanceInternal = asyncHandler(async (req: Request, res: Response) => {
  const { liveClassId, userId } = req.body ?? {};
  if (!liveClassId || !userId) {
    sendError(res, 422, "liveClassId na userId birakenewe.");
    return;
  }
  await prisma.liveClassAttendance.create({ data: { liveClassId, userId } });
  sendResponse(res, 201, null);
});

/**
 * One endpoint covers every "close out attendance" shape the LiveClass
 * service needs: close everyone still open for a class (ending it),
 * close one specific participant (removed or disconnected), or close a
 * specific list of participants -- distinguished by which of userId /
 * userIds is present. Omitting both closes every open attendance row
 * for the class.
 */
export const closeAttendanceInternal = asyncHandler(async (req: Request, res: Response) => {
  const { liveClassId, userId, userIds } = req.body ?? {};
  if (!liveClassId) {
    sendError(res, 422, "liveClassId birakenewe.");
    return;
  }
  const where: any = { liveClassId, leftAt: null };
  if (userId) where.userId = userId;
  else if (Array.isArray(userIds) && userIds.length > 0) where.userId = { in: userIds };

  const result = await prisma.liveClassAttendance.updateMany({ where, data: { leftAt: new Date() } });
  sendResponse(res, 200, { count: result.count });
});
