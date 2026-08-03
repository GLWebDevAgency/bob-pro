# Spec P0 — Bob Live mobile : fermeture post-bootstrap

Date : 2026-08-03
Objectifs parents : O3 (GPT Realtime), O4 (mission continue), O5 (Voice Trace)
Statut : `specified`

Lot A — diagnostic fermé mobile → API : `implemented` localement, non certifié tant que le
rebase, la CI, le déploiement staging et la reproduction Android ne sont pas acquis.

## Problème prouvé

Sur l'APK preview branché à staging, le serveur ouvre correctement l'appel WebRTC, reçoit le
sideband, termine le bootstrap GPT Realtime et acquitte la capability Mission V2. Environ une
seconde plus tard, le mobile envoie `DELETE /voice/realtime/calls/:handle` sans avoir publié de
contexte et sans tour utilisateur.

La fermeture est donc située entre le retour du bootstrap acquitté et le premier
`PUT /context`. Elle ne doit pas être maquillée par une reconnexion : trois tentatives identiques
ont déjà transformé le défaut déterministe en `429`.

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
- [ ] Le bouton global et l'écran Assistant déclenchent le même propriétaire Bob Live ; aucun
      second moteur vocal ne peut concurrencer la session.
- [ ] Une reproduction Android preview sur staging ne ferme plus spontanément la session et
      atteint au minimum `context_confirmed` puis `microphone_opened`.

## Definition of Done

- tests ciblés mobile, API client et API verts ;
- typecheck mobile/API client/API vert ;
- review adversariale des contrats de données et de confidentialité ;
- PR unique, staging déployé selon `PR -> staging validé -> production` ;
- preuve appareil Android et contrôle Railway/Voice Trace corrélés ;
- le statut ne passe à `certified` qu'après cette preuve appareil.
