-- Additive only: new nullable-with-default column, no existing data
-- touched. Backs a "playlist tab" style grouping for Dars (audio/video
-- lessons) the same way Book.category already backs Ibitabo's category
-- filter existing rows just get category = '' (shown as ungrouped /
-- "Ibindi" in the UI) until an admin assigns a real category.
ALTER TABLE `Dars` ADD COLUMN `category` VARCHAR(191) NOT NULL DEFAULT '';
