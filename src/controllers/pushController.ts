import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { getVapidPublicKey } from "../utils/webPush.js";

export const getVapidKey = asyncHandler(async (_req: Request, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) {
    sendError(res, 503, "Push notifications ntizishoboye kuri iyi seriveri (VAPID keys ntizashyizweho).");
    return;
  }
  sendResponse(res, 200, { publicKey: key });
});

export const subscribe = asyncHandler(async (req: Request, res: Response) => {
  const { endpoint, keys } = req.body?.subscription ?? req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    sendError(res, 422, "Subscription ntabwo yuzuye neza.");
    return;
  }

  // upsert by endpoint — the browser may re-subscribe with the same endpoint
  // (e.g. after re-granting permission); this should update, not duplicate.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth },
    create: { userId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });

  sendResponse(res, 200, null, "Ubutumwa bwa push bwemejwe kuri iyi terefone/mudasobwa.");
});

export const unsubscribe = asyncHandler(async (req: Request, res: Response) => {
  const { endpoint } = req.body ?? {};
  if (!endpoint) {
    sendError(res, 422, "Uzuza endpoint.");
    return;
  }
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
  sendResponse(res, 200, null, "Push notifications zahagaritswe kuri iyi terefone/mudasobwa.");
});
