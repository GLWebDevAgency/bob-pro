/**
 * Fiche société officielle (C24b) — récap du lookup SIRET, partagé entre l'inscription
 * (LoginScreen étape « company ») et le provisioning post-confirmation (ProvisioningScreen).
 * Affiche TOUT ce que l'annuaire connaît ; les champs absents de la source sont MASQUÉS
 * (jamais un « — » menteur). 100 % tokens via useTheme.
 */
import { Text, View } from 'react-native';
import type { CompanyLookupResult } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { Card, font, useTheme } from '@bob/ui';
import { LEGAL_FORM_LABELS, formatDateFr } from '../data/company-draft';

/** 14 chiffres → « 123 456 789 00012 » (groupes SIREN 3-3-3 + NIC 5). */
export function formatSiret(digits: string): string {
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9, 14)];
  return parts.filter(Boolean).join(' ');
}

export function CompanyFicheCard({ company }: { company: CompanyLookupResult }) {
  const { colors, semantic, personality } = useTheme();
  const say = (key: I18nKey): string => t(key, { personality });
  const rows: readonly { label: string; value: string | null }[] = [
    { label: say('auth.companySiretLabel'), value: formatSiret(company.siret) },
    {
      label: say('auth.companyLegalFormLabel'),
      value: company.legalForm ? LEGAL_FORM_LABELS[company.legalForm] : null,
    },
    { label: say('auth.companyNafLabel'), value: company.nafApe },
    {
      label: say('auth.companyAddressLabel'),
      value: company.address
        ? `${company.address.line1}, ${company.address.zip} ${company.address.city}`
        : null,
    },
    { label: say('auth.companyTvaLabel'), value: company.tvaIntracom },
    { label: say('auth.companyCreatedLabel'), value: formatDateFr(company.dateCreation) },
  ];
  return (
    <Card padding={16} radius={16} style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={[font('label', 700), { flex: 1, fontSize: 16.5, color: colors.ink900 }]}>
          {company.denomination}
        </Text>
        {company.rge ? (
          <View
            style={{
              backgroundColor: semantic.successBg,
              borderRadius: 7,
              paddingHorizontal: 8,
              paddingVertical: 3,
            }}
          >
            <Text style={[font('label', 700), { fontSize: 11, color: semantic.success }]}>
              {say('auth.companyRge')}
            </Text>
          </View>
        ) : null}
      </View>
      {rows
        .filter((row): row is { label: string; value: string } => row.value !== null)
        .map((row, i) => (
          <View
            key={row.label}
            style={{
              flexDirection: 'row',
              gap: 12,
              paddingTop: 10,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: colors.lineSoft,
            }}
          >
            <Text style={[font('label', 600), { width: 104, fontSize: 12.5, color: colors.slate400 }]}>
              {row.label}
            </Text>
            <Text style={[font('sub'), { flex: 1, fontSize: 13.5, color: colors.ink800 }]}>
              {row.value}
            </Text>
          </View>
        ))}
    </Card>
  );
}
