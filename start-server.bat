@echo off
REM Bat server Lark MCP remote, giu cua so hien de nhin thay trang thai.
REM Dong cua so nay = tat server, ca cong ty mat ket noi.
REM
REM Vong lap duoi day de phong node chet han (crash, OOM). Supervisor tu lo
REM server con + tunnel; chi khi ban than supervisor tat thi moi vao day.

title Lark MCP Remote - DANG CHAY (dong cua so nay se tat server)
cd /d "%~dp0"

echo ============================================================
echo   LARK MCP REMOTE - SERVER
echo   Cua so nay phai de MO. Dong lai la moi nguoi mat ket noi.
echo   Ctrl+C de dung han.
echo ============================================================
echo.

:loop
node supervisor.js
set CODE=%errorlevel%

REM Ma 3 = da co server khac giu cong 8787. Bat lai chi tao vong lap
REM EADDRINUSE vo ich, nen dung tai day.
if "%CODE%"=="3" goto busy
REM Ma 0 = Ctrl+C, nguoi dung chu dong dung.
if "%CODE%"=="0" goto stopped

echo.
echo [%time:~0,8%] SUPERVISOR TAT BAT THUONG (ma=%CODE%) - bat lai sau 10s.
echo             Ctrl+C bay gio neu ban muon dung han.
timeout /t 10 /nobreak > nul
goto loop

:busy
echo.
echo Da co mot server khac dang chay o cong 8787. Khong bat them.
goto end

:stopped
echo.
echo Server da dung theo lenh cua ban.
goto end

:end
echo Nhan phim bat ky de dong.
pause > nul
