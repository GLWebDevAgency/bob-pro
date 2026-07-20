# SPEC — SCANNER INTELLIGENT UNIVERSEL (vision fondateur 18/07, à co-challenger GPT)

VISION : le scan comprend N'IMPORTE quel document « comme Claude/GPT en version ultra
poussée » — ticket de caisse, facture fournisseur, Kbis, attestation, RIB, contrat —
et fait LA bonne chose pour chacun. Classe mondiale, tout public, parité vocale.

## ARCHITECTURE — GATEWAY DE COMPRÉHENSION À 2 ÉTAGES (routage par coût)
Étage 1 (économique, toujours) : OCR Mistral dédié (existant) + CLASSIFICATION cheap
(mistral-small) → {type de document, confiance, complexité}. Types V1 : ticket_caisse,
facture_fournisseur, kbis, attestation_assurance, rib, courrier_admin, autre.
Étage 2 (routé) : extraction SPÉCIALISÉE par type avec schéma dédié (tool calling —
convergence avec l'architecture boucle agentique NLU) ; modèle FORT (mistral-large)
SEULEMENT si : confiance basse, multi-pages, manuscrit, type complexe. Chaque réponse
porte {type, champs, confiance par champ, modèle utilisé, coût} — traçable.

## LE BUG ACTUEL À FIXER IMMÉDIATEMENT (tranche séparée, part maintenant)
Un ticket de caisse scanné crée une dépense « à payer » avec bouton Payer — ABSURDE :
un ticket EST une preuve de paiement. Règle : ticket_caisse → dépense PAYÉE d'emblée,
le scan ATTACHÉ comme PREUVE (la chaîne paymentEvidence de la lane preuves existe !) ;
facture_fournisseur AVEC échéance → « à payer » + rappel À régler aujourd'hui.

## CORRÉLATIONS PROACTIVES (idées Claude — le scan nourrit TOUT le produit)
1. CLASSEMENT AUTO au coffre : les dossiers SYSTÈME existent (achats/assurances/
   fiscal_social/banque/comptable) → le type route le document + rattachements.
2. MISES À JOUR PROPOSÉES : attestation décennale scannée → proposer MAJ du n° de
   police dans Facturation & modèles ; RIB scanné → proposer MAJ coordonnées bancaires ;
   Kbis → fiche société. TOUJOURS proposer→valider (confirm_all).
3. ÉCHÉANCES DÉTECTÉES : facture fournisseur à 30j → priorité « À régler » au bon moment.
4. RÉCURRENCE : même fournisseur/montant mensuel → suggérer charge récurrente.
5. ANTI-DOUBLON : hash + similarité (même ticket scanné 2×) → alerte douce.
6. TVA : extraite par taux → déductibilité pré-remplie (lien moteur fiscal).
7. CONFIRMATION CONVERSATIONNELLE (« voilà ce que j'ai compris ») : écran de validation
   post-scan = la compréhension complète (type, montant, TVA, payé/à payer, dossier
   proposé) corrigeable au TAP ou À LA VOIX (« non, c'est du matériel »). Parité stricte.
8. RGPD : OCR Mistral France — cohérent privacy policy ; jamais d'entraînement.

## DoD : spec co-challengée GPT avant le gros œuvre · goldens par type de document
(corpus réel) · routage coût mesuré (télémétrie modèle/coût par scan) · états socle ·
parité vocale · le bug ticket = fix immédiat hors gel (correction, pas feature).

## V2 VISION AFFINÉE (fondateur 18/07) — L'AGENT DOCUMENTAIRE (architecture « Claude Code pour documents »)
Réponse Claude à « ta meilleure solution » : pas un pipeline figé — UNE BOUCLE AGENTIQUE.
Après l'OCR, UN agent (routage mistral small→medium/large selon complexité/confiance)
reçoit : le texte + LE CONTEXTE DU TENANT (métier, fournisseurs connus, dépenses
récurrentes existantes, historique du même fournisseur, dossiers du coffre, fiche
société) + une PALETTE D'OUTILS TYPÉS : classifyAs · createExpense(paid|to_pay) ·
attachAsEvidence · fileTo(dossier) · proposeRecurring(échéancier) · updateCompanyRecord
(assurance/RIB/infos Kbis) · writeSummary(2-3 lignes) · askUser(question à choix).
Il raisonne, enchaîne, et TOUTE conséquence passe par confirm_all (cartes de validation).
CAS CANONIQUES :
· KBIS : classify → extraire SIREN/greffe/date → COMPARER à la fiche société → classer
  au dossier officiel + résumé (« Kbis Fly Services, extrait du 12/07/2026, RCS X ») +
  si divergence → proposer la MAJ de la fiche.
· ABONNEMENT TÉLÉPHONIQUE : facture + indices (période « du 1 au 30 », télécom, montant
  ≈ identique aux factures PRÉCÉDENTES du même fournisseur — l'agent VOIT l'historique)
  → « Ça ressemble à ton abonnement Free Pro, ~39,99 €/mois le 5 — je le note comme
  charge récurrente ? » → OUI → dépense + récurrence + auto-rapprochement des suivantes.
· RÉSUMÉ AU COUP D'ŒIL (exigence UX) : chaque document classé porte {résumé 2-3 lignes,
  type, montants clés, dates clés} générés À L'ANALYSE et stockés — affichés en tête de
  la fiche document AU-DESSUS de l'aperçu PDF. Jamais regénérés à la volée.
INGÉNIERIE : prompts VERSIONNÉS par type (pattern prompt-pack existant), goldens par
type (corpus réel), routage de modèle tracé {modèle, coût, confiance} par scan,
escalade automatique si confiance basse. La palette d'outils = les MÊMES use cases core
que le manuel (parité structurelle totale).
