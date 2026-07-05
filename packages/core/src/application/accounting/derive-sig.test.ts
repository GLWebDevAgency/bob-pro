import { describe, it, expect } from 'vitest';
import { deriveSig, type SigEntryData } from './derive-sig';
import { deriveIncomeStatement } from './derive-income-statement';

/** Écriture mono-ligne de commodité (le moteur cumule par compte, pas par pièce). */
function mv(account: string, debitCents: number, creditCents: number): SigEntryData {
  return { lines: [{ account, debitCents, creditCents }] };
}

describe('deriveSig', () => {
  it('cascade un dossier artisan type : production → VA → EBE → REX', () => {
    const entries: SigEntryData[] = [
      mv('706', 0, 1_500_000), // prestations
      mv('707', 0, 400_000), // ventes de matériaux
      mv('606', 350_000, 0), // fournitures consommées
      mv('611', 200_000, 0), // sous-traitance
      mv('625', 40_000, 0), // déplacements/repas
      mv('63512', 25_000, 0), // CFE
      mv('6811', 60_000, 0), // dotation amortissements
    ];
    const sig = deriveSig(entries);

    // Pas de 607/6037 mouvementé : la « marge » serait fictive (707 sans coût d'achat).
    expect(sig.margeCommercialeActive).toBe(false);
    expect(sig.margeCommercialeProduitsCents).toBe(400_000);
    expect(sig.productionCents).toBe(1_500_000);
    expect(sig.consommationsCents).toBe(590_000);
    expect(sig.valeurAjouteeCents).toBe(400_000 + 1_500_000 - 590_000);
    expect(sig.ebeCents).toBe(sig.valeurAjouteeCents - 25_000);
    expect(sig.resultatExploitationCents).toBe(sig.ebeCents - 60_000);
  });

  it('active la marge commerciale dès qu un compte d achats revendus est mouvementé', () => {
    const sig = deriveSig([mv('707', 0, 400_000), mv('607', 260_000, 0), mv('6097', 0, 10_000)]);
    expect(sig.margeCommercialeActive).toBe(true);
    // Coût d'achat net des RRR obtenus : 260 000 − 10 000.
    expect(sig.margeCommercialeChargesCents).toBe(250_000);
    expect(sig.margeCommercialeCents).toBe(150_000);
  });

  it('absorbe les comptes à contre-sens par le signe : 709 débiteur, 6037 signé, 71 déstocké', () => {
    const sig = deriveSig([
      mv('706', 0, 1_000_000),
      mv('707', 0, 300_000),
      mv('7097', 50_000, 0), // RRR accordés sur marchandises → réduit les ventes nettes
      mv('7091', 20_000, 0), // RRR sur prestations → réduit la PRODUCTION (pas la marge)
      mv('607', 180_000, 0),
      mv('6037', 0, 30_000), // stockage de marchandises → RÉDUIT le coût d'achat vendu
      mv('713', 0, -40_000), // production stockée créditrice négative = déstockage
    ]);
    expect(sig.margeCommercialeProduitsCents).toBe(250_000); // 300 000 − 50 000
    expect(sig.margeCommercialeChargesCents).toBe(150_000); // 180 000 − 30 000
    expect(sig.productionCents).toBe(1_000_000 - 20_000 - 40_000);
  });

  it('ne fuit pas hors exploitation : financier, exceptionnel, 686/786, IS restent dehors', () => {
    const exploitation: SigEntryData[] = [mv('706', 0, 800_000), mv('606', 100_000, 0)];
    const horsExploitation: SigEntryData[] = [
      mv('7620', 0, 30_000), // produits financiers
      mv('66116', 12_000, 0), // intérêts d'emprunt
      mv('686', 5_000, 0), // dotation FINANCIÈRE — piège du préfixe court « 68 »
      mv('786', 0, 4_000), // reprise financière
      mv('797', 0, 3_000), // transfert de charges exceptionnel
      mv('675', 8_000, 0), // VNC d'immobilisation cédée
      mv('695', 20_000, 0), // IS
      mv('691', 6_000, 0), // participation
      mv('512', 100_000, 0), // bilan
    ];
    expect(deriveSig([...exploitation, ...horsExploitation])).toEqual(deriveSig(exploitation));
  });

  it('range 781/791 au niveau du REX, jamais dans l EBE (position liasse)', () => {
    const base: SigEntryData[] = [mv('706', 0, 500_000), mv('6811', 80_000, 0)];
    const avecTransfert = deriveSig([...base, mv('791', 0, 30_000)]);
    const sans = deriveSig(base);
    expect(avecTransfert.ebeCents).toBe(sans.ebeCents);
    expect(avecTransfert.resultatExploitationCents).toBe(sans.resultatExploitationCents + 30_000);
  });

  it('INVARIANT : le REX SIG recolle au centime au résultat d exploitation du CR, écritures adverses incluses', () => {
    const adverse: SigEntryData[] = [
      mv('701', 0, 777_777),
      mv('706', 0, 123_456),
      mv('707', 0, 300_001),
      mv('7097', 49_999, 0),
      mv('709', 10_000, 0), // RRR générique → production via « 70 »
      mv('708', 0, 5_000),
      mv('713', 0, -33_333), // déstockage
      mv('72', 0, 11_111),
      mv('731', 0, 7_777), // compte 73 exotique
      mv('740', 0, 90_000),
      mv('751', 0, 2_500),
      mv('781', 0, 15_000),
      mv('791', 0, 8_000),
      mv('601', 50_000, 0),
      mv('6037', -12_345, 0), // variation de stocks négative au débit
      mv('607', 199_999, 0),
      mv('6087', 3_000, 0),
      mv('6097', 0, 7_000),
      mv('611', 88_888, 0),
      mv('625', 14_400, 0),
      mv('635', 22_222, 0),
      mv('641', 250_000, 0),
      mv('654', 4_321, 0),
      mv('6811', 66_666, 0),
      // Hors exploitation — ne doit RIEN changer au REX des deux moteurs.
      mv('761', 0, 9_999),
      mv('66', 5_555, 0),
      mv('686', 2_222, 0),
      mv('771', 0, 30_000),
      mv('675', 18_000, 0),
      mv('687', 1_111, 0),
      mv('787', 0, 2_345),
      mv('796', 0, 1_234),
      mv('691', 5_000, 0),
      mv('695', 40_000, 0),
    ];
    const sig = deriveSig(adverse);
    const cr = deriveIncomeStatement(adverse);
    expect(sig.resultatExploitationCents).toBe(cr.resultatExploitationCents);
    // La partition est exacte des DEUX côtés du solde, pas seulement du net.
    expect(sig.margeCommercialeProduitsCents + sig.productionCents + sig.subventionsCents + sig.autresProduitsExploitationCents).toBe(cr.exploitationProduitsCents);
    expect(sig.margeCommercialeChargesCents + sig.consommationsCents + sig.impotsTaxesCents + sig.chargesPersonnelCents + sig.autresChargesExploitationCents).toBe(cr.exploitationChargesCents);
  });

  it('rend une cascade nulle sur un dossier vide', () => {
    const sig = deriveSig([]);
    expect(sig.resultatExploitationCents).toBe(0);
    expect(sig.margeCommercialeActive).toBe(false);
  });
});
