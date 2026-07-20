import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { FiscalProfileFieldPatch, FiscalProfileView } from '@bob/core';
import { useTheme } from '@bob/ui';
import type { AgentAffordance } from '../agent';
import { useFiscalProfile, useUpdateFiscalProfileField } from '../data/hooks';
import { FiscalFlowSheet } from '../components/fiscal/FiscalFlowSheet';
import { FiscalVoiceConfirmSheet } from '../components/fiscal/FiscalVoiceConfirmSheet';
import { fiscalFlowRemainingCount } from './fiscal-flow-steps';
import { matchFiscalVoiceUtterance, type FiscalVoiceProposal } from './fiscal-voice';

/**
 * Compose l'accès au profil fiscal pour UN écran (Argent, Home, Compte, « Mon profil fiscal ») :
 * la query partagée (react-query, même clé partout), le mini-flow, la confirmation vocale, et
 * les affordances vocales prêtes à fusionner dans l'AgentSurface de l'écran appelant. Chaque
 * écran monte `<flow.Sheets />` UNE fois et pilote l'ouverture via `flow.openFlow()`.
 */
export function useFiscalProfileFlow() {
  const { personality } = useTheme();
  const query = useFiscalProfile();
  const mutation = useUpdateFiscalProfileField();
  const [flowOpen, setFlowOpen] = useState(false);
  const [voiceProposal, setVoiceProposal] = useState<FiscalVoiceProposal | null>(null);

  const confirmField = useCallback(
    async (patch: FiscalProfileFieldPatch) => {
      await mutation.mutateAsync(patch);
    },
    [mutation],
  );

  // Séquence VOULUE (chaque patch dépend de l'état persisté par le précédent — le backend
  // Phase 1A n'expose qu'une écriture atomique PAR CHAMP, voir legal-regime-correction.ts).
  const confirmPatches = useCallback(
    async (patches: readonly FiscalProfileFieldPatch[]) => {
      for (const patch of patches) {
        // eslint-disable-next-line no-await-in-loop
        await mutation.mutateAsync(patch);
      }
    },
    [mutation],
  );

  const profile: FiscalProfileView | undefined = query.data;
  const remainingCount = fiscalFlowRemainingCount(profile);

  const voiceAffordances: readonly AgentAffordance[] = useMemo(() => {
    if (!profile) return [];
    return [
      {
        id: 'fiscal.voiceProposal',
        match: (utterance: string) => {
          const proposal = matchFiscalVoiceUtterance(utterance, personality);
          if (!proposal) return null;
          return () => {
            setVoiceProposal(proposal);
            return { say: proposal.say };
          };
        },
      },
    ];
  }, [profile, personality]);

  // JSX calculée à CHAQUE rendu (pas une fonction/composant enveloppée) : les éléments
  // <FiscalFlowSheet>/<FiscalVoiceConfirmSheet> gardent leur IDENTITÉ DE TYPE stable à cette
  // position — si `sheets` était un composant produit par useCallback, sa référence changerait
  // à chaque dépendance (le profil change après CHAQUE mutation) et React démonterait/remonterait
  // tout le sous-arbre (perdant `busy`/`error`/`laterAcked` en plein milieu d'un flow).
  const sheets: ReactNode = (
    <>
      {profile ? (
        <FiscalFlowSheet
          visible={flowOpen}
          profile={profile}
          personality={personality}
          confirmField={confirmField}
          confirmPatches={confirmPatches}
          onLater={() => setFlowOpen(false)}
          onDone={() => setFlowOpen(false)}
        />
      ) : null}
      {profile && voiceProposal ? (
        <FiscalVoiceConfirmSheet
          proposal={voiceProposal}
          profile={profile}
          personality={personality}
          confirmField={confirmField}
          confirmPatches={confirmPatches}
          onClose={() => setVoiceProposal(null)}
        />
      ) : null}
    </>
  );

  return {
    profile,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    refetch: query.refetch,
    remainingCount,
    hasPending: remainingCount > 0,
    openFlow: () => setFlowOpen(true),
    voiceAffordances,
    /** Exposées pour l'édition champ-par-champ (écran « Mon profil fiscal », FiscalFieldEditSheet) —
     * même mutation que le mini-flow, une seule source de vérité de l'écriture. */
    confirmField,
    confirmPatches,
    /** À rendre avec `{flow.sheets}` (PAS `<flow.sheets />`) — voir commentaire ci-dessus. */
    sheets,
  };
}
