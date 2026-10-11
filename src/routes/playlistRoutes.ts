import { Router } from "express";
import {
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  updatePlaylist,
} from "../controllers/playlistController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

const router = Router();

// Browsing playlists is public, same as browsing Dars itself.
router.get("/", listPlaylists);
router.get("/:id", getPlaylist);

router.use(authenticate);
// Its own dedicated permission (see permissionCatalog.ts) -- NOT
// dars.create/update/delete. A playlist can just as easily hold books,
// ifaida posts, or photo insights as Dars, so gating every playlist
// operation on a Dars-specific permission (the previous design) meant
// a book-only, ifaida-only, or photo-insight-only leader could never
// manage a playlist at all, even one made entirely of their own
// content type. backfillPlaylistPermission.ts is what preserves this
// for anyone who already had one of the old content permissions.
router.post("/", requirePermission("playlist.manage"), createPlaylist);
router.patch("/:id", requirePermission("playlist.manage"), updatePlaylist);
router.delete("/:id", requirePermission("playlist.manage"), deletePlaylist);

export default router;
