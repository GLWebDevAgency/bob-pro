/**
 * Réglages facturation — « Facturation & modèles » (claim C27, réf proto dc.html §showBilling).
 *
 * LECTURE RÉELLE, honnêteté avant pixel :
 * · TVA & mentions : taux par défaut du MÉTIER (profil réel useProfile → TradeConfig) +
 *   explication voix Bob — les mentions obligatoires sont générées par le core (buildMentions,
 *   figées à l'émission) ; l'APERÇU montre les mentions RÉELLES de la dernière facture émise
 *   (InvoiceView.mentions — jamais une liste inventée) ; aucune facture → état vide honnête ;
 * · Numérotation : garantie SANS TROU du core (SequenceCounterPort, allocation atomique à
 *   l'émission) — explication voix Bob + DERNIER numéro réellement émis (le « prochain » du
 *   proto n'est pas affiché : l'allocation est serveur, l'afficher serait une promesse) ;
 * · Logo / RIB : AUCUN champ au profil exposé par BobClient (vérifié packages/api-client) →
 *   états « à venir » assumés, PAS de formulaire fantôme (contrat C27) ;
 * · Entrée catalogue : rangée de navigation vers /catalogue (les prestations et les prix).
 *
 * Écarts assumés vs proto : identité (raison sociale/SIRET/adresse), assurance décennale,
 * validité devis/acompte/couleur d'accent = édition sans endpoint → NON rendus plutôt que
 * factices ; le CTA « Enregistrer » du proto n'a pas lieu d'être (écran de lecture).
 * Zéro hex/rgba — tokens only.
 */
import { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadowNative } from '@bob/tokens';
import { t } from '@bob/i18n';
import { Card, ErrorRetry, InnerScreenHeader, SectionHeader, SkeletonCard, font, useTheme } from '@bob/ui';
import type { InvoiceView } from '@bob/api-client';
import { useInvoices, useProfile } from '../src/data/hooks';
import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon } from '../src/components/icons';

/** Taux affiché à la française (5.5 → « 5,5 ») — même règle que devis/new. */
const fmtRate = (rate: number): string => String(rate).replace('.', ',');

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

export default function ReglagesFacturation() {
  const { colors, radius, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const profile = useProfile();
  const invoices = useInvoices();

  const lastInvoice = useMemo(() => lastIssuedInvoice(invoices.data ?? []), [invoices.data]);
  const loading = profile.isLoading || invoices.isLoading;
  const failed = profile.isError || invoices.isError;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('reglages.back', { personality })}
          onPress={() => router.back()}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
            {t('reglages.back', { personality })}
          </Text>
        </Pressable>
      </View>

      <InnerScreenHeader
        eyebrow={t('reglages.eyebrow', { personality })}
        title={t('reglages.title', { personality })}
        subtitle={t('reglages.subtitle', { personality })}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: insets.bottom + 34 }}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          // 5 blocs réels (catalogue, TVA & mentions, aperçu mentions, numérotation, logo/RIB) —
          // hauteurs calées sur leur gabarit final (zéro saut de layout).
          <View style={{ gap: 14 }}>
            <SkeletonCard height={70} contentLines={2} />
            <SkeletonCard height={110} contentLines={3} />
            <SkeletonCard height={150} contentLines={4} />
            <SkeletonCard height={120} contentLines={3} />
            <SkeletonCard height={210} contentLines={3} />
          </View>
        ) : failed ? (
          <ErrorRetry
            message={t('reglages.dataError', { personality })}
            onRetry={() => {
              void profile.refetch();
              void invoices.refetch();
            }}
          />
        ) : (
          <>
            {/* Entrée catalogue — les prestations et les prix vivent sur leur écran (C27) */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('reglages.catalogueRow', { personality })}
              onPress={() => router.push('/catalogue')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                backgroundColor: colors.surface,
                borderRadius: radius.cardLg,
                paddingVertical: 14,
                paddingHorizontal: 15,
                ...shadowNative.e1,
              }}
            >
              <FileTextIcon color={colors.ink800} size={18} />
              <View style={{ flex: 1 }}>
                <Text style={[font('label', 600), { fontSize: 14.5, color: colors.ink900 }]}>
                  {t('reglages.catalogueRow', { personality })}
                </Text>
                <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}>
                  {t('reglages.catalogueRowSub', { personality })}
                </Text>
              </View>
              <ChevronRightIcon color={colors.slate400} size={15} />
            </Pressable>

            {/* TVA & mentions légales — profil réel + mentions RÉELLES de la dernière facture */}
            <SectionHeader title={t('reglages.sectionVat', { personality })} />
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[font('sub'), { color: colors.slate500, flex: 1, paddingRight: 10 }]}>
                  {t('reglages.vatDefaultLabel', {
                    personality,
                    params: { trade: profile.data?.label ?? '—' },
                  })}
                </Text>
                <Text style={[font('label', 700), { fontSize: 15, color: colors.ink900 }]}>
                  {t('catalogue.vatRatePct', {
                    personality,
                    params: { rate: fmtRate(profile.data?.defaultVatRate ?? 20) },
                  })}
                </Text>
              </View>
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 12 }]}>
                {t('reglages.mentionsAuto', { personality })}
              </Text>
            </Card>
            <Card style={{ marginTop: 10 }}>
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

            {/* Numérotation — garantie core sans trou, dernier numéro RÉEL */}
            <SectionHeader title={t('reglages.sectionNumbering', { personality })} />
            <Card>
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

            {/* Logo — aucun endpoint : état « à venir », pas de faux bouton « Changer » */}
            <SectionHeader title={t('reglages.sectionLogo', { personality })} />
            <Card>
              <SoonPill />
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 8 }]}>
                {t('reglages.logoSoon', { personality })}
              </Text>
            </Card>

            {/* RIB — aucun endpoint : état « à venir », pas de switch fantôme */}
            <SectionHeader title={t('reglages.sectionRib', { personality })} />
            <Card>
              <SoonPill />
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 8 }]}>
                {t('reglages.ribSoon', { personality })}
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}
