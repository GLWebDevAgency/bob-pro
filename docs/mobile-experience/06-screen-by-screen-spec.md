# Spécification écran par écran

Statut : **Proposed**
Périmètre observé : application mobile au commit `2515ddf3`
Propriétaires pressentis : Product Design, Mobile, Produit, Accessibilité, QA
Dernière mise à jour : 2026-07-23

## 1. Objet

Ce document transforme l'audit visuel et motion en une cible vérifiable pour chaque écran. Il décrit l'ordre de lecture, la composition, les transitions, les états, le contenu, l'accessibilité et les preuves attendues. Il ne modifie ni les cas d'usage, ni les règles comptables, ni les confirmations sensibles, ni les contrats backend.

Les identifiants `S01` à `S33` sont stables. Une exigence peut être affinée, mais elle ne doit pas être supprimée sans décision documentée et mise à jour de la [matrice de traçabilité](./15-traceability-matrix.md).

## 2. Contrat commun à tous les écrans

Chaque écran doit respecter les documents transverses suivants :

- hiérarchie et personnalité : [vision d'expérience](./01-experience-vision.md) ;
- durées, ressorts, retours tactiles et mouvement réduit : [système de motion](./03-motion-interaction-system.md) ;
- routes, scroll, surfaces et barres système : [navigation](./04-navigation-scroll-surfaces.md) ;
- états de Bob : [Bob Live](./05-bob-live-experience.md) ;
- textes et statuts : [content design](./07-content-design.md) ;
- taille de texte, contraste, focus et préférences système : [accessibilité](./08-accessibility-adaptive-design.md) ;
- budgets de fluidité et confidentialité : [performance](./10-performance-observability.md).

### 2.1 Gabarit visuel commun

1. La barre système et le header doivent former une seule composition, sans rupture de couleur ou de matériau.
2. Le premier écran visible doit répondre immédiatement à trois questions : « Où suis-je ? », « Qu'est-ce qui compte maintenant ? », « Quelle est l'action principale ? ».
3. Une seule action primaire est dominante par viewport. Les actions secondaires restent disponibles sans lui faire concurrence.
4. Les montants utilisent des chiffres tabulaires, une unité explicite et une couleur qui ne porte jamais seule le sens.
5. Les listes longues commencent par leur contexte, puis les outils de recherche/filtre, puis les résultats. Les contrôles collants ne doivent pas masquer le dernier élément.
6. Le bouton Bob global ne recouvre ni un CTA, ni une barre d'onglets, ni le clavier. Il n'existe qu'une seule instance visible.
7. Chargement, vide, erreur, hors-ligne, données périmées, succès et accès interdit sont des états conçus, pas des variantes improvisées.
8. Les animations d'entrée expliquent la structure ; elles ne rejouent pas lors d'un simple retour arrière, d'un rafraîchissement ou d'une mise à jour de donnée.

### 2.2 Preuves communes

Pour déclarer un écran terminé, fournir au minimum :

- captures iOS et Android en petit téléphone, téléphone de référence et grand téléphone ;
- captures texte standard et taille d'accessibilité maximale supportée ;
- mode mouvement réduit, lecteur d'écran, clavier ouvert et hors-ligne ;
- vidéo 60 fps de l'entrée, du scroll, de l'action principale, du retour et d'une erreur ;
- test de non-régression du cas d'usage et preuve qu'aucun succès n'est affiché avant autorité backend ;
- mesure de fluidité selon les scénarios `PERF` applicables.

## 3. Navigation principale et découverte

<a id="s01"></a>

### S01 — Aujourd'hui

**Route :** `/(tabs)/index` · **Epic :** E06 · **Priorité :** P1 après autorisation de la tranche ; P0 uniquement si un défaut de vérité/lisibilité est isolé

**Mission.** Donner en moins de cinq secondes la situation de l'entreprise et la prochaine action utile, sans transformer l'accueil en tableau de bord anxiogène.

**Composition cible.** Header compact avec salutation utile et accès notifications ; carte « À faire maintenant » limitée aux urgences réelles ; résumé financier à deux ou trois indicateurs maximum ; activité récente ; raccourcis contextuels. Les informations secondaires passent sous la ligne de flottaison. Les cartes ne doivent pas toutes avoir la même emphase : une carte héro, des surfaces simples, puis des lignes.

**Motion.** Au premier affichage seulement, le titre apparaît avec un léger fondu/décalage, suivi de la carte prioritaire puis des modules en cascade courte. Un nombre mis à jour fait une transition directionnelle discrète ; un refresh ne rejoue pas l'entrée complète. Le header se compacte au scroll et la carte héro perd légèrement son élévation, sans parallaxe décorative.

**États et texte.** Le vide devient une étape de démarrage explicite. Une donnée périmée conserve sa dernière valeur avec horodatage et action « Réessayer ». Les alertes expliquent l'impact et l'action, jamais seulement « Attention ».

**Invariants.** Les indicateurs viennent des sources autoritatives existantes ; aucune estimation ne ressemble à un montant comptable confirmé. Les raccourcis réutilisent les mêmes cas d'usage que les parcours complets.

**Acceptation spécifique.** L'action prioritaire est identifiable sans couleur ; sa validation met à jour l'accueil seulement après résultat autoritatif ; aucun module ne bouge après stabilisation ; le dernier contenu reste accessible au-dessus de Bob et de la barre d'onglets ; le retour depuis un détail restaure position et focus.

<a id="s02"></a>

### S02 — Clients

**Route :** `/(tabs)/clients` · **Epic :** E07 · **Priorité :** P1

**Mission.** Retrouver un client, comprendre son activité et commencer une action commerciale avec un minimum de friction.

**Composition cible.** Header avec titre, compteur utile et ajout ; recherche immédiatement disponible ; segments ou filtres seulement s'ils changent réellement le résultat ; liste en lignes denses avec identité, statut factuel, dernier événement et montant pertinent. Les avatars décoratifs ne doivent pas prendre plus de place que l'information métier.

**Motion.** La recherche s'étend depuis le header ou se fixe sous celui-ci sans saut de layout. L'ajout réussi insère la ligne à sa place avec un bref highlight non bloquant. Une suppression ou désactivation confirmée réduit d'abord la ligne puis la retire, avec possibilité d'annulation si le domaine l'autorise.

**États et texte.** Le vide distingue « aucun client » de « aucun résultat ». Les filtres actifs sont visibles et réinitialisables. L'erreur de recherche ne remplace pas toute la liste déjà chargée.

**Invariants.** Les statuts et montants ne sont pas recalculés côté présentation. Toute action sensible conserve sa confirmation métier.

**Acceptation spécifique.** Recherche utilisable à une main, zone tactile de chaque ligne sans chevauchement, ordre de lecture cohérent, restauration du terme/filtre/scroll au retour, aucune perte de résultat quand le clavier se ferme.

<a id="s03"></a>

### S03 — Argent

**Route :** `/(tabs)/argent` · **Epic :** E08 · **Priorité :** P0/P1 selon risque de lisibilité

**Mission.** Donner une lecture sûre de la trésorerie, des entrées, des sorties et des échéances, sans promettre une précision que les données ne possèdent pas.

**Composition cible.** En tête : montant principal avec libellé temporel et provenance ; ensuite variation et échéances ; puis graphiques ; enfin accès aux sous-parcours dépenses, comptabilité, clôture et pilotage. Les graphiques restent secondaires par rapport aux valeurs et actions. Toute prévision est visuellement et textuellement distincte du réalisé.

**Motion.** Les montants ne comptent pas depuis zéro. Un changement confirmé utilise une transition courte des chiffres ; une variation négative ne « secoue » pas l'interface. Les courbes se révèlent par masque simple lors de leur première apparition, puis répondent au toucher sans animation continue. Le changement de période conserve le cadre et transforme les données, au lieu de remplacer brutalement la page.

**États et texte.** Les unités, périodes, taxes et statuts de synchronisation sont explicites. Hors-ligne, la dernière donnée sûre reste visible avec sa date. Les erreurs partielles restent dans le module concerné.

**Invariants.** Aucun calcul fiscal ou comptable nouveau dans la couche UI ; pas de rouge/vert comme seule information ; aucun « tout va bien » sans source et seuil produit validés.

**Acceptation spécifique.** Chaque montant est vocalisable sans ambiguïté ; les graphiques ont un résumé textuel ; les valeurs restent lisibles à 200 % ; changement de période sans flash ni perte de focus.

<a id="s04"></a>

### S04 — Documents

**Route :** `/(tabs)/documents` · **Epic :** E09 · **Priorité :** P1

**Mission.** Retrouver, classer, numériser et comprendre les documents sans reproduire un explorateur de fichiers complexe.

**Composition cible.** Header et recherche ; dossiers fréquents/récents ; filtres de statut ; liste de documents avec type, nom, date, statut et action contextuelle. Le scan est l'action primaire contextuelle, mais ne doit pas masquer l'ajout/import si celui-ci existe déjà.

**Motion.** L'ouverture d'un dossier suit une transition de profondeur cohérente. Une miniature nouvellement traitée passe du squelette au contenu par fondu croisé. Le déplacement d'un document montre sa destination par une transition de layout, sans illusion de réussite avant confirmation.

**États et texte.** Distinguer bibliothèque vide, dossier vide, filtre sans résultat, traitement en cours et traitement échoué. Les statuts OCR/validation sont traduits en conséquences compréhensibles.

**Invariants.** Les types, statuts et permissions viennent du domaine ; aucune animation de progression inventée ; le document reste accessible si un enrichissement secondaire échoue.

**Acceptation spécifique.** Recherche et filtres persistent au retour ; les miniatures ne provoquent pas de reflow ; chaque document a un libellé lecteur d'écran complet ; l'action scan reste accessible sans collision avec Bob ; une validation suivie d'un classement ne déplace le document qu'après confirmation backend.

<a id="s05"></a>

### S05 — Assistant

**Route :** `/(tabs)/assistant` · **Epic :** E05 · **Priorité :** P0 pour cohérence Bob

**Mission.** Faire de Bob un espace de travail conversationnel fiable, orienté action et transparent sur ce qu'il sait, prépare, exécute ou ne peut pas faire.

**Composition cible.** Contexte/conversation au centre ; propositions de départ seulement quand elles sont utiles ; composer texte et voix au bas de l'écran ; progression d'outil rattachée au message concerné ; résultats sous forme de cartes actionnables. Éviter un second « Bob flottant » si l'écran possède déjà le contrôle vocal principal.

**Motion.** Les nouveaux messages entrent par un fondu et léger déplacement, sans faire remonter brutalement l'historique. Les états écouter/comprendre/répondre suivent le langage de [Bob Live](./05-bob-live-experience.md). Le scroll automatique s'arrête dès que l'utilisateur remonte ; un bouton « Revenir au dernier message » apparaît alors.

**États et texte.** Séparer clairement brouillon, proposition, confirmation requise, exécution et résultat confirmé. Une erreur conserve le message et permet de réessayer. Le streaming textuel ne doit pas rendre la lecture ou VoiceOver instable.

**Invariants.** Les actions sensibles exigent la même confirmation qu'en interface tactile ; aucun outil n'est présenté comme terminé avant retour autoritatif ; aucun contenu de conversation dans la télémétrie produit.

**Acceptation spécifique.** Clavier, safe area et composer cohabitent ; interruption vocale visible en moins de 100 ms après événement local ; navigation écran/voix identique ; focus restauré après une feuille de confirmation.

<a id="s06"></a>

### S06 — Recherche globale

**Route :** `/recherche` · **Epic :** E06 · **Priorité :** P1

**Mission.** Trouver rapidement un client, chantier, document, devis, facture ou action, avec une hiérarchie stable.

**Composition cible.** Champ focalisé à l'entrée lorsque cela ne perturbe pas les technologies d'assistance ; recherches récentes ; résultats groupés par type avec compteurs ; action « Tout voir » si nécessaire. Les suggestions d'action ne se confondent pas avec les données trouvées.

**Motion.** Présentation en page ou search presentation native selon l'ADR navigation. Les groupes apparaissent sans cascade longue. Pendant la frappe, l'ancien résultat reste stable jusqu'au remplacement ; aucun spinner pleine page. L'effacement du champ ramène doucement aux recherches récentes.

**États et texte.** Minimum de caractères, délai réseau et absence de résultat sont expliqués. Les correspondances peuvent être mises en évidence sans réduire le contraste. Une erreur de catégorie reste locale.

**Invariants.** Aucun résultat ne contourne les permissions ; la sélection ouvre la route canonique ; pas de fausse recherche locale si la source requiert le serveur.

**Acceptation spécifique.** Temps de réponse perçu maîtrisé, annulation des requêtes obsolètes, clavier non bloquant, annonces accessibles non bavardes, retour au même groupe et à la même position.

<a id="s07"></a>

### S07 — Notifications

**Route :** `/notifications` · **Epic :** E06 · **Priorité :** P2

**Mission.** Transformer les événements utiles en décisions, sans créer une boîte de réception anxiogène.

**Composition cible.** Groupement temporel ; type et gravité exprimés par icône, texte et style ; action directe quand elle est sûre ; réglages accessibles sans être dominants. « Tout marquer comme lu » reste secondaire et confirmé si son effet est irréversible.

**Motion.** Une notification marquée lue réduit son emphase par transition de couleur/opacité, sans disparaître immédiatement. Les nouvelles entrées peuvent recevoir un bref halo statique, désactivé en mouvement réduit. Le swipe n'est qu'un raccourci et possède une alternative visible.

**États et texte.** Distinguer aucune notification, aucune non lue et chargement. L'intitulé dit ce qui s'est produit, sur quel objet et ce que l'utilisateur peut faire.

**Invariants.** Le badge suit l'autorité existante ; aucun optimisme irréversible ; les liens profonds valident session, tenant et existence avant présentation.

**Acceptation spécifique.** Ordre chronologique stable, lecture accessible complète, retour depuis le détail sans perte de position, état lu/non lu cohérent après synchronisation.

## 4. Clients et chantiers

<a id="s08"></a>

### S08 — Détail client

**Route :** `/client/[id]` · **Epic :** E07 · **Priorité :** P1

**Mission.** Comprendre la relation client et lancer devis, facture, appel ou chantier depuis une fiche fiable.

**Composition cible.** Identité et statut ; actions principales ; encours et documents ; chantiers ; coordonnées et métadonnées. Les actions les plus fréquentes sont visibles, les actions destructives restent dans un menu clairement nommé.

**Motion.** Le titre du client se compacte dans le header au scroll. Les sections se chargent indépendamment sans déplacer celles déjà stabilisées. Une mise à jour réussie souligne brièvement la valeur modifiée ; aucun feu d'artifice.

**États et texte.** Les sections vides proposent l'action adaptée. L'absence de permission ou l'objet supprimé a un écran de récupération, pas une page blanche.

**Invariants.** Montants, statuts et coordonnées restent issus des sources existantes ; les appels ou messages externes exigent une action explicite.

**Acceptation spécifique.** L'identité reste identifiable avec grande taille de texte ; une erreur de module ne masque pas le reste ; retour aux clients restaure recherche et position.

<a id="s09"></a>

### S09 — Chantiers

**Route :** `/chantiers` · **Epic :** E07 · **Priorité :** P1

**Mission.** Voir ce qui est en cours, en retard ou terminé, puis ouvrir le bon chantier.

**Composition cible.** Résumé compact ; segments réellement utiles ; liste avec client, lieu, phase, prochaine échéance et valeur si autorisée ; création tactile depuis une action dominante ou une sheet conforme au contrat. Les statuts sont des libellés métier, pas des couleurs abstraites.

**Motion.** Le passage d'un segment à l'autre conserve la hauteur utile et anime uniquement les éléments communs. Une évolution de statut déplace la ligne de manière compréhensible, après confirmation serveur. Le scroll ne déclenche aucun effet décoratif permanent.

**États et texte.** Séparer aucun chantier, filtre vide et accès restreint. Les retards indiquent date et action possible.

**Invariants.** L'ordre et les statuts reposent sur les règles existantes ; aucun score de risque nouveau sans spécification métier.

**Acceptation spécifique.** Filtres annoncés, touch targets conformes, valeurs accessibles, création/annulation par sheet testées, états vide/offline couverts, médias stables, position restaurée et affichage stable pendant refresh.

<a id="s10"></a>

### S10 — Détail chantier

**Route :** `/chantier/[id]` · **Epic :** E07 · **Priorité :** P1

**Mission.** Donner un cockpit de chantier : état, client, documents, finances et prochaine action.

**Composition cible.** Header identité/statut ; « prochaine étape » ; chronologie ; galerie documents/photos ; finances ; note vocale si le cas d'usage est déjà autorisé ; informations secondaires. La chronologie prime sur une mosaïque de cartes lorsque l'ordre temporel est essentiel.

**Motion.** Transition de profondeur depuis la liste. La chronologie se révèle sans animation de dessin prolongée. Une nouvelle pièce ou étape s'insère dans le bon ordre avec un accent bref. Le header collant conserve le nom et le statut.

**États et texte.** Chaque module gère son vide et son erreur. Les dates passées/futures sont explicites. Une action en cours indique ce qui peut être quitté sans risque.

**Invariants.** Aucune synthèse financière locale ; les documents gardent leurs permissions ; les transitions ne suggèrent pas qu'un upload est fini avant l'ACK autoritatif ; la note vocale utilise le contrat audio existant et n'ajoute ni stockage ni télémétrie implicite.

**Acceptation spécifique.** Chronologie lisible sans couleur, galerie et fichiers accessibles, note vocale réelle et annulable lorsqu'elle existe, profil mémoire avec médias, scroll conservé et retour stable à la liste.

## 5. Vente, devis et facturation

<a id="s11"></a>

### S11 — Ventes

**Route :** `/ventes` · **Epic :** E10 · **Priorité :** P1

**Mission.** Suivre devis et factures, comprendre leur état et créer le bon document.

**Composition cible.** Deux indicateurs sûrs maximum ; bascule devis/factures ou filtre unifié ; recherche ; lignes denses avec client, numéro, montant, date et statut ; CTA de création contextuel. Les montants et statuts dominent les ornements.

**Motion.** Les changements de filtre transforment la liste sans slide latéral trompeur. Un document créé s'insère après retour et reçoit un bref accent. Les badges changent par fondu de contenu, sans rebond.

**États et texte.** Distinguer brouillon, à envoyer, envoyé, accepté/refusé, dû, payé, en retard selon le domaine canonique. Les filtres vides conservent la possibilité de réinitialiser.

**Invariants.** Aucun statut inventé ou traduit de façon ambiguë ; totaux autoritatifs ; création tactile et vocale convergent vers les mêmes cas d'usage.

**Acceptation spécifique.** Montants alignés et vocalisables, statut jamais couleur seule, filtres restaurés, aucune action flottante ne recouvre une ligne.

<a id="s12"></a>

### S12 — Nouveau devis

**Route :** `/devis/new` · **Epic :** E10 · **Priorité :** P0 fonctionnel/P1 visuel

**Mission.** Créer un devis juste, compréhensible et récupérable, par saisie ou voix.

**Composition cible.** Progression sobre basée sur les étapes réelles : client, lignes, conditions, revue. Résumé total et action de continuation restent visibles sans masquer les champs. La revue finale rassemble destinataire, lignes, taxes, total et action exacte.

**Motion.** Transition entre étapes par continuité du conteneur, directionnelle mais courte. Une ligne ajoutée s'insère et le total change avec continuité numérique. Une validation échouée conduit le focus au premier problème ; pas de shake global. La dictée affiche ce qui a été compris avant toute application.

**États et texte.** Autosauvegarde seulement si elle existe réellement et avec statut fiable. « Enregistrer le brouillon », « Créer » et « Envoyer » ne sont jamais synonymes. Les erreurs sont placées au champ et résumées en haut.

**Invariants.** Calculs, taxes, numérotation, validation et confirmations restent dans le domaine/backend. La voix produit un brouillon révisable ; aucune création silencieuse.

**Acceptation spécifique.** Navigation clavier complète, données conservées après interruption récupérable, total accessible à chaque étape, double tap impossible sur le CTA, résultat confirmé avant succès.

<a id="s13"></a>

### S13 — Détail devis

**Route :** `/devis/[id]` · **Epic :** E10 · **Priorité :** P1

**Mission.** Lire, vérifier et faire avancer un devis sans ambiguïté sur son état.

**Composition cible.** Statut et montant ; client et dates ; aperçu/lignes ; historique ; action primaire dictée par le statut ; menu secondaire. La conversion en facture, l'envoi ou l'annulation ne coexistent pas visuellement avec la même emphase.

**Motion.** Le changement de statut confirmé transforme badge et action dans une transition courte. L'aperçu s'ouvre en profondeur. Un partage externe affiche une feuille claire et revient au même état.

**États et texte.** Les actions disent leur résultat : « Envoyer le devis », « Créer la facture à partir du devis ». Les erreurs d'envoi ne changent pas le statut localement.

**Invariants.** Historique immuable, confirmation sensible conservée, statut autoritatif et idempotence des actions.

**Acceptation spécifique.** Aucune action incompatible avec l'état ; montant et taxes lisibles à grande taille ; retour depuis aperçu/partage sans refetch visuellement brutal.

<a id="s14"></a>

### S14 — Nouvelle facture

**Route :** `/facture/new` · **Epic :** E10 · **Priorité :** P0 fonctionnel/P1 visuel

**Mission.** Produire une facture conforme et révisable avec le minimum de charge cognitive.

**Composition cible.** Même grammaire que le devis, avec différences légales explicites ; sélection client ; lignes ; dates/conditions ; revue de conformité ; création ; transmission séparée. Les mentions obligatoires ne sont pas cachées dans un accordéon incompréhensible.

**Motion.** Identique à S12 afin de réduire l'apprentissage. Les contrôles de conformité apparaissent près de la donnée concernée ; une alerte critique n'utilise pas une animation agressive. La création verrouille le CTA et montre une attente honnête.

**États et texte.** Distinguer brouillon, facture créée et facture transmise. Expliquer une donnée manquante et le chemin de correction.

**Invariants.** Numéro, taxes, arrondis, Factur-X, validation et immutabilité sont autoritatifs ; aucune UI ne « corrige » silencieusement une valeur.

**Acceptation spécifique.** Revue complète avant action irréversible, erreur récupérable sans perte, succès seulement après confirmation, preuve de conformité intégrée aux tests métier existants.

<a id="s15"></a>

### S15 — Détail facture

**Route :** `/facture/[id]` · **Epic principal :** E10 · **Revue transverse :** E08 finance · **Priorité :** P0 pour vérité financière

**Mission.** Comprendre immédiatement montant, échéance, paiement, transmission et actions possibles.

**Composition cible.** Statut, montant et échéance ; client ; transmission/paiement ; aperçu ; historique ; action principale. Les statuts « créée », « transmise », « reçue », « payée » restent distincts. Les données de paiement ne sont jamais réduites à un simple badge vert.

**Motion.** Transition de statut après ACK, avec mise à jour coordonnée du badge, de la chronologie et du CTA. Un paiement confirmé peut recevoir un accent premium très bref et non festif. La progression d'envoi n'avance pas artificiellement.

**États et texte.** Expliquer les échecs de transmission, les retards et la prochaine action. Une donnée partielle conserve les autres sections fiables.

**Invariants.** Pas d'optimisme sur paiement/transmission ; aucune mutation d'un document légal par simple animation ; historique et montants autoritatifs.

**Acceptation spécifique.** Tous les statuts sont différenciables en niveaux de gris, VoiceOver lit devise et état, CTA cohérent avec le domaine, deep link sûr après reconnexion.

<a id="s16"></a>

### S16 — Transmission d'une facture

**Route :** `/facture/transmission/[id]` · **Epic principal :** E10 · **Revue transverse :** E08 finance · **Priorité :** P0

**Mission.** Rendre une opération sensible explicite, confirmable, traçable et récupérable.

**Composition cible.** Récapitulatif non éditable ; destinataire/canal ; vérifications ; conséquences ; confirmation finale ; état d'envoi ; reçu ou erreur. Le bouton nomme l'action et le destinataire quand cela reste lisible.

**Motion.** La confirmation se présente en feuille ou étape dédiée selon complexité. Après confirmation, le contenu morph vers un état d'attente stable, puis vers le reçu seulement après autorité serveur. En cas d'erreur, retour vers l'étape réparable sans animation de succès intermédiaire.

**États et texte.** « Préparation », « Envoi demandé », « Transmise » et « Échec » sont distincts. Un timeout dit que le résultat doit être vérifié, pas que l'action a échoué si l'autorité est inconnue.

**Invariants.** Confirmation existante obligatoire, idempotence, aucune répétition automatique opaque, aucune donnée destinataire dans les analytics.

**Acceptation spécifique.** Double soumission impossible, interruption/reprise sûre, reçu accessible et partageable si le domaine le permet, annonces accessibles mesurées.

<a id="s17"></a>

### S17 — Catalogue

**Route :** `/catalogue` · **Epic :** E10 · **Priorité :** P2

**Mission.** Retrouver et maintenir les produits/prestations utilisés dans les documents commerciaux.

**Composition cible.** Recherche, catégories utiles, liste dense avec nom, unité et prix, ajout/édition. Les prix secondaires restent alignés ; les métadonnées rarement utilisées sont dans le détail.

**Motion.** Recherche et insertion suivent S02. Une édition réussie met à jour la ligne sans recharger tout l'écran. Les menus contextuels s'ancrent à l'élément.

**États et texte.** Distinguer catalogue vide et filtre vide. Les unités, prix HT/TTC et taxes sont nommés sans abréviation ambiguë.

**Invariants.** Règles de prix et taxes restent autoritatives ; la suppression respecte les dépendances métier.

**Acceptation spécifique.** Scan rapide des lignes, ordre stable, édition accessible au clavier, erreurs au bon champ, pas de valeur monétaire tronquée.

## 6. Finance et pilotage

<a id="s18"></a>

### S18 — Dépenses

**Route :** `/depenses` · **Epic :** E08 · **Priorité :** P1

**Mission.** Comprendre les sorties, leurs paiements/états temporels lorsqu'ils existent, et traiter les justificatifs ou anomalies.

**Composition cible.** Période et total ; filtres ; liste avec fournisseur, date, montant, catégorie, justificatif et statut de paiement si le domaine l'expose ; actions de consultation, création, paiement ou justificatif uniquement lorsqu'elles sont autorisées. Les catégories restent secondaires au montant et au statut documentaire.

**Motion.** Changement de période continu, insertion d'une dépense confirmée, état de justificatif mis à jour par fondu. Aucun graphique décoratif en mouvement permanent.

**États et texte.** Une dépense sans justificatif explique l'action ; une donnée à vérifier n'est pas présentée comme erreur définitive.

**Invariants.** Catégorisation, totaux, preuve et paiement autoritatifs ; double soumission impossible ; pas de déduction fiscale implicite inventée par l'UI.

**Acceptation spécifique.** Création/consultation/paiement/échec/retry couverts si ces opérations existent ; montant, preuve et statut cohérents ; montants et signes sans ambiguïté, filtres restaurés, résumé accessible des tendances, erreur partielle non destructive.

<a id="s19"></a>

### S19 — Comptabilité

**Route :** `/comptabilite` · **Epic :** E08 · **Priorité :** P0/P1

**Mission.** Rendre l'état comptable compréhensible sans prétendre remplacer la logique métier ou le conseil professionnel.

**Composition cible.** État de synchronisation ; équilibre ou écart expliqué ; tâches à traiter ; périodes ; journal détaillé en progressive disclosure ; exports ou transmissions existantes ; historique. Les alertes critiques sont séparées des recommandations.

**Motion.** Une synchronisation utilise une activité indéterminée honnête ; les tâches résolues quittent la liste après confirmation avec réduction courte. Les nombres ne défilent pas.

**États et texte.** Préciser ce qui est à jour, à vérifier, bloquant ou indisponible. Expliquer l'effet d'une action avant son lancement.

**Invariants.** Aucune écriture, rapprochement ou statut n'est simulé localement ; opérations sensibles confirmées ; terminologie alignée sur le domaine.

**Acceptation spécifique.** Fixtures équilibrée/déséquilibrée exactes ; journal accessible ; export strictement identique aux données ; une personne non comptable identifie la prochaine action, une personne experte retrouve date/source ; statut accessible sans couleur ; reprise hors-ligne sûre.

<a id="s20"></a>

### S20 — Clôture

**Route :** `/cloture` · **Epic :** E08 · **Priorité :** P0

**Mission.** Guider une séquence à fort enjeu avec contrôle, preuve et possibilité de corriger avant validation.

**Composition cible.** Période ; checklist ordonnée ; problèmes bloquants ; éléments à vérifier ; synthèse ; confirmation finale. La progression reflète des contrôles réels, jamais un pourcentage décoratif.

**Motion.** Cocher un contrôle confirmé réduit son emphase sans le supprimer de l'historique. Le passage d'étape conserve le contexte. La confirmation finale est calme, lisible et résistante au double tap.

**États et texte.** Différencier « à faire », « vérification en cours », « bloqué », « prêt » et « clôturé ». Chaque blocage dit pourquoi et où corriger.

**Invariants.** Autorité backend, immutabilité, permissions, audit et confirmation ; pas de succès avant réponse finale.

**Acceptation spécifique.** Reprise après interruption, focus sur premier blocage, historique lisible, export uniquement si réellement permis, preuve E2E d'idempotence et de vérité du statut.

<a id="s21"></a>

### S21 — Pilotage

**Route :** `/pilotage` · **Epic :** E08 · **Priorité :** P2

**Mission.** Montrer tendances et leviers sans surcharger ni fabriquer des prédictions.

**Composition cible.** Période ; quelques KPI prioritaires ; tendance avec valeur et explication ; objectifs ou comparaisons uniquement s'ils existent ; détails progressifs. Une carte répond à une question, pas à quatre.

**Motion.** Le changement de période transforme valeurs et courbes dans le même cadre. Interaction tactile sur graphique avec repère stable ; mouvement réduit remplace les tracés par fondu. Aucun compteur depuis zéro.

**États et texte.** Indiquer données manquantes, période insuffisante et nature estimée/réalisée. Les recommandations sont qualifiées comme telles.

**Invariants.** KPI calculés par les sources canoniques ; aucune nouvelle promesse prédictive ; provenance et période disponibles.

**Acceptation spécifique.** Résumé textuel équivalent à chaque graphique, tabular nums, axe/échelle lisibles, aucune interprétation portée uniquement par couleur.

## 7. Documents et capture

<a id="s22"></a>

### S22 — Dossier de documents

**Route :** `/documents/folder/[id]` · **Epic :** E09 · **Priorité :** P1

**Mission.** Parcourir un sous-ensemble de documents en conservant orientation et outils.

**Composition cible.** Breadcrumb ou retour nommé ; titre/compteur ; recherche/tri ; liste ; actions du dossier dans un menu. Le chemin reste compréhensible sans reproduire une arborescence de bureau.

**Motion.** Entrée de profondeur depuis S04 ; retour inverse. Les tris réordonnent les lignes avec prudence ou par remplacement stable si la liste est longue. Upload/traitement n'invente pas de progression.

**États et texte.** Dossier vide distinct d'une erreur et d'un filtre vide. Un document en traitement reste identifiable.

**Invariants.** Permissions et appartenance au dossier validées côté autorité ; aucune relocalisation optimiste irréversible.

**Acceptation spécifique.** Chemin vocalisable, retour à la même position dans S04, longues listes fluides, actions alternatives au swipe.

<a id="s23"></a>

### S23 — Détail document

**Route :** `/documents/[id]` · **Epic :** E09 · **Priorité :** P1

**Mission.** Prévisualiser, comprendre le statut, corriger les métadonnées autorisées et agir sur un document.

**Composition cible.** Preview stable ; nom/type/statut ; données extraites ; liens métier ; historique ; actions. Les erreurs OCR sont visuellement séparées du fichier original.

**Motion.** La preview se charge dans un cadre réservé. Zoom/pan restent des interactions de contenu, pas des transitions de page. Une correction confirmée met en évidence le champ puis se stabilise.

**États et texte.** Traitement, données à vérifier, échec d'extraction, fichier indisponible et permission refusée ont des réparations distinctes.

**Invariants.** Le fichier source n'est jamais altéré par une correction visuelle ; statuts et extraction autoritatifs ; partage/export explicites.

**Acceptation spécifique.** Preview accessible ou alternative descriptive, zoom non bloquant, focus restauré après édition, aucune donnée sensible en analytics.

<a id="s24"></a>

### S24 — Scanner un document

**Route :** `/scan-document` · **Epic :** E09 · **Priorité :** P0/P1

**Mission.** Capturer un document net, le vérifier et l'envoyer sans surprise.

**Composition cible.** Permission contextualisée ; caméra plein cadre ; guide de capture utile mais discret ; déclencheur accessible ; aperçu ; recadrage/rotation si disponibles ; confirmation ; upload/traitement. L'UI reste lisible sur fond clair ou sombre de la caméra.

**Motion.** Aucun clignotement décoratif. Le déclenchement donne un retour tactile/visuel conforme à la capture réelle. La transition caméra→aperçu utilise le contenu capturé ; l'upload affiche une progression réelle ou indéterminée. Mouvement réduit neutralise les transformations non indispensables.

**États et texte.** Permission refusée avec accès Réglages ; appareil indisponible ; capture floue si réellement détectée ; upload interrompu ; traitement différé. Ne jamais afficher « analysé » au moment où seul l'upload est fini.

**Invariants.** Permission, stockage temporaire, suppression, upload et traitement suivent les contrats scanner/confidentialité existants.

**Acceptation spécifique.** Test appareil réel en faible lumière et rotation, gros texte sans masquer le déclencheur, reprise réseau, fermeture sûre sans perdre une capture non confirmée.

## 8. Diagnostic, onboarding et compte

<a id="s25"></a>

### S25 — Diagnostic

**Route :** `/diagnostic` · **Epic :** E11 · **Priorité :** P2

**Mission.** Guider des questions directionnelles, puis expliquer le diagnostic, son score lorsqu'il existe, ses limites et les actions recommandées.

**Composition cible.** Questions ordonnées avec retour/reprise ; résumé ; éléments solides ; points à compléter ; priorités ; actions. Le score, s'il existe, n'apparaît qu'après calcul réel, possède une méthode et ne devient pas une jauge anxiogène sans contexte.

**Motion.** Révélation progressive des sections après résultat autoritatif, sans roulette dramatique. Les recommandations apparaissent ensemble ou en cascade très courte. Pas de confettis.

**États et texte.** Expliquer ce qui manque et comment améliorer la qualité. Distinguer analyse en cours, résultat partiel et échec.

**Invariants.** Aucun score/recommandation nouveau côté UI ; limites et provenance visibles ; pas de promesse réglementaire.

**Acceptation spécifique.** Réponse/retour/reprise/résultat couverts ; score seulement après autorité ; recommandations ordonnées ; résultat compréhensible sans animation, résumé accessible et action suivante claire.

<a id="s26"></a>

### S26 — Onboarding

**Route :** `/onboarding` · **Epic :** E11 · **Priorité :** P0 activation

**Mission.** Amener l'utilisateur jusqu'à une première valeur réelle avec le minimum de questions et une confiance maximale.

**Composition cible.** Promesse courte ; étapes uniquement nécessaires au produit et à la conformité ; personnalisation fondée sur les choix réels ; progression discrète et exacte ; saisie ; revue ; fin orientée vers la première action. Les permissions sont demandées au moment où leur bénéfice est compréhensible.

**Motion.** Transition directionnelle courte entre étapes ; continuité des éléments communs ; aucune illustration en boucle. Les erreurs ramènent au champ sans reset. La fin ne simule pas une configuration réussie avant confirmation.

**États et texte.** Dire pourquoi une information est demandée, si elle est modifiable plus tard et ce qui est facultatif. Une reprise de session restaure l'étape réellement enregistrée.

**Invariants.** Même validation backend, consentements explicites, aucune permission précoce, aucun faux progrès.

**Acceptation spécifique.** Parcours interrompu/repris, petit écran, gros texte, clavier, lecteur d'écran, réseau instable ; choix persistés et accueil réellement dérivé des réponses seulement si le domaine le prévoit ; temps jusqu'à valeur mesuré sans contenu personnel.

<a id="s27"></a>

### S27 — Compte

**Route :** `/compte` · **Epic :** E11 · **Priorité :** P1

**Mission.** Regrouper identité, sécurité, préférences, facturation et support avec une hiérarchie prévisible.

**Composition cible.** Identité ; entreprise ; sécurité ; abonnement/statut commercial s'il existe ; facturation ; préférences ; aide ; déconnexion ; suppression/fermeture dans une zone de danger séparée. Les lignes décrivent leur valeur actuelle quand utile.

**Motion.** Navigation standard, menus sans ressort ludique. Une préférence change localement seulement si le contrat le permet ; sinon attente honnête. La déconnexion utilise une transition de session cohérente.

**États et texte.** Clarifier les conséquences des actions sensibles. Les valeurs absentes ne sont pas remplacées par des placeholders trompeurs.

**Invariants.** Permissions, confirmation, réauthentification et contrats de session inchangés.

**Acceptation spécifique.** Ordre de focus logique, danger non déclenchable accidentellement, préférence accessible sans couleur, retour au bon groupe.

<a id="s28"></a>

### S28 — Réglages de facturation

**Route :** `/reglages-facturation` · **Epic principal :** E11 · **Revue transverse :** E08 finance · **Priorité :** P0/P1

**Mission.** Configurer les paramètres légaux et commerciaux qui affectent les futurs documents, avec conséquences explicites.

**Composition cible.** Groupes : numérotation, paiement, mentions, taxes si autorisées, aperçu d'impact et indicateur de modifications non enregistrées. Chaque groupe explique sa portée et sa date d'effet. Sauvegarde globale ou par section, mais pas un mélange implicite.

**Motion.** Les champs conditionnels se déploient par layout transition courte. Sauvegarde avec état sur le bouton et confirmation non intrusive. Une erreur garde les valeurs et amène au bon groupe.

**États et texte.** Différencier valeur actuelle, nouvelle valeur et exemple. Les avertissements disent quels documents seront affectés.

**Invariants.** Validation métier et légale autoritative ; aucune modification rétroactive implicite ; confirmation si le domaine l'exige.

**Acceptation spécifique.** Dirty state et sortie avec modifications couverts ; grande taille de texte, erreurs regroupées, aperçu non présenté comme document officiel, comparaison au document final généré, succès après persistance réelle.

<a id="s29"></a>

### S29 — Profil fiscal

**Route :** `/profil-fiscal` · **Epic principal :** E11 · **Revue transverse :** E08 finance · **Priorité :** P0

**Mission.** Collecter et afficher les informations fiscales de façon précise, compréhensible et prudente.

**Composition cible.** Statut/profil ; champs groupés par sens ; explications ; pièces ou vérifications si existantes ; revue ; sauvegarde. Le jargon possède une aide courte, sans masquer la responsabilité utilisateur.

**Motion.** Apparition courte des champs conditionnels ; pas d'animation célébratoire pour un choix fiscal. Une vérification distante montre son état réel.

**États et texte.** « Non renseigné », « à vérifier », « vérifié » et « refusé » restent distincts. Expliquer la correction attendue sans donner un conseil fiscal non validé.

**Invariants.** Source autoritative, validations, audit, confidentialité et consentement ; aucun calcul fiscal local nouveau.

**Acceptation spécifique.** Champs et erreurs accessibles, données sensibles absentes des logs/analytics, reprise sûre, confirmation lisible avant mutation importante.

## 9. Authentification et récupération

<a id="s30"></a>

### S30 — Retour d'authentification

**Route :** `/auth/callback` · **Epic :** E11 · **Priorité :** P0

**Mission.** Finaliser une authentification externe de manière sûre et expliquer seulement ce qui est utile.

**Composition cible.** État centré minimal avec marque, message précis et action de récupération si nécessaire. Aucun menu applicatif tant que la session n'est pas établie.

**Motion.** Indicateur indéterminé calme ; transition vers l'application uniquement après session autoritative. En échec, l'indicateur s'arrête et les actions apparaissent sans flash.

**États et texte.** Validation, succès, lien expiré/invalide, session déjà consommée, réseau et erreur inconnue. Ne jamais afficher des tokens ou détails techniques.

**Invariants.** Contrats auth, redirections autorisées, session cache et protection contre rejeu inchangés.

**Acceptation spécifique.** Deep link froid/chaud, double ouverture, retour arrière, hors-ligne, lecteur d'écran ; aucune boucle de navigation ni faux succès.

<a id="s31"></a>

### S31 — Récupération de compte

**Route :** `/auth/recovery` · **Epic :** E11 · **Priorité :** P0

**Mission.** Permettre la récupération sans révéler l'existence d'un compte ni créer d'impasse.

**Composition cible.** Étape demande ; confirmation neutre ; ouverture du lien ; nouveau secret ; résultat. Une seule action primaire, critères de mot de passe accessibles et aide visible.

**Motion.** Passage d'étape sobre ; validation inline non agressive ; aucune secousse. Le succès apparaît seulement après confirmation et conduit clairement à la connexion.

**États et texte.** Réponses anti-énumération, lien expiré, déjà utilisé, invalide, réseau, mot de passe refusé. Les messages restent utiles sans divulgation.

**Invariants.** Règles de sécurité, expiration, usage unique et invalidation des sessions selon contrats existants.

**Acceptation spécifique.** Gestionnaire de mots de passe, collage, lecteur d'écran, gros texte, deep links, retour arrière ; absence de PII dans télémétrie.

<a id="s32"></a>

### S32 — Voix historique

**Route :** `/voix` · **Epic :** E05 · **Priorité :** P0 décision de convergence

**Mission.** Préserver les parcours existants tout en évitant deux expériences vocales concurrentes.

**Composition cible.** Tant que la route existe, utiliser la même projection d'état, les mêmes mots et la même sécurité que Bob Live. Si elle devient une façade de compatibilité, expliquer son rôle et rediriger sans boucle vers la surface canonique.

**Motion.** Aucun langage visuel parallèle. Écoute, compréhension, réponse, confirmation, erreur et reconnexion suivent [Bob Live](./05-bob-live-experience.md). Une redirection approuvée est instantanée ou utilise une transition standard, jamais un faux écran de chargement.

**États et texte.** Couvrir toutes les erreurs acoustiques/réseau/session. Ne pas nommer le fournisseur technique dans le langage utilisateur.

**Invariants.** Même transport, mêmes cas d'usage, mêmes confirmations et même politique de confidentialité que la surface canonique.

**Acceptation spécifique.** Une seule instance audio active, aucune collision avec le bouton global, parité fonctionnelle prouvée, décision de maintien/dépréciation enregistrée avant suppression.

<a id="s33"></a>

### S33 — Connexion et inscription

**Composant :** `src/screens/LoginScreen.tsx` · **Epic :** E11 · **Priorité :** P0

**Mission.** Établir la confiance et accéder au produit avec un parcours court, sûr et sans ambiguïté entre connexion, création et confirmation d'e-mail.

**Composition cible.** Marque et promesse mesurée ; mode connexion/inscription clairement sélectionné ; champs e-mail, secret et données entreprise/SIRET seulement si le contrat d'inscription les exige ; aide/mot de passe oublié ; CTA ; consentements requis ; confirmation d'e-mail. Les éléments marketing ne poussent pas le formulaire sous le clavier.

**Motion.** Changement de mode par transition de contenu courte avec conservation des champs compatibles uniquement si c'est sûr. Focus et clavier restent stables. Le bouton reflète attente et empêche le double envoi. Aucun succès avant session ou résultat autoritatif.

**États et texte.** Erreur de saisie, identifiants refusés, compte non confirmé, rate limit, réseau, service indisponible et confirmation envoyée. Les erreurs ne permettent pas l'énumération de comptes.

**Invariants.** Authentification, consentements, règles de mot de passe, confirmation d'e-mail et stockage de session inchangés.

**Acceptation spécifique.** Autofill et gestionnaire de mots de passe, petits/grands écrans, gros texte, lecteur d'écran, clavier, mode hors-ligne ; aucune donnée sensible dans logs ou analytics.

## 10. Revue transversale obligatoire avant chaque tranche

Pour chaque lot d'écrans, le trio Design–Mobile–QA doit répondre par preuve aux questions suivantes :

1. L'action principale est-elle évidente sans animation ?
2. L'écran reste-t-il entièrement utilisable quand les animations sont supprimées ?
3. Les montants, dates, statuts et conséquences sont-ils non ambigus ?
4. Les états partiels et les erreurs locales préservent-ils les données fiables ?
5. Le retour restaure-t-il route, focus, scroll, filtres et saisie selon le contrat ?
6. Le lecteur d'écran reçoit-il le même sens, dans le bon ordre, sans annonces répétées ?
7. La grande taille de texte n'introduit-elle ni troncature critique ni CTA inaccessible ?
8. Bob, le clavier, les feuilles et les barres système peuvent-ils coexister sans collision ?
9. Toute réussite affichée correspond-elle à une autorité réelle ?
10. Les vidéos et métriques démontrent-elles le respect du budget de performance ?
