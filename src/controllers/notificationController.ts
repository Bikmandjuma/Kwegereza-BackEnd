import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";
import { categoryForType, CONFIGURABLE_CATEGORIES } from "../utils/notify.js";

// Bell dropdown: last 30, unread count only — kept exactly as before so the
// bell keeps working with zero changes on that call site.
export const listNotifications = asyncHandler(async (req: Request, res: Response) => {
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.notification.count({ where: { userId: req.user!.id, read: false } }),
  ]);
  sendResponse(res, 200, notifications, null, { unreadCount });
});

// Full Notification Center page: paginated history with a category filter —
// "Ubutumwa" from the spec (Chat/Dars/Ifaida/Live Class/Books/Exams/
// Announcements/Account/System, unread count, read/unread, history).
export const listNotificationHistory = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 20));
  const category = String(req.query.category ?? "").trim().toUpperCase();

  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
  });

  const withCategory = notifications.map((n) => ({
    ...n,
    category: categoryForType(n.type) ?? (n.type.startsWith("account.") ? "ACCOUNT" : "SYSTEM"),
  }));

  const filtered = category ? withCategory.filter((n) => n.category === category) : withCategory;
  const total = filtered.length;
  const start = (page - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);
  const unreadCount = notifications.filter((n) => !n.read).length;

  sendResponse(res, 200, pageRows, null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
    unreadCount,
  });
});

export const getNotificationPreferences = asyncHandler(async (req: Request, res: Response) => {
  const rows = await prisma.notificationPreference.findMany({ where: { userId: req.user!.id } });
  const byCategory: Record<string, { enabled: boolean; push: boolean }> = {};
  for (const category of CONFIGURABLE_CATEGORIES) byCategory[category] = { enabled: true, push: true };
  for (const row of rows) byCategory[row.category] = { enabled: row.enabled, push: row.push };
  sendResponse(res, 200, { categories: byCategory });
});

export const updateNotificationPreferences = asyncHandler(async (req: Request, res: Response) => {
  const { category, enabled, push } = req.body ?? {};
  if (!CONFIGURABLE_CATEGORIES.includes(category)) {
    sendError(res, 422, "Iyi category ntabwo ihindurwa — ni ingenzi ku mutekano wa konti yawe.");
    return;
  }
  const updated = await prisma.notificationPreference.upsert({
    where: { userId_category: { userId: req.user!.id, category } },
    create: {
      userId: req.user!.id,
      category,
      enabled: enabled ?? true,
      push: push ?? true,
    },
    update: {
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof push === "boolean" ? { push } : {}),
    },
  });
  sendResponse(res, 200, updated, "Ihitamo ryawe ryabitswe.");
});

export const markNotificationRead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.userId !== req.user!.id) {
    sendError(res, 404, "Ubutumwa ntaboneka.");
    return;
  }
  const updated = await prisma.notification.update({ where: { id }, data: { read: true } });
  sendResponse(res, 200, updated);
});

export const markAllNotificationsRead = asyncHandler(async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, read: false },
    data: { read: true },
  });
  sendResponse(res, 200, null, "Byose byasomwe.");
});
