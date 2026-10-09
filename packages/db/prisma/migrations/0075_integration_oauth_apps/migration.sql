-- Instance-wide OAuth apps (one per provider) for OAuth-connected integrations.
-- The client secret is stored encrypted; the key never lives in the database.
-- CreateTable
CREATE TABLE "integration_oauth_apps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_oauth_apps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_oauth_apps_provider_key" ON "integration_oauth_apps"("provider");
