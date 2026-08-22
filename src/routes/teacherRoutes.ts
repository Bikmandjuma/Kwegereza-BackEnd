import { Router } from "express";
import {
  createTeacher,
  deleteTeacher,
  getPublicOne,
  listAdmin,
  listPublic,
  updateTeacher,
} from "../controllers/teacherController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { makeMultiFieldUploader } from "../utils/storage.js";

const router = Router();
const upload = makeMultiFieldUploader({ photo: "images" });

router.get("/", listPublic);
router.get("/:id", getPublicOne);

router.use(authenticate);

router.get("/admin/all", requirePermission("teacher.manage"), listAdmin);
router.post("/", requirePermission("teacher.manage"), upload, createTeacher);
router.patch("/:id", requirePermission("teacher.manage"), upload, updateTeacher);
router.delete("/:id", requirePermission("teacher.manage"), deleteTeacher);

export default router;
