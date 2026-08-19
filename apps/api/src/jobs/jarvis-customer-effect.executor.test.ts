/**
 * Jarvis U1-d — L'INDÉCIDABLE SE LIT, IL NE S'ANNONCE PAS (revue C10).
 *
 * Fakes seulement : les preuves d'écriture canonique et d'idempotence §9.1 vivent dans
 * jarvis-customer-effect.executor.postgres.test.ts. Ici on prouve la seule chose qu'un fake
 * puisse prouver honnêtement — la DÉCISION après une écriture d'issue inconnue : la fiche est
 * cherchée à sa clé d'idempotence (le `customerId` DÉRIVÉ de l'`effectId`) avant qu'un mot soit
 * prononcé, un succès n'est jamais inventé sur une absence, et une lecture impossible se dit.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_STATE_SCHEMA,
  CUSTOMER_CONTACT_STATE_VERSION,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  sha256Hex,
  type CustomerContactProposedFieldsV1,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadStorePort,
  type JarvisRunEnvelope,
} from '@bob/core';
import type {
  JarvisWorkItemCoordinates,
  JarvisWorkItemLease,
} from '../persistence/prisma/jarvis-work-items.persistence';
import {
  JarvisCustomerEffectExecutor,
  deriveJarvisEffectCustomerId,
  jarvisCustomerEffectSuccessDigest,
  jarvisCustomerEffectUnknownDigest,
  type JarvisCustomerEffectAuthority,
  type JarvisCustomerEffectTarget,
  type JarvisCustomerFields,
  type JarvisCustomerSnapshot,
  type JarvisCustomerWriteResult,
} from './jarvis-customer-effect.executor';

const COMPANY_ID = 'co_1';
const OWNER_USER_ID = 'usr_1';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const EFFECT_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const RECEIPT_ID = '55555555-5555-4555-8555-555555555555';
const LEASE_TOKEN = '66666666-6666-4666-8666-666666666666';
const CONFIRMATION_ID = '77777777-7777-4777-8777-777777777777';
const WAKE_ID = '88888888-8888-4888-8888-888888888888';
const TARGET_CUSTOMER_ID = 'cus_existante';

const COORDINATES: JarvisWorkItemCoordinates = {
  companyId: COMPANY_ID,
  ownerUserId: OWNER_USER_ID,
  runId: RUN_ID,
};

const FIELDS: CustomerContactProposedFieldsV1 = Object.freeze({
  displayName: 'Marie Dupont',
  legalName: null,
  email: 'marie.dupont@example.test',
  phone: '0601020304',
  addressLine: '12 rue des Lilas',
  postalCode: '75011',
  city: 'Paris',
  vatNumber: null,
  billingChannel: null,
  recipientName: null,
});

const FIELDS_DIGEST = computeCustomerContactFieldsDigest(FIELDS);
const SENSITIVE_DIGEST = computeCustomerContactSensitiveDigest(FIELDS);
const DERIVED_CUSTOMER_ID = deriveJarvisEffectCustomerId(EFFECT_ID);

const EXISTING_FIELDS: JarvisCustomerFields = {
  type: 'b2c',
  name: 'Marie Dupont',
  address: { line1: '1 rue Ancienne', zip: '75001', city: 'Paris' },
};

type ReadStep = 'absent' | 'present' | 'throws';

/** Autorité métier fake, scriptable et NON complaisante : elle ne devine jamais à la place du code. */
class ScriptedAuthority implements JarvisCustomerEffectAuthority {
  readonly reads: JarvisCustomerEffectTarget[] = [];
  writes = 0;

  constructor(
    private readonly readScript: ReadStep[],
    private readonly write: () => Promise<JarvisCustomerWriteResult>,
  ) {}

  async readCustomer(target: JarvisCustomerEffectTarget): Promise<JarvisCustomerSnapshot | null> {
    this.reads.push(target);
    const step = this.readScript[this.reads.length - 1] ?? 'absent';
    if (step === 'throws') throw new Error('base indisponible');
    return step === 'present' ? { customerId: target.customerId, fields: EXISTING_FIELDS } : null;
  }

  async createCustomer(): Promise<JarvisCustomerWriteResult> {
    this.writes += 1;
    return this.write();
  }

  async updateCustomer(): Promise<JarvisCustomerWriteResult> {
    this.writes += 1;
    return this.write();
  }
}

function stateFixture(mode: 'create' | 'update'): unknown {
  return {
    schema: CUSTOMER_CONTACT_STATE_SCHEMA,
    version: CUSTOMER_CONTACT_STATE_VERSION,
    phase: 'committing',
    steps: 3,
    effectId: EFFECT_ID,
    intent:
      mode === 'create'
        ? { mode: 'create' }
        : { mode: 'update', target: { customerId: TARGET_CUSTOMER_ID, revision: 2 } },
    duplicateReview: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalCommandId: PROPOSAL_COMMAND_ID,
      fieldsDigest: FIELDS_DIGEST,
      sensitiveDigest: SENSITIVE_DIGEST,
      targetRevision: mode === 'update' ? 2 : null,
      proposalHash: sha256Hex('proposition'),
    },
    // Phase `committing` : la définition EXIGE une confirmation consommée — l'effet ne part
    // jamais sans le geste de l'artisan (§7.1).
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'consumed',
      issuedAt: '2026-08-19T09:58:00.000Z',
      presentedAt: '2026-08-19T09:59:00.000Z',
      expiresAt: '2026-08-19T10:28:00.000Z',
      consumedByCommandId: RECEIPT_ID,
      wakeId: WAKE_ID,
    },
    receipt: null,
    resolvedExistingCustomerId: null,
    submittedJobRef: null,
    wakes: [],
    wakesScheduled: 0,
    cancelReason: null,
    failureReason: null,
  };
}

function admissionFor(mode: 'create' | 'update'): JarvisAdmissionUnitOfWorkPort {
  const run = {
    kind: 'customer_contact',
    runId: RUN_ID,
    companyId: COMPANY_ID,
    createdBy: OWNER_USER_ID,
    definitionVersion: 1,
    status: 'waiting_external',
    revision: 7,
    stateVersion: CUSTOMER_CONTACT_STATE_VERSION,
    state: stateFixture(mode),
    nextWakeAt: null,
    terminalAt: null,
  } as unknown as JarvisRunEnvelope;
  return {
    async runJarvisAdmission() {
      throw new Error('inattendu : un exécuteur ne soumet jamais de commande utilisateur');
    },
    async runJarvisSystemAdmission() {
      throw new Error('inattendu : le signal appartient au worker, pas à l’exécuteur');
    },
    async readJarvisStateless(
      _owner: unknown,
      read: (view: {
        runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
      }) => Promise<unknown>,
    ) {
      const value = await read({ runById: async () => run });
      return { status: 'executed', value, readAt: '2026-08-19T10:00:00.000Z' };
    },
  } as unknown as JarvisAdmissionUnitOfWorkPort;
}

const PAYLOADS: JarvisProposalPayloadStorePort = {
  async sealProposalPayload() {
    throw new Error('inattendu : l’exécuteur ne scelle jamais de charge');
  },
  async readProposalPayload(ref) {
    return {
      ...ref,
      sensitiveDigest: SENSITIVE_DIGEST,
      fields: FIELDS,
    };
  },
};

function leaseFixture(mode: 'create' | 'update'): JarvisWorkItemLease {
  return {
    id: 'wi_1',
    effectId: EFFECT_ID,
    actionId:
      mode === 'create' ? CUSTOMER_CONTACT_CREATE_ACTION_ID : CUSTOMER_CONTACT_UPDATE_ACTION_ID,
    actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
    authorizationSource: { source: 'confirmation', receiptId: RECEIPT_ID },
    actingPrincipalId: OWNER_USER_ID,
    targetDigest: null,
    payloadRef: { proposalId: PROPOSAL_ID, fieldsDigest: FIELDS_DIGEST },
    executeBy: '2026-08-19T12:00:00.000Z',
    attempts: 0,
    leaseToken: LEASE_TOKEN,
    leaseFence: 1n,
    leaseExpiresAt: '2026-08-19T10:05:00.000Z',
  };
}

function executorFor(
  mode: 'create' | 'update',
  readScript: ReadStep[],
  write: () => Promise<JarvisCustomerWriteResult>,
): { executor: JarvisCustomerEffectExecutor; authority: ScriptedAuthority } {
  const authority = new ScriptedAuthority(readScript, write);
  const executor = new JarvisCustomerEffectExecutor({
    admission: admissionFor(mode),
    payloads: PAYLOADS,
    customers: authority,
    // Le type légal n'est pas encore proposé par la frame (§8) : le harnais le fournit, comme
    // la certification PostgreSQL — sans lui, la création serait refusée avant toute écriture.
    certificationCustomerType: 'b2c',
  });
  return { executor, authority };
}

const throwing = (): Promise<JarvisCustomerWriteResult> => {
  throw new Error('autorité en panne');
};
const unavailable = async (): Promise<JarvisCustomerWriteResult> => ({ status: 'unavailable' });

describe('JarvisCustomerEffectExecutor — l’indécidable de création se tranche par une lecture', () => {
  it('exception APRÈS le commit : la fiche dérivée existe ⇒ succès, jamais « je n’ai pas pu enregistrer »', async () => {
    const { executor, authority } = executorFor('create', ['absent', 'present'], throwing);

    const outcome = await executor.execute({
      coordinates: COORDINATES,
      lease: leaseFixture('create'),
    });

    expect(outcome).toEqual({
      status: 'succeeded',
      resultDigest: jarvisCustomerEffectSuccessDigest(EFFECT_ID, DERIVED_CUSTOMER_ID),
    });
    // La lecture qui tranche interroge la CLÉ D'IDEMPOTENCE : l'identifiant dérivé de l'effet.
    expect(authority.reads.map((target) => target.customerId)).toEqual([
      DERIVED_CUSTOMER_ID,
      DERIVED_CUSTOMER_ID,
    ]);
    expect(authority.writes).toBe(1);
  });

  it('absence lue après la panne ⇒ outcome_unknown MOTIVÉ, jamais un succès inventé', async () => {
    const { executor, authority } = executorFor('create', ['absent', 'absent'], throwing);

    const outcome = await executor.execute({
      coordinates: COORDINATES,
      lease: leaseFixture('create'),
    });

    expect(outcome).toEqual({
      status: 'outcome_unknown',
      resultDigest: jarvisCustomerEffectUnknownDigest(
        EFFECT_ID,
        'customer_authority_failed_not_landed',
      ),
    });
    expect(authority.reads).toHaveLength(2);
  });

  it('autorité qui se déclare indisponible ⇒ MÊME lecture, motif distinct', async () => {
    const { executor } = executorFor('create', ['absent', 'present'], unavailable);

    const outcome = await executor.execute({
      coordinates: COORDINATES,
      lease: leaseFixture('create'),
    });

    expect(outcome).toEqual({
      status: 'succeeded',
      resultDigest: jarvisCustomerEffectSuccessDigest(EFFECT_ID, DERIVED_CUSTOMER_ID),
    });
  });

  it('autorité indisponible ET fiche absente ⇒ outcome_unknown motif `customer_authority_unavailable_not_landed`', async () => {
    const { executor } = executorFor('create', ['absent', 'absent'], unavailable);

    const outcome = await executor.execute({
      coordinates: COORDINATES,
      lease: leaseFixture('create'),
    });

    expect(outcome).toEqual({
      status: 'outcome_unknown',
      resultDigest: jarvisCustomerEffectUnknownDigest(
        EFFECT_ID,
        'customer_authority_unavailable_not_landed',
      ),
    });
  });

  it('lecture impossible : on ne sait rien et on le DIT (`_unreadable`), sans clore un succès', async () => {
    const { executor } = executorFor('create', ['absent', 'throws'], throwing);

    const outcome = await executor.execute({
      coordinates: COORDINATES,
      lease: leaseFixture('create'),
    });

    expect(outcome).toEqual({
      status: 'outcome_unknown',
      resultDigest: jarvisCustomerEffectUnknownDigest(
        EFFECT_ID,
        'customer_authority_failed_unreadable',
      ),
    });
  });

  it('édition : trou ASSUMÉ — outcome_unknown motivé et AUCUNE relecture trompeuse', async () => {
    const { executor, authority } = executorFor('update', ['present'], throwing);

    const outcome = await executor.execute({
      coordinates: COORDINATES,
      lease: leaseFixture('update'),
    });

    expect(outcome).toEqual({
      status: 'outcome_unknown',
      resultDigest: jarvisCustomerEffectUnknownDigest(EFFECT_ID, 'customer_authority_failed'),
    });
    // Une seule lecture : celle de la cible AVANT l'écriture. Relire après ne prouverait rien
    // (la fiche existe des deux côtés, et le postimage ne dit pas QUI l'a écrit) — le trou est
    // nommé dans le code, pas masqué par une relecture qui rassurerait à tort.
    expect(authority.reads.map((target) => target.customerId)).toEqual([TARGET_CUSTOMER_ID]);
  });

  it('réconciliation : création atterrie ⇒ `landed` avec le digest de succès ; jamais exécutée ⇒ `not_landed`', async () => {
    const landed = executorFor('create', ['present'], throwing);
    const never = executorFor('create', ['absent'], throwing);
    const lease = leaseFixture('create');

    await expect(
      landed.executor.reconcileEffect({ coordinates: COORDINATES, lease }),
    ).resolves.toEqual({
      kind: 'landed',
      outcome: {
        status: 'succeeded',
        resultDigest: jarvisCustomerEffectSuccessDigest(EFFECT_ID, DERIVED_CUSTOMER_ID),
      },
    });
    await expect(
      never.executor.reconcileEffect({ coordinates: COORDINATES, lease }),
    ).resolves.toEqual({ kind: 'not_landed' });
    // Aucune écriture : la réconciliation est une LECTURE, elle ne clôt rien elle-même.
    expect(landed.authority.writes + never.authority.writes).toBe(0);
  });

  it('réconciliation : édition rejouable, base muette indécidable', async () => {
    const update = executorFor('update', ['present'], throwing);
    const mute = executorFor('create', ['throws'], throwing);

    await expect(
      update.executor.reconcileEffect({ coordinates: COORDINATES, lease: leaseFixture('update') }),
    ).resolves.toEqual({ kind: 'safe_to_replay' });
    await expect(
      mute.executor.reconcileEffect({ coordinates: COORDINATES, lease: leaseFixture('create') }),
    ).resolves.toEqual({ kind: 'undecidable' });
  });
});
