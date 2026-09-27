# CI evidence only (build-windows.yml): renders CloudBox Status against sample pipe documents and the Setup welcome
# screen on the windows-latest desktop, and saves PNGs. Not shipped; the samples are fictional.
# Nothing here may block: the fake pipe server is a separate process with its own deadline that is also hard-killed,
# and every window is force-stopped after its screenshot.
param([string]$Publish = "publish", [string]$Out = "screenshots")
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# Serves the given document to each pipe client until the deadline, then exits. Never waits without a timeout.
$serverScript = Join-Path $env:TEMP "cbx-fake-pipe.ps1"
@'
param([string]$DocPath, [int]$Seconds)
$doc = Get-Content $DocPath -Raw
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $pipe = New-Object System.IO.Pipes.NamedPipeServerStream("CloudBoxAgent", [System.IO.Pipes.PipeDirection]::Out, 1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous)
  try {
    $wait = $pipe.WaitForConnectionAsync()
    while (-not $wait.Wait(500)) { if ((Get-Date) -ge $deadline) { exit 0 } }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($doc)
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
    Start-Sleep -Milliseconds 200
  } catch { } finally { $pipe.Dispose() }
}
'@ | Set-Content $serverScript

foreach ($sample in Get-ChildItem "$PSScriptRoot/samples/*.json") {
  $server = Start-Process pwsh -ArgumentList "-NoProfile", "-File", $serverScript, $sample.FullName, "30" -PassThru -WindowStyle Hidden
  Start-Sleep 3
  $status = Start-Process "$Publish/status/CloudBox.Status.exe" -PassThru
  Start-Sleep 12
  Shot "status-$($sample.BaseName)"
  Stop-Process -Id $status.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep 1
}

$setup = Start-Process "$Publish/setup/CloudBox.Server.Setup.exe" -PassThru
Start-Sleep 40
Shot "setup-welcome"
Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue
Get-Process CloudBox.* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-ChildItem $Out | Format-Table Name, Length -AutoSize
