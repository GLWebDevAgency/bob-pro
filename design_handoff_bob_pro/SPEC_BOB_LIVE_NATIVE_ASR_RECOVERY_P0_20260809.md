# Spec P0 — Bob Live : terminaison ASR native et sortie texte

Date : 9 août 2026

Objectifs parents : O3 (repli classique compatible avec le chemin vocal de publication) et O7
(release reproductible). O5 (Voice Trace corrélée/SLO) n'est pas livré par ce lot.

Statut : `specified`

## 1. Objectif

Quand le repli vocal natif de l'unique `AgentSessionProvider` échoue, Bob doit converger vers un
état terminal unique, expliquer l'échec et offrir une sortie texte accessible. Une annulation,
un silence normal, un résultat final et une erreur technique ne doivent jamais se doubler ni se
transformer les uns dans les autres sous l'effet d'événements natifs tardifs.

Ce lot corrige la fiabilité du repli ASR déjà présent. Il ne change ni le fournisseur Realtime,
ni les flags, ni le protocole Mission, ni le périmètre métier du devis vocal.

## 2. Défaut prouvé

Dans `apps/mobile/src/data/voice.ts`, l'événement natif `error` ferme aujourd'hui le lease et écrit
seulement un `console.warn`. Il n'appelle jamais `onIssue`. L'unique session racine voit donc son
oreille se fermer sans cause fiable et peut retomber sur « rien entendu » alors que le moteur a
réellement signalé une panne, un refus ou une indisponibilité.

La version embarquée `expo-speech-recognition@56.0.1` ajoute deux pièges :

- Android peut émettre `too-many-requests`, absent de l'union TypeScript publiée ;
- `ERROR_INSUFFICIENT_PERMISSIONS` est nommé `service-not-allowed` et le code natif `9` n'est pas
  garanti sur toutes les implémentations. La permission demandée avant `start()` reste donc le
  premier garde-fou ; si le code `9` existe, il doit conserver la cause `denied`.

Le code actuel ne fence pas non plus le terminal de la génération : un résultat final tardif peut
encore être livré après `cancel()`, et plusieurs erreurs peuvent produire plusieurs effets.

La revue contradictoire du 9 août 2026 a prouvé deux défauts supplémentaires :

- les événements Expo n'ont aucun identifiant de session. Or le lease est aujourd'hui rendu sur un
  simple timer, avant le `end` natif. Un événement de N peut alors être attribué à N+1. Le contrat
  Expo 56.0.1 garantit que `end` est le dernier événement d'une reconnaissance : il devient donc
  l'autorité obligatoire avant toute réouverture ;
- le mode nommé `native` n'impose pas `requiresOnDeviceRecognition: true` et une ancienne préférence
  AsyncStorage `cloud` peut encore activer un envoi audio sans sélecteur ni disclosure actuels. Cela
  contredit le registre RGPD (« aucun cloud », « sans transmission »).

## 3. Portée

### Inclus

- classificateur pur des erreurs natives connues et futures ;
- machine terminale par génération, exactement une fois ;
- branchement réel de l'événement `error` vers `onIssue` ;
- conservation de la grâce de 350 ms autorisant un résultat final après `end` ;
- conservation exclusive du lease jusqu'à `end`, puis grâce, puis libération ;
- phase native `arming → started → ended`, terminal de grâce et latch de commande
  `none → stop → abort` exactement une fois ;
- listener `nomatch` et convergence de `end/grâce` vers le silence ;
- dictée locale forcée par `requiresOnDeviceRecognition: true`, sans repli réseau silencieux ;
- invalidation fail-closed de toute préférence historique `cloud` tant qu'un futur parcours de
  consentement/disclosure n'est pas spécifié et livré ;
- silence normal sans faux message d'erreur ;
- CTA « Écrire dans l'Assistant » après erreur terminale, sans redémarrer le micro ;
- libellé, hint lecteur d'écran et cible tactile d'au moins 44 points ;
- i18n des trois personnalités ;
- tests purs des courses et test de rendu du hint accessible du bouton partagé.
- preuve dynamique du hook avec emitter Expo contrôlé et preuve de focus texte consommée une fois.
- barrière native `abortAndWaitAsync` patchée sur iOS et Android : un `start` en attente est invalidé,
  le teardown et la livraison de `end` sont terminés avant que le lease puisse être rendu ;
- barrière applicative `cancel()` attendable : toute transition entrée micro → synthèse attend la
  libération effective du lease, ou échoue vers le texte sans perdre silencieusement la réponse ;
- sérialisation native des commandes `start`, `abort` et destruction, y compris pour les appelants
  directs du module patché qui n'utilisent pas le coordinateur audio Bob ;
- préflight local `fr-FR` mémorisé pendant la vie du hook afin d'éviter une allocation native et
  une latence à chaque tour ;
- synthèse classique sans API Bob : Android n'accepte qu'une voix système `fr-FR` explicitement
  déclarée hors réseau ; absence de voix ou callback perdu mène à la sortie texte ;
- migration de démarrage de l'ancienne valeur AsyncStorage `cloud` vers `native` ;
- synchronisation de la notice réellement servie et de la DPIA avec le fournisseur de publication,
  les artefacts audio de réponse et les gates de conformité réels.
- vérité de la clôture de compte dans la notice et l'écran : fermeture d'accès et conservation du
  dossier métier, sans prétendre livrer une purge/anonymisation absente.

### Exclus

- aucun changement WebRTC, Mistral, OpenAI, admission, entitlement ou Voice Trace serveur ; la
  cible OpenAI de publication reste inchangée et Mistral V3 reste différé ;
- aucun retry automatique du micro et aucun second prompt de permission ;
- aucun téléchargement automatique de modèle hors-ligne ; un appareil sans modèle `fr-FR` reçoit
  une indisponibilité honnête et la sortie texte ;
- aucun passage de transcript, prompt ou contexte dans l'URL ;
- aucun faux handoff : le CTA texte n'appelle pas `requestHandoff` et ne promet pas de conserver
  une proposition absente ;
- aucun M2-B/M2-C, création/envoi/signature de devis ou changement financier ;
- aucune activation staging/production dans cette PR ;
- aucun changement des routes STT/TTS tour-par-tour V1, de leurs fournisseurs ou de leur matrice :
  l'autorité de publication impose de les préserver. Le client courant ne les appelle plus depuis
  sa préférence classique, mais les anciens binaires peuvent toujours les utiliser ; la notice doit
  déclarer ce flux Mistral et son absence de consentement certifié au lieu de le prétendre fermé.

## 4. Contrat d'erreurs

| Erreur native | Cause Bob | Effet |
| --- | --- | --- |
| `aborted` | annulation attendue | terminal silencieux `cancelled` |
| `no-speech`, `speech-timeout` | silence | terminal `silent`, récupération « rien entendu » existante |
| `not-allowed` | `denied` | message permission + sortie texte |
| `service-not-allowed` avec code `9` | `denied` | message permission + sortie texte |
| `service-not-allowed` autre, `audio-capture`, `interrupted`, `language-not-supported`, `busy` | `unavailable` | message indisponibilité + sortie texte |
| `network`, `bad-grammar`, `client`, `unknown`, `too-many-requests`, valeur future | `failed` | message échec + sortie texte |

Le texte libre `message` du moteur n'est ni une autorité de classification, ni une donnée de log.

## 5. Invariants

1. Une génération possède exactement un terminal parmi `cancelled`, `final`, `silent`, `issue`.
2. `stop()` ne terminalise pas. `end` clôt le cycle natif, puis la grâce laisse encore gagner un
   final ; son expiration terminalise en `silent` si aucun autre terminal n'a gagné.
3. `cancel()` terminalise avant `abort()` ; tout final tardif est ignoré.
4. Un résultat final dupliqué produit au plus un transcript.
5. Une erreur dupliquée produit au plus un `onIssue`.
6. Une génération N garde le lease jusqu'à son `end` natif puis la grâce. Pour une annulation, la
   barrière native attend le start en vol, le teardown et la livraison de `end` avant la même grâce.
   N+1 ne peut jamais être ouverte pendant que des événements contractuels de N restent dus.
7. `aborted`, `no-speech` et `speech-timeout` ne deviennent jamais une panne utilisateur.
8. Toute valeur d'erreur inconnue échoue fermée en `failed` au lieu de disparaître.
9. Le log technique contient seulement le code normalisé et l'entier natif éventuel, jamais le
   message fournisseur, un transcript, un audio, un identifiant métier ou un secret.
10. Le CTA de revue valide garde priorité sur le CTA texte. Une erreur sans handoff ouvre
    l'Assistant, sans relancer la voix, sans rejouer une commande et sans paramètre d'URL.
11. Le bouton partagé transmet un `accessibilityHint`, expose un rôle button et conserve son
    plancher tactile de 44 points.
12. Les flags publics et la matrice de publication restent inchangés.
13. Le mode `native` impose la reconnaissance locale. Aucune absence de modèle local ne déclenche
    un repli réseau ; elle mène à `unavailable` puis au texte.
14. Une préférence historique `cloud` n'active plus STT/TTS réseau depuis le **client courant** et
    est migrée vers `native`. Ce lot ne change pas les routes V1 ni la matrice fournisseur ; leur
    exposition aux anciens binaires reste déclarée et bloque une certification privacy tant que le
    parc, l'information et le choix n'ont pas été prouvés.
15. `nomatch → end → grâce` et `end → grâce` convergent vers un terminal `silent`.
16. Une commande native est émise au plus une fois ; `stop → cancel` autorise seulement une
    promotion unique vers `abort`.
17. L'alerte lecteur d'écran contient la cause utilisateur précise et la sortie texte. Après le CTA,
    le focus arrive dans le champ de saisie sans commande ni contexte dans l'URL.
18. Android < 13, l'absence de modèle ASR `fr-FR`, l'absence de voix TTS locale Android et toute
    preuve native ambiguë ferment la voix et conservent le parcours texte.
19. Un watchdog TTS N ne peut ni résoudre ni arrêter N+1 ; l'arrêt utilisateur règle N immédiatement
    et le lease n'est rendu qu'après arrêt confirmé ou preuve `isSpeakingAsync === false`.
20. `cancel()` ne résout positivement qu'après la preuve terminale native, la grâce et la libération
    effective du lease. Une réponse TTS ne tente jamais d'acquérir la sortie pendant cette fermeture.
21. Une utilisation manuelle de l'Assistant peut être évitée ; aucune notice ne promet un interrupteur
    ou un mode IA local qui n'existe pas réellement dans le produit.
22. La clôture in-app n'est jamais présentée comme un effacement RGPD automatique : l'accès fermé,
    les données conservées et la dette de purge sont distingués explicitement.

## 6. Critères d'acceptation binaires

- [x] Le tableau d'erreurs est couvert, y compris code `9`, `too-many-requests` et valeur future.
- [x] `cancel → aborted → client → end` produit zéro issue et zéro transcript.
- [x] `final → network → end` produit un transcript et zéro issue.
- [x] Deux erreurs `network` produisent exactement une issue `failed`.
- [x] `stop → no-speech → end` produit zéro issue et conserve la récupération de silence.
- [x] `stop → network → end` produit exactement une issue `failed`.
- [x] `end → final` pendant la grâce produit un transcript.
- [x] N n'est libérée qu'après `end` puis grâce ; N+1 ne peut être ouverte avant cette preuve.
- [x] Une erreur légitime avant `start` est classée, puis le `end` clôt la même génération.
- [x] `nomatch → end → grâce` et `end → grâce` produisent un silence terminal sans issue.
- [x] Deux `cancel` n'émettent qu'un `abort` ; `stop → cancel` émet un `stop` puis un seul `abort`.
- [x] Sans `end` ni preuve `getStateAsync() === inactive`, le lease n'est pas rendu par un simple
      timeout et aucune N+1 ne démarre.
- [x] `cancel → final` produit zéro transcript ; deux finals en produisent un seul.
- [x] Le handler natif appelle réellement `onIssue` pour les terminaux classés et ne journalise
      aucun texte libre du moteur.
- [x] Après une issue inactive sans handoff, une seule action « Écrire dans l'Assistant » est
      visible ; elle navigue vers `/(tabs)/assistant` et n'appelle ni `toggle` ni `requestHandoff`.
- [x] Une revue avec handoff conserve exclusivement « Continuer dans l'Assistant ».
- [x] Le CTA texte possède label, hint, rôle et cible 44 points dans les trois personnalités.
- [x] Le message exact de l'issue et l'action texte sont annoncés par VoiceOver/TalkBack ; activer
      le CTA focalise le champ Assistant et ouvre la saisie, sans paramètre de commande dans l'URL.
- [x] Le démarrage Expo contient `requiresOnDeviceRecognition: true` et une préférence stockée
      `cloud` est neutralisée ; aucun appel de transcription/TTS réseau ne part de cette préférence.
- [x] Le diff ne change ni `GET /voice/config`, ni `POST /voice/transcribe`, ni
      `POST /voice/synthesize`, ni la matrice V1 ; la notice décrit leur flux Mistral encore possible
      pour les anciens binaires.
- [x] Android < 13 ou sans modèle `fr-FR` refuse avant permission ; iOS refuse avant permission si
      le recognizer exact `fr-FR` n'est pas strictement on-device.
- [x] `cancel` avant l'ACK `start`, puis démontage, attend la barrière native ; aucun start tardif,
      événement N ou lease N ne peut contaminer N+1.
- [x] Deux tours Android positifs ne relancent qu'une fois la découverte coûteuse des locales.
- [x] Une voix Android réseau est refusée ; une voix `fr-FR` locale est sélectionnée ; un stop N
      sans callback ne laisse aucun timer capable de couper N+1.
- [x] Une entrée active suivie de `cancel → synthèse` attend `abortAndWaitAsync`, `end`, la grâce et
      la libération ; le coordinateur audio réel ne renvoie pas `audio_busy` et le TTS est appelé.
- [x] `abort(): void → start()` immédiat est sérialisé par le module natif patché et ne superpose
      jamais deux recognizers.
- [x] Les sources de la page de confidentialité liée par l'app, du registre, de la liste des
      sous-traitants et de la DPIA distinguent dictée classique, Bob Live OpenAI et Mistral différé
      sans promettre une purge audio non certifiée.
- [x] Ces sources déclarent les usages textuels/OCR Mistral et Anthropic ainsi que les canaux actifs
      Sentry/EAS Observe, sans inventer d'opt-out, de durée maximale ou de région non prouvés.
- [x] L'écran de clôture, les sources de la notice publique et des CGU, le registre et la DPIA
      n'annoncent aucune suppression ou anonymisation que le runtime ne réalise pas.
- [ ] Les pages confidentialité et CGU effectivement servies par les URLs de l'app correspondent au
      commit exact déployé ; cette preuve relève de staging puis production, pas de l'état local.
- [x] Les tests ciblés mobile/UI/i18n, typechecks, lints et builds concernés sont verts depuis ce
      checkout propre.
- [x] Une revue adversariale ne laisse aucun P0/P1 local ouvert ; les gates de certification et de
      publication restent recensés séparément ci-dessous.

## 7. Definition of Done

- `implemented` : code réellement branché, tests ciblés, typecheck/lint/build et revue
  adversariale verts dans une PR atomique ;
- `certified` : CI du commit, APK preview exact-SHA puis scénario Android et iPhone physiques
  couvrant refus permission, silence, panne réseau et bascule texte avec TalkBack/VoiceOver ;
- `released` : promotion selon `PR → staging validé → production`, sans changement silencieux de
  fournisseur ou activation de capacité Mission supplémentaire.

Tant qu'une PR atomique/commit de preuve n'existe pas et que la revue adversariale conserve des
critères ouverts, le lot reste `specified`, même si l'implémentation candidate et ses preuves
logicielles existent dans le worktree. Les preuves appareils sont ensuite nécessaires pour passer
à `certified` ; aucune réponse ne présente ce lot comme « 100 % certifié production ».

## 8. Preuves de l'implémentation candidate — 9 août 2026

Preuves reproduites depuis ce checkout :

- mobile : 208 fichiers / 2 236 tests, plus 16 tests de redirection d'authentification ; typecheck
  et ESLint des fichiers modifiés verts ;
- core : 241 fichiers / 3 180 tests et typecheck verts ;
- UI : 56 fichiers / 508 tests et typecheck verts ; i18n : 113 tests et typecheck verts ;
- sign-web : 4 tests de parité légale, typecheck et build Next de production verts ;
- API clôture de compte : 4 tests ; typechecks API et api-client verts ;
- dépendances : installation `--frozen-lockfile` verte et patchs pnpm appliqués ;
- Android : `:app:compileDebugKotlin` et `:bob-live-audio:testDebugUnitTest`, 421 tâches, succès ;
- iOS : build complet du dev client sur simulateur avec Xcode 26.6, succès ;
- revue adversariale à trois voix : aucun P0/P1 restant dans le runtime local ASR/TTS classique,
  le lifecycle natif, le contrat Expo/TypeScript ou le parcours texte accessible.

Le scénario `cancel → synthèse` est désormais prouvé avec le singleton
`ProcessAudioSessionCoordinator` de production : avant la résolution de la barrière et de la grâce,
une acquisition concurrente reçoit `audio_busy` ; après libération, le lease de sortie est accordé
et le TTS est réellement appelé. Les sources légales et de conformité du dépôt sont cohérentes et
testées par parité, mais leur déploiement exact reste une preuve externe. Les blockers suivants ne
sont pas des défauts locaux du repli vocal ; ils empêchent toujours toute certification ou
publication.

## 9. Gates restant dus avant `certified` ou `released`

- déployer les pages confidentialité/CGU corrigées sur les URLs réellement liées par l'app, puis
  attester leur contenu et le SHA servi ;
- livrer une suppression de compte et des données associées, avec conservation légale classifiée,
  reprise durable de la suppression Auth et ressource web de demande ; la clôture actuelle ne
  constitue pas cette suppression ;
- résoudre les champs `[BLOQUÉ FONDATEUR]` : identité et contact légaux, DPA/CCT, régions,
  rétentions et décisions de conservation ;
- inventorier et certifier le parc d'anciens binaires qui peut encore appeler les routes vocales V1,
  ou fermer cette capacité par une décision produit autorisée et atomique ;
- obtenir CI du commit exact, APK preview exact-SHA, essais Android/iPhone physiques et preuves
  TalkBack/VoiceOver, puis suivre `PR → staging validé → production` ;
- attester les métadonnées de release production et les flags réels ; Bob Live public reste OFF.
