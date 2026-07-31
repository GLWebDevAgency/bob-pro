/**
 * Réglages facturation — « Facturation & modèles » (claim C27 initial + fusion proto, réf
 * design_handoff_bob_pro/Bob Pro.dc.html §showBilling — retours device fondateur). Ordre de
 * l'écran = ordre du proto : Aperçu → Identité → RIB → TVA & mentions → Assurance →
 * Numérotation → Valeurs par défaut → Mon catalogue.
 *
 * HONNÊTETÉ AVANT PIXEL — toutes les valeurs interactives de cet écran ont une autorité serveur :
 *  · Identité (raison sociale/SIRET/RM/adresse), numérotation (dernier n° réel), TVA (régime
 *    RÉEL, PATCH /company/profile déjà existant) → données/actions SERVEUR réelles.
 *  · RIB (iban/bic) → PATCH /company/billing, AJOUTÉ avec ce chantier (ces champs existaient sur
 *    CompanyProps depuis C24b mais n'avaient jamais d'endpoint d'écriture après l'onboarding).
 *  · toggles RIB/assurance + couleur PDF → CompanyBillingSettings PostgreSQL et renderer PDF ;
 *  · validité/acompte → même source PostgreSQL, appliquée au démarrage d'un nouveau devis.
 *  · conditions de paiement → PostgreSQL puis IssueInvoice ; aucune facture ne peut être émise
 *    avant un choix explicite. Le logo reste masqué tant que son stockage objet n'existe pas.
 *  · Numérotation : le proto affiche un « format éditable » + « prochain numéro » — non repris :
 *    la numérotation est allouée atomiquement par le serveur (SequenceCounterPort), l'éditer
 *    côté client sans effet réel serait un contrôle décoratif (contraire à la doctrine du
 *    fichier) ; seul le DERNIER numéro réellement émis est affiché, décision déjà actée avant ce
 *    chantier et conservée ici.
 */
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { shadowNative, themes } from '@bob/tokens';
import { t } from '@bob/i18n';
import {
  Card,
  Chip,
  ErrorRetry,
  SectionHeader,
  SegmentedControl,
  SkeletonCard,
  font,
  useTheme,
} from '@bob/ui';
import {
  Company,
  formatSiret,
  tradeProfile,
  type CompanyRelancePolicy,
  type InvoicePdfAccentColor,
} from '@bob/core';
import type { InvoiceView } from '@bob/api-client';
import { useCompanyMe, useInvoices, useUpdateCompanyProfile } from '../src/data/hooks';
import { useBillingPrefs } from '../src/data/billing-prefs';
import { companyCanIssue } from '../src/data/company-completeness';
import { ChevronRightIcon, FileTextIcon } from '../src/components/icons';
import { ScreenHeader } from '../src/components/screen-header';
import { PressableRow } from '../src/components/pressable-row';
import { SettingsToggle } from '../src/components/settings-toggle';
import { IbanEditSheet } from '../src/components/billing/iban-edit-sheet';
import { LegalIdentityEditSheet } from '../src/components/billing/legal-identity-edit-sheet';
import { formatCapitalSocialEuros } from '../src/components/billing/legal-identity-edit.logic';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';

/** Ligne du bloc §Identité — `missing` colore la valeur en alerte, `editable` ouvre la feuille
 *  d'identité légale (LegalIdentityEditSheet, seule porte d'écriture de ces champs). */
interface IdentityRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tabular?: boolean;
  readonly missing?: boolean;
  readonly editable?: boolean;
}

/** Dernière facture ÉMISE (numéro légal posé) — max lexicographique des F-AAAA-nnn (année en tête). */
function lastIssuedInvoice(invoices: readonly InvoiceView[]): InvoiceView | null {
  const issued = invoices.filter((i) => i.number !== null);
  if (issued.length === 0) return null;
  return issued.reduce((best, i) => ((i.number ?? '') > (best.number ?? '') ? i : best));
}

/** Pastille « Bientôt » (aucun endpoint) — pas un contrôle, un état assumé. */
function SoonPill() {
  const { controls, colors, personality } = useTheme();
  return (
    <View
      style={{
        backgroundColor: controls.segmentedTrack,
        borderRadius: 8,
        paddingHorizontal: 9,
        paddingVertical: 4,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={[font('label', 700), { fontSize: 11, color: colors.slate500 }]}>
        {t('reglages.soonBadge', { personality }).toUpperCase()}
      </Text>
    </View>
  );
}

const VALIDITY_PRESETS: readonly number[] = [15, 30, 45, 60];
const DEPOSIT_PRESETS: readonly number[] = [0, 10, 20, 30, 40, 50];
const PAYMENT_TERMS_PRESETS: readonly number[] = [15, 30, 45, 60];
const ACCENT_ORDER: readonly InvoicePdfAccentColor[] = ['navy', 'green', 'purple', 'orange'];
/** PR-06 — cadences PROPOSÉES (choix produit : presets cohérents plutôt que 4 champs libres —
 * l'ordre strict est garanti par construction ; l'API accepte toute cadence valide).
 * « Patiente » = le rythme Fly Services (J+15/J+30/J+45, MED proposée à J+60). */
const RELANCE_CADENCE_PRESETS: readonly {
  key: string;
  labelKey: 'reglages.relanceCadenceDefault' | 'reglages.relanceCadenceSouple' | 'reglages.relanceCadencePatiente';
  policy: CompanyRelancePolicy | null;
}[] = [
  { key: 'default', labelKey: 'reglages.relanceCadenceDefault', policy: null },
  {
    key: 'souple',
    labelKey: 'reglages.relanceCadenceSouple',
    policy: { cordialAfterDays: 7, neutreAfterDays: 15, fermeAfterDays: 25, miseEnDemeureAfterDays: 40 },
  },
  {
    key: 'patiente',
    labelKey: 'reglages.relanceCadencePatiente',
    policy: { cordialAfterDays: 15, neutreAfterDays: 30, fermeAfterDays: 45, miseEnDemeureAfterDays: 60 },
  },
];

export default function ReglagesFacturation() {
  const { colors, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const company = useCompanyMe();
  const invoices = useInvoices();
  const updateProfile = useUpdateCompanyProfile();
  const billingPrefs = useBillingPrefs();
  const [ibanSheetOpen, setIbanSheetOpen] = useState(false);
  const [legalSheetOpen, setLegalSheetOpen] = useState(false);

  const lastInvoice = useMemo(() => lastIssuedInvoice(invoices.data ?? []), [invoices.data]);
  const loading = company.isLoading || invoices.isLoading || billingPrefs.isLoading;
  const failed = company.isError || invoices.isError || billingPrefs.isError;
  const data = company.data ?? null;
  const prefs = billingPrefs.prefs;

  // Company.of() revalide SIREN/SIRET (déjà valides en base) — uniquement pour réutiliser
  // isBtp()/isSociete() SANS dupliquer BTP_TRADES ni CAPITAL_LEGAL_FORMS ici (source unique :
  // packages/core/src/domain/company/company.ts).
  const companyEntity = useMemo(() => (data ? Company.of(data) : null), [data]);
  const isBtp = companyEntity?.ok ? companyEntity.value.isBtp() : null;
  // Société à capital (EURL/SASU/SARL/SAS) : pilote la ligne « Capital social » — une EI n'a
  // pas de capital, la ligne serait un mensonge d'interface (art. R123-238).
  const isSociete = companyEntity?.ok === true && companyEntity.value.isSociete();
  // Hors franchise, assertCanIssue exige un n° de TVA réellement attribué.
  const tvaRequired = data !== null && data.vatRegime !== 'franchise';
  // MÊME prédicat que le gate d'émission (DocumentActions → companyIncompleteGateSpec) : cet
  // écran est désormais la DESTINATION de ce gate, il doit donc dire exactement la même vérité.
  const canIssue = companyCanIssue(data);

  // Swatches FIXES (indépendants du thème d'app actif — themes.* est une palette statique,
  // pas useTheme().theme qui suit le thème choisi par l'utilisateur) : la couleur d'accent du
  // PDF est un choix de MARQUE sur le document, pas une préférence d'affichage de l'app.
  const accentSwatchColor: Record<InvoicePdfAccentColor, string> = {
    navy: themes.marine.d1,
    green: semantic.success,
    purple: semantic.b2g,
    orange: semantic.warning,
  };
  const accentColor = prefs ? accentSwatchColor[prefs.pdfAccentColor] : null;

  const setVatRegime = (segment: 'reel' | 'franchise'): void => {
    if (!data || updateProfile.isPending) return;
    updateProfile.mutate(
      { trade: data.trade, vatRegime: segment === 'franchise' ? 'franchise' : 'reel_normal' },
      { onError: () => Alert.alert(t('reglages.dataError', { personality })) },
    );
  };
  const vatSegment: 'reel' | 'franchise' = data?.vatRegime === 'franchise' ? 'franchise' : 'reel';

  const previewNumber = lastInvoice?.number ?? '—';
  const previewTvaMention =
    data?.vatRegime === 'franchise'
      ? t('reglages.vatFranchiseValue', { personality })
      : t('reglages.vatPerDocumentValue', { personality });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader
        backLabel={t('reglages.back', { personality })}
        onBack={() => router.back()}
        eyebrow={t('reglages.eyebrow', { personality })}
        title={t('reglages.title', { personality })}
        subtitle={t('reglages.subtitle', { personality })}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingTop: 14,
          paddingBottom: bobScrollInsets.paddingBottom,
        }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={{ gap: 14 }}>
            <SkeletonCard height={110} contentLines={2} />
            <SkeletonCard height={70} contentLines={2} />
            <SkeletonCard height={140} contentLines={4} />
            <SkeletonCard height={110} contentLines={3} />
            <SkeletonCard height={150} contentLines={4} />
            <SkeletonCard height={120} contentLines={3} />
            <SkeletonCard height={210} contentLines={3} />
          </View>
        ) : failed || !data || !prefs || isBtp === null || accentColor === null ? (
          <ErrorRetry
            message={t('reglages.dataError', { personality })}
            onRetry={() => {
              void company.refetch();
              void invoices.refetch();
              void billingPrefs.refetch();
            }}
            retrying={company.isRefetching || invoices.isRefetching}
          />
        ) : (
          <>
            {/* Aperçu du même accent et des mêmes options que le renderer PDF serveur. */}
            <View
              style={{
                borderRadius: 18,
                overflow: 'hidden',
                backgroundColor: colors.surface,
                ...shadowNative.e2,
              }}
            >
              <View style={{ height: 7, backgroundColor: accentColor }} />
              <View style={{ padding: 16 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                  }}
                >
                  <View
                    style={{ flexDirection: 'row', gap: 11, alignItems: 'center', flexShrink: 1 }}
                  >
                    <View
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 11,
                        backgroundColor: accentColor,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={[font('cardTitle'), { fontSize: 15, color: colors.surface }]}>
                        {data.name
                          .split(/\s+/)
                          .filter(Boolean)
                          .slice(0, 2)
                          .map((w) => w[0]?.toUpperCase() ?? '')
                          .join('')}
                      </Text>
                    </View>
                    <View style={{ flexShrink: 1 }}>
                      <Text
                        numberOfLines={1}
                        style={[font('sub', 700), { fontSize: 14.5, color: colors.ink900 }]}
                      >
                        {data.name}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate400 }]}>
                        {tradeProfile(data.trade).label}
                      </Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text
                      style={[
                        font('label', 800),
                        { fontSize: 15, color: accentColor, letterSpacing: 0.5 },
                      ]}
                    >
                      {t('reglages.previewInvoiceLabel', { personality })}
                    </Text>
                    <Text
                      style={[
                        font('meta'),
                        { color: colors.slate400, fontVariant: ['tabular-nums'] },
                      ]}
                    >
                      {previewNumber}
                    </Text>
                  </View>
                </View>
                <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 13 }} />
                <Text style={[font('meta'), { color: colors.slate300, lineHeight: 17 }]}>
                  {`SIRET ${formatSiret(data.siret)}${data.rcsOrRm ? ` · ${data.rcsOrRm}` : ''} · ${previewTvaMention}`}
                </Text>
                {prefs.showRibOnInvoices && data.iban ? (
                  <Text
                    style={[font('meta'), { color: colors.slate300, lineHeight: 17, marginTop: 4 }]}
                  >
                    {`${t('reglages.ribIbanLabel', { personality })} ${maskedIban(data.iban)}${
                      data.bic ? ` · BIC ${data.bic}` : ''
                    }`}
                  </Text>
                ) : null}
                {prefs.showInsuranceOnInvoices && data.decennale ? (
                  <Text
                    style={[font('meta'), { color: colors.slate300, lineHeight: 17, marginTop: 4 }]}
                  >
                    {`${t(
                      isBtp ? 'reglages.insuranceDecennaleLabel' : 'reglages.insuranceRcProLabel',
                      { personality },
                    )} ${data.decennale.insurer} · n°${data.decennale.policyNo}`}
                  </Text>
                ) : null}
              </View>
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                marginTop: 8,
                marginBottom: 6,
              }}
            >
              <Feather name="eye" size={13} color={colors.slate400} />
              <Text style={[font('label', 600), { fontSize: 11.5, color: colors.slate400 }]}>
                {t('reglages.previewLive', { personality })}
              </Text>
            </View>

            {/* ── Identité sur les factures — n° RCS/RM, capital social (société), TVA et
                adresse ÉDITABLES (PATCH /company/legal) : les QUATRE exigences de
                Company.assertCanIssue(). Sans elles l'émission est bloquée, et sans CET écran
                le gate était un cul-de-sac (RCS/adresse 20/07, capital 30/07 FLY SERVICES). ── */}
            <SectionHeader title={t('reglages.sectionIdentity', { personality })} />
            {/* Bandeau d'alerte UNIQUEMENT quand l'émission est réellement bloquée — même
                prédicat que le gate (companyCanIssue), jamais une alarme décorative. */}
            {!canIssue ? (
              <View
                accessible
                accessibilityRole="alert"
                style={{
                  backgroundColor: semantic.warningBg,
                  borderRadius: 14,
                  padding: 13,
                  marginBottom: 10,
                  gap: 6,
                }}
              >
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <Feather name="alert-triangle" size={14} color={semantic.warning} />
                  <Text style={[font('sub', 700), { fontSize: 13.5, color: semantic.warning }]}>
                    {t('reglages.identityBlockingTitle', { personality })}
                  </Text>
                </View>
                <Text style={[font('meta'), { color: colors.slate500, lineHeight: 17 }]}>
                  {t('reglages.identityBlockingBody', { personality })}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('reglages.identityFixCta', { personality })}
                  onPress={() => setLegalSheetOpen(true)}
                  style={({ pressed }) => ({
                    minHeight: 44,
                    justifyContent: 'center',
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={[font('label', 700), { fontSize: 13.5, color: semantic.warning }]}>
                    {t('reglages.identityFixCta', { personality })}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            <Card padding={4} style={{ paddingHorizontal: 15, marginBottom: 18 }}>
              {(
                [
                  {
                    key: 'name',
                    label: t('reglages.identityName', { personality }),
                    value: data.name,
                  },
                  {
                    key: 'siret',
                    label: t('reglages.identitySiret', { personality }),
                    value: formatSiret(data.siret),
                    tabular: true,
                  },
                  {
                    key: 'rm',
                    label: t('reglages.identityRm', { personality }),
                    value: data.rcsOrRm ?? t('reglages.identityEmpty', { personality }),
                    missing: !data.rcsOrRm,
                    editable: true,
                  },
                  // Capital social — SOCIÉTÉS uniquement : le champ dont l'invisibilité a
                  // bloqué FLY SERVICES (exigé par assertCanIssue, éditable nulle part).
                  ...(isSociete
                    ? [
                        {
                          key: 'capital',
                          label: t('reglages.identityCapital', { personality }),
                          value:
                            data.capitalSocialCents === undefined
                              ? t('reglages.identityEmpty', { personality })
                              : formatCapitalSocialEuros(data.capitalSocialCents),
                          missing: data.capitalSocialCents === undefined,
                          editable: true,
                        },
                      ]
                    : []),
                  // N° TVA — « À compléter » SEULEMENT quand assertCanIssue l'exige (régime
                  // réel) ; en franchise sans numéro attribué : « — », rien à faire.
                  {
                    key: 'tva',
                    label: t('reglages.identityTva', { personality }),
                    value:
                      data.tvaIntracom ??
                      (tvaRequired ? t('reglages.identityEmpty', { personality }) : '—'),
                    missing: tvaRequired && !data.tvaIntracom,
                    editable: true,
                  },
                  {
                    key: 'address',
                    label: t('reglages.identityAddress', { personality }),
                    value:
                      data.address.line1 && data.address.city
                        ? `${data.address.line1}, ${data.address.zip} ${data.address.city}`
                        : t('reglages.identityEmpty', { personality }),
                    // Le domaine exige l'adresse COMPLÈTE (rue + CP + ville) — le CP fait
                    // partie du « manquant », sinon la ligne dirait « tout va bien » à tort.
                    missing: !data.address.line1 || !data.address.zip || !data.address.city,
                    editable: true,
                  },
                ] as readonly IdentityRow[]
              ).map((row, index, rows) => {
                const missing = row.missing === true;
                const separator = {
                  borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                  borderBottomColor: colors.lineSoft,
                };
                const label = (
                  <Text style={[font('sub'), { color: colors.slate400 }]}>{row.label}</Text>
                );
                const value = (
                  <Text
                    numberOfLines={2}
                    style={[
                      font('sub', 700),
                      {
                        fontSize: 14,
                        color: missing ? semantic.warning : colors.ink800,
                        flexShrink: 1,
                        textAlign: 'right',
                      },
                      row.tabular === true ? { fontVariant: ['tabular-nums'] } : null,
                    ]}
                  >
                    {row.value}
                  </Text>
                );
                // Raison sociale et SIRET restent en lecture (identité posée à l'inscription,
                // elle engage les pièces déjà émises) — RCS/RM, capital, TVA et adresse
                // s'éditent ici via la feuille d'identité légale.
                if (row.editable !== true) {
                  return (
                    <View
                      key={row.key}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                        paddingVertical: 12,
                        ...separator,
                      }}
                    >
                      {label}
                      {value}
                    </View>
                  );
                }
                return (
                  <Pressable
                    key={row.key}
                    accessibilityRole="button"
                    accessibilityLabel={`${row.label}. ${row.value}`}
                    onPress={() => setLegalSheetOpen(true)}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      minHeight: 44,
                      paddingVertical: 12,
                      ...separator,
                    }}
                  >
                    {label}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 7,
                        flexShrink: 1,
                      }}
                    >
                      {value}
                      <ChevronRightIcon color={colors.slate300} size={15} />
                    </View>
                  </Pressable>
                );
              })}
            </Card>
            <Text
              style={[
                font('meta'),
                { color: colors.slate300, marginTop: -10, marginBottom: 18, lineHeight: 16 },
              ]}
            >
              {t('reglages.identityNotEditableNote', { personality })}
            </Text>

            {/* ── Coordonnées bancaires (RIB) — seul champ d'identité RÉELLEMENT éditable ici ── */}
            <SectionHeader title={t('reglages.sectionRib', { personality })} />
            <Card padding={4} style={{ paddingHorizontal: 15, marginBottom: 18 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t('reglages.ribIbanLabel', { personality })}. ${
                  data.iban ? data.iban : t('reglages.ribIbanEmpty', { personality })
                }`}
                onPress={() => setIbanSheetOpen(true)}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 44,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.lineSoft,
                }}
              >
                <Text style={[font('sub'), { color: colors.slate400 }]}>
                  {t('reglages.ribIbanLabel', { personality })}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <Text
                    style={[
                      font('sub', 700),
                      {
                        fontSize: 13.5,
                        color: data.iban ? colors.ink800 : colors.slate400,
                        fontVariant: ['tabular-nums'],
                      },
                    ]}
                  >
                    {data.iban
                      ? maskedIban(data.iban)
                      : t('reglages.ribIbanEmpty', { personality })}
                  </Text>
                  <ChevronRightIcon color={colors.slate300} size={15} />
                </View>
              </Pressable>
              <SettingsToggle
                value={prefs.showRibOnInvoices}
                onChange={(next) => billingPrefs.update({ showRibOnInvoices: next })}
                disabled={billingPrefs.isPending || !data.iban}
                title={t('reglages.ribToggleLabel', { personality })}
                subtitle={t('reglages.ribToggleSub', { personality })}
              />
            </Card>
            <Text
              style={[
                font('meta'),
                { color: colors.slate300, marginTop: -10, marginBottom: 18, lineHeight: 16 },
              ]}
            >
              {t('reglages.ribOnPdfNote', { personality })}
            </Text>

            {/* ── TVA & mentions légales — régime RÉEL, branché sur l'endpoint existant ── */}
            <SectionHeader title={t('reglages.sectionVat', { personality })} />
            <Card style={{ marginBottom: 10 }}>
              <SegmentedControl<'reel' | 'franchise'>
                options={[
                  { key: 'reel', label: t('reglages.vatSegmentReel', { personality }) },
                  { key: 'franchise', label: t('reglages.vatSegmentFranchise', { personality }) },
                ]}
                value={vatSegment}
                onChange={setVatRegime}
                accessibilityLabel={t('reglages.sectionVat', { personality })}
              />
              <View
                style={{
                  flexDirection: 'row',
                  gap: 8,
                  alignItems: 'flex-start',
                  backgroundColor: semantic.successBg,
                  borderRadius: 11,
                  padding: 12,
                  marginTop: 12,
                }}
              >
                <Feather
                  name="check-circle"
                  size={14}
                  color={semantic.success}
                  style={{ marginTop: 2 }}
                />
                <Text
                  style={[
                    font('meta'),
                    { fontSize: 12.5, color: semantic.success, lineHeight: 18, flex: 1 },
                  ]}
                >
                  {t(
                    vatSegment === 'franchise'
                      ? 'reglages.vatRegimeHelpFranchise'
                      : 'reglages.vatRegimeHelpReel',
                    { personality },
                  )}
                </Text>
              </View>
            </Card>
            <Card style={{ marginBottom: 18 }}>
              <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
                {t('reglages.mentionsPreviewTitle', { personality }).toUpperCase()}
              </Text>
              {lastInvoice !== null && lastInvoice.mentions.length > 0 ? (
                <View style={{ marginTop: 8, gap: 6 }}>
                  {lastInvoice.number !== null ? (
                    <Text style={[font('meta', 600), { fontSize: 12.5, color: colors.ink800 }]}>
                      {lastInvoice.number}
                    </Text>
                  ) : null}
                  {lastInvoice.mentions.map((mention, i) => (
                    <View
                      key={`${i}-${mention.slice(0, 16)}`}
                      style={{ flexDirection: 'row', gap: 8 }}
                    >
                      <Text style={[font('meta'), { color: colors.slate400 }]}>•</Text>
                      <Text
                        style={[
                          font('meta'),
                          { fontSize: 12.5, color: colors.slate500, lineHeight: 19, flex: 1 },
                        ]}
                      >
                        {mention}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text
                  style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 8 }]}
                >
                  {t('reglages.mentionsEmpty', { personality })}
                </Text>
              )}
            </Card>

            {/* ── Assurance — adaptatif métier (décennale BTP / RC Pro hors bâtiment) ── */}
            <SectionHeader
              title={t(isBtp ? 'reglages.sectionInsuranceBtp' : 'reglages.sectionInsuranceOther', {
                personality,
              })}
            />
            <Card padding={4} style={{ paddingHorizontal: 15, marginBottom: 18 }}>
              {data.decennale ? (
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  <Text style={[font('sub'), { color: colors.slate400 }]}>
                    {t(
                      isBtp ? 'reglages.insuranceDecennaleLabel' : 'reglages.insuranceRcProLabel',
                      { personality },
                    )}
                  </Text>
                  <Text style={[font('sub', 700), { fontSize: 14, color: colors.ink800 }]}>
                    {`${data.decennale.insurer} · n°${data.decennale.policyNo}`}
                  </Text>
                </View>
              ) : (
                <View
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.lineSoft,
                    gap: 8,
                  }}
                >
                  <SoonPill />
                  <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                    {t(isBtp ? 'reglages.insuranceEmptyBtp' : 'reglages.insuranceEmptyOther', {
                      personality,
                    })}
                  </Text>
                </View>
              )}
              <SettingsToggle
                value={prefs.showInsuranceOnInvoices}
                onChange={(next) => billingPrefs.update({ showInsuranceOnInvoices: next })}
                disabled={billingPrefs.isPending || !data.decennale}
                title={t(
                  isBtp ? 'reglages.insuranceToggleLabelBtp' : 'reglages.insuranceToggleLabelOther',
                  { personality },
                )}
                subtitle={t(
                  isBtp ? 'reglages.insuranceToggleSubBtp' : 'reglages.insuranceToggleSubOther',
                  { personality },
                )}
              />
            </Card>
            <Text
              style={[
                font('meta'),
                { color: colors.slate300, marginTop: -10, marginBottom: 18, lineHeight: 16 },
              ]}
            >
              {t('reglages.insuranceOnPdfNote', { personality })}
            </Text>

            {/* ── Numérotation — garantie core sans trou, dernier numéro RÉEL ── */}
            <SectionHeader title={t('reglages.sectionNumbering', { personality })} />
            <Card style={{ marginBottom: 18 }}>
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20 }]}>
                {t('reglages.numberingBody', { personality })}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 12,
                  paddingTop: 12,
                  borderTopWidth: 1,
                  borderTopColor: colors.lineSoft,
                }}
              >
                <Text style={[font('sub'), { color: colors.slate500 }]}>
                  {t('reglages.lastNumber', { personality })}
                </Text>
                <Text
                  style={[
                    font('label', 700),
                    { fontSize: 14.5, color: colors.ink900, fontVariant: ['tabular-nums'] },
                  ]}
                >
                  {lastInvoice?.number ?? t('reglages.noNumberYet', { personality })}
                </Text>
              </View>
            </Card>

            {/* ── Valeurs par défaut PostgreSQL — validité et acompte appliqués au prochain
                nouveau devis ; couleur appliquée aux prochaines pièces émises. ── */}
            <SectionHeader title={t('reglages.sectionDefaults', { personality })} />
            <Card style={{ marginBottom: 8 }}>
              <Text style={[font('sub'), { color: colors.slate500, marginBottom: 9 }]}>
                {t('reglages.defaultsValidityLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {VALIDITY_PRESETS.map((days) => (
                  <Chip
                    key={days}
                    label={t('reglages.defaultsValidityDays', { personality, params: { days } })}
                    active={prefs.defaultQuoteValidityDays === days}
                    onPress={
                      billingPrefs.isPending
                        ? undefined
                        : () => billingPrefs.update({ defaultQuoteValidityDays: days })
                    }
                  />
                ))}
              </View>

              <Text style={[font('sub'), { color: colors.slate500, marginBottom: 9 }]}>
                {t('reglages.defaultsDepositLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {DEPOSIT_PRESETS.map((pct) => (
                  <Chip
                    key={pct}
                    label={
                      pct === 0
                        ? t('devis.depositNone', { personality })
                        : t('devis.depositPct', { personality, params: { pct } })
                    }
                    active={prefs.defaultDepositPercent === pct}
                    onPress={
                      billingPrefs.isPending
                        ? undefined
                        : () => billingPrefs.update({ defaultDepositPercent: pct })
                    }
                  />
                ))}
              </View>

              <Text style={[font('sub'), { color: colors.slate500, marginBottom: 9 }]}>
                {t('reglages.defaultsPaymentTermsLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {PAYMENT_TERMS_PRESETS.map((days) => (
                  <Chip
                    key={days}
                    label={t('reglages.defaultsValidityDays', {
                      personality,
                      params: { days },
                    })}
                    active={prefs.defaultInvoicePaymentTermsDays === days}
                    onPress={
                      billingPrefs.isPending
                        ? undefined
                        : () => billingPrefs.update({ defaultInvoicePaymentTermsDays: days })
                    }
                  />
                ))}
              </View>
              {prefs.defaultInvoicePaymentTermsDays === null ? (
                <Text
                  accessibilityRole="alert"
                  style={[
                    font('meta'),
                    { color: semantic.warning, lineHeight: 17, marginBottom: 16 },
                  ]}
                >
                  {t('reglages.paymentTermsRequired', { personality })}
                </Text>
              ) : (
                <View style={{ marginBottom: 16 }} />
              )}

              <Text style={[font('sub'), { color: colors.slate500, marginBottom: 9 }]}>
                {t('reglages.defaultsAccentLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', gap: 13 }}>
                {ACCENT_ORDER.map((swatch) => (
                  <Pressable
                    key={swatch}
                    accessibilityRole="button"
                    accessibilityState={{ selected: prefs.pdfAccentColor === swatch }}
                    accessibilityLabel={swatch}
                    hitSlop={6}
                    disabled={billingPrefs.isPending}
                    onPress={() => billingPrefs.update({ pdfAccentColor: swatch })}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      backgroundColor: accentSwatchColor[swatch],
                      borderWidth: prefs.pdfAccentColor === swatch ? 3 : 0,
                      borderColor: colors.ink900,
                      opacity: billingPrefs.isPending ? 0.55 : 1,
                    }}
                  />
                ))}
              </View>
            </Card>
            <Text
              style={[font('meta'), { color: colors.slate300, marginBottom: 22, lineHeight: 16 }]}
            >
              {t('reglages.defaultsNote', { personality })}
            </Text>

            {/* ── PR-06 — Relances : cadence paramétrable + interrupteur automatique.
                La MED reste JAMAIS envoyée seule quel que soit le réglage (relance.medWarning). ── */}
            <SectionHeader title={t('reglages.sectionRelances', { personality })} />
            <Card style={{ marginBottom: 8 }}>
              <SettingsToggle
                title={t('reglages.relanceAutoTitle', { personality })}
                subtitle={t('reglages.relanceAutoSubtitle', { personality })}
                value={prefs.relanceAutoEnabled}
                disabled={billingPrefs.isPending}
                onChange={(next) => billingPrefs.update({ relanceAutoEnabled: next })}
              />
              <Text style={[font('sub'), { color: colors.slate500, marginTop: 14, marginBottom: 9 }]}>
                {t('reglages.relanceCadenceLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {RELANCE_CADENCE_PRESETS.map((preset) => {
                  const active =
                    preset.policy === null
                      ? prefs.relancePolicy === null
                      : prefs.relancePolicy !== null &&
                        prefs.relancePolicy.cordialAfterDays === preset.policy.cordialAfterDays &&
                        prefs.relancePolicy.neutreAfterDays === preset.policy.neutreAfterDays &&
                        prefs.relancePolicy.fermeAfterDays === preset.policy.fermeAfterDays &&
                        prefs.relancePolicy.miseEnDemeureAfterDays ===
                          preset.policy.miseEnDemeureAfterDays;
                  return (
                    <Chip
                      key={preset.key}
                      label={t(preset.labelKey, { personality })}
                      active={active}
                      onPress={
                        billingPrefs.isPending
                          ? undefined
                          : () => billingPrefs.update({ relancePolicy: preset.policy })
                      }
                    />
                  );
                })}
              </View>
              <Text style={[font('meta'), { color: colors.slate400, lineHeight: 17 }]}>
                {t('reglages.relanceCadenceCurrent', {
                  personality,
                  params: {
                    cordial: prefs.relancePolicy?.cordialAfterDays ?? 3,
                    neutre: prefs.relancePolicy?.neutreAfterDays ?? 10,
                    ferme: prefs.relancePolicy?.fermeAfterDays ?? 20,
                    med: prefs.relancePolicy?.miseEnDemeureAfterDays ?? 30,
                  },
                })}
              </Text>
            </Card>
            <Text
              style={[font('meta'), { color: colors.slate300, marginBottom: 22, lineHeight: 16 }]}
            >
              {t('reglages.relanceNote', { personality })}
            </Text>

            {/* ── Mon catalogue — les prestations et les prix, EN DESSOUS de tout ── */}
            <PressableRow
              accessibilityLabel={t('reglages.catalogueRow', { personality })}
              onPress={() => router.push('/catalogue')}
              icon={<FileTextIcon color={colors.ink800} size={18} />}
              title={t('reglages.catalogueRow', { personality })}
              subtitle={t('reglages.catalogueRowSub', { personality })}
            />
          </>
        )}
      </ScrollView>

      {data ? (
        <>
          <IbanEditSheet
            visible={ibanSheetOpen}
            currentIban={data.iban ?? null}
            personality={personality}
            onClose={() => setIbanSheetOpen(false)}
          />
          <LegalIdentityEditSheet
            visible={legalSheetOpen}
            company={data}
            personality={personality}
            onClose={() => setLegalSheetOpen(false)}
          />
        </>
      ) : null}
    </View>
  );
}

/** Masque le RIB à l'affichage — même gabarit que le proto (« FR76 3000 … 45 »), sans dépendre
 * d'`Iban.of` (l'IBAN vient déjà validé du serveur ; un format legacy imprévu reste affiché tel
 * quel plutôt que de faire planter l'écran). */
function maskedIban(iban: string): string {
  const compact = iban.replace(/\s/g, '');
  if (compact.length < 8) return compact;
  return `${compact.slice(0, 4)} … ${compact.slice(-4)}`;
}
