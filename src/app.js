// BlinkCode AI shell: wires the UI to the workers. All heavy lifting
// (compression, rendering payloads, optical decoding) happens off-thread.

import { WorkerClient } from './workers/worker-rpc.js';
import { CanvasSurface } from './lib/surface.js';
import { drawSpectraCode, specByName } from './lib/spectracode.js';
import { chunkSize, parseFrame, FrameCollector } from './lib/stream.js';
import { MODE } from './lib/format.js';

const $ = (id) => document.getElementById(id);
const workers = {
  model: new WorkerClient(new URL('./workers/model-loader.js', import.meta.url)),
  compress: new WorkerClient(new URL('./workers/compression-worker.js', import.meta.url)),
  decompress: new WorkerClient(new URL('./workers/decompression-worker.js', import.meta.url)),
  optical: new WorkerClient(new URL('./workers/spectracode-decoder-worker.js', import.meta.url)),
};

const state = {
  file: null,
  frames: null, // Uint8Array[] of palette symbols, one per SpectraCode frame
  spec: specByName('standard'),
  container: null,
  stream: null,
  scanning: false,
  wakeLock: null,
  playTimer: null,
  playIndex: 0,
  collector: new FrameCollector(),
  resultUrl: null,
  resultBlob: null,
};

const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;

function setStatus(el, message, tone = '') {
  el.textContent = message;
  el.dataset.tone = tone;
}

// ---------------------------------------------------------------- model boot

async function bootModel() {
  const chip = $('model-chip');
  const progress = $('model-progress');
  try {
    const status = await workers.model.call('status');
    if (!status.cached) {
      progress.hidden = false;
      $('model-bar').style.width = '15%';
    }
    const info = await workers.model.call('ensure');
    $('model-bar').style.width = '100%';
    progress.hidden = true;
    chip.dataset.state = 'ready';
    chip.textContent = `model v${info.version} · ${fmtBytes(info.bytes)} · offline ready`;
    $('compress-btn').disabled = !state.file;
  } catch (err) {
    chip.dataset.state = 'error';
    chip.textContent = 'model unavailable';
    setStatus($('send-status'), `Model load failed: ${err.message}`, 'err');
  }
}

// --------------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`);
    });
  });
}

// --------------------------------------------------------------- sender flow

const dropzone = $('dropzone');
const fileInput = $('file-input');

const selectedDensity = () => specByName($('density-select').value);
const framesPerSecond = () => Number($('fps-input').value);

function selectFile(file) {
  state.file = file;
  state.frames = null;
  $('show-btn').disabled = true;
  $('selftest-btn').disabled = true;
  $('send-stats').hidden = true;
  $('preview-canvas').hidden = true;
  $('compress-btn').disabled = $('model-chip').dataset.state !== 'ready';
  dropzone.querySelector('strong').textContent = file.name;
  setStatus($('send-status'), `${fmtBytes(file.size)} selected · ${file.type || 'unknown type'}`);
}

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) selectFile(fileInput.files[0]);
});

['dragover', 'dragleave', 'drop'].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.toggle('hover', type === 'dragover');
    if (type === 'drop' && event.dataTransfer.files[0]) selectFile(event.dataTransfer.files[0]);
  });
});

$('paste-btn').addEventListener('click', async () => {
  try {
    $('text-input').value = await navigator.clipboard.readText();
  } catch (err) {
    setStatus($('send-status'), `Clipboard unavailable: ${err.message} — paste manually.`, 'err');
  }
});

$('use-text-btn').addEventListener('click', () => {
  const text = $('text-input').value;
  if (!text.trim()) return;
  const name = /^https?:\/\//i.test(text.trim()) ? 'link.txt' : 'note.txt';
  selectFile(new File([text], name, { type: 'text/plain' }));
  document.querySelector('input[name="mode"][value="0"]').checked = true;
});

$('fps-input').addEventListener('input', () => {
  $('fps-label').textContent = `${framesPerSecond()} / s`;
  if (state.playTimer) startPlayback();
});

$('density-select').addEventListener('change', () => {
  const spec = selectedDensity();
  $('dropzone-hint').textContent =
    `or drop it here — ${chunkSize(spec).toLocaleString()} B of File DNA per frame, longer files stream`;
});

const selectedMode = () => Number(document.querySelector('input[name="mode"]:checked').value);

$('compress-btn').addEventListener('click', async () => {
  if (!state.file) return;
  const mode = selectedMode();
  const spec = selectedDensity();
  setStatus($('send-status'), 'Compressing…');
  try {
    const payload = { name: state.file.name, mode, density: spec.name };
    const transfer = [];
    if (mode === MODE.PERCEPTUAL_IMAGE) {
      if (!state.file.type.startsWith('image/')) {
        throw new Error('perceptual mode needs an image file');
      }
      payload.bitmap = await createImageBitmap(state.file);
      transfer.push(payload.bitmap);
    } else {
      payload.bytes = await state.file.arrayBuffer();
      transfer.push(payload.bytes);
    }

    const { symbolFrames, container, stats } = await workers.compress.call('compress', payload, {
      transfer,
    });
    state.frames = symbolFrames;
    state.container = container;
    state.spec = spec;
    state.playIndex = 0;

    const ratio = stats.originalBytes / stats.containerBytes;
    const seconds = stats.frames / framesPerSecond();
    $('send-stats').hidden = false;
    $('send-stats').innerHTML = `
      <dt>Original</dt><dd>${fmtBytes(stats.originalBytes)}</dd>
      <dt>File DNA</dt><dd>${fmtBytes(stats.containerBytes)}</dd>
      <dt>Ratio</dt><dd>${ratio.toFixed(ratio > 10 ? 0 : 2)} : 1</dd>
      <dt>Frames</dt><dd>${stats.frames} × ${spec.cols}×${spec.rows} · one loop ≈ ${seconds.toFixed(1)} s</dd>
      <dt>Time</dt><dd>${stats.elapsedMs} ms</dd>`;
    setStatus(
      $('send-status'),
      stats.frames === 1 ? 'Ready to display.' : `Ready — ${stats.frames} frames will loop on screen.`,
      'ok',
    );
    $('show-btn').disabled = false;
    $('selftest-btn').disabled = false;
    renderPreview();
  } catch (err) {
    setStatus($('send-status'), err.message, 'err');
  }
});

function renderTo(canvas, size, symbols) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawSpectraCode(new CanvasSurface(ctx), symbols, size, state.spec);
  return ctx;
}

function renderPreview() {
  const canvas = $('preview-canvas');
  canvas.hidden = false;
  renderTo(canvas, 840, state.frames[0]);
  canvas.style.width = 'min(100%, 420px)';
}

/** Loop the frames on screen; a single-frame transfer just stays put. */
function startPlayback() {
  clearInterval(state.playTimer);
  const side = Math.min(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1);
  const size = Math.round(side);
  const paint = () => {
    renderTo($('spectra-canvas'), size, state.frames[state.playIndex]);
    $('frame-counter').textContent =
      state.frames.length > 1 ? `frame ${state.playIndex + 1} / ${state.frames.length}` : '';
    state.playIndex = (state.playIndex + 1) % state.frames.length;
  };
  paint();
  if (state.frames.length > 1) {
    state.playTimer = setInterval(paint, Math.round(1000 / framesPerSecond()));
  }
}

async function keepAwake(on) {
  try {
    if (on) state.wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    else {
      await state.wakeLock?.release();
      state.wakeLock = null;
    }
  } catch {
    state.wakeLock = null; // best effort: unsupported or denied
  }
}

$('show-btn').addEventListener('click', () => {
  $('fullscreen').hidden = false;
  state.playIndex = 0;
  startPlayback();
  keepAwake(true);
  document.documentElement.requestFullscreen?.().catch(() => {});
});

$('close-fullscreen').addEventListener('click', () => {
  $('fullscreen').hidden = true;
  clearInterval(state.playTimer);
  state.playTimer = null;
  keepAwake(false);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});

// A second device is not always around: render every frame offscreen and push
// it straight through the optical decoder to prove the whole chain works.
$('selftest-btn').addEventListener('click', async () => {
  setStatus($('send-status'), 'Running loopback self-test…');
  const started = performance.now();
  try {
    const size = state.spec.cols > 60 ? 1400 : 900;
    const collector = new FrameCollector();
    for (const symbols of state.frames) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      drawSpectraCode(new CanvasSurface(ctx), symbols, size, state.spec);
      const image = ctx.getImageData(0, 0, size, size);
      collector.add(parseFrame(await decodeFrame(image)));
    }
    const file = await restore(collector.assemble());
    setStatus(
      $('send-status'),
      `Self-test passed: ${state.frames.length} frame(s) → ${file.name} (${fmtBytes(file.bytes.length)})` +
        ` in ${Math.round(performance.now() - started)} ms`,
      'ok',
    );
  } catch (err) {
    setStatus($('send-status'), `Self-test failed: ${err.message}`, 'err');
  }
});

// ------------------------------------------------------------- receiver flow

let lastOptical = null;

/** Optical decode of one captured image into raw frame bytes. */
async function decodeFrame(image) {
  const optical = await workers.optical.call(
    'decode',
    { data: image.data.buffer, width: image.width, height: image.height },
    { transfer: [image.data.buffer] },
  );
  lastOptical = optical;
  return optical.payload;
}

async function restore(container) {
  return workers.decompress.call(
    'decompress',
    { container: container.buffer },
    { transfer: [container.buffer] },
  );
}

function updateScanProgress() {
  const { collector } = state;
  const wrap = $('scan-progress');
  if (collector.count === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const pct = Math.round((collector.received / collector.count) * 100);
  $('scan-bar').style.width = `${pct}%`;
  $('scan-label').textContent =
    collector.count === 1
      ? 'Frame captured'
      : `${collector.received} / ${collector.count} frames — keep the code in view`;
}

/**
 * Feed one captured image to the collector.
 * @returns {Promise<boolean>} true when the transfer completed
 */
async function ingest(image) {
  const frame = parseFrame(await decodeFrame(image));
  const { fresh, restarted } = state.collector.add(frame);
  if (restarted) setStatus($('receive-status'), 'New transfer detected — collecting frames…');
  updateScanProgress();
  if (!state.collector.complete) {
    if (fresh) setStatus($('receive-status'), `Collected frame ${frame.index + 1} of ${frame.count}`);
    return false;
  }
  const container = state.collector.assemble();
  const started = performance.now();
  const file = await restore(container);
  state.collector.reset();
  updateScanProgress();
  showResult({ ...file, optical: lastOptical, totalMs: Math.round(performance.now() - started) });
  return true;
}

function showResult(result) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  const blob = new Blob([result.bytes], { type: result.type });
  const url = URL.createObjectURL(blob);
  state.resultUrl = url;
  state.resultBlob = blob;
  $('receive-result').hidden = false;
  $('result-name').textContent = result.name;
  $('result-meta').textContent =
    `${fmtBytes(result.bytes.length)} · ${result.mode === MODE.PERCEPTUAL_IMAGE ? 'perceptual' : 'lossless'}` +
    ` · ${result.optical.density} density · ${result.optical.corrected} byte(s) repaired by Reed-Solomon` +
    ` · ${result.totalMs} ms`;

  const img = $('result-image');
  const text = $('result-text');
  img.hidden = true;
  text.hidden = true;
  $('copy-btn').hidden = true;
  if (result.type.startsWith('image/')) {
    img.src = url;
    img.hidden = false;
  } else if (result.bytes.length < 16384) {
    const decoded = new TextDecoder().decode(result.bytes);
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(decoded)) {
      text.textContent = decoded;
      text.hidden = false;
      $('copy-btn').hidden = false;
      $('copy-btn').onclick = () => navigator.clipboard?.writeText(decoded).catch(() => {});
    }
  }

  const link = $('result-download');
  link.href = url;
  link.download = result.name;

  const share = $('share-btn');
  const file = new File([blob], result.name, { type: result.type });
  share.hidden = !navigator.canShare?.({ files: [file] });
  share.onclick = () => navigator.share({ files: [file], title: result.name }).catch(() => {});
  setStatus($('receive-status'), `File received in ${result.totalMs} ms`, 'ok');
}

function frameToImageData(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** Continuously pull frames off the camera until the transfer completes. */
async function scanLoop() {
  const video = $('camera');
  let misses = 0;
  while (state.scanning) {
    if (!video.videoWidth) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      const image = frameToImageData(video, video.videoWidth, video.videoHeight);
      const done = await ingest(image);
      misses = 0;
      if (done) {
        stopCamera();
        return;
      }
    } catch (err) {
      misses++;
      if (misses % 8 === 0) {
        $('camera-hint').textContent = `Searching… (${err.message})`;
      }
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

function stopCamera() {
  state.scanning = false;
  const video = $('camera');
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
  $('camera-btn').textContent = 'Start scanning';
  $('capture-btn').disabled = true;
  $('camera-hint').textContent = 'Camera off';
}

$('camera-btn').addEventListener('click', async () => {
  if (state.stream) {
    stopCamera();
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 } },
    });
    const video = $('camera');
    video.srcObject = state.stream;
    await video.play();
    $('camera-btn').textContent = 'Stop scanning';
    $('capture-btn').disabled = false;
    $('camera-hint').textContent = 'Fill the frame with the code — scanning continuously';
    state.scanning = true;
    state.collector.reset();
    updateScanProgress();
    scanLoop();
  } catch (err) {
    setStatus($('receive-status'), `Camera unavailable: ${err.message}`, 'err');
  }
});

$('capture-btn').addEventListener('click', async () => {
  const video = $('camera');
  setStatus($('receive-status'), 'Decoding…');
  try {
    await ingest(frameToImageData(video, video.videoWidth, video.videoHeight));
  } catch (err) {
    setStatus($('receive-status'), `${err.message} — hold steady, avoid glare, then retry.`, 'err');
  }
});

$('photo-input').addEventListener('change', async () => {
  const file = $('photo-input').files[0];
  if (!file) return;
  setStatus($('receive-status'), 'Decoding photo…');
  try {
    const bitmap = await createImageBitmap(file);
    await ingest(frameToImageData(bitmap, bitmap.width, bitmap.height));
  } catch (err) {
    setStatus($('receive-status'), err.message, 'err');
  }
});

$('retry-btn').addEventListener('click', () => {
  $('receive-result').hidden = true;
  state.collector.reset();
  updateScanProgress();
  setStatus($('receive-status'), '');
});

// ----------------------------------------------------------------- PWA setup

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

bootModel();
