import { Module, type Provider } from '@nestjs/common';
import type { DocumentStoragePort } from '@bob/core';

import type { Persistence } from '../persistence/persistence';
import { PersistenceModule } from '../persistence/persistence.module';
import { PERSISTENCE } from '../persistence/persistence-token';
import { DocumentArchiveIntegrityAuthority } from './document-archive-integrity.authority';
import { DOCUMENT_STORAGE, buildDocumentStorage } from './storage';

const documentStorageProvider: Provider = {
  provide: DOCUMENT_STORAGE,
  useFactory: buildDocumentStorage,
};

const documentArchiveIntegrityProvider: Provider = {
  provide: DocumentArchiveIntegrityAuthority,
  inject: [PERSISTENCE, DOCUMENT_STORAGE],
  useFactory: (persistence: Persistence, storage: DocumentStoragePort) =>
    new DocumentArchiveIntegrityAuthority(persistence, storage),
};

@Module({
  imports: [PersistenceModule],
  providers: [documentStorageProvider, documentArchiveIntegrityProvider],
  exports: [DOCUMENT_STORAGE, DocumentArchiveIntegrityAuthority],
})
export class DocumentArchiveIntegrityModule {}
