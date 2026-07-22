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
5. Une réponse n'est complète qu'après transcription finale concordante, `response.done` réussi,
   arrêt du buffer distant, persistance de l'usage et contexte toujours courant.
6. Une divergence, un outil, une réponse inconnue, un chevauchement ou un événement malformé
   annule/purge, révoque tout contrôle et ferme la session si l'autorité ne peut plus être prouvée.
7. Une action reste une capacité opaque issue du cerveau Bob. Elle n'est consommable qu'après la
   complétion serveur, un ACK mobile durable post-lecture et une nouvelle validation du contexte.
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
- `completed` exige transcript conforme + génération terminée + buffer arrêté + usage accepté ;
- `delivered` exige l'ACK mobile exact, tenant/session/turn/contexte scellés ;
- tous les états terminaux sont immuables ;
- un contrôle référence en XOR soit un artefact audité, soit une livraison native, jamais les deux.

### 5.1 Maintenance et rétention V1

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

- [ ] Le config public et le bootstrap discriminent exactement les deux modes de livraison.
- [ ] Une session OpenAI native démarre avec une seule clé OpenAI et n'appelle jamais Mistral.
- [ ] `output_modalities=['audio']`, `create_response=false`, aucun outil et budget borné sont
      vérifiés par tests de contrat provider.
- [ ] Le sideband rejette réponse inconnue, metadata divergente, sortie texte, outil, réponse
      concurrente et événement malformé.
- [ ] Le dispatch `response.create` est durable et at-most-once, y compris après résultat réseau
      ambigu ou reprise de processus.
- [ ] Les ordres inversés `response.done` / `output_audio_buffer.stopped` convergent vers le même
      état terminal sans double contrôle.
- [ ] Transcript absent/divergent, contexte obsolète, perte d'owner ou usage indisponible ne
      produisent ni livraison, ni historique complet, ni contrôle.
- [ ] Le contrôle durable accepte une liaison XOR artefact/livraison native et reste one-shot,
      tenant-scopé, contextuel et anti-rejeu.
- [ ] Le bootstrap OpenAI ne dépend pas du stockage audio signé ni du TTS Mistral.
- [ ] Le bootstrap Mistral et son artefact audité restent inchangés par tests de régression.
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
- [ ] Aucun flag de production n'est activé par le lot.

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
- nouvelles capacités métier des missions vocales multi-étapes ;
- preuve acoustique indépendante avant écoute, incompatible avec un RTP immédiatement audible
  sans buffering complet.
