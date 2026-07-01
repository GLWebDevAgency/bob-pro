# Registre des sous-traitants ultérieurs (RGPD art. 28)

Prestataires traitant des données personnelles pour le compte de Bob Pro. Un DPA (Data Processing Agreement)
doit être signé avec chacun avant mise en production.

| Sous-traitant | Rôle | Données traitées | Localisation | Base du transfert | DPA | Désactivable |
|---|---|---|---|---|---|---|
| **Supabase** (Postgres + Storage + Auth) | Hébergement base, stockage documentaire, authentification | T1–T3, T10 (comptes, clients, factures, documents, écritures) | **UE — eu-west-3 (Paris)** | Intra-UE (pas de transfert) | À signer | Non (cœur d'infra) |
| **Mistral AI — Voxtral** (STT/TTS cloud) | Transcription / synthèse vocale premium | Audio (STT) / texte (TTS) — **audio non persisté** | **France / UE** | Intra-UE | À signer | **Oui** — voix native on-device par défaut |
| **Anthropic (Claude)** *ou* **Zhipu (GLM)** | LLM de classification d'intention | Texte de commande **minimisé** (PII incident masqué par `redactPII`) | Anthropic : **hors-UE (US)** · GLM : hors-UE | CCT + mesures supplémentaires (Anthropic) | À signer | **Oui** — mode démo régex 100 % on-device |
| **Stripe** | Liens de paiement, encaissement | Montant, référence facture, statut | UE (entité Stripe UE) + flux internationaux | CCT le cas échéant | À signer | Oui (fonctionnalité paiement en ligne) |
| **Brevo** (ex-Sendinblue) | E-mail transactionnel (relances, envoi de pièces) | E-mail, nom, montant, n° de pièce | **UE (France)** | Intra-UE | À signer | Oui (repli : notifier local d'audit sans envoi) |
| **Fournisseur OCR** *(à confirmer)* | Extraction de données des reçus/justificatifs | Image de pièce, texte extrait | À documenter | À documenter | À signer | Oui (saisie manuelle) |

## Mesures de minimisation par sous-traitant

- **LLM (Anthropic/GLM)** — c'est le point de transfert le plus sensible. Atténuations en place :
  - `redactPII` masque e-mail, téléphone, IBAN, SIREN/SIRET **avant** l'envoi (voir [pii-redaction.ts](../../packages/ai/src/guardrails/pii-redaction.ts)).
  - Seul le **texte de commande** est transmis (pas la base clients ni les documents) — aucun contexte massif injecté.
  - Le LLM ne fait que de la **classification d'intention** (tool-calling) ; il ne produit ni montant ni décision métier (le domaine déterministe exécute).
  - **Désactivable intégralement** : sans clé, le routeur bascule en classification régex **on-device** — zéro donnée sortante.
- **Voix (Voxtral)** — activée en option ; par défaut la reconnaissance/synthèse est **on-device** (aucune transmission). En mode cloud, l'audio n'est pas conservé (transcription → texte).
- **Documents (Supabase Storage)** — bucket privé ; accès uniquement via URLs signées à TTL court générées côté serveur ; RLS sur les métadonnées.

## Recommandations

1. Privilégier un LLM **hébergé UE** (Mistral) pour la classification, afin d'éliminer le transfert hors-UE — la couche `redactPII` et le mode on-device restent des filets de sécurité.
2. Confirmer et documenter le **fournisseur OCR** et sa localisation.
3. Conserver la liste à jour : tout nouveau prestataire traitant des données personnelles = nouvelle ligne + DPA avant activation.
