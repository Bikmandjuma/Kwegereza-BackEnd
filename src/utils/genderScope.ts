import { isAdminTier } from "./permissions.js";

/**
 * Gender-scoping is a property of the ROLE TIER, not one specific role
 * name any non-admin-tier role (LEADER, or a brand new custom role an
 * admin creates, e.g. "Women's Affairs Coordinator") gets the exact same
 * behavior automatically: set your own gender, and you only see/manage
 * students of that gender. A non-admin-tier actor with no gender set yet
 * keeps today's behavior (sees everyone) rather than silently locking them
 * out of students they were already managing opt-in enforcement, not a
 * retroactive lockout. ADMIN/SUPER_ADMIN are never gender-scoped.
 *
 * Shared by studentController.ts (who a supervisor can view/approve/block)
 * and chatController.ts (who a supervisor can open a 1:1 chat with) --
 * the same rule, enforced everywhere a supervisor could otherwise reach a
 * specific person, not just in the student-management screens.
 */
export function genderScopeWhere(actor: { role: string; gender: string | null }) {
  if (!isAdminTier(actor.role) && actor.gender) {
    return { gender: actor.gender };
  }
  return {};
}

/** True if a non-admin-tier actor is blocked from a specific target by gender scope. */
export function isOutOfGenderScope(actor: { role: string; gender: string | null }, target: { gender: string | null }) {
  return !isAdminTier(actor.role) && Boolean(actor.gender) && target.gender !== actor.gender;
}

/**
 * Symmetric version for direct messages: unlike student management (always
 * actor -> STUDENT), a chat DM has two ordinary users on either side, and
 * either one could be the "supervisor" here. Blocked only when BOTH sides
 * are non-admin-tier and BOTH have a gender set and those genders differ --
 * an ADMIN/SUPER_ADMIN on either end stays reachable (moderation, support),
 * and a user with no gender recorded never gets silently locked out.
 */
export function isCrossGenderBlocked(
  userA: { role: string; gender: string | null },
  userB: { role: string; gender: string | null }
): boolean {
  if (isAdminTier(userA.role) || isAdminTier(userB.role)) return false;
  if (!userA.gender || !userB.gender) return false;
  return userA.gender !== userB.gender;
}
