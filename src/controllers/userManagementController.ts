import bcrypt from "bcryptjs";
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
    quranLevel: u.quranLevel,
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

const VALID_GENDERS = new Set(["MALE", "FEMALE"]);

export const getPermissionCatalog = asyncHandler(async (_req: Request, res: Response) => {
  sendResponse(res, 200, PERMISSION_CATALOG);
});

/**
 * The one genuinely new "Super-Admin can add anyone" capability — creates an
 * account directly as ACTIVE, skipping the PENDING approval queue entirely
 * (a super-admin manually creating someone doesn't need to review their own
 * action the way a self-registration does). Can mint STUDENT, LEADER, or
 * ADMIN accounts. Minting another SUPER_ADMIN is deliberately NOT exposed
 * here or anywhere in the API — that stays a seed/direct-database action
 * only, to keep the blast radius of a compromised super-admin session or a
 * UI bug from ever reaching the very top tier.
 */
export const createUserByAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { fullName, email, password, role, gender, phone, kunia, permissions } = req.body ?? {};

  if (!fullName?.trim() || !email?.trim() || !password) {
    sendError(res, 422, "Uzuza amazina, email, n'ijambo ry'ibanga.");
    return;
  }
  const customRoles = await prisma.role.findMany({ where: { isSystem: false }, select: { key: true } });
  const customRoleKeys = customRoles.map((r) => r.key);
  if (!["STUDENT", "LEADER", "ADMIN", ...customRoleKeys].includes(role)) {
    sendError(res, 422, "Uru ruhare ntiruzwi.");
    return;
  }
  if (String(password).length < 6) {
    sendError(res, 422, "Ijambo ry'ibanga rigomba kuba rifite byibura inyuguti 6.");
    return;
  }
  if (gender && !VALID_GENDERS.has(String(gender))) {
    sendError(res, 422, "Igitsina kigomba kuba MALE cyangwa FEMALE.");
    return;
  }
  if ((role === "LEADER" || customRoleKeys.includes(role)) && !gender) {
    sendError(res, 422, "Uyu mukoresha agomba kuba afite igitsina cyagenwe — bikoreshwa mu gucunga abanyeshuri.");
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
  if (existing) {
    sendError(res, 422, "Iyi email isanzwe ifite konti.");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const safePermissions = role === "STUDENT" || role === "ADMIN" ? [] : sanitizePermissions(permissions);

  const user = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      email: String(email).toLowerCase(),
      phone: phone ? String(phone) : null,
      gender: gender ? String(gender) : null,
      kunia: kunia?.trim() ? String(kunia).trim() : null,
      passwordHash,
      role,
      status: "ACTIVE",
      permissions: JSON.stringify(safePermissions),
      approvedById: req.user!.id,
      approvedAt: new Date(),
    },
  });

  await writeAudit(req.user!.id, "user.create_by_super_admin", user.id, { role });

  sendResponse(res, 201, { user: publicUser(user) }, "Umukoresha yashyizweho neza.");
});

// Whitelisted so `sort` can never become an arbitrary Prisma orderBy field
// from user input — only columns actually shown in the table are sortable.
const SORTABLE_FIELDS = new Set(["fullName", "email", "role", "status", "createdAt"]);

export const getUserById = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) {
    sendError(res, 404, "Umukoresha ntaboneka.");
    return;
  }
  sendResponse(res, 200, publicUser(user));
});

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

  const targets = await prisma.user.findMany({
    where: {
      id: { in: ids },
      role: { notIn: req.user!.role === "SUPER_ADMIN" ? ["SUPER_ADMIN"] : ["ADMIN", "SUPER_ADMIN"] },
    },
  });
  const targetIds = targets.map((t) => t.id).filter((tid) => tid !== req.user!.id);
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

// Promote/demote between STUDENT and LEADER (ADMIN actor), or additionally
// to/from ADMIN (SUPER_ADMIN actor only). Nobody can touch a SUPER_ADMIN
// account through this endpoint, and only a SUPER_ADMIN can touch an
// account that currently is — or is becoming — ADMIN.
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { role, permissions: explicitPermissions } = req.body ?? {};
  const actorIsSuperAdmin = req.user!.role === "SUPER_ADMIN";

  // Any non-system custom role (Secretariat, Accountant, Women's Affairs
  // Coordinator, ...) is a valid target the exact same way LEADER is — the
  // Role table is the source of truth for "what custom roles exist", not a
  // hardcoded list here.
  const customRoles = await prisma.role.findMany({ where: { isSystem: false }, select: { key: true, defaultPermissions: true } });
  const customRoleKeys = customRoles.map((r) => r.key);
  const validTargets = actorIsSuperAdmin
    ? ["STUDENT", "LEADER", "ADMIN", ...customRoleKeys]
    : ["STUDENT", "LEADER", ...customRoleKeys];

  if (!validTargets.includes(role)) {
    sendError(
      res,
      422,
      actorIsSuperAdmin
        ? "Uru ruhare ntiruzwi. Reba urutonde rw'uburenganzira rwemewe."
        : "Uru ruhare ntiruzwi, cyangwa rugenwa gusa na Super-Admin."
    );
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
  if (target.role === "SUPER_ADMIN") {
    sendError(res, 403, "Ntushobora guhindura uruhare rwa Super-Admin.");
    return;
  }
  if (target.role === "ADMIN" && !actorIsSuperAdmin) {
    sendError(res, 403, "Ntushobora guhindura konti ya Admin.");
    return;
  }
  const isNonAdminRoleChange = role === "LEADER" || customRoleKeys.includes(role);
  if (isNonAdminRoleChange && !target.gender) {
    sendError(res, 422, "Uyu mukoresha agomba kuba afite igitsina cyagenwe mbere yo guhabwa uru ruhare.");
    return;
  }

  const data: any = { role };
  if (role === "STUDENT" || role === "ADMIN") {
    // STUDENT has no use for a leftover permission list; ADMIN's power is
    // role-based (see hasPermission), not permission-list-based — either
    // way, a stale list here is meaningless noise. Explicit overrides are
    // not honored for these two roles, by design.
    data.permissions = "[]";
  } else if (explicitPermissions !== undefined) {
    // The new combined "assign role + set permissions" flow sends both in
    // one request — honor exactly what was checked, not a role default.
    data.permissions = JSON.stringify(sanitizePermissions(explicitPermissions));
  } else if (role !== target.role) {
    // Switching to a genuinely different role with no explicit permission
    // list given — start from that role's own defaults rather than
    // silently inheriting whatever permissions happened to be left over
    // from an unrelated previous role.
    const roleDefaults = customRoles.find((r) => r.key === role)?.defaultPermissions;
    data.permissions = roleDefaults ?? "[]";
  }

  const updated = await prisma.user.update({ where: { id }, data });
  await writeAudit(req.user!.id, "user.role_change", id, { from: target.role, to: role });
  pingAccountUpdated(id);

  await notifyUser({
    userId: id,
    type: "account.role_changed",
    title: role === "LEADER" ? "Wabaye Umuyobozi!" : role === "ADMIN" ? "Wabaye Admin!" : "Uruhare rwawe rwahindutse",
    body:
      role === "LEADER"
        ? "Ubu ufite uruhare rw'Umuyobozi kuri Kwegereza. Reba uburenganzira wahawe."
        : role === "ADMIN"
        ? "Ubu ufite uruhare rwa Admin kuri Kwegereza."
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

// Generalized block/unblock/reject — works for STUDENT or LEADER, and (for a
// SUPER_ADMIN actor only) ADMIN too. This whole controller is mounted behind
// requireRole("ADMIN", "SUPER_ADMIN"), but a plain ADMIN still can never
// touch another ADMIN or a SUPER_ADMIN account — that extra guard lives here.
export const blockAnyUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (id === req.user!.id) {
    sendError(res, 422, "Ntushobora guhagarika konti yawe ubwawe.");
    return;
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    sendError(res, 404, "Umukoresha ntaboneka.");
    return;
  }
  if (target.role === "SUPER_ADMIN") {
    sendError(res, 403, "Ntushobora guhagarika konti ya Super-Admin.");
    return;
  }
  if (target.role === "ADMIN" && req.user!.role !== "SUPER_ADMIN") {
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
