-- CreateEnum
CREATE TYPE "StoredDocumentKind" AS ENUM ('invoice_pdf', 'quote_pdf', 'facturx_xml', 'expense_receipt', 'signed_quote', 'other');

-- CreateEnum
CREATE TYPE "StoredDocumentOrigin" AS ENUM ('generated', 'uploaded', 'ocr');

-- CreateEnum
CREATE TYPE "StoredDocumentStatus" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "StoredDocumentLinkedEntityType" AS ENUM ('invoice', 'quote', 'expense', 'chantier', 'company');

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "StoredDocumentKind" NOT NULL,
    "origin" "StoredDocumentOrigin" NOT NULL,
    "status" "StoredDocumentStatus" NOT NULL DEFAULT 'active',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storageKey" TEXT NOT NULL,
    "linkedEntityType" "StoredDocumentLinkedEntityType",
    "linkedEntityId" TEXT,
    "documentDate" TEXT,
    "issuedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "retentionUntil" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storageKey_key" ON "documents"("storageKey");

-- CreateIndex
CREATE INDEX "documents_companyId_kind_idx" ON "documents"("companyId", "kind");

-- CreateIndex
CREATE INDEX "documents_companyId_linkedEntityType_linkedEntityId_idx" ON "documents"("companyId", "linkedEntityType", "linkedEntityId");

-- CreateIndex
CREATE INDEX "documents_companyId_retentionUntil_idx" ON "documents"("companyId", "retentionUntil");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storageKey_key" ON "document_versions"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_version_key" ON "document_versions"("documentId", "version");

-- CreateIndex
CREATE INDEX "document_versions_documentId_idx" ON "document_versions"("documentId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
