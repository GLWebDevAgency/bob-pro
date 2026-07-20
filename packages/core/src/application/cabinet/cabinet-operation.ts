import { type Result, err, ok } from '../../shared-kernel/result';
import { type UnitOfWorkPort } from '../ports/services';
import { type AppError } from '../result';

export class CabinetOperationAborted extends Error {
  constructor(readonly appError: AppError) {
    super('Cabinet operation aborted.');
  }
}

export function abortCabinetOperation(appError: AppError): never {
  throw new CabinetOperationAborted(appError);
}

export async function runCabinetOperation<T>(
  uow: UnitOfWorkPort,
  operation: () => Promise<T>,
): Promise<Result<T, AppError>> {
  try {
    return ok(await uow.runInTransaction(operation));
  } catch (error) {
    if (error instanceof CabinetOperationAborted) return err(error.appError);
    throw error;
  }
}
