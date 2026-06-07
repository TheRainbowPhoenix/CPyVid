param(
    [string]$InputVideo,
    [string]$OutputPak = '',
    [int]$Fps = 2,
    [int]$Width = 320,
    [int]$Height = 528,
    [string]$Mode = 'stretch',
    [string]$Format = 'Color',
    [string]$Colors = '8',
    [string]$Dither = 'None',
    [string]$Audio = 'strip',
    [string]$Profile = 'p4_rgb565',
    [string]$PrepMp4 = '',
    [string]$FramesDir = '',
    [string]$SkipPrep = '0'
)

$ErrorActionPreference = 'Stop'

if ($InputVideo -eq '') {
    Write-Host 'Usage:'
    Write-Host '  .\make_gmpak.ps1 input.mp4'
    Write-Host '  .\make_gmpak.ps1 input.mp4 VIDEO.gmpak -Fps 10'
    exit 1
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Root -eq '') { $Root = '.' }

$PythonExe = Join-Path $Root 'runtime\venv\Scripts\python.exe'
$OldPythonExe = Join-Path $Root 'runtime\python\python.exe'
if (-not (Test-Path $PythonExe)) {
    if (Test-Path $OldPythonExe) {
        $PythonExe = $OldPythonExe
    } else {
        throw 'Missing Python runtime. Run setup_windows_venv_v3.ps1 first.'
    }
}

$FfmpegBin = Join-Path $Root 'runtime\ffmpeg\bin'
$FfmpegExe = Join-Path $FfmpegBin 'ffmpeg.exe'
if (-not (Test-Path $FfmpegExe)) {
    throw 'Missing runtime\ffmpeg\bin\ffmpeg.exe. Run setup_windows_venv_v3.ps1 first.'
}

$Fxconv = Join-Path $Root 'tools\fxconv.py'
if (-not (Test-Path $Fxconv)) {
    $Fxconv = Join-Path $Root 'fxconv.py'
}
if (-not (Test-Path $Fxconv)) {
    throw 'Missing fxconv.py. Expected tools\fxconv.py or fxconv.py next to this script.'
}

$Enc3 = Join-Path $Root 'enc3.py'
$FramesTool = Join-Path $Root 'video_frames_to_fxconv_py.py'
$Packer = Join-Path $Root 'gmpak_pack_v2.py'

if (-not (Test-Path $Enc3)) { throw 'Missing enc3.py next to make_gmpak.ps1.' }
if (-not (Test-Path $FramesTool)) { throw 'Missing video_frames_to_fxconv_py.py next to make_gmpak.ps1.' }
if (-not (Test-Path $Packer)) { throw 'Missing gmpak_pack_v2.py next to make_gmpak.ps1.' }

$Leaf = Split-Path -Leaf $InputVideo
$Base = $Leaf -replace '\.[^.]*$', ''
if ($Base -eq '') { $Base = 'VIDEO' }

if ($OutputPak -eq '') {
    $OutputPak = Join-Path $Root ($Base + '.gmpak')
}
if ($PrepMp4 -eq '') {
    $PrepMp4 = Join-Path $Root ($Base + '_prep.mp4')
}
if ($FramesDir -eq '') {
    $FramesDir = Join-Path $Root ($Base + '_frames_fx')
}

$env:PATH = $FfmpegBin + ';' + $env:PATH

Write-Host '==> Using Python:' $PythonExe
Write-Host '==> Using FFmpeg:' $FfmpegExe
Write-Host '==> Input video:' $InputVideo
Write-Host '==> Prepared MP4:' $PrepMp4
Write-Host '==> Frames folder:' $FramesDir
Write-Host '==> Output GMPAK:' $OutputPak
Write-Host ''

if ($SkipPrep -ne '1') {
    Write-Host '==> 1/3 Preparing MP4'
    & $PythonExe $Enc3 $InputVideo -o $PrepMp4 --fps $Fps --width $Width --height $Height --mode $Mode --format $Format --colors $Colors --dither $Dither --audio $Audio
    if ($LASTEXITCODE -ne 0) { throw 'enc3.py failed.' }
} else {
    Write-Host '==> 1/3 Skipping MP4 prep'
}

Write-Host '==> 2/3 Converting frames to fxconv-style Python'
& $PythonExe $FramesTool $PrepMp4 $FramesDir --fxconv $Fxconv --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'video_frames_to_fxconv_py.py failed.' }

Write-Host '==> 3/3 Packing GMPAK'
& $PythonExe $Packer $FramesDir $OutputPak $Fps
if ($LASTEXITCODE -ne 0) { throw 'gmpak_pack_v2.py failed.' }

Write-Host ''
Write-Host '==> Done:' $OutputPak
