#!/usr/bin/env python3
"""Patch the throwaway checkout's scripts/mobile-showcase.ts for free macOS runners.

expo-dev-launcher on these runners ignores the `--initialUrl` simctl launch arg. Instead, after
launch, drive the launcher's own "Enter URL manually" form with AXe (no system "Open in ...?"
alert, which AXe cannot see through).
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
    "    const axe = (args: string[]) =>\n"
    '      runCommand("axe", [...args, "--udid", simulator.udid]).catch(() => undefined);\n'
    "    await delay(8000);\n"
    '    await axe(["tap", "--label", "Enter URL manually"]);\n'
    "    await delay(2000);\n"
    '    await axe(["type", metroUrl]);\n'
    "    await delay(1000);\n"
    '    await axe(["tap", "--label", "Connect"]);\n'
    "  };"
)

if needle not in src:
    print("WARN: manual-url patch anchor not found")
    sys.exit(0)
open(path, "w").write(src.replace(needle, replacement, 1))
print("manual-url patch applied")
