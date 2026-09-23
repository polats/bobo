import UIKit
import Capacitor
import WebKit

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
