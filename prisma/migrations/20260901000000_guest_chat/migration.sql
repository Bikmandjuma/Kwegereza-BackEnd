-- Additive only: two new tables, no existing data touched.
CREATE TABLE `GuestConversation` (
    `id` VARCHAR(191) NOT NULL,
    `guestName` VARCHAR(191) NOT NULL,
    `guestGender` VARCHAR(191) NOT NULL,
    `guestToken` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `assignedToId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GuestConversation_guestToken_key`(`guestToken`),
    INDEX `GuestConversation_status_idx`(`status`),
    INDEX `GuestConversation_assignedToId_idx`(`assignedToId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GuestMessage` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `senderType` VARCHAR(191) NOT NULL,
    `senderId` VARCHAR(191) NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GuestMessage_conversationId_idx`(`conversationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `GuestConversation` ADD CONSTRAINT `GuestConversation_assignedToId_fkey` FOREIGN KEY (`assignedToId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `GuestMessage` ADD CONSTRAINT `GuestMessage_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `GuestConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `GuestMessage` ADD CONSTRAINT `GuestMessage_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
