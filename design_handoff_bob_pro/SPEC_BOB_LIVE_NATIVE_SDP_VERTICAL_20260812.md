# SPEC — PR86 · Autorité SDP native et preuve verticale pré-contrôle

**Statut : implemented — aucune activation ni certification appareil dans ce lot**

**Objectifs :** O3 (GPT Realtime natif), O4 (Mission V2 continue), O7 (code réellement appelé)

**Dépendance :** `main@2e36622e`, qui contient la fondation dormante PR85.

## 1. Outcome binaire

Le serveur et le mobile utilisent un même classifieur strict de la topologie audio SDP Bob Live.
Une offre native incohérente est refusée avant tout effet. Une réponse OpenAI native incohérente
est refusée dans l'adapter fournisseur, après le bind durable du `call_id`, puis compensée selon
l'autorité existante avant que le service puisse attacher le sideband ou rendre le SDP au mobile.

Un test mobile vertical traverse les vraies classes
`RealtimeSessionController → RealtimeResilienceOrchestrator → transport primaire → composition →
RealtimeWebRtcTransport → HttpBobClient`. Il prouve que Mission V2 et le contexte confirmé
précèdent l'ouverture du micro.

Ce verdict est uniquement **bootstrap duplex natif pré-contrôle**. Sans `provider_stream/v2`, il ne
certifie ni tour vocal Bob, ni audio descendant, ni navigation, ni proposition, ni action Jarvis.

## 2. Portée

1. Ajouter dans `@bob/ai` un classifieur SDP WebRTC Bob pur, partagé par API et mobile. Ce module
   n'est pas présenté comme un parseur RFC général et ne transforme jamais le SDP.
2. Remplacer le classifieur privé mobile par cette autorité, sans changer les décisions du rail
   audité : offre mobile `sendonly`, réponse fournisseur `recvonly`.
3. Refuser côté service une offre **native seulement** qui n'est pas une topologie audio unique
   `sendrecv`, après validation du contrat wire et de la delivery, mais avant identité,
   entitlement, Mission, lease ou egress OpenAI.
4. Valider la réponse native dans `OpenAiRealtimeCallAdapter`, après `onCallCreated()` et avant
   son retour. Le rail audité publié conserve strictement son shape-check historique dans ce lot
   dormant ; sa contraction intervient seulement lors du cutover qui le retire.
5. Prouver la compensation d'une réponse native invalide : une invocation logique locale du
   hangup ; une libération `confirmed` uniquement après le statut fournisseur `200` documenté.
   `202`, `204`, `404` et `409` restent incertains dans ce nouveau chemin. La sémantique historique
   du rail audité reste inchangée dans ce lot dormant : la corriger sans keyring/reconciliation
   rendrait son reaper non convergent. Cette dette est un bloqueur explicite du cutover.
6. Réaligner le test canonique `HttpBobClient` : le natif demande Mission V2, acquitte sa
   capability et n'utilise plus une réponse `recvonly` comme exemple valide.
7. Ajouter une preuve verticale mobile positive et une preuve fail-closed, avec doubles limités
   aux frontières OS WebRTC et HTTP distant dans des fichiers `*.test.ts` non exportés.
8. Extraire le composition root mobile hors React : `AgentSessionProvider` et la preuve verticale
   appellent la même fabrique de production ; un contrat source interdit tout second assemblage.
9. Étendre le smoke exact-runtime existant avec un reçu topologique borné émis seulement après
   application de la réponse, connexion du peer et ouverture du data channel. Il ne conserve ni
   SDP brut, ni hash de SDP, ni ICE, fingerprint, candidate, IP ou identifiant d'appel/session.
10. Rendre l'autorité mobile générationnelle de bout en bout : binding contrôleur/client/checkpoint
    atomique, hooks fencés par identité, fermeture retentable, contexte confirmé exact et étape
    post-PUT sérialisée. Deux publications concurrentes ne peuvent ni rouvrir le micro sur la
    mauvaise révision, ni appliquer un contrôle de l'ancien écran.

## 3. Non-objectifs

- aucun flag Railway, Supabase ou EAS, aucun secret/keyring et aucun déploiement ;
- aucun retrait du compile-lock natif, aucune APK et aucun verdict appareil ;
- aucune migration, politique acoustique V2, purge ou activation `provider_stream/v2` ;
- aucun contrôle, navigation, proposition ou mutation native ;
- aucun changement de protocole, provider, configuration ou contrat réseau Mistral ; les fences
  transport-agnostiques de contexte, phase d'écoute et fermeture s'appliquent cependant à tous les
  transports qui passent par le contrôleur commun ;
- aucune nouvelle gate serveur sur le rail `audited-signed-url-v1` ;
- aucune réécriture ou normalisation d'un SDP ;
- aucun statut supérieur à `implemented`.

## 4. Invariants

1. **Autorité unique.** API et mobile appellent le même classifieur pur ; aucun second parseur de
   direction/topologie audio ne subsiste dans ces deux couches.
2. **Profil natif exact.** Il existe exactement une `m=audio` active sous le profil WebRTC sécurisé
   `UDP/TLS/RTP/SAVPF` avec des payload types RTP numériques uniques et bornés, aucune autre m-line
   audio, aucune m-line vidéo ou média RTP active, et la direction effective vaut `sendrecv`. Une
   absence de direction vaut `sendrecv`; une direction de niveau média remplace celle de session. La
   section SCTP `m=application` peut porter sa propre direction `sendrecv` (JSEP/Pion) sans
   modifier la direction RTP audio ; duplicat ou attribut malformé restent refusés.
3. **Ambiguïté refusée.** Direction dupliquée, attribut directionnel malformé, m-line/port invalide,
   port non sûr, audio multiple, vidéo active et `bundle-only` ambigu échouent fermés. Les sections
   `application` nécessaires au data channel restent permises.
4. **Offre avant effet.** Une offre native invalide implique zéro identity lookup métier,
   entitlement, préparation Mission, réservation et appel fournisseur.
5. **Réponse compensée à la frontière.** L'adapter est la seule autorité de validation de la
   réponse. Après bind réussi, une réponse invalide ne franchit jamais le service ni le sideband.
6. **Sémantique d'incertitude honnête.** Le hangup est idempotent et peut être tenté plusieurs fois
   par son adapter ou le reaper. La garantie n'est pas une requête réseau exactly-once, mais une
   seule invocation logique de compensation dans le bootstrap puis un traitement at-least-once
   borné. La récupération par reaper n'est garantie que si le bind durable avait réussi. Un
   statut terminal fournisseur ne doit jamais être déduit d'un simple succès HTTP générique. Pour
   la compensation native, seul `200` acquiert l'autorité terminale ; `202`, `204`, `404` et
   `409` restent incertains. Le rail audité N-1 conserve provisoirement son comportement historique
   afin de ne pas casser sa convergence active. Avant cutover, un train dédié doit lier la
   génération du credential/projet au bail et normaliser cette sémantique sans dette infinie.
7. **Rails historiques stables.** Le mobile audité conserve offre `sendonly`, réponse `recvonly` et
   son fallback Android `currentDirection` ; l'API ne lui ajoute aucune gate sémantique nouvelle.
   Mistral, le wire public v4 et la terminaison du rail audité restent inchangés.
8. **Mission avant oreille.** Capability V2 exacte, handle adopté, contexte PUT/acquitté et
   `confirmContext()` précèdent le premier `track.enabled=true` du micro.
9. **Fail-closed.** Aucun échec de ce parcours n'arme le driver legacy, Mistral ou une deuxième
   oreille/voix.
10. **Autorité UX par phase.** Avant qu'un bootstrap retourne `realtime`/`resumed`, son outcome est
    l'unique autorité : aucun hook terminal tardif ne repeint l'UI. Après succès, la première
    rupture asynchrone de la même génération émet `onFailedClosed` exactement une fois ; toute
    continuation d'une génération antérieure est inerte.
11. **Preuve fournisseur sans fuite.** Aucune fixture « SDP OpenAI assainie » n'est versionnée :
    elle serait soit sensible, soit synthétique et donc non probante. PR86 prépare le reçu du smoke
    exact-runtime audité (`single-audio-recvonly`). La vraie réponse native `single-audio-sendrecv`
    reste un gate du canary après levée explicite du compile-lock, via l'API Bob et son bind durable,
    jamais par un probe direct qui pourrait laisser un appel fournisseur orphelin.
12. **Contexte générationnel exact.** Une transition révoque d'abord le micro, la fence confirmée,
    les ACK de contrôle et la phase `listening`. Les PUT restent `latest-wins`; l'étape
    transport → Mission → permission → micro est sérialisée et revalide après chaque `await`
    l'epoch, les générations, le transport, le publisher, la révision et le digest. Seule cette
    autorité finale alimente le gate de contrôle et rouvre le micro. L'epoch est capturé avant le
    premier `await` : une révocation survenue pendant le PUT ne peut jamais être absorbée par son
    retour tardif. Un transfert manuel pose en plus un latch durable jusqu'au prochain `start`.
13. **Contrôleur atomique et retentable.** Contrôleur, client et checkpoint forment un seul binding.
    Dès qu'une fermeture/rotation commence, ses hooks deviennent inertes. Un reçu incertain conserve
    l'autorité pour un retry mais la rend inutilisable; aucun tap ne peut la recycler ni créer B
    avant la fermeture confirmée de A. Une factory fautive échoue fermée sans orbe zombie.
14. **Écoute véridique.** `ready` est uniquement technique. L'UI ne publie `listening` qu'après
    contexte autoritatif et activation locale réussie; toute transition, récupération ou teardown
    coupe d'abord le micro puis revient à `thinking`. Le rail natif WebRTC possède une activation
    synchrone; l'ACK acoustique asynchrone des anciens rails reste une dette du lot lifecycle dédié.
15. **Gate de changement de principal.** PR86 ne certifie pas encore la déconnexion pendant appel.
    Avant toute activation native, un lot dédié doit prouver, indépendamment du DELETE réseau, la
    libération locale capture+playback+lease puis la destruction Mission avant `Supabase.signOut`.
    `[BLOQUÉ ACTIVATION O3 : preuve locale sign-out provider-neutral]`.
16. **Fence sémantique des événements.** PR86 rend transcripts, états de parole, completion et
    contrôles inertes tant qu'un handoff contextuel est en cours. Le wire actuel n'attache cependant
    pas encore révision+digest à chaque transcript/commit/terminal : un paquet de r2 livré seulement
    après l'activation de r3 ne peut pas être distingué localement. Le train lifecycle/protocole
    suivant doit porter cette fence jusque dans chaque événement avant tout canary natif.
    `[BLOQUÉ ACTIVATION O3 : événements vocaux liés au contexte exact]`.

## 5. Critères d'acceptation binaires

- [x] Le classifieur partagé couvre `sendrecv` explicite/implicite, héritage session, override
      média, profil/payload audio invalide, port audio zéro, deux audio, vidéo active,
      `bundle-only`, direction dupliquée et direction malformée, ainsi que la seule forme SCTP
      `m=application ... a=sendrecv` issue de Pion/OpenAI.
- [x] Le mobile n'a plus de parseur SDP audio privé et ses fixtures auditée/native gardent les
      décisions attendues.
- [x] Une offre native `sendonly`, `recvonly`, `inactive`, multi-audio ou vidéo est refusée avant
      tous les ports à effet ; `sendrecv` explicite et implicite passe.
- [x] Une réponse native non-`sendrecv` est compensée après bind et avant sideband ; une réponse
      `sendrecv` implicite passe. L'API auditée garde son shape-check N-1 dans ce lot dormant.
- [x] Réponse invalide + hangup confirmé : une invocation logique locale, release `confirmed`
      unique, aucun sideband. Hangup incertain post-bind : aucun release, aucun second hangup dans
      le service, bail lié récupérable par le reaper.
- [x] La compensation native n'acquitte que `200` ; `202`, `204`, `404` et `409` conservent le bail.
      Le test N-1 prouve simultanément que la sémantique de terminaison auditée n'a pas changé.
- [x] Le test vertical positif prouve Mission V2, même UUID/capability, contexte acquitté puis
      micro `false → true`, et cleanup unique.
- [x] Le test vertical négatif prouve micro toujours OFF, zéro fallback et libération unique des
      ressources possédées.
- [x] `AgentSessionProvider` et la preuve verticale consomment le même composition root ; aucun des
      deux ne construit directement contrôleur, orchestrateur ou transport fournisseur.
- [x] `stop(user|background|unmount)` arme la cause applicative avant l'AbortSignal : la première
      cause autoritative atteint le DELETE sans être remplacée par `lifecycle/aborted`.
- [x] Un bootstrap refusé rend `failed_closed` sans hook terminal tardif ; une rupture mid-call
      déjà `resumed` émet un hook unique et un callback A tardif reste sans effet sur la session B.
- [x] Un fallback pendant le bootstrap natif rend toujours `failed_closed`; il n'arme jamais le
      pilote legacy, même si `orchestrator.start()` se résout après le teardown.
- [x] Deux publications r2/r3 avec synchronisations inversées n'ouvrent le micro que sur r3 ; le
      gate, les transcripts et contrôles restent inertes pendant la transition. Le même rail est
      prouvé sans concurrence post-PUT dans le shell Mistral historique.
- [x] Un transfert manuel pendant un PUT contexte conserve le micro fermé au retour du PUT et
      refuse toute republication jusqu'à la fermeture puis au prochain `start`.
- [x] Une fermeture A incertaine rend immédiatement ses neuf hooks inertes, est retentée sur la
      même autorité et précède toute création B. Un checkpoint enregistré pendant la factory n'est
      ni perdu ni attribué à une autre lease.
- [x] Le test canonique `HttpBobClient` demande/acquitte Mission V2 et n'utilise plus `recvonly`
      comme réponse native valide ; les tests N/N-1 génériques restent présents.
- [x] Le smoke exact-runtime rend seulement `expectedAnswerProfile` (attente contractuelle, pas
      observation du SDP) et une preuve peer fermée après succès ; un SDP/une erreur synthétiques
      empoisonnés démontrent qu'aucun secret/ICE/IP/fingerprint n'entre dans le reçu ou stderr.
- [x] Aucun fichier de config, env, migration ou lockfile n'est modifié.
- [x] Suites ciblées, typechecks, lints, builds et gardes d'artefact verts depuis un checkout
      propre du commit candidat.
- [x] Revue indépendante : zéro P0/P1 restant sur le périmètre.

## 6. Definition of Done

PR86 atteint au maximum `implemented` lorsque tous les critères §5 sont prouvés, le diff est
atomique, la CI est verte et la PR est fusionnée avant l'ouverture de la suivante.

Le train continue ensuite, une seule PR active à la fois :

1. lifecycle local provider-neutral : preuve capture/playback/lease + Mission avant changement de
   principal, indépendamment du hangup HTTP, ACK acoustique asynchrone des rails historiques et
   fence révision+digest sur chaque événement vocal ;
2. `provider_stream/v2` phase A dormante : dual read/write, politique V2, XOR, crypto, purge,
   RLS/ACL, writers N-1 ; le CHECK d'interdiction reste validé ;
3. readiness agrégée → minimum-client et fermeture du fallback legacy → opérateur exact-SHA ;
4. phase B sous admissions fermées et pods N-1 drainés sur le même SHA, puis canary staging sur
   sujet interne, Voice Trace et nouvelle APK ;
5. certification Android/iPhone des deux surfaces Bob : RTP, ACK, navigation, proposition,
   confirmation, barge-in, cold boot, reprise réseau, routes audio et SLO.
