# ADR 0005 — PA externe portable, B2Brouter eDocSync candidat prioritaire

- **Statut** : Accepted pour l'architecture ; fournisseur conditionné au gate G-PA-01
- **Date** : 2026-07-21

## Contexte

Bob sait construire, valider, afficher et archiver ses factures, mais ne dispose pas d'un adapter
réel vers une Plateforme Agréée. Reconstruire l'Annuaire, les flux DGFiP, l'interopérabilité PA,
Peppol, les statuts CDAR et le e-reporting créerait une activité réglementée distincte de notre
différenciateur produit.

B2Brouter publie une offre eDocSync destinée aux éditeurs en marque blanche et une API couvrant
ces responsabilités. Il figure dans la liste officielle DGFiP consultée le jour de la décision.

## Décision

Bob s'adosse à une PA via un port anti-corruption provider-neutral et ne devient pas PA pour la
première version. B2Brouter est le candidat d'intégration initial, sous réserve du gate défini dans
`design_handoff_bob_pro/SPEC_CONNECTEUR_PA_B2BROUTER.md`.

Le domaine Bob reste la source de vérité de la facture. La PA est la source de vérité du transport
réglementaire. Bob conserve une copie immuable et hashée du document légal exact retourné par la
PA et de son historique de statuts.

## Conséquences

- accélération forte du chemin légal sans abandonner l'UX et la marque Bob ;
- dépendance commerciale et opérationnelle contenue derrière un port remplaçable ;
- maintien nécessaire de nos invariants, de notre archive et de nos validations ;
- interdiction de promettre une transmission/e-reporting automatique avant certification sandbox
  et production ;
- besoin d'une outbox/inbox et d'une réconciliation, l'API distante restant asynchrone.

## Alternatives rejetées

- **Devenir PA maintenant** : hors différenciateur, délai et charge réglementaire incompatibles
  avec la publication.
- **Coupler directement l'UI à B2Brouter** : fuite du fournisseur dans le produit, perte de
  testabilité, de sécurité tenant et de réversibilité.
- **Supprimer le moteur Factur-X Bob** : perte d'aperçu/export, de contrôle métier, d'archive
  indépendante et de portabilité.
