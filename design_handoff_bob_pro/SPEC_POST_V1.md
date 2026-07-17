# SPEC POST-V1 — chantiers gelés jusqu'à la publication (ordre fondateur 17/07)

Aucun de ces chantiers ne démarre avant la V1 publiée. Chacun exige : spec détaillée
co-challengée Claude+GPT avant code, DoD signée, parité vocale, tokens stricts.

## P1 — SYNCHRO BANCAIRE (open banking DSP2)
Voie : agrégateur agréé AISP porteur de conformité (jamais d'agrément propre).
Séquence : POC GoCardless Bank Account Data (palier gratuit) → choix prod Bridge/Powens
selon couverture réelle des banques utilisateurs → intégration.
Killer feature cible : RAPPROCHEMENT AUTO virement↔facture (« j'ai reçu 1 210 € de
Lefèvre, je marque la facture payée ? » — proposition, jamais automatique).
Le domaine anticipe déjà : BankBalanceSource 'connecteur' + politique de fraîcheur 6h.
DoD : consentement SCA 180j géré (renouvellement UX), RGPD (finalité, suppression),
aucune donnée bancaire persistée hors agrégats nécessaires, rapprochement = proposition
confirm_all, fallback saisie manuelle intact, coûts par compte monitorés.

## P2 — BOUCLE AGENTIQUE VOCALE (si verdict GPT non implémenté avant gel)
REUNION_NLU_VOCALE_20260716.md fait foi (tool calling → boucle, 2 critères d'acceptation
fondateur : catalogue-first bimodal + flow complet d'une traite).

## P3 — OPPORTUNITÉS INFRA (analyse rendue au fondateur 16/07)
Partenariat/case study Mistral (dès V1 publiée, coût zéro) → open-core gateway realtime
(BSL, si traction V2) → agents métier API marque blanche (V3, si prospects).

## P4 — MONÉTISATION ACTIVE
IAP StoreKit/Play (restaurer achats), conversion des ~15 sites de gating (spec pilier 2
#4), paywall V1.1 sur pricing value-based existant.

## P5 — DIVERS ACTÉS
Archivage image du tracé de signature + consentement versionné (suite R4) · révision de
devis signé (nouveau devis lié) · multi-brouillons devis · endpoint serveur catalogue
(mutation vocale par item) · mention brouillon dans salutation Bob (pressure ledger) ·
migration corbeilles restantes vers DeleteIconButton · webhook alerting réel ·
staging Railway aligné · Expert fiscal V2/V3 (simulation UI + dossier cabinet, post
re-review flag).

## P6 — CHANTIERS/PROJETS INTELLIGENTS (vision fondateur 17/07 — V1 = notes+photos seulement)
1. AVANCEMENT lié au devis : à la création du chantier, PROPOSER d'importer les lignes du
   devis signé comme tâches cochables (import optionnel, jamais forcé) + tâches libres
   ajoutables (manuel/vocal). L'avancement % dérive des tâches cochées.
2. RAPPEL Home sympa (« À régler aujourd'hui ») : chantier en cours sans mise à jour
   depuis N jours → « Tu as avancé sur le chantier Lefèvre ? » — gouvernance de pression,
   réponse vocale possible (« oui, pose du ballon finie » → coche/note proposée).
3. CRA VOCAL (métiers IT/conseil — vécu fondateur) : compte-rendu quotidien de mission
   (temps passé, fait/à faire) dicté ; export mensuel (client/facturation au temps).
4. IA DE FORMATAGE DE NOTES : modèle PREMIUM (le plus intelligent dispo du provider
   retenu) AVEC OUTILS — décide seul : checklist/to-dos, résumé, structuration — c'est
   une application directe de la boucle agentique NLU (mêmes patterns, mêmes planchers).
   STT Voxtral pour la transcription, compréhension par le modèle fort.
5. PHOTOS → migration Cloudflare R2 (bucket dédié, coût faible) derrière le port
   WorksiteMediaStorage posé en V1 ; accès wrangler à rétablir (login fondateur).
