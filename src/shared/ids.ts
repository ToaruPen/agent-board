export function newEventId(): string {
  return globalThis.crypto.randomUUID();
}

export function newMessageId(): string {
  return globalThis.crypto.randomUUID();
}
