import { Router } from "express";
import {
  createAnnouncement,
  deleteAnnouncement,
  listAdmin,
  listPublished,
  updateAnnouncement,
} from "../controllers/announcementController.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ coverImage: "images" });

router.get("/published", listPublished);

router.use(authenticate);

router.get("/", requireAnyPermission("announcement.create", "announcement.update", "announcement.publish"), listAdmin);
router.post("/", requirePermission("announcement.create"), upload, createAnnouncement);
router.patch("/:id", requirePermission("announcement.update"), upload, updateAnnouncement);
router.delete("/:id", requirePermission("announcement.delete"), deleteAnnouncement);
router.post("/:id/publish", requirePermission("announcement.publish"), (req, res, next) => {
  req.body = { ...req.body, status: "PUBLISHED" };
  next();
}, updateAnnouncement);
router.post("/:id/unpublish", requirePermission("announcement.publish"), (req, res, next) => {
  req.body = { ...req.body, status: "DRAFT" };
  next();
}, updateAnnouncement);

export default router;
