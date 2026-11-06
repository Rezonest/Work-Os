-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "renewalOfProjectId" TEXT;

-- CreateIndex
CREATE INDEX "Offer_renewalOfProjectId_idx" ON "Offer"("renewalOfProjectId");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_renewalOfProjectId_fkey" FOREIGN KEY ("renewalOfProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
