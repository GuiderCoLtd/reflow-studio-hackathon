# Reflow Studio

Reflow Studio turns a task in a web app into a how-to guide, and redoes the guide when the app changes. It is for teams that keep how-to guides for software: support, onboarding and training.

Give it a task, such as "create a private repository" in Gitea, an open-source code hosting app. Muse Spark 1.3 does the task in the real app through computer use, and Studio turns that run into four formats: a narrated video, a step-by-step article, a click-through demo and a walkthrough inside Reflow's in-app player. When the app's navigation changes and the saved guide breaks, Spark does the task again on the new screen, the guide is re-verified and regenerated, and it waits for a person to approve it.

Demo video (2:46): https://youtu.be/V2-H_sfvKF4

## What we built during the hackathon (Oct 27 – Nov 4, 2026)

The first commit (Oct 26) is the Studio prototype as it stood before the hackathon. It already explored a web app, performed tasks with a DOM snapshot agent, verified guides by deterministic replay, produced the four formats, ran a maintenance loop (replay, re-perform on failure, re-verify, regenerate, stop for review) and checked every action against a basic policy gate (`src/safety.mjs`).

Built during the hackathon, on top of that:

| New | Where |
|---|---|
| Muse Spark 1.3 computer-use executor. Spark sees screenshots plus the labels and grid coordinates of the visible controls, and answers with actions on the native computer tool, at 1280×720 | `src/computer.mjs`, `callComputer` in `src/llm.mjs` |
| Pixel-to-element resolver. Every coordinate Spark acts on is resolved to the real element and a verified locator bundle, so the run becomes guide steps that replay with no model choosing clicks | `src/computer.mjs` |
| Meta safety checks wired to the existing policy gate. A `computer_action_requires_confirmation` check is acknowledged only after the gate allows the action; a blocked action is never executed | `src/computer.mjs` |
| SAM 3.1 drift evidence. When a saved step fails, Spark names the control it expected and SAM counts it on the before and after screenshots | `src/evidence.mjs`, `segment` in `src/llm.mjs` |
| Muse Voice Transcribe listen-back. Every narrated line of a regenerated video is transcribed and flagged when the transcript differs from the script | `src/narrate.mjs`, `transcribe` in `src/llm.mjs` |
| Meta provider for planning, compiling and judging replay end states; English guide copy | `src/cli.mjs`, `src/compile.mjs`, `src/docs.mjs` |
| A controlled redesign to test against: our own navigation templates for a local Gitea 28.2, with the "+" menu removed and creation moved under Workspace > Create new | `testapps/gitea-ui-v2/`, `testapps/ctl.sh` |
| Public mode and one-command setup, so the repository runs without the private Reflow source | `testapps/setup.sh`, `src/reflow.mjs`, `src/cli.mjs` |

Not part of this repository: the Reflow browser extension and its player, a separate product that existed before the hackathon.

Every change since the first commit: https://github.com/GuiderCoLtd/reflow-studio-hackathon/compare/1cc8084...main

## How it works

1. **Perform.** Spark gets the goal, a screenshot and the visible controls, and answers with actions. Before each action runs, the executor finds the element under the coordinate, records a locator bundle, and checks the action against the policy gate.
2. **Compile and verify.** Detours are dropped and the copy is written for each format. The test database is restored and the guide is replayed as plain code to verify it before anything is filmed. A model judges the end state; it does not choose clicks during replay.
3. **Produce.** The verified run is filmed and narrated, and becomes a step-by-step article, a click-through demo and a guide for Reflow's in-app player.
4. **Maintain.** After the app changes, `maintain` replays each guide. When a step fails, SAM 3.1 checks the old control on both screenshots, Spark performs the task again on the new UI without being given the new route, and the guide is recompiled, re-verified, refilmed and listened back. It stops at `REVIEW_REQUIRED`; nothing is published automatically.

## Results

### Redesign test (Gitea, Nov 1)

We replaced Gitea's navigation templates ourselves (`GITEA_UI=v2`).

- The old guide's first selector still matched an element, so it opened the account menu; step 2 then failed with target not found.
- SAM 3.1 with the prompt "plus icon": 2 matches on the old screen, 0 on the new one.
- Spark performed the task again in 9 turns (113 s of agent time) without being given the new route. The repaired guide has 8 steps instead of 7 and passed replay with no model choosing clicks. The video, article, click-through demo and player guide were regenerated, and the run stopped at `REVIEW_REQUIRED`.
- Listen-back on the regenerated narration flagged 2 of 10 lines for review, for example "Type the repository name in the field." transcribed as "type the repository repository name in the field."
- Safety test: a read-only task that asks for a delete. Spark proposed "Delete This Repository", the gate blocked it, and no write request was sent.

### Fresh clone check (Nov 3)

We followed the Quick start below in an empty folder, without the Reflow extension source. `setup.sh`, `run` and `maintain` all finished. `maintain` met the same failure (step 1 opened the account menu, step 2 target not found), Spark performed the task again, and the run stopped at `REVIEW_REQUIRED` with the player check recorded as not run. In this run Spark described the missing control as a "black tooltip", which SAM found on neither screen, so the visual evidence was empty: the evidence is only as useful as the concept Spark names.

### Benchmark: 11 everyday workflows (Oct 31, Gitea and Vikunja)

| | DOM snapshot agent | Muse Spark 1.3 computer use |
|---|---|---|
| Task performed | 11/11 | 11/11 |
| Replayed with no model choosing clicks | 11/11 | 11/11 |
| Filmed | 11/11 | 11/11 |
| Completed in Reflow's player | 10/11 | 10/11 |
| Total agent execution time | 503 s | 1,311 s |

- For Spark, one replay passed after the compiler was told why the first attempt failed, and one filming passed on a second take. Both retries are now automatic.
- The player miss is a step that presses Esc to close a date picker; the player has no key-press steps.
- Click test with screenshots only: 6 real buttons, Spark 1.1 and 1.3 at several effort settings, 36 of 36 clicks within 4 px of the target.
- Spark matched the snapshot agent on success counts and took about 2.6 times as long.

## Quick start

```bash
git clone https://github.com/GuiderCoLtd/reflow-studio-hackathon && cd reflow-studio-hackathon
npm install
npx playwright install chromium
./testapps/setup.sh            # downloads Gitea and Vikunja, demo account, sample data, snapshots

export MODEL_API_KEY=...       # Meta Model API key (or put it in ~/.config/meta-model-api/key)
export OPENAI_API_KEY=...      # narration voice only

node src/cli.mjs run gitea-demo create-private-repository --provider meta
GITEA_UI=v2 node src/cli.mjs maintain gitea-demo create-private-repository --provider meta
```

- `run` goes through perform, compile and verify, film, narrate, render and docs. Outputs land in `runs/<site>/wf/<workflow>/`: `out/video.mp4`, the article, the click-through demo, and `maintain/maintenance.json` after `maintain`.
- `GITEA_UI=v2` makes the test reset start Gitea with the redesigned navigation, so `maintain` meets the changed UI.
- Without the Reflow extension source (`REFLOW_SRC`), the Reflow player check is skipped and recorded as not run (`out/reflow/player-check.json`). Every other stage runs.
- Single stages: `node src/cli.mjs <perform|compile|film|narrate|render|docs> <site> <workflow>`.
- `--executor snapshot` runs the same task with the DOM snapshot agent for comparison.
- Narration uses OpenAI or ElevenLabs text-to-speech, since the Meta Model API has no speech synthesis model.

## Notes from building with Muse Spark computer use

- Coordinates: the model answers on a 0–1000 grid and the API converts it to pixels. Coordinates you put in a prompt must be grid values; pixel values come back shifted, and anything above 1000 comes back as 500.
- Viewport: 1280×720 for the executor. At 1440×810 the y coordinates drift. Replay and filming work on the DOM, so they keep 1440×810.
- Icons: position from the screenshot alone is accurate, but the meaning of an icon such as "⋯" is not. Each turn therefore also sends the visible controls with their labels and grid coordinates.
- `tool_choice: "required"` returns 400; only `auto` works.
- Every pending safety check must be acknowledged exactly once, or the next call returns 400. A blocked action is therefore never answered; the run continues in a new conversation from the current screen.
- A stored response chain occasionally returns 500; the executor restarts from the current screen.

## Sites (`sites/*.json`)

- `siteMode: "sandbox"`: a test app or test account. Approved creates and edits are allowed, and the database snapshot is restored before each run (`reset`).
- `siteMode: "live"`: a real service. Read-only tasks only; irreversible actions are filmed as ghost steps and never executed.
- `login`: checked at the start of every session, with a fresh login when the session has expired.

## Test apps (`testapps/`)

Vikunja 2.7.1 (tasks and projects, Vue SPA) and Gitea 28.2 (code hosting, server-rendered) run locally on sqlite. `./testapps/setup.sh` downloads them, points their configs at your checkout, creates the `demo` / `DemoPass!2026` account (local only), loads sample data and saves the snapshots the site configs restore.

- `./testapps/ctl.sh start|stop|restart|snapshot|restore <app> [name]` controls an app and its database snapshot, including the WAL checkpoint.

## Requirements

Linux, Node 22, Playwright (Chromium), Python 3.12 with OpenCV and Pillow, ffmpeg 6, and the Pretendard or Nanum font for Korean captions.
