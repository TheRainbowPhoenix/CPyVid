# Windows setup for the enc3 → fxconv frames → GMPAK pipeline

This folder is meant to be self-contained for normal Windows users.

Running `setup_windows.ps1` installs a local copy of normal Python into:

```text
runtime\python
```

It does not add Python to the user's PATH and does not associate `.py` files. It also installs Tcl/Tk so the GUI works.

## Files expected in the project folder

```text
enc3.py
video_frames_to_fxconv_py.py
gmpak_pack_v2.py
fxconv.py              # setup copies this to tools\fxconv.py if needed
requirements.txt
setup_windows.ps1
make_gmpak.ps1
```

## First-time setup

Open PowerShell in the project folder and run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup_windows.ps1
```

This downloads:

- Python 3.11.9, installed locally to `runtime\python`
- FFmpeg Windows essentials build, installed locally to `runtime\ffmpeg`
- Python packages from `requirements.txt`

## Launch the GUI

```bat
run_gui.bat
```

## Full command-line pipeline

```bat
make_gmpak.bat input.mp4 -Fps 2 -Width 320 -Height 528 -Mode stretch -Format Color -Colors 8 -OutputPak VIDEO.gmpak
```

Equivalent manual commands are:

```bat
runtime\python\python.exe enc3.py input.mp4 -o output_prep.mp4 --fps 2 --width 320 --height 528 --mode stretch --format Color --colors 8 --audio strip
runtime\python\python.exe video_frames_to_fxconv_py.py output_prep.mp4 frames_fx --fxconv tools\fxconv.py --profile p4_rgb565
runtime\python\python.exe gmpak_pack_v2.py frames_fx VIDEO.gmpak 2
```

## Notes

- `enc3.py` creates the low-resolution / low-FPS prepared MP4.
- `video_frames_to_fxconv_py.py` converts that MP4 into `frame_0000.py`, `frame_0001.py`, etc.
- `gmpak_pack_v2.py` packs those frames into `VIDEO.gmpak`.
- The FPS value passed to `gmpak_pack_v2.py` should match the FPS used in `enc3.py`.
