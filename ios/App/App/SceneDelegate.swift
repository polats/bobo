import UIKit
import Capacitor
import WebKit
import CoreHaptics

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
