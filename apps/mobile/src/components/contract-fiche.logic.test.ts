import { describe, expect, it } from 'vitest';
import { MAX_CONTRACT_LABEL_LENGTH } from '@bob/core';
import { t } from '@bob/i18n';
import {
  contractEventDay,
  contractHistoryEntries,
  contractPrimaryCta,
  contractRenameAllowed,
  contractRenameCloseEffect,
  contractRenameNotice,
  contractRenameSubmission,
  frContractDate,
  importCoveredUntilFromInclusive,
  inclusiveFromImportCoveredUntil,
  inclusivePeriodOf,
  isContractRevisionConflict,
} from './contract-fiche.logic';

describe('[annexe erratum n° 4] importCoveredUntil — saisie INCLUSIVE → colonne EXCLUSIVE', () => {
  it('convertit +1 jour : « facturé jusqu’au 11/10/2026 inclus » → borne exclusive 2026-10-12', () => {
    expect(importCoveredUntilFromInclusive('2026-10-11')).toBe('2026-10-12');
  });

  it('anti off-by-one : la période migrée [2025-10-12, 2026-10-12) est ENTIÈREMENT couverte par la saisie 2026-10-11', () => {
    // La dérivation compare period.end ≤ importCoveredUntil (bornes exclusives toutes deux) :
    // sans la conversion, la saisie brute (2026-10-11) laisserait period.end (2026-10-12) >
    // importCoveredUntil → « facture annuelle à émettre » à TORT sur toute la flotte migrée
    // au jour 1 — exactement le bruit que P13 corrige, recréé par un off-by-one.
    const periodEndExclusive = '2026-10-12';
    const converted = importCoveredUntilFromInclusive('2026-10-11');
    expect(converted).not.toBeNull();
    expect(periodEndExclusive <= converted!).toBe(true);
    // Et la saisie de la VEILLE (2026-10-10) ne couvre PAS la période : rien n'est sur-couvert.
    const dayBefore = importCoveredUntilFromInclusive('2026-10-10');
    expect(periodEndExclusive <= dayBefore!).toBe(false);
  });

  it('traverse les fins de mois et d’année sans trou (31/12 → 01/01, 28/02 → 01/03)', () => {
    expect(importCoveredUntilFromInclusive('2026-12-31')).toBe('2027-01-01');
    expect(importCoveredUntilFromInclusive('2027-02-28')).toBe('2027-03-01');
  });

  it('vide ou invalide → null (champ optionnel, jamais une date inventée)', () => {
    expect(importCoveredUntilFromInclusive('')).toBeNull();
    expect(importCoveredUntilFromInclusive('  ')).toBeNull();
    expect(importCoveredUntilFromInclusive('11/10/2026')).toBeNull();
  });

  it('inverse exacte pour l’édition : colonne exclusive → affichage inclusif (aller-retour stable)', () => {
    expect(inclusiveFromImportCoveredUntil('2026-10-12')).toBe('2026-10-11');
    expect(inclusiveFromImportCoveredUntil(null)).toBe('');
    const inclusive = '2026-10-11';
    expect(inclusiveFromImportCoveredUntil(importCoveredUntilFromInclusive(inclusive))).toBe(inclusive);
  });
});

describe('affichage des périodes — bornes INCLUSES lisibles (amélioration 5)', () => {
  it('montre la VEILLE de la fin exclusive (jamais une borne qui ment d’un jour)', () => {
    expect(inclusivePeriodOf({ start: '2025-10-12', end: '2026-10-12' })).toEqual({
      start: '2025-10-12',
      end: '2026-10-11',
    });
  });

  it('frContractDate : dates complètes en toutes lettres (a11y — jamais couleur seule)', () => {
    expect(frContractDate('2026-10-12')).toBe('12 oct. 2026');
    expect(frContractDate('2027-02-01')).toBe('1 févr. 2027');
  });
});

describe('historique honnête [revue P10] — faits stockés + reconductions étiquetées (calculé)', () => {
  it('mêle activation (stockée), reconductions (calculées) et résiliation (stockée + motif), tri décroissant', () => {
    const entries = contractHistoryEntries({
      contract: {
        activatedAt: '2024-10-12T08:00:00.000Z',
        terminatedAt: '2026-11-02T09:00:00.000Z',
        terminationNote: 'Marché perdu.',
      },
      renewals: ['2025-10-12', '2026-10-12'],
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      'terminated',
      'renewed',
      'renewed',
      'activated',
    ]);
    expect(entries.filter((entry) => entry.computed).map((entry) => entry.kind)).toEqual([
      'renewed',
      'renewed',
    ]);
    expect(entries[0]!.note).toBe('Marché perdu.');
  });

  /**
   * MÊME faille que celle corrigée sur TerminateContract (97a96840) : `.slice(0, 10)` rend le
   * jour UTC, pas le jour MÉTIER. Entre 00 h et 02 h à Paris, l'UTC est encore la VEILLE —
   * l'historique daterait activation et résiliation d'un jour trop tôt, et le pro lirait une
   * date qui ne correspond ni à son geste ni à ce que le domaine a écrit.
   */
  it('[jour MÉTIER Paris] un fait posé à 00 h 30 n’est jamais daté de la veille', () => {
    const entries = contractHistoryEntries({
      contract: {
        // 12/10/2024 22 h 30 UTC = 13 octobre 00 h 30 à Paris (CEST, UTC+2).
        activatedAt: '2024-10-12T22:30:00.000Z',
        // 02/11/2026 23 h 30 UTC = 3 novembre 00 h 30 à Paris (CET, UTC+1).
        terminatedAt: '2026-11-02T23:30:00.000Z',
        terminationNote: 'Marché perdu.',
      },
      renewals: [],
    });
    expect(entries.map((entry) => entry.at)).toEqual(['2026-11-03', '2024-10-13']);
  });

  it('contractEventDay : jour métier Paris d’un instant stocké, null si le fait n’existe pas', () => {
    expect(contractEventDay('2026-11-02T23:30:00.000Z')).toBe('2026-11-03');
    // Même instant lu en plein jour : aucun décalage inventé.
    expect(contractEventDay('2026-11-02T09:00:00.000Z')).toBe('2026-11-02');
    expect(contractEventDay(null)).toBeNull();
    expect(contractEventDay('')).toBeNull();
  });

  it('brouillon jamais activé : historique vide (aucun fait inventé)', () => {
    expect(
      contractHistoryEntries({
        contract: { activatedAt: null, terminatedAt: null, terminationNote: null },
        renewals: [],
      }),
    ).toEqual([]);
  });
});

describe('CTA primaire §3.1 — dérivé, transitions interdites = CTA ABSENTS', () => {
  it('draft → Activer ; active + due → Préparer ; active couvert → aucun ; résilié → aucun', () => {
    expect(contractPrimaryCta({ status: 'draft', billingDue: null })).toBe('activate');
    expect(contractPrimaryCta({ status: 'active', billingDue: { period: {} } })).toBe(
      'prepare_annual_invoice',
    );
    expect(contractPrimaryCta({ status: 'active', billingDue: null })).toBeNull();
    expect(contractPrimaryCta({ status: 'terminated', billingDue: null })).toBeNull();
  });
});

describe('Renommer — le remède que la garde du libellé PROMET (« un tap sur la fiche »)', () => {
  it('champ pré-rempli intact ⇒ « unchanged » : un bouton qui attend, jamais une erreur', () => {
    expect(
      contractRenameSubmission({ current: 'Entretien fontaines', typed: 'Entretien fontaines' }),
    ).toEqual({ label: null, blocked: 'unchanged' });
    // Seulement re-espacé : intact aussi — sinon la révision tournerait pour rien.
    expect(
      contractRenameSubmission({ current: 'Entretien fontaines', typed: '  Entretien fontaines  ' }),
    ).toEqual({ label: null, blocked: 'unchanged' });
  });

  it('nom changé ⇒ part TRIMÉ (le serveur reçoit ce que le pro lit, pas ses espaces)', () => {
    expect(
      contractRenameSubmission({
        current: 'Entretien fontaines',
        typed: '  Entretien fontaines quai 3 ',
      }),
    ).toEqual({ label: 'Entretien fontaines quai 3', blocked: null });
  });

  it('vidé ⇒ « vide » : le domaine exige un nom, l’écran le dit AVANT l’appel', () => {
    expect(contractRenameSubmission({ current: 'Entretien fontaines', typed: '   ' })).toEqual({
      label: null,
      blocked: 'vide',
    });
  });

  it('borné par le DOMAINE : la borne exacte passe, un caractère de plus est refusé avant l’appel', () => {
    const current = 'Entretien fontaines';
    expect(
      contractRenameSubmission({ current, typed: 'a'.repeat(MAX_CONTRACT_LABEL_LENGTH) }).blocked,
    ).toBeNull();
    expect(
      contractRenameSubmission({ current, typed: 'a'.repeat(MAX_CONTRACT_LABEL_LENGTH + 1) }).blocked,
    ).toBe('trop_long');
  });

  it('caractères de contrôle collés ⇒ refusés (même règle mono-ligne que le domaine)', () => {
    expect(
      contractRenameSubmission({ current: 'Entretien', typed: 'Entretien\u0007fontaines' }).blocked,
    ).toBe('caractere_de_controle');
  });

  it('le nom TAPÉ n’est PAS soumis à la garde des noms DÉDUITS — sinon le remède serait un cul-de-sac', () => {
    // « Contrat mars 1 200 euros » réunit ce que `inspectContractLabel` refuse le plus durement
    // (date, somme, mot monétaire quantifié). Écrit à la main et relu par l'artisan, il passe :
    // c'est précisément le genre de nom qu'une extraction ratée a pu laisser sur la fiche, et
    // que ce geste doit pouvoir corriger — ou assumer. Seul le domaine borne.
    expect(
      contractRenameSubmission({ current: 'Ancien nom', typed: 'Contrat mars 1 200 euros' }),
    ).toEqual({ label: 'Contrat mars 1 200 euros', blocked: null });
  });

  it('résilié = « lecture seule » côté domaine ⇒ affordance ABSENTE, jamais grisée (§3.1)', () => {
    expect(contractRenameAllowed('draft')).toBe(true);
    expect(contractRenameAllowed('active')).toBe(true);
    expect(contractRenameAllowed('terminated')).toBe(false);
  });

  it('conflit de révision RECONNU (et lui seul) — rien d’autre ne doit passer pour un conflit', () => {
    expect(
      isContractRevisionConflict({
        kind: 'conflict',
        entity: 'maintenance_contract',
        reason: 'stale_revision',
      }),
    ).toBe(true);
    expect(
      isContractRevisionConflict({
        kind: 'conflict',
        entity: 'maintenance_contract',
        reason: 'another_conflict',
      }),
    ).toBe(false);
    // Un conflit sur une AUTRE entité ne dit rien de cette fiche.
    expect(
      isContractRevisionConflict({ kind: 'conflict', entity: 'invoice', reason: 'stale_revision' }),
    ).toBe(false);
    expect(
      isContractRevisionConflict({ kind: 'domain', error: { code: 'VALIDATION', message: 'x' } }),
    ).toBe(false);
    expect(isContractRevisionConflict(null)).toBe(false);
    expect(isContractRevisionConflict('conflict')).toBe(false);
  });
});

describe('Renommer — après un CONFLIT, aucune porte ne laisse la fiche périmée', () => {
  it('fermer une feuille PÉRIMÉE recharge la fiche : le chemin honnête n’est pas contournable', () => {
    // Le conflit dit que la fiche AFFICHÉE derrière la feuille est fausse. Fermer sans
    // recharger laisserait le pro travailler sur un nom que le serveur a déjà remplacé —
    // « Recharger la fiche » ne peut donc pas être un chemin qu'on quitte par le scrim.
    expect(contractRenameCloseEffect({ pending: false, stale: true })).toBe('reload_before_close');
  });

  it('sans conflit, fermer ne recharge rien — aucun appel réseau gratuit', () => {
    expect(contractRenameCloseEffect({ pending: false, stale: false })).toBe('close');
  });

  it('pendant l’écriture, la feuille ne se ferme pas : le geste est en vol', () => {
    expect(contractRenameCloseEffect({ pending: true, stale: false })).toBe('stay');
    expect(contractRenameCloseEffect({ pending: true, stale: true })).toBe('stay');
  });
});

describe('Renommer — ce que la feuille AFFICHE : jamais un bouton gris sans explication', () => {
  it('« unchanged » a une explication, et son ton dit que ce n’est pas une faute', () => {
    // Un voyant ne lit pas les indices d'accessibilité : l'explication du bouton désactivé
    // doit être VISIBLE. Elle reste calme — un champ pré-rempli et intact n'est pas une erreur.
    expect(contractRenameNotice('unchanged')).toEqual({
      key: 'contrat.renameUnchanged',
      tone: 'attente',
    });
  });

  it('un champ vidé ATTEND lui aussi — on ne reproche pas au pro de ne pas encore avoir tapé', () => {
    expect(contractRenameNotice('vide')).toEqual({
      key: 'contrat.labelRequired',
      tone: 'attente',
    });
  });

  it('ce que le domaine REFUSERA se dit en refus : le nom tapé ne passera jamais tel quel', () => {
    expect(contractRenameNotice('trop_long')).toEqual({
      key: 'contrat.renameTooLong',
      tone: 'refus',
    });
    expect(contractRenameNotice('caractere_de_controle')).toEqual({
      key: 'contrat.renameControlChars',
      tone: 'refus',
    });
  });

  it('rien ne bloque ⇒ rien n’est affiché (le bouton parle tout seul)', () => {
    expect(contractRenameNotice(null)).toBeNull();
  });

  it('chaque blocage a sa phrase, dans les TROIS personnalités — jamais un libellé manquant', () => {
    const blocks = ['unchanged', 'vide', 'trop_long', 'caractere_de_controle'] as const;
    for (const block of blocks) {
      const notice = contractRenameNotice(block);
      expect(notice).not.toBeNull();
      for (const personality of ['pote', 'pro', 'direct'] as const) {
        const said = t(notice!.key, {
          personality,
          params: { max: String(MAX_CONTRACT_LABEL_LENGTH) },
        });
        expect(said.length).toBeGreaterThan(0);
        // Un gabarit non substitué ({max}) atteindrait l'écran tel quel.
        expect(said).not.toContain('{');
      }
    }
  });
});
