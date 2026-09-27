# HarmoniSutra (VoiceMandala)

An audio-visual instrument that turns the acoustic physics of a human voice — pitch, loudness, and timbre — into generative mandala art, with a live telemetry HUD that explains the signal processing as it happens.

The experience runs in two phases: a **live visualizer** while you're speaking or an upload is playing, and a **final aggregate mandala** — built from the entire take — once you stop, paired with a single physics write-up of the whole recording rather than a running commentary that changes mid-sentence.

**Files:** `index.html` (structure) · `style.css` (design system) · `script.js` (audio engine + renderer). No build step, no dependencies — open `index.html` in any modern browser, or serve it over `https://` / `localhost` (required for microphone access).

---

## Portfolio summary

**Architectural design**
- Single-page app with a clean three-file separation: markup, a token-based CSS design system (custom properties for color/type/radius), and a self-contained JS module wrapped in an IIFE to avoid global scope leakage.
- One `AudioContext` graph feeds a shared `AnalyserNode` (`fftSize = 4096`) regardless of source — microphone (`getUserMedia` → `MediaStreamSource`) or an uploaded file (`<audio>` → `MediaElementSource`) — so the entire analysis and rendering pipeline downstream is source-agnostic.
- A single `requestAnimationFrame` loop each frame: pulls both time- and frequency-domain buffers once, derives five acoustic features, maps them to a "target" visual-parameter object, and exponentially smooths toward that target before drawing — separating *signal → feature → mapping → render* into distinct, testable stages.
- **Two-phase session model**, added to keep the live view calm and the explanation coherent:
  - *Live phase* — the mandala animates every frame as usual, and the HUD's numeric telemetry (pitch, RMS, centroid, rolloff, flatness) keeps updating in real time. The lesson card, however, is intentionally frozen on a static "listening" message here — it does not regenerate every frame, since a sentence that keeps rewriting itself while the sound is still changing is more distracting than educational.
  - *Final phase* — triggered by stopping the mic, an uploaded file finishing playback, or clicking "Reveal final mandala." The `rAF` loop is cancelled, the entire session's time series (logged throughout the live phase) is collapsed into one aggregate feature set, and a single static mandala plus a single physics explanation are generated from it — one artifact and one write-up per take, not one per frame.

**Signal processing implemented**
- Fundamental pitch via **autocorrelation** on the time-domain buffer, with a silence gate, leading/trailing-silence trim, and **parabolic interpolation** around the correlation peak for sub-sample precision.
- **RMS amplitude** for perceptual loudness.
- **Spectral centroid** (energy-weighted mean frequency → timbral brightness).
- **Spectral rolloff** (85%-energy cutoff frequency → harmonic vs. noisy content).
- **Spectral flatness** (geometric/arithmetic mean of the power spectrum → tonal-vs-noise-like classification), computed in the same single pass as centroid and rolloff for efficiency.
- Frequency → musical note/cents conversion using the standard MIDI-log formula.
- **Session-level aggregation**: every ~4th frame's raw features are logged into a time series while a take is active (throttled to bound memory on long recordings). On stop, this collapses into a loudness-weighted average fundamental, a 5th–95th-percentile pitch range, average/peak RMS, and average centroid/rolloff/flatness — run through the *same* feature-to-geometry mapping used live, so the final artwork obeys identical physics-to-shape rules, just applied to whole-take statistics instead of a single frame.

**Generative graphics**
- Pure polar-coordinate rendering: one parametric petal `r(θ) = baseR·(1 + curvature·sin(kθ))` is drawn once per frame and repeated `N` times via `ctx.rotate(2π/N)` — literally modeling the rotational symmetry of a Chladni standing-wave pattern, where `N` is driven by a log-mapped pitch value.
- Amplitude drives stroke weight and radial expansion; spectral centroid drives particle density, petal curvature, and the number of nested harmonic sub-rings.
- A translucent frame-clear (`rgba(...,0.22)`) produces a soft motion trail during the live phase instead of a hard wipe, cheaply, with no offscreen buffers.
- **Final-mandala composition**: the same petal geometry is redrawn once, statically, from the aggregate parameters, and wrapped in an outer **voiceprint ring** — the take's entire pitch contour plotted in polar form (elapsed time → angle, pitch → radius, closed into a loop), with loudness encoded as dot size/opacity along it. The ring makes the whole utterance's melodic shape visible at a glance around the averaged mandala at its center.

**Technical challenges solved**
- **Render-loop performance**: all per-frame math (autocorrelation, spectral pass, drawing) is kept allocation-light inside a single `rAF` tick, with typed arrays (`Float32Array`/`Uint8Array`) reused across frames instead of recreated.
- **FFT/pitch noise**: dual-rate exponential smoothing — a lighter smoothing constant for the HUD's numeric readouts (stays responsive) and a heavier one for the visual parameters that drive the canvas (stays organic, not jittery); pitch is allowed to decay gracefully rather than snap to zero on a single dropout frame.
- **Coherent narration over a changing signal**: rather than regenerating an explanatory sentence every frame (which reads as noisy and contradicts itself as the sound changes), the write-up is deferred to a single point-in-time synthesis over the whole take's aggregated statistics — a small state machine (`beginSession` → live phase → `finalizeSession`) governs the transition and what the HUD/lesson card are allowed to show at each stage.
- **Source-agnostic pipeline**: mic and file-upload paths converge on the same `AnalyserNode`, so every downstream feature/mapping/render function has exactly one code path to maintain.
- **Accessibility**: visible focus rings, `aria-pressed`/`aria-live` state on interactive controls, an `aria-live="assertive"` status region for permission, file-load, and final-mandala-ready events, `prefers-reduced-motion` handling, and native semantic controls (`<button>`, `<label for>`) throughout instead of div-based click targets.

**Stack:** HTML5 Canvas 2D · Web Audio API (`AudioContext`, `AnalyserNode`, `getUserMedia`, `MediaElementSource`) · vanilla ES6+ · CSS custom properties. No frameworks, no build tooling.

---

## How a session flows

1. **Start** — click "Listen with mic" or upload an audio file. The idle overlay clears, the mandala starts animating, and the HUD begins showing live pitch/note/amplitude/brightness/rolloff/flatness/duration.
2. **Speak / play** — the mandala keeps reshaping itself in real time from your voice's pitch, loudness and timbre. The lesson card stays on a fixed "listening" message throughout — it does not narrate every fluctuation.
3. **Stop** — happens automatically when the mic is stopped or the file finishes, or manually via "Reveal final mandala" (enabled once roughly 1.5s of audio has been captured).
4. **Final mandala** — the view freezes: a static mandala built from the whole take's aggregate pitch/loudness/timbre, wrapped in a voiceprint ring tracing the pitch contour over time. The HUD relabels to "Session summary" with whole-take stats, and the lesson card writes one explanation of the physics behind that specific artwork.
5. **Export or reset** — "Freeze & export" saves the current canvas as a PNG at any point; "New session" clears everything and returns to the idle state to start again.
