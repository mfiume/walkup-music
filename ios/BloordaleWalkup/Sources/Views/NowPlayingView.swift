import SwiftUI

struct NowPlayingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [BloordaleTheme.green, .black],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 20) {
                topBar
                Spacer(minLength: 0)
                batterBlock
                upNextStack
                progressBlock
                transportRow
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 20)
        }
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "chevron.down")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .padding(8)
            }
            Spacer()
            Text(model.phase != .idle ? "Now Batting" : "Up Next")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.8))
                .textCase(.uppercase)
                .tracking(2)
            Spacer()
            Color.clear.frame(width: 44, height: 44)
        }
    }

    private var batterBlock: some View {
        VStack(spacing: 8) {
            if let p = model.currentPlayer {
                Text(p.jerseyLabel)
                    .font(.system(size: 64, weight: .black, design: .rounded))
                    .foregroundStyle(BloordaleTheme.gold)
                Text(p.fullName)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                if let song = p.song {
                    Text(song)
                        .font(.headline)
                        .foregroundStyle(.white.opacity(0.7))
                }
            } else {
                Text("No player selected")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
    }

    private var upNextStack: some View {
        VStack(spacing: 8) {
            if let onDeck = model.onDeck {
                UpNextRow(role: "On Deck", player: onDeck)
            }
            if let hole = model.inTheHole {
                UpNextRow(role: "In The Hole", player: hole)
            }
        }
    }

    private var progressBlock: some View {
        VStack(spacing: 6) {
            ProgressBar(progress: progressFraction)
                .frame(height: 5)
            HStack {
                Text(formatTime(model.elapsed))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.75))
                Spacer()
                Text(formatTime(model.totalDuration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
    }

    private var transportRow: some View {
        HStack(spacing: 36) {
            Button { model.navigate(by: -1) } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.white)
            }
            .disabled(!model.canCycle)

            Button { model.togglePlayPauseFromTransport() } label: {
                ZStack {
                    Circle().fill(BloordaleTheme.gold).frame(width: 88, height: 88)
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 36, weight: .heavy))
                        .foregroundStyle(BloordaleTheme.green)
                }
            }
            .disabled(model.currentPlayer == nil)

            Button { model.navigate(by: 1) } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.white)
            }
            .disabled(!model.canCycle)
        }
        .padding(.vertical, 8)
    }

    private var progressFraction: Double {
        guard model.totalDuration > 0 else { return 0 }
        return min(1, max(0, model.elapsed / model.totalDuration))
    }

    private func formatTime(_ s: TimeInterval) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        let m = Int(s) / 60
        let sec = Int(s) % 60
        return String(format: "%d:%02d", m, sec)
    }
}

private struct UpNextRow: View {
    let role: String
    let player: Player
    var body: some View {
        HStack {
            Text(role.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(1.5)
                .foregroundStyle(.white.opacity(0.65))
            Spacer()
            HStack(spacing: 6) {
                Text(player.jerseyLabel)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(BloordaleTheme.gold)
                Text(player.fullName)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.white.opacity(0.08))
        )
    }
}
