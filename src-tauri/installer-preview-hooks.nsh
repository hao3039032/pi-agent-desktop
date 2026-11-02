; Preview-only payload cleanup. Never remove agent data or another app's files.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\resources\static-preview"
!macroend
