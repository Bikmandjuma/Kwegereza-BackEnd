-- Adds the two columns backing gender-segregated chat rooms. `kind`
-- defaults to 'DM' so every existing conversation is classified correctly
-- with zero data migration needed — they were all 1:1 chats already.
ALTER TABLE `Conversation` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'DM',
    ADD COLUMN `genderScope` VARCHAR(191) NULL;

-- Guarantees at most one real room per gender. MySQL does not treat
-- multiple NULLs as duplicates under a unique index, so this has no effect
-- on the many existing (and future) DM rows, which all have genderScope
-- NULL — it only ever constrains kind='GENDER_ROOM' rows.
CREATE UNIQUE INDEX `Conversation_kind_genderScope_key` ON `Conversation`(`kind`, `genderScope`);
