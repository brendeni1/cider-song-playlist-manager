/**
 * Intelligent caching system for playlist data with change tracking
 */

export interface CachedPlaylist {
  id: string;
  name: string;
  tracks: string[]; // Song IDs in the playlist
  lastModified: Date;
  artworkUrl?: string;
  cachedAt: Date;
}

export interface CacheSettings {
  enabled: boolean;
  expirationMinutes: number;
}

const CACHE_KEY = 'playlist-manager-cache';
const SETTINGS_KEY = 'playlist-manager-settings';
const MODIFIED_PLAYLISTS_KEY = 'playlist-manager-modified';

export class PlaylistCache {
  private static defaultSettings: CacheSettings = {
    enabled: true,
    expirationMinutes: 5,
  };

  /**
   * Get cache settings
   */
  static getSettings(): CacheSettings {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        return { ...this.defaultSettings, ...JSON.parse(stored) };
      }
    } catch (error) {
      console.error('Error reading cache settings:', error);
    }
    return this.defaultSettings;
  }

  /**
   * Save cache settings
   */
  static saveSettings(settings: Partial<CacheSettings>): void {
    try {
      const current = this.getSettings();
      const updated = { ...current, ...settings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
      console.log('Cache settings saved:', updated);
    } catch (error) {
      console.error('Error saving cache settings:', error);
    }
  }

  /**
   * Get all cached playlists
   */
  static getCache(): CachedPlaylist[] {
    const settings = this.getSettings();
    if (!settings.enabled) {
      return [];
    }

    try {
      const stored = localStorage.getItem(CACHE_KEY);
      if (!stored) return [];

      const cache: CachedPlaylist[] = JSON.parse(stored);
      
      // Convert date strings back to Date objects
      return cache.map(p => ({
        ...p,
        lastModified: new Date(p.lastModified),
        cachedAt: new Date(p.cachedAt),
      }));
    } catch (error) {
      console.error('Error reading cache:', error);
      return [];
    }
  }

  /**
   * Get a specific playlist from cache
   */
  static getCachedPlaylist(playlistId: string): CachedPlaylist | null {
    const cache = this.getCache();
    const playlist = cache.find(p => p.id === playlistId);
    
    if (!playlist) return null;

    // Check if cache is expired
    const settings = this.getSettings();
    const now = new Date();
    const expirationMs = settings.expirationMinutes * 60 * 1000;
    const age = now.getTime() - playlist.cachedAt.getTime();

    if (age > expirationMs) {
      console.log(`Cache expired for playlist ${playlistId} (age: ${Math.round(age / 1000)}s)`);
      return null;
    }

    return playlist;
  }

  /**
   * Check if a song is in a cached playlist
   */
  static isSongInPlaylist(playlistId: string, songId: string): boolean | null {
    const playlist = this.getCachedPlaylist(playlistId);
    if (!playlist) return null;

    return playlist.tracks.includes(songId);
  }

  /**
   * Update cache for specific playlists
   */
  static updatePlaylists(playlists: CachedPlaylist[]): void {
    const settings = this.getSettings();
    if (!settings.enabled) return;

    try {
      const cache = this.getCache();
      const now = new Date();

      // Update or add playlists
      playlists.forEach(playlist => {
        const index = cache.findIndex(p => p.id === playlist.id);
        const cachedPlaylist = {
          ...playlist,
          cachedAt: now,
        };

        if (index >= 0) {
          cache[index] = cachedPlaylist;
        } else {
          cache.push(cachedPlaylist);
        }
      });

      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      console.log(`Updated cache for ${playlists.length} playlists`);
    } catch (error) {
      console.error('Error updating cache:', error);
    }
  }

  /**
   * Clear entire cache
   */
  static clearCache(): void {
    try {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(MODIFIED_PLAYLISTS_KEY);
      console.log('Cache cleared');
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  /**
   * Mark playlists as modified (need refresh)
   */
  static markPlaylistsModified(playlistIds: string[]): void {
    try {
      const stored = localStorage.getItem(MODIFIED_PLAYLISTS_KEY);
      const modified = stored ? JSON.parse(stored) : [];
      
      playlistIds.forEach(id => {
        if (!modified.includes(id)) {
          modified.push(id);
        }
      });

      localStorage.setItem(MODIFIED_PLAYLISTS_KEY, JSON.stringify(modified));
      console.log(`Marked ${playlistIds.length} playlists as modified`);
    } catch (error) {
      console.error('Error marking playlists as modified:', error);
    }
  }

  /**
   * Get list of modified playlists
   */
  static getModifiedPlaylists(): string[] {
    try {
      const stored = localStorage.getItem(MODIFIED_PLAYLISTS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Error reading modified playlists:', error);
      return [];
    }
  }

  /**
   * Clear modified playlists list
   */
  static clearModifiedPlaylists(): void {
    try {
      localStorage.removeItem(MODIFIED_PLAYLISTS_KEY);
    } catch (error) {
      console.error('Error clearing modified playlists:', error);
    }
  }

  /**
   * Get cache statistics
   */
  static getStats(): {
    totalPlaylists: number;
    expiredPlaylists: number;
    modifiedPlaylists: number;
    cacheSize: string;
    oldestCache: Date | null;
  } {
    const cache = this.getCache();
    const settings = this.getSettings();
    const modified = this.getModifiedPlaylists();
    const now = new Date();
    const expirationMs = settings.expirationMinutes * 60 * 1000;

    const expired = cache.filter(p => {
      const age = now.getTime() - p.cachedAt.getTime();
      return age > expirationMs;
    });

    const oldest = cache.length > 0
      ? cache.reduce((oldest, p) => p.cachedAt < oldest ? p.cachedAt : oldest, cache[0].cachedAt)
      : null;

    // Estimate cache size
    const cacheStr = localStorage.getItem(CACHE_KEY) || '';
    const sizeKB = Math.round(cacheStr.length / 1024);

    return {
      totalPlaylists: cache.length,
      expiredPlaylists: expired.length,
      modifiedPlaylists: modified.length,
      cacheSize: `${sizeKB} KB`,
      oldestCache: oldest,
    };
  }
}
