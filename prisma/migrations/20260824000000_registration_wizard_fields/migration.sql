-- Backs the new multi-step registration wizard: age range, location,
-- Qur'an-reading level (drives which class track a student lands in),
-- and their stated day/hour availability + an optional note, all captured
-- at registration time.
ALTER TABLE `User` ADD COLUMN `ageRange` VARCHAR(191) NULL,
    ADD COLUMN `location` VARCHAR(191) NULL,
    ADD COLUMN `quranLevel` VARCHAR(191) NULL,
    ADD COLUMN `availableDays` VARCHAR(191) NULL,
    ADD COLUMN `availableHours` VARCHAR(191) NULL,
    ADD COLUMN `registrationNote` VARCHAR(191) NULL;
