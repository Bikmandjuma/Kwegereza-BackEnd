import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";

function publicAnnouncement(a: any) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    coverImage: a.coverImage,
    status: a.status,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt,
    authorName: a.author?.fullName,
  };
}

export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 10));

  const where = { status: "PUBLISHED" };
  const [total, items] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      include: { author: true },
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, items.map(publicAnnouncement), null, {
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
  if (search) where.title = { contains: search };
  if (status) where.status = status;

  const [total, items] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      include: { author: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, items.map(publicAnnouncement), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const createAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const { title, body } = req.body ?? {};
  const coverUpload = (req.files as Record<string, Express.Multer.File[]> | undefined)?.coverImage?.[0];

  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe w'itangazo.");
    return;
  }
  try {
    if (coverUpload) verifySignatureOrThrow("images", coverUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const item = await prisma.announcement.create({
    data: {
      title: title.trim(),
      body: body ? String(body) : "",
      coverImage: coverUpload ? publicUrlFor("images", coverUpload.filename) : null,
      status: "DRAFT",
      authorId: req.user!.id,
    },
    include: { author: true },
  });

  sendResponse(res, 201, publicAnnouncement(item), "Itangazo ryongewe (umushinga).");
});

export const updateAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const item = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!item) {
    sendError(res, 404, "Iri tangazo ntiriboneka.");
    return;
  }

  const { title, body, status } = req.body ?? {};
  const coverUpload = (req.files as Record<string, Express.Multer.File[]> | undefined)?.coverImage?.[0];
  try {
    if (coverUpload) verifySignatureOrThrow("images", coverUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const data: any = {};
  if (title !== undefined) data.title = String(title).trim();
  if (body !== undefined) data.body = String(body);
  if (status !== undefined && ["DRAFT", "PUBLISHED"].includes(String(status))) {
    data.status = status;
    data.publishedAt = status === "PUBLISHED" ? new Date() : null;
  }
  if (coverUpload) {
    deleteUploadedFile(item.coverImage);
    data.coverImage = publicUrlFor("images", coverUpload.filename);
  }

  const updated = await prisma.announcement.update({ where: { id: item.id }, data, include: { author: true } });
  sendResponse(res, 200, publicAnnouncement(updated), "Bikawe.");
});

export const deleteAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const item = await prisma.announcement.findUnique({ where: { id: req.params.id } });
  if (!item) {
    sendError(res, 404, "Iri tangazo ntiriboneka.");
    return;
  }
  await prisma.announcement.delete({ where: { id: item.id } });
  deleteUploadedFile(item.coverImage);
  sendResponse(res, 200, null, "Itangazo ryasibwe.");
});
