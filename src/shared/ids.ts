export function newEventId(): string {
  return globalThis.crypto.randomUUID();
}
