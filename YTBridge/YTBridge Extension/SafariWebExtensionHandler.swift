//
//  SafariWebExtensionHandler.swift
//  YTBridge Extension
//
//  Receives `{type:"sync", state}` from the background relay, stores it in the
//  StateStore, drains any queued commands back in the reply, and (once per process)
//  starts the NWListener bind spike that keeps the local HTTP server alive.
//
//  Privacy: logs event type, payload size and timing only — never state content.
//

import SafariServices
import os

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let log = Logger(subsystem: "com.trypwood.ytbridge", category: "handler")

    func beginRequest(with context: NSExtensionContext) {
        // Ensure the local HTTP server is up on every sync — it self-heals if
        // the system tore the listener down while the extension was suspended.
        HTTPServer.shared.ensureRunning()

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
            StateStore.shared.update(state: state)
            commands = StateStore.shared.drainCommands()

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
