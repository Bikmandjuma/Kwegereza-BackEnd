import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";

function publicBook(b: any) {
  return {
    id: b.id,
    title: b.title,
    description: b.description,
    author: b.author,
    category: b.category,
    fileUrl: b.fileUrl,
    coverImage: b.coverImage,
    status: b.status,
    downloads: b.downloads,
    publishedAt: b.publishedAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    createdByName: b.createdBy?.fullName,
  };
}

export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 12));
  const search = String(req.query.search ?? "").trim();
  const category = String(req.query.category ?? "").trim();

  const where: any = { status: "PUBLISHED" };
  if (search) where.OR = [{ title: { contains: search } }, { author: { contains: search } }];
  if (category) where.category = category;

  const [total, books] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, books.map(publicBook), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const trackDownload = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book || book.status !== "PUBLISHED") {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }
  const updated = await prisma.book.update({ where: { id: book.id }, data: { downloads: { increment: 1 } } });
  sendResponse(res, 200, { fileUrl: updated.fileUrl, downloads: updated.downloads });
});

export const listAdmin = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();

  const where: any = {};
  if (search) where.OR = [{ title: { contains: search } }, { author: { contains: search } }];
  if (status) where.status = status;

  const [total, books] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      include: { createdBy: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, books.map(publicBook), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const createBook = asyncHandler(async (req: Request, res: Response) => {
  const { title, description, author, category } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const fileUpload = files?.file?.[0];
  const coverUpload = files?.coverImage?.[0];

  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe w'igitabo.");
    return;
  }
  if (!fileUpload) {
    sendError(res, 422, "Ushyiremo idosiye y'igitabo (PDF).");
    return;
  }

  try {
    verifySignatureOrThrow("documents", fileUpload.path);
    if (coverUpload) verifySignatureOrThrow("images", coverUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const book = await prisma.book.create({
    data: {
      title: title.trim(),
      description: description ? String(description) : "",
      author: author ? String(author) : "",
      category: category ? String(category) : "",
      fileUrl: publicUrlFor("documents", fileUpload.filename),
      coverImage: coverUpload ? publicUrlFor("images", coverUpload.filename) : null,
      status: "DRAFT",
      createdById: req.user!.id,
    },
    include: { createdBy: true },
  });

  sendResponse(res, 201, publicBook(book), "Igitabo cyongewe (umushinga).");
});

export const updateBook = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book) {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }

  const { title, description, author, category, status } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const fileUpload = files?.file?.[0];
  const coverUpload = files?.coverImage?.[0];

  try {
    if (fileUpload) verifySignatureOrThrow("documents", fileUpload.path);
    if (coverUpload) verifySignatureOrThrow("images", coverUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const data: any = {};
  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = String(description);
  if (author !== undefined) data.author = String(author);
  if (category !== undefined) data.category = String(category);
  if (status !== undefined && ["DRAFT", "PUBLISHED"].includes(String(status))) {
    data.status = status;
    data.publishedAt = status === "PUBLISHED" ? new Date() : null;
  }
  if (fileUpload) {
    deleteUploadedFile(book.fileUrl);
    data.fileUrl = publicUrlFor("documents", fileUpload.filename);
  }
  if (coverUpload) {
    deleteUploadedFile(book.coverImage);
    data.coverImage = publicUrlFor("images", coverUpload.filename);
  }

  const updated = await prisma.book.update({ where: { id: book.id }, data, include: { createdBy: true } });
  sendResponse(res, 200, publicBook(updated), "Bikawe.");
});

export const deleteBook = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book) {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }
  await prisma.book.delete({ where: { id: book.id } });
  deleteUploadedFile(book.fileUrl);
  deleteUploadedFile(book.coverImage);
  sendResponse(res, 200, null, "Igitabo cyasibwe.");
});
