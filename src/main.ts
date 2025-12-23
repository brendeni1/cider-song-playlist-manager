import { defineCustomElement } from "vue";
import type { App } from "vue";
import { createPinia } from "pinia";
import {
  definePluginContext,
  addMediaItemContextMenuEntry,
  DialogAPI,
  createModal,
} from "@ciderapp/pluginkit";
import PlaylistManagerModal from "./components/PlaylistManagerModal.vue";
import SettingsModal from "./components/SettingsModal.vue";
import PluginConfig from "./plugin.config";

/**
 * Initializing a Vue app instance so we can use things like Pinia.
 */
const pinia = createPinia();

/**
 * Function that configures the app instances of the custom elements
 */
function configureApp(app: App) {
  app.use(pinia);
}

/**
 * Custom Elements that will be registered in the app
 */
export const CustomElements = {
  "playlist-manager-modal": defineCustomElement(PlaylistManagerModal, {
    /**
     * Disabling the shadow root DOM so that we can inject styles from the DOM
     */
    shadowRoot: false,
    configureApp,
  }),
  "settings-modal": defineCustomElement(SettingsModal, {
    shadowRoot: false,
    configureApp,
  }),
};

/**
 * Defining the plugin context
 */
const { plugin, customElementName } = definePluginContext({
  ...PluginConfig,
  CustomElements,
  setup() {
    /**
     * Registering the custom elements in the app
     */
    for (const [key, value] of Object.entries(CustomElements)) {
      const _key = key as keyof typeof CustomElements;
      customElements.define(customElementName(_key), value);
    }

    /**
     * Defining our custom settings element
     * This tells Cider to use our settings component
     */
    this.SettingsElement = customElementName("settings-modal");

    /**
     * Function to open the modal with song data
     */
    function openPlaylistManagerModal(songId: string | number, songTitle: string, songArtist: string, songAlbum?: string, songArtwork?: string) {
      // Convert songId to string immediately
      const songIdStr = String(songId);
      
      console.log("Opening Playlist Manager with:", { songId: songIdStr, songTitle, songArtist });

      if (!songIdStr || songIdStr === 'undefined' || songIdStr === 'null') {
        DialogAPI.createAlert("Invalid song ID provided.");
        return;
      }

      // Use createModal
      const { openDialog, closeDialog, dialogElement } = createModal({
        escClose: true,
      });

      // Create the custom element with a unique timestamp to force remount
      const content = document.createElement(
        customElementName("playlist-manager-modal")
      ) as any;
      
      // Add a unique timestamp to force fresh data on each open
      const timestamp = Date.now();
      
      // Set props on the custom element
      content._props = {
        songId: songIdStr,
        songTitle: songTitle,
        songArtist: songArtist,
        songAlbum: songAlbum || '',
        songArtwork: songArtwork || '',
        onClose: () => {
          console.log("Modal closing, removing element...");
          // Remove the element to ensure fresh mount next time
          if (content.parentNode) {
            content.parentNode.removeChild(content);
          }
          closeDialog();
        },
      };

      // Append to dialog
      dialogElement.appendChild(content);

      // Open the dialog
      openDialog();
      
      console.log("Modal opened at timestamp:", timestamp);
    }

    /**
     * Function to open the playlist manager from context menu
     */
    function openPlaylistManager(item: any) {
      console.log("=== EXTRACTING SONG INFO ===");
      console.log("Full item object:", item);
      console.log("Item keys:", Object.keys(item));
      
      // Try multiple ways to get the song ID
      let songId = item?.id;
      
      // Check playParams first (most reliable for catalog songs)
      if (!songId && item?.attributes?.playParams) {
        songId = item.attributes.playParams.catalogId || 
                 item.attributes.playParams.id ||
                 item.attributes.playParams.reportingId;
      }
      
      // For library songs, try different paths
      if (!songId) {
        songId = item?.playParams?.catalogId ||
                 item?.playParams?.id ||
                 item?.catalogId;
      }
      
      // Try getting from container
      if (!songId && item?.container) {
        songId = item.container.id || 
                 item.container.catalogId ||
                 item.container.playParams?.catalogId;
      }
      
      // Check if item itself has a songId property
      if (!songId) {
        songId = item?.songId || item?.trackId;
      }
      
      // Try getting from mediaItem (Cider often wraps in this)
      if (!songId && item?.mediaItem) {
        songId = item.mediaItem.id ||
                 item.mediaItem.attributes?.playParams?.catalogId ||
                 item.mediaItem.attributes?.playParams?.id;
      }
      
      // Check the _data property that Cider sometimes uses
      if (!songId && item?._data) {
        songId = item._data.id ||
                 item._data.attributes?.playParams?.catalogId;
      }
      
      // Last resort - check rawItem
      if (!songId && item?.rawItem) {
        songId = item.rawItem.id ||
                 item.rawItem.catalogId ||
                 item.rawItem.attributes?.playParams?.catalogId;
      }

      const songTitle = item?.attributes?.name || 
                        item?.mediaItem?.attributes?.name ||
                        item?._data?.attributes?.name ||
                        item?.name || 
                        item?.title ||
                        "Unknown Song";
      const songArtist = item?.attributes?.artistName || 
                         item?.mediaItem?.attributes?.artistName ||
                         item?._data?.attributes?.artistName ||
                         item?.artistName || 
                         item?.artist ||
                         "Unknown Artist";
      const songAlbum = item?.attributes?.albumName || 
                        item?.mediaItem?.attributes?.albumName ||
                        item?._data?.attributes?.albumName ||
                        item?.albumName || 
                        item?.album ||
                        "";
      const songArtwork = item?.attributes?.artwork?.url ||
                          item?.mediaItem?.attributes?.artwork?.url ||
                          item?._data?.attributes?.artwork?.url ||
                          item?.artwork?.url ||
                          "";
      
      // If we have artwork URL template, replace dimensions
      let artworkUrl = "";
      if (songArtwork) {
        artworkUrl = songArtwork
          .replace('{w}', '80')
          .replace('{h}', '80')
          .replace('{f}', 'jpg');
      }

      console.log("Context menu - extracted:", { songId, songTitle, songArtist, songAlbum, artworkUrl });

      if (!songId) {
        console.error("Could not find song ID in any known location");
        console.log("Available properties:", {
          hasId: !!item?.id,
          hasAttributes: !!item?.attributes,
          hasPlayParams: !!item?.playParams,
          hasContainer: !!item?.container,
          hasMediaItem: !!item?.mediaItem,
          has_data: !!item?._data,
          hasRawItem: !!item?.rawItem,
        });
        DialogAPI.createAlert("Unable to identify the song. Please try again or use window.openPlaylistManager('songId', 'title', 'artist') in console.");
        return;
      }

      openPlaylistManagerModal(String(songId), songTitle, songArtist, songAlbum, artworkUrl);
    }

    /**
     * Store the last right-clicked element to get song data from it
     */
    let lastRightClickedElement: HTMLElement | null = null;
    
    // Add global right-click listener to capture the target element
    document.addEventListener('contextmenu', (e) => {
      lastRightClickedElement = e.target as HTMLElement;
      console.log("Right-clicked element:", lastRightClickedElement);
      console.log("Right-clicked element classes:", lastRightClickedElement.className);
      console.log("Right-clicked element parent:", lastRightClickedElement.parentElement);
    }, true);
    
    // Also capture clicks on menu buttons (the "..." button)
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // Check if we clicked on a menu button or its children
      const menuBtn = target.closest('.menu-btn');
      if (menuBtn) {
        // Find the parent song item
        const songItem = menuBtn.closest('.ri-list-item, .library-song-item, [data-item-id]');
        if (songItem) {
          lastRightClickedElement = songItem as HTMLElement;
          console.log("Menu button clicked, storing song element:", lastRightClickedElement);
        }
      }
    }, true);

    /**
     * Add "Manage Playlists" to the context menu for media items
     */
    addMediaItemContextMenuEntry({
      label: "Add to Playlist",
      onClick(item: any) {
        console.log("=== PLAYLIST MANAGER - Context Menu Click ===");
        console.log("Item received:", item);
        console.log("Last right-clicked element:", lastRightClickedElement);
        
        // The actual song data might be in the event or we need to get it from the current track
        // Try to get from MusicKit's current queue or nowPlayingItem
        const musicKit = (window as any).MusicKit?.getInstance();
        
        // Option 1: Try to get from the last right-clicked element
        let songData = null;
        if (lastRightClickedElement) {
          const target = lastRightClickedElement;
          
          // Look for media item in parent chain - including library browser
          const mediaItem = target.closest('.ri-list-item') ||         // Playlist/Library list view
                           target.closest('.library-song-item') ||     // Library browser
                           target.closest('[data-item-id]') ||         // Any item with data attributes
                           target.closest('.c-listitem-short') ||      // Search and Artist page
                           target.closest('.track-item') ||            // Track items
                           target.closest('.song-item') ||             // Song items
                           target.closest('[data-media-item]') ||      // Generic media items
                           target.closest('.media-item') ||            // Alternative media items
                           target.closest('.album-track');             // Album view tracks
          
          if (mediaItem) {
            console.log("Found media item element:", mediaItem);
            const element = mediaItem as HTMLElement;
            
            // Extract data from Cider's data attributes (works for list views)
            if (element.dataset.itemId) {
              const itemId = element.dataset.itemId;
              const itemType = element.dataset.itemType || 'library-songs';
              
              // Check if this is a library browser item (.library-song-item)
              if (element.classList.contains('library-song-item')) {
                // Library browser has a different DOM structure
                const titleEl = element.querySelector('.content-title .title-text');
                const artistEl = element.querySelector('.content-artist');
                const albumEl = element.querySelector('.albumLink');
                const artworkImg = element.querySelector('.fcol[fcol-type="artwork"] img');
                
                songData = {
                  id: itemId,
                  type: itemType,
                  attributes: {
                    name: titleEl?.textContent?.trim() || 'Unknown Song',
                    artistName: artistEl?.textContent?.trim() || 'Unknown Artist',
                    albumName: albumEl?.textContent?.trim() || '',
                    artwork: artworkImg ? { url: (artworkImg as HTMLImageElement).src } : undefined,
                  },
                };
                
                console.log("Extracted song data from library browser:", songData);
              } else {
              // Get the title and artist from the DOM
              // In album view, the artist might be in the album header, not in each track
              const titleElement = element.querySelector('.title-section .title-text') ||
                                 element.querySelector('.title-section') ||
                                 element.querySelector('.content-title .title-text') ||  // Search/Artist view
                                 element.querySelector('.track-title') ||
                                 element.querySelector('.song-title');
              
              // Try to find artist in the track row first
              let artistElement = element.querySelector('.artist-section .title-text') ||
                                element.querySelector('.artist-section') ||
                                element.querySelector('.content-artist') ||      // Search view
                                element.querySelector('.track-artist') ||
                                element.querySelector('.song-artist');
              
              // If no artist in track row, look for it in the album header
              if (!artistElement || !artistElement.textContent?.trim()) {
                const albumView = element.closest('.album-view');
                if (albumView) {
                  artistElement = albumView.querySelector('.album-details .artist-chips .chip-name') ||
                                albumView.querySelector('.album-details .artist') ||
                                albumView.querySelector('.album-header .artist-chips .chip-name') ||
                                albumView.querySelector('.album-header .artist') ||
                                albumView.querySelector('.album-artist');
                }
              }
              
              // For search results, look for artist in description
              if (!artistElement || !artistElement.textContent?.trim()) {
                const description = element.closest('.description');
                if (description) {
                  const artistLinks = description.querySelectorAll('.artistLink.subtitle');
                  // Usually the last artistLink is the artist name
                  if (artistLinks.length > 0) {
                    artistElement = artistLinks[artistLinks.length - 1];
                  }
                }
              }
              
              // For artist page songs, look for artist in page header
              if (!artistElement || !artistElement.textContent?.trim()) {
                const artistPage = document.querySelector('.artist-view') || document.querySelector('[data-page-type="artist"]');
                if (artistPage) {
                  artistElement = artistPage.querySelector('.artist-header .artist-name') ||
                                artistPage.querySelector('.artist-details .name') ||
                                artistPage.querySelector('.page-title') ||
                                artistPage.querySelector('h1');
                }
              }
              
              // Get album name from the track row or album view
              let albumElement = element.querySelector('.album-section .title-text') ||
                                element.querySelector('.album-section') ||
                                element.querySelector('.content-album');      // Artist page
              
              // If no album in track row, look for it in the album header
              if (!albumElement || !albumElement.textContent?.trim()) {
                const albumView = element.closest('.album-view');
                if (albumView) {
                  albumElement = albumView.querySelector('.album-details .album-title') ||
                                albumView.querySelector('.album-header .album-title') ||
                                albumView.querySelector('.album-name');
                }
              }
              
              // For search results, look in description
              if (!albumElement || !albumElement.textContent?.trim()) {
                const description = element.closest('.description');
                if (description) {
                  // The first subtitle is usually the album name
                  const subtitles = description.querySelectorAll('.subtitle');
                  if (subtitles.length > 0) {
                    albumElement = subtitles[0];
                  }
                }
              }
              
              // For artist page songs, look in content-album
              if (!albumElement || !albumElement.textContent?.trim()) {
                const contentAlbum = element.querySelector('.content-album');
                if (contentAlbum) {
                  albumElement = contentAlbum;
                }
              }
              
              // Try to get artwork
              let artworkUrl = '';
              
              // Check if we're in a playlist/library view with track artwork
              const trackArtworkImg = element.querySelector('.track-artwork--image img');
              if (trackArtworkImg) {
                const imgSrc = (trackArtworkImg as HTMLImageElement).src || '';
                if (!imgSrc.includes('data:image/svg')) {
                  artworkUrl = imgSrc;
                }
              }
              
              // For album view, prioritize getting from album header
              if (!artworkUrl) {
                const albumView = element.closest('.album-view');
                if (albumView) {
                  // Try picture source first (has higher quality URLs)
                  const pictureSource = albumView.querySelector('.album-artwork picture source') ||
                                      albumView.querySelector('.album-header picture source') ||
                                      albumView.querySelector('.album-details picture source');
                  if (pictureSource) {
                    const srcset = (pictureSource as HTMLSourceElement).srcset;
                    if (srcset && !srcset.includes('data:image/svg')) {
                      // Extract first URL from srcset
                      artworkUrl = srcset.split(' ')[0].split(',')[0];
                    }
                  }
                  
                  // Fallback to img if no source found
                  if (!artworkUrl) {
                    const albumArtwork = albumView.querySelector('.album-artwork img') ||
                                       albumView.querySelector('.album-header .artwork img') ||
                                       albumView.querySelector('.album-details .artwork img');
                    if (albumArtwork) {
                      const imgSrc = (albumArtwork as HTMLImageElement).src || '';
                      if (!imgSrc.includes('data:image/svg')) {
                        artworkUrl = imgSrc;
                      }
                    }
                  }
                }
              }
              
              // Final fallback to any artwork
              if (!artworkUrl) {
                const artworkImg = element.querySelector('.artwork img') ||
                                 element.querySelector('.track-artwork img');
                if (artworkImg) {
                  const imgSrc = (artworkImg as HTMLImageElement).src || '';
                  if (!imgSrc.includes('data:image/svg')) {
                    artworkUrl = imgSrc;
                  }
                }
              }
              
              songData = {
                id: itemId,
                type: itemType,
                attributes: {
                  name: titleElement?.textContent?.trim() || 'Unknown Song',
                  artistName: artistElement?.textContent?.trim() || 'Unknown Artist',
                  albumName: albumElement?.textContent?.trim().split('·')[0].trim() || '',
                  artwork: artworkUrl ? { url: artworkUrl } : undefined,
                },
              };
              
              console.log("Extracted song data from DOM:", songData);
              }
            } else {
              // For search/artist view items without data-item-id, try to construct from available data
              const titleEl = element.querySelector('.content-title .title-text');
              const artistEl = element.querySelector('.content-artist');
              const albumEl = element.querySelector('.content-album');
              
              // Try to find an ID - search results might have it in different places
              const possibleId = element.getAttribute('data-song-id') || 
                               element.getAttribute('data-track-id') ||
                               element.id;
              
              // Try to get artwork for search/artist view
              let artworkUrl = '';
              const artworkImg = element.querySelector('.artwork img');
              if (artworkImg) {
                artworkUrl = (artworkImg as HTMLImageElement).src || '';
              }
              
              if (titleEl && possibleId) {
                songData = {
                  id: possibleId,
                  type: 'songs',
                  attributes: {
                    name: titleEl.textContent?.trim() || 'Unknown Song',
                    artistName: artistEl?.textContent?.trim() || 'Unknown Artist',
                    albumName: albumEl?.textContent?.trim().split('·')[0].trim() || '',
                    artwork: artworkUrl ? { url: artworkUrl } : undefined,
                  },
                };
                console.log("Extracted song data from search/artist view:", songData);
              }
            }
            
            // For album view tracks, try to find track data in parent album container
            if (!songData && element.closest('.album-view')) {
              console.log("Detected album view, trying to extract track data...");
              
              // Try to get track index from the element
              const trackIndex = element.dataset.trackIndex || 
                               element.dataset.index ||
                               Array.from(element.parentElement?.children || []).indexOf(element);
              
              // Try to find the album container with track data
              const albumContainer = element.closest('.album-view');
              if (albumContainer) {
                // Look for track data in Vue component or data attributes
                const albumData = (albumContainer as any).__vue__ || 
                                (albumContainer as any).__vueParentComponent?.data ||
                                (albumContainer as any)._data;
                
                if (albumData?.tracks?.[trackIndex]) {
                  songData = albumData.tracks[trackIndex];
                  console.log("Extracted song from album tracks:", songData);
                }
              }
            }
            
            // Also try other data sources
            if (!songData) {
              songData = (element as any).__data__ || 
                        (element as any)._data ||
                        (element as any).__vue__ ||
                        (element as any).__vueParentComponent?.data;
            }
            
            // Try to get from dataset
            if (!songData && element.dataset.mediaItem) {
              try {
                songData = JSON.parse(element.dataset.mediaItem);
              } catch (e) {
                console.log("Could not parse dataset.mediaItem");
              }
            }
          }
        }
        
        // Option 2: If item is the actual song data (not a proxy with label/onClick)
        if (!songData && item && typeof item === 'object' && !('label' in item && 'onClick' in item)) {
          songData = item;
          console.log("Using item directly as song data");
        }
        
        // Option 3: Try to get from app state
        if (!songData) {
          const app = (window as any).app;
          if (app?.chrome?.store?.state?.mediaItem) {
            songData = app.chrome.store.state.mediaItem;
            console.log("Got song from app state:", songData);
          }
        }
        
        // Option 4: Try MusicKit's nowPlayingItem
        if (!songData && musicKit?.nowPlayingItem) {
          songData = musicKit.nowPlayingItem;
          console.log("Got song from nowPlayingItem:", songData);
        }
        
        // Option 5: Try to get from Cider's internal queue/playlist state
        if (!songData) {
          const cider = (window as any).Cider;
          if (cider?.playback?.currentTrack) {
            songData = cider.playback.currentTrack;
            console.log("Got song from Cider playback:", songData);
          }
        }
        
        if (songData) {
          console.log("Final song data:", songData);
          openPlaylistManager(songData);
        } else {
          console.error("Could not find song data from context menu");
          console.log("Available globals:", {
            hasMusicKit: !!(window as any).MusicKit,
            hasApp: !!(window as any).app,
            hasCider: !!(window as any).Cider,
            musicKitKeys: (window as any).MusicKit ? Object.keys((window as any).MusicKit.getInstance() || {}) : [],
          });
          DialogAPI.createAlert(
            "Unable to identify the song. This feature only works when right-clicking on a song in your library or playlist. " +
            "You can also use window.openPlaylistManager('songId', 'title', 'artist') in the console."
          );
        }
      },
    });

    /**
     * Function to open the settings modal
     */
    function openSettingsModal() {
      console.log("Opening Playlist Manager Settings");

      const { openDialog, closeDialog, dialogElement } = createModal({
        escClose: true,
      });

      const content = document.createElement(
        customElementName("settings-modal")
      ) as any;

      content._props = {
        standalone: true,
        onClose: () => {
          console.log("Settings modal closing...");
          if (content.parentNode) {
            content.parentNode.removeChild(content);
          }
          closeDialog();
        },
      };

      dialogElement.appendChild(content);
      openDialog();
    }

    // Expose for testing
    (window as any).openPlaylistManager = openPlaylistManagerModal;
    (window as any).openPlaylistSettings = openSettingsModal;
    
    console.log("Playlist Manager Plugin loaded successfully!");
    console.log("Test with: window.openPlaylistManager('1440881859', 'More Than You Know', 'Axwell Λ Ingrosso', 'More Than You Know')");
    console.log("Open settings with: window.openPlaylistSettings()");
    
    // Try to add inline buttons to tracks (experimental)
    // This will attempt to inject a button next to the "..." menu on each track
    function addInlineButtons() {
      // Find all track items that don't already have our button
      // Only add to PlaylistTrack and AlbumTrack views
      const tracks = document.querySelectorAll('.ri-list-item:not([data-playlist-btn])');
      
      tracks.forEach((track) => {
        const element = track as HTMLElement;
        
        // Different views have different structures
        let menuSection = null;
        
        // For playlist/album views (.ri-list-item)
        menuSection = element.querySelector('.menu-section');
        
        // For album view, look for the container with the menu button
        if (!menuSection) {
          const menuBtn = element.querySelector('.menu-btn');
          if (menuBtn?.parentElement) {
            menuSection = menuBtn.parentElement;
          }
        }
        
        if (menuSection) {
          // Mark this track as processed
          element.dataset.playlistBtn = 'true';
          
          // Create our button
          const btn = document.createElement('button');
          btn.className = 'menu-btn passive-button playlist-mgr-btn';
          btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15V6"></path>
              <path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"></path>
              <path d="M12 12H3"></path>
              <path d="M16 6H3"></path>
              <path d="M12 18H3"></path>
            </svg>
          `;
          btn.title = 'Add to Playlist';
          
          btn.onclick = (e) => {
            e.stopPropagation();
            
            // Extract song data from the track element
            let songId = element.dataset.itemId;
            
            // Library browser has data-item-id set, so it should work
            // No special handling needed for library-song-item
            
            // In album view, try to get the ID from other attributes or Vue data
            if (!songId) {
              console.log('No data-item-id found, checking alternative sources...');
              
              // Try to get from Vue component data
              const vueData = (element as any).__vueParentComponent?.ctx || 
                             (element as any).__vue__ ||
                             (element as any)._vnode?.component?.ctx;
              
              if (vueData?.item) {
                songId = vueData.item.id || 
                        vueData.item.attributes?.playParams?.catalogId ||
                        vueData.item.attributes?.playParams?.id;
                console.log('Found ID from Vue data:', songId);
              }
              
              // Try to get from track number in album view
              if (!songId) {
                const albumView = element.closest('.album-view');
                if (albumView) {
                  // Get track index
                  const trackElements = albumView.querySelectorAll('.ri-list-item');
                  const trackIndex = Array.from(trackElements).indexOf(element);
                  
                  // Try to get album data
                  const albumData = (albumView as any).__vueParentComponent?.ctx ||
                                   (albumView as any).__vue__ ||
                                   (albumView as any)._vnode?.component?.ctx;
                  
                  if (albumData?.album?.relationships?.tracks?.data?.[trackIndex]) {
                    const track = albumData.album.relationships.tracks.data[trackIndex];
                    songId = track.id || 
                            track.attributes?.playParams?.catalogId ||
                            track.attributes?.playParams?.id;
                    console.log('Found ID from album tracks data:', songId);
                  }
                }
              }
            }
            
            console.log('Final extracted songId:', songId);
            
            if (!songId) {
              console.error('Could not extract song ID from track element');
              console.log('Element:', element);
              console.log('Element dataset:', element.dataset);
              console.log('Element Vue data:', (element as any).__vueParentComponent?.ctx);
              DialogAPI.createAlert('Unable to identify song. Please use the context menu instead.');
              return;
            }
            
            // Get title from the FIRST title-text element (not the album duplicate)
            const titleSection = element.querySelector('.title-section');
            const titleEl = titleSection?.querySelector('.title-text');
            const titleText = titleEl?.textContent?.trim() || 'Unknown Song';
            
            // Get artist - in album view, artist is in the album header, not in each track
            let artistText = 'Unknown Artist';
            const artistSection = element.querySelector('.artist-section');
            const artistEl = artistSection?.querySelector('.title-text');
            
            if (artistEl?.textContent?.trim()) {
              artistText = artistEl.textContent.trim();
            } else {
              // In album view, look for artist in the album header
              const albumView = element.closest('.album-view');
              if (albumView) {
                const artistChip = albumView.querySelector('.artist-chips .chip-name');
                if (artistChip?.textContent?.trim()) {
                  artistText = artistChip.textContent.trim();
                }
              }
              
              // For search results, look in description
              if (!artistText || artistText === 'Unknown Artist') {
                const description = element.closest('.description');
                if (description) {
                  const artistLinks = description.querySelectorAll('.artistLink.subtitle');
                  if (artistLinks.length > 0) {
                    // Last artistLink is usually the artist name
                    artistText = artistLinks[artistLinks.length - 1].textContent?.trim() || 'Unknown Artist';
                  }
                }
              }
              
              // For artist page, get from page header
              if (!artistText || artistText === 'Unknown Artist') {
                const artistPage = document.querySelector('.artist-view') || document.querySelector('[data-page-type="artist"]');
                if (artistPage) {
                  const artistName = artistPage.querySelector('.artist-header .artist-name') ||
                                   artistPage.querySelector('.artist-details .name') ||
                                   artistPage.querySelector('.page-title') ||
                                   artistPage.querySelector('h1');
                  if (artistName?.textContent?.trim()) {
                    artistText = artistName.textContent.trim();
                  }
                }
              }
            }
            
            // Get album - in album view, album is in the header
            let albumText = '';
            const albumSection = element.querySelector('.album-section');
            const albumEl = albumSection?.querySelector('.title-text');
            
            if (albumEl?.textContent?.trim()) {
              albumText = albumEl.textContent.trim();
            } else {
              // In album view, look for album name in the header
              const albumView = element.closest('.album-view');
              if (albumView) {
                const albumTitle = albumView.querySelector('.album-details .title .title-text') ||
                                 albumView.querySelector('.album-header .album-title') ||
                                 albumView.querySelector('.album-details .title');
                if (albumTitle?.textContent?.trim()) {
                  albumText = albumTitle.textContent.trim();
                }
              }
              
              // For search results, look in description
              if (!albumText) {
                const description = element.closest('.description');
                if (description) {
                  const subtitles = description.querySelectorAll('.subtitle');
                  if (subtitles.length > 0) {
                    albumText = subtitles[0].textContent?.trim() || '';
                  }
                }
              }
              
              // For artist page songs, look in content-album
              if (!albumText) {
                const contentAlbum = element.querySelector('.content-album');
                if (contentAlbum?.textContent?.trim()) {
                  // Extract just the album name (remove year if present)
                  const fullText = contentAlbum.textContent.trim();
                  albumText = fullText.split('·')[0].trim();
                }
              }
            }
            
            // Try to get artwork
            let artworkUrl = '';
            
            // Check if we're in a playlist/library view with track artwork
            const trackArtworkImg = element.querySelector('.track-artwork--image img');
            if (trackArtworkImg) {
              const imgSrc = (trackArtworkImg as HTMLImageElement).src || '';
              if (!imgSrc.includes('data:image/svg')) {
                artworkUrl = imgSrc;
              }
            }
            
            // For album view, prioritize getting from album header
            if (!artworkUrl) {
              const albumView = element.closest('.album-view');
              if (albumView) {
                // Try picture source first (has higher quality URLs)
                const pictureSource = albumView.querySelector('.album-artwork picture source') ||
                                    albumView.querySelector('.album-header picture source') ||
                                    albumView.querySelector('.album-details picture source');
                if (pictureSource) {
                  const srcset = (pictureSource as HTMLSourceElement).srcset;
                  if (srcset && !srcset.includes('data:image/svg')) {
                    // Extract first URL from srcset
                    artworkUrl = srcset.split(' ')[0].split(',')[0];
                  }
                }
                
                // Fallback to img if no source found
                if (!artworkUrl) {
                  const albumArtwork = albumView.querySelector('.album-artwork img') ||
                                     albumView.querySelector('.album-header .artwork img') ||
                                     albumView.querySelector('.album-details .artwork img');
                  if (albumArtwork) {
                    const imgSrc = (albumArtwork as HTMLImageElement).src || '';
                    if (!imgSrc.includes('data:image/svg')) {
                      artworkUrl = imgSrc;
                    }
                  }
                }
              }
            }
            
            // Final fallback to any artwork
            if (!artworkUrl) {
              const artworkImg = element.querySelector('.artwork img') ||
                               element.querySelector('.track-artwork img');
              if (artworkImg) {
                const imgSrc = (artworkImg as HTMLImageElement).src || '';
                if (!imgSrc.includes('data:image/svg')) {
                  artworkUrl = imgSrc;
                }
              }
            }
            
            console.log('Inline button clicked - extracted:', { songId, titleText, artistText, albumText, artworkUrl });
            
            if (songId) {
              openPlaylistManagerModal(
                songId,
                titleText,
                artistText,
                albumText,
                artworkUrl
              );
            }
          };
          
          // Insert before the menu button
          menuSection.insertBefore(btn, menuSection.firstChild);
        }
      });
    }
    
    // Run on load and when DOM changes
    addInlineButtons();
    
    // Watch for new tracks being added to the DOM
    const observer = new MutationObserver(() => {
      addInlineButtons();
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    
    // Add CSS for inline buttons
    const style = document.createElement('style');
    style.textContent = `
      /* Position the track relatively so we can position button absolutely */
      .ri-list-item {
        position: relative;
      }
      
      .playlist-mgr-btn {
        opacity: 0;
        transition: opacity 0.2s;
        position: absolute;
        padding: 4px !important;
        width: 32px;
        height: 32px;
        min-width: 32px;
        min-height: 32px;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 4px;
        pointer-events: none;
        top: 50%;
        transform: translateY(-50%);
      }
      
      /* For playlist view - time-section is before menu-section */
      [sfc-name="PlaylistTrack"] .playlist-mgr-btn {
        right: 52px;
      }
      
      /* For album view - time is a direct child before the menu wrapper */
      [sfc-name="AlbumTrack"] .playlist-mgr-btn {
        right: 52px;
      }
      
      /* Show button when hovering the track */
      .ri-list-item:hover .playlist-mgr-btn {
        opacity: 1;
        pointer-events: auto;
      }
      
      .playlist-mgr-btn:hover {
        background: rgba(255, 255, 255, 0.15);
      }
      
      /* Ensure the ... button stays visible on hover */
      .ri-list-item:hover .menu-section .menu-btn:not(.playlist-mgr-btn),
      .ri-list-item:hover > div > .menu-btn:not(.playlist-mgr-btn) {
        opacity: 1;
      }
      
      /* Hide time when hovering over the track (so button is visible) */
      .ri-list-item:hover .time,
      .ri-list-item:hover .time-section {
        opacity: 0 !important;
      }
      
      /* Keep time visible by default when just hovering the row */
      .ri-list-item .time,
      .ri-list-item .time-section {
        transition: opacity 0.2s;
        text-align: center;
      }
      
      /* Hide button in very small viewports to prevent overlap */
      @media (max-width: 768px) {
        .playlist-mgr-btn {
          display: none !important;
        }
      }
      
      /* Adjust positioning for medium viewports */
      @media (min-width: 769px) and (max-width: 1024px) {
        .playlist-mgr-btn {
          width: 28px;
          height: 28px;
          min-width: 28px;
          min-height: 28px;
        }
        .playlist-mgr-btn svg {
          width: 14px;
          height: 14px;
        }
      }
    `;
    document.head.appendChild(style);
  },
});

/**
 * Exporting the plugin, Cider will use this to load the plugin
 */
export default plugin;
