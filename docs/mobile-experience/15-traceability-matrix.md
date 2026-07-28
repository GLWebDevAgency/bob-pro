# Matrice de traçabilité exhaustive

Statut : **Proposed**
Couverture : **77 exigences uniques sur 77**
Propriétaires pressentis : Product Design, Mobile, QA, Accessibilité, Produit
Dernière mise à jour : 2026-07-23

## 1. Contrat de traçabilité

Cette matrice est la mémoire anti-oubli de l'audit. Le parcours attendu pour chaque exigence est :

`constat → spécification → décision éventuelle → work package → test → preuve → verdict`.

Les identifiants sont immuables :

- `G01–G22` : exigences globales de design, interaction et adaptation ;
- `V01–V14` : Bob Live, conversation et voix ;
- `S01–S33` : surfaces d'expérience ;
- `T01–T08` : content design et vérité des statuts.

Toutes les lignes sont `Proposed` à la création du dossier. Le statut opérationnel, l'owner nommé,
le build, l'URI de preuve, le verdict, les reviewers et le waiver sont tenus dans le
[registre de preuves](./18-evidence-register.md). Le statut ne passe à `Verified` que lorsque le
manifest normatif `docs/mobile-experience/evidence/<release>/<ID>/manifest.md` existe et que la
[Definition of Done](./12-definition-of-done.md) est satisfaite, sans transcript, audio, PII ou
donnée métier sensible.

## 2. Exigences globales — 22/22

| ID | Exigence précise | Epic / WP | Autorité principale | Test ou preuve binaire attendu |
|---|---|---|---|---|
| G01 | Barre d'état adaptative et toujours lisible. | E01 · WP-0102, WP-0304 | [Navigation](./04-navigation-scroll-surfaces.md) | Captures de toutes les familles de fonds et vidéo clair↔marine : icônes système correctes, aucun flash illisible. |
| G02 | Contrat complet d'apparence claire/sombre. | E01 · WP-0101 | [Accessibilité](./08-accessibility-adaptive-design.md) | ADR accepte le thème sémantique complet ; force-light est seulement transitoire ; matrice de toutes les routes avant `Verified`. |
| G03 | Typographie adaptative et Dynamic Type jusqu'à environ 200 %. | E01 · WP-0103, WP-0105 | [Accessibilité](./08-accessibility-adaptive-design.md) | Appareils en standard, XL et taille d'accessibilité : aucun CTA essentiel tronqué, collision ou contenu inaccessible. |
| G04 | Grammaire motion sémantique unique. | E02 · WP-0201, WP-0202 | [Motion](./03-motion-interaction-system.md) | Catalogue de tokens validé, contrôle statique contre les durées arbitraires et vidéos entrée/sortie/interruption/redirection. |
| G05 | Feedback de pression cohérent pour boutons et surfaces interactives. | E02 · WP-0203 | [Motion](./03-motion-interaction-system.md) | Tests `rest/pressed/disabled/loading/selected` et vidéo appareil : compression discrète, cible stable, aucun double déclenchement. |
| G06 | Grammaire haptique sémantique et parcimonieuse. | E02 · WP-0204 | [Motion](./03-motion-interaction-system.md) | Matrice événement→haptique approuvée ; recette iOS/Android sans vibration continue, doublée ou obligatoire au sens. |
| G07 | Sheets interactives, à detents et pilotées par le geste. | E03 · WP-0305 | [Navigation](./04-navigation-scroll-surfaces.md) | E2E drag/velocity/detent/fermeture, clavier et lecteur d'écran ; suivi 1:1 et retour de focus prouvés. |
| G08 | Transitions d'insertion, suppression, tri et changement d'état. | E02 · WP-0206 | [Motion](./03-motion-interaction-system.md) | Tests ajout/retrait/réorganisation/interruption avec identité, focus et offset conservés. |
| G09 | États asynchrones explicites et feedback succès/erreur fiable. | E02 · WP-0205, WP-0405 | [Motion](./03-motion-interaction-system.md) | Machine `idle→pending→ACK/relecture→success/error/unknown`, incluant perte réseau et double tap ; aucun faux succès. |
| G10 | Architecture de navigation native et continuité spatiale. | E03 · WP-0301, WP-0302, WP-0308 | [Navigation](./04-navigation-scroll-surfaces.md) | E2E push/modal/sheet/deep link/retour gestuel et vidéos liste→détail/fallback OS, sans route perdue. |
| G11 | Barre d'onglets expressive, native ou équivalente. | E03 · WP-0303, WP-0308 | [Navigation](./04-navigation-scroll-surfaces.md) | ADR accepté puis E2E sélection, retap scroll-top, badge, clavier, safe area et restauration par onglet. |
| G12 | Headers contractiles et chrome synchronisé au scroll. | E03 · WP-0304 | [Navigation](./04-navigation-scroll-surfaces.md) | Scroll lent/rapide/interrompu : grand titre→compact, sticky correct, aucun saut et barre système synchronisée. |
| G13 | Filtres et contrôles segmentés avec continuité visuelle. | E04 · WP-0207, WP-0403 | [Motion](./03-motion-interaction-system.md) | Sélection, capsule/fade-through, compteurs et résultat synchronisés, avec changements rapides, clavier et lecteur d'écran. |
| G14 | Cartes et listes animées sans perte de contexte. | E04 · WP-0206, WP-0402 | [Motion](./03-motion-interaction-system.md) | Longue liste avec ajout/retrait/tri, clés stables, offset conservé et conformité chiffrée aux seuils `PERF-CALIBRATION`. |
| G15 | Transitions exactes des nombres et graphiques. | E04 · WP-0208, WP-0404 | [Motion](./03-motion-interaction-system.md) | Valeur finale exacte, signes/unités stables, parité graphe-table et aucune animation sans changement réel. |
| G16 | Recherche centrée sur le focus, le clavier et les résultats. | E03 · WP-0306 | [Navigation](./04-navigation-scroll-surfaces.md) | E2E focus/annulation/debounce/requête obsolète/récents/vide/erreur, avec clavier et scroll restaurés. |
| G17 | Réduction de densité par progressive disclosure. | E04 · WP-0401 | [Écrans](./06-screen-by-screen-spec.md) | Revue avant/après `conclusion→raison→action`, toutes preuves métier, légales et techniques restant accessibles. |
| G18 | Consolidation des primitives UI en une source cohérente. | E02 · WP-0209 | [Architecture](./09-technical-architecture.md) | Inventaire de migration, contrôle statique des imports dépréciés, aucun nouveau doublon Button/Row/Field/Sheet/Toast. |
| G19 | Adaptation iPad, grandes fenêtres et split view. | E01 · WP-0106, WP-0406 | [Accessibilité](./08-accessibility-adaptive-design.md) | iPad portrait/paysage/split-screen : largeur plafonnée, grille/master-detail, aucune colonne téléphone simplement étirée. |
| G20 | Matières blur/verre réservées à la couche fonctionnelle. | E03 · WP-0307 | [Navigation](./04-navigation-scroll-surfaces.md) | Fonds extrêmes, Reduce Transparency, contraste, trace GPU et fallback opaque fonctionnel. |
| G21 | Runtime motion et budgets de performance mesurés en release. | E02 · WP-0201, WP-0210 | [Performance](./10-performance-observability.md) | Traces avant/après sur appareils cibles 60/120 Hz selon capacité, sans régression frame, mémoire, démarrage, audio ou batterie. |
| G22 | Reduced Motion sans perte d'information. | E01 · WP-0104, WP-0210 | [Accessibilité](./08-accessibility-adaptive-design.md) | Préférence changée sur appareil : aucune boucle/zoom/parallaxe/blur animé ; mêmes statuts, contenus et actions. |

## 3. Bob Live et expérience vocale — 14/14

| ID | Exigence précise | Epic / WP | Autorité principale | Test ou preuve binaire attendu |
|---|---|---|---|---|
| V01 | Signature visuelle Bob propriétaire et continue. | E05 · WP-0502 | [Bob Live](./05-bob-live-experience.md) | Prototype appareil des formes trigger/capsule/carte et morph, normal/réduit, sans imitation d'un assistant tiers. |
| V02 | États connexion, autorisation et disponibilité véridiques. | E05 · WP-0501 | [Bob Live](./05-bob-live-experience.md) | Projection de chaque événement vers `authorizing/connecting/ready/reconnecting/error`, jamais vers une fausse réflexion. |
| V03 | Écoute réactive à l'amplitude audio réelle. | E05 · WP-0503 | [Bob Live](./05-bob-live-experience.md) | Fixture audio déterministe : attack/release, absence de jitter, source réelle ; aucune persistance d'audio brut/amplitude fine. |
| V04 | Traitement calme et honnête du silence. | E05 · WP-0501 | [Bob Live](./05-bob-live-experience.md) | Plusieurs silences : atténuation sans faux commit, compte à rebours ou changement d'état inventé. |
| V05 | Réflexion et exécution d'outil reliées aux phases réelles. | E05 · WP-0501 | [Bob Live](./05-bob-live-experience.md) | Matrice runtime→libellé/visuel ; aucune phase cyclique décorative sans outil réel. |
| V06 | Parole de Bob distincte de l'écoute et reliée au playback. | E05 · WP-0503 | [Bob Live](./05-bob-live-experience.md) | Démarrage/pause/fin du player : signal de sortie distinct et arrêt du mouvement au silence effectif. |
| V07 | Barge-in immédiatement perceptible et sans régression audio. | E05 · WP-0504 | [Bob Live](./05-bob-live-experience.md) | Feedback visuel p95 <100 ms et Voice Trace avant/après conforme au SLO d'interruption audio. |
| V08 | Erreur et reconnexion visibles, explicites et réparables. | E05 · WP-0501 | [Bob Live](./05-bob-live-experience.md) | E2E permission refusée, perte réseau, retry, erreur terminale et repli texte ; aucune erreur silencieusement ramenée à idle. |
| V09 | Fin de session avec repli et conservation du résultat. | E05 · WP-0505 | [Bob Live](./05-bob-live-experience.md) | Fermeture confirmée : repli vers trigger, retour focus et dernière réponse conservée dans Assistant. |
| V10 | Overlay Bob global unique, contextuel et non obstructif. | E05 · WP-0505 | [Bob Live](./05-bob-live-experience.md) | Multi-écrans/clavier/safe areas : une seule instance, mission conservée, aucun CTA critique recouvert. |
| V11 | Auto-scroll conversationnel respectueux de la lecture. | E05 · WP-0506 | [Bob Live](./05-bob-live-experience.md) | E2E utilisateur en bas vs relisant plus haut : auto-scroll seulement en bas et bouton nouveaux messages sinon. |
| V12 | Streaming de réponse par blocs ou phrases, jamais caractère par caractère. | E05 · WP-0506 | [Bob Live](./05-bob-live-experience.md) | Deltas rapides : batching, rendus bornés, texte sélectionnable, aucun effet machine à écrire. |
| V13 | Cartes d'actions agentiques reflétant le cycle réel. | E05 · WP-0507 | [Bob Live](./05-bob-live-experience.md) | `proposé→confirmation→pending→ACK/relecture→fait/échec/unknown`, avec retry, idempotence et perte réseau. |
| V14 | Expérience vocale accessible et équivalente sans mouvement. | E05 · WP-0508 | [Bob Live](./05-bob-live-experience.md) | VoiceOver/TalkBack, captions, grandes polices et Reduce Motion ; états sans dépendre de couleur, son ou spatialité. |

## 4. Surfaces d'expérience — 33/33

`S01–S33` comptent des surfaces et non exactement 33 routes physiques : S33 agrège connexion/inscription dans `LoginScreen`, tandis que S30/S31 sont des routes dédiées et S32 une route historique.

| ID | Exigence précise | Epic / WP | Autorité principale | Test ou preuve binaire attendu |
|---|---|---|---|---|
| S01 | Aujourd'hui : accueil vivant, hiérarchisé et causal. | E06 · WP-0009, WP-0601 | [Écran S01](./06-screen-by-screen-spec.md#s01) | E2E chargement, mise à jour du disponible et validation d'une priorité ; header contractile et réorganisation sans faux succès. |
| S02 | Clients : recherche, filtres et continuité vers la fiche. | E07 · WP-0701 | [Écran S02](./06-screen-by-screen-spec.md#s02) | E2E filtre, recherche, ajout, ouverture ; position et identité avatar/nom conservées au retour. |
| S03 | Argent : décision financière prioritaire et scénarios lisibles. | E08 · WP-0801 | [Écran S03](./06-screen-by-screen-spec.md#s03) | Période/hypothèse : valeurs exactes, parité accessible et aucune animation monétaire trompeuse. |
| S04 | Documents : validation et classement spatialement compréhensibles. | E09 · WP-0009, WP-0901 | [Écran S04](./06-screen-by-screen-spec.md#s04) | Document à valider→confirmation backend→dossier ; déplacement visuel seulement après autorité. |
| S05 | Assistant : conversation vivante, agentique et véridique. | E05 · WP-0509-01, WP-0009 | [Bob Live](./05-bob-live-experience.md) · [S05](./06-screen-by-screen-spec.md#s05) | E2E texte, voix, outil, confirmation, erreur/reprise ; auto-scroll, cartes et composer conformes V01–V14. |
| S06 | Recherche : focus immédiat et résultats sans rupture. | E06 · WP-0602 | [Écran S06](./06-screen-by-screen-spec.md#s06) | Récente/nouvelle/annulée/échouée ; requêtes obsolètes ignorées et correspondances visibles. |
| S07 | Notifications : regroupement actionnable et lecture synchronisée. | E06 · WP-0603 | [Écran S07](./06-screen-by-screen-spec.md#s07) | Marquer lu, action, undo et perte réseau ; badge/groupes cohérents serveur. |
| S08 | Fiche client : identité continue et action contextuelle dominante. | E07 · WP-0702 | [Écran S08](./06-screen-by-screen-spec.md#s08) | Depuis S02 : scroll contractile, action adaptée au statut, retour à la même ligne. |
| S09 | Chantiers : cartes identifiables, progression et création tactile. | E07 · WP-0703 | [Écran S09](./06-screen-by-screen-spec.md#s09) | Création par sheet, progression, ouverture détail, vide/offline et chargement média. |
| S10 | Détail chantier : galerie, timeline et note vocale intégrées. | E07 · WP-0704 | [Écran S10](./06-screen-by-screen-spec.md#s10) | Galerie, sous-navigation, ajout et note vocale réelle ; profil mémoire et scroll conservé. |
| S11 | Ventes : navigation par cycle de vie des pièces. | E10 · WP-1001 | [Écran S11](./06-screen-by-screen-spec.md#s11) | Filtre, statut et ouverture devis/facture ; statut toujours issu du backend. |
| S12 | Nouveau devis : construction d'un document vivant et brouillon robuste. | E10 · WP-1002 | [Écran S12](./06-screen-by-screen-spec.md#s12) | Lignes/recalcul/background/reprise/erreur ; récupération brouillon et totaux métier inchangés. |
| S13 | Détail devis : document hero, timeline et action selon statut. | E10 · WP-1003 | [Écran S13](./06-screen-by-screen-spec.md#s13) | Chaque statut significatif : CTA autorisé, historique, export/partage et retour cohérent. |
| S14 | Nouvelle facture : création continue, exacte et idempotente. | E10 · WP-1004 | [Écran S14](./06-screen-by-screen-spec.md#s14) | Lignes/taxes/total, double tap, timeout/reprise ; une seule facture et valeurs exactes. |
| S15 | Détail facture : lecture immédiate du statut et prochaine action. | E10 · WP-1004 | [Écran S15](./06-screen-by-screen-spec.md#s15) | Émission/transmission/paiement ; timeline et CTA exclusivement autoritatifs. |
| S16 | Transmission de facture : progression réelle et envoi non dupliqué. | E10 · WP-1004 | [Écran S16](./06-screen-by-screen-spec.md#s16) | Envoi, timeout inconnu, vérification, retry, succès ; aucune transmission double ou confirmation précoce. |
| S17 | Catalogue : recherche et CRUD tactile avec récupération. | E10 · WP-1005 | [Écran S17](./06-screen-by-screen-spec.md#s17) | Recherche/catégorie/CRUD/undo, prix exact et stabilité de la liste. |
| S18 | Dépenses : reçu, paiement et état temporel explicites. | E08 · WP-0802 | [Écran S18](./06-screen-by-screen-spec.md#s18) | Création/consultation/paiement/échec/retry ; statut, preuve et montant cohérents, double soumission impossible. |
| S19 | Comptabilité : équilibre expliqué et détails progressivement révélés. | E08 · WP-0803 | [Écran S19](./06-screen-by-screen-spec.md#s19) | Fixtures équilibrée/déséquilibrée : calcul exact, explication, journal accessible et export identique. |
| S20 | Clôture : parcours guidé par les blocages réels. | E08 · WP-0804 | [Écran S20](./06-screen-by-screen-spec.md#s20) | Dossier bloqué puis résolu : progression, sections accessibles, export réellement permis. |
| S21 | Pilotage : graphiques explorables et équivalents aux données. | E08 · WP-0805 | [Écran S21](./06-screen-by-screen-spec.md#s21) | Période, scrub/tooltip et tableau accessible ; égalité source/graphe/valeur annoncée. |
| S22 | Dossier documentaire : entrée spatiale et mutations récupérables. | E09 · WP-0902 | [Écran S22](./06-screen-by-screen-spec.md#s22) | Depuis S04 : ajout, suppression/undo, retour ; dossier, offset et identité conservés. |
| S23 | Détail document : document prioritaire, zoom et actions contextuelles. | E09 · WP-0903 | [Écran S23](./06-screen-by-screen-spec.md#s23) | Zoom/fallback OS, déplacement, partage/retour et profil mémoire PDF/image. |
| S24 | Scan : capture caméra-first et progression OCR véridique. | E09 · WP-0904 | [Écran S24](./06-screen-by-screen-spec.md#s24) | Permission/détection/capture/OCR/correction/timeout/offline/création ; aucune phase sans événement pipeline. |
| S25 | Diagnostic : questions directionnelles et révélation fiable du score. | E11 · WP-1101 | [Écran S25](./06-screen-by-screen-spec.md#s25) | Réponse/retour/reprise/résultat ; score après calcul réel et recommandations ordonnées. |
| S26 | Onboarding : personnalisation progressive et persistante. | E11 · WP-1102 | [Écran S26](./06-screen-by-screen-spec.md#s26) | Abandon/reprise/fin ; choix persistés et accueil réellement dérivé des réponses si le domaine le prévoit. |
| S27 | Compte : réglages calmes, abonnement visible et danger isolé. | E11 · WP-1103 | [Écran S27](./06-screen-by-screen-spec.md#s27) | Profil/abonnement/action destructive, confirmation/focus et impossibilité de destruction accidentelle. |
| S28 | Réglages facturation : aperçu fidèle et sauvegarde autoritaire. | E11 · WP-1103 | [Écran S28](./06-screen-by-screen-spec.md#s28) | Dirty state, aperçu, sauvegarde/erreur/retry et comparaison au document final généré. |
| S29 | Profil fiscal : décisions guidées et conséquences explicites. | E11 · WP-1103 | [Écran S29](./06-screen-by-screen-spec.md#s29) | Scénarios validés métier, reprise, résumé final, mentions conservées et aucune conclusion juridique inventée. |
| S30 | Callback e-mail : retour idempotent et sans écran technique. | E11 · WP-1104 | [Écran S30](./06-screen-by-screen-spec.md#s30) | Deep link valide/expiré/déjà utilisé, double ouverture et froid, sans flash blanc ni double traitement. |
| S31 | Récupération : parcours sûr, explicite et entièrement terminé. | E11 · WP-1104 | [Écran S31](./06-screen-by-screen-spec.md#s31) | Compte existant/inconnu, token valide/expiré, validation/succès ; aucune fuite d'existence. |
| S32 | Route voix historique : redirection transparente et contextuelle. | E05 · WP-0509-02 | [Bob Live](./05-bob-live-experience.md) · [S32](./06-screen-by-screen-spec.md#s32) | Ancien deep link chaud/froid : aucun flash, boucle ou perte de contexte, fallback Assistant. |
| S33 | Connexion/inscription : authentification fluide et fiable. | E11 · WP-1104 | [Écran S33](./06-screen-by-screen-spec.md#s33) | Clavier/autofill/SIRET/e-mail/erreurs/background ; attente réelle, données préservées et statut non simulé. |

## 5. Content design — 8/8

| ID | Exigence précise | Epic / WP | Autorité principale | Test ou preuve binaire attendu |
|---|---|---|---|---|
| T01 | Vérité et séparation des statuts. | E12 · WP-1201 | [Content design](./07-content-design.md) | Table source→clé→libellé et snapshots interdisant connexion=réflexion ou réseau disponible=voix disponible. |
| T02 | Ton sobre pour les actions financières et sensibles. | E12 · WP-1202 | [Content design](./07-content-design.md) | Revue Finance/Juridique des confirmations critiques dans les trois personnalités, avec montant/date/objet/conséquence. |
| T03 | Abstraction du jargon technique au premier niveau. | E12 · WP-1203 | [Content design](./07-content-design.md) | Formulation métier primaire, détails support accessibles, aucun secret/PII dans le niveau technique. |
| T04 | Hiérarchie éditoriale action-first. | E12 · WP-1203 | [Content design](./07-content-design.md) | Chaque carte prioritaire suit `conclusion→justification→action`, CTA nommé par son résultat, test de compréhension. |
| T05 | Pérennité temporelle des textes. | E12 · WP-1204 | [Content design](./07-content-design.md) | Test 31 décembre/1er janvier, Europe/Paris et recherche de millésimes/délais figés non autorisés. |
| T06 | Erreurs compréhensibles, réparables et non culpabilisantes. | E12 · WP-1204 | [Content design](./07-content-design.md) | Catalogue E2E : cause sûre, impact, donnée préservée et action ; auth sans révélation de compte. |
| T07 | Personnalités Bob sans variation du sens métier. | E12 · WP-1202 | [Content design](./07-content-design.md) | Snapshots Pote/Pro/Direct : montants, temporalité, conséquence et confirmation invariants. |
| T08 | Succès fondé sur l'autorité backend. | E12 · WP-1201 | [Content design](./07-content-design.md) | Contrats pending/ACK/relecture/success/unknown/error, timeout/idempotence ; aucun check/toast au seul tap. |

## 6. Recouvrements intentionnels

| IDs | Pourquoi ce n'est pas un doublon | Autorité retenue |
|---|---|---|
| G01 | Chrome/navigation et lisibilité/accessibilité se croisent. | Principal `04`, secondaire `08`. |
| G19 | Adaptation de navigation et accessibilité tablette se croisent. | Principal `08`, secondaire `04`. |
| G21 | Runtime motion, architecture et mesure se croisent. | Principal `10`, secondaires `03` et `09`. |
| G22 | Motion, accessibilité et performance se croisent. | Principal `08`, secondaires `03` et `10`. |
| V03, V07, V10–V14 | Bob possède ses propres contrats, mais leurs budgets vivent dans la performance. | Principal `05`, secondaire `10`. |
| V14 | Équivalence vocale spécifique au sein de l'accessibilité globale. | Principal `05`, secondaire `08`. |
| T01, T06, T08 | Règles globales de contenu projetées dans Bob Live. | Principal `07`, secondaire `05`. |
| G09 / T08 | G09 décrit la machine d'interaction ; T08 autorise ou interdit le mot « succès ». | Deux exigences conservées. |
| G22 / V14 | G22 couvre toute l'app ; V14 couvre voix, captions et états Bob. | Deux exigences conservées. |
| V02 / T01 | V02 projette le runtime voix ; T01 régit tous les libellés. | Deux exigences conservées. |
| G10 / G12 | G10 décrit la relation entre routes ; G12 le chrome dans une route. | Deux exigences conservées. |
| S05 / S32 | Deux surfaces, une autorité Bob commune. | Principal `05`, rappel dans `06`. |
| S01 / S04 | Leur rôle de pilote de roadmap n'ajoute pas une exigence. | Un seul ID chacun. |

## 7. Décisions ouvertes qui bloquent l'implémentation

Le [registre opérable des décisions](./adr/README.md) est l'autorité unique pour statut, owner,
date cible et WP bloqués. La table ci-dessous donne seulement la lecture par exigence.

| Sujet | IDs | Décision exigée |
|---|---|---|
| Runtime motion | G04, G08, G13–G15, G21 | Accepter UX-ADR-001 sur spike non publié avant les primitives produit. |
| Navigation/sheets | G07, G10–G12, G16 | Accepter UX-ADR-002 puis fermer le choix tabs D07. |
| Projection Bob | V01–V14, S05, S32 | Accepter UX-ADR-003 et le contrat d'événements D09. |
| Apparence | G02 | Accepter la cible finale thème sémantique complet ; force-light reste transitoire dans UX-ADR-004. |
| Observabilité | G21 | Accepter UX-ADR-005 et l'artefact de calibration D12. |
| Haptique | G06 | Accepter UX-ADR-006 et sa certification acoustique. |
| Tab bar | G11 | Comparer custom et Native Tabs dans le runtime réel puis accepter une solution. |
| Verre/blur | G20 | Rester progressif ; jamais une dépendance fonctionnelle ; fallback opaque obligatoire. |
| Taux de rafraîchissement | G21 | Mesurer la cible réellement supportée ; 60/120 Hz ne sont pas deux promesses universelles. |
| Amplitude audio | V03, V06 | Si entrée/sortie native manque, documenter un fallback borné qui ne prétend pas être audio-réactif. |
| Outils voix | V05 | N'afficher une phase outil que si un événement runtime fiable existe. |
| Surfaces auth | S30, S31, S33 | Conserver la distinction entre routes explicites et expérience agrégée LoginScreen. |
| Route voix historique | S32 | Décider maintien, façade ou dépréciation avant toute suppression. |

## 8. Contrôles de couverture

| Famille | Attendu | Présent | Verdict |
|---|---:|---:|---|
| Global `G` | 22 | 22 | Complet |
| Voix `V` | 14 | 14 | Complet |
| Surfaces `S` | 33 | 33 | Complet |
| Textes `T` | 8 | 8 | Complet |
| **Total** | **77** | **77** | **Complet** |

Un contrôle automatisé de documentation doit échouer si un ID manque, apparaît deux fois dans les tables d'autorité, ne référence aucun `WP`, ou n'a plus de preuve binaire.
