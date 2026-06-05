//
//  StateStore.swift
//  YTBridge Extension
//
//  Thread-safe singleton holding the latest playback state pushed from Safari, the
//  time of the last sync (for the 3s staleness rule), and a bounded FIFO command
//  queue that the HTTP server (Phase 2) fills and each native sync drains.
//
//  Privacy: this type never logs the state's string content. Track titles in the
//  unified log are readable by any same-user process.
//

import Foundation

final class StateStore {

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
