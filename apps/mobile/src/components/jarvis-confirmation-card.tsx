/**
 * Carte tactile d'un run Jarvis `customer_contact@1` (spec §7.0/§7.1, U1-d/U1-h).
 *
 * C'est la surface écran JUMELLE de la voix : les mêmes détails critiques y sont MONTRÉS et
 * VOCALISABLES (§7.0 règles 2-3), et chaque geste passe par le même contrat d'admission que le
 * canal vocal. Elle ne fabrique aucune donnée : tout vient de la projection serveur, y compris
 * les libellés humains — le mobile ne traduit jamais le jargon lui-même.
 *
 * Réemploi strict de l'existant : `Card`/`Button` de @bob/ui, la grammaire visuelle de la carte
 * assistant (pastille IA, titre, corps, rangée d'actions) et `ActionDiffView` — le MÊME rendu
 * avant/après que les propositions de Bob, avec sa sémantique de lecteur d'écran déjà éprouvée.
 *
 * L'accusé de présentation part au rendu RÉEL de la proposition (effet monté après commit), une
 * seule fois par confirmation ABOUTIE : c'est lui qui fait passer la confirmation à `presented`
 * et ouvre le bouton « Confirmer ». Sans lui, le domaine refuserait la confirmation — un accusé
 * perdu figerait donc la carte. Il ne peut pas l'être (revue C8) : la clé d'accusé n'est marquée
 * qu'APRÈS le succès, un vol concurrent DIFFÈRE l'envoi au lieu de l'avaler, et un échec réel
 * s'affiche avec « Réessayer » plutôt que de disparaître.
 */

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, Text, View } from 'react-native';
import type { ActionDiff } from '@bob/ai';
import { space } from '@bob/tokens';
import { Button, Card, font, useTheme } from '@bob/ui';
import type { CustomerContactPresentationV1, JarvisCommandReceiptView } from '@bob/api-client';
import {
  JarvisRunCoordinator,
  type JarvisRunCall,
  type JarvisRunFrame,
  type JarvisRunGesture,
  type JarvisRunPorts,
} from '../agent/jarvis-run-coordinator';
import { ActionDiffView } from './ActionDiffView';

/** Ce que la carte a le droit d'afficher — dérivé de la SEULE projection serveur. */
export type JarvisConfirmationCardMode =
  | {
      readonly kind: 'proposal';
      /** La confirmation est `issued` : elle attend l'accusé d'affichage. */
      readonly ackable: boolean;
      /** La confirmation est `presented` : le geste humain peut la consommer. */
      readonly confirmable: boolean;
    }
  | {
      /** Ordre et ordinaux viennent du jeu scellé : l'écran ne les reconstruit jamais. */
      readonly kind: 'duplicate_review';
      readonly reviewId: string;
      readonly choices: NonNullable<CustomerContactPresentationV1['duplicateReview']>['choices'];
    }
  | {
      readonly kind: 'notice';
      readonly reason:
        | 'resolving'
        | 'preparing'
        | 'duplicate_labels_unavailable'
        | 'recording'
        | 'cancelling'
        | 'consumed'
        | 'rejected'
        | 'expired'
        | 'invalidated'
        | 'completed'
        | 'cancelled'
        | 'failed';
    };

const NOTICES: Readonly<
  Record<Extract<JarvisConfirmationCardMode, { kind: 'notice' }>['reason'], string>
> = {
  resolving: 'Bob vérifie si ce client existe déjà chez vous…',
  preparing: 'Dites à Bob ce qu’il faut mettre dans la fiche.',
  duplicate_labels_unavailable:
    'Bob n’arrive pas à afficher les fiches proches. Relisez la demande ou annulez-la.',
  recording: 'Bob enregistre la fiche client…',
  cancelling: 'Bob referme cette demande…',
  consumed: 'C’est confirmé. Bob enregistre la fiche client.',
  rejected: 'Proposition écartée. Dites à Bob ce qu’il faut changer.',
  expired: 'Cette proposition a expiré. Redemandez-la à Bob.',
  invalidated: 'Ces informations ont changé entre-temps : Bob va vous en proposer une nouvelle.',
  completed: 'La fiche client est enregistrée.',
  cancelled: 'Demande annulée.',
  failed: 'Bob n’a pas pu terminer cette demande.',
};

const TITLES: Readonly<Record<CustomerContactPresentationV1['intent'], string>> = {
  create: 'Créer la fiche client',
  update: 'Modifier la fiche client',
};

/**
 * Projection totale phase × confirmation — aucune branche implicite : une phase inconnue de la
 * confirmation ne montre JAMAIS un bouton, elle explique où en est Bob.
 */
export function deriveJarvisConfirmationCardMode(
  presentation: CustomerContactPresentationV1,
): JarvisConfirmationCardMode {
  switch (presentation.phase) {
    case 'completed':
      return { kind: 'notice', reason: 'completed' };
    case 'cancelled':
      return { kind: 'notice', reason: 'cancelled' };
    case 'failed':
      return { kind: 'notice', reason: 'failed' };
    case 'committing':
    case 'awaiting_receipt':
      return { kind: 'notice', reason: 'recording' };
    case 'cancelling':
      return { kind: 'notice', reason: 'cancelling' };
    case 'resolving_customer':
      return { kind: 'notice', reason: 'resolving' };
    case 'awaiting_duplicate_review':
      return presentation.duplicateReview === null
        ? { kind: 'notice', reason: 'duplicate_labels_unavailable' }
        : {
            kind: 'duplicate_review',
            reviewId: presentation.duplicateReview.reviewId,
            choices: presentation.duplicateReview.choices,
          };
    case 'preparing_proposal':
      return { kind: 'notice', reason: 'preparing' };
    case 'awaiting_confirmation':
      break;
  }
  const confirmation = presentation.confirmation;
  if (confirmation === null || presentation.proposal === null) {
    return { kind: 'notice', reason: 'preparing' };
  }
  switch (confirmation.status) {
    case 'issued':
      return { kind: 'proposal', ackable: true, confirmable: false };
    case 'presented':
      return { kind: 'proposal', ackable: false, confirmable: true };
    case 'consumed':
      return { kind: 'notice', reason: 'consumed' };
    case 'rejected':
      return { kind: 'notice', reason: 'rejected' };
    case 'expired':
      return { kind: 'notice', reason: 'expired' };
    case 'invalidated':
      return { kind: 'notice', reason: 'invalidated' };
  }
}

/**
 * Les champs REMPLACÉS deviennent un `ActionDiff` — donc exactement le rendu avant/après des
 * propositions de l'assistant. Les champs seulement AJOUTÉS n'ont pas d'avant : les inventer
 * serait mentir, ils sont listés à part.
 */
export function deriveJarvisProposalDiff(
  presentation: CustomerContactPresentationV1,
): ActionDiff | null {
  const proposal = presentation.proposal;
  if (proposal === null) return null;
  const fields = proposal.fields
    .filter((field) => field.before !== null)
    .map((field) => ({
      label: field.label,
      before: field.before as string,
      after: field.after,
    }));
  return fields.length === 0
    ? null
    : { tool: 'jarvis_customer_contact', title: TITLES[presentation.intent], fields };
}

export interface JarvisConfirmationCardProps {
  readonly frame: JarvisRunFrame;
  readonly coordinator: JarvisRunCoordinator;
  readonly ports: JarvisRunPorts;
  /** Relecture autoritative (GET run) après tout geste abouti — l'écran ne devine jamais. */
  readonly onAuthoritativeRefresh: (receipt?: JarvisCommandReceiptView) => void;
  /**
   * L'hôte est-il RÉELLEMENT devant les yeux de l'artisan ? §7.1 — `record_presentation_ack`
   * atteste que la proposition A ÉTÉ AFFICHÉE, et c'est lui qui ouvre le droit de confirmer.
   * Une carte montée dans un onglet en arrière-plan est montée, pas VUE : l'accusé y serait un
   * mensonge, et un mensonge qui déverrouille une écriture. Par défaut `true` — un hôte qui ne
   * sait pas répondre affiche la carte au premier plan.
   */
  readonly visible?: boolean;
}

export function JarvisConfirmationCard({
  frame,
  coordinator,
  ports,
  onAuthoritativeRefresh,
  visible = true,
}: JarvisConfirmationCardProps) {
  const { colors, semantic } = useTheme();
  const frameKey = `${frame.run.runId}:${frame.run.revision}`;
  const [busy, setBusy] = useState<JarvisRunGesture | null>(null);
  const [failure, setFailure] = useState<{
    readonly frameKey: string;
    readonly gesture: JarvisRunGesture;
  } | null>(null);
  const inFlight = useRef(false);
  // Le tag suffit à masquer une panne d'ancienne révision sans muter une réf pendant un render
  // concurrent qui pourrait ensuite être abandonné par React.
  const currentFailure = failure?.frameKey === frameKey ? failure : null;
  const failed = currentFailure?.gesture ?? null;
  /**
   * Clé de l'accusé RÉELLEMENT abouti — posée APRÈS le succès, jamais avant l'appel. Un accusé
   * perdu ne se marque donc pas comme rendu : la prochaine confirmation réveille l'effet.
   */
  const acknowledged = useRef<string | null>(null);
  /**
   * Un accusé est DÛ au serveur. Quelle confirmation il accuse n'est décidé qu'à l'ENVOI, sur la
   * frame réellement à l'écran : si le parent remplace la proposition pendant un vol, c'est la
   * NOUVELLE qui est accusée, jamais celle qui n'est plus montrée.
   */
  const ackOwed = useRef(false);
  /**
   * Le relanceur vit dans une réf : appelé depuis le `finally` d'un geste, il doit viser la frame
   * du DERNIER rendu, pas celle qui a lancé ce geste.
   */
  const pump = useRef<() => void>(() => {});

  const presentation = frame.presentation;
  const mode = deriveJarvisConfirmationCardMode(presentation);
  const proposal = presentation.proposal;
  const confirmation = presentation.confirmation;
  const diff = deriveJarvisProposalDiff(presentation);
  const added = proposal === null ? [] : proposal.fields.filter((field) => field.before === null);
  const sensitive =
    proposal !== null && proposal.fields.some((field) => field.sensitiveField !== null);

  const reviewAnnouncementKey =
    visible && currentFailure === null && mode.kind === 'duplicate_review'
      ? `${frame.run.runId}:${mode.reviewId}`
      : visible &&
          currentFailure === null &&
          mode.kind === 'notice' &&
          mode.reason === 'duplicate_labels_unavailable'
        ? `${frameKey}:duplicate_labels_unavailable`
        : null;
  const reviewAnnouncement =
    mode.kind === 'duplicate_review'
      ? 'Bob a trouvé des fiches proches. Choisissez une fiche, créez-en une nouvelle, ou annulez.'
      : mode.kind === 'notice' && mode.reason === 'duplicate_labels_unavailable'
        ? NOTICES.duplicate_labels_unavailable
        : null;
  const announcedReview = useRef<string | null>(null);
  useEffect(() => {
    // Android porte la région vive ; iOS exige une annonce explicite pour VoiceOver.
    if (
      Platform.OS !== 'ios' ||
      reviewAnnouncementKey === null ||
      reviewAnnouncement === null ||
      announcedReview.current === reviewAnnouncementKey
    ) {
      return;
    }
    announcedReview.current = reviewAnnouncementKey;
    void AccessibilityInfo.announceForAccessibility(reviewAnnouncement);
  }, [reviewAnnouncement, reviewAnnouncementKey]);

  const failureAnnouncement =
    currentFailure === null
      ? null
      : currentFailure.gesture === 'presentation_ack'
        ? 'Bob n’a pas pu enregistrer l’affichage de cette proposition.'
        : mode.kind === 'duplicate_review'
          ? 'Bob n’a pas pu vérifier votre geste. Relisez la demande avant de réessayer.'
          : mode.kind === 'notice'
            ? 'Bob n’a pas pu vérifier l’annulation. Relisez la demande avant de réessayer.'
            : 'Bob n’a pas pu enregistrer votre geste.';
  const announcedFailure = useRef<typeof currentFailure>(null);
  useEffect(() => {
    if (
      Platform.OS !== 'ios' ||
      !visible ||
      currentFailure === null ||
      failureAnnouncement === null ||
      announcedFailure.current === currentFailure
    ) {
      return;
    }
    announcedFailure.current = currentFailure;
    void AccessibilityInfo.announceForAccessibility(failureAnnouncement);
  }, [currentFailure, failureAnnouncement, visible]);

  const run = async (
    gesture: JarvisRunGesture,
    task: () => Promise<JarvisRunCall>,
    /** Clé d'accusé que CE vol acquitte — marquée seulement s'il aboutit. */
    ackKeyOfCall: string | null = null,
  ): Promise<void> => {
    if (inFlight.current) return;
    const callFrameKey = frameKey;
    inFlight.current = true;
    setBusy(gesture);
    setFailure((previous) => (previous?.frameKey === callFrameKey ? null : previous));
    try {
      const result = await task();
      if (result.status === 'completed') {
        if (ackKeyOfCall !== null) acknowledged.current = ackKeyOfCall;
        // Le reçu est la première postimage autoritaire : L7 l'arme avant qu'un worker rapide ou
        // un nouveau foreground puisse masquer ce run au prochain GET current.
        onAuthoritativeRefresh(result.value);
        return;
      }
      // Un conflit signifie qu'une autre autorité (la voix, un second appareil) a déjà avancé
      // le run : la seule réponse honnête est de relire, jamais de réessayer le même geste.
      if (result.status === 'failed' && result.error.kind === 'conflict') {
        onAuthoritativeRefresh();
        return;
      }
      setFailure({ frameKey: callFrameKey, gesture });
    } catch {
      setFailure({ frameKey: callFrameKey, gesture });
    } finally {
      inFlight.current = false;
      setBusy(null);
      // Un accusé rendu DÛ pendant ce vol part maintenant — sur la frame du dernier rendu.
      pump.current();
    }
  };

  // Clé du rendu RÉEL : elle ne change que si une AUTRE confirmation est réellement affichée.
  // `visible` entre dans la CONDITION, pas dans la clé : quand l'hôte revient au premier plan,
  // la même clé redevient due et l'accusé part — jamais un second accusé pour la même proposition.
  const ackKey =
    visible && mode.kind === 'proposal' && mode.ackable && confirmation !== null
      ? `${frame.run.runId}:${frame.run.revision}:${confirmation.confirmationId}`
      : null;

  /**
   * Envoie l'accusé DÛ, s'il l'est encore et si la voie est libre. Un geste en vol ne l'avale
   * pas : la dette reste posée et le `finally` de ce geste rappelle ce relanceur.
   */
  const sendOwedAck = (): void => {
    if (!ackOwed.current || ackKey === null || acknowledged.current === ackKey) return;
    if (inFlight.current) return;
    ackOwed.current = false;
    void run('presentation_ack', () => coordinator.acknowledgePresentation(frame, ports), ackKey);
  };

  useEffect(() => {
    pump.current = sendOwedAck;
  });

  useEffect(() => {
    if (ackKey === null || acknowledged.current === ackKey) return;
    // La dette est posée AVANT toute tentative : même bloquée, même perdue, elle survit.
    ackOwed.current = true;
    sendOwedAck();
    void AccessibilityInfo.announceForAccessibility('Bob attend votre confirmation.');
    // Seule la confirmation réellement rendue réveille cet effet : les autres publications de
    // props (occupation, échec) ne doivent jamais reproduire un accusé d'affichage. Une clé
    // NOUVELLE le réveille en revanche toujours, même si l'accusé précédent n'a pas abouti.
  }, [ackKey]);

  if (mode.kind === 'notice') {
    // ABANDON TOUJOURS POSSIBLE TANT QUE RIEN N'EST ENGAGÉ. Les phases de résolution, de
    // préparation ou de revue illisible peuvent tenir le premier plan sans autre geste tactile.
    // On ne l'offre pas sur `recording`/`cancelling` : l'écriture est partie, dire « annulé » y
    // serait un mensonge.
    const abandonnable =
      mode.reason === 'preparing' ||
      mode.reason === 'resolving' ||
      mode.reason === 'duplicate_labels_unavailable';
    const relisible = mode.reason === 'duplicate_labels_unavailable';
    const refreshable = relisible || failed !== null;
    return (
      <Card padding={space[7]}>
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
          {TITLES[presentation.intent]}
        </Text>
        {presentation.targetLabel === null ? null : (
          <Text style={[font('sub'), { color: colors.ink900, marginTop: 2 }]}>
            {presentation.targetLabel}
          </Text>
        )}
        <Text
          accessibilityRole={relisible ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          style={[font('sub'), { color: colors.slate500, marginTop: space[2] }]}
        >
          {NOTICES[mode.reason]}
        </Text>
        {failed !== null ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[font('sub'), { color: colors.ink900, lineHeight: 20, marginTop: space[3] }]}
          >
            Bob n’a pas pu vérifier l’annulation. Relisez la demande avant de réessayer.
          </Text>
        ) : null}
        {abandonnable ? (
          <View style={{ gap: space[3], marginTop: space[5] }}>
            {refreshable ? (
              <Button
                title="Relire la demande"
                variant="secondary"
                disabled={busy !== null}
                accessibilityLabel={
                  relisible
                    ? 'Relire la demande pour afficher les fiches proches.'
                    : 'Relire la demande après l’échec de l’annulation.'
                }
                onPress={() => onAuthoritativeRefresh()}
              />
            ) : null}
            <Button
              title="Annuler"
              variant="secondary"
              loading={busy === 'cancel'}
              disabled={busy !== null}
              accessibilityLabel="Annuler. Bob annule ce qui peut encore l’être puis relit la demande."
              onPress={() => {
                void run('cancel', () => coordinator.cancel(frame.run, ports));
              }}
            />
          </View>
        ) : null}
      </Card>
    );
  }

  if (mode.kind === 'duplicate_review') {
    const locked = busy !== null;
    return (
      <Card padding={space[7]} style={{ borderWidth: 1, borderColor: semantic.ai }}>
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
          {TITLES[presentation.intent]}
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          style={[font('sub'), { color: colors.slate500, marginTop: space[2] }]}
        >
          Bob a trouvé des fiches proches. Choisissez-en une, poursuivez la création, ou annulez.
        </Text>

        <View style={{ gap: space[4], marginTop: space[5] }}>
          {mode.choices.map((choice) => {
            const unavailable = choice.label === null;
            return (
              <View key={choice.choiceId} style={{ gap: space[2] }}>
                <Text selectable style={[font('sub'), { color: colors.ink900 }]}>
                  {choice.ordinal}. {choice.label ?? 'Fiche introuvable'}
                </Text>
                <View style={{ alignSelf: 'flex-start' }}>
                  <Button
                    title={unavailable ? 'Choix indisponible' : 'Choisir cette fiche'}
                    variant="secondary"
                    loading={!unavailable && busy === 'use_existing'}
                    disabled={locked || unavailable}
                    accessibilityState={{ disabled: locked || unavailable }}
                    accessibilityLabel={
                      unavailable
                        ? `${choice.ordinal}. Fiche introuvable. Choix indisponible.`
                        : `${choice.ordinal}. ${choice.label}. Choisir cette fiche existante.`
                    }
                    onPress={() => {
                      if (unavailable) return;
                      void run('use_existing', () =>
                        coordinator.chooseExistingCustomer(frame, choice.choiceId, ports),
                      );
                    }}
                  />
                </View>
              </View>
            );
          })}
        </View>

        {failed !== null ? (
          <View style={{ gap: space[3], marginTop: space[5] }}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[font('sub'), { color: colors.ink900, lineHeight: 20 }]}
            >
              Bob n’a pas pu vérifier votre geste. Relisez la demande avant de réessayer.
            </Text>
            <View style={{ alignSelf: 'flex-start' }}>
              <Button
                title="Relire la demande"
                variant="secondary"
                disabled={locked}
                onPress={() => onAuthoritativeRefresh()}
              />
            </View>
          </View>
        ) : null}

        <View style={{ gap: space[3], marginTop: space[5] }}>
          <Button
            title="Créer quand même"
            variant="secondary"
            loading={busy === 'continue_create'}
            disabled={locked}
            accessibilityState={{ disabled: locked }}
            accessibilityLabel="Créer quand même une nouvelle fiche malgré les fiches proches."
            onPress={() => {
              void run('continue_create', () => coordinator.continueCreation(frame, ports));
            }}
          />
          <Button
            title="Annuler"
            variant="danger"
            loading={busy === 'cancel'}
            disabled={locked}
            accessibilityState={{ disabled: locked }}
            accessibilityLabel="Annuler. Bob annule ce qui peut encore l’être puis relit la demande."
            onPress={() => {
              void run('cancel', () => coordinator.cancel(frame.run, ports));
            }}
          />
        </View>
      </Card>
    );
  }

  const acking = busy === 'presentation_ack';
  const locked = busy !== null;

  return (
    <View accessibilityLiveRegion="polite" style={{ gap: space[5] }}>
      <Card padding={space[7]} style={{ borderWidth: 1, borderColor: semantic.ai }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[4] }}>
          <View
            accessible={false}
            style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: semantic.ai }}
          />
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
              {TITLES[presentation.intent]}
            </Text>
            {/* U1-f §4 — DE QUI parle-t-on. Sur l'onglet assistant, rien d'autre ne le dit : sans
                ce nom, l'artisan confirmerait une modification sans savoir sur quelle fiche elle
                porte. `null` quand le serveur n'a pas pu le nommer — jamais un identifiant. */}
            {presentation.targetLabel === null ? null : (
              <Text
                selectable
                style={[font('sub'), { color: colors.ink900, marginTop: 2, fontWeight: '600' }]}
              >
                {presentation.targetLabel}
              </Text>
            )}
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 2 }]}>
              Vérifiez avant que Bob enregistre.
            </Text>
          </View>
          {locked ? (
            <ActivityIndicator
              accessibilityRole="progressbar"
              accessibilityLabel="Bob enregistre votre geste."
              color={semantic.ai}
            />
          ) : null}
        </View>

        <ActionDiffView diff={diff} />

        {added.length > 0 ? (
          <View style={{ gap: space[3], marginTop: space[5] }}>
            {added.map((field) => (
              <View
                key={field.field}
                accessible
                accessibilityLabel={`${field.label} : ${field.after}.`}
                style={{ gap: 2 }}
              >
                <Text
                  accessible={false}
                  style={[font('meta'), { color: colors.slate500, lineHeight: 18 }]}
                >
                  {field.label}
                </Text>
                <Text
                  accessible={false}
                  style={[font('sub', 600), { color: colors.ink900, lineHeight: 20 }]}
                >
                  {field.after}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {sensitive ? (
          <Text style={[font('meta'), { color: colors.slate500, marginTop: space[5] }]}>
            Bob relit ces informations juste avant d’enregistrer : si l’une d’elles change d’ici là,
            il vous en repropose une nouvelle plutôt que d’enregistrer l’ancienne.
          </Text>
        ) : null}

        {failed !== null ? (
          <View style={{ gap: space[3], marginTop: space[5] }}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={[font('sub'), { color: colors.ink900, lineHeight: 20 }]}
            >
              {failed === 'presentation_ack'
                ? 'Bob n’a pas pu enregistrer l’affichage de cette proposition.'
                : 'Bob n’a pas pu enregistrer votre geste.'}
            </Text>
            <View style={{ alignSelf: 'flex-start' }}>
              <Button
                title="Réessayer"
                variant="secondary"
                disabled={locked}
                onPress={() => {
                  // L'accusé se REDEMANDE (la dette se repose) ; une proposition qui n'est plus
                  // accusable ne se rejoue pas à l'aveugle, elle se relit.
                  if (failed === 'presentation_ack' && ackKey !== null) {
                    ackOwed.current = true;
                    sendOwedAck();
                    return;
                  }
                  onAuthoritativeRefresh();
                }}
              />
            </View>
          </View>
        ) : null}

        <View style={{ gap: space[3], marginTop: space[5] }}>
          <Button
            title="Confirmer"
            variant="aiSolid"
            loading={busy === 'confirm'}
            // Une confirmation non PRÉSENTÉE serait refusée par le domaine : le bouton ne
            // s'ouvre qu'une fois l'accusé d'affichage acquis (§7.1).
            disabled={locked || acking || !mode.confirmable}
            accessibilityState={{ disabled: locked || acking || !mode.confirmable }}
            accessibilityLabel={
              mode.confirmable
                ? 'Confirmer'
                : 'Confirmer. Disponible dès que Bob a enregistré l’affichage de la proposition.'
            }
            onPress={() => {
              void run('confirm', () => coordinator.confirm(frame, ports));
            }}
          />
          <Button
            title="Modifier"
            variant="secondary"
            loading={busy === 'reject'}
            disabled={locked}
            accessibilityLabel="Modifier. Bob écarte cette proposition et vous en prépare une autre."
            onPress={() => {
              void run('reject', () => coordinator.reject(frame, ports));
            }}
          />
          <Button
            title="Annuler"
            variant="danger"
            loading={busy === 'cancel'}
            disabled={locked}
            accessibilityLabel="Annuler. Bob annule ce qui peut encore l’être puis relit la demande."
            onPress={() => {
              void run('cancel', () => coordinator.cancel(frame.run, ports));
            }}
          />
        </View>
      </Card>
    </View>
  );
}
