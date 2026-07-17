import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const output = resolve(apiRoot, 'dist');

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

if (!existsSync(resolve(output, 'main.js'))) {
  throw new Error('Artefact API invalide : dist/main.js est absent.');
}

const forbiddenPaths = [
  /^(?:apps|packages)\//u,
  /(?:^|\/)persistence\/in-memory\.(?:js|js\.map)$/u,
  /(?:^|\/)persistence\/sales-document-search\.in-memory\.(?:js|js\.map)$/u,
  /(?:^|\/)cabinet\/memory-cabinet-infrastructure\.(?:js|js\.map)$/u,
  /(?:^|\/)voice\/realtime\/evaluation\//u,
  /(?:^|\/)[^/]+\.(?:test|spec|testing)\.(?:js|js\.map)$/u,
  /(?:^|\/)application\/fixtures\//u,
];

const forbiddenSymbols = [
  'InMemoryPersistence',
  'InMemoryCompanyRepository',
  'InMemoryCustomerRepository',
  'InMemoryQuoteRepository',
  'InMemoryInvoiceRepository',
  'InMemoryDocumentRepository',
  'InMemoryDocumentFolderRepository',
  'InMemoryPaymentRepository',
  'InMemoryExpenseRepository',
  'InMemoryCatalogueRepository',
  'InMemoryChantierRepository',
  'InMemoryAgentJournalRepository',
  'InMemorySupplierMemoryRepository',
  'InMemorySubscriptionRepository',
  'InMemoryBankBalanceSnapshotRepository',
  'InMemoryFiscalProfileRepository',
  'InMemoryDocumentFolderDeletionPlanStore',
  'InMemoryDocumentAnalysisStore',
  'InMemoryExpenseCreationRequestStore',
  'InMemoryQuoteCreationRequestStore',
  'InMemorySalesDocumentSearchRepository',
  'InMemoryCompanyMemory',
  'InMemoryDocumentStorage',
  'InMemoryRealtimeAdmission',
  'InProcessRealtimeAdmission',
  'MemoryCabinetInfrastructure',
  'LocalBobClient',
  'DemoLlmAdapter',
  'DemoSttAdapter',
  'DemoTtsAdapter',
  'DemoOcrAdapter',
  'MERCIER_PROPS',
  'OCR_GOLDEN_CASES',
  '@bob/core/testing',
  '@bob/ai/testing',
  'x-demo-user-id',
  'x-demo-user-email',
  'local-test-harness',
];

const files = filesBelow(output);
const pathViolations = files
  .map((path) => relative(output, path).replaceAll('\\', '/'))
  .filter((path) => forbiddenPaths.some((pattern) => pattern.test(path)));

const contentViolations = [];
for (const path of files.filter((candidate) => /\.(?:js|map|json)$/u.test(candidate))) {
  const content = readFileSync(path, 'utf8');
  for (const symbol of forbiddenSymbols) {
    if (content.includes(symbol)) {
      contentViolations.push(`${relative(output, path)} -> ${symbol}`);
    }
  }
}

if (pathViolations.length > 0 || contentViolations.length > 0) {
  throw new Error([
    'Artefact API refusé : un double mémoire, une fixture ou un module de test a été émis.',
    ...pathViolations.map((path) => `path: ${path}`),
    ...contentViolations.map((violation) => `content: ${violation}`),
  ].join('\n'));
}

console.log(`Artefact API certifié : ${files.length} fichiers, aucun double métier/fixture.`);
