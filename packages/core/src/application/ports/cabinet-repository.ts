import { type Cabinet } from '../../domain/cabinet/cabinet';

export interface CabinetRepository {
  findById(id: string): Promise<Cabinet | null>;
  /** Charge et verrouille l'agrégat et ses memberships dans l'unité de travail courante. */
  lockById(id: string): Promise<Cabinet | null>;
  listByUserId(userId: string): Promise<Cabinet[]>;
  /** expectedVersion=null crée le cabinet et son premier admin atomiquement. */
  save(cabinet: Cabinet, expectedVersion: number | null): Promise<void>;
}
