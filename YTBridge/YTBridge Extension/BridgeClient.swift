//
//  BridgeClient.swift
//  YTBridge Extension
//
//  The extension → container-app forwarder. The container app owns the loopback HTTP
//  server (so the bridge survives Safari quit/relaunch); on every Safari sync we POST
//  the latest playback state to its private `/_internal/sync` ingest and read back any
//  queued commands, which beginRequest returns to the background page in one round trip.
//
//  Synchronous-but-bounded: beginRequest must return commands in the same call, so we
//  block on a semaphore with a hard timeout. URLSession's completion runs on its own
//  queue, so this never deadlocks. If the app isn't running the connection is refused
//  fast and we return no commands — graceful, identical to the old "native host down".
//
//  Requires the `network.client` (outgoing) sandbox entitlement on this target.
//  Privacy: logs sizes/timing only, never state content.
//

import Foundation
import os

enum BridgeClient {

    /// The container app's internal ingest endpoint (same loopback port as the public
    /// API; a distinct, token-gated path). URLSession sets Host to 127.0.0.1:8976 and
    /// sends no Origin, satisfying the server's Host/Origin checks.
    private static let endpoint = URL(string: "http://127.0.0.1:8976/_internal/sync")!

    /// MUST match HTTPServer.internalToken in the app target.
    private static let token = "ytb-internal-7f3a9c2e1b8d4056-v1"

    private static let timeout: TimeInterval = 2.0

    private static let log = Logger(subsystem: "com.trypwood.ytbridge", category: "client")

    /// Forward `state` to the app and return the commands it has queued (empty on any
    /// failure: app not running, timeout, malformed reply).
    static func forward(state: [String: Any]) -> [[String: Any]] {
        guard let httpBody = try? JSONSerialization.data(withJSONObject: ["state": state]) else {
            return []
        }

        var req = URLRequest(url: endpoint, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-YTBridge-Token")
        req.setValue("close", forHTTPHeaderField: "Connection")
        req.httpBody = httpBody

        let semaphore = DispatchSemaphore(value: 0)
        var commands: [[String: Any]] = []

        let task = URLSession.shared.dataTask(with: req) { data, _, error in
            defer { semaphore.signal() }
            if let error = error {
                log.error("forward failed: \(String(describing: error), privacy: .public)")
                return
            }
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmds = obj["commands"] as? [[String: Any]] else {
                return
            }
            commands = cmds
        }
        task.resume()

        // Ceiling slightly above the request timeout so URLSession reports first.
        if semaphore.wait(timeout: .now() + timeout + 0.5) == .timedOut {
            task.cancel()
            log.error("forward timed out")
        }
        return commands
    }
}
