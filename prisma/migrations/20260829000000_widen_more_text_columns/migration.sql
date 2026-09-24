-- Widening only, no data loss. Same fix as the earlier migration for
-- ifaida/Book/Dars descriptions these four were the remaining
-- VARCHAR(191)-capped free-form content fields still in the schema.
-- Teacher.bio is the literal "bio" field that prompted this pass.
ALTER TABLE `Teacher` MODIFY COLUMN `bio` TEXT NOT NULL;
ALTER TABLE `Playlist` MODIFY COLUMN `description` TEXT NOT NULL;
ALTER TABLE `Exam` MODIFY COLUMN `description` TEXT NOT NULL;
ALTER TABLE `Announcement` MODIFY COLUMN `body` TEXT NOT NULL;
