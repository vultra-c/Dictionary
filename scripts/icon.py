"""Generate the original book icon using PNG primitives; CI only."""
import struct
import zlib
from pathlib import Path


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


pixels = bytearray()
for y in range(96):
    pixels.append(0)
    for x in range(96):
        color = (13, 110, 255)
        if 19 <= x <= 76 and 21 <= y <= 75:
            color = (255, 255, 255)
        if 46 <= x <= 49 and 21 <= y <= 75:
            color = (13, 110, 255)
        if (25 <= x <= 40 or 55 <= x <= 70) and y in (33, 34, 44, 45, 55, 56):
            color = (13, 110, 255)
        pixels.extend(color)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 96, 96, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
Path('src/common/icon.png').write_bytes(png)
