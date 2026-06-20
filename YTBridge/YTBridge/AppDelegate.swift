//
//  AppDelegate.swift
//  YTBridge  (container app — bridge host, lifecycle owned by JellyBeat)
//
//  This app hosts the loopback bridge socket (127.0.0.1:8976). It is NOT a login item and
//  does NOT run on its own: JellyBeat — the only consumer — launches it when JellyBeat opens
//  and terminates it when JellyBeat quits. So the bridge exists exactly while JellyBeat is
//  running: not before, not after. That's the UX anchor — the consumer owns the lifecycle.
//
//  To stay honest about that, the host watches JellyBeat and quits itself if JellyBeat is gone
//  (covers a JellyBeat crash, or a stray manual launch). Pass `--standalone` to keep it up
//  without JellyBeat — used only by scripts/dev-reinstall.sh for local verification.
//
//  Headless (.accessory in main.swift + LSUIElement): no Dock icon, no window, no menu bar.
//

import Cocoa
import ServiceManagement
import os

/// JellyBeat's bundle identifier — the app whose lifecycle this host is tied to.
let jellybeatBundleID = "software.trypwood.jellybeat"

class AppDelegate: NSObject, NSApplicationDelegate {

    private static let log = Logger(subsystem: "com.trypwood.ytbridge", category: "app")

    /// Dev escape hatch: keep the host alive without JellyBeat (scripts/dev-reinstall.sh).
    private let standalone = ProcessInfo.processInfo.arguments.contains("--standalone")

    private var healthTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Bind the bridge socket immediately — JellyBeat launched us because it wants it now.
        HTTPServer.shared.ensureRunning()

        removeStaleLoginItem()

        if !standalone {
            // Quit the instant JellyBeat quits.
            NSWorkspace.shared.notificationCenter.addObserver(
                self,
                selector: #selector(appTerminated(_:)),
                name: NSWorkspace.didTerminateApplicationNotification,
                object: nil
            )
        }

        // Self-heal the listener, and (belt-and-suspenders) quit if JellyBeat has vanished
        // without us catching the termination notification.
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            HTTPServer.shared.ensureRunning()
            self?.quitIfJellyBeatGone()
        }

        Self.log.notice("bridge host launched (standalone=\(self.standalone, privacy: .public)); serving on 127.0.0.1:\(HTTPServer.port, privacy: .public)")
    }

    // No windows, no UI: stay alive as a background process for as long as JellyBeat wants us.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // MARK: - Lifecycle tied to JellyBeat

    @objc private func appTerminated(_ note: Notification) {
        guard !standalone else { return }
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        if app?.bundleIdentifier == jellybeatBundleID {
            Self.log.notice("JellyBeat terminated — bridge host quitting")
            NSApp.terminate(nil)
        }
    }

    private func quitIfJellyBeatGone() {
        guard !standalone else { return }
        if NSRunningApplication.runningApplications(withBundleIdentifier: jellybeatBundleID).isEmpty {
            Self.log.notice("JellyBeat not running — bridge host quitting")
            NSApp.terminate(nil)
        }
    }

    /// One-time cleanup: earlier builds registered this app as a login item. We don't anymore
    /// (JellyBeat owns our lifecycle), so drop any stale registration — otherwise we'd linger
    /// in System Settings → Login Items and briefly launch at every boot (then self-quit).
    private func removeStaleLoginItem() {
        guard #available(macOS 13.0, *) else { return }
        let status = SMAppService.mainApp.status
        if status == .enabled || status == .requiresApproval {
            try? SMAppService.mainApp.unregister()
            Self.log.notice("removed stale login-item registration")
        }
    }
}
