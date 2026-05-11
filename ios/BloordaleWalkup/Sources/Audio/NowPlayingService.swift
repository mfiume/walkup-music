import MediaPlayer
import UIKit

/// Wires up the iOS Now Playing info center + lock-screen / Control Center
/// remote commands. The PWA does the equivalent via MediaSession; here we get
/// the real native treatment: scrubbable progress, jersey + name as title,
/// album art on the lock screen.
@MainActor
final class NowPlayingService {

    var onPlay: () -> Void = {}
    var onPause: () -> Void = {}
    var onNext: () -> Void = {}
    var onPrevious: () -> Void = {}
    var onToggle: () -> Void = {}

    private var registered = false

    func registerCommands() {
        guard !registered else { return }
        registered = true
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { [weak self] _ in
            self?.onPlay(); return .success
        }
        cc.pauseCommand.addTarget { [weak self] _ in
            self?.onPause(); return .success
        }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.onToggle(); return .success
        }
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.onNext(); return .success
        }
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.onPrevious(); return .success
        }
    }

    func update(player: Player?,
                isPlaying: Bool,
                elapsed: TimeInterval,
                duration: TimeInterval) {
        var info: [String: Any] = [:]
        if let player {
            info[MPMediaItemPropertyTitle] = player.fullName
            info[MPMediaItemPropertyArtist] = player.song ?? "Walk-Up"
            info[MPMediaItemPropertyAlbumTitle] = "Bloordale Bombers"
            if let image = UIImage(named: "NowPlayingArtwork") {
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                info[MPMediaItemPropertyArtwork] = artwork
            }
        }
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, min(elapsed, duration))
        }
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
