ALTER TABLE "Category"
  ADD COLUMN "excerpt" TEXT,
  ADD COLUMN "contentHtml" TEXT,
  ADD COLUMN "contentJson" JSONB,
  ADD COLUMN "metaTitle" TEXT,
  ADD COLUMN "metaDescription" TEXT,
  ADD COLUMN "canonicalUrl" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isIndexable" BOOLEAN NOT NULL DEFAULT true;
