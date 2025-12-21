<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { DialogAPI, v3 } from "@ciderapp/pluginkit";

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

const filteredPlaylists = computed(() => {
  if (!searchQuery.value) return playlists.value;

  const query = searchQuery.value.toLowerCase();
  return playlists.value.filter((p) => p.name.toLowerCase().includes(query));
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

async function loadPlaylists() {
  try {
    loading.value = true;

    console.log("Fetching playlists using v3 API...");

    // Use v3 helper from pluginkit
    const response = await v3<any>(`/v1/me/library/playlists`, { limit: 100 });
    
    // Check if aborted
    if (aborted.value) {
      console.log("Playlist loading aborted");
      return;
    }
    
    console.log("Playlists API response:", response);

    const userPlaylists = Array.isArray(response.data)
      ? response.data
      : response.data?.data || [];

    console.log("Found", userPlaylists.length, "playlists");

    // Filter out Apple Music playlists (Favorites, Rotations, etc.)
    // These have canEdit: false and are system playlists
    const editablePlaylists = userPlaylists.filter((playlist: any) => {
      const canEdit = playlist.attributes?.canEdit !== false;
      const isLibraryPlaylist = playlist.type === 'library-playlists';
      return canEdit && isLibraryPlaylist;
    });

    console.log("Found", editablePlaylists.length, "editable playlists (filtered out Apple Music playlists)");

    // Sort by last modified date (most recent first)
    const sortedPlaylists = [...editablePlaylists].sort((a: any, b: any) => {
      const dateA = new Date(a.attributes?.lastModifiedDate || 0);
      const dateB = new Date(b.attributes?.lastModifiedDate || 0);
      return dateB.getTime() - dateA.getTime();
    });

    // Check if song is in each playlist
    console.log(
      `Checking if song ${props.songId} is in ${sortedPlaylists.length} playlists...`
    );
    
    // Only batch if we have many playlists to avoid unnecessary delays
    const shouldBatch = sortedPlaylists.length > 20;
    const batchSize = shouldBatch ? 10 : sortedPlaylists.length;
    const playlistStates: PlaylistCheckState[] = [];
    
    for (let i = 0; i < sortedPlaylists.length; i += batchSize) {
      // Check if aborted before each batch
      if (aborted.value) {
        console.log("Playlist checking aborted");
        return;
      }
      
      const batch = sortedPlaylists.slice(i, i + batchSize);
      const batchStates = await Promise.all(
        batch.map(async (playlist: any, batchIndex: number) => {
          const index = i + batchIndex;
          const playlistName = playlist.attributes?.name || "Untitled Playlist";
          const playlistId = playlist.id;
          console.log(
            `[${index}] Checking playlist: "${playlistName}" (${playlistId})`
          );
          const isInPlaylist = await checkSongInPlaylist(
            playlistId,
            playlistName
          );
          console.log(
            `[${index}]   Result: ${isInPlaylist ? "✅ FOUND" : "❌ Not found"}`
          );

          return {
            id: playlistId,
            name: playlistName,
            isInPlaylist,
            originalState: isInPlaylist,
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
      
      // Only add delay between batches if we're actually batching AND not on last batch
      if (shouldBatch && i + batchSize < sortedPlaylists.length && !aborted.value) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    playlists.value = playlistStates;
    
    // Don't log if aborted
    if (!aborted.value) {
      const matchedPlaylists = playlistStates.filter((p) => p.isInPlaylist);
      console.log(
        `Final playlist states with ${matchedPlaylists.length} matches:`
      );
      matchedPlaylists.forEach((p) => {
        console.log(
          `  ✅ "${p.name}" (${p.id}) - isInPlaylist: ${p.isInPlaylist}`
        );
      });
      console.log(
        "All playlists state:",
        playlists.value.map((p) => ({
          name: p.name,
          isInPlaylist: p.isInPlaylist,
          originalState: p.originalState,
        }))
      );
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

async function checkSongInPlaylist(
  playlistId: string,
  playlistName: string
): Promise<boolean> {
  try {
    const songIdStr = String(props.songId);
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
        
        // If we get no tracks, we've reached the end
        if (tracks.length === 0) {
          hasMore = false;
          break;
        }
        
        allTracks = allTracks.concat(tracks);

        // Check if there are more tracks - if we got fewer than the limit, we're done
        hasMore = tracks.length === limit;
        offset += limit;

        // Safety check to prevent infinite loops
        if (offset > 1000) {
          console.warn(
            `Stopped fetching tracks for "${playlistName}" at 1000 tracks`
          );
          break;
        }
      } catch (error: any) {
        // If we get a 404 or any error, assume we've reached the end
        // The v3 API logs this error, but we can safely ignore it as it just means
        // we've paginated past the end of the playlist
        console.log(`Finished pagination for "${playlistName}" (${allTracks.length} tracks)`);
        hasMore = false;
        break;
      }
    }

    console.log(
      `  Playlist "${playlistName}" has ${allTracks.length} total tracks (fetched with pagination)`
    );

    // Log first few tracks to see their structure (only for emoji playlists)
    if (
      allTracks.length > 0 &&
      playlistName.match(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
      )
    ) {
      console.log(`  First track in "${playlistName}":`, {
        id: allTracks[0].id,
        type: allTracks[0].type,
        catalogId: allTracks[0].attributes?.playParams?.catalogId,
        reportingId: allTracks[0].attributes?.playParams?.reportingId,
        playParamsId: allTracks[0].attributes?.playParams?.id,
        name: allTracks[0].attributes?.name,
      });
    }

    const found = allTracks.some((track: any) => {
      // Try multiple ID fields
      const trackId = String(track.id || "");
      const catalogId = String(track.attributes?.playParams?.catalogId || "");
      const reportingId = String(
        track.attributes?.playParams?.reportingId || ""
      );
      const playParamsId = String(track.attributes?.playParams?.id || "");

      // Check if any field matches
      const matches =
        trackId === songIdStr ||
        catalogId === songIdStr ||
        reportingId === songIdStr ||
        playParamsId === songIdStr ||
        // Also check if the songId is contained in the track ID (for cases like i.1440881859)
        trackId.includes(songIdStr) ||
        catalogId.includes(songIdStr) ||
        reportingId.includes(songIdStr);

      if (matches) {
        console.log(
          `  ✅ "${playlistName}" - Found match! Track ID: ${trackId}, Catalog: ${catalogId}, Reporting: ${reportingId}`
        );
      }

      return matches;
    });

    return found;
  } catch (error) {
    console.error(`Error checking playlist ${playlistId}:`, error);
    return false;
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

    // Only add delays if we're updating many playlists
    const shouldDelay = changes.length > 5;
    
    for (let i = 0; i < changes.length; i++) {
      const playlist = changes[i];
      
      if (playlist.isInPlaylist) {
        await addSongToPlaylist(playlist.id);
      } else {
        await removeSongFromPlaylist(playlist.id);
      }
      
      // Only delay if we have many changes AND not on the last one
      if (shouldDelay && i < changes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Success! Close modal without alert
    closeModal();
  } catch (error) {
    console.error("Error applying changes:", error);
    DialogAPI.createAlert("Failed to update playlists. Please try again.");
    processing.value = false;
  }
}

async function addSongToPlaylist(playlistId: string) {
  try {
    // Use direct fetch with proper MusicKit authentication
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
        
        // If we get no tracks, we've reached the end
        if (tracks.length === 0) {
          hasMore = false;
          break;
        }
        
        allTracks = allTracks.concat(tracks);

        // Check if there are more tracks - if we got fewer than the limit, we're done
        hasMore = tracks.length === limit;
        offset += limit;

        if (offset > 1000) break;
      } catch (error: any) {
        // If we get an error (usually 404), assume we've reached the end
        // The v3 API logs this error, but we can safely ignore it
        console.log(`Finished pagination for playlist (${allTracks.length} tracks)`);
        hasMore = false;
        break;
      }
    }

    // Find which track to remove and filter it out
    let foundIndex = -1;
    const remainingTracks = allTracks.filter((track: any, index: number) => {
      const trackId = String(track.id || "");
      const catalogId = String(track.attributes?.playParams?.catalogId || "");
      const reportingId = String(
        track.attributes?.playParams?.reportingId || ""
      );
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

      return !isMatch; // Keep tracks that don't match
    });

    if (foundIndex === -1) {
      console.warn(
        `Track not found in playlist ${playlistId}, nothing to remove`
      );
      return;
    }

    console.log(
      `Removing track at index ${foundIndex}. Before: ${allTracks.length}, After: ${remainingTracks.length}`
    );

    // Use Apple Music API to replace the playlist with remaining tracks
    const musicKit = (window as any).MusicKit?.getInstance();
    const developerToken = musicKit?.developerToken;
    const userToken = musicKit?.musicUserToken;

    if (!developerToken || !userToken) {
      throw new Error("Music tokens not available");
    }

    // Build the data array with remaining tracks
    const data = remainingTracks.map((track) => ({
      id: track.id,
      type: track.type || "library-songs",
    }));

    // Use PUT to replace the entire playlist (matching the curl example)
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

  // Set aborted flag to stop any ongoing API calls
  aborted.value = true;
  
  // Call the close function passed from main.ts
  if (props.onClose) {
    props.onClose();
  }

  // Also emit for good measure
  emits("dialogClose");
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
}

.search-input {
  width: 100%;
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
