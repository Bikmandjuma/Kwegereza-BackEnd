import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { notifyUser } from "../utils/notify.js";
import { endOpenSessions } from "../utils/activity.js";

function publicUser(user: any) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    approvedAt: user.approvedAt,
    createdAt: user.createdAt,
  };
}

async function writeAudit(actorId: string, actionType: string, targetId: string, meta: Record<string, unknown> = {}) {
  await prisma.auditLog.create({
    data: { actorId, actionType, targetId, meta: JSON.stringify(meta) },
  });
}

// GET /api/students — full table-standard listing: search, status filter, pagination.
export const listStudents = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();

  const where: any = { role: "STUDENT" };
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { fullName: { contains: search } },
      { email: { contains: search } },
    ];
  }

  const [total, students] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(
    res,
    200,
    students.map(publicUser),
    null,
    { total, page, perPage, totalPages: Math.ceil(total / perPage) || 1 }
  );
});

// GET /api/students/pending — "Abanyeshuri Bategereje Kwemezwa"
export const listPendingStudents = asyncHandler(async (req: Request, res: Response) => {
  const search = String(req.query.search ?? "").trim();
  const where: any = { role: "STUDENT", status: "PENDING" };
  if (search) {
    where.OR = [
      { fullName: { contains: search } },
      { email: { contains: search } },
    ];
  }
  const [total, students] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: "asc" } }),
  ]);
  sendResponse(res, 200, students.map(publicUser), null, { total });
});

// GET /api/students/:id — "REBA": full detail view for one student.
export const getStudentDetail = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({
    where: { id },
    include: { approvedBy: true },
  });
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umunyeshuri ntaboneka.");
    return;
  }
  sendResponse(res, 200, {
    ...publicUser(student),
    approvedByName: student.approvedBy?.fullName ?? null,
  });
});

export const approveStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({ where: { id } });
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umunyeshuri ntabwo aboneka.");
    return;
  }
  if (student.status !== "PENDING") {
    sendError(res, 422, "Uyu munyeshuri ntagitegereje kwemezwa.");
    return;
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE", approvedById: req.user!.id, approvedAt: new Date() },
  });

  await writeAudit(req.user!.id, "student.approve", id);

  // eventKey uses the target's id + the exact approval timestamp — unique
  // per real approval action, but any duplicate CALL of this same action
  // (retry, double-click before the button disabled) collapses to one row.
  await notifyUser({
    userId: id,
    type: "account.approved",
    title: "Konti yawe yemejwe!",
    body: "Ubu ushobora kwinjira kandi ukoreshe Kwegereza byuzuye.",
    url: "/",
    eventKey: `account-approved-${id}-${updated.approvedAt!.getTime()}`,
  });

  sendResponse(res, 200, { user: publicUser(updated) }, "Umunyeshuri yemejwe neza.");
});

export const rejectStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({ where: { id } });
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umunyeshuri ntabwo aboneka.");
    return;
  }
  const updated = await prisma.user.update({
    where: { id },
    data: { status: "REJECTED", tokenVersion: { increment: 1 } },
  });
  await endOpenSessions(id);
  await writeAudit(req.user!.id, "student.reject", id, { reason: req.body?.reason ?? null });
  sendResponse(res, 200, { user: publicUser(updated) }, "Ubusabe bwanze.");
});

export const blockStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({ where: { id } });
  if (!student) {
    sendError(res, 404, "Umukoresha ntabwo aboneka.");
    return;
  }
  // tokenVersion bump = every existing session for this user is invalid on their
  // very next request, regardless of which device/browser issued the token.
  const updated = await prisma.user.update({
    where: { id },
    data: { status: "BLOCKED", tokenVersion: { increment: 1 } },
  });
  await endOpenSessions(id);
  await writeAudit(req.user!.id, "student.block", id, { reason: req.body?.reason ?? null });
  sendResponse(res, 200, { user: publicUser(updated) }, "Konti yahagaritswe.");
});

export const unblockStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({ where: { id } });
  if (!student) {
    sendError(res, 404, "Umukoresha ntabwo aboneka.");
    return;
  }
  const updated = await prisma.user.update({
    where: { id },
    data: { status: "ACTIVE" },
  });
  await writeAudit(req.user!.id, "student.unblock", id);
  sendResponse(res, 200, { user: publicUser(updated) }, "Konti yasubijwe mu bikorwa.");
});
