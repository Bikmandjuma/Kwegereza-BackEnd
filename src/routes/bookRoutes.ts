import { Router } from "express";
import {
  createBook,
  deleteBook,
  listAdmin,
  listPublished,
  listReaders,
  trackDownload,
  trackShare,
  trackView,
  updateBook,
} from "../controllers/bookController.js";
import { authenticate, optionalAuthenticate, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ file: "documents", coverImage: "images" });

router.get("/published", optionalAuthenticate, listPublished);
// optionalAuthenticate, not authenticate: anonymous view/download/share
// must keep working, but a logged-in caller's identity is what backs the
// per-user "who read this" list below.
router.post("/:id/download", optionalAuthenticate, trackDownload);
router.post("/:id/view", optionalAuthenticate, trackView);
router.post("/:id/share", optionalAuthenticate, trackShare);

router.use(authenticate);

router.get("/", requirePermission("book.view"), listAdmin);
// Same permission Dars watch-history uses (analytics.media) this is
// content-engagement analytics, not book management specifically, so a
// super-admin can grant it independently of book.update/book.delete.
router.get("/:id/readers", requirePermission("analytics.media"), listReaders);
router.post("/", requirePermission("book.create"), upload, createBook);
router.patch("/:id", requirePermission("book.update"), upload, updateBook);
router.delete("/:id", requirePermission("book.delete"), deleteBook);

export default router;
