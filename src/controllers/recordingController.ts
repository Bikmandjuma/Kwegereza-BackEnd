import type { Request, Response } from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { isAdminTier } from "../utils/permissions.js";

// Deliberately a bare S3Client pointed at whatever endpoint is
// configured, not hardcoded to AWS -- the same client works unchanged
// against real AWS S3, Cloudflare R2, DigitalOcean Spaces, or a
// self-hosted MinIO instance, since all of them speak the S3 API. See
// this project's README for which env vars this needs and why MinIO is
// the realistic free option if there's no cloud storage account already.
const s3 = new S3Client({
  region: process.env.EGRESS_S3_REGION ?? "auto",
  endpoint: process.env.EGRESS_S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.EGRESS_S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.EGRESS_S3_SECRET ?? "",
  },
});
const BUCKET = process.env.EGRESS_S3_BUCKET ?? "";

function publicRecording(r: any) {
  return {
    id: r.id,
    liveClassId: r.liveClassId,
    status: r.status,
    fileSizeBytes: r.fileSizeBytes != null ? r.fileSizeBytes.toString() : null,
    durationSeconds: r.durationSeconds,
    startedByUserId: r.startedByUserId,
    startedByName: r.startedByUser?.fullName,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    downloadable: r.status === "COMPLETE" && !!r.fileKey,
  };
}

/** Host of the class (at the time it was recorded, i.e. whoever started
 * it) or any admin-tier account. Deliberately not "the class's CURRENT
 * host" -- a recording someone started stays theirs to retrieve even if
 * hosting duties for that class later pass to someone else. */
async function canAccessRecording(userId: string, role: string, recording: { startedByUserId: string }) {
  return isAdminTier(role) || recording.startedByUserId === userId;
}

export const listRecordingsForClass = asyncHandler(async (req: Request, res: Response) => {
  const { liveClassId } = req.params;
  const recordings = await prisma.liveClassRecording.findMany({
    where: { liveClassId },
    include: { startedByUser: true },
    orderBy: { startedAt: "desc" },
  });
  const visible = recordings.filter((r) => isAdminTier(req.user!.role) || r.startedByUserId === req.user!.id);
  sendResponse(res, 200, visible.map(publicRecording));
});

/** One recording across ALL classes a host has ever started, for a
 * standing "my recordings" screen -- not scoped to a single class the
 * way listRecordingsForClass is, so a host can come back long after a
 * class ended and still find it (the "download it anytime" part of the
 * spec: nothing here depends on the class, or this server, still being
 * in any particular state). */
export const listMyRecordings = asyncHandler(async (req: Request, res: Response) => {
  const where = isAdminTier(req.user!.role) ? {} : { startedByUserId: req.user!.id };
  const recordings = await prisma.liveClassRecording.findMany({
    where,
    include: { startedByUser: true, liveClass: { select: { title: true } } },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  sendResponse(
    res,
    200,
    recordings.map((r) => ({ ...publicRecording(r), liveClassTitle: r.liveClass.title }))
  );
});

export const getRecordingDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const recording = await prisma.liveClassRecording.findUnique({ where: { id } });
  if (!recording) {
    sendError(res, 404, "Iyi recording ntiboneka.");
    return;
  }
  if (!(await canAccessRecording(req.user!.id, req.user!.role, recording))) {
    sendError(res, 403, "Ntushobora kubona iyi recording.");
    return;
  }
  if (recording.status !== "COMPLETE" || !recording.fileKey) {
    sendError(res, 422, "Iyi recording ntarangiye kwandikwa, ongera ugerageze nyuma.");
    return;
  }
  if (!BUCKET) {
    sendError(res, 500, "Ububiko bwa recording ntibwashyizweho kuri uyu seriveri (EGRESS_S3_BUCKET).");
    return;
  }

  // Generated fresh on every request, expires in one hour -- deliberately
  // never stored anywhere, so a link copy-pasted into chat or shared
  // outside the app stops working on its own rather than staying valid
  // forever.
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: recording.fileKey }),
    { expiresIn: 3600 }
  );
  sendResponse(res, 200, { url, expiresInSeconds: 3600 });
});
