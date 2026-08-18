"""Emission (1) du manifeste de surfaces v0 (JSON) et (2) du premier jet de catalog.data.ts.

Toutes les chaines TS sont emises via json.dumps (double quotes) ; Prettier
normalisera le style. La curation manuelle suit sur le fichier emis.
"""
import json
import re
from collections import Counter

SC = ('/private/tmp/claude-501/-Users-limameghassene-development-Bob-Pro/'
      '8adbf03e-f9b0-4f6f-a398-af1cd251c59d/scratchpad')

with open(SC + '/merged_inventory.json') as f:
    merged = json.load(f)

manifest = {
    'schema': 'public-action-surface-manifest',
    'version': 'v0-llm-assisted',
    'generatedAt': '2026-08-18',
    'commit': '72acef4b',
    'method': ('workflow 10 agents (9 eclaireurs multi-modaux + critique de completude), '
               'fusion mecanique par cle semantique — collecteur deterministe a construire (U1+)'),
    'rawActionCount': 704,
    'mergedCount': len(merged),
    'surfaces': merged,
}
with open(SC + '/public-action-surface-manifest.v0.json', 'w') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

NAV_COLLAPSE = re.compile(r'^(nav|ouvrir|naviguer)\b')
FINANCIAL_KW = re.compile(r'emettre|emission|encaiss|paiement|payment|payer|avoir|rembours|acompte|situation|reglement|virement')
EXTERNAL_KW = re.compile(r'envoyer|send|relance|transmettre|transmission|partager|lien-paiement|lien-signature')
DESTRUCTIVE_KW = re.compile(r'supprimer|delete|purger')
DRAFT_KW = re.compile(r'brouillon|draft|note|photo|tag|classement|filtre|preference')
SIGNATURE_KW = re.compile(r'signature|signer')
CLOSED_RULES = [
    (re.compile(r'fusion'), 'FD-2026-0817-06',
     "fusion de doublons fermee en V1 (detection lecture seule uniquement)"),
    (re.compile(r'prospection|campagne-marketing'), 'FD-2026-0817-01', "prospection interdite"),
    (re.compile(r'fec'), 'FD-2026-0817-08',
     "FEC closed jusqu'a snapshot comptable serveur conforme (spec 13.3) ; export etiquete preparation comptable"),
    (re.compile(r'compte-supprimer|supprimer-compte|abonnement|subscription|identite-compte|changer-email|mot-de-passe'),
     'FD-2026-0817-02',
     "R4 hors Jarvis : parcours ecran dedie avec auth renforcee ; la voix peut au plus y naviguer"),
]
STEP_UP_FLAGS = {'destructive', 'irreversible', 'mass_action', 'security_sensitive'}
KNOWN_FLAGS = {'external', 'financial', 'legal', 'privacy_sensitive', 'recipient_authority',
               'destructive', 'irreversible', 'third_party_act', 'mass_action', 'security_sensitive'}
# CURATION : mass_action au sens FD-02 = >= 2 destinataires EXTERNES. Les operations
# internes en volume (gerer des dossiers, reglages, notifications) ne le sont pas.
TRUE_MASS_ACTION = re.compile(r'relance.*(groupe|masse|toutes)|envoi.*(groupe|masse)|campagne')


def classify(entry):
    kinds = set(entry['kinds'])
    text = entry['key'] + ' ' + ' '.join(entry['ids'])
    flags = set(entry['flags']) & KNOWN_FLAGS
    closed = None
    for rx, fd, reason in CLOSED_RULES:
        if rx.search(text):
            closed = (fd, reason)
            break
    if kinds <= {'navigation', 'read'}:
        risk, mode = 'L0', 'read'
    elif kinds <= {'prepare', 'read', 'navigation'}:
        risk, mode = 'P1', 'prepare'
    else:
        risk, mode = 'M2', 'confirmable'
        if 'external_send' in kinds or EXTERNAL_KW.search(text):
            risk = 'E3'
            flags.add('external')
        if FINANCIAL_KW.search(text):
            risk = 'E3'
            flags.add('financial')
        if DESTRUCTIVE_KW.search(text) and not DRAFT_KW.search(text):
            flags.add('destructive')
        if SIGNATURE_KW.search(text):
            flags.add('third_party_act')
    if 'mass_action' in flags and not TRUE_MASS_ACTION.search(text):
        flags.discard('mass_action')
    step_up = 'biometric_or_pin' if flags & STEP_UP_FLAGS else 'none'
    if step_up == 'biometric_or_pin' and mode == 'confirmable':
        mode = 'screen_commit'
    if closed:
        mode = 'closed'
    return risk, mode, sorted(flags), step_up, closed


def best_authority(entry):
    counts = Counter(s['authority'] for s in entry['surfaces']
                     if s.get('authority') and s['authority'] != 'inconnu'
                     and 'expo-router' not in s['authority'])
    return counts.most_common(1)[0][0] if counts else None


def surfaces_ts(entry):
    seen, out = set(), []
    for s in entry['surfaces'][:3]:
        src = s['source'][:90]
        if src in seen:
            continue
        seen.add(src)
        platform = 'api' if s['scout'] == 'api-endpoints' else 'mobile'
        out.append('{ platform: %s, route: %s, source: %s }' % (
            json.dumps(platform), json.dumps(src.split(':')[0]), json.dumps(src)))
    return out


# ============================================================================
# CURATION issue de la revue adversariale du 18/08 (workflow wf_1d2fb742-14c,
# 65 findings confirmes + 12 juges par Claude apres mort des refuteurs).
# Chaque entree est auditable : actionId -> correction et justification courte.
# ============================================================================
MERGE_IDS = {
    # doublon -> conserve (surfaces fusionnees)
    'push-activer': 'push-appareil-gerer',
    'facture-lien-paiement-creer': 'facture-lien-paiement',
    'compte-fermer': 'compte-supprimer',
    'compte-cloturer': 'compte-supprimer',
    'societe-rib-modifier': 'iban-modifier',
    'societe-editer-iban': 'iban-modifier',
    'bob-regler-relances-auto': 'impaye-activer-relances-auto',
    'solde-bancaire-confirmer': 'solde-bancaire-declarer',
}

# Regle systemique (revue) : creer/partager un LIEN persiste un grant public
# (publicAccessToken + rotation) — jamais une preparation pure (spec §7).
LINK_GRANT = re.compile(r'lien|partage')

OVERRIDES = {
    # --- grants de liens (revue : P1 interdit des qu'un grant existe) ---
    'devis-partager-lien':   {'risk': 'E3', 'mode': 'confirmable', 'flags+': ['external', 'legal']},
    'devis-lien-signature':  {'risk': 'E3', 'mode': 'confirmable', 'flags+': ['external', 'legal', 'privacy_sensitive']},
    'facture-lien-paiement': {'risk': 'E3', 'mode': 'confirmable', 'flags+': ['external', 'financial']},
    'facture-partager-lien': {'risk': 'M2', 'mode': 'confirmable', 'flags+': ['external']},
    'piece-lien-lecture':    {'risk': 'M2', 'mode': 'confirmable', 'flags+': ['external']},
    'piece-partager':        {'risk': 'M2', 'mode': 'confirmable', 'flags+': ['external']},
    # --- embargo L221-10 (revue : engagement juridique/financier) ---
    'facture-embargo-outrepasser': {'risk': 'E3', 'flags+': ['financial', 'legal']},
    'facture-embargo-programmer':  {'risk': 'E3', 'flags+': ['financial', 'legal']},
    # --- signature (revue : acte du tiers = third_party_wait ; sur place = E3) ---
    'devis-signer-en-ligne':        {'risk': 'E3', 'mode': 'third_party_wait', 'step_up': 'none',
                                     'notes': "acte du CLIENT via lien public — Jarvis observe, ne commite jamais (spec §11, FD-03)"},
    'retractation-exercer-en-ligne': {'risk': 'E3', 'mode': 'third_party_wait', 'step_up': 'none',
                                      'notes': "acte du consommateur (L221-21) — jamais commitable cote tenant"},
    'devis-signer-sur-place': {'risk': 'E3'},
    'devis-signer-appareil':  {'risk': 'E3'},
    'devis-marquer-signe-refuse': {'risk': 'E3', 'flags+': ['irreversible']},
    # --- relances (FD-05 : auto = closed V1 ; mise en demeure = R3, scindee) ---
    'impaye-activer-relances-auto': {'closed': ('FD-2026-0817-05',
        "relances automatiques fermees en V1 ; reouverture post-V1 en mandat R3 borne (§7.2)")},
    'impaye-choisir-cadence-relances': {'closed': ('FD-2026-0817-05',
        "cadence automatique fermee tant que le mandat de campagne (post-V1) n'existe pas")},
    'facture-relancer':   {'notes': "paliers amiable/ferme uniquement — la mise en demeure est l'action dediee relance-mise-en-demeure (R3)"},
    'relance-envoyer':    {'flags-': ['recipient_authority'],
                           'notes': "paliers amiable/ferme — mise en demeure = action dediee R3"},
    'bob-envoyer-relance': {'notes': "paliers amiable/ferme — mise en demeure = action dediee R3"},
    # --- contrats (revue : engagement financier/juridique) ---
    'contrat-resilier':   {'risk': 'E3', 'flags+': ['legal', 'irreversible']},
    'bob-resilier-contrat': {'risk': 'E3', 'flags+': ['legal', 'irreversible']},
    'contrat-activer':    {'risk': 'E3', 'flags+': ['financial', 'legal']},
    'bob-activer-contrat': {'risk': 'E3', 'flags+': ['financial', 'legal']},
    'contrat-cycle-vie':  {'risk': 'E3', 'flags+': ['financial', 'legal', 'irreversible'],
                           'notes': "agrege activer/resilier/renouveler — scinder en U2"},
    'contrat-rediger':    {'flags+': ['financial', 'legal']},
    'bob-creer-contrat-maintenance': {'flags+': ['financial']},
    # --- catalogue (revue : le delete est destructif) ---
    'catalogue-gerer':             {'flags+': ['destructive']},
    'catalogue-prestations-gerer': {'flags+': ['destructive']},
    # --- depenses / interventions ---
    'depense-regulariser':  {'risk': 'E3', 'flags+': ['financial']},
    'intervention-facturer': {'risk': 'M2', 'mode': 'confirmable', 'flags+': ['financial']},
    'depense-affecter-chantier': {'reopen': True, 'risk': 'M2', 'mode': 'confirmable',
                                  'authority': 'AssignExpenseToChantier (PUT /expenses/:id/chantier)'},
    # --- RGPD : coherence privacy_sensitive entre jumeaux (FD-09) ---
    'bob-creer-client':   {'flags+': ['privacy_sensitive']},
    'contact-modifier':   {'flags+': ['privacy_sensitive']},
    'carnet-clients-lire': {'flags+': ['privacy_sensitive']},
    'client-fiche-lire':  {'flags+': ['privacy_sensitive']},
    'document-scanner':   {'flags+': ['privacy_sensitive']},
    'document-deposer':   {'flags+': ['privacy_sensitive']},
    'diagnostic-evaluation-envoyer': {'flags+': ['privacy_sensitive']},
    'client-canal-facturation': {'flags+': ['legal', 'recipient_authority', 'privacy_sensitive']},
    'client-contacts-gerer': {'flags+': ['privacy_sensitive', 'destructive'],
                              'notes': "inclut la suppression definitive de contact (R3) — scinder en U1"},
    # --- societe / compte (liste R3 FD-02) ---
    'identite-legale-modifier': {'flags+': ['legal', 'security_sensitive']},
    'iban-modifier':            {'flags+': ['financial', 'security_sensitive', 'recipient_authority']},
    'societe-modifier':         {'flags+': ['security_sensitive'],
                                 'notes': "agrege IBAN + identite legale (deux items R3) — scinder en U1"},
    'compte-souscrire-offre': {'closed': ('FD-2026-0817-02',
        "R4 hors Jarvis : achat/changement d'abonnement — parcours ecran dedie, la voix peut au plus y naviguer")},
    'compte-session-gerer': {'risk': 'M2', 'mode': 'confirmable', 'flags+': ['external'],
                             'notes': "inclut l'e-mail de reinitialisation (envoi externe) — scinder en U1"},
    'bob-confirmer': {'risk': 'E3', 'flags+': ['external', 'financial'],
                      'notes': "doublon faible de bob-action-confirmer — fusionner en U1"},
    # --- pre-compta / fiscal ---
    'compta-exporter': {'closed': ('FD-2026-0817-08',
        "export FEC ferme jusqu'a snapshot comptable serveur conforme (spec 13.3) ; liste R3 FD-02")},
    'precompta-consulter-exporter': {'risk': 'L0', 'mode': 'read', 'flags-': ['external'],
        'authority': 'listAccountingEntries',
        'notes': "restreinte a la CONSULTATION — l'export FEC vit dans les entrees closed FD-08 dediees"},
}

# Lectures avec init-on-read (spec §13.1 : un L0 prouve zero write) — bloqueur U1.
INIT_ON_READ_NOTE = ("BLOQUANT U1 : le chemin actuel initialise le profil fiscal au premier acces "
                     "(spec 13.1) — separer l'initialisation avant toute admission runtime")
INIT_ON_READ_IDS = {'pilotage-diagnostic-consulter', 'treso-consulter-echeancier-fiscal',
                    'bob-echeances-fiscales', 'tableau-bord-consulter', 'fiscal-consulter-profil'}

# Action dediee issue de la scission relances (FD-05 : mise en demeure = R3).
EXTRA_ENTRIES = ['''  {
    actionId: "relance-mise-en-demeure",
    version: 1,
    label: "Envoyer une mise en demeure (palier R3 de la relance)",
    domain: "impaye",
    status: "specified",
    voiceMode: "screen_commit",
    riskClass: "E3",
    flags: ["external", "financial", "legal", "security_sensitive"],
    stepUp: "biometric_or_pin",
    commandAuthority: "RelanceService.sendRelance (palier miseendemeure)",
    surfaces: [{ platform: "mobile", route: "argent", source: "src/data/relance-plan.ts:25" }],
    founderDecisionIds: ["FD-2026-0817-05"],
    notes: "Scindee de facture-relancer par la revue du 18/08 : FD-05 classe la mise en demeure en envoi R3.",
  },''']

# CURATION : fusion mecanique des collisions d'actionId (meme action vue par
# plusieurs eclaireurs sous des cles semantiques differentes) — union des surfaces,
# risque maximal conserve.
RISK_ORDER = {'L0': 0, 'P1': 1, 'M2': 2, 'E3': 3}
by_final_id: dict[str, dict] = {}
nav_count = 0
for entry in merged:
    if NAV_COLLAPSE.search(entry['ids'][0]) and set(entry['kinds']) == {'navigation'}:
        nav_count += 1
        continue
    aid = sorted(entry['ids'], key=len)[0]
    aid = MERGE_IDS.get(aid, aid)
    if aid in by_final_id:
        tgt = by_final_id[aid]
        tgt['ids'] = sorted(set(tgt['ids']) | set(entry['ids']))
        tgt['kinds'] = sorted(set(tgt['kinds']) | set(entry['kinds']))
        tgt['flags'] = sorted(set(tgt['flags']) | set(entry['flags']))
        tgt['surfaces'].extend(entry['surfaces'])
        tgt['risks'].extend(entry['risks'])
    else:
        by_final_id[aid] = dict(entry)

rows, risk_stats = [], Counter()
for aid, entry in by_final_id.items():
    risk, mode, flags, step_up, closed = classify(entry)
    flags = set(flags)
    notes = None
    text = entry['key'] + ' ' + ' '.join(entry['ids'])

    # Regle systemique revue : un "lien/partage" P1 cree un grant -> M2 minimum.
    if risk == 'P1' and LINK_GRANT.search(text):
        risk, mode = 'M2', 'confirmable'
        flags.add('external')

    ov = OVERRIDES.get(aid)
    if ov:
        if ov.get('reopen'):
            closed = None
        if 'closed' in ov:
            closed = ov['closed']
        risk = ov.get('risk', risk)
        if 'mode' in ov:
            mode = ov['mode']
        flags |= set(ov.get('flags+', []))
        flags -= set(ov.get('flags-', []))
        notes = ov.get('notes')
    if aid in INIT_ON_READ_IDS:
        notes = (notes + ' ; ' if notes else '') + INIT_ON_READ_NOTE

    # Recalcul du plancher apres curation (les flags peuvent avoir change).
    step_up = 'biometric_or_pin' if flags & STEP_UP_FLAGS else \
        (ov or {}).get('step_up', 'none')
    if step_up == 'biometric_or_pin' and mode == 'confirmable':
        mode = 'screen_commit'
    if closed:
        mode = 'closed'
    flags = sorted(flags)

    risk_stats[risk + ('/closed' if closed else '')] += 1
    authority = (ov or {}).get('authority') or best_authority(entry)
    if mode == 'closed':
        auth_ts = 'null'
    elif authority:
        auth_ts = json.dumps(authority[:80])
    else:
        auth_ts = json.dumps('A_EXTRAIRE')
    fd_ts = json.dumps(closed[0]) if closed else ''
    closed_line = '\n    closedReason: %s,' % json.dumps(closed[1]) if closed else ''
    if notes:
        closed_line += '\n    notes: %s,' % json.dumps(notes[:250])
    rows.append(
        '  {\n'
        '    actionId: %s,\n' % json.dumps(aid) +
        '    version: 1,\n'
        '    label: %s,\n' % json.dumps(entry['label'][:110]) +
        '    domain: %s,\n' % json.dumps(entry['domain']) +
        "    status: 'specified',\n"
        '    voiceMode: %s,\n' % json.dumps(mode) +
        '    riskClass: %s,\n' % json.dumps(risk) +
        '    flags: [%s],\n' % ', '.join(json.dumps(f) for f in flags) +
        '    stepUp: %s,\n' % json.dumps(step_up) +
        '    commandAuthority: %s,\n' % auth_ts +
        '    surfaces: [%s],\n' % ', '.join(surfaces_ts(entry)) +
        '    founderDecisionIds: [%s],%s\n' % (fd_ts, closed_line) +
        '  },')

header = '''/**
 * Catalogue des actions publiques — donnee v0 (lot U0).
 *
 * Grain = action metier ; le grain surface vit dans le manifeste
 * PUBLIC_ACTION_SURFACE_MANIFEST_V0. Genere depuis l'inventaire 10 agents du
 * 18/08 puis cure a la main ; chaque entree est `specified` — aucun statut
 * superieur sans le gate correspondant (spec section 21).
 */

import type { ActionCatalogEntry } from './types';

export const ACTION_CATALOG_V0: readonly ActionCatalogEntry[] = [
  {
    actionId: "ecran-ouvrir",
    version: 1,
    label: "Ouvrir un ecran de l'application (navigation generalisee)",
    domain: "contexte",
    status: "specified",
    voiceMode: "read",
    riskClass: "L0",
    flags: [],
    stepUp: "none",
    commandAuthority: "expo-router",
    surfaces: [{ platform: "mobile", route: "*", source: "apps/mobile/app (37 routes, manifeste v0)" }],
    founderDecisionIds: [],
    notes: "Les routes de navigation du manifeste v0 se replient ici : une action, N surfaces.",
  },
'''
rows.extend(EXTRA_ENTRIES)
with open(SC + '/catalog.data.ts', 'w') as f:
    f.write(header + '\n'.join(rows) + '\n];\n')

print('navigation repliee:', nav_count, 'lignes -> 1 action')
print('entrees catalogue:', len(rows) + 1)
print('repartition risque:', dict(risk_stats.most_common()))
