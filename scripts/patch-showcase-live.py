#!/usr/bin/env python3
"""Live mode only: stop the showcase coordinator from yanking the app back to its fixture route.

ShowcaseCaptureCoordinator re-dispatches a navigation whenever the current route's scene differs from the
requested scene (effect deps include `scene`). Opening a live mock thread by hand changes the route, so the app
snaps back to the list. Patch (throwaway checkout, JS only, no native rebuild): navigate once per requested
scene request, so manual taps/BACK stick. Requesting a *different* scene (via the scene file) still navigates.
"""
import sys

path = sys.argv[1]
src = open(path).read()

decl_old = "  const requestedSceneRef = useRef<ShowcaseScene | null>(null);\n"
decl_new = decl_old + "  const liveNavDoneRef = useRef<ShowcaseScene | null>(null);\n"
guard_old = "    if (scene === requestedScene) return;\n"
guard_new = (
    guard_old
    + "    if (liveNavDoneRef.current === requestedScene) return;\n"
    + "    liveNavDoneRef.current = requestedScene;\n"
)
set_old = "      setRequestedScene(value);\n"
set_new = "      liveNavDoneRef.current = null;\n" + set_old
if decl_old not in src or src.count(guard_old) != 1 or src.count(set_old) != 1:
    print("WARN: live-nav patch anchors not found; the coordinator will pull the app back to fixture routes")
    sys.exit(1)
src = src.replace(decl_old, decl_new, 1).replace(guard_old, guard_new, 1).replace(set_old, set_new, 1)
open(path, "w").write(src)
print("live-nav patch applied")
