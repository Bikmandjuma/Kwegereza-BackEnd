import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { isAdminTier } from "../utils/permissions.js";

export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    sendResponse(res, 200, []);
    return;
  }

  const requester = req.user!;
  const where: any = {
    status: "ACTIVE",
    id: { not: requester.id },
    OR: [{ fullName: { contains: q } }, { email: { contains: q } }],
  };

  // The actual fix for "don't let a search surface the other gender to
  // chat with" (see isCrossGenderBlocked in genderScope.ts, which then
  // also rejects starting/sending in that DM as a second layer): a non-
  // admin-tier searcher with a gender on file never even SEES an opposite-
  // gender result here, except an ADMIN/SUPER_ADMIN account, who stays
  // reachable by anyone for support/moderation.
  if (!isAdminTier(requester.role) && requester.gender) {
    const oppositeGender = requester.gender === "MALE" ? "FEMALE" : "MALE";
    where.NOT = { AND: [{ gender: oppositeGender }, { role: { notIn: ["ADMIN", "SUPER_ADMIN"] } }] };
  }

  const users = await prisma.user.findMany({
    where,
    take: 10,
    select: { id: true, fullName: true, role: true, email: true },
  });

  sendResponse(res, 200, users);
});
