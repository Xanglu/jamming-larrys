#!/usr/bin/env python3
"""Generate the extension icon set and the silent keep-alive WAV.

The icons use the JAMMING 7TV emote (https://7tv.app/emotes/01HQPADS580002TBKNPGQGFJKC)
on a dark warm background so the yellow mascot stays legible at small sizes.
"""
import os
import struct
import wave

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, "icons")
MASCOT = os.path.join(ROOT, "assets", "mascot.png")
os.makedirs(ICONS, exist_ok=True)

SIZE = 1024
BG_START = (36, 28, 8)
BG_END = (16, 12, 3)

# The emote is 140x80 with music notes in the corners. This square crop keeps
# the creature's body and hands, dropping the notes.
CROP = (30, 0, 110, 80)


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
        radius=int(master_size * 0.225),
        fill=255,
    )

    icon = Image.new("RGBA", (master_size, master_size), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    face = Image.open(MASCOT).convert("RGBA").crop(CROP)
    target = int(master_size * 0.84)
    face = face.resize((target, target), Image.LANCZOS)
    icon.alpha_composite(face, ((master_size - target) // 2, (master_size - target) // 2))

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
