import { Router } from "express";
import {
  blockAnyUser,
  bulkUpdateUserStatus,
  createUserByAdmin,
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
// examples. So this whole controller is gated on role, not on any
// individual permission flag. SUPER_ADMIN sits above ADMIN and can reach
// everything ADMIN can, plus the SUPER_ADMIN-only actions guarded
// individually below (creating new accounts, touching ADMIN accounts).
router.use(authenticate, requireRole("ADMIN", "SUPER_ADMIN"));

router.get("/permissions-catalog", getPermissionCatalog);
router.get("/users", listAllUsers);
// Directly creating an account (any role, active immediately, no approval
// queue) is the one genuinely new "Super-Admin can add anyone" capability —
// deliberately restricted to SUPER_ADMIN only, not shared with plain ADMIN.
router.post("/users", requireRole("SUPER_ADMIN"), createUserByAdmin);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/permissions", updateUserPermissions);
router.post("/users/:id/block", blockAnyUser);
router.post("/users/:id/unblock", unblockAnyUser);
router.post("/users/bulk-status", bulkUpdateUserStatus);

export default router;
