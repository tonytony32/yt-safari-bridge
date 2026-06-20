//
//  AppDelegate.swift
//  YTBridge  (container app — headless background agent)
//
//  The container app is now the owner of the loopback bridge. It runs for the whole login
//  session (registered as a launch-at-login item) and binds the HTTP server on
//  127.0.0.1:8976 the moment it starts — so JellyBeat can connect immediately after a cold
//  Safari launch, with no YouTube tab open and without toggling the extension. The extension
//  only feeds playback state in over the loopback ingest (see BridgeClient / HTTPServer); it
//  no longer hosts any socket.
//
//  Deliberately HEADLESS: no Dock icon, no window, no menu-bar item (LSUIElement +
//  .accessory in main.swift). Its only job is to keep the socket up; status and control live
//  in the consumer (JellyBeat reads GET /v1/health), so there's a single control surface
//  instead of a second macOS UI competing with it. It's the closest Safari gets to Chrome's
//  invisible native-messaging host. Manage it from System Settings ▸ Login Items.
//

import Cocoa
import ServiceManagement
import os

class AppDelegate: NSObject, NSApplicationDelegate {

    private static let log = Logger(subsystem: "com.trypwood.ytbridge", category: "app")

    /// Set once, on first ever launch, so we register the login item a single time and then
    /// respect whatever the user/System Settings choose afterward (no fighting).
    private static let didAttemptInitialLoginRegistrationKey = "didAttemptInitialLoginRegistration"

    private var healthTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Bind the bridge socket for the whole login session, independent of Safari.
        HTTPServer.shared.ensureRunning()

        registerLoginItemOnFirstRun()

        // Self-heal: re-assert the listener on a slow cadence in case the system tore it down
        // (sleep/wake, network changes). ensureRunning() is idempotent while already bound.
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
            HTTPServer.shared.ensureRunning()
        }

        Self.log.notice("bridge agent launched; serving on 127.0.0.1:\(HTTPServer.port, privacy: .public)")
    }

    // No windows, no UI: stay alive as a background agent.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // MARK: - Login item (launch at login)

    private func registerLoginItemOnFirstRun() {
        guard #available(macOS 13.0, *) else { return }
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.didAttemptInitialLoginRegistrationKey) else { return }
        defaults.set(true, forKey: Self.didAttemptInitialLoginRegistrationKey)
        do {
            try SMAppService.mainApp.register()
            Self.log.notice("registered login item")
        } catch {
            Self.log.error("login item initial register failed: \(String(describing: error), privacy: .public)")
        }
    }
}
