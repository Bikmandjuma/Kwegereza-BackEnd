-- Widening only, no data loss: every String field in this schema mapped
-- to MySQL's default VARCHAR(191) via Prisma unless told otherwise. That
-- silently capped real free-form content worst case ifaida.content,
-- which holds a full rich-text article as HTML and could never have
-- realistically fit in 191 characters. Existing short values are
-- unaffected; this only raises the ceiling.
ALTER TABLE `ifaida` MODIFY COLUMN `description` TEXT NOT NULL;
ALTER TABLE `ifaida` MODIFY COLUMN `content` TEXT NOT NULL;
ALTER TABLE `Book` MODIFY COLUMN `description` TEXT NOT NULL;
ALTER TABLE `Dars` MODIFY COLUMN `description` TEXT NOT NULL;
