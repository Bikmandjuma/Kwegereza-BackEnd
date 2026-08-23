import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { sanitizeRichText } from "../utils/sanitize.js";
import { isAdminTier } from "../utils/permissions.js";

const WORDS_PER_MINUTE = 200;

function estimateReadingMinutes(html: string): number {
  const text = html.replace(/<[^>]+>/g, " ");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function publicIfaida(post: any, opts: { includeContent?: boolean } = {}) {
  return {
    id: post.id,
    title: post.title,
    description: post.description,
    category: post.category,
    coverImage: post.coverImage,
    status: post.status,
    publishedAt: post.publishedAt,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    authorId: post.authorId,
    authorName: post.author?.fullName,
    readingMinutes: estimateReadingMinutes(post.content ?? ""),
    ...(opts.includeContent ? { content: post.content } : {}),
  };
}

export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 12));
  const search = String(req.query.search ?? "").trim();

  const where: any = { status: "PUBLISHED" };
  if (search) {
    where.OR = [{ title: { contains: search } }, { description: { contains: search } }];
  }

  const [total, posts] = await Promise.all([
    prisma.ifaida.count({ where }),
    prisma.ifaida.findMany({
      where,
      include: { author: true },
      orderBy: { publishedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, posts.map((p) => publicIfaida(p)), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const getPublished = asyncHandler(async (req: Request, res: Response) => {
  const post = await prisma.ifaida.findUnique({ where: { id: req.params.id }, include: { author: true } });
  if (!post || post.status !== "PUBLISHED") {
    sendError(res, 404, "Iyi nyandiko ntiboneka.");
    return;
  }
  sendResponse(res, 200, publicIfaida(post, { includeContent: true }));
});

export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "").trim();
  const where: any = { authorId: req.user!.id };
  if (status) where.status = status;

  const posts = await prisma.ifaida.findMany({
    where,
    include: { author: true },
    orderBy: { updatedAt: "desc" },
  });
  sendResponse(res, 200, posts.map((p) => publicIfaida(p)));
});

export const getMine = asyncHandler(async (req: Request, res: Response) => {
  const post = await prisma.ifaida.findUnique({ where: { id: req.params.id }, include: { author: true } });
  if (!post) {
    sendError(res, 404, "Iyi nyandiko ntiboneka.");
    return;
  }
  if (post.authorId !== req.user!.id && !isAdminTier(req.user!.role)) {
    sendError(res, 403, "Ntabwo wemerewe kureba iyi nyandiko.");
    return;
  }
  sendResponse(res, 200, publicIfaida(post, { includeContent: true }));
});

export const createIfaida = asyncHandler(async (req: Request, res: Response) => {
  const { title } = req.body ?? {};
  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe w'inyandiko.");
    return;
  }

  const post = await prisma.ifaida.create({
    data: { title: title.trim(), authorId: req.user!.id, status: "DRAFT" },
    include: { author: true },
  });

  sendResponse(res, 201, publicIfaida(post, { includeContent: true }), "Umushinga watangijwe.");
});

export const updateIfaida = asyncHandler(async (req: Request, res: Response) => {
  const post = await prisma.ifaida.findUnique({ where: { id: req.params.id } });
  if (!post) {
    sendError(res, 404, "Iyi nyandiko ntiboneka.");
    return;
  }
  if (post.authorId !== req.user!.id && !isAdminTier(req.user!.role)) {
    sendError(res, 403, "Ntabwo wemerewe guhindura iyi nyandiko.");
    return;
  }

  const { title, description, content, category, coverImage } = req.body ?? {};
  const data: any = {};
  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = String(description);
  if (content !== undefined) data.content = sanitizeRichText(String(content));
  if (category !== undefined) data.category = String(category);
  if (coverImage !== undefined) data.coverImage = coverImage ? String(coverImage) : null;

  const updated = await prisma.ifaida.update({ where: { id: post.id }, data, include: { author: true } });
  sendResponse(res, 200, publicIfaida(updated, { includeContent: true }), "Bikawe.");
});

export const deleteIfaida = asyncHandler(async (req: Request, res: Response) => {
  const post = await prisma.ifaida.findUnique({ where: { id: req.params.id } });
  if (!post) {
    sendError(res, 404, "Iyi nyandiko ntiboneka.");
    return;
  }
  if (post.authorId !== req.user!.id && !isAdminTier(req.user!.role)) {
    sendError(res, 403, "Ntabwo wemerewe gusiba iyi nyandiko.");
    return;
  }
  await prisma.ifaida.delete({ where: { id: post.id } });
  sendResponse(res, 200, null, "Nyandiko yasibwe.");
});

export const publishIfaida = asyncHandler(async (req: Request, res: Response) => {
  const post = await prisma.ifaida.findUnique({ where: { id: req.params.id } });
  if (!post) {
    sendError(res, 404, "Iyi nyandiko ntiboneka.");
    return;
  }
  if (post.authorId !== req.user!.id && !isAdminTier(req.user!.role)) {
    sendError(res, 403, "Ntabwo wemerewe gutangaza iyi nyandiko.");
    return;
  }
  if (!post.content?.trim()) {
    sendError(res, 422, "Ntabwo ushobora gutangaza inyandiko itarimo ibikubiye.");
    return;
  }

  const updated = await prisma.ifaida.update({
    where: { id: post.id },
    data: { status: "PUBLISHED", publishedAt: new Date() },
    include: { author: true },
  });
  sendResponse(res, 200, publicIfaida(updated, { includeContent: true }), "Nyandiko yatangajwe.");
});

export const unpublishIfaida = asyncHandler(async (req: Request, res: Response) => {
  const post = await prisma.ifaida.findUnique({ where: { id: req.params.id } });
  if (!post) {
    sendError(res, 404, "Iyi nyandiko ntiboneka.");
    return;
  }
  if (post.authorId !== req.user!.id && !isAdminTier(req.user!.role)) {
    sendError(res, 403, "Ntabwo wemerewe guhagarika iyi nyandiko.");
    return;
  }

  const updated = await prisma.ifaida.update({
    where: { id: post.id },
    data: { status: "DRAFT" },
    include: { author: true },
  });
  sendResponse(res, 200, publicIfaida(updated, { includeContent: true }), "Nyandiko yahagaritswe kuboneka.");
});
