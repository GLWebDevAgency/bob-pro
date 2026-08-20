# SPEC U1-f — La chaîne armée : l'effet réel, le bouton, la continuité voix↔écran

- **Date** : 2026-08-20 · **Auteur** : Claude (bâton fondateur, autonomie déléguée) · **Méthode** :
  cartographie 6 lecteurs + synthèse croisée (wf_ecced7cc, faits re-vérifiés `fichier:ligne`).
- **Parents** : SPEC_U1E (parcours visible) · spec Jarvis §5.3/§7.0/§7.1/§8/§9.1/§14 · FD-02.
- **Périmètre** : rendre le parcours `client-modifier@1` RÉELLEMENT opérant en production —
  aujourd'hui un `confirm` n'écrit jamais rien (chaîne d'effet désarmée) et un run ouvert à
  l'écran ne peut jamais recevoir de proposition (émetteur inatteignable).

## 1. Armer la chaîne d'effet (bloqueur absolu)

Le worker de dispatch tourne chaque minute et rend `dependencies_absent` : ses trois liaisons
n'existent pas. Un run confirmé reste en `committing` à vie — et `cancel_run` en `committing` ne
fait qu'observer un reçu qui ne viendra jamais. AUCUNE sortie humaine.

- **`JARVIS_WORK_ITEMS_DISPATCH`** : lier `PrismaJarvisWorkItemsRepository` (existe, certifié).
- **`JARVIS_DISPATCH_RUN_DIRECTORY`** : annuaire des coordonnées à dispatcher — implémentation
  Prisma neuve, calquée sur la lecture du harnais u1e (work items `signalAppliedAt IS NULL`),
  mais sous l'identité que la RLS de `jarvis_work_items` admet réellement (à prouver en
  certification, jamais un `BYPASSRLS`).
- **`JARVIS_CUSTOMER_EFFECT_AUTHORITY`** : l'adapter de production annoncé « livrable à part »
  par U1-d — portée tenant/principal sur les use cases CANONIQUES (`Customer.of`+save,
  `UpdateCustomer`), même patron que `CertificationCustomerAuthority` du harnais u1e ; jamais
  un accès direct aux tables.

Contraintes : DI fail-closed tout-ou-rien ; registre borné à `U1_OPEN_ACTIONS` (source G2) ;
`BOB_JARVIS_DISPATCH_ENABLED` est ON par défaut — câbler ARME, et c'est voulu : aucun run ne
peut naître avant ce lot (pas de bouton, flag vocal OFF), donc armer précède l'ouverture.

## 2. La continuité voix↔écran (§14) — un run écran doit être joignable

L'unique émetteur de `stage_proposal` est l'orchestrateur vocal, et il ne balaie que ses 4
graines dérivées de session : un run semé par `POST /jarvis/runs` lui est invisible. Le bouton
de l'item 3, livré seul, fabriquerait des runs parqués en `preparing_proposal` qui confisquent
le premier plan (foreground unique par owner).

Décision : `prepare()` vocal découvre D'ABORD le run `customer_contact` non terminal de l'owner
— tous semeurs confondus — puis retombe sur ses graines pour un semis neuf. La vue stateless
est étendue (port fermé → nouvelle méthode `currentRunByKind`), adossée à la lecture
`readJarvisCurrentRun` déjà certifiée. Deux tours concurrents restent déterministes : le run
courant est un fait de base, la graine un dérivé.

Gardes : l'offre d'outils par phase est INCHANGÉE (un run écran en `preparing_proposal` offre
`proposal.stage`/`cancel` — c'est le but) ; le confirm d'update reste interdit à la voix
(§7.0 règle 3) ; AUCUN flag n'est flippé — la cascade d'activation vocale reste OFF, ce lot
livre la capacité, l'activation est une décision de release séparée.

## 3. Le bouton d'ouverture — « Modifier avec Bob »

QuickAction sur la fiche client (surface cataloguée de `client-modifier@1`, tone `ai` — le
canal de Bob), appelant `client.jarvisOpenRun` :

- `commandId` mémoïsé jusqu'au reçu via le registre INJECTÉ (le `runId` est dérivé du
  `commandId` : un id régénéré au remontage créerait un second run) ;
- narrowing de la méthode optionnelle, échec fermé ;
- `jarvis.refresh()` après le reçu — la carte apparaît EN PLACE (notice « préparation » +
  Annuler) sans navigation ;
- 409 `foreground_busy` PRÉSENTÉ au point du bouton (aucun traitement mobile n'existe) : le
  message dit qu'une demande est déjà en cours et où la retrouver ;
- gating `!customerFresh` comme les autres gestes d'écriture ; borne G2 par `isU1OpenAction`.

**[DÉCISION D1]** Pas de gate d'entitlement : parité humain↔Bob (l'artisan modifie sa fiche à
la main sans abonnement ; Bob qui l'assiste sur la MÊME surface suit la même règle), test
normatif existant (« la fiche client n'est fermée par AUCUN entitlement »), bornes réelles =
rollout G2 + admission.

## 4. Nommer la cible — le libellé serveur

L'onglet assistant fait confirmer une modification M2 `privacy_sensitive` sans dire de QUI il
s'agit. La présentation wire gagne `targetLabel: string | null`, TOUJOURS présent :

- résolu SERVEUR par extension de `JarvisStatelessReadView` (lecture nue de `customers.name`
  sur le MÊME snapshot RepeatableRead, sans verrou) — le controller n'a aucun accès base ;
- bornes `presentedText` fail-closed appliquées au libellé (serveur ET codec) ; illisible ⇒
  `null`, jamais une présentation annulée (le libellé est informatif, pas engageant) ;
- lockstep wire assumé **[DÉCISION D3]** : pré-V1, aucune APK publique — codec, fixtures et
  contrats mis à jour ensemble ; jamais persisté (le state ne porte que des digests).

## 5. L'avant du diff — display-only, §9.1 reste l'autorité

**[DÉCISION D2]** `before` est rempli par une relecture DISPLAY-ONLY au GET (TOCTOU assumé et
documenté : la garde §9.1 au confirm est l'unique autorité — une fiche qui bouge invalide la
proposition, l'avant affiché n'engage rien). Politique d'imprésentabilité DÉFINIE :

- `after` imprésentable ⇒ présentation entière annulée (règle existante, inchangée — l'after
  est ce que l'artisan confirme) ;
- `before` imprésentable (ex. `billingChannelType` hors table de libellés, `chorus`/`portail`)
  ⇒ `before: null` pour CE champ — dégradé honnête, jamais une fiche inconfirmable.

Mapping colonnes→clés : celui de la relecture d'admission étendu (name, email, phone,
addrLine1, addrZip, addrCity, contactName, tvaIntracom, billingChannelType). Zéro changement
mobile : le wire, le codec et la carte savent déjà rendre un `before` non nul.

## 6. Dérive de cible avant proposition — traitement minimal

Le run stale est un cul-de-sac SOFT (Annuler offert, ré-ouverture re-résout frais). En lot :
le refus `target_revision_stale` au `stage_proposal` vocal gagne sa PAROLE NOMMÉE (« la fiche
a changé depuis ma vérification… ») au lieu du générique mensonger, plus une trace d'audit.
Le re-datage réel (rouvrir le cycle §7.1) : chantier de domaine à part, hors lot.

## 7. Hors lot (tracé, avec pourquoi)

- **Résolution create** (`no_duplicates`/`duplicate_candidates` sans émetteur) : vertical
  création vocale, flag kind OFF fail-closed. GARDE IMPÉRATIVE tracée : ne pas activer
  `bob.agent_missions.customer_contact.v1` tant que ce maillon manque.
- **Émetteur `record_target_mutation`** depuis UpdateCustomer : §9.1 couvre déjà la sûreté au
  confirm ; l'éveil temps-réel est un chantier propre (commandId v8 + preuve tx).
- **Canal écran pour email/phone/vatNumber** (exclus de la voix par redaction PII) : exige un
  canal non-LLM neuf, le tap est fermé par doctrine.
- **Handoff voix→écran** (invalidation `['jarvis-run','current']` post-tour Live) : confort ;
  mount/focus + refresh du bouton couvrent le parcours.
- **Drapeaux dormants** `RUN_STALE_RECOVERY_PROBES`/`SEED_EPHEMERAL_ACTIVATION_EVIDENCE`
  (hors Jarvis) : preuves qui ne tournent nulle part — à traiter dans un lot santé-dépôt.

## 8. Preuves exigées

Certification PostgreSQL : la chaîne COMPLÈTE bout en bout par les routes et le worker RÉELS —
ouverture écran → proposition (port) → ack → confirm → work item claim → effet exécuté par
l'adapter de PRODUCTION → fiche relue mutée → run `completed` ; l'annuaire de dispatch prouvé
sous la RLS réelle ; le libellé et le `before` prouvés depuis le GET. Mobile : le bouton
(mémoïsation du commandId au remontage, 409 présenté), la carte avec libellé et avant. É1
locale (`expo run:ios` simulateur) si le temps le permet — jamais de build EAS sans GO.
