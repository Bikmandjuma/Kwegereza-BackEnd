-- Adds real view/share counters to Book, alongside the existing downloads
-- counter — backing the professional reader UI (view count, download
-- count, share count, all shown together).
ALTER TABLE `Book` ADD COLUMN `views` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `shares` INTEGER NOT NULL DEFAULT 0;
