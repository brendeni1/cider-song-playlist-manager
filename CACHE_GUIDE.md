# Cider Playlist Manager - Cache System

## Overview

Version 1.3.0 introduces an intelligent caching system that dramatically improves performance by:
- **Smart Caching**: Only fetches playlist data when needed
- **Change Tracking**: Tracks which playlists you've modified and only refreshes those
- **Configurable Expiration**: Set how long cached data remains valid (default: 5 minutes)
- **Manual Control**: Enable/disable caching and clear cache manually

## How It Works

### Initial Load
When you open the playlist manager for the first time:
1. Fetches all your playlists from Apple Music API
2. Checks which playlists contain the selected song
3. Stores this data in the cache with a timestamp

### Subsequent Loads
On future opens:
1. **Cached Playlists**: Instantly shows results from cache (⚡ indicator)
2. **Modified Playlists**: Only fetches playlists you've changed
3. **Expired Cache**: Refreshes playlists whose cache has expired

### After Making Changes
When you add/remove songs:
1. Updates the playlists via Apple Music API
2. Marks those specific playlists as "modified"
3. Next time you open the manager, only those playlists are refreshed

## Settings

Access settings via the console:
```javascript
window.openPlaylistSettings()
```

### Available Options

#### Enable Caching
Toggle caching on/off. When disabled, always fetches fresh data from Apple Music.

#### Cache Expiration
Choose how long cached data remains valid:
- 1 minute (for frequently changing playlists)
- 5 minutes (default, balanced performance)
- 15 minutes (for stable playlists)
- 30 minutes (longer sessions)
- 1 hour (maximum)
- Custom (set your own duration)

#### Clear Cache
Manually clear all cached data. Use this if:
- You've made changes outside the plugin
- Something seems out of sync
- You want fresh data for all playlists

### Cache Statistics

The settings page shows:
- **Cached Playlists**: Total number of playlists in cache
- **Modified**: Playlists marked for refresh
- **Expired**: Playlists past their expiration time
- **Cache Size**: Storage space used
- **Oldest Cache**: Age of the oldest cached playlist

## Technical Details

### Storage
- Uses browser `localStorage` for persistence
- Caches persist across Cider restarts
- Each playlist stores: ID, name, track IDs, last modified date, artwork URL

### Performance Benefits
Example with 50 playlists:
- **Without cache**: 50+ API calls, ~5-10 seconds
- **With cache**: 0-5 API calls (only modified/expired), ~1-2 seconds
- **Cache hit**: Instant display (< 100ms)

### Smart Batching
When fetching multiple playlists:
- Processes in batches of 10 to avoid overwhelming the API
- Small delays between batches for stability
- Aborts gracefully if modal is closed

## Best Practices

### Recommended Settings
- **Casual use**: 5-15 minutes (balances freshness and performance)
- **Heavy use**: 1-5 minutes (more frequent updates)
- **Stable playlists**: 30-60 minutes (maximum performance)

### When to Clear Cache
- After bulk playlist changes outside Cider
- If you notice playlist contents are incorrect
- Before important playlist management tasks

### When to Disable Caching
- Rarely needed, but useful for:
  - Troubleshooting sync issues
  - Collaborative playlist editing
  - Ensuring absolute freshness

## Development

### Cache Keys
- `playlist-manager-cache`: Main cache storage
- `playlist-manager-settings`: User settings
- `playlist-manager-modified`: List of modified playlist IDs

### Cache Structure
```typescript
interface CachedPlaylist {
  id: string;
  name: string;
  tracks: string[];  // Array of song IDs
  lastModified: Date;
  artworkUrl?: string;
  cachedAt: Date;
}
```

### Testing
```javascript
// Open playlist manager
window.openPlaylistManager('songId', 'Title', 'Artist')

// Open settings
window.openPlaylistSettings()

// Check cache stats (in console)
const stats = PlaylistCache.getStats()
console.log(stats)
```

## Troubleshooting

### Cache not working?
1. Check settings - ensure caching is enabled
2. Check expiration time - might be too short
3. Clear cache and try again

### Seeing wrong playlist contents?
1. Clear cache in settings
2. Try again with fresh data
3. If persists, disable caching temporarily

### Performance still slow?
1. Reduce cache expiration time
2. You might have many playlists or large playlists
3. The initial load will always be slower (building cache)

## Future Enhancements

Possible improvements for future versions:
- Background cache refresh
- Selective playlist caching (favorite playlists)
- Cache preloading on Cider startup
- Cloud sync for cache across devices
- Compression for large caches
