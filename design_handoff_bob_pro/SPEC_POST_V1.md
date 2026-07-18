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

## P4 — MONÉTISATION ACTIVE — DÉCISION FONDATEUR 18/07 : PATTERN SHOPIFY (web checkout)
CANAL D'ABONNEMENT = la LANDING WEB (souscription Stripe checkout sur le site, en cours
de design Claude Design) ; l'app mobile = COMPAGNON. Objectif : conformité + éviter les
15-30 % d'IAP. RÈGLES DE CONFORMITÉ du pattern (à appliquer au moment du paywall) :
① l'app iOS ne pousse JAMAIS vers l'achat externe (pas de lien « abonne-toi sur le
  site », pas de bouton d'achat) — formulations neutres « gère ton offre depuis ton
  compte » ; ② REVOIR la grille tarifaire affichée dans compte.tsx (CTA gelés
  aujourd'hui) : en pattern compagnon strict, prix et CTA d'achat sortent de l'app iOS
  (ou entitlement lien externe selon juridiction/DMA au moment T) ; ③ le web
  souscrit → webhooks Stripe existants → table subscriptions → l'app REFLÈTE l'offre.
④ PAS d'IAP/RevenueCat en V1.1 (réévaluable si la conversion l'exige un jour).
Conversion des ~15 sites de gating (spec pilier 2 #4) inchangée.
NOTE Stripe Sync Engine (Supabase) : NON INSTALLÉ, déconseillé à ce stade — nos webhooks
tenant-scoped idempotents font déjà foi dans NOTRE table subscriptions ; le Sync Engine
dupliquerait les données Stripe dans un schéma parallèle avec pg_cron/pg_net/edge
functions = surface d'infra sans besoin actuel. Réévaluer seulement pour de l'analytics
revenus SQL direct.

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

## P7 — POSITIONNEMENT vs NÉOBANQUES (Shine/Qonto/Revolut) — doctrine « judo » (17-18/07)
PRINCIPE : ne jamais affronter leur cœur (compte+carte = licences bancaires, années,
capital) ; les INTÉGRER et vendre le cerveau au-dessus. Slogan interne : « Nico marche
AVEC ta banque, pas à sa place. »
1. OPEN BANKING (P1 déjà spécifié) = le judo ultime : le client GARDE Shine/Qonto/
   Revolut/sa banque — Nico s'y branche en lecture (DSP2) : solde auto + rapprochement
   virement↔facture. Argument comparatif direct ET co-marketing (« compatible avec ta
   banque »). Leur facturation = utilitaire froid ; la nôtre = copilote vocal métier.
2. LIENS DE PAIEMENT (V1.1) : Stripe payment links par facture DÉJÀ câblés (gelés
   early-access) — activer d'abord ; puis connecteurs marchands candidats selon demande
   réelle : Revolut Merchant API, SumUp, Lydia Pro (interface PaymentLinkProvider
   abstraite). Le VIREMENT reste roi en B2B artisan : le RIB sur facture (livré) est
   déjà l'essentiel.
3. CE QU'ILS NE COPIERONT PAS STRUCTURELLEMENT (leur cible est trop large) : le vocal
   métier profond (devis en 40 s dans le fourgon, terminologie chantier, catalogue
   prestations), l'expert fiscal outillé (Publicodes/URSSAF officiel), la conformité
   artisan FR fine (décennale, autoliquidation, e-invoicing), les relances gouvernées.
   LA DÉMO VOCALE DE 30 SECONDES = l'arme marketing différenciante n°1.
4. SURF MARKETING : pages comparatives SEO (« Nico vs Shine pour les devis d'artisan »),
   badge « compatible toutes banques » dès l'open banking, ciblage des artisans DÉJÀ
   clients de néobanques (ils ont prouvé qu'ils paient pour du logiciel).

## P8 — BOB AGENT RUNTIME (décision fondateur 18/07) : orchestration multi-agents niveau Claude Code, propulsée Mistral
UNIFIE P2 (boucle NLU vocale) + SCANNER V2 (agent documentaire) en UNE architecture :
un ORCHESTRATEUR (mistral fort, routage par complexité) qui délègue à des SOUS-AGENTS
spécialisés (documentaire, fiscal, recherche, relances…), chacun avec sa palette
d'OUTILS TYPÉS = les use cases core existants (parité structurelle manuel↔vocal↔agent),
des ARTEFACTS de travail (résumés, plans, propositions révisables), le plancher
confirm_all INTACT à chaque conséquence, coût/modèle tracés par tour. Prompts versionnés
(pattern prompt-pack), goldens, évals. Chantier majeur POST-V1 (le gel s'applique) —
spec unifiée à co-challenger GPT avant tout code ; la V1 publie avec le vocal actuel
(fix extraction livré) + le fix scanner ticket.

### P8.1 — Graphe de connaissances (question fondateur 18/07, avis Claude)
Oui comme ATOUT, non comme INFRASTRUCTURE dédiée. Le domaine est déjà un graphe
(client↔chantier↔devis↔facture↔dépense↔document↔fournisseur) — matérialisé par les FK
Postgres + le modèle DDD ; un tenant artisan = quelques milliers de nœuds, ça tient en
une requête. Introduire une base graphe (Neo4j/triplestore/GraphRAG) = double-écriture,
sync, dérive : refusé tant que le besoin multi-sauts à grande échelle n'est pas prouvé.
Plan en 3 crans, chacun ne se justifiant que si le précédent plafonne :
1. (P8 déjà prévu) TYPED TOOLS DE NAVIGATION : l'agent parcourt le graphe existant via
   les use cases (get_chantier → list_expenses(chantierId) → get_document…). C'est un
   knowledge graph interrogé par outils — sans nouvelle techno. + « tenant context »
   (spec SCANNER V2) : résumé structuré du graphe injecté dans les prompts.
2. ARÊTES INFÉRÉES PERSISTÉES : les liens que l'IA découvre (fournisseur récurrent,
   abonnement détecté, document↔chantier suggéré, corrélations produit) deviennent des
   arêtes de première classe AVEC provenance + confiance + validation humaine — le vrai
   apport « KG » ; amorcé par la suggestion de destination livrée le 18/07 (validation
   anti-hallucination contre le contexte = discipline KG déjà en place).
3. (si preuve du besoin) PROJECTION graphe/vecteurs DÉRIVÉE de Postgres (jamais source
   de vérité) : CTE récursives + pgvector d'abord, GraphRAG seulement si mesuré utile.

### P8.2 — Mémoire de l'agent (question fondateur 18/07, avis Claude)
Redis REFUSÉ pour la mémoire : c'est un cache de latence/état éphémère, or la mémoire
d'agent n'a ni problème de latence (quelques ms Postgres, invisibles dans un tour LLM
de 1-3 s) ni de volume (tenant artisan minuscule) — une infra de plus = une source de
vérité de plus. Modèle en 3 couches, calqué sur le fonctionnement de Claude Code :
1. MÉMOIRE DE TRAVAIL (session) : le fil de conversation (history, 5 derniers tours
   utilisateur + dernier tour Bob pour les anaphores — LIVE-2, déjà en place) ; la
   fondation durable est POSÉE par la lane GPT (mistral-conversation-authority Postgres,
   v2 fail-closed OFF) — c'est là que vivront reprise/replay, pas dans Redis.
2. MÉMOIRE DES ACTES : Bob ne doit JAMAIS « se souvenir » de ce qu'il a fait — il RELIT.
   La BDD métier + l'audit trail (audit:document.* etc.) SONT sa mémoire d'actions :
   source de vérité relue à la demande (tool historique/audit), zéro dérive possible.
   Principe Claude Code : l'état du monde (git/BDD) prime toujours sur le souvenir.
3. MÉMOIRE SÉMANTIQUE DURABLE (le chantier P8, pas avant) : petits faits CURÉS par
   tenant — habitudes (« Free → frais généraux »), corrections, préférences — persistés
   Postgres avec provenance + confiance + validation humaine (= les arêtes inférées de
   P8.1), injectés en contexte au bon moment (tenant context du scanner V2, même canal).
   + COMPACTION : résumé de fin de session généré par le modèle, stocké en BDD, relu à
   l'ouverture de la suivante (le pattern résumé-de-contexte de Claude Code).
V1 : RIEN à construire — fil de session + BDD + audit suffisent ; l'amnésie
inter-sessions des échanges (pas des données) est un comportement v1 standard.
