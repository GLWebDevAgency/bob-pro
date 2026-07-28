# UX-ADR-004 — Apparence adaptative et matières

## Statut

Proposed — 2026-07-23

## Décideurs attendus

Design owner, Mobile tech lead, Product owner, Accessibility reviewer et QA. Décision initiale en
Vague 0 ; l'activation sombre complète exige une décision de rollout distincte après certification.

## Contexte

L'app déclare une apparence système automatique, mais les surfaces et la StatusBar ne suivent pas
un contrat clair/sombre complet. Les APIs blur/verre peuvent améliorer le chrome sur certains OS,
mais ne sont pas disponibles uniformément et peuvent réduire contraste et performance.

## Drivers

- lisibilité immédiate des barres système ;
- rôles sémantiques de couleur ;
- support Reduce Transparency/Increase Contrast ;
- identité Bob préservée ;
- fallback stable iOS/Android ;
- aucun glassmorphism de contenu.

## Options

### A — Forcer le mode clair

Rapide, cohérent et sûr ; ne satisfait pas une ambition sombre complète.

### B — Laisser `automatic` sans refonte des rôles

Rejeté : produit un pseudo-mode adaptatif et des contrastes non contrôlés.

### C — Thème adaptatif complet, livré par étapes

Rôles canvas/content/chrome/status et surfaces système, avec force-light possible jusqu'à
certification complète.

## Preuves minimales pour accepter la décision

- inventaire de chaque famille de surface et des ruptures StatusBar actuelles ;
- comparaison chiffrée force-light durable vs thème sémantique complet ;
- prototype de tokens canvas/content/chrome/status en clair, sombre et contraste augmenté ;
- démonstration Reduce Transparency et fallback opaque sur surfaces candidates ;
- estimation QA/performance et décision Product/Design/Mobile/Accessibilité.

## Décision proposée

Retenir C avec gate :

1. corriger StatusBar et choisir explicitement force-light pour le train initial ;
2. définir les rôles light/dark/high-contrast ;
3. certifier toutes les routes prioritaires ;
4. activer `automatic` uniquement lorsque le thème complet est prêt ;
5. verre/blur réservés au chrome, sélectionnés par capability ;
6. Reduce Transparency impose un fallback opaque.

## Algorithme de surface

```text
reduceTransparency → opaque
sinon chrome éligible + glass runtime → glass
sinon chrome éligible + blur supporté + budget tenu → blur
sinon → opaque
```

## Conséquences

Positives : cohérence système, accessibilité, progression sans big bang.
Négatives : double palette à concevoir, QA importante, matières variables par OS.

## Critères de vérification de l'implémentation

- [ ] StatusBar/navigation bar lisibles sur chaque route.
- [ ] Aucun état automatique partiel.
- [ ] Contrastes certifiés light/dark/high contrast.
- [ ] Reduce Transparency sans différence fonctionnelle.
- [ ] Aucune carte métier dépend du verre.
- [ ] GPU et batterie mesurés avec blur/verre.

## Réexamen

Revoir le choix force-light lorsque toutes les routes critiques et surfaces tierces possèdent des
preuves dark mode.
