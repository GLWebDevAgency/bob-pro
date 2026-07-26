/**
 * B4 + canal de facturation — sections PREMIUM de la fiche client :
 *  • « Conditions de paiement » : jours + fin de mois + libellé imprimé, LegalHint plafonds
 *    L441-10 (client professionnel), aperçu LIVE de l'échéance dérivée ;
 *  • « Comment ce client reçoit ses factures » : email (défaut) | Chorus Pro (+ code service)
 *    | portail fournisseur (nom + URL) — le guide de dépôt de la facture émise en découle.
 * Écriture par REMPLACEMENT COMPLET revalidé (UpdateCustomer/Customer.of) : le payload reprend
 * TOUS les faits connus de la fiche (buildCustomerReplacementPayload) — jamais une condition ni
 * un canal perdus par un patch partiel. Logique pure : customer-terms.logic (testée node).
 */
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import {
  parisDateOnly,
  type CustomerBillingChannelType,
  type CustomerListItem,
  type CustomerPaymentTerms,
} from '@bob/core';
import type { UpdateCustomerClientInput } from '@bob/api-client';
import { t } from '@bob/i18n';
import { Button, Card, Chip, LegalHint, SectionHeader, Sheet, font, useTheme } from '@bob/ui';
import { useUpdateCustomer } from '../data/hooks';
import {
  billingChannelTypeOf,
  buildBillingChannel,
  describeBillingChannel,
  describePaymentTerms,
  parseTermsDaysInput,
  previewDueDate,
  termsCeilingExceeded,
} from './customer-terms.logic';

/**
 * Remplacement complet SANS PERTE : tous les faits de la fiche repartent tels quels, seuls les
 * champs explicitement patchés changent. Exporté pour que l'édition générale (CustomerForm)
 * préserve elle aussi conditions/canal/faits fiscaux.
 */
export function buildCustomerReplacementPayload(
  customer: CustomerListItem,
  patch: Partial<
    Pick<UpdateCustomerClientInput, 'paymentTerms' | 'billingChannel' | 'requiresPurchaseOrder'>
  > & { clearPaymentTerms?: boolean },
): UpdateCustomerClientInput {
  const paymentTerms =
    patch.clearPaymentTerms === true
      ? undefined
      : patch.paymentTerms !== undefined
        ? patch.paymentTerms
        : (customer.paymentTerms ?? undefined);
  const billingChannel =
    patch.billingChannel !== undefined ? patch.billingChannel : (customer.billingChannel ?? undefined);
  // PR-04 — garde « BC obligatoire » : patchée explicitement, sinon PRÉSERVÉE telle quelle
  // (un remplacement complet depuis la fiche ne doit jamais désactiver la garde en silence).
  const requiresPurchaseOrder =
    patch.requiresPurchaseOrder !== undefined
      ? patch.requiresPurchaseOrder
      : customer.requiresPurchaseOrder === true
        ? true
        : undefined;
  return {
    type: customer.type,
    name: customer.name,
    address: { ...customer.address },
    ...(customer.siren !== null ? { siren: customer.siren } : {}),
    ...(customer.tvaIntracom != null ? { tvaIntracom: customer.tvaIntracom } : {}),
    ...(customer.email !== null ? { email: customer.email } : {}),
    ...(customer.phone !== null ? { phone: customer.phone } : {}),
    ...(customer.contactName !== null && customer.contactName !== ''
      ? { contactName: customer.contactName }
      : {}),
    ...(customer.paymentTermsLabel != null ? { paymentTermsLabel: customer.paymentTermsLabel } : {}),
    ...(paymentTerms !== undefined ? { paymentTerms } : {}),
    ...(billingChannel !== undefined ? { billingChannel } : {}),
    ...(requiresPurchaseOrder !== undefined ? { requiresPurchaseOrder } : {}),
    ...(customer.isInternational === true ? { isInternational: true } : {}),
    ...(customer.isSubcontractingBtp === true ? { isSubcontractingBtp: true } : {}),
  };
}

const CHANNEL_TYPES: readonly CustomerBillingChannelType[] = ['email', 'chorus', 'portail'];
const CHANNEL_LABEL = { email: 'canal.email', chorus: 'canal.chorus', portail: 'canal.portail' } as const;
const CHANNEL_HINT = {
  email: 'canal.emailHint',
  chorus: 'canal.chorusHint',
  portail: 'canal.portailHint',
} as const;

export function CustomerBillingSections({ customer }: { customer: CustomerListItem }) {
  const { colors, semantic, controls, personality } = useTheme();
  const update = useUpdateCustomer();

  // ── Feuille conditions de paiement ──
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsDaysRaw, setTermsDaysRaw] = useState('');
  const [termsEom, setTermsEom] = useState(false);
  const [termsLabel, setTermsLabel] = useState('');
  const [termsError, setTermsError] = useState<string | null>(null);

  // ── Feuille canal ──
  const [canalOpen, setCanalOpen] = useState(false);
  const [canalType, setCanalType] = useState<CustomerBillingChannelType>('email');
  const [chorusCode, setChorusCode] = useState('');
  const [portailNom, setPortailNom] = useState('');
  const [portailUrl, setPortailUrl] = useState('');
  const [canalError, setCanalError] = useState(false);

  const terms = customer.paymentTerms ?? null;
  const isPro = customer.type !== 'b2c';

  const openTerms = (): void => {
    setTermsDaysRaw(terms !== null ? String(terms.days) : '30');
    setTermsEom(terms?.endOfMonth === true);
    setTermsLabel(terms?.label ?? '');
    setTermsError(null);
    setTermsOpen(true);
  };
  const openCanal = (): void => {
    const channel = customer.billingChannel ?? null;
    setCanalType(billingChannelTypeOf(channel));
    setChorusCode(channel?.chorusServiceCode ?? '');
    setPortailNom(channel?.portailNom ?? '');
    setPortailUrl(channel?.portailUrl ?? '');
    setCanalError(false);
    setCanalOpen(true);
  };

  const parsedDays = parseTermsDaysInput(termsDaysRaw);
  const ceilingExceeded =
    parsedDays !== null && termsCeilingExceeded(customer.type, parsedDays, termsEom);
  const duePreview =
    parsedDays !== null && !ceilingExceeded
      ? previewDueDate(parsedDays, termsEom, parisDateOnly())
      : null;

  const saveTerms = (clear: boolean): void => {
    if (update.isPending) return;
    setTermsError(null);
    let patch: Parameters<typeof buildCustomerReplacementPayload>[1];
    if (clear) {
      patch = { clearPaymentTerms: true };
    } else {
      if (parsedDays === null || ceilingExceeded) {
        setTermsError(t('terms.saveError', { personality }));
        return;
      }
      const label =
        termsLabel.trim() !== ''
          ? termsLabel.trim()
          : describePaymentTerms({ days: parsedDays, endOfMonth: termsEom, label: '' }, personality);
      const nextTerms: CustomerPaymentTerms = { days: parsedDays, endOfMonth: termsEom, label };
      patch = { paymentTerms: nextTerms };
    }
    update.mutate(
      { id: customer.id, patch: buildCustomerReplacementPayload(customer, patch) },
      {
        onSuccess: () => setTermsOpen(false),
        onError: () => setTermsError(t('terms.saveError', { personality })),
      },
    );
  };

  const saveCanal = (): void => {
    if (update.isPending) return;
    setCanalError(false);
    const channel = buildBillingChannel({
      type: canalType,
      chorusServiceCode: chorusCode,
      portailNom,
      portailUrl,
    });
    update.mutate(
      { id: customer.id, patch: buildCustomerReplacementPayload(customer, { billingChannel: channel }) },
      {
        onSuccess: () => setCanalOpen(false),
        onError: () => setCanalError(true),
      },
    );
  };

  const editAction = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 10,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={[font('label', 700), { fontSize: 13, color: semantic.aiInk }]}>{label}</Text>
    </Pressable>
  );

  const fieldStyle = {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.ink800,
  } as const;

  return (
    <View>
      {/* ── B4 — Conditions de paiement ── */}
      <SectionHeader
        title={t('terms.sectionTitle', { personality })}
        action={editAction(t('terms.edit', { personality }), openTerms)}
      />
      <Card radius={18} padding={16} style={{ marginBottom: 16 }}>
        <Text style={[font('body', 700), { fontSize: 15, color: colors.ink900 }]}>
          {describePaymentTerms(terms, personality)}
        </Text>
        {terms !== null && terms.label.trim() !== '' ? (
          <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 3 }]}>
            {terms.label}
          </Text>
        ) : null}
        {isPro ? (
          <View style={{ marginTop: 8 }}>
            <LegalHint
              label={t('legal.terms.inline', { personality })}
              lawKey="legal.terms.law"
              whyKey="legal.terms.why"
              source="art. L441-10 et L441-16 du code de commerce"
            />
          </View>
        ) : null}
      </Card>

      {/* ── Canal de facturation ── */}
      <SectionHeader
        title={t('canal.sectionTitle', { personality })}
        action={editAction(t('canal.edit', { personality }), openCanal)}
      />
      <Card radius={18} padding={16}>
        <Text style={[font('body', 700), { fontSize: 15, color: colors.ink900 }]}>
          {describeBillingChannel(customer.billingChannel ?? null, personality)}
        </Text>
        <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 3 }]}>
          {t(CHANNEL_HINT[billingChannelTypeOf(customer.billingChannel ?? null)], { personality })}
        </Text>
      </Card>

      {/* ── PR-04 — Garde « BC obligatoire » (par client, désactivée par défaut) ── */}
      <SectionHeader
        title={t('poGuard.sectionTitle', { personality })}
        action={editAction(
          customer.requiresPurchaseOrder === true
            ? t('poGuard.disable', { personality })
            : t('poGuard.enable', { personality }),
          () => {
            if (update.isPending) return;
            update.mutate({
              id: customer.id,
              patch: buildCustomerReplacementPayload(customer, {
                requiresPurchaseOrder: customer.requiresPurchaseOrder !== true,
              }),
            });
          },
        )}
      />
      <Card radius={18} padding={16} style={{ marginTop: 0, marginBottom: 16 }}>
        <Text style={[font('body', 700), { fontSize: 15, color: colors.ink900 }]}>
          {t(customer.requiresPurchaseOrder === true ? 'poGuard.on' : 'poGuard.off', {
            personality,
          })}
        </Text>
        <Text style={[font('meta', 500), { fontSize: 12.5, color: colors.slate400, marginTop: 3 }]}>
          {t('poGuard.hint', { personality })}
        </Text>
        <View style={{ marginTop: 8 }}>
          <LegalHint
            label={t('legal.poGuard.inline', { personality })}
            lawKey="legal.poGuard.law"
            whyKey="legal.poGuard.why"
            source="EN 16931 (BT-13) · exigence des acheteurs publics et grands comptes (Chorus Pro : n° d'engagement)"
          />
        </View>
      </Card>

      {/* ── Feuille : conditions de paiement ── */}
      <Sheet
        visible={termsOpen}
        onClose={() => {
          if (!update.isPending) setTermsOpen(false);
        }}
        accessibilityLabel={t('terms.sheetTitle', { personality })}
      >
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]}>
          {t('terms.sheetTitle', { personality })}
        </Text>
        <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
          {t('terms.daysField', { personality }).toUpperCase()}
        </Text>
        <TextInput
          value={termsDaysRaw}
          onChangeText={setTermsDaysRaw}
          keyboardType="number-pad"
          accessibilityLabel={t('terms.daysField', { personality })}
          placeholder="30"
          placeholderTextColor={colors.slate300}
          style={[font('body'), fieldStyle, { marginTop: 7 }]}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <Chip
            label={t('terms.eomToggle', { personality })}
            active={termsEom}
            onPress={() => setTermsEom((v) => !v)}
          />
          <Text style={[font('meta', 500), { fontSize: 12, color: colors.slate400, flex: 1 }]}>
            {t('terms.eomHint', { personality })}
          </Text>
        </View>
        <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
          {t('terms.labelField', { personality }).toUpperCase()}
        </Text>
        <TextInput
          value={termsLabel}
          onChangeText={setTermsLabel}
          maxLength={120}
          accessibilityLabel={t('terms.labelField', { personality })}
          placeholder={describePaymentTerms(
            { days: parsedDays ?? 30, endOfMonth: termsEom, label: '' },
            personality,
          )}
          placeholderTextColor={colors.slate300}
          style={[font('body'), fieldStyle, { marginTop: 7 }]}
        />
        {isPro ? (
          <View style={{ marginTop: 10 }}>
            <LegalHint
              label={t('legal.terms.inline', { personality })}
              lawKey="legal.terms.law"
              whyKey="legal.terms.why"
              source="art. L441-10 et L441-16 du code de commerce"
            />
          </View>
        ) : null}
        {ceilingExceeded ? (
          <View
            style={{
              marginTop: 8,
              borderRadius: 12,
              backgroundColor: semantic.dangerBg,
              paddingVertical: 10,
              paddingHorizontal: 12,
            }}
          >
            <Text accessibilityRole="alert" style={[font('sub', 600), { color: semantic.danger, lineHeight: 19 }]}>
              {t('legal.terms.inline', { personality })}
            </Text>
          </View>
        ) : duePreview !== null ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[font('meta', 600), { fontSize: 12.5, color: semantic.success, marginTop: 10 }]}
          >
            {t('terms.dueAtIssuedNoLabel', { personality, params: { date: duePreview } })}
          </Text>
        ) : null}
        {termsError !== null ? (
          <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 8 }]}>
            {termsError}
          </Text>
        ) : null}
        <Button
          title={t('terms.edit', { personality })}
          loading={update.isPending}
          disabled={update.isPending || parsedDays === null || ceilingExceeded}
          style={{ marginTop: 14 }}
          onPress={() => saveTerms(false)}
        />
        {terms !== null ? (
          <Button
            title={t('terms.clear', { personality })}
            variant="secondary"
            disabled={update.isPending}
            style={{ marginTop: 8 }}
            onPress={() => saveTerms(true)}
          />
        ) : null}
      </Sheet>

      {/* ── Feuille : canal de facturation ── */}
      <Sheet
        visible={canalOpen}
        onClose={() => {
          if (!update.isPending) setCanalOpen(false);
        }}
        accessibilityLabel={t('canal.sheetTitle', { personality })}
      >
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]}>
          {t('canal.sheetTitle', { personality })}
        </Text>
        <View style={{ gap: 8 }}>
          {CHANNEL_TYPES.map((type) => {
            const selected = canalType === type;
            return (
              <Pressable
                key={type}
                accessibilityRole="radio"
                accessibilityLabel={t(CHANNEL_LABEL[type], { personality })}
                accessibilityState={{ selected }}
                onPress={() => setCanalType(type)}
                style={{
                  borderRadius: 14,
                  borderWidth: selected ? 2 : 1,
                  borderColor: selected ? colors.ink900 : controls.cardBorder,
                  backgroundColor: colors.surface,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  minHeight: 44,
                }}
              >
                <Text style={[font('label', 700), { fontSize: 14, color: colors.ink900 }]}>
                  {t(CHANNEL_LABEL[type], { personality })}
                </Text>
                <Text style={[font('meta'), { fontSize: 11.5, lineHeight: 15, color: colors.slate400, marginTop: 2 }]}>
                  {t(CHANNEL_HINT[type], { personality })}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {canalType === 'chorus' ? (
          <>
            <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 12 }]}>
              {t('canal.chorusServiceCode', { personality }).toUpperCase()}
            </Text>
            <TextInput
              value={chorusCode}
              onChangeText={setChorusCode}
              maxLength={100}
              autoCapitalize="none"
              accessibilityLabel={t('canal.chorusServiceCode', { personality })}
              placeholderTextColor={colors.slate300}
              style={[font('body'), fieldStyle, { marginTop: 7 }]}
            />
          </>
        ) : null}
        {canalType === 'portail' ? (
          <>
            <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 12 }]}>
              {t('canal.portailNom', { personality }).toUpperCase()}
            </Text>
            <TextInput
              value={portailNom}
              onChangeText={setPortailNom}
              maxLength={200}
              accessibilityLabel={t('canal.portailNom', { personality })}
              placeholderTextColor={colors.slate300}
              style={[font('body'), fieldStyle, { marginTop: 7 }]}
            />
            <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 12 }]}>
              {t('canal.portailUrl', { personality }).toUpperCase()}
            </Text>
            <TextInput
              value={portailUrl}
              onChangeText={setPortailUrl}
              maxLength={500}
              autoCapitalize="none"
              keyboardType="url"
              accessibilityLabel={t('canal.portailUrl', { personality })}
              placeholder="https://"
              placeholderTextColor={colors.slate300}
              style={[font('body'), fieldStyle, { marginTop: 7 }]}
            />
          </>
        ) : null}
        {canalError ? (
          <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 10 }]}>
            {t('canal.saveError', { personality })}
          </Text>
        ) : null}
        <Button
          title={t('canal.edit', { personality })}
          loading={update.isPending}
          disabled={update.isPending}
          style={{ marginTop: 14 }}
          onPress={saveCanal}
        />
      </Sheet>
    </View>
  );
}
