// BlinkCode AI shell: wires the UI to the workers. All heavy lifting
// (compression, rendering payloads, optical decoding) happens off-thread.

import { WorkerClient } from './workers/worker-rpc.js';
import { CanvasSurface } from './lib/surface.js';
import { drawSpectraCode, PAYLOAD_CAPACITY } from './lib/spectracode.js';
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
  symbols: null,
  container: null,
  stream: null,
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

function selectFile(file) {
  state.file = file;
  state.symbols = null;
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

const selectedMode = () => Number(document.querySelector('input[name="mode"]:checked').value);

$('compress-btn').addEventListener('click', async () => {
  if (!state.file) return;
  const mode = selectedMode();
  setStatus($('send-status'), 'Compressing…');
  try {
    const payload = { name: state.file.name, mode };
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

    const { symbols, container, stats } = await workers.compress.call('compress', payload, { transfer });
    state.symbols = symbols;
    state.container = container;

    const ratio = stats.originalBytes / stats.containerBytes;
    $('send-stats').hidden = false;
    $('send-stats').innerHTML = `
      <dt>Original</dt><dd>${fmtBytes(stats.originalBytes)}</dd>
      <dt>File DNA</dt><dd>${fmtBytes(stats.containerBytes)} of ${fmtBytes(PAYLOAD_CAPACITY)} capacity</dd>
      <dt>Ratio</dt><dd>${ratio.toFixed(ratio > 10 ? 0 : 2)} : 1</dd>
      <dt>Time</dt><dd>${stats.elapsedMs} ms</dd>`;
    setStatus($('send-status'), 'Ready to display.', 'ok');
    $('show-btn').disabled = false;
    $('selftest-btn').disabled = false;
    renderPreview();
  } catch (err) {
    setStatus($('send-status'), err.message, 'err');
  }
});

function renderTo(canvas, size) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawSpectraCode(new CanvasSurface(ctx), state.symbols, size);
  return ctx;
}

function renderPreview() {
  const canvas = $('preview-canvas');
  canvas.hidden = false;
  renderTo(canvas, 840);
  canvas.style.width = 'min(100%, 420px)';
}

$('show-btn').addEventListener('click', () => {
  const overlay = $('fullscreen');
  overlay.hidden = false;
  const side = Math.min(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1);
  renderTo($('spectra-canvas'), Math.round(side));
  document.documentElement.requestFullscreen?.().catch(() => {});
});

$('close-fullscreen').addEventListener('click', () => {
  $('fullscreen').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});

// A second device is not always around: render the code offscreen and push it
// straight through the optical decoder to prove the whole chain works.
$('selftest-btn').addEventListener('click', async () => {
  setStatus($('send-status'), 'Running loopback self-test…');
  try {
    const size = 1400;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    drawSpectraCode(new CanvasSurface(ctx), state.symbols, size);
    const image = ctx.getImageData(0, 0, size, size);
    const decoded = await decodeImage(image);
    setStatus(
      $('send-status'),
      `Self-test passed: recovered ${decoded.name} (${fmtBytes(decoded.bytes.length)}) in ${decoded.totalMs} ms`,
      'ok',
    );
  } catch (err) {
    setStatus($('send-status'), `Self-test failed: ${err.message}`, 'err');
  }
});

// ------------------------------------------------------------- receiver flow

async function decodeImage(image) {
  const started = performance.now();
  const optical = await workers.optical.call(
    'decode',
    { data: image.data.buffer, width: image.width, height: image.height },
    { transfer: [image.data.buffer] },
  );
  const file = await workers.decompress.call(
    'decompress',
    { container: optical.payload.buffer },
    { transfer: [optical.payload.buffer] },
  );
  return { ...file, optical, totalMs: Math.round(performance.now() - started) };
}

function showResult(result) {
  const blob = new Blob([result.bytes], { type: result.type });
  const url = URL.createObjectURL(blob);
  $('receive-result').hidden = false;
  $('result-name').textContent = result.name;
  $('result-meta').textContent =
    `${fmtBytes(result.bytes.length)} · ${result.mode === MODE.PERCEPTUAL_IMAGE ? 'perceptual' : 'lossless'}` +
    ` · ${result.optical.corrected} byte(s) repaired by Reed-Solomon · ${result.totalMs} ms`;

  const img = $('result-image');
  const text = $('result-text');
  img.hidden = true;
  text.hidden = true;
  if (result.type.startsWith('image/')) {
    img.src = url;
    img.hidden = false;
  } else if (result.bytes.length < 4096) {
    const decoded = new TextDecoder().decode(result.bytes);
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(decoded)) {
      text.textContent = decoded;
      text.hidden = false;
    }
  }
  const link = $('result-download');
  link.href = url;
  link.download = result.name;
}

function frameToImageData(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

$('camera-btn').addEventListener('click', async () => {
  const video = $('camera');
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    video.srcObject = null;
    $('camera-btn').textContent = 'Start camera';
    $('capture-btn').disabled = true;
    $('camera-hint').textContent = 'Camera off';
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 } },
    });
    video.srcObject = state.stream;
    await video.play();
    $('camera-btn').textContent = 'Stop camera';
    $('capture-btn').disabled = false;
    $('camera-hint').textContent = 'Fill the frame with the code, then capture';
  } catch (err) {
    setStatus($('receive-status'), `Camera unavailable: ${err.message}`, 'err');
  }
});

$('capture-btn').addEventListener('click', async () => {
  const video = $('camera');
  setStatus($('receive-status'), 'Decoding…');
  try {
    const image = frameToImageData(video, video.videoWidth, video.videoHeight);
    const result = await decodeImage(image);
    setStatus($('receive-status'), `File received in ${result.totalMs} ms`, 'ok');
    showResult(result);
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
    const image = frameToImageData(bitmap, bitmap.width, bitmap.height);
    const result = await decodeImage(image);
    setStatus($('receive-status'), `File received in ${result.totalMs} ms`, 'ok');
    showResult(result);
  } catch (err) {
    setStatus($('receive-status'), err.message, 'err');
  }
});

$('retry-btn').addEventListener('click', () => {
  $('receive-result').hidden = true;
  setStatus($('receive-status'), '');
});

// ----------------------------------------------------------------- PWA setup

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

bootModel();
