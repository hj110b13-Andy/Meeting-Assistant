@echo off
REM Chrome Native Messaging 主機的啟動器。
REM Chrome 只能執行 .exe / .bat，所以用這支轉呼 PowerShell。
REM -NonInteractive 與 -NoProfile 很重要：使用者的 profile 若印出任何字，
REM 會混進 stdout 破壞 Native Messaging 的二進位協定。
REM 注意：本檔必須是 CRLF 換行。cmd.exe 讀 LF-only 批次檔會把指令 token 切錯，
REM 症狀是 powershell.exe 被拆成 powershell. 與 exe，主機一啟動就死。
REM 用完整路徑而不是裸 powershell.exe：Windows 預設會把 v1.0 目錄放進 PATH，
REM 但那是可以被改掉的（實測有機器只留 System32、沒有該子目錄），
REM 此時裸呼叫會得到「不是內部或外部命令」，主機讀到 0 bytes 就結束，
REM 症狀看起來像「橋接沒回應」，完全不指向 PATH。
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0host.ps1"
