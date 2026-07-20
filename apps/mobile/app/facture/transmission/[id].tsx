/**
 * Canal de facturation — ÉCRAN GUIDE de dépôt d'une facture ÉMISE (client Chorus Pro ou
 * portail fournisseur). Le guide est DÉRIVÉ CÔTÉ SERVEUR (deriveTransmissionGuide, pure —
 * embarqué par GET /invoices/:id d'une pièce émise) : l'écran affiche les étapes avec l'état
 * honnête de chaque prérequis (vérifié / à vérifier / à faire soi-même) et offre les ACTIONS
 * RÉELLES : partager le PDF Factur-X, partager le n° d'engagement, ouvrir le portail. Le suivi
 * « Déposée le… / Acceptée le… » se déclare en 2 taps (PATCH /invoices/:id/transmission,
 * dates DÉCLARÉES par l'artisan — jamais inventées). Aucune promesse de raccordement
 * automatique : le connecteur Plateforme Agréée est l'item B8, hors V1.
 */
import { useMemo, useState } from 'react';
import { Alert, Linking, ScrollView, Share, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatDateOnlyFr, parisDateOnly } from '@bob/core';
import { t } from '@bob/i18n';
import {
  Button,
  Card,
  ErrorRetry,
  PressableScale,
  SkeletonCard,
  SkeletonHeader,
  StatusBadge,
  font,
  useTheme,
} from '@bob/ui';
import {
  appErrorMessage,
  useInvoice,
  useRecordInvoiceTransmission,
} from '../../../src/data/hooks';
import { useDocuments } from '../../../src/data/documents';
import { useBobClient } from '../../../src/data/client';
import { shareDocument } from '../../../src/lib/share-document';
import { goBackOrHome } from '../../../src/lib/navigation';
import { ChevronLeftIcon } from '../../../src/components/icons';

const CHORUS_URL = 'https://portail.chorus-pro.gouv.fr';

export default function FactureTransmissionGuide() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, semantic, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useBobClient();
  const invoice = useInvoice(id);
  const documents = useDocuments();
  const record = useRecordInvoiceTransmission();
  const [suiviError, setSuiviError] = useState(false);

  const guide = invoice.data?.transmissionGuide;
  const transmission = invoice.data?.transmission ?? null;

  const pdfDoc = useMemo(
    () =>
      (documents.data ?? []).find(
        (d) => d.linkedEntityType === 'invoice' && d.linkedEntityId === id && d.kind === 'invoice_pdf',
      ) ?? null,
    [documents.data, id],
  );

  const sharePdf = async (): Promise<void> => {
    if (pdfDoc === null) {
      Alert.alert('Oups', t('guide.pdfMissing', { personality }));
      return;
    }
    const r = await client.documentDownloadUrl(pdfDoc.id);
    if (!r.ok) {
      Alert.alert('Oups', t('piece.shareError', { personality }));
      return;
    }
    const shared = await shareDocument({
      url: r.value.url,
      filename: pdfDoc.filename,
      mimeType: pdfDoc.mimeType,
    });
    if (shared === 'unavailable') Alert.alert('Oups', t('piece.shareUnavailable', { personality }));
    else if (shared === 'error') Alert.alert('Oups', t('piece.shareError', { personality }));
  };

  const shareEngagementNumber = async (): Promise<void> => {
    const number = invoice.data?.purchaseOrder?.number;
    if (!number) return;
    // Pas de presse-papiers natif dans ce binaire (module non installé — jamais de dépendance
    // fantôme) : la feuille de partage système couvre « copier » sur iOS ET Android.
    await Share.share({ message: number });
  };

  const openPortal = async (url: string): Promise<void> => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Oups', appErrorMessage(new Error(url)));
    }
  };

  const declare = (field: 'depositedAt' | 'acceptedAt'): void => {
    if (record.isPending) return;
    setSuiviError(false);
    record.mutate(
      { invoiceId: id, [field]: parisDateOnly() },
      { onError: () => setSuiviError(true) },
    );
  };

  if (invoice.isLoading || documents.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <SkeletonHeader onClose={() => router.back()} />
        <View style={{ padding: 18, gap: 12 }}>
          <SkeletonCard contentLines={4} />
          <SkeletonCard contentLines={3} />
        </View>
      </View>
    );
  }
  if (invoice.isError || documents.isError || !invoice.data || guide === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: 18 }}>
        <ErrorRetry
          message={t('piece.dataError', { personality })}
          onRetry={() => void Promise.all([invoice.refetch(), documents.refetch()])}
          retrying={invoice.isRefetching || documents.isRefetching}
          secondaryLabel={t('piece.close', { personality })}
          onSecondaryAction={() => goBackOrHome(router)}
        />
      </View>
    );
  }

  const inv = invoice.data;
  const portalName =
    guide.channel === 'chorus'
      ? t('canal.chorus', { personality })
      : (guide.portail?.nom ?? t('guide.portalFallbackName', { personality }));
  const portalUrl = guide.channel === 'chorus' ? CHORUS_URL : (guide.portail?.url ?? null);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* En-tête : retour + titre + n° de pièce */}
      <View
        style={{
          paddingTop: insets.top + 10,
          paddingHorizontal: 18,
          paddingBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {/* Press feedback standard (PressableScale) — parité motion avec les écrans frères. */}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('piece.close', { personality })}
          onPress={() => router.back()}
          hitSlop={6}
          style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
        >
          <ChevronLeftIcon color={colors.ink600} size={20} strokeWidth={2.2} />
        </PressableScale>
        <View style={{ flex: 1 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>
            {t('guide.screenTitle', { personality }).toUpperCase()}
          </Text>
          <Text style={[font('screenH1'), { fontSize: 22, color: colors.ink900 }]}>
            {inv.number ?? '—'}
          </Text>
        </View>
        <StatusBadge
          label={guide.channel === 'chorus' ? t('canal.chorus', { personality }) : t('canal.portail', { personality })}
          variant="b2g"
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 28, gap: 12 }}
      >
        {/* Étapes VISUELLES numérotées — checklist serveur, état honnête de chaque prérequis. */}
        <Card radius={20} padding={16}>
          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginBottom: 10 }]}>
            {t('guide.checklistTitle', { personality }).toUpperCase()}
          </Text>
          {guide.checklist.map((item, index) => {
            const tone =
              item.done === true ? semantic.success : item.done === false ? semantic.warning : semantic.ai;
            const stateLabel =
              item.done === true
                ? t('guide.checkDone', { personality })
                : item.done === false
                  ? t('guide.checkTodo', { personality })
                  : t('guide.checkManual', { personality });
            return (
              <View
                key={`${index}-${item.label}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 12,
                  paddingVertical: 10,
                  borderBottomWidth: index < guide.checklist.length - 1 ? 1 : 0,
                  borderBottomColor: colors.lineSoft,
                }}
              >
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor:
                      item.done === true
                        ? semantic.successBg
                        : item.done === false
                          ? semantic.warningBg
                          : semantic.aiBg,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 1,
                  }}
                >
                  <Text style={[font('label', 800), { fontSize: 13, color: tone }]}>{index + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[font('sub', 600), { color: colors.ink800, lineHeight: 19 }]}>
                    {item.label}
                  </Text>
                  <Text style={[font('meta', 700), { fontSize: 11, color: tone, marginTop: 2 }]}>
                    {stateLabel.toUpperCase()}
                  </Text>
                </View>
              </View>
            );
          })}
        </Card>

        {/* Actions RÉELLES du dépôt. */}
        <Card radius={20} padding={16}>
          <View style={{ gap: 8 }}>
            <Button title={t('guide.actionDownload', { personality })} onPress={() => void sharePdf()} />
            {inv.purchaseOrder != null ? (
              <Button
                title={t('guide.actionShareNumber', { personality })}
                variant="secondary"
                onPress={() => void shareEngagementNumber()}
              />
            ) : null}
            {portalUrl !== null ? (
              <Button
                title={
                  guide.channel === 'chorus'
                    ? t('guide.actionOpenChorus', { personality })
                    : t('guide.actionOpenPortal', { personality, params: { name: portalName } })
                }
                variant="secondary"
                onPress={() => void openPortal(portalUrl)}
              />
            ) : null}
          </View>
          {guide.channel === 'chorus' && guide.chorusServiceCode != null ? (
            <Text style={[font('meta', 600), { fontSize: 12.5, color: colors.slate500, marginTop: 10 }]}>
              {t('canal.chorusServiceCode', { personality })} : {guide.chorusServiceCode}
            </Text>
          ) : null}
        </Card>

        {/* Suivi déclaré en 2 taps — Déposée le… / Acceptée le… (relances dérivées). */}
        <Card radius={20} padding={16}>
          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
            {t('guide.suiviTitle', { personality }).toUpperCase()}
          </Text>
          <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 4 }]}>
            {t('guide.suiviHint', { personality })}
          </Text>
          <View style={{ gap: 8, marginTop: 12 }}>
            {transmission?.depositedAt != null ? (
              <View
                style={{
                  borderRadius: 12,
                  backgroundColor: semantic.successBg,
                  paddingVertical: 11,
                  paddingHorizontal: 13,
                }}
              >
                <Text style={[font('sub', 700), { color: semantic.success }]}>
                  {t('guide.depositedOn', {
                    personality,
                    params: { date: formatDateOnlyFr(transmission.depositedAt) },
                  })}
                </Text>
              </View>
            ) : (
              <Button
                title={t('guide.markDeposited', { personality })}
                loading={record.isPending}
                disabled={record.isPending}
                onPress={() => declare('depositedAt')}
              />
            )}
            {transmission?.acceptedAt != null ? (
              <View
                style={{
                  borderRadius: 12,
                  backgroundColor: semantic.successBg,
                  paddingVertical: 11,
                  paddingHorizontal: 13,
                }}
              >
                <Text style={[font('sub', 700), { color: semantic.success }]}>
                  {t('guide.acceptedOn', {
                    personality,
                    params: { date: formatDateOnlyFr(transmission.acceptedAt) },
                  })}
                </Text>
              </View>
            ) : transmission?.depositedAt != null ? (
              <Button
                title={t('guide.markAccepted', { personality })}
                variant="secondary"
                loading={record.isPending}
                disabled={record.isPending}
                onPress={() => declare('acceptedAt')}
              />
            ) : null}
          </View>
          {suiviError ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 10 }]}>
              {t('guide.suiviError', { personality })}
            </Text>
          ) : null}
        </Card>
      </ScrollView>
    </View>
  );
}
