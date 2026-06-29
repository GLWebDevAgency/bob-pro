import { type VatRate } from './vat-rate';

export type LineCategory = 'labor' | 'supply' | 'travel' | 'disbursement' | 'subscription';

export interface LineInput {
  label: string;
  category: LineCategory;
  qty: number;
  unit?: string;
  unitPriceHT: number; // centimes
  vatRate: VatRate;
}
