import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDocumentIntakeClientInput,
  RecordDocumentExpenseClientInput,
  RecordDocumentExpenseClientOutput,
} from '@bob/api-client';
import {
  DOCUMENT_INTELLIGENCE_MIME_TYPES,
  type AppError,
  type DeleteDocumentFolderStrategy,
} from '@bob/core';
import { useBobClient } from './client';

export function supportsDocumentAnalysis(mimeType: string): boolean {
  const normalized = (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return DOCUMENT_INTELLIGENCE_MIME_TYPES.some((supported) => supported === normalized);
}

/** Liste réelle des documents archivés (factures PDF/Factur-X, devis signés, reçus scannés…). */
export function useDocuments() {
  const client = useBobClient();
  return useQuery({
    queryKey: ['documents'],
    queryFn: async () => {
      const r = await client.listDocuments();
      if (!r.ok) throw new Error('Chargement des documents impossible.');
      return r.value;
    },
  });
}

export function useDocument(documentId: string) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['document', documentId],
    enabled: documentId.length > 0,
    queryFn: async () => {
      const result = await client.getDocument(documentId);
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

/** Archive l'original de façon idempotente AVANT l'analyse IA. */
export function useCreateDocumentIntake() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDocumentIntakeClientInput) => {
      const result = await client.createDocumentIntake(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });
}

export function useDocumentFolders(parentId: string | null = null) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['document-folders', parentId],
    queryFn: async () => {
      const result = await client.listDocumentFolders({ parentId, limit: 100 });
      if (!result.ok) throw result.error;
      return result.value.items;
    },
  });
}

export function useDocumentFolder(folderId: string) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['document-folder', folderId],
    enabled: folderId.length > 0,
    queryFn: async () => {
      const result = await client.getDocumentFolder(folderId);
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

export function useDocumentsInFolder(folderId: string | null) {
  const client = useBobClient();
  return useQuery({
    queryKey: ['documents', 'folder', folderId],
    queryFn: async () => {
      const result = await client.listDocuments({ folderId });
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

export function useAnalyzeDocument() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (documentId: string) => {
      const result = await client.analyzeDocument(documentId);
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

export function useCreateDocumentFolder() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; parentId?: string | null }) => {
      const result = await client.createDocumentFolder(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['document-folders'] }),
  });
}

export function useUpdateDocumentFolder() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      folderId: string;
      expectedRevision: number;
      name?: string;
      parentId?: string | null;
    }) => {
      const result = await client.updateDocumentFolder(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['document-folders'] }),
  });
}

export function usePreviewDocumentFolderDeletion() {
  const client = useBobClient();
  return useMutation({
    mutationFn: async (folderId: string) => {
      const result = await client.previewDocumentFolderDeletion(folderId);
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
}

export function useExecuteDocumentFolderDeletion() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; strategy: DeleteDocumentFolderStrategy }) => {
      const result = await client.executeDocumentFolderDeletion(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['document-folders'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useMoveDocumentToFolder() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { documentId: string; folderId: string | null; expectedRevision: number }) => {
      const result = await client.moveDocumentToFolder(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['document', input.documentId] });
      void queryClient.invalidateQueries({ queryKey: ['document-folders'] });
    },
  });
}

/** Dernier geste du scan : dépense + écritures + dossier + lien, atomiques côté serveur. */
export function useRecordDocumentExpense() {
  const client = useBobClient();
  const queryClient = useQueryClient();
  return useMutation<RecordDocumentExpenseClientOutput, AppError, RecordDocumentExpenseClientInput>({
    mutationFn: async (input: RecordDocumentExpenseClientInput) => {
      const result = await client.recordDocumentExpense(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['document', result.document.id] });
      void queryClient.invalidateQueries({ queryKey: ['document-folders'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['cashflow'] });
      void queryClient.invalidateQueries({ queryKey: ['accounting-entries'] });
    },
  });
}
