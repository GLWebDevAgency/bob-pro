/**
 * PR-09 « Le métier » — carte « Contacts » de la fiche client (exigence 1) : plusieurs
 * personnes jointes par fiche (demandeur, valideur, compta…), rôle porté par un label LIBRE.
 * Liste / ajout / édition / suppression — MÊMES use cases que Bob (parité humain↔Bob) ;
 * le choix du destinataire à l'ENVOI d'une pièce vit dans la feuille d'envoi (DocumentActions),
 * jamais ici. États 4 niveaux (skeleton / erreur / vide / données) — aucun repli inventé.
 */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { challengeFor } from '@bob/ai';
import { t } from '@bob/i18n';
import {
  Button,
  Card,
  EmptyState,
  ErrorRetry,
  Sheet,
  SkeletonRow,
  font,
  useTheme,
} from '@bob/ui';
import type { CustomerContactView } from '@bob/api-client';
import {
  appErrorMessage,
  useCreateCustomerContact,
  useCustomerContacts,
  useDeleteCustomerContact,
  useUpdateCustomerContact,
} from '../data/hooks';
import { useConfirm } from './ConfirmSheet';

interface ContactFormState {
  label: string;
  name: string;
  email: string;
  phone: string;
}

const EMPTY_FORM: ContactFormState = { label: '', name: '', email: '', phone: '' };

/** Suppression d'un contact : mutation réversible (recréable) — palier de confirmation standard. */
const REVERSIBLE = { mutating: true, outbound: false, riskTier: 'reversible' } as const;

export function CustomerContactsCard({ customerId }: { customerId: string }) {
  const { colors, semantic, personality } = useTheme();
  const confirm = useConfirm();
  const contacts = useCustomerContacts(customerId);
  const createContact = useCreateCustomerContact(customerId);
  const updateContact = useUpdateCustomerContact(customerId);
  const deleteContact = useDeleteCustomerContact(customerId);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerContactView | null>(null);
  const [form, setForm] = useState<ContactFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setSheetOpen(true);
  };
  const openEdit = (contact: CustomerContactView): void => {
    setEditing(contact);
    setForm({
      label: contact.label,
      name: contact.name,
      email: contact.email ?? '',
      phone: contact.phone ?? '',
    });
    setFormError(null);
    setSheetOpen(true);
  };
  const closeSheet = (): void => {
    if (createContact.isPending || updateContact.isPending) return;
    setSheetOpen(false);
  };

  const submit = async (): Promise<void> => {
    if (createContact.isPending || updateContact.isPending) return;
    setFormError(null);
    const patch = {
      label: form.label,
      name: form.name,
      email: form.email.trim().length > 0 ? form.email.trim() : null,
      phone: form.phone.trim().length > 0 ? form.phone.trim() : null,
    };
    try {
      if (editing === null) await createContact.mutateAsync(patch);
      else await updateContact.mutateAsync({ contactId: editing.id, patch });
      setSheetOpen(false);
    } catch (error) {
      // 422 serveur (label/nom requis, e-mail difforme) affiché TEL QUEL — état honnête.
      setFormError(appErrorMessage(error));
    }
  };

  const removeContact = async (contact: CustomerContactView): Promise<void> => {
    const ok = await confirm({
      title: t('contacts.deleteConfirmTitle', { personality }),
      message: t('contacts.deleteConfirmBody', {
        personality,
        params: { name: contact.name },
      }),
      challenge: challengeFor(REVERSIBLE, 'confirm_all'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteContact.mutateAsync(contact.id);
    } catch {
      // L'invalidation de la query racontera l'état réel ; pas de toast fantôme.
    }
  };

  const fieldStyle = {
    minHeight: 44,
    marginTop: 7,
    borderWidth: 1,
    borderColor: colors.lineSoft,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.ink800,
  } as const;

  const fieldLabel = (key: Parameters<typeof t>[0]): string =>
    t(key, { personality }).toUpperCase();

  return (
    <Card radius={18} padding={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink800 }]}>
          {t('contacts.title', { personality })}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('contacts.addCta', { personality })}
          onPress={openCreate}
          hitSlop={8}
          style={({ pressed }) => [{ minHeight: 32, justifyContent: 'center' }, pressed && { opacity: 0.6 }]}
        >
          <Text style={[font('label', 700), { fontSize: 13.5, color: colors.ink600 }]}>
            {t('contacts.addCta', { personality })}
          </Text>
        </Pressable>
      </View>
      <Text style={[font('meta'), { fontSize: 12, color: colors.slate400, lineHeight: 16, marginTop: 4 }]}>
        {t('contacts.hint', { personality })}
      </Text>

      {contacts.isLoading ? (
        <View style={{ marginTop: 12 }}>
          <SkeletonRow avatar={false} lines={2} trailing={false} />
        </View>
      ) : contacts.isError ? (
        <View style={{ marginTop: 12 }}>
          <ErrorRetry
            message={t('contacts.dataError', { personality })}
            onRetry={() => void contacts.refetch()}
            retrying={contacts.isRefetching}
          />
        </View>
      ) : (contacts.data ?? []).length === 0 ? (
        <View style={{ marginTop: 12 }}>
          <EmptyState
            body={t('contacts.empty', { personality })}
            cta={{ label: t('contacts.addCta', { personality }), onPress: openCreate }}
          />
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {(contacts.data ?? []).map((contact, index, rows) => (
            <Pressable
              key={contact.id}
              accessibilityRole="button"
              accessibilityLabel={`${contact.label} · ${contact.name}${contact.email ? ` · ${contact.email}` : ''}`}
              accessibilityHint={t('contacts.rowHint', { personality })}
              onPress={() => openEdit(contact)}
              onLongPress={() => void removeContact(contact)}
              style={({ pressed }) => [
                {
                  minHeight: 52,
                  paddingVertical: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                  borderBottomColor: colors.lineSoft,
                },
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text accessible={false} style={[font('sub', 700), { color: colors.ink800 }]} numberOfLines={1}>
                  {contact.name}
                </Text>
                <Text accessible={false} style={[font('meta'), { color: colors.slate400, marginTop: 2 }]} numberOfLines={1}>
                  {contact.label}
                  {contact.email ? ` · ${contact.email}` : ''}
                  {contact.phone ? ` · ${contact.phone}` : ''}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {/* ── Feuille ajout/édition — même formulaire, remplacement complet revalidé serveur ── */}
      <Sheet visible={sheetOpen} onClose={closeSheet}>
        <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
            {t(editing === null ? 'contacts.createTitle' : 'contacts.editTitle', { personality })}
          </Text>

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
            {fieldLabel('contacts.fieldLabel')}
          </Text>
          <TextInput
            value={form.label}
            onChangeText={(label) => setForm((current) => ({ ...current, label }))}
            placeholder={t('contacts.fieldLabelPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('contacts.fieldLabel', { personality })}
            style={[font('body'), fieldStyle]}
          />

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 12 }]}>
            {fieldLabel('contacts.fieldName')}
          </Text>
          <TextInput
            value={form.name}
            onChangeText={(name) => setForm((current) => ({ ...current, name }))}
            placeholder={t('contacts.fieldNamePlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('contacts.fieldName', { personality })}
            style={[font('body'), fieldStyle]}
          />

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 12 }]}>
            {fieldLabel('contacts.fieldEmail')}
          </Text>
          <TextInput
            value={form.email}
            onChangeText={(email) => setForm((current) => ({ ...current, email }))}
            placeholder={t('contacts.fieldEmailPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            keyboardType="email-address"
            autoCapitalize="none"
            accessibilityLabel={t('contacts.fieldEmail', { personality })}
            style={[font('body'), fieldStyle]}
          />

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 12 }]}>
            {fieldLabel('contacts.fieldPhone')}
          </Text>
          <TextInput
            value={form.phone}
            onChangeText={(phone) => setForm((current) => ({ ...current, phone }))}
            placeholder={t('contacts.fieldPhonePlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            keyboardType="phone-pad"
            accessibilityLabel={t('contacts.fieldPhone', { personality })}
            style={[font('body'), fieldStyle]}
          />

          {formError !== null ? (
            <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 10 }]}>
              {formError}
            </Text>
          ) : null}

          <View style={{ marginTop: 16, gap: 10 }}>
            <Button
              title={t(editing === null ? 'contacts.createCta' : 'contacts.saveCta', { personality })}
              loading={createContact.isPending || updateContact.isPending}
              onPress={() => void submit()}
            />
            {editing !== null ? (
              <Button
                title={t('contacts.deleteCta', { personality })}
                variant="secondary"
                disabled={createContact.isPending || updateContact.isPending || deleteContact.isPending}
                onPress={() => {
                  const target = editing;
                  setSheetOpen(false);
                  if (target !== null) void removeContact(target);
                }}
              />
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Sheet>
    </Card>
  );
}
