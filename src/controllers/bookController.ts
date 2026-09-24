import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";
import { longTextError } from "../utils/validateText.js";
import { writeAudit } from "../utils/auditLog.js";

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
    views: b.views,
    shares: b.shares,
    publishedAt: b.publishedAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    createdByName: b.createdBy?.fullName,
    playlistId: b.playlistId,
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

  // Fetch everything matching, not a DB-level page see the identical
  // comment in photoInsightController.ts's listPublished for why: a guest
  // needs the 3 unlocked books to actually surface where they'll see
  // them, and DB-level pagination by publishedAt alone could easily bury
  // the free (oldest) 3 on a later page they never reach.
  const all = await prisma.book.findMany({ where, orderBy: { publishedAt: "desc" } });
  const total = all.length;

  // Same guest-locking mechanism as Dars, but books have no "teacher" to
  // group by, so the free set is simply the first 3 books this platform
  // ever published (by publishedAt ascending, so it's stable over time
  // rather than shifting every time a new book is added) not the first
  // 3 of THIS page. Any authenticated user, any role, always sees
  // everything unlocked, exactly like Dars.
  const isAnonymous = !req.user;
  let freeIds = new Set<string>();
  if (isAnonymous) {
    const freeBooks = await prisma.book.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "asc" },
      take: 3,
      select: { id: true },
    });
    freeIds = new Set(freeBooks.map((b) => b.id));
  }

  const withLock = all.map((b) => {
    const base = publicBook(b);
    if (!isAnonymous || freeIds.has(b.id)) return { ...base, locked: false };
    return { ...base, locked: true, fileUrl: null };
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

export const trackDownload = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book || book.status !== "PUBLISHED") {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }
  const updated = await prisma.book.update({ where: { id: book.id }, data: { downloads: { increment: 1 } } });
  if (req.user) {
    await prisma.bookActivityEvent.create({ data: { bookId: book.id, userId: req.user.id, type: "DOWNLOAD" } });
  }
  sendResponse(res, 200, { fileUrl: updated.fileUrl, downloads: updated.downloads });
});

/** Fired once when the in-browser reader opens a book a distinct signal
 * from downloading the raw file, same distinction Dars already makes
 * between "plays" and nothing else needing a download at all. */
export const trackView = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book || book.status !== "PUBLISHED") {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }
  const updated = await prisma.book.update({ where: { id: book.id }, data: { views: { increment: 1 } } });
  if (req.user) {
    await prisma.bookActivityEvent.create({ data: { bookId: book.id, userId: req.user.id, type: "VIEW" } });
  }
  sendResponse(res, 200, { views: updated.views });
});

export const trackShare = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book || book.status !== "PUBLISHED") {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }
  const updated = await prisma.book.update({ where: { id: book.id }, data: { shares: { increment: 1 } } });
  if (req.user) {
    await prisma.bookActivityEvent.create({ data: { bookId: book.id, userId: req.user.id, type: "SHARE" } });
  }
  sendResponse(res, 200, { shares: updated.shares });
});

/**
 * Per-user activity for one book who viewed/downloaded/shared it, how
 * many times each, and when they last did. Grouped in application code,
 * same as Dars's listWatchers: an admin wants "Fatima downloaded this
 * twice and viewed it once", not a raw event dump.
 */
export const listReaders = asyncHandler(async (req: Request, res: Response) => {
  const bookId = req.params.id;
  const book = await prisma.book.findUnique({ where: { id: bookId } });
  if (!book) {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }

  const events = await prisma.bookActivityEvent.findMany({
    where: { bookId },
    include: { user: true },
    orderBy: { createdAt: "desc" },
  });

  const byUser = new Map<
    string,
    { userId: string; fullName: string; email: string; views: number; downloads: number; shares: number; lastActivityAt: Date }
  >();
  for (const e of events) {
    const existing = byUser.get(e.userId);
    const bump = { views: 0, downloads: 0, shares: 0 };
    if (e.type === "VIEW") bump.views = 1;
    else if (e.type === "DOWNLOAD") bump.downloads = 1;
    else if (e.type === "SHARE") bump.shares = 1;

    if (existing) {
      existing.views += bump.views;
      existing.downloads += bump.downloads;
      existing.shares += bump.shares;
      if (e.createdAt > existing.lastActivityAt) existing.lastActivityAt = e.createdAt;
    } else {
      byUser.set(e.userId, {
        userId: e.userId,
        fullName: e.user.fullName,
        email: e.user.email,
        ...bump,
        lastActivityAt: e.createdAt,
      });
    }
  }

  const readers = Array.from(byUser.values()).sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  const loggedInViews = events.filter((e) => e.type === "VIEW").length;
  const loggedInDownloads = events.filter((e) => e.type === "DOWNLOAD").length;
  const loggedInShares = events.filter((e) => e.type === "SHARE").length;

  sendResponse(res, 200, {
    totalViews: book.views,
    totalDownloads: book.downloads,
    totalShares: book.shares,
    guestViews: Math.max(0, book.views - loggedInViews),
    guestDownloads: Math.max(0, book.downloads - loggedInDownloads),
    guestShares: Math.max(0, book.shares - loggedInShares),
    readers,
  });
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
  const { title, description, author, category, playlistId, playlistOrder } = req.body ?? {};
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
  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
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
      playlistId: playlistId ? String(playlistId) : null,
      playlistOrder: playlistOrder !== undefined ? Number(playlistOrder) || 0 : 0,
    },
    include: { createdBy: true },
  });

  await writeAudit(req.user!.id, "book.create", null, { title: book.title });
  sendResponse(res, 201, publicBook(book), "Igitabo cyongewe (by'agategenyo).");
});

export const updateBook = asyncHandler(async (req: Request, res: Response) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book) {
    sendError(res, 404, "Iki gitabo ntikiboneka.");
    return;
  }

  const { title, description, author, category, status, playlistId, playlistOrder } = req.body ?? {};
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const fileUpload = files?.file?.[0];
  const coverUpload = files?.coverImage?.[0];

  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }
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
  if (playlistId !== undefined) data.playlistId = playlistId ? String(playlistId) : null;
  if (playlistOrder !== undefined) data.playlistOrder = Number(playlistOrder) || 0;
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
  await writeAudit(req.user!.id, "book.delete", null, { title: book.title });
  sendResponse(res, 200, null, "Igitabo cyasibwe.");
});
