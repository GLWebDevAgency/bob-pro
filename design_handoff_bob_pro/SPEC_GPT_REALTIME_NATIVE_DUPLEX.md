# SPEC — GPT Realtime natif : duplex, barge-in et autorité durable

**Statut** : en implémentation, non activable en production avant certification physique.

**Décision du 22 juillet 2026** : le chemin natif reste limité aux paroles génériques à faible
risque. Le Jarvis métier OpenAI cible le contrat hybride et l'autorité « une seule voix par tour »
définis dans `SPEC_OPENAI_HYBRID_SPEECH.md`. Le présent lot construit et éprouve le transport natif ;
il ne doit pas être interprété comme une autorisation de prononcer nativement des faits métier.

## 1. Résultat produit

Quand Bob Live sélectionne OpenAI, le même appel GPT Realtime reçoit le microphone et restitue la
voix par WebRTC. Le microphone reste ouvert pendant la parole de Bob afin que l'utilisateur puisse
l'interrompre naturellement. Le cerveau métier, le contexte d'écran, les contrôles et les mutations
restent exclusivement sous l'autorité de Bob Pro.

Le mode Mistral conserve son transport et sa parole par artefact audité. Aucun fallback implicite,
appel concurrent ou mélange de clés n'est autorisé dans une session.

### 1.1 North Star produit — le « Jarvis métier » de Bob

Ce lot est le système nerveux de Bob, pas sa définition de réussite produit. Une connexion audio
fluide ne vaut jamais « Bob terminé ». La cible est un agent qui comprend l'écran de départ,
conserve le contexte après chaque navigation et achève une mission métier multi-étapes sur les
données réelles. Il ne sollicite l'utilisateur que pour désambiguïser un choix réel, compléter une
donnée absente ou confirmer une action qui l'exige.

La parité voix/tap est structurelle : Bob et l'interface manuelle invoquent les mêmes use cases,
subissent les mêmes invariants et montrent les mêmes choix, diffs et confirmations. Tout geste
manuel autorisé dans l'application doit donc devenir composable dans une mission vocale ; la voix
ne possède aucun raccourci métier caché et ne peut jamais inventer une donnée ou contourner une
validation. Le devis complet — client, lignes issues du catalogue ou créées, prix/TVA, récapitulatif
et confirmation — reste le scénario canonique de bout en bout. Transport, boucle agentique et
mission métier possèdent des DoD distinctes et doivent toutes être certifiées avant de revendiquer
« Bob partout ».

## 2. Contrats de livraison séparés

- `openai-native-webrtc-v1` : RTP descendant GPT Realtime, plein duplex candidat, contrôle durable
  distinct de la metadata fournisseur ;
- `audited-signed-url-v1` : artefact privé TTS/ASR actuel, utilisé par Mistral et disponible comme
  chemin à exactitude acoustique pré-audible.

Le bootstrap et le client discriminent ces contrats. Un client ancien, une réponse ambiguë ou une
configuration partielle échoue fermé ; il ne joue jamais les deux sorties.

## 3. Autorités et invariants

1. Le sideband garde `create_response=false`, `tools=[]` et `tool_choice='none'`. Seul le serveur
   Bob peut demander une restitution vocale.
2. `BobAgent` produit le texte canonique à partir du contexte durable et des use cases. OpenAI ne
   reçoit qu'une demande hors conversation (`conversation: 'none'`) de prononcer ce texte.
3. La metadata OpenAI ne contient aucun payload métier, route, `proposalId` ni commande. Elle ne
   transporte que des identifiants opaques de corrélation bornés.
4. Chaque rendu natif possède une machine durable monotone et un dispatch **at-most-once**. Un
   résultat réseau ambigu n'est jamais rejoué.
5. Une réponse n'est complète côté fournisseur qu'après transcription finale concordante,
   `response.done` réussi, `output_audio_buffer.stopped`, persistance de l'usage et contexte toujours
   courant. Selon le contrat OpenAI, `output_audio_buffer.stopped` signifie que le buffer est
   entièrement drainé **sur le serveur** ; cet événement ne prouve jamais à lui seul la fin du rendu
   haut-parleur local.
6. Une divergence, un outil, une réponse inconnue, un chevauchement ou un événement malformé
   annule/purge, révoque tout contrôle et ferme la session si l'autorité ne peut plus être prouvée.
7. Une action reste une capacité opaque issue du cerveau Bob. Elle n'est consommable qu'après la
   complétion serveur, un ACK mobile durable post-observation V1 et une nouvelle validation du
   contexte. En V1, cette observation n'est explicitement **pas** une preuve de lecture complète.
8. La metadata provider seule n'autorise jamais navigation, proposition ou mutation. Le mobile
   refuse toute référence dépourvue du reçu durable Bob.
9. Le barge-in coupe le son local immédiatement, puis envoie `response.cancel` et
   `output_audio_buffer.clear`. Aucun événement tardif ne peut ressusciter une ancienne génération.
10. Le micro reste fermé jusqu'à l'ACK exact du premier contexte. Il reste ensuite actif pendant la
    sortie Bob, sous réserve de l'AEC native certifiée sur appareils.

## 4. Limite d'exactitude explicitement assumée

Le RTP natif peut être entendu avant `response.output_audio_transcript.done`. L'audit de transcript
est donc un garde de révocation et de contrôle, pas une preuve indépendante préalable à l'écoute.
Il ne peut pas retirer une phrase déjà entendue.

Conséquences de rollout :

- le master Bob Live reste fermé pendant ce lot ;
- aucune communication « exactitude acoustique préauditée » n'est permise pour ce mode ;
- la première activation native est limitée aux comptes internes, puis aux réponses non
  actionnables et à faible risque ;
- les paroles financières, légales, contractuelles ou portant un contrôle restent sur le chemin
  préaudité tant qu'une certification et un ADR de risque dédiés ne les autorisent pas.

## 5. Machine durable cible

```text
prepared → dispatching → requested → accepted
         → streaming → draining → completed → delivered
         ↘ cancelled | failed | expired
```

- `dispatching` est le claim atomique avant `socket.send` ;
- `completed` exige transcript conforme + génération terminée + buffer fournisseur drainé + usage
  accepté ;
- `delivered` exige l'ACK mobile exact, tenant/session/turn/contexte scellés et une observation locale
  versionnée. La V1 n'accepte que
  `webrtc_remote_rtp_observed_provider_drained_v1`, preuve honnête que du RTP distant a été observé et
  que le fournisseur a fini d'émettre, **pas** une preuve DAC ou d'audibilité ;
- `native_playout_queue_drained_v1` reste réservé et refusé tant qu'un callback natif générationnel
  ne prouve pas la vidange de la file locale sur iOS et Android ;
- tous les états terminaux sont immuables ;
- un contrôle référence en XOR soit un artefact audité, soit une livraison native, jamais les deux.

### 5.1 ACK distribué, vérité UI et rotation des clés

- un ACK reçu avant `completed` rend l'erreur machine-typée
  `bob-live-native-acknowledgement-not-ready` avec `Retry-After: 1`. Le mobile rejoue le même corps
  et le même `acknowledgementId` ; un mismatch réel, un état terminal divergent, un 404 ou un 409
  reste fatal ;
- la notification HTTP vers le manager sideband n'est qu'un fast-path process-local. Après
  `completed`, l'owner relit l'autorité PostgreSQL dans une fenêtre bornée : un ACK écrit par une
  autre réplique converge donc sans sticky session ni bus mémoire ;
- seul le `canonicalSpeech` déjà approuvé et conservé par l'owner peut entrer dans l'historique Bob.
  Le transcript fournisseur sert à la concordance durable mais n'est jamais publié comme vérité UI ;
- `output_audio_buffer.stopped` ne mute pas la piste native : le buffer serveur est drainé mais la
  queue jitter/DAC locale peut encore porter sa fin. Après ACK durable, cette queue ne conserve la
  piste ouverte que pendant une grâce bornée de **1,5 s**, liée à la génération et révocable. Une
  nouvelle réponse, un barge-in, une annulation, un changement de contexte, une interruption ou le
  teardown annulent la grâce et coupent la piste immédiatement ;
- les deux terminaux fournisseur restent obligatoires pour une livraison heureuse. Si
  `output_audio_buffer.stopped` n'est pas suivi de `response.done` sous **5 s**, ou si un
  `response.done=completed` avec audio n'est pas suivi de `output_audio_buffer.stopped` sous
  **30 s**, le tour échoue fermé. Le premier événement arme une échéance non extensible par ses
  doublons ; `cancelled` termine immédiatement après mute et n'attend aucun second terminal ;
- les HMAC sujet sont dérivés courant d'abord, puis depuis une keyring explicite de 32 versions au
  maximum. Cette liste exacte est copiée avant toute suspension et comparée avec
  `timingSafeEqual` après **une seule** lecture durable ; une rotation ne multiplie donc jamais les
  transactions PostgreSQL par le nombre de clés. Toute nouvelle livraison persiste sa
  `subjectKeyVersion` ; l'ACK doit correspondre à cette version exacte. Seules les lignes N-1
  historiques à `NULL` comparent toutes les clés configurées, sans boucle DB ;
- les keyspaces `bob-live-subject-hmac-v1` et `openai-native-speech-proof-hmac-v1` sont stageés
  atomiquement par `manage-bob-live-native-key-versions.mjs`. Chaque version preuve est liée de
  manière append-only au SHA-256 des octets UTF-8 exacts passés à HMAC. Le boot OpenAI natif prend
  un verrou partagé et refuse version hors plage, binding absent, keyring incomplète ou substitution
  A/v1 → B/v1. Les inserts prennent les mêmes verrous : un writer N-1 ne peut pas gagner après un
  retire ;
- une rotation de clé preuve ne possède aucun fallback implicite : flag natif coupé, sessions
  OpenAI drainées, reaper terminé, puis
  `apps/api/prisma/openai-native-proof-key-rotation-cert.sql` doit passer en lecture seule avant le
  retrait de l'ancienne clé (`psql "$DIRECT_URL" --set proof_key_version="$BOB_LIVE_PROOF_KEY_VERSION"
  --set proof_key_fingerprint="<sha256-utf8-du-secret-courant-calculé-hors-historique-shell>"
  --file apps/api/prisma/openai-native-proof-key-rotation-cert.sql`) ;
- `completed → delivered` et toute transition en vol restent impossibles sans la clé de preuve de
  la ligne. Après terminalisation, le replay exact, le conflit terminal et la réconciliation owner
  sont en revanche décidés depuis l'état immuable sans ancienne clé ; une réponse HTTP d'ACK perdue
  reste donc rejouable pendant toute la rétention ;
- une ligne N-1 `delivered` dont l'observation locale vaut `NULL/NULL` reste lisible pendant
  l'expand, mais elle est explicitement **non prouvée** : aucune réconciliation/histoire n'en découle
  et le certificat de rotation/activation la bloque jusqu'à sa purge de rétention.

### 5.2 Maintenance et rétention V1

- un scheduler DB-only, indépendant du flag Bob Live et du fournisseur courant, terminalise les
  non-terminaux échus par lots tenantés avec `FOR UPDATE SKIP LOCKED` et horloge PostgreSQL ;
- la découverte ne dépend ni de `JOB_COMPANY_IDS`, ni d'un scan agrégé : un curseur keyset durable
  par lane, verrouillé en base, inspecte au plus `limit + 1` preuves via quatre indexes online et
  fige une borne haute de cycle. Même si de nouvelles preuves arrivent en continu, l'historique
  progresse sans famine ;
- chaque page est livrée **at-least-once** sous un `claimId` UUID avec lease de 30 secondes. Le
  curseur n'avance jamais lors du claim : un pod concurrent ne reçoit rien tant que le lease vit,
  puis une page expirée est relivrée à l'identique sous un nouveau claim ;
- le scheduler renouvelle le lease avant chaque transaction tenantée, elle-même bornée à quatre
  secondes. Il traite au plus un lot par tenant et n'ACKe la page qu'après le succès de tous ses
  tenants. Un ACK ou renouvellement portant un ancien claim est refusé sans effet ;
- `list`, `renew` et `ACK` s'exécutent dans une transaction globale dédiée : une première
  instruction pose réellement `statement_timeout=3s` et `lock_timeout=1s`, puis seulement la
  fonction directory est appelée, sous une seconde borne Prisma de quatre secondes. Le
  `statement_timeout` déclaré dans `proconfig` reste une défense secondaire et n'est jamais pris
  pour preuve, car PostgreSQL arme le timer du statement appelant avant d'entrer dans la fonction ;
- un crash après une mutation et avant l'ACK peut donc rejouer le lot, jamais le perdre. Les
  transitions et purges tenantées restent idempotentes ; le contrat ne prétend pas fournir de
  l'exactly-once ;
- la purge de rétention est bornée, tenantée, limitée aux terminaux échus et refuse toute racine
  encore référencée ; DELETE est encadré par FORCE RLS, une policy RESTRICTIVE et un trigger DB ;
- `provider_stream/v2` reste physiquement interdit par CHECK pendant la V1. Ce CHECK ne pourra
  être retiré que dans le même train qu'une purge atomique consommation → grant → livraison ;
- le runtime ne reçoit ni TRUNCATE, ni REFERENCES, ni TRIGGER, ni suppression des contrôles ;
- la preuve comportementale (CAS, horloge, courses, `SKIP LOCKED`, keyset et purge) s'exécute
  uniquement en CI sur un PostgreSQL loopback nommé `bob_ephemeral_*` ; le script de release live
  exécute séparément un certificat metadata-only en transaction `READ ONLY`, sans fixture ni DDL.

## 6. Critères d'acceptation binaires — code et contrats

- [x] Le config public et le bootstrap discriminent exactement les deux modes de livraison.
- [ ] Une session OpenAI native démarre avec une seule clé OpenAI et n'appelle jamais Mistral.
- [x] `output_modalities=['audio']`, `create_response=false`, aucun outil et budget borné sont
      vérifiés par tests de contrat provider.
- [x] Le sideband rejette réponse inconnue, metadata divergente, sortie texte, outil, réponse
      concurrente et événement malformé.
- [x] Le dispatch `response.create` est durable et at-most-once, y compris après résultat réseau
      ambigu ou reprise de processus.
- [x] Les ordres inversés `response.done` / `output_audio_buffer.stopped` convergent vers le même
      état fournisseur terminal sans double contrôle ; aucune preuve acoustique locale n'en est
      déduite.
- [x] Transcript absent/divergent, contexte obsolète, perte d'owner ou usage indisponible ne
      produisent ni livraison, ni historique complet, ni contrôle.
- [x] Un ACK arrivé avant `completed` est retryable avec le même reçu ; les conflits terminaux
      restent fatals et le transcript fournisseur n'est jamais publié comme autorité UI.
- [x] L'owner réconcilie un ACK PostgreSQL écrit par une autre réplique dans une fenêtre bornée.
- [x] Le barge-in révoque encore `completed` avant ACK et `cancelled + stopped` termine sans exiger
      un événement `cleared` fournisseur.
- [x] Le baseline RTP est repris après `buffer.started`; une hausse antérieure ne prouve jamais le
      tour courant et le drain serveur ne tronque pas la queue locale. Le probe peut être réarmé
      après un démarrage fournisseur lent, mais la métrique conserve `speech_stopped` comme origine.
- [x] La queue locale post-ACK est bornée à 1,5 s et génération-fencée ; les terminaux manquants
      échouent fermé à 5 s (`response.done`) ou 30 s (`output_audio_buffer.stopped`) sans que les
      doublons repoussent l'échéance, tandis que `cancelled` termine immédiatement après mute.
- [x] La rotation sujet est bornée, versionnée et n'induit qu'une lecture/CAS ; la rotation preuve
      est fingerprintée et conserve les décisions terminales sans ancienne clé, tandis que les
      états en vol et les delivered legacy sans observation sont fermés par les triggers, le boot,
      le certificat opérateur READ ONLY et une course writer/retire sur PostgreSQL réel.
- [ ] Le contrôle durable accepte une liaison XOR artefact/livraison native et reste one-shot,
      tenant-scopé, contextuel et anti-rejeu.
- [x] Le bootstrap OpenAI ne dépend pas du stockage audio signé ni du TTS Mistral.
- [x] Le bootstrap Mistral et son artefact audité restent inchangés par tests de régression.
- [ ] Le mobile OpenAI négocie un unique média audio `sendrecv`, accepte une seule piste distante
      audio et arrête toute piste vidéo, dupliquée ou obsolète.
- [ ] Le RTP entrant alimente les métriques sans fermer la session ; le micro reste actif pendant
      `bob_speaking`.
- [ ] Une interruption émet au plus un cancel et un clear par réponse, retire le contrôle et ne
      laisse reprendre aucun ancien buffer.
- [ ] Background, stop et échec natif arrêtent piste distante, piste locale, data channel et peer ;
      le lease audio n'est rendu qu'après fermeture native confirmée.
- [ ] Un client incompatible ou un protocole de livraison incohérent échoue fermé sans double voix.
- [x] Les expirations sont distribuées, idempotentes, bornées et certifiées sur PostgreSQL réel.
- [x] La rétention purge seulement les terminaux échus, sous FORCE RLS, sans dépendance native.
- [x] La découverte globale est un scan keyset durable `limit + 1`, sans agrégation globale ni
      liste de tenants configurée, et expose toute saturation de sa fenêtre.
- [x] Une page n'avance qu'après ACK de son claim courant ; lease vivant, renouvellement, reprise
      après expiration et refus d'un ancien claim sont explicites et fail-closed.
- [x] `provider_stream/v2` est impossible en V1 tant que sa purge de graphe n'existe pas.
- [x] Aucun flag de production n'est activé par le lot.

## 7. Certification bloquante avant activation

- [ ] Tests unitaires, courses, contrats, typecheck, lint et builds API/mobile verts.
- [x] Les expansions et indexes `CONCURRENTLY` sont séparés ; la contraction préactivation
      `provider_stream` utilise `ADD ... NOT VALID` puis `VALIDATE` dans deux migrations courtes.
- [x] CI PostgreSQL éphémère : CAS, RLS, horloge DB, `SKIP LOCKED`, drainage et purge mutationnels.
- [x] Release live : ownership/ACL, triggers, CHECK, indexes et curseurs certifiés sans mutation.
- [ ] Dix barge-ins consécutifs sans reprise audio, double contrôle ni incohérence de session.
- [ ] iPhone et Android physiques : haut-parleur, écouteur, filaire et Bluetooth.
- [ ] Fin de parole → premier audio : p50 ≤ 900 ms, p95 ≤ 1 800 ms.
- [ ] Début de barge-in → silence : p50 ≤ 250 ms, p95 ≤ 500 ms.
- [ ] Background/foreground, perte réseau et changement de route audio certifiés.
- [ ] Zéro requête Mistral observée sur toute la mission OpenAI.
- [ ] Le profil de charge staging utilise 1 000 comptes actifs aux volumes de données représentatifs
      et des paliers de 50, 100 puis 250 sessions Live concurrentes. Chaque palier tient au moins
      15 minutes et le palier 250 un soak d'une heure ; latences p50/p95/p99, pool PostgreSQL,
      CPU/mémoire, reconnexions et quotas OpenAI sont consignés sans erreur silencieuse ni file non
      bornée. Cette preuve ne signifie pas « 1 000 voix simultanées ».
- [ ] À saturation, l'admission refuse proprement avant d'épuiser les ressources ; aucune session
      existante, preuve durable ou action métier confirmée n'est perdue.
- [ ] ADR de risque natif et matrice de certification explicitement validés avant ouverture.

## 8. Hors lot

- activation production et modification des variables Railway ;
- Mistral V3 ;
- réécriture globale en Rust : TypeScript/Nest/Expo restent l'autorité produit ; seuls des hotspots
  natifs mesurés (DSP/VAD/écho/PCM, PDF/OCR, crypto/compression) pourront être extraits après profilage ;
- nouvelles capacités métier des missions vocales multi-étapes ;
- preuve acoustique indépendante avant écoute, incompatible avec un RTP immédiatement audible
  sans buffering complet.
