/* استودیو صدا — ضبط، میکس و ویرایش چندترکه با Web Audio */
(function () {
  'use strict';

  // ───────── ثابت‌ها و وضعیت ─────────
  var HEAD = 96, RULER = 26, LANE = 96, MIN_DUR = 0.05;
  var COLORS = {
    voice: ['#ff5fa2', '#8b5cf6'],
    beat: ['#22d3ee', '#3b82f6']
  };
  var S = {
    tracks: [],        // {id,name,type,vol,mute,solo,clips:[]}
    playhead: 0,
    playing: false,
    recording: false,
    selId: null,
    zoom: 80           // پیکسل بر ثانیه
  };
  var uidN = 1, counters = { voice: 0, beat: 0, rec: 0 };
  var hist = [];
  var ctx = null;      // AudioContext زنده
  var live = null;     // {t0, from, trackGains, sources}
  var rec = null;      // {recorder, stream, chunks, startPos, t0, analyser, srcNode}
  var dirty = true;
  var peaksCache = new WeakMap();

  function $(id) { return document.getElementById(id); }
  function uid() { return uidN++; }
  function fa(s) { return String(s).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fmtTime(t) {
    t = Math.max(0, t);
    var m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t * 10) % 10);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + d;
  }
  function fmtDur(t) { return t < 60 ? fa(t.toFixed(1)) + ' ثانیه' : fa(Math.floor(t / 60)) + ' دقیقه و ' + fa(Math.round(t % 60)) + ' ثانیه'; }

  var toastTimer;
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  async function busy(msg) {
    if (msg) { $('busyMsg').textContent = msg; $('busy').classList.remove('hidden'); await sleep(40); }
    else $('busy').classList.add('hidden');
  }

  function ensureCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ───────── داده‌ها ─────────
  function findClip(id) {
    for (var i = 0; i < S.tracks.length; i++) {
      var t = S.tracks[i];
      for (var j = 0; j < t.clips.length; j++) if (t.clips[j].id === id) return { tr: t, cl: t.clips[j], ti: i };
    }
    return null;
  }
  function selected() { return S.selId ? findClip(S.selId) : null; }
  function totalDuration() {
    var m = 0;
    S.tracks.forEach(function (t) { t.clips.forEach(function (c) { m = Math.max(m, c.start + c.dur); }); });
    return m;
  }
  function anySolo() { return S.tracks.some(function (t) { return t.solo; }); }
  function audible(t, solo) { return !t.mute && (!solo || t.solo); }

  function snapshot() {
    hist.push({
      sel: S.selId,
      tracks: S.tracks.map(function (t) {
        var c = {}; for (var k in t) c[k] = t[k];
        c.clips = t.clips.map(function (x) { var y = {}; for (var k2 in x) y[k2] = x[k2]; return y; });
        return c;
      })
    });
    if (hist.length > 60) hist.shift();
    $('btnUndo').disabled = false;
  }
  function undo() {
    var h = hist.pop();
    if (!h) return;
    S.tracks = h.tracks; S.selId = h.sel;
    if (!hist.length) $('btnUndo').disabled = true;
    changed(true);
  }

  function newTrack(type, name) {
    counters[type]++;
    var t = { id: uid(), name: name || ((type === 'beat' ? 'بیت ' : 'ویس ') + fa(counters[type])), type: type, vol: 1, mute: false, solo: false, clips: [] };
    S.tracks.push(t);
    return t;
  }
  function addClip(tr, buffer, start, name) {
    var c = { id: uid(), buffer: buffer, start: Math.max(0, start), offset: 0, dur: buffer.duration, gain: 1, fadeIn: 0, fadeOut: 0, name: name || tr.name, orig: null };
    tr.clips.push(c);
    return c;
  }

  // بعد از هر تغییر ساختاری
  function changed(heads) {
    if (heads) renderHeads();
    updateLayout();
    renderEditor();
    $('emptyHint').classList.toggle('hidden', S.tracks.length > 0);
    dirty = true;
    if (S.playing && !S.recording) restartPlayback();
  }

  // ───────── میکس / زمان‌بندی (زنده و آفلاین) ─────────
  function scheduleClipGain(g, c, when, rel) {
    var G = c.gain, D = c.dur;
    var fi = Math.min(c.fadeIn || 0, D / 2), fo = Math.min(c.fadeOut || 0, D / 2);
    function at(r) {
      var v = 1;
      if (fi > 0 && r < fi) v = Math.min(v, r / fi);
      if (fo > 0 && r > D - fo) v = Math.min(v, (D - r) / fo);
      return Math.max(0, v) * G;
    }
    g.gain.setValueAtTime(at(rel), when);
    if (fi > 0 && rel < fi) g.gain.linearRampToValueAtTime(G, when + (fi - rel));
    if (fo > 0) {
      var foStart = D - fo;
      if (rel < foStart) g.gain.setValueAtTime(G, when + (foStart - rel));
      g.gain.linearRampToValueAtTime(0, when + (D - rel));
    }
  }

  function buildMix(c, dest, from, t0) {
    var solo = anySolo(), trackGains = new Map(), sources = [];
    S.tracks.forEach(function (tr) {
      var tg = c.createGain();
      tg.gain.value = audible(tr, solo) ? tr.vol : 0;
      tg.connect(dest);
      trackGains.set(tr.id, tg);
      tr.clips.forEach(function (cl) {
        var rel = Math.max(0, from - cl.start), d = cl.dur - rel;
        if (d <= 0.001) return;
        var src = c.createBufferSource(); src.buffer = cl.buffer;
        var g = c.createGain(); src.connect(g); g.connect(tg);
        var when = t0 + Math.max(0, cl.start - from);
        scheduleClipGain(g, cl, when, rel);
        src.start(when, cl.offset + rel, d);
        sources.push(src);
      });
    });
    return { trackGains: trackGains, sources: sources };
  }

  function updateLiveGains() {
    if (!live) return;
    var solo = anySolo();
    S.tracks.forEach(function (t) {
      var g = live.trackGains.get(t.id);
      if (g) g.gain.value = audible(t, solo) ? t.vol : 0;
    });
  }

  // ───────── پخش ─────────
  function stopSources() {
    if (!live) return;
    live.sources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} });
    live.trackGains.forEach(function (g) { try { g.disconnect(); } catch (e) {} });
    live = null;
  }
  function play() {
    ensureCtx();
    var tot = totalDuration();
    if (!S.recording && S.playhead >= tot - 0.05) S.playhead = 0;
    if (!tot) { toast('چیزی برای پخش نیست'); return; }
    stopSources();
    var t0 = ctx.currentTime + 0.05;
    var mix = buildMix(ctx, ctx.destination, S.playhead, t0);
    live = { t0: t0, from: S.playhead, trackGains: mix.trackGains, sources: mix.sources };
    S.playing = true;
    $('btnPlay').textContent = '⏸';
    dirty = true;
  }
  function pause() {
    if (live) S.playhead = Math.max(live.from, live.from + ctx.currentTime - live.t0);
    stopSources();
    S.playing = false;
    $('btnPlay').textContent = '▶';
    dirty = true;
  }
  function restartPlayback() {
    if (!S.playing) return;
    if (live) S.playhead = Math.max(live.from, live.from + ctx.currentTime - live.t0);
    play();
  }
  function seekTo(t) {
    S.playhead = Math.max(0, t);
    if (S.playing && !S.recording) play();
    dirty = true;
  }

  // ───────── ضبط ─────────
  function pickMime() {
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  async function startRecording() {
    ensureCtx();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || pickMime() === null) {
      toast('ضبط صدا روی این دستگاه پشتیبانی نمی‌شود'); return;
    }
    var ns = $('optMicNS').checked, stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: ns, noiseSuppression: ns, autoGainControl: ns, channelCount: 1 }
      });
    } catch (e) {
      toast('دسترسی به میکروفون داده نشد'); return;
    }
    var mime = pickMime();
    var recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    var srcNode = ctx.createMediaStreamSource(stream); srcNode.connect(analyser);
    rec = { recorder: recorder, stream: stream, chunks: chunks, startPos: S.playhead, t0: ctx.currentTime, analyser: analyser, srcNode: srcNode, overdub: $('optOverdub').checked && totalDuration() > 0 };
    recorder.onstop = function () { finishRecording(rec_snapshot); };
    var rec_snapshot = rec;
    recorder.start(250);
    S.recording = true;
    $('btnRec').classList.add('on');
    if (rec.overdub) play();
    dirty = true;
  }
  function stopRecording() {
    if (!rec) return;
    var r = rec;
    S.recording = false;
    $('btnRec').classList.remove('on');
    $('meter').style.width = '0';
    if (r.overdub) pause();
    try { r.recorder.stop(); } catch (e) {}
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    try { r.srcNode.disconnect(); } catch (e) {}
    rec = null;
  }
  async function finishRecording(r) {
    var blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
    if (blob.size < 200) { toast('صدایی ضبط نشد'); dirty = true; return; }
    await busy('در حال آماده‌سازی ضبط…');
    try {
      var buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      snapshot();
      counters.rec++;
      var tr = newTrack('voice', 'ضبط ' + fa(counters.rec));
      var c = addClip(tr, buf, r.startPos, tr.name);
      S.selId = c.id;
      S.playhead = r.startPos + buf.duration;
      changed(true);
      toast('ضبط ذخیره شد');
    } catch (e) {
      toast('خواندن ضبط ناموفق بود');
    }
    await busy(null);
  }

  // ───────── آپلود ─────────
  async function importFiles(files, type) {
    ensureCtx();
    if (!files || !files.length) return;
    var ok = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      await busy('در حال خواندن «' + f.name + '»…');
      try {
        var buf = await ctx.decodeAudioData(await f.arrayBuffer());
        if (!ok) snapshot();
        var nm = f.name.replace(/\.[^.]+$/, '');
        var tr = newTrack(type, nm.length > 18 ? nm.slice(0, 18) + '…' : nm);
        var c = addClip(tr, buf, S.playhead, nm);
        S.selId = c.id;
        ok++;
      } catch (e) {
        toast('فایل «' + f.name + '» خوانده نشد');
      }
    }
    await busy(null);
    if (ok) { changed(true); }
  }

  // ───────── ویرایش کلیپ ─────────
  function splitSel() {
    var f = selected(); if (!f) return;
    var c = f.cl, p = S.playhead;
    if (p <= c.start + 0.03 || p >= c.start + c.dur - 0.03) { toast('نشانگر را وسط کلیپ بگذارید'); return; }
    snapshot();
    var left = p - c.start;
    var right = { id: uid(), buffer: c.buffer, start: p, offset: c.offset + left, dur: c.dur - left, gain: c.gain, fadeIn: 0, fadeOut: c.fadeOut, name: c.name, orig: c.orig };
    c.dur = left; c.fadeOut = 0;
    f.tr.clips.push(right);
    S.selId = right.id;
    changed();
  }
  function deleteSel() {
    var f = selected(); if (!f) return;
    snapshot();
    f.tr.clips = f.tr.clips.filter(function (c) { return c.id !== f.cl.id; });
    S.selId = null;
    changed();
  }
  function dupSel() {
    var f = selected(); if (!f) return;
    snapshot();
    var c = f.cl, d = {};
    for (var k in c) d[k] = c[k];
    d.id = uid(); d.start = c.start + c.dur;
    f.tr.clips.push(d);
    S.selId = d.id;
    changed();
    toast('کپی بلافاصله بعد از کلیپ قرار گرفت');
  }
  async function denoiseSel() {
    var f = selected(); if (!f) return;
    var c = f.cl, buf = c.buffer, sr = buf.sampleRate;
    var strength = parseInt($('edNs').value, 10) / 100;
    var s = Math.floor(c.offset * sr), e = Math.min(buf.length, Math.ceil((c.offset + c.dur) * sr));
    if (e - s < 4096) { toast('کلیپ برای حذف نویز خیلی کوتاه است'); return; }
    await busy('در حال حذف نویز…');
    try {
      snapshot();
      var out = ctx.createBuffer(buf.numberOfChannels, e - s, sr);
      for (var ch = 0; ch < buf.numberOfChannels; ch++) {
        var res = DSP.denoise(buf.getChannelData(ch).subarray(s, e), sr, strength);
        out.copyToChannel(res, ch);
        await sleep(0);
      }
      if (!c.orig) c.orig = { buffer: buf, base: s / sr };
      c.buffer = out;
      c.offset = 0;
      c.dur = Math.min(c.dur, out.duration);
      changed();
      toast('نویز کم شد. اگر صدا گرفته شد، شدت را کمتر کنید');
    } catch (err) {
      toast('حذف نویز ناموفق بود');
    }
    await busy(null);
  }
  function restoreSel() {
    var f = selected(); if (!f || !f.cl.orig) return;
    snapshot();
    var c = f.cl;
    c.buffer = c.orig.buffer;
    c.offset = c.orig.base + c.offset;
    c.dur = Math.min(c.dur, c.buffer.duration - c.offset);
    c.orig = null;
    changed();
    toast('صدای اصلی برگشت');
  }

  // ───────── نمایش: طرح‌بندی ─────────
  var cv = $('cv'), g2 = cv.getContext('2d'), scroller = $('scroller');
  var viewW = 300, viewH = RULER + LANE;
  function laneCount() { return Math.max(1, S.tracks.length); }
  function updateLayout() {
    viewW = Math.max(240, scroller.clientWidth);
    viewH = RULER + laneCount() * LANE;
    var contentW = Math.max(viewW, HEAD + (totalDuration() + 10) * S.zoom);
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(viewW * dpr) || cv.height !== Math.round(viewH * dpr)) {
      cv.width = Math.round(viewW * dpr); cv.height = Math.round(viewH * dpr);
    }
    cv.style.width = viewW + 'px'; cv.style.height = viewH + 'px';
    $('view').style.width = viewW + 'px'; $('view').style.height = viewH + 'px';
    $('content').style.width = contentW + 'px'; $('content').style.height = viewH + 'px';
    $('heads').style.height = viewH + 'px';
    dirty = true;
  }

  function renderHeads() {
    var box = $('heads'); box.innerHTML = '';
    S.tracks.forEach(function (t, i) {
      var h = document.createElement('div');
      h.className = 'head'; h.style.top = (RULER + i * LANE) + 'px'; h.style.height = LANE + 'px';
      var nm = document.createElement('div'); nm.className = 'nm';
      var tag = document.createElement('i'); tag.className = 'tag'; tag.style.background = COLORS[t.type][0];
      var tx = document.createElement('span'); tx.textContent = t.name;
      nm.appendChild(tag); nm.appendChild(tx);
      nm.title = 'برای تغییر نام لمس کنید';
      nm.onclick = function () {
        var v = window.prompt('نام ترک', t.name);
        if (v && v.trim()) { t.name = v.trim().slice(0, 24); tx.textContent = t.name; }
      };
      var bt = document.createElement('div'); bt.className = 'bt';
      var bm = document.createElement('button'); bm.className = 'mute' + (t.mute ? ' on' : ''); bm.textContent = '🔇'; bm.title = 'بی‌صدا';
      var bs = document.createElement('button'); bs.className = 'solo' + (t.solo ? ' on' : ''); bs.textContent = 'تک'; bs.title = 'فقط این ترک';
      var bd = document.createElement('button'); bd.textContent = '✕'; bd.title = 'حذف ترک';
      bm.onclick = function () { t.mute = !t.mute; bm.classList.toggle('on', t.mute); updateLiveGains(); };
      bs.onclick = function () { t.solo = !t.solo; bs.classList.toggle('on', t.solo); updateLiveGains(); };
      bd.onclick = function () {
        if (!window.confirm('ترک «' + t.name + '» حذف شود؟')) return;
        snapshot();
        S.tracks = S.tracks.filter(function (x) { return x.id !== t.id; });
        if (S.selId && !findClip(S.selId)) S.selId = null;
        changed(true);
      };
      bt.appendChild(bm); bt.appendChild(bs); bt.appendChild(bd);
      var vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 150; vol.value = Math.round(t.vol * 100); vol.title = 'بلندی ترک';
      vol.oninput = function () { t.vol = vol.value / 100; updateLiveGains(); };
      h.appendChild(nm); h.appendChild(bt); h.appendChild(vol);
      box.appendChild(h);
    });
  }

  // ───────── نمایش: رسم ─────────
  function peaksFor(buf) {
    var p = peaksCache.get(buf);
    if (!p) {
      var chans = [];
      for (var i = 0; i < buf.numberOfChannels; i++) chans.push(buf.getChannelData(i));
      p = DSP.computePeaks(chans, 256);
      peaksCache.set(buf, p);
    }
    return p;
  }
  function tx(t) { return HEAD + t * S.zoom - scroller.scrollLeft; }
  function timeAt(x) { return Math.max(0, (x - HEAD + scroller.scrollLeft) / S.zoom); }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  function draw() {
    var dpr = window.devicePixelRatio || 1, c = g2, W = viewW, H = viewH;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.font = '11px Vazirmatn, sans-serif';

    // پس‌زمینه‌ی ردیف‌ها
    for (var i = 0; i < laneCount(); i++) {
      c.fillStyle = i % 2 ? 'rgba(255,255,255,.04)' : 'rgba(255,255,255,.075)';
      c.fillRect(0, RULER + i * LANE, W, LANE);
    }
    c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(0, 0, W, RULER);

    c.save(); c.beginPath(); c.rect(HEAD, 0, W - HEAD, H); c.clip();

    // خط‌کش زمان
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600], step = 600;
    for (i = 0; i < steps.length; i++) if (steps[i] * S.zoom >= 64) { step = steps[i]; break; }
    var t0 = Math.floor(timeAt(HEAD) / step) * step, t1 = timeAt(W) + step;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    for (var t = t0; t <= t1; t += step) {
      var x = Math.round(tx(t)) + .5;
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.moveTo(x, RULER - 8); c.lineTo(x, RULER); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.07)'; c.beginPath(); c.moveTo(x, RULER); c.lineTo(x, H); c.stroke();
      c.fillStyle = 'rgba(244,241,255,.75)';
      var mm = Math.floor(t / 60), ss = Math.round(t % 60);
      c.fillText(fa(mm + ':' + (ss < 10 ? '0' : '') + ss), x + 4, RULER / 2 - 2);
    }

    // نوار ضبط
    if (S.recording && rec) {
      var rx = tx(rec.startPos), rw = Math.max(2, (S.playhead - rec.startPos) * S.zoom);
      c.fillStyle = 'rgba(255,77,109,.28)'; c.fillRect(rx, RULER, rw, H - RULER);
      c.fillStyle = 'rgba(255,77,109,.9)'; c.fillRect(rx, 0, rw, 4);
    }

    // کلیپ‌ها
    S.tracks.forEach(function (tr, ti) {
      var y0 = RULER + ti * LANE + 6, h = LANE - 12, cols = COLORS[tr.type];
      tr.clips.forEach(function (cl) {
        var x0 = tx(cl.start), w = cl.dur * S.zoom;
        if (x0 + w < HEAD || x0 > W) return;
        var sel = cl.id === S.selId;
        var gr = c.createLinearGradient(x0, y0, x0 + w, y0 + h);
        gr.addColorStop(0, cols[0] + (sel ? 'cc' : '88')); gr.addColorStop(1, cols[1] + (sel ? 'cc' : '88'));
        rr(c, x0, y0, w, h, 10); c.fillStyle = gr; c.fill();
        c.save(); rr(c, x0, y0, w, h, 10); c.clip();
        // موج‌نما
        var pk = peaksFor(cl.buffer), sr = cl.buffer.sampleRate, mid = y0 + h / 2, amp = (h / 2 - 4);
        c.strokeStyle = 'rgba(255,255,255,.92)'; c.lineWidth = 1.4; c.beginPath();
        var pxStart = Math.max(Math.floor(x0), HEAD), pxEnd = Math.min(Math.ceil(x0 + w), W);
        for (var px = pxStart; px < pxEnd; px += 2) {
          var s0 = (cl.offset + (px - x0) / S.zoom) * sr, s1 = s0 + 2 * sr / S.zoom;
          var b0 = Math.max(0, Math.floor(s0 / pk.block)), b1 = Math.min(pk.peaks.length - 1, Math.max(b0, Math.floor(s1 / pk.block)));
          var m = 0;
          for (var b = b0; b <= b1; b++) if (pk.peaks[b] > m) m = pk.peaks[b];
          m = Math.min(1, m * cl.gain);
          var hh = Math.max(1, m * amp);
          c.moveTo(px + .5, mid - hh); c.lineTo(px + .5, mid + hh);
        }
        c.stroke();
        c.restore();
        // برچسب
        if (w > 50) {
          c.save(); c.beginPath(); c.rect(Math.max(x0, HEAD) + 4, y0, w - 8, 16); c.clip();
          c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'top';
          c.fillText((cl.orig ? '✨ ' : '') + cl.name, Math.max(x0, HEAD) + 8, y0 + 3);
          c.restore();
        }
        if (sel) {
          c.lineWidth = 2; c.strokeStyle = '#fff'; rr(c, x0, y0, w, h, 10); c.stroke();
          c.fillStyle = '#fff';
          rr(c, x0 + 2, y0 + h / 2 - 14, 5, 28, 3); c.fill();
          rr(c, x0 + w - 7, y0 + h / 2 - 14, 5, 28, 3); c.fill();
        }
      });
    });

    // نشانگر پخش
    var px2 = tx(S.playhead);
    if (px2 >= HEAD - 1 && px2 <= W) {
      c.strokeStyle = '#fbbf24'; c.lineWidth = 2; c.beginPath(); c.moveTo(px2, 0); c.lineTo(px2, H); c.stroke();
      c.fillStyle = '#fbbf24'; c.beginPath(); c.moveTo(px2 - 7, 0); c.lineTo(px2 + 7, 0); c.lineTo(px2, 11); c.closePath(); c.fill();
    }
    c.restore();
    dirty = false;
  }

  function tick() {
    if (S.playing && live) {
      S.playhead = Math.max(live.from, live.from + ctx.currentTime - live.t0);
      if (!S.recording && S.playhead >= totalDuration()) { S.playhead = totalDuration(); pause(); }
      dirty = true;
    } else if (S.recording && rec) {
      S.playhead = rec.startPos + (ctx.currentTime - rec.t0);
      dirty = true;
    }
    if (S.recording && rec) {
      var data = new Uint8Array(rec.analyser.fftSize); rec.analyser.getByteTimeDomainData(data);
      var pk = 0; for (var i = 0; i < data.length; i++) { var a = Math.abs(data[i] - 128) / 128; if (a > pk) pk = a; }
      $('meter').style.width = Math.min(100, pk * 160) + '%';
    }
    if (S.playing || S.recording) {
      var need = HEAD + (Math.max(totalDuration(), S.playhead) + 10) * S.zoom;
      if (need > parseFloat($('content').style.width || 0)) updateLayout();
      var x = tx(S.playhead);
      if (x > viewW - 30) scroller.scrollLeft = Math.max(0, S.playhead * S.zoom - 40);
      else if (x < HEAD) scroller.scrollLeft = Math.max(0, S.playhead * S.zoom - 40);
    }
    if (dirty) {
      draw();
      $('timeDisplay').textContent = fmtTime(S.playhead);
    }
    requestAnimationFrame(tick);
  }

  // ───────── لمس و ماوس روی خط زمان ─────────
  function hit(x, y) {
    if (y < RULER) return { zone: 'ruler' };
    var ti = Math.floor((y - RULER) / LANE);
    if (ti < 0 || ti >= S.tracks.length) return { zone: 'empty', ti: ti };
    var tr = S.tracks[ti], t = timeAt(x);
    for (var i = tr.clips.length - 1; i >= 0; i--) {
      var c = tr.clips[i];
      if (t >= c.start && t <= c.start + c.dur && x >= HEAD) {
        var x0 = tx(c.start), x1 = tx(c.start + c.dur), edge = null;
        if (c.id === S.selId) {
          if (x - x0 < 16) edge = 'l'; else if (x1 - x < 16) edge = 'r';
        }
        return { zone: 'clip', ti: ti, tr: tr, cl: c, edge: edge };
      }
    }
    return { zone: 'empty', ti: ti };
  }

  var drag = null;
  cv.addEventListener('pointerdown', function (e) {
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    cv.setPointerCapture(e.pointerId);
    var h = hit(x, y);
    drag = { sx: x, sy: y, sl: scroller.scrollLeft, moved: false, mode: 'pan', h: h };
    if (h.zone === 'ruler') { drag.mode = 'scrub'; seekTo(timeAt(x)); }
    else if (h.zone === 'clip' && h.cl.id === S.selId) {
      drag.mode = h.edge === 'l' ? 'trimL' : h.edge === 'r' ? 'trimR' : 'move';
      drag.o = { start: h.cl.start, offset: h.cl.offset, dur: h.cl.dur };
      drag.snap = false;
    }
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    var dx = x - drag.sx, dy = y - drag.sy;
    if (!drag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    drag.moved = true;
    if (drag.mode === 'pan') { scroller.scrollLeft = drag.sl - dx; dirty = true; return; }
    if (drag.mode === 'scrub') { seekTo(timeAt(x)); return; }
    var cl = drag.h.cl, o = drag.o, dt = dx / S.zoom;
    if (!drag.snap) { snapshot(); drag.snap = true; }
    if (drag.mode === 'move') {
      var ns = Math.max(0, o.start + dt), th = 10 / S.zoom, best = null;
      var cands = [0, S.playhead];
      S.tracks.forEach(function (t) { t.clips.forEach(function (k) { if (k.id !== cl.id) { cands.push(k.start); cands.push(k.start + k.dur); } }); });
      cands.forEach(function (cd) {
        [[ns, cd], [ns + cl.dur, cd]].forEach(function (p, idx) {
          var d = Math.abs(p[0] - p[1]);
          if (d < th && (best === null || d < best.d)) best = { d: d, shift: p[1] - p[0] };
        });
      });
      if (best) ns = Math.max(0, ns + best.shift);
      cl.start = ns;
      var ti = clamp(Math.floor((y - RULER) / LANE), 0, S.tracks.length - 1);
      var cur = findClip(cl.id);
      if (cur && cur.ti !== ti) {
        cur.tr.clips = cur.tr.clips.filter(function (k) { return k.id !== cl.id; });
        S.tracks[ti].clips.push(cl);
      }
    } else if (drag.mode === 'trimL') {
      var d = clamp(dt, -o.offset, o.dur - MIN_DUR);
      cl.start = o.start + d; cl.offset = o.offset + d; cl.dur = o.dur - d;
    } else if (drag.mode === 'trimR') {
      cl.dur = clamp(o.dur + dt, MIN_DUR, cl.buffer.duration - o.offset);
    }
    dirty = true;
  });
  function endDrag(e) {
    if (!drag) return;
    var d = drag; drag = null;
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (d.mode === 'pan' && !d.moved) {
      if (d.h.zone === 'clip') { S.selId = d.h.cl.id; seekTo(timeAt(x)); }
      else { S.selId = null; if (y > RULER) seekTo(timeAt(x)); }
      renderEditor(); dirty = true;
    } else if (d.mode === 'move' && !d.moved) {
      seekTo(timeAt(x));
    } else if (d.moved && (d.mode === 'move' || d.mode === 'trimL' || d.mode === 'trimR')) {
      changed(false);
    }
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', function () { drag = null; });
  scroller.addEventListener('scroll', function () { dirty = true; });

  // ───────── پنل ویرایش ─────────
  function renderEditor() {
    var f = selected(), box = $('editor');
    box.classList.toggle('hidden', !f);
    if (!f) return;
    var c = f.cl;
    $('edName').textContent = c.name;
    $('edInfo').textContent = ' — ' + fmtDur(c.dur) + ' · ' + f.tr.name;
    $('edGain').value = Math.round(c.gain * 100); $('vGain').textContent = fa(Math.round(c.gain * 100)) + '٪';
    $('edFi').value = Math.round(c.fadeIn * 10); $('vFi').textContent = fa(c.fadeIn.toFixed(1)) + ' ث';
    $('edFo').value = Math.round(c.fadeOut * 10); $('vFo').textContent = fa(c.fadeOut.toFixed(1)) + ' ث';
    $('edRestore').classList.toggle('hidden', !c.orig);
  }
  function bindSlider(id, apply) {
    var el = $(id), snapped = false;
    el.addEventListener('input', function () {
      var f = selected(); if (!f) return;
      if (!snapped) { snapshot(); snapped = true; }
      apply(f.cl, +el.value); dirty = true;
    });
    el.addEventListener('change', function () { snapped = false; if (S.playing && !S.recording) restartPlayback(); });
  }
  bindSlider('edGain', function (c, v) { c.gain = v / 100; $('vGain').textContent = fa(v) + '٪'; });
  bindSlider('edFi', function (c, v) { c.fadeIn = v / 10; $('vFi').textContent = fa((v / 10).toFixed(1)) + ' ث'; });
  bindSlider('edFo', function (c, v) { c.fadeOut = v / 10; $('vFo').textContent = fa((v / 10).toFixed(1)) + ' ث'; });
  $('edNs').addEventListener('input', function () { $('vNs').textContent = fa($('edNs').value) + '٪'; });

  $('edSplit').onclick = splitSel;
  $('edDel').onclick = deleteSel;
  $('edDup').onclick = dupSel;
  $('edDenoise').onclick = denoiseSel;
  $('edRestore').onclick = restoreSel;

  // ───────── دکمه‌های بالا ─────────
  $('btnPlay').onclick = function () { if (S.recording) return; S.playing ? pause() : play(); };
  $('btnStop').onclick = function () {
    if (S.recording) { stopRecording(); return; }
    if (S.playing) pause();
    S.playhead = 0; scroller.scrollLeft = 0; dirty = true;
  };
  $('btnStart').onclick = function () { scroller.scrollLeft = 0; seekTo(0); };
  $('btnRec').onclick = function () { S.recording ? stopRecording() : startRecording(); };
  $('btnUndo').onclick = undo;
  $('btnUndo').disabled = true;
  $('btnAddVoice').onclick = function () { $('fileVoice').click(); };
  $('btnAddBeat').onclick = function () { $('fileBeat').click(); };
  $('fileVoice').onchange = function (e) { importFiles(e.target.files, 'voice'); e.target.value = ''; };
  $('fileBeat').onchange = function (e) { importFiles(e.target.files, 'beat'); e.target.value = ''; };

  $('zoom').addEventListener('input', function (e) {
    var centerT = timeAt(HEAD + (viewW - HEAD) / 2);
    S.zoom = +e.target.value;
    updateLayout();
    scroller.scrollLeft = Math.max(0, centerT * S.zoom - (viewW - HEAD) / 2);
    dirty = true;
  });

  document.addEventListener('keydown', function (e) {
    if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
    else if (e.code === 'Delete' || e.code === 'Backspace') deleteSel();
    else if (e.key === 's' || e.key === 'S') splitSel();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  });

  // ───────── خروجی ─────────
  function toInt16(f) {
    var o = new Int16Array(f.length);
    for (var i = 0; i < f.length; i++) { var s = f[i]; s = s > 1 ? 1 : s < -1 ? -1 : s; o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return o;
  }
  async function encodeMp3(chans, sr, kbps) {
    var enc = new lamejs.Mp3Encoder(2, sr, kbps);
    var L = toInt16(chans[0]), R = toInt16(chans[1]), out = [], total = 0, bs = 1152 * 20;
    for (var i = 0, n = 0; i < L.length; i += bs, n++) {
      var b = enc.encodeBuffer(L.subarray(i, i + bs), R.subarray(i, i + bs));
      if (b.length) { out.push(b); total += b.length; }
      if (n % 25 === 0) { $('busyMsg').textContent = 'در حال ساخت MP3… ' + fa(Math.round(i / L.length * 100)) + '٪'; await sleep(0); }
    }
    var f = enc.flush(); if (f.length) { out.push(f); total += f.length; }
    var res = new Uint8Array(total), p = 0;
    out.forEach(function (b) { res.set(b, p); p += b.length; });
    return res;
  }
  function toBase64(bytes) {
    var s = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(s);
  }
  async function saveBytes(bytes, name, mime) {
    var Cap = window.Capacitor;
    var native = Cap && Cap.isNativePlatform && Cap.isNativePlatform();
    if (native && Cap.Plugins && Cap.Plugins.Filesystem && Cap.Plugins.Share) {
      var w = await Cap.Plugins.Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: 'CACHE' });
      await Cap.Plugins.Share.share({ title: name, url: w.uri, dialogTitle: 'ذخیره یا ارسال آهنگ' });
    } else {
      var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      var a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }
  }
  async function doExport() {
    var dur = totalDuration();
    if (!dur) { toast('چیزی برای خروجی گرفتن نیست'); return; }
    var name = ($('exName').value.trim() || 'آهنگ من').replace(/[\\/:*?"<>|]/g, '_');
    var fmt = document.querySelector('input[name=fmt]:checked').value, norm = $('exNorm').checked;
    $('modal').classList.add('hidden');
    if (S.playing) pause();
    ensureCtx();
    await busy('در حال ساخت میکس…');
    try {
      var sr = [44100, 48000, 32000].indexOf(ctx.sampleRate) >= 0 ? ctx.sampleRate : 44100;
      var len = Math.ceil((dur + 0.3) * sr);
      var off = new OfflineAudioContext(2, len, sr);
      buildMix(off, off.destination, 0, 0);
      var rendered = await off.startRendering();
      var chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
      if (norm) DSP.normalizePeak(chans, -1);
      var bytes, mime;
      if (fmt === 'wav') { $('busyMsg').textContent = 'در حال ساخت WAV…'; await sleep(20); bytes = DSP.encodeWAV(chans, sr); mime = 'audio/wav'; }
      else { bytes = await encodeMp3(chans, sr, 192); mime = 'audio/mpeg'; }
      await saveBytes(bytes, name + '.' + fmt, mime);
      toast('آهنگ آماده شد ✓');
    } catch (e) {
      if (!(e && e.message && /cancel|dismiss/i.test(e.message))) toast('ساخت خروجی ناموفق بود');
    }
    await busy(null);
  }
  $('btnExport').onclick = function () {
    if (!totalDuration()) { toast('اول چیزی ضبط یا آپلود کنید'); return; }
    $('modal').classList.remove('hidden');
  };
  $('exCancel').onclick = function () { $('modal').classList.add('hidden'); };
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
  $('exGo').onclick = doExport;

  // ───────── راه‌اندازی ─────────
  window.addEventListener('resize', function () { updateLayout(); });
  if (window.ResizeObserver) new ResizeObserver(function () { updateLayout(); }).observe(scroller);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { dirty = true; });
  window.SedaStudio = { S: S, play: play, pause: pause, addClip: addClip, newTrack: newTrack, changed: changed, ensureCtx: ensureCtx, buildMix: buildMix, totalDuration: totalDuration };
  renderHeads(); updateLayout(); renderEditor();
  requestAnimationFrame(tick);
})();
