import SwiftUI

struct MiniPlayerBar: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        if let p = model.currentPlayer {
                            Text(p.jerseyLabel)
                                .font(.system(.subheadline, design: .rounded).weight(.heavy))
                                .foregroundStyle(BloordaleTheme.gold)
                            Text(p.fullName)
                                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                        } else {
                            Text("No player selected")
                                .foregroundStyle(BloordaleTheme.muted)
                                .font(.subheadline)
                        }
                    }
                    if let song = model.currentPlayer?.song {
                        Text(song)
                            .font(.caption2)
                            .foregroundStyle(BloordaleTheme.muted)
                            .lineLimit(1)
                    }
                    if !model.statusText.isEmpty {
                        Text(model.statusText)
                            .font(.caption2)
                            .foregroundStyle(BloordaleTheme.muted)
                    }
                }
                Spacer()
                Image(systemName: "chevron.up")
                    .foregroundStyle(BloordaleTheme.muted)
            }

            HStack(spacing: 24) {
                Button { model.navigate(by: -1) } label: {
                    Image(systemName: "backward.fill").imageScale(.large)
                }
                .disabled(!model.canCycle)

                Button { model.togglePlayPauseFromTransport() } label: {
                    ZStack {
                        Circle().fill(BloordaleTheme.gold).frame(width: 48, height: 48)
                        Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 20, weight: .heavy))
                            .foregroundStyle(BloordaleTheme.green)
                    }
                }
                .disabled(model.currentPlayer == nil)

                Button { model.navigate(by: 1) } label: {
                    Image(systemName: "forward.fill").imageScale(.large)
                }
                .disabled(!model.canCycle)
            }
            .tint(BloordaleTheme.gold)

            ProgressBar(progress: progressFraction)
                .frame(height: 4)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
    }

    private var progressFraction: Double {
        guard model.totalDuration > 0 else { return 0 }
        return min(1, max(0, model.elapsed / model.totalDuration))
    }
}

struct ProgressBar: View {
    let progress: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(BloordaleTheme.gold)
                    .frame(width: max(0, CGFloat(progress) * geo.size.width))
            }
        }
    }
}
