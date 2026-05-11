import SwiftUI

struct RosterView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(model.roster) { p in
                        Button { model.previewFromRoster(p) } label: {
                            RosterCard(player: p, isActive: isActive(p))
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal)
                    }
                }
                .padding(.vertical)
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Roster")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { BrandTitle() }
            }
        }
    }

    private func isActive(_ p: Player) -> Bool {
        model.currentPlayer?.number == p.number && model.phase != .idle
    }
}

private struct RosterCard: View {
    let player: Player
    let isActive: Bool

    var body: some View {
        HStack(spacing: 14) {
            Text(player.jerseyLabel)
                .font(.system(.title3, design: .rounded).weight(.heavy))
                .foregroundStyle(isActive ? BloordaleTheme.gold : BloordaleTheme.muted)
                .frame(width: 54, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(player.fullName)
                    .font(.system(.body, design: .rounded).weight(.semibold))
                    .foregroundStyle(.white)
                if let song = player.song {
                    Text(song)
                        .font(.caption)
                        .foregroundStyle(BloordaleTheme.muted)
                        .lineLimit(1)
                }
            }
            Spacer()
            Image(systemName: "play.fill")
                .foregroundStyle(BloordaleTheme.gold)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isActive ? BloordaleTheme.green.opacity(0.45) : BloordaleTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isActive ? BloordaleTheme.gold : .clear, lineWidth: 2)
        )
    }
}
