-- A2-C16 : la facture finale porte la trace de l'acompte déjà facturé (déduction du net à payer).
ALTER TABLE "invoices" ADD COLUMN "depositDeductionCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "depositInvoiceId" TEXT;
