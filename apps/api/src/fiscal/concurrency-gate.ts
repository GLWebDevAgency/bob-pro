/**
 * Porte de concurrence minimale (contre-revue GPT ⑤ — mesurée : ~5 ms/évaluation pour le cas
 * micro, ~41 ms/évaluation pour l'inversion numérique SASU, cf. rapport de la tâche). Chaque
 * évaluation Publicodes reste SYNCHRONE/mono-thread : cette porte ne parallélise RIEN (Node reste
 * mono-thread) — elle borne le nombre d'évaluations "en vol" pour qu'une rafale de requêtes ne
 * monopolise pas la boucle d'événements en continu (qui sert aussi /voice/realtime sur le même
 * process), en mettant les requêtes excédentaires en file d'attente plutôt qu'en les exécutant
 * toutes sans jamais céder la main.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
