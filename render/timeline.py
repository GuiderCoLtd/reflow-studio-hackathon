"""Deterministic, frame-quantized scene and camera planning."""
from __future__ import annotations

import math
import wave
from pathlib import Path

import cv2
import numpy as np

from stills import StillCache


def ease(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return np.asarray(a) * (1 - t) + np.asarray(b) * t


def full_camera(width, height, aspect):
    w = min(width, height * aspect)
    h = w / aspect
    return [(width - w) / 2, (height - h) / 2, w, h]


def visible_rect(rect, width, height):
    x, y, w, h = rect
    left, top = max(0., x), max(0., y)
    right, bottom = min(float(width), x + w), min(float(height), y + h)
    return [left, top, max(0., right - left), max(0., bottom - top)]


def union_rect(first, second):
    x, y = min(first[0], second[0]), min(first[1], second[1])
    return [x, y, max(first[0] + first[2], second[0] + second[2]) - x,
            max(first[1] + first[3], second[1] + second[3]) - y]


def fit_camera(region, full, width, height):
    x, y, w, h = region
    aspect = full[2] / full[3]
    cw = min(full[2], max(full[2] / 1.6, w, h * aspect))
    ch = cw / aspect
    return [max(0., min(width - cw, x + w / 2 - cw / 2)),
            max(0., min(height - ch, y + h / 2 - ch / 2)), cw, ch]


def context_rect(context, dpr):
    if not isinstance(context, dict):
        return None
    values = [context.get(k) for k in ('x', 'y', 'width', 'height')]
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
        return None
    if values[2] <= 0 or values[3] <= 0:
        return None
    return [v * dpr for v in values]


def target_camera(box, full, width, height, context=None):
    x, y, w, h = box
    usable = visible_rect(context, width, height) if context else None
    if usable and usable[2] > 0 and usable[3] > 0:
        # Oversized/scrolled blocks retain their horizontal layout and local vertical context.
        if context[2] > width * .9 or context[3] > height * .8:
            local_height = max(h * 1.7, height * .52)
            usable = [usable[0], y + h / 2 - local_height / 2, usable[2], local_height]
        region = union_rect(box, usable)
        padx, pady = max(80., width * .035), max(65., height * .04)
    else:
        region = list(box)
        padx = pady = 220.
    region = [region[0] - padx, region[1] - pady,
              region[2] + 2 * padx, region[3] + 2 * pady]
    return fit_camera(visible_rect(region, width, height), full, width, height)


def clean_camera(camera, image, full, width, height, keep=None, reach=.25, gap=.009, rounds=4):
    """Tidy the camera's edges so the crop reads as deliberate: an edge never
    slices a line of text or a control, and never leaves a sliver of a side
    panel or sidebar at the border (the panel is either in or out). `keep` is
    the rect that must stay in view (the step targets and their block);
    `reach` caps how far an edge moves out and `gap` is the blank band an edge
    needs (fractions of the page width)."""
    if image is None or camera[2] >= full[2] - 1:
        return camera
    aspect = full[2] / full[3]
    min_w = full[2] / 1.6
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.int16)
    ink = (np.abs(cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)).astype(np.int32)
           + np.abs(cv2.Sobel(gray, cv2.CV_16S, 0, 1, ksize=3)).astype(np.int32)) > 120
    limit, need = int(width * reach), max(6, int(width * gap))
    margin = int(width * .008)
    x, y, w, h = camera
    if keep is None:
        keep = [x + w / 2, y + h / 2, 0, 0]
    kx0, ky0, kx1, ky1 = keep[0], keep[1], keep[0] + keep[2], keep[1] + keep[3]

    def blank_col(c, y0, y1):
        if not 0 <= c < width:
            return True
        line = ink[max(0, int(y0)):min(height, int(y1)), int(c)]
        return line.size == 0 or line.mean() < .003

    def blank_row(r, x0, x1):
        if not 0 <= r < height:
            return True
        line = ink[int(r), max(0, int(x0)):min(width, int(x1))]
        return line.size == 0 or line.mean() < .003

    def panel_cols(y0, y1):
        """Columns where the background steps along much of the span: the
        edges of sidebars, side panels and cards."""
        band = gray[max(0, int(y0)):min(height, int(y1)), :]
        if band.shape[0] < 4:
            return []
        step = np.abs(np.diff(band, axis=1)) > 3
        return list(np.where(step.mean(axis=0) > .35)[0] + 1)

    def outward_col(c, direction, y0, y1):
        run = 0
        for k in range(limit):
            q = int(c) + direction * k
            if q <= 0 or q >= width:
                return min(max(q, 0), width)
            run = run + 1 if blank_col(q, y0, y1) else 0
            if run >= need:
                return q - direction * (need // 2)
        return c

    L, R, T, B = x, x + w, y, y + h
    for _ in range(rounds):
        before = (L, R, T, B)
        cols = panel_cols(T, B)
        # a panel edge just inside the border: drop the sliver (keep stays in view)
        sliver = .15 * (R - L)
        left_in = [c for c in cols if L < c <= L + sliver and c + margin <= kx0]
        if left_in:
            L = max(left_in) + margin
        right_in = [c for c in cols if R - sliver <= c < R and c - margin >= kx1]
        if right_in:
            R = min(right_in) - margin
        # text under the border: move it out to a blank band (a single blank
        # column can be the gap between two letters, so test a band)
        def clear(c):
            return all(blank_col(q, T, B) for q in range(int(c) - need // 2, int(c) + need // 2 + 1, 2))
        if not clear(L):
            L = outward_col(L, -1, T, B)
        if not clear(R):
            R = outward_col(R, 1, T, B)
        # width rules, then the height that goes with it
        cw = min(full[2], max(min_w, R - L))
        if cw > R - L:
            grow = (cw - (R - L)) / 2
            L, R = L - grow, R + grow
            if L < 0:
                L, R = 0, cw
            if R > width:
                L, R = width - cw, width
        ch = cw / aspect
        cy = min(max((T + B) / 2, ky1 - ch / 2), ky0 + ch / 2) if ky1 - ky0 <= ch else (ky0 + ky1) / 2
        T = min(max(cy - ch / 2, 0), height - ch)
        B = T + ch
        # slide (not resize) so neither the top nor the bottom cuts a line
        best = None
        for d in sorted(range(-limit, limit + 1, 4), key=abs):
            t2, b2 = T + d, B + d
            if t2 < 0 or b2 > height or t2 > ky0 or b2 < ky1:
                continue
            if blank_row(t2, L, R) and blank_row(b2 - 1, L, R):
                best = d
                break
        if best is not None:
            T, B = T + best, B + best
        if all(abs(a - b) < 1 for a, b in zip(before, (L, R, T, B))):
            break
    return [float(L), float(T), float(R - L), float(B - T)]


def overlap(first, second):
    w = max(0., min(first[0] + first[2], second[0] + second[2]) - max(first[0], second[0]))
    h = max(0., min(first[1] + first[3], second[1] + second[3]) - max(first[1], second[1]))
    return w * h / min(first[2] * first[3], second[2] * second[3])


def stabilize_scenes(scenes, full, source, stills):
    steps = [s for s in scenes if s['kind'] == 'step']
    for j, scene in enumerate(steps):
        idle, result = scene['events'][0]['f'], scene['events'][-1]['f']
        next_idle = steps[j + 1]['events'][0]['f'] if j + 1 < len(steps) else result
        scene['screen_change'] = stills.difference(idle, next_idle)
        scene['boundary_change'] = stills.difference(result, next_idle)
        scene['navigation'] = (scene['url_navigation'] or scene['screen_change']['large']
                               or scene['boundary_change']['large'])
    groups = []
    for scene in steps:
        previous = groups[-1][-1] if groups else None
        if (previous and not previous['navigation']
                and overlap(previous['camera_preferred'], scene['camera_preferred']) >= .68):
            groups[-1].append(scene)
        else:
            groups.append([scene])
    for group_id, group in enumerate(groups):
        region = group[0]['camera_preferred']
        for scene in group[1:]:
            region = union_rect(region, scene['camera_preferred'])
        shared = fit_camera(region, full, *source)
        keep = None
        for scene in group:
            for rect in (scene.get('box'), visible_rect(scene['context'], *source) if scene.get('context') else None):
                if rect and rect[2] > 0 and rect[3] > 0:
                    keep = list(rect) if keep is None else union_rect(keep, rect)
        try:
            shared = clean_camera(shared, stills.load(group[0]['events'][0]['f']), full, *source, keep=keep)
        except (AttributeError, ValueError):
            pass
        for scene in group:
            scene.update(camera_target=shared, camera_group=group_id,
                         camera_stabilized=len(group) > 1)
            scene['camera_end'] = full if (scene['navigation'] or scene['large_target']
                                          or scene is steps[-1]) else shared
    previous = full
    for scene in scenes:
        scene['camera_from'] = list(previous)
        previous = scene['camera_end']


def audio_info(entry, wf, text, no_audio, warnings):
    if no_audio:
        return max(1.8, len(text) / 7.5), None
    if not entry or not entry.get('wav'):
        raise ValueError('Missing narration WAV; use --no-audio for text timing')
    path = Path(entry['wav'])
    if not path.is_absolute():
        path = wf / path
    with wave.open(str(path), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (48000, 1, 2):
            raise ValueError(f'Expected 48 kHz mono PCM16 WAV: {path}')
        duration = wav.getnframes() / wav.getframerate()
    if abs(duration - entry.get('duration', duration)) > .05:
        warnings.append(f'{path.name}: duration taken from WAV, not metadata')
    return duration, str(path)


def plan(script, film, narration, wf, fps, size, source, no_audio, stills=None):
    warnings, scenes = [], []
    width, height = source
    full = full_camera(width, height, size[0] / size[1])
    stills = stills or StillCache(wf / 'film/frames', source)
    dpr = film.get('dpr', 1)
    expected = (film['viewport']['width'] * dpr, film['viewport']['height'] * dpr)
    if expected != source:
        raise ValueError(f'Still dimensions {source} do not match viewport × DPR {expected}')
    copies = {s['i']: s for s in script['steps']}
    voices = {s['i']: s for s in narration.get('steps', [])}
    current_frame = 0
    previous_camera = full
    previous_cursor = [width * .5, height * .55]
    last_still = film['opening']['f']

    def add(kind, text, voice, title, capture=None):
        nonlocal current_frame, previous_camera, previous_cursor, last_still
        duration, wav = audio_info(voice, wf, text, no_audio, warnings)
        s = dict(kind=kind, title=title, text=text, audio_duration=duration, wav=wav,
                 start=current_frame / fps, start_frame=current_frame,
                 camera_from=list(previous_camera), cursor_from=list(previous_cursor))
        events = []
        if kind == 'step':
            c = capture
            frames = c['frames']
            idle = frames.get('idle', {'f': last_still})['f']
            hover = frames.get('hover', {'f': idle})['f']
            ghost = c.get('status') == 'ghost'
            action = c['action']
            box = c.get('box')
            if not box:
                warnings.append(f"Step {c['i']}: no target box; using full view")
            rect = [box[k] * dpr for k in ('x', 'y', 'width', 'height')] if box else None
            cursor = c.get('cursor')
            point = ([cursor['x'] * dpr, cursor['y'] * dpr] if cursor else
                     [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2] if rect else previous_cursor)
            context = context_rect(c.get('context'), dpr)
            camera = target_camera(rect, full, width, height, context) if rect else full
            approach = .7
            if action == 'fill':
                action_at = max(.9, min(duration * .42, duration * .55))
                late = action_at > duration * .55
            else:
                # Clicks land near the end of the line, so the caption never describes
                # a screen that has already been replaced.
                action_at = max(.9, min(duration * .78, duration - .25))
                late = action_at > duration - .25
            if late:
                warnings.append(f"Step {c['i']}: narration too short for the 0.9s action lead-in")
            events = [dict(at=0., f=idle, kind='idle', fade=0.),
                      dict(at=approach, f=hover, kind='hover', fade=.12)]
            at = action_at
            if not ghost and action != 'hover':
                if action == 'fill':
                    if frames.get('focus'):
                        events.append(dict(at=at, f=frames['focus']['f'], kind='focus', fade=.08))
                    at += .16
                    for frame in frames.get('typing', []):
                        events.append(dict(at=at, f=frame['f'], kind='typing', fade=0.,
                                           chars=frame.get('chars')))
                        at += .07
                elif action == 'select' and frames.get('open'):
                    events.append(dict(at=at, f=frames['open']['f'], kind='open', fade=.1))
                    at += .5
                else:
                    at += .12
                burst = frames.get('burst', [])
                gaps = [max(.08, min(.3, (burst[j + 1]['t'] - f['t'])
                                    if j + 1 < len(burst) else .15)) for j, f in enumerate(burst)]
                # Keep every captured burst frame within both the interval and total limits.
                if len(gaps) > 15:
                    indices = np.linspace(0, len(burst) - 1, 15).astype(int)
                    burst = [burst[j] for j in indices]
                    gaps = [.08] * 15
                    warnings.append(f"Step {c['i']}: burst resampled to 15 frames")
                if sum(gaps) > 1.2:
                    excess = sum(gaps) - .08 * len(gaps)
                    factor = (1.2 - .08 * len(gaps)) / excess
                    gaps = [.08 + (g - .08) * factor for g in gaps]
                burst_start = at
                for frame, gap in zip(burst, gaps):
                    events.append(dict(at=at, f=frame['f'], kind='burst', fade=min(.1, gap)))
                    at += gap
                settled = frames.get('settled', {'f': events[-1]['f']})['f']
                events.append(dict(at=at, f=settled, kind='settled', fade=.1))
            else:
                burst_start = at
                settled = hover
                at = max(approach + .4, at)
                if ghost:
                    warnings.append(f"Step {c['i']}: ghost; action and result frames suppressed")
            scene_duration = max(duration + .35, at + .8)
            navigation = c.get('urlAfter') != c.get('urlBefore')
            large = bool(rect and (rect[2] > width * .55 or rect[3] > height * .55))
            camera_end = full if navigation or large else camera
            s.update(i=c['i'], action=action, status=c.get('status', 'ok'), box=rect,
                     context=context, context_kind=(c.get('context') or {}).get('kind'),
                     camera_preferred=camera, url_navigation=navigation, large_target=large,
                     cursor=point, approach=approach, action_at=None if ghost or action == 'hover' else action_at,
                     result_at=at, burst_start=burst_start, burst_duration=at - burst_start,
                     camera_target=camera, camera_end=camera_end,
                     camera_return_duration=min(1.15, scene_duration - at), events=events)
            previous_cursor = point
            last_still = settled
        else:
            scene_duration = duration + (.35 if kind == 'intro' else 1.2)
            if kind == 'outro':
                s.update(card_at=math.ceil(duration * fps) / fps, card_duration=1.2,
                         completion_text='완료' if script.get('lang', 'ko') == 'ko' else 'Complete')
                scene_duration = s['card_at'] + s['card_duration']
            events = [dict(at=0., f=last_still, kind=kind, fade=0.)]
            camera_end = full
            s.update(events=events, camera_target=full, camera_end=full)
        for j, event in enumerate(events):
            if not (wf / 'film/frames' / event['f']).is_file():
                replacement = next((e['f'] for e in events[j + 1:]
                                    if (wf / 'film/frames' / e['f']).is_file()),
                                   events[j - 1]['f'] if j else film['opening']['f'])
                warnings.append(f"Missing still {event['f']}; substituted {replacement}")
                event['missing_source'] = event['f']
                event['f'] = replacement
        last_still = events[-1]['f']
        count = math.ceil(scene_duration * fps)
        current_frame += count
        s.update(end_frame=current_frame, end=current_frame / fps,
                 duration=count / fps, frame_count=count)
        scenes.append(s)
        previous_camera = camera_end

    voice = narration.get('intro')
    add('intro', (voice or {}).get('text', script.get('intro', '')), voice, script['title'])
    for c in film['steps']:
        cp, voice = copies[c['i']], voices.get(c['i'])
        add('step', (voice or {}).get('text', cp.get('narration', cp.get('instruction', ''))),
            voice, cp['title'], c)
    voice = narration.get('outro')
    add('outro', (voice or {}).get('text', script.get('outro', '')), voice,
        script['title'])
    stabilize_scenes(scenes, full, source, stills)
    return scenes, warnings


def camera_at(scene, t):
    camera = lerp(scene['camera_from'], scene['camera_target'],
                  ease(t / scene.get('approach', 1.0)))
    if scene['kind'] == 'step' and t >= scene['result_at']:
        camera = lerp(scene['camera_target'], scene['camera_end'],
                      ease((t - scene['result_at']) / scene['camera_return_duration']))
    return camera
