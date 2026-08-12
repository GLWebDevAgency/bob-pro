# SPEC — PR85 · Fondations dormantes Bob Live GPT Realtime natif

**Statut : implemented — certification et activation explicitement hors lot**

**Objectifs :** O3 (GPT Realtime), O4 (Mission continue), O5 (Voice Trace)

**Nature du lot :** première micro-PR d'un train strictement séquentiel ; une seule PR active et
mergée avant d'ouvrir la suivante. Ce découpage est un choix d'ingénierie destiné à rendre chaque
contrat réfutable. Il n'est pas présenté comme la contre-signature du message Claude n°494, qui
demandait une PR voice unique et reste un avis conditionnel.

## 1. Pourquoi ce lot existe

Le rail publié `audited-signed-url-v1` échoue aujourd'hui sur deux frontières distinctes :

- sa preuve acoustique TTS → Whisper dépasse le budget d'admission après expiration du cache ;
- son offre `sendonly` est incompatible avec la réponse `sendrecv` légitime de GPT Realtime et le
  mobile ferme correctement sous `answer_sdp_rejected`.

La cible architecturale est `openai-native-webrtc-v1` : une seule session WebRTC porte le micro et
la voix Bob. Avant de lever son compile-lock, le serveur et le mobile doivent toutefois convenir
de la même autorité Mission V2 et échouer fermés sans toucher au rail audité existant.

## 2. Portée exacte PR85

1. Consigner la cible native et ses risques sans prétendre qu'elle est déployée, certifiée ou
   contre-signée pour la production.
2. Autoriser Mission V2 à évaluer le delivery natif dans l'adapter d'admission.
3. Exiger côté serveur une demande **et** une préparation Mission V2 exactes avant toute lease ou
   requête OpenAI native.
4. Le mobile demande Mission V2 pour tout transport WebRTC, audité ou natif.
   Le vrai transport natif exige V2 avant lease/micro/réseau et transfère la capability issue du
   bootstrap ; un double d'orchestrateur ne constitue pas cette preuve.
5. Le config public sonde la readiness et Mission V2 uniquement pour le futur delivery natif ; il
   ne déclenche jamais la sonde acoustique longue du rail audité.
6. Tout config natif indisponible ferme le nouveau client au lieu de l'envoyer silencieusement
   vers le driver historique, sans ajouter un enum incompatible au contrat wire v4 publié.
7. Les lectures de topologie du drill Voice Trace utilisent le helper Railway sans secret M1-B et
   reçoivent explicitement `TARGET_ENVIRONMENT_NAME=staging`, rollback compris.

Le correctif O5 est atomique avec cette fondation : Voice Trace est un verrou obligatoire du
canary natif et son opérateur actuel ne peut ni certifier ni restaurer staging sans cette correction.

## 3. Non-objectifs et verrous conservés

- aucun flag Railway, Supabase ou EAS n'est modifié ;
- le compile-lock `OPENAI_NATIVE_WEBRTC_RUNTIME_READY=false` reste fermé ;
- aucun keyring native subject/proof n'est créé ou posé ;
- aucune migration `provider_stream/v2`, politique acoustique V2 ou purge contrôle native ;
- `/health/ready` n'est pas encore l'autorité agrégée runtime + Mission ;
- aucun opérateur d'activation native, déploiement staging, APK ou verdict appareil ;
- aucun retrait runtime/code/keyring Mistral ;
- aucun affaiblissement de la validation SDP auditée ;
- aucun verdict `certified` ou `released`.

## 4. Invariants

1. **Dormance réelle.** Sur l'état opérationnel audité actuel, la réponse config et l'admission
   conservent leur comportement N-1 ; aucun préflight runtime/Mission nouveau n'est appelé.
2. **Mission native obligatoire aux deux frontières.** `omitted`, `null`, V1, gate fermé,
   capability malformée ou binding divergent refusent le natif avant lease et egress provider.
3. **Aucun fallback ajouté.** Les nouvelles causes natives sont fail-closed dans le client N.
   La fermeture globale du driver legacy pour toutes les causes et la stratégie minimum-client
   restent des verrous du lot d'activation : le natif ne peut pas être activé avant leur preuve.
4. **Compatibilité honnête.** Serveur N + APK N-1 restent inchangés tant que le delivery audité est
   actif. Une APK N-1 demandant le natif sera rejetée sans lease/effet ; l'activation est interdite
   tant que le minimum-client/fermeture legacy n'empêche pas son repli local historique.
5. **Readiness bornée.** Le GET config audité n'exécute jamais le round-trip TTS → Whisper. Le GET
   natif refuse si son runtime boot-vérifié ou Mission V2 manque.
6. **Course générationnelle.** Une réponse config reçue après stop/background ne recrée ni erreur,
   ni transport, ni fallback, et ne peut jamais résoudre le waiter Mission d'une génération
   redémarrée entre-temps. Le caller React ne peut pas davantage arrêter le contrôleur de la
   nouvelle génération lorsque l'ancien `await` revient.
7. **Rollback exécutable.** Chaque appel du helper Railway générique dispose de l'environnement
   cible explicite, dans le job principal comme dans le job de secours.

## 5. Critères d'acceptation binaires PR85

- [x] Le config audité reste `available` pour un tenant autorisé même si les doubles readiness et
      Mission injectés lèvent une exception ; aucun des deux n'est appelé.
- [x] Le config natif est indisponible si runtime natif ou Mission V2 manque, sans compter une
      panne Mission comme une panne d'entitlement.
- [x] Les bootstraps natifs omis/null/V1 sont refusés avant entitlement, `reserve()` et
      `provider.createCall()`.
- [x] Une demande V2 dont le gate rend null/diverge est refusée avant `reserve()` et egress.
- [x] Une demande V2 exacte passe encore le bootstrap natif dans le test positif.
- [x] Le transport WebRTC réel accepte nativement Mission V2, transmet V2 au bootstrap, reçoit la
      capability V2 et refuse null/V1 avant lease, permission micro et réseau.
- [x] Une answer native sans attribut de direction explicite est acceptée comme `sendrecv` selon
      SDP ; le rail audité conserve son exigence stricte `recvonly`.
- [x] Une réponse native tardive après `stop(background)` se termine `cancelled`, sans callback
      fail-closed posthume ni fallback ; A lent → stop → B → réponse A tardive laisse B atteindre
      `resumed` et ouvrir son micro après contexte confirmé.
- [x] Au niveau du caller qui attend le contrôleur partagé, le retour tardif de A ne peut appeler
      `stop()` sur B ; une génération encore courante devenue inactive nettoie toujours son rail.
- [x] Le workflow Voice Trace contient exactement deux autorités job-level
      `TARGET_ENVIRONMENT_NAME: staging` et zéro helper topo M1-B.
- [x] Suites ciblées API, mobile, api-client et workflow vertes ; typecheck/lint ciblés verts ;
      `git diff --check` vert.
- [x] Revue indépendante : zéro P0/P1 restant sur le périmètre PR85.

## 6. Definition of Done

PR85 atteint au maximum le statut **implemented** lorsque tous les critères §5 sont verts, le diff
est atomique, la décision associée est suivie par Git et la PR est mergée. Le statut ne devient pas
`certified` via cette PR.

Les trains suivants, un à la fois, sont :

1. expansion dormante `provider_stream/v2` + politique acoustique et maintenance ;
2. readiness globale, minimum-client/fermeture legacy et opérateur native exact-SHA ;
3. activation staging, canary Voice Trace, nouvelle APK puis QA Android/iPhone avec RTP, ACK,
   navigation, proposition, confirmations et barge-in mesurés.

L'ouverture production reste **[BLOQUÉ FONDATEUR : acceptation explicite du risque acoustique
audible-before-audit et clé/budget OpenAI production]** ainsi que **[BLOQUÉ CONTRE-SIGNATURE :
équivalence d'audit exigée par l'avis Claude n°494]**.
