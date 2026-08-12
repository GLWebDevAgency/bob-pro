# DÉCISION — GPT Realtime natif comme rail vocal de publication

**Statut : Accepted comme cible d'architecture preview — certification et production bloquées**

**Objectifs :** `O3 — GPT Realtime`, `O4 — mission continue`, `O5 — Voice Trace`

**Objectif fondateur observé :** conversations Codex — privilégier sans compromis la
fluidité, la qualité et l'intelligence de Bob Jarvis ; un seul système vocal de publication à
maintenir ; compréhension par le LLM, règles et effets par les use cases déterministes ; Mistral
Realtime préservé pour un chantier post-publication.

**Avis conditionnel Claude :** message Git-native `outbox/gpt.md` n°494 du 10 août 2026 — GO sous
conditions pour `openai-native-webrtc-v1`, notamment Voice Trace avec une capture d'audit
équivalente au rail privé audité, séquencement archive → voice, nouvelle APK, fermeture du
premier-tap 503 et retrait Mistral versionné. Cet avis n'est pas une contre-signature du risque
`audible-before-audit` décrit ci-dessous.

**Portée de l'acceptation :** cette décision fixe la **cible du train**, elle ne prétend pas que le
cutover a déjà eu lieu. Jusqu'à la certification native et à la mutation atomique de la matrice des
flags, `MATRICE_FLAGS_V1.md` reste la vérité des profils effectivement posés. Le présent lot ne
modifie aucun flag Railway et ne retire aucun runtime.

## 1. Incident qui impose la décision

Le chemin `audited-signed-url-v1` ouvre aujourd'hui une session WebRTC avec une offre audio
`sendonly`, car Bob restitue ensuite un artefact TTS séparé. GPT Realtime répond légitimement avec
un média duplex `sendrecv`. Le garde SDP mobile refuse cette topologie incohérente sous
`answer_sdp_rejected`, après le bootstrap et l'ACK Mission V2. Désactiver la garde, réécrire le SDP
ou accepter une direction ambiguë masquerait le défaut et pourrait créer une double voix.

Le même chemin audité provoque aussi le 503 du premier appui après quinze minutes d'inactivité :
l'admission attend 2,5 s une preuve acoustique OpenAI TTS → Whisper qui prend environ 12,4 s. Le
premier utilisateur réchauffe donc le cache en essuyant le refus. Allonger le timeout ne rendrait
pas l'expérience premium.

## 2. Décision

1. `openai-native-webrtc-v1` devient l'unique rail acoustique du train de publication GPT
   Realtime : microphone et audio Bob transitent dans la même session WebRTC `sendrecv`.
2. Le sideband Bob reste l'autorité conversationnelle : `create_response=false`, aucun outil
   fournisseur, aucune mutation fournisseur. Le LLM interprète la transcription et le contexte ;
   les outils typés relisent la base tenantée et les use cases appliquent les invariants.
3. Bob produit une réponse canonique. Le sideband demande à GPT Realtime de la vocaliser hors
   conversation, puis compare la transcription finale fournisseur. Cette concordance arrive après
   le début possible du RTP : elle est une preuve de révocation et d'audit, pas un pré-audit de ce
   qui a déjà pu être entendu.
4. Ce risque acoustique résiduel est toléré uniquement pour l'implémentation et les comptes
   preview internes afin d'évaluer le plein duplex et le barge-in natifs. Son acceptation en
   production reste bloquée par une décision fondateur explicite et par la condition d'audit de
   l'avis Claude. Il ne réduit aucune sécurité métier : navigation,
   proposition et mutation restent des capacités opaques, contextuelles, one-shot et
   consommables seulement après ACK natif durable et revalidation du contexte. Toute action
   financière, contractuelle, fiscale ou destructive garde sa confirmation explicite.
5. Le rail hybride `openai-hybrid-v1` et le player audité semi-duplex ne sont plus la cible de
   publication. Après le cutover, aucun fallback silencieux n'y reviendra.
6. Mistral/Voxtral vocal **sera** retiré des profils de publication lors du cutover natif et gelé
   derrière ses flags. Son code, ses migrations et ses keyrings existants seront conservés pour le
   chantier post-V1 ; la chaîne audio/Realtime OpenAI (capture, transcription/raisonnement live,
   synthèse et downlink) ne devra appeler aucune clé ni aucun service Mistral. Les outils métier
   externes, par exemple l'OCR documentaire, conservent leur provider explicite et traçable.

## 3. Voice Trace et données d'audit

Voice Trace V2 est un verrou du canary staging, pas une autorité de parole ou d'effet :

- aucun audio brut, paquet RTP/SDP, payload fournisseur, prompt, argument libre d'outil, token ou
  secret n'est stocké ;
- seuls le transcript final utilisateur et la réponse canonique Bob peuvent être conservés sur
  staging pour les couples tenant/utilisateur explicitement autorisés ; ils sont chiffrés
  applicativement dans `realtime_voice_trace_events`, sous FORCE RLS et rétention base maximale de
  720 heures ;
- les logs Railway, Sentry, métriques et reçus CI ne contiennent jamais ces textes ;
- une panne d'écriture Trace ne modifie ni le résultat métier ni une capacité déjà scellée. La
  file bornée ouvre son disjoncteur, émet un incident sans contenu et marque l'environnement
  dégradé ; elle bloque toute nouvelle promotion/certification. La session en cours peut se fermer
  proprement, mais elle ne devient jamais une preuve de qualité réussie ;
- production conserve Voice Trace V2 à `OFF` tant que la gouvernance/DPO ne l'autorise pas.

## 4. Invariants de publication

- une seule piste locale audio, une seule piste distante audio, zéro vidéo ;
- offre et réponse SDP appliquées et prouvées `sendrecv`, sans transformation de SDP ;
- micro ouvert pendant la parole Bob après ACK du contexte ; interruption locale avant le réseau,
  puis au plus un `response.cancel` et un `output_audio_buffer.clear` ;
- toute réponse métier canonique est liée à une livraison native persistée, à son contexte, à son
  owner et à une preuve HMAC dédiée ;
- tout contrôle est lié en XOR à cette livraison native, créé atomiquement ou rejeté, et reste
  inaccessible avant l'ACK mobile durable ;
- le premier appui natif ne dépend ni d'un sidecar Whisper, ni d'OpenAI TTS, ni d'une sonde
  acoustique ;
- `/health/ready` et `/voice/realtime/config` ne peuvent annoncer `available=true` sans runtime
  natif boot-vérifié, Mission V2 disponible et mode/livraison exacts ;
- une configuration partielle échoue au boot. Une activation ou un rollback passe exclusivement
  par un opérateur staging exact-SHA avec admissions fermées, drainage, canary authentifié et reçu
  non-PII.

## 5. Definition of Done binaire

- [ ] Le compile-lock natif est levé avec tests de configuration complets et aucun besoin de
      secrets Whisper/TTS audités.
- [ ] Le premier appel après boot et après plus de quinze minutes d'inactivité atteint
      `bob.live.lifecycle.activated` sans 503 de readiness.
- [ ] Le mobile prouve offre/réponse `sendrecv`, une piste distante audio, RTP entrant et ACK
      durable ; toute piste supplémentaire ou vidéo ferme la session.
- [ ] Une réponse métier réelle peut être parlée nativement ; transcript divergent, événement
      inconnu, contexte obsolète ou usage indisponible révoque et ferme sans effet.
- [ ] Navigation et proposition sont livrées après ACK natif via la même autorité de contrôle que
      l'UI ; mutation financière/contractuelle reste confirmée explicitement.
- [ ] Voice Trace staging est ON, allowlistée, chiffrée, purgée et diagnosticable ; une panne Trace
      interdit le verdict `certified`.
- [ ] Readiness/config exposent sans secret le provider, le transport, la livraison, le protocole
      Mission et l'état du runtime ; tout mismatch rend `available=false`.
- [ ] L'opérateur `activate/deactivate` natif refuse tout SHA non livré normalement, rollbacke sur
      échec et conserve les preuves historiques/keyrings.
- [ ] Un seul build preview du commit mergé est testé depuis l'orbe global et l'onglet Assistant,
      sur Android et iPhone physiques : premier tap, mission continue, navigation, choix,
      proposition, confirmation voix/tap, dix barge-ins, background/foreground et perte réseau.
- [ ] SLO appareil : fin de parole → premier audio p50 ≤ 900 ms / p95 ≤ 1 800 ms ; parole
      utilisateur → silence Bob p50 ≤ 250 ms / p95 ≤ 500 ms ; zéro double voix, action fantôme ou
      confirmation rejouée.
- [ ] Aucune requête Mistral n'est observée dans la chaîne audio/Realtime pendant les scénarios
      OpenAI ; les éventuels outils métier externes restent tracés séparément et les flags Mistral
      vocaux restent OFF par garde anti-drift.

L'ouverture production reste **[BLOQUÉ FONDATEUR : acceptation explicite du risque acoustique
audible-before-audit et clé/budget OpenAI production]** et **[BLOQUÉ CONTRE-SIGNATURE : preuve
d'audit équivalente exigée par l'avis Claude n°494]**.

Tant qu'un item reste ouvert, le statut maximal est `implemented`; ni `certified` ni `released` ne
peut être revendiqué.
