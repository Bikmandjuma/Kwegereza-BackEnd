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

  // upsert by endpoint the browser may re-subscribe with the same endpoint
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

/** Lets the frontend know whether THIS account has any push
 * subscription registered at all, across however many devices --
 * useful for a settings page that wants to show "notifications are on"
 * without the browser's own Notification.permission being the only
 * signal (that's per-browser, not per-account, so it can't by itself
 * answer "is push enabled for me anywhere"). */
export const getSubscriptionStatus = asyncHandler(async (req: Request, res: Response) => {
  const count = await prisma.pushSubscription.count({ where: { userId: req.user!.id } });
  sendResponse(res, 200, { subscribed: count > 0, deviceCount: count });
});

/** The mobile app's equivalent of subscribe() above -- one opaque Expo
 * push token per installed app instance, instead of a browser's
 * endpoint/keys triple. Same upsert-by-token reasoning: a token can
 * legitimately get re-registered (app reinstall, Expo occasionally
 * rotating tokens), and that should update the existing row rather
 * than create a duplicate. */
export const registerExpoToken = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body ?? {};
  if (!token || typeof token !== "string") {
    sendError(res, 422, "Uzuza token.");
    return;
  }
  await prisma.expoPushToken.upsert({
    where: { token },
    update: { userId: req.user!.id },
    create: { userId: req.user!.id, token },
  });
  sendResponse(res, 200, null, "Ubutumwa bwa push bwemejwe kuri iyi porogaramu.");
});

export const unregisterExpoToken = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body ?? {};
  if (!token) {
    sendError(res, 422, "Uzuza token.");
    return;
  }
  await prisma.expoPushToken.deleteMany({ where: { token, userId: req.user!.id } });
  sendResponse(res, 200, null, "Push notifications zahagaritswe kuri iyi porogaramu.");
});
