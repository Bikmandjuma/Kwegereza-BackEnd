export function parsePermissions(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function hasPermission(role: string, permissionsJson: string, permission: string): boolean {
  // Admin is always authoritative — everyone else is permission-driven only.
  if (role === "ADMIN") return true;
  return parsePermissions(permissionsJson).includes(permission);
}
