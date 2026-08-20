import { describe, expect, it } from 'vitest';
import {
  JARVIS_PRESENTED_FIELDS_MAX,
  decodeCustomerContactPresentation,
  decodeJarvisCommandReceipt,
  decodeJarvisCurrentRun,
  decodeJarvisRun,
  decodeJarvisRunSnapshot,
  encodeJarvisOpenRunIntent,
  encodeJarvisRunCommand,
  isJarvisAdmissionKind,
  isJarvisUserCommandId,
} from './jarvis-codec';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    status: 'waiting_user',
    revision: 4,
    nextWakeAt: '2026-08-19T10:05:00.000Z',
    terminalAt: null,
    ...overrides,
  };
}

function field(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    field: 'name',
    label: 'Nom du client',
    before: null,
    after: 'Dupont Plomberie',
    sensitiveField: null,
    ...overrides,
  };
}

function presentation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'bob.jarvis-run.customer-contact-presentation',
    version: 1,
    phase: 'awaiting_confirmation',
    intent: 'create',
    targetCustomerId: null,
    targetLabel: null,
    // U1-h — LOCKSTEP : le decodeur refuse A LA FORME sur cle inconnue, donc toute cle
    // ajoutee au wire serveur doit apparaitre ICI, sinon la presentation entiere devient
    // `null` et PLUS AUCUNE carte ne s'affiche — y compris le parcours de modification.
    duplicateReview: null,
    completion: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalHash: HASH,
      fieldsDigest: DIGEST,
      fields: [field()],
    },
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'issued',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: null,
    },
    ...overrides,
  };
}

describe('jarvis-codec — projection du run', () => {
  it('décode un run projeté et refuse toute clé inconnue', () => {
    expect(decodeJarvisRun(run())).toMatchObject({ runId: RUN_ID, revision: 4 });
    expect(decodeJarvisRun({ ...run(), extra: 1 })).toBeNull();
    expect(decodeJarvisRun({ ...run(), state: { secret: true } })).toBeNull();
  });

  it('refuse la branche quote_creation : le writer N-1 ne traverse jamais ce wire', () => {
    expect(decodeJarvisRun(run({ kind: 'quote_creation' }))).toBeNull();
    expect(isJarvisAdmissionKind('quote_creation')).toBe(false);
    expect(isJarvisAdmissionKind('customer_contact')).toBe(true);
    expect(isJarvisAdmissionKind('single_business_action')).toBe(true);
  });

  it('refuse un statut hors des onze statuts §5.1 et une révision non entière', () => {
    expect(decodeJarvisRun(run({ status: 'en_cours' }))).toBeNull();
    expect(decodeJarvisRun(run({ revision: 1.5 }))).toBeNull();
    expect(decodeJarvisRun(run({ revision: 0 }))).toBeNull();
  });

  it('exige des instants ISO canoniques, aller-retour exact', () => {
    expect(decodeJarvisRun(run({ nextWakeAt: '2026-08-19T10:05:00Z' }))).toBeNull();
    expect(decodeJarvisRun(run({ terminalAt: '2026-08-19' }))).toBeNull();
    expect(decodeJarvisRun(run({ nextWakeAt: null }))).not.toBeNull();
  });
});

describe('jarvis-codec — présentation serveur', () => {
  it('décode une création et gèle les champs proposés', () => {
    const decoded = decodeCustomerContactPresentation(presentation());
    expect(decoded?.proposal?.fields[0]).toMatchObject({
      field: 'name',
      label: 'Nom du client',
      before: null,
      after: 'Dupont Plomberie',
    });
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it('lie l’intention à la cible : une modification sans cible relue n’existe pas', () => {
    expect(decodeCustomerContactPresentation(presentation({ intent: 'update' }))).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({ intent: 'update', targetCustomerId: CUSTOMER_ID }),
      ),
    ).not.toBeNull();
    expect(
      decodeCustomerContactPresentation(presentation({ targetCustomerId: CUSTOMER_ID })),
    ).toBeNull();
  });

  it('refuse une confirmation sans proposition scellée', () => {
    expect(decodeCustomerContactPresentation(presentation({ proposal: null }))).toBeNull();
  });

  it('refuse un champ dupliqué, vide, non borné ou porteur de contrôle', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field(), field({ after: 'Autre' })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ label: '   ' })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ after: 'Dupont\u0007' })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ after: 'D'.repeat(513) })],
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: Array.from({ length: JARVIS_PRESENTED_FIELDS_MAX + 1 }, (_value, index) =>
              field({ field: `champ_${index}` }),
            ),
          },
        }),
      ),
    ).toBeNull();
  });

  it('n’accepte qu’un champ sensible du vocabulaire §9.1', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ sensitiveField: 'vat_profile' })],
          },
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH,
            fieldsDigest: DIGEST,
            fields: [field({ sensitiveField: 'iban' })],
          },
        }),
      ),
    ).toBeNull();
  });

  it('refuse un digest ou un hash non canonique', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          proposal: {
            proposalId: PROPOSAL_ID,
            proposalHash: HASH.toUpperCase(),
            fieldsDigest: DIGEST,
            fields: [field()],
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('jarvis-codec — instantané et reçu', () => {
  it('accepte une présentation absente : le digest non revérifié ferme l’écran', () => {
    expect(decodeJarvisRunSnapshot({ run: run(), presentation: null })).toMatchObject({
      presentation: null,
    });
  });

  it('refuse un instantané dont la présentation est corrompue plutôt que de l’amputer', () => {
    expect(
      decodeJarvisRunSnapshot({ run: run(), presentation: presentation({ phase: 'inconnue' }) }),
    ).toBeNull();
    expect(decodeJarvisRunSnapshot({ run: run() })).toBeNull();
  });

  it('ne connaît que les deux issues d’un reçu : admitted et replayed', () => {
    expect(
      decodeJarvisCommandReceipt({
        outcome: 'replayed',
        run: run(),
        presentation: presentation(),
        eventSequence: 12,
      }),
    ).toMatchObject({ outcome: 'replayed', eventSequence: 12 });
    expect(
      decodeJarvisCommandReceipt({
        outcome: 'stale_revision',
        run: run(),
        presentation: null,
        eventSequence: 12,
      }),
    ).toBeNull();
    expect(
      decodeJarvisCommandReceipt({
        outcome: 'admitted',
        run: run(),
        presentation: null,
        eventSequence: 0,
      }),
    ).toBeNull();
  });
});

describe('jarvis-codec — canal des commandes humaines', () => {
  it('reconstruit les quatre gestes clé par clé', () => {
    expect(
      encodeJarvisRunCommand({
        type: 'record_presentation_ack',
        confirmationId: CONFIRMATION_ID,
        ack: 'screen_ack',
      }),
    ).toEqual({
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'screen_ack',
    });
    expect(
      encodeJarvisRunCommand({
        type: 'confirm',
        confirmationId: CONFIRMATION_ID,
        proposalHash: HASH,
      }),
    ).toEqual({ type: 'confirm', confirmationId: CONFIRMATION_ID, proposalHash: HASH });
    expect(
      encodeJarvisRunCommand({ type: 'reject_proposal', confirmationId: CONFIRMATION_ID }),
    ).toEqual({ type: 'reject_proposal', confirmationId: CONFIRMATION_ID });
    expect(encodeJarvisRunCommand({ type: 'cancel_run', reason: 'user_cancelled' })).toEqual({
      type: 'cancel_run',
      reason: 'user_cancelled',
    });
  });

  it('ferme le canal : ni ack vocal, ni clé étrangère, ni commande système', () => {
    expect(
      encodeJarvisRunCommand({
        type: 'record_presentation_ack',
        confirmationId: CONFIRMATION_ID,
        ack: 'voice_presentation_ack',
      }),
    ).toBeNull();
    expect(
      encodeJarvisRunCommand({
        type: 'confirm',
        confirmationId: CONFIRMATION_ID,
        proposalHash: HASH,
        revalidatedTargetRevision: 3,
      }),
    ).toBeNull();
    expect(
      encodeJarvisRunCommand({
        type: 'record_effect_receipt',
        effectId: PROPOSAL_ID,
        outcome: { kind: 'succeeded', customerId: CUSTOMER_ID, customerRevision: 1 },
      }),
    ).toBeNull();
    expect(encodeJarvisRunCommand({ type: 'wake_run', wakeId: PROPOSAL_ID })).toBeNull();
    expect(
      encodeJarvisRunCommand({
        type: 'confirm',
        confirmationId: CONFIRMATION_ID,
        proposalHash: 'x',
      }),
    ).toBeNull();
  });
});

describe('jarvis-codec — découverte du run courant (U1-e §1)', () => {
  it('décode « aucun run » : les DEUX champs nuls, et rien d’autre', () => {
    expect(decodeJarvisCurrentRun({ run: null, presentation: null })).toEqual({
      run: null,
      presentation: null,
    });
    expect(Object.isFrozen(decodeJarvisCurrentRun({ run: null, presentation: null }))).toBe(true);
    // Une présentation sans run est une carte orpheline : elle n'atteint jamais l'écran.
    expect(decodeJarvisCurrentRun({ run: null, presentation: presentation() })).toBeNull();
  });

  it('décode un run courant et sa présentation, ou une présentation absente (G4)', () => {
    expect(decodeJarvisCurrentRun({ run: run(), presentation: presentation() })).toMatchObject({
      run: { runId: RUN_ID },
      presentation: { phase: 'awaiting_confirmation' },
    });
    expect(decodeJarvisCurrentRun({ run: run(), presentation: null })).toMatchObject({
      run: { runId: RUN_ID },
      presentation: null,
    });
    // Contrat cassé : une présentation illisible ne devient jamais une présentation partielle.
    expect(decodeJarvisCurrentRun({ run: run(), presentation: {} })).toBeNull();
  });

  it('refuse un run TERMINAL : « courant » et « terminé » s’excluent', () => {
    expect(
      decodeJarvisCurrentRun({ run: run({ status: 'completed' }), presentation: null }),
    ).toBeNull();
    expect(
      decodeJarvisCurrentRun({ run: run({ status: 'cancelled' }), presentation: null }),
    ).toBeNull();
    expect(
      decodeJarvisCurrentRun({ run: run({ status: 'failed_terminal' }), presentation: null }),
    ).toBeNull();
    // `terminalAt` posé sur un statut non terminal est tout aussi contradictoire.
    expect(
      decodeJarvisCurrentRun({
        run: run({ terminalAt: '2026-08-19T10:05:00.000Z' }),
        presentation: null,
      }),
    ).toBeNull();
    // `parked` n'est PAS terminal : c'est précisément le run qu'on vient reprendre à l'écran.
    expect(
      decodeJarvisCurrentRun({ run: run({ status: 'parked' }), presentation: null }),
    ).not.toBeNull();
  });

  it('refuse toute clé inconnue ou manquante dans l’enveloppe de découverte', () => {
    expect(decodeJarvisCurrentRun({ run: null, presentation: null, readAt: 'x' })).toBeNull();
    expect(decodeJarvisCurrentRun({ run: null })).toBeNull();
    expect(decodeJarvisCurrentRun([{ run: null, presentation: null }])).toBeNull();
  });
});

describe('jarvis-codec — intention d’ouverture (U1-e §1)', () => {
  it('reconstruit `{ mode: update, target: { customerId } }` clé par clé', () => {
    const intent = encodeJarvisOpenRunIntent({
      mode: 'update',
      target: { customerId: CUSTOMER_ID },
    });
    expect(intent).toEqual({ mode: 'update', target: { customerId: CUSTOMER_ID } });
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it('refuse une création : l’écran n’ouvre que des modifications', () => {
    expect(encodeJarvisOpenRunIntent({ mode: 'create' })).toBeNull();
    expect(
      encodeJarvisOpenRunIntent({ mode: 'create', target: { customerId: CUSTOMER_ID } }),
    ).toBeNull();
  });

  it('refuse une révision de cible affirmée par le client (§7.1 : le serveur relit)', () => {
    expect(
      encodeJarvisOpenRunIntent({
        mode: 'update',
        target: { customerId: CUSTOMER_ID, revision: 3 },
      }),
    ).toBeNull();
  });

  it('refuse une cible absente, non canonique ou une clé étrangère', () => {
    expect(encodeJarvisOpenRunIntent({ mode: 'update' })).toBeNull();
    expect(
      encodeJarvisOpenRunIntent({ mode: 'update', target: { customerId: 'client-1' } }),
    ).toBeNull();
    expect(
      encodeJarvisOpenRunIntent({
        mode: 'update',
        target: { customerId: CUSTOMER_ID },
        actionId: 'client-modifier',
      }),
    ).toBeNull();
    expect(encodeJarvisOpenRunIntent(null)).toBeNull();
  });
});

describe('jarvis-codec — contrat du commandId', () => {
  it('exige un UUID v4 pour un commandId utilisateur (§5.4)', () => {
    expect(isJarvisUserCommandId(RUN_ID)).toBe(true);
    // v8 = commandId SYSTÈME (§5.6) : il n'entre jamais par le canal utilisateur.
    expect(isJarvisUserCommandId('11111111-1111-8111-8111-111111111111')).toBe(false);
    expect(isJarvisUserCommandId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true);
    expect(isJarvisUserCommandId('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(false);
  });
});

describe('jarvis-codec — U1-h : la revue énoncée, et la fin du run', () => {
  const REVIEW_ID = '77777777-7777-4777-8777-777777777777';
  const CHOICE_A = '88888888-8888-4888-8888-888888888888';
  const CHOICE_B = '99999999-9999-4999-8999-999999999999';

  function revue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      reviewId: REVIEW_ID,
      choices: [
        { ordinal: 1, choiceId: CHOICE_A, label: 'Dupont Plomberie' },
        { ordinal: 2, choiceId: CHOICE_B, label: 'Dupont Plomberie SARL' },
      ],
      ...overrides,
    };
  }

  it('décode la revue en conservant le rang que Bob a PRONONCÉ', () => {
    const decoded = decodeCustomerContactPresentation(presentation({ duplicateReview: revue() }));
    expect(decoded?.duplicateReview?.reviewId).toBe(REVIEW_ID);
    expect(decoded?.duplicateReview?.choices.map((choice) => choice.ordinal)).toEqual([1, 2]);
    expect(decoded?.duplicateReview?.choices[0]?.label).toBe('Dupont Plomberie');
  });

  it('REFUSE un rang qui ne suit pas sa position — l’écran ne renumérote JAMAIS', () => {
    // C'est la garantie centrale du lot côté écran : « le troisième » à l'oreille doit rester le
    // troisième au doigt. Un ordre reçu au hasard porterait un rattachement DURABLE vers la
    // mauvaise fiche, et l'artisan n'aurait aucun moyen de s'en apercevoir.
    for (const choices of [
      [{ ordinal: 2, choiceId: CHOICE_A, label: 'A' }],
      [
        { ordinal: 1, choiceId: CHOICE_A, label: 'A' },
        { ordinal: 3, choiceId: CHOICE_B, label: 'B' },
      ],
      [
        { ordinal: 2, choiceId: CHOICE_A, label: 'A' },
        { ordinal: 1, choiceId: CHOICE_B, label: 'B' },
      ],
    ]) {
      expect(
        decodeCustomerContactPresentation(presentation({ duplicateReview: revue({ choices }) })),
      ).toBeNull();
    }
  });

  it('GARDE un rang dont le nom ne se résout plus — il ne disparaît pas', () => {
    const decoded = decodeCustomerContactPresentation(
      presentation({
        duplicateReview: revue({
          choices: [
            { ordinal: 1, choiceId: CHOICE_A, label: null },
            { ordinal: 2, choiceId: CHOICE_B, label: 'Dupont Plomberie SARL' },
          ],
        }),
      }),
    );
    expect(decoded?.duplicateReview?.choices).toHaveLength(2);
    expect(decoded?.duplicateReview?.choices[0]?.label).toBeNull();
    expect(decoded?.duplicateReview?.choices[0]?.ordinal).toBe(1);
  });

  it('REFUSE deux rangs qui désignent la même fiche — un jeu dérivé ne se déduplique pas', () => {
    expect(
      decodeCustomerContactPresentation(
        presentation({
          duplicateReview: revue({
            choices: [
              { ordinal: 1, choiceId: CHOICE_A, label: 'A' },
              { ordinal: 2, choiceId: CHOICE_A, label: 'A' },
            ],
          }),
        }),
      ),
    ).toBeNull();
  });

  it('REFUSE une revue hors forme À LA FORME : clé inconnue, id non canonique, libellé impropre', () => {
    for (const mauvaise of [
      revue({ inconnue: true }),
      revue({ reviewId: 'pas-un-uuid' }),
      revue({ choices: [] }),
      revue({ choices: [{ ordinal: 1, choiceId: CHOICE_A, label: 42 }] }),
      revue({ choices: [{ ordinal: 1, choiceId: 'x', label: 'A' }] }),
      revue({ choices: [{ ordinal: 1, choiceId: CHOICE_A }] }),
    ]) {
      expect(
        decodeCustomerContactPresentation(presentation({ duplicateReview: mauvaise })),
      ).toBeNull();
    }
  });

  it('décode les DEUX fins de run, et `existing_selected` n’affirme aucune écriture', () => {
    const ecrit = decodeCustomerContactPresentation(
      presentation({ phase: 'completed', completion: { kind: 'recorded' } }),
    );
    expect(ecrit?.completion).toEqual({ kind: 'recorded' });

    const retenu = decodeCustomerContactPresentation(
      presentation({
        phase: 'completed',
        proposal: null,
        confirmation: null,
        completion: { kind: 'existing_selected', label: 'Dupont Plomberie' },
      }),
    );
    expect(retenu?.completion).toEqual({ kind: 'existing_selected', label: 'Dupont Plomberie' });

    // Une fin inconnue, ou une fin `recorded` qui porterait un libellé, sont refusées.
    for (const mauvaise of [
      { kind: 'adopted' },
      { kind: 'recorded', label: 'X' },
      { kind: 'existing_selected' },
      { kind: 'existing_selected', label: 42 },
    ]) {
      expect(
        decodeCustomerContactPresentation(
          presentation({ phase: 'completed', completion: mauvaise }),
        ),
      ).toBeNull();
    }
  });

  it('REFUSE toute contradiction entre phase, intention et issue terminale', () => {
    // Un succès avant la phase terminale et une phase terminale sans issue sont deux mensonges.
    expect(
      decodeCustomerContactPresentation(
        presentation({ completion: { kind: 'recorded' } }),
      ),
    ).toBeNull();
    expect(
      decodeCustomerContactPresentation(
        presentation({ phase: 'completed', completion: null }),
      ),
    ).toBeNull();

    // Choisir un existant est une issue du parcours de création uniquement : une édition ne peut
    // jamais se transformer en rattachement à une autre fiche par un wire incohérent.
    expect(
      decodeCustomerContactPresentation(
        presentation({
          phase: 'completed',
          intent: 'update',
          targetCustomerId: CUSTOMER_ID,
          proposal: null,
          confirmation: null,
          completion: { kind: 'existing_selected', label: 'Dupont Plomberie' },
        }),
      ),
    ).toBeNull();

    // L'édition enregistrée reste une issue valide : la garde ne ferme pas le vrai chemin CAS.
    expect(
      decodeCustomerContactPresentation(
        presentation({
          phase: 'completed',
          intent: 'update',
          targetCustomerId: CUSTOMER_ID,
          completion: { kind: 'recorded' },
        }),
      )?.completion,
    ).toEqual({ kind: 'recorded' });

    expect(
      decodeCustomerContactPresentation(
        presentation({
          phase: 'awaiting_duplicate_review',
          intent: 'update',
          targetCustomerId: CUSTOMER_ID,
          proposal: null,
          confirmation: null,
          duplicateReview: revue(),
        }),
      ),
    ).toBeNull();
  });

  it('encode l’issue de revue en la RECONSTRUISANT, et refuse toute autre décision', () => {
    expect(
      encodeJarvisRunCommand({
        type: 'choose_duplicate_resolution',
        reviewId: REVIEW_ID,
        decision: { kind: 'use_existing', choiceId: CHOICE_A },
      }),
    ).toEqual({
      type: 'choose_duplicate_resolution',
      reviewId: REVIEW_ID,
      decision: { kind: 'use_existing', choiceId: CHOICE_A },
    });
    expect(
      encodeJarvisRunCommand({
        type: 'choose_duplicate_resolution',
        reviewId: REVIEW_ID,
        decision: { kind: 'continue_create' },
      }),
    ).toEqual({
      type: 'choose_duplicate_resolution',
      reviewId: REVIEW_ID,
      decision: { kind: 'continue_create' },
    });
    // `adopt_existing` est CLOS (SPEC_U1H §2) : sous un mauvais choix, la mise à jour recouvrirait
    // l'identité de la fiche existante par celle qu'on saisit. La fermeture EST la garantie FD-06.
    for (const mauvaise of [
      { type: 'choose_duplicate_resolution', reviewId: REVIEW_ID, decision: { kind: 'adopt_existing', choiceId: CHOICE_A } },
      { type: 'choose_duplicate_resolution', reviewId: REVIEW_ID, decision: { kind: 'use_existing' } },
      { type: 'choose_duplicate_resolution', reviewId: 'x', decision: { kind: 'continue_create' } },
      { type: 'choose_duplicate_resolution', reviewId: REVIEW_ID, decision: { kind: 'continue_create', choiceId: CHOICE_A } },
    ]) {
      expect(encodeJarvisRunCommand(mauvaise)).toBeNull();
    }
  });
});
