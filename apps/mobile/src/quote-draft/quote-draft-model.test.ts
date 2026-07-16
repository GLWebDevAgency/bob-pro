import { describe, expect, it } from 'vitest';
import type { CataloguePrestation, LineInput } from '@bob/core';
import {
  acceptQuoteDraftProposal,
  addCatalogueLine,
  addLine,
  applyQuoteDraftCommand,
  applyQuoteDraftCommands,
  clearQuoteDraftLineForm,
  completeQuoteDraft,
  completeQuoteDraftMission,
  createQuoteDraft,
  deriveQuoteDraftGuidance,
  discardQuoteDraft,
  expireQuoteDraftProposal,
  hasMeaningfulQuoteDraft,
  hasUnsavedQuoteDraftChanges,
  markQuoteDraftSaved,
  proposeQuoteDraft,
  quoteDraftStage,
  rejectQuoteDraftProposal,
  requireQuoteDraftRevision,
  selectCustomer,
  startQuoteDraftMission,
  stopQuoteDraftMission,
  updateLine,
  updateQuoteDraftLineForm,
  validateQuoteDraftLine,
  type QuoteDraftState,
} from './quote-draft-model';

const CUSTOMER = { id: 'customer-camping', name: 'Camping Les Pins' } as const;
const LABOR: LineInput = {
  label: "Main-d'œuvre plomberie",
  category: 'labor',
  qty: 2,
  unit: '1 h',
  unitPriceHT: 5_500,
  vatRate: 10,
};
const BOILER: CataloguePrestation = {
  id: 'perso-chauffe-eau',
  label: 'Chauffe-eau 200 L',
  category: 'supply',
  unit: null,
  unitPriceHT: 89_000,
  vatRate: 10,
  source: 'perso',
  indicative: false,
};

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function onLines(): QuoteDraftState {
  const selected = value(selectCustomer(createQuoteDraft('draft-1'), CUSTOMER));
  return value(applyQuoteDraftCommand(selected, { type: 'next_step' }));
}

describe('quote draft shared model', () => {
  it('conserve la machine @bob/core comme source canonique et guide la mission par étape', () => {
    let state = createQuoteDraft('draft-1');
    expect(state.flow.step).toBe('client');
    expect(quoteDraftStage(state)).toBe('client');
    expect(deriveQuoteDraftGuidance(state)).toBeNull();

    state = value(
      startQuoteDraftMission(state, {
        id: 'mission-1',
        mode: 'guided_voice',
        startedFrom: '/(tabs)',
        startedAt: 1_000,
      }),
    );
    expect(deriveQuoteDraftGuidance(state)).toMatchObject({ expectation: 'customer' });

    state = value(selectCustomer(state, CUSTOMER, 1_010));
    expect(state.flow.draft.customerId).toBe(CUSTOMER.id);
    expect(deriveQuoteDraftGuidance(state)).toMatchObject({
      expectation: 'advance',
      title: CUSTOMER.name,
    });

    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }, 1_020));
    expect(state.flow.step).toBe('lignes');
    expect(deriveQuoteDraftGuidance(state)).toMatchObject({ expectation: 'line' });
  });

  it('refuse de quitter client sans client et lignes sans ligne via les gardes core', () => {
    const first = applyQuoteDraftCommand(createQuoteDraft('draft-1'), { type: 'next_step' });
    expect(first).toMatchObject({ ok: false, error: { code: 'validation', field: 'customerId' } });

    const second = applyQuoteDraftCommand(onLines(), { type: 'next_step' });
    expect(second).toMatchObject({ ok: false, error: { code: 'validation', field: 'lines' } });
  });

  it('interdit les éditions hors de leur étape, y compris après passage en revue', () => {
    expect(
      addLine(createQuoteDraft('draft-1'), {
        lineId: 'too-early',
        line: LABOR,
        interaction: 'voice',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_transition', field: 'step' } });

    let review = value(
      addLine(onLines(), { lineId: 'line-1', line: LABOR, interaction: 'manual' }),
    );
    review = value(applyQuoteDraftCommand(review, { type: 'next_step' }));
    expect(updateLine(review, 'line-1', { qty: 3 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_transition', field: 'step' },
    });
    expect(selectCustomer(review, { id: 'other', name: 'Autre client' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_transition', field: 'step' },
    });
  });

  it('normalise et valide les invariants d’une ligne avant toute mutation', () => {
    expect(
      validateQuoteDraftLine({ ...LABOR, label: '  Pose   chaudière  ', qty: 1.234 }),
    ).toMatchObject({
      ok: true,
      value: { label: 'Pose chaudière', qty: 1.234 },
    });
    expect(validateQuoteDraftLine({ ...LABOR, qty: 1.2345 })).toMatchObject({
      ok: false,
      error: { field: 'qty' },
    });
    expect(validateQuoteDraftLine({ ...LABOR, unitPriceHT: 10.5 })).toMatchObject({
      ok: false,
      error: { field: 'unitPriceHT' },
    });
    expect(validateQuoteDraftLine({ ...LABOR, vatRate: 7 as 10 })).toMatchObject({
      ok: false,
      error: { field: 'vatRate' },
    });
  });

  it('ajoute puis modifie une ligne via son id stable sans muter les entrées', () => {
    const input = { ...LABOR };
    let state = value(
      addLine(onLines(), {
        lineId: 'line-labor',
        line: input,
        interaction: 'manual',
      }),
    );
    expect(input).toEqual(LABOR);
    expect(state.lineMetadata).toEqual([{ id: 'line-labor', interaction: 'manual' }]);

    state = value(updateLine(state, 'line-labor', { qty: 3, label: '  Pose   et raccordement ' }));
    expect(state.flow.draft.lines[0]).toMatchObject({ qty: 3, label: 'Pose et raccordement' });
    expect(state.lineMetadata[0]?.id).toBe('line-labor');
    expect(updateLine(state, 'missing', { qty: 4 })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('reprend exactement catégorie, prix et TVA du catalogue avec sa provenance', () => {
    const state = value(
      addCatalogueLine(onLines(), {
        lineId: 'line-boiler',
        prestation: BOILER,
        qty: 1,
        interaction: 'voice',
      }),
    );
    expect(state.flow.draft.lines[0]).toEqual({
      label: BOILER.label,
      category: BOILER.category,
      qty: 1,
      unitPriceHT: BOILER.unitPriceHT,
      vatRate: BOILER.vatRate,
    });
    expect(state.lineMetadata[0]).toEqual({
      id: 'line-boiler',
      interaction: 'voice',
      catalogue: { id: BOILER.id, source: 'perso', indicative: false },
    });
  });

  it('applique un lot atomique client + navigation avec une seule révision', () => {
    const initial = createQuoteDraft('draft-1');
    const result = applyQuoteDraftCommands(initial, [
      { type: 'select_customer', customer: CUSTOMER },
      { type: 'next_step' },
    ]);
    const state = value(result);
    expect(state.revision).toBe(1);
    expect(state.flow.step).toBe('lignes');
    expect(initial.flow.step).toBe('client');

    const failed = applyQuoteDraftCommands(initial, [
      { type: 'select_customer', customer: CUSTOMER },
      { type: 'add_line', lineId: 'bad', line: { ...LABOR, qty: 0 }, interaction: 'voice' },
    ]);
    expect(failed.ok).toBe(false);
    expect(initial.customer).toBeNull();
  });

  it('prévisualise un diff client avant application puis confirme la proposition exacte', () => {
    const initial = createQuoteDraft('draft-1');
    const proposed = value(
      proposeQuoteDraft(initial, {
        id: 'proposal-customer',
        source: 'bob_voice',
        commands: [{ type: 'select_customer', customer: CUSTOMER }, { type: 'next_step' }],
        createdAt: 1_000,
        expiresAt: 2_000,
        explanation: 'Client reconnu dans la liste affichée.',
      }),
    );

    expect(proposed.flow).toEqual(initial.flow);
    expect(proposed.revision).toBe(0);
    expect(Object.isFrozen(proposed.proposal)).toBe(true);
    expect(Object.isFrozen(proposed.proposal?.commands)).toBe(true);
    expect(Object.isFrozen(proposed.proposal?.diff)).toBe(true);
    const customerCommand = proposed.proposal?.commands[0];
    expect(customerCommand?.type).toBe('select_customer');
    if (customerCommand?.type === 'select_customer') {
      expect(Object.isFrozen(customerCommand.customer)).toBe(true);
    }
    expect(proposed.proposal?.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'customer',
          before: 'Non sélectionné',
          after: CUSTOMER.name,
        }),
        expect.objectContaining({ key: 'step', before: 'client', after: 'lignes' }),
      ]),
    );
    expect(
      deriveQuoteDraftGuidance(
        value(
          startQuoteDraftMission(proposed, {
            id: 'mission-1',
            mode: 'guided_voice',
            startedFrom: '/',
            startedAt: 1_001,
          }),
        ),
      ),
    ).toMatchObject({ expectation: 'proposal_confirmation' });

    const accepted = value(acceptQuoteDraftProposal(proposed, 'proposal-customer', 1_500));
    expect(accepted.flow.step).toBe('lignes');
    expect(accepted.customer).toEqual(CUSTOMER);
    expect(accepted.revision).toBe(1);
    expect(accepted.lastProposalDecision).toEqual({
      proposalId: 'proposal-customer',
      decision: 'accepted',
      at: 1_500,
    });
  });

  it('montre les changements ligne et totaux dans le diff canonique', () => {
    const withLine = value(
      addLine(onLines(), {
        lineId: 'line-labor',
        line: LABOR,
        interaction: 'manual',
      }),
    );
    const proposed = value(
      proposeQuoteDraft(withLine, {
        id: 'proposal-update',
        source: 'bob_voice',
        commands: [{ type: 'update_line', lineId: 'line-labor', patch: { qty: 3 } }],
        createdAt: 100,
        expiresAt: 200,
      }),
    );
    expect(proposed.proposal?.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'line:line-labor:qty', before: '2', after: '3' }),
        expect.objectContaining({ key: 'total:ht' }),
        expect.objectContaining({ key: 'total:ttc' }),
      ]),
    );
  });

  it('refuse, expire et fence les propositions obsolètes sans effet financier', () => {
    const initial = onLines();
    const proposed = value(
      proposeQuoteDraft(initial, {
        id: 'proposal-line',
        source: 'bob_voice',
        commands: [{ type: 'add_line', lineId: 'line-1', line: LABOR, interaction: 'voice' }],
        createdAt: 100,
        expiresAt: 200,
      }),
    );
    const rejected = value(rejectQuoteDraftProposal(proposed, 'proposal-line', 150));
    expect(rejected.flow.draft.lines).toEqual([]);
    expect(rejected.lastProposalDecision?.decision).toBe('rejected');

    expect(acceptQuoteDraftProposal(proposed, 'proposal-line', 200)).toMatchObject({
      ok: false,
      error: { code: 'proposal_expired' },
    });
    expect(expireQuoteDraftProposal(proposed, 200)).toMatchObject({
      proposal: null,
      lastProposalDecision: { decision: 'expired' },
    });

    const stale = { ...proposed, revision: proposed.revision + 1 };
    expect(acceptQuoteDraftProposal(stale, 'proposal-line', 150)).toMatchObject({
      ok: false,
      error: { code: 'proposal_stale' },
    });
    expect(acceptQuoteDraftProposal(proposed, 'other-proposal', 150)).toMatchObject({
      ok: false,
      error: { code: 'proposal_mismatch' },
    });
  });

  it('une action manuelle supplante le diff IA en attente', () => {
    const proposed = value(
      proposeQuoteDraft(onLines(), {
        id: 'proposal-line',
        source: 'bob_voice',
        commands: [{ type: 'add_line', lineId: 'line-1', line: LABOR, interaction: 'voice' }],
        createdAt: 100,
        expiresAt: 200,
      }),
    );
    const manual = value(
      addLine(
        proposed,
        {
          lineId: 'line-manual',
          line: LABOR,
          interaction: 'manual',
        },
        120,
      ),
    );
    expect(manual.proposal).toBeNull();
    expect(manual.lastProposalDecision).toEqual({
      proposalId: 'proposal-line',
      decision: 'superseded',
      at: 120,
    });
  });

  it('une proposition plus récente remplace explicitement l’ancienne dans la trace locale', () => {
    const first = value(
      proposeQuoteDraft(onLines(), {
        id: 'proposal-1',
        source: 'bob_voice',
        commands: [{ type: 'add_line', lineId: 'line-1', line: LABOR, interaction: 'voice' }],
        createdAt: 100,
        expiresAt: 200,
      }),
    );
    const second = value(
      proposeQuoteDraft(first, {
        id: 'proposal-2',
        source: 'bob_voice',
        commands: [
          { type: 'add_line', lineId: 'line-2', line: { ...LABOR, qty: 3 }, interaction: 'voice' },
        ],
        createdAt: 110,
        expiresAt: 210,
      }),
    );
    expect(second.proposal?.id).toBe('proposal-2');
    expect(second.lastProposalDecision).toEqual({
      proposalId: 'proposal-1',
      decision: 'superseded',
      at: 110,
    });
  });

  it('arrête la mission sans perdre le brouillon et abandonne la proposition non validée', () => {
    let state = value(
      startQuoteDraftMission(onLines(), {
        id: 'mission-1',
        mode: 'guided_voice',
        startedFrom: '/devis/new',
        startedAt: 100,
      }),
    );
    state = value(addLine(state, { lineId: 'line-1', line: LABOR, interaction: 'manual' }));
    state = value(
      proposeQuoteDraft(state, {
        id: 'proposal-update',
        source: 'bob_voice',
        commands: [{ type: 'update_line', lineId: 'line-1', patch: { qty: 3 } }],
        createdAt: 120,
        expiresAt: 220,
      }),
    );

    const stopped = stopQuoteDraftMission(state, { reason: 'home_navigation', stoppedAt: 130 });
    expect(stopped.mission).toEqual({
      status: 'stopped',
      id: 'mission-1',
      reason: 'home_navigation',
      stoppedAt: 130,
    });
    expect(stopped.flow.draft.lines).toHaveLength(1);
    expect(stopped.proposal).toBeNull();
    expect(deriveQuoteDraftGuidance(stopped)).toBeNull();
  });

  it('marque une mission terminée sans réinitialiser son résultat', () => {
    const active = value(
      startQuoteDraftMission(onLines(), {
        id: 'mission-1',
        mode: 'manual',
        startedFrom: '/devis/new',
        startedAt: 100,
      }),
    );
    const completed = completeQuoteDraftMission(active, 500);
    expect(completed.mission).toEqual({ status: 'completed', id: 'mission-1', completedAt: 500 });
    expect(completed.flow.step).toBe('lignes');
  });

  it('passe à la revue seulement quand au moins une ligne valide existe', () => {
    let state = value(addLine(onLines(), { lineId: 'line-1', line: LABOR, interaction: 'voice' }));
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' }));
    expect(state.flow.step).toBe('tvaMentions');
    expect(quoteDraftStage(state)).toBe('revue');
  });

  it('conserve la saisie de ligne non validée sans la confondre avec le contenu financier', () => {
    const initial = onLines();
    const staged = updateQuoteDraftLineForm(initial, {
      label: 'Pose chauffe-eau',
      quantity: '2',
      unitPrice: '450,00',
      category: 'supply',
    });

    expect(staged.flow.draft.lines).toEqual([]);
    expect(staged.revision).toBe(initial.revision);
    expect(staged.stagingRevision).toBe(initial.stagingRevision + 1);
    expect(hasMeaningfulQuoteDraft(staged)).toBe(true);
    expect(hasUnsavedQuoteDraftChanges(staged)).toBe(true);

    const cleared = clearQuoteDraftLineForm(staged);
    expect(cleared.lineForm).toEqual({
      label: '',
      quantity: '1',
      unitPrice: '',
      category: 'supply',
    });
    expect(cleared.flow.draft.lines).toEqual([]);
  });

  it('distingue un brouillon explicitement enregistré de modifications ultérieures', () => {
    const selected = value(selectCustomer(createQuoteDraft('draft-1'), CUSTOMER));
    const saved = markQuoteDraftSaved(selected, 1_000);
    expect(hasMeaningfulQuoteDraft(saved)).toBe(true);
    expect(hasUnsavedQuoteDraftChanges(saved)).toBe(false);

    const edited = updateQuoteDraftLineForm(saved, { label: 'Préparation non validée' });
    expect(hasUnsavedQuoteDraftChanges(edited)).toBe(true);
    expect(edited.saved).toEqual({
      contentRevision: selected.revision,
      stagingRevision: selected.stagingRevision,
      at: 1_000,
    });
  });

  it('ne considère pas le défaut TVA du profil comme un brouillon utilisateur', () => {
    const seeded = value(
      applyQuoteDraftCommand(createQuoteDraft('draft-1'), {
        type: 'set_vat',
        context: { housingOlderThan2y: true },
        vatRate: 10,
      }),
    );
    expect(seeded.flow.draft.tvaContext).toEqual({ housingOlderThan2y: true });
    expect(hasMeaningfulQuoteDraft(seeded)).toBe(false);
    expect(hasUnsavedQuoteDraftChanges(seeded)).toBe(false);
  });

  it('fait passer client, TVA, signature et acompte par les mêmes commandes sérialisables', () => {
    const populated = value(
      addLine(onLines(), {
        lineId: 'line-before-customer-change',
        line: LABOR,
        interaction: 'manual',
      }),
    );
    const changedCustomer = value(applyQuoteDraftCommand(populated, { type: 'clear_customer' }));
    expect(changedCustomer.flow.step).toBe('client');
    expect(changedCustomer.flow.draft.customerId).toBeNull();
    expect(changedCustomer.customer).toBeNull();
    expect(changedCustomer.flow.draft.lines).toEqual([LABOR]);
    expect(changedCustomer.lineMetadata).toHaveLength(1);

    let state = value(addLine(onLines(), { lineId: 'line-1', line: LABOR, interaction: 'manual' }));
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' })); // lignes -> tvaMentions
    state = value(
      applyQuoteDraftCommand(state, {
        type: 'set_vat',
        context: { energyRenovation: true },
        vatRate: 5.5,
      }),
    );
    expect(state.flow.draft.lines[0]?.vatRate).toBe(5.5);
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' })); // tvaMentions -> acompte
    state = value(applyQuoteDraftCommand(state, { type: 'set_deposit_pct', depositPct: 20 }));
    expect(state.flow.draft.depositPct).toBe(20);
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' })); // acompte -> signature
    state = value(
      applyQuoteDraftCommand(state, { type: 'set_sign_mode', signMode: 'onsite' }),
    );
    state = value(
      applyQuoteDraftCommand(state, { type: 'set_signer_name', signerName: '  Jean   Dupont ' }),
    );
    expect(state.flow.draft.signerName).toBe('Jean Dupont');
    state = value(applyQuoteDraftCommand(state, { type: 'next_step' })); // signature -> recap
    expect(state.flow.step).toBe('recap');
  });

  it('refuse le second geste calculé sur une révision déjà consommée', () => {
    const initial = onLines();
    const renderedRevision = initial.revision;
    const first = value(
      addLine(initial, {
        lineId: 'line-1',
        line: LABOR,
        interaction: 'manual',
      }),
    );

    expect(requireQuoteDraftRevision(first, renderedRevision)).toMatchObject({
      ok: false,
      error: { code: 'revision_conflict', field: 'revision' },
    });
    expect(first.flow.draft.lines).toHaveLength(1);
  });

  it('efface explicitement le brouillon sans perdre la fence des créations déjà terminées', () => {
    const selected = value(selectCustomer(createQuoteDraft('draft-1'), CUSTOMER));
    const firstCompletion = completeQuoteDraft(selected, {
      artifactId: 'invoice-1',
      newSessionId: 'draft-2',
    });
    expect(firstCompletion.didReset).toBe(true);
    expect(firstCompletion.state.flow).toEqual(createQuoteDraft('comparison').flow);
    expect(firstCompletion.state.completedArtifactIds).toEqual(['invoice-1']);

    const nextDraft = value(selectCustomer(firstCompletion.state, CUSTOMER));
    const duplicate = completeQuoteDraft(nextDraft, {
      artifactId: 'invoice-1',
      newSessionId: 'must-not-be-used',
    });
    expect(duplicate.didReset).toBe(false);
    expect(duplicate.state).toBe(nextDraft);
    expect(duplicate.state.customer).toEqual(CUSTOMER);

    const discarded = discardQuoteDraft(nextDraft, 'draft-3');
    expect(discarded.customer).toBeNull();
    expect(discarded.completedArtifactIds).toEqual(['invoice-1']);
  });

  it('garde une proposition opaque hors du devis tant que le consentement exact manque', () => {
    const withLine = value(
      addLine(onLines(), {
        lineId: 'line-1',
        line: LABOR,
        interaction: 'manual',
      }),
    );
    const proposed = value(
      proposeQuoteDraft(withLine, {
        id: 'proposal-1',
        source: 'bob_voice',
        commands: [{ type: 'update_line', lineId: 'line-1', patch: { unitPriceHT: 45_000 } }],
        createdAt: 100,
        expiresAt: 200,
      }),
    );

    const saved = markQuoteDraftSaved(proposed, 110);
    expect(saved.flow.draft.lines[0]?.unitPriceHT).toBe(LABOR.unitPriceHT);
    expect(saved.proposal?.id).toBe('proposal-1');
    expect(hasUnsavedQuoteDraftChanges(saved)).toBe(false);
  });
});
