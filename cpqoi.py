import struct
from gint import drect

def decode_and_draw(data, offset_x, offset_y):
    """Fast CPQOI decoder routing runs directly to drect()"""
    if data[:4] != b'CPQO': return
    width, height = struct.unpack('<HH', data[4:8])
    
    index = [0] * 64
    prev_color = 0
    p = 8
    end = len(data)
    x = 0
    y = 0
    
    # Localize for slight performance boost
    local_drect = drect
    
    while p < end:
        b1 = data[p]
        p += 1
        
        # Uses direct < logic instead of bit shifting
        if b1 < 0x40:
            # INDEX
            prev_color = index[b1]
            local_drect(offset_x + x, offset_y + y, offset_x + x, offset_y + y, prev_color)
            x += 1
        elif b1 < 0x80:
            # SKIP (Alpha/Transparency delta mechanics)
            x += (b1 & 0x3F) + 1
        elif b1 < 0xC0:
            # RUN (Draws solid horizontal rects)
            run = (b1 & 0x3F) + 1
            local_drect(offset_x + x, offset_y + y, offset_x + x + run - 1, offset_y + y, prev_color)
            x += run
        elif b1 == 0xFF:
            # RAW
            prev_color = data[p] | (data[p+1] << 8)
            p += 2
            # Fast 16-bit Hash
            index[(prev_color ^ (prev_color >> 5) ^ (prev_color >> 11)) % 64] = prev_color
            local_drect(offset_x + x, offset_y + y, offset_x + x, offset_y + y, prev_color)
            x += 1
        elif b1 == 0xFE:
            # LONG SKIP
            x += (data[p] | (data[p+1] << 8)) + 1
            p += 2
        elif b1 == 0xFD:
            # LONG RUN
            run = (data[p] | (data[p+1] << 8)) + 1
            p += 2
            local_drect(offset_x + x, offset_y + y, offset_x + x + run - 1, offset_y + y, prev_color)
            x += run

        # Wrap line
        if x >= width:
            y += x // width
            x = x % width