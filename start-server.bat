@echo off
REM Bat server Lark MCP remote, giu cua so hien de nhin thay trang thai.
REM Dong cua so nay = tat server, ca cong ty mat ket noi.

title Lark MCP Remote - DANG CHAY (dong cua so nay se tat server)
cd /d "%~dp0"

echo ============================================================
echo   LARK MCP REMOTE - SERVER
echo   Cua so nay phai de MO. Dong lai la moi nguoi mat ket noi.
echo   Ctrl+C de dung han.
echo ============================================================
echo.

node supervisor.js

echo.
echo Server da dung. Nhan phim bat ky de dong.
pause > nul
