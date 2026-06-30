# Bob en mode vocal — le « Jarvis » de l'artisan

> Principe : la **voix n'est qu'un canal d'entrée**. `voix → transcription (STT natif/cloud) → MÊME cerveau Bob (classifieur LLM → outils) → action`. Tout ce que Bob fait passe par les **mêmes use cases** que l'UI manuelle (parité). Garde-fous toujours actifs : périmètre strict (admin/finance), `parse` des arguments, money-guard (aucun montant inventé), et **politique d'autonomie** (auto / recommandé / tout-confirmer) — les actions sortantes/sensibles demandent confirmation (modale de choix).

Statut : ✅ = fonctionne aujourd'hui · 🧭 = Bob **ouvre le bon écran** (navigation) · ⏳ = prévu (tool à brancher).

## Tableau de rapprochement — ce que permet l'app ↔ ce que Bob fait à la voix

| Capacité de l'app | Exemple de commande vocale | Bob aujourd'hui | Mécanisme |
|---|---|---|---|
| Marquer une facture encaissée | « encaisse la facture 2026-014 » / « la facture de Durand est réglée » | ✅ exécute (confirme selon l'autonomie) | `encaisser_facture` → use case RegisterPayment |
| Lister les impayés | « mes factures impayées » | ✅ répond | `factures_impayees` |
| Préparer une relance | « prépare une relance » | ✅ rédige un brouillon (n'envoie pas) | `relance_brouillon` |
| Combien je peux me verser | « combien je peux me verser ce mois ? » | ✅ répond (montant du domaine) | `tresorerie_versement` |
| Enchaîner plusieurs actions | « encaisse Durand **puis** Martin » | ✅ plan multi-étapes (lot confirmé selon l'autonomie) | runMulti (batch) |
| Lever une ambiguïté | « marque comme payé » (plusieurs factures) | ✅ propose des **boutons de choix** | `choices` (modale) |
| **Scanner un reçu / ticket / justificatif** | « salut Bob, je viens d'acheter des fournitures pour le chantier, **scanne ce reçu** » | 🧭 **ouvre l'OCR caméra** | `ouvrir_scan_recu` → `/scan-document` (OCR → dépense) |
| Ouvrir un nouveau devis | « fais-moi un devis » | 🧭 **ouvre l'écran devis** | `nouveau_devis` → `/devis/new` |
| Voir les chantiers | « montre mes chantiers » | 🧭 **ouvre les chantiers** | `ouvrir_chantiers` → `/chantiers` |
| **Créer un devis entièrement dicté** (lignes, montants, client) | « devis pour Durand : 3 h de pose à 45 € + un chauffe-eau à 800 € » | ⏳ à venir | tool `creer_devis` (extraction lignes) → CreateQuote |
| **Créer / émettre une facture** par la voix | « facture le devis signé de Durand » | ⏳ à venir | tools `generer_facture` / `emettre_facture` |
| Rattacher la dépense scannée à un **chantier/projet** dicté | « …pour le chantier Villa Durand » | ⏳ à venir | scan + `lier_chantier` (le contexte du message guide le rattachement) |
| **Envoyer** une relance / un devis au client (action sortante) | « relance Martin maintenant » | ⏳ à venir (**confirmation obligatoire**) | tool `envoyer_relance` (outbound → confirme) |
| Classer automatiquement les documents | « classe ce document dans Assurances » | ⏳ à venir | tools de classement (le coffre Documents existe) |
| Naviguer partout (clients, trésorerie, compte…) | « ouvre la trésorerie » | ⏳ extension simple des intents de navigation | ajouter des routes à `NAV_ROUTES` |

## Vocal : natif vs cloud
- **Natif (défaut)** : `expo-speech-recognition`, sur l'appareil, gratuit, privé, fr-FR.
- **Cloud (option)** : enregistrement → backend **Whisper (OpenAI)** ; plus précis (jargon BTP, bruit). Activable dans les **réglages** (Compte) + nécessite une clé `OPENAI_API_KEY`. Alternative UE : **Mistral Voxtral**.
- Le réglage natif/cloud est dans Paramètres ; `/voice/config` expose `cloudAvailable`.
- ⚠️ La **capture micro** nécessite un **build natif** (les modules micro ne tournent pas en bundle JS pur) — code prêt, à valider sur appareil.

## Comment on étend Bob (recette)
Chaque nouvelle commande = **1 outil** dans le registre (`packages/ai/src/tools/registry.ts` + spec LLM dans `classifier.ts` + détection regex dans `intent.ts`), qui **délègue à un use case existant**. C'est ce qui garde Bob en parité stricte avec l'app, sécurisé et borné — un vrai chef d'orchestre **agentique**, jamais hors-périmètre.

**Prochaines briques à fort impact** : `creer_devis` dicté, `emettre_facture`, `envoyer_relance` (avec confirmation), rattachement dépense→chantier, et l'extension des routes de navigation.
