/**
 * B5 — Carte « Retenue à récupérer » (loi n° 71-584) : créance SUIVIE agrégée depuis les
 * factures RÉELLES porteuses de retenue (émises, jamais brouillon/annulée/avoir). Affichée sur
 * la fiche chantier (restreinte au client du chantier) ET dans Argent (tout le tenant). Sans
 * PV de réception V1, l'échéance de restitution est annoncée HONNÊTEMENT « réception + 1 an »
 * — jamais une date inventée. Ne rend RIEN quand aucune retenue n'est constituée.
 */
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatEUR, parisDateOnly } from '@bob/core';
import { t } from '@bob/i18n';
import { Card, LegalHint, MoneyText, font, useTheme } from '@bob/ui';
import { useInvoices } from '../data/hooks';
import { deriveRetenueSuivi } from '../finance/retenue-garantie-suivi.logic';

export function RetenueSuiviCard({
  customerId,
  customerName,
}: {
  /** Restreint la créance au client (fiche chantier) — absent : tout le tenant (Argent). */
  customerId?: string;
  customerName?: string;
}) {
  const { colors, semantic, personality } = useTheme();
  const router = useRouter();
  const invoices = useInvoices();

  // États loading/erreur : la carte est un COMPLÉMENT — elle se tait plutôt que d'afficher un
  // squelette de plus (les écrans hôtes portent déjà leurs états de premier rang).
  if (invoices.data === undefined) return null;
  const suivi = deriveRetenueSuivi(
    invoices.data,
    parisDateOnly(),
    customerId !== undefined ? { customerId } : undefined,
  );
  if (suivi === null) return null;

  return (
    <Card radius={20} padding={16} style={{ borderColor: semantic.warning }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
          {t('retenue.suiviTitle', { personality }).toUpperCase()}
        </Text>
        <Text style={[font('meta', 600), { fontSize: 12, color: colors.slate400 }]}>
          {t('retenue.suiviPieces', { personality, params: { count: suivi.pieceCount } })}
        </Text>
      </View>
      <View style={{ marginTop: 6 }}>
        <MoneyText cents={suivi.retainedCents} variant="big" color={semantic.warning} />
      </View>
      {customerName !== undefined ? (
        <Text style={[font('meta', 600), { fontSize: 12.5, color: colors.slate500, marginTop: 2 }]}>
          {t('retenue.suiviCustomer', { personality, params: { name: customerName } })}
        </Text>
      ) : null}
      <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 6 }]}>
        {t('retenue.suiviNoReception', { personality })}
      </Text>
      {/* Les pièces porteuses — nav réelle vers chaque facture. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {suivi.pieces.map((piece) => (
          <Pressable
            key={piece.id}
            accessibilityRole="button"
            accessibilityLabel={`Facture ${piece.number ?? ''}`}
            onPress={() => router.push(`/facture/${piece.id}`)}
            style={({ pressed }) => ({
              borderWidth: 1,
              borderColor: semantic.warning,
              backgroundColor: semantic.warningBg,
              borderRadius: 999,
              paddingHorizontal: 9,
              paddingVertical: 4,
              minHeight: 28,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={[font('meta'), { fontSize: 11, fontWeight: '700', color: semantic.warning }]}>
              {piece.number ?? '—'} · {formatEUR(piece.retainedCents)}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ marginTop: 8 }}>
        <LegalHint
          label={t('legal.retenue.inline', { personality })}
          lawKey="legal.retenue.law"
          whyKey="legal.retenue.why"
          source="loi n° 71-584 du 16 juillet 1971, art. 1er et 2"
        />
      </View>
    </Card>
  );
}
