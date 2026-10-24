/* Wiom Movie Pilot — runtime config. Edit per environment; no secrets belong here.
 * Overrides for testing: ?api=<API_BASE>&media=<MEDIA_BASE>&drm=<clearkey|widevine|auto>
 *   API_BASE   ''  = same origin (mock server); or e.g. 'http://localhost:8787' (wrangler dev) / Worker URL
 *   MEDIA_BASE base of manifest.mpd / master.m3u8 / film.json / poster.jpg / thumbs/ (trailing slash)
 *   FILM_ID    film id sent to /api/playback/start
 *   DRM_MODE   'auto' = use what /api/playback/start returns; 'clearkey' | 'widevine' to force
 */
window.WIOM_CONFIG = {
  API_BASE: 'https://wiom-movie-pilot-api.shivank-sood.workers.dev',
  MEDIA_BASE: 'https://pub-0d5a4e22335f4c3e8574d3a026a91933.r2.dev/films/sstb-notld/v1/',
  FILM_ID: 'sstb-notld',
  DRM_MODE: 'auto',
  OFFER_ID: 'net14_movie',
};
(function () {
  try {
    var q = new URLSearchParams(location.search), c = window.WIOM_CONFIG;
    if (q.get('api') !== null) c.API_BASE = q.get('api');
    if (q.get('media')) c.MEDIA_BASE = q.get('media');
    if (q.get('drm')) c.DRM_MODE = q.get('drm');
    c.API_BASE = c.API_BASE.replace(/\/+$/, '');
    if (!/\/$/.test(c.MEDIA_BASE)) c.MEDIA_BASE += '/';
  } catch (e) { /* keep defaults */ }
})();
