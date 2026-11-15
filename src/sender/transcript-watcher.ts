import type { EventEnvelope } from "../shared/envelope.js";

export type EnvelopeSink = (envelope: EventEnvelope) => Promise<void> | void;

export interface InputSource {
  readonly name: string;
  start(sink: EnvelopeSink): Promise<void>;
  stop(): Promise<void>;
}

export class HookInputSource implements InputSource {
  readonly name = "hooks";
  private sink: EnvelopeSink | null = null;

  async start(sink: EnvelopeSink): Promise<void> {
    this.sink = sink;
  }

  async accept(envelope: EventEnvelope): Promise<void> {
    await this.sink?.(envelope);
  }

  async stop(): Promise<void> {
    this.sink = null;
  }
}

/**
 * The Codex rollout format is explicitly unstable. This source stays isolated
 * behind InputSource so a parser failure cannot affect the hook path. The full
 * parser is intentionally not built until the Windows probe proves that the
 * Codex app does not fire file based hooks.
 */
export class TranscriptWatcherSource implements InputSource {
  readonly name = "windows-transcript-watcher";
  private running = false;

  async start(_sink: EnvelopeSink): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}

export class InputSourceRegistry {
  private readonly sources = new Map<string, InputSource>();

  register(source: InputSource): void {
    this.sources.set(source.name, source);
  }

  get(name: string): InputSource | undefined {
    return this.sources.get(name);
  }

  async stopAll(): Promise<void> {
    for (const source of this.sources.values()) await source.stop();
  }
}
