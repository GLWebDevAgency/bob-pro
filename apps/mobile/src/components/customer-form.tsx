import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Siret, validateFrenchVatId, type Address, type CustomerType } from '@bob/core';
import type { CreateCustomerClientInput } from '@bob/api-client';
import { t, type Personality } from '@bob/i18n';
import { Button, Chip, Skeleton, font, useTheme } from '@bob/ui';
import { useLookupCompany, useSearchAddress } from '../data/hooks';
import { formatSiret } from './CompanyFicheCard';
import { decideSiretLookupResult } from './customer-form-siret.logic';

const SEARCH_DEBOUNCE_MS = 350;
const TYPES: readonly CustomerType[] = ['b2c', 'b2b', 'b2g'];
const TYPE_LABEL_KEY = {
  b2c: 'clients.filterB2c',
  b2b: 'clients.filterB2b',
  b2g: 'clients.filterB2g',
} as const;

/** Pré-remplissage (édition) — un sous-ensemble de CreateCustomerClientInput + les 2 volets
 * du nom (prénom/nom) reconstitués depuis `name` par l'appelant, la fiche n'ayant PAS de champ
 * prénom séparé côté domaine (un seul champ `name`, cf. chaîne complète C13/C40 TODO partagé). */
export interface CustomerFormInitial {
  type: CustomerType;
  firstName: string;
  lastName: string;
  companyName: string;
  siren: string | null;
  siret: string | null;
  tvaIntracom: string | null;
  contactName: string;
  email: string;
  phone: string;
  address: Address | null;
  addressLabel: string;
}

const EMPTY_INITIAL: CustomerFormInitial = {
  type: 'b2c',
  firstName: '',
  lastName: '',
  companyName: '',
  siren: null,
  siret: null,
  tvaIntracom: null,
  contactName: '',
  email: '',
  phone: '',
  address: null,
  addressLabel: '',
};

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  autoCapitalize?: 'words' | 'none' | 'sentences' | 'characters';
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
  invalid?: boolean;
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = 'sentences',
  keyboardType = 'default',
  invalid = false,
}: FieldProps) {
  const { colors, semantic } = useTheme();
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
        {label.toUpperCase()}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.slate300}
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        style={[
          font('body'),
          {
            minHeight: 44,
            marginTop: 7,
            borderWidth: 1,
            borderColor: invalid ? semantic.danger : colors.lineSoft,
            borderRadius: 12,
            paddingHorizontal: 13,
            paddingVertical: 11,
            color: colors.ink800,
          },
        ]}
      />
    </View>
  );
}

/**
 * Formulaire client (C13/C40 TODO partagé) — champs adaptés au type, partagé entre création
 * (Sheet Clients) et édition (fiche client). Arbitrage fondateur révisé : AUCUN moyen de contact
 * n'est bloquant à la création — l'envoi de pièces passe par un lien partageable (Share natif),
 * pas par un email forcé. Seule l'identité (prénom+nom / raison sociale) est requise.
 */
export function CustomerForm({
  personality,
  initial,
  submitLabel,
  submitting,
  errorMessage,
  onSubmit,
}: {
  personality: Personality;
  initial?: CustomerFormInitial;
  submitLabel: string;
  submitting: boolean;
  errorMessage: string | null;
  onSubmit: (payload: CreateCustomerClientInput) => void;
}) {
  const { colors, semantic } = useTheme();
  const base = initial ?? EMPTY_INITIAL;
  const [type, setType] = useState<CustomerType>(base.type);
  const [firstName, setFirstName] = useState(base.firstName);
  const [lastName, setLastName] = useState(base.lastName);
  const [companyName, setCompanyName] = useState(base.companyName);
  const [siren, setSiren] = useState<string | null>(base.siren);
  const [tvaIntracom, setTvaIntracom] = useState(base.tvaIntracom ?? '');
  const [contactName, setContactName] = useState(base.contactName);
  const [email, setEmail] = useState(base.email);
  const [phone, setPhone] = useState(base.phone);
  const [addressQuery, setAddressQuery] = useState(base.addressLabel);
  const [selectedAddress, setSelectedAddress] = useState<Address | null>(base.address);
  // Vrai dès qu'une adresse est CHOISIE (suggestion BAN ou lookup SIRET) — évite de relancer une
  // recherche sur le texte affiché tant que l'utilisateur ne retape pas lui-même.
  const [addressLocked, setAddressLocked] = useState(base.address !== null);

  const [siret, setSiret] = useState(base.siret ?? '');
  const siretRef = useRef(base.siret ?? '');
  const lookupRequestIdRef = useRef(0);
  const [siretError, setSiretError] = useState(false);
  const [siretFound, setSiretFound] = useState<string | null>(null);
  // État administratif de l'ÉTABLISSEMENT retenu par l'annuaire ('F' = fermé). Un établissement
  // fermé n'est pas refusé — il reste facturable (facture finale, avoir) — mais il est annoncé.
  const [siretClosed, setSiretClosed] = useState(false);
  const [siretAddressMissing, setSiretAddressMissing] = useState(false);
  const [siretCandidateUnverified, setSiretCandidateUnverified] = useState(false);
  const lookup = useLookupCompany();
  const search = useSearchAddress();

  useEffect(() => {
    const query = addressQuery.trim();
    if (query.length < 3 || addressLocked) {
      search.reset();
      return;
    }
    const timeout = setTimeout(() => search.mutate(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [addressQuery, addressLocked]);

  const searchSiret = (): void => {
    const requestId = ++lookupRequestIdRef.current;
    setSiretError(false);
    setSiretFound(null);
    setSiretClosed(false);
    setSiretAddressMissing(false);
    const v = Siret.of(siret);
    if (!v.ok) {
      setSiretError(true);
      return;
    }
    const requestedSiret = v.value.value;
    lookup.mutate(requestedSiret, {
      onSuccess: (result) => {
        const decision = decideSiretLookupResult({
          requestId,
          latestRequestId: lookupRequestIdRef.current,
          requestedSiret,
          currentSiret: siretRef.current,
          result,
        });
        if (decision.kind === 'stale') return;
        if (decision.kind === 'identity_mismatch') {
          setSiretError(true);
          setSiretCandidateUnverified(true);
          return;
        }
        siretRef.current = decision.siret;
        setSiret(decision.siret);
        setCompanyName(decision.denomination);
        setSiren(decision.siren);
        setTvaIntracom(decision.tvaIntracom);
        setSiretFound(decision.denomination);
        setSiretClosed(decision.closed);
        setSiretAddressMissing(decision.addressMissing);
        setSiretCandidateUnverified(false);
        // Toujours remplacer les trois états d'adresse ensemble : `null` efface explicitement
        // l'adresse précédente et rouvre la saisie, jamais de repli silencieux.
        setSelectedAddress(decision.address);
        setAddressQuery(decision.addressLabel);
        setAddressLocked(decision.addressLocked);
      },
      onError: () => {
        if (
          requestId === lookupRequestIdRef.current &&
          siretRef.current === requestedSiret
        ) {
          setSiretError(true);
        }
      },
    });
  };

  const normalizedVat =
    type !== 'b2c' && tvaIntracom.trim() !== '' && siren !== null
      ? validateFrenchVatId(tvaIntracom, siren)
      : null;
  const vatValid =
    type === 'b2c' ||
    tvaIntracom.trim() === '' ||
    (siren !== null && normalizedVat?.ok === true);
  const identityValid =
    (type === 'b2c'
      ? firstName.trim() !== '' && lastName.trim() !== ''
      : companyName.trim() !== '') &&
    vatValid &&
    !siretCandidateUnverified;

  const submit = (): void => {
    if (!identityValid || submitting) return;
    const name = type === 'b2c' ? `${firstName.trim()} ${lastName.trim()}`.trim() : companyName.trim();
    onSubmit({
      type,
      name,
      address: selectedAddress ?? { line1: '', zip: '', city: '' },
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(type !== 'b2c' && siren ? { siren } : {}),
      ...(type !== 'b2c' && siret ? { siret } : {}),
      ...(type !== 'b2c' && normalizedVat?.ok === true
        ? { tvaIntracom: normalizedVat.value }
        : {}),
      ...(type !== 'b2c' && contactName.trim() ? { contactName: contactName.trim() } : {}),
    });
  };

  const showAddressResults =
    !addressLocked &&
    addressQuery.trim().length >= 3 &&
    search.variables === addressQuery.trim() &&
    search.isSuccess;

  return (
    <View>
      <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400 }]}>
        {t('clients.createTypeLabel', { personality }).toUpperCase()}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        {TYPES.map((key) => (
          <Chip
            key={key}
            label={t(TYPE_LABEL_KEY[key], { personality })}
            active={type === key}
            onPress={() => setType(key)}
          />
        ))}
      </View>

      {type === 'b2c' ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Field
              label={t('clients.createFirstNameLabel', { personality })}
              value={firstName}
              onChangeText={setFirstName}
              placeholder={t('clients.createFirstNamePlaceholder', { personality })}
              autoCapitalize="words"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label={t('clients.createLastNameLabel', { personality })}
              value={lastName}
              onChangeText={setLastName}
              placeholder={t('clients.createLastNamePlaceholder', { personality })}
              autoCapitalize="words"
            />
          </View>
        </View>
      ) : (
        <>
          <Field
            label={t('clients.createCompanyNameLabel', { personality })}
            value={companyName}
            onChangeText={(v) => {
              setCompanyName(v);
              setSiretFound(null);
              setSiretClosed(false);
            }}
            placeholder={t('clients.createCompanyNamePlaceholder', { personality })}
            autoCapitalize="words"
          />

          <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
            {t('clients.createSiretLabel', { personality }).toUpperCase()}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 7, alignItems: 'center' }}>
            <TextInput
              value={formatSiret(siret)}
              onChangeText={(raw) => {
                const next = raw.replace(/\D/g, '').slice(0, 14);
                // Toute frappe invalide immédiatement la réponse en vol, sans bloquer le champ.
                lookupRequestIdRef.current += 1;
                siretRef.current = next;
                setSiret(next);
                // Une saisie de recherche ne remplace jamais la fiche persistée avant succès.
                // Tant qu'elle n'est pas vérifiée, on bloque Enregistrer plutôt que d'effacer
                // silencieusement le SIREN/TVA existant ou d'envoyer l'ancien avec le nouveau.
                setSiretCandidateUnverified(next.length > 0);
                setSiretFound(null);
                setSiretClosed(false);
                setSiretAddressMissing(false);
                setSiretError(false);
              }}
              placeholder={t('clients.createSiretPlaceholder', { personality })}
              placeholderTextColor={colors.slate300}
              accessibilityLabel={t('clients.createSiretLabel', { personality })}
              keyboardType="number-pad"
              style={[
                font('body'),
                {
                  flex: 1,
                  minHeight: 44,
                  borderWidth: 1,
                  borderColor: siretError ? semantic.danger : colors.lineSoft,
                  borderRadius: 12,
                  paddingHorizontal: 13,
                  paddingVertical: 11,
                  color: colors.ink800,
                },
              ]}
            />
            <Button
              title={t('clients.createSiretSearch', { personality })}
              variant="secondary"
              size="compact"
              loading={lookup.isPending}
              disabled={siret.length !== 14}
              onPress={searchSiret}
            />
          </View>
          {lookup.isPending ? (
            <View style={{ marginTop: 8 }}>
              <Skeleton height={13} width="70%" radius={6} />
            </View>
          ) : siretError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[font('sub'), { color: semantic.danger, marginTop: 8 }]}
            >
              {t('clients.createSiretError', { personality })}
            </Text>
          ) : siretFound !== null ? (
            <>
              <Text
                accessibilityLiveRegion="polite"
                style={[font('sub'), { color: semantic.success, marginTop: 8 }]}
              >
                {t('clients.createSiretFound', { personality, params: { name: siretFound } })}
              </Text>
              {siretClosed ? (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  style={{
                    marginTop: 8,
                    borderWidth: 1,
                    borderColor: semantic.warning,
                    borderRadius: 10,
                    backgroundColor: semantic.warningBg,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                >
                  <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]}>
                    {t('clients.createSiretClosed', { personality })}
                  </Text>
                </View>
              ) : null}
              {siretAddressMissing ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 8 }]}
                >
                  {t('clients.createSiretAddressMissing', { personality })}
                </Text>
              ) : null}
            </>
          ) : null}

          <Field
            label={t('clients.createTvaLabel', { personality })}
            value={tvaIntracom}
            onChangeText={setTvaIntracom}
            placeholder={t('clients.createTvaPlaceholder', { personality })}
            autoCapitalize="characters"
            invalid={!vatValid}
          />
          <Text
            accessibilityRole={!vatValid ? 'alert' : undefined}
            style={[
              font('sub'),
              { color: !vatValid ? semantic.danger : colors.slate400, lineHeight: 18, marginTop: 7 },
            ]}
          >
            {t(!vatValid ? 'clients.createTvaInvalid' : 'clients.createTvaHint', { personality })}
          </Text>

          <Field
            label={t('clients.createContactNameLabel', { personality })}
            value={contactName}
            onChangeText={setContactName}
            placeholder={t('clients.createContactNamePlaceholder', { personality })}
            autoCapitalize="words"
          />
        </>
      )}

      <Field
        label={t('clients.createEmailLabel', { personality })}
        value={email}
        onChangeText={setEmail}
        placeholder={t('clients.createEmailPlaceholder', { personality })}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Field
        label={t('clients.createPhoneLabel', { personality })}
        value={phone}
        onChangeText={setPhone}
        placeholder={t('clients.createPhonePlaceholder', { personality })}
        keyboardType="phone-pad"
      />
      <Text style={[font('sub'), { color: colors.slate400, lineHeight: 18, marginTop: 7 }]}>
        {t('clients.createContactHint', { personality })}
      </Text>

      <Text style={[font('label', 700), { fontSize: 12, color: colors.slate400, marginTop: 14 }]}>
        {t('clients.createAddressLabel', { personality }).toUpperCase()}
      </Text>
      <TextInput
        value={addressQuery}
        onChangeText={(v) => {
          setAddressQuery(v);
          setSelectedAddress(null);
          setAddressLocked(false);
        }}
        placeholder={t('clients.createAddressPlaceholder', { personality })}
        placeholderTextColor={colors.slate300}
        accessibilityLabel={t('clients.createAddressLabel', { personality })}
        style={[
          font('body'),
          {
            minHeight: 44,
            marginTop: 7,
            borderWidth: 1,
            borderColor: colors.lineSoft,
            borderRadius: 12,
            paddingHorizontal: 13,
            paddingVertical: 11,
            color: colors.ink800,
          },
        ]}
      />
      {search.isPending && search.variables === addressQuery.trim() ? (
        <View accessibilityLiveRegion="polite" style={{ marginTop: 9, gap: 6 }}>
          <Skeleton height={13} width="88%" radius={6} />
        </View>
      ) : showAddressResults ? (
        (search.data ?? []).length > 0 ? (
          <View accessibilityLiveRegion="polite" style={{ marginTop: 7, gap: 2 }}>
            {(search.data ?? []).map((suggestion, index) => (
              <Pressable
                key={`${suggestion.label}-${index}`}
                accessibilityRole="button"
                accessibilityLabel={suggestion.label}
                onPress={() => {
                  setSelectedAddress(suggestion);
                  setAddressQuery(suggestion.label);
                  setAddressLocked(true);
                  search.reset();
                }}
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 7 }}
              >
                <Text style={[font('sub'), { color: colors.ink800 }]}>{suggestion.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={[font('sub'), { color: colors.slate500, marginTop: 9 }]}>
            {t('chantiers.addressNoResult', { personality })}
          </Text>
        )
      ) : null}

      {errorMessage ? (
        <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger, marginTop: 12 }]}>
          {errorMessage}
        </Text>
      ) : null}

      <Button
        title={submitLabel}
        variant="primary"
        disabled={!identityValid}
        loading={submitting}
        style={{ marginTop: 16 }}
        onPress={submit}
      />
    </View>
  );
}
