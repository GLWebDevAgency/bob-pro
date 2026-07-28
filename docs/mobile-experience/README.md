# Programme d'excellence de l'expérience mobile Bob

> Statut : **Proposed — dossier de conception, aucun code associé**
> Dernière mise à jour : 2026-07-23
> Périmètre : application mobile Expo/React Native Bob Pro
> Audience : produit, design, mobile, QA, accessibilité, contenu, sécurité et direction

## Objet

Ce dossier transforme l'audit visuel et motion du 22 juillet 2026 en un programme de livraison
exécutable. Il décrit ce que Bob doit devenir, dans quel ordre, avec quelles frontières techniques,
quels critères d'acceptation et quelles preuves de qualité.

Le programme vise une expérience de référence, comparable en finition aux meilleures applications
natives, sans :

- modifier les règles métier, financières, fiscales ou de sécurité ;
- inventer un succès, une progression ou un état qui n'existe pas réellement ;
- retarder une action backend pour terminer une animation ;
- recopier Siri, Gemini, ChatGPT ou un langage visuel tiers ;
- transformer Bob en démonstration de glassmorphism ou en catalogue d'effets.

La règle directrice est : **animer la causalité, l'état et la continuité spatiale ; préserver le
contrôle et la vérité du système**.

## Hiérarchie d'autorité

En cas de contradiction, l'ordre suivant s'applique :

1. invariants légaux, financiers, de sécurité, de consentement et comportement du code canonique ;
2. ADR acceptés et dernier cap de publication fondateur intégré à la branche canonique ;
3. contrats fonctionnels, de confirmation et de ton qui n'ont pas été supersédés ;
4. décisions `Accepted` du présent dossier ;
5. implémentation courante comme baseline factuelle, vérifiée au commit indiqué ;
6. handoff, prototypes et guides visuels historiques comme intention de référence ;
7. propositions `Proposed` du présent dossier ;
8. exemples visuels et valeurs indicatives.

Une proposition UX n'autorise jamais à contourner une confirmation, une révision, un ACK backend,
une règle RLS, une politique d'entitlement ou une dégradation fail-closed.

Le cap de publication accepté est désormais intégré à la branche canonique via
[OBJECTIFS_SPECS_DOD_PUBLICATION](../../design_handoff_bob_pro/OBJECTIFS_SPECS_DOD_PUBLICATION.md)
et
[l'ADR fournisseur de publication](../adr/0004-gpt-realtime-publication-mistral-v3-post-v1.md).
Cette intégration satisfait la dépendance documentaire, mais **ne lève pas à elle seule
D00/GATE-PUBLICATION** : le présent dossier reste préparatoire jusqu'au rescoping explicite du
feature freeze et à l'affectation des responsables exigés.

## Carte documentaire

| Document | Rôle | Lecteurs prioritaires |
| --- | --- | --- |
| [00 — Baseline](00-audit-baseline.md) | Fige l'état actuel, les notes, les preuves et la cible mesurable. | Tous |
| [01 — Vision](01-experience-vision.md) | Définit la direction artistique, les principes et les anti-patterns. | Produit, design, mobile |
| [02 — Roadmap](02-roadmap.md) | Ordonne les phases, jalons, dépendances, gates et scénarios de capacité. | Direction, produit, delivery |
| [03 — Système motion](03-motion-interaction-system.md) | Spécifie timings, ressorts, transitions, haptique et comportement réduit. | Design, mobile, QA |
| [04 — Navigation et surfaces](04-navigation-scroll-surfaces.md) | Spécifie routes, tabs, headers, scroll, sheets, menus, verre et adaptation. | Design, mobile |
| [05 — Bob Live](05-bob-live-experience.md) | Définit la signature vocale, la machine visuelle et les retours multimodaux. | Voix, design, mobile, QA |
| [06 — Écrans](06-screen-by-screen-spec.md) | Donne les exigences des 33 surfaces, correspondant à 32 routes physiques plus l'expérience auth agrégée. | Produit, design, mobile |
| [07 — Content design](07-content-design.md) | Cadre statuts, confirmations, erreurs, ton et texte temporel. | Produit, contenu, juridique |
| [08 — Accessibilité](08-accessibility-adaptive-design.md) | Spécifie Dynamic Type, contraste, lecteurs d'écran, motion et adaptation. | Accessibilité, design, QA |
| [09 — Architecture](09-technical-architecture.md) | Définit les frontières, modules, états, dépendances et stratégie de migration. | Tech leads, mobile, voix |
| [10 — Performance](10-performance-observability.md) | Fixe budgets, métriques, instrumentation et critères de rollback. | Mobile, SRE, QA |
| [11 — Tests](11-test-strategy.md) | Définit la pyramide de tests, la matrice appareils et les preuves attendues. | QA, mobile, design |
| [12 — Definition of Done](12-definition-of-done.md) | Donne les checklists binaires globales, composant, écran et Bob Live. | Tous les builders/reviewers |
| [13 — Gouvernance](13-delivery-governance.md) | Définit rôles, revues, flags, rollout, change control et rituels. | Produit, design, engineering |
| [14 — Risques](14-risk-register.md) | Registre les risques, signaux, propriétaires et mitigations. | Direction, leads |
| [15 — Traçabilité](15-traceability-matrix.md) | Garantit la couverture de G01–G22, V01–V14, S01–S33 et T01–T08. | PM, QA, audit |
| [16 — Backlog](16-implementation-backlog.md) | Décompose le programme en epics, work packages, dépendances et règles de découpage testables. | Delivery, engineering |
| [17 — Références](17-references.md) | Centralise sources normatives, documentation technique et caveats de version. | Tous |
| [18 — Preuves](18-evidence-register.md) | Enregistre owner, statut, manifest, build, verdict, reviewers et waivers pour 77/77. | QA, release, audit |
| [19 — Glossaire](19-glossary.md) | Fixe le sens des termes produit, delivery, runtime et design employés. | Tous |
| [ADR UX](adr/README.md) | Capture les décisions d'architecture proposées et leurs alternatives. | Architecture, mobile, design |

## Métadonnées et propriétaires documentaires

Sauf override explicite, les constats de code de ce dossier héritent du snapshot `2515ddf3` et de
la date de formalisation 2026-07-23 ; les références web ont été vérifiées le 2026-07-22. Une
modification de code ou de dépendance n'actualise pas automatiquement ce snapshot : le reviewer doit
mettre à jour le document concerné et le registre ci-dessous.

Un owner rôle n'est pas un owner effectif. Toutes les lignes restent **à affecter** parce que le
dossier est `Proposed`; aucune ne peut devenir `Accepted` avant qu'une personne nommée accepte la
responsabilité.

| Document | Owner rôle attendu | Owner nommé | Dernière référence |
|---|---|---|---|
| 00 Baseline | QA + Product Design | À affecter | code `2515ddf3` |
| 01 Vision | Design owner | À affecter | audit 2026-07-22 |
| 02 Roadmap | Product owner / delivery | À affecter | cap canonique de publication |
| 03 Motion | Design owner + Mobile | À affecter | code `2515ddf3` |
| 04 Navigation | Mobile tech lead + Design | À affecter | code `2515ddf3` |
| 05 Bob Live | Bob Live owner + Design | À affecter | code `2515ddf3`, cap canonique de publication |
| 06 Écrans | Product Design | À affecter | code `2515ddf3` |
| 07 Content | Content owner | À affecter | contrats existants au `2515ddf3` |
| 08 Accessibilité | Accessibility reviewer | À affecter | code `2515ddf3` |
| 09 Architecture | Mobile tech lead | À affecter | code `2515ddf3` |
| 10 Performance | QA/performance owner | À affecter | code `2515ddf3` |
| 11 Tests | QA owner | À affecter | stratégie 2026-07-23 |
| 12 DoD | QA owner + Product owner | À affecter | programme 2026-07-23 |
| 13 Gouvernance | Product owner | À affecter | programme 2026-07-23 |
| 14 Risques | Product + Tech leads | À affecter | programme 2026-07-23 |
| 15 Traçabilité | QA owner | À affecter | audit 77/77 |
| 16 Backlog | Delivery owner | À affecter | programme 2026-07-23 |
| 17 Références | Architecture owner | À affecter | web 2026-07-22, git 2026-07-23 |
| 18 Preuves | QA owner | À affecter | initialisé 2026-07-23 |
| 19 Glossaire | Content owner | À affecter | programme 2026-07-23 |
| UX-ADR-001–006 | Décideurs listés dans chaque ADR | À affecter | spikes futurs WP-0004 |

La mise à jour d'un owner nommé, d'un snapshot ou d'un statut se fait dans ce registre et dans
l'en-tête du document au même changement. Le registre est l'autorité si un ancien export diverge.

## Parcours de lecture

### Décision produit

Lire `00`, `01`, `02`, `12`, `14`, puis la matrice `15`.

### Implémentation mobile

Lire `01`, `03`, `04`, `08`, `09`, `10`, `11`, `12`, puis les ADR UX.

### Bob Live

Lire les ADR Bob Live existants, puis `05`, `07`, `08`, `10`, `11` et `12`.

### Conception d'un écran

Lire `06`, puis les règles transversales `03`, `04`, `07` et `08`. Aucun écran ne peut définir
seul un nouveau timing, une nouvelle matière, une nouvelle haptique ou un nouveau statut.

## Identifiants stables

| Préfixe | Domaine | Étendue |
| --- | --- | --- |
| `G` | Fondations globales | `G01` à `G22` |
| `V` | Bob Live et voix | `V01` à `V14` |
| `S` | Écrans et routes | `S01` à `S33` |
| `T` | Content design | `T01` à `T08` |
| `E` | Epic de delivery | `E00` à `E12` |
| `WP` | Work package de delivery, à découper s'il reste `XL` | `WP-####`, puis enfants immuables `WP-####-NN` |
| `UX-ADR` | Décision d'architecture de ce programme | Numérotation locale |

Ces identifiants ne sont jamais recyclés. Une exigence supprimée reste dans l'historique avec le
statut `Rejected`, `Deprecated` ou `Superseded`.

## Statuts documentaires

- `Draft` : structure incomplète ; ne peut pas alimenter un ticket.
- `Proposed` : proposition complète en attente de revue/validation.
- `Accepted` : contrat validé, implémentation autorisée.
- `In progress` : au moins un work package est en construction.
- `Verified` : implémentation et preuves satisfont la DoD.
- `Deferred` : exigence conservée mais reportée par décision signée, avec impact et date de réexamen.
- `Deprecated` : ne s'applique plus, historique conservé.
- `Superseded` : remplacé par une décision liée.
- `Rejected` : étudié mais volontairement non retenu.

Le présent dossier est `Proposed`. L'acceptation doit être explicite et peut être faite par lots ;
elle ne doit pas être déduite du démarrage d'un autre chantier.

## Règles non négociables

1. **Truth first** : l'UI dérive des états canoniques ; elle n'invente aucune phase.
2. **Backend first** : l'animation n'avance jamais un statut métier et ne bloque jamais un ACK.
3. **Native first** : utiliser le comportement plateforme lorsque sa sémantique correspond.
4. **Bob, pas un clone** : conserver la palette, les formes, les polices et la voix propres à Bob.
5. **Une chorégraphie dominante** : aucune page ne cumule plusieurs effets concurrents.
6. **Motion facultative** : chaque effet possède une variante Reduce Motion complète.
7. **Performance mesurée** : aucune sensation premium ne repose sur une animation non profilée.
8. **Accessibilité comme gate** : pas comme tâche de finition.
9. **Actions sensibles sobres** : aucune célébration avant résultat durable.
10. **Dégradation honnête** : matière, zoom, haptique et voix ont toujours un fallback.
11. **Clean Architecture** : le domaine et l'application restent indépendants de React Native.
12. **Feature flags** : les migrations de chrome, motion et Bob Live restent désactivables.

## Hors périmètre

- Refonte des règles de calcul, des use cases ou du modèle fiscal.
- Changement de provider de voix, de protocole ou d'autorité de session.
- Modification des entitlements ou des plans commerciaux.
- Refonte du site web ou de l'espace cabinet, sauf cohérence de tokens documentée.
- Nouvelle identité de marque complète.
- Implémentation de code dans le cadre de ce dossier.

## Conditions de démarrage d'un lot

Un lot ne peut passer à `In progress` que si :

- ses exigences et exclusions sont `Accepted` ;
- l'ADR correspondant est accepté lorsqu'une dépendance structurante change ;
- le mapping audit → work package → test est complet ;
- une capture ou vidéo baseline existe ;
- le support plateforme et le fallback sont connus ;
- le risque de concurrence avec un chantier actif est résolu ;
- le plan de mesure et le rollback sont écrits avant le premier changement visible.

## Maintenance

- Ne jamais réécrire silencieusement un ADR accepté ; le superséder.
- Mettre à jour la matrice de traçabilité dans le même changement que la spec.
- Mettre à jour le registre de preuves dans le même changement que le verdict d'un ID.
- Lier toute dérogation de motion, accessibilité ou performance à une décision explicite.
- Rejouer le reader test documentaire après toute modification structurante.
- Revalider les liens et versions Expo/React Native avant chaque phase d'implémentation.
