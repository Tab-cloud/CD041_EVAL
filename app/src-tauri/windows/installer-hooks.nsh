!macro NSIS_HOOK_PREINSTALL
  ; Stop the installed app and its sidecar before NSIS replaces their files.
  Push $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Process -Name eval-agent,eval-server -ErrorAction SilentlyContinue | Stop-Process -Force"'
  Pop $0
  Sleep 700

  ; A sidecar may still be finishing its shutdown after its parent exits.
  ; Run a second hidden pass so an in-place upgrade cannot hit a locked EXE.
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Process -Name eval-server -ErrorAction SilentlyContinue | Stop-Process -Force"'
  Pop $0
  Pop $0
!macroend
