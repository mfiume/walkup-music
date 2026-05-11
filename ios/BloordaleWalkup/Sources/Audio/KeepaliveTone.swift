import AVFoundation

/// Sub-audible heartbeat that prevents Bluetooth speakers from sleeping during
/// dead time between batters. Same idea as the JS implementation: a quiet
/// 30 Hz tone every 20s keeps the BT codec's silence gate from cutting the link.
@MainActor
final class KeepaliveTone {

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var buffer: AVAudioPCMBuffer?
    private var timer: Timer?
    private var isPrepared = false

    private let intervalSeconds: TimeInterval = 20
    private let toneSeconds: Double = 0.25
    private let toneHz: Float = 30
    private let toneGain: Float = 0.0005

    func start() {
        guard timer == nil else { return }
        prepareIfNeeded()
        // Fire one immediately so a long pause doesn't lose the link.
        playTone()
        timer = Timer.scheduledTimer(withTimeInterval: intervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.playTone() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if engine.isRunning {
            player.stop()
            engine.stop()
        }
    }

    private func prepareIfNeeded() {
        guard !isPrepared else { return }
        isPrepared = true
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        let frameCount = AVAudioFrameCount(format.sampleRate * toneSeconds)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buf.frameLength = frameCount
        if let channel = buf.floatChannelData?[0] {
            let twoPi = Float(2.0 * .pi)
            let sr = Float(format.sampleRate)
            for n in 0..<Int(frameCount) {
                let t = Float(n) / sr
                channel[n] = sin(twoPi * toneHz * t) * toneGain
            }
        }
        buffer = buf
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    private func playTone() {
        guard let buffer else { return }
        do {
            if !engine.isRunning {
                try engine.start()
            }
            if !player.isPlaying { player.play() }
            player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        } catch {
            // Best-effort.
        }
    }
}
