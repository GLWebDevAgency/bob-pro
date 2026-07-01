import { type ComponentProps } from 'react';
import { ScrollView, View, Text, Pressable, ActivityIndicator, Linking, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/theme';
import { useProfile } from '../../src/data/hooks';
import { useBobClient } from '../../src/data/client';
import { useDocuments } from '../../src/data/documents';
import { GradientHeader, Card, Button, font } from '../../src/components/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

const KIND_META: Record<string, { label: string; icon: IconName }> = {
  invoice_pdf: { label: 'Facture', icon: 'document-text-outline' },
  facturx_xml: { label: 'Factur-X', icon: 'code-slash-outline' },
  quote_pdf: { label: 'Devis', icon: 'reader-outline' },
  signed_quote: { label: 'Devis signé', icon: 'checkmark-done-outline' },
  expense_receipt: { label: 'Reçu', icon: 'receipt-outline' },
  other: { label: 'Document', icon: 'document-outline' },
};
const FALLBACK: { label: string; icon: IconName } = { label: 'Document', icon: 'document-outline' };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}
function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

export default function Documents() {
  const { colors, semantic } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const { data: profile } = useProfile();
  const hasChantiers = (profile?.modules ?? []).some((m) => m.key === 'chantiers');
  const { data: documents, isLoading, error, refetch } = useDocuments();

  const kindColor = (kind: string): string => {
    if (kind === 'invoice_pdf' || kind === 'facturx_xml') return semantic.b2b;
    if (kind === 'quote_pdf') return semantic.ai;
    if (kind === 'signed_quote') return semantic.success;
    if (kind === 'expense_receipt') return semantic.warning;
    return colors.slate500;
  };

  const open = async (doc: { id: string; filename: string }): Promise<void> => {
    const r = await client.documentDownloadUrl(doc.id);
    if (r.ok) await Linking.openURL(r.value.url);
    else Alert.alert('Document', 'Impossible d’ouvrir ce document pour le moment.');
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 120 }}>
      <GradientHeader>
        <Text style={[font('eyebrow'), { color: 'rgba(255,255,255,0.7)' }]}>TON COFFRE-FORT</Text>
        <Text style={[font('pageTitle'), { color: '#fff', marginTop: 4 }]}>Documents</Text>
        <Text style={[font('body'), { color: 'rgba(255,255,255,0.8)', marginTop: 4 }]}>Je classe, tu retrouves. Même 10 ans après.</Text>
      </GradientHeader>

      <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 10 }}>
        <Button title="Scanner un document" onPress={() => router.push('/scan-document')} />
        {hasChantiers ? <Button title="Mes chantiers" variant="secondary" onPress={() => router.push('/chantiers')} /> : null}
      </View>

      <View style={{ padding: 20, gap: 12 }}>
        {isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={semantic.ai} />
          </View>
        ) : error ? (
          <Card>
            <Text style={[font('body'), { color: colors.ink800 }]}>Impossible de charger tes documents.</Text>
            <View style={{ marginTop: 10 }}>
              <Button title="Réessayer" variant="secondary" onPress={() => void refetch()} />
            </View>
          </Card>
        ) : !documents || documents.length === 0 ? (
          <Card>
            <Ionicons name="folder-open-outline" size={28} color={semantic.ai} />
            <Text style={[font('cardTitle'), { color: colors.ink900, marginTop: 10 }]}>Rien encore</Text>
            <Text style={[font('body'), { color: colors.slate500, marginTop: 4 }]}>
              Tes factures, devis signés et reçus scannés se rangent ici automatiquement — et se conservent 10 ans.
            </Text>
          </Card>
        ) : (
          documents.map((doc) => {
            const meta = KIND_META[doc.kind] ?? FALLBACK;
            const tint = kindColor(doc.kind);
            return (
              <Pressable
                key={doc.id}
                onPress={() => void open(doc)}
                accessibilityRole="button"
                accessibilityLabel={`Ouvrir ${doc.filename}`}
              >
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: colors.lineSoft, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name={meta.icon} size={22} color={tint} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[font('cardTitle'), { color: colors.ink800 }]} numberOfLines={1}>
                        {doc.filename}
                      </Text>
                      <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                        {meta.label} · {formatDate(doc.createdAt)} · {formatSize(doc.byteSize)}
                      </Text>
                    </View>
                    <Ionicons name="open-outline" size={18} color={colors.slate300} />
                  </View>
                </Card>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
