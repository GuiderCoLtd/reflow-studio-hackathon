# Reflow Studio

Guides that survive a redesign. Muse Spark performs a task once on the real app, plain code replays it with no model choosing clicks, and when the UI changes Spark finds the new path and the guide regenerates. Nothing is published until a person approves.

Demo video (2:54): https://youtu.be/ahgLJ2ZSCV8

## Built during the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026)

The first commit (Oct 26) is the prototype as it stood before the hackathon. Everything after it was built during the hackathon.

| New | Where |
|---|---|
| Muse Spark 1.3 computer-use executor: screenshot in, pixel actions out, at 1280×720 | `src/computer.mjs`, `callComputer` in `src/llm.mjs` |
| Pixel-to-element resolver: every pixel Spark returns becomes the real element plus verified locators, so the guide replays without a model | `src/computer.mjs` |
| Policy gate on safety checks: a `computer_action_requires_confirmation` check is acknowledged only for actions the gate lets through; refused actions never run | `src/computer.mjs`, `src/safety.mjs` |
| SAM 3.1 drift evidence: Spark names the control that disappeared, SAM counts it on the before and after screenshots | `src/evidence.mjs`, `segment` in `src/llm.mjs` |
| Muse Voice Transcribe listen-back: each narrated line of the regenerated video is transcribed and flagged when it drifts from the script | `src/narrate.mjs`, `transcribe` in `src/llm.mjs` |
| A real redesign to test against: Gitea 28.2 navigation templates with the "+" menu removed (Workspace > Create new instead) | `testapps/gitea-ui-v2/`, `testapps/ctl.sh` |
| Meta provider for planning, compiling and judging; English guide copy | `src/cli.mjs`, `src/compile.mjs`, `src/docs.mjs` |

Existed before the hackathon: the Reflow browser extension and its player (a separate product, not in this repository), and the Studio pipeline in the first commit: explore, plan, perform with a DOM snapshot agent, compile, deterministic replay, film, narrate, render and docs.

## How it works

1. **Perform.** Spark gets the goal and a screenshot and answers with pixel actions through the native computer tool. Before each action the executor finds the element under the pixel, records a locator bundle, and runs the action through the policy gate.
2. **Compile and verify.** Detours are dropped and the copy is written for each format. The test database is restored and the guide is replayed as plain code to verify it before anything is filmed.
3. **Produce.** The verified run is filmed and narrated, and becomes a step-by-step article, a click-through demo and a guide for Reflow's in-app player.
4. **Maintain.** After the app changes, `maintain` replays every guide without a model. When a step fails, SAM 3.1 checks the old control on both screenshots, Spark performs the task again on the new UI with no path given, and the guide is recompiled, re-verified, refilmed and listened back. It then stops at `REVIEW_REQUIRED`.

## Results

Same 11 workflows on Gitea and Vikunja (Oct 31):

| | DOM snapshot agent | Muse Spark 1.3 computer use |
|---|---|---|
| Task performed | 11/11 | 11/11 |
| Replayed with no model | 11/11 | 11/11 |
| Filmed | 11/11 | 11/11 |
| Completed in Reflow's player | 10/11 | 10/11 |
| Total run time | 503 s | 1,311 s |

- Click accuracy from screenshots alone, 6 real buttons: 36/36, all within 4 px.
- Redesign test (Gitea): the old guide's first selector still matched something and opened the account menu, then step 2 failed with target not found. SAM 3.1 found the "plus icon" twice before and zero times after. Spark re-performed the task in 9 turns (113 s) with no path given; the repaired guide has 8 steps and replays without a model.
- Safety test: a read-only task that asks for a delete. Spark reached for "Delete This Repository", the gate refused it, and no write request was sent.

## Quick start

```bash
npm install
npx playwright install chromium
export MODEL_API_KEY=...     # Meta Model API key (or put it in ~/.config/meta-model-api/key)
export OPENAI_API_KEY=...    # narration voice only

./testapps/ctl.sh start gitea
node src/cli.mjs run gitea-demo create-private-repository --provider meta

GITEA_UI=v2 ./testapps/ctl.sh restart gitea    # apply the redesign
node src/cli.mjs maintain gitea-demo create-private-repository --provider meta
```

- `run` goes through perform, compile and verify, film, narrate, render, docs and reflow. Outputs land in `runs/<site>/wf/<workflow>/`.
- Single stages: `node src/cli.mjs <perform|compile|film|narrate|render|docs|reflow> <site> <workflow>`.
- `--executor snapshot` runs the same task with the DOM snapshot agent for comparison.
- Narration voice uses OpenAI or ElevenLabs text-to-speech, since the Meta Model API has no speech synthesis model.
- The reflow stage reads the Reflow extension source from `REFLOW_SRC`, which is not public. Every other stage runs without it.

## Notes from building with Muse Spark computer use

- Coordinates: the model answers on a 0–1000 grid and the API converts it to pixels. Coordinates you put in a prompt must be grid values; pixel values come back shifted, and anything above 1000 comes back as 500.
- Viewport: 1280×720 for the executor. At 1440×810 the y coordinates drift. Replay and filming work on the DOM, so they keep 1440×810.
- Icons: position from the screenshot alone is accurate, but the meaning of an icon such as "⋯" is not. Each turn also sends the visible controls with their labels and grid coordinates.
- `tool_choice: "required"` returns 400; only `auto` works.
- Every pending safety check must be acknowledged exactly once, or the next call returns 400. A blocked action is therefore never answered; the run continues in a new conversation from the current screen.
- A stored response chain occasionally returns 500; the executor restarts from the current screen.

## Sites (`sites/*.json`)

- `siteMode: "sandbox"`: a test app or test account. Approved creates and edits are allowed, and the database snapshot is restored before each run (`reset`).
- `siteMode: "live"`: a real service. Read-only tasks only; irreversible actions are filmed as ghost steps and never executed.
- `login`: checked at the start of every session, with a fresh login when the session has expired.

## Test apps (`testapps/`)

Vikunja 2.7.1 (tasks and projects, Vue SPA) and Gitea 28.2 (code hosting, server-rendered) run locally on sqlite. The account is `demo` / `DemoPass!2026`, local only.

```bash
curl -sL -o /tmp/vikunja.zip https://github.com/go-vikunja/vikunja/releases/download/v2.7.1/vikunja-v2.7.1-linux-amd64-full.zip
unzip -o /tmp/vikunja.zip -d testapps/vikunja
curl -sL -o testapps/gitea/gitea https://dl.gitea.com/gitea/28.2.0/gitea-28.2.0-linux-amd64 && chmod +x testapps/gitea/gitea
(cd testapps/vikunja && source env.sh && export VIKUNJA_SERVICE_SECRET=$VIKUNJA_SERVICE_JWTSECRET && ./vikunja-v2.7.1-linux-amd64 migrate && ./vikunja-v2.7.1-linux-amd64 user create -u demo -e demo@example.com -p 'DemoPass!2026')
(cd testapps/gitea && ./gitea --config custom/conf/app.ini migrate && ./gitea --config custom/conf/app.ini admin user create --admin --username demo --password 'DemoPass!2026' --email demo@example.com --must-change-password=false)
./testapps/ctl.sh start vikunja && ./testapps/ctl.sh start gitea
node testapps/seed.mjs all
./testapps/ctl.sh snapshot vikunja base && ./testapps/ctl.sh snapshot gitea base
./testapps/ctl.sh snapshot gitea base-demo     # the snapshot sites/gitea-demo.json restores
```

- Paths inside `testapps/vikunja/env.sh` and `testapps/gitea/custom/conf/app.ini` are absolute; change them to where you cloned the repository.
- `ctl.sh snapshot|restore <app> [name]` saves and restores the database, including the WAL checkpoint.

## Requirements

Node 22, Playwright 1.64 (Chromium), the openai SDK 7, Python 3.12 with OpenCV and Pillow, ffmpeg 6, and the Pretendard or Nanum font for Korean captions.
