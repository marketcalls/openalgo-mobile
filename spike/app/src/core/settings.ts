// THROWAWAY SPIKE. Run settings and the single live feed. The API key for a real
// server is kept in memory only and never persisted: the spike is not the place
// to design credential storage.
import { create } from 'zustand';
import { type Feed, type FeedStatus, SimFeed, WsFeed } from './feed';
import { type FlushMode, setFlushMode } from './tickStore';

export type FeedMode = 'sim' | 'ws';

interface SettingsState {
  feedMode: FeedMode;
  simRate: number; // ticks per second across all streamed instruments
  wsUrl: string;
  apiKey: string;
  flushMode: FlushMode;
  status: FeedStatus;
  set: (patch: Partial<Omit<SettingsState, 'set' | 'status'>>) => void;
}

let feed: Feed | null = null;

function restartFeed(s: Pick<SettingsState, 'feedMode' | 'simRate' | 'wsUrl' | 'apiKey'>) {
  feed?.stop();
  feed = s.feedMode === 'sim' ? new SimFeed(s.simRate) : new WsFeed(s.wsUrl, s.apiKey);
  feed.onStatus((status) => useSettings.setState({ status }));
  feed.start();
}

export const useSettings = create<SettingsState>((set, get) => ({
  feedMode: 'sim',
  simRate: 300,
  wsUrl: 'ws://192.168.1.10:8765',
  apiKey: '',
  flushMode: 'raf',
  status: { state: 'idle' },
  set: (patch) => {
    set(patch);
    const s = get();
    if ('flushMode' in patch) setFlushMode(s.flushMode);
    if ('feedMode' in patch || 'simRate' in patch || 'wsUrl' in patch || 'apiKey' in patch) restartFeed(s);
  },
}));

export function startDefaultFeed() {
  if (!feed) restartFeed(useSettings.getState());
}
