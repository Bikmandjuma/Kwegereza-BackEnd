-- Backs the "time spent per activity" student-analytics feature — one row
-- per user+category+day, incremented in place rather than one row per
-- heartbeat, so this stays cheap even at scale.
CREATE TABLE `ActivityTime` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `seconds` INTEGER NOT NULL DEFAULT 0,

    INDEX `ActivityTime_userId_date_idx`(`userId`, `date`),
    UNIQUE INDEX `ActivityTime_userId_category_date_key`(`userId`, `category`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ActivityTime` ADD CONSTRAINT `ActivityTime_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
