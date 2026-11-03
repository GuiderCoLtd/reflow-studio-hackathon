# Workflow video compositor

Run from the repository root:

```bash
python3 render/video.py --wf runs/hometax/wf/business-status-lookup
python3 render/video.py --wf runs/gitea/wf/create-private-repository
python3 render/video.py --wf runs/gitea/wf/check-requested-reviews
```

Options: `--out runs/.../out/variant`, `--size 1920x1080`, `--fps 30`,
`--no-audio`, `--lang ko`. Outputs are restricted to `runs/**/out/`; artifacts
with matching names in that directory are replaced. Workflows without narration
can use `--no-audio`, for example `find-repository-and-read-readme`.

Requires Python 3.12, NumPy, OpenCV, Pillow, ffmpeg with libx264/AAC, and a Korean
font. NanumBarunGothic Bold is preferred, with NanumGothic/Noto Sans CJK/fontconfig
fallbacks. No browser, network service, or GPU is required.

## Framing and scene timing

`timeline.py` builds a deterministic narration-driven scene plan. WAV durations
are measured from PCM data. No-audio mode estimates voice length at 7.5
characters/second. Scenes are quantized to whole frames; step result holds last
at least 0.8 seconds. Ghost steps never use action/result stills. Capture
timestamps govern burst spacing; typing stills use 70 ms intervals.

Targets and optional `context` rectangles are converted from CSS to still pixels
using DPR. The camera includes the target and its UI block, with padding. Blocks
wider than 90% or taller than 80% of the viewport retain their horizontal range
and a local vertical neighborhood around the target. Negative coordinates and
oversized blocks are clipped to the source viewport. Null, empty, incomplete, or
invalid context falls back to generous target padding. Zoom never exceeds 1.6×;
at 16:9 the camera always shows at least 62.5% of the original width.

Consecutive preferred cameras with at least 68% overlap share one fitted view,
unless a page/major-screen transition separates them. The shared view includes
the union of the preferred crops, avoiding repeated pans between nearby fields.
URL changes or large differences between idle/result/next-idle signatures cause
a full-view retreat during the result phase. The last step also returns to full
view before the outro. `render.json` records original contexts, preferred and
shared cameras, camera groups, transition flags, and image-difference metrics.

Intro length follows narration plus 0.35 seconds, without the old 2.5-second
floor. Titles wrap to at most two whole-word lines and shrink when necessary.
During outro narration the final result remains at full zoom and brightness,
with subtitles only. After the voice ends, a separate 1.2-second title and
completion card appears, followed by a fade to black. The card begins on the
first whole frame after the audio ends.

## Composition and artifacts

`stills.py` shares a bounded source-image LRU between transition analysis and
composition; signatures are tiny blurred grayscale images. `video.py` uses
subpixel crop centers, cached resized views, and raw BGR frames piped to ffmpeg.
A temporary 48 kHz PCM mix is removed after encoding; video replacement is atomic
after ffmpeg succeeds. `ffmpeg.log` remains for diagnosis.

`graphics.py` shapes Korean text, preserves words, limits subtitles to two lines
per cue, and composites captions, the cursor, and highlights in small regions.
Caption chunks use proportional character timing, rather than phoneme alignment.
SRT/VTT and burned-in captions use the same frame boundaries. Existing icons in
captured screenshots remain part of those screenshots; added graphics are text,
the caption panel (step number and title above the narration line), cobalt
corner marks around the target, a segmented progress line (one segment per
step), click ripples, and the pointer. The pointer is drawn larger than life
with a soft cobalt glow; it flies to each target on a shallow arc, banks toward
its direction of travel, overshoots a few pixels and settles, with faint motion
blur while moving. Click and select actions happen near the end of their
narration line (about 78 %), so the caption describes the screen being shown.

Outputs are `video.mp4`, `captions.srt`, `captions.vtt`, `chapters.json`,
`poster.jpg`, and `render.json`, plus the encoder log. Chapters contain step
intervals; intro/outro and the completion-card timing are in the full render plan.
Missing optional stills fall forward to the next existing scene still, or back to
the previous available still, with a warning and `missing_source` on the event.
Inputs are never modified. Missing opening stills or narration WAVs fail clearly.

## Verification

```bash
python3 -m unittest discover -s render -p 'test_*.py' -v
python3 render/verify.py \
  runs/hometax/wf/business-status-lookup/out \
  runs/gitea/wf/create-private-repository/out \
  runs/gitea/wf/check-requested-reviews/out
```

Ten regressions cover context fallback/dialogs/negative-y long forms, zoom limits,
shared framing, scroll and same-URL transitions, short intros, two-line titles,
unobscured outro narration, completion-card fade, caption timing, and action
variants. Ghost/native-select branches use in-memory planning fixtures because
the supplied samples do not contain them.

`verify.py` checks H.264 High/yuv420p, exact frame counts, A/V duration, caption
endpoints, every frame's camera bounds and 1.6× zoom limit, and target containment.
During outro narration it compares three encoded frames to the undimmed final
still, excluding the subtitle region (brightness ratio 0.98–1.02; pixel MAE <4).
It also checks full-view framing, card timing/dimming, and the final black frame.
The verifier extracts `contact-sheet.jpg`, `action-sheet.jpg`, and
`review-sheet.jpg` from the actual MP4 and records checks/timestamps in
`verification.json`. Empty contact-sheet tiles are not video frames.

Measured at 1920×1080, 30 fps on the local Ryzen 9 5900X, with audio:

| Workflow | Video duration | Render wall time | Throughput |
| --- | ---: | ---: | ---: |
| hometax/business-status-lookup | 26.37 s | 9.83 s | 80.5 fps |
| gitea/create-private-repository | 32.13 s | 12.01 s | 80.3 fps |
| gitea/check-requested-reviews | 16.10 s | 5.66 s | 85.3 fps |

All three were rendered, probed, and visually inspected at action, page-retreat,
intro, clear-outro, completion-card, and final-fade frames. Current inputs produce
no missing-still warnings. Outro narration brightness is approximately 98.9% of
the source after H.264 color conversion; global dimming starts only in the card.

## 확대 범위 가장자리
카메라가 확대할 때 가장자리가 어색하게 걸리지 않게 다듬는다(`timeline.py`의 `clean_camera`).
- 사이드바·옆 패널의 경계가 가장자리 바로 안쪽에 있으면 그 조각을 잘라내 패널이 통째로 빠지게 한다(단계 대상과 그 블록은 항상 화면 안).
- 가장자리가 글자 줄을 가로지르면 빈 띠(페이지 폭의 약 0.9%)가 나올 때까지 바깥으로 넓힌다(최대 페이지 폭의 25%). 글자 사이 틈을 빈 곳으로 오인하지 않게 한 줄이 아니라 띠로 검사한다.
- 위·아래 가장자리는 크기를 바꾸지 않고 위아래로 밀어 글자 줄을 피한다.
