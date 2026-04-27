<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { DialogAPI, v3, useMusicKit } from "@ciderapp/pluginkit";
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
const accentColor = ref("30, 0, 0"); // RGB triplet for --modal-accent
const accentIsLight = ref(false);
let musicKitInstance: MusicKit.MusicKitInstance | null = null;

// Captured from the first v3 GET call — reused for DELETE which v3 doesn't natively support
let capturedAuthHeaders: Record<string, string> = {};
let fetchInterceptorInstalled = false;

function getHeader(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return '';
  // Headers instance (has .get method)
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? '';
  }
  // Array of [name, value] pairs
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : '';
  }
  // Plain object
  const obj = headers as Record<string, string>;
  return obj[name] ?? obj[name.toLowerCase()] ?? '';
}

function buildAuthHeaders(): Record<string, string> | null {
  const mk = musicKitInstance as any;
  if (mk) {
    const developerToken = mk.developerToken || mk._developerToken || mk.authorizationStatus?.developerToken;
    const userToken = mk.musicUserToken || mk._musicUserToken || mk.userToken || mk._userToken;
    if (developerToken && userToken) {
      return { Authorization: `Bearer ${developerToken}`, 'Music-User-Token': userToken };
    }
  }
  const globalMk = (window as any).MusicKit?.getInstance?.() as any;
  if (globalMk) {
    const dt = globalMk.developerToken || globalMk._developerToken;
    const ut = globalMk.musicUserToken || globalMk._musicUserToken || globalMk.userToken || globalMk._userToken;
    if (dt && ut) {
      return { Authorization: `Bearer ${dt}`, 'Music-User-Token': ut };
    }
  }
  return null;
}

function installFetchInterceptor() {
  if (fetchInterceptorInstalled) return;
  fetchInterceptorInstalled = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(...args: Parameters<typeof fetch>) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? '';
    if (url.includes('amp-api.music.apple.com')) {
      const headers = args[1]?.headers;
      const auth = getHeader(headers, 'Authorization');
      if (auth && !capturedAuthHeaders['authorization']) {
        const allHeaders: Record<string, string> = {};
        if (typeof (headers as Headers).get === 'function') {
          (headers as Headers).forEach((value, key) => { allHeaders[key] = value; });
        } else if (Array.isArray(headers)) {
          headers.forEach(([k, v]: [string, string]) => { allHeaders[k] = v; });
        } else if (headers) {
          Object.assign(allHeaders, headers);
        }
        capturedAuthHeaders = { ...allHeaders };
      }
    }
    return origFetch(...args);
  };
}

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

// ── Artwork colour extraction ────────────────────────────────────────────────
function extractAccentFromImage(url: string): Promise<{ r: number; g: number; b: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 40; // sample at small size for speed
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        // Weighted average that down-weights near-grey/near-white/near-black pixels
        // to surface the actual accent hue
        let rSum = 0, gSum = 0, bSum = 0, weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const saturation = max === 0 ? 0 : (max - min) / max;
          const lightness = (max + min) / 510; // 0-1
          // Prefer vivid mid-tone pixels
          const w = saturation * (1 - Math.abs(lightness - 0.45));
          rSum += r * w;
          gSum += g * w;
          bSum += b * w;
          weight += w;
        }

        if (weight < 1) {
          // Image is basically greyscale — fall back to a dark neutral
          resolve({ r: 30, g: 20, b: 20 });
        } else {
          resolve({
            r: Math.round(rSum / weight),
            g: Math.round(gSum / weight),
            b: Math.round(bSum / weight),
          });
        }
      } catch {
        resolve({ r: 30, g: 0, b: 0 });
      }
    };
    img.onerror = () => resolve({ r: 30, g: 0, b: 0 });
    img.src = url;
  });
}

function relativeLuminance(r: number, g: number, b: number): number {
  const chan = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

async function applyAccentColor() {
  if (!props.songArtwork) return;
  const { r, g, b } = await extractAccentFromImage(props.songArtwork);
  // Darken slightly so the gradient base is deep enough for dark text to pop
  const dr = Math.round(r * 0.6);
  const dg = Math.round(g * 0.6);
  const db = Math.round(b * 0.6);
  accentColor.value = `${dr}, ${dg}, ${db}`;
  accentIsLight.value = relativeLuminance(dr, dg, db) > 0.179;
}
// ─────────────────────────────────────────────────────────────────────────────

onMounted(async () => {
  installFetchInterceptor();
  try {
    musicKitInstance = useMusicKit();
  } catch {
    musicKitInstance = (window as any).MusicKit?.getInstance?.() ?? null;
  }
  aborted.value = false;
  // Kick off colour extraction in parallel — doesn't block playlist loading
  applyAccentColor();
  await loadPlaylists();
});

/**
 * Try to find the library ID for a catalog song
 */
async function findLibraryId(catalogId: string): Promise<string | null> {
  try {
    const response = await v3<any>(`/v1/me/library/songs`, { filter: { id: catalogId }, limit: 1 });
    const songs = Array.isArray(response.data) ? response.data : response.data?.data || [];
    if (songs.length > 0 && songs[0].id) return songs[0].id;
  } catch { /* not in library */ }
  return null;
}

/**
 * Fetch all pages of library playlists (handles libraries with 100+ playlists).
 */
async function fetchAllPlaylists(): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    if (aborted.value) break;
    const response = await v3<any>(`/v1/me/library/playlists`, { limit, offset });
    const page = Array.isArray(response.data)
      ? response.data
      : response.data?.data || [];
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return all;
}

/**
 * Run up to `concurrency` async tasks at a time.
 */
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      if (aborted.value) return;
      const item = items[index++];
      await fn(item);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
}

async function loadPlaylists() {
  try {
    loading.value = true;
    const settings = PlaylistCache.getSettings();
    
    let searchIds = [props.songId];
    if (!props.songId.startsWith('i.')) {
      const libraryId = await findLibraryId(props.songId);
      if (libraryId) searchIds.push(libraryId);
    }

    // Paginate through all playlists — handles libraries with 100+ playlists
    const userPlaylists = await fetchAllPlaylists();
    
    if (aborted.value) return;

    const editablePlaylists = userPlaylists.filter((playlist: any) =>
      playlist.attributes?.canEdit !== false && playlist.type === 'library-playlists'
    );

    // Sort by last modified date
    const sortedPlaylists = [...editablePlaylists].sort((a: any, b: any) => {
      const dateA = new Date(a.attributes?.lastModifiedDate || 0);
      const dateB = new Date(b.attributes?.lastModifiedDate || 0);
      return dateB.getTime() - dateA.getTime();
    });

    const modifiedPlaylistIds = PlaylistCache.getModifiedPlaylists();

    // Separate cache hits from playlists that need API fetches
    const playlistStates: PlaylistCheckState[] = [];
    const playlistsToFetch: any[] = [];
    let cacheHits = 0;
    
    for (const playlist of sortedPlaylists) {
      const playlistId = playlist.id;
      const playlistName = playlist.attributes?.name || "Untitled Playlist";
      
      const needsRefresh = modifiedPlaylistIds.includes(playlistId);
      let cachedResult = null;
      if (!needsRefresh) {
        for (const searchId of searchIds) {
          cachedResult = PlaylistCache.isSongInPlaylist(playlistId, searchId);
          if (cachedResult !== null) break;
        }
      }
      
      if (cachedResult !== null && settings.enabled) {
        cacheHits++;
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
        playlistsToFetch.push(playlist);
      }
    }

    cacheUsed.value = cacheHits > 0;

    if (playlistsToFetch.length > 0) {
      const playlistsToCache: CachedPlaylist[] = [];
      const fetchedStates: PlaylistCheckState[] = Array(playlistsToFetch.length);

      // Run up to 25 playlist checks concurrently — fast for large libraries
      // without overwhelming the Apple Music API
      await withConcurrency(playlistsToFetch, 25, async (playlist: any) => {
        if (aborted.value) return;
        const idx = playlistsToFetch.indexOf(playlist);
        const playlistId = playlist.id;
        const playlistName = playlist.attributes?.name || "Untitled Playlist";

        const result = await checkSongInPlaylistWithCache(playlistId, playlistName, searchIds);
        playlistsToCache.push(result.cached);

        fetchedStates[idx] = {
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
      });

      playlistStates.push(...fetchedStates.filter(Boolean));

      if (playlistsToCache.length > 0 && settings.enabled) {
        PlaylistCache.updatePlaylists(playlistsToCache);
      }
    }

    if (modifiedPlaylistIds.length > 0) {
      PlaylistCache.clearModifiedPlaylists();
    }

    // Sort: playlists containing the song first, then by last modified date
    playlistStates.sort((a, b) => {
      if (a.isInPlaylist && !b.isInPlaylist) return -1;
      if (!a.isInPlaylist && b.isInPlaylist) return 1;
      const dateA = a.lastModified?.getTime() || 0;
      const dateB = b.lastModified?.getTime() || 0;
      return dateB - dateA;
    });

    playlists.value = playlistStates;
    
    if (!aborted.value) {
      const inCount = playlistStates.filter((p) => p.isInPlaylist).length;
      console.log(`[PlaylistManager] ${props.songTitle}: in ${inCount}/${playlistStates.length} playlists, ${cacheHits} from cache`);
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

function trackMatchesSearchIds(track: any, searchIds: string[]): boolean {
  const libraryId = String(track.id || track.attributes?.playParams?.id || "");
  const catalogId = String(track.attributes?.playParams?.catalogId || track.attributes?.playParams?.reportingId || "");
  return searchIds.some(searchId => {
    const clean = searchId.replace(/^i\./, '');
    return [libraryId, catalogId].some(tid => {
      if (!tid) return false;
      const cleanTid = tid.replace(/^i\./, '');
      return tid === searchId || cleanTid === clean ||
             tid.includes(searchId) || searchId.includes(tid) ||
             cleanTid.includes(clean) || clean.includes(cleanTid);
    });
  });
}

function extractTrackIds(track: any): string[] {
  const ids: string[] = [];
  const lib = String(track.id || track.attributes?.playParams?.id || "");
  const cat = String(track.attributes?.playParams?.catalogId || track.attributes?.playParams?.reportingId || "");
  if (lib) ids.push(lib);
  if (cat) ids.push(cat);
  return ids;
}

async function checkSongInPlaylistWithCache(
  playlistId: string,
  playlistName: string,
  searchIds: string[]
): Promise<{ found: boolean; cached: CachedPlaylist }> {
  try {
    let allIds: string[] = [];
    let offset = 0;
    const limit = 100;
    let found = false;

    // Paginate through tracks, but short-circuit as soon as we find the song
    while (true) {
      try {
        const response = await v3<any>(
          `/v1/me/library/playlists/${playlistId}/tracks`,
          { limit, offset }
        );

        const tracks = Array.isArray(response.data)
          ? response.data
          : response.data?.data || [];

        if (tracks.length === 0) break;

        for (const track of tracks) {
          const ids = extractTrackIds(track);
          allIds = allIds.concat(ids);
          if (!found && trackMatchesSearchIds(track, searchIds)) {
            found = true;
            // Don't break — keep collecting IDs for caching, but we know the answer
          }
        }

        if (tracks.length < limit) break;
        offset += limit;
        if (offset > 1000) break;
      } catch {
        break;
      }
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

    // Apply all adds and removes concurrently
    await Promise.all(
      changes.map(async (playlist) => {
        if (playlist.isInPlaylist) {
          await addSongToPlaylist(playlist.id);
        } else {
          await removeSongFromPlaylist(playlist.id);
        }
        playlist.originalState = playlist.isInPlaylist;
      })
    );

    PlaylistCache.markPlaylistsModified(changes.map((p) => p.id));
    closeModal();
  } catch (error) {
    console.error("Error applying changes:", error);
    DialogAPI.createAlert("Failed to update playlists. Please try again.");
    processing.value = false;
  }
}

async function addSongToPlaylist(playlistId: string) {
  try {
    const store = (window as any).CiderApp?.musicKitStore;
    if (!store?.addToPlaylist) {
      throw new Error("musicKitStore.addToPlaylist not available");
    }

    await store.addToPlaylist(playlistId, [{ id: String(props.songId), type: "songs" }]);
    console.log(`[PlaylistManager] Added to ${playlistId}`);
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
        if (tracks.length === 0) { hasMore = false; break; }
        allTracks = allTracks.concat(tracks);
        hasMore = tracks.length === limit;
        offset += limit;
        if (offset > 1000) break;
      } catch {
        hasMore = false;
        break;
      }
    }

    // Find and remove the matching track
    let foundIndex = -1;
    allTracks.forEach((track: any, index: number) => {
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
    });

    if (foundIndex === -1) {
      console.warn(`[PlaylistManager] Track not found in ${playlistId}`);
      return;
    }

    const authHeaders = buildAuthHeaders()
      ?? (Object.keys(capturedAuthHeaders).length > 0 ? capturedAuthHeaders : null);

    if (!authHeaders) throw new Error('Could not obtain auth headers for DELETE request');

    const trackToRemove = allTracks[foundIndex];
    const libraryId = String(
      trackToRemove.id ||
      trackToRemove.attributes?.playParams?.id ||
      ""
    );

    if (!libraryId) {
      throw new Error(`Could not determine library ID for track at index ${foundIndex}`);
    }

    const deleteUrl = `https://amp-api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?ids[library-songs]=${encodeURIComponent(libraryId)}&mode=all`;

    const response = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { ...authHeaders },
    });

    if (!response.ok && response.status !== 204) {
      const body = await response.text().catch(() => '');
      throw new Error(`DELETE /tracks failed: HTTP ${response.status} — ${body}`);
    }

    console.log(`[PlaylistManager] Removed ${libraryId} from ${playlistId}`);
  } catch (error) {
    console.error(`Error removing song from playlist ${playlistId}:`, error);
    throw error;
  }
}

function closeModal() {
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
  <div class="modal-content plugin-base playlist-manager-modal"
    :style="{
      '--modal-accent': `rgb(${accentColor})`,
    }"
    :class="{ 'accent-is-light': accentIsLight }"
  >
    <!-- Blurred background layer that picks up nowPlaying colours -->
    <div class="modal-bg-blur" aria-hidden="true" />
    <div class="modal-bg-gradient" aria-hidden="true" />

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
          <div class="song-artist">{{ songArtist }}</div>
          <div class="song-album" v-if="songAlbum">{{ songAlbum }}</div>
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
/* ─── Enter animation (from your theme snippets) ─── */
@keyframes modalEnter {
  from {
    opacity: 0;
    transform: translateY(10%);
    filter: blur(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }
}

/* ─── Shell ─── */
.playlist-manager-modal {
  height: 600px;
  width: 450px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  border-radius: 14px;
  overflow: hidden;
  position: relative;
  isolation: isolate;

  /* Play the enter animation using the same easing as your theme */
  animation: modalEnter 0.35s var(--ease_appleSpring, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
  will-change: opacity, transform, filter;

  /* Thin iridescent border — same technique as .cider-sidebar::after */
  &::after {
    content: "";
    position: absolute;
    inset: 0;
    border: 1px solid transparent;
    border-radius: inherit;
    background: linear-gradient(
        -70deg,
        var(--modal-accent, white),
        color-mix(in srgb, var(--modal-accent, white) 60%, white),
        var(--modal-accent, white)
      )
      border-box;
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
    opacity: 0.45;
    filter: saturate(380%) contrast(100%) brightness(130%);
    z-index: 10;
  }
}

/* ─── Blurred backdrop — sits behind everything ─── */
.modal-bg-blur {
  position: absolute;
  inset: 0;
  backdrop-filter: blur(60px) saturate(380%) brightness(50%);
  z-index: -2;
  border-radius: inherit;

  /* Light mode */
  body.body--light & {
    backdrop-filter: blur(60px) saturate(380%) brightness(100%);
  }
}

/* ─── Gradient tint — uses extracted artwork accent ─── */
.modal-bg-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--modal-accent, rgb(30,0,0)) 55%, rgb(0,0,0)) 0%,
    color-mix(in srgb, var(--modal-accent, rgb(30,0,0)) 25%, rgb(0,0,0)) 55%,
    rgb(0,0,0) 100%
  );
  z-index: -1;
  border-radius: inherit;
  transition: background 0.6s ease;

  body.body--light & {
    background: linear-gradient(
      160deg,
      color-mix(in srgb, var(--modal-accent, rgb(240,232,232)) 35%, rgba(255,255,255,0.9)) 0%,
      rgba(255,255,255,0.8) 100%
    );
  }
}

/* ─── Body ─── */
.modal-body {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 20px;
}

/* ─── Song info strip ─── */
.song-info {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 0 18px;
  border-bottom: 1px solid rgb(255 255 255 / 10%);
  animation: modalEnter 0.35s var(--ease_appleSpring, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
  animation-delay: 40ms;
  will-change: opacity, transform, filter;
}

.song-artwork {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 4px 16px rgb(0 0 0 / 40%);
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

.song-artist {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.song-album {
  font-size: 11px;
  opacity: 0.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

/* ─── Search row ─── */
.search-container {
  padding: 14px 0;
  margin: 0 -20px;
  padding-left: 20px;
  padding-right: 20px;
  width: calc(100% + 40px);
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: modalEnter 0.35s var(--ease_appleSpring, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
  animation-delay: 80ms;
  will-change: opacity, transform, filter;
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
  background: rgb(255 255 255 / 10%);
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
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 8px;
  background: rgb(255 255 255 / 6%);
  color: inherit;
  font-size: 14px;
  outline: none;
  transition: all 0.2s;
  backdrop-filter: blur(10px);
}

.search-input:focus {
  border-color: color-mix(in display-p3, var(--nowPlaying-bgColor, var(--keyColor, #ff0033)) 80%, white 20%);
  background: rgb(255 255 255 / 10%);
}

.cache-indicator {
  font-size: 18px;
  opacity: 0.6;
  animation: fadeIn 0.3s ease-in;
  display: flex;
  align-items: center;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to   { opacity: 0.6; }
}

/* ─── Loading ─── */
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
  border: 3px solid rgb(255 255 255 / 10%);
  border-top-color: color-mix(in display-p3, var(--nowPlaying-bgColor, var(--keyColor, #ff0033)) 70%, white 30%);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ─── Playlist list ─── */
.playlists-list {
  flex: 1;
  overflow-y: auto;
  margin: 0 -20px;
  padding: 0 20px;
  animation: modalEnter 0.4s var(--ease_appleSpring, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
  animation-delay: 120ms;
  will-change: opacity, transform, filter;
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s, transform 0.15s;
  margin-bottom: 3px;
}

.playlist-item:hover {
  background: rgb(255 255 255 / 7%);
}

.playlist-item:active {
  transform: scale(0.99);
}

.playlist-item.changed {
  background: color-mix(in display-p3, var(--nowPlaying-bgColor, var(--keyColor, #ff0033)) 20%, transparent);
}

.playlist-item.changed:hover {
  background: color-mix(in display-p3, var(--nowPlaying-bgColor, var(--keyColor, #ff0033)) 28%, transparent);
}

.playlist-artwork {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgb(0 0 0 / 30%);
}

.playlist-artwork img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.placeholder-artwork {
  width: 100%;
  height: 100%;
  background: rgb(255 255 255 / 10%);
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

/* ─── Checkbox ─── */
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
  border: 2px solid rgb(255 255 255 / 30%);
  border-radius: 4px;
  transition: all 0.2s;
}

.checkbox-container:hover .checkmark {
  border-color: rgb(255 255 255 / 55%);
}

.checkbox-container input:checked ~ .checkmark {
  background-color: color-mix(in srgb, var(--modal-accent, var(--keyColor, #ff0033)) 70%, white 30%);
  border-color: color-mix(in srgb, var(--modal-accent, var(--keyColor, #ff0033)) 70%, white 30%);
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

/* ─── Empty state ─── */
.no-playlists {
  text-align: center;
  padding: 40px 20px;
  opacity: 0.5;
  font-size: 14px;
}

/* ─── Footer ─── */
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-top: 1px solid rgb(255 255 255 / 8%);
  /* subtle extra blur strip at the bottom */
  background: rgb(0 0 0 / 20%);
  backdrop-filter: blur(20px) saturate(200%) brightness(60%);

  body.body--light & {
    background: rgb(255 255 255 / 30%);
    backdrop-filter: blur(20px) saturate(200%) brightness(110%);
  }
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

/* ─── Buttons ─── */
.c-btn {
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 10%);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  background: rgb(255 255 255 / 8%);
  color: inherit;
  backdrop-filter: blur(10px);
}

.c-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 14%);
  border-color: rgb(255 255 255 / 18%);
}

.c-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.c-btn.primary {
  background: color-mix(in srgb, var(--modal-accent, var(--keyColor, #ff0033)) 65%, black 35%);
  border-color: color-mix(in srgb, var(--modal-accent, var(--keyColor, #ff0033)) 80%, white 20%);
  color: white;
}

.c-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--modal-accent, var(--keyColor, #ff0033)) 80%, white 20%);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px color-mix(in srgb, var(--modal-accent, var(--keyColor, #ff0033)) 50%, transparent);
}

.c-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
