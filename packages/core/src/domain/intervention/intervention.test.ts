import { describe, expect, it } from 'vitest';
import {
  Intervention,
  INTERVENTION_TRANSITIONS,
  type InterventionProps,
  type InterventionSignature,
  type InterventionStatus,
} from './intervention';

const SHA = 'a'.repeat(64);

function props(overrides: Partial<InterventionProps> = {}): InterventionProps {
  return {
    id: '5f0c9a52-8e5c-4a4f-9d21-3f6b1a2c4d5e',
    companyId: 'co-1',
    chantierId: 'site-1',
    customerId: 'cust-1',
    contractId: null,
    equipmentId: null,
    kind: 'Visite d’entretien',
    status: 'scheduled',
    plannedAt: '2026-08-04T09:00:00.000Z',
    technicianLabel: 'Papa',
    startedAt: null,
    finishedAt: null,
    checklist: [{ label: 'Détartrage', done: false }],
    summary: null,
    signature: null,
    reportDocumentId: null,
    billedInvoiceId: null,
    revision: 1,
    ...overrides,
  };
}

function rehydrate(overrides: Partial<InterventionProps> = {}): Intervention {
  return Intervention.rehydrate(props(overrides));
}

function signature(overrides: Partial<InterventionSignature> = {}): InterventionSignature {
  return {
    signerName: 'M. Responsable',
    method: 'onsite_draw',
    sha256: SHA,
    capturedAt: '2026-08-04T10:31:00.000Z',
    ...overrides,
  };
}

describe('Intervention — machine à états §3.3 (matrice COMPLÈTE)', () => {
  const statuses = Object.keys(INTERVENTION_TRANSITIONS) as InterventionStatus[];

  it('la table couvre exactement les cinq états', () => {
    expect(statuses.sort()).toEqual(['cancelled', 'completed', 'in_progress', 'scheduled', 'signed']);
  });

  const factOf = (status: InterventionStatus): Partial<InterventionProps> =>
    status === 'scheduled' || status === 'cancelled'
      ? {}
      : status === 'in_progress'
        ? { startedAt: '2026-08-04T09:04:00.000Z' }
        : {
            startedAt: '2026-08-04T09:04:00.000Z',
            finishedAt: '2026-08-04T10:12:00.000Z',
            ...(status === 'signed' ? { signature: signature() } : {}),
          };

  const mutations: {
    label: string;
    to: InterventionStatus;
    run: (intervention: Intervention) => { ok: boolean };
  }[] = [
    { label: 'start', to: 'in_progress', run: (i) => i.start('2026-08-04T09:04:00.000Z') },
    { label: 'complete', to: 'completed', run: (i) => i.complete('2026-08-04T10:12:00.000Z') },
    { label: 'sign', to: 'signed', run: (i) => i.sign(signature()) },
    { label: 'cancel', to: 'cancelled', run: (i) => i.cancel() },
  ];

  for (const from of statuses) {
    for (const mutation of mutations) {
      const allowed = INTERVENTION_TRANSITIONS[from].includes(mutation.to);
      it(`${from} → ${mutation.label} : ${allowed ? 'accepté' : 'refusé'}`, () => {
        const intervention = rehydrate({ status: from, ...factOf(from) });
        const result = mutation.run(intervention);
        expect(result.ok).toBe(allowed);
        expect(intervention.status).toBe(allowed ? mutation.to : from);
      });
    }
  }

  it('le chemin nominal complet passe : scheduled → in_progress → completed → signed', () => {
    const intervention = rehydrate();
    expect(intervention.start('2026-08-04T09:04:00.000Z').ok).toBe(true);
    expect(
      intervention.complete('2026-08-04T10:12:00.000Z', {
        checklist: [{ label: 'Détartrage', done: true, note: 'Pression basse, réglée' }],
        summary: 'Détartrage complet.',
      }).ok,
    ).toBe(true);
    expect(intervention.sign(signature()).ok).toBe(true);
    expect(intervention.status).toBe('signed');
    expect(intervention.revision).toBe(4);
    expect(intervention.signature?.sha256).toBe(SHA);
  });

  it('l’annulation est IMPOSSIBLE après completed (le passage a eu lieu)', () => {
    const intervention = rehydrate({
      status: 'completed',
      startedAt: '2026-08-04T09:04:00.000Z',
      finishedAt: '2026-08-04T10:12:00.000Z',
    });
    expect(intervention.cancel().ok).toBe(false);
    expect(intervention.status).toBe('completed');
  });
});

describe('Intervention — invariants §3.4', () => {
  it('kind est REQUIS mais LIBRE (jamais une énumération)', () => {
    expect(Intervention.record(props({ kind: '  ' })).ok).toBe(false);
    expect(Intervention.record(props({ kind: 'Certificat sanitaire fontaines' })).ok).toBe(true);
    expect(Intervention.record(props({ kind: 'x'.repeat(201) })).ok).toBe(false);
  });

  it('startedAt ≤ finishedAt — une fin avant le début est refusée', () => {
    const r = Intervention.record(
      props({
        status: 'completed',
        startedAt: '2026-08-04T10:00:00.000Z',
        finishedAt: '2026-08-04T09:00:00.000Z',
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('cohérence statut ↔ faits : in_progress sans startedAt refusé, completed sans finishedAt refusé', () => {
    expect(Intervention.record(props({ status: 'in_progress' })).ok).toBe(false);
    expect(
      Intervention.record(props({ status: 'completed', startedAt: '2026-08-04T09:00:00.000Z' })).ok,
    ).toBe(false);
  });

  it('cohérence TRIPLE signature : signed ⟺ preuve présente, jamais un demi-état', () => {
    expect(
      Intervention.record(
        props({
          status: 'signed',
          startedAt: '2026-08-04T09:00:00.000Z',
          finishedAt: '2026-08-04T10:00:00.000Z',
          signature: null,
        }),
      ).ok,
    ).toBe(false);
    expect(Intervention.record(props({ signature: signature() })).ok).toBe(false);
  });

  it('preuve : sha256 hex 64 exigé (calculé SERVEUR), signataire normalisé', () => {
    const intervention = rehydrate({
      status: 'completed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T10:00:00.000Z',
    });
    expect(intervention.sign(signature({ sha256: 'pas-un-hash' })).ok).toBe(false);
    expect(intervention.sign(signature({ signerName: ' ' })).ok).toBe(false);
    const signed = intervention.sign(signature({ signerName: '  M.   Responsable  ' }));
    expect(signed.ok).toBe(true);
    expect(intervention.signature?.signerName).toBe('M. Responsable');
  });

  it('convention capturedAt / capturedAtDevice / syncedAt (P12) transportée intacte', () => {
    const intervention = rehydrate({
      status: 'completed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T10:00:00.000Z',
    });
    const offline = intervention.sign(
      signature({
        capturedAt: '2026-08-04T12:05:00.000Z',
        capturedAtDevice: '2026-08-04T10:31:00.000Z',
        syncedAt: '2026-08-04T12:05:00.000Z',
      }),
    );
    expect(offline.ok).toBe(true);
    expect(intervention.signature?.capturedAtDevice).toBe('2026-08-04T10:31:00.000Z');
    expect(intervention.signature?.syncedAt).toBe('2026-08-04T12:05:00.000Z');
  });

  it('checklist : labels requis, bornes tenues, notes multilignes admises', () => {
    expect(Intervention.record(props({ checklist: [{ label: ' ', done: false }] })).ok).toBe(false);
    expect(
      Intervention.record(
        props({ checklist: [{ label: 'OK', done: true, note: 'ligne 1\nligne 2' }] }),
      ).ok,
    ).toBe(true);
    expect(
      Intervention.record(
        props({ checklist: Array.from({ length: 51 }, (_, i) => ({ label: `i${i}`, done: false })) }),
      ).ok,
    ).toBe(false);
  });

  it('résumé : 2000 max, multiligne admis, contrôle non admis refusé', () => {
    expect(Intervention.record(props({ summary: 'Détartrage.\nPrévoir cartouche.' })).ok).toBe(true);
    expect(Intervention.record(props({ summary: 'sonnerie \u0007' })).ok).toBe(false);
    expect(Intervention.record(props({ summary: 'x'.repeat(2001) })).ok).toBe(false);
  });
});

describe('Intervention — verrouillage post-signature (§3.4) et fenêtres d’édition', () => {
  const signedIntervention = () =>
    rehydrate({
      status: 'signed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T10:00:00.000Z',
      signature: signature(),
      revision: 4,
    });

  it('update accepté en scheduled et in_progress (CAS au niveau use case)', () => {
    const scheduled = rehydrate();
    expect(scheduled.update({ checklist: [{ label: 'Filtres', done: false }] }).ok).toBe(true);
    const inProgress = rehydrate({ status: 'in_progress', startedAt: '2026-08-04T09:00:00.000Z' });
    expect(inProgress.update({ summary: 'En cours' }).ok).toBe(true);
  });

  it('checklist FIGÉE à completed : update refusé, la fiche se signe ou s’envoie', () => {
    const completed = rehydrate({
      status: 'completed',
      startedAt: '2026-08-04T09:00:00.000Z',
      finishedAt: '2026-08-04T10:00:00.000Z',
    });
    const r = completed.update({ checklist: [{ label: 'Ajout tardif', done: true }] });
    expect(r.ok).toBe(false);
    expect(completed.checklist).toEqual([{ label: 'Détartrage', done: false }]);
  });

  it('après signed : update, complete, cancel, sign — TOUT est refusé, rien ne bouge', () => {
    const locked = signedIntervention();
    expect(locked.update({ summary: 'retouche' }).ok).toBe(false);
    expect(locked.complete('2026-08-04T11:00:00.000Z').ok).toBe(false);
    expect(locked.cancel().ok).toBe(false);
    expect(locked.sign(signature()).ok).toBe(false);
    expect(locked.revision).toBe(4);
    expect(locked.toProps()).toMatchObject({ status: 'signed', summary: null });
  });

  it('acceptsFieldTraces : vrai jusqu’à signed exclu, faux sur signed et cancelled', () => {
    expect(rehydrate().acceptsFieldTraces()).toBe(true);
    expect(
      rehydrate({ status: 'in_progress', startedAt: '2026-08-04T09:00:00.000Z' }).acceptsFieldTraces(),
    ).toBe(true);
    expect(
      rehydrate({
        status: 'completed',
        startedAt: '2026-08-04T09:00:00.000Z',
        finishedAt: '2026-08-04T10:00:00.000Z',
      }).acceptsFieldTraces(),
    ).toBe(true);
    expect(signedIntervention().acceptsFieldTraces()).toBe(false);
    expect(rehydrate({ status: 'cancelled' }).acceptsFieldTraces()).toBe(false);
  });

  it('les faits SYSTÈME (rapport archivé, facture liée) restent posables après signature', () => {
    const locked = signedIntervention();
    expect(locked.attachReportDocument('doc-1').ok).toBe(true);
    expect(locked.attachBilledInvoice('inv-1').ok).toBe(true);
    locked.detachBilledInvoice();
    expect(locked.billedInvoiceId).toBeNull();
    expect(locked.reportDocumentId).toBe('doc-1');
  });

  it('les faits système sont REFUSÉS avant la complétion (rien à archiver, rien à facturer)', () => {
    const scheduled = rehydrate();
    expect(scheduled.attachReportDocument('doc-1').ok).toBe(false);
    expect(scheduled.attachBilledInvoice('inv-1').ok).toBe(false);
  });
});
