#!/usr/bin/env python3
"""Patch the throwaway checkout's scripts/mobile-showcase.ts for free macOS runners.

expo-dev-launcher on these runners ignores the `--initialUrl` simctl launch arg (the app never
connects to Metro and stays on "Searching for development servers"). Also deliver the standard
dev-client deep link and tap the system "Open" prompt with AXe.
"""
import sys

path = sys.argv[1]
src = open(path).read()

needle = (
    '      "--showcaseOrientation",\n'
    '      capture.device.orientation ?? "portrait",\n'
    "    ]);\n"
    "  };"
)
replacement = (
    '      "--showcaseOrientation",\n'
    '      capture.device.orientation ?? "portrait",\n'
    "    ]);\n"
    "    await delay(4000);\n"
    '    await runCommand("xcrun", [\n'
    '      "simctl",\n'
    '      "openurl",\n'
    "      simulator.udid,\n"
    "      `t3code://expo-development-client/?url=${encodeURIComponent(metroUrl)}`,\n"
    "    ]).catch(() => undefined);\n"
    "    await delay(3000);\n"
    '    // System "Open in T3 Code?" alert is invisible to AXe label lookup; tap its Open button by\n'
    "    // point (iPhone 17 Pro Max, 440x956 pt). Harmless blank-area tap if no alert is shown.\n"
    '    await runCommand("axe", ["tap", "-x", "293", "-y", "515", "--udid", simulator.udid]).catch(\n'
    "      () => undefined,\n"
    "    );\n"
    "  };"
)

if needle not in src:
    print("WARN: deep-link patch anchor not found")
    sys.exit(0)
open(path, "w").write(src.replace(needle, replacement, 1))
print("deep-link patch applied")
