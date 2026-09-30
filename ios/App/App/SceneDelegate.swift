import UIKit
import Capacitor
import WebKit
import CoreHaptics
import AVFoundation

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = BoboViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

class BoboViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BoboHapticsPlugin())
        bridge?.registerPluginInstance(BoboMicPlugin())
        #if DEBUG
        // Debug-only launch hooks for device testing from the Mac:
        //   devicectl ... launch --environment-variables '{"BOBO_TOY":"goo","BOBO_AUTOPLAY":"1"}'
        let env = ProcessInfo.processInfo.environment
        var source = ""
        if let toy = env["BOBO_TOY"], toy.range(of: "^[a-z0-9-]+$", options: .regularExpression) != nil {
            source += "window.boboStartToy = '\(toy)';"
        }
        if env["BOBO_AUTOPLAY"] == "1" {
            source += "window.boboAutoplay = true;"
            UIApplication.shared.isIdleTimerDisabled = true
        }
        if !source.isEmpty {
            let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            webView?.configuration.userContentController.addUserScript(script)
        }
        #endif
    }
}

/// Continuous haptics for toys: one looping Core Haptics player whose intensity and sharpness the
/// page updates every frame (a pressure-washer jet, a mower bogging down, yarn reeling in).
/// Discrete taps still go through @capacitor/haptics.
@objc(BoboHapticsPlugin)
public class BoboHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BoboHapticsPlugin"
    public let jsName = "BoboHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "level", returnType: CAPPluginReturnNone),
    ]
    private let supported = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    private var engine: CHHapticEngine?
    private var player: CHHapticAdvancedPatternPlayer?
    private var running = false

    @objc func info(_ call: CAPPluginCall) {
        call.resolve(["tier": supported ? "core-haptics" : "none", "continuous": supported])
    }

    @objc func level(_ call: CAPPluginCall) {
        let intensity = Float(call.getDouble("intensity") ?? 0)
        let sharpness = Float(call.getDouble("sharpness") ?? 0.5)
        DispatchQueue.main.async { self.set(intensity, sharpness) }
    }

    private func set(_ intensity: Float, _ sharpness: Float) {
        guard supported else { return }
        if intensity <= 0.01 {
            if running { try? player?.stop(atTime: CHHapticTimeImmediate) }
            running = false
            return
        }
        do {
            if engine == nil {
                let e = try CHHapticEngine()
                e.playsHapticsOnly = true
                e.isAutoShutdownEnabled = true
                // The system can stop or reset the engine (backgrounding, audio interruptions): rebuild lazily.
                e.stoppedHandler = { [weak self] _ in DispatchQueue.main.async { self?.player = nil; self?.running = false } }
                e.resetHandler = { [weak self] in DispatchQueue.main.async { self?.player = nil; self?.running = false } }
                engine = e
            }
            guard let e = engine else { return }
            if player == nil {
                try e.start()
                // A long looping continuous event at full strength; the dynamic parameters scale it.
                let event = CHHapticEvent(eventType: .hapticContinuous, parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
                ], relativeTime: 0, duration: 30)
                player = try e.makeAdvancedPlayer(with: CHHapticPattern(events: [event], parameters: []))
                player?.loopEnabled = true
            }
            if !running {
                try e.start()
                try player?.start(atTime: CHHapticTimeImmediate)
                running = true
            }
            try player?.sendParameters([
                CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: min(1, intensity), relativeTime: 0),
                // Sharpness control is an offset from the event's 0.5.
                CHHapticDynamicParameter(parameterID: .hapticSharpnessControl, value: max(-0.5, min(0.5, sharpness - 0.5)), relativeTime: 0),
            ], atTime: CHHapticTimeImmediate)
        } catch {
            player = nil
            running = false
        }
    }
}

/// Microphone features for toys (blowing, singing): loudness, pitch and how voiced the sound is,
/// computed on the device from an AVAudioEngine tap and sent to the page ~40 times a second.
/// Nothing is recorded or stored. Native because WKWebView's Web Audio input reads silence.
@objc(BoboMicPlugin)
public class BoboMicPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BoboMicPlugin"
    public let jsName = "BoboMic"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]
    private let engine = AVAudioEngine()
    private var running = false
    private var saved: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

    @objc func start(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async {
                guard granted else { return call.resolve(["granted": false]) }
                do {
                    try self.begin(echoCancel: call.getBool("echoCancel") ?? false)
                    call.resolve(["granted": true])
                } catch {
                    call.reject("Microphone failed to start: \(error.localizedDescription)")
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.end()
            call.resolve()
        }
    }

    private func begin(echoCancel: Bool) throws {
        if running { return }
        let session = AVAudioSession.sharedInstance()
        saved = (session.category, session.mode, session.categoryOptions)
        // Keep toy sounds on the loudspeaker and mixed with other audio while listening. Measurement
        // mode turns off automatic gain, so a harder blow really reads louder. Toys that listen for
        // singing over their own tone ask for Apple's voice processing (echo cancellation) instead.
        try session.setCategory(.playAndRecord, mode: echoCancel ? .default : .measurement, options: [.defaultToSpeaker, .mixWithOthers, .allowBluetoothA2DP])
        try session.setActive(true)
        let input = engine.inputNode
        try? input.setVoiceProcessingEnabled(echoCancel)
        let format = input.outputFormat(forBus: 0)
        let rate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let data = buffer.floatChannelData?[0] else { return }
            let f = BoboMicPlugin.features(data, count: Int(buffer.frameLength), rate: rate)
            self.notifyListeners("frame", data: ["rms": f.rms, "pitch": f.pitch, "clarity": f.clarity])
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    private func end() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        if let (category, mode, options) = saved {
            try? AVAudioSession.sharedInstance().setCategory(category, mode: mode, options: options)
        }
    }

    override public func load() {
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.end() }
    }

    /// RMS, and pitch plus clarity from a normalised autocorrelation on a 4x-decimated signal
    /// (70-1000 Hz). Blowing is loud with low clarity; a sung note has high clarity.
    static func features(_ x: UnsafePointer<Float>, count: Int, rate: Double) -> (rms: Double, pitch: Double, clarity: Double) {
        var sum: Float = 0
        for i in 0..<count { sum += x[i] * x[i] }
        let rms = Double(sqrt(sum / Float(max(1, count))))
        let n = count / 4
        if n < 64 { return (rms, 0, 0) }
        var d = [Float](repeating: 0, count: n)
        for i in 0..<n { d[i] = (x[i * 4] + x[i * 4 + 1] + x[i * 4 + 2] + x[i * 4 + 3]) * 0.25 }
        let sr = rate / 4
        let minLag = max(2, Int(sr / 1000)), maxLag = min(n / 2, Int(sr / 70))
        var e0: Float = 0
        for i in 0..<(n - maxLag) { e0 += d[i] * d[i] }
        if e0 < 1e-9 { return (rms, 0, 0) }
        var r = [Float](repeating: 0, count: maxLag + 1)
        var best: Float = 0
        for lag in minLag...maxLag {
            var c: Float = 0, e1: Float = 0
            for i in 0..<(n - maxLag) {
                c += d[i] * d[i + lag]
                e1 += d[i + lag] * d[i + lag]
            }
            r[lag] = c / sqrt(e0 * e1 + 1e-12)
            best = max(best, r[lag])
        }
        // The shortest lag nearly as periodic as the best, so a note isn't read an octave low.
        var bestLag = 0
        for lag in (minLag + 1)..<maxLag where r[lag] >= best * 0.92 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] {
            bestLag = lag
            break
        }
        return (rms, bestLag > 0 ? sr / Double(bestLag) : 0, Double(max(0, best)))
    }
}
