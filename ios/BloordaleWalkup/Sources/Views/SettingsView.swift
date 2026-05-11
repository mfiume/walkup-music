import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Walk-Up Mode")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.white)
                    Text("How the announcement and music line up at each at-bat.")
                        .font(.subheadline)
                        .foregroundStyle(BloordaleTheme.muted)

                    VStack(spacing: 10) {
                        ForEach(PlaybackMode.allCases) { m in
                            Button { model.mode = m } label: {
                                ModeCard(mode: m, selected: model.mode == m)
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    Spacer(minLength: 32)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("About")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                        Text("Bloordale Bombers · walk-up music & announcements.")
                            .font(.subheadline)
                            .foregroundStyle(BloordaleTheme.muted)
                        Text("Built for game-day. Plays through to your Bluetooth speaker, locks the screen, and keeps the link alive between batters.")
                            .font(.caption)
                            .foregroundStyle(BloordaleTheme.muted)
                    }
                }
                .padding()
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { BrandTitle() }
            }
        }
    }
}

private struct ModeCard: View {
    let mode: PlaybackMode
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(mode.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Spacer()
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? BloordaleTheme.gold : BloordaleTheme.muted)
                        .imageScale(.large)
                }
                Text(mode.blurb)
                    .font(.caption)
                    .foregroundStyle(BloordaleTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(selected ? BloordaleTheme.green.opacity(0.4) : BloordaleTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(selected ? BloordaleTheme.gold : .clear, lineWidth: 2)
        )
    }
}
