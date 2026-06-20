//
//  StateStore.swift
//  YTBridge  (container app)
//
//  Thread-safe singleton holding the latest playback state, the time of the last
//  sync (for the 3s staleness rule), and a bounded FIFO command queue that the
//  HTTP server fills and each Safari sync drains.
//
//  Lives in the CONTAINER APP now (not the extension): the app owns the loopback
//  server for the whole login session, so the socket is up across Safari quit/relaunch
//  instead of dying with the on-demand .appex. The extension's beginRequest forwards
//  state into here over a loopback channel (see HTTPServer `/_internal/sync` and the
//  extension's BridgeClient); `update(state:)` is driven by that ingest.
//
//  `nonisolated` so it stays off the app target's default MainActor isolation — its
//  methods run on the HTTPServer's connection queues, guarded by its own lock.
//
//  Privacy: this type never logs the state's string content. Track titles in the
//  unified log are readable by any same-user process.
//

import Foundation

// `@unchecked Sendable`: the shared singleton is reached from the HTTP server's
// connection queues; all state is serialized through `lock`.
nonisolated final class StateStore: @unchecked Sendable {

    static let shared = StateStore()

    /// State older than this is treated as "idle" (`{active:false}`) — covers crashed
    /// tabs, closed Safari, disabled extension.
    static let stalenessInterval: TimeInterval = 3.0

    /// Bounded command queue depth; oldest is dropped on overflow.
    private static let maxCommands = 16

    private let lock = DispatchQueue(label: "com.trypwood.ytbridge.statestore")

    private var state: [String: Any] = ["active": false]
    private var lastSync: Date?
    private var commands: [[String: Any]] = []

    private init() {}

    // MARK: - Sync from Safari

    /// Store the latest state reported by the background relay and stamp the sync time.
    func update(state newState: [String: Any]) {
        lock.sync {
            self.state = newState
            self.lastSync = Date()
        }
    }

    // MARK: - Reads for the HTTP server

    /// The state to serve, applying the staleness rule. Includes `updatedAtMs`.
    func currentState() -> [String: Any] {
        lock.sync {
            guard let last = lastSync,
                  Date().timeIntervalSince(last) <= Self.stalenessInterval else {
                return ["active": false]
            }
            var s = state
            s["updatedAtMs"] = Int(last.timeIntervalSince1970 * 1000)
            return s
        }
    }

    /// Milliseconds since the last sync, or nil if we've never synced.
    func millisSinceLastSync() -> Int? {
        lock.sync {
            guard let last = lastSync else { return nil }
            return Int(Date().timeIntervalSince(last) * 1000)
        }
    }

    /// True when there has been no sync within the staleness window.
    func isStale() -> Bool {
        lock.sync {
            guard let last = lastSync else { return true }
            return Date().timeIntervalSince(last) > Self.stalenessInterval
        }
    }

    // MARK: - Command queue

    /// Enqueue a validated command, dropping the oldest on overflow.
    func enqueue(command: [String: Any]) {
        lock.sync {
            commands.append(command)
            if commands.count > Self.maxCommands {
                commands.removeFirst(commands.count - Self.maxCommands)
            }
        }
    }

    /// Atomically take and clear all queued commands (called on each native sync).
    func drainCommands() -> [[String: Any]] {
        lock.sync {
            let drained = commands
            commands.removeAll(keepingCapacity: true)
            return drained
        }
    }
}
