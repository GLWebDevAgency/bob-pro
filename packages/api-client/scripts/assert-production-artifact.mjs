import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(packageRoot, 'dist');

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

for (const entry of ['index.js', 'index.d.ts']) {
  if (!existsSync(resolve(output, entry))) {
    throw new Error(`Artefact @bob/api-client invalide : dist/${entry} est absent.`);
  }
}

const forbiddenPath =
  /(?:^|\/)(?:testing|local-client|[^/]+\.(?:test|testing|spec))\.(?:js|d\.ts|map)$/u;
const forbiddenSymbols = [
  'LocalBobClient',
  'InMemoryCompanyRepository',
  'InMemoryCustomerRepository',
  'InMemoryQuoteRepository',
  'InMemoryInvoiceRepository',
  'InMemoryPaymentRepository',
  'InMemoryExpenseRepository',
  'InMemoryAccountingEntryRepository',
  'InMemoryCatalogueRepository',
  'InMemoryChantierRepository',
  'FixtureClock',
  'FixtureCashflowSnapshot',
  'DemoCompanyLookupAdapter',
  'DemoVatAdapter',
  'DemoAddressAdapter',
  '@bob/core/testing',
  '@bob/ai/testing',
  'x-company-id',
];

const files = filesBelow(output);
const pathViolations = files
  .map((path) => relative(output, path).replaceAll('\\', '/'))
  .filter((path) => forbiddenPath.test(path));
const contentViolations = [];

for (const path of files) {
  const content = readFileSync(path, 'utf8');
  for (const symbol of forbiddenSymbols) {
    if (content.includes(symbol)) {
      contentViolations.push(`${relative(output, path)} -> ${symbol}`);
    }
  }
}

if (pathViolations.length > 0 || contentViolations.length > 0) {
  throw new Error([
    'Artefact @bob/api-client refusé : un client local, un double mémoire ou une fixture a été émis.',
    ...pathViolations.map((path) => `path: ${path}`),
    ...contentViolations.map((violation) => `content: ${violation}`),
  ].join('\n'));
}

console.log(`Artefact @bob/api-client certifié : ${files.length} fichiers, aucun client local/double.`);
