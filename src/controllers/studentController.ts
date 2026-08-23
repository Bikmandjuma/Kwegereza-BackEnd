import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { notifyUser } from "../utils/notify.js";
import { endOpenSessions } from "../utils/activity.js";
import { sendEmail } from "../utils/email.js";
import { approvalEmail } from "../utils/emailTemplates.js";
import { getFrontendUrl } from "../utils/email.js";

function publicUser(user: any) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    gender: user.gender,
    role: user.role,
    status: user.status,
    approvedAt: user.approvedAt,
    createdAt: user.createdAt,
  };
}

/**
 * A LEADER whose own gender is set only sees/manages students of the same
 * gender ("a female leader manages female students, a male leader manages
 * male students" — per spec). A LEADER with no gender set yet keeps today's
 * behavior (sees everyone) rather than silently locking them out of
 * students they were already managing — this is opt-in enforcement, not a
 * retroactive lockout, so an admin can set the leader's gender whenever is
 * convenient without an outage in between. ADMIN/SUPER_ADMIN are never
 * gender-scoped; they oversee both.
 */
function genderScopeWhere(actor: { role: string; gender: string | null }) {
  if (actor.role === "LEADER" && actor.gender) {
    return { gender: actor.gender };
  }
  return {};
}

/** True if a LEADER actor is blocked from a specific target by gender scope. */
function isOutOfGenderScope(actor: { role: string; gender: string | null }, target: { gender: string | null }) {
  return actor.role === "LEADER" && Boolean(actor.gender) && target.gender !== actor.gender;
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

  const where: any = { role: "STUDENT", ...genderScopeWhere(req.user!) };
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
  const where: any = { role: "STUDENT", status: "PENDING", ...genderScopeWhere(req.user!) };
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
  if (isOutOfGenderScope(req.user!, student)) {
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
  if (isOutOfGenderScope(req.user!, student)) {
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

  // Fire-and-forget — a failed/unconfigured email must never block the
  // approval itself (in-app + push notification above already succeeded).
  const { subject, html } = approvalEmail(updated.fullName, `${getFrontendUrl()}/login`);
  sendEmail({ to: updated.email, subject, html }).catch((err) =>
    console.error("[studentController] approval email failed:", err)
  );

  sendResponse(res, 200, { user: publicUser(updated) }, "Umunyeshuri yemejwe neza.");
});

export const rejectStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const student = await prisma.user.findUnique({ where: { id } });
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umunyeshuri ntabwo aboneka.");
    return;
  }
  if (isOutOfGenderScope(req.user!, student)) {
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
  // BUG FIX: this endpoint previously had no role check at all — a LEADER
  // holding only the narrow `student.block` permission could call it against
  // ANY user id, including an ADMIN's, and lock them out (tokenVersion bump
  // + forced session end). Scoping to STUDENT targets closes that privilege
  // escalation path, matching every sibling function in this file.
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umukoresha ntabwo aboneka.");
    return;
  }
  if (isOutOfGenderScope(req.user!, student)) {
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
  if (!student || student.role !== "STUDENT") {
    sendError(res, 404, "Umukoresha ntabwo aboneka.");
    return;
  }
  if (isOutOfGenderScope(req.user!, student)) {
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
