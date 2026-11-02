; Windows Tauri resource_dir is the executable directory ($INSTDIR).
; The preview overlay maps its payload to static-preview/ under that directory.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\static-preview"
!macroend
