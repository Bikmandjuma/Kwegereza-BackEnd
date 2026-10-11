-- AlterTable: add the column nullable first so existing rows can be
-- backfilled before the NOT NULL + UNIQUE constraint goes on -- adding
-- a NOT NULL UNIQUE column directly to a table that already has rows
-- would fail outright (every existing row would collide on the same
-- empty default).
ALTER TABLE `Book`
    ADD COLUMN `slug` VARCHAR(191) NULL;

-- Backfill: MySQL's UUID() is evaluated freshly PER ROW in an UPDATE
-- (not once for the whole statement), so this gives every existing
-- book its own effectively-random 12-character slug in one pass.
-- Collision odds across a realistic number of existing books are
-- negligible; any new book going forward gets its slug from
-- bookController.ts's own generation + uniqueness-check loop instead.
UPDATE `Book`
SET `slug` = LOWER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 12))
WHERE `slug` IS NULL;

-- AlterTable: now safe to enforce NOT NULL + UNIQUE, since every row
-- has a real value.
ALTER TABLE `Book`
    MODIFY COLUMN `slug` VARCHAR(191) NOT NULL;

CREATE UNIQUE INDEX `Book_slug_key` ON `Book`(`slug`);
