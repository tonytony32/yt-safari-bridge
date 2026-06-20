//
//  main.swift
//  YTBridge  (container app)
//
//  Explicit programmatic entry point. This app has no main storyboard (it's a headless
//  background agent), so nothing else would create NSApplication, install the delegate, or
//  start the run loop. Doing it here guarantees `applicationDidFinishLaunching` fires — which
//  is where the bridge socket gets bound. `.accessory` activation = agent (no Dock icon, no
//  menu bar), matching the LSUIElement Info.plist key.
//

import Cocoa

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
