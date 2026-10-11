-- Additive only: a new table, no existing data touched. Same pattern as
-- DarsPlayEvent backs "who read/downloaded/shared this book" for the
-- admin Books list, previously only an anonymous global counter existed.
CREATE TABLE `BookActivityEvent` (
    `id` VARCHAR(191) NOT NULL,
    `bookId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `BookActivityEvent_bookId_idx`(`bookId`),
    INDEX `BookActivityEvent_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BookActivityEvent` ADD CONSTRAINT `BookActivityEvent_bookId_fkey` FOREIGN KEY (`bookId`) REFERENCES `Book`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `BookActivityEvent` ADD CONSTRAINT `BookActivityEvent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
