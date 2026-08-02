/**
 * PR-12c — fiche CONTRAT DE MAINTENANCE (écrans §3.1-§3.2, kit matière Bob du train n°2).
 * Chaque badge/CTA est DÉRIVÉ des faits serveur (période arithmétique, couverture par les
 * factures réelles, alerte renouvellement) — l'écran constate, il ne réinterprète jamais :
 *  · les transitions interdites sont des CTA ABSENTS, jamais grisés ;
 *  · « Reconduire » n'est pas un bouton : la reconduction tacite est un FAIT CALCULÉ,
 *    étiqueté « (calculé) » dans l'historique (revue P10) ;
 *  · l'annulation d'une facture annuelle RALLUME le CTA toute seule — l'écran l'explique ;
 *  · « Préparer la facture annuelle » = BROUILLON en un tap (« rien n'est envoyé ») ; si la
 *    TVA re-suggérée diverge du contrat (bascule de régime — amélioration 2), le bloc
 *    « TVA recalculée » affiche l'écart honnêtement AVANT d'ouvrir le brouillon ;
 *  · préavis : LegalHint AFFICHÉ, jamais bloquant (la résiliation subie est actée, tracée) ;
 *  · « Renommer » : le geste que la garde du libellé PROMET (« un nom de contrat imparfait DANS
 *    L'APPLICATION se corrige d'un tap sur la fiche »). Sans lui, un nom mal compris à la dictée
 *    serait définitif — et toute la doctrine du train Contrats reposerait sur une promesse vide.
 */
import { useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  InteractionManager,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@bob/i18n';
import {
  BobSurface,
  Button,
  EmptyState,
  ErrorRetry,
  Eyebrow,
  LegalHint,
  MoneyText,
  MorphReplace,
  PressableScale,
  Sheet,
  SkeletonRow,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import { MAX_CONTRACT_LABEL_LENGTH, formatEURWhole, type Totals } from '@bob/core';
import type { MaintenanceContractClientView } from '@bob/api-client';
import {
  appErrorMessage,
  useActivateMaintenanceContract,
  useChantierEquipments,
  useDeleteDraftMaintenanceContract,
  useMaintenanceContract,
  usePrepareContractAnnualInvoice,
  useRenameMaintenanceContract,
  useTerminateMaintenanceContract,
} from '../../src/data/hooks';
import { ScreenHeader } from '../../src/components/screen-header';
import { ChevronRightIcon } from '../../src/components/icons';
import { useBobAwareScrollInsets } from '../../src/components/use-bob-aware-scroll-insets';
import { useConfirm } from '../../src/components/ConfirmSheet';
import {
  contractEventDay,
  contractHistoryEntries,
  contractRenameAllowed,
  contractRenameCloseEffect,
  contractRenameNotice,
  contractRenameSubmission,
  frContractDate,
  inclusivePeriodOf,
  isContractRevisionConflict,
} from '../../src/components/contract-fiche.logic';
import {
  ContractRenameReloadCoordinator,
  isMaintenanceContractNotFound,
} from '../../src/components/contract-rename-reload';
import { usePublishAgentContext, type AgentContext } from '../../src/agent';
import { issueContractDeletedNotice } from '../../src/lib/navigation-notice';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Seuil d'apparition du compteur de caractères du renommage — les derniers 20 % de la borne. */
const RENAME_COUNTER_FROM = Math.floor(MAX_CONTRACT_LABEL_LENGTH * 0.8);

/** Bloc « TVA recalculée » (amélioration 2) — l'écart contrat/brouillon, jamais réécrit en
 * silence. Conservé à l'écran tant que la fiche est ouverte (l'utilisateur choisit d'ouvrir). */
interface VatDivergenceNotice {
  invoiceId: string;
  totals: Totals;
  contractTotals: Totals;
}

interface RenameReloadTarget {
  readonly mode: 'conflict' | 'committed';
  readonly minimumRevision: number;
  readonly expectedLabel: string | null;
}

type RenamePostCloseEffect =
  | { readonly kind: 'alert'; readonly message: string }
  | { readonly kind: 'contract_missing' };

export default function FicheContrat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { personality, colors, controls, semantic } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const scrollInsets = useBobAwareScrollInsets();
  const confirm = useConfirm();

  const query = useMaintenanceContract(id);
  const view = query.data ?? null;
  const contract = view?.contract ?? null;
  // [Amélioration 4] « 3 couverts, dont 1 retiré » — le retrait AFFICHÉ, jamais masqué.
  const siteEquipments = useChantierEquipments(contract?.chantierId ?? '', contract?.chantierId != null);
  const activate = useActivateMaintenanceContract();
  const terminate = useTerminateMaintenanceContract();
  const deleteDraft = useDeleteDraftMaintenanceContract();
  const prepare = usePrepareContractAnnualInvoice();
  const rename = useRenameMaintenanceContract();

  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminateDate, setTerminateDate] = useState('');
  const [terminateNote, setTerminateNote] = useState('');
  const [terminateError, setTerminateError] = useState<string | null>(null);
  const [vatNotice, setVatNotice] = useState<VatDivergenceNotice | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  /** Dès que l'écriture est incertaine ou que la vue est périmée, la feuille se FIGE jusqu'à
   *  une relecture serveur prouvée. Même règle après succès : on n'annonce jamais « terminé »
   *  sur la seule réponse de mutation. */
  const [renameReloadTarget, setRenameReloadTarget] = useState<RenameReloadTarget | null>(null);
  const [renameReloadPending, setRenameReloadPending] = useState(false);
  const [renameReloadCoordinator] = useState(() => new ContractRenameReloadCoordinator());
  /** Fence impérative : couvre le tour JS entre le départ de mutateAsync et le prochain commit
   * React. Les states seuls laisseraient une ancienne closure fermer la feuille dans cet interstice. */
  const renameMutationInFlight = useRef(false);
  const renameTerminalCloseInFlight = useRef(false);
  const [renamePostCloseEffect, setRenamePostCloseEffect] =
    useState<RenamePostCloseEffect | null>(null);
  const renameStale = renameReloadTarget !== null;

  // Nom de RÉFÉRENCE du renommage : celui de la vue chargée. Le brouillon en part à l'ouverture
  // et n'est plus jamais réécrit sous les doigts du pro — si la fiche bouge ailleurs entre-temps,
  // c'est la révision qui le dira au moment d'écrire, pas un champ qui change tout seul.
  const currentLabel = contract?.label ?? '';

  usePublishAgentContext(
    useMemo<AgentContext>(
      () => ({
        screen: { name: '/contrat/[id]', instanceId: `contract:${id}` },
        entities: contract ? [{ type: 'contract' as const, id: contract.id, label: contract.label }] : [],
        capabilities: ['screen.read'],
      }),
      [contract, id],
    ),
  );

  if (query.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader
          backLabel={t('contrat.eyebrow', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title="…"
        />
        <View style={{ paddingHorizontal: 16 }}>
          <BobSurface tone="neutral" emphasis="raised">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </BobSurface>
        </View>
      </View>
    );
  }
  if (
    (query.isError && renameReloadTarget === null)
    || view === null
    || contract === null
  ) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader
          backLabel={t('contrat.eyebrow', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title={t('contrat.notFound', { personality })}
        />
        <View style={{ paddingHorizontal: 16 }}>
          {query.isError ? (
            <ErrorRetry message={t('contrat.dataError', { personality })} onRetry={() => void query.refetch()} />
          ) : (
            <EmptyState body={t('contrat.notFound', { personality })} />
          )}
        </View>
      </View>
    );
  }

  const lifecycle = view.lifecycle;
  const expired = lifecycle.expired;
  const badge =
    contract.status === 'draft'
      ? { variant: 'warning' as const, label: t('contrat.badgeDraft', { personality }) }
      : contract.status === 'terminated'
        ? {
            variant: 'neutral' as const,
            label: t('contrat.badgeTerminated', {
              personality,
              // Jour MÉTIER Paris, jamais le jour UTC : entre 00 h et 02 h l'UTC est
              // encore la veille et le badge daterait la résiliation d'un jour trop tôt.
              params: { date: frContractDate(contractEventDay(contract.terminatedAt) ?? '') },
            }),
          }
        : expired !== null
          ? {
              variant: 'warning' as const,
              label: t('contrat.badgeExpired', {
                personality,
                params: { date: frContractDate(expired.since) },
              }),
            }
          : { variant: 'success' as const, label: t('contrat.badgeActive', { personality }) };

  const period = view.currentPeriod === null ? null : inclusivePeriodOf(view.currentPeriod);
  const coveredBy = view.currentPeriodCoveredBy;
  const billingDue = view.billingDue;
  const renewal = view.renewalAlert;
  const history = contractHistoryEntries({ contract, renewals: lifecycle.renewals });
  const coveredEquipments = new Set(contract.equipmentIds);
  const retiredCovered = (siteEquipments.data ?? []).filter(
    (equipment) => coveredEquipments.has(equipment.id) && equipment.status === 'retired',
  ).length;

  const handlePrepare = async (): Promise<void> => {
    try {
      const prepared = await prepare.mutateAsync(contract.id);
      AccessibilityInfo.announceForAccessibility(t('contrat.prepareNote', { personality }));
      if (prepared.vatDivergence) {
        // Amélioration 2 : l'écart est DIT avant d'ouvrir le brouillon — jamais en silence.
        setVatNotice({
          invoiceId: prepared.invoiceId,
          totals: prepared.totals,
          contractTotals: prepared.contractTotals,
        });
        return;
      }
      router.push(`/facture/${prepared.invoiceId}`);
    } catch (error) {
      // Refus actionnables du domaine (« déjà couverte par F-… ») restitués tels quels.
      Alert.alert(t('contrat.prepareCta', { personality }), appErrorMessage(error));
    }
  };

  const handleActivate = async (): Promise<void> => {
    const okGo = await confirm({
      title: t('contrat.activateCta', { personality }),
      message: t('contrat.activateHint', { personality }),
      challenge: { kind: 'tap' },
    });
    if (!okGo) return;
    try {
      await activate.mutateAsync({ contractId: contract.id, expectedRevision: contract.revision });
    } catch (error) {
      Alert.alert('Oups', appErrorMessage(error));
    }
  };

  const handleDeleteDraft = async (): Promise<void> => {
    const okGo = await confirm({
      title: t('contrat.deleteDraftCta', { personality }),
      message: contract.label,
      challenge: { kind: 'tap' },
      destructive: true,
    });
    if (!okGo) return;
    try {
      await deleteDraft.mutateAsync({ contractId: contract.id, expectedRevision: contract.revision });
      router.back();
    } catch (error) {
      Alert.alert('Oups', appErrorMessage(error));
    }
  };

  // « Renommer » — le remède promis par la garde du libellé. Le champ part du nom COURANT (on
  // corrige un nom, on n'en réécrit pas un de zéro) et le geste se juge sur la logique pure
  // `contractRenameSubmission` : même verdict à l'écran et dans son test.
  const renameSubmission = contractRenameSubmission({
    current: currentLabel,
    typed: renameDraft,
  });
  // Ce que la feuille AFFICHE sous le champ : l'explication du bouton désactivé est VISIBLE,
  // jamais réservée au lecteur d'écran — un bouton gris sans raison ne se distingue pas d'un bug.
  const renameNotice = contractRenameNotice(renameSubmission.blocked);

  const openRename = (): void => {
    setRenameDraft(currentLabel);
    setRenameError(null);
    setRenameReloadTarget(null);
    setRenamePostCloseEffect(null);
    setRenameOpen(true);
  };

  /** Un not_found exact est une preuve terminale. On retire immédiatement cet ID de la liste
   *  cachée (sinon le staleTime global peut rendre une ligne fantôme encore tappable), puis on
   *  invalide la collection. La fiche détail est purgée après la transition de navigation. */
  const beginMissingContractExit = (): void => {
    if (renameTerminalCloseInFlight.current) return;
    queryClient.setQueryData<MaintenanceContractClientView[]>(
      ['contracts'],
      (cached) => cached?.filter((item) => item.contract.id !== contract.id),
    );
    void queryClient.invalidateQueries({ queryKey: ['contracts'], exact: true });
    renameTerminalCloseInFlight.current = true;
    setRenamePostCloseEffect({ kind: 'contract_missing' });
    setRenameError(null);
    setRenameOpen(false);
  };

  /** Une mutation réussie n'est pas encore une vue fiable. La feuille ne se ferme qu'après
   *  avoir relu le même contrat à une révision au moins égale à celle attendue. */
  const reloadRename = async (target: RenameReloadTarget): Promise<void> => {
    if (renameReloadCoordinator.isRunning) return;
    setRenameReloadPending(true);
    setRenameError(null);
    const outcome = await renameReloadCoordinator.reload({
      contractId: contract.id,
      minimumRevision: target.minimumRevision,
      refetch: () => query.refetch({ cancelRefetch: true }),
    });
    setRenameReloadPending(false);
    if (outcome.kind === 'missing') {
      // État terminal : réessayer ne fera jamais réapparaître un brouillon supprimé ailleurs.
      // On attend la fin visuelle de la Sheet avant de remplacer la route. La destination
      // possède le feedback : aucun Alert lancé par l'écran en cours de démontage.
      beginMissingContractExit();
      return;
    }
    if (outcome.kind === 'unavailable') {
      const message =
        target.mode === 'committed'
          ? t('contrat.renameCommittedReloadError', { personality })
          : t('contrat.renameReloadError', { personality });
      setRenameReloadTarget(target);
      setRenameError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }

    setRenameOpen(false);
    setRenameReloadTarget(null);
    setRenameError(null);
    if (target.mode === 'committed' && outcome.contract.label !== target.expectedLabel) {
      // Jamais deux modales : le message attend `Sheet.onDidClose`, après les 220 ms de sortie.
      setRenamePostCloseEffect({
        kind: 'alert',
        message: t('contrat.renameSuperseded', { personality }),
      });
      return;
    }
    AccessibilityInfo.announceForAccessibility(
      t(target.mode === 'committed' ? 'contrat.renameDone' : 'contrat.renameReloaded', {
        personality,
      }),
    );
  };

  /** LA seule sortie de la feuille — bouton « Recharger la fiche », scrim, geste de fermeture :
   *  après un conflit, toutes rechargent. Une porte qui laisserait la vue périmée rendrait le
   *  chemin honnête contournable, donc décoratif. */
  const closeRename = (): void => {
    // Fence synchrone : protège aussi l'interstice avant que `isPending` / state React soit
    // visible par une nouvelle closure.
    if (
      renameMutationInFlight.current
      || renameReloadCoordinator.isRunning
      || renameTerminalCloseInFlight.current
    ) return;
    const effect = contractRenameCloseEffect({
      pending: rename.isPending || renameReloadPending,
      stale: renameStale,
    });
    if (effect === 'stay') return;
    if (effect === 'reload_before_close' && renameReloadTarget !== null) {
      void reloadRename(renameReloadTarget);
      return;
    }
    setRenameOpen(false);
    setRenameReloadTarget(null);
    setRenameError(null);
  };

  const submitRename = async (): Promise<void> => {
    if (
      renameSubmission.label === null
      || renameMutationInFlight.current
      || renameReloadCoordinator.isRunning
    ) {
      // Rien à ajouter : ce qui bloque est DÉJÀ écrit sous le champ (`renameNotice`), et le
      // bouton est désactivé. Le redire en rouge ferait d'une attente une faute.
      return;
    }
    renameMutationInFlight.current = true;
    setRenameError(null);
    try {
      const renamed = await rename.mutateAsync({
        contractId: contract.id,
        // La révision de la vue DÉJÀ CHARGÉE — jamais une relecture juste avant l'appel, qui
        // ferait passer la garde CAS du serveur pour une formalité.
        expectedRevision: contract.revision,
        label: renameSubmission.label,
      });
      const target: RenameReloadTarget = {
        mode: 'committed',
        minimumRevision: renamed.revision,
        expectedLabel: renamed.label,
      };
      setRenameReloadTarget(target);
      await reloadRename(target);
    } catch (error) {
      if (isMaintenanceContractNotFound(error, contract.id)) {
        // Suppression inter-appareil AVANT le tap : même terminal que le not_found du refetch.
        // Jamais une erreur générique suivie d'un bouton qui réessaierait pour toujours.
        beginMissingContractExit();
        return;
      }
      if (isContractRevisionConflict(error)) {
        // La fiche a changé ailleurs entre son chargement et ce tap : Bob le DIT et s'arrête.
        // Pas de réessai avec la révision fraîche — ce serait écraser en silence le nom que
        // l'autre appareil vient d'écrire, exactement ce que la révision existe pour empêcher.
        setRenameReloadTarget({
          mode: 'conflict',
          minimumRevision: contract.revision + 1,
          expectedLabel: null,
        });
        setRenameError(t('contrat.renameConflict', { personality }));
        return;
      }
      setRenameError(appErrorMessage(error));
    } finally {
      renameMutationInFlight.current = false;
    }
  };

  const handleRenameDidClose = (): void => {
    if (renamePostCloseEffect === null) return;
    const effect = renamePostCloseEffect;
    setRenamePostCloseEffect(null);
    if (effect.kind === 'contract_missing') {
      renameTerminalCloseInFlight.current = false;
      const noticeToken = issueContractDeletedNotice({
        customerId: contract.customerId,
        contractId: contract.id,
      });
      router.replace({
        pathname: '/client/[id]',
        params: {
          id: contract.customerId,
          tab: 'contracts',
          noticeToken,
        },
      });
      // Le détail prouvé absent ne doit pas survivre dans le cache. Attendre la fin des
      // interactions évite de faire flasher le skeleton de la route qui est en train de sortir.
      void InteractionManager.runAfterInteractions(() => {
        queryClient.removeQueries({ queryKey: ['contract', contract.id], exact: true });
      });
      return;
    }
    Alert.alert(t('contrat.renameTitle', { personality }), effect.message);
  };

  const submitTerminate = async (): Promise<void> => {
    const note = terminateNote.trim();
    if (note === '') {
      setTerminateError(t('contrat.terminateNoteField', { personality }));
      return;
    }
    const date = terminateDate.trim();
    if (date !== '' && !DATE_ONLY.test(date)) {
      setTerminateError(t('contrat.dateInvalid', { personality }));
      return;
    }
    setTerminateError(null);
    try {
      await terminate.mutateAsync({
        contractId: contract.id,
        expectedRevision: contract.revision,
        note,
        ...(date !== '' ? { effectiveDate: date } : {}),
      });
      setTerminateOpen(false);
      setTerminateDate('');
      setTerminateNote('');
    } catch (error) {
      setTerminateError(appErrorMessage(error));
    }
  };

  // Lot 4 : le sur-titre maison (sub 700 + letterSpacing inline) → Eyebrow kit —
  // l'écran étalon ne réinvente pas le cran du kit.
  const sectionTitle = (label: string) => (
    <View style={{ marginTop: 16 }}>
      <Eyebrow>{label}</Eyebrow>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: scrollInsets.paddingBottom }}
        scrollIndicatorInsets={{ bottom: scrollInsets.scrollIndicatorBottom }}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
      >
        <ScreenHeader
          backLabel={view.customerName ?? t('contrat.clientLabel', { personality })}
          onBack={() => router.back()}
          eyebrow={t('contrat.eyebrow', { personality })}
          title={contract.label}
          // L'affordance vit SUR le titre — c'est lui qu'on corrige. Résilié = « lecture seule »
          // côté domaine : le CTA est alors ABSENT, jamais grisé (§3.1).
          action={
            contractRenameAllowed(contract.status) ? (
              <Button
                title={t('contrat.renameCta', { personality })}
                variant="secondary"
                size="compact"
                accessibilityLabel={`${t('contrat.renameCta', { personality })} — ${contract.label}`}
                onPress={openRename}
              />
            ) : undefined
          }
        />
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          {/* Héros — BobSurface marine (matière Bob, jamais la transparence iOS). */}
          <BobSurface tone="marine" emphasis="raised">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {/* Lot 4 : après « Résilier », le badge MORPHE sous les yeux (parité fiche
                  équipement) — reduce-motion : bascule sèche, l'annonce existante porte le fait. */}
              <MorphReplace morphKey={`${contract.status}|${expired !== null ? 'expired' : 'current'}`}>
                <StatusBadge variant={badge.variant} label={badge.label} />
              </MorphReplace>
              <StatusBadge
                variant="b2b"
                label={t(contract.tacitRenewal ? 'contrat.tacitOn' : 'contrat.tacitOff', { personality })}
              />
            </View>
            {/* Lot 4 : les liens '›' texte deviennent de vraies rangées — PressableScale +
                ChevronRightIcon + structure row/gap (une carte de navigation qui ne répond
                pas au doigt paraît cassée). */}
            <View style={{ gap: 4, marginTop: 10 }}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${t('contrat.clientLabel', { personality })} : ${view.customerName ?? ''}`}
                onPress={() => router.push(`/client/${contract.customerId}`)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}
              >
                <Text style={[font('body', 600), { color: colors.ink800, flexShrink: 1 }]} numberOfLines={1}>
                  {t('contrat.clientLabel', { personality })}  {view.customerName ?? contract.customerId}
                </Text>
                <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
              </PressableScale>
              {contract.chantierId !== null ? (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`${t('contrat.siteLabel', { personality })} : ${view.chantierNom ?? ''}`}
                  onPress={() => router.push(`/chantier/${contract.chantierId}`)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}
                >
                  <Text style={[font('body', 600), { color: colors.ink800, flexShrink: 1 }]} numberOfLines={1}>
                    {t('contrat.siteLabel', { personality })}  {view.chantierNom ?? contract.chantierId}
                  </Text>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </PressableScale>
              ) : null}
            </View>
            {/* Lot 4 : le total annuel en MoneyText (bigNum tabular) DANS la phrase i18n —
                le chiffre est le héros, la phrase reste celle de la voix de Bob. */}
            {(() => {
              const amount = formatEURWhole(view.annualTotals.ht);
              const line = `${t('contrat.totalPerYear', { personality, params: { amount } })}  ·  ${t(
                'contrat.visitsPerYear',
                { personality, params: { count: String(contract.visitsPerYear) } },
              )}`;
              const at = line.indexOf(amount);
              return (
                <Text style={[font('cardTitle'), { color: colors.ink800, marginTop: 10 }]}>
                  {at === -1 ? (
                    line
                  ) : (
                    <>
                      {line.slice(0, at)}
                      <MoneyText cents={view.annualTotals.ht} variant="big" whole color={colors.ink800} />
                      {line.slice(at + amount.length)}
                    </>
                  )}
                </Text>
              );
            })()}
          </BobSurface>

          {/* Bloc « TVA recalculée » (amélioration 2) — visible tant que l'écart n'est pas lu. */}
          {vatNotice !== null ? (
            <BobSurface tone="warning" emphasis="raised">
              <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                {t('contrat.vatDivergence', {
                  personality,
                  params: {
                    actual: formatEURWhole(vatNotice.totals.ttc),
                    expected: formatEURWhole(vatNotice.contractTotals.ttc),
                  },
                })}
              </Text>
              <LegalHint
                label={t('legal.contractVat.inline', { personality })}
                lawKey="legal.contractVat.law"
                whyKey="legal.contractVat.why"
                source="art. 293 B et 283-3 CGI"
              />
              <View style={{ alignSelf: 'flex-start', marginTop: 8 }}>
                <Button
                  title={t('contrat.seeDraftCta', { personality })}
                  onPress={() => {
                    const invoiceId = vatNotice.invoiceId;
                    setVatNotice(null);
                    router.push(`/facture/${invoiceId}`);
                  }}
                />
              </View>
            </BobSurface>
          ) : null}

          {/* ÉCHÉANCES — période CALCULÉE, couverture DÉRIVÉE (bornes INCLUSES lisibles). */}
          <BobSurface tone="neutral" emphasis="raised">
            <Eyebrow>{t('contrat.sectionEcheances', { personality })}</Eyebrow>
            {period !== null ? (
              <Text style={[font('body', 600), { color: colors.ink800, marginTop: 8 }]}>
                {t('contrat.currentPeriod', {
                  personality,
                  params: { start: frContractDate(period.start), end: frContractDate(period.end) },
                })}
              </Text>
            ) : null}
            {coveredBy !== null ? (
              <Text style={[font('sub', 600), { color: semantic.success, marginTop: 4 }]}>
                {coveredBy.by === 'invoice'
                  ? t('contrat.coveredByInvoice', { personality, params: { number: coveredBy.number ?? '—' } })
                  : t('contrat.coveredByImport', { personality })}
              </Text>
            ) : null}
            {billingDue !== null && billingDue.cancelledCoveringNumber !== null ? (
              <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 4 }]}>
                {t('contrat.rebillHint', {
                  personality,
                  params: { number: billingDue.cancelledCoveringNumber },
                })}
              </Text>
            ) : null}
            {billingDue !== null ? (
              <View style={{ alignSelf: 'flex-start', marginTop: 10 }}>
                <Button
                  title={t('contrat.prepareCta', { personality })}
                  loading={prepare.isPending}
                  onPress={() => void handlePrepare()}
                />
              </View>
            ) : null}
            {billingDue !== null ? (
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 6 }]}>
                {t('contrat.prepareNote', { personality })}
              </Text>
            ) : null}
            {contract.status === 'active' && renewal !== null ? (
              <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 8 }]}>
                {t(renewal.tacit ? 'contrat.renewalTacit' : 'contrat.renewalNonTacit', {
                  personality,
                  params: { days: String(renewal.daysUntil) },
                })}
              </Text>
            ) : null}
            {contract.status === 'active' && renewal !== null ? (
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 2 }]}>
                {t('contrat.nextAnniversary', {
                  personality,
                  params: { date: frContractDate(renewal.anniversary) },
                })}
              </Text>
            ) : null}
            {lifecycle.terminatedCoverage !== null ? (
              <Text style={[font('sub', 600), { color: colors.slate500, marginTop: 8 }]}>
                {t('contrat.terminatedCoverage', {
                  personality,
                  params: { date: frContractDate(lifecycle.terminatedCoverage.until) },
                })}
              </Text>
            ) : null}
            <View style={{ marginTop: 8 }}>
              <LegalHint
                label={t('legal.contractNotice.inline', {
                  personality,
                  params: { days: String(contract.noticeDays) },
                })}
                lawKey="legal.contractNotice.law"
                whyKey="legal.contractNotice.why"
                source="clause de préavis du contrat"
              />
            </View>
          </BobSurface>

          {/* ÉQUIPEMENTS COUVERTS — le retrait est AFFICHÉ (amélioration 4). */}
          {contract.equipmentIds.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('contrat.sectionEquipments', { personality })}
              disabled={contract.chantierId === null}
              onPress={() => {
                if (contract.chantierId !== null) router.push(`/equipements/${contract.chantierId}`);
              }}
            >
              <BobSurface tone="neutral" emphasis="raised">
                <Eyebrow>{t('contrat.sectionEquipments', { personality })}</Eyebrow>
                <Text style={[font('body', 600), { color: colors.ink800, marginTop: 6 }]}>
                  {retiredCovered > 0
                    ? t('contrat.equipmentsCountRetired', {
                        personality,
                        params: {
                          count: String(contract.equipmentIds.length),
                          retired: String(retiredCovered),
                        },
                      })
                    : t('contrat.equipmentsCount', {
                        personality,
                        params: { count: String(contract.equipmentIds.length) },
                      })}
                  {contract.chantierId !== null ? ' ›' : ''}
                </Text>
              </BobSurface>
            </Pressable>
          ) : null}

          {/* LIGNES — Σ vivante, jamais persistée (catégorie 'subscription' à la facture). */}
          {sectionTitle(t('contrat.sectionLines', { personality }))}
          <BobSurface tone="neutral" emphasis="raised" padding={12}>
            {contract.lines.map((line, index) => (
              <View
                key={line.id}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderTopWidth: index > 0 ? 1 : 0,
                  borderTopColor: colors.lineSoft,
                  gap: 12,
                }}
              >
                <Text style={[font('body'), { color: colors.ink800, flexShrink: 1 }]}>{line.label}</Text>
                <Text style={[font('body', 600), { color: colors.ink800 }]}>
                  {`${line.quantity} × ${formatEURWhole(line.unitPriceHtCents)}`}
                </Text>
              </View>
            ))}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingTop: 10,
                borderTopWidth: contract.lines.length > 0 ? 1 : 0,
                borderTopColor: colors.lineSoft,
              }}
            >
              <Text style={[font('body', 700), { color: colors.ink800 }]}>
                {t('contrat.totalHtYear', { personality })}
              </Text>
              <Text style={[font('body', 700), { color: colors.ink800 }]}>
                {formatEURWhole(view.annualTotals.ht)}
              </Text>
            </View>
          </BobSurface>

          {/* HISTORIQUE honnête [P10] — faits stockés + reconductions « (calculé) ». */}
          {history.length > 0 ? (
            <>
              {sectionTitle(t('contrat.sectionHistory', { personality }))}
              <BobSurface tone="neutral" emphasis="raised" padding={12}>
                {history.map((entry, index) => (
                  <View
                    key={`${entry.kind}-${entry.at}-${index}`}
                    style={{
                      paddingVertical: 8,
                      borderTopWidth: index > 0 ? 1 : 0,
                      borderTopColor: colors.lineSoft,
                    }}
                  >
                    <Text style={[font('body'), { color: colors.ink800 }]}>
                      {`${frContractDate(entry.at)} — ${
                        entry.kind === 'activated'
                          ? t('contrat.historyActivated', { personality })
                          : entry.kind === 'renewed'
                            ? t('contrat.historyRenewed', { personality })
                            : t('contrat.historyTerminated', {
                                personality,
                                params: { note: entry.note ?? '—' },
                              })
                      }`}
                    </Text>
                  </View>
                ))}
              </BobSurface>
            </>
          ) : null}

          {/* Gestes d'état — dérivés §3.1 (CTA absents quand la transition est interdite). */}
          {contract.status === 'draft' ? (
            <View style={{ gap: 8 }}>
              <Button
                title={t('contrat.activateCta', { personality })}
                loading={activate.isPending}
                onPress={() => void handleActivate()}
              />
              <Button
                title={t('contrat.deleteDraftCta', { personality })}
                variant="secondary"
                loading={deleteDraft.isPending}
                onPress={() => void handleDeleteDraft()}
              />
            </View>
          ) : null}
          {contract.status === 'active' ? (
            <Button
              title={t('contrat.terminateCta', { personality })}
              variant="secondary"
              onPress={() => {
                setTerminateError(null);
                setTerminateOpen(true);
              }}
            />
          ) : null}
        </View>
      </ScrollView>

      {/* Renommer — champ PRÉ-REMPLI du nom courant, borné par le domaine
          (MAX_CONTRACT_LABEL_LENGTH), validation DÉSACTIVÉE tant que rien n'a changé. Le nom
          tapé n'est PAS soumis à la garde des noms DÉDUITS d'une dictée : ce geste EST le remède
          qu'elle promet, l'y soumettre le rendrait circulaire. */}
      <Sheet
        visible={renameOpen}
        onClose={closeRename}
        accessibilityLabel={t('contrat.renameTitle', { personality })}
        closeAccessibilityHint={
          renameStale ? t('contrat.renameReloadCloseHint', { personality }) : undefined
        }
        closeBusy={rename.isPending || renameReloadPending}
        onDidClose={handleRenameDidClose}
      >
        <Text
          accessibilityRole="header"
          style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}
        >
          {t('contrat.renameTitle', { personality })}
        </Text>
        <View style={{ gap: 10 }}>
          <TextInput
            value={renameDraft}
            onChangeText={(value) => {
              setRenameError(null);
              setRenameDraft(value);
            }}
            // Borne du DOMAINE, jamais une copie : le champ ne peut pas laisser taper un nom
            // que `MaintenanceContract.record` refuserait ensuite.
            maxLength={MAX_CONTRACT_LABEL_LENGTH}
            editable={!rename.isPending && !renameReloadPending && !renameStale}
            placeholder={t('contrat.renameField', { personality })}
            placeholderTextColor={colors.slate400}
            // Pas d'accessibilityHint : la MÊME phrase est AFFICHÉE juste sous le champ (plus
            // bas). En mettre une ici la ferait lire deux fois de suite au lecteur d'écran.
            accessibilityLabel={t('contrat.renameField', { personality })}
            autoFocus
            autoCapitalize="sentences"
            autoCorrect
            returnKeyType="done"
            onSubmitEditing={() => void submitRename()}
            style={[
              font('body'),
              {
                minHeight: 44,
                borderWidth: 1,
                // Le champ se souligne de la MÊME façon qu'il refuse : un refus écrit en rouge
                // sous un champ resté neutre laisserait croire que la faute est ailleurs.
                borderColor:
                  renameError !== null || renameNotice?.tone === 'refus'
                    ? semantic.danger
                    : controls.cardBorder,
                borderRadius: 12,
                paddingHorizontal: 12,
                color: colors.ink800,
                backgroundColor: colors.surface,
              },
            ]}
          />
          {/* Compteur affiché SEULEMENT à l'approche de la borne : permanent, il ferait du bruit
              sur un nom de trois mots ; absent, la limite se découvrirait au moment de buter. */}
          {renameDraft.length >= RENAME_COUNTER_FROM ? (
            <Text
              style={[
                font('meta'),
                { color: colors.slate400, textAlign: 'right', fontVariant: ['tabular-nums'] },
              ]}
            >
              {`${renameDraft.length}/${MAX_CONTRACT_LABEL_LENGTH}`}
            </Text>
          ) : null}
          {/* Ce que ce nom fait — et surtout ce qu'il NE fait PAS : la ligne de la facture
              annuelle reste composée par le domaine. Promettre l'inverse serait mentir. */}
          <Text style={[font('sub', 500), { color: colors.slate500 }]}>
            {t('contrat.renameHint', { personality })}
          </Text>
          {renameError !== null ? (
            <Text accessibilityRole="alert" style={[font('sub', 600), { color: semantic.danger }]}>
              {renameError}
            </Text>
          ) : null}
          {/* POURQUOI le bouton est gris — écrit à l'écran, pas seulement dit au lecteur
              d'écran. Ton calme pour ce qui ATTEND (« rien n'a changé », champ vidé) : ce n'est
              pas une faute ; ton d'alerte pour ce que le domaine refusera de toute façon. */}
          {renameNotice !== null && !renameStale ? (
            <Text
              style={[
                font('sub', renameNotice.tone === 'refus' ? 600 : 500),
                { color: renameNotice.tone === 'refus' ? semantic.danger : colors.slate500 },
              ]}
            >
              {t(renameNotice.key, {
                personality,
                params: { max: String(MAX_CONTRACT_LABEL_LENGTH) },
              })}
            </Text>
          ) : null}
          {renameStale ? (
            // Conflit de révision : le SEUL chemin honnête est de repartir du nom à jour — et
            // toutes les autres sorties de la feuille rechargent aussi (closeRename).
            <Button
              title={t('contrat.renameReload', { personality })}
              variant="secondary"
              loading={renameReloadPending}
              onPress={closeRename}
            />
          ) : (
            <Button
              title={t('contrat.renameConfirm', { personality })}
              loading={rename.isPending}
              disabled={renameSubmission.label === null}
              onPress={() => void submitRename()}
            />
          )}
        </View>
      </Sheet>

      {/* Résilier… — date d'effet DÉFAUT = prochain anniversaire CALCULÉ, motif obligatoire ;
          préavis expliqué (LegalHint), JAMAIS bloquant. */}
      <Sheet
        visible={terminateOpen}
        onClose={() => {
          if (!terminate.isPending) setTerminateOpen(false);
        }}
        accessibilityLabel={t('contrat.terminateTitle', { personality })}
      >
        <Text style={[font('section'), { color: colors.ink800, marginBottom: 10 }]}>
          {t('contrat.terminateTitle', { personality })}
        </Text>
        <View style={{ gap: 8 }}>
          {renewal !== null ? (
            <Text style={[font('sub', 500), { color: colors.slate500 }]}>
              {t('contrat.terminateDateHint', {
                personality,
                params: { date: frContractDate(renewal.anniversary) },
              })}
            </Text>
          ) : null}
          <TextInput
            value={terminateDate}
            onChangeText={(value) => {
              setTerminateError(null);
              setTerminateDate(value);
            }}
            placeholder={t('contrat.terminateDateField', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('contrat.terminateDateField', { personality })}
            autoCapitalize="none"
            style={[
              font('body'),
              {
                minHeight: 44,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                borderRadius: 12,
                paddingHorizontal: 12,
                color: colors.ink800,
                backgroundColor: colors.surface,
              },
            ]}
          />
          <TextInput
            value={terminateNote}
            onChangeText={(value) => {
              setTerminateError(null);
              setTerminateNote(value);
            }}
            placeholder={t('contrat.terminateNoteField', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('contrat.terminateNoteField', { personality })}
            multiline
            style={[
              font('body'),
              {
                minHeight: 66,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingTop: 10,
                color: colors.ink800,
                backgroundColor: colors.surface,
              },
            ]}
          />
          <LegalHint
            label={t('legal.contractNotice.inline', {
              personality,
              params: { days: String(contract.noticeDays) },
            })}
            lawKey="legal.contractNotice.law"
            whyKey="legal.contractNotice.why"
            source="clause de préavis du contrat"
          />
          {terminateError ? (
            /* Lot 4 : résilier est le geste le plus grave de la fiche — son erreur parle
               en DANGER avec role alert, elle ne chuchote pas en slate. */
            <Text accessibilityRole="alert" style={[font('sub', 600), { color: semantic.danger }]}>
              {terminateError}
            </Text>
          ) : null}
          <Button
            title={t('contrat.terminateConfirm', { personality })}
            loading={terminate.isPending}
            onPress={() => void submitTerminate()}
          />
        </View>
      </Sheet>
    </View>
  );
}
