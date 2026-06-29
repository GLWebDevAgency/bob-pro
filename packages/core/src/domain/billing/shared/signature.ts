import { type Instant } from '../../../shared-kernel/time';

export interface Signature {
  signerName: string;
  signedAt: Instant;
  method: 'draw';
  accepted: true;
}
