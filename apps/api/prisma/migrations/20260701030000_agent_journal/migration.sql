-- Journal append-only des actions agentiques Bob.
-- Additif : aucune table financière existante n'est modifiée.

CREATE TYPE "AgentJournalPhase" AS ENUM ('planned', 'denied', 'executed', 'failed');

CREATE TYPE "AgentComplianceLevel" AS ENUM ('low', 'medium', 'high');

CREATE TABLE "agent_journal_entries" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL,
  "phase" "AgentJournalPhase" NOT NULL,
  "tool" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "args" JSONB NOT NULL,
  "mutating" BOOLEAN NOT NULL,
  "outbound" BOOLEAN NOT NULL,
  "compliance" "AgentComplianceLevel" NOT NULL,
  "reason" TEXT,
  "resultDigest" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_agent_journal_seq" ON "agent_journal_entries"("companyId", "runId", "seq");
CREATE INDEX "agent_journal_entries_companyId_runId_idx" ON "agent_journal_entries"("companyId", "runId");
CREATE INDEX "agent_journal_entries_companyId_at_idx" ON "agent_journal_entries"("companyId", "at");

ALTER TABLE "agent_journal_entries"
  ADD CONSTRAINT "agent_journal_entries_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
