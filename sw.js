// Walk-Up Music Service Worker — offline-capable build
//
// Strategy:
//   • Code + data (HTML / JS / CSS / JSON): NETWORK-FIRST. When online you
//     always get the freshest build (this is what the old clearServiceWorkers
//     hack was protecting against); when offline you fall back to the last
//     cached copy.
//   • Audio (announcements, library clips, team intro): CACHE-FIRST. These are
//     immutable, slug-named files — once cached they never need re-fetching,
//     so the whole game can run with no network at all.
//
// All of audio/simple is precached on install so the app is fully playable
// offline immediately after the first online visit (no need to tap each
// player once). Deezer preview clips are stored separately in IndexedDB by
// app.js and already work offline.

const CACHE = 'walkup-simple-v5-offline';

// Core shell — install fails if any of these can't be fetched (they're
// essential and always present).
const CRITICAL = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'roster.json',
  'audio/simple/library.json',
];

// Nice-to-have shell assets — best-effort so a single 404 can't break install.
const OPTIONAL = [
  'manifest.json',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-bloordale-b.png',
  'og-image.png',
];

// Every announcement + every library track + the team intro. Precaching these
// is what makes the app work end-to-end with no connection.
const AUDIO = [
  // Announcements (per player)
  'audio/simple/announcements/adrian.wav',
  'audio/simple/announcements/alexander.wav',
  'audio/simple/announcements/axel.wav',
  'audio/simple/announcements/connor.wav',
  'audio/simple/announcements/devin.wav',
  'audio/simple/announcements/emmett.wav',
  'audio/simple/announcements/everett.wav',
  'audio/simple/announcements/gregory.wav',
  'audio/simple/announcements/james.wav',
  'audio/simple/announcements/lincoln.wav',
  'audio/simple/announcements/ozzy.wav',
  'audio/simple/announcements/ryder.wav',
  'audio/simple/announcements/william.wav',
  // Library walk-up clips
  'audio/simple/library/all-i-do-is-win.mp3',
  'audio/simple/library/dtmf.mp3',
  'audio/simple/library/enter-sandman.mp3',
  'audio/simple/library/fair-trade.mp3',
  'audio/simple/library/fireball.mp3',
  'audio/simple/library/give-it-away.mp3',
  'audio/simple/library/home-run.mp3',
  'audio/simple/library/lion-sleeps-tonight.mp3',
  'audio/simple/library/lose-yourself.mp3',
  'audio/simple/library/national-treasures.mp3',
  'audio/simple/library/run-it.mp3',
  'audio/simple/library/seven-nation-army.mp3',
  'audio/simple/library/thick-of-it.mp3',
  'audio/simple/library/trend-setter.mp3',
  'audio/simple/library/tsunami.mp3',
  'audio/simple/library/we-on-go.mp3',
  // Pre-game team intro
  'audio/simple/team-intro.wav',
];

// Install: precache the shell (critical, must succeed) then everything else
// best-effort. skipWaiting so a fresh SW takes over without a manual reload.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CRITICAL);
    await Promise.allSettled([...OPTIONAL, ...AUDIO].map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

// Activate: drop any older cache versions, then take control of open clients.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isAudio(url) {
  return url.pathname.includes('/audio/');
}

// Cache-first: serve the cached copy if we have it; otherwise fetch, cache,
// and return. Used for immutable audio.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(request)) || Response.error();
  }
}

// Network-first: try the network (and refresh the cache) so online users get
// the latest build; fall back to cache when offline. The ignoreSearch fallback
// lets a precached bare `app.js` satisfy a request for `app.js?v=34`.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  } catch (_) {
    const hit =
      (await cache.match(request)) ||
      (await cache.match(request, { ignoreSearch: true }));
    if (hit) return hit;
    if (request.mode === 'navigate') {
      return (await cache.match('index.html')) || (await cache.match('./'));
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Skip non-http(s) schemes (blob: object URLs for Deezer clips, data:, etc.)
  if (!url.protocol.startsWith('http')) return;
  // Only manage our own origin. Deezer's API/CDN, OG scrapers, etc. pass
  // straight through to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(isAudio(url) ? cacheFirst(request) : networkFirst(request));
});
