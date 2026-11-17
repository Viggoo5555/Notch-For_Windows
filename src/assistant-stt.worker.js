// Local speech-to-text. Whisper runs in this worker (WebGPU when the machine
// has it, otherwise WASM) so the UI thread never stutters while it listens.

let asr = null;
let loading = null;
let webgpuBroken = false;

function post(message) {
  self.postMessage(message);
}

async function loadModule() {
  const candidates = [
    '../node_modules/@huggingface/transformers/dist/transformers.min.js',
    '../node_modules/@huggingface/transformers/dist/transformers.js',
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await import(new URL(candidate, self.location.href).href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('transformers.js is not installed');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

// A real GPU is a large speed-up; a software adapter (WARP, or a driver that
// never answers) is slower than plain WASM, so check before committing.
async function pickDevice(requested) {
  if (requested === 'wasm' || requested === 'webgpu') return requested;
  if (webgpuBroken) return 'wasm';
  if (!self.navigator || !self.navigator.gpu) return 'wasm';
  try {
    const adapter = await withTimeout(self.navigator.gpu.requestAdapter(), 5000, 'no adapter');
    if (!adapter) return 'wasm';
    const info = adapter.info || {};
    const vendor = String(info.vendor || '').toLowerCase();
    const architecture = String(info.architecture || '').toLowerCase();
    if (vendor.includes('microsoft') || architecture.includes('warp')) return 'wasm';
    return 'webgpu';
  } catch {
    return 'wasm';
  }
}

async function load(model, fallback, requested) {
  const mod = await loadModule();
  const { pipeline, env } = mod;

  env.allowLocalModels = false;
  env.useBrowserCache = true;
  try {
    env.backends.onnx.wasm.wasmPaths = new URL(
      '../node_modules/@huggingface/transformers/dist/',
      self.location.href,
    ).href;
  } catch {
    /* older builds fall back to their default paths */
  }

  const progress = (event) => {
    if (!event) return;
    if (event.status === 'progress' && typeof event.progress === 'number') {
      post({ type: 'progress', pct: Math.round(event.progress), file: event.file || '' });
    }
  };

  const options = {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: progress,
  };

  const device = await pickDevice(requested);
  if (device === 'webgpu') {
    try {
      asr = await withTimeout(
        pipeline('automatic-speech-recognition', model, { ...options, device: 'webgpu' }),
        45000,
        'gpu init timed out',
      );
      post({ type: 'ready', device: 'webgpu' });
      return;
    } catch {
      asr = null;
      webgpuBroken = true;
    }
  }

  try {
    asr = await pipeline('automatic-speech-recognition', model, { ...options, device: 'wasm' });
    post({ type: 'ready', device: 'wasm' });
    return;
  } catch (error) {
    if (!fallback) throw error;
    post({ type: 'progress', pct: 0, file: 'fallback model' });
    asr = await pipeline('automatic-speech-recognition', fallback, { ...options, device: 'wasm' });
    post({ type: 'ready', device: 'wasm' });
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === 'init') {
    if (loading) return;
    loading = load(data.model, data.fallback, data.device).catch((error) => {
      asr = null;
      loading = null;
      post({ type: 'error', message: String((error && error.message) || error) });
    });
    return;
  }
  if (data.type === 'transcribe') {
    if (!asr) {
      // The first request can arrive before the model finishes warming up.
      if (loading) await loading.catch(() => {});
      if (!asr) {
        post({ type: 'result', text: '' });
        return;
      }
    }
    try {
      const audio = data.audio instanceof Float32Array ? data.audio : new Float32Array(data.audio);
      if (!audio.length) {
        post({ type: 'result', text: '' });
        return;
      }
      const result = await asr(audio, { chunk_length_s: 30, sampling_rate: 16000 });
      const text = Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text;
      post({ type: 'result', text: String(text || '').trim() });
    } catch (error) {
      post({ type: 'error', message: String((error && error.message) || error) });
      post({ type: 'result', text: '' });
    }
  }
};
