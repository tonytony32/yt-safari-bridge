//
//  SafariWebExtensionHandler.swift
//  YTBridge Extension
//
//  Receives `{type:"sync", state}` from the background relay and FORWARDS it to the
//  container app, which owns the loopback HTTP server now. The app stores the state and
//  returns any queued commands, which we hand straight back to the background page in
//  the same round trip (unchanged contract from the JS side).
//
//  The extension no longer binds a socket: that moved to the always-on container app so
//  the bridge survives Safari quit/relaunch (see HTTPServer / BridgeClient). If the app
//  isn't running yet, the forward fails fast and we simply return no commands — the next
//  sync retries, exactly as before when the native host was momentarily down.
//
//  Privacy: logs event type, payload size and timing only — never state content.
//

import SafariServices
import os

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let log = Logger(subsystem: "com.trypwood.ytbridge", category: "handler")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        var commands: [[String: Any]] = []

        if let dict = message as? [String: Any],
           dict["type"] as? String == "sync" {
            let state = (dict["state"] as? [String: Any]) ?? ["active": false]
            // Forward to the container app's loopback ingest; it returns queued commands.
            commands = BridgeClient.forward(state: state)

            let active = (state["active"] as? Bool) ?? false
            Self.log.log("sync: active=\(active, privacy: .public) stateKeys=\(state.count, privacy: .public) cmdsOut=\(commands.count, privacy: .public)")
        } else {
            Self.log.error("ignored non-sync message")
        }

        let response = NSExtensionItem()
        let payload: [String: Any] = ["commands": commands]
        if #available(macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
