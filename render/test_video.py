"""Regression checks for framing, transitions, timing, and unobscured result holds."""
import copy
import json
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from graphics import Graphics, build_captions, title_layout
from timeline import camera_at, context_rect, full_camera, plan, target_camera
from video import Compositor

WF = Path(__file__).resolve().parent.parent / 'runs/gitea/wf/create-private-repository'
SOURCE, SIZE = (2880, 1620), (1920, 1080)
FULL = full_camera(*SOURCE, 16 / 9)


class DifferenceCache:
    def __init__(self, changed=()):
        self.changed = set(changed)

    def difference(self, first, second):
        large = (first, second) in self.changed
        return dict(mean=.2 if large else 0., changed_fraction=.8 if large else 0., large=large)


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.script = json.loads((WF / 'script.json').read_text())
        self.film = json.loads((WF / 'film/timeline.json').read_text())
        self.voice = json.loads((WF / 'narration.json').read_text())

    def make_plan(self, no_audio=False, stills=None):
        return plan(self.script, self.film, self.voice, WF, 30, SIZE, SOURCE, no_audio, stills)

    def test_narration_timing_zoom_and_camera_continuity(self):
        scenes, _ = self.make_plan()
        for j, scene in enumerate(scenes):
            self.assertGreaterEqual(scene['duration'], scene['audio_duration'] + .349)
            if j:
                self.assertEqual(scene['start_frame'], scenes[j - 1]['end_frame'])
                np.testing.assert_allclose(camera_at(scene, 0), camera_at(scenes[j - 1], scenes[j - 1]['duration']))
            for t in np.linspace(0, scene['duration'], 121):
                x, y, w, h = camera_at(scene, t)
                self.assertGreaterEqual(x, -1e-6)
                self.assertGreaterEqual(y, -1e-6)
                self.assertLessEqual(x + w, SOURCE[0] + 1e-6)
                self.assertLessEqual(y + h, SOURCE[1] + 1e-6)
                self.assertAlmostEqual(w / h, 16 / 9)
                self.assertLessEqual(FULL[2] / w, 1.6 + 1e-6)
            if scene['kind'] == 'step':
                voice = scene['audio_duration']
                self.assertGreaterEqual(scene['action_at'], .9)
                if scene['action'] == 'fill':
                    self.assertLessEqual(scene['action_at'], voice * .55)
                else:
                    # clicks land late in the line, so the caption still matches the screen
                    self.assertAlmostEqual(scene['action_at'], max(.9, min(voice * .78, voice - .25)))
                    self.assertLessEqual(scene['action_at'], max(.9, voice - .25))
                self.assertGreaterEqual(scene['duration'] - scene['result_at'], .8)
                self.assertLessEqual(scene['burst_duration'], 1.2 + 1e-6)

    def test_missing_capture_falls_forward(self):
        self.film['steps'][0]['frames']['burst'][0]['f'] = 'deliberately-missing.jpg'
        scenes, warnings = self.make_plan(stills=DifferenceCache())
        event = next(e for e in scenes[1]['events'] if e['kind'] == 'burst')
        self.assertEqual(event['missing_source'], 'deliberately-missing.jpg')
        self.assertTrue(any('deliberately-missing.jpg' in w for w in warnings))

    def test_ghost_cannot_show_mutation(self):
        self.film['steps'][0]['status'] = 'ghost'
        scenes, warnings = self.make_plan(stills=DifferenceCache())
        self.assertIsNone(scenes[1]['action_at'])
        self.assertEqual([e['kind'] for e in scenes[1]['events']], ['idle', 'hover'])
        self.assertTrue(any('ghost' in w for w in warnings))

    def test_select_and_hover(self):
        step = self.film['steps'][0]
        step['action'] = 'select'
        step['frames']['open'] = copy.deepcopy(step['frames']['hover'])
        scenes, _ = self.make_plan(stills=DifferenceCache())
        scene = scenes[1]
        opened = next(e for e in scene['events'] if e['kind'] == 'open')
        burst = next(e for e in scene['events'] if e['kind'] == 'burst')
        self.assertAlmostEqual(burst['at'] - opened['at'], .5)
        step['action'] = 'hover'
        scenes, _ = self.make_plan(stills=DifferenceCache())
        self.assertIsNone(scenes[1]['action_at'])
        self.assertEqual(len(scenes[1]['events']), 2)

    def test_captions_match_narration_and_frames(self):
        scenes, _ = self.make_plan(no_audio=True, stills=DifferenceCache())
        captions = build_captions(scenes, Graphics(*SIZE), 30)
        self.assertLess(captions[-1]['end'], scenes[-1]['end'])
        self.assertEqual(' '.join(c['text'].replace('\n', ' ') for c in captions),
                         ' '.join(s['text'] for s in scenes))
        for j, cue in enumerate(captions):
            self.assertLessEqual(len(cue['text'].splitlines()), 2)
            self.assertGreater(cue['end_frame'], cue['start_frame'])
            self.assertAlmostEqual(cue['start'] * 30, cue['start_frame'])
            if j:
                self.assertGreaterEqual(cue['start'], captions[j - 1]['end'])

    def test_context_null_empty_dialog_and_oversized_form(self):
        box = [1400, 800, 28, 28]
        for context in (None, {}, {'height': 10}, {'x': 0, 'y': 0, 'width': -1, 'height': 2}):
            self.assertIsNone(context_rect(context, 2))
            camera = target_camera(box, FULL, *SOURCE, context_rect(context, 2))
            self.assertGreaterEqual(camera[2], SOURCE[0] * .6)
            self.assertLessEqual(SOURCE[0] / camera[2], 1.6)
        dialog = [850, 400, 1100, 700]
        camera = target_camera(box, FULL, *SOURCE, dialog)
        self.assertLessEqual(camera[0], dialog[0])
        self.assertLessEqual(camera[1], dialog[1])
        self.assertGreaterEqual(camera[0] + camera[2], dialog[0] + dialog[2])
        self.assertGreaterEqual(camera[1] + camera[3], dialog[1] + dialog[3])
        for box in ([1196, 796, 28, 28], [1196, 1320, 300, 76]):
            camera = target_camera(box, FULL, *SOURCE, [668, -804, 1544, 2200])
            self.assertLessEqual(camera[0], 668)
            self.assertGreaterEqual(camera[0] + camera[2], 2212)
            self.assertGreaterEqual(camera[1], 0)
            self.assertLessEqual(camera[1] + camera[3], SOURCE[1])
            self.assertGreaterEqual(camera[1] + camera[3], box[1] + box[3])

    def test_overlapping_form_steps_share_camera_and_scroll_retreats(self):
        scenes, _ = self.make_plan()
        np.testing.assert_array_equal(scenes[2]['camera_target'], scenes[3]['camera_target'])
        self.assertTrue(scenes[2]['camera_stabilized'])
        self.assertTrue(scenes[4]['boundary_change']['large'])
        np.testing.assert_allclose(scenes[4]['camera_end'], FULL)
        np.testing.assert_allclose(scenes[5]['camera_from'], FULL)

    def test_large_idle_change_retreats_without_url_change(self):
        first, second = self.film['steps'][1:3]
        cache = DifferenceCache([(first['frames']['idle']['f'], second['frames']['idle']['f'])])
        scenes, _ = self.make_plan(stills=cache)
        self.assertFalse(scenes[2]['url_navigation'])
        self.assertTrue(scenes[2]['navigation'])
        np.testing.assert_allclose(scenes[2]['camera_end'], FULL)
        np.testing.assert_allclose(scenes[3]['camera_from'], FULL)

    def test_short_intro_and_two_line_title(self):
        self.script['intro'] = '시작'
        self.voice['intro']['text'] = '시작'
        scenes, _ = self.make_plan(no_audio=True, stills=DifferenceCache())
        self.assertLess(scenes[0]['duration'], 2.5)
        graphics = Graphics(*SIZE)
        font, lines = title_layout('긴 제목의 줄바꿈을 확인하는 가이드 ' * 5, graphics.font, 68, 1488)
        self.assertLessEqual(len(lines), 2)
        self.assertLessEqual(max(map(font.getlength, lines)), 1488)

    def test_outro_voice_has_no_dimming_or_title_then_card_fades(self):
        scenes, _ = self.make_plan(stills=DifferenceCache())
        graphics = Graphics(*SIZE)
        captions = build_captions(scenes, graphics, 30)
        class FlatStills:
            def load(self, name):
                return np.full((SOURCE[1], SOURCE[0], 3), 210, dtype=np.uint8)
        compositor = Compositor(WF / 'film/frames', SOURCE, SIZE, scenes, captions, graphics, FlatStills())
        outro = scenes[-1]
        self.assertAlmostEqual(outro['duration'] - outro['card_at'], 1.2)
        for fraction in (0., .5, .95):
            number = outro['start_frame'] + int(outro['audio_duration'] * fraction * 30)
            image = compositor.frame(number, 30)
            np.testing.assert_array_equal(image[:750], 210)
            np.testing.assert_allclose(camera_at(outro, (number - outro['start_frame']) / 30), FULL)
        card = compositor.frame(outro['start_frame'] + round((outro['card_at'] + .5) * 30), 30)
        self.assertLess(float(card[:750].mean()), 150)
        self.assertGreater(int(card.max()), 230)
        self.assertEqual(int(compositor.frame(outro['end_frame'] - 1, 30).max()), 0)


if __name__ == '__main__':
    unittest.main()
