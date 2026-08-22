import { Router } from "express";
import {
  createDars,
  deleteDars,
  listAdmin,
  listPublished,
  trackPlay,
  updateDars,
} from "../controllers/darsController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ audio: "audio", thumbnail: "images" });

router.get("/published", listPublished);
router.post("/:id/play", trackPlay);

router.use(authenticate);

router.get("/", requirePermission("dars.view"), listAdmin);
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
