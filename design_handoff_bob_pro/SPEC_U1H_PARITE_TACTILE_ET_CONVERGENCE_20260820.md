# SPEC U1-h — La revue de doublons se résout au doigt, et la fin d'un run cesse d'être un silence

- **Date** : 2026-08-20 · **Auteur** : Claude (bâton fondateur) · **Méthode** : panel 3 architectes
  + juge (wf_00b3e76f), **faits porteurs re-vérifiés de ma main** avant rédaction.
- **Amendement** : Codex, 2026-08-20 — état réel après Safety, intégration et contre-revue U1-h.
- **Statut normatif** : `specified` — la gate moteur unique du parent Jarvis §17/§21.2 reste
  fermée. L0/L1/L9 (`3a51593f6`), L2/L3 (`ab7b4439d` + durcissement `5a86f94d6`) et L4
  (`d4742b35d`) sont réalisés et prouvés localement ; la mesure/correction M1 est implémentée
  localement par `e79d205e0` ; L7 est implémenté localement par `e9d128c97` et L5 par le présent
  lot. L6, L8 et L10–L11 restent à réaliser. Aucun livrable U1-h n'est `certified` ni `released`.
- **Deltas mesurés** : `3a51593f6` = 7 fichiers, +453/-15 ; `ab7b4439d` = 6 fichiers,
  +503/-13 ; `5a86f94d6` = 4 fichiers, +359/-16. Safety et U1-i ne sont pas attribués à U1-h.
- **Parents** : SPEC_U1G §6 (hors-lot tracé) · spec Jarvis §7.0/§8/§9.1/§14/§17.1 · FD-2026-0817-06.
- **Objet** : donner un **émetteur humain** et une **voix honnête** au chemin de doublons déjà
  livré, et fermer trois dettes que le vertical traîne — sans ajouter une capacité au domaine.

## 0. L'axe, et ce qu'il exclut

Le delta U1-h (`3a51593f6`, `ab7b4439d`, `5a86f94d6`) ne modifie ni
`packages/core/src/domain/agent/definitions/customer-contact-v1.ts`, ni
`customer-contact-semantic-frame.ts` : l'oracle L0 fige l'union des commandes, les phases et les
décisions de doublon. Le lot Safety intégré séparément modifie le contrat d'autorité de l'action
via `actionReference` et le binding d'admission, sans modifier l'union des commandes, les phases
ni les décisions de doublon figées par L0. Cette modification ne doit pas être attribuée à U1-h.

U1-h n'ajoute aucune migration et n'active aucun flag. Après Safety, `U1_OPEN_ACTIONS` n'existe
plus : `U1_CANDIDATE_ACTIONS` est uniquement un inventaire technique et ne vaut jamais
publication. Le manifest runtime reste vide.

La commande `choose_duplicate_resolution` **existe déjà** (union, parse, `reduceDuplicateDecision`,
garde de phase). Il ne lui manquait qu'un émetteur tactile.

## 1. Les cinq faits de la baseline qui commandent ce lot, mesurés

Chacun décrit la baseline `dd953e435` et a été vérifié avant rédaction. Leur état après
implémentation est donné par le ledger ci-dessus ; aucun n'est une déduction.

1. **L'effet de convergence est MORT.** `use-jarvis-run-frame.ts` déclenche sa relecture sur
   `phase === 'completed'`. Or la phase de domaine `completed` projette vers le **statut**
   `completed` (`customer-contact-v1.ts:129-130`), qui est dans `JARVIS_RUN_TERMINAL_STATUSES` — et
   `getCurrentRun` rend `NO_CURRENT_RUN` dès qu'un statut est terminal
   (`jarvis-run.controller.ts:1161`). La phase observée passe donc de « écriture » à **`null`**,
   jamais à `'completed'`. Conséquence exacte : l'artisan confirme, la carte disparaît sans un mot,
   **sa fiche reste visuellement inchangée** — le préjudice que le commentaire du fichier prétend
   empêcher.
2. **Le libellé de fiche a DEUX règles de frontière.** Le devis passe par
   `canonicalCustomerName()` (quatre lectures) ; le jumeau Jarvis
   `readJarvisCustomerLabels` rend `row.canonicalName` **brut**. Divergence réelle, dans du code
   livré sans appelant — donc jamais exercée. Avec la lecture Jarvis, cela fait cinq sites au
   total, pas « cinq plus un ».
3. **`idleExpiresAt` MENT.** La branche non-semis de `persistTransition` avance `updatedAt` mais
   n'écrit jamais `idleExpiresAt` : la colonne mesure l'**âge** du run, pas son inactivité. Pire,
   les lignes Jarvis violent ainsi l'invariant legacy `agent-mission.ts:1597`
   (`idleExpiresAt !== Math.min(updatedAt + IDLE_TTL, hardExpiresAt)` ⇒ `inconsistent_state`), que
   la projection déterministe du cutover §17 relira. On ne prépare pas un balayeur : **on désamorce
   une mine**, en une ligne, sans migration.
4. **Le catalogue ignore les surfaces Jarvis.** `client-creer@1` ne cite que
   `clients.tsx:74` et `:285` ; `client-modifier@1` cite `client/[id].tsx:327` et `:599`. Aucune
   des deux ne cite la carte de l'onglet assistant, alors que la gate de continuité de surface
   §17.1 se calcule sur ce manifeste. *(Le panel avait sur-généralisé sur `client-modifier` ; c'est
   corrigé ici.)*
5. **`findForegroundForUpdate` ne cherche que `status: 'active'`**, alors que l'index partiel
   `agent_missions_one_active_owner_key` inclut `waiting_user`. Le chemin vers un
   `insert_conflict_without_active_foreground` est donc plausible — mais ce n'est qu'une
   **hypothèse** : elle se mesure (M1), elle ne s'écrit pas.

## 2. `adopt_existing` — CLOS, avec ses raisons mesurées

Le pivot création→modification reste la plus séduisante des idées, et il est **clos sous cette
forme**. La raison décisive n'est pas théorique : `projectUpdateFields`
(`jarvis-customer-effect.executor.ts:280-313`) fait **recouvrir** `name`, adresse, e-mail,
téléphone et destinataire sur la fiche existante. Un `use_existing` erroné **termine le run sans
écrire** ; un `adopt_existing` erroné **écrase l'identité d'un client par celle d'un autre** —
l'effet que §9.1 réserve à « une action distincte, destructive et renforcée » — sur un choix fait
à l'oreille, parmi des libellés bornés à 160 avec élision médiane.

À la baseline, l'`actionId` était recalculé à plusieurs frontières. Safety le dérive désormais une
seule fois depuis le seed ou le state persistant via `definition.actionReference` ; toute
divergence du wire rend `action_binding_mismatch`. Un pivot création→modification au milieu du
même run violerait donc cette identité autoritaire et reste interdit. Par ailleurs,
`capabilitiesFor` n'offre pas `confirm` vocal en mode `update`, si bien que le run deviendrait
**inconfirmable à la voix** juste après que Bob a dit « d'accord ».

**Le pont existe déjà et il est meilleur** : `use_existing` puis « Modifier avec Bob » sur la vraie
fiche — deux gestes, deux runs, deux autorités, aucune identité écrasée.

## 3. Livrables

- **L0 — Oracle « domaine intact »** : union de commandes, phases et table de transitions figées en
  liste explicite. Le reducer et la frame sortent byte-identiques.
- **L1 — Une seule règle de frontière pour le libellé** : `canonicalCustomerName` devient une source
  unique ; les quatre lectures devis et `readJarvisCustomerLabels` s'y branchent, ce dernier **pinçant**
  aussi sa borne. Fixture d'égalité obligatoire (patron U1-g L3).
- **L2 — La présentation serveur nomme la revue et l'issue** : le wire gagne `duplicateReview`
  (reviewId + rangs {ordinal, choiceId, label}) et `completion`. Identités **et ordre** viennent du
  state **scellé**, jamais d'une nouvelle recherche. **Aucun `customerId` de candidat** ne traverse
  le wire. Libellés assainis par le **même** `sanitizeSpokenLabel(…, 160)` que la voix, puis
  `presentedText`. Port absent ou en panne ⇒ `duplicateReview: null` + audit
  `jarvis.presentation.duplicate_labels_unavailable` (patron `target_snapshot_unavailable`).
- **L3 — La commande tactile** : cinquième membre de l'union fermée,
  `choose_duplicate_resolution { reviewId, decision: continue_create | use_existing{choiceId} }`,
  reconstruit clé par clé. C'est un **choix structuré** (§8), pas une confirmation d'effet : ni
  reçu de présentation ni step-up.
- **L4 — Deux gestes du coordinateur** : `chooseExistingCustomer` et `continueCreation`, gardés sur
  la phase et l'appartenance du `choiceId` au jeu **rendu** — refus **sans réseau** sinon.
- **L5 — La carte** : `awaiting_duplicate_review` sort du `default:` ; liste numérotée dans l'ordre
  du wire, un rang irrésolu affiche « Fiche introuvable », **garde son ordinal**, bouton désactivé.
  `NOTICES.preparing` scindé en deux vérités. Kit 1.x uniquement ; accessibilité = livrable.
- **L6 — L'hôte rend le vrai client** *(reste `specified`, conditionné à M2)* : à
  `5a86f94d6`, `JarvisRunWireView` ne transporte pas `resolvedExistingCustomerId`.
  L'implémentation devra nommer le champ terminal exact, le codec et sa provenance depuis le
  postimage ; aucun `customerId` de candidat ne doit apparaître dans la revue.
- **L7 — La fin d'un run cesse d'être un silence** : un reçu tactile autoritaire, ou une lecture
  courante autoritaire, arme le suivi exact dès qu'un effet peut encore modifier les projections.
  Le règlement n'affirme rien : il relit.
- **L8 — Les paroles nomment toutes les issues** : « ou dis “annule” » à la revue ; le client retenu
  est **nommé** (libellé irrésolu ⇒ phrase sans nom, jamais un nom deviné) ; la promesse « je te dis
  dès que c'est fait » cesse (aucun tour vocal ne naît d'un reçu) et dit **où** le résultat paraît ;
  `foreground_busy` nomme l'onglet sans affirmer la nature de la demande bloquante.
- **L9 — `idleExpiresAt` redevient vrai** : `LEAST(occurredAt + idleTtlMs, "hardExpiresAt")`,
  horloge **base**. `hardExpiresAt` reste immuable après le semis. Aucune migration.
- **L10 — Les surfaces Jarvis entrent au catalogue** : `client-creer@1` gagne la carte de l'onglet
  assistant ; `client-modifier@1` gagne le geste « Modifier avec Bob ». Aucune autre valeur touchée.
- **L11 — Spec, AIPD, mesures** : cette spec ; ligne AIPD étendue (libellés affichés à l'**écran**,
  hors LLM, hors historique) ; **M1** (foreground vs `waiting_user`) et **M2** (survie de la session
  realtime au changement d'onglet) consignées **avant** toute ligne qui en dépend.

### 3.1 M1 — protocole binaire avant correction

M1 ne se déduit pas du seul index. La mesure doit traverser le vrai writer devis et PostgreSQL :

1. persister, pour un propriétaire neuf, un run `customer_contact@1` valide en
   `status = waiting_user` et `phase = awaiting_duplicate_review` ;
2. appeler le vrai `StartQuoteAgentMission` sous l'autorité realtime de ce même propriétaire ;
3. relire missions, événements et brouillon après la transaction.

Le défaut est confirmé si le writer tente l'insert puis retourne
`insert_conflict_without_active_foreground`. L'acceptation après correction est fermée :

- le résultat est le conflit métier `agent_mission_foreground/active_mission_exists` ;
- le run Jarvis existant est la seule mission du propriétaire ;
- aucun événement devis et aucun `quote_draft_slot` ne sont créés ;
- `findForeground` et `findForegroundForUpdate` utilisent la **même** liste core exportée que
  l'index `agent_missions_one_active_owner_key` ;
- la matrice exacte reste `active | waiting_user | waiting_screen | retry_due`, gardée contre la
  migration par le test de vocabulaire ; aucune migration ni modification de schéma n'est requise.

**Évidence locale M1 — `e79d205e0`.** La mesure pré-correction rend 121 preuves PostgreSQL vertes
et une rouge avec `insert_conflict_without_active_foreground`. Après correction : 8 fichiers / 122
preuves PostgreSQL, test core 14/14, synchronisation SQL 13/13, typechecks core/API, ESLint ciblé et
`git diff --check` verts. Cette preuve établit `implemented` localement ; elle ne promeut ni U1-h ni
le moteur Jarvis en `certified` ou `released`.

### 3.2 L7 — protocole binaire de convergence

Le terminal ne devient pas une nouvelle projection mobile : `GET /jarvis/runs/current` conserve sa
loi réelle. Il sert le run courant non terminal/non quarantiné en donnant la priorité au détenteur
du foreground ; `waiting_external` et `cancelling` peuvent donc y être servis tout en libérant ce
foreground, puis être masqués par un nouveau run.

Le reçu tactile admis est la première postimage autoritaire. La carte ne le jette plus : elle le
transmet à l'autorité L7 **avant** la relecture courante. Une lecture `current` qui observe elle-même
un statut d'effet pendant reste un deuxième émetteur autoritaire. Dès l'une de ces observations, le
run est suivi par l'endpoint stateless existant `GET /jarvis/runs/:runId` ; voir ensuite `absent` ou
un autre `runId` n'est ni requis, ni interprété comme une fin.

La décision « un effet déjà autorisé peut-il encore modifier les projections ? » appartient au
core sous forme d'une matrice exhaustive des onze `JarvisRunStatus`. Elle vaut vrai uniquement pour
`waiting_external`, `retry_due` et `cancelling`; ajouter un statut exige donc une décision de
compilation, jamais un défaut mobile implicite. Dès que la lecture exacte rend un statut dont cette
matrice vaut faux, l'autorité invalide une fois les préfixes métier canoniques et relit `current`,
sans déduire succès, échec ou entité modifiée.

Cette autorité est une instance owner-scopée unique, montée au-dessus des routes avec la capability
Mission : assistant et fiche client ne possèdent ni file ni timer. Sa file ne garde que des `runId`,
la révision minimale autoritaire et des métadonnées de cadence/backoff, jamais un snapshot ou de la
PII. Un seul GET exact vole à la fois, avec un plancher global de 1 500 ms ; succès encore pendant ⇒
rotation équitable, erreur ⇒ backoff exponentiel plafonné à 30 s, sans qu'une cible en panne bloque
les suivantes. Une panne réseau suit ce backoff ; le scheduler se met en pause en arrière-plan via
le pont AppState/focusManager déjà câblé, puis reprend au signal. Changement de principal, logout ou
démontage global abortent le vol et purgent la file. Aucun endpoint neuf, aucune seconde projection
terminale et aucun polling par hôte ne sont ajoutés.

L'acceptation L7 est fermée :

- confirmation tactile sur A → reçu A `waiting_external` → premier GET courant déjà absent ou B :
  A reste suivi ; sa sortie exacte invalide notamment `['customers']` exactement une fois ;
- une lecture courante de A dans un statut d'effet pendant arme le même suivi, y compris sans
  présentation ; le doublon reçu/current reste un seul `runId` ;
- une absence initiale, une lecture en chargement ou en erreur et un run dont la matrice core vaut
  faux n'arment ni n'invalident rien ;
- une erreur de relecture courante ou exacte ne détruit ni le dernier témoin d'écriture ni la cible
  suivie : une lecture autoritaire ultérieure converge encore ;
- deux hôtes montés observent la même instance : un seul GET exact vole et un règlement n'invalide
  qu'une fois ;
- une cible en erreur, cinq cibles pendantes et le backoff maximal prouvent l'ordre équitable et le
  plancher global ; la suite avance réellement le temps, puis prouve zéro GET après règlement ;
- un écho d'un autre `runId` ou une révision exacte inférieure au dernier reçu/current observé ne
  règle jamais la cible ; la lecture reste due avec backoff ;
- le changement de principal avec un vol en retard purge et abort : aucune réponse d'un compte ne
  déclenche une invalidation pour un autre ; l'arrière-plan ne produit aucun GET ;
- plusieurs effets sont suivis séparément, sans qu'un effet bloqué affame les suivants. Le suivi
  s'arrête sur toute sortie stable ; aucun polling d'un run réglé et aucune seconde autorité de
  cache ne sont ajoutés.

Le canal vocal ne rend aujourd'hui aucun reçu de commande au mobile. L7 couvre donc un effet vocal
seulement s'il est observé pendant par `GET current`; un effet vocal devenu terminal avant toute
observation mobile reste un blocker distinct de la convergence voix→écran et interdit toute
revendication de L7 global/certifié.

**Évidence locale L7 — `e9d128c97`.** La matrice core passe 15/15 ; sept fichiers de preuves
mobiles passent 85/85, incluant le reçu A masqué par B, deux hôtes, StrictMode réel, révision stale,
écho de run divergent, équité/backoff, changement de principal, cold-start arrière-plan et gestes
tactiles. Typechecks core/mobile, ESLint ciblé et `git diff --check` sont verts. Aucune preuve
appareil, staging ou voix→écran n'est revendiquée : L7 est `implemented`, jamais `certified`.

### 3.3 L5 — protocole binaire de la carte de revue

La carte consomme exclusivement `duplicateReview`, déjà dérivé serveur de l'état scellé. Elle ne
retrie, ne renumérote, ne recherche et ne traduit aucun candidat. L'ordre du tableau et chaque
`ordinal` traversent jusqu'au rendu ; un libellé `null` reste visible à son rang sous « Fiche
introuvable », avec son bouton de choix désactivé. Aucun `customerId` n'est ajouté au mobile.

`awaiting_duplicate_review` avec `duplicateReview: null` ne signifie pas « Bob cherche encore » :
la projection n'a pas pu rendre les libellés. La carte le nomme, offre une relecture autoritaire et
la même annulation honnête que les autres phases sans effet engagé ; elle n'invente ni liste vide,
ni succès, ni promesse « rien ne sera enregistré ». `resolving_customer` et
`preparing_proposal` gardent deux notices distinctes. L'issue terminale `existing_selected` reste
du ressort de L6 : `GET current` masque les runs terminaux, donc une frame terminale injectée dans
un test de carte serait une preuve artificielle.

Les trois gestes de revue sont ceux du coordinateur déjà gardé : choisir une fiche rendue, créer
malgré les rapprochements, ou annuler le run. Un seul vol est admis ; pendant ce vol tous les
gestes sont désactivés. Un reçu abouti est transmis à la convergence L7 avant relecture ; un conflit
relit, une panne reste visible et relançable sans état optimiste. Une panne est liée au `runId` et à
la révision qui l'ont produite : une frame autoritaire plus récente ne réaffiche jamais l'erreur de
l'ancienne. Le montage de la revue n'émet ni ACK de présentation, ni commande.

TalkBack consomme les régions vives Android. VoiceOver reçoit une annonce explicite seulement si
l'hôte est visible, une fois par `reviewId` et une fois par nouvelle panne ; un montage en arrière-
plan attend le premier plan et une republication identique ne parle pas deux fois.

Acceptation fermée L5 :

- matrice pure : revue complète → mode revue ; revue `null` → indisponibilité nommée ;
  `resolving_customer` et `preparing_proposal` → deux notices différentes ;
- ordre et ordinaux byte-identiques au wire ; rang irrésolu conservé et non choisissable, zéro
  appel réseau si son handler est invoqué malgré l'état désactivé ;
- chaque geste disponible appelle exactement la méthode du coordinateur avec la frame ou le run
  attendu ; le reçu complet part à L7, le conflit déclenche seulement une relecture ;
- vol différé : un seul départ, tous les boutons exposent leur état désactivé/occupé, puis l'erreur
  est annoncée et la relecture reste disponible ; une frame plus récente arrivée pendant ce vol
  reste exempte de son éventuel échec tardif ;
- VoiceOver/TalkBack disposent d'un titre, de libellés uniques incluant ordinal et nom, d'un état
  désactivé explicite pour le rang introuvable et d'une région vive/alerte pour les changements ;
  l'annonce iOS est absente en arrière-plan, part au premier plan et reste dédupliquée ;
- ce lot ne déplace pas les gates d'entitlement de l'hôte, ne touche ni L6, ni manifest, ni flag,
  ni contrat serveur. La publication N/N-1 reste bloquée par §7.

**Évidence locale L5 — présent lot.** La carte passe 25/25 et la matrice ciblée carte + coordinateur
et deux hôtes passe 71/71. La suite mobile complète passe 209 fichiers / 2305 tests, puis 16/16
contrôles de redirection. La preuve L7 qui dépendait de la vitesse des micro-tâches tient désormais
la lecture exacte ouverte et passe 28/28 ; mobile typecheck, ESLint ciblé, format et
`git diff --check` sont verts. Cette preuve établit `implemented` localement. Aucun essai appareil
VoiceOver/TalkBack, aucune validation staging et aucune compatibilité N/N-1 ne sont revendiqués :
L5 n'est ni `certified`, ni `released`.

## 4. Gardes à rendre vraies avant certification

- **G1** — une revue ne peut plus se résoudre à la seule voix.
- **G2** — l'écran ne peut ni **renuméroter**, ni **re-chercher** : l'ordinal est ce que Bob a
  prononcé, et il vient du jeu scellé. Un rang qui disparaîtrait ferait de « le troisième » à
  l'oreille un « 2 » à l'écran, sur un rattachement durable.
- **G3** — aucun `customerId` de candidat ne quitte le serveur ; la cible de navigation vient du
  postimage, jamais d'un choix affiché.
- **G4** — une panne de libellés échoue **fermé** et **nommé**, jamais en demi-liste.
- **G5** — la parole allongée ne peut pas faire taire les autres lanes : marge **recalculée** dans
  la preuve de frontière, avec un nom **astral**, jamais un nombre recopié.

## 5. Preuves exigées

- [x] Oracle L0 et absence de changement sémantique propre au delta U1-h.
- [x] Les quatre lectures devis et la lecture Jarvis sont câblées sur `canonicalCustomerName`.
- [ ] Une fixture discriminante traverse les quatre projections devis et
      `readJarvisCustomerLabels`, avec une valeur historique à espaces anormaux.
- [x] Projection serveur et codec prouvent ordre, absence de `customerId`, panne globale et issue.
- [x] Le parseur tactile serveur et le codec refusent clés étrangères et `adopt_existing`.
- [x] Coordinateur : deux gestes gardés, refus sans réseau hors phase/jeu rendu.
- [x] Carte : matrice phase × confirmation, ordre, rang irrésolu et accessibilité.
- [x] Convergence : reçu/current pendant → GET exact owner-scopé → règlement invalide une fois ;
      absence/B, écho divergent et révision stale ne peuvent clore prématurément le suivi.
- [x] PostgreSQL réel : `idleExpiresAt` avance avec la transition, `hardExpiresAt` reste immuable
      et `idle <= hard` (`121/121`, certificat local du 2026-08-20).
- [ ] Preuve discriminante du clamp exact sur `hardExpiresAt` sans fabriquer une ligne, et zéro
      ligne `quote_creation` touchée par ce scénario U1-h.
- [ ] PostgreSQL réel : `use_existing` tactile zéro écriture client et compte tenant inchangé.
- [ ] Catalogue, AIPD, M1 et M2 sont consignés avec preuves reproductibles.

## 6. Hors lot, tracé

- **Balayeur d'expiration** : L9 rend la colonne vraie ; le job qui la consomme est un lot santé —
  un cron neuf entre d'abord à l'inventaire §17.1.
- **`wake_run` sans émetteur** : la transition existe, totale et idempotente, mais rien ne l'émet —
  le TTL de confirmation §7.1 ne s'applique donc que paresseusement.
- **Rapprochement SIREN / e-mail / téléphone** : §9.1 l'autorise, la minimisation PII l'exclut de la
  voix. « Rapprochement par **nom uniquement** » est reconduit.
- **`adopt_existing`** : clos (§2). Une reprise éventuelle passerait par une action **distincte et
  renforcée**, jamais par une mutation d'`actionId` en cours de run.

## 7. Le piège de publication, à consigner

Le codec refuse **à la forme** sur clé inconnue : un serveur qui enverrait `duplicateReview` à un
client N-1 rendrait la présentation `null` et pourrait masquer toute carte, y compris le parcours
de modification. La fermeture Safety empêche une publication accidentelle mais ne prouve ni
l'absence d'une APK N-1, ni sa compatibilité.

Ce risque U1-h n'est levé qu'avec un schéma réellement compatible N/N-1, ou avec la gate client
exacte du parent §17.1 : force-update global déployé et prouvé, ou anciennes routes en lecture
seule avec bandeau pendant une fenêtre chiffrée. Une attestation opérateur exact-SHA seule est
insuffisante. Ces preuves sont nécessaires mais ne remplacent aucune autre gate de publication.

Aucun flag positif, aucune publication et aucune certification ne sont revendiqués ici.
