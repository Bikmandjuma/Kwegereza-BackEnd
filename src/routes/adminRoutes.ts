import { Router } from "express";
import {
  blockAnyUser,
  bulkUpdateUserStatus,
  createUserByAdmin,
  deleteStudentAccount,
  getPermissionCatalog,
  getUserById,
  listAllUsers,
  unblockAnyUser,
  updateUserInfo,
  updateUserPermissions,
  updateUserRole,
} from "../controllers/userManagementController.js";
import { createRole, deleteRole, listRoles, updateRole } from "../controllers/roleController.js";
import { authenticate, requirePermission, requireRole } from "../middleware/auth.js";

const router = Router();

// Editing another user's basic info (name/email/phone/gender) is a
// grantable PERMISSION (`users.edit_info`), not an admin-tier-only action
// like everything else in this file a super-admin can hand this to a
// LEADER or any custom role without also giving them role- or
// permission-editing power. So it gets its own auth+permission gate here,
// defined BEFORE the router-wide requireRole(ADMIN, SUPER_ADMIN) below,
// which would otherwise block any non-admin-tier caller regardless of
// what permission they hold.
router.patch("/users/:id/info", authenticate, requirePermission("users.edit_info"), updateUserInfo);

// Real, permanent deletion of a student account is its own grantable
// permission (`student.delete`), separate from users.edit_info above --
// editing basic info and permanently destroying an account with its
// whole history are very different levels of trust, and a super-admin
// should be able to hand out one without the other. Same
// before-the-router-wide-requireRole placement as users.edit_info, for
// the same reason: ADMIN/SUPER_ADMIN always pass any requirePermission
// check regardless (see hasPermission), so this changes nothing for
// them it only ADDS the ability for a super-admin to extend this to
// a non-admin-tier custom role. deleteStudentAccount itself
// independently still refuses anything that isn't role STUDENT.
router.delete("/users/:id", authenticate, requirePermission("student.delete"), deleteStudentAccount);

// Assigning roles and permissions is a system-authority action, not a
// permission-driven one per the spec, Roles/Permissions management is
// listed only under what ADMIN can do, never under the leader permission
// examples. So this whole controller is gated on role, not on any
// individual permission flag. SUPER_ADMIN sits above ADMIN and can reach
// everything ADMIN can, plus the SUPER_ADMIN-only actions guarded
// individually below (creating new accounts, touching ADMIN accounts).
router.use(authenticate, requireRole("ADMIN", "SUPER_ADMIN"));

router.get("/permissions-catalog", getPermissionCatalog);
router.get("/roles", listRoles);
router.post("/roles", createRole);
router.patch("/roles/:id", updateRole);
router.delete("/roles/:id", deleteRole);
router.get("/users", listAllUsers);
router.get("/users/:id", getUserById);
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
