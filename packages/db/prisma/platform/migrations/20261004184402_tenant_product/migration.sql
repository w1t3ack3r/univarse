-- CreateTable
CREATE TABLE "tenant_product" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "product" TEXT NOT NULL,
    "entitled" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_product_tenant_id_product_key" ON "tenant_product"("tenant_id", "product");

-- AddForeignKey
ALTER TABLE "tenant_product" ADD CONSTRAINT "tenant_product_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity (spec 0003 P1/P4): only catalog products, and a product can never be enabled
-- without being entitled — even if application code regresses.
ALTER TABLE "tenant_product" ADD CONSTRAINT "tenant_product_known_product"
  CHECK (product IN ('core','admissions','bursary','academics','teaching','assessment','student_affairs','helpdesk','reporting'));
ALTER TABLE "tenant_product" ADD CONSTRAINT "tenant_product_enabled_requires_entitled"
  CHECK (NOT enabled OR entitled);
