interface ArchiveWorkerResult {
  ok: boolean;
}

export interface WaitForDocumentArchiveInput {
  label: string;
  drain: () => Promise<ArchiveWorkerResult>;
  ready: () => boolean | Promise<boolean>;
  attempts?: number;
}

/**
 * Attend l'état durable, pas la victoire d'un appel précis au worker. Le kick post-commit peut
 * prendre le lease entre le scan et le claim du test ; dans ce cas le drain manuel retourne
 * honnêtement zéro pendant que l'autre worker termine. Ce helper borne l'attente et relit le
 * résultat observable après chaque tentative.
 */
export async function waitForDocumentArchive(
  input: WaitForDocumentArchiveInput,
): Promise<void> {
  const attempts = input.attempts ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const drained = await input.drain();
    if (!drained.ok) throw new Error(`${input.label}: document archive worker failed`);
    if (await input.ready()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`${input.label}: document archive did not reach its durable ready state`);
}
