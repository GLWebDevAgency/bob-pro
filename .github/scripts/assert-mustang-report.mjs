import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function assertMustangReport(report, options) {
  if (typeof report !== 'string' || report.trim().length === 0) {
    throw new Error('Rapport Mustang absent ou vide.');
  }
  if (!/<validation\b[\s\S]*<\/validation>\s*$/.test(report.trim())) {
    throw new Error('Rapport Mustang tronqué ou enveloppe <validation> absente.');
  }
  const xmlBlock = report.match(/<xml>([\s\S]*?)<\/xml>/)?.[1];
  if (xmlBlock === undefined) {
    throw new Error('Bloc de validation XML absent.');
  }
  const escapedVersion = options.expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`<validator\\s+version=["']${escapedVersion}["']\\s*\\/>`).test(xmlBlock)) {
    throw new Error(`Version Mustang inattendue : ${options.expectedVersion} requise.`);
  }
  const facturXEn16931Profile = 'urn:cen.eu:en16931:2017';
  if (!xmlBlock.includes(`<profile>${facturXEn16931Profile}</profile>`)) {
    throw new Error('Profil Factur-X EN16931 attendu absent ou différent.');
  }
  const fired = Number(xmlBlock.match(/<fired>(\d+)<\/fired>/)?.[1] ?? Number.NaN);
  if (!Number.isSafeInteger(fired) || fired <= 0) {
    throw new Error('Aucune règle Schematron exécutée dans le rapport Mustang.');
  }
  const summaryStatuses = [...report.matchAll(/<summary\s+status=["']([^"']+)["']\s*\/>/g)]
    .map((match) => match[1]);
  if (summaryStatuses.length === 0 || summaryStatuses.some((status) => status !== 'valid')) {
    throw new Error(`Validation Mustang non valide : ${summaryStatuses.join(', ') || 'aucun résumé'}.`);
  }
  const failedRules = [...xmlBlock.matchAll(/<failed>(\d+)<\/failed>/g)]
    .map((match) => Number(match[1]));
  if (failedRules.some((count) => count !== 0)) {
    throw new Error(`Schematron Mustang en échec : ${failedRules.join(', ')} règle(s).`);
  }
  if (options.kind === 'pdf') {
    if (!/<pdf>[\s\S]*?<\/pdf>/.test(report)) {
      throw new Error('Bloc de validation PDF absent.');
    }
    if (!/flavour=3b\b/.test(report) || !/isCompliant=true\b/.test(report)) {
      throw new Error('Le document n’est pas certifié PDF/A-3b conforme.');
    }
  }
}

function main() {
  const [, , reportPath, expectedVersion, kind] = process.argv;
  if (!reportPath || !expectedVersion || (kind !== 'xml' && kind !== 'pdf')) {
    throw new Error(
      'Usage: node assert-mustang-report.mjs <rapport.xml> <version> <xml|pdf>',
    );
  }
  const report = readFileSync(reportPath, 'utf8');
  assertMustangReport(report, { expectedVersion, kind });
  process.stdout.write(`Rapport Mustang ${kind} certifié (${expectedVersion}).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
