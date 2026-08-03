/**
 * Clôture — préparer le mois pour le comptable (refonte @bob/ui, CLOTURE-UI). Pattern écran
 * poussé (A3-C17) : rangée retour sticky (bg .92) + InnerScreenHeader → carte de synthèse
 * (tout prêt / points à arbitrer) → « À arbitrer » + « Pièces » (checklist actionnable, mêmes
 * points d'entrée que Bob) → ÉTATS DE SYNTHÈSE (balance générale + compte de résultat CDR-1 +
 * bilan BILAN-1, dérivés @bob/core, cohérents par construction) → « Envoyer au comptable »
 * (dossier DOSSIER-1 + FEC). Paywall accounting_operations conservé — via la fondation
 * monetization (useEntitlement + PaywallCard contextuelle, jamais pendant le chargement).
 * Zéro hex, zéro fixture, i18n cloture.* ×3 humeurs.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  buildClosingDossier,
  deriveBalanceSheet,
  deriveClosingReview,
  deriveIncomeStatement,
  deriveTrialBalance,
  formatEUR,
} from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  IconTile,
  InnerScreenHeader,
  PressableScale,
  SectionHeader,
  Sheet,
  SkeletonCard,
  StaggeredList,
  StatusBadge,
  StickyBackRow,
  Toast,
  font,
  useErrorSheet,
  useTheme,
} from '@bob/ui';
import {
  useAccountingEntries,
  useCompany,
  useExportFec,
  useInvoices,
  useQuotes,
  appErrorMessage,
} from '../src/data/hooks';
import { PaywallCard, useEntitlement } from '../src/monetization/paywall';
import { useDocuments } from '../src/data/documents';
import { combineQueryStates } from '../src/data/query-state';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { shareFec } from '../src/lib/share-fec';
import { shareTextFile } from '../src/lib/share-text';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
import {
  ChartIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileIcon,
  SendIcon,
} from '../src/components/icons';

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Mois courant (clé AAAA-MM + libellé « juillet 2026 ») — sans Intl, comme formatEUR. */
function moisCourant(d: Date = new Date()): { key: string; label: string } {
  return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
}

interface CheckItem {
  key: string;
  labelKey: I18nKey;
  count: number;
  route: Href;
}

export default function Cloture() {
  const { personality, colors, semantic, controls } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  // Entitlement TYPÉ (fondation paywall) — même feature que le gating historique de l'écran.
  const entitlement = useEntitlement('accounting_operations');
  const invoices = useInvoices();
  const quotes = useQuotes();
  const documents = useDocuments();
  const entries = useAccountingEntries();
  const company = useCompany();
  const exportFec = useExportFec();
  const entitled = entitlement.allowed;
  const [sendingDossier, setSendingDossier] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Grammaire d'erreur (Lot 5) : les échecs appelables au support passent en ErrorSheet
  // (voix + matière de Bob), les avertissements FEC en Sheet listée — plus d'Alert système.
  const errorSheet = useErrorSheet();
  const [fecWarnings, setFecWarnings] = useState<readonly string[] | null>(null);

  // Toutes les synthèses de clôture croisent ces cinq lectures autoritatives. Une source
  // absente ou en échec ferme aussi Bob : l'agent ne doit jamais commenter une clôture
  // calculée à partir de tableaux vides transitoires.
  const queryState = combineQueryStates(invoices, quotes, documents, entries, company);
  // Pending VISIBLE du « Réessayer » (ErrorRetry) — passe feel 18/07.
  const refreshing =
    invoices.isRefetching ||
    quotes.isRefetching ||
    documents.isRefetching ||
    entries.isRefetching ||
    company.isRefetching;
  const agentDataReady =
    entitlement.verified &&
    entitled &&
    !queryState.loading &&
    !queryState.failed &&
    invoices.data !== undefined &&
    quotes.data !== undefined &&
    documents.data !== undefined &&
    entries.data !== undefined &&
    company.data !== undefined;

  // Bob sait que tu es sur la clôture — « lance la revue » (intent revue_cloture) fait le
  // reste ; aucune entité publiée : les contrôles ne sont pas des pièces adressables (S3).
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'cloture', instanceId: 'cloture' },
      entities: [],
      capabilities: agentDataReady ? ['screen.read'] : [],
    }),
    [agentDataReady],
  );
  usePublishAgentContext(agentContext);

  // États de synthèse dérivés @bob/core — cohérents par construction (résultat identique).
  const balance = useMemo(() => deriveTrialBalance(entries.data ?? []), [entries.data]);
  const income = useMemo(() => deriveIncomeStatement(entries.data ?? []), [entries.data]);
  const bilan = useMemo(() => deriveBalanceSheet(entries.data ?? []), [entries.data]);

  const mois = moisCourant();
  const inv = invoices.data ?? [];
  const qs = quotes.data ?? [];
  const docs = documents.data ?? [];
  // P0 (audit 14/07) : failed se lit TOUJOURS avec loading — un timeout réseau ne devient
  // jamais un allClear=true silencieux (socle combineQueryStates, cf. src/data/query-state.ts).
  const signedNotInvoiced = qs.filter((q) => q.status === 'signed' && !inv.some((i) => i.parentQuoteId === q.id));
  const invoicePdfIds = new Set(docs.filter((d) => d.kind === 'invoice_pdf' && d.linkedEntityId).map((d) => d.linkedEntityId));
  const missingPdf = inv
    .filter((i) => i.status !== 'draft' && i.status !== 'cancelled')
    .filter((i) => !invoicePdfIds.has(i.id));

  const anomalies: CheckItem[] = [
    { key: 'signed', labelKey: 'cloture.itemSignedNotInvoiced', count: signedNotInvoiced.length, route: '/ventes' },
    { key: 'drafts', labelKey: 'cloture.itemDrafts', count: inv.filter((i) => i.status === 'draft').length, route: '/ventes' },
    { key: 'late', labelKey: 'cloture.itemLate', count: inv.filter((i) => i.status === 'late').length, route: '/ventes' },
    { key: 'partial', labelKey: 'cloture.itemPartial', count: inv.filter((i) => i.status === 'partially_paid').length, route: '/ventes' },
  ];
  const pieces: CheckItem[] = [
    { key: 'pdf', labelKey: 'cloture.itemMissingPdf', count: missingPdf.length, route: '/documents' },
  ];
  const anomaliesTotal = anomalies.reduce((s, i) => s + i.count, 0);
  const piecesTotal = pieces.reduce((s, i) => s + i.count, 0);
  const allClear = anomaliesTotal === 0 && piecesTotal === 0;

  // `mois.key` est produit localement au format AAAA-MM. On le relit sans année/mois de
  // secours : un fallback calendaire codé en dur pourrait fabriquer une période comptable
  // différente de celle affichée si ce contrat interne venait à être cassé.
  const yy = Number(mois.key.slice(0, 4));
  const mm = Number(mois.key.slice(5, 7));
  const fecFrom = `${mois.key}-01`;
  const fecTo = `${mois.key}-${pad(new Date(yy, mm, 0).getDate())}`;
  // Période COMPTABLE des états et de la revue = l'exercice À DATE (le bilan est cumulatif —
  // un bilan du seul mois serait faux) ; le mois reste la période du FEC et l'emballage.
  const reviewFrom = `${yy}-01-01`;
  const yearEnd = mm === 12;

  // DOSSIER-2 : les diligences de l'EC exécutées par Bob — même use case que le dossier envoyé.
  const engagedInvoices = inv.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const review = useMemo(
    () =>
      deriveClosingReview({
        entries: (entries.data ?? []).map((e) => ({ entryDate: e.entryDate, lines: e.lines })),
        period: { from: reviewFrom, to: fecTo },
        justificatifs: { expected: engagedInvoices.length, provided: engagedInvoices.length - missingPdf.length },
        yearEnd,
      }),
    [entries.data, reviewFrom, fecTo, engagedInvoices.length, missingPdf.length, yearEnd],
  );

  const onExportFec = async (): Promise<void> => {
    try {
      const res = await exportFec.mutateAsync({ from: fecFrom, to: fecTo });
      const shared = await shareFec(res); // E9 : octets ISO 8859-15 (arrêté 29/07/2013)
      if (shared === 'unavailable') setToast(t('cloture.fecGenerated', { personality, params: { filename: res.filename } }));
      if (res.warnings.length) setFecWarnings(res.warnings);
    } catch (e) {
      // Échec appelable au support : la feuille de Bob, plus jamais « Oups » système.
      errorSheet.showError(t('cloture.exportFec', { personality }), appErrorMessage(e));
    }
  };

  const onSendDossier = async (): Promise<void> => {
    if (!company.data) {
      errorSheet.showError(
        t('cloture.sendDossier', { personality }),
        "L'identité de l'entreprise n'est pas disponible. Réessaie avant de préparer le dossier.",
      );
      return;
    }
    setSendingDossier(true);
    try {
      const now = new Date();
      const dossier = buildClosingDossier({
        company: { name: company.data.name, siren: company.data.siren },
        // Exercice à date : mêmes états et même revue que l'écran (le FEC, lui, reste au mois).
        period: { from: reviewFrom, to: fecTo },
        generatedOn: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        entries: (entries.data ?? []).map((e) => ({ entryDate: e.entryDate, lines: e.lines })),
        justificatifs: { expected: engagedInvoices.length, provided: engagedInvoices.length - missingPdf.length },
        yearEnd,
      });
      const shared = await shareTextFile(dossier);
      if (shared === 'unavailable') setToast(t('cloture.dossierPrepared', { personality, params: { filename: dossier.filename } }));
    } catch (e) {
      errorSheet.showError(t('cloture.sendDossier', { personality }), appErrorMessage(e));
    } finally {
      setSendingDossier(false);
    }
  };

  /** Rangée de checklist : pastille statut + libellé + compteur + chevron (si à traiter).
   * Press feedback standard (PressableScale) — une rangée réglée (count 0) reste inerte
   * SANS accessibilityState.disabled (verdict Lot 5, P3) : « c'est réglé » n'est pas
   * « non disponible », VoiceOver n'annonce rien de désactivé sur une rangée gagnée. */
  function CheckRow({ item, divider }: { item: CheckItem; divider: boolean }) {
    const done = item.count === 0;
    return (
      <PressableScale
        accessibilityRole={item.count > 0 ? 'button' : undefined}
        accessibilityLabel={`${t(item.labelKey, { personality })} : ${item.count}`}
        onPress={item.count > 0 ? () => router.push(item.route) : undefined}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          paddingVertical: 11,
          borderBottomWidth: divider ? 1 : 0,
          borderBottomColor: colors.lineSoft,
        }}
      >
        <IconTile tone={done ? 'success' : 'particulier'} size={30} radius={9}>
          {done ? (
            <CheckIcon color={semantic.success} size={14} />
          ) : (
            <Feather name="alert-triangle" size={14} color={semantic.particulier} />
          )}
        </IconTile>
        <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]}>{t(item.labelKey, { personality })}</Text>
        <StatusBadge label={String(item.count)} variant={done ? 'success' : 'particulier'} />
        {item.count > 0 ? <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} /> : null}
      </PressableScale>
    );
  }

  /** Ligne « libellé …… montant » teintée par signe (états de synthèse). */
  function AmountRow({ label, cents, strong, topBorder }: { label: string; cents: number; strong?: boolean; topBorder?: boolean }) {
    return (
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingVertical: strong ? 8 : 6,
          borderTopWidth: topBorder ? 1 : 0,
          borderTopColor: colors.lineSoft,
        }}
      >
        <Text style={[strong ? font('cardTitle') : font('sub'), { color: colors.ink800 }]}>{label}</Text>
        <Text
          style={[
            strong ? font('cardTitle') : font('sub'),
            { color: cents >= 0 ? colors.ink900 : semantic.warning, fontVariant: ['tabular-nums'] },
          ]}
        >
          {cents < 0 ? '−' : ''}
          {formatEUR(Math.abs(cents))}
        </Text>
      </View>
    );
  }

  const section = (title: I18nKey, body: ReactNode): ReactNode => (
    <View>
      <SectionHeader title={t(title, { personality })} />
      {body}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
      >
        <StickyBackRow
          backLabel={t('cloture.back', { personality })}
          onBack={() => router.back()}
        />

        <InnerScreenHeader
          eyebrow={t('cloture.eyebrow', { personality })}
          title={t('cloture.title', { personality })}
          subtitle={t('cloture.subtitle', { personality, params: { month: mois.label } })}
        />

        <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 14 }}>
          {/* Abonnement en chargement → squelettes, JAMAIS le paywall (fail-open d'affichage) ;
              verrouillé → carte contextuelle du domaine (même emplacement que le contenu) ;
              decision 'unavailable' (aucun catalogue ne vend la capacité) → PaywallCard rend
              null PAR CONSTRUCTION (paywall.tsx) : repli EmptyState pour ne jamais laisser
              l'écran vide (P2 audit 14/07). */}
          {!entitlement.loading && !entitled ? (
            entitlement.decision !== null ? (
              entitlement.decision.kind === 'unavailable' ? (
                <Card>
                  <EmptyState
                    title={t('cloture.paywallTitle', { personality })}
                    body={t('cloture.paywallBody', { personality })}
                  />
                </Card>
              ) : (
                <PaywallCard
                  decision={entitlement.decision}
                  source="feature_screen"
                  personality={personality}
                  onDismissed={() => router.back()}
                />
              )
            ) : null
          ) : entitlement.loading || queryState.loading ? (
            // 8 Cards réelles (synthèse, revue, arbitrer, pièces, balance, résultat, bilan,
            // grand-livre) — hauteurs calées sur leur gabarit final (zéro saut de layout).
            <>
              <SkeletonCard height={92} contentLines={2} />
              <SkeletonCard height={320} contentLines={6} />
              <SkeletonCard height={240} contentLines={4} />
              <SkeletonCard height={84} contentLines={1} />
              <SkeletonCard height={280} contentLines={6} />
              <SkeletonCard height={200} contentLines={5} />
              <SkeletonCard height={230} contentLines={5} />
              <SkeletonCard height={66} contentLines={1} />
            </>
          ) : queryState.failed ? (
            // P0 (audit 14/07) : un échec réseau n'est JAMAIS présenté comme « tout est prêt
            // pour le comptable » — remplace toute la synthèse À LA PLACE du contenu.
            <ErrorRetry
              message={t('today.dataError', { personality })}
              onRetry={queryState.refetchAll}
              retrying={refreshing}
            />
          ) : (
            // Cascade sobre (Lot 5) : chaque bloc de la clôture fond en entrant (40 ms/rang,
            // cap 8) — coupée nette sous reduce-motion, wrappers enfants directs du gap 14.
            <StaggeredList>
              {/* Synthèse — tout prêt ou points restants */}
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                  <IconTile tone={allClear ? 'success' : 'particulier'} size={34} radius={10}>
                    {allClear ? (
                      <ClipboardCheckIcon color={semantic.success} />
                    ) : (
                      <Feather name="alert-triangle" size={16} color={semantic.particulier} />
                    )}
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                      {t(allClear ? 'cloture.allClear' : 'cloture.readyTitle', { personality })}
                    </Text>
                    {!allClear ? (
                      <Text style={{ ...font('sub', 500), fontSize: 12.5, color: colors.slate500, marginTop: 3, lineHeight: 18 }}>
                        {anomaliesTotal > 0
                          ? anomaliesTotal === 1
                            ? t('cloture.remainArbitrerOne', { personality })
                            : t('cloture.remainArbitrer', { personality, params: { count: anomaliesTotal } })
                          : ''}
                        {anomaliesTotal > 0 && piecesTotal > 0 ? ' · ' : ''}
                        {piecesTotal > 0
                          ? piecesTotal === 1
                            ? t('cloture.remainPiecesOne', { personality })
                            : t('cloture.remainPieces', { personality, params: { count: piecesTotal } })
                          : ''}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Card>

              {/* DOSSIER-2 — la revue de pré-signature : Bob exécute les diligences, l'EC signe */}
              {section(
                'cloture.reviewSection',
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.lineSoft }}>
                    <Text style={[font('sub'), { color: colors.slate500, flex: 1 }]}>
                      {t(
                        !review.readyToSign
                          ? 'cloture.reviewBlocked'
                          : review.hasReserves
                            ? 'cloture.reviewReserves'
                            : 'cloture.reviewReady',
                        {
                          personality,
                          params: { count: String(!review.readyToSign ? review.anomalieCount : review.attentionCount) },
                        },
                      )}
                    </Text>
                    <StatusBadge
                      label={`${review.okCount}/${review.okCount + review.attentionCount + review.anomalieCount}`}
                      variant={!review.readyToSign ? 'danger' : review.hasReserves ? 'particulier' : 'success'}
                    />
                  </View>
                  {review.controls.map((ctrl, i) => (
                    <View
                      key={ctrl.id}
                      accessible
                      accessibilityLabel={`${ctrl.label} : ${ctrl.detail}`}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'flex-start',
                        gap: 10,
                        paddingVertical: 9,
                        borderBottomWidth: i < review.controls.length - 1 ? 1 : 0,
                        borderBottomColor: colors.lineSoft,
                      }}
                    >
                      <Feather
                        name={ctrl.status === 'ok' ? 'check-circle' : ctrl.status === 'info' ? 'info' : ctrl.status === 'attention' ? 'alert-triangle' : 'x-circle'}
                        size={15}
                        color={
                          ctrl.status === 'ok'
                            ? semantic.success
                            : ctrl.status === 'info'
                              ? semantic.b2b
                              : ctrl.status === 'attention'
                                ? semantic.particulier
                                : semantic.danger
                        }
                        style={{ marginTop: 2 }}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[font('sub'), { color: colors.ink800 }]}>{ctrl.label}</Text>
                        <Text style={[font('meta'), { color: colors.slate400, marginTop: 1, lineHeight: 16 }]}>{ctrl.detail}</Text>
                      </View>
                    </View>
                  ))}
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 8, lineHeight: 16 }]}>
                    {t('cloture.reviewHint', { personality })}
                  </Text>
                </Card>,
              )}

              {section(
                'cloture.sectionArbitrer',
                <Card>
                  {anomalies.map((item, i) => (
                    <CheckRow key={item.key} item={item} divider={i < anomalies.length - 1} />
                  ))}
                </Card>,
              )}

              {section(
                'cloture.sectionPieces',
                <Card>
                  {pieces.map((item, i) => (
                    <CheckRow key={item.key} item={item} divider={i < pieces.length - 1} />
                  ))}
                </Card>,
              )}

              {balance.rows.length > 0 ? (
                <>
                  {/* Balance générale */}
                  {section(
                    'cloture.sectionBalance',
                    <Card>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[font('meta'), { color: colors.slate400 }]}>{t('cloture.resultProvisoire', { personality })}</Text>
                          <Text
                            style={{
                              ...font('bigNum'),
                              fontSize: 24,
                              color: balance.resultCents >= 0 ? semantic.success : semantic.warning,
                              marginTop: 2,
                              fontVariant: ['tabular-nums'],
                            }}
                          >
                            {balance.resultCents >= 0 ? '+' : '−'}
                            {formatEUR(Math.abs(balance.resultCents))}
                          </Text>
                          <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                            {t('cloture.produitsCharges', {
                              personality,
                              params: { produits: formatEUR(balance.revenueCents), charges: formatEUR(balance.chargesCents) },
                            })}
                          </Text>
                        </View>
                        <StatusBadge
                          label={t(balance.balanced ? 'cloture.balanced' : 'cloture.unbalanced', { personality })}
                          variant={balance.balanced ? 'success' : 'danger'}
                        />
                      </View>
                      <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
                      {balance.rows.map((row) => (
                        <View
                          key={row.account}
                          accessible
                          accessibilityLabel={`Compte ${row.account}, solde ${formatEUR(row.balanceCents)}`}
                          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 5 }}
                        >
                          {/* Colonnes en flexBasis+minWidth (Lot 5) : en Dynamic Type XXL le
                              contenu POUSSE la colonne au lieu d'être tronqué par un width figé. */}
                          <Text style={[font('sub'), { color: colors.ink800, flexBasis: 60, minWidth: 60, fontVariant: ['tabular-nums'] }]}>
                            {row.account}
                          </Text>
                          <Text style={{ ...font('meta'), color: colors.slate400, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                            D {formatEUR(row.debitCents)}
                          </Text>
                          <Text style={{ ...font('meta'), color: colors.slate400, flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                            C {formatEUR(row.creditCents)}
                          </Text>
                          <Text
                            style={{
                              ...font('sub', 700),
                              color: row.balanceCents >= 0 ? colors.ink900 : colors.slate500,
                              flexBasis: 92,
                              minWidth: 92,
                              textAlign: 'right',
                              fontVariant: ['tabular-nums'],
                            }}
                          >
                            {formatEUR(row.balanceCents)}
                          </Text>
                        </View>
                      ))}
                      <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 8 }} />
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={[font('meta'), { color: colors.slate400 }]}>{t('cloture.totauxLabel', { personality })}</Text>
                        <Text style={{ ...font('meta'), color: colors.slate500, fontVariant: ['tabular-nums'] }}>
                          {t('cloture.totaux', {
                            personality,
                            params: { debit: formatEUR(balance.totalDebitCents), credit: formatEUR(balance.totalCreditCents) },
                          })}
                        </Text>
                      </View>
                    </Card>,
                  )}

                  {/* Compte de résultat (cascade CDR-1) */}
                  {section(
                    'cloture.sectionResult',
                    <Card>
                      <AmountRow label={t('cloture.prodExpl', { personality })} cents={income.exploitationProduitsCents} />
                      <AmountRow label={t('cloture.chargesExpl', { personality })} cents={-income.exploitationChargesCents} />
                      <AmountRow label={t('cloture.resExpl', { personality })} cents={income.resultatExploitationCents} strong topBorder />
                      {income.financierProduitsCents !== 0 || income.financierChargesCents !== 0 ? (
                        <AmountRow label={t('cloture.resFin', { personality })} cents={income.resultatFinancierCents} strong topBorder />
                      ) : null}
                      {income.resultatExceptionnelCents !== 0 ? (
                        <AmountRow label={t('cloture.resExc', { personality })} cents={income.resultatExceptionnelCents} strong topBorder />
                      ) : null}
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: 8,
                          paddingTop: 10,
                          borderTopWidth: 2,
                          borderTopColor: income.resultatNetCents >= 0 ? semantic.success : semantic.warning,
                        }}
                      >
                        <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{t('cloture.resNet', { personality })}</Text>
                        <Text
                          style={{
                            ...font('bigNum'),
                            fontSize: 21,
                            color: income.resultatNetCents >= 0 ? semantic.success : semantic.warning,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {income.resultatNetCents >= 0 ? '+' : '−'}
                          {formatEUR(Math.abs(income.resultatNetCents))}
                        </Text>
                      </View>
                      {income.impotBeneficesCents !== 0 ? (
                        <Text style={[font('meta'), { color: colors.slate400, marginTop: 6 }]}>
                          {t('cloture.apresImpot', { personality, params: { amount: formatEUR(income.impotBeneficesCents) } })}
                        </Text>
                      ) : null}
                    </Card>,
                  )}

                  {/* Bilan (BILAN-1) */}
                  {section(
                    'cloture.sectionBilan',
                    <Card>
                      <View style={{ flexDirection: 'row', gap: 14 }}>
                        {(
                          [
                            {
                              titre: t('cloture.actif', { personality }),
                              total: bilan.actif.totalCents,
                              postes: [
                                { label: t('cloture.immo', { personality }), cents: bilan.actif.immobilisationsNettesCents },
                                { label: t('cloture.stocks', { personality }), cents: bilan.actif.stocksCents },
                                { label: t('cloture.creances', { personality }), cents: bilan.actif.creancesCents },
                                { label: t('cloture.dispo', { personality }), cents: bilan.actif.disponibilitesCents },
                              ],
                            },
                            {
                              titre: t('cloture.passif', { personality }),
                              total: bilan.passif.totalCents,
                              postes: [
                                { label: t('cloture.capitaux', { personality }), cents: bilan.passif.capitauxPropresCents },
                                { label: t('cloture.resultat', { personality }), cents: bilan.passif.resultatNetCents },
                                { label: t('cloture.provisions', { personality }), cents: bilan.passif.provisionsCents },
                                { label: t('cloture.emprunts', { personality }), cents: bilan.passif.empruntsCents },
                                { label: t('cloture.dettes', { personality }), cents: bilan.passif.dettesCents },
                                { label: t('cloture.decouvert', { personality }), cents: bilan.passif.decouvertCents },
                              ],
                            },
                          ] as { titre: string; total: number; postes: { label: string; cents: number }[] }[]
                        ).map((col) => (
                          <View key={col.titre} style={{ flex: 1 }}>
                            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>{col.titre}</Text>
                            {col.postes
                              .filter((p) => p.cents !== 0)
                              .map((p) => (
                                <View
                                  key={p.label}
                                  style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 6 }}
                                >
                                  <Text style={[font('meta'), { color: colors.slate500, flexShrink: 1 }]} numberOfLines={1}>
                                    {p.label}
                                  </Text>
                                  <Text style={{ ...font('meta'), color: p.cents >= 0 ? colors.ink800 : semantic.warning, fontVariant: ['tabular-nums'] }}>
                                    {formatEUR(p.cents)}
                                  </Text>
                                </View>
                              ))}
                            <View
                              style={{
                                flexDirection: 'row',
                                justifyContent: 'space-between',
                                marginTop: 6,
                                paddingTop: 6,
                                borderTopWidth: 1,
                                borderTopColor: colors.lineSoft,
                              }}
                            >
                              <Text style={{ ...font('sub', 700), color: colors.ink900 }}>{t('cloture.total', { personality })}</Text>
                              <Text style={{ ...font('sub', 700), color: colors.ink900, fontVariant: ['tabular-nums'] }}>
                                {formatEUR(col.total)}
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                        <Feather
                          name={bilan.balanced ? 'check-circle' : 'alert-circle'}
                          size={16}
                          color={bilan.balanced ? semantic.success : semantic.warning}
                        />
                        <Text style={[font('meta'), { color: bilan.balanced ? semantic.success : semantic.warning, flex: 1 }]}>
                          {bilan.balanced
                            ? t('cloture.bilanBalanced', { personality })
                            : t('cloture.bilanEcart', { personality, params: { amount: formatEUR(Math.abs(bilan.ecartCents)) } })}
                        </Text>
                      </View>
                    </Card>,
                  )}
                </>
              ) : (
                // P1 (audit 14/07) : onboarding sans écriture — les états de synthèse et le
                // CTA « Envoyer au comptable » ne disparaissent plus en silence, un EmptyState
                // explique pourquoi (même vide honnête que le grand-livre, cloture/compta.empty).
                section(
                  'cloture.sectionBalance',
                  <Card>
                    <EmptyState body={t('compta.empty', { personality })} />
                  </Card>,
                )
              )}

              {/* Envoyer au comptable — dossier (primaire) + FEC (secondaire) */}
              {section(
                'cloture.sectionExport',
                <>
                  {/* Les 2 CTA au langage kit (Lot 5) : Button avec slot icône, parité
                      STRICTE disabled/loading (sendingDossier, exportFec.isPending) —
                      le spinner remplace l'icône, busy annoncé, libellé d'action stable. */}
                  {balance.rows.length > 0 ? (
                    <Button
                      title={t(sendingDossier ? 'cloture.sendingDossier' : 'cloture.sendDossier', { personality })}
                      accessibilityLabel={t('cloture.sendDossier', { personality })}
                      onPress={() => void onSendDossier()}
                      disabled={sendingDossier}
                      loading={sendingDossier}
                      icon={<SendIcon color={colors.surface} size={17} />}
                      radius={14}
                    />
                  ) : null}
                  <View style={{ height: balance.rows.length > 0 ? 10 : 0 }} />
                  <Button
                    title={t(exportFec.isPending ? 'cloture.exportingFec' : 'cloture.exportFec', { personality })}
                    accessibilityLabel={t('cloture.exportFec', { personality })}
                    variant="secondary"
                    onPress={() => void onExportFec()}
                    disabled={exportFec.isPending}
                    loading={exportFec.isPending}
                    icon={<FileIcon color={colors.ink600} size={16} />}
                    radius={14}
                  />
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 8, textAlign: 'center', lineHeight: 16 }]}>
                    {t('cloture.exportHelper', { personality })}
                  </Text>
                </>,
              )}

              {/* Accès au grand-livre complet */}
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('compta.title', { personality })}
                onPress={() => router.push('/comptabilite')}
              >
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                    <IconTile tone="b2b" size={34} radius={10}>
                      <ChartIcon color={semantic.b2b} />
                    </IconTile>
                    <Text style={{ ...font('cardTitle'), color: colors.ink800, flex: 1 }}>{t('compta.title', { personality })}</Text>
                    <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                  </View>
                </Card>
              </PressableScale>
            </StaggeredList>
          )}
        </View>
      </ScrollView>

      {/* Avertissements FEC — Sheet LISTÉE (matière Bob) : chaque avertissement sur sa
          rangée, plus un bloc Alert système illisible. */}
      <Sheet
        visible={fecWarnings !== null}
        onClose={() => setFecWarnings(null)}
        accessibilityLabel={t('cloture.fecWarningsTitle', { personality })}
        closeAccessibilityLabel={t('common.close', { personality })}
      >
        <Text
          accessibilityRole="header"
          style={[font('sheetTitle'), { color: colors.ink900, marginBottom: 10 }]}
        >
          {t('cloture.fecWarningsTitle', { personality })}
        </Text>
        {(fecWarnings ?? []).map((warning, index) => (
          <View
            key={index}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 8,
              paddingVertical: 7,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: colors.lineSoft,
            }}
          >
            <Feather name="alert-triangle" size={14} color={semantic.warning} style={{ marginTop: 2 }} />
            <Text style={[font('sub'), { color: colors.ink800, flex: 1, lineHeight: 19 }]}>{warning}</Text>
          </View>
        ))}
        <View style={{ marginTop: 12, marginBottom: 8 }}>
          {/* i18n common.close (verdict Lot 5, P3) — le geste EST la fermeture : plus de
              « OK » hors catalogue sur une surface neuve. */}
          <Button title={t('common.close', { personality })} onPress={() => setFecWarnings(null)} />
        </View>
      </Sheet>

      {errorSheet.errorSheet}

      {/* Succès uniquement (les échecs vivent en ErrorSheet) — coche du tone kit. */}
      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        tone="success"
      />
    </View>
  );
}
