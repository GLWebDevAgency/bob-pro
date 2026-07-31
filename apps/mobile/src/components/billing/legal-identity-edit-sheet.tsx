/**
 * LegalIdentityEditSheet — édition de l'identité légale imprimée et BLOQUANTE pour l'émission
 * (Réglages facturation §Identité sur les factures, PATCH /company/legal).
 *
 * POURQUOI CET ÉCRAN EXISTE : `Company.assertCanIssue()` (@bob/core) exige, avant toute
 * émission : `rcsOrRm` (art. R123-237 c. com.), l'adresse COMPLÈTE du siège (rue + code postal
 * + ville), le capital social pour une société (art. R123-238 c. com.) et le n° de TVA
 * intracommunautaire hors franchise. Ces données sont provisionnées par le lookup SIRET… qui ne
 * les fournit pas toutes (jamais le capital). Sans champ pour les saisir, le gate « entreprise
 * incomplète » était un cul-de-sac : aucune pièce émissible à vie (bug 20/07 pour RCS/adresse,
 * bug FLY SERVICES 30/07 pour le capital d'une SAS). Cette feuille est la sortie — TOUTES les
 * exigences d'identité du domaine s'éditent ici, et le verrou anti-récidive de
 * document-gates.logic.test.ts casse si l'une d'elles perd son éditeur.
 *
 * MÊME PATRON PREMIUM que IbanEditSheet (feuille @bob/ui, jamais d'Alert natif) : titre, corps,
 * champs ≥ 44 pt, erreurs inline, bandeau d'échec réseau, boutons Enregistrer / Annuler.
 *
 * DOCTRINE « hypothèse de Bob, à confirmer » (identique au profil fiscal) : pour une société
 * commerciale, Bob PROPOSE « <SIREN> RCS <Ville> » dérivé par `suggestRegistrationNumber`
 * (@bob/core — règle légale, donc domaine). La valeur n'est JAMAIS posée en silence : elle
 * s'affiche dans un encart avec son avertissement (le greffe n'est pas toujours la ville du
 * siège) et un bouton explicite « Utiliser cette valeur ». Pour un artisan au répertoire des
 * métiers, aucune valeur n'est proposée — seul le format est rappelé.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Company, suggestRegistrationNumber, type CompanyProps } from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { Button, LegalHint, Sheet, font, useTheme } from '@bob/ui';
import { useUpdateCompanyLegal } from '../../data/hooks';
import { formatCentsForEuroInput } from '../../finance/parse-euro-amount';
import {
  buildLegalIdentityPatch,
  canSaveLegalIdentity,
  legalIdentityErrors,
  type LegalIdentityValues,
} from './legal-identity-edit.logic';

export interface LegalIdentityEditSheetProps {
  readonly visible: boolean;
  readonly company: CompanyProps;
  readonly personality: Personality;
  readonly onClose: () => void;
}

const valuesOf = (company: CompanyProps): LegalIdentityValues => ({
  rcsOrRm: company.rcsOrRm ?? '',
  tvaIntracom: company.tvaIntracom ?? '',
  // Centimes → euros EXACTS avec virgule française (« 10000,50 ») — arithmétique entière,
  // même aller-retour que le solde bancaire (BankBalanceSheet).
  capitalSocialEuros:
    company.capitalSocialCents === undefined
      ? ''
      : formatCentsForEuroInput(company.capitalSocialCents),
  line1: company.address.line1 ?? '',
  zip: company.address.zip ?? '',
  city: company.address.city ?? '',
});

export function LegalIdentityEditSheet({
  visible,
  company,
  personality,
  onClose,
}: LegalIdentityEditSheetProps) {
  const { colors, semantic } = useTheme();
  const updateLegal = useUpdateCompanyLegal();
  const current = valuesOf(company);
  const [values, setValues] = useState<LegalIdentityValues>(current);
  const [touched, setTouched] = useState(false);
  // Le DOMAINE décide si un capital est exigé (`isSociete()` — art. R123-238) : l'écran ne
  // connaît aucune forme juridique. `Company.of` ne peut échouer qu'avec une fiche serveur
  // incohérente ; on retombe alors sur « pas de champ capital » — l'émission reste de toute
  // façon fermée par le gate (companyCanIssue, fail-closed).
  const domainCompany = useMemo(() => Company.of(company), [company]);
  const capitalRequired = domainCompany.ok && domainCompany.value.isSociete();
  const legalContext = {
    siren: company.siren,
    vatRequired: company.vatRegime !== 'franchise',
    capitalRequired,
  };

  useEffect(() => {
    if (visible) {
      setValues(valuesOf(company));
      setTouched(false);
      updateLegal.reset();
    }
    // La fiche société peut se rafraîchir pendant que la feuille est fermée : on ne réarme
    // qu'à l'OUVERTURE, jamais sous les doigts de l'utilisateur en pleine saisie.
  }, [visible]);

  const say = (key: I18nKey) => t(key, { personality });
  const errors = legalIdentityErrors(values, legalContext);
  const busy = updateLegal.isPending;
  const canSave =
    canSaveLegalIdentity(values, legalContext) &&
    buildLegalIdentityPatch(current, values, legalContext) !== null;

  // Hypothèse dérivée dans le DOMAINE — l'écran ne calcule rien. La ville proposée est celle du
  // siège SAISIE (pas celle en base) : si l'utilisateur corrige sa ville, l'hypothèse suit.
  const suggestion = suggestRegistrationNumber({
    legalForm: company.legalForm,
    siret: company.siret,
    city: values.city,
  });
  // On ne propose que si le champ ne porte pas DÉJÀ cette valeur (sinon l'encart est du bruit).
  const showRcsSuggestion =
    suggestion !== null &&
    suggestion.value !== null &&
    values.rcsOrRm.trim() !== suggestion.value;

  const handleClose = (): void => {
    if (!busy) onClose();
  };

  const handleSave = async (): Promise<void> => {
    const patch = buildLegalIdentityPatch(current, values, legalContext);
    if (patch === null || busy) return;
    try {
      await updateLegal.mutateAsync(patch);
      onClose();
    } catch {
      // Échec affiché via updateLegal.isError ci-dessous — jamais un Alert natif.
    }
  };

  const fieldStyle = (invalid: boolean) => [
    font('body'),
    {
      minHeight: 44,
      color: colors.ink900,
      borderWidth: 1,
      borderColor: invalid ? semantic.danger : colors.line,
      borderRadius: 12,
      paddingHorizontal: 12,
      marginBottom: 6,
    },
  ];

  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      accessibilityLabel={say('reglages.legalSheetTitle')}
      closeAccessibilityLabel={say('reglages.legalSheetCancel')}
    >
      <Text
        accessibilityRole="header"
        style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
      >
        {say('reglages.legalSheetTitle')}
      </Text>
      <Text style={[font('body'), { color: colors.slate500, lineHeight: 20, marginBottom: 12 }]}>
        {say('reglages.legalSheetBody')}
      </Text>

      {/* PÉDAGOGIE LÉGALE AU POINT DE DÉCISION (doctrine LegalHint) : pourquoi ce numéro est
          obligatoire, en une phrase bénéfice + source citée, dépliable en 2 blocs. */}
      <View style={{ marginBottom: 14 }}>
        <LegalHint
          label={say('legal.rcs.inline')}
          lawKey="legal.rcs.law"
          whyKey="legal.rcs.why"
          source="art. R123-237 du code de commerce"
        />
      </View>

      <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.ink800, marginBottom: 6 }]}>
        {say('reglages.legalSheetRcsLabel')}
      </Text>
      <TextInput
        value={values.rcsOrRm}
        onChangeText={(next) => {
          setValues((v) => ({ ...v, rcsOrRm: next }));
          setTouched(true);
        }}
        onBlur={() => setTouched(true)}
        editable={!busy}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder={suggestion?.placeholder ?? ''}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={say('reglages.legalSheetRcsLabel')}
        style={fieldStyle(touched && errors.rcsOrRm)}
      />
      {touched && errors.rcsOrRm ? (
        <Text style={[font('meta', 600), { color: semantic.danger, marginBottom: 10 }]}>
          {say('reglages.legalSheetRcsInvalid')}
        </Text>
      ) : null}

      <Text
        style={[
          font('sub', 600),
          { fontSize: 13.5, color: colors.ink800, marginBottom: 6, marginTop: 4 },
        ]}
      >
        {say('reglages.legalSheetTvaLabel')}
      </Text>
      <TextInput
        value={values.tvaIntracom}
        onChangeText={(next) => {
          setValues((v) => ({ ...v, tvaIntracom: next }));
          setTouched(true);
        }}
        onBlur={() => setTouched(true)}
        editable={!busy}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder={say('reglages.legalSheetTvaPlaceholder')}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={say('reglages.legalSheetTvaLabel')}
        style={fieldStyle(touched && errors.tvaIntracom)}
      />
      <Text
        style={[
          font('meta', touched && errors.tvaIntracom ? 600 : 500),
          {
            color: touched && errors.tvaIntracom ? semantic.danger : colors.slate400,
            lineHeight: 17,
            marginBottom: 10,
          },
        ]}
      >
        {say(
          touched && errors.tvaIntracom
            ? 'reglages.legalSheetTvaInvalid'
            : legalContext.vatRequired
              ? 'reglages.legalSheetTvaRequiredHint'
              : 'reglages.legalSheetTvaOptionalHint',
        )}
      </Text>

      {/* Hypothèse RCS — encart PROPOSÉ, jamais appliqué tout seul. */}
      {showRcsSuggestion && suggestion?.value ? (
        <View
          style={{
            backgroundColor: semantic.successBg,
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <Text style={[font('sub', 700), { fontSize: 13.5, color: colors.ink800 }]}>
            {t('reglages.legalSuggestRcsLabel', {
              personality,
              params: { value: suggestion.value },
            })}
          </Text>
          <Text
            style={[font('meta'), { color: colors.slate500, lineHeight: 17, marginTop: 5 }]}
          >
            {say('reglages.legalSuggestRcsHint')}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${say('reglages.legalSuggestApply')} : ${suggestion.value}`}
            disabled={busy}
            onPress={() => {
              setValues((v) => ({ ...v, rcsOrRm: suggestion.value ?? v.rcsOrRm }));
              setTouched(true);
            }}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              marginTop: 6,
              opacity: pressed || busy ? 0.6 : 1,
            })}
          >
            <Text style={[font('label', 700), { fontSize: 13.5, color: semantic.success }]}>
              {say('reglages.legalSuggestApply')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Artisan au répertoire des métiers : aucune valeur dérivable — seul le format est dit. */}
      {suggestion?.registry === 'rm' ? (
        <Text
          style={[font('meta'), { color: colors.slate400, lineHeight: 17, marginBottom: 12 }]}
        >
          {t('reglages.legalSuggestRmHint', {
            personality,
            params: { placeholder: suggestion.placeholder },
          })}
        </Text>
      ) : null}

      {/* Capital social — SOCIÉTÉS UNIQUEMENT (capitalRequired, décidé par le domaine) : une
          EI/micro n'a pas de capital, lui montrer ce champ serait un mensonge d'interface.
          Saisie en euros, conversion en centimes par arithmétique entière (jamais de flottant),
          aucune valeur déduite de l'annuaire : le montant vient des statuts, saisi par l'humain. */}
      {capitalRequired ? (
        <>
          <Text
            style={[
              font('sub', 600),
              { fontSize: 13.5, color: colors.ink800, marginBottom: 6, marginTop: 4 },
            ]}
          >
            {say('reglages.legalSheetCapitalLabel')}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: 44,
              borderWidth: 1,
              borderColor: touched && errors.capitalSocial ? semantic.danger : colors.line,
              borderRadius: 12,
              paddingHorizontal: 12,
              marginBottom: 6,
            }}
          >
            <TextInput
              value={values.capitalSocialEuros}
              onChangeText={(next) => {
                setValues((v) => ({ ...v, capitalSocialEuros: next }));
                setTouched(true);
              }}
              onBlur={() => setTouched(true)}
              editable={!busy}
              keyboardType="decimal-pad"
              placeholder={say('reglages.legalSheetCapitalPlaceholder')}
              placeholderTextColor={colors.slate400}
              accessibilityLabel={say('reglages.legalSheetCapitalLabel')}
              style={[font('body'), { flex: 1, minHeight: 42, color: colors.ink900 }]}
            />
            <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.slate400 }]}>€</Text>
          </View>
          <Text
            style={[
              font('meta', touched && errors.capitalSocial ? 600 : 500),
              {
                color: touched && errors.capitalSocial ? semantic.danger : colors.slate400,
                lineHeight: 17,
                marginBottom: 10,
              },
            ]}
          >
            {say(
              touched && errors.capitalSocial
                ? 'reglages.legalSheetCapitalInvalid'
                : 'reglages.legalSheetCapitalHint',
            )}
          </Text>
        </>
      ) : null}

      <Text
        style={[
          font('sub', 600),
          { fontSize: 13.5, color: colors.ink800, marginBottom: 6, marginTop: 4 },
        ]}
      >
        {say('reglages.legalSheetAddressLabel')}
      </Text>
      <TextInput
        value={values.line1}
        onChangeText={(next) => {
          setValues((v) => ({ ...v, line1: next }));
          setTouched(true);
        }}
        onBlur={() => setTouched(true)}
        editable={!busy}
        placeholder={say('reglages.legalSheetLine1Placeholder')}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={say('reglages.legalSheetLine1Label')}
        style={fieldStyle(touched && errors.line1)}
      />
      {touched && errors.line1 ? (
        <Text style={[font('meta', 600), { color: semantic.danger, marginBottom: 6 }]}>
          {say('reglages.legalSheetLine1Invalid')}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ width: 116 }}>
          <TextInput
            value={values.zip}
            onChangeText={(next) => {
              setValues((v) => ({ ...v, zip: next }));
              setTouched(true);
            }}
            onBlur={() => setTouched(true)}
            editable={!busy}
            keyboardType="number-pad"
            placeholder={say('reglages.legalSheetZipPlaceholder')}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={say('reglages.legalSheetZipLabel')}
            style={fieldStyle(touched && errors.zip)}
          />
        </View>
        <View style={{ flex: 1 }}>
          <TextInput
            value={values.city}
            onChangeText={(next) => {
              setValues((v) => ({ ...v, city: next }));
              setTouched(true);
            }}
            onBlur={() => setTouched(true)}
            editable={!busy}
            placeholder={say('reglages.legalSheetCityPlaceholder')}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={say('reglages.legalSheetCityLabel')}
            style={fieldStyle(touched && errors.city)}
          />
        </View>
      </View>
      {/* Le code postal est exigé par assertCanIssue (adresse complète) — son erreur s'affiche
          sous la rangée CP + ville, au même patron que les autres champs. */}
      {touched && errors.zip ? (
        <Text style={[font('meta', 600), { color: semantic.danger, marginBottom: 6 }]}>
          {say('reglages.legalSheetZipInvalid')}
        </Text>
      ) : null}
      {touched && errors.city ? (
        <Text style={[font('meta', 600), { color: semantic.danger, marginBottom: 6 }]}>
          {say('reglages.legalSheetCityInvalid')}
        </Text>
      ) : null}

      {updateLegal.isError ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{
            marginTop: 6,
            marginBottom: 12,
            borderRadius: 12,
            padding: 10,
            backgroundColor: semantic.dangerBg,
          }}
        >
          <Text style={[font('meta', 600), { color: semantic.danger }]}>
            {say('reglages.legalSheetError')}
          </Text>
        </View>
      ) : (
        <View style={{ marginBottom: 12 }} />
      )}

      <Button
        title={say('reglages.legalSheetSave')}
        variant="primary"
        loading={busy}
        disabled={!canSave || busy}
        onPress={() => void handleSave()}
      />
      <View style={{ marginTop: 8 }}>
        <Button
          title={say('reglages.legalSheetCancel')}
          variant="secondary"
          disabled={busy}
          onPress={handleClose}
        />
      </View>
    </Sheet>
  );
}
