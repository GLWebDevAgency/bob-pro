# Gouvernance de conception et de delivery

> Statut : **Proposed**

## Objectif

Éviter trois échecs fréquents : une refonte big bang, des effets ajoutés écran par écran sans
système, et une UI qui devance la vérité du backend.

## Rôles

| Rôle | Responsabilité | Veto sur |
| --- | --- | --- |
| Product owner/fondateur | Priorité, périmètre, acceptation des vagues. | Scope et changement de cap. |
| Design owner | Vision, hiérarchie, motion, prototypes et revue appareil. | Cohérence et surcharge visuelle. |
| Mobile tech lead | Architecture, dépendances, migration, performance et rollback. | Dette structurelle et risque runtime. |
| Bob Live owner | Contrat d'états, SLO, amplitude, transcript et interruption. | Faux état et régression audio. |
| QA owner | Matrice, preuves, non-régression et release verdict. | Gate non prouvé. |
| Accessibility reviewer | Grandes polices, lecteurs d'écran, motion, contraste. | Perte d'accès ou d'information. |
| Content owner | Statuts, erreurs, confirmations et personnalités. | Copy fausse ou ambiguë. |
| Security/finance reviewer | Consentement, actions sensibles et vérité des montants. | Affaiblissement d'un invariant. |

Une même personne peut porter plusieurs rôles dans une petite équipe, mais les cases de revue
restent distinctes et explicites.

## Artefacts obligatoires par work package

1. lien vers les IDs audit ;
2. état actuel et résultat attendu ;
3. diagramme d'états ou parcours ;
4. maquette entrée, sortie, interruption et erreur ;
5. contrat Reduced Motion/Transparency ;
6. critères d'acceptation binaires ;
7. plan de tests et appareils ;
8. budget performance ;
9. flag, fallback et rollback ;
10. risques métier et dépendances ;
11. preuves avant/après ;
12. décision ou dérogation ADR lorsque nécessaire.

## Cycle d'une tranche

```text
Specified → Reviewed → Accepted → Implementing → Device QA → Canary → Verified
       ↘ Rejected       ↘ Blocked        ↘ Rolled back
```

### Specified

Les états et exclusions sont écrits. Aucun ticket “améliorer l'animation” sans résultat observable
et critère d'arrêt n'est recevable.

### Reviewed

Design, mobile, QA, accessibilité et owner métier ont commenté. Pour Bob Live, l'owner runtime est
obligatoire.

### Accepted

Le product owner accepte le périmètre et l'architecture nécessaire. Une spec `Proposed` ne suffit
pas.

### Implementing

Les claims Git sont pris, les fichiers partagés ont un seul owner, le flag est OFF par défaut.

### Device QA

Le comportement est observé en build release sur appareils cibles, avec modes système.

### Canary

Le slice est activé sur un ring borné avec métriques et rollback.

### Verified

La DoD est signée, la matrice indique l'attendu et le registre de preuves contient owner, manifest,
build, reviewers et verdict admissible.

## Change control

Un nouvel ADR est requis pour :

- adopter ou remplacer le runtime motion principal ;
- changer la stratégie tabs/navigation/sheets ;
- exposer de nouveaux événements runtime à la présentation Bob Live ;
- définir la politique thème sombre ou apparence adaptative ;
- introduire ou modifier la politique haptique, surtout pendant capture/playback audio ;
- introduire Skia comme dépendance produit ;
- modifier le modèle de feature flags ou le rollout ;
- déroger à un budget performance ou accessibilité.

Un ADR n'est pas requis pour une animation d'écran conforme aux tokens et patterns acceptés.

## Gouvernance des tokens

- Les tokens sémantiques sont ajoutés à `packages/tokens`, pas dans les écrans.
- Un token n'est accepté que s'il sert au moins deux usages ou un moment signature documenté.
- Les durées ne portent pas le nom d'un écran ; elles portent un rôle.
- Une modification de valeur inclut une liste des consommateurs et des captures.
- Les tokens de statut ne changent jamais de signification selon le thème.
- Toute couleur doit avoir une variante de contraste et une alternative non colorée.

## Gouvernance des composants

- `packages/ui` possède les primitives génériques.
- `apps/mobile` possède la composition et les moments spécifiques Bob.
- Les composants historiques sont marqués deprecated avant suppression.
- Aucun nouvel usage d'un composant deprecated.
- Une migration peut laisser coexister ancien et nouveau uniquement derrière un plan borné.
- La galerie de composants documente nominal, press, disabled, loading, success, error, grandes
  polices et Reduced Motion.

## Règle de vérité de statut

Chaque état visible doit avoir une source nommée :

| État UI | Source admise |
| --- | --- |
| Pending local | Commande créée et non terminée, avec identifiant stable. |
| Pending serveur | Requête/mission reconnue ou état autoritaire relu. |
| Success | ACK ou relecture durable, jamais timer. |
| Error | Erreur typée ou timeout explicitement transformé en état inconnu/récupérable. |
| Reconnecting | Transport réellement en reprise. |
| Listening | Capture autorisée et active. |
| Speaking | Playback effectivement actif. |
| Completed | État terminal du use case/mission. |

Un statut sans source est soit supprimé, soit rendu indéterminé avec un texte honnête.

## Feature flags

Les flags sont organisés par capability, pas par composant décoratif :

- `mobile_adaptive_chrome_v1` ;
- `mobile_motion_primitives_v1` ;
- `mobile_native_sheets_v1` ;
- `mobile_tabs_experiment_v1` ;
- `bob_live_visual_state_v1` ;
- `mobile_screen_<domain>_v1` pour les migrations à risque.

Contraintes :

- OFF par défaut dans la première build contenant le code ;
- résolution serveur ou configuration signée pour les flags de rollout ;
- fallback testé et maintenu pendant la fenêtre canary ;
- analytics séparant ancien/nouveau ;
- suppression du flag seulement après stabilité et migration complète ;
- aucun flag ne modifie une autorisation ou un entitlement métier.

## Revue de design sur appareil

La revue doit comparer :

- source et destination de la transition ;
- premier frame, frame intermédiaire et frame final ;
- interruption au milieu ;
- retour arrière ;
- 60 Hz et, si disponible, 120 Hz ;
- Reduce Motion ;
- grand texte ;
- fond clair/sombre selon contrat ;
- perte réseau ou réponse lente ;
- Android médian, pas seulement simulateur iOS.

## Reader test documentaire

Avant acceptation d'une vague, un lecteur sans contexte doit pouvoir répondre :

1. Quel problème résout cette tranche ?
2. Quel état métier commande chaque animation ?
3. Que voit-on si l'animation est désactivée ?
4. Quel composant ou écran est propriétaire ?
5. Comment prouve-t-on la performance ?
6. Que se passe-t-il sur un ancien OS ?
7. Comment revient-on en arrière ?
8. Quelle action sensible pourrait être affectée ?
9. Quelles preuves autorisent le rollout ?
10. Quels IDs audit sont fermés ?

Une réponse impossible indique une spec incomplète.

## Coordination multi-agent

- `git status`, les refs `agents/*`, claims et diffs sont la vérité.
- Un seul writer par fichier ou famille de composants.
- L'autre agent peut reviewer en lecture seule.
- Les lots restent petits et atomiques.
- Aucun reset, checkout destructeur ou reformatage transversal.
- Un handoff liste chemins, état, validations et risques.
- Les documents de processus ne sont pas auto-committés avec un lot produit sans demande.
