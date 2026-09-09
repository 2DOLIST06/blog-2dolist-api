ALTER TABLE "Category" ADD COLUMN "path" TEXT;

CREATE UNIQUE INDEX "Category_path_key" ON "Category"("path");
