# SPEC U1-f — La chaîne armée : l'effet réel, le bouton, la continuité voix↔écran

- **Date** : 2026-08-20 · **Auteur initial** : Claude (bâton fondateur, autonomie déléguée) ·
  **Amendements de sûreté** : GPT, 2026-08-20, contre-signature Claude demandée via le canal
  git-native et encore en attente au moment de ce gel · **Méthode** : cartographie 6 lecteurs +
  synthèse croisée (wf_ecced7cc, faits re-vérifiés `fichier:ligne`) puis revue adversariale du
  runtime réellement mergé.
- **Instruction fondatrice** : chat du 2026-08-20 — « un seul et même moteur », sans code
  dupliqué ni surcouche, puis « faire les corrections en parallèle au fur et à mesure ».
  La fermeture de publication ci-dessous est la conséquence de sûreté des specs parentes ; elle
  n'est pas présentée comme une citation du fondateur.
- **Parents** : SPEC_U1E (parcours visible) · spec Jarvis §5.3/§7.0/§7.1/§8/§9.1/§14 · FD-02.
- **Périmètre** : câbler la chaîne technique du parcours `client-modifier@1`, mais le garder
  **non mutant en production** jusqu'au release manifest exact et au cutover du moteur unique.
  Le câblage seul ne promeut aucun statut et ne vaut jamais publication.

## 1. Armer la chaîne d'effet (bloqueur absolu)

Le worker de dispatch tourne chaque minute et rend `dependencies_absent` : ses trois liaisons
n'existent pas. Un run confirmé reste en `committing` à vie — et `cancel_run` en `committing` ne
fait qu'observer un reçu qui ne viendra jamais. AUCUNE sortie humaine.

- **`JARVIS_WORK_ITEMS_DISPATCH`** : lier `PrismaJarvisWorkItemsRepository` (existe et est couvert
  par la certification PostgreSQL locale reproductible de ce lot).
- **`JARVIS_DISPATCH_RUN_DIRECTORY`** : annuaire des coordonnées à dispatcher — implémentation
  Prisma neuve, calquée sur la lecture du harnais u1e (work items `signalAppliedAt IS NULL`),
  mais sous l'identité que la RLS de `jarvis_work_items` admet réellement (à prouver en
  certification, jamais un `BYPASSRLS`).
- **`JARVIS_CUSTOMER_EFFECT_AUTHORITY`** : l'adapter de production annoncé « livrable à part »
  par U1-d — portée tenant/principal sur les use cases CANONIQUES (`Customer.of`+save,
  `UpdateCustomer`), même patron que `CertificationCustomerAuthority` du harnais u1e ; jamais
  un accès direct aux tables.

Contraintes : DI fail-closed tout-ou-rien ; registre borné à `U1_CANDIDATE_ACTIONS` (source G2), qui
n'est qu'une allowlist technique et ne vaut jamais release. `BOB_JARVIS_ADMISSION_ENABLED` et
`BOB_JARVIS_DISPATCH_ENABLED` sont **OFF quand absents** et ne s'ouvrent que par la valeur
littérale `true`. L'unique policy de publication reçoit l'entrée catalogue exacte et porte
elle-même la loi de cycle de vie, le contexte tenant/principal et la cohorte ; le catalogue ou
l'allowlist technique ne publient jamais seuls. Le manifest runtime reste vide dans ce lot. La
future policy canonique devra rendre une décision structurée (`implemented_staging |
certified_production_canary | released`) avant toute activation. Les intégrations avant publication utilisent une policy
permissive définie dans un fichier `.testing.ts` exclu de l'artefact runtime ; elles ne
certifient ni staging, ni production, ni canary.

**Action autoritaire, une seule fois** : pour une nouvelle commande, l'admission charge le run
`FOR UPDATE` puis demande à sa définition versionnée de dériver `actionId@version` depuis le seed
canonique ou le state persistant. La paire du wire reste uniquement une assertion et une composante
du fingerprint v1 ; toute divergence rend `action_binding_mismatch`, zéro write. Le reçu exact est
recherché avant ce binding et reste donc rejouable après fermeture. `cancel_run` exige le binding
du run mais ne consulte ni kill switch ni policy ; une policy indisponible ne peut pas bloquer le
drain. Les contrôleurs, l'API client, le coordinateur tactile et l'orchestrateur vocal ne filtrent
jamais replay/cancel sur `U1_CANDIDATE_ACTIONS` : ils valident ou pincent seulement la forme, puis
l'unique admission tranche. La candidate technique ne subsiste que pour l'offre provisoire de
capacité — explicitement non autoritative tant que la vue serveur de publication manque (§3).

**Cutover froid obligatoire** : N-1 bloque `cancel_run`/replay quand l'admission est à `false`,
reprend encore certains items `authorized` même si le dispatch est à `false` et, surtout,
transforme encore un `outcome_unknown` en faux échec terminal. Il n'a donc pas le droit de servir
de worker de drain : « le laisser finir » détruirait précisément la vérité que ce lot restaure.
La bascule assume une indisponibilité Jarvis bornée et suit cet ordre exact : (1) fermer l'ingress
Jarvis en amont de l'ancienne flotte et inventorier les runs/work items ; (2) arrêter tous les
processus N-1 capables d'admettre ou de dispatcher, puis attester qu'aucun ne sert encore ;
(3) lire l'état autoritaire. S'il existe un item exécutable, autorisé, incertain, non signalé ou
une forme terminale contradictoire, la release est **NO-GO** : réconciliation opérateur ou bridge
de compatibilité purpose-specific séparé, jamais reprise par N-1 ; (4) poser les deux masters à
`false` ; (5) le predeploy N exige simultanément zéro item dangereux, zéro résultat non signalé,
zéro annulation historique bloquée, zéro forme terminale contradictoire et aucune mutation pendant
une lease ; (6) déployer entièrement N fermé, puis vérifier le SHA servi et l'absence de tout
replica N-1 ; (7) seulement alors, utiliser N pour annuler les runs non terminaux sans work item.
Dans N, `cancel_run` reste admis sous switch fermé après authentification et CAS, parce que la
postcondition centrale exige zéro intent ; un reçu déjà commité reste rejouable zéro-write. Aucune
valeur `true` n'est autorisée dans ce train et ce correctif n'est pas présenté comme transparent.

**[BLOQUÉ OPÉRATEUR : attestation du prédécesseur N-1 fermé]**. Le processus `railway run`
voit la configuration courante, pas l'environnement déjà chargé par un replica N-1. Le snapshot
SQL ci-dessus est donc nécessaire mais insuffisant pour le tout premier train : avant tout
déploiement du nouveau binaire, l'ingress doit être fermé et la flotte N-1 arrêtée ; ses workers ne
constituent pas un drain sûr. L'opérateur atteste ensuite zéro replica ancien et le SHA réellement
servi. Tant qu'une sonde de readiness exacte ou un reçu plateforme
vérifiable n'est pas livré, cette attestation reste humaine et le rollout est **NO-GO avant tout
déploiement** — et avant merge lorsque `main` auto-déploie — ; le script
ne prétend pas l'inférer des seules variables du job.

## 2. La continuité voix↔écran (§14) — un run écran doit être joignable

L'unique émetteur de `stage_proposal` est l'orchestrateur vocal, et il ne balaie que ses 4
graines dérivées de session : un run semé par `POST /jarvis/runs` lui est invisible. Le bouton
de l'item 3, livré seul, fabriquerait des runs parqués en `preparing_proposal` qui confisquent
le premier plan (foreground unique par owner).

Décision : `prepare()` vocal découvre D'ABORD le run `customer_contact` non terminal de l'owner
— tous semeurs confondus — puis retombe sur ses graines pour un semis neuf. La vue stateless
réutilise son port réel `currentRun()`, adossé à la lecture courante couverte par les tests
PostgreSQL. Deux tours
concurrents restent déterministes : le run
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
- gating `!customerFresh` comme les autres gestes d'écriture. **État réel de ce lot** : avec le
  manifest runtime vide et sans vue serveur de publication, le CTA est masqué et l'orchestrateur
  n'offre pas `customer_contact.run.open` au modèle. Les transports de replay/cancel restent
  joignables pour un run existant. Avant toute publication, une vue serveur dérivée de la même
  autorité doit piloter le bouton et les capacités du modèle ; aucune allowlist technique ne peut
  les rouvrir.

**[BLOQUÉ FONDATEUR : confirmer les rôles/entitlements exacts de `client-modifier@1`]**. En
attendant, le manifest runtime reste vide : aucune absence d'entitlement ne peut être interprétée
comme une autorisation implicite. La preuve du principal, le cycle de vie catalogue, le release
manifest/cohorte et le kill switch restent obligatoires. La session vocale conserve séparément son
entitlement de transport ; aucun `ai_assistant` n'est inventé ici.

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

- **Résolution create** : U1-g a livré l'émetteur `no_duplicates|duplicate_candidates`, mais la
  publication reste fermée ; cette présence ne vaut ni activation ni preuve de la chaîne complète.
- **Émetteur `record_target_mutation`** depuis UpdateCustomer : §9.1 couvre déjà la sûreté au
  confirm ; l'éveil temps-réel est un chantier propre (commandId v8 + preuve tx).
- **Canal écran pour email/phone/vatNumber** (exclus de la voix par redaction PII) : exige un
  canal non-LLM neuf, le tap est fermé par doctrine.
- **Handoff voix→écran** (invalidation `['jarvis-run','current']` post-tour Live) : exigence de
  continuité à livrer avant ouverture, pas un confort ; mount/focus ne couvre pas un écran déjà
  monté dont le cache courant est vide.
- **Drapeaux dormants** `RUN_STALE_RECOVERY_PROBES`/`SEED_EPHEMERAL_ACTIVATION_EVIDENCE`
  (hors Jarvis) : preuves qui ne tournent nulle part — à traiter dans un lot santé-dépôt.

## 8. Preuves exigées

Une issue `outcome_unknown` n'est jamais rabattue sur `failed_terminal` : elle ne produit aucun
reçu de run, aucun événement terminal et aucun `signalAppliedAt`. Elle reste visible au drain et
bloque toute release jusqu'à une réconciliation purpose-specific. Seuls `succeeded`,
`failed_terminal` et `cancelled` sont signalables ; les unknown sont exclus de la page bornée afin
de ne pas affamer les vrais reçus. La policy d'annuaire ET l'index partiel tenanté portent le
même prédicat fermé ; une preuve PostgreSQL place plus d'une page d'unknown avant un vrai signal et
exige que seul le signal soit rendu. Un nouvel item sans exécuteur est annulé no-effect avant
`authorize`, tandis qu'une reprise déjà autorisée sans arbitre reste indécidable.

Une annulation ne transforme en no-effect que `prepared|leased|retry_due` avec
`authorizedAt IS NULL`, `authorizationDigest IS NULL`, `resultDigest IS NULL` et
`signalAppliedAt IS NULL`. Toute forme N-1 contradictoire reste intacte, visible au drain et bloque
la release : un statut seul ne constitue jamais une preuve d'absence d'autorisation.

Intégration PostgreSQL test-only : la chaîne technique bout en bout par les routes et le worker
RÉELS, sous policy test-only explicite. Le contrat runtime reste fermé par défaut ; le processus de
test ouvre explicitement le seul master dispatch le temps d'exercer le worker —
ouverture écran → proposition (port) → ack → confirm → work item claim → effet exécuté par
l'adapter runtime réel exercé sous harnais test-only → fiche relue mutée → run `completed` ; l'annuaire de dispatch prouvé
sous la RLS réelle ; le libellé et le `before` prouvés depuis le GET. Cette intégration ne promeut
aucun statut. Mobile : le bouton
(mémoïsation du commandId au remontage, 409 présenté), la carte avec libellé et avant. É1
locale (`expo run:ios` simulateur) si le temps le permet — jamais de build EAS sans GO.

Cette intégration ne prouve pas encore la sûreté de publication : l'update client reste dépourvu
de CAS `expectedRevision` au point d'écriture, et l'autorité Jarvis n'absorbe pas encore toutes les
barrières société fermée/archives du chemin manuel. Ces deux points sont des bloqueurs explicites
avant tout manifest positif.
