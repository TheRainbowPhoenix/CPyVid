import sys
import struct
import os

# --- Mock Environment to intercept fxconv parameters safely ---
class MockGint:
    @staticmethod
    def image(profile, width, height, stride, color_count, data, palette=None):
        return {
            'profile': profile, 'width': width, 'height': height,
            'stride': stride, 'color_count': color_count,
            'data': data, 'palette': palette or b''
        }

def parse_fxconv_py(filepath):
    """Executes the fxconv .py file safely and rips out the gint.image parameters"""
    env = {'gint': MockGint()}
    with open(filepath, 'r') as f:
        exec(f.read(), env)
        
    for val in env.values():
        if isinstance(val, dict) and 'profile' in val:
            return val
    raise ValueError(f"Could not find a valid gint.image() in {filepath}")

def pack_gint_payload(img_dict):
    """Packs the arguments of gint.image into a continuous binary payload for the ClassPad"""
    # Header Format: <BHHHBHI (14 bytes total)
    # Profile(1), Width(2), Height(2), Stride(2), Colors(1), PaletteLength(2), DataLength(4)
    pal_len = len(img_dict['palette'])
    data_len = len(img_dict['data'])
    
    header = struct.pack('<BHHHBHI', 
        img_dict['profile'], img_dict['width'], img_dict['height'],
        img_dict['stride'], img_dict['color_count'], 
        pal_len, data_len)
        
    return header + img_dict['palette'] + img_dict['data']

def create_gmpak_from_fxconv(folder_path, output_pak, target_fps=15):
    print(f"Scanning {folder_path} for fxconv Python files...")
    
    # Assume folder has frame_0000.py, frame_0001.py, etc.
    files = sorted([f for f in os.listdir(folder_path) if f.endswith('.py')])
    if not files:
        print("No .py files found!")
        return

    toc_entries = []
    
    with open(output_pak, 'wb') as f:
        # Header Placeholder (Magic, Version, TOC Offset)
        f.write(struct.pack('<4sHI', b'GMPK', 1, 0))
        
        # 1. Metadata (read the first frame so gmplay3.py can center correctly)
        first_img = parse_fxconv_py(os.path.join(folder_path, files[0]))
        meta_payload = (
            f"fps={target_fps}\n"
            f"frames={len(files)}\n"
            f"width={first_img['width']}\n"
            f"height={first_img['height']}\n"
        ).encode('utf-8')
        meta_start = f.tell()
        f.write(meta_payload)
        toc_entries.append((b'META'.ljust(16, b'\x00'), 0, meta_start, len(meta_payload)))

        # 2. Write Binary GINT Streams
        for i, file in enumerate(files):
            img_args = parse_fxconv_py(os.path.join(folder_path, file))
            binary_payload = pack_gint_payload(img_args)
            
            offset = f.tell()
            f.write(binary_payload)
            
            # Type 4 = VIDEO_GINT_IMAGE
            name = f"FRM_{i:04d}".encode('ascii').ljust(16, b'\x00')
            toc_entries.append((name, 4, offset, len(binary_payload)))
            
            if i % 10 == 0: print(f"Packed frame {i}/{len(files)}")

        # 3. Write Table of Contents
        toc_offset = f.tell()
        f.write(struct.pack('<I', len(toc_entries)))
        for entry in toc_entries:
            f.write(struct.pack('<16sBII', *entry))
            
        # 4. Finalize Header pointer
        f.seek(6)
        f.write(struct.pack('<I', toc_offset))
        
    print(f"Success! {output_pak} created with pure native GINT image binaries.")

# Usage: python gmpak_pack_v2.py <folder_of_py_frames> <output.gmpak>
if __name__ == "__main__":
    if len(sys.argv) > 2:
        fps = int(sys.argv[3]) if len(sys.argv) > 3 else 15
        create_gmpak_from_fxconv(sys.argv[1], sys.argv[2], fps)
    else:
        print("Usage: python gmpak_pack_v2.py <folder_of_py_frames> <output.gmpak> [fps]")