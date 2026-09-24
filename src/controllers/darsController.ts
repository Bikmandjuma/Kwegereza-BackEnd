import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";
import { writeAudit } from "../utils/auditLog.js";
import { longTextError } from "../utils/validateText.js";

function publicDars(d: any) {
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    description: d.description,
    category: d.category,
    thumbnail: d.thumbnail,
    status: d.status,
    plays: d.plays,
    audio: d.audio,
    youtubeUrl: d.youtubeUrl,
    teacherId: d.teacherId,
    playlistId: d.playlistId,
    playlistTitle: d.playlist?.title,
    playlistOrder: d.playlistOrder,
    teacherName: d.teacher?.name,
    publishedAt: d.publishedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    createdByName: d.createdBy?.fullName,
  };
}

/**
 * The first 2 PUBLISHED Dars a teacher ever had (by publishedAt ascending,
 * so the free set is stable over time rather than shifting every time
 * something new is uploaded) are free for anyone to open. Only relevant
 * for the teacherIds actually present in the current page/response --
 * never computed for the whole platform at once.
 */
async function computeFreePreviewIds(teacherIds: string[]): Promise<Set<string>> {
  const free = new Set<string>();
  await Promise.all(
    teacherIds.map(async (teacherId) => {
      const rows = await prisma.dars.findMany({
        where: { teacherId, status: "PUBLISHED" },
        orderBy: { publishedAt: "asc" },
        take: 2,
        select: { id: true },
      });
      rows.forEach((r) => free.add(r.id));
    })
  );
  return free;
}

export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 12));
  const type = String(req.query.type ?? "").trim().toUpperCase();
  const teacherId = String(req.query.teacherId ?? "").trim();
  const category = String(req.query.category ?? "").trim();
  const search = String(req.query.search ?? "").trim();

  const where: any = { status: "PUBLISHED" };
  if (type === "AUDIO" || type === "VIDEO") where.type = type;
  if (teacherId) where.teacherId = teacherId;
  if (category) where.category = category;
  if (search) where.OR = [{ title: { contains: search } }, { description: { contains: search } }];

  // Fetch everything matching, not a DB-level page see the identical
  // comment in photoInsightController.ts's listPublished for the full
  // reasoning. Here it matters even more: the free set is computed PER
  // TEACHER across every teacher actually present in the results, which
  // is only correct if that computation sees every matching row, not
  // just whatever happened to land on page 1 by publishedAt alone.
  const all = await prisma.dars.findMany({
    where,
    include: { teacher: true, playlist: true },
    orderBy: { publishedAt: "desc" },
  });
  const total = all.length;

  // Not logged in: everything gets a real `locked` flag, and a locked
  // item never gets its playable source (youtubeUrl/audio) in the
  // response at all the lock icon isn't just UI decoration a guest
  // inspecting network traffic still can't play a locked video. Logged-in
  // callers (any role) always see locked: false and the full source --
  // this whole feature is guest-only, never applied to an authenticated panel.
  const isAnonymous = !req.user;
  let freeIds = new Set<string>();
  if (isAnonymous) {
    const teacherIds = [...new Set(all.filter((d) => d.teacherId).map((d) => d.teacherId as string))];
    freeIds = await computeFreePreviewIds(teacherIds);
  }

  const withLock = all.map((d) => {
    const base = publicDars(d);
    if (!isAnonymous || !d.teacherId || freeIds.has(d.id)) {
      return { ...base, locked: false };
    }
    return { ...base, locked: true, youtubeUrl: null, audio: null };
  });
  // Stable sort: unlocked first, locked after publishedAt-desc order
  // preserved within each group.
  withLock.sort((a, b) => Number(a.locked) - Number(b.locked));

  const result = withLock.slice((page - 1) * perPage, page * perPage);

  sendResponse(res, 200, result, null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

/**
 * The real, distinct category values currently in use among PUBLISHED
 * Dars of a given type backs the "Fiqh / Hadith / Seera / ..." style
 * tabs. Only categories that actually have published content show up;
 * nothing here is a fixed/invented taxonomy.
 */
export const listCategories = asyncHandler(async (req: Request, res: Response) => {
  const type = String(req.query.type ?? "").trim().toUpperCase();
  const where: any = { status: "PUBLISHED", category: { not: "" } };
  if (type === "AUDIO" || type === "VIDEO") where.type = type;

  const rows = await prisma.dars.findMany({
    where,
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" },
  });
  sendResponse(res, 200, rows.map((r) => r.category));
});

export const trackPlay = asyncHandler(async (req: Request, res: Response) => {
  const dars = await prisma.dars.findUnique({ where: { id: req.params.id } });
  if (!dars || dars.status !== "PUBLISHED") {
    sendError(res, 404, "Iri somo ntiriboneka.");
    return;
  }
  const updated = await prisma.dars.update({ where: { id: dars.id }, data: { plays: { increment: 1 } } });
  // Anonymous plays (including the one free preview per teacher) still
  // increment the counter above, exactly as before only a LOGGED-IN
  // caller (this route runs optionalAuthenticate, not authenticate)
  // additionally gets a per-user watch event, which is what backs "who
  // watched this" in the admin list. The event's own id is returned so
  // the player can report back how long they actually watched once
  // they're done (see updateWatchTime below) without this we'd only
  // ever know a play STARTED, never how much of it anyone stayed for.
  let playEventId: string | null = null;
  if (req.user) {
    const event = await prisma.darsPlayEvent.create({
      data: { darsId: dars.id, userId: req.user.id },
    });
    playEventId = event.id;
  }
  sendResponse(res, 200, { plays: updated.plays, playEventId });
});

/**
 * Reports how long someone actually watched/listened after a play was
 * already counted called on pause, on the video/audio actually ending,
 * when switching away, and as a periodic safety-net while playing (in
 * case the tab just closes without any clean pause/unmount event). Always
 * SETS the total elapsed seconds for that one play event rather than
 * incrementing, so a duplicate or out-of-order call can't double-count.
 * Only the user who generated the play event may update it.
 */
export const updateWatchTime = asyncHandler(async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const watchSeconds = Math.max(0, Math.round(Number(req.body?.watchSeconds) || 0));

  const event = await prisma.darsPlayEvent.findUnique({ where: { id: eventId } });
  if (!event || event.userId !== req.user!.id) {
    sendError(res, 404, "Iyi play event ntiboneka.");
    return;
  }
  await prisma.darsPlayEvent.update({ where: { id: eventId }, data: { watchSeconds } });
  sendResponse(res, 200, { watchSeconds });
});

/**
 * Per-user play history for one Dars who watched/listened, how many
 * times, and when they last did. Admin-only (dars.view), and grouped in
 * application code rather than a raw event dump: an admin wants "Fatima
 * watched this 4 times, last on Tuesday", not 4 separate identical rows.
 */
export const listWatchers = asyncHandler(async (req: Request, res: Response) => {
  const darsId = req.params.id;
  const dars = await prisma.dars.findUnique({ where: { id: darsId } });
  if (!dars) {
    sendError(res, 404, "Iri somo ntiriboneka.");
    return;
  }

  const events = await prisma.darsPlayEvent.findMany({
    where: { darsId },
    include: { user: true },
    orderBy: { playedAt: "desc" },
  });

  const byUser = new Map<
    string,
    { userId: string; fullName: string; email: string; playCount: number; totalWatchSeconds: number; lastPlayedAt: Date }
  >();
  for (const e of events) {
    const existing = byUser.get(e.userId);
    if (existing) {
      existing.playCount += 1;
      existing.totalWatchSeconds += e.watchSeconds ?? 0;
      if (e.playedAt > existing.lastPlayedAt) existing.lastPlayedAt = e.playedAt;
    } else {
      byUser.set(e.userId, {
        userId: e.userId,
        fullName: e.user.fullName,
        email: e.user.email,
        playCount: 1,
        totalWatchSeconds: e.watchSeconds ?? 0,
        lastPlayedAt: e.playedAt,
      });
    }
  }

  const watchers = Array.from(byUser.values()).sort((a, b) => b.lastPlayedAt.getTime() - a.lastPlayedAt.getTime());
  sendResponse(res, 200, { totalPlays: dars.plays, loggedInPlays: events.length, watchers });
});

export const listAdmin = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();
  const type = String(req.query.type ?? "").trim().toUpperCase();
  const category = String(req.query.category ?? "").trim();

  const where: any = {};
  if (search) where.OR = [{ title: { contains: search } }, { description: { contains: search } }];
  if (status) where.status = status;
  if (type === "AUDIO" || type === "VIDEO") where.type = type;
  if (category) where.category = category;

  const [total, darsat] = await Promise.all([
    prisma.dars.count({ where }),
    prisma.dars.findMany({
      where,
      include: { teacher: true, createdBy: true, playlist: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, darsat.map(publicDars), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const createDars = asyncHandler(async (req: Request, res: Response) => {
  const { title, description, category, type, youtubeUrl, teacherId, playlistId, playlistOrder } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const audioUpload = files?.audio?.[0];
  const thumbUpload = files?.thumbnail?.[0];

  const normalizedType = String(type ?? "").toUpperCase();
  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe wa Dars.");
    return;
  }
  if (!["AUDIO", "VIDEO"].includes(normalizedType)) {
    sendError(res, 422, "Ubwoko bwa Dars bugomba kuba AUDIO cyangwa VIDEO.");
    return;
  }
  if (normalizedType === "AUDIO" && !audioUpload) {
    sendError(res, 422, "Ushyiremo idosiye y'amajwi (audio) kuri iri somo.");
    return;
  }
  if (normalizedType === "VIDEO" && !youtubeUrl?.trim()) {
    sendError(res, 422, "Ushyiremo link ya YouTube kuri iri somo rya amashusho.");
    return;
  }
  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }
  if (teacherId) {
    const teacher = await prisma.teacher.findUnique({ where: { id: String(teacherId) } });
    if (!teacher) {
      sendError(res, 422, "Umwarimu watoranyije ntaboneka.");
      return;
    }
  }
  // Adding to a playlist is entirely optional (see the Playlist model
  // comment) only validated when actually provided.
  if (playlistId) {
    const playlist = await prisma.playlist.findUnique({ where: { id: String(playlistId) } });
    if (!playlist) {
      sendError(res, 422, "Playlist yatoranyijwe ntiboneka.");
      return;
    }
  }

  try {
    if (audioUpload) verifySignatureOrThrow("audio", audioUpload.path);
    if (thumbUpload) verifySignatureOrThrow("images", thumbUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const dars = await prisma.dars.create({
    data: {
      title: title.trim(),
      type: normalizedType,
      description: description ? String(description) : "",
      category: category ? String(category).trim() : "",
      thumbnail: thumbUpload ? publicUrlFor("images", thumbUpload.filename) : null,
      audio: audioUpload ? publicUrlFor("audio", audioUpload.filename) : null,
      youtubeUrl: normalizedType === "VIDEO" ? String(youtubeUrl).trim() : null,
      teacherId: teacherId ? String(teacherId) : null,
      playlistId: playlistId ? String(playlistId) : null,
      playlistOrder: Number(playlistOrder) || 0,
      status: "DRAFT",
      createdById: req.user!.id,
    },
    include: { teacher: true, createdBy: true, playlist: true },
  });

  await writeAudit(req.user!.id, "dars.create", null, { title: dars.title, type: dars.type });
  sendResponse(res, 201, publicDars(dars), "Dars yongewe (by'agategenyo).");
});

export const updateDars = asyncHandler(async (req: Request, res: Response) => {
  const dars = await prisma.dars.findUnique({ where: { id: req.params.id } });
  if (!dars) {
    sendError(res, 404, "Iri somo ntiriboneka.");
    return;
  }

  const { title, description, category, youtubeUrl, teacherId, playlistId, playlistOrder, status } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const audioUpload = files?.audio?.[0];
  const thumbUpload = files?.thumbnail?.[0];

  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }
  try {
    if (audioUpload) verifySignatureOrThrow("audio", audioUpload.path);
    if (thumbUpload) verifySignatureOrThrow("images", thumbUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const data: any = { updatedById: req.user!.id };
  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = String(description);
  if (category !== undefined) data.category = String(category).trim();
  if (youtubeUrl !== undefined) data.youtubeUrl = youtubeUrl ? String(youtubeUrl).trim() : null;
  if (teacherId !== undefined) data.teacherId = teacherId ? String(teacherId) : null;
  if (playlistId !== undefined) data.playlistId = playlistId ? String(playlistId) : null;
  if (playlistOrder !== undefined) data.playlistOrder = Number(playlistOrder) || 0;
  if (status !== undefined && ["DRAFT", "PUBLISHED"].includes(String(status))) {
    data.status = status;
    data.publishedAt = status === "PUBLISHED" ? new Date() : null;
  }
  if (audioUpload) {
    deleteUploadedFile(dars.audio);
    data.audio = publicUrlFor("audio", audioUpload.filename);
  }
  if (thumbUpload) {
    deleteUploadedFile(dars.thumbnail);
    data.thumbnail = publicUrlFor("images", thumbUpload.filename);
  }

  const updated = await prisma.dars.update({
    where: { id: dars.id },
    data,
    include: { teacher: true, createdBy: true, playlist: true },
  });
  sendResponse(res, 200, publicDars(updated), "Bikawe.");
});

export const deleteDars = asyncHandler(async (req: Request, res: Response) => {
  const dars = await prisma.dars.findUnique({ where: { id: req.params.id } });
  if (!dars) {
    sendError(res, 404, "Iri somo ntiriboneka.");
    return;
  }
  await prisma.dars.delete({ where: { id: dars.id } });
  deleteUploadedFile(dars.audio);
  deleteUploadedFile(dars.thumbnail);
  await writeAudit(req.user!.id, "dars.delete", null, { title: dars.title });
  sendResponse(res, 200, null, "Dars yasibwe.");
});
