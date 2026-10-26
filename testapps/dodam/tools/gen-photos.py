#!/usr/bin/env python3
"""Generate the demo site's photographs with the newest gpt-image model.

Photographs only: places and people. No icons, pictograms, illustrations,
UI or readable text. Writes PNGs to assets-src/photos/.
  python3 tools/gen-photos.py [name ...]
"""
import base64
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'assets-src' / 'photos'
API = 'https://api.openai.com/v1'
HEAD = {'Authorization': f"Bearer {os.environ['OPENAI_API_KEY']}", 'Content-Type': 'application/json'}


def newest_model():
    req = urllib.request.Request(f'{API}/models', headers=HEAD)
    ids = [m['id'] for m in json.loads(urllib.request.urlopen(req, timeout=60).read())['data']]
    # prefer the sunburst variant of the newest gpt-image generation
    cands = sorted({i for i in ids if i.startswith('gpt-image-') and not i[-10:].replace('-', '').isdigit()})
    best = max(cands, key=lambda i: [float(p) if p.replace('.', '').isdigit() else 0 for p in i.split('-')[2:3]] + ['sunburst' in i])
    return best


NEGATIVE = (' Photorealistic documentary photograph, natural color, restrained grading, realistic skin texture. '
            'No readable text anywhere, no letters, no logos, no watermarks, no user interface on screens, '
            'no icons, no illustration, no 3D render look, no studio backdrop.')

PORTRAIT = (' Head-and-shoulders portrait, subject looking near the camera, 85mm lens, shallow depth of field, '
            'candid moment between shots rather than a posed ID photo.')

PHOTOS = {
    # people (square)
    'p-kim-haneul': ('1024x1024', 'A Korean woman in her mid-thirties, marketing team lead, sitting on a low sofa in a bright office '
                     'lounge by a large window on an overcast day, cream knit cardigan over a white tee, warm relaxed smile, '
                     'a ceramic mug in hand slightly out of frame.' + PORTRAIT),
    'p-park-jihoon': ('1024x1024', 'A Korean man in his early fifties, company director, standing in a small glass-walled meeting room, '
                      'navy blazer with an open-collar light blue shirt, calm thoughtful expression, cool daylight, '
                      'a whiteboard far behind him completely out of focus.' + PORTRAIT),
    'p-lee-doyun': ('1024x1024', 'A Korean man in his late twenties, marketing specialist, at a standing desk area with wooden shelves '
                    'blurred behind, light gray hoodie under an unbuttoned olive overshirt, easy grin, mixed window and warm lamp light.' + PORTRAIT),
    'p-choi-seoa': ('1024x1024', 'A Korean woman in her late twenties, marketing manager, in a small office pantry with a coffee machine '
                    'softly blurred, pale blue oxford shirt, hair tied back loosely, natural expression mid-laugh, soft side light.' + PORTRAIT),
    'p-han-soyul': ('1024x1024', 'A Korean woman in her late thirties, design team lead, in a design studio corner with pinned paper '
                    'swatches and fabric samples far out of focus, black turtleneck, short bob haircut, confident calm look, '
                    'directional daylight from the left.' + PORTRAIT),
    'p-seo-junho': ('1024x1024', 'A Korean man in his mid-thirties, engineering team lead, in a quiet corner of an open office in the evening, '
                    'thin metal glasses, dark green plaid overshirt over a black tee, slight smile, warm desk lamp light '
                    'and cool monitor glow from the side, background desks in bokeh.' + PORTRAIT),
    # places (wide)
    'office-seongsu': ('1536x1024', 'The office of a small B2B software company in an old renovated brick building in Seongsu, Seoul. '
                       'Overcast daylight through tall steel-framed windows, long shared wooden desks in use with notebooks, '
                       'a few laptops seen from behind, potted plants, two people working in the far background, '
                       'tidy but lived-in, eye-level view, no exaggerated wide angle, quiet weekday afternoon mood.'),
    'townhall': ('1536x1024', 'A monthly all-hands meeting in the same small Seoul company office: about twenty Korean employees in their twenties to forties, in casual clothes, '
                 'seated on mismatched chairs facing a speaker who stands with her back half turned to the camera, '
                 'a projection screen far ahead showing only a soft blank glow, natural light from windows, candid documentary feel, '
                 'shot from the back of the room at eye level.'),
    'training-room': ('1536x1024', 'A small seminar room in a Korean office during an information security training session: '
                      'eight employees at two rows of tables with laptops closed or turned away, a trainer gesturing beside a blank screen, '
                      'afternoon daylight, muted neutral colors, candid moment, eye-level view.'),
}


def generate(name, size, prompt, model):
    body = json.dumps({'model': model, 'prompt': prompt + NEGATIVE, 'size': size, 'quality': 'xhigh', 'n': 1}).encode()
    req = urllib.request.Request(f'{API}/images/generations', data=body, headers=HEAD)
    with urllib.request.urlopen(req, timeout=900) as res:
        item = json.load(res)['data'][0]
    dest = OUT / f'{name}.png'
    dest.write_bytes(base64.b64decode(item['b64_json']))
    return f'{name}: {dest.stat().st_size // 1024} KB'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    model = newest_model()
    print('model', model, flush=True)
    names = sys.argv[1:] or list(PHOTOS)
    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        futs = {pool.submit(generate, n, *PHOTOS[n], model): n for n in names}
        for f in futs:
            try:
                print(f.result(), flush=True)
            except Exception as e:  # report and keep the others
                print(f'{futs[f]}: FAILED {e}', flush=True)


if __name__ == '__main__':
    main()
