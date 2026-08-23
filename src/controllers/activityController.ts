import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { heartbeatSession, trackEvent } from "../utils/activity.js";
import { prisma } from "../utils/prisma.js";

// Events the client is allowed to report directly. Anything not on this list
// is rejected — activity tracking is meaningful, curated events only, never
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
  "IFAIDA",
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
 * Records N seconds spent on one activity category — called periodically by
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
