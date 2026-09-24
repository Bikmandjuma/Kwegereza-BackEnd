import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { writeAudit } from "../utils/auditLog.js";
import { longTextError } from "../utils/validateText.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";

function publicPhotoInsight(p: any) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    image: p.image,
    status: p.status,
    createdByName: p.createdBy?.fullName,
    publishedAt: p.publishedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    playlistId: p.playlistId,
  };
}

/**
 * Same guest-locking pattern as Dars and Books: the first 3 this platform
 * ever published (by publishedAt ascending) are free for a guest, no
 * grouping key (photo-insights have no "teacher"/author-scoping concept
 * the way Dars does). Any authenticated user, any role, always sees
 * everything unlocked.
 */
export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 12));
  const search = String(req.query.search ?? "").trim();

  const where: any = { status: "PUBLISHED" };
  if (search) where.title = { contains: search };

  // Locking is decided per-item (see below), and a guest needs to
  // actually SEE what they can open without digging through pages of
  // locked tiles first the old version paginated at the database
  // level by publishedAt alone, so the 3 free (oldest) items could easily
  // sit on a page a guest never reaches if there's more than a page's
  // worth of newer, locked content. Fetching everything matching the
  // filter and paginating in application code, AFTER sorting unlocked
  // first, is what actually fixes that; content volume here is modest
  // enough (an education platform, not millions of rows) that this is
  // simpler and more correct than fighting SQL to express "sort by a
  // status that isn't a real column."
  const all = await prisma.photoInsight.findMany({ where, orderBy: { publishedAt: "desc" } });
  const total = all.length;

  const isAnonymous = !req.user;
  let freeIds = new Set<string>();
  if (isAnonymous) {
    const free = await prisma.photoInsight.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "asc" },
      take: 3,
      select: { id: true },
    });
    freeIds = new Set(free.map((f) => f.id));
  }

  const withLock = all.map((p) => {
    const base = publicPhotoInsight(p);
    if (!isAnonymous || freeIds.has(p.id)) return { ...base, locked: false };
    return { ...base, locked: true, image: null };
  });
  // Stable sort: unlocked first, locked after within each group the
  // original publishedAt-desc order is preserved (Array.sort in modern
  // JS engines is guaranteed stable).
  withLock.sort((a, b) => Number(a.locked) - Number(b.locked));

  const result = withLock.slice((page - 1) * perPage, page * perPage);

  sendResponse(res, 200, result, null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const listAdmin = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();

  const where: any = {};
  if (status) where.status = status;
  if (search) where.title = { contains: search };

  const [total, items] = await Promise.all([
    prisma.photoInsight.count({ where }),
    prisma.photoInsight.findMany({
      where,
      include: { createdBy: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, items.map(publicPhotoInsight), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const createPhotoInsight = asyncHandler(async (req: Request, res: Response) => {
  const { title, description, playlistId, playlistOrder } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const imageUpload = files?.image?.[0];

  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe.");
    return;
  }
  if (!imageUpload) {
    sendError(res, 422, "Ushyiremo ifoto/idosiye.");
    return;
  }
  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }

  try {
    verifySignatureOrThrow("images", imageUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const item = await prisma.photoInsight.create({
    data: {
      title: title.trim(),
      description: description ? String(description) : "",
      image: publicUrlFor("images", imageUpload.filename),
      status: "DRAFT",
      createdById: req.user!.id,
      playlistId: playlistId ? String(playlistId) : null,
      playlistOrder: playlistOrder !== undefined ? Number(playlistOrder) || 0 : 0,
    },
    include: { createdBy: true },
  });

  await writeAudit(req.user!.id, "photoinsight.create", null, { title: item.title });
  sendResponse(res, 201, publicPhotoInsight(item), "Byongewe (by'agategenyo).");
});

export const updatePhotoInsight = asyncHandler(async (req: Request, res: Response) => {
  const item = await prisma.photoInsight.findUnique({ where: { id: req.params.id } });
  if (!item) {
    sendError(res, 404, "Ntibiboneka.");
    return;
  }

  const { title, description, status, playlistId, playlistOrder } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const imageUpload = files?.image?.[0];

  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }
  try {
    if (imageUpload) verifySignatureOrThrow("images", imageUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const data: any = {};
  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = String(description);
  if (status !== undefined && ["DRAFT", "PUBLISHED"].includes(String(status))) {
    data.status = status;
    data.publishedAt = status === "PUBLISHED" ? new Date() : null;
  }
  if (playlistId !== undefined) data.playlistId = playlistId ? String(playlistId) : null;
  if (playlistOrder !== undefined) data.playlistOrder = Number(playlistOrder) || 0;
  if (imageUpload) {
    data.image = publicUrlFor("images", imageUpload.filename);
    deleteUploadedFile(item.image);
  }

  const updated = await prisma.photoInsight.update({ where: { id: item.id }, data, include: { createdBy: true } });
  await writeAudit(req.user!.id, "photoinsight.update", null, { title: updated.title });
  sendResponse(res, 200, publicPhotoInsight(updated), "Byahinduwe.");
});

export const deletePhotoInsight = asyncHandler(async (req: Request, res: Response) => {
  const item = await prisma.photoInsight.findUnique({ where: { id: req.params.id } });
  if (!item) {
    sendError(res, 404, "Ntibiboneka.");
    return;
  }
  await prisma.photoInsight.delete({ where: { id: item.id } });
  deleteUploadedFile(item.image);
  await writeAudit(req.user!.id, "photoinsight.delete", null, { title: item.title });
  sendResponse(res, 200, null, "Byasibwe.");
});
