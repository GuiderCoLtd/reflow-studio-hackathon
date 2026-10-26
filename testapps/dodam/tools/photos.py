#!/usr/bin/env python3
"""Convert the source photographs in assets-src/photos/ into the optimized
JPEGs the app serves from public/img/ (/static/img/<name>-<size>.jpg).
Re-runnable; the source PNGs are never modified.

  python3 tools/photos.py

People become square crops around the face (160 and 480 px); places keep
their aspect ratio (1600 and 800 px wide).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'assets-src' / 'photos'
OUT = ROOT / 'public' / 'img'

# Face centre of each portrait as a fraction of width/height (measured once by eye).
PEOPLE = {
    'p-kim-haneul': (0.47, 0.37),
    'p-park-jihoon': (0.44, 0.37),
    'p-lee-doyun': (0.50, 0.37),
    'p-choi-seoa': (0.48, 0.41),
    'p-han-soyul': (0.455, 0.42),
    'p-seo-junho': (0.50, 0.42),
}
PLACES = ['office-seongsu', 'townhall', 'training-room']

CROP = 0.64  # side of the avatar crop relative to the source side
DROP = 0.07  # move the crop below the face centre so a little of the shoulders shows


def save(im, dest, quality=84):
    im.save(dest, 'JPEG', quality=quality, optimize=True, progressive=True)
    return f'{dest.relative_to(ROOT)} {im.width}x{im.height} {dest.stat().st_size // 1024} KB'


def portrait(name, centre):
    im = Image.open(SRC / f'{name}.png').convert('RGB')
    side = round(min(im.size) * CROP)
    cx = round(im.width * centre[0])
    cy = round(im.height * (centre[1] + DROP))
    left = min(max(0, cx - side // 2), im.width - side)
    top = min(max(0, cy - side // 2), im.height - side)
    face = im.crop((left, top, left + side, top + side))
    return [save(face.resize((px, px), Image.LANCZOS), OUT / f'{name}-{px}.jpg') for px in (160, 480)]


def place(name):
    im = Image.open(SRC / f'{name}.png').convert('RGB')
    out = []
    for w in (1600, 800):
        h = round(im.height * w / im.width)
        out.append(save(im.resize((w, h), Image.LANCZOS), OUT / f'{name}-{w}.jpg', quality=82))
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, centre in PEOPLE.items():
        print(*portrait(name, centre), sep='\n')
    for name in PLACES:
        print(*place(name), sep='\n')


if __name__ == '__main__':
    main()
