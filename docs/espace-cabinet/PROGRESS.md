# Espace Cabinet — PROGRESS (source de vérité de reprise)

> Tout agent (Claude A/B, GPT C, autre) commence par lire `ARCHITECTURE.md`, `GLOSSAIRE.md`,
> `SLICES.md` puis CE fichier, et reprend à la slice en cours. Chaque merge de slice ajoute une
> entrée ici ET un log `CAB-n` dans `design_handoff_bob_pro/CLAIMS.md` (protocole inter-sessions).

## État courant

- **2026-07-12 — Programme initialisé (session A).** Gap analysis livrée (SLICES.md) : 3 slices
  à construire à neuf (4, 9, 11), le reste part d'un existant partiel à fort. Décisions
  structurantes posées (ARCHITECTURE.md ADR-1→7), dont la réconciliation référentiel
  paramétrable × moteur fiscal audité (ADR-2) et la double tenancy cabinet/artisan (ADR-3).
- **Checkpoint fondateur (cahier §1.2)** : plan soumis au fondateur ce jour. Prérequis §8 en
  attente côté humain : (1) environnement STAGING Railway + base staging ; (2) secret BREVO_*
  (déjà requis par C25) ; (3) mandat feature flags minimal en base (par défaut : oui, ADR-5).
- **Slice en cours : aucune.** Prochaine : Slice 0 (session A) dès validation du checkpoint —
  en parallèle, session C (GPT) exécute son préalable design (①–⑤ review C-WEB-EC) qui ne
  dépend d'aucun prérequis.

## Journal des slices

| Slice | Claim | Statut | Sessions | Notes |
|---|---|---|---|---|
| Préalable C — design web aligné (①–⑤) | CAB-0C | À LANCER (aucune dépendance) | C (GPT) | Tokens→CSS générés, typo Schibsted/Hanken, CTA navy, tsconfig strict repo, i18n voix « pro » |
| 0 — Fondations & rails | CAB-0 | EN ATTENTE checkpoint + staging | A | Tables cabinets/members, RLS cabinet, RBAC, flags, fix log 500/422 |
| 1 → 14 | CAB-1…14 | — | cf. SLICES.md | — |
