import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Track } from '../sdk';

export interface CachedTrackMetadata {
  id: string;
  track: Track;
  artwork?: Blob;
  audioBytes: number;
  artworkBytes: number;
  cachedAt: number;
}

export interface CachedTrack extends CachedTrackMetadata {
  audio: Blob;
}

interface CachedAudio {
  id: string;
  audio: Blob;
}

interface MusicCacheDatabase extends DBSchema {
  metadata: {
    key: string;
    value: CachedTrackMetadata;
    indexes: { 'by-cached-at': number };
  };
  audio: {
    key: string;
    value: CachedAudio;
  };
}

export interface OfflineStore {
  get(id: string): Promise<CachedTrack | undefined>;
  getMetadata(id: string): Promise<CachedTrackMetadata | undefined>;
  has(id: string): Promise<boolean>;
  put(track: Track, audio: Blob, artwork?: Blob): Promise<CachedTrack>;
  updateTrack(track: Track): Promise<void>;
  list(): Promise<CachedTrackMetadata[]>;
  ids(): Promise<Set<string>>;
  prune(keptIds: ReadonlySet<string>): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  usageBytes(): Promise<number>;
}

/**
 * Audio lives in a separate object store so listing downloads and measuring
 * usage never structured-clones every large Blob into an older iPhone's RAM.
 */
export class IndexedDbOfflineStore implements OfflineStore {
  private readonly database: Promise<IDBPDatabase<MusicCacheDatabase>>;

  constructor(databaseName = 'my-wave-offline-v2') {
    this.database = openDB<MusicCacheDatabase>(databaseName, 1, {
      upgrade(database) {
        const metadata = database.createObjectStore('metadata', { keyPath: 'id' });
        metadata.createIndex('by-cached-at', 'cachedAt');
        database.createObjectStore('audio', { keyPath: 'id' });
      },
    });
  }

  async get(id: string): Promise<CachedTrack | undefined> {
    const database = await this.database;
    const transaction = database.transaction(['metadata', 'audio'], 'readonly');
    const [metadata, media] = await Promise.all([
      transaction.objectStore('metadata').get(id),
      transaction.objectStore('audio').get(id),
    ]);
    await transaction.done;
    if (!metadata || !media) return undefined;
    return { ...metadata, audio: media.audio };
  }

  async getMetadata(id: string): Promise<CachedTrackMetadata | undefined> {
    return (await this.database).get('metadata', id);
  }

  async has(id: string): Promise<boolean> {
    return (await this.database).count('metadata', id).then((count) => count > 0);
  }

  async put(track: Track, audio: Blob, artwork?: Blob): Promise<CachedTrack> {
    const metadata: CachedTrackMetadata = {
      id: track.id,
      track,
      artwork,
      audioBytes: audio.size,
      artworkBytes: artwork?.size ?? 0,
      cachedAt: Date.now(),
    };
    const database = await this.database;
    const transaction = database.transaction(['metadata', 'audio'], 'readwrite');
    await Promise.all([
      transaction.objectStore('metadata').put(metadata),
      transaction.objectStore('audio').put({ id: track.id, audio }),
    ]);
    await transaction.done;
    return { ...metadata, audio };
  }

  async updateTrack(track: Track): Promise<void> {
    const database = await this.database;
    const cached = await database.get('metadata', track.id);
    if (cached) await database.put('metadata', { ...cached, track });
  }

  async list(): Promise<CachedTrackMetadata[]> {
    // Downloads are written sequentially in recommendation order, so the
    // ascending cache timestamp keeps Offline previous/next intuitive.
    return (await this.database).getAllFromIndex('metadata', 'by-cached-at');
  }

  async ids(): Promise<Set<string>> {
    return new Set(await (await this.database).getAllKeys('metadata'));
  }

  async prune(keptIds: ReadonlySet<string>): Promise<void> {
    const database = await this.database;
    const ids = await database.getAllKeys('metadata');
    const removedIds = ids.filter((id) => !keptIds.has(id));
    if (!removedIds.length) return;
    const transaction = database.transaction(['metadata', 'audio'], 'readwrite');
    await Promise.all(
      removedIds.flatMap((id) => [
        transaction.objectStore('metadata').delete(id),
        transaction.objectStore('audio').delete(id),
      ]),
    );
    await transaction.done;
  }

  async remove(id: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(['metadata', 'audio'], 'readwrite');
    await Promise.all([
      transaction.objectStore('metadata').delete(id),
      transaction.objectStore('audio').delete(id),
    ]);
    await transaction.done;
  }

  async clear(): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(['metadata', 'audio'], 'readwrite');
    await Promise.all([
      transaction.objectStore('metadata').clear(),
      transaction.objectStore('audio').clear(),
    ]);
    await transaction.done;
  }

  async usageBytes(): Promise<number> {
    const entries = await (await this.database).getAll('metadata');
    return entries.reduce((total, entry) => total + entry.audioBytes + entry.artworkBytes, 0);
  }
}
