import sys
import os
import subprocess
import argparse
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np
from PIL import Image, ImageTk

def run_ffmpeg_command(cmd, progress_callback):
    """Executes FFmpeg while capturing and communicating progress/logs."""
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1
        )
        
        while True:
            line = process.stdout.readline()
            if not line and process.poll() is not None:
                break
            if line:
                clean_line = line.strip()
                if "time=" in clean_line or "frame=" in clean_line:
                    progress_callback(clean_line)
                    
        rc = process.poll()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, cmd)
    except Exception as e:
        raise Exception(f"FFmpeg pipeline crashed: {str(e)}")

def build_ffmpeg_cmd(input_file, output_file, fps, width, height, mode, format_mode, colors, dither, start_time="", duration="", audio_mode="strip"):
    """Assembles a tailored FFmpeg command array based on GUI configurations."""
    cmd = ["ffmpeg", "-y"]
    
    # 1. Trim configuration
    if start_time:
        cmd.extend(["-ss", str(start_time)])
        
    cmd.extend(["-i", input_file])
    
    if duration:
        cmd.extend(["-t", str(duration)])
        
    # 2. Build Video Filter (vf) Chain
    vf_filters = []
    
    # Dimensions & aspect handling
    if mode == 'crop':
        vf_filters.append(f"crop='min(in_w,in_h)':'min(in_w,in_h)',scale={width}:{height}")
    elif mode == 'pad':
        vf_filters.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
    else: # stretch
        vf_filters.append(f"scale={width}:{height}")
        
    # Grayscale rendering
    if format_mode == 'Grayscale':
        vf_filters.append("format=gray")
        
    base_vf = ",".join(vf_filters)
    
    # 3. Handle Color Limits & Dithering via Dynamic Palette Filters
    if colors != "Original":
        dither_str = "floyd_steinberg" if dither == "Floyd-Steinberg" else "none"
        # Generate custom local frame palette to match exact color depth request
        filter_complex_str = (
            f"[0:v]{base_vf}[pre];"
            f"[pre]split[a][b];"
            f"[a]palettegen=max_colors={colors}:reserve_transparent=0[pal];"
            f"[b][pal]paletteuse=dither={dither_str}"
        )
        cmd.extend(["-filter_complex", filter_complex_str])
    else:
        cmd.extend(["-vf", base_vf])
    
    # Framerate control
    cmd.extend(["-r", str(fps)])
    
    # 4. Audio Optimization Settings
    if audio_mode == "strip":
        cmd.append("-an")
    elif audio_mode == "mono_11k":
        cmd.extend(["-c:a", "aac", "-ac", "1", "-ar", "11025", "-b:a", "32k"])
    elif audio_mode == "mono_22k":
        cmd.extend(["-c:a", "aac", "-ac", "1", "-ar", "22050", "-b:a", "64k"])
    else: # Keep Original
        cmd.extend(["-c:a", "copy"])
        
    # 5. Standard H.264 Encoder configurations
    cmd.extend([
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", "22",
        output_file
    ])
    
    return cmd

def launch_gui():
    root = tk.Tk()
    root.title("Stage 2 MP4 Optimizer (CPvid Prep)")
    root.geometry("540x660")
    root.resizable(False, False)

    # Style
    style = ttk.Style()
    style.configure("TLabel", font=("Segoe UI", 9))
    style.configure("TButton", font=("Segoe UI", 9))
    style.configure("Header.TLabel", font=("Segoe UI Semibold", 10))

    # Variables
    in_var = tk.StringVar()
    out_var = tk.StringVar(value="stage2_output.mp4")
    fps_var = tk.IntVar(value=10)
    w_var = tk.IntVar(value=320)
    h_var = tk.IntVar(value=528) # Default to full screen height of ClassPad
    mode_var = tk.StringVar(value="pad")
    format_var = tk.StringVar(value="Grayscale")
    colors_var = tk.StringVar(value="128")
    dither_var = tk.StringVar(value="None")
    audio_var = tk.StringVar(value="mono_11k")
    start_var = tk.StringVar()
    dur_var = tk.StringVar()
    status_var = tk.StringVar(value="Ready.")
    cmd_text_var = tk.StringVar()

    def get_args_dict():
        return {
            "input_file": in_var.get(),
            "output_file": out_var.get(),
            "fps": fps_var.get(),
            "width": w_var.get(),
            "height": h_var.get(),
            "mode": mode_var.get(),
            "format_mode": format_var.get(),
            "colors": colors_var.get(),
            "dither": dither_var.get(),
            "start_time": start_var.get().strip(),
            "duration": dur_var.get().strip(),
            "audio_mode": audio_var.get()
        }

    def update_command_display(*args):
        """Generates and displays the current raw command inside the text field."""
        try:
            p = get_args_dict()
            if not p["input_file"]:
                cmd_text_var.set("Select an input video to preview command.")
                return
            cmd = build_ffmpeg_cmd(
                p["input_file"], p["output_file"], p["fps"], p["width"], p["height"],
                p["mode"], p["format_mode"], p["colors"], p["dither"],
                p["start_time"], p["duration"], p["audio_mode"]
            )
            cmd_text_var.set(" ".join(cmd))
        except Exception as e:
            cmd_text_var.set(f"Error: {e}")

    # Listen to config modifications to update the live command text block
    for var in (in_var, out_var, fps_var, w_var, h_var, mode_var, format_var, colors_var, dither_var, audio_var, start_var, dur_var):
        var.trace_add("write", update_command_display)

    def browse_in():
        f = filedialog.askopenfilename(filetypes=[("Video Files", "*.mp4 *.avi *.mkv *.gif *.mov")])
        if f: 
            in_var.set(f)
            base, _ = os.path.splitext(f)
            out_var.set(f"{base}_prep.mp4")

    def browse_out():
        f = filedialog.asksaveasfilename(defaultextension=".mp4", filetypes=[("MP4 Video", "*.mp4")])
        if f: out_var.set(f)

    def run_preview():
        if not in_var.get():
            messagebox.showerror("Error", "Please select an input video first!")
            return
        
        try:
            cap = cv2.VideoCapture(in_var.get())
            if start_var.get():
                try:
                    cap.set(cv2.CAP_PROP_POS_MSEC, float(start_var.get()) * 1000)
                except ValueError:
                    pass

            frame = None
            skip_frames = 1 if start_var.get() else 15
            for _ in range(skip_frames):  
                ret, temp_frame = cap.read()
                if not ret: break
                frame = temp_frame
            cap.release()
            
            if frame is None:
                raise Exception("Could not fetch a valid frame from standard video stream.")

            # Processing simulation
            width, height = w_var.get(), h_var.get()
            mode = mode_var.get()
            
            # Aspect Resize Logic Matcher
            if mode == 'crop':
                h_orig, w_orig = frame.shape[:2]
                min_dim = min(w_orig, h_orig)
                start_x = (w_orig - min_dim) // 2
                start_y = (h_orig - min_dim) // 2
                cropped = frame[start_y:start_y+min_dim, start_x:start_x+min_dim]
                resized = cv2.resize(cropped, (width, height))
            elif mode == 'pad':
                h_orig, w_orig = frame.shape[:2]
                scale = min(width/w_orig, height/h_orig)
                new_w, new_h = int(w_orig * scale), int(h_orig * scale)
                resized_img = cv2.resize(frame, (new_w, new_h))
                resized = np.zeros((height, width, 3), dtype=np.uint8)
                x_off = (width - new_w) // 2
                y_off = (height - new_h) // 2
                resized[y_off:y_off+new_h, x_off:x_off+new_w] = resized_img
            else:
                resized = cv2.resize(frame, (width, height))

            # Apply Color Filter Simulation
            if format_var.get() == "Grayscale":
                resized = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                pil_img = Image.fromarray(resized).convert('RGB')
            else:
                pil_img = Image.fromarray(cv2.cvtColor(resized, cv2.COLOR_BGR2RGB))

            # Quantization Simulation
            if colors_var.get() != "Original":
                num_colors = int(colors_var.get())
                dither_arg = getattr(Image, 'Dither', Image).NONE
                if dither_var.get() == "Floyd-Steinberg":
                    dither_arg = getattr(Image, 'Dither', Image).FLOYDSTEINBERG
                pil_img = pil_img.quantize(colors=num_colors, dither=dither_arg).convert('RGB')

            prev_win = tk.Toplevel(root)
            prev_win.title("Processed Frame Simulation")
            
            tk_img = ImageTk.PhotoImage(pil_img)
            lbl_img = tk.Label(prev_win, image=tk_img)
            lbl_img.image = tk_img 
            lbl_img.pack(padx=10, pady=10)
            
            info_text = f"Intermediate Output Structure:\nResolution: {width}x{height} | Style: {format_var.get()} ({colors_var.get()} Colors) | Dither: {dither_var.get()}"
            tk.Label(prev_win, text=info_text, justify=tk.CENTER).pack(pady=(0, 10))

        except Exception as e:
            messagebox.showerror("Preview Setup Error", str(e))

    def run_conversion():
        if not in_var.get():
            messagebox.showerror("Error", "Please select an input video!")
            return
        
        p = get_args_dict()
        cmd = build_ffmpeg_cmd(
            p["input_file"], p["output_file"], p["fps"], p["width"], p["height"],
            p["mode"], p["format_mode"], p["colors"], p["dither"], p["start_time"], p["duration"], p["audio_mode"]
        )

        btn_convert.config(state=tk.DISABLED)
        btn_preview.config(state=tk.DISABLED)
        status_var.set("Conversion initialized...")

        def task():
            try:
                run_ffmpeg_command(cmd, lambda msg: status_var.set(msg))
                messagebox.showinfo("Success", f"Optimized video saved to:\n{p['output_file']}")
            except Exception as e:
                status_var.set("An error occurred during execution.")
                messagebox.showerror("Execution Fault", str(e))
            finally:
                btn_convert.config(state=tk.NORMAL)
                btn_preview.config(state=tk.NORMAL)
                status_var.set("Ready.")

        threading.Thread(target=task, daemon=True).start()

    # Layout structure
    main_frame = ttk.Frame(root, padding=12)
    main_frame.pack(fill=tk.BOTH, expand=True)

    # File I/O Frame
    io_frame = ttk.LabelFrame(main_frame, text=" File Paths ", padding=8)
    io_frame.pack(fill=tk.X, pady=(0, 8))

    ttk.Label(io_frame, text="Input Video:").grid(row=0, column=0, sticky="w")
    ttk.Entry(io_frame, textvariable=in_var, width=42).grid(row=0, column=1, padx=(5, 5))
    ttk.Button(io_frame, text="...", width=3, command=browse_in).grid(row=0, column=2)

    ttk.Label(io_frame, text="Output File:").grid(row=1, column=0, sticky="w", pady=(5, 0))
    ttk.Entry(io_frame, textvariable=out_var, width=42).grid(row=1, column=1, padx=(5, 5), pady=(5, 0))
    ttk.Button(io_frame, text="...", width=3, command=browse_out).grid(row=1, column=2, pady=(5, 0))

    # Options Frame
    opt_frame = ttk.LabelFrame(main_frame, text=" Stream Optimization & Sizing ", padding=8)
    opt_frame.pack(fill=tk.X, pady=8)

    # Row 1: Dimensions & Trim
    ttk.Label(opt_frame, text="Resolution:").grid(row=0, column=0, sticky="w", pady=4)
    dim_frame = ttk.Frame(opt_frame)
    dim_frame.grid(row=0, column=1, sticky="w", pady=4)
    ttk.Entry(dim_frame, textvariable=w_var, width=5).pack(side=tk.LEFT)
    ttk.Label(dim_frame, text=" x ").pack(side=tk.LEFT)
    ttk.Entry(dim_frame, textvariable=h_var, width=5).pack(side=tk.LEFT)

    ttk.Label(opt_frame, text="Trim (sec):").grid(row=0, column=2, sticky="w", padx=(15, 0), pady=4)
    trim_frame = ttk.Frame(opt_frame)
    trim_frame.grid(row=0, column=3, sticky="w", pady=4)
    ttk.Label(trim_frame, text="Start:").pack(side=tk.LEFT)
    ttk.Entry(trim_frame, textvariable=start_var, width=6).pack(side=tk.LEFT, padx=(2, 5))
    ttk.Label(trim_frame, text="Dur:").pack(side=tk.LEFT)
    ttk.Entry(trim_frame, textvariable=dur_var, width=6).pack(side=tk.LEFT, padx=(2, 0))

    # Row 2: FPS & Aspect Handling
    ttk.Label(opt_frame, text="Framerate (FPS):").grid(row=1, column=0, sticky="w", pady=4)
    ttk.Combobox(opt_frame, textvariable=fps_var, values=[1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 14, 15, 20, 24, 30], width=10, state="readonly").grid(row=1, column=1, sticky="w", pady=4)

    ttk.Label(opt_frame, text="Resize Mode:").grid(row=1, column=2, sticky="w", padx=(15, 0), pady=4)
    ttk.Combobox(opt_frame, textvariable=mode_var, values=['pad', 'crop', 'stretch'], width=12, state="readonly").grid(row=1, column=3, sticky="w", pady=4)

    # Row 3: Color & Colors Selection
    ttk.Label(opt_frame, text="Visual Style:").grid(row=2, column=0, sticky="w", pady=4)
    ttk.Combobox(opt_frame, textvariable=format_var, values=['Color', 'Grayscale'], width=10, state="readonly").grid(row=2, column=1, sticky="w", pady=4)

    ttk.Label(opt_frame, text="Max Colors:").grid(row=2, column=2, sticky="w", padx=(15, 0), pady=4)
    ttk.Combobox(opt_frame, textvariable=colors_var, values=['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '24', '32', '48', '56', '64', '96', '128', '192', '256', 'Original'], width=12, state="readonly").grid(row=2, column=3, sticky="w", pady=4)

    # Row 4: Dithering & Audio Format
    ttk.Label(opt_frame, text="Dithering:").grid(row=3, column=0, sticky="w", pady=4)
    ttk.Combobox(opt_frame, textvariable=dither_var, values=['None', 'Floyd-Steinberg'], width=10, state="readonly").grid(row=3, column=1, sticky="w", pady=4)

    ttk.Label(opt_frame, text="Audio Track:").grid(row=3, column=2, sticky="w", padx=(15, 0), pady=4)
    audio_box = ttk.Combobox(
        opt_frame, 
        textvariable=audio_var, 
        width=12, 
        state="readonly"
    )
    audio_box.grid(row=3, column=3, sticky="w", pady=4)
    audio_box['values'] = ('strip', 'mono_11k', 'mono_22k', 'copy')

    # Raw command Frame
    cmd_frame = ttk.LabelFrame(main_frame, text=" Live FFmpeg Command ", padding=8)
    cmd_frame.pack(fill=tk.BOTH, expand=True, pady=8)
    
    cmd_entry = tk.Entry(cmd_frame, textvariable=cmd_text_var, state="readonly", font=("Consolas", 8), fg="#004d40")
    cmd_entry.pack(fill=tk.BOTH, expand=True, padx=2, pady=2)

    # Action buttons Area
    btn_frame = ttk.Frame(main_frame)
    btn_frame.pack(fill=tk.X, pady=(10, 0))

    btn_preview = ttk.Button(btn_frame, text="Simulate Frame", command=run_preview)
    btn_preview.pack(side=tk.LEFT, padx=5, ipadx=10, ipady=4)

    btn_convert = ttk.Button(btn_frame, text="Prepare Intermediate MP4", command=run_conversion)
    btn_convert.pack(side=tk.RIGHT, padx=5, ipadx=10, ipady=4)

    # Status Bar
    status_bar = ttk.Label(main_frame, textvariable=status_var, font=("Segoe UI Italic", 9), foreground="#37474f", wraplength=480)
    status_bar.pack(fill=tk.X, pady=(8, 0))

    root.mainloop()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage 2 MP4 Optimizer (CPvid Prep)")
    parser.add_argument("input", nargs="?", help="Input video file")
    parser.add_argument("-o", "--output", default="stage2_output.mp4", help="Output prepared MP4 file")
    parser.add_argument("--fps", type=int, default=10, help="Target framerate (1, 5, 10, 15)")
    parser.add_argument("--width", type=int, default=320, help="Width")
    parser.add_argument("--height", type=int, default=528, help="Height")
    parser.add_argument("--mode", choices=['crop', 'pad', 'stretch'], default='pad', help="Resize strategy")
    parser.add_argument("--format", choices=['Color', 'Grayscale'], default='Grayscale', help="Output style")
    parser.add_argument("--colors", default="128", help="Output colors (2, 16, 32, 64, 128, 256, Original)")
    parser.add_argument("--dither", choices=['None', 'Floyd-Steinberg'], default='None', help="Dithering mode")
    parser.add_argument("--start", default="", help="Start time (seconds)")
    parser.add_argument("--duration", default="", help="Duration to encode (seconds)")
    parser.add_argument("--audio", choices=['strip', 'mono_11k', 'mono_22k', 'copy'], default='mono_11k', help="Audio configuration")

    args = parser.parse_args()

    if not args.input:
        launch_gui()
    else:
        print(f"--- Stage 2 MP4 Optimization ---\nExecuting FFmpeg command...")
        cmd = build_ffmpeg_cmd(
            args.input, args.output, args.fps, args.width, args.height,
            args.mode, args.format, args.colors, args.dither, args.start, args.duration, args.audio
        )
        try:
            run_ffmpeg_command(cmd, print)
            print(f"[SUCCESS] Optimized MP4 saved to: {args.output}")
        except Exception as e:
            print(f"[ERROR] Process failed: {str(e)}")
            sys.exit(1)