# CPyVid / GMPAK generator Windows setup using an existing system Python + venv.
# PowerShell 5 compatible.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\setup_windows_venv_v3.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup_windows_venv_v3.ps1 -PythonExe "C:\Path\To\python.exe"
#
# Other override methods if your PowerShell dislikes parameters:
#   $env:PYTHON_EXE="C:\Path\To\python.exe"; .\setup_windows_venv_v3.ps1
#   echo C:\Path\To\python.exe > python_path.txt

param(
    [string]$PythonExe = "",
    [switch]$ForceVenv,
    [switch]$ForceFfmpeg
)

$ErrorActionPreference = 'Stop'

# ---- Config ----
$MinPyMajor = 3
$MinPyMinor = 8   # Accepts Phoebe's Python 3.8.10 + Tk 8.6. Change to 9 if you want 3.9+ only.

$Root       = (Get-Location).Path
$RuntimeDir = Join-Path $Root 'runtime'
$DownloadDir = Join-Path $RuntimeDir 'downloads'
$VenvDir    = Join-Path $RuntimeDir 'venv'
$VenvPy     = Join-Path $VenvDir 'Scripts\python.exe'
$VenvPip    = Join-Path $VenvDir 'Scripts\pip.exe'
$ToolsDir   = Join-Path $Root 'tools'

$FfmpegUrl  = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$FfmpegZip  = Join-Path $DownloadDir 'ffmpeg-release-essentials.zip'
$FfmpegDir  = Join-Path $RuntimeDir 'ffmpeg'
$FfmpegExe  = Join-Path $FfmpegDir 'bin\ffmpeg.exe'

New-Item -ItemType Directory -Force -Path $RuntimeDir, $DownloadDir | Out-Null

function Write-Step($Text) {
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Split-CommandLine([string]$Line) {
    # Good enough for our override cases. Use -PythonExe for paths with spaces.
    $Line = $Line.Trim()
    if ($Line.StartsWith('"')) {
        $end = $Line.IndexOf('"', 1)
        if ($end -gt 0) {
            $exe = $Line.Substring(1, $end - 1)
            $rest = $Line.Substring($end + 1).Trim()
            return @($exe, $rest)
        }
    }
    $parts = $Line -split '\s+', 2
    if ($parts.Count -eq 1) { return @($parts[0], '') }
    return @($parts[0], $parts[1])
}

function Test-PythonCandidate($Exe, $ArgString) {
    Write-Step "Checking Python candidate: $Exe $ArgString"

    $CheckPy = Join-Path $env:TEMP ('cpyvid_check_python_' + [guid]::NewGuid().ToString('N') + '.py')
    @"
import sys
try:
    import tkinter
except Exception as e:
    print('NO_TKINTER|' + repr(e))
    raise SystemExit(20)
print('EXE|' + sys.executable)
print('VER|%d.%d.%d' % sys.version_info[:3])
print('TK|' + str(tkinter.TkVersion))
if sys.version_info[:2] < ($MinPyMajor, $MinPyMinor):
    raise SystemExit(10)
raise SystemExit(0)
"@ | Set-Content -Path $CheckPy -Encoding UTF8

    $argsList = @()
    if ($ArgString -and $ArgString.Trim().Length -gt 0) {
        $argsList += ($ArgString -split '\s+')
    }
    $argsList += $CheckPy

    try {
        $out = & $Exe @argsList 2>&1
        $code = $LASTEXITCODE
    } catch {
        Remove-Item -Force $CheckPy -ErrorAction SilentlyContinue
        return $null
    }
    Remove-Item -Force $CheckPy -ErrorAction SilentlyContinue

    if ($code -ne 0) {
        foreach ($line in $out) { Write-Host "    $line" -ForegroundColor DarkGray }
        return $null
    }

    $result = @{}
    foreach ($line in $out) {
        $s = [string]$line
        if ($s.StartsWith('EXE|')) { $result.Exe = $s.Substring(4) }
        elseif ($s.StartsWith('VER|')) { $result.Ver = $s.Substring(4) }
        elseif ($s.StartsWith('TK|')) { $result.Tk = $s.Substring(3) }
    }
    if (-not $result.Exe) { return $null }
    return $result
}

function Find-SystemPython() {
    # 1) Explicit parameter
    if ($PythonExe -and $PythonExe.Trim().Length -gt 0) {
        return Test-PythonCandidate $PythonExe ''
    }

    # 2) Environment variable override
    if ($env:PYTHON_EXE -and $env:PYTHON_EXE.Trim().Length -gt 0) {
        return Test-PythonCandidate $env:PYTHON_EXE ''
    }

    # 3) Text-file override; handy for double-click / old PowerShell workflows
    $PythonPathTxt = Join-Path $Root 'python_path.txt'
    if (Test-Path $PythonPathTxt) {
        $line = (Get-Content $PythonPathTxt | Select-Object -First 1)
        if ($line) {
            $split = Split-CommandLine $line
            return Test-PythonCandidate $split[0] $split[1]
        }
    }

    # 4) py launcher and PATH candidates. Include 3.8 because OpenCV/Pillow can still be pinned for it.
    $candidates = @(
        @('py', '-3.13'),
        @('py', '-3.12'),
        @('py', '-3.11'),
        @('py', '-3.10'),
        @('py', '-3.9'),
        @('py', '-3.8'),
        @('py', '-3'),
        @('python', ''),
        @('python3', '')
    )

    foreach ($c in $candidates) {
        $r = Test-PythonCandidate $c[0] $c[1]
        if ($r) { return $r }
    }
    return $null
}

function Download-File-Reuse($Url, $Dest) {
    if (Test-Path $Dest) {
        Write-Step "Using existing download: $Dest"
        return
    }
    Write-Step "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

# ---- Locate Python ----
$py = Find-SystemPython
if (-not $py) {
    throw "No usable system Python found. Need Python $MinPyMajor.$MinPyMinor+ with tkinter. Try: .\setup_windows_venv_v3.ps1 -PythonExe C:\Path\To\python.exe  OR set PYTHON_EXE env var OR put the path in python_path.txt"
}

Write-Host "" 
Write-Host "Using Python:" -ForegroundColor Green
Write-Host "  $($py.Exe)"
Write-Host "  version $($py.Ver), tkinter $($py.Tk)"
Write-Host ""

# ---- Create / reuse venv ----
if ($ForceVenv -and (Test-Path $VenvDir)) {
    Write-Step "Removing existing venv"
    Remove-Item -Recurse -Force $VenvDir
}

if (-not (Test-Path $VenvPy)) {
    Write-Step "Creating venv at $VenvDir"
    & $py.Exe -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
} else {
    Write-Step "Reusing existing venv at $VenvDir"
}

Write-Step "Upgrading pip/setuptools/wheel"
& $VenvPy -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }

# ---- Requirements ----
$ProjectReq = Join-Path $Root 'requirements.txt'
$CompatReq = Join-Path $RuntimeDir 'requirements-resolved.txt'

$minor = [int](($py.Ver -split '\.')[1])
if ($minor -eq 8) {
    Write-Step "Python 3.8 detected; using pinned compatibility requirements"
    @"
numpy<2
Pillow==10.4.0
opencv-python==4.10.0.84
"@ | Set-Content -Path $CompatReq -Encoding ASCII
    & $VenvPy -m pip install --no-warn-script-location -r $CompatReq
} elseif (Test-Path $ProjectReq) {
    Write-Step "Installing requirements.txt"
    & $VenvPy -m pip install --no-warn-script-location -r $ProjectReq
} else {
    Write-Step "requirements.txt not found; installing default packages"
    & $VenvPy -m pip install --no-warn-script-location pillow opencv-python numpy
}
if ($LASTEXITCODE -ne 0) { throw "requirements installation failed" }

# ---- Verify Python packages + tkinter inside venv ----
Write-Step "Verifying venv imports"
& $VenvPy -c "import sys, tkinter, PIL, cv2, numpy; print(sys.executable); print('tk', tkinter.TkVersion); print('PIL/cv2/numpy OK')"
if ($LASTEXITCODE -ne 0) { throw "venv import verification failed" }

# ---- FFmpeg ----
if ($ForceFfmpeg -and (Test-Path $FfmpegDir)) {
    Write-Step "Removing existing FFmpeg"
    Remove-Item -Recurse -Force $FfmpegDir
}

if (-not (Test-Path $FfmpegExe)) {
    Download-File-Reuse $FfmpegUrl $FfmpegZip

    $ExtractTmp = Join-Path $RuntimeDir 'ffmpeg_extract_tmp'
    if (Test-Path $ExtractTmp) { Remove-Item -Recurse -Force $ExtractTmp }
    New-Item -ItemType Directory -Force -Path $ExtractTmp | Out-Null

    Write-Step "Extracting FFmpeg"
    Expand-Archive -Path $FfmpegZip -DestinationPath $ExtractTmp -Force

    $bin = Get-ChildItem -Path $ExtractTmp -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
    if (-not $bin) { throw "ffmpeg.exe not found inside downloaded ZIP" }

    $sourceRoot = Split-Path (Split-Path $bin.FullName -Parent) -Parent
    if (Test-Path $FfmpegDir) { Remove-Item -Recurse -Force $FfmpegDir }
    Copy-Item -Path $sourceRoot -Destination $FfmpegDir -Recurse
    Remove-Item -Recurse -Force $ExtractTmp
} else {
    Write-Step "Reusing existing FFmpeg at $FfmpegExe"
}

# ---- Ensure tools folder / fxconv path ----
if (-not (Test-Path $ToolsDir)) { New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null }
$RootFxconv = Join-Path $Root 'fxconv.py'
$ToolsFxconv = Join-Path $ToolsDir 'fxconv.py'
if ((Test-Path $RootFxconv) -and (-not (Test-Path $ToolsFxconv))) {
    Copy-Item $RootFxconv $ToolsFxconv -Force
    Write-Step "Copied fxconv.py into tools\fxconv.py"
}

# ---- Create launchers ----
$RunGuiBat = @"
@echo off
setlocal
pushd "%~dp0"
set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
"%~dp0runtime\venv\Scripts\python.exe" "%~dp0enc3.py" %*
popd
"@
Set-Content -Path (Join-Path $Root 'run_gui.bat') -Value $RunGuiBat -Encoding ASCII

$MakePakBat = @"
@echo off
setlocal
pushd "%~dp0"
set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
powershell -ExecutionPolicy Bypass -File "%~dp0make_gmpak.ps1" %*
popd
"@
Set-Content -Path (Join-Path $Root 'make_gmpak.bat') -Value $MakePakBat -Encoding ASCII

# Create make_gmpak.ps1 if absent.
$MakePakPs1 = Join-Path $Root 'make_gmpak.ps1'
if (-not (Test-Path $MakePakPs1)) {
@'
param(
    [Parameter(Position=0, Mandatory=$true)] [string]$InputVideo,
    [int]$Fps = 2,
    [int]$Width = 320,
    [int]$Height = 528,
    [string]$Mode = "stretch",
    [string]$Format = "Color",
    [string]$Colors = "8",
    [string]$Profile = "p4_rgb565",
    [string]$OutputPak = "VIDEO.gmpak"
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = Join-Path $Root 'runtime\venv\Scripts\python.exe'
$env:PATH = (Join-Path $Root 'runtime\ffmpeg\bin') + ';' + $env:PATH
$Prep = Join-Path $Root 'output_prep.mp4'
$Frames = Join-Path $Root 'frames_fx'

& $Py (Join-Path $Root 'enc3.py') $InputVideo -o $Prep --fps $Fps --width $Width --height $Height --mode $Mode --format $Format --colors $Colors --audio strip
if ($LASTEXITCODE -ne 0) { throw 'enc3.py failed' }
& $Py (Join-Path $Root 'video_frames_to_fxconv_py.py') $Prep $Frames --profile $Profile --fxconv (Join-Path $Root 'tools\fxconv.py')
if ($LASTEXITCODE -ne 0) { throw 'video_frames_to_fxconv_py.py failed' }
& $Py (Join-Path $Root 'gmpak_pack_v2.py') $Frames (Join-Path $Root $OutputPak) $Fps
if ($LASTEXITCODE -ne 0) { throw 'gmpak_pack_v2.py failed' }
Write-Host "Created $OutputPak" -ForegroundColor Green
'@ | Set-Content -Path $MakePakPs1 -Encoding UTF8
}

Write-Host ""
Write-Host "==> Done." -ForegroundColor Green
Write-Host "Python venv: $VenvDir"
Write-Host "FFmpeg:      $FfmpegExe"
Write-Host "GUI:         .\run_gui.bat"
Write-Host "Pack video:  .\make_gmpak.bat input.mp4 -Fps 2 -Width 320 -Height 528 -Mode stretch -Format Color -Colors 8 -OutputPak VIDEO.gmpak"
Write-Host ""
