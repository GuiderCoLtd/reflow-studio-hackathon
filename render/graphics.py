"""Cached text sprites and small-region compositing in BGR space."""
from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, features


PRETENDARD = '/usr/share/fonts/opentype/pretendard/Pretendard-{}.otf'
COBALT = (37, 99, 235)
# Cobalt lifted for numerals and marks on dark backdrops, where #2563EB reads too dim.
COBALT_LIGHT = (101, 145, 241)
INK = (17, 24, 39)
# Deep ink-cobalt behind the intro and completion cards.
CARD = (15, 23, 48)
WHITE = (248, 250, 252)
SOFT_WHITE = (226, 232, 240)
MUTED_ON_DARK = (169, 184, 214)
RULE_ON_DARK = (112, 124, 148)
# Caption panels: ink at ~80 % over a frosted copy of the screen.
PANEL_ALPHA = 204
# Tabular numerals need libraqm; without it the digits fall back to proportional.
TNUM = ['tnum'] if features.check('raqm') else None


def bgr(rgb):
    return np.array(rgb[::-1], np.float32)


def font_file(weight='SemiBold'):
    path = PRETENDARD.format(weight)
    return path if Path(path).exists() else font_path()


def font_path():
    choices = [PRETENDARD.format('Bold'),
               '/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf',
               '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
               '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc']
    for path in choices:
        if Path(path).exists():
            return path
    path = subprocess.check_output(['fc-match', '-f', '%{file}', 'sans:lang=ko:style=Bold'], text=True)
    if not Path(path).exists():
        raise ValueError('No usable Korean font found')
    return path


def wrap_words(text, font, width):
    lines, line = [], ''
    for word in text.split():
        proposed = f'{line} {word}'.strip()
        if line and font.getlength(proposed) > width:
            lines.append(line)
            line = word
        else:
            line = proposed
    if line:
        lines.append(line)
    return lines


def title_layout(text, path, size, width):
    # Keep titles to two complete, word-wrapped lines, shrinking only when necessary.
    while True:
        font = ImageFont.truetype(path, size)
        lines = wrap_words(text, font, width)
        if size <= 1 or (len(lines) <= 2 and max(map(font.getlength, lines), default=0) <= width):
            return font, lines
        size -= 1


def caption_chunks(text, font, width):
    # Sentence boundaries precede length-based splitting; words are never cut.
    sentences = re.split(r'(?<=[.!?。！？])\s+', text.strip())
    result = []
    for sentence in sentences:
        lines = wrap_words(sentence, font, width)
        result.extend('\n'.join(lines[i:i + 2]) for i in range(0, len(lines), 2))
    return result


def build_captions(scenes, graphics, fps):
    captions = []
    for scene in scenes:
        chunks = caption_chunks(scene['text'], graphics.caption_font, graphics.width * .78 - 48 * graphics.scale)
        weights = [len(c.replace('\n', ' ')) for c in chunks]
        total = sum(weights)
        start = scene['start_frame']
        end = start + round(scene['audio_duration'] * fps)
        running = 0
        for j, (chunk, weight) in enumerate(zip(chunks, weights)):
            next_frame = end if j == len(chunks) - 1 else start + round((running + weight) / total * (end - start))
            begin = start + round(running / total * (end - start))
            if next_frame > begin:
                captions.append(dict(start=begin / fps, end=next_frame / fps, text=chunk,
                                     start_frame=begin, end_frame=next_frame))
            running += weight
    return captions


def timestamp(t, separator):
    ms = round(t * 1000)
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    seconds, ms = divmod(ms, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02}{separator}{ms:03}'


def write_captions(captions, out):
    srt, vtt = [], ['WEBVTT\n']
    for i, c in enumerate(captions, 1):
        text = c['text']
        srt.append(f"{i}\n{timestamp(c['start'], ',')} --> {timestamp(c['end'], ',')}\n{text}\n")
        vtt.append(f"{timestamp(c['start'], '.')} --> {timestamp(c['end'], '.')}\n{text}\n")
    (out / 'captions.srt').write_text('\n'.join(srt), encoding='utf-8')
    (out / 'captions.vtt').write_text('\n'.join(vtt), encoding='utf-8')


def sprite_from_pil(im):
    a = np.asarray(im)
    return a[:, :, 2::-1].copy(), a[:, :, 3:4].astype(np.float32) / 255


def composite(frame, sprite, x, y, opacity=1.):
    rgb, alpha = sprite
    x, y = round(x), round(y)
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(frame.shape[1], x + rgb.shape[1]), min(frame.shape[0], y + rgb.shape[0])
    if x2 <= x1 or y2 <= y1 or opacity <= 0:
        return
    src = rgb[y1 - y:y2 - y, x1 - x:x2 - x]
    a = alpha[y1 - y:y2 - y, x1 - x:x2 - x] * opacity
    roi = frame[y1:y2, x1:x2]
    roi[:] = src * a + roi * (1 - a)


def frost(frame, coverage, x, y, sigma, saturation=.4):
    """Blur and desaturate the screen under a panel's coverage, so the UI behind
    a caption reads as soft light instead of competing text or site colour."""
    x, y = round(x), round(y)
    h, w = coverage.shape[:2]
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(frame.shape[1], x + w), min(frame.shape[0], y + h)
    if x2 <= x1 or y2 <= y1:
        return
    # Sample a margin around the panel so its edges blur real neighbours.
    m = math_ceil(sigma * 2)
    X1, Y1 = max(0, x1 - m), max(0, y1 - m)
    X2, Y2 = min(frame.shape[1], x2 + m), min(frame.shape[0], y2 + m)
    region = frame[Y1:Y2, X1:X2]
    small = cv2.resize(region, (max(1, (X2 - X1) // 4), max(1, (Y2 - Y1) // 4)), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), sigma / 4)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)[:, :, None]
    small = (small * saturation + gray * (1 - saturation)).astype(np.uint8)
    soft = cv2.resize(small, (X2 - X1, Y2 - Y1), interpolation=cv2.INTER_LINEAR)[y1 - Y1:y2 - Y1, x1 - X1:x2 - X1]
    a = coverage[y1 - y:y2 - y, x1 - x:x2 - x]
    roi = frame[y1:y2, x1:x2]
    roi[:] = soft * a + roi * (1 - a)


def rounded_mask(w, h, radius, aa=3):
    im = Image.new('L', (w * aa, h * aa))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, w * aa - 1, h * aa - 1), radius=radius * aa, fill=255)
    return im.resize((w, h), Image.Resampling.LANCZOS)


def ink_extent(font, sample='한'):
    # Ink above and below the baseline for a representative glyph, so panels are
    # padded by what the eye sees rather than by the font's line box.
    _, top, _, bottom = font.getbbox(sample, anchor='ls')
    return -top, max(0, bottom)


class Graphics:
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.scale = height / 1080
        self.font = font_path()
        self.fonts = {k: font_file(w) for k, w in dict(caption='SemiBold', step='Bold', title='ExtraBold',
                                                       eyebrow='SemiBold', meta='Medium', done='Medium').items()}
        self.caption_font = ImageFont.truetype(self.fonts['caption'], max(12, round(34 * self.scale)))
        step_size = max(10, round(21 * self.scale))
        self.step_fonts = (ImageFont.truetype(self.fonts['step'], step_size),
                           ImageFont.truetype(self.fonts['caption'], step_size))
        self.pointer_hi = self.make_pointer()
        self.glow = self.make_glow()

    @lru_cache(maxsize=256)
    def text(self, text, kind='title'):
        # Card typography (intro / completion): centred lines, no backdrop.
        s = self.scale
        size = {'title': 64, 'eyebrow': 24, 'meta': 24, 'done': 28}[kind]
        color = {'eyebrow': COBALT_LIGHT, 'meta': MUTED_ON_DARK, 'done': MUTED_ON_DARK}.get(kind, WHITE)
        path = self.fonts[kind]
        font = ImageFont.truetype(path, max(12, round(size * s)))
        max_width = self.width * .80 - 48 * s
        if kind == 'title':
            font, lines = title_layout(text, path, font.size, max_width)
        else:
            lines = text.split('\n') if '\n' in text else wrap_words(text, font, max_width)
        # Exceptionally long identifiers keep their word intact at a smaller font size.
        longest = max((font.getlength(line) for line in lines), default=1)
        if longest > max_width:
            font = ImageFont.truetype(path, max(1, int(font.size * max_width / longest)))
        line_h = round(font.size * (1.24 if kind == 'title' else 1.38))
        pad = round(4 * s)
        w = math_ceil(max((font.getlength(line) for line in lines), default=1)) + pad * 2
        h = max(1, len(lines)) * line_h + pad * 2
        im = Image.new('RGBA', (w, h))
        draw = ImageDraw.Draw(im)
        for j, line in enumerate(lines):
            draw.text(((w - font.getlength(line)) / 2, pad + j * line_h + (line_h - font.size * 1.18) / 2),
                      line, font=font, fill=color, anchor='lt')
        return sprite_from_pil(im)

    @lru_cache(maxsize=256)
    def caption(self, text, number=None, title=None):
        """Subtitle panel. Step captions carry a small line above the narration:
        cobalt numerals, a short rule and the step title. Returns the sprite and
        the panel's coverage, which frost() uses to soften the screen beneath."""
        s = self.scale
        body, (f_num, f_title) = self.caption_font, self.step_fonts
        lines = text.split('\n')
        pad_x, pad_y = round(30 * s), round(20 * s)
        line_h = round(body.size * 1.4)
        top, bottom = ink_extent(body)
        width = max(body.getlength(line) for line in lines)
        head_h = 0
        if number:
            gap, rule = round(12 * s), round(16 * s)
            num_w = f_num.getlength(number, features=TNUM)
            width = max(width, num_w + gap + rule + gap + f_title.getlength(title))
            h_top, h_bottom = ink_extent(f_title)
            head_h = h_top + h_bottom + round(15 * s)
        w = math_ceil(width) + pad_x * 2
        h = round(pad_y * 2 + head_h + top + bottom + (len(lines) - 1) * line_h)
        coverage = rounded_mask(w, h, 10 * s)
        im = Image.new('RGBA', (w, h), (*INK, 0))
        im.putalpha(coverage.point(lambda v: v * PANEL_ALPHA // 255))
        draw = ImageDraw.Draw(im)
        if number:
            base = pad_y + h_top
            draw.text((pad_x, base), number, font=f_num, fill=COBALT_LIGHT, anchor='ls', features=TNUM)
            x = pad_x + num_w + gap
            mid, thick = base - h_top * .42, max(1, round(1.5 * s))
            draw.rectangle((x, mid - thick / 2, x + rule, mid + thick / 2), fill=RULE_ON_DARK)
            draw.text((x + rule + gap, base), title, font=f_title, fill=SOFT_WHITE, anchor='ls')
        for j, line in enumerate(lines):
            draw.text((pad_x, pad_y + head_h + top + j * line_h), line, font=body, fill=WHITE, anchor='ls')
        return sprite_from_pil(im), np.asarray(coverage, np.float32)[:, :, None] / 255

    @lru_cache(maxsize=4)
    def check(self, size=64):
        # Completion mark: a thin cobalt ring around a drawn check, not a filled disc.
        s, aa = self.scale, 4
        n = round(size * s)
        m = n * aa
        im = Image.new('RGBA', (m, m))
        d = ImageDraw.Draw(im)
        d.ellipse((0, 0, m - 1, m - 1), outline=(*COBALT_LIGHT, 255), width=round(3 * s * aa))
        pts = [(m * .31, m * .52), (m * .445, m * .645), (m * .70, m * .385)]
        stroke = 3.6 * s * aa
        d.line(pts, fill=(*WHITE, 255), width=round(stroke), joint='curve')
        for x, y in (pts[0], pts[-1]):
            r = stroke / 2
            d.ellipse((x - r, y - r, x + r, y + r), fill=(*WHITE, 255))
        return sprite_from_pil(im.resize((n, n), Image.Resampling.LANCZOS))

    def progress(self, frame, total, position):
        """Segmented progress along the bottom edge: one thin segment per step,
        completed segments cobalt, the current one filling. position runs from
        0 (before the first step) to total (all steps done)."""
        if total < 1:
            return
        s = self.scale
        h = max(2, round(4 * s))
        gap = max(2, round(6 * s))
        span = (self.width - gap * (total - 1)) / total
        band = frame[self.height - h:]
        track, fill = bgr(INK), bgr(COBALT)
        for j in range(total):
            x0, x1 = round(j * (span + gap)), round(j * (span + gap) + span)
            segment = band[:, x0:x1]
            segment[:] = segment * .58 + track * .42
            done = min(1., max(0., position - j))
            if done > 0:
                band[:, x0:x0 + round((x1 - x0) * done)] = fill

    # Pointer drawn larger than life (macOS-style black arrow, white rim) on a
    # square canvas whose centre is the hotspot, so it can lean and scale
    # around the tip while it travels.
    POINTER_SCALE = 1.25
    ARROW = [(0, 0), (0, 27), (7, 20), (12, 31), (17, 28), (12, 18), (22, 18)]

    def make_pointer(self, aa=4):
        k = self.scale * self.POINTER_SCALE
        half = math_ceil(46 * k)
        n = half * 2 * aa
        pts = [(n / 2 + x * k * aa, n / 2 + y * k * aa) for x, y in self.ARROW]
        body = Image.new('L', (n, n))
        ImageDraw.Draw(body).polygon(pts, fill=255)
        rim = max(1, round(2.0 * k * aa))
        outline = body.filter(ImageFilter.MaxFilter(2 * rim + 1))
        shadow = Image.new('L', (n, n))
        shadow.paste(outline, (round(1.6 * k * aa), round(2.6 * k * aa)))
        shadow = shadow.filter(ImageFilter.GaussianBlur(3.2 * k * aa)).point(lambda v: v * 120 // 255)
        im = Image.new('RGBA', (n, n), (2, 6, 23, 0))
        im.putalpha(shadow)
        white = Image.new('RGBA', (n, n), (255, 255, 255, 0))
        white.putalpha(outline)
        im = Image.alpha_composite(im, white)
        dark = Image.new('RGBA', (n, n), (11, 15, 25, 0))
        dark.putalpha(body)
        return Image.alpha_composite(im, dark)

    def make_glow(self):
        # Soft cobalt halo that keeps the pointer visible on light pages.
        r = math_ceil(58 * self.scale)
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1].astype(np.float32)
        d2 = (xx * xx + yy * yy) / (r * r)
        # gaussian core with a window that reaches exactly zero at the sprite edge
        fall = np.exp(-d2 / (2 * .38 ** 2)) * np.clip(1 - d2, 0, 1) ** 2
        rgb = np.zeros((2 * r + 1, 2 * r + 1, 3), np.float32)
        rgb[:] = (COBALT[2], COBALT[1], COBALT[0])
        return rgb.astype(np.uint8), (fall * .5)[:, :, None]

    @lru_cache(maxsize=512)
    def pointer_sprite(self, lean, scale):
        base = self.pointer_hi
        im = base.rotate(-lean, resample=Image.Resampling.BICUBIC, center=(base.width / 2, base.height / 2))
        size = max(8, round(base.width / 4 * scale))
        return sprite_from_pil(im.resize((size, size), Image.Resampling.LANCZOS))

    def cursor(self, frame, point, press=0., opacity=1., lean=0., speed=0., glow=True):
        """Draw the pointer with its tip at point.

        lean: degrees the arrow banks toward its direction of travel.
        speed: 0..1, how fast it is moving (slightly enlarges it mid-flight).
        """
        if opacity <= 0:
            return
        scale = (1 + .05 * speed) * (1 - .14 * press)
        if glow:
            rgb, alpha = self.glow
            k = self.scale * self.POINTER_SCALE
            # centre the halo on the arrow body rather than its tip
            gx, gy = point[0] + 8 * k, point[1] + 12 * k
            strength = min(1., .62 + .25 * speed + .5 * press) * opacity
            composite(frame, (rgb, alpha), gx - rgb.shape[1] / 2, gy - rgb.shape[0] / 2, strength)
        sprite = self.pointer_sprite(round(lean * 2) / 2, round(scale, 2))
        rgb, _ = sprite
        composite(frame, sprite, point[0] - rgb.shape[1] / 2, point[1] - rgb.shape[0] / 2, opacity)

    def highlight(self, frame, rect, opacity, spread=0.):
        """Corner marks: four short cobalt L-corners with a soft glow and a faint
        wash inside, instead of a full outline. spread (0..1) holds the corners
        slightly outside the target while they arrive."""
        if opacity <= 0:
            return
        x, y, w, h = rect
        s = self.scale
        pad = (7 + 14 * spread) * s
        x, y, w, h = x - pad, y - pad, w + 2 * pad, h + 2 * pad
        margin = round(16 * s)
        left, top = max(0, int(x - margin)), max(0, int(y - margin))
        right, bottom = min(self.width, math_ceil(x + w + margin)), min(self.height, math_ceil(y + h + margin))
        if right <= left or bottom <= top:
            return
        aa = 3
        x0, y0, x1, y1 = (x - left) * aa, (y - top) * aa, (x + w - left) * aa, (y + h - top) * aa
        stroke = max(aa, round(3 * s * aa))
        arm = min(17 * s, w * .4, h * .4) * aa
        marks = Image.new('L', ((right - left) * aa, (bottom - top) * aa))
        d = ImageDraw.Draw(marks)
        d.rounded_rectangle((x0, y0, x1, y1), radius=4.5 * s * aa, outline=255, width=stroke)
        # erase the middle of every side, leaving four corners
        d.rectangle((x0 + arm, y0 - aa, x1 - arm, y0 + stroke + aa), fill=0)
        d.rectangle((x0 + arm, y1 - stroke - aa, x1 - arm, y1 + aa), fill=0)
        d.rectangle((x0 - aa, y0 + arm, x0 + stroke + aa, y1 - arm), fill=0)
        d.rectangle((x1 - stroke - aa, y0 + arm, x1 + aa, y1 - arm), fill=0)
        marks = marks.resize((right - left, bottom - top), Image.Resampling.BOX)
        wash = Image.new('L', marks.size)
        ImageDraw.Draw(wash).rounded_rectangle((x0 / aa, y0 / aa, x1 / aa, y1 / aa), radius=6 * s, fill=255)
        m = np.asarray(marks, np.float32) / 255
        glow = np.asarray(marks.filter(ImageFilter.GaussianBlur(3.5 * s)), np.float32) / 255 * .75
        inside = np.asarray(wash, np.float32) / 255 * .07
        alpha = 1 - (1 - m) * (1 - glow) * (1 - inside)
        rgb = np.empty((*alpha.shape, 3), np.uint8)
        rgb[:] = bgr(COBALT)
        composite(frame, (rgb, alpha[:, :, None]), left, top, opacity)

    def ripple(self, frame, point, progress):
        # Click: a soft disc blooms under the tip while a thin ring runs out.
        if not 0 <= progress <= 1:
            return
        s = self.scale
        ring = (7 + 30 * ease_out(progress)) * s
        disc = (5 + 18 * ease_out(min(1., progress * 1.4))) * s
        r = round(ring + 6 * s)
        aa = 3
        im = Image.new('RGBA', ((2 * r + 1) * aa, (2 * r + 1) * aa))
        d = ImageDraw.Draw(im)
        c = (r + .5) * aa
        d.ellipse((c - disc * aa, c - disc * aa, c + disc * aa, c + disc * aa),
                  fill=(*COBALT, round(70 * (1 - progress))))
        d.ellipse((c - ring * aa, c - ring * aa, c + ring * aa, c + ring * aa),
                  outline=(*COBALT, round(235 * (1 - progress) ** 1.3)), width=max(1, round(2.4 * s * aa)))
        im = im.resize((2 * r + 1, 2 * r + 1), Image.Resampling.LANCZOS)
        composite(frame, sprite_from_pil(im), point[0] - r, point[1] - r)


def ease_out(t):
    t = min(1., max(0., t))
    return 1 - (1 - t) ** 3


def math_ceil(value):
    return int(np.ceil(value))
