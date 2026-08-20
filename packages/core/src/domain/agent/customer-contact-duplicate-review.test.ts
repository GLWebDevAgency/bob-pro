/**
 * Jarvis U1-g — LA DÉRIVATION DE REVUE (SPEC_U1G §3/§4).
 *
 * Ce que ces preuves défendent : « je ne sais pas » ne devient JAMAIS « aucun doublon ». C'est la
 * garde qui fait la valeur du lot — un seul repli silencieux vers `no_duplicates` écrirait un fait
 * certifié faux dans un journal immuable, et brûlerait l'unique fenêtre de résolution du run.
 */
import { describe, expect, it } from 'vitest';

import type { CustomerCandidate } from '../../application/ports/customer-candidate-search';
import {
  CUSTOMER_CONTACT_SPOKEN_LABEL_LIMIT,
  deriveCustomerContactDuplicateReview,
  type CustomerContactDuplicateProbe,
} from './customer-contact-duplicate-review';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const AUTRE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';

function candidat(over: Partial<CustomerCandidate> = {}): CustomerCandidate {
  return {
    customerId: 'customer-1',
    canonicalName: 'Dupont Plomberie',
    matchKind: 'fuzzy',
    score: 0.8,
    ...over,
  };
}

function derive(
  candidates: readonly CustomerCandidate[],
  query = 'Dupont Plomberie',
): CustomerContactDuplicateProbe {
  return deriveCustomerContactDuplicateReview({
    runId: RUN_ID,
    commandId: COMMAND_ID,
    query,
    candidates,
  });
}

describe('deriveCustomerContactDuplicateReview — la revue de doublons', () => {
  it('aucun candidat ⇒ `no_duplicates` : c’est le SEUL chemin qui y mène', () => {
    expect(derive([])).toEqual({ kind: 'no_duplicates' });
  });

  it('CONSERVE l’ordre de l’adaptateur — re-trier ferait diverger Bob du résolveur du devis', () => {
    const probe = derive([
      candidat({ customerId: 'c-exact', canonicalName: 'Dupont Plomberie', matchKind: 'exact', score: 1 }),
      candidat({ customerId: 'c-proche', canonicalName: 'Dupont Plomberie SARL', score: 0.7 }),
      candidat({ customerId: 'c-loin', canonicalName: 'Dupond Plomberie', score: 0.6 }),
    ]);
    if (probe.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    expect(probe.candidates.map((c) => c.customerId)).toEqual(['c-exact', 'c-proche', 'c-loin']);
    // Les libellés sont ALIGNÉS sur l'ordinal : c'est par le rang que l'artisan choisit.
    expect(probe.labels).toEqual(['Dupont Plomberie', 'Dupont Plomberie SARL', 'Dupond Plomberie']);
    expect(probe.moreThanShown).toBe(false);
  });

  it('un candidat EXACT unique reste une SUGGESTION, jamais une décision prise à sa place', () => {
    const probe = derive([candidat({ matchKind: 'exact', score: 1 })]);
    expect(probe.kind).toBe('duplicate_candidates');
  });

  it('une page saturée est TRONQUÉE et le dit — on ne prétend jamais être exhaustif', () => {
    const six = Array.from({ length: 6 }, (_, index) =>
      candidat({ customerId: `c-${index}`, canonicalName: `Dupont ${index}` }),
    );
    const probe = derive(six);
    if (probe.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    expect(probe.candidates).toHaveLength(5);
    expect(probe.labels).toHaveLength(5);
    expect(probe.moreThanShown).toBe(true);
  });

  it('une identité EN DOUBLE est une dérive de la base : refus, JAMAIS une déduplication muette', () => {
    const probe = derive([candidat({ customerId: 'c-1' }), candidat({ customerId: 'c-1' })]);
    expect(probe).toEqual({ kind: 'unusable', reason: 'invalid_candidate_set' });
  });

  it('un candidat ABERRANT rend le jeu inexploitable — et surtout PAS `no_duplicates`', () => {
    // Chacun de ces cas signale une base qui a dérivé. Conclure « aucun doublon » serait le pire :
    // on créerait une fiche en double en ayant certifié le contraire.
    const aberrants: readonly CustomerCandidate[][] = [
      [candidat({ canonicalName: '   ' })],
      [candidat({ score: 1.4 })],
      [candidat({ score: Number.NaN })],
      [candidat({ customerId: '' })],
      [candidat({ matchKind: 'approx' as unknown as 'fuzzy' })],
    ];
    for (const jeu of aberrants) {
      const probe = derive(jeu);
      expect(probe.kind).toBe('unusable');
      expect(probe.kind === 'unusable' && probe.reason).toBe('invalid_candidate_set');
    }
  });

  it('une requête hors forme est REFUSÉE : sans terme de recherche, il n’y a pas de « rien trouvé »', () => {
    expect(derive([candidat()], '   ')).toEqual({ kind: 'unusable', reason: 'invalid_query' });
    expect(derive([candidat()], 'x'.repeat(201))).toEqual({
      kind: 'unusable',
      reason: 'invalid_query',
    });
    // Et même sans AUCUN candidat : on ne dit pas « aucun doublon » pour une requête invalide.
    expect(derive([], '')).toEqual({ kind: 'unusable', reason: 'invalid_query' });
  });

  it('est DÉTERMINISTE : deux dérivations du même monde rendent le même octet', () => {
    const jeu = [candidat({ customerId: 'c-1' }), candidat({ customerId: 'c-2' })];
    expect(derive(jeu)).toEqual(derive(jeu));
  });

  it('CLOISONNE l’évidence par run : deux runs ne partagent ni identité de choix ni digest', () => {
    const jeu = [candidat()];
    const ici = derive(jeu);
    const ailleurs = deriveCustomerContactDuplicateReview({
      runId: AUTRE_RUN_ID,
      commandId: COMMAND_ID,
      query: 'Dupont Plomberie',
      candidates: jeu,
    });
    if (ici.kind !== 'duplicate_candidates' || ailleurs.kind !== 'duplicate_candidates') {
      throw new Error('revues attendues');
    }
    expect(ici.reviewId).not.toBe(ailleurs.reviewId);
    expect(ici.candidates[0]?.matchDigest).not.toBe(ailleurs.candidates[0]?.matchDigest);
    expect(ici.candidates[0]?.choiceId).not.toBe(ailleurs.candidates[0]?.choiceId);
  });

  it('l’évidence porte sur le nom D’ALORS : renommer la fiche change le digest', () => {
    const avant = derive([candidat({ canonicalName: 'Dupont Plomberie' })]);
    const apres = derive([candidat({ canonicalName: 'Dupont Plomberie SARL' })]);
    if (avant.kind !== 'duplicate_candidates' || apres.kind !== 'duplicate_candidates') {
      throw new Error('revues attendues');
    }
    // Comportement VOULU et figé : l'évidence dit « au moment de la revue, ces noms se
    // ressemblaient » — pas « cette fiche est un doublon pour toujours ».
    expect(avant.candidates[0]?.matchDigest).not.toBe(apres.candidates[0]?.matchDigest);
  });

  it('NE FAIT SORTIR AUCUN NOM dans ce qui sera scellé', () => {
    const probe = derive([candidat({ canonicalName: 'Zorglub Ferronnerie' })]);
    if (probe.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    // Les libellés vivent À PART, pour la parole. Le scellé, lui, ne porte que des digests.
    expect(JSON.stringify(probe.candidates)).not.toContain('Zorglub');
    expect(probe.labels).toContain('Zorglub Ferronnerie');
  });

  it('une requête SANS AUCUN trigramme ne scelle JAMAIS « aucun doublon »', () => {
    // `pg_trgm` ne tire de trigrammes que des caractères alphanumériques. Sans un seul, la branche
    // de similarité est structurellement morte : zéro résultat n'y prouve RIEN — surtout pas une
    // absence. Mesuré sur PostgreSQL 17.6 : show_trgm('?') = show_trgm('-') = show_trgm('&') = {}.
    for (const requete of ['?', '...', '-', '&', '   ...   ', '!?!']) {
      expect(derive([], requete)).toEqual({ kind: 'unusable', reason: 'invalid_query' });
    }
  });

  it('UN SEUL caractère alphanumérique suffit — refuser plus casserait « H&M » et « J-C »', () => {
    // LE DEFAUT QUE CETTE PREUVE FERME. Une première garde exigeait un MOT de deux caractères, en
    // généralisant a tort word_similarity('d','dupont plomberie') = 0,5 — ce 0,5 vient de la
    // longueur du mot CIBLE, pas de la requête. Mesuré sur PostgreSQL 17.6 :
    //   'h&m' <% 'h&m paris centre' = t (ws = 1) · 'j-c' <% 'j-c dupont' = t · '4' <% '4 murs' = t
    // Ces noms devenaient IMPOSSIBLES à créer à la voix, et Bob répondait « je ne peux pas
    // vérifier » juste après avoir vérifié — la garde produisait l'inverse de son objet.
    for (const requete of ['H&M', 'C&A', 'B&B', 'J-C', 'A.B.C.', 'M. K', 'A', 'd', '4', 'Éé']) {
      expect(derive([], requete)).toEqual({ kind: 'no_duplicates' });
    }
  });

  it('deux fiches DISTINCTES restent distinctes à l’oreille — la borne ne les fusionne pas', () => {
    // Sans l'élision médiane, ces deux syndics produisaient le MÊME libellé : l'artisan choisissait
    // à l'aveugle et scellait un rattachement durable une fois sur deux vers la mauvaise fiche.
    const prefixe =
      'SYNDIC RESIDENCE LES JARDINS DE BELLEVUE - BATIMENT A - ESCALIER 2 - PORTE 12 - RESIDENCE DU PARC ET DES GRANDS JARDINS FLEURIS';
    const probe = derive([
      candidat({ customerId: 'c-1', canonicalName: `${prefixe} - PARIS 11E` }),
      candidat({ customerId: 'c-2', canonicalName: `${prefixe} - PARIS 12E` }),
    ]);
    if (probe.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    expect(probe.labels[0]).not.toBe(probe.labels[1]);
    expect(probe.labels[0]).toContain('11E');
    expect(probe.labels[1]).toContain('12E');
  });

  it('la garde ne mord QUE sur l’absence : des candidats trouvés restent présentables', () => {
    // La branche d'ÉGALITÉ du SQL marche à n'importe quelle longueur : une fiche nommée « A » est
    // réellement trouvable. Refuser la revue ici retirerait une capacité sans rien protéger.
    const probe = derive([candidat({ canonicalName: 'A' })], 'A');
    expect(probe.kind).toBe('duplicate_candidates');
  });

  it('ASSAINIT les libellés parlés — un invisible relu en base rendrait l’assistant muet', () => {
    // U+200B franchit le validateur de création (qui ne refuse que les contrôles ASCII), se
    // stocke, ressort ici, entre dans la parole puis dans l'historique — que le planner rejette
    // ENTIER, devis compris. L'assainissement est le seul endroit où cela s'arrête.
    const probe = derive([candidat({ canonicalName: 'Dupont\u200b\u00a0Plomberie' })]);
    if (probe.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    expect(probe.labels).toEqual(['Dupont Plomberie']);
  });

  it('BORNE les libellés parlés, et l’évidence continue de porter le nom ENTIER', () => {
    const nom = 'A'.repeat(200);
    const probe = derive([candidat({ canonicalName: nom })]);
    if (probe.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    expect(Array.from(probe.labels[0] ?? '')).toHaveLength(CUSTOMER_CONTACT_SPOKEN_LABEL_LIMIT);
    expect(probe.labels[0]).toContain('\u2026');
    // Un nom RÉEL, lui, passe entier : la borne du dépôt pour un libellé présenté est 160.
    const reel = derive([candidat({ canonicalName: 'Ateliers Bâtiment & Fils de Dupont-Plomberie' })]);
    if (reel.kind !== 'duplicate_candidates') throw new Error('revue attendue');
    expect(reel.labels[0]).toBe('Ateliers Bâtiment & Fils de Dupont-Plomberie');
    // Ce qui est SCELLÉ ne dépend pas de ce qui est DIT : le digest reste celui du nom complet.
    const entier = derive([candidat({ canonicalName: nom })]);
    const tronque = derive([candidat({ canonicalName: `${nom}B` })]);
    if (entier.kind !== 'duplicate_candidates' || tronque.kind !== 'duplicate_candidates') {
      throw new Error('revues attendues');
    }
    expect(entier.candidates[0]?.matchDigest).not.toBe(tronque.candidates[0]?.matchDigest);
  });

  it('un nom qui ne laisse RIEN une fois assaini est une dérive — jamais un libellé de secours', () => {
    const probe = derive([candidat({ canonicalName: '\u200b\u200b' })]);
    expect(probe).toEqual({ kind: 'unusable', reason: 'invalid_candidate_set' });
  });
});
