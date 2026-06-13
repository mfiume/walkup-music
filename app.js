/* Walk-Up Music — Simple Build
 *
 * Strips back to just the prerecorded announcement + walk-up music workflow.
 * - Roster tab: tap a player to preview their announcement + song.
 * - Lineup tab: build the batting order, tap a batter to play, prev/next to advance.
 * - Announcement and walk-up are overlapped: the song fades up under the tail
 *   of the announcement, then plays for ~30s with a graceful fade out.
 */

(function () {
  'use strict';

  // === Config ===
  const WALKUP_DURATION_S = 30;     // play-through cap for any clip
  // Deezer previews are 30s; umpires care about ten-second walk-ups so we
  // hard-cap any Deezer-sourced clip to this many seconds.
  const DEEZER_CLIP_DURATION_S = 10;
  const FADE_IN_S = 0.3;            // soft fade-in when music starts (never cuts)
  const FADE_OUT_S = 1.5;           // soft fade-out at the end of any clip
  const OVERLAP_S = 1.2;            // start music this many seconds before announcement ends
  const MUSIC_DUCKED_VOL = 0.35;    // library-clip volume while announcement still playing
  // Deezer previews are commercially mastered (much hotter RMS than our
  // hand-trimmed library clips), so the same ducking multiplier sounds far
  // louder under the announcement. The announcement is already at max
  // volume, so the only lever is the music: duck Deezer tracks way down
  // under the talk track, and hold their full level a bit below 1.0 too.
  // (HTMLMediaElement volume is linear amplitude — 0.07 ≈ -23 dB.)
  const DEEZER_DUCKED_VOL = 0.07;
  const DEEZER_FULL_VOL = 0.8;
  const MUSIC_FULL_VOL = 1.0;
  const MUSIC_RAMP_S = 0.9;         // ramp from ducked → full once announcement ends

  // === State ===
  let roster = [];
  let lineup = [];                 // array of player numbers
  let currentBatterIdx = -1;       // index into lineup; -1 = roster preview / none
  let currentPlayer = null;
  let playbackPhase = null;        // 'announcement' | 'walkup' | null
  let isPaused = false;
  let progressInterval = null;
  let walkupFadeTimeout = null;
  let announcementOverlapTimer = null;
  let wakeLock = null;
  // 'sequential' (announcement first, music ducks in at the tail) or
  // 'overlap' (music plays under announcement from t=0 then ramps up).
  // Overlap is the default — feels more like a real stadium walk-up.
  let playbackMode = localStorage.getItem('walkup-simple-mode') || 'overlap';

  // Per-player song override:  { [playerNumber]: walkupFilePath }
  // Empty / missing entry = the default in roster.json. Saved in localStorage
  // so a coach's picks survive reloads and PWA restarts.
  let playerSongOverrides = (() => {
    try { return JSON.parse(localStorage.getItem('walkup-simple-songs') || '{}') || {}; }
    catch (_) { return {}; }
  })();

  // Per-player Deezer assignment:
  //   { [playerNumber]: { trackId, title, artist, artUrl, previewUrl } }
  // The track's MP3 preview is cached as a Blob in IndexedDB keyed by trackId,
  // so once a player has been assigned a Deezer song the app can play it
  // offline. Deezer wins over playerSongOverrides — if a player has a Deezer
  // track assigned, their walk-up comes from Deezer, not the library.
  let playerDeezerSongs = (() => {
    try { return JSON.parse(localStorage.getItem('walkup-simple-deezer') || '{}') || {}; }
    catch (_) { return {}; }
  })();

  // Object URLs created at runtime so we can revoke them on reassign. Map of
  // playerNumber → blob URL.
  const playerDeezerBlobUrls = {};

  // Single audio element used for previewing alternates in the Settings tab,
  // separate from the walk-up / announcement / team-intro elements.
  const previewAudio = new Audio();
  previewAudio.preload = 'auto';

  // Reorder state
  let dragIdx = -1;

  // === DOM refs ===
  const tabs = document.querySelectorAll('.tab');
  const views = document.querySelectorAll('.view');
  const lineupList = document.getElementById('lineup-list');
  const availableList = document.getElementById('available-list');
  const clearLineupBtn = document.getElementById('clear-lineup-btn');
  const rosterView = document.getElementById('roster-view');

  const playbackBar = document.getElementById('playback-bar');
  const playbackNumber = document.getElementById('playback-number');
  const playbackName = document.getElementById('playback-name');
  const playbackSongName = document.getElementById('playback-song-name');
  const playbackStatus = document.getElementById('playback-status');
  const prevBtn = document.getElementById('prev-btn');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const nextBtn = document.getElementById('next-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const progressFill = document.getElementById('progress-fill');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');

  const announcementAudio = document.getElementById('announcement-audio');
  const walkupAudio = document.getElementById('walkup-audio');

  // Now Playing (fullscreen overlay) refs
  const nowPlaying = document.getElementById('now-playing');
  const expandBtn = document.getElementById('expand-btn');
  const collapseBtn = document.getElementById('collapse-btn');
  const npCurrentLabel = document.getElementById('np-current-label');
  const npNumber = document.getElementById('np-number');
  const npName = document.getElementById('np-name');
  const npSongName = document.getElementById('np-song-name');
  const npUpNext = document.getElementById('np-up-next');
  const npProgressFill = document.getElementById('np-progress-fill');
  const npTimeCurrent = document.getElementById('np-time-current');
  const npTimeTotal = document.getElementById('np-time-total');
  const npPrevBtn = document.getElementById('np-prev-btn');
  const npPlayPauseBtn = document.getElementById('np-play-pause-btn');
  const npNextBtn = document.getElementById('np-next-btn');
  const npPlayIcon = document.getElementById('np-play-icon');
  const npPauseIcon = document.getElementById('np-pause-icon');

  // Pre-game team intro
  const teamIntroBtn = document.getElementById('team-intro-btn');
  const teamIntroAudio = document.getElementById('team-intro-audio');
  const pregamePlayIcon = document.getElementById('pregame-play-icon');
  const pregamePauseIcon = document.getElementById('pregame-pause-icon');

  // === Init ===
  // Register the service worker that makes the app work offline. It uses a
  // network-first strategy for code/data (so online users always get the
  // latest build — no stale-build trap) and cache-first for the precached
  // audio, so a whole game can run with no connection.
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
  }

  // Show a slim banner under the header when the device drops offline, so the
  // user knows the network is gone but the app is still fully usable from its
  // saved audio. Toggling body.is-offline also lets the CSS soften features
  // that genuinely need a connection (the Deezer search launcher).
  function bindOfflineIndicator() {
    const bar = document.getElementById('offline-bar');
    const sync = () => {
      const offline = !navigator.onLine;
      if (bar) bar.classList.toggle('hidden', !offline);
      document.body.classList.toggle('is-offline', offline);
    };
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    sync();
  }

  async function init() {
    // Fire-and-forget: registration is fast and the SW precaches in the
    // background, so it never blocks first paint or the initial data fetch.
    registerServiceWorker();
    bindOfflineIndicator();

    // Roster (who) and library (what) are loaded in parallel. Roster lists
    // each player with their default walkup file path; library.json is the
    // single source of truth for song titles + the menu of choices any
    // player can pick from in Settings.
    const [rosterResp, libraryResp] = await Promise.all([
      fetch('roster.json'),
      fetch('audio/simple/library.json'),
    ]);
    roster = await rosterResp.json();
    roster.sort((a, b) => a.number - b.number);
    songLibrary = await libraryResp.json();

    // Snapshot each player's default walkup file + title, then hydrate
    // any cached Deezer blobs out of IndexedDB before applying overrides
    // so the rest of the app just reads player.walkup / player.song
    // without caring which source (library / Deezer / default) is selected.
    snapshotSongDefaults();
    try { await hydrateDeezerBlobs(); } catch (_) { /* ignore */ }
    applySongOverrides();

    const saved = localStorage.getItem('walkup-simple-lineup');
    if (saved) {
      try {
        const arr = JSON.parse(saved);
        const nums = new Set(roster.map(p => p.number));
        lineup = arr.filter(n => nums.has(n));
      } catch (_) { lineup = []; }
    }

    // Ask the browser to keep our storage durable. On a PWA / home-screen
    // install this is automatic, but in a regular browser tab some engines
    // (notably Safari ITP) can evict localStorage + IndexedDB under storage
    // pressure or after periods of inactivity. Requesting persistence makes
    // selections actually survive. Fire-and-forget — best-effort.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    bindTabs();
    bindTransport();
    bindNowPlaying();
    bindAudioEvents();
    bindSettings();
    bindTeamIntro();
    bindMediaSession();
    bindDeezerModal();

    // Restore the lineup cursor so a hard refresh returns to whoever was Up
    // Next / batting, not the leadoff hitter. Falls back to 0 if the saved
    // index points past the (possibly edited) lineup.
    let restoredIdx = 0;
    const savedIdx = localStorage.getItem('walkup-simple-cursor');
    if (savedIdx != null) {
      const n = parseInt(savedIdx, 10);
      if (Number.isFinite(n) && n >= 0 && n < lineup.length) restoredIdx = n;
    }
    if (lineup.length > 0) {
      currentBatterIdx = restoredIdx;
      showBarFromLineup();
    }

    renderRoster();
    renderLineup();
    renderAvailable();
    updatePlaybackBar();

    // Keep the Bluetooth speaker awake even before the first batter is sent up.
    // The very first tone won't make sound until the user taps something
    // (browsers gate AudioContext on a user gesture), but the schedule is
    // running and will start ticking as soon as the context is unlocked.
    startKeepalive();

    // The playback bar is absolutely-positioned over the bottom of <main>
    // (so content scrolls visually beneath it). Sync main's bottom padding
    // to the bar's actual height so the last list item can always be
    // scrolled fully into view above the bar.
    syncBarHeight();
    window.addEventListener('resize', syncBarHeight);
    if (window.ResizeObserver) {
      new ResizeObserver(syncBarHeight).observe(playbackBar);
    }
  }

  function syncBarHeight() {
    if (!playbackBar) return;
    const h = playbackBar.getBoundingClientRect().height;
    if (h > 0) {
      document.body.style.setProperty('--bar-h', `${Math.ceil(h)}px`);
    }
  }

  function saveLineup() {
    localStorage.setItem('walkup-simple-lineup', JSON.stringify(lineup));
    saveCursor();
  }

  // Persist the lineup cursor (currentBatterIdx) so that a hard refresh comes
  // back to whoever was Up Next / batting. Stored as a plain string so it
  // works in any storage backend. Called from showBarFromLineup + playPlayer
  // which together cover every cursor mutation site.
  function saveCursor() {
    try {
      localStorage.setItem('walkup-simple-cursor', String(currentBatterIdx));
    } catch (_) { /* storage full / disabled — ignore */ }
  }

  // === Tabs ===
  function applyTabState() {
    // Belt-and-suspenders: set display directly so a stale stylesheet can't
    // leave inactive views visible. For the *active* view we leave display
    // to the stylesheet so it can use flex/grid (the roster view's gap
    // depends on display: flex).
    views.forEach(v => {
      v.style.display = v.classList.contains('active') ? '' : 'none';
    });
  }

  function activateTab(tabName, opts = {}) {
    const { pushUrl = true } = opts;
    const target = Array.from(tabs).find(t => t.dataset.tab === tabName);
    if (!target) return;

    tabs.forEach(x => {
      x.classList.remove('active');
      x.setAttribute('aria-selected', 'false');
    });
    views.forEach(v => v.classList.remove('active'));
    target.classList.add('active');
    target.setAttribute('aria-selected', 'true');
    document.getElementById(`${tabName}-view`).classList.add('active');
    applyTabState();

    // Each tab starts fresh at the top of its own scroll context.
    const scrollEl = document.querySelector('main');
    if (scrollEl) scrollEl.scrollTop = 0;

    // Stop any in-flight song preview when leaving the Settings tab.
    if (tabName !== 'settings') {
      try { previewAudio.pause(); previewAudio.currentTime = 0; } catch (_) {}
      document.querySelectorAll('.song-opt-preview.playing').forEach(b => {
        b.classList.remove('playing');
        b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
      });
    }

    if (pushUrl) {
      // Anchor URL to the GitHub Pages base path so /walkup-music/lineup works,
      // but a local file:// or root deploy gets clean /lineup paths too.
      const base = location.pathname.replace(/\/(lineup|roster|settings)\/?$/, '');
      const next = base.replace(/\/$/, '') + '/' + tabName;
      try {
        history.pushState({ tab: tabName }, '', next);
      } catch (_) { /* ignore history errors (e.g., file://) */ }
    }
  }

  function tabFromUrl() {
    const m = location.pathname.match(/\/(lineup|roster|settings)\/?$/);
    return m ? m[1] : 'lineup';
  }

  function bindTabs() {
    // Initial state from URL (default lineup)
    activateTab(tabFromUrl(), { pushUrl: false });

    tabs.forEach(t => {
      t.addEventListener('click', () => activateTab(t.dataset.tab));
    });

    // Back/forward buttons
    window.addEventListener('popstate', () => {
      activateTab(tabFromUrl(), { pushUrl: false });
    });
  }

  // === Pre-game team intro ===
  function bindTeamIntro() {
    if (!teamIntroBtn || !teamIntroAudio) return;
    teamIntroBtn.addEventListener('click', () => {
      if (!teamIntroAudio.paused) {
        teamIntroAudio.pause();
        teamIntroAudio.currentTime = 0;
        setIntroPlaying(false);
        return;
      }
      // If a batter is queued or playing, stop them first; the intro is a
      // one-shot that owns the speakers for its duration.
      if (playbackPhase || isPaused) {
        stopAll();
        if (currentBatterIdx >= 0 && lineup.length > 0) showBarFromLineup();
        else updatePlaybackBar();
      }
      teamIntroAudio.currentTime = 0;
      const p = teamIntroAudio.play();
      if (p && p.catch) p.catch(() => {});
      setIntroPlaying(true);
    });
    teamIntroAudio.addEventListener('ended', () => setIntroPlaying(false));
    teamIntroAudio.addEventListener('pause', () => {
      if (teamIntroAudio.currentTime === 0) setIntroPlaying(false);
    });
  }

  function setIntroPlaying(playing) {
    if (!teamIntroBtn) return;
    teamIntroBtn.classList.toggle('playing', playing);
    if (pregamePlayIcon) pregamePlayIcon.style.display = playing ? 'none' : '';
    if (pregamePauseIcon) pregamePauseIcon.style.display = playing ? '' : 'none';
    teamIntroBtn.setAttribute('aria-label', playing ? 'Stop team intro' : 'Play team intro');
    if (playing) stopKeepalive(); else startKeepalive();
  }

  // === Per-player song overrides ===
  // The library (loaded from audio/simple/library.json) is the single source
  // of truth for songs. Each library entry: { file, song }. Players have a
  // default walkup file path in roster.json; the displayed song title is
  // looked up from the library so roster + library can't drift.
  let songLibrary = [];

  function findLibraryEntry(file) {
    return songLibrary.find(s => s.file === file) || null;
  }

  // Each player gets a `_defaultWalkup` / `_defaultSong` / `_defaultArtist`
  // snapshot taken before any override is applied, so we can always show /
  // switch back to their original.
  function snapshotSongDefaults() {
    roster.forEach(p => {
      p._defaultWalkup = p.walkup;
      const entry = findLibraryEntry(p.walkup);
      p._defaultSong = entry ? entry.song : '(no title)';
      p._defaultArtist = entry ? (entry.artist || '') : '';
      p.song = p._defaultSong;
      p.artist = p._defaultArtist;
    });
  }

  // Read playerSongOverrides and mutate each player's walkup + song + artist
  // fields to match the selected library entry. Invalid entries (file no
  // longer in the library) silently fall back to the default. A Deezer
  // assignment (if any) takes precedence and is applied on top via
  // applyDeezerSongs.
  function applySongOverrides() {
    roster.forEach(p => {
      p._deezerTrack = null;
      const sel = playerSongOverrides[p.number];
      if (!sel || sel === p._defaultWalkup) {
        p.walkup = p._defaultWalkup;
        p.song = p._defaultSong;
        p.artist = p._defaultArtist;
      } else {
        const lib = findLibraryEntry(sel);
        if (lib) {
          p.walkup = lib.file;
          p.song = lib.song;
          p.artist = lib.artist || '';
        } else {
          p.walkup = p._defaultWalkup;
          p.song = p._defaultSong;
          p.artist = p._defaultArtist;
        }
      }
    });
    applyDeezerSongs();
  }

  // For each player with a saved Deezer assignment + cached blob, set their
  // walkup to the local object URL so the rest of the app plays it like any
  // other clip. If the blob is missing (e.g. IDB cleared, fresh install of the
  // PWA on a new device), we keep the library/default and surface a "redownload"
  // affordance in the settings UI.
  function applyDeezerSongs() {
    roster.forEach(p => {
      const entry = playerDeezerSongs[p.number];
      if (!entry) return;
      const url = playerDeezerBlobUrls[p.number];
      if (url) {
        p.walkup = url;
        p.song = entry.title;
        p.artist = entry.artist || '';
        p._deezerTrack = entry;
      } else {
        // Marker is present but the blob hasn't been hydrated yet (or the
        // download failed). Keep the player on their library/default song;
        // the settings card will offer a one-tap re-fetch.
        p._deezerTrack = { ...entry, _missing: true };
      }
    });
  }

  // Single source of truth for how we display "Title · Artist" inline. If a
  // player has no artist we just show the title (or whatever song label fits).
  function songLine(player) {
    if (!player) return '';
    const t = player.song || '';
    const a = player.artist || '';
    if (t && a) return `${t} · ${a}`;
    return t || a || '';
  }

  // === Deezer integration ===
  // Search Deezer's public API for a song, preview it inline, and on "Use"
  // download the 30s MP3 preview into IndexedDB so it plays as the player's
  // walk-up. The clip is hard-capped at DEEZER_CLIP_DURATION_S (10s) so we
  // don't outstay our welcome with the umpires.
  const DEEZER_DB_NAME = 'walkup-simple-deezer';
  const DEEZER_DB_VERSION = 1;
  const DEEZER_STORE = 'audio';
  let deezerDbPromise = null;

  function openDeezerDb() {
    if (deezerDbPromise) return deezerDbPromise;
    deezerDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DEEZER_DB_NAME, DEEZER_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DEEZER_STORE)) {
          db.createObjectStore(DEEZER_STORE);  // keyed by trackId
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return deezerDbPromise;
  }

  async function idbGetBlob(trackId) {
    const db = await openDeezerDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DEEZER_STORE, 'readonly');
      const req = tx.objectStore(DEEZER_STORE).get(String(trackId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPutBlob(trackId, blob) {
    const db = await openDeezerDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DEEZER_STORE, 'readwrite');
      tx.objectStore(DEEZER_STORE).put(blob, String(trackId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDeleteBlob(trackId) {
    const db = await openDeezerDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DEEZER_STORE, 'readwrite');
      tx.objectStore(DEEZER_STORE).delete(String(trackId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Deezer's REST API doesn't send CORS headers on the search endpoint, but it
  // supports JSONP. We inject a <script> with a callback name and wait for it
  // to fire. The preview MP3 CDN does send CORS so we fetch() that as a Blob.
  function deezerJsonp(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const cb = '__dz_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('Deezer timeout')); }, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (_) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error('Deezer load failed')); };
      script.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
      document.head.appendChild(script);
    });
  }

  async function searchDeezer(q) {
    if (!q || q.trim().length < 2) return [];
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q.trim())}&limit=15`;
    const data = await deezerJsonp(url);
    return (data && Array.isArray(data.data)) ? data.data : [];
  }

  // Hydrate all saved Deezer assignments at startup: pull each cached blob out
  // of IDB and stash an object URL we'll use as the player's walkup src.
  async function hydrateDeezerBlobs() {
    const nums = Object.keys(playerDeezerSongs).map(n => Number(n));
    await Promise.all(nums.map(async (num) => {
      const entry = playerDeezerSongs[num];
      if (!entry || !entry.trackId) return;
      try {
        const blob = await idbGetBlob(entry.trackId);
        if (blob) playerDeezerBlobUrls[num] = URL.createObjectURL(blob);
      } catch (_) { /* ignore — falls back to library/default */ }
    }));
  }

  // Download and persist a Deezer preview, then mark it as this player's
  // walk-up. Old assignments (and their blobs/object URLs) are cleaned up.
  async function assignDeezerTrackToPlayer(playerNumber, track) {
    if (!track || !track.preview) throw new Error('Track has no preview URL');

    // Clean up any prior assignment for this player first.
    await clearDeezerForPlayer(playerNumber, { skipRender: true });

    const res = await fetch(track.preview);
    if (!res.ok) throw new Error('Failed to fetch preview');
    const blob = await res.blob();

    const trackId = String(track.id);
    await idbPutBlob(trackId, blob);
    const url = URL.createObjectURL(blob);
    playerDeezerBlobUrls[playerNumber] = url;

    const entry = {
      trackId,
      title: track.title_short || track.title || 'Untitled',
      artist: (track.artist && track.artist.name) || 'Unknown',
      artUrl: (track.album && (track.album.cover_medium || track.album.cover)) || '',
      previewUrl: track.preview,
    };
    playerDeezerSongs[playerNumber] = entry;
    localStorage.setItem('walkup-simple-deezer', JSON.stringify(playerDeezerSongs));

    // Picking a Deezer track also clears any library override for this
    // player so the two sources stay mutually exclusive.
    if (playerSongOverrides[playerNumber]) {
      delete playerSongOverrides[playerNumber];
      localStorage.setItem('walkup-simple-songs', JSON.stringify(playerSongOverrides));
    }

    applySongOverrides();
    renderLineup();
    renderRoster();
    renderAvailable();
    renderSongOptionsList();

    if (currentPlayer && currentPlayer.number === playerNumber) {
      const p = roster.find(x => x.number === playerNumber);
      if (p) {
        currentPlayer = p;
        updatePlaybackBar();
        updateMediaSession();
        if (!playbackPhase) preloadForPlayer(currentPlayer);
      }
    }
  }

  async function clearDeezerForPlayer(playerNumber, opts = {}) {
    const { skipRender = false } = opts;
    // Do the synchronous bookkeeping first so any caller that fires this
    // and then immediately calls applySongOverrides() sees the cleared state.
    const prior = playerDeezerSongs[playerNumber];
    const url = playerDeezerBlobUrls[playerNumber];
    if (url) {
      try { URL.revokeObjectURL(url); } catch (_) {}
      delete playerDeezerBlobUrls[playerNumber];
    }
    if (playerDeezerSongs[playerNumber]) {
      delete playerDeezerSongs[playerNumber];
      localStorage.setItem('walkup-simple-deezer', JSON.stringify(playerDeezerSongs));
    }
    // Then drop the cached blob (best-effort, runs after we've already updated
    // in-memory state).
    if (prior && prior.trackId) {
      try { await idbDeleteBlob(prior.trackId); } catch (_) {}
    }
    if (!skipRender) {
      applySongOverrides();
      renderLineup();
      renderRoster();
      renderAvailable();
      renderSongOptionsList();
      if (currentPlayer && currentPlayer.number === playerNumber) {
        const p = roster.find(x => x.number === playerNumber);
        if (p) {
          currentPlayer = p;
          updatePlaybackBar();
          updateMediaSession();
          if (!playbackPhase) preloadForPlayer(currentPlayer);
        }
      }
    }
  }

  // Per-player accordion: each player gets a <details> row. Collapsed shows
  // #N, name, and the current song (default or selected). Expanded reveals
  // the full song library; tapping a library entry assigns it to the player.
  // Library entries that are someone else's default get a small "Adrian's"
  // tag so the coach knows where the song came from.
  function renderSongOptionsList() {
    const host = document.getElementById('song-options-list');
    if (!host) return;
    // Preserve which player rows are currently expanded across re-renders.
    const expanded = new Set(
      Array.from(host.querySelectorAll('details.song-player-card[open]'))
        .map(d => d.dataset.pnum)
    );
    host.innerHTML = '';

    const players = roster.slice().sort((a, b) => a.number - b.number);
    if (players.length === 0 || songLibrary.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state subtle';
      empty.textContent = 'No songs available.';
      host.appendChild(empty);
      return;
    }

    players.forEach(p => {
      const card = document.createElement('details');
      card.className = 'song-player-card';
      card.dataset.pnum = String(p.number);
      if (expanded.has(String(p.number))) card.open = true;

      const summary = document.createElement('summary');
      summary.className = 'song-player-head';
      const dz = playerDeezerSongs[p.number];
      const isCustom = (!dz && playerSongOverrides[p.number] && playerSongOverrides[p.number] !== p._defaultWalkup) || !!dz;
      const currentLine = songLine(p) || p._defaultSong || '(no song)';
      summary.innerHTML = `
        <span class="lineup-num">#${p.number}</span>
        <span class="song-player-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
        <span class="song-player-current ${isCustom ? 'is-custom' : ''}">
          ${dz ? '<span class="song-player-deezer-chip" title="From Deezer">DZ</span>' : ''}
          ${escapeHtml(currentLine)}
          ${isCustom ? '<span class="song-player-customdot" title="Custom selection"></span>' : ''}
        </span>
        <span class="song-player-caret" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      `;
      card.appendChild(summary);

      const opts = document.createElement('div');
      opts.className = 'song-opts';

      // === Deezer row(s) ===
      // Always show a "Search Deezer" entry. If this player already has a
      // Deezer track assigned, show it as the active row above the library
      // with a Remove affordance.
      if (dz) {
        const dzRow = document.createElement('div');
        dzRow.className = 'song-opt song-opt-deezer active';
        dzRow.setAttribute('role', 'radio');
        dzRow.setAttribute('aria-checked', 'true');
        dzRow.innerHTML = `
          <button class="song-opt-preview" type="button" aria-label="Preview ${escapeHtml(dz.title)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </button>
          ${dz.artUrl ? `<img class="song-opt-art" src="${escapeHtml(dz.artUrl)}" alt="" loading="lazy">` : ''}
          <span class="song-opt-title">
            <span class="song-opt-title-line">${escapeHtml(dz.title)}</span>
            <span class="song-opt-sub">${escapeHtml(dz.artist)}</span>
          </span>
          <span class="song-opt-tag">Deezer</span>
          <button class="song-opt-remove" type="button" aria-label="Remove Deezer song" title="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        `;
        const dzPreviewBtn = dzRow.querySelector('.song-opt-preview');
        const dzPreviewSrc = playerDeezerBlobUrls[p.number] || dz.previewUrl;
        dzPreviewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePreview(dzPreviewSrc, dzPreviewBtn);
        });
        dzRow.querySelector('.song-opt-remove').addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await clearDeezerForPlayer(p.number); }
          catch (err) { console.warn('Clear Deezer failed', err); }
        });
        opts.appendChild(dzRow);
      }

      const searchRow = document.createElement('div');
      searchRow.className = 'song-opt song-opt-deezer-search';
      searchRow.setAttribute('role', 'button');
      searchRow.innerHTML = `
        <span class="song-opt-deezer-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>
        </span>
        <span class="song-opt-title">${dz ? 'Change Deezer song…' : 'Search Deezer…'}</span>
        <span class="song-opt-tag muted">Online</span>
      `;
      searchRow.addEventListener('click', () => openDeezerModal(p));
      opts.appendChild(searchRow);

      // Visual divider between Deezer + library
      const divider = document.createElement('div');
      divider.className = 'song-opts-divider';
      divider.innerHTML = '<span>Library</span>';
      opts.appendChild(divider);

      songLibrary.forEach(lib => {
        const isActive = p.walkup === lib.file;
        // 'Default' tag shows only on this player's own default song,
        // so they can see which one switches back. We don't attribute
        // any song to other players — every song is just a library entry.
        const isOwnDefault = lib.file === p._defaultWalkup;

        const row = document.createElement('div');
        row.className = 'song-opt' + (isActive ? ' active' : '');
        row.setAttribute('role', 'radio');
        row.setAttribute('aria-checked', isActive ? 'true' : 'false');
        row.dataset.pnum = String(p.number);
        row.dataset.file = lib.file;

        const tagHtml = isOwnDefault ? '<span class="song-opt-tag">Default</span>' : '';
        const artistHtml = lib.artist
          ? `<span class="song-opt-sub">${escapeHtml(lib.artist)}</span>`
          : '';

        row.innerHTML = `
          <button class="song-opt-preview" type="button" aria-label="Preview ${escapeHtml(lib.song)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </button>
          <span class="song-opt-title">
            <span class="song-opt-title-line">${escapeHtml(lib.song)}</span>
            ${artistHtml}
          </span>
          ${tagHtml}
          <span class="song-opt-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>
        `;

        row.addEventListener('click', (e) => {
          if (e.target.closest('.song-opt-preview')) return;
          selectSongForPlayer(p.number, lib.file);
        });

        const previewBtn = row.querySelector('.song-opt-preview');
        previewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePreview(lib.file, previewBtn);
        });

        opts.appendChild(row);
      });
      card.appendChild(opts);
      host.appendChild(card);
    });
  }

  function selectSongForPlayer(playerNumber, file) {
    const p = roster.find(x => x.number === playerNumber);
    if (!p) return;
    // Picking a library entry also clears any Deezer assignment so the
    // two sources stay mutually exclusive. Fire-and-forget — the local
    // state is updated synchronously below.
    if (playerDeezerSongs[playerNumber]) {
      clearDeezerForPlayer(playerNumber, { skipRender: true }).catch(() => {});
    }
    if (file === p._defaultWalkup) {
      delete playerSongOverrides[playerNumber];
    } else {
      playerSongOverrides[playerNumber] = file;
    }
    localStorage.setItem('walkup-simple-songs', JSON.stringify(playerSongOverrides));
    applySongOverrides();

    // Re-render lineup / roster so song titles update wherever they appear.
    renderLineup();
    renderRoster();
    renderAvailable();
    renderSongOptionsList();

    // If this player is currently queued up or playing, refresh the bar +
    // the preloaded audio so a future Play picks up the new file.
    if (currentPlayer && currentPlayer.number === playerNumber) {
      currentPlayer = p;
      updatePlaybackBar();
      updateMediaSession();
      if (!playbackPhase) preloadForPlayer(currentPlayer);
    }
  }

  function togglePreview(file, btn) {
    const sameBtn = btn.classList.contains('playing');
    // Always reset state of any other preview button
    document.querySelectorAll('.song-opt-preview.playing').forEach(b => {
      b.classList.remove('playing');
      b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    });
    try { previewAudio.pause(); previewAudio.currentTime = 0; } catch (_) {}

    if (sameBtn) return;

    previewAudio.src = file;
    previewAudio.currentTime = 0;
    btn.classList.add('playing');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';
    previewAudio.play().catch(() => {
      btn.classList.remove('playing');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    });
  }
  // Stop preview when it ends naturally
  previewAudio.addEventListener('ended', () => {
    document.querySelectorAll('.song-opt-preview.playing').forEach(b => {
      b.classList.remove('playing');
      b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    });
  });

  // === Deezer search modal ===
  // Owns its own previewAudio-like element so the modal's preview state is
  // independent of the per-row library previews.
  const deezerPreview = new Audio();
  deezerPreview.preload = 'auto';
  deezerPreview.addEventListener('ended', () => {
    setDeezerPreviewPlayingBtn(null);
  });
  let deezerModalPlayer = null;       // player object the modal was opened for
  let deezerSearchSeq = 0;            // debounce / stale-response guard
  let deezerSearchTimer = null;
  let lastDeezerResults = [];

  function openDeezerModal(player) {
    deezerModalPlayer = player;
    const modal = document.getElementById('deezer-modal');
    const label = document.getElementById('deezer-modal-subtitle');
    const input = document.getElementById('deezer-search-input');
    const results = document.getElementById('deezer-results');
    if (!modal || !input || !results) return;
    if (label) label.textContent = `For #${player.number} ${player.firstName} ${player.lastName}`;
    input.value = '';
    results.innerHTML = navigator.onLine
      ? '<div class="deezer-empty">Search for any song or artist above.</div>'
      : '<div class="deezer-empty">You\'re offline. Deezer search needs a connection — your saved songs still play.</div>';
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    setTimeout(() => { try { input.focus(); } catch (_) {} }, 30);
  }

  function closeDeezerModal() {
    const modal = document.getElementById('deezer-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    try { deezerPreview.pause(); deezerPreview.currentTime = 0; } catch (_) {}
    setDeezerPreviewPlayingBtn(null);
    deezerModalPlayer = null;
  }

  function setDeezerPreviewPlayingBtn(btnOrNull) {
    document.querySelectorAll('.deezer-result-play.playing').forEach(b => {
      b.classList.remove('playing');
      b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    });
    if (btnOrNull) {
      btnOrNull.classList.add('playing');
      btnOrNull.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';
    }
  }

  function toggleDeezerPreview(track, btn) {
    const sameBtn = btn.classList.contains('playing');
    try { deezerPreview.pause(); deezerPreview.currentTime = 0; } catch (_) {}
    setDeezerPreviewPlayingBtn(null);
    if (sameBtn) return;
    deezerPreview.src = track.preview;
    setDeezerPreviewPlayingBtn(btn);
    deezerPreview.play().catch(() => setDeezerPreviewPlayingBtn(null));
  }

  function renderDeezerResults(tracks) {
    const host = document.getElementById('deezer-results');
    if (!host) return;
    host.innerHTML = '';
    lastDeezerResults = tracks || [];
    if (!tracks || tracks.length === 0) {
      host.innerHTML = '<div class="deezer-empty">No results.</div>';
      return;
    }
    tracks.forEach(t => {
      if (!t.preview) return;  // need a previewable track
      const art = (t.album && (t.album.cover_medium || t.album.cover)) || '';
      const row = document.createElement('div');
      row.className = 'deezer-result';
      row.innerHTML = `
        <button class="deezer-result-play" type="button" aria-label="Preview ${escapeHtml(t.title || '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        </button>
        ${art ? `<img class="deezer-result-art" src="${escapeHtml(art)}" alt="" loading="lazy">` : '<span class="deezer-result-art placeholder"></span>'}
        <span class="deezer-result-info">
          <span class="deezer-result-title">${escapeHtml(t.title_short || t.title || '')}</span>
          <span class="deezer-result-artist">${escapeHtml((t.artist && t.artist.name) || '')}</span>
        </span>
        <button class="deezer-result-use" type="button">Use</button>
      `;
      row.querySelector('.deezer-result-play').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDeezerPreview(t, e.currentTarget);
      });
      row.querySelector('.deezer-result-use').addEventListener('click', async (e) => {
        e.stopPropagation();
        const useBtn = e.currentTarget;
        if (!deezerModalPlayer) return;
        useBtn.disabled = true;
        useBtn.textContent = 'Saving…';
        try {
          await assignDeezerTrackToPlayer(deezerModalPlayer.number, t);
          closeDeezerModal();
        } catch (err) {
          console.warn('Deezer assign failed', err);
          useBtn.disabled = false;
          useBtn.textContent = 'Try again';
        }
      });
      host.appendChild(row);
    });
  }

  function bindDeezerModal() {
    const modal = document.getElementById('deezer-modal');
    if (!modal) return;
    const closeBtn = document.getElementById('deezer-close');
    const backdrop = document.getElementById('deezer-modal-backdrop');
    const input = document.getElementById('deezer-search-input');
    if (closeBtn) closeBtn.addEventListener('click', closeDeezerModal);
    if (backdrop) backdrop.addEventListener('click', closeDeezerModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeDeezerModal();
    });
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(deezerSearchTimer);
        const q = input.value.trim();
        const host = document.getElementById('deezer-results');
        if (q.length < 2) {
          if (host) host.innerHTML = '<div class="deezer-empty">Search for any song or artist above.</div>';
          return;
        }
        if (host) host.innerHTML = '<div class="deezer-empty">Searching…</div>';
        const mySeq = ++deezerSearchSeq;
        deezerSearchTimer = setTimeout(async () => {
          try {
            const tracks = await searchDeezer(q);
            if (mySeq !== deezerSearchSeq) return;  // newer query in flight
            renderDeezerResults(tracks);
          } catch (err) {
            if (mySeq !== deezerSearchSeq) return;
            if (host) host.innerHTML = '<div class="deezer-empty error">Search failed. Check your connection and try again.</div>';
          }
        }, 280);
      });
    }
  }

  // === Settings ===
  function bindSettings() {
    const opts = document.querySelectorAll('.settings-opt');
    function paint() {
      opts.forEach(o => {
        const isActive = o.dataset.mode === playbackMode;
        o.classList.toggle('active', isActive);
        o.setAttribute('aria-checked', isActive ? 'true' : 'false');
      });
    }
    opts.forEach(o => {
      o.addEventListener('click', () => {
        playbackMode = o.dataset.mode;
        localStorage.setItem('walkup-simple-mode', playbackMode);
        paint();
        // Re-arm the timeline math for the new mode if anything is queued up.
        // We don't rip out an in-progress at-bat; the change applies to the
        // next batter that's sent up.
        if (!playbackPhase) updatePlaybackBar();
      });
    });
    paint();
    renderSongOptionsList();
  }

  // === Roster (preview) ===
  function renderRoster() {
    rosterView.innerHTML = '';
    roster.forEach(p => {
      const card = document.createElement('button');
      card.className = 'roster-card';
      if (currentPlayer && currentPlayer.number === p.number && playbackPhase) {
        card.classList.add('active');
      }
      card.innerHTML = `
        <span class="roster-num">#${p.number}</span>
        <span class="roster-info">
          <span class="roster-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
          <span class="roster-song">${escapeHtml(songLine(p))}</span>
        </span>
        <span class="roster-play" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        </span>
      `;
      card.addEventListener('click', () => {
        // Preview from roster: don't lock to a lineup index
        currentBatterIdx = -1;
        playPlayer(p);
      });
      rosterView.appendChild(card);
    });
  }

  // === Lineup ===
  function renderLineup() {
    lineupList.innerHTML = '';
    if (lineup.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No batters yet. Add players from the list below.';
      lineupList.appendChild(empty);
      clearLineupBtn.disabled = true;
      return;
    }
    clearLineupBtn.disabled = false;

    lineup.forEach((num, idx) => {
      const p = roster.find(x => x.number === num);
      if (!p) return;

      const row = document.createElement('div');
      row.className = 'lineup-row';
      if (currentBatterIdx === idx && currentPlayer && currentPlayer.number === num) {
        row.classList.add('active');
      }
      row.draggable = true;
      row.dataset.idx = idx;

      row.innerHTML = `
        <span class="lineup-pos">${idx + 1}</span>
        <span class="lineup-num">#${p.number}</span>
        <span class="lineup-info">
          <span class="lineup-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
          <span class="lineup-song">${escapeHtml(songLine(p))}</span>
        </span>
        <button class="lineup-play" aria-label="Play">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        </button>
        <button class="lineup-remove" aria-label="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      row.querySelector('.lineup-play').addEventListener('click', (e) => {
        e.stopPropagation();
        currentBatterIdx = idx;
        playPlayer(p);
      });
      row.querySelector('.lineup-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromLineup(idx);
      });
      row.addEventListener('click', () => {
        currentBatterIdx = idx;
        playPlayer(p);
      });

      // Drag reorder — live preview: as the user drags over other rows,
      // the lineup rearranges in real time so they can see the new order
      // before they let go. Dropping just commits whatever the order
      // already is; cancelling (esc / drop outside) leaves it as-is.
      row.addEventListener('dragstart', (e) => {
        dragIdx = idx;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers refuse to start a drag without setData
        try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        dragIdx = -1;
        saveLineup();
        // Full re-render to reset event closures with the new order
        renderLineup();
        updatePlaybackBar();
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragIdx < 0) return;

        // Use the row's *current* DOM position, not the closure-captured idx,
        // since we shuffle children during the drag.
        const targetIdx = Array.from(lineupList.children).indexOf(row);
        if (targetIdx < 0 || targetIdx === dragIdx) return;

        const rect = row.getBoundingClientRect();
        const isBelow = e.clientY > rect.top + rect.height / 2;
        let newIdx = isBelow ? targetIdx + 1 : targetIdx;
        if (dragIdx < newIdx) newIdx -= 1;  // removing dragIdx shifts later positions down
        if (newIdx === dragIdx) return;

        // 1. Mutate the lineup array
        const num = lineup.splice(dragIdx, 1)[0];
        lineup.splice(newIdx, 0, num);

        // 2. Move the dragged row in the DOM (preserves its drag identity)
        const draggedEl = lineupList.children[dragIdx];
        if (draggedEl) {
          if (isBelow) row.parentNode.insertBefore(draggedEl, row.nextSibling);
          else         row.parentNode.insertBefore(draggedEl, row);
        }

        // 3. Refresh position numbers + active highlight
        Array.from(lineupList.children).forEach((el, i) => {
          const posEl = el.querySelector('.lineup-pos');
          if (posEl) posEl.textContent = String(i + 1);
        });

        // 4. Track the current player's index if they're in the lineup
        if (currentPlayer) {
          currentBatterIdx = lineup.indexOf(currentPlayer.number);
        }

        dragIdx = newIdx;
      });
      row.addEventListener('drop', (e) => {
        // The reorder already happened in dragover; just suppress the
        // default and let dragend persist.
        e.preventDefault();
      });

      lineupList.appendChild(row);
    });
  }

  function renderAvailable() {
    availableList.innerHTML = '';
    const inLineup = new Set(lineup);
    const available = roster.filter(p => !inLineup.has(p.number));
    if (available.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state subtle';
      empty.textContent = 'Everyone is in the lineup.';
      availableList.appendChild(empty);
      return;
    }
    available.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'available-row';
      btn.innerHTML = `
        <span class="lineup-num">#${p.number}</span>
        <span class="lineup-info">
          <span class="lineup-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
          <span class="lineup-song">${escapeHtml(songLine(p))}</span>
        </span>
        <span class="add-icon">+</span>
      `;
      btn.addEventListener('click', () => {
        const wasEmpty = lineup.length === 0;
        lineup.push(p.number);
        saveLineup();
        // First batter added: point at them so the bar shows them as "Up Next"
        if (wasEmpty && currentBatterIdx < 0) {
          currentBatterIdx = 0;
          showBarFromLineup();
        }
        renderLineup();
        renderAvailable();
      });
      availableList.appendChild(btn);
    });
  }

  function removeFromLineup(idx) {
    const wasPointer = idx === currentBatterIdx;
    lineup.splice(idx, 1);

    if (lineup.length === 0) {
      stopAll();
      currentPlayer = null;
      currentBatterIdx = -1;
    } else if (wasPointer) {
      // Removed the batter we were pointing at; stop and stay at the same
      // index (which is now the next batter, or wrap to 0).
      if (playbackPhase || isPaused) stopAll();
      if (currentBatterIdx >= lineup.length) currentBatterIdx = 0;
      showBarFromLineup();
    } else if (currentBatterIdx > idx) {
      // Removed someone earlier in the order; shift our pointer left.
      currentBatterIdx -= 1;
    }

    saveLineup();
    renderLineup();
    renderAvailable();
    updatePlaybackBar();
  }

  if (clearLineupBtn) {
    clearLineupBtn.addEventListener('click', () => {
      if (lineup.length === 0) return;
      if (!confirm('Clear the entire batting order?')) return;
      lineup = [];
      stopAll();
      currentPlayer = null;
      currentBatterIdx = -1;
      saveLineup();  // also persists cursor reset
      renderLineup();
      renderAvailable();
      updatePlaybackBar();
    });
  }

  // === Playback ===
  // The play button is the only thing that actually starts audio. Prev/Next
  // just stop and move the pointer; the bar then shows the new batter as
  // "Up Next" until the user taps Play. After a song ends, the pointer
  // auto-advances to the next batter — same idea: tap Play to send them up.
  function bindTransport() {
    playPauseBtn.addEventListener('click', onPlayPauseClicked);
    prevBtn.addEventListener('click', () => navigateBatter(-1));
    nextBtn.addEventListener('click', () => navigateBatter(1));
  }

  function onPlayPauseClicked() {
    // Idle state with a lineup pointer set: play that batter
    if (!currentPlayer && currentBatterIdx >= 0 && lineup.length > 0) {
      const p = roster.find(x => x.number === lineup[currentBatterIdx]);
      if (p) { playPlayer(p); return; }
    }
    if (!currentPlayer) return;
    if (isPaused) resumePlayback();
    else if (playbackPhase) pausePlayback();
    else playPlayer(currentPlayer);  // restart
  }

  // Stop any current playback and move the lineup pointer by `delta`,
  // wrapping at both ends. Does NOT start playing — the bar shows the
  // new batter as "Up Next" and waits for the user to press Play.
  function navigateBatter(delta) {
    if (lineup.length === 0) return;
    if (playbackPhase || isPaused) stopAll();
    if (currentBatterIdx < 0) currentBatterIdx = 0;
    currentBatterIdx = (currentBatterIdx + delta + lineup.length) % lineup.length;
    showBarFromLineup();
  }

  // Sync the playback bar (and Now Playing) with whoever the lineup pointer
  // points at, without starting playback. Called after navigate, after a
  // song ends, and on initial load.
  function showBarFromLineup() {
    if (currentBatterIdx < 0 || lineup.length === 0) {
      currentPlayer = null;
    } else {
      const num = lineup[currentBatterIdx];
      currentPlayer = roster.find(p => p.number === num) || null;
    }
    saveCursor();
    progressFill.style.width = '0%';
    npProgressFill.style.width = '0%';
    timeCurrent.textContent = '0:00';
    npTimeCurrent.textContent = '0:00';
    setPlayPauseIcon(false);
    updatePlaybackBar();
    updateMediaSession();
    setMediaSessionState(currentPlayer ? 'paused' : 'none');
    // Begin downloading the upcoming batter's audio so that whenever the
    // user finally taps Play — whether in the app, on the lock screen, or
    // in Control Center — playback can start immediately instead of waiting
    // for iOS to load the file from a backgrounded tab.
    preloadForPlayer(currentPlayer);
  }

  // Set audio.src + .load() only if the source has changed. Calling .load()
  // on an already-loaded element re-fetches and re-buffers, which is what
  // was causing the lock-screen play delay.
  function preloadForPlayer(player) {
    if (!player) return;
    if (player.announcement && !audioHasSrc(announcementAudio, player.announcement)) {
      announcementAudio.src = player.announcement;
      try { announcementAudio.load(); } catch (_) {}
    }
    if (player.walkup && !audioHasSrc(walkupAudio, player.walkup)) {
      walkupAudio.src = player.walkup;
      try { walkupAudio.load(); } catch (_) {}
    }
  }

  function audioHasSrc(audio, relPath) {
    if (!audio.src) return false;
    try {
      const u = new URL(audio.src);
      return u.pathname.endsWith(relPath);
    } catch (_) {
      return audio.src.endsWith(relPath);
    }
  }

  // === Now Playing (fullscreen) ===
  function bindNowPlaying() {
    expandBtn.addEventListener('click', openNowPlaying);
    // Tapping the mini-player text area also expands
    document.getElementById('playback-info').addEventListener('click', (e) => {
      // Don't expand when tapping the expand button itself (it already handles it)
      if (e.target.closest('#expand-btn')) return;
      if (currentPlayer) openNowPlaying();
    });

    collapseBtn.addEventListener('click', closeNowPlaying);

    npPlayPauseBtn.addEventListener('click', onPlayPauseClicked);
    npPrevBtn.addEventListener('click', () => navigateBatter(-1));
    npNextBtn.addEventListener('click', () => navigateBatter(1));

    // Esc closes the overlay
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !nowPlaying.classList.contains('hidden')) {
        closeNowPlaying();
      }
    });
  }

  function openNowPlaying() {
    nowPlaying.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    updateNowPlaying();
  }
  function closeNowPlaying() {
    nowPlaying.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function updateNowPlaying() {
    if (!currentPlayer) {
      npNumber.textContent = '';
      npName.textContent = 'No player selected';
      npSongName.classList.add('hidden');
      npUpNext.innerHTML = '';
      npProgressFill.style.width = '0%';
      npTimeCurrent.textContent = '0:00';
      npTimeTotal.textContent = '0:00';
      npPrevBtn.disabled = true;
      npNextBtn.disabled = true;
      npPlayPauseBtn.disabled = true;
      return;
    }
    // Label flips between "Now Batting" (playing) and "Up Next" (idle).
    npCurrentLabel.textContent = playbackPhase ? 'Now Batting' : 'Up Next';

    npNumber.textContent = `#${currentPlayer.number}`;
    npName.textContent = `${currentPlayer.firstName} ${currentPlayer.lastName}`;
    const npLine = songLine(currentPlayer);
    if (npLine) {
      npSongName.textContent = npLine;
      npSongName.classList.remove('hidden');
    } else {
      npSongName.classList.add('hidden');
    }

    npPlayPauseBtn.disabled = false;
    // Order wraps, so prev/next are usable whenever there's more than one batter.
    const canCycle = currentBatterIdx >= 0 && lineup.length > 1;
    npPrevBtn.disabled = !canCycle;
    npNextBtn.disabled = !canCycle;

    // Up Next / In The Hole — only meaningful when batting through a lineup
    npUpNext.innerHTML = '';
    if (currentBatterIdx >= 0 && lineup.length > 0) {
      // Order wraps: after the last batter, the top of the order is on deck.
      const onDeckNum = lineup.length > 1
        ? lineup[(currentBatterIdx + 1) % lineup.length]
        : null;
      const inTheHoleNum = lineup.length > 2
        ? lineup[(currentBatterIdx + 2) % lineup.length]
        : null;
      if (onDeckNum != null) {
        const p = roster.find(x => x.number === onDeckNum);
        if (p) npUpNext.appendChild(makeUpNextRow('On Deck', p));
      }
      if (inTheHoleNum != null) {
        const p = roster.find(x => x.number === inTheHoleNum);
        if (p) npUpNext.appendChild(makeUpNextRow('In The Hole', p));
      }
    }
  }

  function makeUpNextRow(label, player) {
    const row = document.createElement('div');
    row.className = 'np-role-row';
    row.innerHTML = `
      <span class="np-role-label">${label}</span>
      <span class="np-role-name">
        <span class="np-role-num">#${player.number}</span>${escapeHtml(player.firstName)} ${escapeHtml(player.lastName)}
      </span>
    `;
    return row;
  }

  function bindAudioEvents() {
    announcementAudio.addEventListener('ended', onAnnouncementEnded);
    walkupAudio.addEventListener('ended', onWalkupEnded);
    [announcementAudio, walkupAudio].forEach(a => {
      a.addEventListener('error', (e) => {
        console.warn('Audio error', a.src, e);
      });
    });
  }

  function playPlayer(player) {
    if (!player) return;
    stopAll();
    currentPlayer = player;
    isPaused = false;
    saveCursor();

    // Set src + load only if it isn't already set to this file. This avoids
    // re-fetching the audio on every play, which on iOS is what stalls
    // lock-screen playback for a couple of seconds.
    if (player.walkup && !audioHasSrc(walkupAudio, player.walkup)) {
      walkupAudio.src = player.walkup;
      try { walkupAudio.load(); } catch (_) {}
    }
    walkupAudio.volume = 0;        // every music entry fades in (see startWalkupAudio)
    walkupAudio.currentTime = 0;

    if (player.announcement) {
      playbackPhase = 'announcement';
      if (!audioHasSrc(announcementAudio, player.announcement)) {
        announcementAudio.src = player.announcement;
        try { announcementAudio.load(); } catch (_) {}
      }
      announcementAudio.volume = 1.0;
      announcementAudio.currentTime = 0;
      announcementAudio.play().then(() => {
        if (playbackMode === 'overlap') {
          // Music plays the entire time, ducked under the announcement.
          // Soft fade-in from 0 to ducked so it doesn't cut in.
          startWalkupAudio(duckedVol());
        } else {
          scheduleAnnouncementOverlap();
        }
      }).catch(err => {
        console.warn('Announcement play failed, going straight to walk-up', err);
        startWalkup();
      });
    } else {
      startWalkup();
    }

    acquireWakeLock();
    stopKeepalive();
    setPlayPauseIcon(true);
    startProgressLoop();
    updatePlaybackBar();
    updateMediaSession();
    setMediaSessionState('playing');
  }

  function scheduleAnnouncementOverlap() {
    clearTimeout(announcementOverlapTimer);
    const tryArm = () => {
      const dur = announcementAudio.duration;
      if (!dur || isNaN(dur) || !isFinite(dur)) {
        announcementOverlapTimer = setTimeout(tryArm, 120);
        return;
      }
      const startMusicAt = Math.max(0, dur - OVERLAP_S);
      const fireIn = Math.max(0, (startMusicAt - announcementAudio.currentTime) * 1000);
      announcementOverlapTimer = setTimeout(beginMusicOverlap, fireIn);
    };
    tryArm();
  }

  function beginMusicOverlap() {
    if (playbackPhase !== 'announcement') return;
    if (!walkupAudio.src) return;
    // Music starts ducked under the tail of the announcement, fading in
    // from 0 so the entry isn't a hard cut. Announcement continues at full
    // volume.
    startWalkupAudio(duckedVol());
  }

  function onAnnouncementEnded() {
    if (playbackPhase !== 'announcement') return;
    playbackPhase = 'walkup';
    if (walkupAudio.paused && walkupAudio.src) {
      walkupAudio.play().catch(() => {});
    }
    fade(walkupAudio, walkupAudio.volume || duckedVol(), fullVol(), MUSIC_RAMP_S * 1000);
    armWalkupFadeOut();
  }

  function startWalkup() {
    playbackPhase = 'walkup';
    // No announcement: fade music in from 0 to full so the song doesn't
    // hard-cut on entry.
    startWalkupAudio(fullVol());
    armWalkupFadeOut();
  }

  // Begin (or restart) the walk-up music with a soft fade-in to `targetVol`.
  // Used everywhere we'd normally do `walkupAudio.play()` at a fixed volume,
  // so every entry into the music gets the same gentle ramp instead of a cut.
  function startWalkupAudio(targetVol) {
    // Cancel any in-flight volume ramp so we always start from 0 cleanly.
    cancelFades();
    walkupAudio.volume = 0;
    const p = walkupAudio.play();
    if (p && p.catch) p.catch((err) => {
      console.warn('Walk-up play failed', err);
    });
    fade(walkupAudio, 0, targetVol, FADE_IN_S * 1000);
  }

  // Cap for the current player's walk-up. Deezer-sourced clips are held to
  // DEEZER_CLIP_DURATION_S (10s) because the umpires aren't going to let us
  // play a full 30-second preview.
  function currentWalkupCap() {
    if (isCurrentPlayerDeezer()) return DEEZER_CLIP_DURATION_S;
    return WALKUP_DURATION_S;
  }

  // True when the current player's walk-up is a (loaded) Deezer preview.
  function isCurrentPlayerDeezer() {
    return !!(currentPlayer && currentPlayer._deezerTrack && !currentPlayer._deezerTrack._missing);
  }

  // Volume the music sits at while the announcement is still playing, and the
  // level it ramps up to afterwards. Deezer previews are mastered hot, so they
  // get ducked harder and held a bit below full.
  function duckedVol() { return isCurrentPlayerDeezer() ? DEEZER_DUCKED_VOL : MUSIC_DUCKED_VOL; }
  function fullVol() { return isCurrentPlayerDeezer() ? DEEZER_FULL_VOL : MUSIC_FULL_VOL; }

  // The play-through length is the lesser of the configured cap and the audio
  // file's natural duration. For ~10s clips, total = ~10s; for longer songs we
  // cap at the configured ceiling and fade out before the song ends.
  function effectiveWalkupTotal() {
    const d = walkupAudio.duration;
    const cap = currentWalkupCap();
    if (isFinite(d) && d > 0) return Math.min(d, cap);
    return cap;
  }

  // Length of the announcement, or 0 if none / not loaded yet.
  function announcementTotal() {
    if (!currentPlayer || !currentPlayer.announcement) return 0;
    const d = announcementAudio.duration;
    return isFinite(d) && d > 0 ? d : 0;
  }

  // Combined at-bat duration. Two modes:
  //   sequential: announcement + music − overlap (music ducks in at the tail)
  //   overlap:    max(announcement, music) — both start at t=0; whichever
  //               clip is longer sets the bar's total. In practice the music
  //               is always longer than the announcement.
  function effectiveAtBatTotal() {
    const ann = announcementTotal();
    const walkup = effectiveWalkupTotal();
    if (ann <= 0) return walkup;
    if (playbackMode === 'overlap') return Math.max(ann, walkup);
    return ann + walkup - OVERLAP_S;
  }

  // Where we are in the combined at-bat timeline. Continuous across the
  // announcement → music transition.
  function atBatElapsed() {
    if (playbackMode === 'overlap') {
      // Both audios share the same t=0, so the master clock is whichever
      // is currently audible. Music is the steadier clock since it plays
      // through the entire at-bat.
      const w = walkupAudio.currentTime;
      const a = announcementAudio.currentTime;
      return Math.max(w || 0, a || 0);
    }
    // sequential mode
    if (playbackPhase === 'announcement') {
      return announcementAudio.currentTime;
    }
    if (playbackPhase === 'walkup') {
      const ann = announcementTotal();
      return ann > 0
        ? ann + walkupAudio.currentTime - OVERLAP_S
        : walkupAudio.currentTime;
    }
    return 0;
  }

  function armWalkupFadeOut() {
    clearTimeout(walkupFadeTimeout);
    const arm = () => {
      clearTimeout(walkupFadeTimeout);
      const total = effectiveWalkupTotal();
      // Always schedule a soft fade-out so the song never cuts at the end —
      // whether it's a short 10s library clip or a longer track being capped
      // at WALKUP_DURATION_S. Schedule by how much music is left from "now"
      // (overlap mode starts the music at t=0, so by walkup phase the music
      // is already several seconds in).
      const fadeStartMs = Math.max(
        0,
        (total - FADE_OUT_S - walkupAudio.currentTime) * 1000
      );
      walkupFadeTimeout = setTimeout(() => {
        fade(walkupAudio, walkupAudio.volume, 0, FADE_OUT_S * 1000, () => {
          walkupAudio.pause();
          onWalkupEnded();
        });
      }, fadeStartMs);
      // Refresh the displayed total now that we know the real duration
      updatePlaybackBar();
    };
    if (isFinite(walkupAudio.duration) && walkupAudio.duration > 0) {
      arm();
    } else {
      // Duration not loaded yet; arm once metadata arrives
      walkupAudio.addEventListener('loadedmetadata', arm, { once: true });
    }
  }

  // Walk-up has finished playing. Reset the playback flags, then auto-advance
  // the lineup pointer so the bar shows the NEXT batter as "Up Next" — but
  // don't start playing. The user just taps Play again to send them up.
  function onWalkupEnded() {
    playbackPhase = null;
    isPaused = false;
    setPlayPauseIcon(false);
    releaseWakeLock();
    stopProgressLoop();
    progressFill.style.width = '0%';
    npProgressFill.style.width = '0%';
    timeCurrent.textContent = '0:00';
    npTimeCurrent.textContent = '0:00';
    if (currentBatterIdx >= 0 && lineup.length > 0) {
      currentBatterIdx = (currentBatterIdx + 1) % lineup.length;
      showBarFromLineup();
    } else {
      // Roster preview: nothing queued up, just clear.
      currentPlayer = null;
      updatePlaybackBar();
    }
    // Between batters, kick the BT speaker every 25s so it doesn't sleep.
    startKeepalive();
  }

  function pausePlayback() {
    if (playbackPhase === 'announcement') announcementAudio.pause();
    if (!walkupAudio.paused) walkupAudio.pause();
    clearTimeout(walkupFadeTimeout);
    clearTimeout(announcementOverlapTimer);
    isPaused = true;
    setPlayPauseIcon(false);
    stopProgressLoop();
    setMediaSessionState('paused');
    startKeepalive();
  }

  function resumePlayback() {
    isPaused = false;
    if (playbackPhase === 'announcement') {
      announcementAudio.play().catch(() => {});
      scheduleAnnouncementOverlap();
    } else if (playbackPhase === 'walkup') {
      walkupAudio.play().catch(() => {});
      armWalkupFadeOut();
    }
    setPlayPauseIcon(true);
    startProgressLoop();
    setMediaSessionState('playing');
    stopKeepalive();
  }

  function stopAll() {
    clearTimeout(walkupFadeTimeout);
    clearTimeout(announcementOverlapTimer);
    cancelFades();
    try { announcementAudio.pause(); announcementAudio.currentTime = 0; } catch (_) {}
    try { walkupAudio.pause(); walkupAudio.currentTime = 0; } catch (_) {}
    walkupAudio.volume = MUSIC_FULL_VOL;
    announcementAudio.volume = 1;
    playbackPhase = null;
    isPaused = false;
    stopProgressLoop();
    setPlayPauseIcon(false);
    setMediaSessionState('none');
    startKeepalive();
  }

  // === Fade helper ===
  const activeFades = new Set();
  function fade(audio, fromVol, toVol, durationMs, onDone) {
    const start = performance.now();
    const handle = {};
    const tick = () => {
      const t = (performance.now() - start) / durationMs;
      if (t >= 1) {
        audio.volume = clamp01(toVol);
        activeFades.delete(handle);
        if (onDone) onDone();
        return;
      }
      audio.volume = clamp01(fromVol + (toVol - fromVol) * easeInOut(t));
      handle.raf = requestAnimationFrame(tick);
    };
    handle.raf = requestAnimationFrame(tick);
    activeFades.add(handle);
  }
  function cancelFades() {
    activeFades.forEach(h => cancelAnimationFrame(h.raf));
    activeFades.clear();
  }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // === Playback bar UI ===
  function updatePlaybackBar() {
    if (!currentPlayer) {
      playbackNumber.textContent = '';
      playbackName.textContent = 'No player selected';
      playbackSongName.textContent = '';
      playbackSongName.classList.add('hidden');
      playbackStatus.textContent = '';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      playPauseBtn.disabled = true;
      progressFill.style.width = '0%';
      timeCurrent.textContent = '--:--';
      timeTotal.textContent = '--:--';
      renderLineup();
      renderRoster();
      return;
    }
    playbackNumber.textContent = `#${currentPlayer.number}`;
    playbackName.textContent = `${currentPlayer.firstName} ${currentPlayer.lastName}`;
    const barLine = songLine(currentPlayer);
    if (barLine) {
      playbackSongName.textContent = barLine;
      playbackSongName.classList.remove('hidden');
    } else {
      playbackSongName.classList.add('hidden');
    }
    if (currentBatterIdx >= 0) {
      // Lineup mode: status reflects whether we're actively playing or ready
      playbackStatus.textContent = playbackPhase
        ? `Now Batting · ${currentBatterIdx + 1} of ${lineup.length}`
        : `Up Next · ${currentBatterIdx + 1} of ${lineup.length}`;
    } else {
      playbackStatus.textContent = 'Preview';
    }
    playPauseBtn.disabled = false;
    const canCycle = currentBatterIdx >= 0 && lineup.length > 1;
    prevBtn.disabled = !canCycle;
    nextBtn.disabled = !canCycle;
    timeTotal.textContent = formatTime(effectiveAtBatTotal());
    renderLineup();
    renderRoster();
    updateNowPlaying();
  }

  function setPlayPauseIcon(playing) {
    playIcon.style.display = playing ? 'none' : '';
    pauseIcon.style.display = playing ? '' : 'none';
    playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    npPlayIcon.style.display = playing ? 'none' : '';
    npPauseIcon.style.display = playing ? '' : 'none';
    npPlayPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  // === Progress loop ===
  // The bar runs the whole at-bat: announcement (ticking up from 0) → music
  // (continuing without a jump). It only pauses if both audio elements are
  // paused (announcement may be done while we're in walkup phase).
  function startProgressLoop() {
    stopProgressLoop();
    progressInterval = setInterval(() => {
      if (!playbackPhase) return;
      const isPlaying =
        (playbackPhase === 'announcement' && !announcementAudio.paused) ||
        (playbackPhase === 'walkup' && !walkupAudio.paused);
      if (!isPlaying) return;

      const total = effectiveAtBatTotal();
      const elapsed = atBatElapsed();
      const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
      progressFill.style.width = `${pct}%`;
      npProgressFill.style.width = `${pct}%`;
      const cur = formatTime(elapsed);
      const tot = formatTime(total);
      timeCurrent.textContent = cur;
      timeTotal.textContent = tot;
      npTimeCurrent.textContent = cur;
      npTimeTotal.textContent = tot;
      updateMediaPosition();
    }, 200);
  }
  function stopProgressLoop() {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  // === Helpers ===
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : text;
    return div.innerHTML;
  }

  // === Media Session — iOS Control Center / lock-screen controls ===
  // Sets the artwork (gold B on green) + title/artist for the current
  // batter, and wires play/pause/prev/next to the same lineup logic.
  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (!currentPlayer && currentBatterIdx >= 0 && lineup.length > 0) {
          const p = roster.find(x => x.number === lineup[currentBatterIdx]);
          if (p) { playPlayer(p); return; }
        }
        if (!currentPlayer) return;
        if (isPaused) resumePlayback();
        else if (!playbackPhase) playPlayer(currentPlayer);
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (playbackPhase) pausePlayback();
      });
      navigator.mediaSession.setActionHandler('previoustrack', mediaSessionPrev);
      navigator.mediaSession.setActionHandler('nexttrack', mediaSessionNext);
    } catch (_) {}
  }

  function mediaSessionPrev() {
    if (lineup.length === 0) return;
    if (currentBatterIdx < 0) currentBatterIdx = 0;
    currentBatterIdx = (currentBatterIdx - 1 + lineup.length) % lineup.length;
    const p = roster.find(x => x.number === lineup[currentBatterIdx]);
    if (p) playPlayer(p);
  }
  function mediaSessionNext() {
    if (lineup.length === 0) return;
    if (currentBatterIdx < 0) currentBatterIdx = 0;
    currentBatterIdx = (currentBatterIdx + 1) % lineup.length;
    const p = roster.find(x => x.number === lineup[currentBatterIdx]);
    if (p) playPlayer(p);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    if (!currentPlayer) {
      try { navigator.mediaSession.metadata = null; } catch (_) {}
      return;
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${currentPlayer.firstName} ${currentPlayer.lastName}`,
        artist: songLine(currentPlayer) || 'Walk-Up',
        album: 'Bloordale Bombers',
        artwork: [
          { src: 'icon-192.png?v=2', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png?v=2', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch (_) {}
  }

  function setMediaSessionState(state) {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = state; } catch (_) {}
  }

  function updateMediaPosition() {
    if (!('mediaSession' in navigator)) return;
    if (!navigator.mediaSession.setPositionState) return;
    if (!playbackPhase) return;
    const total = effectiveAtBatTotal();
    const elapsed = atBatElapsed();
    if (!isFinite(total) || total <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: total,
        position: Math.min(Math.max(0, elapsed), total),
        playbackRate: 1.0,
      });
    } catch (_) {}
  }

  // === Bluetooth speaker keepalive ===
  // Many BT speakers go into power-save / disconnect after ~30s of true
  // silence. When that happens, audio quietly routes back to the phone
  // speaker and the user has no idea. This plays a very quiet, very
  // short tone every 25 seconds while no real audio is playing to keep
  // the link active.
  let keepaliveCtx = null;
  let keepaliveTimer = null;
  const KEEPALIVE_INTERVAL_MS = 20_000;
  // 30 Hz is below most consumer speakers' usable response curve and below
  // the typical 40-50 Hz lower edge of human pitch perception. At a gain of
  // 0.0005 (-66 dBFS) it's effectively silent — but the BT codec still
  // sees a non-zero waveform and won't trigger the speaker's silence gate.
  const KEEPALIVE_TONE_HZ = 30;
  const KEEPALIVE_TONE_GAIN = 0.0005;
  const KEEPALIVE_TONE_S = 0.25;

  function ensureKeepaliveCtx() {
    if (keepaliveCtx) return keepaliveCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) keepaliveCtx = new Ctx();
    } catch (_) {}
    return keepaliveCtx;
  }

  function playKeepaliveTone() {
    const ctx = ensureKeepaliveCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = KEEPALIVE_TONE_HZ;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(KEEPALIVE_TONE_GAIN, now + 0.02);
      gain.gain.linearRampToValueAtTime(0.0001, now + KEEPALIVE_TONE_S);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + KEEPALIVE_TONE_S + 0.05);
    } catch (_) {}
  }

  function startKeepalive() {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(playKeepaliveTone, KEEPALIVE_INTERVAL_MS);
  }

  function stopKeepalive() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  // === Wake Lock (best-effort) ===
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) {}
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playbackPhase) acquireWakeLock();
  });

  // === Go ===
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
