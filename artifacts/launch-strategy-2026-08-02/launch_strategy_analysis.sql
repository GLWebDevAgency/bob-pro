-- Bob Pro launch strategy — reviewed analytical snapshot, 2026-08-02.
--
-- This file is the reproducible data model behind artifact.json. Values are a
-- manual synthesis of the canonical publication registry, current source code,
-- live endpoint checks, current CI evidence, and the official/competitive
-- sources listed in source-notes.md. It does not query production customer data.

CREATE TEMP VIEW objective_status AS
SELECT * FROM (VALUES
  ('O1', 'Vérité Git', 'specified', 'Aucune preuve de publication exacte depuis main sur les deux appareils'),
  ('O2', 'Facturation / Factur-X', 'implemented', 'CI actuelle verte ; preuve runtime production et corpus terrain encore dus'),
  ('O3', 'GPT Realtime', 'implemented', 'Runtime public fermé ; round-trip natif, iPhone/Android et SLO absents'),
  ('O4', 'Mission continue', 'implemented', 'M1-B certifié staging ; autres missions et preuve appareil incomplètes'),
  ('O5', 'Voice Trace', 'implemented', 'Trace public OFF ; drill, SLO et preuve appareil dus'),
  ('O6', 'Données réelles, zéro fiction', 'implemented', 'Correctif fail-closed fusionné et CI verte ; preuves appareil encore dues'),
  ('O7', 'Release reproductible', 'implemented', 'Lifecycle suppression local vert ; pas sur main/CI publié, pas de replay Supabase staging ni de déploiement exact-SHA'),
  ('O8', 'Plateforme Agréée', 'specified', 'Aucun partenaire, contrat, sandbox ou flux légal réconcilié')
) AS v(objective_id, objective, evidence_status, remaining_gate);

CREATE TEMP VIEW launch_versions AS
SELECT * FROM (VALUES
  ('v0.8', 'Bêta fermée', 'TestFlight + Play closed', '4 semaines après P0', 0, 'vague 1 : 5 ; maximum 15, dont 12 Play/14 j si requis', 'Compte réel ; client ; catalogue simple ; devis → signature → facture/avoir simple → envoi → paiement manuel ; Bob Live canary allowlist', 'OCR, dépenses, pré-compta, chantiers, facturation avancée et Bob texte restent sous flags canary ; PA, paiement en ligne, équipe et offline fermés', '0 P0 sécurité/finance ; activation ≥60 % ; rétention S4 ≥6/10 ; 0 double envoi/faux succès'),
  ('v1.0', 'Lancement limité', 'App Store + Play production, rollout progressif', 'cible de soumission : ≥6–8 semaines après P0 ; disponibilité non garantie', 0, 'maximum 50 sociétés, cap serveur + allowlist + entitlement early_access', 'Cœur minimal certifié ; support/suppression certifiés ; Bob Live certifié selon le cap canonique O3–O5', 'PA/e-reporting, paiements en ligne, équipe/cabinet et tous les canaries non certifiés', 'CI + staging exact-SHA ; deux OS ; légal final ; suppression AC9–AC10 ; cap réellement exécutoire ; Bob Live device/SLO, sauf changement de cap fondateur'),
  ('v1.1', 'Founder Solo', 'Vente web, app de connexion', 'après preuve de valeur 1.0', 19, '50 premiers artisans solo, prix garanti 12 mois', 'Cœur 1.0 certifié + quotas exécutoires + support standard', 'PA, équipe et automatisations non certifiées', '≥5 dépôts/précommandes payés ; support ≤10 min/compte/mois ; coût variable ≤5 €'),
  ('v1.1+', 'Solo standard', 'Vente web, app de connexion', 'après deux cohortes payantes', 29, 'artisans solo hors cohorte fondateur', 'Même promesse Solo, onboarding self-serve et support documenté', 'PA et équipe', 'Rétention payante M2 ≥70 % sur ≥20 clients ; marge brute et support soutenables'),
  ('v1.2', 'Pro', 'Vente web puis politique stores validée', 'après PA et automatisations certifiées', 49, 'artisans à fort volume administratif', 'Connecteur PA réel ; Bob Live certifié ; relances/automatisations gouvernées ; trésorerie prouvée', 'Multi-sociétés et cabinet si non certifiés', 'Contrat/DPA/sandbox PA ; SLO voix ; coût variable ≤8 € ; zéro incident financier'),
  ('v2.0', 'Business', 'Web + mobile', 'après traction et support soutenable', 79, 'petites équipes', 'Rôles/équipe ; contrôle comptable ; multi-sociétés/cabinet selon certification', 'Aucune fonction seulement maquettée ou spécifiée', 'Rétention payante et usage équipe prouvés ; sécurité multi-rôles certifiée')
) AS v(version, phase, distribution, timing, monthly_price_eur, audience, included, excluded, exit_gate);

CREATE TEMP VIEW module_audit AS
SELECT * FROM (VALUES
  ('Identité, compte et accès', 'Page web et lifecycle backend implemented localement ; production 404 ; opérateur/rétention non certifiés ; identité Bob Pro/Nico contradictoire', 'Après commit, CI et replay staging', 'Indispensable après certification production', '—', 'Nom/support décidés ; URL 200 exact-SHA ; demande, effacement et confirmation prouvés'),
  ('CGU, confidentialité, RGPD', 'Pages live avec placeholders ; matrice de rétention incomplète', 'Non externe avant correction', 'P0 absolu', 'Revue juridique continue', 'Identité légale, DPA, transferts, Storage/logs/backups, rétentions et fournisseurs exacts'),
  ('Onboarding métiers', 'Codé mais promet des verticales non livrées', 'BTP solo seulement', 'BTP solo seulement', 'Maintenance après équipements/interventions certifiés', 'Masquer les métiers et bénéfices non prouvés ; choix fondateur enregistré'),
  ('CRM clients et recherche', 'Câblé aux données réelles', 'Oui', 'Cœur V1', 'Enrichissement CRM', 'États vide/erreur + tenant vierge/peuplé certifiés'),
  ('Catalogue', 'Domaine et mobile réels', 'Simple après QA', 'Cœur V1', 'Mutations avancées', 'Zéro donnée locale trompeuse et états réseau certifiés'),
  ('Devis et signature', 'Socle large, signature web et archives présents', 'Oui, cas bornés', 'Cœur V1', 'Variantes non certifiées', 'Email/signature/archive sur appareils et production'),
  ('Factures, avoirs, paiements manuels', 'Socle large, tests CI verts ; certification publication incomplète', 'Oui, cas simples', 'Cœur V1', 'Cas avancés non prouvés', 'Facture finale toujours atteignable ; PDF/Factur-X/TVA exacts'),
  ('Facturation avancée', 'Facture directe, remises, échéances, situations et BC codés à divers niveaux', 'Flag canary par cas', 'OFF par défaut', 'Après matrice exhaustive', 'Résultat visible E2E pour chaque sémantique'),
  ('Factur-X', 'O2 implemented ; CI FNFE/Mustang/veraPDF verte', 'Oui comme génération', 'Oui avec wording factuel', 'Certification terrain continue', 'Dire « Factur-X généré », jamais « réforme réglée » sans PA'),
  ('Plateforme Agréée', 'O8 specified seulement ; guide manuel', 'PA externe explicitée', 'Pas d’automatisation annoncée', 'V1.2', 'Partenaire agréé, contrat, DPA, sandbox, annuaire, rejets et réconciliation'),
  ('Envoi, relances, notifications', 'Lifecycle local annule/minimise les jobs et ferme email/push ; exploitation production à prouver', 'Oui après replay staging', 'Cœur V1 après certification', 'Autonomie gouvernée', 'Brevo réel, anti-doublon, cron/alerting et clôture tenant certifiés'),
  ('Trésorerie / argent', 'O6 fusionné ; certification appareil à faire', 'Flag canary, lecture prudente', 'OFF par défaut sauf preuve exacte', 'Open banking/forecast avancé', 'États absent/périmé/erreur visibles et tests tenant'),
  ('Dépenses, documents, OCR', 'Intake/OCR présents ; droit OCR non appliqué avant appel fournisseur', 'Flag canary avec revue humaine', 'OFF par défaut', 'Après cœur stable', 'DPA, quota/entitlement et correction avant écriture financière'),
  ('Pré-compta, clôture, FEC', 'Écrans/use cases présents', 'Flag canary', 'OFF par défaut', 'Après export prouvé', 'Golden files + test de partage sur appareils'),
  ('Chantiers, notes, photos', 'Câblé au réel', 'Flag canary BTP', 'OFF par défaut', 'V1.1 selon signal terrain', 'Upload, permissions et états réseau certifiés'),
  ('Équipements et contrats', 'Domaine/API/écrans présents, non certifiés publication', 'Non dans le pilote BTP', 'Non', 'Verticale maintenance', 'Polish, preuve terrain et support soutenable'),
  ('Interventions / offline', 'Domaine/API sans parcours mobile public complet', 'Test technique seulement', 'Non', 'Post-V1', 'UI, outbox offline, conflits, signature et synchronisation terrain'),
  ('Bob texte', 'Assistant branché aux mêmes use cases ; quota mensuel backend TODO', 'Flag canary, fournisseur unique', 'OFF par défaut tant que quota absent', 'Après quota et coût prouvés', 'DPA, coût, confirmations et absence de faux succès'),
  ('Bob Live / voix', 'O3/O4/O5 implemented mais production OFF et non certifiés appareils', 'Canary allowlist', 'Requis par le cap canonique ; sinon [BLOQUÉ FONDATEUR : changement de cap]', 'Améliorations post-V1', 'iPhone+Android, SLO, barge-in, Trace, coût et rollback'),
  ('Abonnements / Stripe / IAP', 'Paiement différé ; nouveau tenant reçoit actuellement Business gratuit sans échéance', 'early_access explicite, allowlist et cap serveur avant cohorte', 'Gratuit borné, sans carte ni débit automatique', 'V1.1 web', 'Droits/quotas/cap exécutoires avant V1 ; webhooks et remboursements avant vente'),
  ('Équipe, multi-sociétés, cabinet', 'Promis par le catalogue Business mais non certifié', 'Non', 'Non', 'V2', 'Rôles, RLS, audit, UX et support multi-utilisateur'),
  ('Ops, jobs et release', 'CI main verte ; plusieurs schedulers restent pilotés par liste ; SHA prod absent', 'Pilotage manuel documenté', 'Bloquant self-serve', 'Automatisation continue', 'Nouvelle société couverte, exact-SHA, staging, migrations bornées et runbook')
) AS v(module, current_state, beta_08, store_v10, later, launch_gate);

CREATE TEMP VIEW pricing_path AS
SELECT * FROM (VALUES
  ('Bêta 0.8', 0, 'vague 1 : 5 ; maximum 15', 'Recherche produit, aucune carte, aucune reconduction', 'P0 légal + lifecycle staging + build fermé'),
  ('V1.0 lancement limité', 0, 'maximum 50 sociétés', 'Cœur certifié, accès invitation/early_access à échéance explicite', 'Cap serveur, allowlist, droits et gates stores'),
  ('V1.1 Founder Solo', 19, '50 premiers, 12 mois', 'Cœur certifié + quotas ; hypothèse tarifaire fondateur', '≥5 dépôts/précommandes réels + support ≤10 min/mois'),
  ('V1.1+ Solo standard', 29, 'artisans solo', 'Même cœur self-serve ; hypothèse après apprentissage', 'Rétention payante M2 ≥70 % sur ≥20 clients'),
  ('V1.2 Pro', 49, 'fort usage administratif', 'PA réelle + Bob Live + automatisations gouvernées', 'Certification PA/voix et coût variable ≤8 €'),
  ('V2 Business', 79, 'petites équipes', 'Équipe, contrôle, multi-sociétés/cabinet certifiés', 'Traction, rôles/RLS et support prouvés')
) AS v(stage, monthly_price_eur, audience, promise, activation_condition);

CREATE TEMP VIEW competitor_benchmark AS
SELECT * FROM (VALUES
  ('Abby', '0 €', '7,20 € HT/mois, annuel promo', 'Oui', 'Oui', 'Micro-entreprise généraliste ; devis/factures illimités'),
  ('Tiime', '0 €', '17,99 € HT/mois, annuel', 'Oui', 'Oui', 'Facturation + pré-compta + banque'),
  ('Indy', '0 €', 'à partir de 9 € HT/mois, annuel', 'Oui', 'Oui', 'Comptabilité/facturation indépendants'),
  ('Shine Facture', '0 €', '11 € mensuel ou 9 € annuel', 'Oui', 'À vérifier par offre', 'Facturation intégrée à l’écosystème Shine'),
  ('Tolteck', '—', '25 € mensuel ou 19 € annuel', 'Non', 'À vérifier', 'Devis/factures BTP, offline'),
  ('Obat', '—', 'à partir de 49 € HT/mois affiché', 'Non', 'Via partenaire', 'BTP complet ; devis vocal proposé en option')
) AS v(vendor, free_entry, paid_entry, free_invoicing, pa_position, market_position);

CREATE TEMP VIEW launch_budget AS
SELECT * FROM (VALUES
  ('Comptes Apple + Google', 120, 'Apple 99 USD/an + Google 25 USD une fois ; réallouer si déjà payés'),
  ('Revue juridique/RGPD ciblée', 200, 'Revue ciblée seulement, pas un accompagnement juridique complet'),
  ('Infrastructure, 3 mois', 210, 'Supabase + Railway + Vercel commercial ; enveloppe TVA/FX'),
  ('Crédits IA/voix/OCR', 150, 'Plafond dur et alertes ; mesurer coût par compte'),
  ('Domaine + email professionnel', 50, 'Support et confiance ; remplacer l’adresse personnelle'),
  ('Appareils / incentives testeurs', 120, 'Suppose un iPhone possédé/emprunté ; Android modeste ou incentives'),
  ('Contingence', 150, 'Rebuild, incident, taxe, certificat ou dépassement contrôlé')
) AS v(category, budget_eur, rationale);

CREATE TEMP VIEW kpi_registry AS
SELECT * FROM (VALUES
  ('Primaire', 'Activation J7', 'Sociétés ayant envoyé un premier devis ou une facture réelle sous 7 j / sociétés invitées éligibles', '≥60 %, minimum 10 invitées', '≥70 %, minimum 20 invitées', 'Hebdomadaire'),
  ('Primaire', 'Rétention cœur S4', 'Sociétés activées ayant terminé ≥2 workflows cœur sur ≥2 semaines distinctes à J28 / sociétés activées', '≥6/10 activées', '≥50 %, minimum 20 activées', 'Hebdomadaire par cohorte'),
  ('Primaire', 'Temps vers première valeur', 'Médiane entre création du compte et premier document réel envoyé', '≤20 min', '≤10 min', 'Hebdomadaire'),
  ('Qualité', 'Succès des workflows cœur', 'Terminaisons exactes / tentatives devis-signature-facture-envoi-paiement', '≥98 % sur ≥100 tentatives', '≥99,5 % sur ≥1 000 tentatives', 'Quotidien'),
  ('Qualité', 'Sessions sans crash', 'Sessions sans crash / sessions totales', '≥99 % sur ≥500 sessions', '≥99,5 % sur ≥2 000 sessions', 'Quotidien'),
  ('Garde-fou', 'Incidents financiers/sécurité', 'Cross-tenant + double envoi + double écriture + faux succès', '0', '0', 'Temps réel / revue hebdo'),
  ('Économie', 'Charge support', 'Minutes fondateur consacrées au support / société active / mois', '≤45 min', '≤10 min, sinon concierge payant', 'Mensuel'),
  ('Économie', 'Coût variable', 'IA + OCR + email + stockage/egress variables / société active / mois', 'Mesuré', '≤5 € Solo ; ≤8 € Pro et ≤30 % du prix', 'Mensuel'),
  ('Monétisation', 'Preuve de paiement', 'Dépôts, précommandes ou premiers paiements encaissés / testeurs activés éligibles', '≥5 paiements sur ≥10 activés', '≥50 % sur ≥20 essais qualifiés', 'Fin de cohorte'),
  ('Voix', 'Latence et sûreté Bob Live', 'Fin de parole → premier audio ; erreurs fantômes/doubles confirmations', 'p95 ≤1 800 ms ; 0 erreur critique', 'Même seuil sur iPhone et Android', 'Chaque build voix')
) AS v(metric_group, metric, formula, beta_gate, v1_gate, cadence);

CREATE TEMP VIEW go_to_market AS
SELECT * FROM (VALUES
  ('Recrutement bêta', 'BTP solo : 5 en vague 1, maximum 15', 'Réseau direct, experts-comptables locaux, négoces et associations métier', '0 € média ; 120 € device/incentives', 'Entretien initial 30 min + point hebdo 15 min', '≥6/10 activés encore actifs à S4 ; 0 incident'),
  ('Lancement limité stores', '50 sociétés maximum, invitation contrôlée', 'Waitlist, parrainage, 2 études de cas et démo courte', '0 € publicité', 'Onboarding assisté léger + centre d’aide minimal', 'Cap/allowlist exécutoires ; activation ≥70 % ; support ≤10 min/compte/mois'),
  ('Commercial Solo', 'Artisans ressemblant aux cohortes retenues', 'SEO problème, partenaires comptables/métier et bouche-à-oreille', 'Test média ≤50 € seulement après rétention payante', 'Checkout web mesuré', '≥50 % de conversion sur ≥20 essais qualifiés ; rétention M2 ≥70 %')
) AS v(phase, target, channels, spend, operating_motion, scale_gate);

CREATE TEMP VIEW p0_action_plan AS
SELECT * FROM (VALUES
  (1, 'Décider Bob Pro ou Nico, fournir l’identité légale et choisir BTP solo', 'Fondateur', '0,5 j décision', 'Spec/ADR datée ; nom, segment, SIREN, adresse, email et vendeur stores cohérents'),
  (2, 'Réécrire CGU/confidentialité et signer/archiver les DPA nécessaires', 'Fondateur + conseil', '2–3 j', 'Pages live sans placeholder ; runtime, transferts et rétentions exacts'),
  (3, 'Promouvoir et certifier le lifecycle de suppression local', 'Produit/tech + ops', '2–4 j ops', 'Commit propre ; CI ; replay Supabase staging non-superuser ; audit bindings legacy ; URL 200 ; mail/runbook/confirmation ; matrice RGPD ; déploiement exact-SHA'),
  (4, 'Créer entitlement early_access, allowlist et cap serveur', 'Backend/produit', '1–2 j', 'Le 51e tenant est refusé ; expiration explicite ; aucun Business gratuit implicite ; paywalls masqués'),
  (5, 'Aligner la fiche store et trancher le cap Bob Live', 'Fondateur + produit', '1 j décision/copy', 'Bob Live certifié dans V1 ou [BLOQUÉ FONDATEUR : changement de cap] avec objectifs/spec/flags atomiques ; screenshots réels'),
  (6, 'Ajouter un profil bêta store-signé et les identifiants de soumission', 'Mobile/ops', '1 j', 'AAB closed track + TestFlight vers staging/candidat contrôlé ; binaire public vers production'),
  (7, 'Corriger ou désactiver la biométrie iOS sans configuration Face ID', 'Mobile', '0,5 j', 'Plugin/usage description + test, ou fonctionnalité fermée'),
  (8, 'Séparer les environnements/release Sentry et prouver les source maps', 'Mobile/ops', '1 j', 'Événement de test attribué au bon environnement, release et SHA'),
  (9, 'Terminer la certification appareil du lot O6 fail-closed', 'GPT writer + fondateur', '0,5–1 j QA', 'CI verte + revue appareil + aucune donnée périmée présentée comme vraie'),
  (10, 'Rendre les jobs multi-tenant self-serve ou limiter explicitement l’accès', 'Backend/ops', '1–2 j', 'Nouvelle société automatiquement couverte ; test onboarding → jobs'),
  (11, 'Borner les migrations restantes et certifier exact-SHA staging/prod', 'Backend/ops', '1–2 j', 'Timeouts ; readiness SHA/env ; rollback/runbook'),
  (12, 'Certifier le cœur et Bob Live sur iPhone et Android modestes', 'Fondateur + testeurs', '2–4 j', 'Cold install, auth, devis, signature, facture, envoi, paiement et gate voix O3–O5'),
  (13, 'Lancer la cohorte fermée et instrumenter le registre KPI', 'Produit', '4 semaines', 'Registre hebdo ; verbatims ; décisions stop/continue tracées')
) AS v(priority, action, owner, estimated_effort, required_evidence);
