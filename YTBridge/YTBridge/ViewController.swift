//
//  ViewController.swift
//  YTBridge
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "com.trypwood.ytbridge.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    private var statusTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }

        // Poll the local bridge API and push status into the page. The webview
        // itself cannot fetch http://127.0.0.1 (WebKit blocks loopback from page
        // contexts); the native side can, with the network.client entitlement.
        refreshBridgeStatus()
        statusTimer?.invalidate()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refreshBridgeStatus()
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else { return }
        switch body {
        case "open-preferences":
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in
                DispatchQueue.main.async {
                    NSApplication.shared.terminate(nil)
                }
            }
        case "refresh":
            refreshBridgeStatus()
        case "focus-tab":
            sendFocusTab()
        default:
            break
        }
    }

    // MARK: - Bridge status

    private func refreshBridgeStatus() {
        guard let url = URL(string: "http://127.0.0.1:8976/v1/now-playing") else { return }
        var req = URLRequest(url: url, timeoutInterval: 2.0)
        req.setValue("close", forHTTPHeaderField: "Connection")
        let task = URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            let js: String
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data),
               let wrapped = try? JSONSerialization.data(withJSONObject: ["up": true, "state": obj]),
               let json = String(data: wrapped, encoding: .utf8) {
                js = "showBridge(\(json))"
            } else {
                // Connection refused / timeout = bridge idle (Safari closed or no YT tab).
                js = "showBridge({\"up\":false})"
            }
            DispatchQueue.main.async {
                self?.webView.evaluateJavaScript(js)
            }
        }
        task.resume()
    }

    /// POST a focusTab command so the extension raises the playing YouTube tab.
    /// The webview can't reach http://127.0.0.1 (WebKit blocks loopback from page
    /// contexts), so the double-click on the cover art routes through here. The
    /// command travels the same queue as playback commands and is dispatched on the
    /// next Safari sync (≤1s). URLSession sets Host to 127.0.0.1:8976 and sends no
    /// Origin, satisfying the bridge's security model.
    private func sendFocusTab() {
        guard let url = URL(string: "http://127.0.0.1:8976/v1/command") else { return }
        var req = URLRequest(url: url, timeoutInterval: 2.0)
        req.httpMethod = "POST"
        req.setValue("close", forHTTPHeaderField: "Connection")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{\"action\":\"focusTab\"}".utf8)
        URLSession.shared.dataTask(with: req).resume()
    }
}
