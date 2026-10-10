@echo off
REM Double-clickable wrapper. The work is in collect-evidence.ps1 -- kept as a
REM .ps1 rather than inlined here because a one-line batch/PowerShell hybrid
REM is a string-escaping problem nobody can test, and this script's only job
REM is to be reliable on a machine that has nothing else installed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-evidence.ps1"
pause
