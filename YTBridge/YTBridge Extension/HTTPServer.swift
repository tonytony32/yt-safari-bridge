//
//  HTTPServer.swift
//  YTBridge Extension
//
//  Minimal hand-rolled HTTP/1.1 server on Network.framework, hosted inside the
//  extension process. Replaces the Phase 1 BindSpike. No SPM dependencies.
//
//  Security model (PLAN.md / docs/api.md) — implemented exactly:
//    - bind strictly to loopback 127.0.0.1 (never 0.0.0.0)
//    - NO CORS headers, ever
//    - 403 if Host header != "127.0.0.1:8976"   (defeats DNS rebinding)
//    - 403 if any Origin header is present       (closes the drive-by browser vector)
//    - 413 if request > 8 KB; 5 s read timeout; max 8 concurrent connections;
//      Connection: close after every response; X-Content-Type-Options: nosniff
//
//  Endpoints: GET /v1/now-playing, GET /v1/health, POST /v1/command.
//  Logs lifecycle/events only — never metadata content.
//

import Foundation
import Network
import os

final class HTTPServer {

    static let shared = HTTPServer()

    static let port: UInt16 = 8976
    static let version = "0.1.0"

    private static let maxRequestBytes = 8 * 1024
    private static let maxConnections = 8
    private static let readTimeout: TimeInterval = 5.0
    private static let expectedHost = "127.0.0.1:8976"

    private let log = Logger(subsystem: "com.trypwood.ytbridge", category: "http")
    private let lock = NSLock()
    private var started = false
    private var listener: NWListener?
    private let connQueue = DispatchQueue(label: "com.trypwood.ytbridge.http", attributes: .concurrent)
    private let countLock = NSLock()
    private var liveConnections = 0
    // Per-connection hard-deadline timers, keyed by identity. Presence in this map
    // is also the "still live" guard that makes finish() decrement exactly once.
    private var connTimers: [ObjectIdentifier: DispatchWorkItem] = [:]

    private init() {}

    /// Ensure the listener is up. Idempotent while a listener is alive, but —
    /// unlike a one-shot start — it revives a listener the system tore down.
    ///
    /// Called on every native-message sync (and on a short timer after a
    /// failure), so a listener cancelled when macOS suspended the extension
    /// process (e.g. its tab went to the background) comes back on the next sync
    /// instead of staying dead for the life of the process. That permanent-dead
    /// case is the root of the "socket CLOSED while the handler is still alive"
    /// flakiness: the old `startOnce` set `started = true` once and never
    /// recovered after `.cancelled`/`.failed`.
    func ensureRunning() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else { return }
        started = true
        startListenerLocked()
    }

    /// Build and start a fresh listener. Caller must hold `lock`.
    private func startListenerLocked() {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: Self.port)!
        )
        params.allowLocalEndpointReuse = true

        do {
            let l = try NWListener(using: params)
            l.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.log.notice("listener ready on 127.0.0.1:\(Self.port, privacy: .public)")
                case .failed(let e):
                    self?.log.error("listener failed: \(String(describing: e), privacy: .public)")
                    self?.handleListenerDown()
                case .cancelled:
                    self?.log.notice("listener cancelled")
                    self?.handleListenerDown()
                default:
                    break
                }
            }
            l.newConnectionHandler = { [weak self] conn in
                self?.accept(conn)
            }
            l.start(queue: connQueue)
            listener = l
        } catch {
            log.error("NWListener init threw: \(String(describing: error), privacy: .public)")
            started = false   // allow a later retry
        }
    }

    /// A listener went down (failed / cancelled by the system). Drop it and
    /// schedule a revive; the next sync's `ensureRunning()` would revive it too,
    /// but the timer covers the case where syncs have paused. `guard wasStarted`
    /// dedups the `.cancelled` our own `cancel()` re-fires, so there's no loop.
    private func handleListenerDown() {
        lock.lock()
        let wasStarted = started
        started = false
        let old = listener
        listener = nil
        lock.unlock()
        guard wasStarted else { return }
        old?.cancel()
        connQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.ensureRunning()
        }
    }

    // MARK: - Connection handling

    private func accept(_ conn: NWConnection) {
        let id = ObjectIdentifier(conn)

        // Hard wall-clock deadline. The per-read deadline check in receiveRequest
        // only fires when bytes arrive; a peer that connects and then stalls (or
        // dribbles half a header and freezes) never wakes that callback, so without
        // this timer it would hold a connection slot until the OS keepalive reaps it
        // — eight such peers exhaust maxConnections and lock out the real consumer.
        let timeout = DispatchWorkItem { [weak self] in self?.finish(conn) }

        countLock.lock()
        let over = liveConnections >= Self.maxConnections
        if !over {
            liveConnections += 1
            connTimers[id] = timeout
        }
        countLock.unlock()

        if over {
            conn.cancel() // shed load past the concurrency cap
            return
        }

        connQueue.asyncAfter(deadline: .now() + Self.readTimeout, execute: timeout)
        conn.start(queue: connQueue)
        receiveRequest(conn, buffer: Data(), deadline: Date().addingTimeInterval(Self.readTimeout))
    }

    /// Tear a connection down exactly once. The deadline timer and any normal
    /// completion path both route here; whoever removes the timer from the map
    /// first owns the single decrement, and the loser becomes a no-op.
    private func finish(_ conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        countLock.lock()
        guard let timer = connTimers.removeValue(forKey: id) else {
            countLock.unlock()
            return // already finished (timeout vs. response race)
        }
        liveConnections = max(0, liveConnections - 1)
        countLock.unlock()
        timer.cancel()
        conn.cancel()
    }

    private func receiveRequest(_ conn: NWConnection, buffer: Data, deadline: Date) {
        if Date() > deadline {
            respond(conn, status: 408, reason: "Request Timeout", json: ["error": "timeout"])
            return
        }
        conn.receive(minimumIncompleteLength: 1, maximumLength: Self.maxRequestBytes + 1) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error = error {
                self.log.error("recv error: \(String(describing: error), privacy: .public)")
                self.finish(conn)
                return
            }

            var buf = buffer
            if let data = data { buf.append(data) }

            if buf.count > Self.maxRequestBytes {
                self.respond(conn, status: 413, reason: "Payload Too Large", json: ["error": "too_large"])
                return
            }

            // Need the full header block before deciding.
            guard let headerEnd = self.rangeOfHeaderTerminator(buf) else {
                if isComplete {
                    self.finish(conn) // closed before sending headers
                } else {
                    self.receiveRequest(conn, buffer: buf, deadline: deadline)
                }
                return
            }

            let headerData = buf.subdata(in: buf.startIndex..<headerEnd.lowerBound)
            guard let request = HTTPRequest(headerBlock: headerData) else {
                self.respond(conn, status: 400, reason: "Bad Request", json: ["error": "bad_request"])
                return
            }

            let bodyStart = headerEnd.upperBound
            let haveBody = buf.subdata(in: bodyStart..<buf.endIndex)
            let need = request.contentLength

            if haveBody.count < need && !isComplete {
                self.receiveRequest(conn, buffer: buf, deadline: deadline)
                return
            }
            let body = need > 0 ? haveBody.prefix(need) : Data()
            self.route(conn, request: request, body: Data(body))
        }
    }

    private func rangeOfHeaderTerminator(_ data: Data) -> Range<Data.Index>? {
        let sep = Data([0x0d, 0x0a, 0x0d, 0x0a]) // \r\n\r\n
        return data.range(of: sep)
    }

    // MARK: - Routing

    private func route(_ conn: NWConnection, request: HTTPRequest, body: Data) {
        // DNS-rebinding defense + drive-by browser defense.
        guard request.headerValue("host") == Self.expectedHost else {
            respond(conn, status: 403, reason: "Forbidden", json: ["error": "bad_host"])
            return
        }
        if request.headerValue("origin") != nil {
            respond(conn, status: 403, reason: "Forbidden", json: ["error": "origin_rejected"])
            return
        }

        switch (request.method, request.path) {
        case ("GET", "/v1/now-playing"):
            respond(conn, status: 200, reason: "OK", json: StateStore.shared.currentState())

        case ("GET", "/v1/health"):
            respond(conn, status: 200, reason: "OK", json: [
                "ok": true,
                "safariLastPollMs": StateStore.shared.millisSinceLastSync() as Any,
                "version": Self.version,
                "capabilities": Self.capabilities,
            ])

        case ("POST", "/v1/command"):
            handleCommand(conn, body: body)

        default:
            respond(conn, status: 404, reason: "Not Found", json: ["error": "not_found"])
        }
    }

    private static let validActions: Set<String> = [
        "play", "pause", "toggle", "next", "previous", "seek", "setVolume",
        "focusTab",
    ]

    /// Self-describing capabilities so a generic consumer (arbiter) doesn't hard-code
    /// per-backend quirks. Constant for this source: full transport control, but no
    /// favorites and no queue (YouTube / YouTube Music). See docs/playback-source.md.
    private static let capabilities: [String: Bool] = [
        "canPlayPause": true,
        "canNext": true,
        "canPrevious": true,
        "canSeek": true,
        "canSetVolume": true,
        "canFocusTab": true,
        "hasFavorites": false,
        "hasQueue": false,
    ]

    private func handleCommand(_ conn: NWConnection, body: Data) {
        guard
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let action = obj["action"] as? String,
            Self.validActions.contains(action)
        else {
            respond(conn, status: 400, reason: "Bad Request", json: ["error": "bad_action"])
            return
        }

        // seek / setVolume require a finite numeric value.
        var command: [String: Any] = ["action": action]
        if action == "seek" || action == "setVolume" {
            guard let v = obj["value"] as? Double, v.isFinite else {
                respond(conn, status: 400, reason: "Bad Request", json: ["error": "bad_value"])
                return
            }
            command["value"] = v
        }

        // No sync within the staleness window: Safari is closed / extension disabled
        // / no YT tab. Don't queue into the void.
        if StateStore.shared.isStale() {
            respond(conn, status: 503, reason: "Service Unavailable", json: ["error": "safari_disconnected"])
            return
        }
        // Synced, but the active tab reports nothing playable — the command would be
        // silently dropped by the background relay, so say so instead of a false 202.
        if (StateStore.shared.currentState()["active"] as? Bool) != true {
            respond(conn, status: 409, reason: "Conflict", json: ["error": "no_active_player"])
            return
        }

        StateStore.shared.enqueue(command: command)
        respond(conn, status: 202, reason: "Accepted", json: ["queued": true])
    }

    // MARK: - Response

    private func respond(_ conn: NWConnection, status: Int, reason: String, json: [String: Any]) {
        let bodyData: Data
        if let d = try? JSONSerialization.data(withJSONObject: json, options: []) {
            bodyData = d
        } else {
            bodyData = Data("{\"error\":\"serialize\"}".utf8)
        }

        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Content-Length: \(bodyData.count)\r\n"
        head += "X-Content-Type-Options: nosniff\r\n"
        head += "Connection: close\r\n"
        // NO CORS headers, by design.
        head += "\r\n"

        var out = Data(head.utf8)
        out.append(bodyData)

        conn.send(content: out, completion: .contentProcessed { [weak self] _ in
            self?.finish(conn)
        })
    }
}

// MARK: - Tiny request parser

private struct HTTPRequest {
    let method: String
    let path: String
    private let headers: [String: String] // lowercased keys

    var contentLength: Int { Int(headers["content-length"] ?? "") ?? 0 }
    func headerValue(_ name: String) -> String? { headers[name.lowercased()] }

    init?(headerBlock: Data) {
        guard let text = String(data: headerBlock, encoding: .utf8) else { return nil }
        let lines = text.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        method = String(parts[0])
        // Strip any query string for routing.
        let rawPath = String(parts[1])
        path = String(rawPath.split(separator: "?", maxSplits: 1).first ?? Substring(rawPath))

        var h: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let val = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            h[key] = val
        }
        headers = h
    }
}
