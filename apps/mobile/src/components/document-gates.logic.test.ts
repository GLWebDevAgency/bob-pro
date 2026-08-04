import { describe, expect, it } from 'vitest';
import type { CompanyProps } from '@bob/core';
import {
  companyCanIssue,
  companyIssueBlocker,
  type CompanyIssueBlocker,
} from '../data/company-completeness';
import {
  companyIncompleteGateSpec,
  paymentTermsMissingGateSpec,
  FIELD_EDITOR_ROUTE,
} from './document-gates.logic';

/**
 * RÉGRESSION du cul-de-sac d'émission (terrain 20/07) : le gate « entreprise incomplète »
 * routait vers `/compte`, écran qui ne porte aucun des champs exigés — l'utilisateur ne
 * pouvait réparer NULLE PART et n'émettait plus jamais de facture.
 */
describe('destination des gates d’émission', () => {
  it('envoie le gate « entreprise incomplète » vers l’écran qui édite les champs d’identité', () => {
    for (const blocker of [null, 'rcsOrRm', 'address', 'capitalSocial', 'tvaIntracom'] as const) {
      expect(companyIncompleteGateSpec(blocker, 'pote').route).toBe('/reglages-facturation');
    }
  });

  it('ne route JAMAIS un blocage d’émission vers /compte (aucun de ces champs n’y vit)', () => {
    const routes = [
      companyIncompleteGateSpec(null, 'pro').route,
      companyIncompleteGateSpec('capitalSocial', 'direct').route,
      paymentTermsMissingGateSpec('pote').route,
    ];
    expect(routes).not.toContain('/compte');
  });

  it('dérive la route de la carte champ → écran (pas d’URL écrite à la main dans le gate)', () => {
    expect(companyIncompleteGateSpec('rcsOrRm', 'pote').route).toBe(FIELD_EDITOR_ROUTE.rcsOrRm);
    expect(companyIncompleteGateSpec(null, 'pote').route).toBe(FIELD_EDITOR_ROUTE.rcsOrRm);
    expect(paymentTermsMissingGateSpec('pote').route).toBe(FIELD_EDITOR_ROUTE.paymentTerms);
  });

  it('décline les textes sur les 3 tons, sans clé manquante — repli générique compris', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      for (const blocker of [null, 'capitalSocial'] as const) {
        const gate = companyIncompleteGateSpec(blocker, personality);
        for (const text of [gate.title, gate.body, gate.ctaLabel, gate.cancelLabel]) {
          expect(text.length).toBeGreaterThan(0);
          // Une clé absente du catalogue ne compile pas (I18nKey) — ceci garde le runtime
          // contre un texte qui serait la clé elle-même après un refactor du catalogue.
          expect(text.startsWith('gate.')).toBe(false);
        }
      }
    }
  });
});

/**
 * ═══════════════════════════ VERROU ANTI-RÉCIDIVE ═══════════════════════════
 * Troisième occurrence de la famille « cul-de-sac d'exigence légale » :
 *  · 20/07 — gate routé vers un écran qui n'éditait pas les champs exigés ;
 *  · 30/07 (FLY SERVICES) — exigence domaine (capital social d'une SAS) sans éditeur mobile,
 *    sans ligne d'affichage NI message qui la nomme : fiche visiblement complète, émission
 *    refusée en boucle par un texte générique.
 *
 * CE TEST provoque CHAQUE refus de `Company.assertCanIssue()` un par un sur une fixture
 * émissible, et exige la chaîne complète pour chacun :
 *  (a) `companyIssueBlocker` NOMME le champ (le domaine parle, la carte traduit) ;
 *  (b) `FIELD_EDITOR_ROUTE` porte l'écran qui l'édite réellement ;
 *  (c) le corps i18n existe pour les 3 personnalités et NOMME (≠ du corps générique).
 *
 * ⚠️ SI LA SENTINELLE ROUGIT : le domaine a gagné une exigence d'émission. NE contourne PAS ce
 * test en bricolant la fixture : ajoute (1) le cas qui provoque la nouvelle exigence ci-dessous,
 * (2) son éditeur mobile (LegalIdentityEditSheet ou l'écran qui la porte), (3) sa route dans
 * FIELD_EDITOR_ROUTE, (4) sa clé de corps dans COMPANY_GATE_BODY_KEY et le catalogue i18n.
 * Sinon tu recrées EXACTEMENT le bug FLY SERVICES : un blocage légal muet et sans issue.
 */
describe('VERROU anti-récidive — chaque refus d’assertCanIssue a un éditeur et un message', () => {
  /** SAS au régime réel, TOUTES les exigences d'émission satisfaites (émissible aujourd'hui). */
  const ISSUABLE: CompanyProps = {
    id: 'company-fly',
    name: 'FLY SERVICES',
    legalForm: 'SAS',
    siren: '732829320',
    siret: '73282932000074',
    trade: 'mainteneur',
    vatRegime: 'reel_normal',
    tvaIntracom: 'FR44732829320',
    rcsOrRm: '732 829 320 RCS Paris',
    capitalSocialCents: 100_000,
    address: { line1: '5 rue des Ateliers', zip: '93100', city: 'Montreuil' },
  };

  it('SENTINELLE : la fixture est émissible — si ce point rougit, lis l’en-tête du describe', () => {
    expect(companyCanIssue(ISSUABLE)).toBe(true);
    expect(companyIssueBlocker(ISSUABLE)).toBeNull();
  });

  const omit = <K extends keyof CompanyProps>(key: K): CompanyProps => {
    const { [key]: _removed, ...rest } = ISSUABLE;
    return rest as CompanyProps;
  };

  const CASES: readonly { casse: string; props: CompanyProps; attendu: CompanyIssueBlocker }[] = [
    { casse: 'sans n° RCS/RM', props: omit('rcsOrRm'), attendu: 'rcsOrRm' },
    {
      casse: 'adresse vidée',
      props: { ...ISSUABLE, address: { line1: '  ', zip: '', city: '' } },
      attendu: 'address',
    },
    {
      casse: 'code postal seul manquant (le domaine exige l’adresse COMPLÈTE)',
      props: { ...ISSUABLE, address: { ...ISSUABLE.address, zip: ' ' } },
      attendu: 'address',
    },
    {
      casse: 'société sans capital social — LE bug FLY SERVICES',
      props: omit('capitalSocialCents'),
      attendu: 'capitalSocial',
    },
    {
      casse: 'régime réel sans TVA attribuée',
      props: omit('tvaIntracom'),
      attendu: 'tvaIntracom',
    },
  ];

  it.each(CASES)('$casse → champ nommé, écran éditeur, message qui nomme', ({ props, attendu }) => {
    // (a) le refus du domaine est NOMMÉ dans le vocabulaire des gates.
    const blocker = companyIssueBlocker(props);
    expect(companyCanIssue(props)).toBe(false);
    expect(blocker).toBe(attendu);
    if (blocker === null) throw new Error('inatteignable — garde de type');
    // (b) un écran édite réellement ce champ (identité = §Identité, en tête : route nue).
    expect(FIELD_EDITOR_ROUTE[blocker]).toBe('/reglages-facturation');
    // (b') les conditions de paiement vivent tout en bas de la page : route ANCRÉE (audit QA A4).
    expect(FIELD_EDITOR_ROUTE.paymentTerms).toBe('/reglages-facturation?section=paymentTerms');
    // (c) le corps du gate existe sur les 3 tons et NOMME (≠ du repli générique).
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const named = companyIncompleteGateSpec(blocker, personality);
      const generic = companyIncompleteGateSpec(null, personality);
      expect(named.route).toBe(FIELD_EDITOR_ROUTE[blocker]);
      expect(named.body.length).toBeGreaterThan(0);
      expect(named.body.startsWith('gate.')).toBe(false);
      expect(named.body).not.toBe(generic.body);
    }
  });

  it('couverture du vocabulaire : chaque champ nommable est provoqué par un cas ci-dessus', () => {
    // Ajouter un champ aux cartes SANS le cas qui le provoque laisserait le verrou aveugle sur
    // ce champ — ce test force la symétrie cas ↔ vocabulaire.
    const provoques = [...new Set(CASES.map((c) => c.attendu))].sort();
    const vocabulaire = Object.keys(FIELD_EDITOR_ROUTE)
      .filter((field) => field !== 'paymentTerms')
      .sort();
    expect(provoques).toEqual(vocabulaire);
  });
});
