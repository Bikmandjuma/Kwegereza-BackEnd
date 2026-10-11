-- Extends the existing Playlist model (previously Dars-only) to Book,
-- ifaida, and PhotoInsight, using the exact same pattern Dars already
-- uses: a nullable playlistId FK plus a playlistOrder for position
-- within that playlist. No existing row's data changes every new
-- column defaults to NULL/0, so every current Book/ifaida/PhotoInsight
-- simply has no playlist yet, exactly as before this migration existed.

ALTER TABLE `Book`
  ADD COLUMN `playlistId` VARCHAR(191) NULL,
  ADD COLUMN `playlistOrder` INT NOT NULL DEFAULT 0;

ALTER TABLE `ifaida`
  ADD COLUMN `playlistId` VARCHAR(191) NULL,
  ADD COLUMN `playlistOrder` INT NOT NULL DEFAULT 0;

ALTER TABLE `PhotoInsight`
  ADD COLUMN `playlistId` VARCHAR(191) NULL,
  ADD COLUMN `playlistOrder` INT NOT NULL DEFAULT 0;

CREATE INDEX `Book_playlistId_idx` ON `Book`(`playlistId`);
CREATE INDEX `ifaida_playlistId_idx` ON `ifaida`(`playlistId`);
CREATE INDEX `PhotoInsight_playlistId_idx` ON `PhotoInsight`(`playlistId`);

ALTER TABLE `Book`
  ADD CONSTRAINT `Book_playlistId_fkey` FOREIGN KEY (`playlistId`) REFERENCES `Playlist`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ifaida`
  ADD CONSTRAINT `ifaida_playlistId_fkey` FOREIGN KEY (`playlistId`) REFERENCES `Playlist`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `PhotoInsight`
  ADD CONSTRAINT `PhotoInsight_playlistId_fkey` FOREIGN KEY (`playlistId`) REFERENCES `Playlist`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
