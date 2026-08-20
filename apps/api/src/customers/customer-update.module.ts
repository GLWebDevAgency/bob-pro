import { Module, type Provider } from '@nestjs/common';

import { DocumentArchiveIntegrityAuthority } from '../documents/document-archive-integrity.authority';
import { DocumentArchiveIntegrityModule } from '../documents/document-archive-integrity.module';
import type { Persistence } from '../persistence/persistence';
import { PersistenceModule } from '../persistence/persistence.module';
import { PERSISTENCE } from '../persistence/persistence-token';
import { CustomerUpdateAuthority } from './customer-update.authority';

const customerUpdateAuthorityProvider: Provider = {
  provide: CustomerUpdateAuthority,
  inject: [PERSISTENCE, DocumentArchiveIntegrityAuthority],
  useFactory: (
    persistence: Persistence,
    archives: DocumentArchiveIntegrityAuthority,
  ) => new CustomerUpdateAuthority(persistence, archives),
};

@Module({
  imports: [PersistenceModule, DocumentArchiveIntegrityModule],
  providers: [customerUpdateAuthorityProvider],
  exports: [CustomerUpdateAuthority, DocumentArchiveIntegrityModule],
})
export class CustomerUpdateModule {}
