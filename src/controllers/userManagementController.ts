import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { PERMISSION_CATALOG, sanitizePermissions } from "../utils/permissionCatalog.js";
import { endOpenSessions } from "../utils/activity.js";
import { notifyUser } from "../utils/notify.js";
import { getIo } from "../realtime/ioInstance.js";

function publicUser(u: any) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    gender: u.gender,
    kunia: u.kunia,
    role: u.role,
    status: u.status,
    permissions: JSON.parse(u.permissions || "[]"),
    createdAt: u.createdAt,
  };
}

async function writeAudit(actorId: string, actionType: string, targetId: string, meta: Record<string, unknown> = {}) {
  await prisma.auditLog.create({ data: { actorId, actionType, targetId, meta: JSON.stringify(meta) } });
}

/**
 * Tells the target user's own open session(s) to silently re-fetch their
 * profile — so a permission/role change (or a block) is reflected in their
 * UI (sidebar, buttons) within seconds, without forcing a full logout.
 * Backend authorization is already live on every request regardless; this
 * only closes the gap between "the backend already enforces the new rule"
 * and "the browser's sidebar visibly updates to match it".
 */
function pingAccountUpdated(userId: string) {
  getIo()?.to(`user:${userId}`).emit("account:updated");
}

export const getPermissionCatalog = asyncHandler(async (_req: Request, res: Response) => {
  sendResponse(res, 200, PERMISSION_CATALOG);
});

// Whitelisted so `sort` can never become an arbitrary Prisma orderBy field
// from user input — only columns actually shown in the table are sortable.
const SORTABLE_FIELDS = new Set(["fullName", "email", "role", "status", "createdAt"]);

export const listAllUsers = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  // perPage=0 is the "export" escape hatch: return every matching row
  // (capped at 5000) instead of a page, so CSV export reflects the full
  // filtered set, not just what's currently on screen.
  const rawPerPage = Number(req.query.perPage);
  const isExport = rawPerPage === 0;
  const perPage = isExport ? 5000 : Math.min(100, Math.max(1, rawPerPage || 20));
  const search = String(req.query.search ?? "").trim();
  const role = String(req.query.role ?? "").trim();
  const status = String(req.query.status ?? "").trim();
  const sort = SORTABLE_FIELDS.has(String(req.query.sort)) ? String(req.query.sort) : "createdAt";
  const order = req.query.order === "asc" ? "asc" : "desc";

  const where: any = {};
  if (role) where.role = role;
  if (status) where.status = status;
  if (search) {
    where.OR = [{ fullName: { contains: search } }, { email: { contains: search } }];
  }

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { [sort]: order },
      skip: isExport ? undefined : (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, users.map(publicUser), null, {
    total,
    page: isExport ? 1 : page,
    perPage,
    totalPages: isExport ? 1 : Math.ceil(total / perPage) || 1,
  });
});

// Bulk block/unblock, driven by the table's row-selection checkboxes.
// Same guardrails as the single-user endpoints (never touches ADMIN
// accounts), just applied to a list of ids in one request instead of N.
export const bulkUpdateUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const { ids, action } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    sendError(res, 422, "Hitamo nibura umukoresha umwe.");
    return;
  }
  if (!["BLOCK", "UNBLOCK"].includes(action)) {
    sendError(res, 422, "Igikorwa ntikizwi.");
    return;
  }

  const targets = await prisma.user.findMany({ where: { id: { in: ids }, role: { not: "ADMIN" } } });
  const targetIds = targets.map((t) => t.id);
  if (targetIds.length === 0) {
    sendResponse(res, 200, { updated: 0 }, "Nta mukoresha wahinduwe.");
    return;
  }

  if (action === "BLOCK") {
    await prisma.user.updateMany({
      where: { id: { in: targetIds } },
      data: { status: "BLOCKED", tokenVersion: { increment: 1 } },
    });
    await Promise.all(targetIds.map((id) => endOpenSessions(id)));
  } else {
    await prisma.user.updateMany({ where: { id: { in: targetIds } }, data: { status: "ACTIVE" } });
  }

  await Promise.all(
    targetIds.map((id) => writeAudit(req.user!.id, `user.bulk_${action.toLowerCase()}`, id, { via: "bulk" }))
  );
  targetIds.forEach(pingAccountUpdated);

  sendResponse(res, 200, { updated: targetIds.length }, "Byahinduwe neza.");
});

// Promote a STUDENT to LEADER, or demote a LEADER back to STUDENT. Deliberately
// cannot touch ADMIN accounts through this endpoint — creating or modifying
// admins is not exposed in the UI at all, on purpose, to avoid an accidental
// or exploited privilege-escalation path through casual admin-panel clicks.
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { role } = req.body ?? {};

  if (!["STUDENT", "LEADER"].includes(role)) {
    sendError(res, 422, "Uruhare rushobora kuba STUDENT cyangwa LEADER gusa.");
    return;
  }
  if (id === req.user!.id) {
    sendError(res, 422, "Ntushobora guhindura uruhare rwawe ubwawe.");
    return;
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    sendError(res, 404, "Umukoresha ntaboneka.");
    return;
  }
  if (target.role === "ADMIN") {
    sendError(res, 403, "Ntushobora guhindura konti ya Admin.");
    return;
  }

  const data: any = { role };
  // Demoting a leader back to student clears any permissions they held —
  // a fresh promotion later starts from zero, never inherits stale grants.
  if (role === "STUDENT" && target.role === "LEADER") {
    data.permissions = "[]";
  }

  const updated = await prisma.user.update({ where: { id }, data });
  await writeAudit(req.user!.id, "user.role_change", id, { from: target.role, to: role });
  pingAccountUpdated(id);

  await notifyUser({
    userId: id,
    type: "account.role_changed",
    title: role === "LEADER" ? "Wabaye Umuyobozi!" : "Uruhare rwawe rwahindutse",
    body:
      role === "LEADER"
        ? "Ubu ufite uruhare rw'Umuyobozi kuri Kwegereza. Reba uburenganzira wahawe."
        : "Uruhare rwawe rwagarutse kuri Umunyeshuri.",
    url: "/",
    eventKey: `role-change-${id}-${Date.now()}`,
  });

  sendResponse(res, 200, { user: publicUser(updated) }, "Uruhare rwahinduwe neza.");
});

// Set a leader's full permission set in one call — this IS the "assign
// role and permission" capability the spec calls out as admin-exclusive.
export const updateUserPermissions = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    sendError(res, 404, "Umukoresha ntaboneka.");
    return;
  }
  if (target.role !== "LEADER") {
    sendError(res, 422, "Uburenganzira bushobora guhabwa gusa abayobozi (LEADER).");
    return;
  }

  const permissions = sanitizePermissions(req.body?.permissions);
  const updated = await prisma.user.update({
    where: { id },
    data: { permissions: JSON.stringify(permissions) },
  });

  await writeAudit(req.user!.id, "user.permissions_change", id, { permissions });
  pingAccountUpdated(id);

  await notifyUser({
    userId: id,
    type: "account.permissions_changed",
    title: "Uburenganzira bwawe bwahinduwe",
    body: "Ubuyobozi bwahinduye uburenganzira ufite kuri Kwegereza.",
    url: "/",
    eventKey: `permissions-change-${id}-${Date.now()}`,
  });

  sendResponse(res, 200, { user: publicUser(updated) }, "Uburenganzira bwahinduwe neza.");
});

// Generalized block/unblock/reject — works for STUDENT or LEADER, unlike the
// student-only endpoints in studentController. This whole controller is
// mounted behind requireRole("ADMIN"), so no separate permission check is
// needed here: an Admin can always do this, by design.
export const blockAnyUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    sendError(res, 404, "Umukoresha ntaboneka.");
    return;
  }
  if (target.role === "ADMIN") {
    sendError(res, 403, "Ntushobora guhagarika konti ya Admin.");
    return;
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { status: "BLOCKED", tokenVersion: { increment: 1 } },
  });
  await endOpenSessions(id);
  await writeAudit(req.user!.id, "user.block", id, { reason: req.body?.reason ?? null });
  pingAccountUpdated(id);

  sendResponse(res, 200, { user: publicUser(updated) }, "Konti yahagaritswe.");
});

export const unblockAnyUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    sendError(res, 404, "Umukoresha ntaboneka.");
    return;
  }

  const updated = await prisma.user.update({ where: { id }, data: { status: "ACTIVE" } });
  await writeAudit(req.user!.id, "user.unblock", id);
  pingAccountUpdated(id);

  sendResponse(res, 200, { user: publicUser(updated) }, "Konti yasubijwe mu bikorwa.");
});
