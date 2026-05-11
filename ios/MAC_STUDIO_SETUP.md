# Building & Deploying from the Mac Studio

You already have Xcode and Claude Code on the Mac Studio. Here's the full
path from "fresh checkout" to "app running on your iPhone."

## One-time setup (~5 min)

### 1. Clone the repo and check out the `ios` branch

```bash
cd ~/Development                 # or wherever you keep code
git clone https://github.com/mfiume/walkup-music.git
cd walkup-music
git checkout ios
```

### 2. Open the Xcode project

```bash
open ios/BloordaleWalkup.xcodeproj
```

Xcode will index the project for ~30 seconds the first time. Wait for the
indexer (top of the window) to finish.

### 3. Set your signing team

In Xcode:

1. Click the blue `BloordaleWalkup` project icon at the top of the left
   sidebar.
2. Select the `BloordaleWalkup` target.
3. Go to the **Signing & Capabilities** tab.
4. Under "Team", pick your Apple ID. If your Apple ID isn't in the
   dropdown:
   - Xcode menu → Settings → Accounts → `+` → sign in with your Apple ID.
5. If you see "Failed to register bundle identifier" or "already in use,"
   change the Bundle Identifier to something unique, e.g.
   `com.marcfiume.bloordale`.

A **free Apple ID** is enough. Apps signed this way run on your phone for
7 days before they expire and need a reinstall from Xcode. A paid
Developer account ($99/year) removes that limit.

### 4. Plug in your iPhone

- Connect with a USB-C or Lightning cable.
- On the phone: tap "Trust This Computer" when prompted.
- On the Mac: at the top of Xcode, click the device picker (next to the
  big Run/Stop buttons). Pick your iPhone from the list.

### 5. Enable Developer Mode on the iPhone (iOS 16+)

First time only:

1. On the phone: Settings → Privacy & Security → Developer Mode → toggle
   on.
2. The phone will prompt for a restart. Restart it.
3. After it reboots, unlock and tap "Turn On" when iOS asks again.

### 6. Run

In Xcode: hit **⌘R** (or the Play button).

First install takes 30 to 60 seconds. The phone will show "Untrusted
Developer." Tap OK, then:

1. On the phone: Settings → General → VPN & Device Management.
2. Tap your Apple ID under "Developer App."
3. Tap "Trust [your Apple ID]" → Trust.

Run again from Xcode (⌘R). The app launches.

## Daily flow after setup

Just open `ios/BloordaleWalkup.xcodeproj`, pick your phone in the device
picker, and ⌘R. Builds are incremental and fast (~5 seconds for code
changes).

## If something breaks

### "No account for team..."
Xcode → Settings → Accounts → add your Apple ID.

### "Could not launch BloordaleWalkup"
Settings → General → VPN & Device Management on the phone, trust the dev
cert.

### "Failed to register bundle identifier"
The bundle ID `com.bloordale.walkup` is already taken by some other
developer (or by an earlier install of yours). Change it in Signing &
Capabilities to something unique like `com.marcfiume.bloordale.walkup`.

### Compile errors
The Swift code parsed clean on a machine without the iOS SDK, but Xcode
will catch anything I missed against the real SDK. If you hit errors:

```bash
# Open Claude Code in the repo, then ask it:
# "Fix the compile errors in ios/. Here's the Xcode output: <paste>"
```

Claude can read the source, propose the fix, and you can iterate without
leaving the editor.

### Audio doesn't route to Bluetooth
The audio session is configured for `.playback` with AirPlay + A2DP
allowed, so this should "just work." If a specific BT speaker disconnects
between batters, the keepalive tone is supposed to prevent that. Worth
checking that the speaker is paired with the phone (not the Mac).

## Regenerating the Xcode project

The `.xcodeproj` is committed for convenience but generated from
`project.yml`. If you tweak the spec (bundle ID, deployment target,
capabilities):

```bash
brew install xcodegen   # one time
cd ios
xcodegen generate
```

Then reload the project in Xcode (File → Close, then reopen).

## TestFlight or App Store (later)

Out of scope for first run, but the bones are here. You'd need a paid
Developer account, then Xcode → Product → Archive → distribute via App
Store Connect.
