# Conformité RGPD — Bob Pro

Documentation de gouvernance des données personnelles pour Bob Pro (copilote administratif et financier
des artisans, indépendants et TPE françaises). Bob traite des données professionnelles **et** personnelles
(un artisan en entreprise individuelle est une personne physique ; ses clients particuliers aussi).

> Ces documents décrivent l'état **réel** du produit tel qu'implémenté dans ce dépôt. Ils sont vivants :
> toute nouvelle finalité, tout nouveau sous-traitant ou flux transfrontalier doit y être ajouté avant mise en production.

## Documents

- [Registre des activités de traitement](registre-des-traitements.md) — RGPD art. 30 : finalités, bases légales, durées, catégories de données.
- [Registre des sous-traitants](sous-traitants.md) — prestataires (hébergement, IA, voix, paiement, e-mail) : rôle, données, localisation, base légale, DPA.
- [DPIA — IA, OCR et voix](dpia-ia.md) — analyse d'impact du traitement algorithmique (classification d'intention, extraction OCR, transcription/synthèse vocale).

## Principes appliqués dans le produit (par conception)

| Principe RGPD | Implémentation dans le code |
|---|---|
| **Minimisation** (art. 5.1.c) | `redactPII` masque e-mail / téléphone / IBAN / SIREN-SIRET **avant** tout envoi au LLM cloud ([packages/ai/src/guardrails/pii-redaction.ts](../../packages/ai/src/guardrails/pii-redaction.ts)). La voix est **native on-device par défaut** (aucun envoi cloud). |
| **Cloisonnement / intégrité** (art. 32) | RLS Postgres `FORCE ROW LEVEL SECURITY` multi-tenant (rôle applicatif non-superuser `bob_app`) ; accès documents via URLs signées à durée courte ; jamais de service-role key sur le device. |
| **Souveraineté / localisation** | Base + stockage Supabase région **eu-west-3 (Paris)** ; voix cloud = Voxtral (Mistral, France). |
| **Limitation de conservation** (art. 5.1.e) | Factures et pièces conservées **10 ans** (obligation fiscale/commerciale) ; l'audio vocal n'est **pas** persisté (transcription → texte). |
| **Exactitude / non-invention** | Bob n'invente jamais un montant : garde-fou `renderWithGuard` + montants issus du domaine déterministe uniquement. |
| **Traçabilité** (responsabilité, art. 5.2) | Journal d'actions append-only immuable et rejouable de l'agent ; écritures comptables en partie double. |

## Rôles

- **Responsable de traitement** : l'artisan/entreprise cliente pour les données de *ses* clients ; l'éditeur de Bob Pro pour les données de compte/usage.
- **Sous-traitant** (art. 28) : l'éditeur de Bob Pro vis-à-vis du client, pour l'hébergement et le traitement de ses données métier. Les prestataires listés sont des **sous-traitants ultérieurs**.

## À faire avant production (checklist gouvernance)

- [ ] Signer les DPA (art. 28) avec chaque sous-traitant listé.
- [ ] Publier une politique de confidentialité et une information des personnes (art. 13/14).
- [ ] Mettre en place le circuit d'exercice des droits (accès, rectification, effacement dans les limites légales de conservation).
- [ ] Vérifier les clauses de transfert hors UE pour tout sous-traitant non-UE (LLM notamment) : CCT + mesures supplémentaires, ou option de désactivation.
