import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { getOnlineUserCount } from "../realtime/socket.js";

/** Records one real page view. `visitorId` is a client-generated anonymous
 * id (see api/visits.js on the frontend) — this is a visit counter, not a
 * tracking-for-ads mechanism, so no IP/user-agent fingerprinting is stored. */
export const recordVisit = asyncHandler(async (req: Request, res: Response) => {
  const { path, visitorId } = req.body ?? {};
  if (!visitorId || typeof visitorId !== "string") {
    sendResponse(res, 200, null); // don't hard-fail the page over a missing beacon
    return;
  }
  await prisma.pageVisit.create({ data: { path: String(path ?? "/").slice(0, 255), visitorId } });
  sendResponse(res, 200, null);
});

export const getPublicStats = asyncHandler(async (_req: Request, res: Response) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [todayVisitorIds, totalVisitorIds] = await Promise.all([
    prisma.pageVisit.findMany({ where: { createdAt: { gte: startOfToday } }, distinct: ["visitorId"], select: { visitorId: true } }),
    prisma.pageVisit.findMany({ distinct: ["visitorId"], select: { visitorId: true } }),
  ]);

  sendResponse(res, 200, {
    onlineNow: getOnlineUserCount(),
    todayVisits: todayVisitorIds.length,
    totalVisits: totalVisitorIds.length,
  });
});
