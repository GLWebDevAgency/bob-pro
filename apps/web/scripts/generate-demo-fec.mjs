#!/usr/bin/env node

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_DAY = '2026-06-30';
const DEMO_PERIOD = { from: '2026-01-01', to: '2026-12-31' };
const DEFAULT_OUTPUT_DIRECTORY = fileURLToPath(new URL('../.tmp/', import.meta.url));
const API_CLIENT_DIST = new URL('../../../packages/api-client/dist/testing.js', import.meta.url);
const CORE_DIST = new URL('../../../packages/core/dist/index.js', import.meta.url);
const BUILD_PREREQUISITE =
  'pnpm --filter @bob/core build && pnpm --filter @bob/ai build && pnpm --filter @bob/api-client build';

function printUsage() {
  console.log(`Génère le FEC réglementaire Latin-9 du client de démonstration Bob Pro.

Usage:
  node apps/web/scripts/generate-demo-fec.mjs [chemin-de-sortie]

Sortie:
  Sans argument, écrit dans apps/web/.tmp/<SIREN>FEC20261231.txt.
  Un chemin de fichier est utilisé tel quel ; un répertoire existant reçoit le nom FEC canonique.

Pré-requis (depuis la racine du dépôt):
  pnpm install
  ${BUILD_PREREQUISITE}

Période de démonstration: ${DEMO_PERIOD.from} au ${DEMO_PERIOD.to}.`);
}

function parseOutputArgument(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return { help: true, output: null };
  }
  if (args.length > 1 || args[0]?.startsWith('-')) {
    throw new Error('Argument invalide. Utilisez --help pour afficher l’usage.');
  }
  return { help: false, output: args[0] ?? null };
}

async function loadBobEngines() {
  try {
    const [apiClient, core] = await Promise.all([import(API_CLIENT_DIST.href), import(CORE_DIST.href)]);
    if (typeof apiClient.LocalBobClient !== 'function' || typeof apiClient.FixtureClock !== 'function') {
      throw new Error('LocalBobClient ou FixtureClock est absent du build @bob/api-client.');
    }
    if (typeof core.encodeLatin9 !== 'function' || !Array.isArray(core.FEC_HEADERS)) {
      throw new Error('encodeLatin9 ou FEC_HEADERS est absent du build @bob/core.');
    }
    return {
      LocalBobClient: apiClient.LocalBobClient,
      FixtureClock: apiClient.FixtureClock,
      encodeLatin9: core.encodeLatin9,
      fecHeaders: core.FEC_HEADERS,
    };
  } catch (cause) {
    throw new Error(
      `Impossible de charger les builds Bob Pro. Depuis la racine, exécutez:\n  ${BUILD_PREREQUISITE}`,
      { cause },
    );
  }
}

function formatAppError(error) {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function validateFecText(content, expectedRowCount, headers) {
  if (!content.endsWith('\n')) throw new Error('Le moteur a produit un FEC sans saut de ligne final.');

  const lines = content.slice(0, -1).split('\n');
  const expectedHeader = headers.join('\t');
  if (lines[0] !== expectedHeader) throw new Error('Les en-têtes produits ne correspondent pas au contrat FEC Bob Pro.');
  if (lines.length - 1 !== expectedRowCount) {
    throw new Error(`Le moteur annonce ${expectedRowCount} ligne(s), mais le fichier en contient ${lines.length - 1}.`);
  }

  const invalidRowIndex = lines.slice(1).findIndex((line) => line.split('\t').length !== headers.length);
  if (invalidRowIndex >= 0) {
    throw new Error(`La ligne FEC ${invalidRowIndex + 2} ne contient pas les ${headers.length} colonnes attendues.`);
  }
}

async function resolveOutputPath(argument, canonicalFilename) {
  if (argument === null) return resolve(DEFAULT_OUTPUT_DIRECTORY, canonicalFilename);

  const candidate = resolve(process.cwd(), argument);
  try {
    const metadata = await stat(candidate);
    if (metadata.isDirectory()) return resolve(candidate, canonicalFilename);
    if (!metadata.isFile()) throw new Error(`Le chemin de sortie n’est ni un fichier ni un répertoire: ${candidate}`);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return candidate;
}

async function main() {
  const parsed = parseOutputArgument(process.argv.slice(2));
  if (parsed.help) return;

  const { LocalBobClient, FixtureClock, encodeLatin9, fecHeaders } = await loadBobEngines();
  let idSequence = 0;
  const client = new LocalBobClient({
    clock: new FixtureClock(DEMO_DAY),
    ids: {
      newId() {
        idSequence += 1;
        return `demo-fec-${String(idSequence).padStart(4, '0')}`;
      },
    },
  });

  const result = await client.exportFec(DEMO_PERIOD);
  if (!result.ok) throw new Error(`L’export FEC a échoué: ${formatAppError(result.error)}`);

  const fec = result.value;
  if (fec.entryCount === 0 || fec.rowCount === 0) {
    throw new Error('Le jeu de démonstration n’a produit aucune écriture sur la période demandée.');
  }
  validateFecText(fec.content, fec.rowCount, fecHeaders);

  const encoded = encodeLatin9(fec.content);
  if (encoded.replacedCount > 0) {
    throw new Error(
      `${encoded.replacedCount} caractère(s) ne sont pas représentables en ISO 8859-15; aucun fichier n’a été écrit.`,
    );
  }
  const decoded = new TextDecoder('iso-8859-15', { fatal: true }).decode(encoded.bytes);
  if (decoded !== fec.content) throw new Error('Le contrôle aller-retour ISO 8859-15 a échoué.');

  const outputPath = await resolveOutputPath(parsed.output, fec.filename);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, encoded.bytes);

  console.log(`filename: ${fec.filename}`);
  console.log(`path: ${outputPath}`);
  console.log(`entries: ${fec.entryCount}`);
  console.log(`rows: ${fec.rowCount}`);
  console.log(`warnings: ${fec.warnings.length}`);
  for (const warning of fec.warnings) console.log(`- ${warning}`);
  console.log(`encoding: ISO-8859-15 (${encoded.bytes.byteLength} bytes, 0 replacement)`);
}

main().catch((error) => {
  console.error(`Erreur: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.cause instanceof Error) console.error(`Cause: ${error.cause.message}`);
  process.exitCode = 1;
});
