-- Adds the proctoring recording URL to ExamAttempt. Nullable, defaults
-- to nothing: every existing attempt simply has no recording, exactly
-- as before this feature existed.
ALTER TABLE `ExamAttempt` ADD COLUMN `proctorVideoUrl` VARCHAR(191) NULL;
