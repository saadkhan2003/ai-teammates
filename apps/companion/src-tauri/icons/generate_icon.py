#!/usr/bin/env python3
"""Create a simple original 64x64 teal desktop placeholder icon."""
import struct, zlib

W=H=64
rows=[]
for y in range(H):
    row=bytearray([0])
    for x in range(W):
        inside=(x-32)**2+(y-32)**2 < 29**2
        mark=(23<=x<=40 and 19<=y<=44 and (x in (23,40) or y in (19,44))) or (30<=x<=33 and 26<=y<=37)
        row.extend((20,184,166,255) if inside and not mark else (226,232,240,255) if inside and mark else (0,0,0,0))
    rows.append(bytes(row))
def chunk(kind,data): return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',W,H,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b'')
with open('icon.png','wb') as f:f.write(png)
