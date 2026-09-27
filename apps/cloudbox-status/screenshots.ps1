# CI evidence only (build-windows.yml): renders CloudBox Status against sample pipe documents and the Setup welcome
# screen on the windows-latest desktop, and saves PNGs. Not shipped; the samples are fictional.
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

foreach ($sample in Get-ChildItem "$PSScriptRoot/samples/*.json") {
  $json = Get-Content $sample.FullName -Raw
  $server = Start-Job -ArgumentList $json -ScriptBlock {
    param($doc)
    while ($true) {
      $pipe = New-Object System.IO.Pipes.NamedPipeServerStream("CloudBoxAgent", [System.IO.Pipes.PipeDirection]::Out)
      $pipe.WaitForConnection()
      $w = New-Object System.IO.StreamWriter($pipe)
      $w.Write($doc); $w.Flush(); $pipe.WaitForPipeDrain(); $pipe.Dispose()
    }
  }
  Start-Sleep 3
  $status = Start-Process "$Publish/status/CloudBox.Status.exe" -PassThru
  Start-Sleep 12
  Shot "status-$($sample.BaseName)"
  Stop-Process $status -Force
  Stop-Job $server; Remove-Job $server -Force
}

$setup = Start-Process "$Publish/setup/CloudBox.Server.Setup.exe" -PassThru
Start-Sleep 40
Shot "setup-welcome"
Stop-Process $setup -Force -ErrorAction SilentlyContinue
Get-ChildItem $Out | Format-Table Name, Length -AutoSize
