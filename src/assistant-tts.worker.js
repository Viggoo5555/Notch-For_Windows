// The studio voice. Kokoro is a small neural reader that sounds like a person
// rather than a synthesiser, and it is the one thing here that a graphics card
// is actually good at: on a discrete GPU it reads several times faster than the
// audio plays. It runs in this worker so the window never stutters while it
// works, on the GPU when there is a real one and on the processor otherwise.

let tts = null;
let loading = null;
let voice = 'bm_george';

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

// A software adapter or an integrated Intel GPU is slower than plain WASM here,
// so the device is checked rather than assumed.
async function pickDevice(requested) {
  if (requested === 'wasm' || requested === 'webgpu') return requested;
  if (!self.navigator || !self.navigator.gpu) return 'wasm';
  try {
    const adapter = await withTimeout(self.navigator.gpu.requestAdapter(), 5000, 'no adapter');
    if (!adapter) return 'wasm';
    const info = adapter.info || {};
    const vendor = String(info.vendor || '').toLowerCase();
    const architecture = String(info.architecture || '').toLowerCase();
    if (
      vendor.includes('microsoft') ||
      vendor.includes('intel') ||
      architecture.includes('warp') ||
      architecture.includes('gen-9') ||
      architecture.includes('software')
    ) {
      return 'wasm';
    }
    return 'webgpu';
  } catch {
    return 'wasm';
  }
}

async function loadModule() {
  // The browser bundle carries its own onnxruntime, so it is one file to load
  // and there is nothing to resolve at runtime.
  return import(new URL('../node_modules/kokoro-js/dist/kokoro.web.js', self.location.href).href);
}

async function load(requested, wanted) {
  if (wanted) voice = wanted;
  const mod = await loadModule();
  const KokoroTTS = mod.KokoroTTS || (mod.default && mod.default.KokoroTTS);
  if (!KokoroTTS) throw new Error('the studio voice library did not load');

  const device = await pickDevice(requested);
  const progress = (event) => {
    if (!event) return;
    if (event.status === 'progress' && typeof event.progress === 'number') {
      post({ type: 'progress', pct: Math.round(event.progress), file: event.file || '' });
    }
  };
  // Quantised weights are a CPU trick; a GPU wants the full precision ones.
  const options = {
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    device,
    progress_callback: progress,
  };

  if (device === 'webgpu') {
    try {
      tts = await withTimeout(
        KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', options),
        180000,
        'gpu init timed out',
      );
      post({ type: 'ready', device: 'webgpu' });
      return;
    } catch {
      tts = null;
    }
  }
  tts = await withTimeout(
    KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      ...options,
      dtype: 'q8',
      device: 'wasm',
    }),
    240000,
    'model load timed out',
  );
  post({ type: 'ready', device: 'wasm' });
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === 'init') {
    if (loading) return;
    loading = load(data.device, data.voice).catch((error) => {
      tts = null;
      loading = null;
      post({ type: 'error', message: String((error && error.message) || error) });
    });
    return;
  }
  if (data.type === 'voice' && data.voice) {
    voice = data.voice;
    return;
  }
  if (data.type === 'speak') {
    if (!tts) {
      if (loading) await loading.catch(() => {});
      if (!tts) {
        post({ type: 'result', id: data.id, samples: null });
        return;
      }
    }
    const text = String(data.text || '').trim();
    if (!text) {
      post({ type: 'result', id: data.id, samples: null });
      return;
    }
    try {
      const audio = await tts.generate(text, { voice: data.voice || voice });
      const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
      post(
        {
          type: 'result',
          id: data.id,
          rate: audio.sampling_rate || 24000,
          samples,
        },
        [samples.buffer],
      );
    } catch (error) {
      post({ type: 'error', message: String((error && error.message) || error) });
      post({ type: 'result', id: data.id, samples: null });
    }
  }
};
