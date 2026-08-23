-- Backs custom, admin-defined roles (Secretariat, Accountant, etc.).
-- User.role is unchanged (still a plain VARCHAR) — this table just makes
-- new role keys creatable and listable through the UI instead of being
-- hardcoded in the frontend.
CREATE TABLE `Role` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `defaultPermissions` VARCHAR(191) NOT NULL DEFAULT '[]',
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Role_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the 4 built-in roles as isSystem rows, purely so they show up
-- alongside custom roles in the same list/dropdown everywhere. ADMIN and
-- SUPER_ADMIN are listed for completeness but are never assignable through
-- the generic role-assignment page — that stays gated through the existing
-- careful promote/demote actions.
INSERT INTO `Role` (`id`, `key`, `label`, `defaultPermissions`, `isSystem`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'STUDENT', 'Umunyeshuri', '[]', true, NOW(3), NOW(3)),
  (UUID(), 'LEADER', 'Umuyobozi', '[]', true, NOW(3), NOW(3)),
  (UUID(), 'ADMIN', 'Admin', '[]', true, NOW(3), NOW(3)),
  (UUID(), 'SUPER_ADMIN', 'Super-Admin', '[]', true, NOW(3), NOW(3));
