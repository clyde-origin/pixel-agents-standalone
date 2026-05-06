export type FeedEntry =
  | { kind: 'text';        text: string;                              timestamp: number }
  | { kind: 'tool_start';  toolId: string; status: string;            timestamp: number }
  | { kind: 'tool_done';   toolId: string;                            timestamp: number }
  | { kind: 'tool_perm';   toolId: string; label: string;             timestamp: number }
  | { kind: 'system';      message: string;                           timestamp: number }

export class FeedBuffer {
  private entries: FeedEntry[] = []
  constructor(private capacity: number) {}
  append(e: FeedEntry): void {
    this.entries.push(e)
    if (this.entries.length > this.capacity) this.entries.shift()
  }
  snapshot(): FeedEntry[] { return this.entries.slice() }
  reset(): void { this.entries = [] }
}
