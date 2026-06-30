ALTER TABLE "Post"
ADD COLUMN "h1" TEXT,
ADD COLUMN "chapoHtml" TEXT,
ADD COLUMN "contentHtml" TEXT,
ADD COLUMN "faqJson" JSONB,
ADD COLUMN "heroImageUrl" TEXT,
ADD COLUMN "heroImageAlt" TEXT,
ADD COLUMN "metaTitle" TEXT,
ADD COLUMN "metaDescription" TEXT,
ADD COLUMN "canonicalUrl" TEXT,
ADD COLUMN "robots" TEXT NOT NULL DEFAULT 'noindex,follow',
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "isIndexable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "categorySlug" TEXT,
ADD COLUMN "tagsJson" JSONB,
ADD COLUMN "jsonLd" JSONB;

CREATE INDEX "Post_isActive_idx" ON "Post"("isActive");
CREATE INDEX "Post_categorySlug_idx" ON "Post"("categorySlug");
