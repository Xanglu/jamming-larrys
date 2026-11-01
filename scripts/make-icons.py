#!/usr/bin/env python3
"""Generate the extension icon set and the silent keep-alive WAV.

The icon art is a LINE sticker of a white dog in sunglasses with a music note
(assets/icon-art.webp). It sits on the same dark warm gradient tile the project
has always used, so the white silhouette and the red note stay legible at 16px.

The JAMMING 7TV emote (https://7tv.app/emotes/01HQPADS580002TBKNPGQGFJKC) is
still what ships inside the extension: the popup logo and the in-page pill
mascot (assets/mascot.webp). Only the browser/toolbar icon uses this artwork.
"""
import os
import struct
import wave

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, "icons")
ART = os.path.join(ROOT, "assets", "icon-art.webp")
os.makedirs(ICONS, exist_ok=True)

SIZE = 1024
BG_START = (36, 28, 8)
BG_END = (16, 12, 3)
CORNER = 0.225
# How much of the tile the artwork covers. The sticker is drawn almost
# edge-to-edge, so this is what gives the icon its dark border and keeps the
# music note clear of the rounded corner.
FILL = 0.86


def gradient(size, start, end):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = (
                round(start[0] + (end[0] - start[0]) * t),
                round(start[1] + (end[1] - start[1]) * t),
                round(start[2] + (end[2] - start[2]) * t),
            )
    return img


def make_icon(master_size):
    base = gradient(master_size, BG_START, BG_END)

    mask = Image.new("L", (master_size, master_size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(
        (0, 0, master_size - 1, master_size - 1),
        radius=int(master_size * CORNER),
        fill=255,
    )

    icon = Image.new("RGBA", (master_size, master_size), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    art = Image.open(ART).convert("RGBA")
    target = int(master_size * FILL)
    scale = target / max(art.size)
    art = art.resize(
        (max(1, round(art.size[0] * scale)), max(1, round(art.size[1] * scale))),
        Image.LANCZOS,
    )
    icon.alpha_composite(art, ((master_size - art.size[0]) // 2, (master_size - art.size[1]) // 2))

    return icon


master = make_icon(SIZE)
for name, size in (("icon16.png", 16), ("icon32.png", 32), ("icon48.png", 48), ("icon128.png", 128)):
    master.resize((size, size), Image.LANCZOS).save(os.path.join(ICONS, name))
master.resize((256, 256), Image.LANCZOS).save(os.path.join(ICONS, "icon256.png"))

# 1 second of 16-bit mono silence at 8 kHz, looped by the offscreen document.
with wave.open(os.path.join(ROOT, "keepalive.wav"), "w") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(8000)
    wav.writeframes(struct.pack("<8000h", *([0] * 8000)))

print("icons + keepalive.wav written")
