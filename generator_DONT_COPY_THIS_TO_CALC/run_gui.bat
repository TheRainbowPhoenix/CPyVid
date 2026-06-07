@echo off
setlocal
pushd "%~dp0"
set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"
"%~dp0runtime\venv\Scripts\python.exe" "%~dp0enc3.py" %*
popd
