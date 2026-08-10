# Đăng ký server tự bật mỗi khi đăng nhập Windows.
#
# Dùng thư mục Startup của người dùng, KHÔNG dùng Task Scheduler hay Windows
# Service:
#   - schtasks trên máy này trả "Access is denied" (bị chính sách chặn)
#   - Service chạy ẩn, không ai nhìn thấy nó sống hay chết — mà yêu cầu là
#     "phải nhìn thấy và luôn bật"
# Startup folder không cần quyền admin và mở hẳn một cửa sổ console.
#
#   Cài : powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#   Gỡ  : powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove

param([switch]$Remove)

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bat     = Join-Path $Root 'start-server.bat'
$Startup = [Environment]::GetFolderPath('Startup')
$Link    = Join-Path $Startup 'LarkMcpRemote.cmd'

if ($Remove) {
  if (Test-Path $Link) { Remove-Item $Link -Force; Write-Host "Da go: $Link" }
  else { Write-Host 'Chua dang ky tu khoi dong.' }
  Write-Host 'Server dang chay van tiep tuc cho toi khi ban dong cua so.'
  exit 0
}

if (-not (Test-Path $Bat)) { Write-Error "Khong thay $Bat"; exit 1 }

# Launcher mong: chi goi sang start-server.bat, de sua .bat khong phai cai lai
@"
@echo off
call "$Bat"
"@ | Set-Content -Path $Link -Encoding ASCII

Write-Host ''
Write-Host 'Da dang ky tu khoi dong.'
Write-Host "  $Link"
Write-Host ''
Write-Host 'LUU Y:'
Write-Host '  - Chay khi DANG NHAP Windows, khong phai khi bat may.'
Write-Host '    May reboot ma chua ai dang nhap thi server chua chay.'
Write-Host '  - May sleep thi server ngu theo. Dat Power Options ->'
Write-Host '    "Put the computer to sleep: Never" neu muon phuc vu 24/7.'
Write-Host '  - Cua so console phai de MO. Dong lai la tat server.'
