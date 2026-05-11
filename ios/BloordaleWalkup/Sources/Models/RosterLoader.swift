import Foundation

enum RosterLoader {
    /// Reads the bundled `roster.json` and returns the players sorted by jersey number.
    static func load() -> [Player] {
        guard let url = Bundle.main.url(forResource: "roster", withExtension: "json") else {
            assertionFailure("roster.json missing from bundle")
            return []
        }
        do {
            let data = try Data(contentsOf: url)
            let players = try JSONDecoder().decode([Player].self, from: data)
            return players.sorted { $0.number < $1.number }
        } catch {
            assertionFailure("Failed to decode roster.json: \(error)")
            return []
        }
    }

    /// Resolves a roster path (e.g. "audio/simple/announcements/adrian.wav") to the
    /// bundled file URL. The PWA serves these via relative URLs; in the iOS bundle
    /// they're flattened into the Audio resource group, so we look up by filename
    /// and fall back to a sub-directory search.
    static func bundleURL(forResourcePath path: String) -> URL? {
        let filename = (path as NSString).lastPathComponent
        let stem = (filename as NSString).deletingPathExtension
        let ext = (filename as NSString).pathExtension
        // Audio resources are added with `path: Resources/Audio` so the
        // subdirectory layout is preserved inside the bundle.
        let subdirs = [
            "Audio/Announcements",
            "Audio/Walkups",
            "Audio/TeamIntro",
            "Audio"
        ]
        for sub in subdirs {
            if let url = Bundle.main.url(forResource: stem, withExtension: ext, subdirectory: sub) {
                return url
            }
        }
        // Last resort: flat lookup.
        return Bundle.main.url(forResource: stem, withExtension: ext)
    }
}
