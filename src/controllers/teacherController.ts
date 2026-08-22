import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { deleteUploadedFile, publicUrlFor, verifySignatureOrThrow } from "../utils/storage.js";

/** Every count here is real — grouped straight from the Dars table, not estimated. */
export const listPublic = asyncHandler(async (_req: Request, res: Response) => {
  const [teachers, counts] = await Promise.all([
    prisma.teacher.findMany({ orderBy: { name: "asc" } }),
    prisma.dars.groupBy({
      by: ["teacherId", "type"],
      where: { status: "PUBLISHED", teacherId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const countMap = new Map<string, { audio: number; video: number }>();
  for (const c of counts) {
    if (!c.teacherId) continue;
    const entry = countMap.get(c.teacherId) ?? { audio: 0, video: 0 };
    if (c.type === "AUDIO") entry.audio = c._count._all;
    if (c.type === "VIDEO") entry.video = c._count._all;
    countMap.set(c.teacherId, entry);
  }

  sendResponse(
    res,
    200,
    teachers.map((t) => ({
      id: t.id,
      name: t.name,
      kunia: t.kunia,
      role: t.role,
      bio: t.bio,
      photo: t.photo,
      audioCount: countMap.get(t.id)?.audio ?? 0,
      videoCount: countMap.get(t.id)?.video ?? 0,
    }))
  );
});

export const getPublicOne = asyncHandler(async (req: Request, res: Response) => {
  const teacher = await prisma.teacher.findUnique({ where: { id: req.params.id } });
  if (!teacher) {
    sendError(res, 404, "Uyu mwarimu ntaboneka.");
    return;
  }
  sendResponse(res, 200, teacher);
});

export const listAdmin = asyncHandler(async (_req: Request, res: Response) => {
  const teachers = await prisma.teacher.findMany({ orderBy: { name: "asc" } });
  sendResponse(res, 200, teachers);
});

export const createTeacher = asyncHandler(async (req: Request, res: Response) => {
  const { name, kunia, role, bio } = req.body ?? {};
  const photoUpload = (req.files as Record<string, Express.Multer.File[]> | undefined)?.photo?.[0];

  if (!name?.trim()) {
    sendError(res, 422, "Uzuza amazina y'umwarimu.");
    return;
  }
  try {
    if (photoUpload) verifySignatureOrThrow("images", photoUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const teacher = await prisma.teacher.create({
    data: {
      name: name.trim(),
      kunia: kunia ? String(kunia) : null,
      role: role ? String(role) : "",
      bio: bio ? String(bio) : "",
      photo: photoUpload ? publicUrlFor("images", photoUpload.filename) : null,
    },
  });
  sendResponse(res, 201, teacher, "Umwarimu yongewe.");
});

export const updateTeacher = asyncHandler(async (req: Request, res: Response) => {
  const teacher = await prisma.teacher.findUnique({ where: { id: req.params.id } });
  if (!teacher) {
    sendError(res, 404, "Uyu mwarimu ntaboneka.");
    return;
  }

  const { name, kunia, role, bio } = req.body ?? {};
  const photoUpload = (req.files as Record<string, Express.Multer.File[]> | undefined)?.photo?.[0];
  try {
    if (photoUpload) verifySignatureOrThrow("images", photoUpload.path);
  } catch (err: any) {
    sendError(res, 422, err.message);
    return;
  }

  const data: any = {};
  if (name !== undefined) data.name = String(name).trim();
  if (kunia !== undefined) data.kunia = kunia ? String(kunia) : null;
  if (role !== undefined) data.role = String(role);
  if (bio !== undefined) data.bio = String(bio);
  if (photoUpload) {
    deleteUploadedFile(teacher.photo);
    data.photo = publicUrlFor("images", photoUpload.filename);
  }

  const updated = await prisma.teacher.update({ where: { id: teacher.id }, data });
  sendResponse(res, 200, updated, "Bikawe.");
});

export const deleteTeacher = asyncHandler(async (req: Request, res: Response) => {
  const teacher = await prisma.teacher.findUnique({ where: { id: req.params.id } });
  if (!teacher) {
    sendError(res, 404, "Uyu mwarimu ntaboneka.");
    return;
  }
  const darsCount = await prisma.dars.count({ where: { teacherId: teacher.id } });
  if (darsCount > 0) {
    sendError(res, 422, `Ntushobora gusiba uyu mwarimu — afite Dars ${darsCount} zimuhuje. Zimure cyangwa uzisibe mbere.`);
    return;
  }
  await prisma.teacher.delete({ where: { id: teacher.id } });
  deleteUploadedFile(teacher.photo);
  sendResponse(res, 200, null, "Umwarimu yasibwe.");
});
