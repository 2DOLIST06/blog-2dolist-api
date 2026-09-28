CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "NewsletterStatus" AS ENUM ('pending', 'active', 'unsubscribed', 'bounced', 'complained');
CREATE TYPE "NewsletterFrequency" AS ENUM ('immediate', 'weekly', 'monthly');

ALTER TABLE "NewsletterSubscriber"
  ADD COLUMN "status" "NewsletterStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "language" TEXT NOT NULL DEFAULT 'fr',
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "unsubscribedAt" TIMESTAMP(3),
  ADD COLUMN "consentAt" TIMESTAMP(3),
  ADD COLUMN "consentTextVersion" TEXT,
  ADD COLUMN "consentSource" TEXT,
  ADD COLUMN "preferencesToken" TEXT,
  ADD COLUMN "confirmationToken" TEXT;

UPDATE "NewsletterSubscriber" SET
  "confirmedAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "consentAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "consentTextVersion" = 'legacy-v1',
  "consentSource" = COALESCE("source", 'legacy'),
  "preferencesToken" = encode(gen_random_bytes(32), 'hex');

ALTER TABLE "NewsletterSubscriber"
  ALTER COLUMN "consentAt" SET NOT NULL,
  ALTER COLUMN "consentTextVersion" SET NOT NULL,
  ALTER COLUMN "consentSource" SET NOT NULL,
  ALTER COLUMN "preferencesToken" SET NOT NULL;

CREATE TABLE "NewsletterPreference" (
  "id" TEXT NOT NULL, "subscriberId" TEXT NOT NULL,
  "newArticles" BOOLEAN NOT NULL DEFAULT true, "practicalGuides" BOOLEAN NOT NULL DEFAULT true,
  "destinationGuides" BOOLEAN NOT NULL DEFAULT true, "activityGuides" BOOLEAN NOT NULL DEFAULT true,
  "newsAndUpdates" BOOLEAN NOT NULL DEFAULT true,
  "frequency" "NewsletterFrequency" NOT NULL DEFAULT 'weekly',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NewsletterPreference_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "NewsletterSubscriberInterest" (
  "id" TEXT NOT NULL, "subscriberId" TEXT NOT NULL, "interest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NewsletterSubscriberInterest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Region" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "NewsletterSubscriberRegion" (
  "id" TEXT NOT NULL, "subscriberId" TEXT NOT NULL, "regionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NewsletterSubscriberRegion_pkey" PRIMARY KEY ("id")
);

INSERT INTO "NewsletterPreference" ("id", "subscriberId", "updatedAt")
SELECT 'legacy-pref-' || "id", "id", CURRENT_TIMESTAMP FROM "NewsletterSubscriber";

INSERT INTO "Region" ("id", "name", "slug", "updatedAt") VALUES
('region-auvergne-rhone-alpes','Auvergne-Rhône-Alpes','auvergne-rhone-alpes',CURRENT_TIMESTAMP),
('region-bourgogne-franche-comte','Bourgogne-Franche-Comté','bourgogne-franche-comte',CURRENT_TIMESTAMP),
('region-bretagne','Bretagne','bretagne',CURRENT_TIMESTAMP),
('region-centre-val-de-loire','Centre-Val de Loire','centre-val-de-loire',CURRENT_TIMESTAMP),
('region-corse','Corse','corse',CURRENT_TIMESTAMP),
('region-grand-est','Grand Est','grand-est',CURRENT_TIMESTAMP),
('region-hauts-de-france','Hauts-de-France','hauts-de-france',CURRENT_TIMESTAMP),
('region-ile-de-france','Île-de-France','ile-de-france',CURRENT_TIMESTAMP),
('region-normandie','Normandie','normandie',CURRENT_TIMESTAMP),
('region-nouvelle-aquitaine','Nouvelle-Aquitaine','nouvelle-aquitaine',CURRENT_TIMESTAMP),
('region-occitanie','Occitanie','occitanie',CURRENT_TIMESTAMP),
('region-pays-de-la-loire','Pays de la Loire','pays-de-la-loire',CURRENT_TIMESTAMP),
('region-provence-alpes-cote-d-azur','Provence-Alpes-Côte d''Azur','provence-alpes-cote-d-azur',CURRENT_TIMESTAMP),
('region-guadeloupe','Guadeloupe','guadeloupe',CURRENT_TIMESTAMP),
('region-martinique','Martinique','martinique',CURRENT_TIMESTAMP),
('region-guyane','Guyane','guyane',CURRENT_TIMESTAMP),
('region-la-reunion','La Réunion','la-reunion',CURRENT_TIMESTAMP),
('region-mayotte','Mayotte','mayotte',CURRENT_TIMESTAMP);

CREATE UNIQUE INDEX "NewsletterSubscriber_preferencesToken_key" ON "NewsletterSubscriber"("preferencesToken");
CREATE UNIQUE INDEX "NewsletterSubscriber_confirmationToken_key" ON "NewsletterSubscriber"("confirmationToken");
CREATE INDEX "NewsletterSubscriber_status_idx" ON "NewsletterSubscriber"("status");
CREATE INDEX "NewsletterSubscriber_language_idx" ON "NewsletterSubscriber"("language");
CREATE UNIQUE INDEX "NewsletterPreference_subscriberId_key" ON "NewsletterPreference"("subscriberId");
CREATE INDEX "NewsletterPreference_frequency_idx" ON "NewsletterPreference"("frequency");
CREATE UNIQUE INDEX "NewsletterSubscriberInterest_subscriberId_interest_key" ON "NewsletterSubscriberInterest"("subscriberId", "interest");
CREATE INDEX "NewsletterSubscriberInterest_interest_idx" ON "NewsletterSubscriberInterest"("interest");
CREATE UNIQUE INDEX "Region_slug_key" ON "Region"("slug");
CREATE UNIQUE INDEX "NewsletterSubscriberRegion_subscriberId_regionId_key" ON "NewsletterSubscriberRegion"("subscriberId", "regionId");
CREATE INDEX "NewsletterSubscriberRegion_regionId_idx" ON "NewsletterSubscriberRegion"("regionId");
ALTER TABLE "NewsletterPreference" ADD CONSTRAINT "NewsletterPreference_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "NewsletterSubscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NewsletterSubscriberInterest" ADD CONSTRAINT "NewsletterSubscriberInterest_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "NewsletterSubscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NewsletterSubscriberRegion" ADD CONSTRAINT "NewsletterSubscriberRegion_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "NewsletterSubscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NewsletterSubscriberRegion" ADD CONSTRAINT "NewsletterSubscriberRegion_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
