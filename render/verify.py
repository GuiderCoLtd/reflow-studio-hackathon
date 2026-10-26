#!/usr/bin/env python3
"""Inspect encoded output and extract overview/action contact sheets."""
import argparse
import json
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from graphics import font_path
from timeline import camera_at, full_camera


def verify(out):
    report = json.loads((out / 'render.json').read_text())
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams',
                                              '-show_format', '-of', 'json', str(out / 'video.mp4')]))
    video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    audio = next((s for s in probe['streams'] if s['codec_type'] == 'audio'), None)
    assert video['codec_name'] == 'h264' and video['pix_fmt'] == 'yuv420p'
    assert video['profile'] == 'High'
    assert int(video['nb_frames']) == report['frame_count']
    assert abs(float(video['duration']) - report['duration']) < .001
    assert report['captions'][-1]['end'] < float(video['duration'])
    if report['no_audio']:
        assert audio is None
    else:
        assert audio is not None and audio['sample_rate'] == '48000'
        assert abs(float(audio['duration']) - float(video['duration'])) <= 1 / report['fps']
    max_bounds_error, max_zoom = 0., 1.
    full = full_camera(*report['source_size'], report['size'][0] / report['size'][1])
    for scene in report['scenes']:
        for frame in range(scene['frame_count']):
            x, y, w, h = camera_at(scene, frame / report['fps'])
            max_zoom = max(max_zoom, full[2] / w)
            max_bounds_error = max(max_bounds_error, -x, -y,
                                   x + w - report['source_size'][0], y + h - report['source_size'][1])
    assert max_bounds_error < 1e-6
    assert max_zoom <= 1.6 + 1e-6
    rows = math.ceil(report['duration'] * .4 / 5)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
                    '-i', str(out / 'video.mp4'), '-vf', f'fps=0.4,scale=384:-1,tile=5x{rows}',
                    '-frames:v', '1', '-threads', '2', str(out / 'contact-sheet.jpg')], check=True)
    targets = [s for s in report['scenes'] if s['kind'] == 'step' and s['action_at'] is not None]
    sheet = Image.new('RGB', (1920, max(1, math.ceil(len(targets) / 2)) * 568), (230, 233, 239))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(font_path(), 20)
    cap = cv2.VideoCapture(str(out / 'video.mp4'))
    coords = []
    for j, s in enumerate(targets):
        # Inspect the first encoded frame at/after the action trigger.
        frame_no = s['start_frame'] + math.ceil(s['action_at'] * report['fps'])
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
        ok, frame = cap.read()
        assert ok
        actual_t = (frame_no - s['start_frame']) / report['fps']
        camera = camera_at(s, actual_t)
        x, y, bw, bh = s['box']
        pointer = [(s['cursor'][k] - camera[k]) * report['size'][k] / camera[k + 2] for k in (0, 1)]
        assert x <= s['cursor'][0] <= x + bw and y <= s['cursor'][1] <= y + bh
        coords.append(dict(i=s['i'], frame=frame_no, time=frame_no / report['fps'], pointer_output=pointer))
        image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).resize((960, 540))
        xx, yy = j % 2 * 960, j // 2 * 568
        sheet.paste(image, (xx, yy))
        draw.text((xx + 12, yy + 542), f"{s['i']}  {s['title']}  /  {frame_no / report['fps']:.2f}s", font=font, fill=(11, 18, 32))
    outro_checks, review_frames = verify_outro(cap, report, out, full)
    cap.release()
    sheet.save(out / 'action-sheet.jpg', quality=93)
    result = dict(video_duration=float(video['duration']), audio_duration=float(audio['duration']) if audio else None,
                  caption_end=report['captions'][-1]['end'], max_camera_bounds_error=max_bounds_error,
                  max_zoom=max_zoom, outro_checks=outro_checks, reviewed_frames=review_frames,
                  clicks=coords, warnings=report['warnings'], render_seconds=report['render_seconds'],
                  render_fps=report['render_fps'])
    (out / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(out, json.dumps(result, ensure_ascii=False))


def reference_view(source, camera, size):
    x, y, w, h = camera
    if round(w) == source.shape[1] and round(h) == source.shape[0]:
        crop = source
    else:
        crop = cv2.getRectSubPix(source, (round(w), round(h)), (x + (w - 1) / 2, y + (h - 1) / 2))
    return cv2.resize(crop, tuple(size), interpolation=cv2.INTER_AREA if w >= size[0] else cv2.INTER_CUBIC)


def verify_outro(cap, report, out, full):
    scene, fps = report['scenes'][-1], report['fps']
    assert scene['kind'] == 'outro'
    assert scene['card_at'] >= scene['audio_duration']
    assert 1.19 <= scene['duration'] - scene['card_at'] <= 1.2 + 1 / fps
    source = cv2.imread(str(Path(report['wf']) / 'film/frames' / scene['events'][-1]['f']))
    assert source is not None
    checks, reviews, images = [], [], []
    intro = report['scenes'][0]
    samples = [('intro', intro['start_frame'] + intro['frame_count'] // 2, None)]
    voice_end = min(scene['card_at'], scene['audio_duration'])
    for fraction in (.03, .5, .95):
        local_frame = min(math.floor(voice_end * fps) - 1, round(voice_end * fraction * fps))
        samples.append(('outro narration', scene['start_frame'] + local_frame, 'voice'))
    samples.append(('completion card', scene['start_frame'] + math.ceil((scene['card_at'] + .5) * fps), 'card'))
    samples.append(('fade end', scene['end_frame'] - 1, 'fade'))
    for step in report['scenes']:
        if step['kind'] == 'step' and step.get('navigation'):
            samples.append((f"step {step['i']} result", step['end_frame'] - 2, None))
    for label, number, phase in samples:
        cap.set(cv2.CAP_PROP_POS_FRAMES, number)
        ok, frame = cap.read()
        assert ok
        t = (number - scene['start_frame']) / fps
        if phase:
            camera = camera_at(scene, t)
            np.testing.assert_allclose(camera, full, atol=1e-6)
            reference = reference_view(source, camera, report['size'])
            # Exclude bottom subtitles; any central title or global dimming remains measurable.
            end_y = round(frame.shape[0] * .72)
            actual_gray = cv2.cvtColor(frame[:end_y], cv2.COLOR_BGR2GRAY).astype(np.float32)
            reference_gray = cv2.cvtColor(reference[:end_y], cv2.COLOR_BGR2GRAY).astype(np.float32)
            ratio = float(actual_gray.mean() / max(1., reference_gray.mean()))
            error = float(np.abs(actual_gray - reference_gray).mean())
            if phase == 'voice':
                assert .98 <= ratio <= 1.02, f'Outro narration dimmed at {number / fps:.3f}s: {ratio}'
                assert error < 4., f'Unexpected overlay during outro narration: MAE={error}'
            elif phase == 'card':
                assert ratio < .75, 'Completion card must be separate from the clear result hold'
            else:
                assert float(frame.mean()) < 2., 'Final frame must fade to black'
            checks.append(dict(phase=phase, time=number / fps, brightness_ratio=ratio, pixel_mae=error))
        images.append(frame)
        reviews.append(dict(label=label, frame=number, time=number / fps))
    sheet = Image.new('RGB', (1920, math.ceil(len(images) / 2) * 568), (230, 233, 239))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(font_path(), 20)
    for j, (frame, review) in enumerate(zip(images, reviews)):
        xx, yy = j % 2 * 960, j // 2 * 568
        image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).resize((960, 540))
        sheet.paste(image, (xx, yy))
        draw.text((xx + 12, yy + 542), f"{review['label']} / {review['time']:.2f}s", font=font, fill=(11, 18, 32))
    sheet.save(out / 'review-sheet.jpg', quality=93)
    return checks, reviews


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path, nargs='+')
    args = parser.parse_args()
    cv2.setNumThreads(2)
    runs = Path(__file__).resolve().parent.parent / 'runs'
    for out in args.out:
        relative = out.resolve().relative_to(runs)
        if 'out' not in relative.parts:
            parser.error('Verification outputs must be inside runs/**/out/')
        verify(out)
