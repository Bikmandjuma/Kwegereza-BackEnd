import { Router } from "express";
import {
  createPhotoInsight,
  deletePhotoInsight,
  listAdmin,
  listPublished,
  updatePhotoInsight,
} from "../controllers/photoInsightController.js";
import { authenticate, optionalAuthenticate, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ image: "images" });

// optionalAuthenticate, not authenticate: guests can browse (with the
// first-3-free lock), but a logged-in caller's identity is what unlocks
// everything, same as Dars and Books.
router.get("/published", optionalAuthenticate, listPublished);

router.use(authenticate);

router.get("/", requirePermission("photoinsight.view"), listAdmin);
router.post("/", requirePermission("photoinsight.create"), upload, createPhotoInsight);
router.patch("/:id", requirePermission("photoinsight.update"), upload, updatePhotoInsight);
router.delete("/:id", requirePermission("photoinsight.delete"), deletePhotoInsight);
router.post("/:id/publish", requirePermission("photoinsight.publish"), (req, res, next) => {
  req.body = { ...req.body, status: "PUBLISHED" };
  next();
}, updatePhotoInsight);
router.post("/:id/unpublish", requirePermission("photoinsight.publish"), (req, res, next) => {
  req.body = { ...req.body, status: "DRAFT" };
  next();
}, updatePhotoInsight);

export default router;
