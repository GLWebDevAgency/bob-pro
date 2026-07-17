import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNTIME_PERSISTENCE_CONSUMERS = [
  './backend.service.ts',
  './persistence/persistence.module.ts',
  './persistence/tenant-persistence.interceptor.ts',
  './cabinet/cabinet-api.service.ts',
  './voice/realtime/realtime.module.ts',
  './notifications/notifications-api.service.ts',
  './jobs/tenant-directory.ts',
  './jobs/notification-delivery.service.ts',
  './jobs/relance.service.ts',
  './jobs/digest.service.ts',
] as const;

const SPLIT_TEST_DOUBLES = [
  ['./persistence/agent-journal.ts', './persistence/agent-journal.testing.ts', 'InMemoryAgentJournalRepository'],
  ['./persistence/supplier-memory.ts', './persistence/supplier-memory.testing.ts', 'InMemorySupplierMemoryRepository'],
  [
    './persistence/document-folder-deletion-plans.ts',
    './persistence/document-folder-deletion-plans.testing.ts',
    'InMemoryDocumentFolderDeletionPlanStore',
  ],
  ['./persistence/document-analyses.ts', './persistence/document-analyses.testing.ts', 'InMemoryDocumentAnalysisStore'],
  [
    './persistence/expense-creation-requests.ts',
    './persistence/expense-creation-requests.testing.ts',
    'InMemoryExpenseCreationRequestStore',
  ],
  [
    './persistence/quote-creation-requests.ts',
    './persistence/quote-creation-requests.testing.ts',
    'InMemoryQuoteCreationRequestStore',
  ],
] as const;

function source(path: string): string {
  return readFileSync(resolve(__dirname, path), 'utf8');
}

describe('graphe d imports runtime API', () => {
  it.each(RUNTIME_PERSISTENCE_CONSUMERS)(
    '%s importe le jeton minimal, jamais le harness de fixtures',
    (path) => {
      const code = source(path);
      expect(code).not.toMatch(
        /import\s*\{[^}]*\bPERSISTENCE\b[^}]*\}\s*from\s*['"][^'"]*persistence(?:\/persistence)?['"]/su,
      );
      expect(code).not.toMatch(/from\s*['"][^'"]*(?:testing|fixture|in-memory)[^'"]*['"]/u);
      expect(code).toContain('persistence-token');
    },
  );

  it('le stockage documentaire déployé ne contient aucun adapter mémoire', () => {
    const code = source('./documents/storage.ts');

    expect(code).not.toContain('InMemoryDocumentStorage');
    expect(code).not.toContain('memory://');
    expect(source('./documents/storage.testing.ts')).toContain('InMemoryDocumentStorage');
  });

  it.each(SPLIT_TEST_DOUBLES)(
    '%s reste runtime-only; %s porte le double %s',
    (runtimePath, testingPath, symbol) => {
      expect(source(runtimePath)).not.toContain(symbol);
      expect(source(testingPath)).toContain(symbol);
    },
  );

  it('le build production exclut physiquement tous les harness mémoire connus', () => {
    const config = source('../tsconfig.build.json');

    expect(config).toContain('src/**/*.testing.ts');
    expect(config).toContain('src/persistence/in-memory.ts');
    expect(config).toContain('src/persistence/sales-document-search.in-memory.ts');
    expect(config).toContain('src/cabinet/memory-cabinet-infrastructure.ts');
    expect(config).toContain('src/voice/realtime/evaluation/**');
    expect(source('../package.json')).toContain('assert-production-artifact.mjs');
  });

  it("la garde d'authentification runtime ne contient aucun pass-through de test ou de démo", () => {
    const code = source('./auth/auth.guard.ts');

    expect(code).not.toContain('isDemoMode');
    expect(code).not.toContain("x-company-id");
    expect(code).not.toContain("x-demo-user-id");
    expect(code).not.toContain("x-demo-user-email");
  });
});
