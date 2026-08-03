# Spec P0 — Bob Live mobile : fermeture post-bootstrap

Date : 2026-08-03
Objectifs parents : O3 (GPT Realtime), O4 (mission continue), O5 (Voice Trace)
Statut : `implemented`

Lot A — diagnostic fermé mobile → API : `implemented` localement, non certifié tant que le
rebase, la CI, le déploiement staging et la reproduction Android ne sont pas acquis.

Lot B — propriétaire mobile unique : `implemented` localement. Le composer Assistant et l'orbe
global consomment désormais l'unique `AgentSessionProvider` racine. L'ancien moteur local
`useVoiceInput`/`useSpeak`, son teardown au blur et sa machine semi-duplex ont été retirés ; la
session continue donc volontairement quand Bob navigue. Un contrat statique interdit qu'un second
module de production réimporte ces hooks audio.

Lot C — terminaison ordonnée et attribuée : `implemented` localement. Le transport WebRTC est
l'unique propriétaire du raccrochage quand il fournit lui-même le handle de session. Le client HTTP
conserve son comportement compensatoire historique pour tous les autres appelants. Lors d'un arrêt
utilisateur ou produit, le transport attend que le POST/ACK bootstrap soit réglé avant son unique
`DELETE`, sans retarder la libération du micro, du peer ni du lecteur natif. Le timeout réseau
borné reste l'exception distribuée : il déclenche l'abort transport puis le `DELETE`, dont le
tombstone serveur fence tout bootstrap tardif. Les arrêts produit sont journalisés comme `policy`
avec un vocabulaire fermé, distinct de `user`, `lifecycle` et `automatic_failure` ; aucune dépendance à
`AbortSignal.reason` n'est admise car le polyfill React Native 0.86 ne le transporte pas.

## Problème prouvé

Sur l'APK preview branché à staging, le serveur ouvre correctement l'appel WebRTC, reçoit le
sideband, termine le bootstrap GPT Realtime et acquitte la capability Mission V2. Environ une
seconde plus tard, le mobile envoie `DELETE /voice/realtime/calls/:handle` sans avoir publié de
contexte et sans tour utilisateur.

Preuve corrélée du 3 août 2026 à 13:01 : `lifecycle.activated` à 13:01:15,17,
`sideband.ready` à 13:01:15,32, `bootstrap.succeeded` (`gpt-realtime-2.1`) à 13:01:15,54,
receipt Mission acquitté à 13:01:15,83, puis `DELETE` initié par le mobile à 13:01:17,06.
Le serveur n'a donc ni refusé ni expiré la session : le terminal est exclusivement client.

La fermeture est donc située entre le retour du bootstrap acquitté et le premier
`PUT /context`. Elle ne doit pas être maquillée par une reconnexion : trois tentatives identiques
ont déjà transformé le défaut déterministe en `429`.

L'implémentation installée de `react-native-webrtc@124.0.7` prouve une divergence de
représentation Android : après un `setRemoteDescription` réussi, le cache JavaScript de la
transceiver peut encore exposer `currentDirection = null` ou même `undefined` si le bridge omet
la clé. C'est une cause terrain fortement compatible avec la chronologie observée, qui restera
à confirmer par le checkpoint de l'APK. Le code P0 exigeait une valeur non nulle et pouvait donc
raccrocher avant le canal de données. Cette absence ne peut être acceptée que sous une seconde preuve fermée :
même transceiver unique, direction locale inchangée et descriptions `offer`/`answer` réellement
appliquées au peer avec les directions SDP exactes du contrat audité ou natif.

## Objectif

Rendre la chaîne mobile post-bootstrap déterministe et diagnosticable, identifier sa frontière
fautive sur l'appareil réel, puis la corriger sans affaiblir les fences de sécurité WebRTC,
Mission ou contexte.

## Périmètre

- transport WebRTC mobile après ACK du bootstrap ;
- composition du lecteur audio audité Expo ;
- transfert/adoption de la capability Mission ;
- publication du contexte avant ouverture du microphone ;
- même contrôleur de session pour le bouton Bob global et l'écran Assistant ;
- diagnostic technique structuré visible dans les logs staging et corrélé au handle de session.

## Hors périmètre

- fournisseur Mistral et protocole Voxtral ;
- nouvelles actions métier ou nouveaux kinds de mission ;
- suppression de compte ;
- assouplissement spéculatif du contrat SDP, de la piste distante ou des capabilities.

## Invariants

1. Le microphone ne s'ouvre jamais avant contexte publié, fence synchronisée et capability
   Mission confirmée.
2. Une fermeture automatique post-bootstrap transporte une cause issue d'un vocabulaire fermé.
   Une fermeture explicite de l'utilisateur reste distincte.
3. Aucun SDP, token, URL signée, transcription, audio, identifiant métier ou texte libre n'entre
   dans ce diagnostic.
4. Une Mission M2-A ne tente aucune reconnexion générique, y compris après une panne transport
   classée transitoire : seule sa reprise durable explicite peut reconstruire l'autorité. Le
   contrôleur ferme donc la mission au lieu de recréer une capability ou d'activer le legacy.
5. Une session ne possède qu'un transport, une capability Mission et un contrôleur actif.
6. Le serveur revalide l'identité tenant/utilisateur/session avant d'accepter un diagnostic.
7. Une `currentDirection` absente (`null` ou `undefined`) n'est jamais une preuve. Elle est tolérée
   uniquement si les deux SDP appliquées au peer prouvent le même contrat ; une valeur non nulle
   incompatible, une identité différente, une topologie multiple ou une description absente
   reste refusée.
8. Un handle ne reçoit qu'un seul `DELETE`. Le propriétaire de la compensation est explicite :
   client HTTP par défaut, transport uniquement pour WebRTC avec un handle UUID connu.
9. Un arrêt utilisateur ou produit pendant le bootstrap libère immédiatement les ressources
   natives mais n'envoie jamais le `DELETE` avant le règlement du POST/ACK. La cause terminale est
   capturée avant l'abort. Après expiration du timeout réseau borné, attendre indéfiniment un
   binding `fetch` défaillant est interdit : le `DELETE` peut gagner, mais son tombstone durable
   doit refuser tout bootstrap tardif sur le même handle.
10. Une règle produit (`entitlement_unconfirmed`, `entitlement_revoked`, `incompatible_route`) ne
    peut jamais être présentée dans les traces comme un geste utilisateur.
11. Une session Live et un tour texte Assistant ne peuvent jamais posséder simultanément la
    navigation ou les mutations. Une session active reste toujours arrêtable.
12. Une réponse d'abonnement en cache accompagnée d'une erreur réseau n'est plus une autorité :
    elle ferme le micro comme `entitlement_unconfirmed` sur les deux surfaces `voice_live`.
13. Un handoff est consommé par compare-and-set sur son identifiant. Le terminal asynchrone A ne
    peut ni effacer ni rendre invisible une proposition B plus récente.
14. Les tours Live terminaux ont des identifiants immuables et restent visibles dans le fil
    Assistant pendant les navigations, après l'arrêt et entre sessions successives tant que le
    provider authentifié reste monté. Le journal UI en mémoire est borné à 256 tours ; cette borne
    n'autorise jamais à élargir l'historique métier court transmis au modèle.

## Limite connue non causale — restitution texte de Bob

Ce P0 rétablit la durée de session, l'audio, le contexte et les actions. Il ne réhabilite jamais le
transcript du fournisseur comme vérité UI. Sur le transport audité dynamique, le texte canonique
n'est aujourd'hui conservé que chiffré dans Voice Trace et dans l'owner sideband de la réplique ;
il n'existe pas encore de projection canonique relisible par le mobile après l'ACK acoustique. Une
spec dédiée devra fournir une enveloppe canonique durable, chiffrée, bornée par TTL et compatible
multi-réplique. Ce manque peut retirer une bulle texte du fil, mais ne peut ni fermer la session ni
annuler un tour vocal.

## Checkpoints fermés

Le dernier checkpoint réussi et la classe terminale doivent permettre de distinguer au minimum :

- bootstrap acquitté ;
- réponse SDP validée ;
- description distante appliquée ;
- transceiver validé ;
- canal de données ouvert ;
- lecteur audité créé ;
- capability Mission adoptée ;
- publication du contexte commencée puis confirmée ;
- microphone ouvert.

## Critères d'acceptation binaires

- [x] Tout échec automatique après bootstrap produit exactement un diagnostic terminal redacted,
      avant ou avec le hangup ; aucune erreur technique n'est réduite au seul `bootstrap_failed`.
- [ ] Les logs staging permettent, à partir d'un handle, de lire le dernier checkpoint réussi et
      la cause terminale en une recherche.
- [x] Un test transport couvre chaque frontière WebRTC post-ACK et prouve un seul hangup avec la
      cause exacte.
- [x] Un test de composition couvre l'échec de création du player audité avec sa cause exacte.
- [x] Un test contrôleur couvre le refus d'adoption Mission avant tout `PUT /context`.
- [x] Le chemin heureux prouve : capability prise une fois, contexte publié une fois, microphone
      ouvert après confirmation, zéro hangup automatique.
- [x] Une Mission M2-A possède un budget de reconnexion générique nul : panne transitoire,
      primaire créé une fois, aucun délai de retry et aucun second bootstrap.
- [x] Les deux contrats WebRTC (audio audité `sendonly/recvonly` et natif
      `sendrecv/sendrecv`) acceptent une `currentDirection` Android absente uniquement sous
      SDP appliquées exactes ; une SDP appliquée incompatible reste terminale.
- [x] Le bouton global et l'écran Assistant déclenchent le même propriétaire Bob Live ; aucun
      second moteur vocal ne peut concurrencer la session.
- [x] Un test vertical `RealtimeWebRtcTransport` + vrai `HttpBobClient` ferme pendant le bootstrap,
      prouve zéro `DELETE` prématuré puis exactement un `DELETE policy` après règlement.
- [x] Le timeout réseau reste borné ; le serveur prouve qu'un `DELETE` gagnant avant un bootstrap
      tardif pose un fence durable, refuse le provider et n'autorise aucune seconde terminaison.
- [x] Le champ interne de propriété de terminaison ne traverse jamais le wire ; son usage sans
      transport WebRTC et handle UUID est refusé avant toute requête réseau.
- [x] Les trois motifs produit sont acceptés par le parseur fermé et le serveur ; une valeur libre
      ou une clé supplémentaire reste refusée.
- [x] Voice Trace conserve la source exacte (`automatic_failure`, `lifecycle`, `policy`) jusque
      dans `session_closed`, avec migration expand/validate générée et test writer N-1 exact.
- [x] Tour texte, confirmation manuelle et démarrage Live sont mutuellement exclusifs ; le bouton
      d'arrêt Live reste explicite, accessible et disponible.
- [x] Une consommation de handoff obsolète est sans effet et les tours Live sont réinjectés une
      seule fois dans le fil Assistant.
- [ ] L'API et les migrations acceptant `terminationSource=policy` sont déployées et vérifiées sur
      staging AVANT la diffusion de l'APK preview. Le rollback serveur ne descend jamais sous ce
      contrat tant que cette APK peut se connecter.
- [ ] Une reproduction Android preview sur staging ne ferme plus spontanément la session et
      atteint au minimum `context_confirmed` puis `microphone_opened`.

## Definition of Done

- tests ciblés mobile, API client et API verts ;
- typecheck mobile/API client/API vert ;
- review adversariale des contrats de données et de confidentialité ;
- PR unique, staging déployé selon `PR -> API+migrations validées -> APK preview` ;
- le reaper durable et la hard-expiry restent le repli documenté d'un `DELETE` réseau non acquitté ;
- preuve appareil Android et contrôle Railway/Voice Trace corrélés ;
- le statut ne passe à `certified` qu'après cette preuve appareil.
