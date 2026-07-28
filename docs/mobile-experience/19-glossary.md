# Glossaire du programme mobile experience

Statut : **Proposed**
Owner attendu : Content owner · **à affecter**
Dernière mise à jour : 2026-07-23

Ce glossaire fixe le sens des termes employés dans ce dossier. Lorsqu'un terme du backend possède
une définition canonique plus précise, celle-ci prévaut ; la définition ci-dessous explique son
usage dans le programme d'expérience.

| Terme | Définition opérationnelle dans ce programme |
|---|---|
| ACK | Accusé de réception autoritatif attestant qu'une commande a été reconnue. Il ne prouve pas toujours que l'état final est durable ; la spec indique alors une relecture. |
| Relecture serveur | Nouvelle lecture de l'objet ou de la mission depuis la source autoritative après une mutation, pour confirmer le résultat visible. |
| Source autoritative | Système qui a le droit de déclarer un fait : domaine/backend, session runtime, player audio, permission OS, etc. L'animation n'est jamais une source. |
| Vérité UI | Correspondance exacte entre l'état visible et la source autoritative, y compris `pending`, `unknown`, erreur et donnée périmée. |
| Succès autoritatif | Succès affiché seulement après l'ACK/relecture requis par le cas d'usage, jamais au tap ou après un timer. |
| État `unknown` | Le résultat d'une action ne peut pas être confirmé, typiquement après timeout. Ce n'est ni succès ni échec ; l'UI propose vérification/retry sûr. |
| Optimisme borné | Mise à jour locale réversible autorisée par le contrat, avec rollback si le serveur refuse. Interdit pour les états sensibles non réversibles. |
| Idempotence | Propriété garantissant qu'une répétition sûre de la même commande ne crée pas un second effet métier. |
| Mission | Unité de travail agentique Bob, avec état, contexte, confirmations et résultat ; pas un simple message visuel. |
| Interaction typée | Proposition/choix/confirmation/action structurée que voix et toucher peuvent résoudre par le même cas d'usage. |
| Projection | Fonction pure qui transforme un état canonique en view model visuel, sans exécuter d'action ni modifier la source. |
| View model | État prêt à rendre : phase, libellé, actions permises et données déjà normalisées. Il n'a pas d'autorité métier. |
| Provider-neutral | Contrat qui ne dépend pas du nom ou du payload d'un fournisseur vocal/IA particulier. |
| Renderer | Implémentation de présentation choisie pour une capability, par exemple Bob visuel legacy ou v2. Il ne désigne pas le transport. |
| Overlay | Surface superposée à la navigation courante. L'overlay Bob est global, unique, contextuel et non obstructif. |
| Barge-in | Interruption de la parole de Bob par l'utilisateur ; le feedback visuel revient immédiatement vers l'écoute sans retarder l'arrêt audio. |
| VAD | Détection d'activité vocale issue du pipeline audio. Elle peut piloter l'état `user_speaking`, jamais un succès métier. |
| Amplitude éphémère | Niveau audio normalisé utilisé momentanément pour le rendu, sans persistance, analytics ou reconstruction de parole. |
| Voice Trace | Autorité de mesure des événements et SLO vocaux, corrélée au renderer sans contenu vocal. |
| SLO | Objectif mesurable de niveau de service, par exemple latence voix ou interruption. Une moyenne visuelle ne le remplace pas. |
| Streaming par blocs | Regroupement de deltas de réponse en phrases/blocs pour limiter les rendus ; exclut l'effet machine à écrire caractère par caractère. |
| Capability | Capacité optionnelle détectée et encapsulée, telle que Glass, Blur, haptique ou Zoom ; elle possède un fallback fonctionnel. |
| Fallback | Comportement sûr et complet utilisé quand une API, un OS, une préférence ou un budget ne permet pas l'enrichissement. |
| Progressive enhancement | Ajout d'un effet sur plateforme capable sans en faire une dépendance du parcours ou du sens. |
| Legacy | Implémentation actuelle conservée temporairement comme fallback pendant une migration bornée. Ce terme ne signifie pas « cassé ». |
| Feature flag | Configuration activant une capability ou un slice pour un public déterminé, sans changer permissions, entitlements ou vérité métier. |
| Kill switch | Contrôle permettant de désactiver immédiatement le nouveau renderer/capability et de revenir au fallback testé. |
| Slice | Tranche verticale bornée incluant design, code, états, accessibilité, tests, performance, preuve, flag et rollback. |
| Epic | Domaine de delivery E00–E12 regroupant plusieurs work packages et exigences. |
| Work package / WP | Lot de delivery traçable. Un parent XL doit être découpé en enfants `WP-####-NN` avant sprint. |
| Gate | Condition d'entrée/sortie binaire. Les gates exécutables et leurs WP exacts vivent dans le backlog. |
| Vague | Séquence de roadmap ; elle exprime un ordre produit plus large qu'une dépendance de ticket. |
| Ring | Audience progressive de rollout R0–R4, de l'interne au général. |
| Canary | Activation limitée servant à mesurer le nouveau comportement avec rollback rapide. |
| Preview build | Build proche de la production destiné aux tests ; différent du mode développement et d'une release publique. |
| Build release | Binaire optimisé utilisé pour conclure sur performance/comportement natif. |
| Cold start | Démarrage sans processus/session préchauffé. |
| Warm run | Exécution répétée après initialisation, utilisée pour comparer des mesures équivalentes. |
| Baseline | Photographie reproductible avant changement : code, build, appareil, fixtures, captures et métriques. |
| `PERF-CALIBRATION` | Manifest signé qui fige appareils, scénarios, seuils, owners et rollback pour les métriques de la release. |
| Harness | Surface ou programme d'essai isolé servant à tester une primitive/décision sans l'intégrer à un parcours produit. |
| Spike | Prototype technique borné, jetable et non publié servant à rendre une décision ADR possible. |
| ADR | Architecture Decision Record : contexte, options, décision, conséquences et réexamen. `Accepted` autorise le choix ; `Verified` concerne l'implémentation. |
| DoD | Definition of Done : critères binaires qui ferment un lot ; « code mergé » n'est pas Done. |
| Definition of Ready | Conditions minimales avant démarrage d'un WP produit : scope, ADR, prototype, tests, mesure, owner et claim. |
| `N/A` | Valeur d'applicabilité d'une exigence ou d'un critère réellement non applicable selon la matrice DoD, justifiée et approuvée ; ce n'est jamais un verdict ni un moyen d'éviter un test difficile. |
| Waiver | Dérogation P2/P3 temporaire, signée, compensée et expirante ; interdite pour P0/P1 et bloqueurs automatiques. |
| `PASS-LIMITED` | Verdict avec limitation acceptée conforme au waiver ; alias de `PASS WITH ACCEPTED LIMITATION`. |
| Manifest de preuve | Fichier normatif qui relie un ID à commit, build, flags, appareils, tests, traces, reviewers et verdict. |
| Fixture | Donnée de test synthétique, stable et non productive utilisée pour rendre captures/tests reproductibles. |
| P0/P1/P2/P3 | Sévérité/priorité : P0 bloque vérité/sécurité/release ; P1 qualité principale ; P2 amélioration importante ; P3 exploration optionnelle. |
| Motion intent | Rôle sémantique d'un mouvement (`press`, `selection`, `layout`, etc.), distinct d'une durée codée dans un écran. |
| Reduced Motion | Préférence système réduisant translation, zoom, profondeur et boucles tout en conservant sens et actions. |
| Reduce Transparency | Préférence système imposant des surfaces plus opaques ; le fallback ne perd aucune fonction. |
| Crossfade | Fondu de remplacement sans déplacement spatial, utilisé notamment en mouvement réduit. |
| Hero transition | Transformation rare d'un objet vers son détail ; elle reste un enrichissement avec fallback push. |
| Card | Conteneur de contenu/action dans une page. Le mot ne désigne pas une présentation de route ; sur grande largeur on parle de panneau de détail. |
| Panneau de détail | Colonne master-detail iPad/grande fenêtre conservant route, focus et retour ; téléphone en push standard. |
| Sheet | Surface modale de tâche courte, à detents ou contenu, avec focus, clavier, fermeture et alternative accessible définis. |
| Detent | Position de hauteur stable d'une sheet. Le geste suit le doigt puis se stabilise sur un detent. |
| Scrim | Voile derrière une modalité, synchronisé mais distinct de la sheet ; il protège le focus et la hiérarchie. |
| Dirty state | Modifications réellement non enregistrées justifiant une confirmation avant fermeture. |
| Native Stack | Navigation de page pilotée par la stack native via Expo Router, avec geste Retour et historique système. |
| Deep link | URL ouvrant directement une route/état après validation session, tenant, permission et existence. |
| Restauration | Retour de route, onglet, scroll, focus, filtres et brouillon selon le contrat après back/background/restart. |
| RLS / tenant | Isolation de données côté backend. Aucun changement visuel ne peut affaiblir les règles d'accès par organisation. |
| Progressive disclosure | Présenter conclusion et action avant les détails, tout en gardant preuves métier/légales accessibles. |
| Action-first | Hiérarchie éditoriale centrée sur ce qui s'est passé, son impact et l'action suivante. |
| Matière fonctionnelle | Blur/verre réservé au chrome, contrôles et modalité ; jamais nécessaire à la lisibilité du contenu. |
| Pixel-perfect adaptatif | Cohérence exacte des relations, alignements et rythmes qui survit aux tailles de texte/écran ; pas des hauteurs rigides. |

## Règle de changement

Un terme critique nouveau est ajouté ici avant d'être utilisé dans plusieurs specs. Une définition
qui changerait un concept backend, légal ou sécurité doit être validée par l'owner canonique et ne
peut pas être modifiée uniquement par le content design.
