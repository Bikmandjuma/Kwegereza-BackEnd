import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { heartbeatSession, trackEvent } from "../utils/activity.js";

// Events the client is allowed to report directly. Anything not on this list
// is rejected — activity tracking is meaningful, curated events only, never
// an open pipe for arbitrary client-supplied event names (and definitely
// never mouse-movement-level noise).
const ALLOWED_CLIENT_EVENTS = new Set(["PAGE_VIEW", "CHAT_OPEN", "BOOK_DOWNLOAD"]);

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
