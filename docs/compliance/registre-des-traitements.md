# Registre des activités de traitement (RGPD art. 30)

Chaque traitement mis en œuvre par Bob Pro. « Base légale » au sens de l'art. 6 RGPD.

| # | Traitement | Finalité | Catégories de personnes | Catégories de données | Base légale | Conservation | Destinataires / sous-traitants |
|---|---|---|---|---|---|---|---|
| T1 | **Compte & authentification** | Créer et sécuriser l'accès | Utilisateurs (artisan, collaborateurs) | E-mail, identifiant, jeton de session (JWT) | Exécution du contrat | Durée du compte + purge après résiliation | Supabase (auth) |
| T2 | **Clients & devis/factures** | Établir devis/factures, suivre l'encours | Clients de l'artisan (B2B, B2G, particuliers) | Identité, adresse, SIREN/TVA, montants, historique | Exécution du contrat / obligation légale (facturation) | **10 ans** (art. L123-22 C. com.) | Supabase (DB, RLS) |
| T3 | **Documents & pièces** | Archiver PDF, Factur-X, reçus, justificatifs | Clients, fournisseurs | Fichiers, métadonnées, hash | Obligation légale (conservation) | **10 ans** | Supabase Storage (bucket privé, URLs signées) |
| T4 | **Paiements & encaissements** | Encaisser, générer des liens de paiement | Clients de l'artisan | Montant, statut, référence facture | Exécution du contrat | 10 ans (rapprochement) | Stripe (lien de paiement) |
| T5 | **Relances & e-mails sortants** | Relancer les impayés, envoyer devis/factures | Clients de l'artisan | E-mail, nom, montant, n° de pièce | Intérêt légitime (recouvrement) / contrat | Journal d'envoi borné | Brevo (e-mail transactionnel) |
| T6 | **Assistant IA (classification d'intention)** | Comprendre une commande et proposer l'action | Utilisateur (texte de la commande) | Texte de commande **minimisé** (PII incident masqué) | Intérêt légitime (assistance) — activable | Non persisté au-delà de la session de traitement | Anthropic (Claude) ou Zhipu (GLM), au choix ; **désactivable** (mode démo régex on-device) |
| T7 | **Voix (STT / TTS)** | Dicter une commande, écouter la réponse | Utilisateur | Audio (STT), texte (TTS) | Intérêt légitime — activable | **Audio non persisté** : STT → texte seulement | **Natif on-device par défaut (aucun cloud)** ; option cloud : Voxtral (Mistral, France) |
| T8 | **OCR de pièces** | Extraire les données d'un reçu/justificatif | Fournisseurs, tiers figurant sur la pièce | Image de la pièce, texte extrait | Exécution du contrat (saisie dépense) | Pièce conservée 10 ans ; extraction rattachée | Fournisseur OCR (voir sous-traitants) |
| T9 | **Trésorerie & tableau de bord** | Calculer disponible/versement, KPI | — (données agrégées de l'artisan) | Montants agrégés | Exécution du contrat | Vivant (recalculé) | Interne |
| T10 | **Journal comptable / grand livre** | Tenir les écritures en partie double, export cabinet | Clients (via écritures) | Comptes, débit/crédit, référence pièce | Obligation légale (comptabilité) | **10 ans** | Supabase (DB, RLS) |

## Mesures transverses (art. 32)

- **Cloisonnement multi-tenant** : Row Level Security Postgres `FORCE` + `WITH CHECK` sur `companyId` ; rôle applicatif non-superuser.
- **Minimisation IA** (T6) : `redactPII` masque e-mail/téléphone/IBAN/SIREN avant l'appel LLM cloud ; les références métier (n° de facture, nom client) nécessaires à l'exécution sont conservées.
- **Voix privée par défaut** (T7) : reconnaissance et synthèse **on-device** (gratuit, hors-ligne), sans transmission ; le cloud souverain (Voxtral FR) n'est activé qu'en option premium.
- **Accès documents** (T3) : jamais servis directement au device — l'API renvoie des URLs signées à TTL court (60–3600 s), scopées `companyId`.
- **Secrets** : clés LLM/paiement/e-mail uniquement côté serveur (jamais sur le device).

## Points de vigilance

- **T6 (LLM)** : si le fournisseur est hors-UE (Anthropic US), encadrer le transfert (CCT + mesures) ou privilégier un fournisseur UE / le mode démo on-device. Activer la rétention zéro côté fournisseur si disponible.
- **T8 (OCR)** : documenter le fournisseur retenu et sa localisation dans [sous-traitants.md](sous-traitants.md).
