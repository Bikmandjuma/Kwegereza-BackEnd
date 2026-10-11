-- Host can book a live class for a future time instead of starting it now.
ALTER TABLE `LiveClass` ADD COLUMN `scheduledFor` DATETIME(3) NULL;
