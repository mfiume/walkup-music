# Bloordale Walk-Up · iOS

Native SwiftUI port of the Bloordale Walk-Up PWA. Lineup management,
announcement + walk-up music with Overlap / Sequential modes, Now Playing on
the lock screen and Control Center, Bluetooth speaker keepalive, fully
offline (all audio bundled into the app).

## Install on your iPhone

You need **Xcode** (the full IDE — not just the Command Line Tools). Once
installed, this is a 5-minute path from `git clone` to app running on your
phone.

1. **Install Xcode** from the Mac App Store. ~10 GB.

2. **Open the project**:
   ```bash
   open ios/BloordaleWalkup.xcodeproj
   ```

3. **Set your signing team** (one time):
   - Select the `BloordaleWalkup` target in the project navigator.
   - Go to **Signing & Capabilities**.
   - Under "Team", pick your Apple ID. A free Apple ID works — apps signed
     this way last 7 days on-device before they need re-installing.
   - If Xcode complains about the bundle identifier being taken, change it
     to something unique like `com.<yourname>.bloordale`.

4. **Plug in your iPhone** with a USB cable and trust the Mac when prompted.

5. **Select your phone** in the device picker at the top of the Xcode window
   (next to the Run button).

6. **Press ⌘R**. First install takes ~30 seconds.

7. On the phone: **Settings → General → VPN & Device Management** → trust
   your developer certificate. You only need to do this the first time.

That's it — the app is installed.

### Regenerating the project

The Xcode project is committed for convenience, but it's generated from
`project.yml` via [XcodeGen](https://github.com/yonaskolb/XcodeGen). If you
edit `project.yml` (e.g. to change bundle id, deployment target, capabilities):

```bash
brew install xcodegen        # one time
cd ios
xcodegen generate
```

## Architecture

- **`Models/`**: `Player` (codable, matches `roster.json`), `PlaybackMode`,
  and `RosterLoader` which reads the bundled roster and resolves audio paths.
- **`Audio/`**:
  - `AudioSessionManager` — configures the AVAudioSession for `.playback`
    with AirPlay + Bluetooth A2DP routing, so audio keeps going when the
    screen locks.
  - `WalkupPlayer` — the heart of the app. Two AVAudioPlayer instances
    (announcement + walk-up). Handles both Overlap mode (music plays under
    the announcement from t=0, ramps to full when announcement ends) and
    Sequential mode (announcement plays alone, music ducks in
    `OVERLAP_S` seconds before the end). Schedules the 30-second walk-up
    cap with a 2.5s fade. Mirrors the JS app's timings exactly.
  - `NowPlayingService` — wires up `MPNowPlayingInfoCenter` and
    `MPRemoteCommandCenter` so the lock screen / Control Center show the
    current batter and the play/pause/prev/next buttons work.
  - `KeepaliveTone` — sub-audible 30 Hz heartbeat through `AVAudioEngine`
    every 20 seconds to stop Bluetooth speakers from sleeping between
    batters.
- **`State/AppModel.swift`** — single `ObservableObject` source of truth.
  Loads roster, persists lineup and play mode to `UserDefaults`, dispatches
  remote commands, advances the batter pointer after each at-bat.
- **`Views/`** — pure SwiftUI: a `TabView` with Lineup / Roster / Settings;
  a frosted mini-player pinned via `safeAreaInset(edge: .bottom)`; a
  full-screen `NowPlayingView` presented as a sheet.

## Audio bundling

The `Resources/Audio/` folder is added to the Xcode project as a **folder
reference** (`type: folder` in `project.yml`), so the subdirectory layout
(`Audio/Announcements/<name>.wav`, `Audio/Library/<song-slug>.mp3`,
`Audio/TeamIntro/team-intro.wav`) is preserved at runtime. `RosterLoader`
looks them up by filename + subdirectory. The list of walk-up songs is
catalogued in `Audio/library.json` (parallel to the web build).

## Background audio

`UIBackgroundModes` in `Info.plist` includes `audio` — playback continues
when the screen locks or the app is backgrounded. The keepalive tone runs
through `AVAudioEngine` so it shares the same audio session and keeps the
BT link warm even when nothing is playing.

## Notes

- **Deployment target**: iOS 16.0. Drop this in `project.yml` if you need to
  support older devices, but you'll lose some SwiftUI niceties like
  `safeAreaInset` (already iOS 15) and `presentationDragIndicator` (iOS 16).
- **Free Apple ID signing**: Apps installed with a free account expire after
  7 days. Re-run from Xcode to refresh. A paid Developer account ($99/yr)
  removes that limit.
- **Roster updates**: the bundled `roster.json` and audio files are baked
  in at build time. To update, replace files under `Resources/` and rebuild.
