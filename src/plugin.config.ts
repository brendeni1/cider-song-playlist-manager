/**
 * Plugin configuration.
 */
export default {
    /**
     * Custom element prefix, must be unique
     */
    ce_prefix: 'song-playlist-manager',
    identifier: 'brendeni1.song-playlist-manager',
    name: 'Song Playlist Manager',
    description: 'Manage songs in playlists with a convenient modal interface w/ checklists.',
    version: '1.3.0',
    author: 'brenden.i1',
    repo: 'https://github.com/brendeni1/cider-song-playlist-manager',
    entry: {
        'plugin.js': {
            type: 'main',
        }
    },
    /**
     * Settings element will be set at runtime in main.ts
     * This tells Cider to use our custom settings component
     */
}
