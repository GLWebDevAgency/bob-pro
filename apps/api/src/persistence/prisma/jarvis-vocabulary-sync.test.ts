/**
 * Vocabulaire Jarvis — SQL ↔ domaine synchrones (spec §4.4, invariant n°1 U1-b).
 *
 * Les CHECK élargis par la migration U1-a (20260818200000_jarvis_run_expand) ont leur
 * source unique dans les constantes `@bob/core` : ce test lit les 3 blocs
 * BEGIN/END GENERATED de la migration et échoue sur TOUTE divergence (valeur, ordre,
 * ajout, retrait) en nommant la liste fautive. Le sens de dépendance reste propre :
 * l'api importe le core, jamais l'inverse.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  JARVIS_RUN_KINDS,
  JARVIS_RUN_PERSISTED_STATUSES,
  JARVIS_WORK_ITEM_STATUSES,
} from '@bob/core';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../prisma/migrations/20260818200000_jarvis_run_expand/migration.sql',
);
const migration = readFileSync(MIGRATION_PATH, 'utf8');

type GeneratedBlockName = 'JARVIS_RUN_KINDS' | 'JARVIS_RUN_STATUSES' | 'JARVIS_WORK_ITEM_STATUSES';

/** Extrait, dans l'ordre SQL, les valeurs quotées d'un bloc BEGIN/END GENERATED. */
function generatedBlock(name: GeneratedBlockName): string[] {
  const pattern = new RegExp(
    `-- BEGIN GENERATED ${name}\\b[^\\n]*\\n([\\s\\S]*?)-- END GENERATED ${name}\\b`,
  );
  const match = pattern.exec(migration);
  if (match === null) {
    throw new Error(
      `Bloc « BEGIN/END GENERATED ${name} » introuvable dans la migration U1-a (${MIGRATION_PATH})`,
    );
  }
  return [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
}

describe('Migration U1-a jarvis_run_expand — blocs GENERATED ≡ constantes @bob/core', () => {
  it('la migration porte exactement les 3 blocs GENERATED couverts par ce test', () => {
    const names = [...migration.matchAll(/-- BEGIN GENERATED (\w+)/g)].map((entry) => entry[1]);
    expect(
      names,
      'Blocs GENERATED de la migration U1-a : tout bloc ajouté ou retiré doit être couvert ici et miroité dans @bob/core',
    ).toEqual(['JARVIS_RUN_KINDS', 'JARVIS_RUN_STATUSES', 'JARVIS_WORK_ITEM_STATUSES']);
  });

  it('CHECK kind ≡ JARVIS_RUN_KINDS', () => {
    expect(
      generatedBlock('JARVIS_RUN_KINDS'),
      'Liste fautive : JARVIS_RUN_KINDS — le CHECK kind de la migration U1-a diverge de @bob/core (packages/core/src/domain/agent/jarvis-run.ts)',
    ).toEqual([...JARVIS_RUN_KINDS]);
  });

  it('CHECK status ≡ JARVIS_RUN_PERSISTED_STATUSES (union legacy ∪ §5.1)', () => {
    expect(
      generatedBlock('JARVIS_RUN_STATUSES'),
      'Liste fautive : JARVIS_RUN_PERSISTED_STATUSES — le CHECK status de la migration U1-a diverge de @bob/core (packages/core/src/domain/agent/jarvis-run.ts)',
    ).toEqual([...JARVIS_RUN_PERSISTED_STATUSES]);
  });

  it('CHECK status des work items ≡ JARVIS_WORK_ITEM_STATUSES', () => {
    expect(
      generatedBlock('JARVIS_WORK_ITEM_STATUSES'),
      'Liste fautive : JARVIS_WORK_ITEM_STATUSES — le CHECK status de jarvis_work_items diverge de @bob/core (packages/core/src/domain/agent/jarvis-work-item.ts)',
    ).toEqual([...JARVIS_WORK_ITEM_STATUSES]);
  });
});
