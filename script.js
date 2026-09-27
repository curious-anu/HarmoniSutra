'use strict';

/* ============================================================================
   HarmoniSutra — script.js
   ----------------------------------------------------------------------------
   ARCHITECTURE (see README.md for the full portfolio write-up)

   1. AUDIO GRAPH
      MediaStream (mic) or MediaElementSource (uploaded file)
        -> AnalyserNode (fftSize 4096)
        -> AudioContext.destination   (only for uploaded playback; the mic path
                                        is analysis-only, so we never route the
                                        live mic back to the speakers)

   2. FEATURE EXTRACTION (per animation frame, ~60fps)
      - Fundamental pitch      : autocorrelation of the time-domain buffer
      - RMS amplitude          : root-mean-square of the same buffer
      - Spectral centroid      : energy-weighted mean frequency ("brightness")
      - Spectral rolloff       : frequency under which 85% of energy sits
      - Spectral flatness      : geometric/arithmetic mean ratio of the
                                  power spectrum (tonal vs. noise-like)

   3. MAPPING LAYER
      Raw features are noisy frame-to-frame, so every feature is converted
      into a "target" visual parameter, then the parameter actually drawn is
      an exponentially-smoothed value that eases toward that target
      (visual = visual + (target - visual) * SMOOTHING). This is what keeps
      the mandala breathing instead of flickering.

   4. RENDER LOOP
      A single requestAnimationFrame loop reads the smoothed visual state
      and redraws the mandala using polar coordinates: for a petal function
      r(theta), one wedge is drawn once and then repeated N times by
      rotating the canvas context by 2*PI/N — this is literally the
      rotational symmetry of a physical standing wave (Chladni pattern).
   ============================================================================ */

(() => {
  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const canvas       = document.getElementById('mandalaCanvas');
  const ctx          = canvas.getContext('2d');
  const waveCanvas   = document.getElementById('waveCanvas');
  const waveCtx      = waveCanvas.getContext('2d');
  const specCanvas   = document.getElementById('specCanvas');
  const specCtx      = specCanvas.getContext('2d');

  const micBtn       = document.getElementById('micBtn');
  const fileInput    = document.getElementById('fileInput');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const finishBtn    = document.getElementById('finishBtn');
  const resetBtn     = document.getElementById('resetBtn');
  const uploadLabel  = document.querySelector('label[for="fileInput"]');
  const freezeBtn    = document.getElementById('freezeBtn');
  const hudToggle    = document.getElementById('hudToggle');
  const hud          = document.getElementById('hud');
  const hudTitle     = document.getElementById('hudTitle');
  const lessonKicker = document.getElementById('lessonKicker');
  const idleOverlay  = document.getElementById('idleOverlay');
  const flashEl      = document.getElementById('flash');
  const srStatus     = document.getElementById('srStatus');

  const out = {
    pitchHz:    document.getElementById('pitchHz'),
    noteName:   document.getElementById('noteName'),
    rms:        document.getElementById('rmsVal'),
    centroid:   document.getElementById('centroidVal'),
    rolloff:    document.getElementById('rolloffVal'),
    flatness:   document.getElementById('flatnessVal'),
    duration:   document.getElementById('durationVal'),
    classify:   document.getElementById('classification'),
    lesson:     document.getElementById('lessonBody'),
  };

  const LISTENING_MSG = 'Listening\u2026 keep speaking or let the audio play. Stop the mic (or let the file finish) to see the final mandala and its physics explanation \u2014 built from everything captured, not just this instant.';
  const IDLE_MSG = 'Make a sound to begin. HarmoniSutra reads your voice\u2019s fundamental frequency, loudness and timbre the whole time you\u2019re speaking, then \u2014 once you stop \u2014 combines all of it into one final mandala and explains the standing-wave math behind it.';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const FFT_SIZE = 4096;                 // frequency resolution vs. latency tradeoff
  const MIN_HZ = 60, MAX_HZ = 1000;      // plausible human-voice fundamental range
  const ROLLOFF_THRESHOLD = 0.85;        // 85% energy-contained rolloff, an audio-engineering convention
  const SMOOTH_VISUAL = 0.12;            // exponential smoothing factor for canvas params
  const SMOOTH_FEATURE = 0.35;           // lighter smoothing for HUD numeric readouts
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // ---------------------------------------------------------------------
  // Audio graph state
  // ---------------------------------------------------------------------
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let micSourceNode = null;
  let fileSourceNode = null;
  let audioEl = null;
  let timeBuf, freqBuf;         // Uint8Array views refreshed each frame
  let floatTimeBuf;             // Float32Array for autocorrelation precision
  let rafId = null;
  let running = false;
  let sourceKind = null;        // 'mic' | 'file'

  // Smoothed scalar features shown in the HUD (kept separate from the
  // heavier visual-parameter smoothing so numbers still feel responsive).
  const feat = { pitch: 0, rms: 0, centroid: 0, rolloff: 0, flatness: 0 };

  // Target vs. smoothed visual parameters that actually drive the drawing.
  // Targets are recomputed every frame from `feat`; the *S values chase them.
  const vis = {
    hue: 250, hueS: 250,
    symmetry: 6, symmetryS: 6,
    radius: 140, radiusS: 140,
    stroke: 2, strokeS: 2,
    subrings: 1, subringsS: 1,
    density: 3, densityS: 3,
    curvature: 0.35, curvatureS: 0.35,
  };
  let rotation = 0; // slow continuous drift so the mandala never fully freezes

  // A "take" is one listening/playback session: every ~4th frame's raw
  // (unsmoothed) features are logged here while active. When the person
  // stops, this whole time series is collapsed into one aggregate mandala
  // instead of the moment-to-moment one — see finalizeSession() below.
  const session = { active: false, startTime: 0, samples: [] };
  let frameCounter = 0;
  let finalized = false;
  const MIN_SAMPLES_FOR_FINAL = 12; // ~1.5s of throttled samples

  // ---------------------------------------------------------------------
  // Canvas sizing (device-pixel-ratio aware, resizes with viewport)
  // ---------------------------------------------------------------------
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // =======================================================================
  // AUDIO GRAPH LIFECYCLE
  // =======================================================================

  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.4; // native pre-smoothing of the FFT bins
      timeBuf = new Uint8Array(analyser.fftSize);
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      floatTimeBuf = new Float32Array(analyser.fftSize);
    }
    return audioCtx;
  }

  async function startMic() {
    try {
      ensureAudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
      });
      micSourceNode = audioCtx.createMediaStreamSource(micStream);
      micSourceNode.connect(analyser);
      // Deliberately NOT connected to destination — analysis only, no feedback loop.

      sourceKind = 'mic';
      beginSession();
      setRunning(true);
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.querySelector('.btn-label').textContent = 'Stop listening';
      finishBtn.hidden = false;
      out.lesson.textContent = LISTENING_MSG;
      announce('Microphone active. Listening for voice.');
    } catch (err) {
      announce('Microphone permission was not granted, or no microphone is available.');
      console.error('[HarmoniSutra] mic error:', err);
    }
  }

  function stopMic() {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (micSourceNode) micSourceNode.disconnect();
    micStream = null; micSourceNode = null;
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.querySelector('.btn-label').textContent = 'Listen with mic';
    if (sourceKind === 'mic') { sourceKind = null; finalizeSession(); }
  }

  async function loadFile(file) {
    ensureAudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    stopMic();
    if (fileSourceNode) fileSourceNode.disconnect();
    if (audioEl) { audioEl.pause(); audioEl.src = ''; }

    audioEl = new Audio();
    audioEl.src = URL.createObjectURL(file);
    audioEl.crossOrigin = 'anonymous';
    fileSourceNode = audioCtx.createMediaElementSource(audioEl);
    fileSourceNode.connect(analyser);
    analyser.connect(audioCtx.destination); // let the user actually hear the file

    audioEl.addEventListener('ended', () => finalizeSession());

    await audioEl.play();
    sourceKind = 'file';
    beginSession();
    playPauseBtn.hidden = false;
    playPauseBtn.querySelector('.btn-label').textContent = 'Pause';
    finishBtn.hidden = false;
    out.lesson.textContent = LISTENING_MSG;
    setRunning(true);
    announce(`Analyzing uploaded file: ${file.name}`);
  }

  function togglePlayPause() {
    if (!audioEl) return;
    if (audioEl.paused) {
      audioEl.play();
      playPauseBtn.querySelector('.btn-label').textContent = 'Pause';
      setRunning(true);
    } else {
      audioEl.pause();
      playPauseBtn.querySelector('.btn-label').textContent = 'Play';
    }
  }

  function setRunning(state) {
    running = state;
    idleOverlay.classList.toggle('hidden', state);
    freezeBtn.disabled = !state && !hasDrawnOnce;
    if (state && !rafId) rafId = requestAnimationFrame(loop);
  }

  // =======================================================================
  // SESSION LIFECYCLE
  // A "take" runs while the mic or an upload is active: the live visualizer
  // and telemetry update every frame as before. When it ends (mic stopped,
  // playback finished, or "Reveal final mandala" clicked), the entire time
  // series collected during the take is collapsed into one static mandala
  // plus one physics explanation of the whole thing — see computeAggregate().
  // =======================================================================

  function beginSession() {
    session.active = true;
    session.startTime = performance.now();
    session.samples = [];
    frameCounter = 0;
    finalized = false;
    finishBtn.disabled = true;
    resetBtn.hidden = true;
  }

  function finalizeSession() {
    session.active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    running = false;

    // Too little was captured to say anything meaningful — just go idle
    // rather than showing an empty/misleading "final" artwork.
    if (session.samples.length < MIN_SAMPLES_FOR_FINAL) {
      idleOverlay.classList.remove('hidden');
      finishBtn.hidden = true;
      out.lesson.textContent = IDLE_MSG;
      return;
    }

    finalized = true;
    const agg = computeAggregate();
    renderFinalMandala(agg);

    hudTitle.textContent = 'Session summary';
    lessonKicker.textContent = 'the physics of what you just said, as a whole';
    out.lesson.textContent = finalLessonText(agg);
    out.pitchHz.textContent = agg.dominantPitch > 0 ? agg.dominantPitch.toFixed(1) : '\u2014';
    out.noteName.textContent = agg.dominantPitch > 0 ? freqToNote(agg.dominantPitch).label : '\u2014';
    out.rms.textContent = `${agg.avgRms.toFixed(2)}/${agg.peakRms.toFixed(2)}`;
    out.centroid.textContent = agg.avgCentroid.toFixed(0);
    out.rolloff.textContent = agg.avgRolloff.toFixed(0);
    out.flatness.textContent = agg.avgFlatness.toFixed(2);
    out.duration.textContent = agg.duration.toFixed(1);
    out.classify.textContent = classify({ pitch: agg.dominantPitch, rms: agg.avgRms, flatness: agg.avgFlatness });

    hasDrawnOnce = true;
    freezeBtn.disabled = false;
    finishBtn.hidden = true;
    resetBtn.hidden = false;
    micBtn.hidden = true;
    uploadLabel.hidden = true;
    playPauseBtn.hidden = true;
    announce('Final mandala ready, combining the entire recording.');
  }

  /**
   * Collapses the whole session's time series into one set of aggregate
   * acoustic features, then runs them through the SAME mapFeaturesToTargets()
   * mapping used for the live view — so the final artwork's geometry is
   * governed by the identical physics-to-shape rules, just applied to
   * whole-session statistics instead of a single instantaneous frame.
   */
  function computeAggregate() {
    const samples = session.samples;
    const n = samples.length;
    let sumRms = 0, peakRms = 0, sumCentroid = 0, sumRolloff = 0, sumFlatness = 0;
    let weightedPitchSum = 0, pitchWeight = 0;

    samples.forEach((s) => {
      sumRms += s.rms;
      peakRms = Math.max(peakRms, s.rms);
      sumCentroid += s.centroid;
      sumRolloff += s.rolloff;
      sumFlatness += s.flatness;
      if (s.pitch > 0) { weightedPitchSum += s.pitch * s.rms; pitchWeight += s.rms; }
    });

    const avgRms = sumRms / n;
    const avgCentroid = sumCentroid / n;
    const avgRolloff = sumRolloff / n;
    const avgFlatness = sumFlatness / n;
    const dominantPitch = pitchWeight > 0 ? weightedPitchSum / pitchWeight : 0;

    const voicedPitches = samples.map(s => s.pitch).filter(p => p > 0).sort((a, b) => a - b);
    const minPitch = voicedPitches.length ? voicedPitches[Math.floor(voicedPitches.length * 0.05)] : 0;
    const maxPitch = voicedPitches.length ? voicedPitches[Math.ceil(voicedPitches.length * 0.95) - 1] : 0;
    const duration = (samples[n - 1].t - samples[0].t) / 1000;

    const targets = mapFeaturesToTargets({
      pitch: dominantPitch, rms: avgRms, centroid: avgCentroid,
    });

    return {
      ...targets, avgRms, peakRms, avgCentroid, avgRolloff, avgFlatness,
      dominantPitch, minPitch, maxPitch, duration, voicedCount: voicedPitches.length, totalCount: n,
    };
  }

  /**
   * The final artwork layers two things:
   *  1. An outer "voiceprint" ring — the entire pitch contour of the take,
   *     drawn as a closed polar curve (time -> angle, pitch -> radius), so
   *     the whole utterance's melodic shape is visible at a glance.
   *  2. An inner symmetric mandala built from the aggregate features,
   *     exactly like the live one but drawn once, statically, as the
   *     single "average standing wave" of the whole recording.
   */
  function renderFinalMandala(agg) {
    const w = innerWidth, h = innerHeight;
    ctx.fillStyle = '#0B0E1A';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const samples = session.samples;

    if (samples.length > 1 && agg.maxPitch > 0) {
      const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
      const dur = Math.max(1, t1 - t0);
      const span = Math.max(1, agg.maxPitch - agg.minPitch);
      const ringBase = agg.radius + 80;
      const ringSpan = 60;

      ctx.beginPath();
      samples.forEach((s, i) => {
        const angle = ((s.t - t0) / dur) * Math.PI * 2 - Math.PI / 2;
        const pNorm = s.pitch > 0 ? clamp((s.pitch - agg.minPitch) / span, 0, 1) : 0.5;
        const r = ringBase + pNorm * ringSpan;
        const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = `hsla(${agg.hue}, 65%, 70%, 0.55)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      samples.forEach((s, i) => {
        if (i % 2 !== 0) return;
        const angle = ((s.t - t0) / dur) * Math.PI * 2 - Math.PI / 2;
        const pNorm = s.pitch > 0 ? clamp((s.pitch - agg.minPitch) / span, 0, 1) : 0.5;
        const r = ringBase + pNorm * ringSpan;
        const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
        ctx.beginPath();
        ctx.arc(x, y, 1 + clamp(s.rms, 0, 0.4) * 6, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${(agg.hue + 40) % 360}, 80%, 70%, ${0.3 + clamp(s.rms, 0, 0.4)})`;
        ctx.fill();
      });
    }

    ctx.save();
    ctx.translate(cx, cy);
    const N = Math.max(3, Math.round(agg.symmetry));
    const step = (Math.PI * 2) / N;
    const rings = Math.max(1, Math.round(agg.subrings));
    for (let ring = 0; ring < rings; ring++) {
      const ringScale = 1 - ring * 0.16;
      const hue = (agg.hue + ring * 14) % 360;
      for (let i = 0; i < N; i++) {
        ctx.save();
        ctx.rotate(step * i);
        drawPetal(agg.radius * ringScale, agg.stroke, hue, agg.curvature, agg.density);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function finalLessonText(agg) {
    if (agg.voicedCount === 0) {
      return `Across the whole recording HarmoniSutra never locked onto a stable fundamental \u2014 average spectral flatness was ${agg.avgFlatness.toFixed(2)} (1.0 is pure noise), so what it heard was closer to breath and fricatives than a sustained tone. The outer ring still traces how loud each moment was, and the inner petals fall back to a default symmetry.`;
    }

    const hz = agg.dominantPitch.toFixed(0);
    const note = freqToNote(agg.dominantPitch).label;
    const n = Math.round(agg.symmetry);
    const rangeText = (agg.maxPitch > agg.minPitch * 1.05)
      ? ` Pitch ranged from about ${agg.minPitch.toFixed(0)}Hz to ${agg.maxPitch.toFixed(0)}Hz over the take \u2014 that melodic shape is what the outer ring traces, mapping time to angle and pitch to radius all the way around.`
      : ' Pitch stayed close to that value the whole time, which is why the outer ring sits close to a perfect circle rather than wandering in and out.';
    const centroidDesc = agg.avgCentroid > 2500 ? 'bright and high-frequency-heavy'
      : agg.avgCentroid > 1200 ? 'moderately bright' : 'warm and low-frequency-heavy';

    return `This mandala is built from the entire take, not one instant. The loudness-weighted average fundamental was ${hz}Hz (${note}), so the ${n}-fold rotational symmetry of the inner petals is the standing-wave pattern that pitch would settle into on a vibrating surface, the way frequency dictates node count on a Chladni plate.${rangeText} The average spectral centroid of ${agg.avgCentroid.toFixed(0)}Hz made the overall timbre ${centroidDesc}, which set ${Math.round(agg.subrings)} nested harmonic ring(s) and a petal curvature of ${agg.curvature.toFixed(2)}. Loudness peaked at ${agg.peakRms.toFixed(2)} RMS against a ${agg.avgRms.toFixed(2)} average across ${agg.duration.toFixed(1)}s, which set the petals\u2019 size and stroke weight. In short: one frozen standing wave, compressed from everything you just said.`;
  }

  // =======================================================================
  // FEATURE EXTRACTION
  // =======================================================================

  /**
   * Autocorrelation-based pitch (fundamental frequency) detector.
   * Works directly on the time-domain signal: a periodic waveform correlates
   * strongly with a delayed copy of itself at a lag equal to its period, so
   * we scan candidate lags across the human-voice range, take the strongest
   * normalized correlation peak, and refine it with parabolic interpolation
   * for sub-sample precision. Returns -1 when the signal is too quiet/noisy
   * to trust (silence, breath noise, unvoiced fricatives).
   */
  function autoCorrelatePitch(buf, sampleRate) {
    const n = buf.length;

    // Silence / noise floor gate via RMS
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.01) return -1;

    // Trim leading/trailing near-silence to tighten the correlation window
    let start = 0, end = n - 1;
    const trimThresh = rms * 0.2;
    while (start < n && Math.abs(buf[start]) < trimThresh) start++;
    while (end > start && Math.abs(buf[end]) < trimThresh) end--;
    const trimmed = buf.slice(start, end + 1);
    const m = trimmed.length;
    if (m < 512) return -1;

    const minLag = Math.floor(sampleRate / MAX_HZ);
    const maxLag = Math.min(Math.floor(sampleRate / MIN_HZ), m - 1);

    let bestLag = -1;
    let bestCorr = 0;
    const corr = new Float32Array(maxLag + 1);

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < m - lag; i++) sum += trimmed[i] * trimmed[i + lag];
      corr[lag] = sum;
      if (sum > bestCorr) { bestCorr = sum; bestLag = lag; }
    }
    if (bestLag <= minLag) return -1;

    // Parabolic interpolation around the peak for sub-bin accuracy
    const c0 = corr[bestLag - 1] || 0, c1 = corr[bestLag], c2 = corr[bestLag + 1] || 0;
    const denom = (c0 - 2 * c1 + c2);
    const shift = denom !== 0 ? 0.5 * (c0 - c2) / denom : 0;
    const refinedLag = bestLag + shift;

    const freq = sampleRate / refinedLag;
    return (freq >= MIN_HZ && freq <= MAX_HZ) ? freq : -1;
  }

  function computeRMS(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /**
   * Spectral centroid, rolloff and flatness — all derived from the same
   * magnitude spectrum in a single pass for efficiency.
   *  - Centroid: energy-weighted average frequency ("brightness" / timbre).
   *  - Rolloff:  frequency below which ROLLOFF_THRESHOLD of total energy sits
   *              (high rolloff ~ hiss/fricatives, low rolloff ~ pure hums).
   *  - Flatness: geometric-mean / arithmetic-mean of the power spectrum.
   *              Near 1 = white-noise-like (flat spectrum); near 0 = tonal
   *              (energy concentrated in a few harmonic peaks).
   */
  function computeSpectralFeatures(mag, sampleRate, fftSize) {
    const n = mag.length;
    const binHz = sampleRate / fftSize;

    let weightedSum = 0, totalMag = 0, totalPower = 0, logSum = 0;
    const power = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const m = mag[i] / 255; // Uint8Array -> [0,1]
      const p = m * m + 1e-12;
      power[i] = p;
      const f = i * binHz;
      weightedSum += f * m;
      totalMag += m;
      totalPower += p;
      logSum += Math.log(p);
    }

    const centroid = totalMag > 0 ? weightedSum / totalMag : 0;

    let cumulative = 0, rolloff = 0;
    const target = ROLLOFF_THRESHOLD * totalPower;
    for (let i = 0; i < n; i++) {
      cumulative += power[i];
      if (cumulative >= target) { rolloff = i * binHz; break; }
    }

    const geoMean = Math.exp(logSum / n);
    const arithMean = totalPower / n;
    const flatness = arithMean > 0 ? geoMean / arithMean : 0;

    return { centroid, rolloff, flatness: Math.min(1, Math.max(0, flatness)) };
  }

  function freqToNote(freq) {
    if (freq <= 0) return { label: '—' };
    const midi = 69 + 12 * Math.log2(freq / 440);
    const rounded = Math.round(midi);
    const cents = Math.round((midi - rounded) * 100);
    const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
    const octave = Math.floor(rounded / 12) - 1;
    const sign = cents >= 0 ? '+' : '';
    return { label: `${name}${octave} (${sign}${cents}c)` };
  }

  function classify(f) {
    if (f.rms < 0.015) return 'Silence';
    if (f.pitch <= 0 && f.flatness > 0.35) return 'Bright vocal fricative (unvoiced, noise-like)';
    if (f.pitch > 0 && f.flatness < 0.08 && f.rms > 0.08) return 'Pure sustained tone';
    if (f.pitch > 0 && f.pitch < 165) return 'Resonant bass / chest voice';
    if (f.pitch >= 165 && f.pitch < 330) return 'Mid vocal register';
    if (f.pitch >= 330) return 'Bright, high vocal register';
    return 'Mixed / breathy tone';
  }

  // =======================================================================
  // MAPPING: acoustic features -> generative-art parameters
  // =======================================================================

  function mapFeaturesToTargets(f) {
    // Pitch -> symmetry axes. Log-mapped across the voice range so both a
    // low hum and a high note produce a musically-sensible spread (4..16).
    let symmetryTarget = 6;
    if (f.pitch > 0) {
      const t = Math.log2(clamp(f.pitch, MIN_HZ, MAX_HZ) / MIN_HZ) / Math.log2(MAX_HZ / MIN_HZ);
      symmetryTarget = Math.round(4 + t * 12); // 4 (low bass) .. 16 (high pitch)
    }

    // Pitch -> base hue around the color wheel (low = warm red/gold, high = cool violet/blue)
    const hueTarget = f.pitch > 0
      ? 10 + (Math.log2(clamp(f.pitch, MIN_HZ, MAX_HZ) / MIN_HZ) / Math.log2(MAX_HZ / MIN_HZ)) * 260
      : vis.hueS;

    // Amplitude -> stroke weight + overall radius (louder = bolder, larger)
    const radiusTarget = 90 + clamp(f.rms, 0, 0.5) * 2 * 220;
    const strokeTarget = 1.2 + clamp(f.rms, 0, 0.5) * 2 * 5;

    // Brightness (centroid) -> particle density / nested sub-rings / curvature
    const centroidNorm = clamp(f.centroid / 4000, 0, 1);
    const densityTarget = 2 + centroidNorm * 10;
    const subringsTarget = 1 + Math.round(centroidNorm * 4);
    const curvatureTarget = 0.15 + centroidNorm * 0.8;

    return {
      symmetry: symmetryTarget, hue: hueTarget, radius: radiusTarget,
      stroke: strokeTarget, density: densityTarget,
      subrings: subringsTarget, curvature: curvatureTarget,
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // =======================================================================
  // RENDERING
  // =======================================================================
  let hasDrawnOnce = false;

  function drawMandala() {
    const w = innerWidth, h = innerHeight;
    ctx.fillStyle = 'rgba(11, 14, 26, 0.22)'; // low-alpha clear = soft motion trail
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    rotation += 0.0015 + vis.strokeS * 0.0004; // louder voice -> slightly faster drift

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    const N = Math.max(3, Math.round(vis.symmetryS));
    const step = (Math.PI * 2) / N;
    const rings = Math.max(1, Math.round(vis.subringsS));

    for (let ring = 0; ring < rings; ring++) {
      const ringScale = 1 - ring * 0.16;
      const hue = (vis.hueS + ring * 14) % 360;

      for (let i = 0; i < N; i++) {
        ctx.save();
        ctx.rotate(step * i);
        drawPetal(vis.radiusS * ringScale, vis.strokeS, hue, vis.curvatureS, vis.densityS);
        ctx.restore();
      }
    }
    ctx.restore();
    hasDrawnOnce = true;
  }

  /**
   * One symmetric "wedge" of the mandala, expressed as a parametric polar
   * curve r(theta) = baseR * (1 + curvature * sin(k*theta)). Rotating and
   * repeating this wedge N times (see drawMandala) is what produces the
   * N-fold rotational symmetry mapped from pitch.
   */
  function drawPetal(baseR, strokeW, hue, curvature, density) {
    const points = Math.max(12, Math.round(12 + density * 4));
    const k = 3; // harmonic count inside a single petal, gives it a leaf-like waist
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const theta = (i / points) * (Math.PI / 6); // wedge spans a slice of the circle
      const r = baseR * (0.35 + curvature * Math.abs(Math.sin(k * theta * 3)));
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `hsla(${hue}, 70%, 68%, 0.85)`;
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Particle accents along the petal tip density, echoing timbral "grain"
    const particles = Math.round(density);
    for (let p = 0; p < particles; p++) {
      const theta = (p / Math.max(1, particles - 1)) * (Math.PI / 6);
      const r = baseR * (0.35 + curvature * Math.abs(Math.sin(3 * theta * 3))) * (0.7 + 0.3 * Math.sin(p));
      ctx.beginPath();
      ctx.arc(r * Math.cos(theta), r * Math.sin(theta), Math.max(0.6, strokeW * 0.3), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue + 30}, 80%, 75%, 0.5)`;
      ctx.fill();
    }
  }

  function drawScopes(time, freq) {
    // Waveform
    waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
    waveCtx.beginPath();
    const wStep = waveCanvas.width / time.length;
    for (let i = 0; i < time.length; i++) {
      const v = time[i] / 128 - 1;
      const y = waveCanvas.height / 2 + v * (waveCanvas.height / 2 - 2);
      i === 0 ? waveCtx.moveTo(0, y) : waveCtx.lineTo(i * wStep, y);
    }
    waveCtx.strokeStyle = '#4FA3A0';
    waveCtx.lineWidth = 1.5;
    waveCtx.stroke();

    // Spectrum (log-ish bar view of the first ~1/3 of bins, where voice energy lives)
    specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);
    const bins = Math.floor(freq.length / 3);
    const bStep = specCanvas.width / bins;
    for (let i = 0; i < bins; i++) {
      const v = freq[i] / 255;
      const barH = v * specCanvas.height;
      specCtx.fillStyle = `hsla(${40 + v * 260}, 75%, 60%, 0.9)`;
      specCtx.fillRect(i * bStep, specCanvas.height - barH, Math.max(1, bStep - 1), barH);
    }
  }

  // =======================================================================
  // MAIN LOOP
  // =======================================================================
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!analyser) return;

    analyser.getByteTimeDomainData(timeBuf);
    analyser.getByteFrequencyData(freqBuf);
    analyser.getFloatTimeDomainData(floatTimeBuf);

    const sr = audioCtx.sampleRate;

    const pitchRaw = autoCorrelatePitch(floatTimeBuf, sr);
    const rmsRaw = computeRMS(floatTimeBuf);
    const spectral = computeSpectralFeatures(freqBuf, sr, analyser.fftSize);

    // Smooth the numeric features shown in the HUD (lighter smoothing so
    // the readout still feels live) — pitch is allowed to hold its last
    // good value briefly rather than snapping to 0 on a single dropout.
    feat.pitch = pitchRaw > 0 ? lerp(feat.pitch, pitchRaw, SMOOTH_FEATURE) : feat.pitch * 0.9;
    feat.rms = lerp(feat.rms, rmsRaw, SMOOTH_FEATURE);
    feat.centroid = lerp(feat.centroid, spectral.centroid, SMOOTH_FEATURE);
    feat.rolloff = lerp(feat.rolloff, spectral.rolloff, SMOOTH_FEATURE);
    feat.flatness = lerp(feat.flatness, spectral.flatness, SMOOTH_FEATURE);

    const targets = mapFeaturesToTargets(feat);
    vis.symmetryS = lerp(vis.symmetryS, targets.symmetry, SMOOTH_VISUAL);
    vis.hueS      = lerp(vis.hueS, targets.hue, SMOOTH_VISUAL);
    vis.radiusS   = lerp(vis.radiusS, targets.radius, SMOOTH_VISUAL);
    vis.strokeS   = lerp(vis.strokeS, targets.stroke, SMOOTH_VISUAL);
    vis.densityS  = lerp(vis.densityS, targets.density, SMOOTH_VISUAL);
    vis.subringsS = lerp(vis.subringsS, targets.subrings, SMOOTH_VISUAL);
    vis.curvatureS= lerp(vis.curvatureS, targets.curvature, SMOOTH_VISUAL);

    drawMandala();
    drawScopes(timeBuf, freqBuf);
    updateHUD(feat);

    // Log a throttled, unsmoothed sample of this frame into the session's
    // time series (~every 4th frame is plenty for the final contour ring,
    // and keeps memory/computation bounded on long takes).
    if (session.active) {
      frameCounter++;
      if (frameCounter % 4 === 0) {
        session.samples.push({
          t: performance.now() - session.startTime,
          pitch: pitchRaw > 0 ? pitchRaw : 0,
          rms: rmsRaw,
          centroid: spectral.centroid,
          rolloff: spectral.rolloff,
          flatness: spectral.flatness,
        });
      }
      out.duration.textContent = ((performance.now() - session.startTime) / 1000).toFixed(1);
      if (session.samples.length >= MIN_SAMPLES_FOR_FINAL) finishBtn.disabled = false;
    }
  }

  // While a take is live, the HUD numbers and the waveform/spectrum scopes
  // keep updating every frame (that telemetry is meant to feel live). The
  // lesson paragraph deliberately does NOT rewrite here — it stays on the
  // static "Listening..." message set in beginSession() until the take
  // ends, so the explanation doesn't rewrite itself mid-sentence while the
  // sound is still changing. See finalizeSession() for the one-time,
  // whole-take explanation that replaces it.
  function updateHUD(f) {
    out.pitchHz.textContent = f.pitch > 0 ? f.pitch.toFixed(1) : '\u2014';
    out.noteName.textContent = f.pitch > 0 ? freqToNote(f.pitch).label : '\u2014';
    out.rms.textContent = f.rms.toFixed(3);
    out.centroid.textContent = f.centroid.toFixed(0);
    out.rolloff.textContent = f.rolloff.toFixed(0);
    out.flatness.textContent = f.flatness.toFixed(2);
    out.classify.textContent = classify(f);
  }

  // =======================================================================
  // FREEZE & EXPORT
  // =======================================================================
  function exportPNG() {
    flashEl.classList.remove('fire'); void flashEl.offsetWidth; flashEl.classList.add('fire');
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `harmonisutra-mandala-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }

  // =======================================================================
  // MISC UI
  // =======================================================================
  function announce(msg) { srStatus.textContent = msg; }

  micBtn.addEventListener('click', () => {
    if (micBtn.getAttribute('aria-pressed') === 'true') stopMic();
    else startMic();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadFile(file);
  });

  playPauseBtn.addEventListener('click', togglePlayPause);
  freezeBtn.addEventListener('click', exportPNG);

  finishBtn.addEventListener('click', () => {
    if (sourceKind === 'mic') stopMic(); // routes into finalizeSession()
    else if (sourceKind === 'file') { if (audioEl) audioEl.pause(); finalizeSession(); }
  });

  resetBtn.addEventListener('click', () => {
    finalized = false;
    session.samples = [];
    hasDrawnOnce = false;
    ctx.fillStyle = '#0B0E1A';
    ctx.fillRect(0, 0, innerWidth, innerHeight);

    idleOverlay.classList.remove('hidden');
    hudTitle.textContent = 'Live telemetry';
    lessonKicker.textContent = 'what your voice is doing, in physics';
    out.lesson.textContent = IDLE_MSG;
    [out.pitchHz, out.noteName, out.rms, out.centroid, out.rolloff, out.flatness, out.duration]
      .forEach(el => { el.textContent = '\u2014'; });
    out.classify.textContent = 'Awaiting sound\u2026';

    finishBtn.hidden = true; finishBtn.disabled = true;
    resetBtn.hidden = true;
    micBtn.hidden = false; uploadLabel.hidden = false; playPauseBtn.hidden = true;
    freezeBtn.disabled = true;
  });

  hudToggle.addEventListener('click', () => {
    const pressed = hudToggle.getAttribute('aria-pressed') === 'true';
    hudToggle.setAttribute('aria-pressed', String(!pressed));
    hud.classList.toggle('hidden', pressed);
  });

  // Enable export as soon as anything has been drawn at least once.
  const enableFreezeObserver = setInterval(() => {
    if (hasDrawnOnce) { freezeBtn.disabled = false; clearInterval(enableFreezeObserver); }
  }, 500);
})();
