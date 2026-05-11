import AVFoundation

/// Owns the AVAudioSession lifecycle. We use `.playback` so audio routes to
/// Bluetooth and continues when the screen locks. `.duckOthers` is off because
/// stadium use means *we* are the music — we want to take the speaker over
/// completely, not duck under Spotify.
enum AudioSessionManager {
    static func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playback,
                mode: .default,
                options: [.allowAirPlay, .allowBluetoothA2DP]
            )
            try session.setActive(true, options: [])
        } catch {
            print("AudioSession activation failed: \(error)")
        }
    }

    static func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // not fatal
        }
    }
}
