import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";

function publicDars(d: any) {
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    description: d.description,
    thumbnail: d.thumbnail,
    status: d.status,
    plays: d.plays,
    audio: d.audio,
    youtubeUrl: d.youtubeUrl,
    teacherId: d.teacherId,
    teacherName: d.teacher?.name,
    publishedAt: d.publishedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    createdByName: d.createdBy?.fullName,
  };
}

export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 12));
  const type = String(req.query.type ?? "").trim().toUpperCase();
  const teacherId = String(req.query.teacherId ?? "").trim();
  const search = String(req.query.search ?? "").trim();

  const where: any = { status: "PUBLISHED" };
  if (type === "AUDIO" || type === "VIDEO") where.type = type;
  if (teacherId) where.teacherId = teacherId;
  if (search) where.OR = [{ title: { contains: search } }, { description: { contains: search } }];

  const [total, darsat] = await Promise.all([
    prisma.dars.count({ where }),
    prisma.dars.findMany({
      where,
      include: { teacher: true },
      orderBy: { publishedAt: "desc" },
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

export const trackPlay = asyncHandler(async (req: Request, res: Response) => {
  const dars = await prisma.dars.findUnique({ where: { id: req.params.id } });
  if (!dars || dars.status !== "PUBLISHED") {
    sendError(res, 404, "Iri somo ntiriboneka.");
    return;
  }
  const updated = await prisma.dars.update({ where: { id: dars.id }, data: { plays: { increment: 1 } } });
  sendResponse(res, 200, { plays: updated.plays });
});

export const listAdmin = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();
  const type = String(req.query.type ?? "").trim().toUpperCase();

  const where: any = {};
  if (search) where.OR = [{ title: { contains: search } }, { description: { contains: search } }];
  if (status) where.status = status;
  if (type === "AUDIO" || type === "VIDEO") where.type = type;

  const [total, darsat] = await Promise.all([
    prisma.dars.count({ where }),
    prisma.dars.findMany({
      where,
      include: { teacher: true, createdBy: true },
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
  const { title, description, type, youtubeUrl, teacherId } = req.body ?? {};
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
    sendError(res, 422, "Ushyiremo idosiye y'ijwi (audio) kuri iri somo.");
    return;
  }
  if (normalizedType === "VIDEO" && !youtubeUrl?.trim()) {
    sendError(res, 422, "Ushyiremo link ya YouTube kuri iri somo rya videwo.");
    return;
  }
  if (teacherId) {
    const teacher = await prisma.teacher.findUnique({ where: { id: String(teacherId) } });
    if (!teacher) {
      sendError(res, 422, "Umwarimu watoranyije ntaboneka.");
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
      thumbnail: thumbUpload ? publicUrlFor("images", thumbUpload.filename) : null,
      audio: audioUpload ? publicUrlFor("audio", audioUpload.filename) : null,
      youtubeUrl: normalizedType === "VIDEO" ? String(youtubeUrl).trim() : null,
      teacherId: teacherId ? String(teacherId) : null,
      status: "DRAFT",
      createdById: req.user!.id,
    },
    include: { teacher: true, createdBy: true },
  });

  sendResponse(res, 201, publicDars(dars), "Dars yongewe (umushinga).");
});

export const updateDars = asyncHandler(async (req: Request, res: Response) => {
  const dars = await prisma.dars.findUnique({ where: { id: req.params.id } });
  if (!dars) {
    sendError(res, 404, "Iri somo ntiriboneka.");
    return;
  }

  const { title, description, youtubeUrl, teacherId, status } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const audioUpload = files?.audio?.[0];
  const thumbUpload = files?.thumbnail?.[0];

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
  if (youtubeUrl !== undefined) data.youtubeUrl = youtubeUrl ? String(youtubeUrl).trim() : null;
  if (teacherId !== undefined) data.teacherId = teacherId ? String(teacherId) : null;
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
    include: { teacher: true, createdBy: true },
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
  sendResponse(res, 200, null, "Dars yasibwe.");
});
