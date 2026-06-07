## Install (in powershell)

`powershell -ExecutionPolicy Bypass -File .\setup_windows_venv.ps1`

## Install (non-windows, advanced)

Need python 3.9+ with TK.

Install the requirements.txt via pip (`pip install -r requirements.txt`)


## Usage :

### Windows:

Open the folder inside powershell and paste :

```
.\run_gui.bat
.\make_gmpak.ps1 .\output_prep.mp4 VIDEO.gmpak
```

When asked for the output file name and path, put this folder and file name `output_prep.mp4`

Then, copy the VIDEO.gmpak and the CPVid.py and cpqoi.py to your calculator...

### Others
```
python enc3.py input.mp4 -o output_prep.mp4 --fps 2 --width 320 --height 528 --mode stretch --format Color --colors 8 --audio strip

python video_frames_to_fxconv_py.py output_prep.mp4 frames_fx --profile p4_rgb565

python gmpak_pack_v2.py frames_fx VIDEO.gmpak 10
```