<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { DialogAPI, v3 } from "@ciderapp/pluginkit";
import { PlaylistCache, type CachedPlaylist } from "../utils/cache";

interface PlaylistCheckState {
  id: string;
  name: string;
  isInPlaylist: boolean;
  originalState: boolean;
  lastModified?: Date;
  artworkUrl?: string;
}

const props = defineProps<{
  songId: string;
  songTitle: string;
  songArtist: string;
  songAlbum?: string;
  songArtwork?: string;
  onClose?: () => void;
}>();

const emits = defineEmits(["dialogClose", "dialogResolve"]);

const playlists = ref<PlaylistCheckState[]>([]);
const loading = ref(true);
const processing = ref(false);
const searchQuery = ref("");
const aborted = ref(false);
const cacheUsed = ref(false);

const filteredPlaylists = computed(() => {
  let filtered = playlists.value;
  
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    filtered = playlists.value.filter((p) => p.name.toLowerCase().includes(query));
  }
  
  // Sort: playlists with the song first, then by last modified date
  return [...filtered].sort((a, b) => {
    // First, sort by whether the song is in the playlist
    if (a.isInPlaylist && !b.isInPlaylist) return -1;
    if (!a.isInPlaylist && b.isInPlaylist) return 1;
    
    // If both have the song or both don't, sort by last modified date
    const dateA = a.lastModified?.getTime() || 0;
    const dateB = b.lastModified?.getTime() || 0;
    return dateB - dateA;
  });
});

const hasChanges = computed(() => {
  return playlists.value.some((p) => p.isInPlaylist !== p.originalState);
});

const changesCount = computed(() => {
  return playlists.value.filter((p) => p.isInPlaylist !== p.originalState)
    .length;
});

onMounted(async () => {
  console.log("Modal mounted!");
  console.log("Looking for songId:", props.songId);
  console.log("Song details:", { title: props.songTitle, artist: props.songArtist, album: props.songAlbum });
  console.log("Close function available:", !!props.onClose);

  aborted.value = false;
  await loadPlaylists();
});

/**
 * Try to find the library ID for a catalog song
 */
async function findLibraryId(catalogId: string): Promise<string | null> {
  try {
    // Search for the song in the library using catalog ID
    const response = await v3<any>(
      `/v1/me/library/songs`,
      { 
        filter: { id: catalogId },
        limit: 1
      }
    );
    
    const songs = Array.isArray(response.data) ? response.data : response.data?.data || [];
    if (songs.length > 0 && songs[0].id) {
      console.log(`Found library ID ${songs[0].id} for catalog ID ${catalogId}`);
      return songs[0].id;
    }
  } catch (error) {
    console.log(`Could not find library ID for catalog ${catalogId}:`, error);
  }
  return null;
}

async function loadPlaylists() {
  try {
    loading.value = true;
    const settings = PlaylistCache.getSettings();
    
    console.log("Cache settings:", settings);
    console.log("Song ID to search for:", props.songId);
    console.log("Song ID type:", props.songId.startsWith('i.') ? 'library' : 'catalog');
    
    // If we have a catalog ID, try to find the library ID
    let searchIds = [props.songId];
    if (!props.songId.startsWith('i.')) {
      const libraryId = await findLibraryId(props.songId);
      if (libraryId) {
        searchIds.push(libraryId);
        console.log(`Will search for both catalog ID ${props.songId} and library ID ${libraryId}`);
      } else {
        console.log(`Song ${props.songId} is not in library yet`);
      }
    }
    
    console.log("Fetching playlists using v3 API...");

    // Get all playlists from API
    const response = await v3<any>(`/v1/me/library/playlists`, { limit: 100 });
    
    if (aborted.value) {
      console.log("Playlist loading aborted");
      return;
    }
    
    console.log("Playlists API response:", response);

    const userPlaylists = Array.isArray(response.data)
      ? response.data
      : response.data?.data || [];

    console.log("Found", userPlaylists.length, "playlists");

    // Filter out Apple Music playlists
    const editablePlaylists = userPlaylists.filter((playlist: any) => {
      const canEdit = playlist.attributes?.canEdit !== false;
      const isLibraryPlaylist = playlist.type === 'library-playlists';
      return canEdit && isLibraryPlaylist;
    });

    console.log("Found", editablePlaylists.length, "editable playlists");

    // Sort by last modified date
    const sortedPlaylists = [...editablePlaylists].sort((a: any, b: any) => {
      const dateA = new Date(a.attributes?.lastModifiedDate || 0);
      const dateB = new Date(b.attributes?.lastModifiedDate || 0);
      return dateB.getTime() - dateA.getTime();
    });

    // Get modified playlists that need refresh
    const modifiedPlaylistIds = PlaylistCache.getModifiedPlaylists();
    console.log(`Found ${modifiedPlaylistIds.length} modified playlists that need refresh`);

    // Check which playlists we can use from cache
    const playlistStates: PlaylistCheckState[] = [];
    const playlistsToFetch: any[] = [];
    let cacheHits = 0;
    
    for (const playlist of sortedPlaylists) {
      const playlistId = playlist.id;
      const playlistName = playlist.attributes?.name || "Untitled Playlist";
      
      // Check if this playlist was modified or if cache is expired/disabled
      const needsRefresh = modifiedPlaylistIds.includes(playlistId);
      // Check cache for any of our search IDs
      let cachedResult = null;
      if (!needsRefresh) {
        for (const searchId of searchIds) {
          cachedResult = PlaylistCache.isSongInPlaylist(playlistId, searchId);
          if (cachedResult !== null) break;
        }
      }
      
      if (cachedResult !== null && settings.enabled) {
        // Use cached result
        cacheHits++;
        console.log(`✓ Cache hit for "${playlistName}": ${cachedResult}`);
        
        playlistStates.push({
          id: playlistId,
          name: playlistName,
          isInPlaylist: cachedResult,
          originalState: cachedResult,
          lastModified: new Date(playlist.attributes?.lastModifiedDate),
          artworkUrl: playlist.attributes?.artwork?.url
            ?.replace("{w}", "60")
            ?.replace("{h}", "60")
            ?.replace("{f}", "jpg")
            ?.replace(".{f}", ".jpg"),
        });
      } else {
        // Need to fetch from API
        playlistsToFetch.push(playlist);
      }
    }

    console.log(`Cache: ${cacheHits} hits, ${playlistsToFetch.length} misses`);
    cacheUsed.value = cacheHits > 0;

    // Fetch playlists that aren't cached
    if (playlistsToFetch.length > 0) {
      console.log(`Fetching ${playlistsToFetch.length} playlists from API...`);
      
      // Batch in groups to avoid overwhelming the API
      const batchSize = 10;
      const playlistsToCache: CachedPlaylist[] = [];
      
      for (let i = 0; i < playlistsToFetch.length; i += batchSize) {
        if (aborted.value) {
          console.log("Playlist checking aborted");
          return;
        }
        
        const batch = playlistsToFetch.slice(i, i + batchSize);
        const batchStates = await Promise.all(
          batch.map(async (playlist: any) => {
            const playlistName = playlist.attributes?.name || "Untitled Playlist";
            const playlistId = playlist.id;
            
            const result = await checkSongInPlaylistWithCache(playlistId, playlistName, searchIds);
            
            // Store for caching
            playlistsToCache.push(result.cached);

            return {
              id: playlistId,
              name: playlistName,
              isInPlaylist: result.found,
              originalState: result.found,
              lastModified: new Date(playlist.attributes?.lastModifiedDate),
              artworkUrl: playlist.attributes?.artwork?.url
                ?.replace("{w}", "60")
                ?.replace("{h}", "60")
                ?.replace("{f}", "jpg")
                ?.replace(".{f}", ".jpg"),
            };
          })
        );
        
        playlistStates.push(...batchStates);
        
        // Add small delay between batches
        if (i + batchSize < playlistsToFetch.length && !aborted.value) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Update cache with newly fetched playlists
      if (playlistsToCache.length > 0 && settings.enabled) {
        PlaylistCache.updatePlaylists(playlistsToCache);
      }
    }

    // Clear the modified playlists list since we just refreshed them
    if (modifiedPlaylistIds.length > 0) {
      PlaylistCache.clearModifiedPlaylists();
    }

    // Sort playlists: those with the song first, then by last modified date
    playlistStates.sort((a, b) => {
      // First, sort by whether the song is in the playlist
      if (a.isInPlaylist && !b.isInPlaylist) return -1;
      if (!a.isInPlaylist && b.isInPlaylist) return 1;
      
      // If both have the song or both don't, sort by last modified date
      const dateA = a.lastModified?.getTime() || 0;
      const dateB = b.lastModified?.getTime() || 0;
      return dateB - dateA;
    });

    playlists.value = playlistStates;
    
    if (!aborted.value) {
      const matchedPlaylists = playlistStates.filter((p) => p.isInPlaylist);
      console.log(`Found song in ${matchedPlaylists.length} playlists`);
      
      if (cacheHits > 0) {
        console.log(`✓ Used cache for ${cacheHits}/${playlistStates.length} playlists`);
      }
    }
  } catch (error) {
    console.error("Error loading playlists:", error);
    DialogAPI.createAlert(
      "Error loading playlists. Please make sure you are signed in to Apple Music."
    );
  } finally {
    loading.value = false;
  }
}

async function checkSongInPlaylistWithCache(
  playlistId: string,
  playlistName: string,
  searchIds: string[]
): Promise<{ found: boolean; cached: CachedPlaylist }> {
  try {
    let allTracks: any[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    // Fetch all tracks with pagination
    while (hasMore) {
      try {
        const response = await v3<any>(
          `/v1/me/library/playlists/${playlistId}/tracks`,
          { limit, offset }
        );

        const tracks = Array.isArray(response.data)
          ? response.data
          : response.data?.data || [];
        
        if (tracks.length === 0) {
          hasMore = false;
          break;
        }
        
        allTracks = allTracks.concat(tracks);
        hasMore = tracks.length === limit;
        offset += limit;

        if (offset > 1000) {
          console.warn(`Stopped fetching tracks for "${playlistName}" at 1000 tracks`);
          break;
        }
      } catch (error: any) {
        console.log(`Finished pagination for "${playlistName}" (${allTracks.length} tracks)`);
        hasMore = false;
        break;
      }
    }

    console.log(`Playlist "${playlistName}" has ${allTracks.length} total tracks`);

    // Extract all track IDs for caching
    const trackIds = allTracks.map((track: any) => {
      const libraryId = String(
        track.id ||
        track.attributes?.playParams?.id ||
        ""
      );
      const catalogId = String(
        track.attributes?.playParams?.catalogId ||
        track.attributes?.playParams?.reportingId ||
        ""
      );
      
      // Return both IDs if we have them
      return { libraryId, catalogId };
    }).filter(ids => ids.libraryId || ids.catalogId);

    console.log(`Playlist "${playlistName}" sample track IDs:`, trackIds.slice(0, 3));

    // Flatten to array of all IDs for checking
    const allIds: string[] = [];
    trackIds.forEach(({ libraryId, catalogId }) => {
      if (libraryId) allIds.push(libraryId);
      if (catalogId) allIds.push(catalogId);
    });

    // Check if any of our search IDs are in the tracks
    const found = searchIds.some((searchId: string) => {
      const cleanSearchId = searchId.replace(/^i\./, '');
      
      return allIds.some((trackId: string) => {
        const cleanTrackId = trackId.replace(/^i\./, '');
        
        return trackId === searchId ||
               cleanTrackId === cleanSearchId ||
               trackId.includes(searchId) ||
               searchId.includes(trackId) ||
               cleanTrackId.includes(cleanSearchId) ||
               cleanSearchId.includes(cleanTrackId);
      });
    });

    console.log(`Song found in "${playlistName}"?: ${found}`);
    console.log(`Search IDs: ${searchIds.join(', ')}`);
    if (!found && allIds.length > 0) {
      console.log(`Sample playlist track IDs: ${allIds.slice(0, 5).join(', ')}`);
    }

    return {
      found,
      cached: {
        id: playlistId,
        name: playlistName,
        tracks: allIds,
        lastModified: new Date(),
        cachedAt: new Date(),
      },
    };
  } catch (error) {
    console.error(`Error checking playlist ${playlistId}:`, error);
    return {
      found: false,
      cached: {
        id: playlistId,
        name: playlistName,
        tracks: [],
        lastModified: new Date(),
        cachedAt: new Date(),
      },
    };
  }
}

function togglePlaylist(playlist: PlaylistCheckState) {
  playlist.isInPlaylist = !playlist.isInPlaylist;
}

async function applyChanges() {
  if (!hasChanges.value) {
    closeModal();
    return;
  }

  processing.value = true;

  try {
    const changes = playlists.value.filter(
      (p) => p.isInPlaylist !== p.originalState
    );

    const modifiedIds: string[] = [];
    
    for (let i = 0; i < changes.length; i++) {
      const playlist = changes[i];
      modifiedIds.push(playlist.id);
      
      if (playlist.isInPlaylist) {
        await addSongToPlaylist(playlist.id);
      } else {
        await removeSongFromPlaylist(playlist.id);
      }
      
      // Update the original state immediately after successful operation
      playlist.originalState = playlist.isInPlaylist;
      
      if (i < changes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Mark these playlists as modified so they'll be refreshed next time
    PlaylistCache.markPlaylistsModified(modifiedIds);
    console.log(`Marked ${modifiedIds.length} playlists for refresh`);

    closeModal();
  } catch (error) {
    console.error("Error applying changes:", error);
    DialogAPI.createAlert("Failed to update playlists. Please try again.");
    processing.value = false;
  }
}

async function addSongToPlaylist(playlistId: string) {
  try {
    const musicKit = (window as any).MusicKit?.getInstance();
    const developerToken = musicKit?.developerToken;
    const userToken = musicKit?.musicUserToken;

    if (!developerToken || !userToken) {
      throw new Error("Music tokens not available");
    }

    const response = await fetch(
      `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks`,
      {
        method: "POST",
        headers: {
          "accept": "*/*",
          "authorization": `Bearer ${developerToken}`,
          "content-type": "text/plain;charset=UTF-8",
          "media-user-token": userToken,
        },
        body: JSON.stringify({
          data: [
            {
              id: String(props.songId),
              type: "songs",
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add song (${response.status}): ${errorText}`);
    }

    console.log(`✅ Successfully added song to playlist ${playlistId}`);
  } catch (error) {
    console.error(`Error adding song to playlist ${playlistId}:`, error);
    throw error;
  }
}

async function removeSongFromPlaylist(playlistId: string) {
  try {
    const songIdStr = String(props.songId);
    let allTracks: any[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await v3<any>(
          `/v1/me/library/playlists/${playlistId}/tracks`,
          { limit, offset }
        );

        const tracks = Array.isArray(response.data)
          ? response.data
          : response.data?.data || [];
        
        if (tracks.length === 0) {
          hasMore = false;
          break;
        }
        
        allTracks = allTracks.concat(tracks);
        hasMore = tracks.length === limit;
        offset += limit;

        if (offset > 1000) break;
      } catch (error: any) {
        console.log(`Finished pagination for playlist (${allTracks.length} tracks)`);
        hasMore = false;
        break;
      }
    }

    let foundIndex = -1;
    const remainingTracks = allTracks.filter((track: any, index: number) => {
      const trackId = String(track.id || "");
      const catalogId = String(track.attributes?.playParams?.catalogId || "");
      const reportingId = String(track.attributes?.playParams?.reportingId || "");
      const playParamsId = String(track.attributes?.playParams?.id || "");

      const isMatch =
        trackId === songIdStr ||
        catalogId === songIdStr ||
        reportingId === songIdStr ||
        playParamsId === songIdStr ||
        trackId.includes(songIdStr) ||
        catalogId.includes(songIdStr) ||
        reportingId.includes(songIdStr);

      if (isMatch && foundIndex === -1) {
        foundIndex = index;
      }

      return !isMatch;
    });

    if (foundIndex === -1) {
      console.warn(`Track not found in playlist ${playlistId}, nothing to remove`);
      return;
    }

    console.log(`Removing track at index ${foundIndex}. Before: ${allTracks.length}, After: ${remainingTracks.length}`);

    const musicKit = (window as any).MusicKit?.getInstance();
    const developerToken = musicKit?.developerToken;
    const userToken = musicKit?.musicUserToken;

    if (!developerToken || !userToken) {
      throw new Error("Music tokens not available");
    }

    const data = remainingTracks.map((track) => ({
      id: track.id,
      type: track.type || "library-songs",
    }));

    const response = await fetch(
      `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks`,
      {
        method: "PUT",
        headers: {
          "accept": "*/*",
          "authorization": `Bearer ${developerToken}`,
          "content-type": "text/plain;charset=UTF-8",
          "media-user-token": userToken,
        },
        body: JSON.stringify({ data }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Apple Music API failed:", errorText);
      throw new Error(`Failed to update playlist (${response.status})`);
    }

    console.log(`✅ Successfully removed song from playlist ${playlistId}`);
  } catch (error) {
    console.error(`Error removing song from playlist ${playlistId}:`, error);
    throw error;
  }
}

function closeModal() {
  console.log("closeModal called, onClose function:", props.onClose);
  aborted.value = true;
  
  if (props.onClose) {
    props.onClose();
  }

  emits("dialogClose");
}

function refreshPlaylists() {
  // Clear cache for all playlists to force refresh
  PlaylistCache.clearCache();
  // Reload playlists
  loadPlaylists();
}
</script>

<template>
  <div class="modal-content plugin-base playlist-manager-modal">
    <cider-modal-title-bar
      title="Manage Playlists"
      :back-btn="false"
      @close-pressed="closeModal"
    />

    <div class="modal-body">
      <div class="song-info">
        <div class="song-artwork" v-if="songArtwork">
          <img :src="songArtwork" :alt="songTitle" />
        </div>
        <div class="song-details">
          <div class="song-title">{{ songTitle }}</div>
          <div class="song-album" v-if="songAlbum">{{ songAlbum }}</div>
          <div class="song-artist">{{ songArtist }}</div>
        </div>
      </div>

      <div class="search-container">
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="Search playlists..."
        />
        <div class="search-icons">
          <button 
            v-if="!loading"
            class="icon-btn refresh-btn" 
            @click="refreshPlaylists"
            title="Refresh all playlists"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
              <g fill="currentColor">
                <path d="M9,17c-4.411,0-8-3.589-8-8S4.589,1,9,1c3.164,0,6.037,1.87,7.318,4.764,.168,.379-.003,.822-.382,.989-.379,.168-.821-.003-.989-.382-1.042-2.352-3.376-3.872-5.947-3.872-3.584,0-6.5,2.916-6.5,6.5s2.916,6.5,6.5,6.5c2.155,0,4.167-1.066,5.38-2.851,.233-.344,.701-.431,1.042-.199,.343,.232,.432,.699,.199,1.042-1.493,2.197-3.967,3.508-6.62,3.508Z"></path>
                <path d="M15.713,7c-.034,0-.069-.002-.104-.007l-2.944-.407c-.411-.057-.697-.436-.641-.846,.057-.41,.437-.693,.846-.641l2.201,.305,.305-2.202c.056-.41,.428-.699,.846-.64,.41,.057,.697,.435,.64,.846l-.408,2.945c-.052,.375-.373,.647-.742,.647Z"></path>
              </g>
            </svg>
          </button>
          <div v-if="cacheUsed && !loading" class="cache-indicator" title="Using cached data">
            ⚡
          </div>
        </div>
      </div>

      <div v-if="loading" class="loading-container">
        <div class="loading-spinner"></div>
        <div>Loading playlists...</div>
      </div>

      <div v-else class="playlists-list">
        <div
          v-for="playlist in filteredPlaylists"
          :key="playlist.id"
          class="playlist-item"
          :class="{ changed: playlist.isInPlaylist !== playlist.originalState }"
          @click="togglePlaylist(playlist)"
        >
          <div class="playlist-artwork">
            <img
              v-if="playlist.artworkUrl"
              :src="playlist.artworkUrl"
              :alt="playlist.name"
            />
            <div v-else class="placeholder-artwork">
              <span>♪</span>
            </div>
          </div>

          <div class="playlist-info">
            <div class="playlist-name">{{ playlist.name }}</div>
          </div>

          <label class="checkbox-container">
            <input
              type="checkbox"
              :checked="playlist.isInPlaylist"
              @click.stop="togglePlaylist(playlist)"
            />
            <span class="checkmark"></span>
          </label>
        </div>

        <div v-if="filteredPlaylists.length === 0" class="no-playlists">
          <div v-if="searchQuery">No playlists match your search</div>
          <div v-else>You don't have any playlists yet</div>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <div class="changes-info">
        <span v-if="hasChanges"
          >{{ changesCount }} change{{ changesCount !== 1 ? "s" : "" }}</span
        >
      </div>
      <div class="action-buttons">
        <button class="c-btn" @click="closeModal" :disabled="processing">
          Cancel
        </button>
        <button
          class="c-btn primary"
          @click="applyChanges"
          :disabled="processing || !hasChanges"
        >
          {{ processing ? "Saving..." : "Done" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playlist-manager-modal {
  height: 600px;
  width: 450px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: var(--glass_backgroundColor, #1a1a1a);
  border-radius: 12px;
  overflow: hidden;
}

.modal-body {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 16px;
}

.song-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.song-artwork {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.song-artwork img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.song-details {
  flex: 1;
  min-width: 0;
}

.song-title {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-album {
  font-size: 11px;
  opacity: 0.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.song-artist {
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.search-container {
  padding: 12px 0;
  margin: 0 -16px 0 -16px;
  padding-left: 16px;
  padding-right: 16px;
  width: calc(100% + 32px);
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-icons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-btn {
  background: none;
  border: none;
  padding: 6px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  opacity: 0.6;
  transition: all 0.2s;
}

.icon-btn:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.icon-btn:active {
  transform: scale(0.95);
}

.refresh-btn svg {
  width: 16px;
  height: 16px;
}

.search-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font-size: 14px;
  outline: none;
  transition: all 0.2s;
}

.search-input:focus {
  border-color: var(--keyColor, #ff0033);
  background: rgba(255, 255, 255, 0.08);
}

.cache-indicator {
  font-size: 18px;
  opacity: 0.6;
  animation: fadeIn 0.3s ease-in;
  display: flex;
  align-items: center;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 0.6;
  }
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
  opacity: 0.7;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--keyColor, #ff0033);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.playlists-list {
  flex: 1;
  overflow-y: auto;
  margin: 0 -16px;
  padding: 0 16px;
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 2px;
}

.playlist-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.playlist-item.changed {
  background: rgba(255, 0, 51, 0.1);
}

.playlist-item.changed:hover {
  background: rgba(255, 0, 51, 0.15);
}

.playlist-artwork {
  width: 34px;
  height: 34px;
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
}

.playlist-artwork img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.placeholder-artwork {
  width: 100%;
  height: 100%;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  opacity: 0.5;
}

.playlist-info {
  flex: 1;
  min-width: 0;
}

.playlist-name {
  font-weight: 500;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.checkbox-container {
  position: relative;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  padding: 4px;
  margin: -4px;
}

.checkbox-container input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 100%;
  width: 100%;
  top: 0;
  left: 0;
  z-index: 1;
}

.checkmark {
  display: block;
  height: 19px;
  width: 19px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  transition: all 0.2s;
}

.checkbox-container:hover .checkmark {
  border-color: rgba(255, 255, 255, 0.5);
}

.checkbox-container input:checked ~ .checkmark {
  background-color: var(--keyColor, #ff0033);
  border-color: var(--keyColor, #ff0033);
}

.checkbox-container input:checked ~ .checkmark::after {
  content: "✓";
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 13px;
  font-weight: bold;
}

.no-playlists {
  text-align: center;
  padding: 40px 20px;
  opacity: 0.5;
  font-size: 14px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.2);
}

.changes-info {
  font-size: 13px;
  opacity: 0.7;
  font-weight: 500;
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.c-btn {
  padding: 8px 20px;
  border-radius: 6px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
}

.c-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
}

.c-btn.primary {
  background: var(--keyColor, #ff0033);
  color: white;
}

.c-btn.primary:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}

.c-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
