from gint import *
import struct
import time
import cpqoi

class GMPak:
    def __init__(self, filename):
        self.f = open(filename, "rb")
        
        header = self.f.read(10)
        magic, version, toc_off = struct.unpack('<4sHI', header)
        
        if magic != b'GMPK':
            raise ValueError("Invalid GMPAK format")
            
        self.f.seek(toc_off)
        count = struct.unpack('<I', self.f.read(4))[0]
        
        self.toc = {}
        for _ in range(count):
            # Read exactly 25 bytes based on new struct!
            entry_data = self.f.read(25)
            name, t, off, size = struct.unpack('<16sBII', entry_data)
            
            name_str = name.split(b'\x00')[0].decode('ascii')
            self.toc[name_str] = {'type': t, 'offset': off, 'size': size}
            
    def get_entry(self, name_str):
        if name_str not in self.toc:
            return None
            
        entry = self.toc[name_str]
        self.f.seek(entry['offset'])
        return self.f.read(entry['size'])

    def close(self):
        self.f.close()


def draw_tiled_gint_image(img, x0, y0, img_w, img_h, tile_size=32):
    """
    Draws a native gint image in chunks for optimized rendering, 
    updating the screen row by row to create a smooth wipe effect.
    """
    cols = img_w // tile_size + (1 if img_w % tile_size != 0 else 0)
    rows = img_h // tile_size + (1 if img_h % tile_size != 0 else 0)
    
    # Localize for performance
    local_dsub = dsubimage
    local_dup = dupdate
    
    for ty in range(rows):
        dy = y0 + ty * tile_size
        sy = ty * tile_size
        th = tile_size if sy + tile_size <= img_h else img_h - sy
        
        for tx in range(cols):
            dx = x0 + tx * tile_size
            sx = tx * tile_size
            tw = tile_size if sx + tile_size <= img_w else img_w - sx
            
            local_dsub(dx, dy, img, sx, sy, tw, th)
            
        # Update the screen layer per row for a smooth transition effect
        local_dup()


def draw_loading_logo():
    """Draws an MPV-style loading logo using gint primitives."""
    dclear(C_BLACK)
    
    # Custom colors
    color_purple = C_RGB(18, 5, 25)
    color_dark_purple = C_RGB(10, 2, 15)
    
    # Center of the Classpad Screen (320x528)
    cx, cy = 160, 264
    
    # 1. Outer White Circle
    dcircle(cx, cy, 50, C_WHITE, C_NONE)
    # 2. Main Purple Circle
    dcircle(cx, cy, 48, color_purple, C_NONE)
    # 3. Darker shadow/off-center circle
    dcircle(cx, cy + 4, 40, color_dark_purple, C_NONE)
    # 4. Inner White Circle
    dcircle(cx, cy, 35, C_WHITE, C_NONE)
    # 5. Play Triangle (Polygon)
    dpoly([cx - 10, cy - 14, cx - 10, cy + 14, cx + 15, cy], color_purple, color_purple)
    
    # Text
    dtext(cx - 56, cy + 70, C_WHITE, "Loading VIDEO")
    dupdate()

    time.sleep(1)


def play_video(pak_file):
    draw_loading_logo()
    
    try:
        pak = GMPak(pak_file)
    except Exception as e:
        dclear(C_BLACK)
        dtext(10, 30, C_RED, "Failed to load VIDEO.")
        dupdate()
        time.sleep(2)
        return

    meta_data = pak.get_entry("META").decode('utf-8')
    fps, total_frames, w, h = 15, 0, 320, 320
    for line in meta_data.split('\n'):
        if line.startswith('fps='): fps = int(line.split('=')[1])
        if line.startswith('frames='): total_frames = int(line.split('=')[1])
        if line.startswith('width='): w = int(line.split('=')[1])
        if line.startswith('height='): h = int(line.split('=')[1])

    frame_duration_ms = int(1000 / fps)
    offset_x = max(0, (DWIDTH - w) // 2)
    offset_y = max(0, (DHEIGHT - h) // 2)

    dclear(C_BLACK)
    x = 0
    y = 0
    drect(x, y, w, h, C_WHITE)
    dupdate()

    playing = True
    frame_idx = 0
    show_icon_timer = 2  # Used to briefly flash the 'Play' icon

    while True:
        start_t = time.ticks_ms()
        
        # --- NON-BLOCKING INPUT HANDLING ---
        cleareventflips()
        clearevents()


        frame_name = "FRM_{:04d}".format(frame_idx)
        toc_entry = pak.toc.get(frame_name)
        
        # --- RENDER CURRENT FRAME ---
        if toc_entry:
            binary_data = pak.get_entry(frame_name)
            
            if toc_entry['type'] == 1:
                # Type 1: Delta CPQOI (Hardware DRECT instructions)
                cpqoi.decode_and_draw(binary_data, offset_x, offset_y)
                
            elif toc_entry['type'] == 4:
                # Type 4: Native fxconv gint.image binaries
                prof, fw, fh, stride, cc, pal_len, data_len = struct.unpack('<BHHHBHI', binary_data[:14])
                pal_start = 14
                data_start = 14 + pal_len
                palette = binary_data[pal_start:data_start] if pal_len > 0 else None
                img_data = binary_data[data_start:data_start + data_len]
                
                img = image(prof, cc, fw, fh, stride, img_data, palette)
                draw_tiled_gint_image(img, offset_x, offset_y, fw, fh, tile_size=32)

        # --- OSD OVERLAYS (CRT-Style Play/Pause) ---
        if not playing or show_icon_timer > 0:
            if not playing:
                # Pause Icon (Two vertical bars)
                drect(285, 15, 293, 35, C_WHITE)
                drect(299, 15, 307, 35, C_WHITE)
                dupdate()
            else:
                # Play Icon (Triangle)
                dpoly([285, 15, 285, 35, 307, 25], C_WHITE, C_WHITE)
                show_icon_timer -= 1
                
        # Commit the draw buffer
        if (toc_entry and toc_entry['type'] == 1) or show_icon_timer > 0:
            dupdate() # Type 4 self-updates in the tiled renderer

        if keydown(KEY_DEL):
            break
            
        if keydown(KEY_EXE):
            playing = not playing
            if playing:
                show_icon_timer = 4  # Display "Play" icon for ~4 frames
                
        # Frame scrubbing navigation
        frame_advanced = False
        if keydown(KEY_RIGHT) or keydown(KEY_6):
            frame_idx = (frame_idx + 1) % total_frames
            frame_advanced = True
            playing = False # Auto-pause when manually seeking
            
        if keydown(KEY_LEFT) or keydown(KEY_4):
            frame_idx = (frame_idx - 1) % total_frames
            frame_advanced = True
            playing = False

        # Natural playback increment
        if playing and not frame_advanced:
            frame_idx += 1
            if frame_idx >= total_frames:
                frame_idx = 0
                # Clear screen to prevent artifacts from delta-codecs wrapping around
                # dclear(C_BLACK) 
                # drect(x, y, w, h, C_WHITE)

        # --- PACING / FPS CONTROL ---
        if playing or frame_advanced:
            elapsed = time.ticks_diff(time.ticks_ms(), start_t)
            sleep_ms = frame_duration_ms - elapsed
            if sleep_ms > 0:
                time.sleep(sleep_ms / 1000.0)
        else:
            # Prevent high CPU usage while paused
            time.sleep(0.05)

    pak.close()

def main():
    play_video("VIDEO.gmpak")

main()
