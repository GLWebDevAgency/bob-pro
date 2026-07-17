/**
 * Réglages facturation — « Facturation & modèles » (claim C27 initial + fusion proto, réf
 * design_handoff_bob_pro/Bob Pro.dc.html §showBilling — retours device fondateur). Ordre de
 * l'écran = ordre du proto : Aperçu → Logo → Identité → RIB → TVA & mentions → Assurance →
 * Numérotation → Valeurs par défaut → Mon catalogue.
 *
 * HONNÊTETÉ AVANT PIXEL — ce qui a un vrai backend vs ce qui reste une préférence locale :
 *  · Identité (raison sociale/SIRET/RM/adresse), numérotation (dernier n° réel), TVA (régime
 *    RÉEL, PATCH /company/profile déjà existant) → données/actions SERVEUR réelles.
 *  · RIB (iban/bic) → PATCH /company/billing, AJOUTÉ avec ce chantier (ces champs existaient sur
 *    CompanyProps depuis C24b mais n'avaient jamais d'endpoint d'écriture après l'onboarding).
 *  · Logo, toggles d'affichage RIB/assurance, couleur d'accent PDF, validité/acompte/conditions
 *    par défaut → AUCUN champ ni endpoint serveur (vérifié CompanyProps + api.controllers.ts) :
 *    préférences LOCALES sobres (billing-prefs.ts, AsyncStorage scopée par société), jamais un
 *    formulaire fantôme — chaque préférence a un effet réel documenté (aperçu en direct de cet
 *    écran ; la validité des devis est en outre RÉELLEMENT appliquée aux prochains devis créés,
 *    cf. devis/new.tsx). Le branchement du logo/RIB/assurance/couleur dans le PDF SERVEUR généré
 *    (apps/api/src/documents/pdf-renderer.ts, littéraux rgb() figés aujourd'hui) reste un TODO
 *    explicite — hors périmètre mobile de cette passe, documenté dans billing-prefs.ts.
 *  · Numérotation : le proto affiche un « format éditable » + « prochain numéro » — non repris :
 *    la numérotation est allouée atomiquement par le serveur (SequenceCounterPort), l'éditer
 *    côté client sans effet réel serait un contrôle décoratif (contraire à la doctrine du
 *    fichier) ; seul le DERNIER numéro réellement émis est affiché, décision déjà actée avant ce
 *    chantier et conservée ici.
 */
import { useMemo, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { shadowNative, themes } from '@bob/tokens';
import { t } from '@bob/i18n';
import { Card, Chip, ErrorRetry, SectionHeader, SegmentedControl, SkeletonCard, font, useTheme } from '@bob/ui';
import { Company, formatSiret, tradeProfile } from '@bob/core';
import type { InvoiceView } from '@bob/api-client';
import { useCompanyMe, useInvoices, useUpdateCompanyProfile } from '../src/data/hooks';
import { useBillingPrefs, type PaymentTermsPreset, type PdfAccentColor } from '../src/data/billing-prefs';
import { pickLogoFromLibrary, removeLogoFile } from '../src/data/logo-picker';
import { ChevronRightIcon, FileTextIcon } from '../src/components/icons';
import { ScreenHeader } from '../src/components/screen-header';
import { PressableRow } from '../src/components/pressable-row';
import { SettingsToggle } from '../src/components/settings-toggle';
import { IbanEditSheet } from '../src/components/billing/iban-edit-sheet';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';

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
const PAYMENT_TERMS_OPTIONS: readonly PaymentTermsPreset[] = ['reception', 'j30', 'j45'];
const PAYMENT_TERMS_KEY: Record<PaymentTermsPreset, 'reglages.paymentTermsReception' | 'reglages.paymentTermsJ30' | 'reglages.paymentTermsJ45'> = {
  reception: 'reglages.paymentTermsReception',
  j30: 'reglages.paymentTermsJ30',
  j45: 'reglages.paymentTermsJ45',
};
const ACCENT_ORDER: readonly PdfAccentColor[] = ['navy', 'green', 'purple', 'orange'];

export default function ReglagesFacturation() {
  const { colors, controls, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  const company = useCompanyMe();
  const invoices = useInvoices();
  const updateProfile = useUpdateCompanyProfile();
  const billingPrefs = useBillingPrefs();
  const [ibanSheetOpen, setIbanSheetOpen] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const lastInvoice = useMemo(() => lastIssuedInvoice(invoices.data ?? []), [invoices.data]);
  const loading = company.isLoading || invoices.isLoading;
  const failed = company.isError || invoices.isError;
  const data = company.data ?? null;

  // Company.of() revalide SIREN/SIRET (déjà valides en base) — uniquement pour réutiliser
  // isBtp() SANS dupliquer BTP_TRADES ici (source unique : packages/core/src/domain/company/company.ts).
  const companyEntity = useMemo(() => (data ? Company.of(data) : null), [data]);
  const isBtp = companyEntity?.ok ? companyEntity.value.isBtp() : true;

  // Swatches FIXES (indépendants du thème d'app actif — themes.* est une palette statique,
  // pas useTheme().theme qui suit le thème choisi par l'utilisateur) : la couleur d'accent du
  // PDF est un choix de MARQUE sur le document, pas une préférence d'affichage de l'app.
  const accentSwatchColor: Record<PdfAccentColor, string> = {
    navy: themes.marine.d1,
    green: semantic.success,
    purple: semantic.b2g,
    orange: semantic.warning,
  };
  const accentColor = accentSwatchColor[billingPrefs.prefs.pdfAccentColor];

  const handlePickLogo = async (): Promise<void> => {
    if (!data) return;
    setLogoError(null);
    setLogoBusy(true);
    try {
      const result = await pickLogoFromLibrary(data.id);
      if (result.kind === 'picked') {
        const previous = billingPrefs.prefs.logoUri;
        billingPrefs.update({ logoUri: result.uri });
        if (previous) removeLogoFile(previous);
      } else if (result.kind === 'permission_denied') {
        setLogoError(t('reglages.logoPermissionDenied', { personality }));
      } else if (result.kind === 'error') {
        setLogoError(t('reglages.logoError', { personality }));
      }
    } finally {
      setLogoBusy(false);
    }
  };

  const handleRemoveLogo = (): void => {
    const current = billingPrefs.prefs.logoUri;
    billingPrefs.update({ logoUri: null });
    if (current) removeLogoFile(current);
  };

  const setVatRegime = (segment: 'reel' | 'franchise'): void => {
    if (!data || updateProfile.isPending) return;
    updateProfile.mutate(
      { trade: data.trade, vatRegime: segment === 'franchise' ? 'franchise' : 'reel_normal' },
      { onError: () => Alert.alert(t('reglages.dataError', { personality })) },
    );
  };
  const vatSegment: 'reel' | 'franchise' = data?.vatRegime === 'franchise' ? 'franchise' : 'reel';

  const previewNumber = lastInvoice?.number ?? t('reglages.previewNumberPlaceholder', { personality });
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
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: bobScrollInsets.paddingBottom }}
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
        ) : failed || !data ? (
          <ErrorRetry
            message={t('reglages.dataError', { personality })}
            onRetry={() => {
              void company.refetch();
              void invoices.refetch();
            }}
          />
        ) : (
          <>
            {/* ── Aperçu de facture (« Aperçu en direct ») — rendu CLIENT, honnête : reflète les
                réglages de cet écran en temps réel, contrairement au PDF serveur (pas encore
                branché, cf. doctrine en tête de fichier). ── */}
            <View style={{ borderRadius: 18, overflow: 'hidden', backgroundColor: colors.surface, ...shadowNative.e2 }}>
              <View style={{ height: 7, backgroundColor: accentColor }} />
              <View style={{ padding: 16 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flexDirection: 'row', gap: 11, alignItems: 'center', flexShrink: 1 }}>
                    {billingPrefs.prefs.logoUri ? (
                      <Image
                        source={{ uri: billingPrefs.prefs.logoUri }}
                        style={{ width: 42, height: 42, borderRadius: 11 }}
                        accessibilityIgnoresInvertColors
                      />
                    ) : (
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
                    )}
                    <View style={{ flexShrink: 1 }}>
                      <Text numberOfLines={1} style={[font('sub', 700), { fontSize: 14.5, color: colors.ink900 }]}>
                        {data.name}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate400 }]}>
                        {tradeProfile(data.trade).label}
                      </Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[font('label', 800), { fontSize: 15, color: accentColor, letterSpacing: 0.5 }]}>
                      {t('reglages.previewInvoiceLabel', { personality })}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate400, fontVariant: ['tabular-nums'] }]}>
                      {previewNumber}
                    </Text>
                  </View>
                </View>
                <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 13 }} />
                <Text style={[font('meta'), { color: colors.slate300, lineHeight: 17 }]}>
                  {`SIRET ${formatSiret(data.siret)}${data.rcsOrRm ? ` · ${data.rcsOrRm}` : ''} · ${previewTvaMention}`}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 6 }}>
              <Feather name="eye" size={13} color={colors.slate400} />
              <Text style={[font('label', 600), { fontSize: 11.5, color: colors.slate400 }]}>
                {t('reglages.previewLive', { personality })}
              </Text>
            </View>

            {/* ── Logo ── */}
            <SectionHeader title={t('reglages.sectionLogo', { personality })} />
            <Card style={{ marginBottom: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                {billingPrefs.prefs.logoUri ? (
                  <Image
                    source={{ uri: billingPrefs.prefs.logoUri }}
                    style={{ width: 54, height: 54, borderRadius: 14 }}
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View
                    style={{
                      width: 54,
                      height: 54,
                      borderRadius: 14,
                      backgroundColor: accentColor,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Feather name="image" size={20} color={colors.surface} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[font('sub', 600), { fontSize: 14, color: colors.ink800 }]}>
                    {t('reglages.logoTitle', { personality })}
                  </Text>
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 1 }]}>
                    {t('reglages.logoSub', { personality })}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    billingPrefs.prefs.logoUri ? 'reglages.logoChange' : 'reglages.logoAdd',
                    { personality },
                  )}
                  disabled={logoBusy}
                  onPress={() => void handlePickLogo()}
                  style={{
                    backgroundColor: controls.segmentedTrack,
                    borderRadius: 11,
                    paddingVertical: 9,
                    paddingHorizontal: 14,
                    minHeight: 44,
                    justifyContent: 'center',
                    opacity: logoBusy ? 0.6 : 1,
                  }}
                >
                  <Text style={[font('label', 700), { fontSize: 13, color: colors.ink800 }]}>
                    {t(billingPrefs.prefs.logoUri ? 'reglages.logoChange' : 'reglages.logoAdd', { personality })}
                  </Text>
                </Pressable>
              </View>
              {billingPrefs.prefs.logoUri ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('reglages.logoRemove', { personality })}
                  onPress={handleRemoveLogo}
                  style={{ marginTop: 10, minHeight: 32 }}
                >
                  <Text style={[font('meta', 600), { color: semantic.danger }]}>
                    {t('reglages.logoRemove', { personality })}
                  </Text>
                </Pressable>
              ) : null}
              {logoError ? (
                <Text
                  accessibilityRole="alert"
                  style={[font('meta', 600), { color: semantic.danger, marginTop: 8 }]}
                >
                  {logoError}
                </Text>
              ) : null}
              <Text style={[font('meta'), { color: colors.slate300, marginTop: 10, lineHeight: 16 }]}>
                {t('reglages.logoOnPdfNote', { personality })}
              </Text>
            </Card>

            {/* ── Identité sur les factures — lecture réelle, non éditable depuis cet écran ── */}
            <SectionHeader title={t('reglages.sectionIdentity', { personality })} />
            <Card padding={4} style={{ paddingHorizontal: 15, marginBottom: 18 }}>
              {(
                [
                  { key: 'name', label: t('reglages.identityName', { personality }), value: data.name },
                  { key: 'siret', label: t('reglages.identitySiret', { personality }), value: formatSiret(data.siret), tabular: true },
                  { key: 'rm', label: t('reglages.identityRm', { personality }), value: data.rcsOrRm ?? '—' },
                  {
                    key: 'address',
                    label: t('reglages.identityAddress', { personality }),
                    value: `${data.address.line1}, ${data.address.zip} ${data.address.city}`,
                  },
                ] as const
              ).map((row, index, rows) => (
                <View
                  key={row.key}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                    borderBottomColor: colors.lineSoft,
                  }}
                >
                  <Text style={[font('sub'), { color: colors.slate400 }]}>{row.label}</Text>
                  <Text
                    numberOfLines={2}
                    style={[
                      font('sub', 700),
                      { fontSize: 14, color: colors.ink800, flexShrink: 1, textAlign: 'right' },
                      'tabular' in row && row.tabular ? { fontVariant: ['tabular-nums'] } : null,
                    ]}
                  >
                    {row.value}
                  </Text>
                </View>
              ))}
            </Card>
            <Text style={[font('meta'), { color: colors.slate300, marginTop: -10, marginBottom: 18, lineHeight: 16 }]}>
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
                      { fontSize: 13.5, color: data.iban ? colors.ink800 : colors.slate400, fontVariant: ['tabular-nums'] },
                    ]}
                  >
                    {data.iban ? maskedIban(data.iban) : t('reglages.ribIbanEmpty', { personality })}
                  </Text>
                  <ChevronRightIcon color={colors.slate300} size={15} />
                </View>
              </Pressable>
              <SettingsToggle
                value={billingPrefs.prefs.showRibOnInvoices}
                onChange={(next) => billingPrefs.update({ showRibOnInvoices: next })}
                title={t('reglages.ribToggleLabel', { personality })}
                subtitle={t('reglages.ribToggleSub', { personality })}
              />
            </Card>
            <Text style={[font('meta'), { color: colors.slate300, marginTop: -10, marginBottom: 18, lineHeight: 16 }]}>
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
                <Feather name="check-circle" size={14} color={semantic.success} style={{ marginTop: 2 }} />
                <Text style={[font('meta'), { fontSize: 12.5, color: semantic.success, lineHeight: 18, flex: 1 }]}>
                  {t(
                    vatSegment === 'franchise' ? 'reglages.vatRegimeHelpFranchise' : 'reglages.vatRegimeHelpReel',
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
                    <View key={`${i}-${mention.slice(0, 16)}`} style={{ flexDirection: 'row', gap: 8 }}>
                      <Text style={[font('meta'), { color: colors.slate400 }]}>•</Text>
                      <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate500, lineHeight: 19, flex: 1 }]}>
                        {mention}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 8 }]}>
                  {t('reglages.mentionsEmpty', { personality })}
                </Text>
              )}
            </Card>

            {/* ── Assurance — adaptatif métier (décennale BTP / RC Pro hors bâtiment) ── */}
            <SectionHeader
              title={t(isBtp ? 'reglages.sectionInsuranceBtp' : 'reglages.sectionInsuranceOther', { personality })}
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
                    {t(isBtp ? 'reglages.insuranceDecennaleLabel' : 'reglages.insuranceRcProLabel', { personality })}
                  </Text>
                  <Text style={[font('sub', 700), { fontSize: 14, color: colors.ink800 }]}>
                    {`${data.decennale.insurer} · n°${data.decennale.policyNo}`}
                  </Text>
                </View>
              ) : (
                <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.lineSoft, gap: 8 }}>
                  <SoonPill />
                  <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                    {t(isBtp ? 'reglages.insuranceEmptyBtp' : 'reglages.insuranceEmptyOther', { personality })}
                  </Text>
                </View>
              )}
              <SettingsToggle
                value={billingPrefs.prefs.showInsuranceOnInvoices}
                onChange={(next) => billingPrefs.update({ showInsuranceOnInvoices: next })}
                title={t(isBtp ? 'reglages.insuranceToggleLabelBtp' : 'reglages.insuranceToggleLabelOther', { personality })}
                subtitle={t(isBtp ? 'reglages.insuranceToggleSubBtp' : 'reglages.insuranceToggleSubOther', { personality })}
              />
            </Card>
            <Text style={[font('meta'), { color: colors.slate300, marginTop: -10, marginBottom: 18, lineHeight: 16 }]}>
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

            {/* ── Valeurs par défaut — validité RÉELLEMENT appliquée (devis/new.tsx) ; acompte/
                conditions/couleur = préférences mémorisées, cf. doctrine en tête de fichier. ── */}
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
                    active={billingPrefs.prefs.defaultQuoteValidityDays === days}
                    onPress={() => billingPrefs.update({ defaultQuoteValidityDays: days })}
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
                    active={billingPrefs.prefs.defaultDepositPercent === pct}
                    onPress={() => billingPrefs.update({ defaultDepositPercent: pct })}
                  />
                ))}
              </View>

              <Text style={[font('sub'), { color: colors.slate500, marginBottom: 9 }]}>
                {t('reglages.defaultsPaymentTermsLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {PAYMENT_TERMS_OPTIONS.map((preset) => (
                  <Chip
                    key={preset}
                    label={t(PAYMENT_TERMS_KEY[preset], { personality })}
                    active={billingPrefs.prefs.defaultPaymentTerms === preset}
                    onPress={() => billingPrefs.update({ defaultPaymentTerms: preset })}
                  />
                ))}
              </View>

              <Text style={[font('sub'), { color: colors.slate500, marginBottom: 9 }]}>
                {t('reglages.defaultsAccentLabel', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', gap: 13 }}>
                {ACCENT_ORDER.map((swatch) => (
                  <Pressable
                    key={swatch}
                    accessibilityRole="button"
                    accessibilityState={{ selected: billingPrefs.prefs.pdfAccentColor === swatch }}
                    accessibilityLabel={swatch}
                    hitSlop={6}
                    onPress={() => billingPrefs.update({ pdfAccentColor: swatch })}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      backgroundColor: accentSwatchColor[swatch],
                      borderWidth: billingPrefs.prefs.pdfAccentColor === swatch ? 3 : 0,
                      borderColor: colors.ink900,
                    }}
                  />
                ))}
              </View>
            </Card>
            <Text style={[font('meta'), { color: colors.slate300, marginBottom: 22, lineHeight: 16 }]}>
              {t('reglages.defaultsNote', { personality })}
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
        <IbanEditSheet
          visible={ibanSheetOpen}
          currentIban={data.iban ?? null}
          personality={personality}
          onClose={() => setIbanSheetOpen(false)}
        />
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
