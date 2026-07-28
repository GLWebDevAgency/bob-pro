# UX-ADR-005 — Performance et observabilité d'expérience

## Statut

Proposed — 2026-07-23

## Décideurs attendus

Mobile tech lead, QA/performance owner, Bob Live owner et Security/Privacy. Décision attendue avant
toute instrumentation de la Vague 1.

## Contexte

La qualité motion ne peut pas être certifiée par captures statiques. Bob Live partage CPU, audio,
réseau et rendu ; une surface visuelle peut dégrader le premier audio ou le barge-in. La
télémétrie ne doit toutefois exposer ni client, montant, transcript, audio ou arguments outil.

## Drivers

- preuve release sur appareils ;
- budgets 60/120 Hz ;
- corrélation avec Voice Trace sans données sensibles ;
- canary et rollback ;
- faible cardinalité et coût maîtrisé.

## Options

### A — Validation subjective seulement

Rejetée : non reproductible et masque les régressions appareil/réseau.

### B — Télémétrie détaillée avec contexte écran complet

Rejetée : risque PII, forte cardinalité et confusion entre UX et métier.

### C — Métriques sémantiques allowlistées + profiling appareil

Mesure catégories de transition, phase normalisée, frames et versions de flag, corrélées par IDs
techniques pseudonymisés.

## Preuves minimales pour accepter la décision

- baseline reproductible sur les scénarios critiques et appareils disponibles ;
- schéma d'événements proposé avec cardinalité, sampling, rétention et owner ;
- revue Security/Privacy confirmant l'absence de PII, contenu, montant, audio et transcript ;
- maquette de dashboard/alertes et plan de corrélation Voice Trace sans payload ;
- runbook de flag/rollback rédigé, même si le canary n'est pas encore exécuté.

## Décision proposée

Retenir C :

- budgets définis dans `10-performance-observability.md` ;
- instrumentation sans route paramétrée ni contenu ;
- profiling release manuel/automatisé ;
- comparaison baseline avant/après ;
- Voice Trace reste autorité SLO voix ;
- alertes/rollback par flag et version renderer.

## Données autorisées

- nom allowlisté du scénario/transition ;
- durée et classes de slow frames ;
- OS, version app, renderer/flag et classe appareil bornée ;
- phase Bob normalisée sans contenu ;
- résultat technique success/error/cancelled.

## Données interdites

- route avec ID, nom client, document, montant ;
- transcript, audio, amplitude fine ;
- texte d'erreur brut fournisseur ;
- arguments/résultat d'outil ;
- secret, token ou identifiant tenant brut.

## Critères de vérification de l'implémentation

- [ ] Schéma d'événements privacy-reviewed.
- [ ] Baseline et seuils d'alerte définis.
- [ ] Profiling iPhone 60 Hz, ProMotion et Android médian.
- [ ] Corrélation Voice Trace sans payload sensible.
- [ ] Dashboard distingue ancien/nouveau renderer.
- [ ] Rollback canary exercé.

## Réexamen

Réexaminer lors d'un changement d'outil d'observabilité, de politique de rétention, de SLO voix,
de classe d'appareil cible ou si la cardinalité/coût dépasse les limites acceptées. Toute extension
de données collectées exige une nouvelle revue Privacy/Security.
