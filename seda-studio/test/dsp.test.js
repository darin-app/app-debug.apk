const DSP = require('../www/dsp.js');
const assert = require('assert');

// ۱) FFT: رفت و برگشت باید سیگنال را برگرداند
{
  const n = 256, re = new Float32Array(n), im = new Float32Array(n), orig = new Float32Array(n);
  for (let i = 0; i < n; i++) orig[i] = re[i] = Math.sin(i * 0.3) + 0.2 * Math.cos(i * 1.1);
  DSP.fft(re, im, false); DSP.fft(re, im, true);
  let err = 0; for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - orig[i]));
  assert(err < 1e-4, 'fft roundtrip err ' + err);
  console.log('fft ok, err', err.toExponential(2));
}

// ۲) حذف نویز: سینوس ۴۴۰ هرتز + نویز سفید، ۲ ثانیه ابتدا فقط نویز
{
  const sr = 44100, len = sr * 6, x = new Float32Array(len), clean = new Float32Array(len);
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let i = 0; i < len; i++) {
    const tone = i > sr * 2 ? 0.4 * Math.sin(2 * Math.PI * 440 * i / sr) : 0;
    clean[i] = tone; x[i] = tone + 0.08 * rnd();
  }
  const t0 = Date.now();
  const y = DSP.denoise(x, sr, 0.7);
  const ms = Date.now() - t0;
  const rmsOf = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / (e - s)); };
  const noiseBefore = rmsOf(x, sr * 0.5, sr * 1.8), noiseAfter = rmsOf(y, sr * 0.5, sr * 1.8);
  const toneBefore = rmsOf(x, sr * 3, sr * 5), toneAfter = rmsOf(y, sr * 3, sr * 5);
  console.log(`denoise ${ms}ms  noise ${noiseBefore.toFixed(4)} -> ${noiseAfter.toFixed(4)}  (${(20 * Math.log10(noiseAfter / noiseBefore)).toFixed(1)} dB)  tone ${toneBefore.toFixed(3)} -> ${toneAfter.toFixed(3)}`);
  assert(y.length === x.length);
  assert(noiseAfter < noiseBefore * 0.25, 'noise not reduced enough');
  assert(toneAfter > toneBefore * 0.8, 'signal damaged');
}

// ۳) WAV هدر و اندازه
{
  const w = DSP.encodeWAV([new Float32Array([0, 1, -1, 0.5]), new Float32Array([0, 0, 0, 0])], 44100);
  assert(w.length === 44 + 4 * 2 * 2);
  assert(String.fromCharCode(...w.slice(0, 4)) === 'RIFF' && String.fromCharCode(...w.slice(8, 12)) === 'WAVE');
  console.log('wav ok');
}

// ۴) نرمال‌سازی و peaks
{
  const ch = [new Float32Array([0.1, -0.25, 0.05])];
  DSP.normalizePeak(ch, -1);
  assert(Math.abs(Math.max(...ch[0].map(Math.abs)) - Math.pow(10, -1 / 20)) < 1e-5);
  const p = DSP.computePeaks([new Float32Array(1000).fill(0.5)], 256);
  assert(p.peaks.length === 4 && p.peaks[0] === 0.5);
  console.log('normalize/peaks ok');
}
console.log('ALL OK');
