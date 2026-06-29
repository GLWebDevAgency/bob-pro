import { type DomainResult, ok, err } from '../../../shared-kernel/result';

export class DocNumber {
  private constructor(readonly value: string) {}
  static of(raw: string): DomainResult<DocNumber> {
    if (!/^[DF]-\d{4}-\d{4,}$/.test(raw))
      return err({ code: 'VALIDATION', field: 'docNumber', message: 'Format attendu X-AAAA-NNNN.' });
    return ok(new DocNumber(raw));
  }
  static format(prefix: 'D' | 'F', year: number, seq: number): DocNumber {
    return new DocNumber(`${prefix}-${year}-${String(seq).padStart(4, '0')}`);
  }
}
