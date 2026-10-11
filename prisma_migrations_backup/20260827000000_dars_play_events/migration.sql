-- Additive only: a new table, no existing data touched. Backs "who
-- watched this video/audio and how many times" for the admin Dars list --
-- previously only an anonymous global `plays` counter existed.
CREATE TABLE `DarsPlayEvent` (
    `id` VARCHAR(191) NOT NULL,
    `darsId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `watchSeconds` INTEGER NULL,
    `playedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DarsPlayEvent_darsId_idx`(`darsId`),
    INDEX `DarsPlayEvent_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DarsPlayEvent` ADD CONSTRAINT `DarsPlayEvent_darsId_fkey` FOREIGN KEY (`darsId`) REFERENCES `Dars`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DarsPlayEvent` ADD CONSTRAINT `DarsPlayEvent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
