/**
 * Tests de structure Jarvis (spec §4.4, greffe reducer-racine) — la pureté des modules
 * n'est pas une convention : elle est VÉRIFIÉE sur les sources. Les modules
 * `definitions/*.ts` et `jarvis-*.ts` n'importent rien hors de `domain/agent/*` et du
 * shared-kernel (aucun port, repository, provider), ne lisent jamais d'horloge ambiante
 * (`occurredAt` vient du contexte d'admission), et le dépôt ne possède qu'UNE entrée de
 * réduction : `reduceJarvisRun`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_KERNEL_DIR = resolve(AGENT_DIR, '../../shared-kernel');
const DEFINITIONS_DIR = join(AGENT_DIR, 'definitions');

function isSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

/** Modules soumis à la pureté absolue : jarvis-*.ts du domaine + toutes les définitions. */
function jarvisSourceFiles(): readonly string[] {
  const roots = readdirSync(AGENT_DIR)
    .filter((name) => name.startsWith('jarvis-') && isSource(name))
    .map((name) => join(AGENT_DIR, name));
  const definitions = existsSync(DEFINITIONS_DIR)
    ? readdirSync(DEFINITIONS_DIR)
        .filter(isSource)
        .map((name) => join(DEFINITIONS_DIR, name))
    : [];
  return [...roots, ...definitions];
}

/**
 * Le scan porte sur le CODE : les commentaires (JSDoc citant `new Date()` ou un exemple
 * d'import) ne doivent jamais déclencher la garde. Dépouillement naïf mais suffisant
 * pour des sources domaine sans URL ni littéral `//` dans les chaînes.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Tous les specifiers importés : import/export-from, side-effect, dynamique, require. */
function importSpecifiers(source: string): readonly string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function isInside(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + sep);
}

function label(file: string): string {
  return relative(AGENT_DIR, file);
}

describe('Pureté structurelle des modules Jarvis (§4.4)', () => {
  it('couvre au moins les trois modules jarvis-*.ts du domaine', () => {
    const names = jarvisSourceFiles().map(label);
    expect(names).toContain('jarvis-run.ts');
    expect(names).toContain('jarvis-work-item.ts');
    expect(names).toContain('jarvis-run-reducer.ts');
  });

  it('n’importe RIEN hors de domain/agent/* et shared-kernel — aucun port, repository, provider', () => {
    // Formes admises (contrat de tranche) : './…' (domain/agent), './agent-mission',
    // './jarvis-…', '../../shared-kernel/…' — et leurs transpositions depuis
    // definitions/ ('../…', '../../../shared-kernel/…'). La preuve est faite par
    // RÉSOLUTION : le chemin résolu doit rester dans domain/agent ou shared-kernel ;
    // tout specifier nu (paquet npm, port applicatif aliasé) est refusé d'office.
    for (const file of jarvisSourceFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of importSpecifiers(source)) {
        expect(
          specifier.startsWith('.'),
          `${label(file)} importe le module nu « ${specifier} » — interdit hors domain/agent et shared-kernel`,
        ).toBe(true);
        const target = resolve(dirname(file), specifier);
        expect(
          isInside(target, AGENT_DIR) || isInside(target, SHARED_KERNEL_DIR),
          `${label(file)} importe « ${specifier} » → ${target} — hors de domain/agent/* et shared-kernel`,
        ).toBe(true);
      }
    }
  });

  it('ne lit JAMAIS d’horloge ambiante — Date.now et new Date() interdits, occurredAt vient du contexte', () => {
    // Sont interdites les LECTURES d'horloge : `Date.now`, `new Date()` sans argument,
    // `new Date` sans parenthèses. La conversion pure d'un Instant fourni
    // (`Date.parse(instant)`, `new Date(epoch).toISOString()`) reste permise — même
    // doctrine que le contrat de réduction : le temps ENTRE par le contexte, jamais
    // par le module.
    for (const file of jarvisSourceFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const ambientClock = source.match(
        /\bDate\.now\b|\bnew\s+Date\s*\(\s*\)|\bnew\s+Date\b(?!\s*\()/,
      );
      expect(
        ambientClock,
        `${label(file)} contient « ${ambientClock?.[0] ?? ''} » — horloge ambiante interdite (le temps vient du contexte d'admission)`,
      ).toBeNull();
    }
  });

  it('déclare exactement UNE « export function reduceJarvisRun » dans domain/agent — pas de second moteur', () => {
    const declaringFiles: string[] = [];
    const stack = [AGENT_DIR];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (!entry.isFile() || !isSource(entry.name)) continue;
        const declarations =
          stripComments(readFileSync(path, 'utf8')).match(
            /\bexport\s+function\s+reduceJarvisRun\b/g,
          ) ?? [];
        for (let index = 0; index < declarations.length; index += 1) {
          declaringFiles.push(label(path));
        }
      }
    }
    expect(declaringFiles).toEqual(['jarvis-run-reducer.ts']);
  });
});
