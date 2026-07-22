# SPEC — Bob Live OpenAI hybride : une seule voix par tour

**Statut au 22 juillet 2026** : spécifié, non implémenté, non activable.

Cette spec complète `SPEC_GPT_REALTIME_NATIVE_DUPLEX.md`. Elle ne rend pas le runtime natif
activable : le flag reste fermé jusqu'aux preuves PostgreSQL, provider et appareils physiques.

## 1. Décision produit

Le profil OpenAI doit combiner deux qualités sans mélanger leurs autorités :

- **RTP OpenAI natif** pour un catalogue positif de clarifications génériques déterministes,
  sans donnée tenant, fait métier, choix réel, navigation, proposition ni action ;
- **OpenAI TTS + audit Whisper local + artefact signé** pour toute réponse qui contient une
  information métier réelle ou peut autoriser un effet dans l'application.

Le choix est effectué **une fois par tour**, persisté avant toute création de sortie et devient
immuable. Une erreur après ce choix termine le tour ; elle ne bascule jamais silencieusement vers
l'autre voix. Une reprise utilise un nouveau `turnId`.

Le profil reste mono-fournisseur cloud : Realtime et TTS utilisent `OPENAI_API_KEY`. L'audit
indépendant est le sidecar Whisper auto-hébergé de Bob. Aucune clé Mistral n'est requise ou appelée.

## 2. Pourquoi le contrat actuel ne suffit pas

Le contrat v4 négocie la livraison au niveau de toute la session :
`openai-native-webrtc-v1` **ou** `audited-signed-url-v1`. Or une mission Jarvis alterne naturellement
clarifications rapides et réponses métier exactes.

Deux P0 empêchent de superposer les chemins existants :

1. les tables native et auditée peuvent chacune accepter le même tour ; sans racine commune, une
   course ou un retry peut produire deux sources sonores ;
2. le player audité actuel coupe le microphone pendant la lecture. Il ne fournit donc pas le
   barge-in naturel attendu sur les réponses métier et ne doit pas être annoncé comme plein duplex.

## 3. Contrat de négociation N/N-1

La nouvelle version est `bob-live-provider-neutral-v5`; la version N-1 reste
`bob-live-provider-neutral-v4` et conserve son wire exact.

Le client déclare explicitement ses versions acceptées. Le serveur sélectionne :

| Client | Serveur | Contrat rendu |
|---|---|---|
| v5 | v5 | `openai-hybrid-v1` |
| v4 ou capacité absente | v5 | v4 `audited-signed-url-v1`, inchangé |
| v5 | v4 | v4 audité, accepté par le mobile |

Le cache HTTP varie sur la capacité déclarée. Aucune propriété v5 ne fuit dans une réponse v4.
Le bootstrap et `createCall` valident le contrat réellement négocié, jamais une simple préférence
globale du serveur.

Le wire v5 expose un discriminant string, pas un objet polymorphe ambigu :

```ts
{
  transport: 'webrtc';
  speechDelivery: 'openai-hybrid-v1';
  speechProtocols: {
    arbitration: 'bob.acoustic-turn.v1';
    nativeResponse: 'bob.openai-native-response.v1';
    nativeAcknowledgement: 'bob.openai-native-delivery-ack.v1';
    auditedArtifact: 'bob.audited-signed-url.v1';
  };
}
```

## 4. Autorité durable de route acoustique

Une racine append-only `RealtimeAcousticTurnRoute` porte au minimum :

```text
companyId, sessionId, turnId
routeKind = native_provider_stream | audited_artifact
routePolicyVersion
contextRevision, contextDigest
sidebandOwnerEpoch, sidebandOwnerTokenHmac
routeClaimId
createdAt, retentionExpiresAt
```

Contraintes physiques :

- clé unique `(companyId, sessionId, turnId)` et `routeClaimId` unique ;
- `INSERT ... ON CONFLICT DO NOTHING`, puis relecture exacte ;
- même route + même fence + même claim = retry idempotent ;
- autre route ou autre fence = conflit fatal ;
- route et premier état enfant créés dans la même transaction tenantée ;
- aucun enfant natif sous route auditée, aucun artefact sous route native ;
- contexte et propriétaire enfant identiques à la racine ;
- FORCE RLS, rôle runtime non privilégié, rétention seulement après terminal et expiration.

La machine est volontairement minimale :

```text
ABSENT ── claim(native)  ──> CLAIMED_NATIVE  (immuable)
       └─ claim(audited) ──> CLAIMED_AUDITED (immuable)
```

## 5. Politique de routage

Le routage est déterministe et fail-closed :

- fait métier, donnée tenant, candidat réel, navigation, proposition, action, résultat ou contrôle
  → `audited_artifact` ;
- formulation libre générée par le modèle → `audited_artifact` ;
- scénario exact appartenant au catalogue positif et ne portant aucune donnée ni effet
  → `native_provider_stream` ;
- doute, provenance incomplète ou signal malformé → `audited_artifact`.

La simple absence de chiffre ou de nom ne rend jamais une phrase éligible au natif. En V1, un tour
natif ne crée aucun contrôle métier. Les premières phrases candidates sont des demandes de
reformulation ou de données manquantes ; les noms, prix et choix proposés restent audités.

## 6. Arbitre acoustique mobile

Un seul composant possède toutes les sorties : `RealtimeAcousticOutputArbiter`. Il ne superpose pas
le player audité au transport WebRTC.

```text
READY -> AWAITING_SOURCE(turn)
      -> NATIVE_ARMED -> NATIVE_PLAYING -> NATIVE_DRAINING -> ACKING -> READY
      -> AUDITED_ARMED -> AUDITED_PLAYING -----------------> ACKING -> READY
      -> CANCELLING -> READY
      -> FATAL
```

Invariants :

- le premier candidat valide verrouille la source du tour ; l'autre source devient fatale ;
- RTP muet par défaut, démuté seulement après metadata exacte et buffer démarré du même response ;
- une route auditée garde le RTP muet ;
- barge-in : mute RTP et arrêt physique du player **avant** le réseau, puis cancel/clear/annulation
  durable au plus une fois ;
- toute génération tardive reste inerte ;
- aucun transcript fournisseur ne devient l'autorité de l'UI ou de l'historique.

Le playback audité v5 exige une vraie route communication/AEC : Voice Processing iOS,
`MODE_IN_COMMUNICATION` Android, micro ouvert, arrêt synchrone, speaker/écouteur/filaire/Bluetooth et
changements de route certifiés. Le player Expo semi-duplex reste uniquement le fallback v4.

## 7. ACK et effets UI

L'ACK natif est strict, idempotent et lié à tenant/sujet/session/tour/contexte/propriétaire. Il n'est
accepté qu'après `response.done=completed`, transcript concordant, arrêt du buffer, persistance de
l'usage et fin locale observée. Une course temporaire est retryable avec le même acknowledgementId
et un nombre d'essais borné.

Le natif V1 ne livre aucun contrôle. Pour la route auditée, la navigation ou proposition devient
consommable seulement après lecture complète, ACK durable et revalidation du contexte. La voix et
le tap alimentent ensuite la même transition AgentMission/use case.

## 8. Migration et activation

1. Expand : table route, repository, RLS, preuves de concurrence ; flags fermés.
2. Writer compatible : toute nouvelle source actuelle écrit sa route dans la même transaction.
3. Audit/backfill : refuser tout tour historique présent dans les deux sources ou toute fence
   divergente.
4. Enforcement : contraintes/triggers physiques puis certification PostgreSQL réelle.
5. Serveur v5 capable de servir v4 audité et v5 hybride.
6. Mobile v5 publié flag OFF.
7. Module playback communication/AEC certifié sur appareils.
8. Canary interne, cohorte 100, puis cohorte 1 000 selon `SPEC_BOB_LIVE_CAPACITY.md`.

## 9. Definition of Done binaire

- [ ] Course native/auditée sur PostgreSQL : exactement un gagnant sur 10 000 ordonnancements.
- [ ] Aucun `response.create` sous route auditée ; aucun artefact sous route native.
- [ ] Tous faits, choix réels, actions et contrôles sont routés vers l'audité par tests de politique.
- [ ] Aucun contrôle ne peut référencer une livraison native V1.
- [ ] Aucun effet UI avant ACK durable et contexte courant.
- [ ] Compatibilité v5/v4 prouvée dans les deux sens, wires exacts.
- [ ] Interruption locale avant réseau ; zéro reprise sur dix barge-ins successifs.
- [ ] Aucune boucle d'écho pendant 15 minutes par route et périphérique.
- [ ] Speaker, écouteur, filaire et Bluetooth certifiés sur iPhone et Android physiques.
- [ ] Fin de parole → premier audio : p50 ≤ 900 ms, p95 ≤ 1 800 ms, séparé par source.
- [ ] Barge-in → silence : p50 ≤ 250 ms, p95 ≤ 500 ms.
- [ ] Contrôle livré → effet UI : p95 ≤ 400 ms.
- [ ] Démarrage et mission OpenAI complète sans `MISTRAL_API_KEY` ni requête Mistral.
- [ ] Sept jours de canary sans double voix, effet prématuré ni fuite inter-tenant.

## 10. Hors promesse actuelle

- activation production avant les preuves ci-dessus ;
- 1 000 voix simultanées ;
- sortie native de faits financiers, légaux ou contractuels ;
- dépendance à une duplication des deltas audio WebSocket sur le sideband d'un appel WebRTC : cette
  propriété fournisseur exige un spike réel et n'est pas requise par la V1.
