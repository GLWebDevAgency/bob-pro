"""Fusion mécanique de l'inventaire : normalisation, dédup par clé sémantique, provenance."""
import json
import re
from collections import defaultdict

path = ('/private/tmp/claude-501/-Users-limameghassene-development-Bob-Pro/'
        '8adbf03e-f9b0-4f6f-a398-af1cd251c59d/tasks/wvata6i3w.output')

with open(path) as f:
    data = json.load(f)['result']

DOMAIN_MAP = {
    'parc': 'parc_intervention', 'societe': 'societe_reglages', 'compte': 'societe_reglages',
    'autre': 'contexte',
}

STOPWORDS = {'un', 'une', 'le', 'la', 'les', 'de', 'du', 'des', 'a', 'au', 'aux', 'en', 'et', 'ou', 'sur', 'dans', 'pour', 'par', 'avec', 'sans', 'd', 'l'}

VERB_MAP = {
    'creer': 'creer', 'create': 'creer', 'ajouter': 'creer', 'add': 'creer', 'nouvelle': 'creer', 'nouveau': 'creer',
    'modifier': 'modifier', 'update': 'modifier', 'editer': 'modifier', 'edit': 'modifier', 'changer': 'modifier', 'renommer': 'modifier',
    'supprimer': 'supprimer', 'delete': 'supprimer', 'retirer': 'supprimer',
    'lister': 'lister', 'list': 'lister', 'consulter': 'consulter', 'voir': 'consulter', 'lire': 'consulter', 'afficher': 'consulter',
    'envoyer': 'envoyer', 'send': 'envoyer', 'emettre': 'emettre', 'issue': 'emettre',
    'ouvrir': 'ouvrir', 'naviguer': 'ouvrir', 'rechercher': 'rechercher', 'search': 'rechercher',
    'enregistrer': 'enregistrer', 'record': 'enregistrer', 'marquer': 'marquer',
    'telecharger': 'telecharger', 'download': 'telecharger', 'exporter': 'exporter', 'export': 'exporter',
    'dupliquer': 'dupliquer', 'annuler': 'annuler', 'relancer': 'relancer', 'classer': 'classer',
}


def norm_token(tok: str) -> str:
    tok = tok.lower()
    return VERB_MAP.get(tok, tok)


def semantic_key(action: dict) -> str:
    domain = DOMAIN_MAP.get(action['domain'], action['domain'])
    toks = [norm_token(t) for t in re.split(r'[-_ /]', action['id']) if t and t not in STOPWORDS]
    # trier pour que 'client-creer' et 'creer-client' fusionnent
    return domain + '|' + '-'.join(sorted(set(toks)))


merged: dict[str, dict] = {}
order: list[str] = []
for scout in data['scouts']:
    for action in scout['actions']:
        key = semantic_key(action)
        entry = merged.get(key)
        surface = {'scout': scout['key'], 'source': action['source'],
                   'authority': action.get('authority', 'inconnu')}
        if entry is None:
            merged[key] = {
                'key': key,
                'ids': [action['id']],
                'label': action['label'],
                'domain': DOMAIN_MAP.get(action['domain'], action['domain']),
                'kinds': [action['kind']],
                'risks': [action.get('risk')],
                'flags': sorted(set(action.get('flags', []))),
                'surfaces': [surface],
                'notes': [action.get('notes', '')],
            }
            order.append(key)
        else:
            entry['ids'].append(action['id'])
            entry['kinds'].append(action['kind'])
            entry['risks'].append(action.get('risk'))
            entry['flags'] = sorted(set(entry['flags']) | set(action.get('flags', [])))
            entry['surfaces'].append(surface)
            entry['notes'].append(action.get('notes', ''))

# ajouter les 2 manquants du critique
for missing in data['critique']['missing']:
    key = semantic_key(missing)
    if key not in merged:
        merged[key] = {
            'key': key, 'ids': [missing['id']],
            'label': missing['id'].replace('-', ' '),
            'domain': DOMAIN_MAP.get(missing['domain'], missing['domain']),
            'kinds': ['mutation'], 'risks': [None], 'flags': [],
            'surfaces': [{'scout': 'critique', 'source': missing['why'][:120], 'authority': 'inconnu'}],
            'notes': [missing['why']],
        }
        order.append(key)

out = [merged[k] for k in order]
result_path = ('/private/tmp/claude-501/-Users-limameghassene-development-Bob-Pro/'
               '8adbf03e-f9b0-4f6f-a398-af1cd251c59d/scratchpad/merged_inventory.json')
with open(result_path, 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

from collections import Counter
print(f'704 brutes -> {len(out)} actions fusionnees')
print('multi-angles (>=2 surfaces):', sum(1 for e in out if len(e["surfaces"]) >= 2))
print('mono-angle:', sum(1 for e in out if len(e["surfaces"]) == 1))
print('par domaine:', dict(Counter(e['domain'] for e in out).most_common()))
disagree = [e for e in out if len({r for r in e['risks'] if r}) > 1]
print(f'desaccords de risque entre eclaireurs: {len(disagree)}')
for e in disagree[:12]:
    print(f"  {e['key']}: {sorted({r for r in e['risks'] if r})}")
