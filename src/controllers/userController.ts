import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";

export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    sendResponse(res, 200, []);
    return;
  }

  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      id: { not: req.user!.id },
      OR: [{ fullName: { contains: q } }, { email: { contains: q } }],
    },
    take: 10,
    select: { id: true, fullName: true, role: true, email: true },
  });

  sendResponse(res, 200, users);
});
