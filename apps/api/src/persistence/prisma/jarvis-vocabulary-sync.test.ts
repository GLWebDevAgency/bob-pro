/**
 * Vocabulaire Jarvis — SQL ↔ domaine synchrones (spec §4.4, invariant n°1 U1-b,
 * étendu U1-c : jamais un second test parallèle — greffe n°4 du panel).
 *
 * Les CHECK élargis par les migrations U1-a (20260818200000) et U1-c
 * (20260819000000 + backstop 20260819000200) ont leur source unique dans les
 * constantes `@bob/core` : ce test lit les blocs BEGIN/END GENERATED des
 * migrations et échoue sur TOUTE divergence (valeur, ordre, ajout, retrait) en
 * nommant la liste fautive. Le sens de dépendance reste propre : l'api importe
 * le core, jamais l'inverse.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AGENT_MISSION_KIND,
  CUSTOMER_CONTACT_DEFINITION_VERSION,
  CUSTOMER_CONTACT_LIMITS,
  CUSTOMER_CONTACT_PHASES,
  CUSTOMER_CONTACT_STATE_SCHEMA,
  CUSTOMER_CONTACT_STATE_VERSION,
  JARVIS_RUN_KINDS,
  JARVIS_RUN_LEASE_RELEASING_STATUSES,
  JARVIS_RUN_PERSISTED_STATUSES,
  JARVIS_RUN_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  JARVIS_WORK_ITEM_STATUSES,
  SINGLE_BUSINESS_ACTION_DEFINITION_VERSION,
  SINGLE_BUSINESS_ACTION_EVENT_TYPES,
  SINGLE_BUSINESS_ACTION_LIMITS,
  SINGLE_BUSINESS_ACTION_PHASES,
  SINGLE_BUSINESS_ACTION_STATE_SCHEMA,
  SINGLE_BUSINESS_ACTION_STATE_VERSION,
} from '@bob/core';
import { describe, expect, it } from 'vitest';

const U1A_MIGRATION_PATH = resolve(
  __dirname,
  '../../../prisma/migrations/20260818200000_jarvis_run_expand/migration.sql',
);
const U1C_EXPAND_MIGRATION_PATH = resolve(
  __dirname,
  '../../../prisma/migrations/20260819000000_jarvis_admission_expand/migration.sql',
);
const U1C_BACKSTOP_MIGRATION_PATH = resolve(
  __dirname,
  '../../../prisma/migrations/20260819000200_jarvis_foreground_backstop/migration.sql',
);
/**
 * Source des types d'événements `cc_*` : la définition U1-b elle-même. Tant que
 * `customer-contact-v1.ts` n'exporte pas de constante `CUSTOMER_CONTACT_EVENT_TYPES`
 * (extension portée par la lane principale U1-c), le vocabulaire est relevé dans la
 * SOURCE de la définition — même discipline de source unique, toute dérive d'un
 * littéral `'cc_…'` du reducer casse ce test jusqu'à ce que la migration suive.
 */
const CUSTOMER_CONTACT_DEFINITION_SOURCE_PATH = resolve(
  __dirname,
  '../../../../../packages/core/src/domain/agent/definitions/customer-contact-v1.ts',
);

const u1aMigration = readFileSync(U1A_MIGRATION_PATH, 'utf8');
const u1cExpandMigration = readFileSync(U1C_EXPAND_MIGRATION_PATH, 'utf8');
const u1cBackstopMigration = readFileSync(U1C_BACKSTOP_MIGRATION_PATH, 'utf8');
const customerContactDefinitionSource = readFileSync(
  CUSTOMER_CONTACT_DEFINITION_SOURCE_PATH,
  'utf8',
);

/**
 * Événement système de quarantaine §5.5 (spec U1-c §1) : écrit par l'admission,
 * pas par une définition — sa constante core arrive avec la lane principale.
 */
const JARVIS_SYSTEM_EVENT_TYPES = ['run_quarantined'] as const;

/** Types `cc_*` relevés dans la définition U1-b (littéraux du reducer, dédupliqués). */
const customerContactEventTypes = [
  ...new Set(
    [...customerContactDefinitionSource.matchAll(/'(cc_[a-z0-9_]+)'/g)].map((entry) => entry[1]),
  ),
];

/** Toutes les occurrences d'un bloc GENERATED (valeurs quotées, dans l'ordre SQL). */
function generatedBlockOccurrences(migration: string, name: string): string[][] {
  const pattern = new RegExp(
    `-- BEGIN GENERATED ${name}\\b[^\\n]*\\n([\\s\\S]*?)-- END GENERATED ${name}\\b`,
    'g',
  );
  return [...migration.matchAll(pattern)].map((match) =>
    [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]),
  );
}

/**
 * Valeurs d'un bloc GENERATED ; exige au moins une occurrence ET que toutes les
 * occurrences du même nom soient identiques (une édition partielle d'un bloc
 * répété est une divergence).
 */
function generatedBlock(migration: string, path: string, name: string): string[] {
  const occurrences = generatedBlockOccurrences(migration, name);
  if (occurrences.length === 0) {
    throw new Error(`Bloc « BEGIN/END GENERATED ${name} » introuvable dans ${path}`);
  }
  const [first, ...rest] = occurrences;
  for (const other of rest) {
    expect(
      other,
      `Occurrences divergentes du bloc GENERATED ${name} dans ${path} — toutes doivent être identiques`,
    ).toEqual(first);
  }
  return first;
}

describe('Migration U1-a jarvis_run_expand — blocs GENERATED ≡ constantes @bob/core', () => {
  it('la migration porte exactement les 3 blocs GENERATED couverts par ce test', () => {
    const names = [...u1aMigration.matchAll(/-- BEGIN GENERATED (\w+)/g)].map((entry) => entry[1]);
    expect(
      names,
      'Blocs GENERATED de la migration U1-a : tout bloc ajouté ou retiré doit être couvert ici et miroité dans @bob/core',
    ).toEqual(['JARVIS_RUN_KINDS', 'JARVIS_RUN_STATUSES', 'JARVIS_WORK_ITEM_STATUSES']);
  });

  it('CHECK kind ≡ JARVIS_RUN_KINDS', () => {
    expect(
      generatedBlock(u1aMigration, U1A_MIGRATION_PATH, 'JARVIS_RUN_KINDS'),
      'Liste fautive : JARVIS_RUN_KINDS — le CHECK kind de la migration U1-a diverge de @bob/core (packages/core/src/domain/agent/jarvis-run.ts)',
    ).toEqual([...JARVIS_RUN_KINDS]);
  });

  it('CHECK status ≡ JARVIS_RUN_PERSISTED_STATUSES (union legacy ∪ §5.1)', () => {
    expect(
      generatedBlock(u1aMigration, U1A_MIGRATION_PATH, 'JARVIS_RUN_STATUSES'),
      'Liste fautive : JARVIS_RUN_PERSISTED_STATUSES — le CHECK status de la migration U1-a diverge de @bob/core (packages/core/src/domain/agent/jarvis-run.ts)',
    ).toEqual([...JARVIS_RUN_PERSISTED_STATUSES]);
  });

  it('CHECK status des work items ≡ JARVIS_WORK_ITEM_STATUSES', () => {
    expect(
      generatedBlock(u1aMigration, U1A_MIGRATION_PATH, 'JARVIS_WORK_ITEM_STATUSES'),
      'Liste fautive : JARVIS_WORK_ITEM_STATUSES — le CHECK status de jarvis_work_items diverge de @bob/core (packages/core/src/domain/agent/jarvis-work-item.ts)',
    ).toEqual([...JARVIS_WORK_ITEM_STATUSES]);
  });
});

describe('Migration U1-c jarvis_admission_expand — branches jarvis ≡ définitions U1-b', () => {
  const expand = (name: string): string[] =>
    generatedBlock(u1cExpandMigration, U1C_EXPAND_MIGRATION_PATH, name);

  it('les blocs GENERATED propres à U1-c sont exactement ceux couverts par ce test', () => {
    // La migration recopie VERBATIM les branches quote (et donc leurs blocs legacy,
    // couverts par leurs propres sources) ; seuls les blocs de la branche jarvis
    // sont énumérés ici — tout ajout/retrait doit être miroité dans ce test.
    const names = new Set(
      [...u1cExpandMigration.matchAll(/-- BEGIN GENERATED (\w+)/g)].map((entry) => entry[1]),
    );
    const jarvisNames = [...names]
      .filter(
        (name) =>
          name.startsWith('JARVIS_') ||
          name === 'CUSTOMER_CONTACT_MISSION_PHASES' ||
          name === 'SINGLE_BUSINESS_ACTION_MISSION_PHASES',
      )
      .sort();
    expect(jarvisNames).toEqual([
      'CUSTOMER_CONTACT_MISSION_PHASES',
      'JARVIS_CC_DEFINITION_VERSIONS',
      'JARVIS_CC_STATE_SCHEMA',
      'JARVIS_CC_STATE_VERSION',
      'JARVIS_EVENT_TYPES',
      'JARVIS_MAX_STATE_BYTES',
      'JARVIS_RUN_TERMINAL_STATUSES',
      'JARVIS_SBA_DEFINITION_VERSIONS',
      'JARVIS_SBA_STATE_SCHEMA',
      'JARVIS_SBA_STATE_VERSION',
      'JARVIS_STATE_ENVELOPE_KEYS',
      'SINGLE_BUSINESS_ACTION_MISSION_PHASES',
    ]);
  });

  it('CHECK events (type/envelope/data/correlation/draft_effect) ≡ vocabulaire des définitions (ordre trié)', () => {
    expect(
      customerContactEventTypes.length,
      `Aucun littéral 'cc_…' relevé dans ${CUSTOMER_CONTACT_DEFINITION_SOURCE_PATH} — le relevé de source est cassé`,
    ).toBeGreaterThan(0);
    const expected = [
      ...new Set([
        ...customerContactEventTypes,
        ...SINGLE_BUSINESS_ACTION_EVENT_TYPES,
        ...JARVIS_SYSTEM_EVENT_TYPES,
      ]),
    ].sort();
    expect(
      expand('JARVIS_EVENT_TYPES'),
      'Liste fautive : JARVIS_EVENT_TYPES — les CHECK events divergent des définitions U1-b (cc_*/sba_*) ∪ run_quarantined §5.5',
    ).toEqual(expected);
  });

  it('CHECK phase ≡ phases exportées par les définitions', () => {
    expect(
      expand('CUSTOMER_CONTACT_MISSION_PHASES'),
      'Liste fautive : CUSTOMER_CONTACT_PHASES (customer-contact-v1.ts)',
    ).toEqual([...CUSTOMER_CONTACT_PHASES]);
    expect(
      expand('SINGLE_BUSINESS_ACTION_MISSION_PHASES'),
      'Liste fautive : SINGLE_BUSINESS_ACTION_PHASES (single-business-action-v1.ts)',
    ).toEqual([...SINGLE_BUSINESS_ACTION_PHASES]);
  });

  it('CHECK payload ≡ schémas et versions de state épinglés par kind', () => {
    expect(expand('JARVIS_CC_STATE_SCHEMA')).toEqual([CUSTOMER_CONTACT_STATE_SCHEMA]);
    expect(expand('JARVIS_SBA_STATE_SCHEMA')).toEqual([SINGLE_BUSINESS_ACTION_STATE_SCHEMA]);
    expect(expand('JARVIS_CC_STATE_VERSION')).toEqual([String(CUSTOMER_CONTACT_STATE_VERSION)]);
    expect(expand('JARVIS_SBA_STATE_VERSION')).toEqual([
      String(SINGLE_BUSINESS_ACTION_STATE_VERSION),
    ]);
    expect(
      expand('JARVIS_STATE_ENVELOPE_KEYS'),
      'Enveloppe minimale du state §5.1 : schema et version, rien d’autre au niveau SQL',
    ).toEqual(['schema', 'version']);
  });

  it('CHECK protocol ≡ versions de définition admises par kind', () => {
    expect(expand('JARVIS_CC_DEFINITION_VERSIONS')).toEqual([
      String(CUSTOMER_CONTACT_DEFINITION_VERSION),
    ]);
    expect(expand('JARVIS_SBA_DEFINITION_VERSIONS')).toEqual([
      String(SINGLE_BUSINESS_ACTION_DEFINITION_VERSION),
    ]);
  });

  it('borne de taille ≡ limits.maxStateBytes des définitions U1-b', () => {
    expect(
      CUSTOMER_CONTACT_LIMITS.maxStateBytes,
      'Les deux définitions doivent partager la même borne tant que la migration ne branche pas la taille par kind',
    ).toBe(SINGLE_BUSINESS_ACTION_LIMITS.maxStateBytes);
    expect(expand('JARVIS_MAX_STATE_BYTES')).toEqual([
      String(CUSTOMER_CONTACT_LIMITS.maxStateBytes),
    ]);
  });

  it('CHECK timestamps ≡ JARVIS_RUN_TERMINAL_STATUSES (ordre trié)', () => {
    expect(
      expand('JARVIS_RUN_TERMINAL_STATUSES'),
      'Liste fautive : JARVIS_RUN_TERMINAL_STATUSES (jarvis-run.ts §5.1)',
    ).toEqual([...JARVIS_RUN_TERMINAL_STATUSES].sort());
  });

  it('chaque discriminant "kind" IN (…) ≡ kinds jarvis (JARVIS_RUN_KINDS moins quote)', () => {
    const expected = JARVIS_RUN_KINDS.filter((kind) => kind !== AGENT_MISSION_KIND);
    const occurrences = [...u1cExpandMigration.matchAll(/"kind" IN \(([^)]*)\)/g)].map((match) =>
      [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]),
    );
    expect(
      occurrences.length,
      'Chaque contrainte missions kind-conditionnelle porte un discriminant "kind" IN (…)',
    ).toBeGreaterThanOrEqual(6);
    for (const values of occurrences) {
      expect(
        values,
        'Un discriminant "kind" IN (…) de la migration U1-c diverge de JARVIS_RUN_KINDS \\ quote_creation',
      ).toEqual([...expected]);
    }
  });
});

describe('Migration U1-c jarvis_foreground_backstop — statuts non-libérants ≡ §5.1', () => {
  it('index partiel ≡ statuts qui TIENNENT le premier plan', () => {
    // Non-libérants = tous les statuts §5.1 moins les terminaux, les libérants
    // (waiting_external/parked/cancelling) et `quarantined` (§5.5 : un run gelé ne
    // doit jamais bloquer le premier plan de son owner — spec U1-c §4).
    const expected = JARVIS_RUN_STATUSES.filter(
      (status) =>
        !JARVIS_RUN_TERMINAL_STATUSES.has(status) &&
        !JARVIS_RUN_LEASE_RELEASING_STATUSES.has(status) &&
        status !== 'quarantined',
    );
    expect(expected).toEqual(['active', 'waiting_user', 'waiting_screen', 'retry_due']);
    expect(
      generatedBlock(
        u1cBackstopMigration,
        U1C_BACKSTOP_MIGRATION_PATH,
        'JARVIS_FOREGROUND_HOLDING_STATUSES',
      ),
      'Liste fautive : JARVIS_FOREGROUND_HOLDING_STATUSES — le backstop agent_missions_one_active_owner_key diverge de §5.1',
    ).toEqual([...expected]);
  });
});
