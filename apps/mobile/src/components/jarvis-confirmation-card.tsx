/**
 * Carte de confirmation d'un run Jarvis `customer_contact@1` (spec §7.0/§7.1 — lot U1-d).
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
import { AccessibilityInfo, ActivityIndicator, Text, View } from 'react-native';
import type { ActionDiff } from '@bob/ai';
import { space } from '@bob/tokens';
import { Button, Card, font, useTheme } from '@bob/ui';
import type { CustomerContactPresentationV1 } from '@bob/api-client';
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
      readonly kind: 'notice';
      readonly reason:
        | 'preparing'
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
  preparing: 'Bob prépare la proposition…',
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
    case 'awaiting_confirmation':
      break;
    default:
      return { kind: 'notice', reason: 'preparing' };
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
  readonly onAuthoritativeRefresh: () => void;
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
  const [busy, setBusy] = useState<JarvisRunGesture | null>(null);
  const [failed, setFailed] = useState<JarvisRunGesture | null>(null);
  const inFlight = useRef(false);
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

  const run = async (
    gesture: JarvisRunGesture,
    task: () => Promise<JarvisRunCall>,
    /** Clé d'accusé que CE vol acquitte — marquée seulement s'il aboutit. */
    ackKeyOfCall: string | null = null,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(gesture);
    setFailed(null);
    try {
      const result = await task();
      if (result.status === 'completed') {
        if (ackKeyOfCall !== null) acknowledged.current = ackKeyOfCall;
        onAuthoritativeRefresh();
        return;
      }
      // Un conflit signifie qu'une autre autorité (la voix, un second appareil) a déjà avancé
      // le run : la seule réponse honnête est de relire, jamais de réessayer le même geste.
      if (result.status === 'failed' && result.error.kind === 'conflict') {
        onAuthoritativeRefresh();
        return;
      }
      setFailed(gesture);
    } catch {
      setFailed(gesture);
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
    // ABANDON TOUJOURS POSSIBLE TANT QUE RIEN N'EST ENGAGÉ. `preparing` couvre les phases où Bob
    // n'a encore rien écrit — dont un run PARKÉ (résolution de cible non aboutie), qui tient
    // pourtant le premier plan de l'artisan. Sans ce geste il n'aurait AUCUN recours à l'écran :
    // ni confirmer (pas de proposition), ni écarter, ni reprendre. On ne l'offre pas sur
    // `recording`/`cancelling` : l'écriture est partie, dire « annulé » y serait un mensonge.
    const abandonnable = mode.reason === 'preparing';
    return (
      <Card padding={space[7]}>
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
          {TITLES[presentation.intent]}
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          style={[font('sub'), { color: colors.slate500, marginTop: space[2] }]}
        >
          {NOTICES[mode.reason]}
        </Text>
        {abandonnable ? (
          <View style={{ marginTop: space[5] }}>
            <Button
              title="Annuler"
              variant="secondary"
              loading={busy === 'cancel'}
              disabled={busy !== null}
              accessibilityLabel="Annuler. Bob abandonne cette demande, rien ne sera enregistré."
              onPress={() => {
                void run('cancel', () => coordinator.cancel(frame, ports));
              }}
            />
          </View>
        ) : null}
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
            accessibilityLabel="Annuler. Bob abandonne cette demande, rien ne sera enregistré."
            onPress={() => {
              void run('cancel', () => coordinator.cancel(frame, ports));
            }}
          />
        </View>
      </Card>
    </View>
  );
}
