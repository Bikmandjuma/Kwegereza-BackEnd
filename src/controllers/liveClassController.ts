import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { endLiveClass } from "../realtime/liveClass.js";
import { getIo } from "../realtime/ioInstance.js";
import { notifyAllActiveUsersExcept } from "../utils/notify.js";

function publicClass(c: any) {
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
  };
}

// Broadcasting "it's live" is identical whether the class went live
// immediately or was a scheduled one just started — one shared code path so
// the realtime emit + notification fan-out can never drift between the two.
async function announceLive(liveClass: any, hostId: string) {
  getIo()?.emit("liveclass:started", publicClass(liveClass));
  await notifyAllActiveUsersExcept(hostId, (userId) => ({
    userId,
    type: "liveclass.started",
    title: "Isomo riri live!",
    body: liveClass.title,
    url: `/live-class/${liveClass.id}`,
    eventKey: `liveclass-started-${liveClass.id}`,
  }));
}

export const createLiveClass = asyncHandler(async (req: Request, res: Response) => {
  const { title, scheduledFor } = req.body ?? {};
  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe w'isomo.");
    return;
  }

  let scheduledDate: Date | null = null;
  if (scheduledFor) {
    scheduledDate = new Date(scheduledFor);
    if (Number.isNaN(scheduledDate.getTime())) {
      sendError(res, 422, "Itariki/igihe cyatanzwe ntibisobanutse.");
      return;
    }
  }

  // A schedule time in the past (or omitted) means "start right now" —
  // exactly today's existing behavior. A future time books it instead.
  const isImmediate = !scheduledDate || scheduledDate.getTime() <= Date.now();

  const liveClass = await prisma.liveClass.create({
    data: {
      title: title.trim(),
      hostId: req.user!.id,
      status: isImmediate ? "LIVE" : "SCHEDULED",
      scheduledFor: isImmediate ? null : scheduledDate,
      startedAt: isImmediate ? new Date() : null,
    },
    include: { host: true },
  });

  if (isImmediate) {
    await announceLive(liveClass, req.user!.id);
    sendResponse(res, 201, { liveClass: publicClass(liveClass) }, "Isomo ritangiye.");
  } else {
    sendResponse(res, 201, { liveClass: publicClass(liveClass) }, "Isomo ryateganyijwe.");
  }
});

// Host manually flips a SCHEDULED class to LIVE when its time comes (or
// early, if they want to start ahead of schedule) — the class can't truly
// go live without the host's own browser/mic present, so this is a
// deliberate action rather than an automatic server-side timer.
export const startScheduledLiveClass = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const liveClass = await prisma.liveClass.findUnique({ where: { id }, include: { host: true } });
  if (!liveClass) {
    sendError(res, 404, "Isomo ntaboneka.");
    return;
  }
  if (liveClass.hostId !== req.user!.id && req.user!.role !== "ADMIN") {
    sendError(res, 403, "Gusa uwateganyije isomo cyangwa admin ni bo bashobora kuritangira.");
    return;
  }
  if (liveClass.status !== "SCHEDULED") {
    sendError(res, 422, "Iri somo ntabwo riri gutegereza gutangira.");
    return;
  }

  const updated = await prisma.liveClass.update({
    where: { id },
    data: { status: "LIVE", startedAt: new Date() },
    include: { host: true },
  });

  await announceLive(updated, liveClass.hostId);
  sendResponse(res, 200, { liveClass: publicClass(updated) }, "Isomo ritangiye.");
});

export const listActiveLiveClasses = asyncHandler(async (_req: Request, res: Response) => {
  const classes = await prisma.liveClass.findMany({
    where: { status: "LIVE" },
    include: { host: true },
    orderBy: { startedAt: "desc" },
  });
  sendResponse(res, 200, classes.map(publicClass));
});

// Upcoming = booked for a future time and not started yet. Ordered soonest
// first so "starts in 3h" always sits above "starts in 2 days".
export const listUpcomingLiveClasses = asyncHandler(async (_req: Request, res: Response) => {
  const classes = await prisma.liveClass.findMany({
    where: { status: "SCHEDULED" },
    include: { host: true },
    orderBy: { scheduledFor: "asc" },
    take: 50,
  });
  sendResponse(res, 200, classes.map(publicClass));
});

// Backs the shareable class link (/live-class/:id): lets someone who opens
// that link see what the class is and when it starts, whether or not
// they're already a participant — read-only, no join side effects.
export const getLiveClass = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const liveClass = await prisma.liveClass.findUnique({ where: { id }, include: { host: true } });
  if (!liveClass) {
    sendError(res, 404, "Isomo ntaboneka.");
    return;
  }
  sendResponse(res, 200, { liveClass: publicClass(liveClass) });
});

export const endLiveClassRoute = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const liveClass = await prisma.liveClass.findUnique({ where: { id } });
  if (!liveClass) {
    sendError(res, 404, "Isomo ntaboneka.");
    return;
  }
  if (liveClass.hostId !== req.user!.id && req.user!.role !== "ADMIN") {
    sendError(res, 403, "Gusa uwatangiye isomo cyangwa admin ni bo bashobora kurihagarika.");
    return;
  }
  if (liveClass.status !== "LIVE") {
    sendError(res, 422, "Iri somo ntabwo ririmo gukorwa (live) ubu.");
    return;
  }

  const io = getIo();
  const updated = await endLiveClass(io, id);
  sendResponse(res, 200, { liveClass: publicClass(updated) }, "Isomo ryarangiye.");
});
