-- Additive: a new optional table, plus two new nullable/defaulted columns
-- on Dars. Existing Dars rows are unaffected (playlistId stays NULL,
-- playlistOrder defaults to 0) adding a Dars to a playlist is entirely
-- opt-in, exactly like Dars.category was.
CREATE TABLE `Playlist` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL DEFAULT '',
    `thumbnail` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Dars` ADD COLUMN `playlistId` VARCHAR(191) NULL;
ALTER TABLE `Dars` ADD COLUMN `playlistOrder` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `Playlist` ADD CONSTRAINT `Playlist_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Dars` ADD CONSTRAINT `Dars_playlistId_fkey` FOREIGN KEY (`playlistId`) REFERENCES `Playlist`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
