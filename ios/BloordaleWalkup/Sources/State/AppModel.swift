import Combine
import Foundation
import SwiftUI

/// Single source of truth for the app. Loads the roster, manages the lineup,
/// drives the WalkupPlayer, persists state to UserDefaults, and keeps the
/// lock-screen Now Playing info in sync.
@MainActor
final class AppModel: ObservableObject {

    // MARK: - Published state
    @Published private(set) var roster: [Player] = []
    @Published var lineup: [Int] = []                   // jersey numbers
    @Published private(set) var currentBatterIdx: Int = -1
    @Published var mode: PlaybackMode = .overlap {
        didSet {
            UserDefaults.standard.set(mode.rawValue, forKey: Keys.mode)
            player.setMode(mode)
        }
    }
    @Published var nowPlayingShown: Bool = false

    // MARK: - Subsystems
    let player = WalkupPlayer()
    private let nowPlaying = NowPlayingService()
    private let keepalive = KeepaliveTone()

    // MARK: - Derived
    var currentPlayer: Player? { player.currentPlayer }
    var phase: WalkupPlayer.Phase { player.phase }
    var isPaused: Bool { player.isPaused }
    var elapsed: TimeInterval { player.elapsed }
    var totalDuration: TimeInterval { player.totalDuration }

    var availablePlayers: [Player] {
        let inLineup = Set(lineup)
        return roster.filter { !inLineup.contains($0.number) }
    }

    var canCycle: Bool { currentBatterIdx >= 0 && lineup.count > 1 }

    var isPlaying: Bool { player.phase != .idle && !player.isPaused }

    var statusText: String {
        guard currentPlayer != nil else { return "" }
        if currentBatterIdx >= 0 {
            let position = "\(currentBatterIdx + 1) of \(lineup.count)"
            return player.phase != .idle
                ? "Now Batting · \(position)"
                : "Up Next · \(position)"
        }
        return "Preview"
    }

    enum Keys {
        static let lineup = "walkup-simple-lineup"
        static let mode = "walkup-simple-mode"
    }

    init() {
        loadRoster()
        loadLineup()
        loadMode()
        configureWiring()

        if !lineup.isEmpty {
            currentBatterIdx = 0
            pointBarAtCurrentBatter()
        }

        keepalive.start()
    }

    // MARK: - Wiring
    private func configureWiring() {
        AudioSessionManager.activate()
        player.setMode(mode)

        nowPlaying.onPlay = { [weak self] in self?.handlePlayCommand() }
        nowPlaying.onPause = { [weak self] in self?.player.pause() }
        nowPlaying.onToggle = { [weak self] in self?.togglePlayPauseFromTransport() }
        nowPlaying.onNext = { [weak self] in self?.remoteNext() }
        nowPlaying.onPrevious = { [weak self] in self?.remotePrevious() }
        nowPlaying.registerCommands()

        player.onPlaybackStateChanged = { [weak self] in
            guard let self = self else { return }
            self.objectWillChange.send()
            self.updateNowPlaying()
            if self.player.phase == .idle && !self.player.isPaused {
                self.keepalive.start()
            } else {
                self.keepalive.stop()
            }
        }
        player.onWalkupFinished = { [weak self] in
            self?.advanceAfterAtBat()
        }
        player.onTeamIntroChanged = { [weak self] in
            guard let self = self else { return }
            self.objectWillChange.send()
            if self.player.teamIntroPlaying { self.keepalive.stop() } else { self.keepalive.start() }
        }
    }

    // MARK: - Roster + persistence
    private func loadRoster() {
        roster = RosterLoader.load()
    }

    private func loadLineup() {
        guard let raw = UserDefaults.standard.array(forKey: Keys.lineup) as? [Int] else { return }
        let nums = Set(roster.map { $0.number })
        lineup = raw.filter { nums.contains($0) }
    }

    private func saveLineup() {
        UserDefaults.standard.set(lineup, forKey: Keys.lineup)
    }

    private func loadMode() {
        if let raw = UserDefaults.standard.string(forKey: Keys.mode),
           let m = PlaybackMode(rawValue: raw) {
            mode = m
        }
    }

    // MARK: - Lineup management
    func addToLineup(_ player: Player) {
        guard !lineup.contains(player.number) else { return }
        let wasEmpty = lineup.isEmpty
        lineup.append(player.number)
        saveLineup()
        if wasEmpty {
            currentBatterIdx = 0
            pointBarAtCurrentBatter()
        }
    }

    func remove(at offsets: IndexSet) {
        guard let first = offsets.first else { return }
        let wasPointer = first == currentBatterIdx
        lineup.remove(atOffsets: offsets)
        if lineup.isEmpty {
            player.stop()
            currentBatterIdx = -1
        } else if wasPointer {
            if player.phase != .idle || player.isPaused { player.stop(resetCurrentPlayer: false) }
            if currentBatterIdx >= lineup.count { currentBatterIdx = 0 }
            pointBarAtCurrentBatter()
        } else if currentBatterIdx > first {
            currentBatterIdx -= 1
        }
        saveLineup()
    }

    func move(from source: IndexSet, to destination: Int) {
        // Track the currently-pointed player by number so we can re-find them
        // after the reorder.
        let trackedNumber: Int? = (currentBatterIdx >= 0 && currentBatterIdx < lineup.count)
            ? lineup[currentBatterIdx]
            : nil
        lineup.move(fromOffsets: source, toOffset: destination)
        saveLineup()
        if let n = trackedNumber, let idx = lineup.firstIndex(of: n) {
            currentBatterIdx = idx
        }
    }

    func clearLineup() {
        lineup.removeAll()
        saveLineup()
        player.stop()
        currentBatterIdx = -1
    }

    // MARK: - Transport
    /// User tapped Play in the mini player / Now Playing sheet.
    func togglePlayPauseFromTransport() {
        // Idle with a lineup pointer: send the pointed-at batter up.
        if player.phase == .idle && !player.isPaused {
            if currentBatterIdx >= 0, currentBatterIdx < lineup.count {
                let num = lineup[currentBatterIdx]
                if let p = roster.first(where: { $0.number == num }) {
                    player.play(p); return
                }
            }
            // Roster preview already loaded
            if let p = currentPlayer { player.play(p); return }
            return
        }
        player.togglePlayPause()
    }

    private func handlePlayCommand() {
        if player.isPaused { player.resume(); return }
        if player.phase == .idle {
            togglePlayPauseFromTransport()
        }
    }

    /// Previous / Next from in-app transport: stop playback, move the pointer
    /// (with wraparound), and show the new batter as "Up Next".
    func navigate(by delta: Int) {
        guard !lineup.isEmpty else { return }
        if player.phase != .idle || player.isPaused {
            player.stop(resetCurrentPlayer: false)
        }
        if currentBatterIdx < 0 { currentBatterIdx = 0 }
        currentBatterIdx = ((currentBatterIdx + delta) % lineup.count + lineup.count) % lineup.count
        pointBarAtCurrentBatter()
    }

    /// Lock-screen prev/next: same as in-app but auto-plays the new batter
    /// (matches the JS app's MediaSession behaviour).
    private func remoteNext() {
        guard !lineup.isEmpty else { return }
        if currentBatterIdx < 0 { currentBatterIdx = 0 }
        currentBatterIdx = (currentBatterIdx + 1) % lineup.count
        if let p = roster.first(where: { $0.number == lineup[currentBatterIdx] }) {
            player.play(p)
        }
    }
    private func remotePrevious() {
        guard !lineup.isEmpty else { return }
        if currentBatterIdx < 0 { currentBatterIdx = 0 }
        currentBatterIdx = (currentBatterIdx - 1 + lineup.count) % lineup.count
        if let p = roster.first(where: { $0.number == lineup[currentBatterIdx] }) {
            player.play(p)
        }
    }

    /// Tap on a lineup row → make it the current batter and play.
    func play(atLineupIndex idx: Int) {
        guard idx >= 0, idx < lineup.count else { return }
        currentBatterIdx = idx
        if let p = roster.first(where: { $0.number == lineup[idx] }) {
            player.play(p)
        }
    }

    /// Tap on a roster card → preview (not bound to a lineup index).
    func previewFromRoster(_ p: Player) {
        currentBatterIdx = -1
        player.play(p)
    }

    /// After a walk-up finishes naturally, advance the pointer to the next
    /// batter and show them as "Up Next" — don't auto-play.
    private func advanceAfterAtBat() {
        guard currentBatterIdx >= 0, !lineup.isEmpty else {
            // Roster preview: just clear.
            return
        }
        currentBatterIdx = (currentBatterIdx + 1) % lineup.count
        pointBarAtCurrentBatter()
    }

    private func pointBarAtCurrentBatter() {
        guard currentBatterIdx >= 0, currentBatterIdx < lineup.count else { return }
        let num = lineup[currentBatterIdx]
        guard let p = roster.first(where: { $0.number == num }) else { return }
        player.preload(p)
        updateNowPlaying()
    }

    // MARK: - Team intro
    func toggleTeamIntro() {
        player.playTeamIntro()
    }
    var teamIntroPlaying: Bool { player.teamIntroPlaying }

    // MARK: - On-deck / in-the-hole (for the Now Playing view)
    var onDeck: Player? {
        guard currentBatterIdx >= 0, lineup.count > 1 else { return nil }
        let idx = (currentBatterIdx + 1) % lineup.count
        return roster.first(where: { $0.number == lineup[idx] })
    }
    var inTheHole: Player? {
        guard currentBatterIdx >= 0, lineup.count > 2 else { return nil }
        let idx = (currentBatterIdx + 2) % lineup.count
        return roster.first(where: { $0.number == lineup[idx] })
    }

    // MARK: - Now Playing
    private func updateNowPlaying() {
        nowPlaying.update(
            player: currentPlayer,
            isPlaying: isPlaying,
            elapsed: player.elapsed,
            duration: player.totalDuration
        )
    }
}
