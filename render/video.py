#!/usr/bin/env python3
"""Compose filmed workflow stills into a narrated tutorial using OpenCV and ffmpeg."""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import wave
from bisect import bisect_right
from functools import lru_cache
from pathlib import Path

from PIL import Image

import cv2
import numpy as np

from graphics import CARD, Graphics, bgr, build_captions, composite, frost, write_captions
from timeline import camera_at, ease, plan
from stills import StillCache


def flight(scene, t):
    """Pointer position at t: it accelerates along a shallow arc, glides, runs a
    few pixels past the target and settles back onto it."""
    a, b = np.asarray(scene['cursor_from'], float), np.asarray(scene['cursor'], float)
    u = min(1., max(0., t / scene['approach']))
    p = 4 * u ** 3 if u < .5 else 1 - (-2 * u + 2) ** 3 / 2
    delta = b - a
    length = float(np.linalg.norm(delta))
    if length < 1:
        return b
    over = min(.045, 18 / length) * math.sin(math.pi * min(1., max(0., (u - .55) / .45)))
    point = a + delta * (p + over)
    return point + np.array([-delta[1], delta[0]]) / length * min(70, length * .08) * 4 * p * (1 - p)


class Compositor:
    def __init__(self, frames, source, size, scenes, captions, graphics, stills=None):
        self.frames = frames
        self.source, self.size = source, size
        self.scenes, self.captions, self.graphics = scenes, captions, graphics
        self.scene_starts = [s['start_frame'] for s in scenes]
        self.caption_starts = [c['start_frame'] for c in captions]
        self.stills = stills or StillCache(frames, source)
        self.load = self.stills.load
        steps = [j for j, s in enumerate(scenes) if s['kind'] == 'step']
        self.step_number = {j: k for k, j in enumerate(steps, 1)}
        self.caption_scene = [bisect_right(self.scene_starts, c['start_frame']) - 1 for c in captions]
        self.captions_on_top = self.place_captions()

    def caption_panel(self, j):
        k = self.caption_scene[j]
        number = self.step_number.get(k)
        if number is None:
            return self.graphics.caption(self.captions[j]['text'])
        return self.graphics.caption(self.captions[j]['text'], f'{number:02d}', self.scenes[k]['title'])

    def place_captions(self):
        # Captions sit at the bottom unless they would cover a step's target,
        # its corner marks or the pointer resting on it.
        g, (width, height) = self.graphics, self.size
        top = set()
        for j, k in enumerate(self.caption_scene):
            scene = self.scenes[k]
            if scene['kind'] != 'step' or not scene['box']:
                continue
            (rgb, _), _ = self.caption_panel(j)
            ph, pw = rgb.shape[:2]
            px, py = (width - pw) / 2, height - ph - 46 * g.scale
            cx, cy, cw, ch = scene['camera_target']
            x, y, w, h = scene['box']
            m = 24 * g.scale
            rx, ry = (x - cx) * width / cw - m, (y - cy) * height / ch - m
            rw, rh = w * width / cw + 2 * m, h * height / ch + 2 * m + 40 * g.scale
            if rx < px + pw and px < rx + rw and ry < py + ph and py < ry + rh:
                top.add(k)
        return top

    @lru_cache(maxsize=4)
    def backdrop(self, name, camera):
        # Title cards sit on a heavily blurred, desaturated and dimmed copy of the
        # screen: the layout survives as faint light, but no UI text or site
        # colour competes with the type.
        view = cv2.cvtColor(self.crop(name, camera), cv2.COLOR_BGR2GRAY)
        h, w = view.shape
        small = cv2.resize(view, (max(1, w // 16), max(1, h // 16)), interpolation=cv2.INTER_AREA)
        soft = cv2.resize(cv2.GaussianBlur(small, (0, 0), 2.5), (w, h), interpolation=cv2.INTER_LINEAR)
        soft = cv2.GaussianBlur(soft, (0, 0), 10).astype(np.float32)[:, :, None]
        return np.clip(bgr(CARD) * .84 + soft * .16, 0, 255).astype(np.uint8)

    def veil(self, frame, scene, camera, amount):
        if amount <= 0:
            return frame
        soft = self.backdrop(scene['events'][-1]['f'], tuple(camera))
        return soft.copy() if amount >= 1 else cv2.addWeighted(frame, 1 - amount, soft, amount, 0)

    @lru_cache(maxsize=8)
    def crop(self, name, camera):
        x, y, w, h = camera
        src = self.load(name)
        # Subpixel centers prevent integer crop positions from creating pan jitter.
        iw, ih = round(w), round(h)
        center = (x + (w - 1) / 2, y + (h - 1) / 2)
        if iw == src.shape[1] and ih == src.shape[0]:
            region = src
        else:
            region = cv2.getRectSubPix(src, (iw, ih), center)
        method = cv2.INTER_AREA if iw >= self.size[0] else cv2.INTER_CUBIC
        return cv2.resize(region, self.size, interpolation=method)

    def base(self, scene, t, camera):
        events = scene['events']
        j = bisect_right([e['at'] for e in events], t) - 1
        event = events[max(0, j)]
        current = self.crop(event['f'], tuple(camera))
        fade = event['fade']
        if j > 0 and fade and t < event['at'] + fade:
            previous = self.crop(events[j - 1]['f'], tuple(camera))
            alpha = ease((t - event['at']) / fade)
            return cv2.addWeighted(previous, 1 - alpha, current, alpha, 0)
        return current.copy()

    def frame(self, frame_index, fps):
        current = bisect_right(self.scene_starts, frame_index) - 1
        scene = self.scenes[current]
        t = (frame_index - scene['start_frame']) / fps
        camera = camera_at(scene, t)
        frame = self.base(scene, t, camera)
        g, (width, height) = self.graphics, self.size
        fade = 0.
        if scene['kind'] == 'step':
            def on_screen(point):
                return ((point[0] - camera[0]) * width / camera[2],
                        (point[1] - camera[1]) * height / camera[3])

            screen_point = on_screen(flight(scene, t))
            # velocity on screen drives the lean, the mid-flight swell and the blur
            h = 1 / 240
            a, b = on_screen(flight(scene, t - h)), on_screen(flight(scene, t + h))
            vx, vy = (b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)
            lean = max(-1., min(1., vx / (1500 * g.scale))) * 14
            speed = min(1., math.hypot(vx, vy) / (2600 * g.scale))
            # corner marks arrive from slightly outside as the pointer lands; they
            # belong to the screen they mark, so when the click opens another page
            # they leave as that page comes in instead of lingering over it
            arrive = ease((t - scene['approach']) / .28)
            if scene.get('navigation'):
                alpha = arrive * (1 - ease((t - scene['burst_start']) / .12))
            else:
                alpha = arrive * (1 - ease((t - scene['result_at']) / .4))
            if scene['box']:
                x, y, w, h = scene['box']
                rect = ((x - camera[0]) * width / camera[2], (y - camera[1]) * height / camera[3],
                        w * width / camera[2], h * height / camera[3])
                g.highlight(frame, rect, alpha, 1 - arrive)
            action_at = scene['action_at']
            progress = (t - action_at) / .35 if action_at is not None else -1
            if 0 <= progress <= 1:
                g.ripple(frame, screen_point, progress)
            press = math.sin(min(1, max(0, progress * 2)) * math.pi) if 0 <= progress < .5 else 0
            opacity = 1 - ease((t - scene['result_at'] - .25) / .45)
            # motion blur: faint copies along the last half frame of travel
            shutter = .5 / fps
            if math.hypot(vx, vy) * shutter > 4 * g.scale:
                for k, weight in enumerate((.16, .09, .05), 1):
                    ghost = on_screen(flight(scene, t - shutter * k / 3))
                    g.cursor(frame, ghost, press, opacity * weight, lean, speed, glow=False)
            g.cursor(frame, screen_point, press, opacity, lean, speed)
        elif scene['kind'] == 'intro':
            reveal_duration = min(.8, scene['duration'] * .35)
            reveal = ease((t - (scene['duration'] - reveal_duration)) / reveal_duration)
            title_alpha = ease(t / .25) * (1 - reveal)
            frame = self.veil(frame, scene, camera, 1 - reveal)
            stack = [g.text(scene['eyebrow'], 'eyebrow') if scene.get('eyebrow') else None,
                     g.text(scene['title'], 'title'),
                     g.text(scene['meta'], 'meta') if scene.get('meta') else None]
            self.stack(frame, stack, (8, 6), height * .43, title_alpha)
        elif t >= scene['card_at']:
            card_time = t - scene['card_at']
            appear = ease(card_time / .25)
            frame = self.veil(frame, scene, camera, appear)
            stack = [g.check(64), g.text(scene['title'], 'title'), g.text(scene['completion_text'], 'done')]
            self.stack(frame, stack, (28, 6), height * .45, appear)
            fade_at = scene['card_duration'] - .35
            fade_end = scene['duration'] - 1 / fps - scene['card_at']
            fade = ease((card_time - fade_at) / max(1e-6, fade_end - fade_at))
        if scene['kind'] == 'step':
            position = self.step_number[current] - 1 + min(1., t / scene['duration'])
        else:
            position = 0 if scene['kind'] == 'intro' else len(self.step_number)
        g.progress(frame, len(self.step_number), position)
        j = bisect_right(self.caption_starts, frame_index) - 1
        if j >= 0 and frame_index < self.captions[j]['end_frame']:
            sprite, coverage = self.caption_panel(j)
            x = (width - sprite[0].shape[1]) / 2
            y = (40 * g.scale if self.caption_scene[j] in self.captions_on_top
                 else height - sprite[0].shape[0] - 46 * g.scale)
            frost(frame, coverage, x, y, 16 * g.scale)
            composite(frame, sprite, x, y)
        if fade:
            frame = cv2.convertScaleAbs(frame, alpha=1 - fade)
        return frame

    def stack(self, frame, sprites, gaps, centre, opacity):
        # Centred column of card elements (mark / eyebrow, title, meta), with the
        # whole block centred on the given height.
        sprites = [(sprite, gap) for sprite, gap in zip(sprites, (0, *gaps)) if sprite is not None]
        s, width = self.graphics.scale, self.size[0]
        total = sum(sp[0].shape[0] for sp, _ in sprites) + sum(gap for _, gap in sprites[1:]) * s
        y = centre - total / 2
        for j, (sprite, gap) in enumerate(sprites):
            y += gap * s if j else 0
            composite(frame, sprite, (width - sprite[0].shape[1]) / 2, y, opacity)
            y += sprite[0].shape[0]


def mix_audio(scenes, duration, path):
    samples = np.zeros(round(duration * 48000), dtype=np.float32)
    for scene in scenes:
        with wave.open(scene['wav'], 'rb') as wav:
            signal = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        count = min(240, len(signal) // 2)
        signal[:count] *= np.linspace(0, 1, count)
        signal[-count:] *= np.linspace(1, 0, count)
        start = round(scene['start'] * 48000)
        samples[start:start + len(signal)] += signal
    peak = float(np.max(np.abs(samples)))
    gain = min(1., .95 / peak) if peak else 1.
    samples *= gain
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        wav.writeframes((samples * 32767).astype('<i2').tobytes())
    return dict(peak_before_gain=peak, gain=gain, sample_rate=48000, duration=len(samples) / 48000)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wf', required=True, type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--size', default='1920x1080')
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--no-audio', action='store_true')
    parser.add_argument('--lang', default='ko', help='Fallback language for generated closing text')
    args = parser.parse_args()
    try:
        args.size = tuple(map(int, args.size.lower().split('x')))
        if len(args.size) != 2 or min(args.size) < 128 or any(n % 2 for n in args.size):
            raise ValueError()
    except ValueError:
        parser.error('--size must be WIDTHxHEIGHT with even dimensions >=128')
    if not 1 <= args.fps <= 120:
        parser.error('--fps must be between 1 and 120')
    args.wf = args.wf.resolve()
    args.out = (args.out or args.wf / 'out').resolve()
    # All artifacts must remain inside a run's out directory.
    project_runs = Path(__file__).resolve().parent.parent / 'runs'
    try:
        relative = args.out.relative_to(project_runs)
        if 'out' not in relative.parts:
            raise ValueError()
    except ValueError:
        parser.error('--out must be under runs/**/out/')
    return args


def main():
    args = parse_args()
    started = time.perf_counter()
    cv2.setNumThreads(2)
    wf, out = args.wf, args.out
    out.mkdir(parents=True, exist_ok=True)
    script = json.loads((wf / 'script.json').read_text())
    script.setdefault('lang', args.lang)
    film = json.loads((wf / 'film/timeline.json').read_text())
    narration = {} if args.no_audio else json.loads((wf / 'narration.json').read_text())
    frames = wf / 'film/frames'
    with Image.open(frames / film['opening']['f']) as opening:
        source = opening.size
    graphics = Graphics(*args.size)
    stills = StillCache(frames, source)
    scenes, warnings = plan(script, film, narration, wf, args.fps, args.size, source, args.no_audio, stills)
    steps = [s for s in scenes if s['kind'] == 'step']
    for ordinal, scene in enumerate(steps, 1):
        scene.update(ordinal=ordinal, total_steps=len(steps))
    site_name = (script.get('site') or {}).get('name') or ''
    for scene in scenes:
        if scene['kind'] == 'intro':
            ko = script.get('lang', 'ko') == 'ko'
            scene['eyebrow'] = (f'{site_name} 사용 가이드' if ko else f'{site_name} how-to guide').strip()
            scene['meta'] = f'{len(steps)}단계' if ko else f'{len(steps)} steps'
        elif scene['kind'] == 'outro':
            scene['completion_text'] = '완료했어요' if script.get('lang', 'ko') == 'ko' else 'Done'

    captions = build_captions(scenes, graphics, args.fps)
    write_captions(captions, out)
    chapters = [dict(i=s['i'], title=s['title'], start=s['start'], end=s['end']) for s in steps]
    (out / 'chapters.json').write_text(json.dumps(chapters, ensure_ascii=False, indent=2) + '\n')
    compositor = Compositor(frames, source, args.size, scenes, captions, graphics, stills)
    duration, count = scenes[-1]['end'], scenes[-1]['end_frame']
    wav_path = out / '.narration-mix.wav'
    audio = None if args.no_audio else mix_audio(scenes, duration, wav_path)
    video_tmp = out / '.video.mp4'
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
               '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', f'{args.size[0]}x{args.size[1]}',
               '-framerate', str(args.fps), '-i', 'pipe:0']
    if audio:
        command += ['-i', str(wav_path), '-map', '0:v:0', '-map', '1:a:0',
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
    command += ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                '-preset', 'veryfast', '-crf', '18', '-threads', str(min(10, os.cpu_count() or 4)),
                '-t', f'{duration:.9f}', '-movflags', '+faststart', str(video_tmp)]
    render_start = time.perf_counter()
    log_path = out / 'ffmpeg.log'
    try:
        with log_path.open('w') as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log)
            try:
                for index in range(count):
                    frame = compositor.frame(index, args.fps)
                    process.stdin.write(memoryview(frame))
                    if index == min(count - 1, scenes[0]['end_frame'] + args.fps):
                        cv2.imwrite(str(out / 'poster.jpg'), frame, [cv2.IMWRITE_JPEG_QUALITY, 94])
                process.stdin.close()
                code = process.wait()
                if code:
                    raise RuntimeError(f'ffmpeg exited with {code}: {log_path.read_text()}')
            except BaseException:
                if not process.stdin.closed:
                    process.stdin.close()
                process.terminate()
                process.wait()
                raise
        video_tmp.replace(out / 'video.mp4')
    finally:
        wav_path.unlink(missing_ok=True)
        video_tmp.unlink(missing_ok=True)
    elapsed = time.perf_counter() - started
    report = dict(version=2, wf=str(wf), size=args.size, fps=args.fps, lang=script['lang'],
                  no_audio=args.no_audio, duration=duration, frame_count=count,
                  render_seconds=elapsed, encoding_seconds=time.perf_counter() - render_start,
                  render_fps=count / elapsed, realtime_factor=duration / elapsed,
                  source_size=source, dpr=film.get('dpr', 1), font=graphics.font,
                  audio=audio, warnings=warnings, decoded_stills=stills.decode_count,
                  cache=compositor.load.cache_info()._asdict(), scenes=scenes, captions=captions,
                  ffmpeg_command=command)
    (out / 'render.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('duration', 'render_seconds', 'render_fps', 'warnings')}, ensure_ascii=False))
    print(out / 'video.mp4')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, RuntimeError) as error:
        print(f'Render failed: {error}', file=sys.stderr)
        sys.exit(1)
