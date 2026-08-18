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

// Bumping this name is what evicts a poisoned cache — v8 existed specifically
// to throw away the 132-byte LFS pointer files that were briefly live and got
// stored as if they were songs, which cache-first would otherwise have served
// forever on any device that saw them. v9 adds the soundboard stingers to the
// precache list.
const CACHE = 'walkup-simple-v9-soundboard';

// Core shell — install fails if any of these can't be fetched (they're
// essential and always present).
const CRITICAL = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'roster.json',
  'audio/simple/library.json',
  'suno-playlist.json',
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
  'suno-logo.png',
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
  // Soundboard stingers (see SOUNDBOARD in app.js)
  'audio/sfx/charge-organ.mp3',
  'audio/sfx/charge-organ-2.mp3',
  'audio/sfx/home-run-horn.mp3',
  'audio/sfx/play-ball.mp3',
  'audio/sfx/play-game.mp3',
];

// Between-innings Suno tracks are read out of suno-playlist.json rather than
// listed here, so songs added to the Suno playlist (and mirrored by
// scripts/sync_suno_playlist.py) become offline-ready with no edit to this
// file. Best-effort: a missing or malformed manifest just means no extras.
async function sunoAudioFiles() {
  try {
    const resp = await fetch('suno-playlist.json', { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.tracks || [])
      .flatMap((t) => [t.file, t.art])
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Install: precache the shell (critical, must succeed) then everything else
// best-effort. skipWaiting so a fresh SW takes over without a manual reload.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CRITICAL);
    const extras = [...OPTIONAL, ...AUDIO, ...(await sunoAudioFiles())];
    // Deliberately not cache.add(): that stores whatever comes back, including
    // a truncated body, and cache-first would then serve it forever.
    await Promise.allSettled(extras.map(async (u) => {
      const res = await fetch(u);
      if (res && res.ok && safeToCache(u, res)) await cache.put(u, res);
    }));
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

// Nothing we serve as audio is anywhere near this small. A response under it
// is a truncated or error body (an LFS pointer file is 132 bytes), and caching
// one is worse than not caching at all: cache-first means a broken clip would
// be served for good, long after the server was fixed.
const MIN_AUDIO_BYTES = 10000;

// Only audio gets the size floor — the shell legitimately includes small files
// (manifest.json is ~500 bytes, icon.svg ~1 KB).
function safeToCache(url, res) {
  if (!String(url).includes('/audio/')) return true;
  const len = parseInt(res.headers.get('content-length') || '', 10);
  return !Number.isFinite(len) || len >= MIN_AUDIO_BYTES;
}

// Cache-first: serve the cached copy if we have it; otherwise fetch, cache,
// and return. Used for immutable audio.
//
// iOS Safari asks for media with a Range header and will not play a media
// element that gets a plain 200 back for a ranged request. The Cache API also
// refuses to store a 206. So: always key the cache off the un-ranged URL, keep
// exactly one whole copy, and slice 206s out of it here.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const range = request.headers.get('range');
  const full = range ? new Request(request.url, { credentials: 'omit' }) : request;

  let hit = await cache.match(full);
  if (!hit) {
    try {
      const res = await fetch(full);
      if (res && res.ok && safeToCache(full.url, res)) cache.put(full, res.clone());
      hit = res;
    } catch (_) {
      hit = await cache.match(full);
    }
  }
  if (!hit) return Response.error();
  return range ? sliceRange(hit, range) : hit;
}

// Build a 206 out of a full cached response. Handles `bytes=N-`, `bytes=N-M`
// and the suffix form `bytes=-N`.
async function sliceRange(response, rangeHeader) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m || (m[1] === '' && m[2] === '')) return response;

  const buf = await response.arrayBuffer();
  const total = buf.byteLength;

  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, total - parseInt(m[2], 10));
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    });
  }

  const body = buf.slice(start, end + 1);
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
  headers.set('Content-Length', String(body.byteLength));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(body, { status: 206, statusText: 'Partial Content', headers });
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
