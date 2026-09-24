import type { Request, Response } from "express";
import crypto from "crypto";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { getIo } from "../realtime/ioInstance.js";

const ONLINE_WINDOW_MS = 60 * 60 * 1000; // 1 hour see getPublicStats below

// A stable, anonymous 4-digit label derived from the visitor's own id —
// the same browser always maps to the same "guestXXXX", without ever
// storing or exposing anything that identifies the actual person. This is
// deliberately NOT a sequential "visitor #1, #2, #3..." counter, which
// would leak how many total guests the site has ever had.
function guestLabel(visitorId: string): string {
  const hash = crypto.createHash("md5").update(visitorId).digest("hex");
  const num = parseInt(hash.slice(0, 8), 16) % 10000;
  return `guest${String(num).padStart(4, "0")}`;
}

/** Records one real page view. `visitorId` is a client-generated anonymous
 * id (see api/visits.js on the frontend) this is a visit counter, not a
 * tracking-for-ads mechanism, so no IP/user-agent fingerprinting is stored. */
export const recordVisit = asyncHandler(async (req: Request, res: Response) => {
  const { path, visitorId } = req.body ?? {};
  if (!visitorId || typeof visitorId !== "string") {
    sendResponse(res, 200, null); // don't hard-fail the page over a missing beacon
    return;
  }

  // Checked BEFORE inserting the new row if nothing with this visitorId
  // exists yet, this is genuinely their first visit ever, and the
  // real-time "guest joined" toast (seen by whoever is currently logged in
  // and connected see socket.ts's presence:update for the equivalent
  // for real accounts) only makes sense to fire once per guest, not on
  // every single page view.
  const seenBefore = await prisma.pageVisit.findFirst({ where: { visitorId } });

  await prisma.pageVisit.create({ data: { path: String(path ?? "/").slice(0, 255), visitorId } });

  if (!seenBefore) {
    getIo()?.emit("guest:joined", { label: guestLabel(visitorId) });
  }

  sendResponse(res, 200, null);
});

export const getPublicStats = asyncHandler(async (_req: Request, res: Response) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const oneHourAgo = new Date(Date.now() - ONLINE_WINDOW_MS);

  const [
    onlineVisitorIds,
    todayVisitorIds,
    totalVisitorIds,
    ifaidaCount,
    darsCount,
    bookCount,
    teacherCount,
    announcementCount,
    photoInsightCount,
  ] = await Promise.all([
    // "Online now" previously came from getOnlineUserCount(), which only
    // ever counted authenticated socket connections. A guest has no
    // account and therefore no socket at all, so every guest was silently
    // invisible here regardless of how many were actually browsing.
    // Deriving this from recent page-visit beacons instead counts anyone
    // whose browser recorded a visit in the last hour guest or not and
    // naturally makes someone "not online" again once an hour passes with
    // no further activity from them, without needing any separate
    // presence/session-expiry mechanism.
    prisma.pageVisit.findMany({ where: { createdAt: { gte: oneHourAgo } }, distinct: ["visitorId"], select: { visitorId: true } }),
    prisma.pageVisit.findMany({ where: { createdAt: { gte: startOfToday } }, distinct: ["visitorId"], select: { visitorId: true } }),
    prisma.pageVisit.findMany({ distinct: ["visitorId"], select: { visitorId: true } }),
    // "Ibyanditswe byose" on AboutPage.jsx (all published content) was a
    // hardcoded "76" this is a genuine content count across every
    // publishable type, not a visit count, so it's computed separately
    // from the three visitor-traffic numbers above.
    prisma.ifaida.count({ where: { status: "PUBLISHED" } }),
    prisma.dars.count({ where: { status: "PUBLISHED" } }),
    prisma.book.count({ where: { status: "PUBLISHED" } }),
    // The navbar's per-type counts (Abarimu/Ibitabo/Inyandiko/Amatangazo)
    // real numbers, not the combined publishedContent total above.
    // Teacher has no draft concept, so it's a straight total.
    prisma.teacher.count(),
    prisma.announcement.count({ where: { status: "PUBLISHED" } }),
    prisma.photoInsight.count({ where: { status: "PUBLISHED" } }),
  ]);

  sendResponse(res, 200, {
    onlineNow: onlineVisitorIds.length,
    todayVisits: todayVisitorIds.length,
    totalVisits: totalVisitorIds.length,
    publishedContent: ifaidaCount + darsCount + bookCount,
    teachers: teacherCount,
    books: bookCount,
    ifaida: ifaidaCount,
    announcements: announcementCount,
    // Isomero (the combined library link replacing separate Ibitabo/
    // Inyandiko top-nav links) shows ONE badge count across all three
    // things it now houses as tabs: books, Inyungu mu Nyandiko, and
    // Inyungu mu Mafoto.
    isomero: bookCount + ifaidaCount + photoInsightCount,
    photoInsights: photoInsightCount,
  });
});
