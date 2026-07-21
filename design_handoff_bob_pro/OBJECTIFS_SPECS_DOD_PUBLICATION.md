# CAP PUBLICATION — OBJECTIFS, SPECS ET DEFINITION OF DONE

**Statut : Accepted**

**Décision fondateur : 2026-07-21**

**Portée : prochaine version publique de Bob Pro**

Ce document est la source de vérité du train de publication. Il remplace toute instruction
antérieure contradictoire sur la priorité des fournisseurs vocaux, l'ordre des chantiers et le
mode de collaboration Git. Les documents historiques restent utiles pour leur architecture et
leurs preuves, mais ne peuvent pas réintroduire un chantier hors du chemin critique défini ici.

La [matrice des flags V1](MATRICE_FLAGS_V1.md) décrit l'état réellement configuré tant que la
bascule GPT Realtime n'a pas été livrée. Elle sera modifiée **dans le même lot atomique** que le
code, les gardes d'environnement et les tests anti-drift ; une spec ne doit jamais faire croire
qu'un fournisseur est actif avant que le runtime ne le prouve.

## 1. Objectif produit

Publier le plus rapidement possible une version **stable, fiable et exploitable avec des données
réelles**, dont le différenciateur est une conversation vocale GPT Realtime fluide qui comprend
l'écran courant, accompagne un parcours complet et fait exécuter les mêmes use cases que
l'interface manuelle, avec les mêmes confirmations et les mêmes garde-fous.

La vitesse recherchée est une vitesse de convergence : un seul tronc canonique, une seule priorité
vocale, des lots verticaux courts et des critères de sortie binaires. Une fonctionnalité seulement
présente dans le code, non branchée ou non prouvée sur le chemin réel n'est pas livrée.

## 2. Résultats attendus, dans l'ordre

| ID | Résultat | Mesure de réussite |
| --- | --- | --- |
| O1 | Vérité Git retrouvée | `main` contient tous les lots retenus, compile depuis un checkout propre et devient l'unique base des nouvelles branches. |
| O2 | Facturation conforme et complète | Le lot Factur-X / PDF-A-3 / TVA / BT-23 est verticalement branché, testé et certifié sans identifiant fiscal inventé. |
| O3 | GPT Realtime est le chemin vocal de publication | Une session utilise OpenAI de l'entrée audio à la sortie audio, sans clé ni service Mistral implicite. |
| O4 | Bob accompagne une mission continue | Navigation, changement d'écran, contexte, choix structurés, diff et confirmation restent corrélés jusqu'à réussite, abandon explicite ou erreur récupérable. |
| O5 | Voice Trace rend la qualité pilotable | Chaque tour produit une trace corrélée ; p50/p95, interruptions, erreurs et dégradations sont observables sans audio ni secret dans les logs. |
| O6 | Zéro donnée fabriquée en production | Écrans, API, calculs et réponses Bob utilisent la base du tenant ; absence et erreur sont affichées honnêtement. |
| O7 | Release reproductible | Le commit publié passe build, tests, migrations, boot avec l'environnement cible, smoke tests et QA sur appareils réels. |

## 3. Périmètre du train

### 3.1 Inclus

- fermeture du lot Factur-X : PDF/A-3, XML embarqué, profil réglementaire, TVA société/client,
  code BT-23 explicite et figé, migrations additives et preuves de conformité ;
- réconciliation Git sur `main`, sauvegarde avant réécriture d'historique et réduction des anciens
  worktrees sans supprimer de travail non intégré ;
- GPT Realtime en plein duplex : streaming audio, VAD, barge-in, arrêt de lecture, reprise et
  fermeture de session déterministes ;
- Voice Trace de bout en bout avec budgets de latence et corrélation mobile/API/provider/outils ;
- contexte d'écran continu, navigation non destructive et boucle agentique typée pour les parcours
  prioritaires ;
- parité voix/tap, propositions inviolables, diffs réels et confirmation obligatoire des mutations ;
- données tenant réelles, états chargement/vide/erreur/données et absence de fixtures dans les
  artefacts de production ;
- accès anticipé sans abonnement payant dans la première version publique, avec état vide honnête
  pour les factures d'abonnement.

### 3.2 Explicitement différé

- **Mistral Realtime V3** : code et décisions préservés, aucune nouvelle implémentation avant la
  publication. Réévaluation post-publication comme solution propriétaire/européenne ou repli si
  GPT Realtime ne satisfait pas les mesures de qualité, coût, disponibilité ou gouvernance ;
- mélange automatique OpenAI/Mistral dans une même session ;
- activation publique des paiements et plans : l'architecture peut rester branchée, mais la V1 est
  en accès anticipé sans plan tant que le train paiement n'est pas certifié ;
- refonte du logo, reprise directement par le fondateur ;
- ajout opportuniste sans lien avec un critère de publication.

## 4. Spécification normative

### 4.1 Sélection du fournisseur vocal

1. Une session de publication choisit `openai` une seule fois au démarrage.
2. En mode OpenAI, capture/transport, compréhension temps réel et synthèse vocale ne dépendent
   d'aucune clé Mistral. Une absence de clé OpenAI refuse clairement l'ouverture de Bob Live.
3. Une panne ne déclenche jamais un changement silencieux de fournisseur. Le produit propose une
   reconnexion, un mode manuel ou un repli explicitement annoncé et mesuré.
4. Les outils métier restent provider-neutral : changer de transport vocal ne change ni les use
   cases, ni les politiques de confirmation, ni les preuves d'audit.
5. Les flags Mistral full-duplex/V3 restent désactivés dans les profils de publication et sont
   protégés contre une activation accidentelle.

### 4.2 Mission conversationnelle continue

Une mission possède un identifiant, un état, une révision de contexte, une révision de brouillon et
un journal d'appels d'outils. Après une navigation, le runner attend l'ACK du nouvel écran, recharge
son contexte réel, puis poursuit la même mission. Il ne repart pas comme une nouvelle conversation.

Pour une demande complète — devis, facture, client, document — Bob :

1. extrait tous les faits exprimés en une fois ;
2. relit les données réelles nécessaires ;
3. exécute automatiquement les lectures et navigations sans risque ;
4. présente un choix structuré seulement en cas d'ambiguïté réelle ;
5. demande uniquement les champs indispensables manquants ;
6. construit un brouillon ou staging, jamais un effet final caché ;
7. affiche et vocalise un diff vérifiable ;
8. recueille la confirmation via le même `choiceId` ou `proposalId` au tap et à la voix ;
9. exécute le use case idempotent, puis relit la base pour annoncer le résultat réel.

La sélection catalogue suit le même protocole : zéro candidat = création libre proposée ; un match
fort = suggestion explicite ; plusieurs candidats = options réelles numérotées ; aucun choix
silencieux du LLM.

### 4.3 Sécurité et vérité métier

- Les lectures peuvent être automatiques. Toute mutation passe par un outil typé et audité.
- Les actions financières, fiscales, contractuelles ou destructrices exigent toujours une
  confirmation explicite, même en mode vocal autonome.
- Les montants, identifiants, libellés de catalogue et statuts annoncés viennent d'un résultat
  d'outil ou de la base, jamais de la prose du modèle.
- Chaque écriture rejouable porte une clé d'idempotence et une révision attendue.
- Une référence hors tenant, périmée ou absente échoue fermée.
- Aucun transcript, audio brut, token ou secret n'entre dans les métriques ou logs applicatifs.

### 4.4 Voice Trace et objectifs de service

Chaque tour corrèle au minimum : session, mission, tenant pseudonymisé, tour, transport, modèle,
horodatages capture/VAD/connexion/premier token/premier audio/fin, appels d'outils, interruption,
repli, erreur et cause normalisée.

| Indicateur device réel | Cible p50 | Cible p95 | Règle |
| --- | ---: | ---: | --- |
| Fin de parole → premier audio Bob | ≤ 900 ms | ≤ 1 800 ms | mesuré sur réseau réaliste, hors warm-up identifié |
| Parole utilisateur → silence Bob | ≤ 250 ms | ≤ 500 ms | arrêt audio réellement observé, pas seulement ACK logique |
| Exécution fantôme | 0 | 0 | bloque la release |
| Confirmation perdue ou rejouée deux fois | 0 | 0 | bloque la release |
| Faux succès après perte réseau | 0 | 0 | bloque la release |

Une cible de latence non atteinte ne peut pas être transformée en succès documentaire : la mesure,
le device, le réseau, le commit et la distribution doivent accompagner le verdict.

### 4.5 Données et états d'interface

- Les chemins de production n'importent ni fixture, ni repository in-memory, ni constante de démo.
- `missing` et `error` donnent `unavailable`, jamais `0` ni un montant crédible inventé.
- Chaque écran de publication couvre chargement, vide, erreur récupérable et données.
- Les valeurs affichées sont relues après mutation ; les optimismes UI restent temporaires et
  réconciliés avec le serveur.
- Le compte propriétaire voit uniquement les données persistées de sa société sous RLS forcée.

## 5. Séquence d'exécution imposée

1. Graver ce cap, l'ADR fournisseur et le DoD.
2. Terminer le lot Factur-X/TVA déjà commencé ; fermer tous ses P0/P1 vérifiés.
3. Le tester, le committer atomiquement et créer une sauvegarde Git nommée.
4. Actualiser `main`, rebaser le lot, résoudre les conflits par intention métier et repasser les
   validations depuis l'état rebasé.
5. Intégrer et pousser `main`, puis inventorier/sauvegarder/supprimer les worktrees obsolètes.
6. Créer **une seule branche courte** depuis le nouveau `main` pour GPT Realtime + Voice Trace.
7. Livrer des tranches verticales démontrables, intégrer sur `main`, supprimer la branche, répéter.

Pendant qu'un agent écrit, l'autre relit et challenge en lecture seule. La passation du bâton est
explicite. Un worktree séparé n'est créé que pour une isolation indispensable et disparaît dès
l'intégration.

## 6. Definition of Done — binaire

### 6.1 Lot de code

- [ ] Une spec courte lie le changement à un objectif `O*` et énumère ses cas limites.
- [ ] Le domaine reste framework-free ; UI, API et Bob appellent le même use case.
- [ ] Aucun mock/fixture/repository in-memory n'est atteignable depuis l'artefact de production.
- [ ] Tests ciblés verts, puis `pnpm typecheck`, `pnpm test` et `pnpm build` verts depuis un checkout
      propre du commit candidat.
- [ ] Toute migration est additive, rejouable et certifiée sur PostgreSQL réel avec le rôle runtime.
- [ ] Les quatre états UX, i18n, accessibilité, confirmation et parité voix/tap sont couverts quand
      la tranche comporte une interface.
- [ ] Une review adversariale correctness/sécurité/architecture/UX a vérifié que le code est appelé.
- [ ] Commit atomique, claim libéré, handoff et preuves consignés.

### 6.2 GPT Realtime + Voice Trace

- [ ] Une clé OpenAI suffit à la session complète ; aucune requête Mistral n'est observée.
- [ ] Ouverture, reconnexion, arrière-plan, interruption, hangup et perte réseau convergent vers un
      état terminal unique et testable.
- [ ] Le micro ne se ferme pas spontanément et un seul overlay Bob existe sur chaque écran autorisé.
- [ ] Une mission devis complète traverse au moins navigation → client → catalogue/ligne → TVA →
      revue → confirmation sans perdre son contexte.
- [ ] Les mêmes choix peuvent être résolus au doigt ou à la voix avec le même identifiant.
- [ ] Les SLO de la section 4.4 sont mesurés sur au moins un iPhone réel et un Android réel.
- [ ] Voice Trace permet de diagnostiquer chaque échec en une lecture et ne journalise aucune donnée
      vocale sensible.
- [ ] Le chemin Mistral V3 est OFF et un test anti-drift empêche son activation dans la build.

### 6.3 Publication

- [ ] `main` distant correspond exactement au commit candidat et aucun lot requis ne vit uniquement
      dans un worktree ou une branche locale.
- [ ] Le schéma cible est migré avant le writer ; le code N-1 reste compatible pendant la fenêtre.
- [ ] L'artefact exact boote localement avec la forme complète de l'environnement de production.
- [ ] `/health/ready` prouve commit, mode de données réel et dépendances obligatoires.
- [ ] Cold onboarding, données réelles, devis, facture, document et Bob Live passent sur appareils.
- [ ] CGU/confidentialité/support, crash reporting, alertes et runbook sont actifs.
- [ ] Zéro P0/P1 ouvert ; les limites restantes sont écrites et non présentées comme fonctionnelles.

## 7. Registre de preuve

Chaque objectif passe par quatre états seulement : `specified`, `implemented`, `certified`,
`released`. Le passage d'état exige un lien vers un commit et une preuve ; le pourcentage estimé ne
remplace jamais ce registre.

| Objectif | État au 2026-07-21 | Prochaine preuve attendue |
| --- | --- | --- |
| O1 — vérité Git | specified | branche de sauvegarde + graphe rebasé + `main` poussé |
| O2 — Factur-X/TVA | implemented | suites complètes + PostgreSQL + validateur externe + checkout propre |
| O3 — GPT Realtime | specified | contrat homogène OpenAI + test sans clé Mistral + QA device |
| O4 — mission continue | specified | scénario devis E2E voix/tap sur vrais use cases |
| O5 — Voice Trace | implemented partiellement | corrélation E2E + dashboard p50/p95 + tests de confidentialité |
| O6 — données réelles | implemented partiellement | garde d'artefact + certification écran/API tenant vierge et peuplé |
| O7 — release reproductible | specified | pipeline au commit candidat + smoke prod/staging |

## 8. Changement de cap

Toute modification du fournisseur de publication, réactivation de Mistral V3, ajout de périmètre ou
affaiblissement d'un critère DoD exige : décision écrite, impact sur la matrice de flags, nouveau
critère d'acceptation et preuve de non-régression. Une discussion orale ou un worktree existant ne
constitue pas une décision.
