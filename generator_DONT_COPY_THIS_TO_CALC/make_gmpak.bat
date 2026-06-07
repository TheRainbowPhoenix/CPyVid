@echo off
setlocal
pushd "%~dp0"
set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
powershell -ExecutionPolicy Bypass -File "%~dp0make_gmpak.ps1" %*
popd
