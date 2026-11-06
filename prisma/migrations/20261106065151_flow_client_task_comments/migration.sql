-- DropForeignKey
ALTER TABLE "TaskComment" DROP CONSTRAINT "TaskComment_authorId_fkey";

-- AlterTable
ALTER TABLE "TaskComment" ADD COLUMN     "clientName" TEXT,
ALTER COLUMN "authorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
