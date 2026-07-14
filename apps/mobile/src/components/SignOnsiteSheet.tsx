/**
 * SignOnsiteSheet (R4) — signature au doigt depuis le DÉTAIL d'un devis envoyé/vu (statut
 * sent/viewed), ouverte par le choix « Sur place » de QuoteActions (ou l'affordance vocale
 * « fais signer sur place » — QuoteActionsHandle.openSignOnsite). Réutilise SignaturePad de
 * @bob/ui exactement comme le wizard devis/new.tsx (étape signature) : même pad, mêmes clés
 * i18n devis.sign* (placeholder/effacer/nom du signataire).
 *
 * PREUVE (P0 R4 « le pad ne signe pas ce qu'il affiche » — fermé côté domaine) : le tracé du pad
 * (SignaturePadValue.dataUrl) est TRANSMIS avec la signature ; le SERVEUR en calcule le SHA-256
 * et persiste { method: 'onsite_draw', sha256, capturedAt } (Signature.proof, colonne
 * quotes.signatureProof). Le dataURL lui-même n'est PAS stocké en V1 — le hash + méta prouvent
 * l'intégrité du tracé reçu ; l'ARCHIVAGE de l'image est l'évolution suivante. Ceci reste une
 * signature « simple » au sens eIDAS (jamais présentée comme avancée/qualifiée) : pas encore de
 * hash lié à la version canonique du devis ni de journal d'audit dédié.
 *
 * MODE PASSAGE CLIENT (challenge GPT 20260714, P0 « le passage du téléphone au client n'est pas
 * isolé ») — quand l'artisan tend son téléphone, l'app doit être ISOLÉE le temps de la signature :
 *
 * 1. Plein écran NON dismissible : `Modal` RN natif (pas le `Sheet` bottom-sheet partagé — celui-
 *    ci reste dismissible par le scrim/l'échap accessibilité, exactement ce que le challenge
 *    reproche). `presentationStyle="fullScreen"` retire nativement le geste de swipe-to-dismiss
 *    iOS (présent sur pageSheet/formSheet, absent sur fullScreen). Aucun scrim cliquable, aucune
 *    croix de fermeture : la seule sortie est l'appui long propriétaire (point 3). Android : le
 *    bouton back matériel est intercepté par DEUX filets — `onRequestClose` (no-op, contrat RN)
 *    ET un `BackHandler` explicite qui renvoie `true` (« traité, ne rien faire d'autre ») tant que
 *    le mode est visible — défense en profondeur demandée explicitement par le brief.
 * 2. Bob/micro suspendus : `useAgentSession().stop()` est appelé à l'ENTRÉE du mode si une session
 *    globale est active (jamais relancée automatiquement — aucun `start()` n'est appelé ici).
 *    Le bouton micro global (GlobalBobAccess) est masqué via le mécanisme CONTEXTE déjà existant
 *    (`usePublishAgentContext(..., { hidden: true })`, agent-context.tsx) : `OnsiteModeAgentGuard`
 *    publie un contexte STABLE (module-level, jamais recréé) avec layout.hidden=true tant qu'il
 *    reste monté. `AgentContextProvider` résout `hidden` par OU sur TOUTES les publications
 *    encore montées (pas seulement la dernière, agent-context.tsx) — un écran parent qui republie
 *    son propre contexte pendant l'isolation (ex. refetch qui recrée `agentLayout`) ne peut donc
 *    plus réafficher le bouton tant que ce guard reste monté : défense en profondeur du P0.
 * 3. Sortie PROPRIÉTAIRE : bouton discret en haut (icône téléphone dans un anneau de progression,
 *    48×48 — cible ≥44pt). Deux mécanismes selon l'assistance active :
 *    - par défaut : maintenu 1,5 s (`EXIT_HOLD_MS`) — relâcher avant le terme annule le geste
 *      (l'anneau revient à zéro) ;
 *    - lecteur d'écran actif (VoiceOver/TalkBack détecté via `AccessibilityInfo`) : un
 *      appui-hold chronométré n'est pas un geste fiable au double-tap d'activation — l'alternative
 *      ANNONCÉE est double-tap pour armer, second double-tap sous 5 s pour confirmer (sinon
 *      désarmement automatique, silencieux).
 *    C'est l'UNIQUE chemin de sortie/annulation, désactivé pendant l'écriture (`saving`) : il
 *    appelle `onClose` (déjà utilisé par l'appelant pour fermer sans signer) — aucune autre voie.
 * 4. En-tête : « Signature de {customerName} — Devis {number} » + consigne courte au client
 *    (devis.signOnsiteModeHeader* / devis.signOnsiteModeInstruction, ×3 humeurs).
 * 5. Reprise : si `signQuote` échoue (réseau…), `error` reste affiché DANS le pad (bandeau
 *    accessible, tracé et nom NON réinitialisés — seule une réouverture les réamorce) et le
 *    bouton repasse en « Réessayer » (`devis.retry`) — jamais un pad vidé après un échec réseau.
 *    Pendant la mutation (`saving`) : bouton principal en pending, pad/nom/sortie désactivés.
 *    Ordre de lecture VoiceOver : sortie (persistante) → titre → nom → pad → valider.
 * 6. Après signature validée OU sortie propriétaire, `visible` repasse à false : le Modal se
 *    referme, `OnsiteModeAgentGuard` se démonte (le bouton Bob réapparaît), et rien ne relance
 *    Bob automatiquement — la restauration est silencieuse, jamais un redémarrage de session.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { Button, SignaturePad, font, useTheme, type SignaturePadValue } from '@bob/ui';
import { t } from '@bob/i18n';
import {
  usePublishAgentContext,
  useAgentSession,
  type AgentAccessLayout,
  type AgentContext,
  type AgentSurface,
} from '../agent';
import { PhoneIcon } from './icons';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Maintien requis pour la sortie propriétaire — ni trop court (geste accidentel), ni trop
 * long (frustration) : 1,5 s, conforme au brief. */
const EXIT_HOLD_MS = 1500;
/** Alternative lecteur d'écran : fenêtre pour confirmer le second double-tap avant désarmement
 * automatique et silencieux (pas de bond de layout, juste un retour au libellé initial). */
const EXIT_CONFIRM_WINDOW_MS = 5000;
const EXIT_RING_SIZE = 48;
const EXIT_RING_RADIUS = 20;
const EXIT_RING_STROKE = 3;
const EXIT_RING_CIRCUMFERENCE = 2 * Math.PI * EXIT_RING_RADIUS;

// Contexte agent STABLE (module-level) publié par le guard pendant le mode onsite. Republier
// `useAgentContext()` EN DIRECT créerait une boucle de rendu : chaque publish clone le contexte
// (nouvelle référence figée), ce qui redéclenche l'effet de publication qui republie... Un
// contenu constant n'a pas ce problème — et le contenu importe peu ici, seul `layout.hidden`
// compte pour GlobalBobAccess.
const ONSITE_AGENT_CONTEXT: AgentContext = Object.freeze({
  screen: Object.freeze({ name: '/signature-onsite', instanceId: 'signature-onsite' }),
  entities: Object.freeze([]),
  capabilities: Object.freeze([]),
});
const ONSITE_HIDDEN_LAYOUT: AgentAccessLayout = Object.freeze({ hidden: true });
const ONSITE_SURFACE: AgentSurface = Object.freeze({});

/** Monté UNIQUEMENT pendant le mode passage client — masque GlobalBobAccess (mic global) sans
 * toucher à l'écran parent. Démonté = republication automatique du contexte de l'écran parent. */
function OnsiteModeAgentGuard() {
  usePublishAgentContext(ONSITE_AGENT_CONTEXT, ONSITE_HIDDEN_LAYOUT, ONSITE_SURFACE);
  return null;
}

export interface SignOnsiteSheetProps {
  readonly visible: boolean;
  /** Préremplit le champ signataire — reste éditable (le nom du client sur la fiche peut
   * différer de la personne qui signe réellement, ex. un salarié mandaté). */
  readonly customerName: string;
  readonly quoteNumber: string | null;
  readonly saving?: boolean;
  /** Échec de la dernière tentative `signQuote` (réseau…) — message honnête déjà traduit
   * (`appErrorMessage`). Reste affiché tant que l'appelant ne le réinitialise pas : le pad, le
   * tracé et le nom saisi restent intacts, seul le bouton principal repasse en « Réessayer ». */
  readonly error?: string | null;
  /** Fermeture SANS signer — c'est aussi l'unique callback de la sortie propriétaire (appui
   * long ou double-tap de confirmation). Une seule voie de fermeture, jamais deux sémantiques
   * différentes. */
  readonly onClose: () => void;
  /** `proofDataUrl` = image SVG du tracé RÉELLEMENT dessiné (SignaturePadValue.dataUrl) — le
   * serveur en dérive le hash de preuve ; sans tracé le bouton reste désactivé (jamais une
   * preuve fabriquée). */
  readonly onSubmit: (signerName: string, proofDataUrl: string) => void;
}

export function SignOnsiteSheet({
  visible,
  customerName,
  quoteNumber,
  saving = false,
  error = null,
  onClose,
  onSubmit,
}: SignOnsiteSheetProps) {
  const { personality, colors, controls, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useAgentSession();
  const [signerName, setSignerName] = useState(customerName);
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);
  const exitProgress = useRef(new Animated.Value(0)).current;
  const exitHoldAnim = useRef<Animated.CompositeAnimation | null>(null);
  // Alternative accessible à l'appui long (VoiceOver/TalkBack) : double-tap pour armer, second
  // double-tap sous EXIT_CONFIRM_WINDOW_MS pour confirmer — un appui-hold chronométré n'est pas
  // un geste fiable une fois l'activation standard « double-tap » de l'AT en jeu.
  const [screenReaderActive, setScreenReaderActive] = useState(false);
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (active) setScreenReaderActive(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderActive);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const clearArmTimer = (): void => {
    if (armTimerRef.current !== null) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  };

  // Réamorce à chaque ouverture : jamais un tracé, un nom résiduel ou un anneau de sortie
  // à moitié tenu d'un passage précédent. `error` reste sous contrôle exclusif de l'appelant
  // (DocumentActions) : une réouverture s'accompagne toujours d'un reset côté appelant aussi.
  useEffect(() => {
    if (!visible) return;
    setSignerName(customerName);
    setSignature(null);
    exitHoldAnim.current?.stop();
    exitProgress.setValue(0);
    clearArmTimer();
    setArmed(false);
  }, [visible, customerName]);

  useEffect(() => () => clearArmTimer(), []);

  // L'anneau (déjà câblé pour le maintien) sert aussi de retour visuel à l'armement AT — sans
  // dupliquer de logique de dessin : plein quand armé, vide sinon (jamais animé ici, l'état
  // change en un seul tap, pas en continu).
  useEffect(() => {
    if (!screenReaderActive) return;
    exitHoldAnim.current?.stop();
    exitProgress.setValue(armed ? 1 : 0);
  }, [armed, screenReaderActive, exitProgress]);

  // Mode passage client, point 2 : Bob/micro suspendus à l'ENTRÉE — jamais relancés seuls.
  useEffect(() => {
    if (!visible) return;
    if (session.active) session.stop();
  }, [visible, session]);

  // Mode passage client, point 1 (Android) : back matériel intercepté et ignoré tant que le
  // mode est visible — seule la sortie propriétaire (appui long) ferme l'écran.
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [visible]);

  useEffect(() => () => exitHoldAnim.current?.stop(), []);

  const beginExitHold = (): void => {
    if (saving) return; // pending : la sortie propriétaire est désactivée (busy visible ailleurs)
    exitHoldAnim.current?.stop();
    exitProgress.setValue(0);
    const anim = Animated.timing(exitProgress, {
      toValue: 1,
      duration: EXIT_HOLD_MS,
      useNativeDriver: false, // strokeDashoffset (SVG) n'est pas piloté par le driver natif
    });
    exitHoldAnim.current = anim;
    anim.start(({ finished }) => {
      // Maintien allé à son terme : sortie propriétaire — annule aussi la signature en cours.
      if (finished) onClose();
    });
  };

  const cancelExitHold = (): void => {
    exitHoldAnim.current?.stop();
    Animated.timing(exitProgress, { toValue: 0, duration: 160, useNativeDriver: false }).start();
  };

  // Alternative AT au maintien : premier double-tap = armer (fenêtre de 5 s, désarmement
  // silencieux si rien ne suit) ; second double-tap PENDANT la fenêtre = confirmer et sortir.
  const handleExitActivate = (): void => {
    if (saving) return;
    if (armed) {
      clearArmTimer();
      setArmed(false);
      onClose();
      return;
    }
    setArmed(true);
    clearArmTimer();
    armTimerRef.current = setTimeout(() => setArmed(false), EXIT_CONFIRM_WINDOW_MS);
  };

  // « Valider la signature » n'est actif QUE si un tracé non vide existe — le nom seul ne suffit
  // pas (c'était précisément le défaut mensonger de l'ancienne ConfirmSheet booléenne). Le
  // dataURL du tracé DOIT exister : c'est lui qui part au serveur comme preuve (P0 R4).
  const valid = signerName.trim() !== '' && signature !== null && !signature.isEmpty && signature.dataUrl !== null;

  const headerTitle = quoteNumber
    ? t('devis.signOnsiteModeHeader', { personality, params: { customerName, number: quoteNumber } })
    : t('devis.signOnsiteModeHeaderNoNumber', { personality, params: { customerName } });

  const exitDashOffset = exitProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [EXIT_RING_CIRCUMFERENCE, 0],
  });

  return (
    <>
      {visible ? <OnsiteModeAgentGuard /> : null}
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => {
          // Android — back matériel : no-op volontaire (contrat RN). L'interception réelle vient
          // du BackHandler ci-dessus ; ce handler existe pour satisfaire l'API et documenter
          // l'intention — jamais de fermeture par ce chemin.
        }}
      >
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: colors.surface }}
          {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}
        >
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              paddingTop: insets.top + 12,
              paddingBottom: Math.max(insets.bottom, 18) + 12,
              paddingHorizontal: 20,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {/* Bandeau propriétaire — discret, sortie UNIQUE par appui long 1,5 s (ou double-tap
                d'armement + confirmation si un lecteur d'écran est détecté). Désactivé pendant
                l'écriture (saving) : jamais une sortie qui court-circuite une mutation en vol. */}
            <View style={{ flexDirection: 'row', marginBottom: 16 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  screenReaderActive && armed
                    ? t('devis.signOnsiteModeExitArmed', { personality })
                    : t('devis.signOnsiteModeExit', { personality })
                }
                accessibilityHint={
                  screenReaderActive
                    ? armed
                      ? t('devis.signOnsiteModeExitArmedHint', { personality })
                      : t('devis.signOnsiteModeExitHintScreenReader', { personality })
                    : t('devis.signOnsiteModeExitHint', { personality })
                }
                accessibilityState={{ disabled: saving, busy: saving }}
                disabled={saving}
                {...(screenReaderActive
                  ? { onPress: handleExitActivate }
                  : { onPressIn: beginExitHold, onPressOut: cancelExitHold })}
                hitSlop={8}
                style={{
                  width: EXIT_RING_SIZE,
                  height: EXIT_RING_SIZE,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                <Svg
                  width={EXIT_RING_SIZE}
                  height={EXIT_RING_SIZE}
                  viewBox={`0 0 ${EXIT_RING_SIZE} ${EXIT_RING_SIZE}`}
                  style={{ position: 'absolute' }}
                >
                  <Circle
                    cx={EXIT_RING_SIZE / 2}
                    cy={EXIT_RING_SIZE / 2}
                    r={EXIT_RING_RADIUS}
                    stroke={controls.ringTrack}
                    strokeWidth={EXIT_RING_STROKE}
                    fill="none"
                  />
                  <AnimatedCircle
                    cx={EXIT_RING_SIZE / 2}
                    cy={EXIT_RING_SIZE / 2}
                    r={EXIT_RING_RADIUS}
                    stroke={colors.slate500}
                    strokeWidth={EXIT_RING_STROKE}
                    strokeLinecap="round"
                    fill="none"
                    strokeDasharray={`${EXIT_RING_CIRCUMFERENCE} ${EXIT_RING_CIRCUMFERENCE}`}
                    strokeDashoffset={exitDashOffset}
                    rotation={-90}
                    originX={EXIT_RING_SIZE / 2}
                    originY={EXIT_RING_SIZE / 2}
                  />
                </Svg>
                <PhoneIcon color={armed ? semantic.danger : colors.slate500} size={18} />
              </Pressable>
            </View>

            <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 4 }]}>
              {headerTitle}
            </Text>
            <Text style={[font('sub'), { color: colors.slate500, marginBottom: 20 }]}>
              {t('devis.signOnsiteModeInstruction', { personality })}
            </Text>

            {/* Ordre de lecture VoiceOver demandé (titre déjà lu ci-dessus) : nom → pad → valider. */}
            <View pointerEvents={saving ? 'none' : 'auto'} style={saving ? { opacity: 0.6 } : undefined}>
              <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
                {t('devis.signerLabel', { personality })}
              </Text>
              <TextInput
                value={signerName}
                onChangeText={setSignerName}
                editable={!saving}
                placeholder={t('devis.signerPlaceholder', { personality })}
                placeholderTextColor={colors.slate400}
                accessibilityLabel={t('devis.signerLabel', { personality })}
                style={[
                  font('body'),
                  {
                    minHeight: 44,
                    color: colors.ink900,
                    borderWidth: 1,
                    borderColor: colors.line,
                    borderRadius: 12,
                    paddingHorizontal: 12,
                  },
                ]}
              />
              <View style={{ marginTop: 12 }}>
                <SignaturePad
                  clearLabel={t('devis.signClear', { personality })}
                  placeholder={t('devis.signPlaceholder', { personality })}
                  accessibilityLabel={t('devis.signTitle', { personality })}
                  onChange={setSignature}
                />
              </View>
            </View>
            {error !== null ? (
              <View
                accessible
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={{ marginTop: 12, borderRadius: 12, padding: 10, backgroundColor: semantic.dangerBg }}
              >
                <Text style={[font('meta', 600), { color: semantic.danger }]}>{error}</Text>
              </View>
            ) : null}
            <View style={{ marginTop: 16 }}>
              <Button
                title={
                  error !== null
                    ? t('devis.retry', { personality })
                    : t('devis.signOnsiteSubmit', { personality })
                }
                loading={saving}
                disabled={!valid || saving}
                onPress={() => {
                  // `valid` garantit un tracé non vide ET son dataURL — la preuve transmise est
                  // toujours celle affichée à l'écran, jamais reconstruite ailleurs.
                  if (signature?.dataUrl) onSubmit(signerName.trim(), signature.dataUrl);
                }}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
