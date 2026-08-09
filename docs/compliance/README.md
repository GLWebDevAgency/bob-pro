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
| **Minimisation** (art. 5.1.c) | Sur le traitement textuel T6/classification, `redactPII` masque e-mail / téléphone / IBAN / SIREN-SIRET avant l'appel au LLM cloud ([packages/ai/src/guardrails/pii-redaction.ts](../../packages/ai/src/guardrails/pii-redaction.ts)). Ce garde ne couvre pas l'OCR T8 : le document fournisseur brut puis son markdown sont transmis à Mistral et doivent être gouvernés comme un flux distinct. Le repli de dictée classique impose le traitement local (`requiresOnDeviceRecognition`) et ne bascule jamais silencieusement vers le réseau ; sans modèle local, l'utilisateur poursuit par écrit. |
| **Cloisonnement / intégrité** (art. 32) | RLS Postgres `FORCE ROW LEVEL SECURITY` multi-tenant (rôle applicatif non-superuser `bob_app`) ; accès documents via URLs signées à durée courte ; jamais de service-role key sur le device. |
| **Souveraineté / localisation** | Base + stockage Supabase région **eu-west-3 (Paris)**. Le client courant neutralise sa préférence cloud, mais les routes Voxtral tour-par-tour V1 restent appelables par d'anciens binaires et doivent être certifiées ou fermées atomiquement. Bob Live reste un traitement distinct soumis à admission et information. |
| **Limitation de conservation** (art. 5.1.e) | Factures et pièces conservées **10 ans** (obligation fiscale/commerciale). La dictée classique ne crée aucun objet audio Bob. Bob Live ne persiste pas le PCM micro côté Bob, mais sa réponse TTS peut être déposée dans le bucket privé `bob-live-audio` : objet/feed disponible 15 min via URL signée ≤ 30 s, métadonnées jusqu'à 30 jours ; la purge objet de production reste un gate avant activation publique. |
| **Clôture ≠ effacement** | L'action in-app ferme l'accès, l'abonnement et les capacités publiques, puis tente la suppression Auth. Le dossier métier reste conservé : aucune purge/anonymisation complète n'est certifiée. La notice et l'UI l'indiquent explicitement. |
| **Exactitude / non-invention** | Bob n'invente jamais un montant : garde-fou `renderWithGuard` + montants issus du domaine déterministe uniquement. |
| **Traçabilité** (responsabilité, art. 5.2) | Journal d'actions append-only immuable et rejouable de l'agent ; écritures comptables en partie double. |
| **Télémétrie minimisée** | Sentry filtre les événements par liste blanche et désactive PII/traces ; EAS Observe collecte la performance avec un identifiant aléatoire d'installation. Ces canaux tiers restent soumis aux DPA/rétentions/régions et au mécanisme d'opposition à arrêter. |

## Rôles

- **Responsable de traitement** : l'artisan/entreprise cliente pour les données de *ses* clients ; l'éditeur de Bob Pro pour les données de compte/usage.
- **Sous-traitant** (art. 28) : l'éditeur de Bob Pro vis-à-vis du client, pour l'hébergement et le traitement de ses données métier. Les prestataires listés sont des **sous-traitants ultérieurs**.

## À faire avant production (checklist gouvernance)

- [ ] Signer les DPA (art. 28) avec chaque sous-traitant listé.
- [ ] Publier une politique de confidentialité et une information des personnes (art. 13/14).
- [ ] Mettre en place le circuit d'exercice des droits (accès, rectification, effacement dans les limites légales de conservation).
- [ ] Classifier les données conservées après clôture, fixer leurs durées, livrer une purge/anonymisation
      idempotente et une reprise durable de la suppression Auth ; tant que ce point est ouvert, ne pas
      présenter la clôture in-app comme une suppression complète du compte.
- [ ] Vérifier les clauses de transfert hors UE pour tout sous-traitant non-UE (OpenAI/Anthropic
      notamment) : CCT + mesures supplémentaires. Les parcours manuels sont une alternative d'usage,
      pas un interrupteur global de traitement tant qu'un tel contrôle n'est pas livré et certifié.
