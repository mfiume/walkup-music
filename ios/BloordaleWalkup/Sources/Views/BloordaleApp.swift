import SwiftUI

@main
struct BloordaleApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(BloordaleTheme.gold)
        }
    }
}

enum BloordaleTheme {
    /// Bloordale green — matches the PWA's #1f6b34.
    static let green = Color(red: 0x1f / 255, green: 0x6b / 255, blue: 0x34 / 255)
    /// Gold accent (the B).
    static let gold = Color(red: 0xd4 / 255, green: 0xa6 / 255, blue: 0x2a / 255)
    static let surface = Color(.sRGB, white: 0.07, opacity: 1)
    static let surfaceElevated = Color(.sRGB, white: 0.12, opacity: 1)
    static let onSurface = Color.white
    static let muted = Color.white.opacity(0.55)
}
