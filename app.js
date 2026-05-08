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
  const WALKUP_DURATION_S = 30;     // how long the song plays before fading
  const FADE_OUT_S = 2.5;           // fade out at end of walk-up
  const OVERLAP_S = 1.2;            // start music this many seconds before announcement ends
  const MUSIC_DUCKED_VOL = 0.35;    // music volume while announcement still playing
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

  // Reorder state
  let dragIdx = -1;

  // === DOM refs ===
  const tabs = document.querySelectorAll('.tab');
  const views = document.querySelectorAll('.view');
  const lineupList = document.getElementById('lineup-list');
  const availableList = document.getElementById('available-list');
  const clearLineupBtn = document.getElementById('clear-lineup-btn');
  const rosterView = document.getElementById('roster-view');

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

  // === Init ===
  // Unregister any stale service worker that might be intercepting fetches
  // and serving an old build. Runs once per page load.
  async function clearServiceWorkers() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
      if (regs.length) console.log('Unregistered', regs.length, 'service worker(s)');
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        if (keys.length) console.log('Cleared', keys.length, 'cache(s)');
      }
    } catch (_) { /* ignore */ }
  }

  async function init() {
    await clearServiceWorkers();

    const resp = await fetch('roster.json');
    roster = await resp.json();
    roster.sort((a, b) => a.number - b.number);

    const saved = localStorage.getItem('walkup-simple-lineup');
    if (saved) {
      try {
        const arr = JSON.parse(saved);
        const nums = new Set(roster.map(p => p.number));
        lineup = arr.filter(n => nums.has(n));
      } catch (_) { lineup = []; }
    }

    bindTabs();
    bindTransport();
    bindNowPlaying();
    bindAudioEvents();

    renderRoster();
    renderLineup();
    renderAvailable();
    updatePlaybackBar();
  }

  function saveLineup() {
    localStorage.setItem('walkup-simple-lineup', JSON.stringify(lineup));
  }

  // === Tabs ===
  function applyTabState() {
    // Belt-and-suspenders: set display directly so a stale stylesheet can't
    // leave inactive views visible.
    views.forEach(v => {
      v.style.display = v.classList.contains('active') ? 'block' : 'none';
    });
  }

  function bindTabs() {
    applyTabState(); // initial
    tabs.forEach(t => {
      t.addEventListener('click', () => {
        tabs.forEach(x => {
          x.classList.remove('active');
          x.setAttribute('aria-selected', 'false');
        });
        views.forEach(v => v.classList.remove('active'));
        t.classList.add('active');
        t.setAttribute('aria-selected', 'true');
        document.getElementById(`${t.dataset.tab}-view`).classList.add('active');
        applyTabState();
      });
    });
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
          <span class="roster-song">${escapeHtml(p.song || '')}</span>
        </span>
        <svg class="roster-play" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
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
          <span class="lineup-song">${escapeHtml(p.song || '')}</span>
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

      // Drag reorder
      row.addEventListener('dragstart', (e) => {
        dragIdx = idx;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        dragIdx = -1;
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragIdx < 0 || dragIdx === idx) return;
        const moved = lineup.splice(dragIdx, 1)[0];
        lineup.splice(idx, 0, moved);
        if (currentPlayer) {
          currentBatterIdx = lineup.indexOf(currentPlayer.number);
        }
        saveLineup();
        renderLineup();
        updatePlaybackBar();
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
          <span class="lineup-song">${escapeHtml(p.song || '')}</span>
        </span>
        <span class="add-icon">+</span>
      `;
      btn.addEventListener('click', () => {
        lineup.push(p.number);
        saveLineup();
        renderLineup();
        renderAvailable();
      });
      availableList.appendChild(btn);
    });
  }

  function removeFromLineup(idx) {
    const removingNum = lineup[idx];
    lineup.splice(idx, 1);
    if (currentPlayer && currentPlayer.number === removingNum) {
      stopAll();
      currentPlayer = null;
      currentBatterIdx = -1;
    } else if (currentPlayer) {
      currentBatterIdx = lineup.indexOf(currentPlayer.number);
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
      saveLineup();
      stopAll();
      currentPlayer = null;
      currentBatterIdx = -1;
      renderLineup();
      renderAvailable();
      updatePlaybackBar();
    });
  }

  // === Playback ===
  function bindTransport() {
    playPauseBtn.addEventListener('click', () => {
      if (!currentPlayer) return;
      if (isPaused) resumePlayback();
      else if (playbackPhase) pausePlayback();
      else playPlayer(currentPlayer); // restart
    });
    prevBtn.addEventListener('click', () => goToPrevBatter());
    nextBtn.addEventListener('click', () => advanceBatter());
  }

  // Move to the previous batter, wrapping from the top of the order to the bottom.
  function goToPrevBatter() {
    if (currentBatterIdx < 0 || lineup.length === 0) return;
    currentBatterIdx = (currentBatterIdx - 1 + lineup.length) % lineup.length;
    const p = roster.find(x => x.number === lineup[currentBatterIdx]);
    if (p) playPlayer(p);
  }

  // === Now Playing (fullscreen) ===
  function bindNowPlaying() {
    function togglePlayPause() {
      if (!currentPlayer) return;
      if (isPaused) resumePlayback();
      else if (playbackPhase) pausePlayback();
      else playPlayer(currentPlayer);
    }

    expandBtn.addEventListener('click', openNowPlaying);
    // Tapping the mini-player text area also expands
    document.getElementById('playback-info').addEventListener('click', (e) => {
      // Don't expand when tapping the expand button itself (it already handles it)
      if (e.target.closest('#expand-btn')) return;
      if (currentPlayer) openNowPlaying();
    });

    collapseBtn.addEventListener('click', closeNowPlaying);

    npPlayPauseBtn.addEventListener('click', togglePlayPause);
    npPrevBtn.addEventListener('click', () => goToPrevBatter());
    npNextBtn.addEventListener('click', () => advanceBatter());

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
    npNumber.textContent = `#${currentPlayer.number}`;
    npName.textContent = `${currentPlayer.firstName} ${currentPlayer.lastName}`;
    if (currentPlayer.song) {
      npSongName.textContent = currentPlayer.song;
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

    // Pre-load the walk-up so we can start it overlapping the announcement
    walkupAudio.src = player.walkup || '';
    walkupAudio.volume = MUSIC_DUCKED_VOL;
    walkupAudio.currentTime = 0;
    try { walkupAudio.load(); } catch (_) {}

    if (player.announcement) {
      playbackPhase = 'announcement';
      announcementAudio.src = player.announcement;
      announcementAudio.volume = 1.0;
      announcementAudio.currentTime = 0;
      announcementAudio.play().then(() => {
        scheduleAnnouncementOverlap();
      }).catch(err => {
        console.warn('Announcement play failed, going straight to walk-up', err);
        startWalkup();
      });
    } else {
      startWalkup();
    }

    acquireWakeLock();
    setPlayPauseIcon(true);
    startProgressLoop();
    updatePlaybackBar();
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

    // Music starts ducked under the tail of the announcement. Announcement
    // continues at full volume until its file ends; no soft fade.
    walkupAudio.volume = MUSIC_DUCKED_VOL;
    walkupAudio.play().catch(() => {});
  }

  function onAnnouncementEnded() {
    if (playbackPhase !== 'announcement') return;
    playbackPhase = 'walkup';
    if (walkupAudio.paused && walkupAudio.src) {
      walkupAudio.play().catch(() => {});
    }
    fade(walkupAudio, walkupAudio.volume || MUSIC_DUCKED_VOL, MUSIC_FULL_VOL, MUSIC_RAMP_S * 1000);
    armWalkupFadeOut();
  }

  function startWalkup() {
    playbackPhase = 'walkup';
    walkupAudio.volume = MUSIC_FULL_VOL;
    walkupAudio.play().catch(err => {
      console.warn('Walk-up play failed', err);
    });
    armWalkupFadeOut();
  }

  // The play-through length is the lesser of WALKUP_DURATION_S and the audio
  // file's natural duration. For ~10s clips, total = ~10s; for longer songs we
  // cap at WALKUP_DURATION_S and fade out before the song ends.
  function effectiveWalkupTotal() {
    const d = walkupAudio.duration;
    if (isFinite(d) && d > 0) return Math.min(d, WALKUP_DURATION_S);
    return WALKUP_DURATION_S;
  }

  function armWalkupFadeOut() {
    clearTimeout(walkupFadeTimeout);
    const arm = () => {
      clearTimeout(walkupFadeTimeout);
      const total = effectiveWalkupTotal();
      // Only schedule a fade-out if the song is longer than our cap. For short
      // clips (≤ cap), let them play to their natural end via the 'ended' event.
      if (!isFinite(walkupAudio.duration) || walkupAudio.duration > WALKUP_DURATION_S) {
        const fadeStartMs = Math.max(0, (total - FADE_OUT_S) * 1000);
        walkupFadeTimeout = setTimeout(() => {
          fade(walkupAudio, walkupAudio.volume, 0, FADE_OUT_S * 1000, () => {
            walkupAudio.pause();
            onWalkupEnded();
          });
        }, fadeStartMs);
      }
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

  function onWalkupEnded() {
    playbackPhase = null;
    setPlayPauseIcon(false);
    releaseWakeLock();
    stopProgressLoop();
    progressFill.style.width = '0%';
    timeCurrent.textContent = '0:00';
    timeTotal.textContent = formatTime(effectiveWalkupTotal());
    renderLineup();
    renderRoster();
  }

  function advanceBatter() {
    stopAll();
    if (currentBatterIdx < 0 || lineup.length === 0) {
      onWalkupEnded();
      return;
    }
    // Batting order wraps: after the last batter, the top of the order bats again.
    currentBatterIdx = (currentBatterIdx + 1) % lineup.length;
    const p = roster.find(x => x.number === lineup[currentBatterIdx]);
    if (p) playPlayer(p);
  }

  function pausePlayback() {
    if (playbackPhase === 'announcement') announcementAudio.pause();
    if (!walkupAudio.paused) walkupAudio.pause();
    clearTimeout(walkupFadeTimeout);
    clearTimeout(announcementOverlapTimer);
    isPaused = true;
    setPlayPauseIcon(false);
    stopProgressLoop();
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
    if (currentPlayer.song) {
      playbackSongName.textContent = currentPlayer.song;
      playbackSongName.classList.remove('hidden');
    } else {
      playbackSongName.classList.add('hidden');
    }
    playbackStatus.textContent = currentBatterIdx >= 0
      ? `Batting ${currentBatterIdx + 1} of ${lineup.length}`
      : 'Preview';
    playPauseBtn.disabled = false;
    const canCycle = currentBatterIdx >= 0 && lineup.length > 1;
    prevBtn.disabled = !canCycle;
    nextBtn.disabled = !canCycle;
    timeTotal.textContent = formatTime(effectiveWalkupTotal());
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

  // === Progress loop (just walk-up phase) ===
  function startProgressLoop() {
    stopProgressLoop();
    progressInterval = setInterval(() => {
      if (playbackPhase === 'walkup' && !walkupAudio.paused) {
        const total = effectiveWalkupTotal();
        const elapsed = walkupAudio.currentTime;
        const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
        progressFill.style.width = `${pct}%`;
        npProgressFill.style.width = `${pct}%`;
        const cur = formatTime(elapsed);
        const tot = formatTime(total);
        timeCurrent.textContent = cur;
        timeTotal.textContent = tot;
        npTimeCurrent.textContent = cur;
        npTimeTotal.textContent = tot;
      } else if (playbackPhase === 'announcement') {
        progressFill.style.width = '0%';
        npProgressFill.style.width = '0%';
        timeCurrent.textContent = '0:00';
        npTimeCurrent.textContent = '0:00';
      }
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
