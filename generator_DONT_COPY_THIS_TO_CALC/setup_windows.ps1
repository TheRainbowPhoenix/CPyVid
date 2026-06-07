#!/usr/bin/env pwsh
# CPvid/GMPAK Windows prep script
# Requires: Windows PowerShell 5+ or PowerShell 7+, internet access
$ErrorActionPreference = 'Stop'

# -------------------- Config --------------------
# Use the normal Python installer, not the embeddable ZIP, because enc3.py uses tkinter.
# The embeddable ZIP intentionally omits tkinter/Tcl/Tk, which makes the GUI path fragile.
$PythonVersion = '3.11.9'
$PythonArch    = 'amd64'   # amd64 or win32
$PythonInstallerName = "python-$PythonVersion-$PythonArch.exe"
$PythonUrl     = "https://www.python.org/ftp/python/$PythonVersion/$PythonInstallerName"

$FfmpegUrl     = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

$Root          = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir    = Join-Path $Root 'runtime'
$DownloadsDir  = Join-Path $RuntimeDir 'downloads'
$PyDir         = Join-Path $RuntimeDir 'python'
$PythonExe     = Join-Path $PyDir 'python.exe'
$FfmpegDir     = Join-Path $RuntimeDir 'ffmpeg'
$FfmpegExe     = Join-Path $FfmpegDir 'bin\ffmpeg.exe'
$ToolsDir      = Join-Path $Root 'tools'
$ReqFile       = Join-Path $Root 'requirements.txt'

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Find-CachedFile([string]$FileName) {
    $candidates = @(
        (Join-Path $DownloadsDir $FileName),
        (Join-Path $Root $FileName)
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Download-File([string]$Url, [string]$OutFile) {
    if (Test-Path -LiteralPath $OutFile) {
        Write-Host "==> Using cached $(Split-Path -Leaf $OutFile)" -ForegroundColor DarkGray
        return
    }
    Write-Host "==> Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

Ensure-Dir $RuntimeDir
Ensure-Dir $DownloadsDir

# -------------------- Python with tkinter --------------------
$NeedPython = $true
if ((Test-Path -LiteralPath $PythonExe) -and (-not $ForcePython)) {
    try {
        $ver = & $PythonExe -c "import sys; print('.'.join(map(str, sys.version_info[:3])))"
        & $PythonExe -c "import tkinter; print('tkinter OK')" | Out-Null
        if ($ver -eq $PythonVersion) {
            Write-Host "==> Existing local Python $ver with tkinter found" -ForegroundColor Green
            $NeedPython = $false
        } else {
            Write-Host "==> Existing local Python is $ver, expected $PythonVersion; reinstalling" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "==> Existing Python is missing tkinter or broken; reinstalling" -ForegroundColor Yellow
    }
}

if ($NeedPython) {
    if (Test-Path -LiteralPath $PyDir) {
        Write-Host "==> Removing old Python folder"
        Remove-Item -Recurse -Force -LiteralPath $PyDir
    }
    Ensure-Dir $PyDir

    $CachedInstaller = Find-CachedFile $PythonInstallerName
    if ($CachedInstaller) {
        $PyInstaller = $CachedInstaller
        Write-Host "==> Reusing Python installer: $PyInstaller" -ForegroundColor DarkGray
    } else {
        $PyInstaller = Join-Path $DownloadsDir $PythonInstallerName
        Download-File $PythonUrl $PyInstaller
    }

    Write-Host "==> Installing Python $PythonVersion into $PyDir"

    # IMPORTANT: Use a single quoted argument string. Start-Process does not
    # reliably preserve quoting for paths with spaces when -ArgumentList is an array.
    $InstallArgs = @(
        '/quiet',
        'InstallAllUsers=0',
        "TargetDir=`"$PyDir`"",
        'Include_pip=1',
        'Include_tcltk=1',
        'Include_test=0',
        'Include_doc=0',
        'Include_launcher=0',
        'AssociateFiles=0',
        'Shortcuts=0',
        'PrependPath=0'
    ) -join ' '

    $p = Start-Process -FilePath $PyInstaller -ArgumentList $InstallArgs -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        throw "Python installer failed with exit code $($p.ExitCode)"
    }

    if (-not (Test-Path -LiteralPath $PythonExe)) {
        Write-Warning "python.exe was not found at the expected path. Searching under runtime..."
        $found = Get-ChildItem -Path $RuntimeDir -Recurse -Filter python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            Write-Warning "Found python.exe at: $($found.FullName)"
            throw "Python installed to the wrong folder. This usually means the installer ignored TargetDir. Delete runtime\python and rerun setup_windows_v2.ps1, or send me the path above."
        }
        throw "python.exe was not created at $PythonExe"
    }
}

Write-Host "==> Verifying Python and tkinter"
& $PythonExe -c "import sys, tkinter; print(sys.version); print('tkinter OK:', tkinter.TkVersion)"

Write-Host "==> Upgrading pip"
& $PythonExe -m pip install --upgrade pip

# -------------------- Python requirements --------------------
if (-not (Test-Path -LiteralPath $ReqFile)) {
    Write-Host "==> Creating default requirements.txt"
@'
pillow
opencv-python
numpy
'@ | Set-Content -Path $ReqFile -Encoding ASCII
}

Write-Host "==> Installing requirements from requirements.txt"
& $PythonExe -m pip install --no-warn-script-location -r $ReqFile

# -------------------- FFmpeg --------------------
if ((Test-Path -LiteralPath $FfmpegExe) -and (-not $ForceFfmpeg)) {
    Write-Host "==> Existing FFmpeg found" -ForegroundColor Green
} else {
    if (Test-Path -LiteralPath $FfmpegDir) {
        Remove-Item -Recurse -Force -LiteralPath $FfmpegDir
    }

    $FfmpegZipName = 'ffmpeg-release-essentials.zip'
    $FfmpegZipCached = Find-CachedFile $FfmpegZipName
    if ($FfmpegZipCached) {
        $FfmpegZip = $FfmpegZipCached
        Write-Host "==> Reusing FFmpeg ZIP: $FfmpegZip" -ForegroundColor DarkGray
    } else {
        $FfmpegZip = Join-Path $DownloadsDir $FfmpegZipName
        Download-File $FfmpegUrl $FfmpegZip
    }

    $FfmpegExtract = Join-Path $RuntimeDir 'ffmpeg_extract'
    if (Test-Path -LiteralPath $FfmpegExtract) { Remove-Item -Recurse -Force -LiteralPath $FfmpegExtract }
    Ensure-Dir $FfmpegExtract

    Write-Host "==> Extracting FFmpeg"
    Expand-Archive -Path $FfmpegZip -DestinationPath $FfmpegExtract -Force

    $FoundFfmpeg = Get-ChildItem -Path $FfmpegExtract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $FoundFfmpeg) {
        throw "Could not find ffmpeg.exe after extracting $FfmpegZip"
    }

    $SourceRoot = Split-Path -Parent (Split-Path -Parent $FoundFfmpeg.FullName)
    Ensure-Dir $FfmpegDir
    Copy-Item -Path (Join-Path $SourceRoot '*') -Destination $FfmpegDir -Recurse -Force
    Remove-Item -Recurse -Force -LiteralPath $FfmpegExtract
}

Write-Host "==> Verifying FFmpeg"
& $FfmpegExe -version | Select-Object -First 1

# -------------------- fxconv.py placement --------------------
Ensure-Dir $ToolsDir
$RootFxconv = Join-Path $Root 'fxconv.py'
$ToolsFxconv = Join-Path $ToolsDir 'fxconv.py'
if ((Test-Path -LiteralPath $RootFxconv) -and (-not (Test-Path -LiteralPath $ToolsFxconv))) {
    Copy-Item -Path $RootFxconv -Destination $ToolsFxconv -Force
    Write-Host "==> Copied fxconv.py to tools\fxconv.py"
}
if (-not (Test-Path -LiteralPath $ToolsFxconv)) {
    Write-Warning "tools\fxconv.py is missing. Put fxconv.py there, or pass --fxconv to video_frames_to_fxconv_py.py."
}

# -------------------- Runner helpers --------------------
$RunGuiBat = @"
@echo off
setlocal
pushd "%~dp0"
set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
"%~dp0runtime\python\python.exe" "%~dp0enc3.py"
popd
endlocal
"@
Set-Content -Path (Join-Path $Root 'run_gui.bat') -Value $RunGuiBat -Encoding ASCII

$MakeBat = @"
@echo off
setlocal
pushd "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0make_gmpak.ps1" %*
popd
endlocal
"@
Set-Content -Path (Join-Path $Root 'make_gmpak.bat') -Value $MakeBat -Encoding ASCII

Write-Host ""
Write-Host "==> Done." -ForegroundColor Green
Write-Host "Python:   $PythonExe"
Write-Host "FFmpeg:   $FfmpegExe"
Write-Host "GUI:      .\run_gui.bat"
Write-Host "Pipeline: .\make_gmpak.bat input.mp4 -Fps 2 -Width 320 -Height 528 -Mode stretch -Format Color -Colors 8 -OutputPak VIDEO.gmpak"
Write-Host ""
