import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { sanitizePermissions } from "../utils/permissionCatalog.js";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/; // e.g. SECRETARIAT, ACCOUNTANT, WOMENS_LEADER

function publicRole(r: any) {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    defaultPermissions: JSON.parse(r.defaultPermissions || "[]"),
    isSystem: r.isSystem,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const listRoles = asyncHandler(async (_req: Request, res: Response) => {
  const roles = await prisma.role.findMany({ orderBy: [{ isSystem: "desc" }, { label: "asc" }] });
  sendResponse(res, 200, roles.map(publicRole));
});

export const createRole = asyncHandler(async (req: Request, res: Response) => {
  const { key, label, defaultPermissions } = req.body ?? {};
  const normalizedKey = String(key ?? "").trim().toUpperCase();

  if (!KEY_PATTERN.test(normalizedKey)) {
    sendError(
      res,
      422,
      "Izina ry'uruhare (key) rigomba kuba inyuguti nkuru gusa, imibare, na '_', rigatangira n'inyuguti (urugero: SECRETARIAT)."
    );
    return;
  }
  if (!label?.trim()) {
    sendError(res, 422, "Uzuza izina rigaragara (urugero: Sekeretariya).");
    return;
  }
  if (["STUDENT", "LEADER", "ADMIN", "SUPER_ADMIN"].includes(normalizedKey)) {
    sendError(res, 422, "Iri zina ryafashwe n'imiterere y'urwego rusanzwe.");
    return;
  }

  const existing = await prisma.role.findUnique({ where: { key: normalizedKey } });
  if (existing) {
    sendError(res, 422, "Uru ruhare rusanzwe rubaho.");
    return;
  }

  const role = await prisma.role.create({
    data: {
      key: normalizedKey,
      label: label.trim(),
      defaultPermissions: JSON.stringify(sanitizePermissions(defaultPermissions)),
      isSystem: false,
    },
  });
  sendResponse(res, 201, publicRole(role), "Uruhare rushya rwashyizweho.");
});

export const updateRole = asyncHandler(async (req: Request, res: Response) => {
  const role = await prisma.role.findUnique({ where: { id: req.params.id } });
  if (!role) {
    sendError(res, 404, "Uru ruhare ntirubonetse.");
    return;
  }
  if (role.isSystem) {
    sendError(res, 403, "Ntushobora guhindura uruhare rusanzwe rwa sisitemu.");
    return;
  }

  const { label, defaultPermissions } = req.body ?? {};
  const data: any = {};
  if (label !== undefined) data.label = String(label).trim();
  if (defaultPermissions !== undefined) data.defaultPermissions = JSON.stringify(sanitizePermissions(defaultPermissions));

  const updated = await prisma.role.update({ where: { id: role.id }, data });
  sendResponse(res, 200, publicRole(updated), "Uruhare rwahinduwe.");
});

export const deleteRole = asyncHandler(async (req: Request, res: Response) => {
  const role = await prisma.role.findUnique({ where: { id: req.params.id } });
  if (!role) {
    sendError(res, 404, "Uru ruhare ntirubonetse.");
    return;
  }
  if (role.isSystem) {
    sendError(res, 403, "Ntushobora gusiba uruhare rusanzwe rwa sisitemu.");
    return;
  }
  const holderCount = await prisma.user.count({ where: { role: role.key } });
  if (holderCount > 0) {
    sendError(
      res,
      422,
      `Ntushobora gusiba uru ruhare — hari abakoresha ${holderCount} barufite. Bahindure uruhare mbere.`
    );
    return;
  }
  await prisma.role.delete({ where: { id: role.id } });
  sendResponse(res, 200, null, "Uruhare rwasibwe.");
});
