//
//  BindSpike.swift
//  YTBridge Extension
//
//  Phase 1 go/no-go gate (PLAN.md): before ANY HTTP code, prove the extension
//  sandbox actually permits a listening socket on 127.0.0.1:8976. Requires the
//  `com.apple.security.network.server` entitlement on the extension target
//  (build setting ENABLE_INCOMING_NETWORK_CONNECTIONS = YES).
//
//  Logs only listener lifecycle to subsystem "com.trypwood.ytbridge" — no metadata.
//  If the listener reaches `.failed`, STOP and switch to the containing-app fallback
//  documented in PLAN.md before writing the Phase 2 HTTP server.
//
//  In Phase 2 this file is replaced by HTTPServer.swift (the newConnectionHandler
//  here just accepts-and-closes).
//

import Foundation
import Network
import os

enum BindSpike {

    static let port: UInt16 = 8976

    private static let log = Logger(subsystem: "com.trypwood.ytbridge", category: "bindspike")
    private static let lock = NSLock()
    private static var started = false
    private static var listener: NWListener?

    /// Idempotent: starts the listener exactly once per extension process.
    static func runOnce() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else { return }
        started = true

        let params = NWParameters.tcp
        // Bind strictly to loopback — never 0.0.0.0.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: port)!
        )
        params.allowLocalEndpointReuse = true

        do {
            let l = try NWListener(using: params)
            l.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    log.log("listener ready on 127.0.0.1:\(port, privacy: .public)")
                case .failed(let error):
                    log.error("listener FAILED (sandbox blocks bind? switch to fallback): \(String(describing: error), privacy: .public)")
                case .cancelled:
                    log.log("listener cancelled")
                case .waiting(let error):
                    log.error("listener waiting (port taken?): \(String(describing: error), privacy: .public)")
                default:
                    break
                }
            }
            l.newConnectionHandler = { connection in
                // Spike only: accept and immediately close. Phase 2 replaces this.
                connection.cancel()
            }
            l.start(queue: .global(qos: .utility))
            listener = l
            log.log("bind spike: NWListener.start() called for 127.0.0.1:\(port, privacy: .public)")
        } catch {
            log.error("bind spike: NWListener init threw: \(String(describing: error), privacy: .public)")
        }
    }
}
