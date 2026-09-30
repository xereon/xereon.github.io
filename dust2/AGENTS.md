# Brief for every feature agent

You are one of ~11 specialist agents building **DUST II**: a browser tactical shooter in
Three.js (r180, vendored) on a from-scratch recreation of the de_dust2 layout. The bar is
**a blind side-by-side against Counter-Strike: Source / CS2 on Dust II**. A harsh critic
agent will screenshot your work and compare. Anything that reads as "a Three.js demo"
(flat lighting, untextured boxes, grey default materials, tile repetition, jaggies, floaty
movement, pea-shooter guns, generic UI) fails.

## Before you write code

1. Read `dust2/CONTRACT.md` in full. It defines units, axes (Source coordinates map 1:1),
   the `World` service locator, and every cross-module interface.
2. Read `dust2/src/main.js` to see how your module is loaded and called.
3. Read the current version of the files you own (they are baseline stubs you replace).

## Hard rules

* **Only edit files you own** (listed in your task). You may read anything. You may create
  new files inside your own directory and `dust2/tools/<yourname>*` for lab pages/tests.
* **Do NOT run `git commit`, `git add`, `git stash`, `git checkout` or anything that
  touches the index or working tree state.** Several agents share this checkout. The lead
  commits.
* **No external assets or network at runtime.** Everything (textures, meshes, sounds) is
  generated procedurally in code. Do not copy Valve textures, logos or sounds. Recreating
  the *layout* of Dust II from public knowledge is fine; copying their files is not.
* Code against the contract. If the thing you depend on is still a stub, your code must
  still run against the stub (feature-detect with `?.`).
* Never throw at module load time. A broken import takes other agents' screenshots down.
* No per-frame allocation in hot paths. Reuse scratch vectors. Keep draw calls sane
  (merge static geometry, use InstancedMesh for repeated props).
* Match the existing code style: ES modules, 2-space indent, short purposeful comments.

## Verifying your work (mandatory)

```bash
cd /home/user/xereon.github.io/dust2
node tools/shot.mjs --list-poses
node tools/shot.mjs --pose <name> --out /tmp/<you>/x.png --w 960 --h 540      # iterate small
node tools/shot.mjs --poses a,b,c --outdir /tmp/<you>/round3 --w 1600 --h 900  # final check
node tools/shot.mjs --pose <name> --probe                                      # perf JSON
node tools/shot.mjs --pose <name> --eval "cv.exposure=1.2" --out /tmp/<you>/y.png
node tools/shot.mjs --query "lab=textures" ...    # extra URL params for your own lab modes
node --import ./tools/three-resolve.mjs your_test.mjs                          # node tests
```

Then **look at the PNG with the Read tool**. The harness is software-rendered (SwiftShader)
so it is slow — iterate at 960×540 — and it exits non-zero on *any* console error, page
error or boot failure; treat that as a failing build. Only two browsers run at once
(semaphore), so if you see "waiting for a free render slot" just wait.

If you need a scene that isn't reachable from a pose (a texture swatch board, a weapon
turntable, a character T-pose), build a small lab page at `dust2/tools/<yourname>lab.html`
that imports your module, and screenshot it with Playwright yourself (copy the pattern in
`tools/shot.mjs`; it uses `/opt/node22/lib/node_modules/playwright`).

## Your self-critique loop

After each meaningful change: screenshot, look, and answer honestly — *"If I put this next
to a CS:S / CS2 Dust II screenshot, what is the first thing that gives it away?"* Fix that
exact thing. Repeat. Stop only when you run out of things a harsh reviewer would name, or
you hit a genuine technical limit (say which).

## Your final report (≤ 350 words, returned as your final message)

* What you built, file by file (one line each).
* Paths of your best 2–4 screenshots.
* Perf numbers from `--probe` if relevant.
* **Honest** list of remaining weaknesses, ranked.
* Contract change requests (don't edit CONTRACT.md yourself).
