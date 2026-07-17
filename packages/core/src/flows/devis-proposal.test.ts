import { describe, expect, it } from 'vitest';
import { startDevis } from './devis';
import {
  devisAcceptProposal,
  devisDiff,
  devisPropose,
  devisRejectProposal,
  withLineRemoved,
  withLineUpdated,
  type DevisFlowStateWithProposal,
} from './devis-proposal';

const base = (): DevisFlowStateWithProposal => ({
  ...startDevis(),
  step: 'lignes',
  draft: {
    customerId: 'c1',
    lines: [
      { label: 'Main-d’œuvre', category: 'labor', qty: 2, unitPriceHT: 5_500, vatRate: 10 },
      { label: 'Chauffe-eau 200 L', category: 'supply', qty: 1, unitPriceHT: 54_000, vatRate: 10 },
    ],
    tvaContext: null,
    vatRate: null,
    depositPct: 30,
    signMode: null,
    signerName: null,
  },
  proposal: null,
});

describe('devisPropose / accept / reject — la voix PROPOSE, l’humain DÉCIDE (S2 core)', () => {
  it('propose « ligne 2 à 450 € » : diff humain avant→après, brouillon INTACT tant que non accepté', () => {
    const state = base();
    const patch = withLineUpdated(state.draft, 2, { unitPriceHT: 45_000 });
    expect(patch.ok).toBe(true);
    if (!patch.ok) return;
    const proposed = devisPropose(state, patch.value, 'Passer la ligne 2 à 450,00 €');
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.draft.lines[1]!.unitPriceHT).toBe(54_000); // rien d’appliqué
    expect(proposed.value.proposal?.diff).toHaveLength(1);
    expect(proposed.value.proposal?.diff[0]).toMatchObject({ field: 'Ligne 2' });
    expect(proposed.value.proposal?.diff[0]!.before).toContain('540,00');
    expect(proposed.value.proposal?.diff[0]!.after).toContain('450,00');

    const accepted = devisAcceptProposal(proposed.value);
    expect(accepted.ok && accepted.value.draft.lines[1]!.unitPriceHT).toBe(45_000);
    expect(accepted.ok && accepted.value.proposal).toBeNull();
  });

  it('rejeter laisse le brouillon INTACT (l’inaction est toujours sûre)', () => {
    const state = base();
    const patch = withLineRemoved(state.draft, 1);
    if (!patch.ok) throw new Error('patch');
    const proposed = devisPropose(state, patch.value, 'Supprimer la ligne 1');
    if (!proposed.ok) throw new Error('propose');
    const rejected = devisRejectProposal(proposed.value);
    expect(rejected.draft.lines).toHaveLength(2);
    expect(rejected.proposal).toBeNull();
  });

  it('garde-fous : proposition vide refusée, accept sans proposition refusé, flow terminé refusé', () => {
    const state = base();
    expect(devisPropose(state, {}, 'rien').ok).toBe(false);
    expect(devisAcceptProposal(state).ok).toBe(false);
    expect(devisPropose({ ...state, step: 'recap' }, { depositPct: 40 }, 'x').ok).toBe(false);
  });

  it('withLineUpdated/Removed : ordinal HUMAIN 1-based, hors-borne = erreur honnête', () => {
    const state = base();
    expect(withLineUpdated(state.draft, 3, { qty: 2 }).ok).toBe(false);
    expect(withLineRemoved(state.draft, 0).ok).toBe(false);
    const removed = withLineRemoved(state.draft, 2);
    expect(removed.ok && (removed.value.lines as unknown[]).length).toBe(1);
  });

  it('devisDiff couvre ajout/suppression/modification de ligne, acompte et signataire', () => {
    const before = base().draft;
    const after = {
      ...before,
      lines: [before.lines[0]!],
      depositPct: 40,
      signerName: 'M. Durand',
    };
    const diff = devisDiff(before, after);
    expect(diff.map((d) => d.field)).toEqual(['Ligne 2', 'Acompte', 'Signataire']);
    expect(diff[0]!.after).toContain('supprimée');
  });
});
