// Estado en memoria de colas en seguimiento para deduplicar alertas (SPEC apartado 6).
// Por cola: { firstDetectedAt, lastNotifiedAt }. lastNotifiedAt es null hasta que un envío tiene éxito.

export class AlertState {
  #entries = new Map();

  trackedNames() {
    return [...this.#entries.keys()];
  }

  get(queueName) {
    return this.#entries.get(queueName);
  }

  // Empieza a seguir la cola si no lo estaba. Devuelve la entrada.
  track(queueName, now) {
    let entry = this.#entries.get(queueName);
    if (!entry) {
      entry = { firstDetectedAt: now, lastNotifiedAt: null };
      this.#entries.set(queueName, entry);
    }
    return entry;
  }

  shouldNotify(queueName, now, reminderMinutes) {
    const entry = this.#entries.get(queueName);
    if (!entry) return false;
    if (entry.lastNotifiedAt === null) return true;
    return reminderMinutes > 0 && now - entry.lastNotifiedAt >= reminderMinutes * 60_000;
  }

  markNotified(queueName, now) {
    const entry = this.#entries.get(queueName);
    if (entry) entry.lastNotifiedAt = now;
  }

  // Devuelve true si la cola estaba en seguimiento.
  recover(queueName) {
    return this.#entries.delete(queueName);
  }
}
