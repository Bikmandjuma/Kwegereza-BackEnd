import { Router } from "express";
import {
  createBook,
  deleteBook,
  listAdmin,
  listPublished,
  trackDownload,
  updateBook,
} from "../controllers/bookController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ file: "documents", coverImage: "images" });

router.get("/published", listPublished);
router.post("/:id/download", trackDownload);

router.use(authenticate);

router.get("/", requirePermission("book.view"), listAdmin);
router.post("/", requirePermission("book.create"), upload, createBook);
router.patch("/:id", requirePermission("book.update"), upload, updateBook);
router.delete("/:id", requirePermission("book.delete"), deleteBook);

export default router;
