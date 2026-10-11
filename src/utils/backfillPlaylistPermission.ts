import { prisma } from "./prisma.js";

// Any permission that already meant "this role/user can create or
// manage SOME kind of playlist-eligible content" under the old,
// mistaken design (playlist routes gated on dars.* alone, even though
// a playlist can hold Dars, books, ifaida posts, or photo insights).
const CONTENT_PERMISSIONS = [
  "dars.create",
  "dars.update",
  "dars.delete",
  "book.create",
  "book.update",
  "book.delete",
  "ifaida.create",
  "ifaida.update",
  "ifaida.delete",
  "photoinsight.create",
  "photoinsight.update",
  "photoinsight.delete",
];

function parsePermissions(json: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(json ?? "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Playlist management moves from being gated on dars.create/update/
 * delete specifically to its own dedicated "playlist.manage"
 * permission (see playlistRoutes.ts) -- correct given a playlist is
 * just as often a container for books, ifaida posts, or photo
 * insights as for Dars, and the old gating silently blocked a
 * book-only (or ifaida-only, or photo-insight-only) leader from ever
 * managing a playlist at all.
 *
 * This backfill is what keeps that change from being a silent
 * regression for anyone who could ALREADY manage playlists under the
 * old rule: any role or user holding any one of the permissions above
 * gets playlist.manage added alongside it. Runs on every server boot,
 * deliberately -- once every eligible row already has the permission,
 * every check below is a no-op (parsePermissions + an array include
 * check, nothing written), so repeating it costs nothing and there is
 * no separate one-time migration step to remember to run.
 */
export async function backfillPlaylistManagePermission(): Promise<void> {
  try {
    const roles = await prisma.role.findMany();
    for (const role of roles) {
      const perms = parsePermissions(role.defaultPermissions);
      if (perms.includes("playlist.manage") || !perms.some((p) => CONTENT_PERMISSIONS.includes(p))) continue;
      await prisma.role.update({
        where: { id: role.id },
        data: { defaultPermissions: JSON.stringify([...perms, "playlist.manage"]) },
      });
    }

    // ADMIN/SUPER_ADMIN bypass permission checks entirely by role (see
    // hasPermission) -- backfilling their stored permissions array
    // would be harmless but genuinely pointless, so they're excluded.
    const users = await prisma.user.findMany({ where: { role: { notIn: ["ADMIN", "SUPER_ADMIN"] } } });
    for (const user of users) {
      const perms = parsePermissions(user.permissions);
      if (perms.includes("playlist.manage") || !perms.some((p) => CONTENT_PERMISSIONS.includes(p))) continue;
      await prisma.user.update({
        where: { id: user.id },
        data: { permissions: JSON.stringify([...perms, "playlist.manage"]) },
      });
    }
  } catch (err) {
    // Never block server startup over this -- worst case, playlist
    // management for a legacy role/user waits until the next boot to
    // self-correct, which is far better than the API failing to start.
    console.error("[backfillPlaylistManagePermission] failed:", err);
  }
}
