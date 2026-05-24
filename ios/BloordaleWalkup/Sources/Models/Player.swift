import Foundation

/// A roster entry. The JSON paths point at files bundled inside the app:
/// announcements stay player-keyed (`audio/simple/announcements/<name>.wav`),
/// walk-up music lives in a shared library by song slug
/// (`audio/simple/library/<song-slug>.mp3`) and is catalogued in
/// `audio/simple/library.json`.
struct Player: Codable, Identifiable, Hashable {
    let number: Int
    let firstName: String
    let lastName: String
    /// Path-style identifier used in roster.json, e.g. "audio/simple/announcements/adrian.wav".
    let announcement: String?
    /// Library file path, e.g. "audio/simple/library/fair-trade.mp3". This is the
    /// player's *default*; users can swap to any other library entry in Settings.
    let walkup: String?
    /// Optional display title. If absent, look it up from library.json by `walkup`.
    let song: String?

    var id: Int { number }

    var fullName: String { "\(firstName) \(lastName)" }
    var jerseyLabel: String { "#\(number)" }
}

/// How the announcement and walk-up music line up during an at-bat.
enum PlaybackMode: String, CaseIterable, Identifiable {
    /// Music starts at t=0 underneath the announcement at ducked volume,
    /// then ramps to full when the announcement ends.
    case overlap
    /// Announcement plays first; music ducks in under the tail and takes over at the end.
    case sequential

    var id: String { rawValue }
    var title: String {
        switch self {
        case .overlap: return "Overlap"
        case .sequential: return "Sequential"
        }
    }
    var blurb: String {
        switch self {
        case .overlap:
            return "Music starts at t=0 underneath the announcement at low volume, then ramps to full when the announcement ends."
        case .sequential:
            return "Announcement plays first; music ducks in under the tail and takes over at the end."
        }
    }
}
