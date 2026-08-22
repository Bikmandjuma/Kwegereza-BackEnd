import { Router } from "express";
import {
  approveStudent,
  blockStudent,
  getStudentDetail,
  listPendingStudents,
  listStudents,
  rejectStudent,
  unblockStudent,
} from "../controllers/studentController.js";
import { authenticate, requirePermission } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.get("/", requirePermission("student.view"), listStudents);
router.get("/pending", requirePermission("student.approve"), listPendingStudents);
router.get("/:id", requirePermission("student.view"), getStudentDetail);
router.post("/:id/approve", requirePermission("student.approve"), approveStudent);
router.post("/:id/reject", requirePermission("student.approve"), rejectStudent);
router.post("/:id/block", requirePermission("student.block"), blockStudent);
router.post("/:id/unblock", requirePermission("student.block"), unblockStudent);

export default router;
