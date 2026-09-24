import { prisma } from "./prisma.js";

/**
 * One shared place to write an AuditLog row previously duplicated as a
 * local helper inside studentController.ts and userManagementController.ts
 * separately, which meant every OTHER controller (books, dars,
 * announcements, ifaida, auth) had no equivalent and simply never logged
 * anything. Any controller that wants "who did this, and when" recorded
 * calls this one function instead of reinventing the insert.
 *
 * IMPORTANT: `targetId` is a real foreign key to User (see AuditLog in
 * schema.prisma) pass an actual target USER's id, or null. Passing any
 * other entity's id (a playlist, a book, a dars...) throws a foreign-key
 * violation; put identifying info in `meta` instead for those, the same
 * way book.create/dars.create/ifaida.create already do.
 *
 * This never lets a bad audit-log write break the actual operation it's
 * logging: the real action (creating a playlist, blocking a user, ...)
 * already happened in the database by the time this runs, so a failure
 * here is caught and logged as a warning rather than propagating up and
 * turning an operation that actually succeeded into a reported 500 error
 * which previously masked the fact that the underlying action had
 * already gone through, and risked the caller retrying into a duplicate.
 */
export async function writeAudit(
  actorId: string,
  actionType: string,
  targetId?: string | null,
  meta: Record<string, unknown> = {}
) {
  try {
    await prisma.auditLog.create({
      data: { actorId, actionType, targetId: targetId ?? null, meta: JSON.stringify(meta) },
    });
  } catch (err) {
    console.error(`[auditLog] failed to record "${actionType}" (targetId=${targetId ?? "null"}):`, err);
  }
}
