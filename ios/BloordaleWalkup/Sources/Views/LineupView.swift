import SwiftUI

struct LineupView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showClearConfirm = false
    @State private var editMode: EditMode = .inactive

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TeamIntroButton()
                        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section {
                    if model.lineup.isEmpty {
                        Text("No batters yet. Add players from the list below.")
                            .font(.subheadline)
                            .foregroundStyle(BloordaleTheme.muted)
                            .listRowBackground(BloordaleTheme.surface)
                    } else {
                        ForEach(Array(model.lineup.enumerated()), id: \.element) { idx, num in
                            if let player = model.roster.first(where: { $0.number == num }) {
                                LineupRow(index: idx, player: player)
                                    .listRowBackground(rowBackground(idx))
                                    .listRowSeparator(.hidden)
                                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                            }
                        }
                        .onMove { from, to in model.move(from: from, to: to) }
                        .onDelete { offsets in model.remove(at: offsets) }
                    }
                } header: {
                    HStack {
                        Text("Batting Order")
                            .font(.headline)
                            .foregroundStyle(BloordaleTheme.muted)
                            .textCase(nil)
                        Spacer()
                        Button(model.lineup.isEmpty ? "" : "Clear") {
                            showClearConfirm = true
                        }
                        .font(.subheadline)
                        .foregroundStyle(model.lineup.isEmpty ? .clear : Color.red)
                        .disabled(model.lineup.isEmpty)
                    }
                }

                Section {
                    if model.availablePlayers.isEmpty {
                        Text("Everyone is in the lineup.")
                            .font(.subheadline)
                            .foregroundStyle(BloordaleTheme.muted)
                            .listRowBackground(BloordaleTheme.surface.opacity(0.6))
                    } else {
                        ForEach(model.availablePlayers) { p in
                            Button { model.addToLineup(p) } label: {
                                AvailableRow(player: p)
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(BloordaleTheme.surface.opacity(0.6))
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        }
                    }
                } header: {
                    Text("Tap to add to lineup")
                        .font(.headline)
                        .foregroundStyle(BloordaleTheme.muted)
                        .textCase(nil)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Bloordale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { BrandTitle() }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if !model.lineup.isEmpty {
                        EditButton().tint(BloordaleTheme.gold)
                    }
                }
            }
            .environment(\.editMode, $editMode)
            .confirmationDialog("Clear the entire batting order?",
                                isPresented: $showClearConfirm,
                                titleVisibility: .visible) {
                Button("Clear lineup", role: .destructive) { model.clearLineup() }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private func rowBackground(_ idx: Int) -> Color {
        let isActive = model.currentBatterIdx == idx
            && model.currentPlayer?.number == model.lineup[idx]
        return isActive ? BloordaleTheme.green.opacity(0.45) : BloordaleTheme.surface
    }
}

private struct LineupRow: View {
    @EnvironmentObject private var model: AppModel
    let index: Int
    let player: Player

    private var isActive: Bool {
        model.currentBatterIdx == index && model.currentPlayer?.number == player.number
    }

    var body: some View {
        Button { model.play(atLineupIndex: index) } label: {
            HStack(spacing: 12) {
                Text("\(index + 1)")
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .frame(width: 26, alignment: .leading)
                    .foregroundStyle(isActive ? BloordaleTheme.gold : .white)
                Text(player.jerseyLabel)
                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                    .foregroundStyle(BloordaleTheme.muted)
                    .frame(width: 40, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
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
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isActive ? BloordaleTheme.gold : .clear, lineWidth: 2)
        )
    }
}

private struct AvailableRow: View {
    let player: Player
    var body: some View {
        HStack(spacing: 12) {
            Text(player.jerseyLabel)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .foregroundStyle(BloordaleTheme.muted)
                .frame(width: 40, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(player.fullName)
                    .font(.system(.body, design: .rounded).weight(.medium))
                    .foregroundStyle(.white)
                if let song = player.song {
                    Text(song)
                        .font(.caption)
                        .foregroundStyle(BloordaleTheme.muted)
                        .lineLimit(1)
                }
            }
            Spacer()
            Image(systemName: "plus.circle.fill")
                .foregroundStyle(BloordaleTheme.gold)
                .imageScale(.large)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
    }
}

private struct TeamIntroButton: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button { model.toggleTeamIntro() } label: {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(BloordaleTheme.gold)
                        .frame(width: 44, height: 44)
                    Image(systemName: model.teamIntroPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 18, weight: .heavy))
                        .foregroundStyle(BloordaleTheme.green)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your Bloordale Bombers")
                        .font(.system(.headline, design: .rounded).weight(.bold))
                        .foregroundStyle(.white)
                    Text("Team intro")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.75))
                }
                Spacer()
            }
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(BloordaleTheme.green)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct BrandTitle: View {
    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(BloordaleTheme.green)
                    .frame(width: 26, height: 26)
                Text("B")
                    .font(.system(size: 16, weight: .black, design: .serif))
                    .foregroundStyle(BloordaleTheme.gold)
            }
            VStack(alignment: .leading, spacing: -2) {
                Text("Bloordale")
                    .font(.system(.headline, design: .rounded).weight(.bold))
                Text("Bombers")
                    .font(.caption2)
                    .foregroundStyle(BloordaleTheme.muted)
            }
        }
    }
}
