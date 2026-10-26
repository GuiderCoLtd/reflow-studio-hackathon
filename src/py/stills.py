"""Batch still processing for documents: resize, optional baked highlight.

Usage: python3 stills.py jobs.json
jobs.json: [{"src": ..., "dst": ..., "width": 1440, "quality": 85,
             "box": {"x":..,"y":..,"width":..,"height":..} | null,  # still pixels
             "label": "03" | null, "color": "#2563EB"}]
"""
import json
import math
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/pretendard/Pretendard-Bold.otf",
    "/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf",
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def corner_marks(size, rect, scale, aa=3):
    """Alpha mask of four short L-corners (rounded at the bend) around rect,
    with a soft glow and a very faint wash inside. No full outline."""
    x0, y0, x1, y1 = (v * aa for v in rect)
    stroke = max(aa, round(3 * scale * aa))
    arm = min(18 * scale, (x1 - x0) / aa * 0.4, (y1 - y0) / aa * 0.4) * aa
    marks = Image.new("L", (size[0] * aa, size[1] * aa))
    d = ImageDraw.Draw(marks)
    d.rounded_rectangle((x0, y0, x1, y1), radius=4.5 * scale * aa, outline=255, width=stroke)
    # erase the middle of every side, leaving the corners
    d.rectangle((x0 + arm, y0 - aa, x1 - arm, y0 + stroke + aa), fill=0)
    d.rectangle((x0 + arm, y1 - stroke - aa, x1 - arm, y1 + aa), fill=0)
    d.rectangle((x0 - aa, y0 + arm, x0 + stroke + aa, y1 - arm), fill=0)
    d.rectangle((x1 - stroke - aa, y0 + arm, x1 + aa, y1 - arm), fill=0)
    marks = marks.resize(size, Image.BOX)
    glow = marks.filter(ImageFilter.GaussianBlur(3.5 * scale)).point(lambda v: v * 3 // 4)
    wash = Image.new("L", size)
    ImageDraw.Draw(wash).rounded_rectangle(rect, radius=6 * scale, fill=18)
    return ImageChops.screen(ImageChops.screen(marks, glow), wash)


def bake(img, box, label, color):
    """Corner marks around the target and the step number as plain cobalt
    numerals beside the top-left corner (a thin white halo keeps them legible
    on busy screens; no disc, no badge)."""
    scale = img.width / 1440
    pad = 7 * scale
    x0, y0 = box["x"] - pad, box["y"] - pad
    x1, y1 = box["x"] + box["width"] + pad, box["y"] + box["height"] + pad
    rgb = hex_rgb(color)
    # judge where the numeral fits on the untouched screenshot
    gray = img.convert("L") if label else None
    margin = 18 * scale
    left, top = max(0, math.floor(x0 - margin)), max(0, math.floor(y0 - margin))
    right, bottom = min(img.width, math.ceil(x1 + margin)), min(img.height, math.ceil(y1 + margin))
    if right > left and bottom > top:
        size = (right - left, bottom - top)
        mask = corner_marks(size, (x0 - left, y0 - top, x1 - left, y1 - top), scale)
        region = img.crop((left, top, right, bottom))
        region.paste(Image.new("RGB", size, rgb), mask=mask)
        img.paste(region, (left, top))
    if label:
        place_label(img, gray, str(label), (x0, y0, x1, y1), rgb, scale)


def place_label(img, gray, label, rect, rgb, scale):
    # The numeral goes beside the top-left corner, on whichever side is quietest,
    # so it never lands on the page's own text.
    x0, y0, x1, y1 = rect
    font = load_font(round(23 * scale))
    halo = max(2, round(3 * scale))
    room = halo + 5 * scale
    gap = 9 * scale
    _, top, right, bottom = font.getbbox(label, anchor="ls")
    w, h = right, bottom - top
    candidates = [(x0, y0 - gap - h), (x0 - gap - w, y0), (x0, y1 + gap)]

    def busy(pos):
        x, y = pos
        if x < halo or y < halo or x + w + halo > img.width or y + h + halo > img.height:
            return float("inf")
        area = gray.crop((round(max(0, x - room)), round(max(0, y - room)),
                          round(min(img.width, x + w + room)), round(min(img.height, y + h + room))))
        return ImageStat.Stat(area).stddev[0]

    scores = [busy(c) + 4 * k for k, c in enumerate(candidates)]
    k = min(range(len(candidates)), key=scores.__getitem__)
    x, y = candidates[k] if scores[k] != float("inf") else (max(halo, x0), max(halo, y0 - gap - h))
    ImageDraw.Draw(img).text((x, y - top), label, font=font, fill=rgb, anchor="ls",
                             stroke_width=halo, stroke_fill=(255, 255, 255))


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf-8"))
    for job in jobs:
        img = Image.open(job["src"]).convert("RGB")
        box = dict(job["box"]) if job.get("box") else None
        crop = job.get("crop")
        if crop:
            # Crop in still pixels first; the highlight box moves with the crop.
            x0, y0 = max(0, round(crop["x"])), max(0, round(crop["y"]))
            x1 = min(img.width, round(crop["x"] + crop["width"]))
            y1 = min(img.height, round(crop["y"] + crop["height"]))
            img = img.crop((x0, y0, x1, y1))
            if box:
                box["x"] -= x0
                box["y"] -= y0
        factor = job.get("width", img.width) / img.width
        if box:
            box = {k: box[k] * factor for k in ("x", "y", "width", "height")}
        if factor != 1:
            img = img.resize((round(img.width * factor), round(img.height * factor)), Image.LANCZOS)
        if box:
            bake(img, box, job.get("label"), job.get("color", "#2563EB"))
        img.save(job["dst"], "JPEG", quality=job.get("quality", 85), optimize=True, progressive=True)


if __name__ == "__main__":
    main()
