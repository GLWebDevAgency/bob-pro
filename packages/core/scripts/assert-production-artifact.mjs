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

for (const entry of ['index.js', 'index.cjs', 'index.d.ts']) {
  if (!existsSync(resolve(output, entry))) {
    throw new Error(`Artefact @bob/core invalide : dist/${entry} est absent.`);
  }
}

const forbiddenPath =
  /(?:^|\/)(?:testing|[^/]+\.(?:test|testing|spec))\.(?:js|cjs|d\.ts|d\.cts|map)$/u;
const forbiddenSymbols = [
  'MERCIER_PROPS',
  'CUSTOMER_PROPS',
  'CASH_SNAPSHOT',
  'TODAY_FIXTURE',
  'seedCompany',
  'seedCustomers',
  'seedExpenses',
  'seedVaultDocuments',
  'DemoOcrAdapter',
];
const forbiddenConcepts = /\b(?:demo|fixture|mock)\b|\bd[ée]mo\b/iu;

const files = filesBelow(output);
const pathViolations = files
  .map((path) => relative(output, path).replaceAll('\\', '/'))
  .filter((path) => forbiddenPath.test(path));
const contentViolations = [];

for (const path of files) {
  const content = readFileSync(path, 'utf8');
  if (forbiddenConcepts.test(content)) {
    contentViolations.push(`${relative(output, path)} -> concept de donnée simulée`);
  }
  for (const symbol of forbiddenSymbols) {
    if (content.includes(symbol)) {
      contentViolations.push(`${relative(output, path)} -> ${symbol}`);
    }
  }
}

if (pathViolations.length > 0 || contentViolations.length > 0) {
  throw new Error([
    'Artefact @bob/core refusé : une fixture ou un adapter de démonstration a été émis.',
    ...pathViolations.map((path) => `path: ${path}`),
    ...contentViolations.map((violation) => `content: ${violation}`),
  ].join('\n'));
}

console.log(`Artefact @bob/core certifié : ${files.length} fichiers, aucune fixture.`);
