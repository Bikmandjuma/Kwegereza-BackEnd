export function parsePermissions(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function hasPermission(role: string, permissionsJson: string, permission: string): boolean {
  // Both admin tiers are always authoritative — everyone else (LEADER) is
  // permission-driven only. SUPER_ADMIN sits above ADMIN (can manage ADMIN
  // accounts themselves — see userManagementController) but has identical
  // blanket access to every permission-gated feature.
  if (role === "ADMIN" || role === "SUPER_ADMIN") return true;
  return parsePermissions(permissionsJson).includes(permission);
}

/** Shared by any controller that needs an "author/host, OR admin-tier
 * override" check — the single place that defines what "admin-tier" means. */
export function isAdminTier(role: string): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}
