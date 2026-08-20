# SPEC U1-h — La revue de doublons se résout au doigt, et la fin d'un run cesse d'être un silence

- **Date** : 2026-08-20 · **Auteur** : Claude (bâton fondateur) · **Méthode** : panel 3 architectes
  + juge (wf_00b3e76f), **faits porteurs re-vérifiés de ma main** avant rédaction.
- **Parents** : SPEC_U1G §6 (hors-lot tracé) · spec Jarvis §7.0/§8/§9.1/§14/§17.1 · FD-2026-0817-06.
- **Objet** : donner un **émetteur humain** et une **voix honnête** au chemin de doublons déjà
  livré, et fermer trois dettes que le vertical traîne — sans ajouter une capacité au domaine.

## 0. L'axe, et ce qu'il exclut

`packages/core/src/domain/agent/definitions/customer-contact-v1.ts` et
`customer-contact-semantic-frame.ts` sortent de ce lot **byte-identiques**. Aucune migration.
Aucun flag activé. `U1_OPEN_ACTIONS` intact. Un oracle le prouve (L0) — c'est la garantie
centrale, pas un détail de forme.

La commande `choose_duplicate_resolution` **existe déjà** (union, parse, `reduceDuplicateDecision`,
garde de phase). Il ne lui manquait qu'un émetteur tactile.

## 1. Les cinq faits qui commandent ce lot, mesurés

Chacun a été vérifié dans le worktree avant d'entrer ici. Aucun n'est une déduction.

1. **L'effet de convergence est MORT.** `use-jarvis-run-frame.ts` déclenche sa relecture sur
   `phase === 'completed'`. Or la phase de domaine `completed` projette vers le **statut**
   `completed` (`customer-contact-v1.ts:129-130`), qui est dans `JARVIS_RUN_TERMINAL_STATUSES` — et
   `getCurrentRun` rend `NO_CURRENT_RUN` dès qu'un statut est terminal
   (`jarvis-run.controller.ts:1161`). La phase observée passe donc de « écriture » à **`null`**,
   jamais à `'completed'`. Conséquence exacte : l'artisan confirme, la carte disparaît sans un mot,
   **sa fiche reste visuellement inchangée** — le préjudice que le commentaire du fichier prétend
   empêcher.
2. **Le libellé de fiche a DEUX règles de frontière.** Le devis passe par
   `canonicalCustomerName()` (5 sites, `agent-mission.persistence.ts:250`) ; le jumeau Jarvis
   `readJarvisCustomerLabels` rend `row.canonicalName` **brut**. Divergence réelle, dans du code
   livré sans appelant — donc jamais exercée.
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

S'y ajoutent : l'`actionId` est dérivé de `state.intent.mode` en **cinq sites** (dont celui qui
pince le rollout et l'enveloppe bornée par `isU1OpenAction`) — le faire muter les fait muter tous,
et le work item émettrait `client-modifier@1` pour un run admis `client-creer@1` ; et
`capabilitiesFor` n'offre pas `confirm` vocal en mode `update`, si bien que le run deviendrait
**inconfirmable à la voix** juste après que Bob a dit « d'accord ».

**Le pont existe déjà et il est meilleur** : `use_existing` puis « Modifier avec Bob » sur la vraie
fiche — deux gestes, deux runs, deux autorités, aucune identité écrasée.

## 3. Livrables

- **L0 — Oracle « domaine intact »** : union de commandes, phases et table de transitions figées en
  liste explicite. Le reducer et la frame sortent byte-identiques.
- **L1 — Une seule règle de frontière pour le libellé** : `canonicalCustomerName` devient une source
  unique ; les 5 sites du devis et `readJarvisCustomerLabels` s'y branchent, ce dernier **pinçant**
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
- **L6 — L'hôte rend le vrai client** *(conditionné à M2)* : `onResolvedExistingCustomer` →
  navigation vers la fiche, l'id venant du **postimage** du reçu.
- **L7 — La fin d'un run cesse d'être un silence** : l'effet de convergence guette la transition
  d'une phase d'écriture vers **`absent`**, seul signal observable. Il n'affirme rien : il relit.
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

## 4. Gardes — ce qui devient impossible

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

En mémoire : l'oracle L0 ; la totalité phase × confirmation de la carte, **par mutation** ; les
refus sans réseau du coordinateur ; le lockstep des trois parseurs sur une présentation issue du
**vrai** serveur ; la frontière de parole avec nom astral.
Sur **PostgreSQL réel** : l'égalité de normalisation sur les cinq sites ; `idleExpiresAt` mesuré
après une transition non-semis, clamp `hardExpiresAt` exercé, zéro ligne `quote_creation` touchée ;
le parcours tactile de bout en bout — `use_existing` **n'écrit aucune fiche** et le compte de fiches
du tenant ne bouge pas.

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
client qui l'ignore rendrait `null` ⇒ `unpresentable` ⇒ **plus aucune carte**, y compris le
parcours de modification. Le risque est **nul aujourd'hui** (pré-V1, aucune APK publique) et
**mortel après publication**. À inscrire au plan de cutover : passé V1, une clé de présentation
s'ajoute **optionnelle** ou derrière une version de schéma.
