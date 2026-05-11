import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection: Tab = .lineup

    enum Tab: Hashable { case lineup, roster, settings }

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selection) {
                LineupView()
                    .tabItem { Label("Lineup", systemImage: "list.number") }
                    .tag(Tab.lineup)
                RosterView()
                    .tabItem { Label("Roster", systemImage: "person.3.fill") }
                    .tag(Tab.roster)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                    .tag(Tab.settings)
            }
            .tint(BloordaleTheme.gold)
            .safeAreaInset(edge: .bottom) {
                if model.currentPlayer != nil {
                    MiniPlayerBar()
                        .background(.ultraThinMaterial)
                        .onTapGesture { model.nowPlayingShown = true }
                }
            }
        }
        .sheet(isPresented: $model.nowPlayingShown) {
            NowPlayingView()
                .environmentObject(model)
                .presentationDragIndicator(.visible)
        }
    }
}
