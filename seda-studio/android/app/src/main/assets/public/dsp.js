/* پردازش صدا: FFT، حذف نویز (کاهش طیفی)، WAV، نرمال‌سازی، موج‌نما */
(function (root) {
  'use strict';

  function fft(re, im, inverse) {
    var n = re.length, i, j, bit, t;
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
      var wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < half; k++) {
          var a = i + k, b = a + half;
          var xr = re[b] * cr - im[b] * ci;
          var xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /**
   * حذف نویز با کاهش طیفی.
   * پروفایل نویز از ساکت‌ترین قاب‌های خود صدا برآورد می‌شود.
   * strength: 0..1
   */
  function denoise(data, sampleRate, strength) {
    var N = 2048, HOP = 512, half = N / 2 + 1;
    var len = data.length;
    if (len < N) return new Float32Array(data);
    strength = Math.max(0, Math.min(1, strength == null ? 0.6 : strength));

    var win = new Float32Array(N);
    for (var i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

    var padded = new Float32Array(len + 2 * N);
    padded.set(data, N);
    var nFrames = Math.floor((padded.length - N) / HOP) + 1;

    // ۱) انرژی هر قاب (حوزه زمان)
    var rms = new Float32Array(nFrames);
    for (var f = 0; f < nFrames; f++) {
      var p = f * HOP, s = 0;
      for (var k = 0; k < N; k += 4) { var v = padded[p + k]; s += v * v; }
      rms[f] = s;
    }
    // قاب‌های بخش پدینگ صفر را نادیده می‌گیریم
    var firstReal = Math.ceil(N / HOP), lastReal = nFrames - firstReal;
    var sorted = [];
    for (f = firstReal; f < lastReal; f++) sorted.push(rms[f]);
    if (!sorted.length) return new Float32Array(data);
    sorted.sort(function (a, b) { return a - b; });
    var thr = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.12))];

    // ۲) پروفایل نویز: میانگین دامنه‌ی قاب‌های ساکت (حداکثر ۳۰۰ قاب)
    var quiet = [];
    for (f = firstReal; f < lastReal; f++) if (rms[f] <= thr) quiet.push(f);
    var step = Math.max(1, Math.floor(quiet.length / 300));
    var noise = new Float32Array(half), cnt = 0;
    var re = new Float32Array(N), im = new Float32Array(N);
    for (var q = 0; q < quiet.length; q += step) {
      var base = quiet[q] * HOP;
      for (i = 0; i < N; i++) { re[i] = padded[base + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      for (i = 0; i < half; i++) noise[i] += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      cnt++;
    }
    if (!cnt) return new Float32Array(data);
    for (i = 0; i < half; i++) noise[i] /= cnt;

    // ۳) کاهش طیفی با هموارسازی
    var alpha = 1.2 + 2.6 * strength;          // شدت کم‌کردن نویز
    var floorG = 0.02 + 0.18 * (1 - strength); // حداقل بهره (برای جلوگیری از صدای رباتی)
    var gPrev = new Float32Array(half).fill(1);
    var gCur = new Float32Array(half);
    var out = new Float32Array(padded.length);

    for (f = 0; f < nFrames; f++) {
      var pos = f * HOP;
      for (i = 0; i < N; i++) { re[i] = padded[pos + i] * win[i]; im[i] = 0; }
      fft(re, im, false);
      for (i = 0; i < half; i++) {
        var mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) + 1e-12;
        var g = (mag - alpha * noise[i]) / mag;
        gCur[i] = g < floorG ? floorG : g;
      }
      // هموارسازی در فرکانس
      for (i = 1; i < half - 1; i++) {
        var gs = 0.25 * gCur[i - 1] + 0.5 * gCur[i] + 0.25 * gCur[i + 1];
        // هموارسازی در زمان (حمله سریع، رها شدن آهسته‌تر)
        var gp = gPrev[i];
        var gt = gs > gp ? 0.3 * gp + 0.7 * gs : 0.6 * gp + 0.4 * gs;
        gPrev[i] = gt;
        re[i] *= gt; im[i] *= gt;
        if (i > 0) { re[N - i] = re[i]; im[N - i] = -im[i]; }
      }
      re[0] *= gPrev[0]; im[0] = 0;
      re[half - 1] *= gPrev[half - 1]; im[half - 1] = 0;
      fft(re, im, true);
      for (i = 0; i < N; i++) out[pos + i] += re[i] * win[i];
    }
    var res = new Float32Array(len);
    for (i = 0; i < len; i++) res[i] = out[N + i] / 2; // مجموع w² در هم‌پوشانی ۷۵٪ برابر ۲ است
    return res;
  }

  function normalizePeak(channels, peakDb) {
    var peak = 0, c, i;
    for (c = 0; c < channels.length; c++) {
      var d = channels[c];
      for (i = 0; i < d.length; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    }
    if (peak < 1e-6) return 1;
    var target = Math.pow(10, (peakDb == null ? -1 : peakDb) / 20);
    var g = target / peak;
    for (c = 0; c < channels.length; c++) {
      var dd = channels[c];
      for (i = 0; i < dd.length; i++) dd[i] *= g;
    }
    return g;
  }

  function encodeWAV(channels, sampleRate) {
    var nCh = channels.length, len = channels[0].length;
    var bytes = 44 + len * nCh * 2;
    var buf = new ArrayBuffer(bytes), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
    v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, len * nCh * 2, true);
    var o = 44;
    for (var i = 0; i < len; i++) {
      for (var c = 0; c < nCh; c++) {
        var s = channels[c][i];
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Uint8Array(buf);
  }

  // بیشینه‌ی دامنه در بلوک‌های ثابت برای رسم سریع موج‌نما
  function computePeaks(channels, block) {
    block = block || 256;
    var len = channels[0].length, n = Math.ceil(len / block);
    var peaks = new Float32Array(n);
    for (var c = 0; c < channels.length; c++) {
      var d = channels[c];
      for (var b = 0; b < n; b++) {
        var s = b * block, e = Math.min(len, s + block), m = peaks[b];
        for (var i = s; i < e; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
        peaks[b] = m;
      }
    }
    return { peaks: peaks, block: block };
  }

  var api = { fft: fft, denoise: denoise, normalizePeak: normalizePeak, encodeWAV: encodeWAV, computePeaks: computePeaks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DSP = api;
})(typeof self !== 'undefined' ? self : this);
