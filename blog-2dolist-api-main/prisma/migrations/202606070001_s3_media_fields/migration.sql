ALTER TABLE "Media"
ADD COLUMN "storageKey" TEXT,
ADD COLUMN "bucket" TEXT,
ADD COLUMN "sizeBytes" INTEGER;

CREATE UNIQUE INDEX "Media_storageKey_key" ON "Media"("storageKey");
