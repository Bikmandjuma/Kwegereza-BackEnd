import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { writeAudit } from "../utils/auditLog.js";
import { longTextError } from "../utils/validateText.js";

function playlistThumbnails(p: any): string[] {
  // A handful of REAL thumbnails from whatever's actually in this
  // playlist, across every type it holds Dars uses its own thumbnail
  // (or falls back to nothing for an audio-only Dars with none), Book
  // uses its cover, ifaida its cover, PhotoInsight the photo itself. Only
  // items that published AND that actually have an image contribute; a
  // playlist that's 90% audio-with-no-cover shouldn't render mostly
  // blank tiles when a later item does have a real image.
  const candidates = [
    ...(p.items ?? []).map((d: any) => ({ thumbnail: d.thumbnail, publishedAt: d.publishedAt })),
    ...(p.books ?? []).map((b: any) => ({ thumbnail: b.coverImage, publishedAt: b.publishedAt })),
    ...(p.ifaidaPosts ?? []).map((i: any) => ({ thumbnail: i.coverImage, publishedAt: i.publishedAt })),
    ...(p.photoInsights ?? []).map((ph: any) => ({ thumbnail: ph.image, publishedAt: ph.publishedAt })),
  ];
  return candidates
    .filter((c) => c.thumbnail)
    .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime())
    .slice(0, 4)
    .map((c) => c.thumbnail);
}

function publicPlaylist(p: any) {
  const darsCount = p._count?.items ?? p.items?.length ?? 0;
  const bookCount = p._count?.books ?? p.books?.length ?? 0;
  const ifaidaCount = p._count?.ifaidaPosts ?? p.ifaidaPosts?.length ?? 0;
  const photoInsightCount = p._count?.photoInsights ?? p.photoInsights?.length ?? 0;
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    thumbnail: p.thumbnail,
    itemCount: darsCount + bookCount + ifaidaCount + photoInsightCount,
    darsCount,
    bookCount,
    ifaidaCount,
    photoInsightCount,
    previewThumbnails: playlistThumbnails(p),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Every playlist, with how many items of EVERY type (Dars, Book, ifaida,
 * PhotoInsight combined) are in each used both for public browsing
 * and for the admin "add to playlist" dropdown, since there's nothing in
 * a playlist itself that needs to be hidden from either. Also carries a
 * handful of real thumbnails per playlist (see playlistThumbnails) so
 * the public "browse playlists" grid can render an actual photo collage
 * per playlist rather than a generic icon standing in for it. */
export const listPlaylists = asyncHandler(async (_req: Request, res: Response) => {
  const playlists = await prisma.playlist.findMany({
    include: {
      _count: { select: { items: true, books: true, ifaidaPosts: true, photoInsights: true } },
      items: { where: { status: "PUBLISHED" }, select: { thumbnail: true, publishedAt: true }, take: 6 },
      books: { where: { status: "PUBLISHED" }, select: { coverImage: true, publishedAt: true }, take: 6 },
      ifaidaPosts: { where: { status: "PUBLISHED" }, select: { coverImage: true, publishedAt: true }, take: 6 },
      photoInsights: { where: { status: "PUBLISHED" }, select: { image: true, publishedAt: true }, take: 6 },
    },
    orderBy: { createdAt: "desc" },
  });
  sendResponse(res, 200, playlists.map(publicPlaylist));
});

/** One playlist's PUBLISHED items, ACROSS EVERY CONTENT TYPE it holds,
 * merged into one list and tagged with `contentType` so the frontend can
 * render a single mixed playlist (a video next to a book next to an
 * article) rather than four separate lists. Each type's own
 * playlistOrder still governs its position within that type, and the
 * combined list is then re-sorted so mixed content interleaves by
 * publishedAt rather than grouping strictly by type. Draft items never
 * show here even if they're assigned to this playlist. */
export const getPlaylist = asyncHandler(async (req: Request, res: Response) => {
  const playlist = await prisma.playlist.findUnique({
    where: { id: req.params.id },
    include: {
      items: { where: { status: "PUBLISHED" }, include: { teacher: true }, orderBy: { playlistOrder: "asc" } },
      books: { where: { status: "PUBLISHED" }, orderBy: { playlistOrder: "asc" } },
      ifaidaPosts: { where: { status: "PUBLISHED" }, include: { author: true }, orderBy: { playlistOrder: "asc" } },
      photoInsights: { where: { status: "PUBLISHED" }, orderBy: { playlistOrder: "asc" } },
    },
  });
  if (!playlist) {
    sendError(res, 404, "Iyi playlist ntiboneka.");
    return;
  }

  const darsItems = playlist.items.map((d) => ({
    id: d.id,
    contentType: "DARS",
    title: d.title,
    type: d.type,
    thumbnail: d.thumbnail,
    youtubeUrl: d.youtubeUrl,
    audio: d.audio,
    plays: d.plays,
    teacherName: d.teacher?.name,
    publishedAt: d.publishedAt,
    playlistOrder: d.playlistOrder,
  }));
  const bookItems = playlist.books.map((b) => ({
    id: b.id,
    contentType: "BOOK",
    title: b.title,
    thumbnail: b.coverImage,
    coverImage: b.coverImage,
    description: b.description,
    fileUrl: b.fileUrl,
    author: b.author,
    views: b.views,
    downloads: b.downloads,
    shares: b.shares,
    publishedAt: b.publishedAt,
    playlistOrder: b.playlistOrder,
  }));
  const ifaidaItems = playlist.ifaidaPosts.map((p) => ({
    id: p.id,
    contentType: "ifaida",
    title: p.title,
    thumbnail: p.coverImage,
    authorName: p.author?.fullName,
    publishedAt: p.publishedAt,
    playlistOrder: p.playlistOrder,
  }));
  const photoItems = playlist.photoInsights.map((p) => ({
    id: p.id,
    contentType: "PHOTO_INSIGHT",
    title: p.title,
    thumbnail: p.image,
    description: p.description,
    publishedAt: p.publishedAt,
    playlistOrder: p.playlistOrder,
  }));

  const combined = [...darsItems, ...bookItems, ...ifaidaItems, ...photoItems].sort(
    (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()
  );

  sendResponse(res, 200, { ...publicPlaylist(playlist), items: combined });
});

export const createPlaylist = asyncHandler(async (req: Request, res: Response) => {
  const { title, description, thumbnail } = req.body ?? {};
  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe wa playlist.");
    return;
  }
  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }
  const playlist = await prisma.playlist.create({
    data: {
      title: title.trim(),
      description: description ? String(description) : "",
      thumbnail: thumbnail ? String(thumbnail) : null,
      createdById: req.user!.id,
    },
  });
  // targetId is a foreign key to User specifically (see AuditLog in
  // schema.prisma) a Playlist id there throws a foreign-key violation,
  // exactly like this DID until now. null + identifying info in `meta` is
  // the same pattern every other content-creation audit call already uses
  // (book.create, dars.create, ifaida.create) since none of those have a
  // "target user" either.
  await writeAudit(req.user!.id, "playlist.create", null, { title: playlist.title });
  sendResponse(res, 201, publicPlaylist(playlist), "Playlist yashyizweho.");
});

export const updatePlaylist = asyncHandler(async (req: Request, res: Response) => {
  const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });
  if (!playlist) {
    sendError(res, 404, "Iyi playlist ntiboneka.");
    return;
  }
  const { title, description, thumbnail } = req.body ?? {};
  const descErr = longTextError(description, "Ibisobanuro");
  if (descErr) {
    sendError(res, 422, descErr);
    return;
  }
  const data: any = {};
  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = String(description);
  if (thumbnail !== undefined) data.thumbnail = thumbnail ? String(thumbnail) : null;

  const updated = await prisma.playlist.update({ where: { id: playlist.id }, data });
  sendResponse(res, 200, publicPlaylist(updated), "Playlist yahinduwe.");
});

/** Deleting a playlist never deletes its Dars items the DB foreign key
 * is ON DELETE SET NULL, so every item just becomes un-playlisted again,
 * exactly as if it had never been added to one. */
export const deletePlaylist = asyncHandler(async (req: Request, res: Response) => {
  const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });
  if (!playlist) {
    sendError(res, 404, "Iyi playlist ntiboneka.");
    return;
  }
  await prisma.playlist.delete({ where: { id: playlist.id } });
  await writeAudit(req.user!.id, "playlist.delete", null, { title: playlist.title });
  sendResponse(res, 200, null, "Playlist yasibwe.");
});
