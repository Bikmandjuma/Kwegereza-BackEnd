import { Router } from "express";
import {
  createDars,
  deleteDars,
  listAdmin,
  listCategories,
  listPublished,
  listWatchers,
  trackPlay,
  updateDars,
  updateWatchTime,
} from "../controllers/darsController.js";
import { authenticate, optionalAuthenticate, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ audio: "audio", thumbnail: "images" });

router.get("/published", optionalAuthenticate, listPublished);
router.get("/categories", listCategories);
// optionalAuthenticate, not authenticate: anonymous/preview plays must
// keep working, but a logged-in caller's identity is what backs the
// per-user "who watched this" list below.
router.post("/:id/play", optionalAuthenticate, trackPlay);
// Reporting watch time requires being identified (it updates a specific
// play event that belongs to this user) real authenticate, not optional.
router.patch("/play-events/:eventId/watch-time", authenticate, updateWatchTime);

router.use(authenticate);

router.get("/", requirePermission("dars.view"), listAdmin);
// "Who watched this" is media analytics, not just Dars management a
// leader could have dars.view (see the list) without analytics.media (see
// per-user watch history), and vice versa a super-admin could grant just
// analytics access to someone who never touches Dars content itself.
router.get("/:id/watchers", requirePermission("analytics.media"), listWatchers);
router.post("/", requirePermission("dars.create"), upload, createDars);
router.patch("/:id", requirePermission("dars.update"), upload, updateDars);
router.delete("/:id", requirePermission("dars.delete"), deleteDars);
router.post("/:id/publish", requirePermission("dars.publish"), (req, res, next) => {
  req.body = { ...req.body, status: "PUBLISHED" };
  next();
}, updateDars);
router.post("/:id/unpublish", requirePermission("dars.publish"), (req, res, next) => {
  req.body = { ...req.body, status: "DRAFT" };
  next();
}, updateDars);

export default router;
