#!/usr/bin/env python3
"""Make the showcase's Metro warm-up fetch the *exact* bundle variant the app requests.

Upstream warms `index.bundle?platform=..&dev=true&minify=false`, but the dev client requests
`index.ts.bundle?...&transform.engine=hermes&transform.bytecode=1&...reactCompiler=true...`,
which is a separate, cold, multi-minute transform on a 3-vCPU runner. The warm-up is a blocking
curl, so warming the real variant makes the showcase wait until the app's bundle is ready.
"""
import sys

path = sys.argv[1]
src = open(path).read()

old = "/apps/mobile/index.bundle?platform=${platform}&dev=true&minify=false"
new = (
    "/apps/mobile/index.ts.bundle?platform=${platform}&dev=true&hot=false&lazy=true"
    "&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app"
    "&transform.reactCompiler=true&unstable_transformProfile=hermes-stable"
)
if old not in src:
    print("WARN: warm-url patch anchor not found")
    sys.exit(0)
open(path, "w").write(src.replace(old, new, 1))
print("warm-url patch applied")
