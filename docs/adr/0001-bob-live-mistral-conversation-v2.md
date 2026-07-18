# ADR-0001 : Bob Live Mistral — session persistante, tours Voxtral isolés

## Statut

Proposed — 2026-07-15, amendé après revue adversariale Claude. Les codecs et reducers v2 sont
implémentés et testés, mais le gateway, le raccord mobile et les preuves acoustiques restent en
construction. Le passage à `Accepted` exige une nouvelle revue gelée de cet ADR. Le rollout v2 et
le duplex restent fermés jusqu'aux preuves PostgreSQL, appareil et SLO décrites ci-dessous.

## Contexte

Le protocole `bob.mistral-pcm.v1` est volontairement sûr et one-shot : un ticket ouvre une
connexion, un flux PCM produit une transcription, Bob répond, puis la session se ferme. Il ne peut
donc pas assurer la mission continue attendue : plusieurs tours, changement d'écran, VAD, reprise
de parole pendant Bob et actions conservant leur diff/confirmation.

Voxtral Realtime est un service de transcription streaming. Mistral décrit l'agent vocal comme la
composition Voxtral STT + LLM + Voxtral TTS, et non comme une session speech-to-speech possédant
elle-même la conversation. Bob doit donc être l'autorité du duplex, du contexte, des tours et des
annulations.

### État réel du code au 15 juillet 2026

Le chantier a commencé avant l'acceptation de cette décision. Les éléments suivants existent dans
le worktree et ne constituent pas encore, à eux seuls, une fonctionnalité v2 activable :

- `mistral-conversation-protocol.ts` contient les codecs stricts, les reducers Mission/Turn, les
  budgets, les séquences, le curseur de reprise et l'ACK cumulatif ; sa suite ciblée est verte ;
- le module natif iOS/Android publie PCM et événements VAD, le contrat TypeScript les fence, et un
  ring borné reconstitue le pré-roll ; le lifecycle mobile v2 et le transport ne les consomment pas
  encore de bout en bout ;
- `mistral-conversation-gateway-v2.ts` est un core expérimental à ports. Sa deadline fournisseur
  est désormais armée après l'ACK `turn.commit`. Son contrat exige un replay d'outbox contigu,
  conserve une mission sur perte de socket, fence les ACK par `missionConnectionEpoch`, borne la
  fenêtre non acquittée et distingue maintenant reprise live et replay terminal. Le core référence
  finalise un `draining` sans dépendre du downlink, rejoue un `closed` sans rouvrir de provider et
  réserve ses compteurs terminalement ; les adapters PostgreSQL, la rétention d'outbox et
  l'ouverture atomique du contrôle audité restent à construire et certifier ;
- la route mobile déployable reste `bob.mistral-pcm.v1`, semi-duplex et one-shot. Elle annonce
  honnêtement `fullDuplex: false` et `bargeIn: false` ;
- les briques RLS, admission, reaper, stockage audité et fencing de réplica sont réutilisables,
  mais ne prouvent pas encore la persistance Mission/Turn v2 ni sa reprise multi-owner.

Manquent donc encore le transport mobile v2, le raccord VAD → interruption → nouveau tour, la
lecture native interruptible, les adapters PostgreSQL/outbox du gateway, la reprise réseau sur
deux répliques réelles, les métriques Mistral et la certification acoustique sur appareils. Le flag
de rollout doit rester éteint tant que cette liste n'est pas fermée.

## Décision drivers

- mode Mistral réellement mono-fournisseur, sans clé OpenAI secondaire ;
- WebSocket mobile persistante pendant une mission Bob ;
- interruption acoustique locale avant tout aller-retour JS/réseau ;
- contexte écran et droits relus à chaque tour ;
- aucune action avant parole auditée, ACK de livraison et confirmation ;
- isolation tenant, idempotence et reprise multi-réplique ;
- dégradation honnête vers push-to-talk si la route audio n'est pas certifiée ;
- p50/p95 mesurables par appareil, route, réseau, modèle et version.

## Options considérées

### Étendre le ticket v1 après son premier `end`

Rejeté. Le ticket, le `redemptionId` et le `turnId` sont aujourd'hui la même identité. Les réutiliser
affaiblirait l'idempotence et les fences de contexte, et conserverait une machine terminale pleine
de cas particuliers.

### Conserver une seule connexion Voxtral pendant toute la mission

Non retenu tant que le contrat officiel ne prouve pas un final indépendant et annulable par tour.
Déduire une fin de tour à partir de deltas ou d'un délai local produirait des transcripts ambigus et
des actions difficiles à rejouer exactement.

### Session Bob persistante, sous-session Voxtral par utterance

Retenu. La connexion mobile reste stable ; chaque prise de parole possède une identité, un budget,
un AbortSignal et un flux STT propres. Une connexion Voxtral suivante peut être préchauffée, mais
elle ne reçoit aucun audio avant l'acceptation durable du tour.

### Utiliser GPT Realtime pour le profil Mistral

Rejeté. Ce serait un fallback fournisseur caché et violerait la promesse Mistral-only. Le profil
OpenAI reste un déploiement séparé sélectionné avant admission et jamais en cours de mission.

## Décision

Créer `bob.mistral-pcm.v2` autour de deux niveaux d'identité :

1. **Mission** : `sessionHandle`, tenant, utilisateur, epoch de connexion, expiration et contexte
   courant.
2. **Tour** : `clientTurnId` UUID, ordinal monotone serveur, `turnId` opaque, contexte exact,
   génération d'annulation et état durable.

Le ticket WSS n'est qu'une capacité de bootstrap consommable une fois. Il n'est jamais un tour.
Le vocabulaire `clientTurnId`, ordinal, génération d'annulation et préchauffage reste interne à la
gateway Mistral. Le `turnId` provider-neutral exposé à `BobAgent`, aux contrôles audités et aux
routes partagées reste inchangé ; OpenAI n'a pas à produire les champs du protocole Mistral.

Deux epochs de granularité différente doivent rester explicitement séparés :

- `missionConnectionEpoch` fence une connexion mobile v2 et augmente à chaque takeover/reprise de
  la mission. L'ancien nom prototype `ownerEpoch` a été supprimé du protocole et du gateway avant
  le raccord durable ;
- `sidebandOwnerEpoch` fence le réplica serveur propriétaire de la publication audio existante.

Ils ne sont jamais copiés, comparés ni incrémentés l'un à partir de l'autre. Toute commande durable
nomme l'epoch attendu avec son type ; une valeur d'un autre domaine doit être rejetée au décodage.

### Machine de mission

```text
connecting → ready ↔ turn_active ↔ response_active → draining → closed
                  ↘ recovering_route ↗
```

Une mission accepte un seul tour utilisateur actif. Une nouvelle reprise de parole annule
atomiquement la réponse précédente avant que son nouveau tour devienne exécutable.

`recovering_route` est une gate bloquante, pas un état décoratif. Une coupure ou une congestion
persistante doit annuler durablement le tour actif, invalider sa génération et ses contrôles, puis
faire reprendre la même mission par CAS avec un `missionConnectionEpoch` supérieur et le dernier
contexte exactement acquitté. Aucun PCM non acquitté n'est rejoué. Après un nombre borné de
tentatives, la mission est fermée avant une nouvelle session Mistral push-to-talk ; elle ne bascule
jamais secrètement vers OpenAI. Tant que l'orchestrateur mobile n'appelle pas réellement ce chemin
et qu'un test réseau dégradé ne le prouve pas, v2 n'est pas activable.

### Machine de tour

```text
created → ingesting → committed → transcribing → reasoning → rendering → delivering → completed
             └────────────── cancel_requested ───────────────→ cancelled
```

Chaque transition est monotone et CASée. `cancelled` invalide transcript tardif, rendu, artefact,
contrôle et reprise audio.

Un tour possède ses propres deadlines durables. La deadline de transcript/réponse commence au
`turn.commit`, et non à l'ouverture de la mission ni au budget audio maximal. Une expiration ferme
la sous-session fournisseur, annule le tour et interdit tout effet tardif. Après perte d'owner, un
reaper ou le nouvel owner CASé doit pouvoir annuler le tour orphelin sans conserver de PCM brut ni
condamner automatiquement toute la mission.

### Contrat mobile v2

- authentification texte stricte avec `resumeNextServerSequence`, puis contrôles stricts et audio
  binaire borné ;
- `session.ready` fixe le `missionConnectionEpoch`, le contexte acquitté, le curseur audio et le
  budget maximal de mission ; aucun de ces compteurs ne vient du mobile ;
- `context.update { contextRevision, contextDigest }` n'est accepté qu'au repos et ne rouvre
  l'écoute qu'après `session.context_updated` ; un tour ne peut jamais embarquer silencieusement
  une révision supérieure ;
- `turn.start { clientTurnId, contextRevision, contextDigest, vadStartedAtMs, preRollMs }` ;
- trames PCM liées à l'ordinal et séquencées globalement ;
- `turn.commit { clientTurnId, lastAudioSequence, vadEndedAtMs }` ;
- `turn.cancel { clientTurnId, cancellationId, reason }` idempotent ;
- `events.ack { missionConnectionEpoch, nextServerSequence }` cumulatif, émis seulement après
  réduction locale de tous les événements antérieurs et jamais au milieu d'un takeover ;
- `session.end { reason }` explicite, limité côté client à `user`, `background`,
  `context_changed` ou `client_handoff` ;
- ACK serveur pour start, commit, cancel et terminalité ; aucune transition déduite d'une fermeture
  de socket.

Les limites restent fail-closed : pré-roll ≤ 300 ms, PCM16 mono 16 kHz, file et débit bornés,
horloges VAD monotones, séquences sans trou et budgets par tour et par mission. Une trame admise
consomme définitivement sa séquence et son budget, même si le tour est annulé avant `commit`.

Le backpressure n'autorise ni buffer infini, ni perte silencieuse, ni saut de séquence. Un seuil
souple arrête l'acquittement de nouveaux frames vers la capture native et déclenche une fenêtre de
drain bornée. Si le seuil bas n'est pas retrouvé, le serveur annule durablement le tour avec la
raison `network_backpressure`, brûle les séquences déjà admises et place la mission en
`recovering_route`. Si la reprise échoue, la mission se ferme avec une erreur récupérable et l'UI
propose de réessayer en push-to-talk. La falaise v1 actuelle à 256 Ko ne doit pas être réutilisée
comme politique v2. Seuils, temps de drain et compteurs viennent d'un profil signé serveur et sont
mesurés par route/réseau.

### Reprise, curseur et outbox

`serverSequence` est un identifiant mission-global, monotone et sans wrap. Un même couple
`(sessionHandle, serverSequence)` désigne pour toujours le même événement canonique. Le client
applique un effet uniquement lorsque la séquence reçue égale son prochain curseur attendu : une
séquence inférieure est un replay sans nouvel effet, une séquence supérieure est un trou fatal et
ne provoque jamais de fast-forward.

Le client conserve son curseur au-dessus de la socket et le lie à `sessionHandle` et au dernier
`missionConnectionEpoch` accepté. Son ACK cumulatif est envoyé seulement après application locale ;
sur takeover, il attend obligatoirement le `session.route_recovered` du nouvel epoch. Un ancien
owner ne peut donc ni avancer l'ACK, ni acquitter un contrôle, ni remettre le curseur à zéro.

`authority.open` exécute sous une seule transaction : vérification du grant et de l'expiration,
lock/CAS de l'owner, refus d'un curseur en avance, calcul de
`min(resumeNextServerSequence, acknowledgedServerSequence)`, annulation du tour orphelin, append du
suffixe recovery puis lecture de l'outbox contiguë jusqu'au nouveau high-watermark. Il retourne
une `RecoveryMetadata` contenant le high-watermark **avant** takeover, l'epoch précédent, la
génération d'annulation précédente et la corrélation éventuelle du tour annulé. Le gateway valide
donc l'incrément exact de l'epoch et de la génération, le préfixe rejoué et le suffixe courant. Un
historique purgé, troué, trop volumineux ou incohérent retourne `history_unavailable` sans muter
version, lease, epoch ni outbox.

Une ouverture sur une mission `draining` ou `closed` ne constitue jamais un takeover live. Sous le
statut distinct `terminal_replay`, l'autorité termine atomiquement un `draining` par un unique
`session.closed`, ou relit sans mutation un `closed` déjà canonique. L'epoch ne bouge pas, aucun
provider n'est ouvert, aucune commande métier n'est acceptée et le gateway referme ensuite la
socket proprement. Le replay peut être vide uniquement si le terminal a déjà été entièrement
acquitté.

La réponse d'ouverture est bornée à 256 événements et 240 Kio, soit sous le high-watermark
downlink de 256 Kio. Une mission live conserve trois places et 48 Kio pour
`turn.cancelled + session.draining + session.closed` : la fenêtre non ACKée est donc limitée à 253
événements et 192 Kio. Une nouvelle transition qui franchirait cette fenêtre retourne
`replay_window_exhausted` puis utilise exclusivement la réserve terminale ; elle ne crée jamais une
mission impossible à reprendre. L'adapter SQL doit appliquer `LIMIT max + 1` et sommer
`payloadBytes` sous lock avant toute matérialisation ou rotation de lease.

`serverSequence`, `missionConnectionEpoch` et la version durable ne wrappent jamais. Chaque
transition laisse les séquences et deux versions nécessaires au drain/close ; un takeover qui ne
peut plus incrémenter l'epoch ou préserver cette réserve terminalise l'ancien snapshot. Une
deadline de replay dédiée est distincte du timeout d'authentification et de la deadline provider.

L'outbox est immuable, unique par tenant + mission + séquence et conservée jusqu'à l'expiration dure
de la mission plus sa période de grâce. Une perte de socket, un callback d'envoi en échec ou une
congestion downlink rend la route récupérable : le process coupe immédiatement capture/provider,
mais ne draine ni ne ferme durablement la mission. Le prochain takeover annule le tour et rejoue
l'intervalle manquant. À l'inverse, `session.end`, expiration, arrêt de service et faute de protocole
terminent explicitement la mission.

Deux exigences restent bloquantes avant rollout : le bootstrap doit distinguer expiration de
capacité et `replayGraceExpiresAt`, afin qu'un terminal `expired` perdu reste relisible sans rouvrir
une capacité métier ; et le mobile/gateway doivent décider puis certifier l'ACK terminal permettant
le pruning (la livraison est déjà rejouable sans lui, mais l'acquittement durable n'avance pas après
`session.closed`).

#### Capacité de reprise et grâce terminale

La reprise n'émet jamais une seconde admission. La lease initiale représente le droit d'occuper la
session ; un ticket de reprise représente seulement le droit ponctuel, one-shot, de reprendre cette
même mission. Il est émis par une route HTTP authentifiée à partir du principal serveur, stocké
uniquement sous forme SHA-256 et lié à : tenant, sujet HMAC + version de clé, mission,
`sessionHandle`, protocole, premier curseur non appliqué et dernier `missionConnectionEpoch`
accepté. Son TTL est court et sa portée est explicite : `live_takeover` avant l'expiration dure ou
`terminal_replay` pendant la grâce. Il ne crée ni lease ni événement d'admission.

Le ticket ne peut pas être consommé puis la mission ouverte dans deux transactions. L'autorité
PostgreSQL expose un unique `redeemAndOpen` qui, sous RLS et locks ticket + mission :

1. vérifie le hash one-shot, le tenant, le sujet, la session, le protocole, le curseur, l'epoch, la
   portée et l'horloge BDD ;
2. vérifie la lease initiale encore active pour un takeover live ;
3. CAS l'epoch `N → N + 1`, change l'owner, annule le tour orphelin et calcule le suffixe contigu ;
4. consomme le ticket dans le même commit.

Deux tickets différents liés à l'epoch `N` ne peuvent donc jamais produire deux takeovers. Un
crash ou rollback laisse ticket et mission réessayables ensemble. Le ticket brut ne traverse aucun
autre port et n'entre jamais dans les logs.

Jusqu'au déploiement de ce `consume-result` discriminé, le bootstrap générique reste fail-closed à
`H` dans le gateway : la grâce durable ne constitue pas, à elle seule, une capacité réseau. Les
méthodes de l'autorité possèdent en outre leur transaction PostgreSQL racine et refusent toute
transaction ambiante ; Prisma n'offrant pas de savepoint imbriqué ici, cette règle empêche un appelant
de capturer une erreur puis de committer un outbox ou un side-effect écrit avant un CAS perdant.

Soit `H = hardExpiresAt` et `G = replayGraceExpiresAt`, selon `clock_timestamp()` lu sous lock :

| Fenêtre | Mission | Autorisé |
| --- | --- | --- |
| `t < H` | absente | création avec capacité initiale live |
| `t < H` | live | commandes métier, ACK et takeover live |
| `t < H` | draining/closed | fermeture, replay terminal et ACK |
| `H ≤ t < G` | absente | refus |
| `H ≤ t < G` | live/recovering | `drain(expired)`, `close`, replay et ACK uniquement |
| `H ≤ t < G` | draining | `close` en conservant la raison déjà commitée, replay et ACK |
| `H ≤ t < G` | closed | replay et ACK uniquement |
| `t ≥ G` | toute phase | aucun accès client ; rétention/purge seulement |

Les bornes sont exclusives : à `H`, aucune nouvelle mutation métier ; à `G`, aucun replay. Une
intention client reçue avant `H` mais linéarisée après `H` perd face à `expired`. Un `drain(user)`
déjà commité conserve en revanche sa raison canonique. Après `H`, nouveau tour, PCM, contexte,
route, transcript, pipeline, completion, contrôle et erreur métier sont interdits.

Le replay terminal utilise une phase gateway `replay_only` : aucun provider ni pipeline n'est
ouvert et seule une trame texte `events.ack` est acceptée. Son ACK passe par un port PostgreSQL
étroit, autorisé par la capacité de reprise consommée et incapable de changer owner, epoch, route,
contexte, audio ou outbox. Pendant la grâce, cet ACK n'entre pas dans le ledger de commandes : son
idempotence vient du curseur durable monotone (`ACK ≤ curseur courant` est un replay sûr), ce qui
interdit de greffer après coup un faux ledger ACK sur une version produite par drain ou fermeture.
Le gateway traite aussi l'ACK reçu synchroniquement pendant l'ouverture,
attend une fenêtre courte bornée par `G`, puis ferme ; la perte de cet ACK reste récupérable par un
nouveau ticket. Une mission abandonnée par crash devient purgeable après sa rétention même si elle
n'a jamais atteint `closed`.

### VAD, AEC et barge-in

Le VAD s'exécute dans le moteur natif **après** le traitement voix, en fenêtres 10/20 ms avec
hystérésis, pré-roll borné et endpointing adaptatif. Pendant la réponse, le micro reste actif
uniquement sur une route certifiée AEC.

Au premier `speechStarted` :

1. la queue de lecture native devient silencieuse immédiatement ;
2. sa génération audio est invalidée pour interdire toute reprise ;
3. le pré-roll et `turn.start` partent vers le gateway ;
4. l'annulation durable de la réponse précédente est publiée ;
5. aucun ancien contrôle ne peut ensuite être acquitté.

Si AEC/route/VAD ne sont pas certifiés, v2 reste multi-tour mais passe en `push_to_talk`. Le champ
`fullDuplexCertified` ne peut venir que d'un profil signé serveur + capacité locale compatible.

La certification VAD emploie des fixtures PCM reproductibles : silence, voix proche, voix faible,
lecture Bob seule, double-talk, perceuse/compresseur, véhicule, vent et routes haut-parleur,
écouteur, filaire et Bluetooth. Pour chaque route certifiée, le corpus doit démontrer au minimum
zéro faux barge-in pendant 30 minutes de lecture Bob + bruit, ≥ 95 % de détection des reprises de
parole, aucun début de mot perdu grâce au pré-roll et un endpoint p95 ≤ 900 ms. Une route qui ne
tient pas ces gates reste push-to-talk, même si le matériel annonce une capacité AEC.

### Parole segmentée et contrôles

Bob produit de courts segments canoniques. Chaque segment dynamique passe entièrement par
TTS → ASR indépendant → comparaison → stockage privé avant sa lecture. Le segment 0 peut être lu
pendant l'audit des suivants, sans jamais diffuser d'octet non certifié.

Un contrôle métier est attaché à la réponse mais n'est échangeable qu'après livraison de tous les
segments marqués `requiredForControl`. Toute interruption antérieure le rend définitivement nul.

Le contrôle reste verrouillé dans le stockage durable jusqu'à l'ACK de livraison du dernier segment
requis. Le passage `locked → redeemable` doit être une transition atomique fencée par owner et
génération ; une erreur de side-effect après persistance ne doit jamais créer une fenêtre où un
contrôle annulé peut être consommé.

### Contexte et multi-réplique

Un changement d'écran coupe micro et lecture, annule le tour, publie la nouvelle révision durable,
puis rouvre le micro seulement après ACK du `missionConnectionEpoch`. `LISTEN/NOTIFY`, outbox ou
bus équivalent transporte context/cancel/hangup vers la réplique propriétaire avec accusé durable.
Le sticky routing seul n'est pas une preuve.

### Cycle fournisseur, sécurité et rétention

Une sous-session Voxtral peut être ouverte après l'acceptation durable de `turn.start`, en parallèle
de la capture du pré-roll. `turn.commit` arme une deadline fournisseur distincte. Si le provider
n'est pas prêt ou ne finalise pas avant cette deadline, le tour échoue sans fermer arbitrairement
la mission et sans exécuter le pipeline Bob.

Chaque sous-session est fermée dans un `finally` sur succès, annulation, timeout, takeover et
hangup. Bob ne persiste pas le PCM utilisateur brut. Transcript, empreintes et métadonnées d'audit
suivent leur politique de rétention tenant. L'admission v2 réutilise sans affaiblissement le
consentement, l'entitlement `voice_live`, la région et les flags licence/sous-traitant de v1 ; une
route STT dont les conditions de traitement ne sont pas approuvées échoue fermée avant le premier
octet audio.

Le « passage client » ne change pas d'interlocuteur à l'intérieur d'une mission Bob. Entrer dans ce
mode envoie `session.end { reason: client_handoff }`, coupe capture et lecture, invalide les
contrôles et attend leur fermeture. Le retour de l'artisan crée une nouvelle mission et republie le
contexte. Cette suspension produit est dans le scope ; l'identification multi-locuteur et la
continuité d'une conversation entre personnes sont explicitement hors scope de v2.

## Conséquences

### Positives

- vraie conversation multi-tour sans dépendre d'un fournisseur speech-to-speech ;
- frontières Mistral-only et Bob brain inchangées ;
- interruption locale rapide et actions toujours auditables ;
- v2 peut offrir un push-to-talk mature avant la certification duplex.

### Négatives

- handshake Voxtral par tour ; préchauffage et mesure sont nécessaires pour tenir le p95 ;
- capture/VAD natifs déjà amorcés, mais playback unifié, AEC, routes et lifecycle à terminer sur
  iOS et Android ;
- nouveaux états durables, reaper et commandes inter-réplique ;
- audit segmenté plus complexe et plus coûteux.

### Risques et mitigations

- **Faux barge-in** : fixtures DSP, double-talk, seuils par route et kill-switch serveur.
- **Premier son trop lent** : segments courts, provider préchauffé, métriques par étape.
- **Audio annulé rejoué** : génération native + CAS serveur + test de dix interruptions.
- **Action partiellement entendue** : `requiredForControl` et annulation irréversible.
- **Congestion uplink** : drain borné, annulation du seul tour et reprise de route mesurée.
- **Tour orphelin** : deadline durable, takeover CAS et purge sans effet tardif.
- **Dérive fournisseur** : codecs stricts, canary officiel et aucune hypothèse sur des événements
  Voxtral non documentés.

## Plan d'implémentation et gates

1. Codecs v2 et machines d'état — implémentés ; figer leur contrat après seconde revue.
2. Gateway multi-tour push-to-talk : fermer deadlines post-commit, contrôle verrouillé, historique
   borné, persistance PostgreSQL/RLS, deux owners concurrents et effets tardifs.
3. Faire coexister `mistral-realtime-agent-sink.ts` uniquement comme chemin v1 one-shot. v2 utilise
   un adapter séparé ; il ne réutilise jamais `redemptionId` comme identité de tour. Supprimer v1
   seulement après drainage de ses sessions et rollback v2 éprouvé.
4. Raccorder capture/playback/VAD natifs, interruption locale, backpressure et `recovering_route` ;
   duplex encore désactivé.
5. Câbler livraison auditée segmentée, transition `locked → redeemable` et annulation de contrôle.
6. Câbler côté Mistral `speechStopped → firstAudio`, `bargeIn → audioCleared`, handshake, drain,
   recovery et coût par tour. Ajouter un usage-kind durable `provider_connection_open` avec
   fournisseur, modèle, tour et durée, sans donnée audio.
7. Canary une réplique, puis invalidation multi-réplique, reaper de tour et takeover PostgreSQL.
8. Corpus acoustique et matrice physique iOS/Android (haut-parleur/écouteur/filaire/Bluetooth,
   Wi-Fi/4G dégradée) ; conserver les rapports sous `docs/architecture/certification/`.
9. Sept jours de SLO avant ouverture.

Gates minimales : trois tours sur une WSS, changement de contexte, crash owner, réseau dégradé,
dix barge-ins sans reprise, p95 fin de parole→premier son ≤ 1 800 ms, p95 barge-in→silence
≤ 500 ms, zéro confusion tenant et zéro effet UI avant ACK audité.

Le coût de handshake, le délai fournisseur post-commit, les backpressures et les recoveries font
partie du tableau de bord canary. Une suite unitaire mémoire ne certifie ni takeover, ni RLS, ni
outbox : ces gates exigent PostgreSQL réel et au moins deux owners concurrents.

### Bascule et rollback v1 → v2

La version de protocole est choisie par l'admission pour une **nouvelle** mission. Désactiver v2
ferme immédiatement son admission, laisse les missions déjà prêtes se drainer pendant une fenêtre
bornée, puis les termine via le reaper ; aucune mission en cours n'est transformée en v1. Le schéma
et les audits v2 restent en place pendant le rollback. Une nouvelle session v1 Mistral peut être
proposée seulement après hangup v2 confirmé et nouveau ticket. Le rollback ne sélectionne jamais
OpenAI et ne supprime jamais les preuves d'audit.

## Références

- [Voxtral Realtime](https://docs.mistral.ai/studio-api/audio/speech_to_text/realtime_transcription)
- [Architecture audio Mistral](https://docs.mistral.ai/studio-api/audio/overview)
- [Bob Live — architecture et certification](../architecture/BOB_LIVE.md)
