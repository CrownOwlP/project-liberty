@echo off
setlocal
cd /d "%~dp0.."
echo Project Liberty AI Engineering Control Plane
call npm run ai:validate || exit /b 1
call npm run ai:sync || exit /b 1
call npm run repo:validate || exit /b 1
call npm run ai:status || exit /b 1
call npm run ai:dispatch || exit /b 1
endlocal
