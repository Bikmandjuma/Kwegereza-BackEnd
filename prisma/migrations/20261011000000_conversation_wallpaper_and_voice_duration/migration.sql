-- AlterTable: store the real recording duration alongside a voice note,
-- rather than relying on the uploaded file's own (often broken, for
-- MediaRecorder-produced webm) duration metadata on playback.
ALTER TABLE `Message`
    ADD COLUMN `attachmentDuration` INT NULL;

-- AlterTable: wallpaper moves off ChatSettings (a per-user-only table,
-- which was the direct cause of one conversation's wallpaper changing
-- another's) onto its own per-(user, conversation) table below. themeId
-- stays here as the one deliberately-global preference. None of these
-- columns carry their own foreign key or index, so dropping them is a
-- plain column removal -- no constraint needs touching first.
ALTER TABLE `ChatSettings`
    DROP COLUMN `wallpaper`,
    DROP COLUMN `wallpaperImageUrl`,
    DROP COLUMN `wallpaperScale`,
    DROP COLUMN `wallpaperOffsetX`,
    DROP COLUMN `wallpaperOffsetY`,
    DROP COLUMN `wallpaperNaturalWidth`,
    DROP COLUMN `wallpaperNaturalHeight`;

-- CreateTable
CREATE TABLE `ConversationWallpaper` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `wallpaper` VARCHAR(191) NULL,
    `wallpaperImageUrl` VARCHAR(191) NULL,
    `wallpaperScale` DOUBLE NULL,
    `wallpaperOffsetX` DOUBLE NULL,
    `wallpaperOffsetY` DOUBLE NULL,
    `wallpaperNaturalWidth` INT NULL,
    `wallpaperNaturalHeight` INT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ConversationWallpaper_userId_conversationId_key`(`userId`, `conversationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `ConversationWallpaper_conversationId_idx` ON `ConversationWallpaper`(`conversationId`);

-- AddForeignKey
ALTER TABLE `ConversationWallpaper` ADD CONSTRAINT `ConversationWallpaper_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ConversationWallpaper` ADD CONSTRAINT `ConversationWallpaper_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
