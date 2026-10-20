; Tauri's NSIS installer only adds files: an overwrite install never clears
; the previous payload, so a stale resources/server/node_modules keeps
; shadowing the freshly installed one through Node's nearest-module
; resolution and crashes the server at import time (issue #72).
;
; NSIS_HOOK_PREINSTALL runs before the installer writes any file, after it
; has confirmed the app is not running. node_modules is pure payload —
; nothing writes into it at runtime — so dropping it here is always safe:
; the installer immediately writes a complete fresh tree over it.
;
; The same goes for the page cache (issue #149): the package ships no
; server\route-cache, Next writes one at runtime from the build's prerendered
; pages and reads it before them, so an upgrade would keep serving the old UI.
; desktop-server.cjs repeats this check on start for installs made before the
; hook existed.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\resources\server\node_modules"
  ; Next's runtime route-cache wins over fresh prerendered pages, and its
  ; namespace is route-based rather than build-id-based, so an upgrade would
  ; keep serving the previous UI. Clear it explicitly, then drop the whole
  ; generated build payload (which subsumes it) so old HTML/RSC and hashed JS
  ; cannot survive either. The installer immediately writes the new build;
  ; sessions and settings live outside it.
  RMDir /r "$INSTDIR\resources\server\.next-desktop\server\route-cache"
  RMDir /r "$INSTDIR\resources\server\.next-desktop"
!macroend
