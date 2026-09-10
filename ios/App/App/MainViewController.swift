import Capacitor
import UIKit

/// EvoSpeechPlugin is a small local plugin that lives directly in the App
/// target (not an installed npm/SPM Capacitor plugin), so Capacitor's own
/// auto-registration never sees it: CapacitorBridge.registerPlugins() only
/// auto-registers classes listed by name in capacitor.config.json's
/// packageClassList, which `cap sync` populates strictly from node_modules
/// packages — it does not scan the app target for CAPBridgedPlugin
/// conformers. A local plugin instance must be registered explicitly, and
/// the bridge only exists once capacitorDidLoad() fires, so this subclass
/// (wired in Main.storyboard in place of the stock CAPBridgeViewController)
/// is where that has to happen.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(EvoSpeechPlugin())
    }
}
