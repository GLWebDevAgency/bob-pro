/**
 * PR-12c — section « Contrats » de la fiche client (écrans §6.3) : label · badge d'état
 * DÉRIVÉ · montant/an (Σ lignes vivante) · prochaine échéance calculée. Client b2c : PAS de
 * CTA « Nouveau contrat » (périmètre V1 — la pédagogie Chatel vit dans le wizard et la voix).
 * Fail-closed : capacité contrats absente ou requête en erreur → la section ne s'affiche pas
 * (jamais un état inventé sur la fiche).
 */
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { t } from '@bob/i18n';
import { BobSurface, Button, StatusBadge, font, useTheme } from '@bob/ui';
import { formatEURWhole } from '@bob/core';
import { useMaintenanceContracts } from '../data/hooks';
import { frContractDate } from './contract-fiche.logic';

export function CustomerContractsCard({
  customerId,
  customerType,
}: {
  customerId: string;
  customerType: 'b2c' | 'b2b' | 'b2g';
}) {
  const { personality, colors } = useTheme();
  const router = useRouter();
  const contracts = useMaintenanceContracts();
  const mine = (contracts.data ?? []).filter((view) => view.contract.customerId === customerId);
  // b2c sans contrat : aucune section (le périmètre V1 ne propose rien à créer ici).
  if (contracts.isError || (customerType === 'b2c' && mine.length === 0)) return null;
  if (contracts.isPending) return null;

  return (
    <BobSurface tone="neutral" emphasis="raised">
      <Text style={[font('sub', 700), { color: colors.slate500, letterSpacing: 0.6 }]}>
        {t('contrat.sectionClient', { personality }).toUpperCase()}
      </Text>
      {mine.length === 0 ? (
        <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 8 }]}>
          {t('contrat.clientEmpty', { personality })}
        </Text>
      ) : (
        mine.map((view, index) => {
          const badge =
            view.contract.status === 'draft'
              ? { variant: 'warning' as const, label: t('contrat.badgeDraft', { personality }) }
              : view.contract.status === 'terminated'
                ? {
                    variant: 'neutral' as const,
                    label: t('contrat.badgeTerminated', {
                      personality,
                      params: {
                        date: frContractDate((view.contract.terminatedAt ?? '').slice(0, 10)),
                      },
                    }),
                  }
                : view.lifecycle.expired !== null
                  ? {
                      variant: 'warning' as const,
                      label: t('contrat.badgeExpired', {
                        personality,
                        params: { date: frContractDate(view.lifecycle.expired.since) },
                      }),
                    }
                  : { variant: 'success' as const, label: t('contrat.badgeActive', { personality }) };
          return (
            <Pressable
              key={view.contract.id}
              accessibilityRole="button"
              accessibilityLabel={`${view.contract.label}, ${badge.label}`}
              onPress={() => router.push(`/contrat/${view.contract.id}`)}
              style={({ pressed }) => ({
                paddingVertical: 10,
                borderTopWidth: index > 0 ? 1 : 0,
                borderTopColor: colors.lineSoft,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[font('body', 600), { color: colors.ink800, flexShrink: 1 }]}>
                  {view.contract.label}
                </Text>
                <StatusBadge variant={badge.variant} label={badge.label} />
              </View>
              <Text style={[font('sub', 500), { color: colors.slate500, marginTop: 2 }]}>
                {t('contrat.totalPerYear', {
                  personality,
                  params: { amount: formatEURWhole(view.annualTotals.ht) },
                })}
                {view.renewalAlert !== null
                  ? ` · ${t('contrat.nextAnniversary', {
                      personality,
                      params: { date: frContractDate(view.renewalAlert.anniversary) },
                    })}`
                  : ''}
              </Text>
            </Pressable>
          );
        })
      )}
      {customerType !== 'b2c' ? (
        <View style={{ alignSelf: 'flex-start', marginTop: 10 }}>
          <Button
            title={t('contrat.newCta', { personality })}
            variant="secondary"
            onPress={() => router.push(`/contrat/new?customerId=${encodeURIComponent(customerId)}`)}
          />
        </View>
      ) : null}
    </BobSurface>
  );
}
