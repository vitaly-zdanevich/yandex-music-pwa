import type { RecommendationClient, RecommendedTrack } from './types';

export class RecommendationSession {
  private queue: RecommendedTrack[] = [];
  private currentIndex = 0;
  private sessionIdValue = '';

  constructor(private readonly client: RecommendationClient) {}

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get index(): number {
    return this.currentIndex;
  }

  get length(): number {
    return this.queue.length;
  }

  get current(): RecommendedTrack | undefined {
    return this.queue[this.currentIndex];
  }

  get all(): readonly RecommendedTrack[] {
    return this.queue;
  }

  async start(): Promise<RecommendedTrack | undefined> {
    const batch = await this.client.startRecommendations();
    this.sessionIdValue = batch.sessionId;
    this.queue = deduplicate(batch.tracks);
    this.currentIndex = 0;
    return this.current;
  }

  reset(): void {
    this.queue = [];
    this.currentIndex = 0;
    this.sessionIdValue = '';
  }

  async ensureUpcoming(count: number): Promise<void> {
    let attempts = 0;
    while (this.queue.length - this.currentIndex - 1 < count && this.sessionIdValue && attempts < 6) {
      const batch = await this.client.getMoreRecommendations(this.sessionIdValue, this.historyQueue());
      const existing = new Set(this.queue.map((item) => item.track.id));
      const additions = batch.tracks.filter((item) => !existing.has(item.track.id));
      this.queue.push(...additions);
      attempts += 1;
      if (additions.length === 0) break;
    }
  }

  next(): RecommendedTrack | undefined {
    if (this.currentIndex + 1 >= this.queue.length) return undefined;
    this.currentIndex += 1;
    return this.current;
  }

  previous(): RecommendedTrack | undefined {
    if (this.currentIndex === 0) return undefined;
    this.currentIndex -= 1;
    return this.current;
  }

  upcoming(count: number): RecommendedTrack[] {
    return this.queue.slice(this.currentIndex + 1, this.currentIndex + 1 + count);
  }

  private historyQueue(): string[] {
    return this.queue
      .slice(0, this.currentIndex + 1)
      .reverse()
      .slice(0, 20)
      .map(({ track }) => (track.album?.id ? `${track.id}:${track.album.id}` : track.id));
  }
}

function deduplicate(items: RecommendedTrack[]): RecommendedTrack[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.track.id)) return false;
    seen.add(item.track.id);
    return true;
  });
}
