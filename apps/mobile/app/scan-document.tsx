import { useMemo } from 'react';
import { ScrollView, View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { formatEUR } from '@bob/core';
import { InMemoryCompanyMemory, suggestExpenseDefaults } from '@bob/ai';
import { useTheme } from '../src/theme';
import { useExtractDocument, useRecordExpense, useExpenses } from '../src/data/hooks';
import { Card, Button, Badge, SectionHeader, font } from '../src/components/ui';

const CATEGORY_LABEL: Record<string, string> = {
  fournitures: 'Fournitures',
  materiel: 'Matériel',
  carburant: 'Carburant',
  repas: 'Repas',
  sous_traitance: 'Sous-traitance',
  autre: 'Autre',
};

export default function ScanDocument() {
  const { colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const extract = useExtractDocument();
  const record = useRecordExpense();
  const expenses = useExpenses();
  const data = extract.data;

  // Mémoire d'entreprise dérivée de l'historique réel des dépenses (fournisseurs déjà classés).
  const memory = useMemo(
    () =>
      new InMemoryCompanyMemory(
        (expenses.data ?? []).map((e) => ({
          name: e.supplierName,
          siren: e.supplierSiren,
          category: e.category,
          vatRatePct: e.vatRatePct,
        })),
      ),
    [expenses.data],
  );
  // Défauts proposés : la mémoire fait primer TA catégorie habituelle sur la devinette OCR (sinon fallback OCR).
  const defaults = data ? suggestExpenseDefaults(memory, data) : null;

  async function capture(from: 'camera' | 'library'): Promise<void> {
    const perm =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6 });
    const asset = res.canceled ? null : res.assets[0];
    if (!asset || !asset.base64) return;
    const mimeType = asset.uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    extract.mutate({ contentBase64: asset.base64, mimeType });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Fermer" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={colors.ink800} />
          <Text style={[font('body'), { color: colors.ink800 }]}>Fermer</Text>
        </Pressable>
      </View>

      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>Scanner un document</Text>
        <Text style={[font('body'), { color: colors.slate500 }]}>
          Photographie une facture ou un ticket fournisseur — Bob en extrait le montant, la TVA et le fournisseur.
        </Text>

        <View style={{ gap: 8 }}>
          <Button title="Prendre une photo" onPress={() => void capture('camera')} />
          <Button title="Choisir dans la galerie" variant="secondary" onPress={() => void capture('library')} />
        </View>

        {extract.isPending ? (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ActivityIndicator color={colors.ink800} />
              <Text style={[font('body'), { color: colors.ink800 }]}>Lecture du document…</Text>
            </View>
          </Card>
        ) : null}

        {extract.isError ? (
          <Card>
            <Text style={[font('cardTitle'), { color: semantic.danger }]}>Lecture impossible</Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 4 }]}>
              Réessaie avec une photo plus nette et bien cadrée.
            </Text>
          </Card>
        ) : null}

        {data ? (
          <>
            <SectionHeader title="Extraction" />
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{data.supplierName}</Text>
                <Badge label={`${Math.round(data.confidence * 100)} %`} tone={data.confidence >= 0.85 ? 'success' : 'warning'} />
              </View>
              <View style={{ marginTop: 10, gap: 6 }}>
                <Row label="Date" value={data.documentDate} colors={colors} />
                <Row label="Total TTC" value={formatEUR(data.totalTtcCents)} colors={colors} strong />
                {data.vatCents !== null ? <Row label="TVA" value={formatEUR(data.vatCents)} colors={colors} /> : null}
                {(defaults?.vatRatePct ?? data.vatRatePctApplied) !== null ? (
                  <Row label="Taux TVA" value={`${defaults?.vatRatePct ?? data.vatRatePctApplied} %`} colors={colors} />
                ) : null}
                <View>
                  <Row
                    label="Catégorie"
                    value={CATEGORY_LABEL[defaults?.category ?? data.categoryGuess] ?? data.categoryGuess}
                    colors={colors}
                  />
                  {defaults?.source === 'memory' ? (
                    <Text style={[font('meta'), { color: semantic.ai, marginTop: 2, textAlign: 'right' }]}>
                      ✨ Proposé d’après ton historique
                    </Text>
                  ) : null}
                </View>
                {(defaults?.supplierSiren ?? data.supplierSiren) ? (
                  <Row label="SIREN" value={(defaults?.supplierSiren ?? data.supplierSiren)!} colors={colors} />
                ) : null}
              </View>
            </Card>
            {record.isError ? (
              <Text style={[font('sub'), { color: semantic.danger }]}>Enregistrement impossible. Réessaie.</Text>
            ) : null}
            <Button
              title={record.isPending ? 'Enregistrement…' : 'Enregistrer la dépense'}
              disabled={record.isPending}
              onPress={() =>
                record.mutate(
                  {
                    supplierName: data.supplierName,
                    supplierSiren: defaults?.supplierSiren ?? data.supplierSiren,
                    documentDate: data.documentDate,
                    totalTtcCents: data.totalTtcCents,
                    totalHtCents: data.totalHtCents,
                    vatCents: data.vatCents,
                    vatRatePct: defaults?.vatRatePct ?? data.vatRatePctApplied,
                    category: defaults?.category ?? data.categoryGuess,
                    source: 'ocr',
                  },
                  { onSuccess: () => router.back() },
                )
              }
            />
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  colors,
  strong,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>['colors'];
  strong?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={[font('sub'), { color: colors.slate400 }]}>{label}</Text>
      <Text style={[strong ? font('cardTitle') : font('sub'), { color: colors.ink900 }]}>{value}</Text>
    </View>
  );
}
