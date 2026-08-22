import { Router } from "express";
import {
  blockAnyUser,
  bulkUpdateUserStatus,
  getPermissionCatalog,
  listAllUsers,
  unblockAnyUser,
  updateUserPermissions,
  updateUserRole,
} from "../controllers/userManagementController.js";
import { authenticate, requireRole } from "../middleware/auth.js";

const router = Router();

// Assigning roles and permissions is a system-authority action, not a
// permission-driven one — per the spec, Roles/Permissions management is
// listed only under what ADMIN can do, never under the leader permission
// examples. So this whole controller is gated on role===ADMIN, not on any
// individual permission flag.
router.use(authenticate, requireRole("ADMIN"));

router.get("/permissions-catalog", getPermissionCatalog);
router.get("/users", listAllUsers);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/permissions", updateUserPermissions);
router.post("/users/:id/block", blockAnyUser);
router.post("/users/:id/unblock", unblockAnyUser);
router.post("/users/bulk-status", bulkUpdateUserStatus);

export default router;
