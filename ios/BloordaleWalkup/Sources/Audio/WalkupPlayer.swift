import AVFoundation
import Combine
import Foundation

/// Drives the announcement → walk-up music pipeline for a single at-bat.
///
/// Mirrors the JS app's two modes:
///   - Overlap: music starts at t=0 at ducked volume, ramps to full when
///     the announcement ends.
///   - Sequential: announcement plays alone; music ducks in `OVERLAP_S` seconds
///     before the end and takes over.
///
/// The walk-up music plays for at most `WALKUP_DURATION_S`, with a
/// `FADE_OUT_S`-second fade at the tail (only if the song is longer than the cap;
/// short clips play to their natural end).
@MainActor
final class WalkupPlayer: NSObject, ObservableObject {

    // MARK: - Tunables (kept in sync with app.js)
    static let walkupDurationSeconds: TimeInterval = 30
    static let fadeOutSeconds: TimeInterval = 2.5
    static let overlapSeconds: TimeInterval = 1.2
    static let musicDuckedVolume: Float = 0.35
    static let musicFullVolume: Float = 1.0
    static let musicRampSeconds: TimeInterval = 0.9

    enum Phase: Equatable {
        case idle
        case announcement
        case walkup
    }

    // MARK: - Published state
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var isPaused: Bool = false
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var totalDuration: TimeInterval = 0
    @Published private(set) var currentPlayer: Player?

    var isActive: Bool { phase != .idle || isPaused }

    // MARK: - State
    private var mode: PlaybackMode = .overlap
    private var announcement: AVAudioPlayer?
    private var walkup: AVAudioPlayer?
    private var teamIntro: AVAudioPlayer?

    private var progressTimer: Timer?
    private var fadeTimer: Timer?
    private var overlapStartTimer: Timer?
    private var walkupFadeOutTimer: Timer?

    // MARK: - Callbacks
    /// Called when an at-bat finishes naturally so the controller can advance
    /// the batting order pointer.
    var onWalkupFinished: (() -> Void)?
    /// Called whenever play/pause state flips so the controller can update
    /// Now Playing info on the lock screen.
    var onPlaybackStateChanged: (() -> Void)?

    // MARK: - Mode
    func setMode(_ mode: PlaybackMode) {
        self.mode = mode
    }

    // MARK: - Preload
    /// Loads (but doesn't play) a player's audio so the first tap on Play is
    /// instant — same trick the JS app uses to keep lock-screen start times
    /// from stalling for a second.
    func preload(_ player: Player) {
        guard player.number != currentPlayer?.number || announcement == nil else { return }
        if let path = player.announcement, let url = RosterLoader.bundleURL(forResourcePath: path) {
            announcement = try? AVAudioPlayer(contentsOf: url)
            announcement?.prepareToPlay()
            announcement?.delegate = self
        } else {
            announcement = nil
        }
        if let path = player.walkup, let url = RosterLoader.bundleURL(forResourcePath: path) {
            walkup = try? AVAudioPlayer(contentsOf: url)
            walkup?.prepareToPlay()
            walkup?.delegate = self
        } else {
            walkup = nil
        }
        currentPlayer = player
    }

    // MARK: - Play / Pause / Stop
    func play(_ player: Player) {
        stop(resetCurrentPlayer: false)
        currentPlayer = player

        // Make sure the audio session is hot before we hit play, otherwise
        // the first sample can come out the wrong route on a fresh BT link.
        AudioSessionManager.activate()

        // (Re)load files if they changed.
        loadIfNeeded(player: player)

        guard let walkup else {
            // No music — nothing to do.
            phase = .idle
            return
        }
        walkup.currentTime = 0
        walkup.volume = Self.musicDuckedVolume

        if let announcement {
            announcement.currentTime = 0
            announcement.volume = 1.0
            phase = .announcement
            isPaused = false
            announcement.play()
            switch mode {
            case .overlap:
                // Music plays from t=0 ducked under the announcement.
                walkup.currentTime = 0
                walkup.volume = Self.musicDuckedVolume
                walkup.play()
            case .sequential:
                // Schedule music to start `overlapSeconds` before the announcement ends.
                scheduleSequentialOverlap()
            }
        } else {
            startWalkup()
        }

        startProgressTimer()
        recomputeTotal()
        onPlaybackStateChanged?()
    }

    func togglePlayPause() {
        guard let currentPlayer else { return }
        if phase == .idle && !isPaused {
            play(currentPlayer)
            return
        }
        if isPaused {
            resume()
        } else {
            pause()
        }
    }

    func pause() {
        guard phase != .idle else { return }
        announcement?.pause()
        walkup?.pause()
        cancelTimers()
        isPaused = true
        stopProgressTimer()
        onPlaybackStateChanged?()
    }

    func resume() {
        guard isPaused else { return }
        switch phase {
        case .announcement:
            announcement?.play()
            if mode == .sequential {
                scheduleSequentialOverlap()
            } else {
                walkup?.play()
            }
        case .walkup:
            walkup?.play()
            armWalkupFadeOut()
        case .idle:
            break
        }
        isPaused = false
        startProgressTimer()
        onPlaybackStateChanged?()
    }

    func stop(resetCurrentPlayer: Bool = true) {
        cancelTimers()
        stopProgressTimer()
        announcement?.stop()
        announcement?.currentTime = 0
        announcement?.volume = 1.0
        walkup?.stop()
        walkup?.currentTime = 0
        walkup?.volume = Self.musicFullVolume
        phase = .idle
        isPaused = false
        elapsed = 0
        if resetCurrentPlayer {
            currentPlayer = nil
            totalDuration = 0
        }
        onPlaybackStateChanged?()
    }

    // MARK: - Team intro (one-shot, owns the speakers)
    private(set) var teamIntroPlaying: Bool = false {
        didSet { onTeamIntroChanged?() }
    }
    var onTeamIntroChanged: (() -> Void)?

    func playTeamIntro() {
        if teamIntroPlaying {
            teamIntro?.stop()
            teamIntroPlaying = false
            return
        }
        // Stop any in-progress at-bat — the intro takes over.
        if phase != .idle || isPaused { stop(resetCurrentPlayer: false) }
        AudioSessionManager.activate()
        if teamIntro == nil,
           let url = RosterLoader.bundleURL(forResourcePath: "audio/simple/team-intro.wav") {
            teamIntro = try? AVAudioPlayer(contentsOf: url)
            teamIntro?.delegate = self
            teamIntro?.prepareToPlay()
        }
        guard let teamIntro else { return }
        teamIntro.currentTime = 0
        teamIntro.volume = 1.0
        teamIntro.play()
        teamIntroPlaying = true
    }

    // MARK: - Loaders
    private func loadIfNeeded(player: Player) {
        if let path = player.announcement,
           let url = RosterLoader.bundleURL(forResourcePath: path),
           announcement?.url != url {
            announcement = try? AVAudioPlayer(contentsOf: url)
            announcement?.delegate = self
            announcement?.prepareToPlay()
        } else if player.announcement == nil {
            announcement = nil
        }
        if let path = player.walkup,
           let url = RosterLoader.bundleURL(forResourcePath: path),
           walkup?.url != url {
            walkup = try? AVAudioPlayer(contentsOf: url)
            walkup?.delegate = self
            walkup?.prepareToPlay()
        } else if player.walkup == nil {
            walkup = nil
        }
    }

    // MARK: - Phase transitions
    private func scheduleSequentialOverlap() {
        cancelTimer(&overlapStartTimer)
        guard let announcement, let walkup else { return }
        let dur = announcement.duration
        let startMusicAt = max(0, dur - Self.overlapSeconds)
        let fireIn = max(0, startMusicAt - announcement.currentTime)
        overlapStartTimer = Timer.scheduledTimer(withTimeInterval: fireIn, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, self.phase == .announcement else { return }
                walkup.currentTime = 0
                walkup.volume = Self.musicDuckedVolume
                walkup.play()
            }
        }
    }

    private func startWalkup() {
        phase = .walkup
        guard let walkup else { return }
        walkup.volume = Self.musicFullVolume
        walkup.play()
        armWalkupFadeOut()
        onPlaybackStateChanged?()
    }

    /// Called when the announcement reaches its end. Music ramps to full and we
    /// arm the tail fade.
    private func handleAnnouncementEnded() {
        guard phase == .announcement else { return }
        phase = .walkup
        if let walkup {
            if !walkup.isPlaying { walkup.play() }
            fade(walkup, from: walkup.volume, to: Self.musicFullVolume, duration: Self.musicRampSeconds)
        }
        armWalkupFadeOut()
        onPlaybackStateChanged?()
    }

    private func armWalkupFadeOut() {
        cancelTimer(&walkupFadeOutTimer)
        guard let walkup else { return }
        let total = min(walkup.duration, Self.walkupDurationSeconds)
        // Only schedule a fade if the song is longer than our cap. Short clips
        // play to their natural end via the delegate callback.
        guard walkup.duration > Self.walkupDurationSeconds else { return }
        let fadeStartIn = max(0, total - Self.fadeOutSeconds - walkup.currentTime)
        walkupFadeOutTimer = Timer.scheduledTimer(withTimeInterval: fadeStartIn, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, let walkup = self.walkup else { return }
                self.fade(walkup, from: walkup.volume, to: 0, duration: Self.fadeOutSeconds) { [weak self] in
                    Task { @MainActor in
                        guard let self = self else { return }
                        walkup.pause()
                        self.finishAtBat()
                    }
                }
            }
        }
    }

    private func finishAtBat() {
        cancelTimers()
        stopProgressTimer()
        phase = .idle
        isPaused = false
        elapsed = 0
        // Reset volumes so the next batter starts clean.
        walkup?.volume = Self.musicFullVolume
        announcement?.volume = 1.0
        onPlaybackStateChanged?()
        onWalkupFinished?()
    }

    // MARK: - Progress
    private func startProgressTimer() {
        stopProgressTimer()
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }

    private func tick() {
        elapsed = computeElapsed()
        totalDuration = computeTotalDuration()
    }

    private func recomputeTotal() {
        totalDuration = computeTotalDuration()
    }

    private func computeTotalDuration() -> TimeInterval {
        let walk = min(walkup?.duration ?? 0, Self.walkupDurationSeconds)
        let ann = announcement?.duration ?? 0
        guard ann > 0 else { return walk }
        switch mode {
        case .overlap:
            return max(ann, walk)
        case .sequential:
            return ann + walk - Self.overlapSeconds
        }
    }

    private func computeElapsed() -> TimeInterval {
        switch mode {
        case .overlap:
            return max(walkup?.currentTime ?? 0, announcement?.currentTime ?? 0)
        case .sequential:
            if phase == .announcement {
                return announcement?.currentTime ?? 0
            }
            if phase == .walkup {
                let ann = announcement?.duration ?? 0
                let w = walkup?.currentTime ?? 0
                return ann > 0 ? ann + w - Self.overlapSeconds : w
            }
            return 0
        }
    }

    // MARK: - Fades
    private func fade(_ player: AVAudioPlayer,
                      from start: Float,
                      to end: Float,
                      duration: TimeInterval,
                      onComplete: (() -> Void)? = nil) {
        let steps = max(1, Int(duration / 0.04))
        let stepDuration = duration / Double(steps)
        var step = 0
        cancelTimer(&fadeTimer)
        fadeTimer = Timer.scheduledTimer(withTimeInterval: stepDuration, repeats: true) { [weak self, weak player] timer in
            guard let self = self, let player = player else { timer.invalidate(); return }
            step += 1
            let t = Float(step) / Float(steps)
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            player.volume = max(0, min(1, start + (end - start) * eased))
            if step >= steps {
                timer.invalidate()
                self.fadeTimer = nil
                onComplete?()
            }
        }
    }

    // MARK: - Timer cleanup
    private func cancelTimers() {
        cancelTimer(&overlapStartTimer)
        cancelTimer(&walkupFadeOutTimer)
        cancelTimer(&fadeTimer)
    }

    private func cancelTimer(_ t: inout Timer?) {
        t?.invalidate()
        t = nil
    }
}

// MARK: - AVAudioPlayerDelegate
extension WalkupPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        // AVAudioPlayer fires this on an arbitrary thread. Hop to the main
        // actor before touching any of our state.
        let finished = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if let a = self.announcement, ObjectIdentifier(a) == finished {
                self.handleAnnouncementEnded()
            } else if let w = self.walkup, ObjectIdentifier(w) == finished {
                self.finishAtBat()
            } else if let t = self.teamIntro, ObjectIdentifier(t) == finished {
                self.teamIntroPlaying = false
            }
        }
    }
}
