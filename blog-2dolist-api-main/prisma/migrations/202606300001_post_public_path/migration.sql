ALTER TABLE "Post" ADD COLUMN "path" TEXT;

CREATE UNIQUE INDEX "Post_locale_path_key" ON "Post"("locale", "path");
