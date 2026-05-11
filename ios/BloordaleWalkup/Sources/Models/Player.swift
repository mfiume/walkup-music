import Foundation

/// A roster entry. The JSON paths point at files bundled inside the app
/// (`audio/simple/announcements/<name>.wav`, `audio/simple/walkups-clean/<name>.mp3`).
struct Player: Codable, Identifiable, Hashable {
    let number: Int
    let firstName: String
    let lastName: String
    /// Path-style identifier used in roster.json, e.g. "audio/simple/announcements/adrian.wav".
    let announcement: String?
    /// Path-style identifier used in roster.json, e.g. "audio/simple/walkups-clean/adrian.mp3".
    let walkup: String?
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
