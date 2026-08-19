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
  // Deezer previews are 30 seconds and we play ten of them, so a track can be
  // set to start anywhere in the first twenty — the hook is rarely at the top
  // of the preview. Clamped against the real duration at play time in case a
  // preview ever comes back shorter than the nominal thirty seconds.
  const DEEZER_PREVIEW_S = 30;
  const MAX_CLIP_START_S = DEEZER_PREVIEW_S - DEEZER_CLIP_DURATION_S;
  const FADE_IN_S = 0.3;            // soft fade-in when music starts (never cuts)
  const FADE_OUT_S = 1.5;           // soft fade-out at the end of any clip
  const OVERLAP_S = 1.2;            // start music this many seconds before announcement ends

  // Every song carries a measured gain that brings it to one shared level:
  // library clips get theirs from library.json (scripts/measure_song_gain.py),
  // Deezer previews are measured in the browser when they're downloaded. Before
  // that, these two multipliers meant something different for every song — the
  // library alone spans 13 dB — so ducking was a guess per player. Now they mean
  // the same thing for everyone: full level, and the level music sits at while
  // the announcement is still talking.
  const MUSIC_FULL_VOL = 1.0;
  // ≈ -14 dB under the song's own full level. Set from measurement, not taste:
  // the announcements run -16 to -19 dB mean and songs sit at -14 dB after their
  // gain, so this puts the bed around -28 dB and leaves the spoken name about
  // 12 dB clear of it — a broadcast-ish ratio. The old -9 dB left only 6 dB,
  // which is muddy even when the ducking works. This is the one number to change
  // if music should sit further under the voice, or closer to it.
  const MUSIC_DUCKED_VOL = 0.2;
  const MUSIC_RAMP_S = 0.9;         // ramp from ducked → full once announcement ends
  // Where the measured gains aim. Keep in step with scripts/measure_song_gain.py.
  const TARGET_MEAN_DBFS = -14;
  // A Deezer track saved before gains existed, or one whose measurement failed.
  // Modern masters run hot — around -8 dB mean — so assume that rather than
  // letting an unmeasured track play at full level over the announcement.
  const UNMEASURED_SONG_GAIN = 0.5;

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

  // A player can carry up to three walk-up songs, one of which is playing.
  // Saved as { [playerNumber]: { songs: [pick, ...], active: <index> } }, where
  // a pick is either a library entry — { src: 'library', file } — or a Deezer
  // track carrying everything needed to show and play it offline. A player with
  // nothing saved has exactly one song: their default from roster.json.
  //
  // Three is the cap because it is what a coach can hold in their head between
  // innings, and because the picker has to fit on a phone next to the batter's
  // name without pushing the transport off the screen.
  const MAX_SONGS_PER_PLAYER = 3;
  const SONGS_KEY = 'walkup-simple-picks';

  let playerSongs = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SONGS_KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch (_) { /* fall through to the migration */ }
    return migrateLegacySongSelections();
  })();

  // Deezer previews live in IndexedDB keyed by track id; this holds the object
  // URLs hydrated for this session. Keyed by track id and not by player,
  // because the same track can now sit in more than one player's list — two
  // brothers picking the same song should not mean two downloads.
  const deezerBlobUrls = {};

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
  const npSongPicks = document.getElementById('np-song-picks');
  const npLastUp = document.getElementById('np-last-up');
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
    applySongSelections();

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

    bindSunoPlayer();
    bindSoundboard();
    bindCollapsibleSections();
    // Fire-and-forget: the Sounds tab fills in as soon as the manifest lands.
    loadSunoPlaylist();

    bindTabs();
    bindTransport();
    bindNowPlaying();
    bindAudioEvents();
    bindSettings();
    bindMediaSession();
    bindDeezerModal();
    bindAudioUnlock();

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
    if (tabName !== 'settings') stopPreview();

    if (pushUrl) {
      // Anchor URL to the GitHub Pages base path so /walkup-music/lineup works,
      // but a local file:// or root deploy gets clean /lineup paths too.
      const base = location.pathname.replace(/\/(lineup|roster|sounds|music|settings)\/?$/, '');
      const next = base.replace(/\/$/, '') + '/' + tabName;
      try {
        history.pushState({ tab: tabName }, '', next);
      } catch (_) { /* ignore history errors (e.g., file://) */ }
    }
  }

  function tabFromUrl() {
    const m = location.pathname.match(/\/(lineup|roster|sounds|music|settings)\/?$/);
    if (!m) return 'lineup';
    // /music is what the Sounds tab used to be called. Keep the old path
    // working: it's the one anyone who added the app to their home screen
    // while sitting on that tab has bookmarked.
    return m[1] === 'music' ? 'sounds' : m[1];
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

  // === Sounds tab — between-innings playlists ==============================
  //
  // Two music sources, each clearly badged (the soundboard that sits above
  // them on the same tab is further down this file):
  //
  //   Spotify — a link out, nothing more. Their iframe embed caps playback at
  //             30-second previews unless the listener is signed in with
  //             Premium, which is useless for filling an inning break, so the
  //             card is just the badge and an Open button.
  //   Suno    — their playlist pages send `frame-ancestors 'none'`, so there
  //             is no embed to drop in and their API sends no CORS headers
  //             either. scripts/sync_suno_playlist.py mirrors the playlist
  //             into audio/suno/ + suno-playlist.json at build time, and the
  //             app plays those files itself. That is what lets between-
  //             innings music work on a field with no signal.

  let sunoPlaylist = null;         // { name, url, tracks: [...] }
  let sunoIdx = -1;                // index into sunoPlaylist.tracks; -1 = idle
  let sunoProgressRaf = null;

  const sunoAudio = document.getElementById('suno-audio');
  const sunoTracksEl = document.getElementById('suno-tracks');
  const sunoOpenEl = document.getElementById('suno-open');

  async function loadSunoPlaylist() {
    if (!sunoTracksEl) return;
    try {
      const resp = await fetch('suno-playlist.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      sunoPlaylist = await resp.json();
    } catch (e) {
      console.warn('Suno playlist unavailable', e);
      sunoTracksEl.innerHTML =
        '<div class="src-offline">Playlist unavailable.</div>';
      return;
    }
    if (sunoOpenEl && sunoPlaylist.url) sunoOpenEl.href = sunoPlaylist.url;
    renderSunoTracks();
  }

  function renderSunoTracks() {
    if (!sunoTracksEl || !sunoPlaylist) return;
    const tracks = sunoPlaylist.tracks || [];

    if (!tracks.length) {
      sunoTracksEl.innerHTML = '<div class="src-offline">No songs in this playlist yet.</div>';
      return;
    }

    sunoTracksEl.innerHTML = '';
    tracks.forEach((track, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'track-row';
      row.dataset.idx = String(i);

      const art = track.art
        ? `<img class="track-art" src="${track.art}" alt="" loading="lazy" decoding="async">`
        : '<span class="track-art"></span>';

      // Subtext is the caption written on the song in Suno, or nothing. Style
      // tags are deliberately not shown: they describe the generator, not the
      // song, and a row with just its title reads better than one labelled
      // "pop rap, hip hop, rap".
      const sub = (track.caption || '').trim();

      row.innerHTML = `
        ${art}
        <span class="track-meta">
          <span class="track-title">${escapeHtml(track.title)}</span>
          ${sub ? `<span class="track-sub">${escapeHtml(sub)}</span>` : ''}
        </span>
        <span class="track-dur">${track.duration ? formatTime(track.duration) : ''}</span>
        <span class="track-play">
          <svg class="track-icon-idle" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          <svg class="track-icon-active" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>
        </span>`;

      row.addEventListener('click', () => toggleSunoTrack(i));
      sunoTracksEl.appendChild(row);

      // Hairline progress bar, revealed only while this track is playing.
      const prog = document.createElement('div');
      prog.className = 'track-progress hidden';
      prog.innerHTML = '<div class="track-progress-fill"></div>';
      sunoTracksEl.appendChild(prog);
    });
    syncSunoRows();
  }

  function toggleSunoTrack(i) {
    if (i === sunoIdx && !sunoAudio.paused) {
      sunoAudio.pause();
      syncSunoRows();
      return;
    }
    if (i === sunoIdx && sunoAudio.paused && sunoAudio.currentTime > 0) {
      playSunoAudio();
      return;
    }
    playSunoTrack(i);
  }

  function playSunoTrack(i) {
    const tracks = (sunoPlaylist && sunoPlaylist.tracks) || [];
    const track = tracks[i];
    if (!track) return;

    // Between-innings music never talks over a batter, the team intro or a
    // soundboard stinger.
    stopSfx();
    stopBatterPlayback();

    sunoIdx = i;
    if (!audioHasSrc(sunoAudio, track.file)) {
      sunoAudio.src = track.file;
      try { sunoAudio.load(); } catch (_) {}
    }
    // Right after load() the element has no timeline yet, and iOS throws
    // InvalidStateError on a currentTime write in that state. Unguarded, that
    // exception happens before play() and the track silently never starts.
    try { sunoAudio.currentTime = 0; } catch (_) {}
    sunoAudio.volume = 1;   // no-op on iOS (hardware-controlled), harmless
    playSunoAudio();
  }

  function playSunoAudio() {
    const p = sunoAudio.play();
    if (p && p.catch) p.catch((e) => console.warn('Suno playback failed', e));
    // The keepalive tone exists to stop Bluetooth speakers sleeping between
    // batters; real audio is playing now, so it isn't needed.
    stopKeepalive();
    syncSunoRows();
  }

  // Stop everything the Sounds tab owns — between-innings music and anything
  // on the soundboard. Called whenever a batter takes the speakers. (Spotify plays in its own app, so there is nothing of ours to
  // stop there — the phone's own audio focus handles that.)
  function stopBetweenInnings() {
    stopSunoPlayback();
    stopSfx();
  }

  function stopSunoPlayback() {
    if (!sunoAudio) return;
    if (!sunoAudio.paused) {
      try { sunoAudio.pause(); } catch (_) {}
    }
    sunoIdx = -1;
    try { sunoAudio.currentTime = 0; } catch (_) {}
    syncSunoRows();
  }

  // Hand the speakers over from an at-bat to whatever the Sounds tab is about
  // to play. The lineup pointer is left where it was, so the bar keeps showing
  // the same batter, now as Up Next.
  function stopBatterPlayback() {
    if (!playbackPhase && !isPaused) return;
    stopAll();
    if (currentBatterIdx >= 0 && lineup.length > 0) showBarFromLineup();
    else updatePlaybackBar();
  }

  // Reflect playback state on the rows: play/pause icon, gold highlight, and
  // the progress hairline under the active track.
  function syncSunoRows() {
    if (!sunoTracksEl) return;
    const playing = sunoAudio && !sunoAudio.paused && sunoIdx >= 0;
    setSectionPlaying('suno-card', playing);
    sunoTracksEl.querySelectorAll('.track-row').forEach((row) => {
      const i = Number(row.dataset.idx);
      const isCurrent = i === sunoIdx;
      row.classList.toggle('playing', isCurrent && playing);
      const idleIcon = row.querySelector('.track-icon-idle');
      const activeIcon = row.querySelector('.track-icon-active');
      if (idleIcon) idleIcon.style.display = isCurrent && playing ? 'none' : '';
      if (activeIcon) activeIcon.style.display = isCurrent && playing ? '' : 'none';
      const prog = row.nextElementSibling;
      if (prog && prog.classList.contains('track-progress')) {
        prog.classList.toggle('hidden', !isCurrent);
        if (!isCurrent) {
          const fill = prog.querySelector('.track-progress-fill');
          if (fill) fill.style.width = '0%';
        }
      }
    });
    if (playing) startSunoProgress(); else stopSunoProgress();
  }

  function startSunoProgress() {
    if (sunoProgressRaf) return;
    const tick = () => {
      const row = sunoTracksEl && sunoTracksEl.querySelector('.track-row.playing');
      const fill = row && row.nextElementSibling
        ? row.nextElementSibling.querySelector('.track-progress-fill')
        : null;
      if (fill && sunoAudio.duration) {
        fill.style.width = `${(sunoAudio.currentTime / sunoAudio.duration) * 100}%`;
      }
      sunoProgressRaf = requestAnimationFrame(tick);
    };
    sunoProgressRaf = requestAnimationFrame(tick);
  }

  function stopSunoProgress() {
    if (sunoProgressRaf) cancelAnimationFrame(sunoProgressRaf);
    sunoProgressRaf = null;
  }

  function bindSunoPlayer() {
    if (!sunoAudio) return;
    // Roll into the next song so a whole inning break plays unattended, and
    // stop cleanly at the end of the list.
    sunoAudio.addEventListener('ended', () => {
      const tracks = (sunoPlaylist && sunoPlaylist.tracks) || [];
      const next = sunoIdx + 1;
      if (next < tracks.length) {
        playSunoTrack(next);
      } else {
        sunoIdx = -1;
        syncSunoRows();
        startKeepalive();
      }
    });
    sunoAudio.addEventListener('pause', () => { syncSunoRows(); startKeepalive(); });
    sunoAudio.addEventListener('play', syncSunoRows);
    sunoAudio.addEventListener('error', () => {
      console.warn('Suno audio error', sunoAudio.currentSrc);
    });
  }

  // === Soundboard — one-shot ballpark stingers ==============================
  //
  // Everything a coach fires by hand: the team intro that opens the game, then
  // the organ stabs. The stingers are mirrored into audio/sfx/ from
  // myinstants.com (source page listed with each entry) for the same reason the
  // Suno tracks are mirrored — one that has to buffer lands after the moment it
  // was for, and the field has no signal. The intro is our own recording.
  //
  // Ordered shortest first, because length is what separates these in use: the
  // three-second call punctuates a play, the long ones fill a gap. Durations
  // are measured (ffprobe) rather than read at runtime, so a row can show its
  // length without the app fetching files it may never play.
  //
  // The intro comes first because it is the one you play before anything else
  // happens; the stingers below it are ordered shortest first, since length is
  // what separates those in use.
  //
  // Their names are what the clips actually are, which is not what the source
  // pages called them. Five were downloaded; two were the same bugle charge call
  // as the first stinger here, a whole tone lower, so they were dropped rather
  // than shipped as three rows that sound the same. Filenames match the names,
  // so the directory reads the way the tab does.
  const SOUNDBOARD = [
    { file: 'audio/simple/team-intro.wav', name: 'Your Bloordale Bombers', duration: 7.2 },
    { file: 'audio/sfx/charge.mp3', name: 'Charge', duration: 2.9,
      source: 'https://www.myinstants.com/en/instant/homerun-baseball-71397/' },
    { file: 'audio/sfx/charge-climb.mp3', name: 'Charge (Climb)', duration: 13.0,
      source: 'https://www.myinstants.com/en/instant/baseball-charge-organ-13865/' },
    { file: 'audio/sfx/lets-go-bombers.mp3', name: "Let's Go Bombers", duration: 15.2,
      source: 'https://www.myinstants.com/en/instant/charge-baseball-organ-68015/' },
  ];

  let sfxIdx = -1;                 // index into SOUNDBOARD; -1 = nothing firing
  let sfxProgressRaf = null;

  const sfxAudio = document.getElementById('sfx-audio');
  const sfxListEl = document.getElementById('sfx-list');

  // Every stinger gets the same glyph in the slot where a Suno track carries
  // its cover art, so the two lists sit under each other with one rhythm.
  const SFX_GLYPH =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/>' +
    '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

  function renderSoundboard() {
    if (!sfxListEl) return;
    sfxListEl.innerHTML = '';
    SOUNDBOARD.forEach((sound, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'track-row';
      row.dataset.idx = String(i);
      // Whole seconds, not m:ss. Every stinger is shorter than a pitch, and
      // "3s" reads faster than "0:03" at a glance.
      row.innerHTML = `
        <span class="track-art track-art--glyph" aria-hidden="true">${SFX_GLYPH}</span>
        <span class="track-meta">
          <span class="track-title">${escapeHtml(sound.name)}</span>
        </span>
        <span class="track-dur">${Math.round(sound.duration)}s</span>
        <span class="track-play">
          <svg class="track-icon-idle" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          <svg class="track-icon-active" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
        </span>`;
      row.addEventListener('click', () => toggleSfx(i));
      sfxListEl.appendChild(row);

      // Hairline progress bar, revealed only while this stinger is playing.
      const prog = document.createElement('div');
      prog.className = 'track-progress hidden';
      prog.innerHTML = '<div class="track-progress-fill"></div>';
      sfxListEl.appendChild(prog);
    });
    syncSfxRows();
  }

  // Tapping a row that is already playing stops it. A stinger is short enough
  // that re-triggering it mid-play is rarely what you want, and the long organ
  // charges are exactly the ones you sometimes need to cut off. The icon says
  // so: a square, not a pause bar, because there is nothing to resume.
  function toggleSfx(i) {
    if (i === sfxIdx && sfxAudio && !sfxAudio.paused) {
      stopSfx();
      return;
    }
    playSfx(i);
  }

  // A stinger takes the speakers outright: between-innings music, the team
  // intro and any at-bat in progress all stop. One thing plays at a time
  // everywhere else in the app, and a horn layered over a walk-up is mud.
  function playSfx(i) {
    const sound = SOUNDBOARD[i];
    if (!sound || !sfxAudio) return;

    stopSunoPlayback();
    stopBatterPlayback();

    sfxIdx = i;
    if (!audioHasSrc(sfxAudio, sound.file)) {
      sfxAudio.src = sound.file;
      try { sfxAudio.load(); } catch (_) {}
    }
    // Right after load() the element has no timeline yet, and iOS throws
    // InvalidStateError on a currentTime write in that state — unguarded, the
    // throw happens before play() and the pad silently does nothing.
    try { sfxAudio.currentTime = 0; } catch (_) {}
    sfxAudio.volume = 1;   // no-op on iOS (hardware-controlled), harmless
    const p = sfxAudio.play();
    if (p && p.catch) p.catch((e) => console.warn('Soundboard playback failed', e));
    // Real audio is playing, so the Bluetooth keepalive tone isn't needed.
    stopKeepalive();
    syncSfxRows();
  }

  function stopSfx() {
    if (!sfxAudio) return;
    if (!sfxAudio.paused) {
      try { sfxAudio.pause(); } catch (_) {}
    }
    sfxIdx = -1;
    try { sfxAudio.currentTime = 0; } catch (_) {}
    syncSfxRows();
  }

  // Reflect playback state on the rows: play/stop icon, gold highlight, and
  // the progress hairline under the stinger that's firing.
  function syncSfxRows() {
    if (!sfxListEl) return;
    const playing = sfxAudio && !sfxAudio.paused && sfxIdx >= 0;
    setSectionPlaying('soundboard-card', playing);
    sfxListEl.querySelectorAll('.track-row').forEach((row) => {
      const i = Number(row.dataset.idx);
      const sound = SOUNDBOARD[i];
      const isCurrent = i === sfxIdx && playing;
      row.classList.toggle('playing', isCurrent);
      row.setAttribute('aria-label',
        `${isCurrent ? 'Stop' : 'Play'} ${sound ? sound.name : 'sound'}`);
      const idleIcon = row.querySelector('.track-icon-idle');
      const activeIcon = row.querySelector('.track-icon-active');
      if (idleIcon) idleIcon.style.display = isCurrent ? 'none' : '';
      if (activeIcon) activeIcon.style.display = isCurrent ? '' : 'none';
      const prog = row.nextElementSibling;
      if (prog && prog.classList.contains('track-progress')) {
        prog.classList.toggle('hidden', !isCurrent);
        if (!isCurrent) {
          const fill = prog.querySelector('.track-progress-fill');
          if (fill) fill.style.width = '0%';
        }
      }
    });
    if (playing) startSfxProgress(); else stopSfxProgress();
  }

  function startSfxProgress() {
    if (sfxProgressRaf) return;
    const tick = () => {
      const row = sfxListEl && sfxListEl.querySelector('.track-row.playing');
      const fill = row && row.nextElementSibling
        ? row.nextElementSibling.querySelector('.track-progress-fill')
        : null;
      if (fill && sfxAudio.duration) {
        fill.style.width = `${(sfxAudio.currentTime / sfxAudio.duration) * 100}%`;
      }
      sfxProgressRaf = requestAnimationFrame(tick);
    };
    sfxProgressRaf = requestAnimationFrame(tick);
  }

  function stopSfxProgress() {
    if (sfxProgressRaf) cancelAnimationFrame(sfxProgressRaf);
    sfxProgressRaf = null;
  }

  function bindSoundboard() {
    renderSoundboard();
    if (!sfxAudio) return;
    // One-shots: nothing rolls on to the next pad when a stinger ends.
    sfxAudio.addEventListener('ended', () => {
      sfxIdx = -1;
      syncSfxRows();
      startKeepalive();
    });
    sfxAudio.addEventListener('pause', () => { syncSfxRows(); startKeepalive(); });
    sfxAudio.addEventListener('play', syncSfxRows);
    sfxAudio.addEventListener('error', () => {
      console.warn('Soundboard audio error', sfxAudio.currentSrc);
    });
  }

  // === Collapsible source cards ============================================
  //
  // The Sounds tab stacks a soundboard and two playlists, and mid-game a coach
  // wants one of them, not all three. Folding a card shut pulls the others up
  // the screen and within thumb reach. The choice is saved per card: whoever
  // closes the playlist to get the stingers to the top wants them there next
  // inning too.
  //
  // Collapsing does not stop anything that's playing — you might well fold the
  // playlist away while it plays to reach a stinger — so a closed card that is
  // still making noise shows a gold dot in its header, which is the only cue
  // left once its rows are hidden.
  let collapsedSections = (() => {
    try { return JSON.parse(localStorage.getItem('walkup-simple-collapsed') || '{}') || {}; }
    catch (_) { return {}; }
  })();

  function bindCollapsibleSections() {
    document.querySelectorAll('.src-toggle').forEach((btn) => {
      const card = btn.closest('.src-card');
      const name = btn.dataset.section;
      if (!card || !name) return;

      setSectionCollapsed(card, name, !!collapsedSections[name], { save: false });

      // The whole header is the hit target, not just the chevron — but the
      // Open link sitting inside it still has to open its app. The chevron is
      // a real button, so it comes along for free: its click bubbles up here.
      const head = card.querySelector('.src-head');
      if (!head) return;
      head.addEventListener('click', (e) => {
        if (e.target.closest('.src-link')) return;
        setSectionCollapsed(card, name, !card.classList.contains('collapsed'));
      });
    });
  }

  function setSectionCollapsed(card, name, collapsed, opts = {}) {
    const { save = true } = opts;
    card.classList.toggle('collapsed', collapsed);

    const btn = card.querySelector('.src-toggle');
    if (btn) {
      const nameEl = card.querySelector('.src-name');
      const what = nameEl ? nameEl.textContent.trim() : 'section';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${what}`);
    }

    if (!save) return;
    collapsedSections[name] = collapsed;
    try {
      localStorage.setItem('walkup-simple-collapsed', JSON.stringify(collapsedSections));
    } catch (_) { /* storage full / disabled — ignore */ }
  }

  // Mark a card as having audio going, for the dot that shows while it's
  // folded shut. Called from both lists' sync functions.
  function setSectionPlaying(cardId, playing) {
    const card = document.getElementById(cardId);
    if (card) card.classList.toggle('has-playing', !!playing);
  }

  // === Per-player songs ====================================================
  // The library (loaded from audio/simple/library.json) is the single source of
  // truth for library songs. Each entry: { file, song, artist?, explicit? }.
  // Players have a default walkup file path in roster.json; the displayed title
  // is looked up from the library so roster + library can't drift.
  let songLibrary = [];

  function findLibraryEntry(file) {
    return songLibrary.find(s => s.file === file) || null;
  }

  // Each player gets a `_defaultWalkup` / `_defaultSong` / `_defaultArtist`
  // snapshot taken before any selection is applied, so we can always show /
  // switch back to their original.
  function snapshotSongDefaults() {
    roster.forEach(p => {
      p._defaultWalkup = p.walkup;
      const entry = findLibraryEntry(p.walkup);
      p._defaultSong = entry ? entry.song : '(no title)';
      p._defaultArtist = entry ? (entry.artist || '') : '';
      p._defaultExplicit = entry ? !!entry.explicit : false;
      p.song = p._defaultSong;
      p.artist = p._defaultArtist;
      p.explicit = p._defaultExplicit;
    });
  }

  // Until this build a player had exactly one chosen song: a library file under
  // 'walkup-simple-songs', or a Deezer track under 'walkup-simple-deezer' which
  // took precedence over it. Carry whichever was in force across as the
  // player's first and only song, so nobody's picks vanish on upgrade. The old
  // keys are left where they are — they cost nothing and make a rollback to the
  // previous build harmless.
  function migrateLegacySongSelections() {
    const read = (key) => {
      try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
      catch (_) { return {}; }
    };
    const out = {};
    const libraryChoices = read('walkup-simple-songs');
    Object.keys(libraryChoices).forEach((num) => {
      const file = libraryChoices[num];
      if (file) out[num] = { songs: [{ src: 'library', file }], active: 0 };
    });
    const deezerChoices = read('walkup-simple-deezer');
    Object.keys(deezerChoices).forEach((num) => {
      const e = deezerChoices[num];
      if (!e || !e.trackId) return;
      out[num] = { songs: [{ src: 'deezer', ...e }], active: 0 };
    });
    if (Object.keys(out).length) {
      try { localStorage.setItem(SONGS_KEY, JSON.stringify(out)); } catch (_) {}
    }
    return out;
  }

  // A pick is only worth keeping if it can still be resolved: a library file
  // that has left library.json is dead weight, and so is a Deezer entry with no
  // track id.
  function isUsablePick(pick, player) {
    if (!pick) return false;
    if (pick.src === 'deezer') return !!pick.trackId;
    if (pick.src === 'library') {
      return !!findLibraryEntry(pick.file) ||
             (!!player && pick.file === player._defaultWalkup);
    }
    return false;
  }

  // A player's songs, validated: at least one, never more than the cap, with
  // `active` pointing at a real entry. Unresolvable picks are dropped here
  // rather than at save time, so an edit to library.json can't strand anyone
  // on a song that no longer exists.
  function songsFor(player) {
    const saved = playerSongs[player.number];
    const raw = Array.isArray(saved && saved.songs) ? saved.songs : [];
    const savedActive = Number.isInteger(saved && saved.active) ? saved.active : 0;
    const list = [];
    let active = 0;
    raw.slice(0, MAX_SONGS_PER_PLAYER).forEach((pick, i) => {
      if (!isUsablePick(pick, player)) return;
      if (i === savedActive) active = list.length;   // active follows its own song
      list.push(pick);
    });
    if (!list.length) {
      return { list: [{ src: 'library', file: player._defaultWalkup }], active: 0 };
    }
    return { list, active: Math.min(active, list.length - 1) };
  }

  // Everything the UI needs to say what one song is, whichever source it came
  // from. One call, so no screen has to know about library-vs-Deezer.
  function pickInfo(pick, player) {
    if (pick && pick.src === 'deezer') {
      return {
        title: pick.title || 'Untitled',
        artist: pick.artist || '',
        explicit: !!pick.explicit,
        art: pick.artUrl || '',
        file: null,
        deezer: true,
      };
    }
    const file = (pick && pick.file) || (player && player._defaultWalkup) || '';
    const lib = findLibraryEntry(file);
    if (lib) {
      return {
        title: lib.song,
        artist: lib.artist || '',
        explicit: !!lib.explicit,
        art: '',
        file,
        deezer: false,
      };
    }
    return {
      title: (player && player._defaultSong) || '(no title)',
      artist: (player && player._defaultArtist) || '',
      explicit: !!(player && player._defaultExplicit),
      art: '',
      file,
      deezer: false,
    };
  }

  function samePick(a, b) {
    if (!a || !b || a.src !== b.src) return false;
    return a.src === 'deezer'
      ? String(a.trackId) === String(b.trackId)
      : a.file === b.file;
  }

  // Materialise every player's active song onto the player object, which is
  // what the rest of the app reads: p.walkup / p.song / p.artist / p.explicit,
  // plus p._songs + p._activeSongIdx for the two pickers.
  function applySongSelections() {
    roster.forEach(p => {
      const { list, active } = songsFor(p);
      p._songs = list;
      p._activeSongIdx = active;
      p._deezerTrack = null;

      const pick = list[active];
      const info = pickInfo(pick, p);

      if (pick.src === 'deezer') {
        const url = deezerBlobUrls[pick.trackId];
        if (url) {
          p.walkup = url;
          p.song = info.title;
          p.artist = info.artist;
          p.explicit = info.explicit;
          p._deezerTrack = pick;
          return;
        }
        // The preview isn't on this device: a fresh install, cleared storage, or
        // a download that failed. Play and label the roster default rather than
        // showing a title we can't sound; the settings row offers a re-download.
        p.walkup = p._defaultWalkup;
        p.song = p._defaultSong;
        p.artist = p._defaultArtist;
        p.explicit = p._defaultExplicit;
        p._deezerTrack = { ...pick, _missing: true };
        return;
      }

      p.walkup = info.file || p._defaultWalkup;
      p.song = info.title;
      p.artist = info.artist;
      p.explicit = info.explicit;
    });
  }

  function saveSongs() {
    try { localStorage.setItem(SONGS_KEY, JSON.stringify(playerSongs)); }
    catch (_) { /* storage full / disabled — the session still works */ }
  }

  // The one way a player's songs change. Writes, re-materialises, refreshes
  // every surface that shows a title, and — if this is the batter at the plate
  // and the change swapped what is loaded — restarts the music on the new song.
  function writePlayerSongs(playerNumber, list, active) {
    const p = roster.find(x => x.number === playerNumber);
    const before = p ? p.walkup : null;

    playerSongs[playerNumber] = {
      songs: list.slice(0, MAX_SONGS_PER_PLAYER),
      active: Math.max(0, Math.min(active, list.length - 1)),
    };
    saveSongs();
    applySongSelections();

    renderSongOptionsList();
    renderAvailable();
    if (p && currentPlayer && currentPlayer.number === playerNumber) {
      currentPlayer = p;
      updatePlaybackBar();     // also re-renders lineup, roster and Now Playing
      updateMediaSession();
      if (!playbackPhase) preloadForPlayer(currentPlayer);
      if (playbackPhase && p.walkup !== before) restartWalkupWithActiveSong();
    } else {
      renderLineup();
      renderRoster();
      updateNowPlaying();
    }
  }

  // Switching songs for the batter at the plate takes effect now, not next time
  // up: tapping another song mid-at-bat means "play this one instead". Only the
  // music restarts — the announcement is already out of the speaker and saying
  // the kid's name twice would be worse than a hard cut.
  function restartWalkupWithActiveSong() {
    if (!currentPlayer) return;
    const wasPlaying = !walkupAudio.paused;
    clearTimeout(walkupFadeTimeout);
    cancelFades();
    if (currentPlayer.walkup) {
      walkupAudio.src = currentPlayer.walkup;
      try { walkupAudio.load(); } catch (_) {}
    }
    // iOS throws InvalidStateError writing currentTime straight after load();
    // seekWalkupToStart swallows that and re-arms once metadata lands.
    seekWalkupToStart();
    // Paused, or the announcement is still running solo in sequential mode:
    // nothing is audible to restart, and the scheduled hand-off will pick the
    // new file up on its own.
    if (isPaused || !wasPlaying) return;
    startWalkupAudio(playbackPhase === 'walkup' ? fullVol() : duckedVol());
    if (playbackPhase === 'walkup') armWalkupFadeOut();
  }

  // Make one of a player's songs the one that plays.
  function setActiveSong(playerNumber, idx) {
    const p = roster.find(x => x.number === playerNumber);
    if (!p) return;
    const { list, active } = songsFor(p);
    if (idx < 0 || idx >= list.length || idx === active) return;
    writePlayerSongs(playerNumber, list, idx);
  }

  // Library rows in Settings choose a song for a player: an unheld song is
  // added and starts playing, one they already hold is switched to. Taking a
  // song away is deliberately not here — removal lives in one place, the X on
  // the player's own list, so a mis-tap can never silently drop a pick.
  function chooseLibrarySong(playerNumber, file) {
    const p = roster.find(x => x.number === playerNumber);
    if (!p) return;
    const { list } = songsFor(p);
    const pick = { src: 'library', file };
    const at = list.findIndex(x => samePick(x, pick));
    if (at >= 0) {
      setActiveSong(playerNumber, at);
      return;
    }
    if (list.length >= MAX_SONGS_PER_PLAYER) return;
    const next = list.concat([pick]);
    writePlayerSongs(playerNumber, next, next.length - 1);
  }

  // Move where a Deezer track starts. The ten seconds we play are re-measured
  // for their new window: a track's intro and its chorus are rarely the same
  // loudness, and the level has to match the announcement either way.
  async function setSongStart(playerNumber, idx, seconds) {
    const p = roster.find(x => x.number === playerNumber);
    if (!p) return;
    const { list, active } = songsFor(p);
    const pick = list[idx];
    if (!pick || pick.src !== 'deezer') return;

    const start = Math.max(0, Math.min(MAX_CLIP_START_S, Math.round(seconds * 2) / 2));
    const next = list.slice();
    next[idx] = { ...pick, start };
    writePlayerSongs(playerNumber, next, active);

    try {
      const blob = await idbGetBlob(String(pick.trackId));
      if (!blob) return;
      const gain = await measureClipGain(pick.trackId, blob, { start });
      if (gain == null) return;
      const after = songsFor(p);
      const target = after.list[idx];
      if (!target || !samePick(target, pick)) return;   // moved on since
      const relevelled = after.list.slice();
      relevelled[idx] = { ...target, gain };
      writePlayerSongs(playerNumber, relevelled, after.active);
    } catch (err) {
      console.warn('Could not re-measure after a start change', err);
    }
  }

  function removeSongAt(playerNumber, idx) {
    const p = roster.find(x => x.number === playerNumber);
    if (!p) return;
    const { list, active } = songsFor(p);
    // Never leave a player with nothing to walk up to.
    if (list.length <= 1 || idx < 0 || idx >= list.length) return;
    const removed = list[idx];
    const next = list.slice(0, idx).concat(list.slice(idx + 1));
    // Keep playing whatever was playing; if that was the song just removed,
    // fall to whichever song took its place in the list.
    let nextActive = active;
    if (idx < active) nextActive = active - 1;
    else if (idx === active) nextActive = Math.min(active, next.length - 1);
    writePlayerSongs(playerNumber, next, nextActive);
    if (removed.src === 'deezer') pruneDeezerBlob(removed.trackId);
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

  function pickLine(info) {
    if (!info) return '';
    if (info.title && info.artist) return `${info.title} · ${info.artist}`;
    return info.title || info.artist || '';
  }

  // The small "E" explicit badge markup, or '' if the song isn't explicit.
  // Works for both library songs (explicit flag in library.json) and Deezer
  // tracks (flag carried on the saved pick); both funnel into player.explicit
  // in applySongSelections().
  function explicitBadgeHtml(player) {
    return (player && player.explicit) ? '<span class="explicit-badge" title="Explicit">E</span>' : '';
  }

  // HTML for a song label, with the explicit badge prefixed when relevant.
  // Use this anywhere the song name is shown via innerHTML so the E marker
  // appears consistently (roster, lineup, playback bar, Now Playing, etc.).
  function songLabelHtml(player) {
    return explicitBadgeHtml(player) + escapeHtml(songLine(player));
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

  // A track counts as explicit if Deezer's boolean flag is set, or its
  // lyric advisory code is "Explicit" (1) or "Partially Explicit" (4).
  // Codes: 0 not-explicit, 1 explicit, 2 unknown, 3 edited(clean),
  // 4 partially-explicit. Explicit tracks aren't hidden — they're flagged
  // with an "E" marker so the coach can choose with eyes open.
  function isExplicitTrack(t) {
    if (!t) return false;
    if (t.explicit_lyrics === true) return true;
    const code = t.explicit_content_lyrics;
    return code === 1 || code === 4;
  }

  async function searchDeezer(q) {
    if (!q || q.trim().length < 2) return [];
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q.trim())}&limit=15`;
    const data = await deezerJsonp(url);
    return (data && Array.isArray(data.data)) ? data.data : [];
  }

  // Hydrate every Deezer preview anyone refers to, deduped by track id, so a
  // song shared by two players is one download and one object URL.
  async function hydrateDeezerBlobs() {
    const ids = new Set();
    Object.keys(playerSongs).forEach((num) => {
      const entry = playerSongs[num];
      ((entry && entry.songs) || []).forEach((pick) => {
        if (pick && pick.src === 'deezer' && pick.trackId) ids.add(String(pick.trackId));
      });
    });
    await Promise.all(Array.from(ids).map(async (id) => {
      try {
        const blob = await idbGetBlob(id);
        if (!blob) return;
        deezerBlobUrls[id] = URL.createObjectURL(blob);
        await backfillDeezerGain(id, blob);
      } catch (_) { /* ignore — the player falls back to their default */ }
    }));
  }

  // Make sure a track's preview is on the device and has an object URL, and hand
  // the blob back so its level can be measured. Reuses an already-downloaded
  // blob, so re-picking a track costs nothing.
  async function ensureDeezerBlob(trackId, previewUrl) {
    const id = String(trackId);
    let blob = null;
    try { blob = await idbGetBlob(id); } catch (_) {}
    if (!blob) {
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error('Failed to fetch preview');
      blob = await res.blob();
      await idbPutBlob(id, blob);
    }
    if (!deezerBlobUrls[id]) deezerBlobUrls[id] = URL.createObjectURL(blob);
    return blob;
  }

  // Decoding a preview costs ~100 ms, and moving a start-point slider re-measures
  // the same track over and over, so the last decode is kept. One entry only: a
  // decoded 30-second preview is about 10 MB.
  let decodedClip = { trackId: null, buffer: null };

  async function decodeClip(trackId, blob) {
    const id = String(trackId);
    if (decodedClip.trackId === id && decodedClip.buffer) return decodedClip.buffer;
    const ctx = ensureAudioCtx();
    if (!ctx || !ctx.decodeAudioData) return null;
    const bytes = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    decodedClip = { trackId: id, buffer };
    return buffer;
  }

  // Measure a downloaded clip so it plays at the same level as everything else.
  // Same method as scripts/measure_song_gain.py: RMS across what we actually
  // play — which means the ten seconds from the track's start point, not the ten
  // at the top of the file — then the attenuation that brings it to the shared
  // target. Never boosts: commercial masters peak within a dB of full scale, so
  // a boost would clip.
  async function measureClipGain(trackId, blob, opts = {}) {
    const { start = 0, seconds = DEEZER_CLIP_DURATION_S } = opts;
    try {
      const audio = await decodeClip(trackId, blob);
      if (!audio) return null;
      const from = Math.max(0, Math.min(Math.floor(audio.sampleRate * start),
                                        Math.max(0, audio.length - 1)));
      const frames = Math.min(audio.length - from, Math.floor(audio.sampleRate * seconds));
      if (frames <= 0) return null;
      let sum = 0;
      let counted = 0;
      for (let ch = 0; ch < audio.numberOfChannels; ch++) {
        const data = audio.getChannelData(ch);
        for (let i = from; i < from + frames; i++) sum += data[i] * data[i];
        counted += frames;
      }
      const rms = Math.sqrt(sum / Math.max(1, counted));
      if (!(rms > 0)) return null;
      const meanDb = 20 * Math.log10(rms);
      const gain = Math.min(1, Math.pow(10, (TARGET_MEAN_DBFS - meanDb) / 20));
      return Math.round(gain * 1000) / 1000;
    } catch (err) {
      // Falls back to UNMEASURED_SONG_GAIN, which assumes a hot master.
      console.warn('Could not measure clip level', err);
      return null;
    }
  }

  // A track saved before levels were measured gets measured on the next start,
  // so an existing pick quietly comes into line instead of staying twice as loud
  // as everything else.
  async function backfillDeezerGain(trackId, blob) {
    const id = String(trackId);
    const unmeasured = [];
    Object.keys(playerSongs).forEach((num) => {
      const entry = playerSongs[num];
      ((entry && entry.songs) || []).forEach((pick) => {
        if (pick && pick.src === 'deezer' && String(pick.trackId) === id &&
            typeof pick.gain !== 'number') {
          unmeasured.push(pick);
        }
      });
    });
    if (!unmeasured.length) return;
    // Each pick can sit at a different point in the same track, so they are
    // measured over their own windows rather than sharing one number.
    let changed = false;
    for (const pick of unmeasured) {
      const gain = await measureClipGain(id, blob, { start: Number(pick.start) || 0 });
      if (gain != null) { pick.gain = gain; changed = true; }
    }
    if (changed) saveSongs();
  }

  // Turn a Deezer search result into a pick.
  function deezerPickFromTrack(track) {
    return {
      src: 'deezer',
      trackId: String(track.id),
      title: track.title_short || track.title || 'Untitled',
      artist: (track.artist && track.artist.name) || 'Unknown',
      artUrl: (track.album && (track.album.cover_medium || track.album.cover)) || '',
      previewUrl: track.preview,
      explicit: isExplicitTrack(track),
    };
  }

  // Download a Deezer preview and give it to a player as one of their songs,
  // playing straight away. A track they already hold is switched to instead of
  // being added twice.
  async function addDeezerSongForPlayer(playerNumber, track) {
    if (!track || !track.preview) throw new Error('Track has no preview URL');
    const p = roster.find(x => x.number === playerNumber);
    if (!p) return;

    const pick = deezerPickFromTrack(track);
    const { list } = songsFor(p);
    const at = list.findIndex(x => samePick(x, pick));
    if (at < 0 && list.length >= MAX_SONGS_PER_PLAYER) {
      throw new Error(`${p.firstName} already has ${MAX_SONGS_PER_PLAYER} songs — remove one first`);
    }

    const blob = await ensureDeezerBlob(pick.trackId, pick.previewUrl);
    // Measure before saving, so the very first play is already at the right
    // level relative to the announcement.
    const gain = await measureClipGain(pick.trackId, blob, { start: 0 });
    if (gain != null) pick.gain = gain;
    if (at >= 0) {
      setActiveSong(playerNumber, at);
      return;
    }
    const next = list.concat([pick]);
    writePlayerSongs(playerNumber, next, next.length - 1);
  }

  // Re-fetch a preview whose blob went missing — a new device, or storage the
  // browser evicted — without disturbing the player's list.
  async function redownloadDeezerSong(playerNumber, pick) {
    if (!pick || !pick.previewUrl) throw new Error('No preview URL saved');
    const blob = await ensureDeezerBlob(pick.trackId, pick.previewUrl);
    await backfillDeezerGain(pick.trackId, blob);
    applySongSelections();
    const p = roster.find(x => x.number === playerNumber);
    renderSongOptionsList();
    renderLineup();
    renderRoster();
    renderAvailable();
    if (p && currentPlayer && currentPlayer.number === playerNumber) {
      currentPlayer = p;
      updatePlaybackBar();
      updateMediaSession();
      if (!playbackPhase) preloadForPlayer(currentPlayer);
    } else {
      updateNowPlaying();
    }
  }

  // Drop a downloaded preview once no player refers to it any more. Called
  // after a removal, never before: a track two players share has to survive
  // one of them dropping it.
  async function pruneDeezerBlob(trackId) {
    const id = String(trackId);
    const stillUsed = Object.keys(playerSongs).some((num) => {
      const entry = playerSongs[num];
      return ((entry && entry.songs) || []).some(
        (pick) => pick && pick.src === 'deezer' && String(pick.trackId) === id);
    });
    if (stillUsed) return;
    const url = deezerBlobUrls[id];
    if (url) {
      try { URL.revokeObjectURL(url); } catch (_) {}
      delete deezerBlobUrls[id];
    }
    try { await idbDeleteBlob(id); } catch (_) {}
  }

  // Per-player accordion. Collapsed: #N, name, the song that is playing, and a
  // dot per song they hold so the count is legible without opening anything.
  // Expanded, top to bottom: the player's own songs (which one plays, and the
  // only place a song can be removed), then the ways to add another — Deezer
  // search, then the library.
  //
  // Two questions, two places to answer them. "Which of their songs plays?" is
  // answered in their own list; "which songs do they have?" is answered by
  // tapping the library. Mixing the two into one tap is how a coach ends up
  // deleting a song they meant to switch to.
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
      const { list, active } = songsFor(p);
      const isFull = list.length >= MAX_SONGS_PER_PLAYER;
      const isCustom = !samePick(list[active], { src: 'library', file: p._defaultWalkup });

      const card = document.createElement('details');
      card.className = 'song-player-card';
      card.dataset.pnum = String(p.number);
      if (expanded.has(String(p.number))) card.open = true;

      const summary = document.createElement('summary');
      summary.className = 'song-player-head';
      const dots = list
        .map((_, i) => `<i class="${i === active ? 'on' : ''}"></i>`)
        .join('');
      summary.innerHTML = `
        <span class="lineup-num">#${p.number}</span>
        <span class="song-player-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
        <span class="song-player-current ${isCustom ? 'is-custom' : ''}">
          ${songLabelHtml(p) || escapeHtml(p._defaultSong || '(no song)')}
        </span>
        <span class="song-player-dots" aria-label="${list.length} song${list.length === 1 ? '' : 's'}">${dots}</span>
        <span class="song-player-caret" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      `;
      card.appendChild(summary);

      const opts = document.createElement('div');
      opts.className = 'song-opts';

      opts.appendChild(dividerRow(
        `${p.firstName}'s songs`,
        `${list.length} of ${MAX_SONGS_PER_PLAYER}`
      ));

      // === The player's own songs — tap to switch, X to remove ===
      list.forEach((pick, i) => {
        const info = pickInfo(pick, p);
        const isActive = i === active;
        const missing = pick.src === 'deezer' && !deezerBlobUrls[pick.trackId];

        const row = document.createElement('div');
        row.className = 'song-opt song-pick' + (isActive ? ' active' : '') +
                        (missing ? ' is-missing' : '');
        row.setAttribute('role', 'radio');
        row.setAttribute('aria-checked', isActive ? 'true' : 'false');
        row.innerHTML = `
          <div class="song-pick-main">
          <button class="song-opt-preview" type="button" aria-label="Preview ${escapeHtml(info.title)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </button>
          ${info.art ? `<img class="song-opt-art" src="${escapeHtml(info.art)}" alt="" loading="lazy">` : ''}
          <span class="song-opt-title">
            <span class="song-opt-title-line">${info.explicit ? '<span class="explicit-badge" title="Explicit">E</span>' : ''}${escapeHtml(info.title)}</span>
            <span class="song-opt-sub">${escapeHtml(missing ? 'Not on this device — tap to download' : info.artist)}</span>
          </span>
          ${info.deezer && !info.art ? '<span class="song-opt-tag">Deezer</span>' : ''}
          ${isActive && !missing
            ? '<span class="song-opt-tag playing-tag">Playing</span>'
            : `<span class="song-opt-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>`}
          ${list.length > 1 ? `<button class="song-opt-remove" type="button" aria-label="Remove ${escapeHtml(info.title)} from ${escapeHtml(p.firstName)}'s songs" title="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>` : ''}
          </div>
        `;

        const previewBtn = row.querySelector('.song-opt-preview');
        const pickStart = pick.src === 'deezer' ? (Number(pick.start) || 0) : 0;
        let rangeInput = null;      // set below for Deezer rows
        const previewSrc = () => (pick.src === 'deezer'
          ? (deezerBlobUrls[pick.trackId] || pick.previewUrl)
          : info.file);
        previewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (missing) {
            redownloadDeezerSong(p.number, pick)
              .catch(err => console.warn('Redownload failed', err));
            return;
          }
          // A Deezer row auditions exactly the ten seconds the plate will hear.
          togglePreview(previewSrc(), previewBtn, pick.src === 'deezer'
            ? { start: Number(rangeInput ? rangeInput.value : pickStart) || 0,
                seconds: DEEZER_CLIP_DURATION_S }
            : {});
        });

        const removeBtn = row.querySelector('.song-opt-remove');
        if (removeBtn) {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeSongAt(p.number, i);
          });
        }

        row.addEventListener('click', (e) => {
          if (e.target.closest('.song-opt-preview') ||
              e.target.closest('.song-opt-remove') ||
              e.target.closest('.song-start')) return;
          if (missing) {
            redownloadDeezerSong(p.number, pick)
              .catch(err => console.warn('Redownload failed', err));
            return;
          }
          setActiveSong(p.number, i);
        });

        // A Deezer preview is thirty seconds and only ten of them play, so the
        // track gets a start point. Library clips are already trimmed to the
        // ten seconds someone chose, so they don't need one.
        if (pick.src === 'deezer' && !missing) {
          const startRow = document.createElement('div');
          startRow.className = 'song-start' + (isActive ? ' on-active' : '');
          startRow.innerHTML = `
            <span class="song-start-label">Starts</span>
            <input class="song-start-range" type="range"
                   min="0" max="${MAX_CLIP_START_S}" step="0.5" value="${pickStart}"
                   aria-label="Start ${escapeHtml(info.title)} this many seconds in">
            <span class="song-start-value">${formatStartLabel(pickStart)}</span>
          `;
          rangeInput = startRow.querySelector('.song-start-range');
          const valueEl = startRow.querySelector('.song-start-value');

          // Live while dragging, saved on release: a re-measure per pixel of
          // travel would decode the track dozens of times.
          rangeInput.addEventListener('input', () => {
            valueEl.textContent = formatStartLabel(Number(rangeInput.value));
          });
          rangeInput.addEventListener('change', () => {
            const seconds = Number(rangeInput.value) || 0;
            const wasAuditioning = previewBtn.classList.contains('playing');
            setSongStart(p.number, i, seconds)
              .catch(err => console.warn('Could not set start point', err));
            // Keep the audition going from the new point, so dragging and
            // listening is one loop instead of two steps.
            if (wasAuditioning) {
              stopPreview();
              togglePreview(previewSrc(), previewBtn,
                { start: seconds, seconds: DEEZER_CLIP_DURATION_S });
            }
          });
          row.appendChild(startRow);
        }

        opts.appendChild(row);
      });

      // === Ways to add another ===
      opts.appendChild(dividerRow('Add a song'));

      if (isFull) {
        const note = document.createElement('div');
        note.className = 'song-opt-note';
        note.textContent = `${MAX_SONGS_PER_PLAYER} is the limit. Remove one above to add another.`;
        opts.appendChild(note);
      }

      const searchRow = document.createElement('div');
      searchRow.className = 'song-opt song-opt-deezer-search' + (isFull ? ' is-disabled' : '');
      searchRow.setAttribute('role', 'button');
      if (isFull) {
        searchRow.setAttribute('aria-disabled', 'true');
        searchRow.setAttribute('aria-label',
          `Search Deezer — ${p.firstName} already has ${MAX_SONGS_PER_PLAYER} songs`);
      }
      searchRow.innerHTML = `
        <span class="song-opt-deezer-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>
        </span>
        <span class="song-opt-title">Search Deezer…</span>
        <span class="song-opt-tag muted">Online</span>
      `;
      if (!isFull) searchRow.addEventListener('click', () => openDeezerModal(p));
      opts.appendChild(searchRow);

      opts.appendChild(dividerRow('Library'));

      songLibrary.forEach(lib => {
        const pick = { src: 'library', file: lib.file };
        const at = list.findIndex(x => samePick(x, pick));
        const held = at >= 0;
        // 'Default' tag shows only on this player's own default song, so they
        // can see which one switches back. We don't attribute any song to other
        // players — every song is just a library entry.
        const isOwnDefault = lib.file === p._defaultWalkup;
        const blocked = !held && isFull;

        const row = document.createElement('div');
        row.className = 'song-opt' +
                        (held ? ' in-list' : '') +
                        (blocked ? ' is-disabled' : '');
        // Neither a radio nor a checkbox: tapping a library row means "give this
        // song to the player and play it", and tapping one they already hold
        // switches to it. Nothing here removes anything, so the label says what
        // the tap will actually do.
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', blocked
          ? `${lib.song} — ${p.firstName} already has ${MAX_SONGS_PER_PLAYER} songs`
          : (held
            ? `Play ${lib.song} for ${p.firstName}`
            : `Add ${lib.song} to ${p.firstName}'s songs`));
        if (blocked) row.setAttribute('aria-disabled', 'true');
        row.dataset.pnum = String(p.number);
        row.dataset.file = lib.file;

        const tags = [];
        if (isOwnDefault) tags.push('<span class="song-opt-tag">Default</span>');
        if (held) tags.push('<span class="song-opt-tag held-tag">Added</span>');

        row.innerHTML = `
          <button class="song-opt-preview" type="button" aria-label="Preview ${escapeHtml(lib.song)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </button>
          <span class="song-opt-title">
            <span class="song-opt-title-line">${lib.explicit ? '<span class="explicit-badge" title="Explicit">E</span>' : ''}${escapeHtml(lib.song)}</span>
            ${lib.artist ? `<span class="song-opt-sub">${escapeHtml(lib.artist)}</span>` : ''}
          </span>
          ${tags.join('')}
          <span class="song-opt-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>
        `;

        row.addEventListener('click', (e) => {
          if (e.target.closest('.song-opt-preview')) return;
          if (blocked) return;
          chooseLibrarySong(p.number, lib.file);
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

  // Small labelled rule between groups of rows, with an optional count on the
  // right ("2 of 3").
  function dividerRow(label, right) {
    const div = document.createElement('div');
    div.className = 'song-opts-divider';
    div.innerHTML = `<span>${escapeHtml(label)}</span>` +
      (right ? `<span class="song-opts-count">${escapeHtml(right)}</span>` : '');
    return div;
  }

  // Preview plays exactly what the plate will hear: from the track's start
  // point, for as long as the walk-up would run. Auditioning the top of a
  // preview when the walk-up begins twenty seconds in tells you nothing.
  let previewStopTimer = null;
  let previewingSrc = null;

  const PREVIEW_PLAY_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  const PREVIEW_PAUSE_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';

  function stopPreview() {
    clearTimeout(previewStopTimer);
    previewStopTimer = null;
    previewingSrc = null;
    document.querySelectorAll('.song-opt-preview.playing').forEach(b => {
      b.classList.remove('playing');
      b.innerHTML = PREVIEW_PLAY_ICON;
    });
    try { previewAudio.pause(); previewAudio.currentTime = 0; } catch (_) {}
  }

  function togglePreview(file, btn, opts = {}) {
    const { start = 0, seconds = 0 } = opts;
    const sameBtn = btn.classList.contains('playing');
    stopPreview();
    if (sameBtn) return;

    previewAudio.src = file;
    previewingSrc = file;
    const seek = () => { try { previewAudio.currentTime = start; } catch (_) {} };
    seek();
    if (start > 0 && previewAudio.readyState < 1) {
      previewAudio.addEventListener('loadedmetadata', seek, { once: true });
    }
    if (seconds > 0) {
      previewStopTimer = setTimeout(stopPreview, seconds * 1000);
    }
    btn.classList.add('playing');
    btn.innerHTML = PREVIEW_PAUSE_ICON;
    previewAudio.play().catch(() => {
      btn.classList.remove('playing');
      btn.innerHTML = PREVIEW_PLAY_ICON;
    });
  }

  // Stop preview when it ends naturally
  previewAudio.addEventListener('ended', stopPreview);

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
    if (label) {
      const held = songsFor(player).list.length;
      label.textContent =
        `For #${player.number} ${player.firstName} ${player.lastName} · ` +
        `${held} of ${MAX_SONGS_PER_PLAYER} songs`;
    }
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
      const explicitHtml = isExplicitTrack(t)
        ? '<span class="explicit-badge" title="Explicit">E</span>'
        : '';
      const row = document.createElement('div');
      row.className = 'deezer-result';
      row.innerHTML = `
        <button class="deezer-result-play" type="button" aria-label="Preview ${escapeHtml(t.title || '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        </button>
        ${art ? `<img class="deezer-result-art" src="${escapeHtml(art)}" alt="" loading="lazy">` : '<span class="deezer-result-art placeholder"></span>'}
        <span class="deezer-result-info">
          <span class="deezer-result-title">${explicitHtml}${escapeHtml(t.title_short || t.title || '')}</span>
          <span class="deezer-result-artist">${escapeHtml((t.artist && t.artist.name) || '')}</span>
        </span>
        <button class="deezer-result-use" type="button">Add</button>
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
          await addDeezerSongForPlayer(deezerModalPlayer.number, t);
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
        if (!navigator.onLine) {
          if (host) host.innerHTML = '<div class="deezer-empty">You\'re offline. Deezer search needs a connection — your saved songs still play.</div>';
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
            const msg = navigator.onLine
              ? 'Search failed. Please try again.'
              : 'You\'re offline. Deezer search needs a connection — your saved songs still play.';
            if (host) host.innerHTML = `<div class="deezer-empty error">${msg}</div>`;
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
          <span class="roster-nameline">
            <span class="roster-name">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</span>
            ${orderChipHtml(p)}
          </span>
          <span class="roster-song">${songLabelHtml(p)}</span>
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

  // === Batting order helpers ===
  // The jersey number and the spot in the order are two different numbers, and
  // "#12" is already spoken for by the jersey. Everything outside the lineup
  // list therefore shows the order as an ordinal ("3rd") so the two can never
  // be read as the same thing.
  function battingOrderPos(player) {
    if (!player) return 0;
    const i = lineup.indexOf(player.number);
    return i < 0 ? 0 : i + 1;
  }

  function ordinal(n) {
    // 11th/12th/13th are the exceptions to the 1st/2nd/3rd pattern.
    const teens = n % 100;
    if (teens >= 11 && teens <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  // Chip markup, or '' for anyone not in the order (absence reads as "not
  // batting", which is exactly what it means).
  function orderChipHtml(player) {
    const pos = battingOrderPos(player);
    return pos ? `<span class="bat-order" title="Bats ${ordinal(pos)}">${ordinal(pos)}</span>` : '';
  }

  // Views that show an order position have to be redrawn when the order
  // changes, not just the lineup list itself. (Settings → Songs deliberately
  // has no chip: that row already truncates long names on a phone, and a
  // chip there was clipped to a sliver.)
  function renderOrderDependent() {
    renderRoster();
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
          <span class="lineup-song">${songLabelHtml(p)}</span>
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
        renderOrderDependent();
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
          <span class="lineup-song">${songLabelHtml(p)}</span>
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
        } else {
          // Everyone else changes the size of the order, so the bar's
          // "Nth of M" has to be redrawn or M stays stuck at its old value.
          updatePlaybackBar();
        }
        // updatePlaybackBar (via either branch) already redraws the lineup.
        renderAvailable();
        renderOrderDependent();
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
    renderOrderDependent();
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
      renderOrderDependent();
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
      npSongPicks.innerHTML = '';
      npLastUp.innerHTML = '';
      npUpNext.innerHTML = '';
      npProgressFill.style.width = '0%';
      npTimeCurrent.textContent = '0:00';
      npTimeTotal.textContent = '0:00';
      npPrevBtn.disabled = true;
      npNextBtn.disabled = true;
      npPlayPauseBtn.disabled = true;
      return;
    }
    // Label flips between "Now Batting" (playing) and "Up Next" (idle), and
    // carries the spot in the order so the fullscreen view answers "who's up
    // and where are we in the order?" without going back to the lineup.
    const npBase = playbackPhase ? 'Now Batting' : 'Up Next';
    if (currentBatterIdx >= 0 && lineup.length > 0) {
      npCurrentLabel.textContent =
        `${npBase} · ${ordinal(currentBatterIdx + 1)} of ${lineup.length}`;
    } else {
      // Roster preview: not batting through the order, but still worth saying
      // where this player hits if they're in it.
      const pos = battingOrderPos(currentPlayer);
      npCurrentLabel.textContent = pos ? `Preview · Bats ${ordinal(pos)}` : 'Preview';
    }

    npNumber.textContent = `#${currentPlayer.number}`;
    npName.textContent = `${currentPlayer.firstName} ${currentPlayer.lastName}`;
    const npLine = songLine(currentPlayer);
    if (npLine) {
      npSongName.innerHTML = songLabelHtml(currentPlayer);
      npSongName.classList.remove('hidden');
    } else {
      npSongName.classList.add('hidden');
    }
    renderNpSongPicks();

    npPlayPauseBtn.disabled = false;
    // Order wraps, so prev/next are usable whenever there's more than one batter.
    const canCycle = currentBatterIdx >= 0 && lineup.length > 1;
    npPrevBtn.disabled = !canCycle;
    npNextBtn.disabled = !canCycle;

    // Last Up / On Deck / In The Hole — only meaningful when batting through a
    // lineup. All three are read off the order rather than off a history of
    // who actually played, so the panel always agrees with the lineup tab and
    // comes back right after a reload.
    npLastUp.innerHTML = '';
    npUpNext.innerHTML = '';
    if (currentBatterIdx >= 0 && lineup.length > 0) {
      const n = lineup.length;
      // The order wraps at both ends: after the last batter the top of the
      // order is on deck, and the leadoff hitter's "last up" is whoever bats
      // ninth.
      const spotAt = (offset) => lineup[(currentBatterIdx + offset + n) % n];
      const onDeckNum = n > 1 ? spotAt(1) : null;
      const inTheHoleNum = n > 2 ? spotAt(2) : null;
      // Who just hit. Dropped when the order is short enough that the spot
      // behind the current batter is already on screen ahead of them — in a
      // three-up order, "in the hole" and "last up" are the same player.
      const lastUpNum = n > 3 ? spotAt(-1) : null;
      if (lastUpNum != null) {
        const p = roster.find(x => x.number === lastUpNum);
        if (p) npLastUp.appendChild(makeUpNextRow('Last Up', p, 'past'));
      }
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

  // The batter's songs as chips under their name: the one playing is filled,
  // a tap switches. Each chip carries its own title rather than a number,
  // because "which song is that?" has to be answerable at arm's length in the
  // middle of an inning — and the full "Title · Artist" of whichever is chosen
  // sits directly above.
  //
  // A player with one song gets no chips at all. There is nothing to choose,
  // and an empty rail would only push the batter's name up the screen.
  function renderNpSongPicks() {
    if (!npSongPicks) return;
    npSongPicks.innerHTML = '';
    if (!currentPlayer) return;
    const songs = currentPlayer._songs || [];
    if (songs.length < 2) return;

    const active = currentPlayer._activeSongIdx || 0;
    const player = currentPlayer;
    songs.forEach((pick, i) => {
      const info = pickInfo(pick, player);
      // A Deezer song whose preview isn't on this device is drawn hollow rather
      // than filled: it is the chosen song but not the one coming out of the
      // speaker, and a filled chip would say otherwise. Tapping it fetches it.
      const missing = pick.src === 'deezer' && !deezerBlobUrls[pick.trackId];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'np-song-chip' +
                       (i === active ? ' active' : '') +
                       (missing ? ' needs-download' : '');
      chip.dataset.idx = String(i);
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', i === active && !missing ? 'true' : 'false');
      // The visible label is the title alone; the artist goes in the accessible
      // name, where there is room for it.
      chip.setAttribute('aria-label',
        (pickLine(info) || info.title) + (missing ? ' — not downloaded, tap to get it' : ''));
      chip.innerHTML = `<span class="np-song-chip-title">${escapeHtml(info.title)}</span>`;
      chip.addEventListener('click', () => {
        if (missing) {
          redownloadDeezerSong(player.number, pick)
            .catch(err => console.warn('Redownload failed', err));
          return;
        }
        setActiveSong(player.number, i);
      });
      npSongPicks.appendChild(chip);
    });
  }

  // `variant` styles a row that isn't part of what's coming up — 'past' dims
  // the batter who has already hit so they never compete with the name of the
  // batter at the plate.
  function makeUpNextRow(label, player, variant) {
    const row = document.createElement('div');
    row.className = variant ? `np-role-row np-role-row--${variant}` : 'np-role-row';
    row.innerHTML = `
      <span class="np-role-label">${label}</span>
      <span class="np-role-name">
        ${orderChipHtml(player)}<span class="np-role-num">#${player.number}</span>${escapeHtml(player.firstName)} ${escapeHtml(player.lastName)}
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
    // A batter's walk-up always wins the speakers over between-innings music.
    stopBetweenInnings();
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
    // Unlock / route the audio graph from inside the tap that starts playback:
    // on iOS this is the only moment the browser will let us take control of the
    // level (see the walk-up level section).
    resumeAudioCtx();
    ensureWalkupRouting();
    setWalkupLevel(0);             // every music entry fades in (see startWalkupAudio)
    seekWalkupToStart();

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
    fadeWalkup(walkupLevel || duckedVol(), fullVol(), MUSIC_RAMP_S * 1000);
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
    setWalkupLevel(0);
    const p = walkupAudio.play();
    if (p && p.catch) p.catch((err) => {
      console.warn('Walk-up play failed', err);
    });
    fadeWalkup(0, targetVol, FADE_IN_S * 1000);
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

  // Where in the file the current player's clip begins. Only Deezer tracks can
  // carry a start point; a library clip is already trimmed to its ten seconds.
  function walkupStartAt() {
    const start = activeSongStart(currentPlayer);
    if (!start) return 0;
    const d = walkupAudio.duration;
    // Never seek so late that there isn't a clip left to play.
    if (isFinite(d) && d > 0) return Math.max(0, Math.min(start, d - 1));
    return start;
  }

  function activeSongStart(player) {
    if (!player) return 0;
    const pick = (player._songs || [])[player._activeSongIdx || 0];
    if (!pick || pick.src !== 'deezer') return 0;
    // A pick whose audio is missing isn't what's playing — the roster default
    // is, and that starts at the top.
    if (player._deezerTrack && player._deezerTrack._missing) return 0;
    const start = Number(pick.start);
    return Number.isFinite(start) && start > 0 ? Math.min(start, MAX_CLIP_START_S) : 0;
  }

  // How far into the clip we actually play, as opposed to how far into the
  // file. The two differ whenever a track has a start point set.
  function walkupClipTime() {
    return Math.max(0, (walkupAudio.currentTime || 0) - walkupStartAt());
  }

  // Seek to the top of the clip. Metadata may not have arrived yet — seeking a
  // media element that has no timeline throws on iOS — so it's armed for the
  // moment it does.
  function seekWalkupToStart() {
    const seek = () => {
      try { walkupAudio.currentTime = walkupStartAt(); } catch (_) {}
    };
    seek();
    if (walkupAudio.readyState < 1 && walkupStartAt() > 0) {
      walkupAudio.addEventListener('loadedmetadata', seek, { once: true });
    }
  }

  // The measured level of the current player's song, 0-1. This is what makes
  // one ducking multiplier work for a hand-trimmed library clip and a
  // commercial master alike.
  function songGain(player) {
    if (!player) return 1;
    const pick = (player._songs || [])[player._activeSongIdx || 0];
    if (!pick) return libraryGain(player._defaultWalkup);
    if (pick.src === 'deezer') {
      // A Deezer pick with no audio on the device isn't what's sounding — the
      // roster default is — so use that song's gain, not this one's.
      if (player._deezerTrack && player._deezerTrack._missing) {
        return libraryGain(player._defaultWalkup);
      }
      return typeof pick.gain === 'number' ? pick.gain : UNMEASURED_SONG_GAIN;
    }
    return libraryGain(pick.file || player._defaultWalkup);
  }

  function libraryGain(file) {
    const lib = findLibraryEntry(file);
    return (lib && typeof lib.gain === 'number') ? lib.gain : 1;
  }

  // The level music sits at while the announcement is still playing, and the
  // level it ramps up to afterwards.
  function duckedVol() { return MUSIC_DUCKED_VOL * songGain(currentPlayer); }
  function fullVol() { return MUSIC_FULL_VOL * songGain(currentPlayer); }

  // The play-through length is the lesser of the configured cap and the audio
  // file's natural duration. For ~10s clips, total = ~10s; for longer songs we
  // cap at the configured ceiling and fade out before the song ends.
  function effectiveWalkupTotal() {
    const d = walkupAudio.duration;
    const cap = currentWalkupCap();
    // What's left of the file after the start point is what there is to play.
    if (isFinite(d) && d > 0) return Math.min(Math.max(0, d - walkupStartAt()), cap);
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
      const w = walkupClipTime();
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
        ? ann + walkupClipTime() - OVERLAP_S
        : walkupClipTime();
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
        (total - FADE_OUT_S - walkupClipTime()) * 1000
      );
      walkupFadeTimeout = setTimeout(() => {
        fadeWalkup(walkupLevel, 0, FADE_OUT_S * 1000, () => {
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
    // Resuming is a tap, which is the only moment iOS will let the audio graph
    // come back up if something interrupted it.
    resumeAudioCtx();
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
    setWalkupLevel(MUSIC_FULL_VOL);
    announcementAudio.volume = 1;
    playbackPhase = null;
    isPaused = false;
    stopProgressLoop();
    setPlayPauseIcon(false);
    setMediaSessionState('none');
    startKeepalive();
  }

  // === Walk-up level =======================================================
  // iOS reserves volume for the hardware buttons: assigning to
  // HTMLMediaElement.volume there does nothing and the property keeps reading
  // back 1. Every duck and every fade this app performs was therefore silent on
  // the phone it is actually used on — a song played at full level straight over
  // the spoken announcement, then stopped dead at the cap instead of fading out.
  //
  // Where the element's own volume works, keep using it: that path is the one
  // least likely to break. Where it doesn't, route the walk-up element through a
  // Web Audio gain node, which iOS does honour.
  //
  // Only the walk-up element is ever routed. A routed element reaches the
  // speakers only through the graph, and iOS suspends an AudioContext while the
  // page is backgrounded, so between-innings music, the team intro and the
  // soundboard deliberately stay on the plain path — those are the ones that
  // play unattended, and they must not depend on the context being awake.
  const canSetElementVolume = (() => {
    try {
      const probe = new Audio();
      probe.volume = 0.5;
      return Math.abs(probe.volume - 0.5) < 0.01;
    } catch (_) { return false; }
  })();

  let walkupLevel = 1;        // the level we last asked for, 0-1
  let walkupGain = null;      // gain node, once routed
  let walkupSource = null;

  // Route the walk-up element through a gain node. Only ever called from inside
  // the tap that starts playback, and only once the context is actually running:
  // routing an element into a suspended context mutes it outright, which would
  // be far worse than the loudness it is here to fix.
  function ensureWalkupRouting() {
    if (canSetElementVolume || walkupGain) return walkupGain;
    const ctx = ensureAudioCtx();
    if (!ctx || ctx.state !== 'running') return null;
    try {
      walkupSource = ctx.createMediaElementSource(walkupAudio);
      walkupGain = ctx.createGain();
      walkupGain.gain.value = walkupLevel;
      walkupSource.connect(walkupGain).connect(ctx.destination);
    } catch (err) {
      // Leaves the app on the plain path: no quieter than it was before.
      console.warn('Walk-up gain routing unavailable', err);
      walkupGain = null;
      walkupSource = null;
    }
    return walkupGain;
  }

  function setWalkupLevel(v) {
    walkupLevel = clamp01(v);
    if (walkupGain && audioCtx) {
      try {
        // A short approach rather than a step: an instant gain change on a
        // signal that is already sounding clicks.
        walkupGain.gain.setTargetAtTime(walkupLevel, audioCtx.currentTime, 0.008);
        return;
      } catch (_) { /* fall through to the element */ }
    }
    walkupAudio.volume = walkupLevel;
  }

  // Levels are, by their nature, invisible: on a phone there is no devtools and
  // no way to tell a duck that worked from one that silently did nothing — which
  // is exactly how the iOS volume problem went unnoticed for a season. This is
  // the window into it, for a Safari console attached to the phone:
  //
  //   walkupDebug()  ->  { level, routed, ctxState, canSetElementVolume, gain }
  //
  window.walkupDebug = () => ({
    level: Number(walkupLevel.toFixed(3)),
    routed: !!walkupGain,
    gainNodeValue: walkupGain ? Number(walkupGain.gain.value.toFixed(3)) : null,
    ctxState: audioCtx ? audioCtx.state : 'none',
    canSetElementVolume,
    elementVolume: walkupAudio.volume,
    songGain: currentPlayer ? songGain(currentPlayer) : null,
    song: currentPlayer ? songLine(currentPlayer) : null,
  });

  // === Fade helper ===
  // Only ever used on the walk-up, and it writes through setWalkupLevel rather
  // than touching walkupAudio.volume, because on iOS that property is inert —
  // which is why every fade in this app used to be silent there.
  const activeFades = new Set();
  function fadeWalkup(fromVol, toVol, durationMs, onDone) {
    const start = performance.now();
    const handle = {};
    const tick = () => {
      const t = (performance.now() - start) / durationMs;
      if (t >= 1) {
        setWalkupLevel(toVol);
        activeFades.delete(handle);
        if (onDone) onDone();
        return;
      }
      setWalkupLevel(fromVol + (toVol - fromVol) * easeInOut(t));
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
      playbackSongName.innerHTML = songLabelHtml(currentPlayer);
      playbackSongName.classList.remove('hidden');
    } else {
      playbackSongName.classList.add('hidden');
    }
    if (currentBatterIdx >= 0) {
      // Lineup mode: status reflects whether we're actively playing or ready
      const spot = `${ordinal(currentBatterIdx + 1)} of ${lineup.length}`;
      playbackStatus.textContent = playbackPhase
        ? `Now Batting · ${spot}`
        : `Up Next · ${spot}`;
    } else {
      // Roster preview: still say where they hit, if they're in the order.
      const pos = battingOrderPos(currentPlayer);
      playbackStatus.textContent = pos ? `Preview · Bats ${ordinal(pos)}` : 'Preview';
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
  // "0s" / "12s" / "12.5s" — plainer than a m:ss for a number under twenty.
  function formatStartLabel(seconds) {
    const s = Math.round((Number(seconds) || 0) * 2) / 2;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
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
      // Lock screen / Control Center: the album line carries the spot in the
      // order, so whoever is running the speaker can see it without unlocking.
      const pos = currentBatterIdx >= 0 && lineup.length > 0
        ? currentBatterIdx + 1
        : battingOrderPos(currentPlayer);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${currentPlayer.firstName} ${currentPlayer.lastName}`,
        artist: songLine(currentPlayer) || 'Walk-Up',
        album: pos ? `Bloordale Bombers · Batting ${ordinal(pos)}` : 'Bloordale Bombers',
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

  // === Shared AudioContext =================================================
  // One context, used by the Bluetooth keepalive tone and by the walk-up gain
  // node. Browsers hand it over suspended and only a user gesture will start it,
  // so the first tap anywhere in the app unlocks it. Without that neither the
  // keepalive tone nor the gain routing ever ran on iOS — the context sat
  // suspended for the whole game.
  let audioCtx = null;

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch (_) {}
    return audioCtx;
  }

  // Safari uses 'interrupted' as well as 'suspended' (a phone call, another app
  // taking the audio session), so anything that isn't 'running' gets a nudge.
  function resumeAudioCtx() {
    const ctx = ensureAudioCtx();
    if (!ctx || ctx.state === 'running') return;
    try {
      const p = ctx.resume();
      // The moment it comes up, take control of the walk-up level — on a first
      // tap the state often flips a beat after this call returns.
      if (p && p.then) p.then(() => { ensureWalkupRouting(); }).catch(() => {});
    } catch (_) {}
  }

  function bindAudioUnlock() {
    const unlock = () => resumeAudioCtx();
    // Capture phase and passive: this must not interfere with any handler, and
    // it stays attached because the context can be suspended again at any time.
    ['pointerdown', 'touchend', 'keydown'].forEach((evt) => {
      document.addEventListener(evt, unlock, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resumeAudioCtx();
    });
  }

  // === Bluetooth speaker keepalive ===
  // Many BT speakers go into power-save / disconnect after ~30s of true
  // silence. When that happens, audio quietly routes back to the phone
  // speaker and the user has no idea. This plays a very quiet, very
  // short tone every 25 seconds while no real audio is playing to keep
  // the link active.
  let keepaliveTimer = null;
  const KEEPALIVE_INTERVAL_MS = 20_000;
  // 30 Hz is below most consumer speakers' usable response curve and below
  // the typical 40-50 Hz lower edge of human pitch perception. At a gain of
  // 0.0005 (-66 dBFS) it's effectively silent — but the BT codec still
  // sees a non-zero waveform and won't trigger the speaker's silence gate.
  const KEEPALIVE_TONE_HZ = 30;
  const KEEPALIVE_TONE_GAIN = 0.0005;
  const KEEPALIVE_TONE_S = 0.25;

  function playKeepaliveTone() {
    const ctx = ensureAudioCtx();
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
