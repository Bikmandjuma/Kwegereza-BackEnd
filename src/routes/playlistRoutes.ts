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
// Same permission that lets someone create Dars in the first place a
// playlist is just an organizing container for Dars, not a separate
// capability someone would have without also being able to create Dars.
router.post("/", requirePermission("dars.create"), createPlaylist);
router.patch("/:id", requirePermission("dars.update"), updatePlaylist);
router.delete("/:id", requirePermission("dars.delete"), deletePlaylist);

export default router;
