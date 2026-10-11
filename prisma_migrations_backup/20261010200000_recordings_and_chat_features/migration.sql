
-- CreateTable: LiveClassRecording
CREATE TABLE `LiveClassRecording` (
    `id` VARCHAR(191) NOT NULL,
    `liveClassId` VARCHAR(191) NOT NULL,
    `egressId` VARCHAR(191) NOT NULL,
    `roomName` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'STARTING',
    `fileKey` VARCHAR(191) NULL,
    `fileSizeBytes` BIGINT NULL,
    `durationSeconds` INT NULL,
    `startedByUserId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LiveClassRecording_egressId_key` (`egressId`),
    INDEX `LiveClassRecording_liveClassId_idx` (`liveClassId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: ChatSettings
CREATE TABLE `ChatSettings` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `themeId` VARCHAR(191) NOT NULL DEFAULT 'default',
    `wallpaper` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChatSettings_userId_key` (`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: ChatSettings wallpaper image support
ALTER TABLE `ChatSettings`
    ADD COLUMN `wallpaperImageUrl` VARCHAR(191) NULL,
    ADD COLUMN `wallpaperScale` DOUBLE NULL,
    ADD COLUMN `wallpaperOffsetX` DOUBLE NULL,
    ADD COLUMN `wallpaperOffsetY` DOUBLE NULL,
    ADD COLUMN `wallpaperNaturalWidth` INT NULL,
    ADD COLUMN `wallpaperNaturalHeight` INT NULL;

-- AlterTable: Message attachments, replies, editing and forwarding
ALTER TABLE `Message`
    ADD COLUMN `editedAt` DATETIME(3) NULL,
    ADD COLUMN `isForwarded` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `replyToId` VARCHAR(191) NULL,
    ADD COLUMN `attachmentUrl` VARCHAR(191) NULL,
    ADD COLUMN `attachmentType` VARCHAR(191) NULL,
    ADD COLUMN `attachmentName` VARCHAR(191) NULL,
    ADD COLUMN `attachmentSize` INT NULL,
    ADD COLUMN `groupId` VARCHAR(191) NULL,
    ADD COLUMN `isVoiceNote` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: MessageDeletion
CREATE TABLE `MessageDeletion` (
    `id` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `deletedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MessageDeletion_messageId_userId_key` (`messageId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LiveClassRecording`
    ADD CONSTRAINT `LiveClassRecording_liveClassId_fkey`
    FOREIGN KEY (`liveClassId`) REFERENCES `LiveClass`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `LiveClassRecording`
    ADD CONSTRAINT `LiveClassRecording_startedByUserId_fkey`
    FOREIGN KEY (`startedByUserId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ChatSettings`
    ADD CONSTRAINT `ChatSettings_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Message`
    ADD CONSTRAINT `Message_replyToId_fkey`
    FOREIGN KEY (`replyToId`) REFERENCES `Message`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MessageDeletion`
    ADD CONSTRAINT `MessageDeletion_messageId_fkey`
    FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `MessageDeletion`
    ADD CONSTRAINT `MessageDeletion_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
