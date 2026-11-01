#!/usr/bin/env python3
"""Generate the extension icon set and the silent keep-alive WAV."""
import os
import struct
import wave

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, "icons")
os.makedirs(ICONS, exist_ok=True)

SIZE = 1024
START = (255, 52, 88)
END = (255, 130, 62)


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = (
                round(START[0] + (END[0] - START[0]) * t),
                round(START[1] + (END[1] - START[1]) * t),
                round(START[2] + (END[2] - START[2]) * t),
            )
    return img


def make_icon(master_size):
    base = gradient(master_size)

    mask = Image.new("L", (master_size, master_size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(
        (0, 0, master_size - 1, master_size - 1),
        radius=int(master_size * 0.225),
        fill=255,
    )

    icon = Image.new("RGBA", (master_size, master_size), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    # Play triangle, optically centered.
    cx, cy = master_size * 0.555, master_size * 0.5
    h = master_size * 0.40
    w = h * 0.86
    points = [(cx - w / 2, cy - h / 2), (cx - w / 2, cy + h / 2), (cx + w / 2, cy)]
    draw.polygon(points, fill=(255, 255, 255, 255))

    # Sound-wave arc hugging the left of the triangle.
    a = master_size * 0.315
    box = (master_size * 0.50 - a, cy - a, master_size * 0.50 + a, cy + a)
    draw.arc(box, start=124, end=236, fill=(255, 255, 255, 145), width=int(master_size * 0.042))

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
