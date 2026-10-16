/* استودیو صدا — ضبط، میکس و ویرایش چندترکه با پروژه‌های ذخیره‌شونده */
(function () {
  'use strict';

  // ───────── ثابت‌ها و وضعیت ─────────
  var HEAD = 96, RULER = 26, LANE = 96, MIN_DUR = 0.05;
  var COLORS = { voice: ['#ff5fa2', '#8b5cf6'], beat: ['#22d3ee', '#3b82f6'] };
  var S = {
    tracks: [],     // {id,name,type,vol,pan,mute,solo,clips:[]}
    playhead: 0, playing: false, recording: false, selId: null,
    zoom: 80, bpm: 120, snap: false, rA: null, rB: null
  };
  var cfg = { latency: 0 };
  var P = null;               // پروژه‌ی باز: {id,name,created}
  var db = null;
  var uidN = 1, counters = { voice: 0, beat: 0, rec: 0, track: 0 };
  var hist = [], redoStack = [];
  var ctx = null, live = null, rec = null, dirty = true;
  var peaksCache = new WeakMap();
  var assetIds = new WeakMap();
  var projDirty = false, saveTimer = null, saveChain = Promise.resolve();
  var lastExport = null;

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
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  var toastTimer;
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
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
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  try { var c0 = JSON.parse(lsGet('seda.cfg') || '{}'); if (typeof c0.latency === 'number') cfg.latency = clamp(c0.latency, 0, 500); } catch (e) {}

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
  function cloneClip(c) { var y = {}; for (var k in c) y[k] = c[k]; return y; }
  function cloneTracks(list) {
    return list.map(function (t) {
      var c = {}; for (var k in t) c[k] = t[k];
      c.clips = t.clips.map(cloneClip);
      return c;
    });
  }

  function syncUndoBtns() {
    $('btnUndo').disabled = !hist.length;
    $('btnRedo').disabled = !redoStack.length;
  }
  function snapshot() {
    hist.push({ sel: S.selId, tracks: cloneTracks(S.tracks) });
    if (hist.length > 60) hist.shift();
    redoStack = [];
    syncUndoBtns();
    markDirty();
  }
  function undo() {
    var h = hist.pop(); if (!h) return;
    redoStack.push({ sel: S.selId, tracks: cloneTracks(S.tracks) });
    S.tracks = h.tracks; S.selId = h.sel;
    if (S.selId && !findClip(S.selId)) S.selId = null;
    syncUndoBtns(); changed(true);
  }
  function redo() {
    var h = redoStack.pop(); if (!h) return;
    hist.push({ sel: S.selId, tracks: cloneTracks(S.tracks) });
    S.tracks = h.tracks; S.selId = h.sel;
    if (S.selId && !findClip(S.selId)) S.selId = null;
    syncUndoBtns(); changed(true);
  }

  function newTrack(type, name) {
    counters[type]++;
    var t = { id: uid(), name: name || ((type === 'beat' ? 'بیت ' : 'ویس ') + fa(counters[type])), type: type, vol: 1, pan: 0, mute: false, solo: false, clips: [] };
    S.tracks.push(t);
    return t;
  }
  function addClip(tr, buffer, start, name) {
    var c = { id: uid(), buffer: buffer, start: Math.max(0, start), offset: 0, dur: buffer.duration, gain: 1, fadeIn: 0, fadeOut: 0, name: name || tr.name, orig: null };
    tr.clips.push(c);
    return c;
  }

  function changed(heads) {
    if (heads) renderHeads();
    updateLayout();
    renderEditor();
    renderRange();
    $('emptyHint').classList.toggle('hidden', S.tracks.length > 0);
    dirty = true;
    markDirty();
    if (S.playing && !S.recording) restartPlayback();
  }

  // ───────── شبکه‌ی ضرب ─────────
  function beatLen() { return 60 / clamp(S.bpm || 120, 30, 300); }
  function snapT(t) { if (!S.snap) return t; var b = beatLen(); return Math.max(0, Math.round(t / b) * b); }
  function setSnap(v) {
    S.snap = !!v;
    $('btnSnap').classList.toggle('on', S.snap);
    $('stSnap').checked = S.snap;
    dirty = true; markDirty();
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
    var solo = anySolo(), trackGains = new Map(), pans = new Map(), sources = [];
    S.tracks.forEach(function (tr) {
      var tg = c.createGain();
      tg.gain.value = audible(tr, solo) ? tr.vol : 0;
      if (c.createStereoPanner) {
        var pn = c.createStereoPanner(); pn.pan.value = clamp(tr.pan || 0, -1, 1);
        tg.connect(pn); pn.connect(dest); pans.set(tr.id, pn);
      } else tg.connect(dest);
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
    return { trackGains: trackGains, pans: pans, sources: sources };
  }
  function updateLiveGains() {
    if (!live) return;
    var solo = anySolo();
    S.tracks.forEach(function (t) {
      var g = live.trackGains.get(t.id); if (g) g.gain.value = audible(t, solo) ? t.vol : 0;
      var p = live.pans.get(t.id); if (p) p.pan.value = clamp(t.pan || 0, -1, 1);
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
    live = { t0: t0, from: S.playhead, trackGains: mix.trackGains, pans: mix.pans, sources: mix.sources };
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: ns, noiseSuppression: ns, autoGainControl: ns, channelCount: 1 } });
    } catch (e) { toast('دسترسی به میکروفون داده نشد'); return; }
    var mime = pickMime();
    var recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    var srcNode = ctx.createMediaStreamSource(stream); srcNode.connect(analyser);
    var r = { recorder: recorder, stream: stream, chunks: chunks, startPos: S.playhead, t0: ctx.currentTime, analyser: analyser, srcNode: srcNode, overdub: $('optOverdub').checked && totalDuration() > 0 };
    recorder.onstop = function () { finishRecording(r); };
    rec = r;
    recorder.start(250);
    S.recording = true;
    $('btnRec').classList.add('on');
    if (r.overdub) play();
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
      var lat = r.overdub ? cfg.latency / 1000 : 0, start = r.startPos - lat, off = 0;
      if (start < 0) { off = -start; start = 0; }
      var c = addClip(tr, buf, start, tr.name);
      c.offset = Math.min(off, Math.max(0, buf.duration - MIN_DUR));
      c.dur = Math.max(MIN_DUR, buf.duration - c.offset);
      S.selId = c.id;
      S.playhead = c.start + c.dur;
      changed(true);
      toast('ضبط ذخیره شد');
    } catch (e) { toast('خواندن ضبط ناموفق بود'); }
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
      } catch (e) { toast('فایل «' + f.name + '» خوانده نشد'); }
    }
    await busy(null);
    if (ok) changed(true);
  }
  function addEmptyTrack() {
    snapshot();
    counters.track++;
    newTrack('voice', 'لایه ' + fa(counters.track));
    changed(true);
    toast('ترک خالی ساخته شد. کلیپ‌ها را با «ترک بالا/پایین» به آن ببرید');
  }

  // ───────── ویرایش کلیپ ─────────
  function splitSel() {
    var f = selected(); if (!f) return;
    var c = f.cl, p = S.playhead;
    if (p <= c.start + 0.03 || p >= c.start + c.dur - 0.03) { toast('نشانگر را وسط کلیپ بگذارید'); return; }
    snapshot();
    var left = p - c.start;
    var right = cloneClip(c); right.id = uid(); right.start = p; right.offset = c.offset + left; right.dur = c.dur - left; right.fadeIn = 0;
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
    var d = cloneClip(f.cl); d.id = uid(); d.start = f.cl.start + f.cl.dur;
    f.tr.clips.push(d); S.selId = d.id;
    changed();
  }
  function repeatSel() {
    var f = selected(); if (!f) return;
    var n = clamp(parseInt($('repN').value, 10) || 1, 1, 64);
    snapshot();
    var pos = f.cl.start + f.cl.dur, last = null;
    for (var i = 0; i < n; i++) {
      var d = cloneClip(f.cl); d.id = uid(); d.start = pos; f.tr.clips.push(d); pos += f.cl.dur; last = d;
    }
    S.selId = last.id;
    changed();
    toast(fa(n) + ' کپی پشت‌سرهم ساخته شد');
  }
  function fillSel() {
    var f = selected(); if (!f) return;
    var total = totalDuration(), c = f.cl, end = c.start + c.dur;
    if (total - end < 0.05) { toast('کلیپ دیگری بلندتر از این نیست. از «کپی پشت‌سرهم» استفاده کنید'); return; }
    snapshot();
    var pos = end, n = 0, last = c;
    while (pos < total - 0.01 && n < 300) {
      var d = cloneClip(c); d.id = uid(); d.start = pos; d.dur = Math.min(c.dur, total - pos);
      if (d.dur < c.dur) d.fadeOut = 0;
      f.tr.clips.push(d); pos += c.dur; n++; last = d;
    }
    S.selId = last.id;
    changed();
    toast('تا انتهای آهنگ تکرار شد');
  }
  function reverseSel() {
    var f = selected(); if (!f) return;
    ensureCtx();
    var c = f.cl, buf = c.buffer, sr = buf.sampleRate;
    var s = Math.floor(c.offset * sr), e = Math.min(buf.length, Math.ceil((c.offset + c.dur) * sr));
    if (e - s < 16) return;
    snapshot();
    var out = ctx.createBuffer(buf.numberOfChannels, e - s, sr);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var src = buf.getChannelData(ch).subarray(s, e), dst = new Float32Array(src.length);
      for (var i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
      out.copyToChannel(dst, ch);
    }
    c.buffer = out; c.offset = 0; c.dur = Math.min(c.dur, out.duration); c.orig = null;
    var fi = c.fadeIn; c.fadeIn = c.fadeOut; c.fadeOut = fi;
    changed();
  }
  function normSel() {
    var f = selected(); if (!f) return;
    var c = f.cl, buf = c.buffer, sr = buf.sampleRate, peak = 0;
    var s = Math.floor(c.offset * sr), e = Math.min(buf.length, Math.ceil((c.offset + c.dur) * sr));
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = s; i < e; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    }
    if (peak < 1e-4) { toast('این کلیپ تقریباً ساکت است'); return; }
    snapshot();
    c.gain = Math.min(4, 0.95 / peak);
    changed();
  }
  function moveClipTrack(dir) {
    var f = selected(); if (!f) return;
    var ti = f.ti + dir;
    if (ti < 0 || ti >= S.tracks.length) { toast(dir < 0 ? 'این بالاترین ترک است' : 'این پایین‌ترین ترک است'); return; }
    snapshot();
    f.tr.clips = f.tr.clips.filter(function (c) { return c.id !== f.cl.id; });
    S.tracks[ti].clips.push(f.cl);
    changed();
  }
  function clipToNewLayer() {
    var f = selected(); if (!f) return;
    snapshot();
    counters.track++;
    var t = newTrack(f.tr.type, 'لایه ' + fa(counters.track));
    f.tr.clips = f.tr.clips.filter(function (c) { return c.id !== f.cl.id; });
    t.clips.push(f.cl);
    changed(true);
  }
  function moveTrackOrder(dir) {
    var f = selected(); if (!f) return;
    var j = f.ti + dir;
    if (j < 0 || j >= S.tracks.length) return;
    snapshot();
    var t = S.tracks[f.ti]; S.tracks[f.ti] = S.tracks[j]; S.tracks[j] = t;
    changed(true);
  }
  async function denoiseSel() {
    var f = selected(); if (!f) return;
    ensureCtx();
    var c = f.cl, buf = c.buffer, sr = buf.sampleRate;
    var strength = parseInt($('edNs').value, 10) / 100;
    var s = Math.floor(c.offset * sr), e = Math.min(buf.length, Math.ceil((c.offset + c.dur) * sr));
    if (e - s < 4096) { toast('کلیپ برای حذف نویز خیلی کوتاه است'); return; }
    await busy('در حال حذف نویز…');
    try {
      snapshot();
      var out = ctx.createBuffer(buf.numberOfChannels, e - s, sr);
      for (var ch = 0; ch < buf.numberOfChannels; ch++) {
        out.copyToChannel(DSP.denoise(buf.getChannelData(ch).subarray(s, e), sr, strength), ch);
        await sleep(0);
      }
      if (!c.orig) c.orig = { buffer: buf, base: s / sr };
      c.buffer = out; c.offset = 0; c.dur = Math.min(c.dur, out.duration);
      changed();
      toast('نویز کم شد. اگر صدا گرفته شد، شدت را کمتر کنید');
    } catch (err) { toast('حذف نویز ناموفق بود'); }
    await busy(null);
  }
  function restoreSel() {
    var f = selected(); if (!f || !f.cl.orig) return;
    snapshot();
    var c = f.cl;
    c.buffer = c.orig.buffer; c.offset = c.orig.base + c.offset;
    c.dur = Math.min(c.dur, c.buffer.duration - c.offset);
    c.orig = null;
    changed();
    toast('صدای اصلی برگشت');
  }

  // ───────── حذف یک بخش ─────────
  function renderRange() {
    $('rangeCard').classList.toggle('hidden', !S.tracks.length);
    var a = S.rA, b = S.rB, el = $('rgInfo');
    if (a == null && b == null) el.textContent = 'بخشی مشخص نشده';
    else if (a != null && b != null) el.textContent = 'از ' + fa(fmtTime(Math.min(a, b))) + ' تا ' + fa(fmtTime(Math.max(a, b)));
    else el.textContent = a != null ? 'شروع ثبت شد؛ پایان را هم بگذارید' : 'پایان ثبت شد؛ شروع را هم بگذارید';
  }
  function cutRange() {
    var A = S.rA, B = S.rB;
    if (A == null || B == null) { toast('اول شروع و پایان بخش را با دکمه‌ها مشخص کنید'); return; }
    var a = Math.min(A, B), b = Math.max(A, B), gap = b - a;
    if (gap < 0.02) { toast('بخش خیلی کوتاه است'); return; }
    var all = $('rgAll').checked, ripple = $('rgRipple').checked, sel = selected();
    if (!all && !sel) { toast('یک کلیپ را انتخاب کنید یا «روی همه‌ی ترک‌ها» را بزنید'); return; }
    snapshot();
    var newSel = null, selId = S.selId;
    S.tracks.forEach(function (tr) {
      var out = [];
      tr.clips.forEach(function (c) {
        var inScope = all || (sel && c.id === sel.cl.id), s = c.start, e = c.start + c.dur;
        if (!inScope || e <= a) { out.push(c); return; }
        if (s >= b) { if (ripple && all) c.start = s - gap; out.push(c); return; }
        var pieces = [];
        if (s < a - 0.001) { var L = cloneClip(c); L.dur = a - s; L.fadeOut = 0; pieces.push(L); }
        if (e > b + 0.001) {
          var R = cloneClip(c); if (pieces.length) R.id = uid();
          R.start = ripple ? a : b; R.offset = c.offset + (b - s); R.dur = e - b; R.fadeIn = 0; pieces.push(R);
        }
        if (c.id === selId && pieces.length) newSel = pieces[0].id;
        pieces.forEach(function (p) { out.push(p); });
      });
      tr.clips = out;
    });
    S.selId = newSel;
    if (ripple) S.playhead = a;
    S.rA = S.rB = null;
    changed();
    toast('بخش حذف شد');
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
        if (v && v.trim()) { snapshot(); t.name = v.trim().slice(0, 24); tx.textContent = t.name; }
      };
      var bt = document.createElement('div'); bt.className = 'bt';
      var bm = document.createElement('button'); bm.className = 'mute' + (t.mute ? ' on' : ''); bm.textContent = '🔇'; bm.title = 'بی‌صدا';
      var bs = document.createElement('button'); bs.className = 'solo' + (t.solo ? ' on' : ''); bs.textContent = 'تک'; bs.title = 'فقط این ترک';
      var bd = document.createElement('button'); bd.textContent = '✕'; bd.title = 'حذف ترک';
      bm.onclick = function () { t.mute = !t.mute; bm.classList.toggle('on', t.mute); updateLiveGains(); markDirty(); };
      bs.onclick = function () { t.solo = !t.solo; bs.classList.toggle('on', t.solo); updateLiveGains(); markDirty(); };
      bd.onclick = function () {
        if (!window.confirm('ترک «' + t.name + '» حذف شود؟')) return;
        snapshot();
        S.tracks = S.tracks.filter(function (x) { return x.id !== t.id; });
        if (S.selId && !findClip(S.selId)) S.selId = null;
        changed(true);
      };
      bt.appendChild(bm); bt.appendChild(bs); bt.appendChild(bd);
      var vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 150; vol.value = Math.round(t.vol * 100); vol.title = 'بلندی ترک';
      vol.oninput = function () { t.vol = vol.value / 100; updateLiveGains(); markDirty(); };
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
    var dpr = window.devicePixelRatio || 1, c = g2, W = viewW, H = viewH, i;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.font = '11px Vazirmatn, sans-serif';

    for (i = 0; i < laneCount(); i++) {
      c.fillStyle = i % 2 ? 'rgba(255,255,255,.04)' : 'rgba(255,255,255,.075)';
      c.fillRect(0, RULER + i * LANE, W, LANE);
    }
    c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(0, 0, W, RULER);

    c.save(); c.beginPath(); c.rect(HEAD, 0, W - HEAD, H); c.clip();

    // شبکه‌ی ضرب
    if (S.snap) {
      var bl = beatLen(), bpx = bl * S.zoom;
      if (bpx >= 9) {
        var k0 = Math.floor(timeAt(HEAD) / bl), k1 = Math.ceil(timeAt(W) / bl);
        for (var k = k0; k <= k1; k++) {
          var gx = Math.round(tx(k * bl)) + .5;
          c.strokeStyle = k % 4 === 0 ? 'rgba(251,191,36,.28)' : 'rgba(255,255,255,.09)';
          c.beginPath(); c.moveTo(gx, RULER); c.lineTo(gx, H); c.stroke();
        }
      }
    }

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

    if (S.recording && rec) {
      var rx = tx(rec.startPos), rw = Math.max(2, (S.playhead - rec.startPos) * S.zoom);
      c.fillStyle = 'rgba(255,77,109,.28)'; c.fillRect(rx, RULER, rw, H - RULER);
      c.fillStyle = 'rgba(255,77,109,.9)'; c.fillRect(rx, 0, rw, 4);
    }

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

    // بخش انتخاب‌شده برای حذف
    if (S.rA != null || S.rB != null) {
      var ra = S.rA != null ? S.rA : S.rB, rb = S.rB != null ? S.rB : S.rA;
      var xa = tx(Math.min(ra, rb)), xb = tx(Math.max(ra, rb));
      if (xb - xa > 1) { c.fillStyle = 'rgba(255,77,109,.22)'; c.fillRect(xa, RULER, xb - xa, H - RULER); }
      c.strokeStyle = '#ff4d6d'; c.lineWidth = 2; c.setLineDash([5, 4]);
      [xa, xb].forEach(function (lx) { c.beginPath(); c.moveTo(lx, 0); c.lineTo(lx, H); c.stroke(); });
      c.setLineDash([]);
    }

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
      if (x > viewW - 30 || x < HEAD) scroller.scrollLeft = Math.max(0, S.playhead * S.zoom - 40);
    }
    if (dirty) { draw(); $('timeDisplay').textContent = fmtTime(S.playhead); }
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
        var x0 = tx(c.start), x1 = tx(c.start + c.dur), ew = Math.min(26, (x1 - x0) / 3), edge = null;
        if (x - x0 < ew) edge = 'l'; else if (x1 - x < ew) edge = 'r';
        return { zone: 'clip', ti: ti, tr: tr, cl: c, edge: edge };
      }
    }
    return { zone: 'empty', ti: ti };
  }

  var drag = null;
  cv.addEventListener('pointerdown', function (e) {
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    var h = hit(x, y);
    drag = { sx: x, sy: y, sl: scroller.scrollLeft, moved: false, mode: 'pan', h: h, snap: false };
    if (h.zone === 'ruler') { drag.mode = 'scrub'; seekTo(snapT(timeAt(x))); }
    else if (h.zone === 'clip') {
      var was = h.cl.id === S.selId;
      if (!was) { S.selId = h.cl.id; renderEditor(); dirty = true; }
      drag.mode = was && h.edge === 'l' ? 'trimL' : was && h.edge === 'r' ? 'trimR' : 'move';
      drag.o = { start: h.cl.start, offset: h.cl.offset, dur: h.cl.dur };
    }
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    var dx = x - drag.sx, dy = y - drag.sy;
    if (!drag.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    if (!drag.moved && drag.mode !== 'pan' && drag.mode !== 'scrub' && Math.abs(dy) > Math.abs(dx) * 2 && e.pointerType === 'touch') return;
    drag.moved = true;
    if (drag.mode === 'pan') { scroller.scrollLeft = drag.sl - dx; dirty = true; return; }
    if (drag.mode === 'scrub') { seekTo(snapT(timeAt(x))); return; }
    var cl = drag.h.cl, o = drag.o, dt = dx / S.zoom;
    if (!drag.snap) { snapshot(); drag.snap = true; }
    if (drag.mode === 'move') {
      var ns = Math.max(0, o.start + dt);
      if (S.snap) ns = snapT(ns);
      else {
        var th = 10 / S.zoom, best = null, cands = [0, S.playhead];
        S.tracks.forEach(function (t) { t.clips.forEach(function (k) { if (k.id !== cl.id) { cands.push(k.start); cands.push(k.start + k.dur); } }); });
        cands.forEach(function (cd) {
          [ns, ns + cl.dur].forEach(function (p) {
            var d = Math.abs(p - cd);
            if (d < th && (best === null || d < best.d)) best = { d: d, shift: cd - p };
          });
        });
        if (best) ns = Math.max(0, ns + best.shift);
      }
      cl.start = ns;
      var ti = clamp(Math.floor((y - RULER) / LANE), 0, S.tracks.length - 1);
      var cur = findClip(cl.id);
      if (cur && cur.ti !== ti) {
        cur.tr.clips = cur.tr.clips.filter(function (k) { return k.id !== cl.id; });
        S.tracks[ti].clips.push(cl);
      }
    } else if (drag.mode === 'trimL') {
      var newStart = snapT(o.start + dt), d2 = clamp(newStart - o.start, -o.offset, o.dur - MIN_DUR);
      cl.start = o.start + d2; cl.offset = o.offset + d2; cl.dur = o.dur - d2;
    } else if (drag.mode === 'trimR') {
      var newEnd = snapT(o.start + o.dur + dt);
      cl.dur = clamp(newEnd - o.start, MIN_DUR, cl.buffer.duration - o.offset);
    }
    dirty = true;
  });
  function endDrag(e) {
    if (!drag) return;
    var d = drag; drag = null;
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (d.mode === 'pan' && !d.moved) {
      S.selId = null; renderEditor();
      if (y > RULER) seekTo(snapT(timeAt(x)));
      dirty = true;
    } else if (d.mode === 'move' && !d.moved) {
      seekTo(snapT(timeAt(x)));
    } else if (d.moved && d.snap) {
      changed(false);
    }
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', function () {
    if (drag && drag.moved && drag.snap) changed(false);
    drag = null;
  });
  scroller.addEventListener('scroll', function () { dirty = true; });

  // ───────── پنل ویرایش ─────────
  function panLabel(v) { return v === 0 ? 'وسط' : (v < 0 ? 'چپ ' : 'راست ') + fa(Math.abs(v)) + '٪'; }
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
    var pv = Math.round((f.tr.pan || 0) * 100);
    $('edPan').value = pv; $('vPan').textContent = panLabel(pv);
    $('edRestore').classList.toggle('hidden', !c.orig);
  }
  function bindSlider(id, apply, onTrack) {
    var el = $(id), snapped = false;
    el.addEventListener('input', function () {
      var f = selected(); if (!f) return;
      if (!snapped) { snapshot(); snapped = true; }
      apply(onTrack ? f.tr : f.cl, +el.value); dirty = true; markDirty();
    });
    el.addEventListener('change', function () { snapped = false; if (S.playing && !S.recording) restartPlayback(); });
  }
  bindSlider('edGain', function (c, v) { c.gain = v / 100; $('vGain').textContent = fa(v) + '٪'; });
  bindSlider('edFi', function (c, v) { c.fadeIn = v / 10; $('vFi').textContent = fa((v / 10).toFixed(1)) + ' ث'; });
  bindSlider('edFo', function (c, v) { c.fadeOut = v / 10; $('vFo').textContent = fa((v / 10).toFixed(1)) + ' ث'; });
  bindSlider('edPan', function (t, v) { t.pan = v / 100; $('vPan').textContent = panLabel(v); updateLiveGains(); }, true);
  $('edNs').addEventListener('input', function () { $('vNs').textContent = fa($('edNs').value) + '٪'; });

  $('edSplit').onclick = splitSel; $('edDel').onclick = deleteSel; $('edDup').onclick = dupSel;
  $('edRepeat').onclick = repeatSel; $('edFill').onclick = fillSel;
  $('edUp').onclick = function () { moveClipTrack(-1); }; $('edDown').onclick = function () { moveClipTrack(1); };
  $('edNewLayer').onclick = clipToNewLayer;
  $('edTrUp').onclick = function () { moveTrackOrder(-1); }; $('edTrDown').onclick = function () { moveTrackOrder(1); };
  $('edDenoise').onclick = denoiseSel; $('edRestore').onclick = restoreSel;
  $('edNorm').onclick = normSel; $('edRev').onclick = reverseSel;

  $('rgA').onclick = function () { S.rA = S.playhead; renderRange(); dirty = true; };
  $('rgB').onclick = function () { S.rB = S.playhead; renderRange(); dirty = true; };
  $('rgClear').onclick = function () { S.rA = S.rB = null; renderRange(); dirty = true; };
  $('rgCut').onclick = cutRange;

  // ───────── دکمه‌های بالا ─────────
  $('btnPlay').onclick = function () { if (S.recording) return; S.playing ? pause() : play(); };
  $('btnStop').onclick = function () {
    if (S.recording) { stopRecording(); return; }
    if (S.playing) pause();
    S.playhead = 0; scroller.scrollLeft = 0; dirty = true;
  };
  $('btnStart').onclick = function () { scroller.scrollLeft = 0; seekTo(0); };
  $('btnRec').onclick = function () { S.recording ? stopRecording() : startRecording(); };
  $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
  $('btnAddVoice').onclick = function () { $('fileVoice').click(); };
  $('btnAddBeat').onclick = function () { $('fileBeat').click(); };
  $('btnAddTrack').onclick = addEmptyTrack;
  $('btnSnap').onclick = function () { setSnap(!S.snap); };
  $('fileVoice').onchange = function (e) { importFiles(e.target.files, 'voice'); e.target.value = ''; };
  $('fileBeat').onchange = function (e) { importFiles(e.target.files, 'beat'); e.target.value = ''; };

  $('zoom').addEventListener('input', function (e) {
    var centerT = timeAt(HEAD + (viewW - HEAD) / 2);
    S.zoom = +e.target.value;
    updateLayout();
    scroller.scrollLeft = Math.max(0, centerT * S.zoom - (viewW - HEAD) / 2);
    dirty = true; markDirty();
  });

  document.addEventListener('keydown', function (e) {
    if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
    else if (e.code === 'Delete' || e.code === 'Backspace') deleteSel();
    else if (e.key === 's' || e.key === 'S') splitSel();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
  });

  // ───────── ذخیره‌ی پروژه (IndexedDB) ─────────
  function dbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no idb')); return; }
      var rq = indexedDB.open('seda-studio', 1);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idb(store, mode, fn) {
    return new Promise(function (res, rej) {
      var tx2 = db.transaction(store, mode), rq = fn(tx2.objectStore(store));
      tx2.oncomplete = function () { res(rq ? rq.result : undefined); };
      tx2.onerror = tx2.onabort = function () { rej(tx2.error || new Error('idb failed')); };
    });
  }
  function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function setSaveState(st) {
    var el = $('saveState');
    el.className = 'muted' + (st === 'dirty' ? ' wait' : st === 'err' ? ' err' : '');
    el.textContent = st === 'dirty' ? 'در حال ذخیره…' : st === 'err' ? 'ذخیره نشد' : 'ذخیره شد';
  }
  function markDirty() {
    if (!P) return;
    projDirty = true; setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveNow(); }, 1200);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!P || !db || !projDirty) return saveChain;
    saveChain = saveChain.then(doSave).catch(function () { setSaveState('err'); toast('ذخیره‌ی پروژه ناموفق بود'); });
    return saveChain;
  }
  async function doSave() {
    if (!P || !db || !projDirty) return;
    projDirty = false;
    var used = {}, tracks = cloneTracks(S.tracks), outTracks = [], nClips = 0, dur = 0;
    async function aid(buf) {
      var id = assetIds.get(buf);
      if (!id) {
        id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var ch = [];
        for (var i = 0; i < buf.numberOfChannels; i++) ch.push(buf.getChannelData(i));
        var wav = DSP.encodeWAV(ch, buf.sampleRate);
        await idb('assets', 'readwrite', function (os) { return os.put(wav.buffer, id); });
        assetIds.set(buf, id);
      }
      used[id] = 1;
      return id;
    }
    for (var ti = 0; ti < tracks.length; ti++) {
      var t = tracks[ti], oc = [];
      for (var ci = 0; ci < t.clips.length; ci++) {
        var c = t.clips[ci];
        oc.push({
          id: c.id, asset: await aid(c.buffer), start: c.start, offset: c.offset, dur: c.dur, gain: c.gain,
          fadeIn: c.fadeIn, fadeOut: c.fadeOut, name: c.name,
          orig: c.orig ? { asset: await aid(c.orig.buffer), base: c.orig.base } : null
        });
        nClips++; dur = Math.max(dur, c.start + c.dur);
      }
      outTracks.push({ id: t.id, name: t.name, type: t.type, vol: t.vol, pan: t.pan || 0, mute: t.mute, solo: t.solo, clips: oc });
    }
    var record = {
      id: P.id, name: P.name, created: P.created, updated: Date.now(), dur: dur, nTracks: outTracks.length, nClips: nClips,
      used: Object.keys(used),
      data: { v: 2, tracks: outTracks, counters: counters, uidN: uidN, bpm: S.bpm, snap: S.snap, zoom: S.zoom, playhead: S.playhead }
    };
    await idb('projects', 'readwrite', function (os) { return os.put(record); });
    if (!projDirty) setSaveState('saved');
  }

  async function listProjects() {
    if (!db) return [];
    var all = await idb('projects', 'readonly', function (os) { return os.getAll(); });
    return (all || []).sort(function (a, b) { return b.updated - a.updated; });
  }
  async function gcAssets() {
    var all = await listProjects(), keep = {};
    all.forEach(function (p) { (p.used || []).forEach(function (k) { keep[k] = 1; }); });
    var keys = await idb('assets', 'readonly', function (os) { return os.getAllKeys(); });
    for (var i = 0; i < keys.length; i++) {
      if (!keep[keys[i]]) await idb('assets', 'readwrite', function (os) { return os.delete(keys[i]); });
    }
  }

  function resetState() {
    if (S.recording) stopRecording();
    if (S.playing) pause();
    S.tracks = []; S.selId = null; S.playhead = 0; S.rA = S.rB = null;
    S.bpm = 120; S.snap = false; S.zoom = 80;
    counters = { voice: 0, beat: 0, rec: 0, track: 0 };
    uidN = 1; hist = []; redoStack = [];
    $('zoom').value = 80; $('stBpm').value = 120; setSnapQuiet(false);
    scroller.scrollLeft = 0;
    syncUndoBtns();
  }
  function setSnapQuiet(v) { S.snap = !!v; $('btnSnap').classList.toggle('on', S.snap); $('stSnap').checked = S.snap; }
  function showProject() {
    $('projName').textContent = P ? P.name : 'بدون پروژه';
    renderHeads(); updateLayout(); renderEditor(); renderRange();
    $('emptyHint').classList.toggle('hidden', S.tracks.length > 0);
    dirty = true;
  }

  async function createProject(name) {
    await saveNow();
    var list = await listProjects();
    resetState();
    P = { id: newId(), name: name || ('پروژه ' + fa(list.length + 1)), created: Date.now() };
    lsSet('seda.last', P.id);
    projDirty = true;
    if (db) await doSave();
    projDirty = false; setSaveState('saved');
    showProject();
    hideHome();
  }
  async function openProject(id) {
    if (P && P.id === id) { hideHome(); return; }
    await saveNow();
    await busy('در حال باز کردن پروژه…');
    try {
      ensureCtx();
      var rec2 = await idb('projects', 'readonly', function (os) { return os.get(id); });
      if (!rec2) throw new Error('missing');
      resetState();
      var cache = {}, missing = 0;
      async function load(aId) {
        if (cache[aId]) return cache[aId];
        var ab = await idb('assets', 'readonly', function (os) { return os.get(aId); });
        if (!ab) throw new Error('asset');
        var buf = await ctx.decodeAudioData(ab.slice(0));
        assetIds.set(buf, aId); cache[aId] = buf;
        return buf;
      }
      var d = rec2.data, maxId = 0;
      for (var i = 0; i < d.tracks.length; i++) {
        var t = d.tracks[i], nt = { id: t.id, name: t.name, type: t.type, vol: t.vol, pan: t.pan || 0, mute: t.mute, solo: t.solo, clips: [] };
        maxId = Math.max(maxId, t.id);
        for (var j = 0; j < t.clips.length; j++) {
          var c = t.clips[j];
          maxId = Math.max(maxId, c.id);
          try {
            var cb = await load(c.asset), co = null;
            if (c.orig) co = { buffer: await load(c.orig.asset), base: c.orig.base };
            nt.clips.push({ id: c.id, buffer: cb, start: c.start, offset: c.offset, dur: c.dur, gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut, name: c.name, orig: co });
          } catch (e) { missing++; }
        }
        S.tracks.push(nt);
      }
      counters = d.counters || counters;
      uidN = Math.max(d.uidN || 1, maxId + 1);
      S.bpm = d.bpm || 120; $('stBpm').value = S.bpm; setSnapQuiet(d.snap);
      S.zoom = d.zoom || 80; $('zoom').value = S.zoom;
      S.playhead = 0;
      P = { id: rec2.id, name: rec2.name, created: rec2.created };
      lsSet('seda.last', P.id);
      showProject();
      projDirty = false; clearTimeout(saveTimer); setSaveState('saved');
      hideHome();
      if (missing) toast('بخشی از صداهای این پروژه پیدا نشد');
    } catch (e) {
      toast('باز کردن پروژه ناموفق بود');
    }
    await busy(null);
  }
  async function duplicateProject(id, openIt) {
    await saveNow();
    var r = await idb('projects', 'readonly', function (os) { return os.get(id); });
    if (!r) return;
    var all = await listProjects(), base = r.name.replace(/ – نسخه .*$/, ''), n = 2, names = {};
    all.forEach(function (p) { names[p.name] = 1; });
    while (names[base + ' – نسخه ' + fa(n)]) n++;
    var copy = JSON.parse(JSON.stringify(r));
    copy.id = newId(); copy.name = base + ' – نسخه ' + fa(n); copy.created = Date.now(); copy.updated = Date.now();
    await idb('projects', 'readwrite', function (os) { return os.put(copy); });
    toast('نسخه‌ی جدید ساخته شد');
    if (openIt) await openProject(copy.id); else await renderHome();
  }
  async function renameProject(id, name) {
    name = (name || '').trim().slice(0, 40);
    if (!name) return;
    if (P && P.id === id) { P.name = name; $('projName').textContent = name; $('stName').value = name; markDirty(); await saveNow(); }
    else {
      var r = await idb('projects', 'readonly', function (os) { return os.get(id); });
      if (r) { r.name = name; await idb('projects', 'readwrite', function (os) { return os.put(r); }); }
    }
  }
  async function deleteProject(id) {
    await saveNow();
    await idb('projects', 'readwrite', function (os) { return os.delete(id); });
    await gcAssets();
    if (P && P.id === id) {
      P = null; resetState(); showProject(); projDirty = false;
      var rest = await listProjects();
      if (!rest.length) { await createProject(); return; }
    }
    await renderHome();
  }

  // ───────── صفحه‌ی پروژه‌ها ─────────
  function relDate(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleDateString('fa-IR') + ' ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  async function renderHome() {
    var list = await listProjects(), box = $('hmList');
    box.innerHTML = '';
    $('hmClose').classList.toggle('hidden', !P);
    if (!list.length) { box.innerHTML = '<div class="empty-p">هنوز پروژه‌ای نساخته‌اید</div>'; return; }
    list.forEach(function (p) {
      var card = document.createElement('div'); card.className = 'glass pcard' + (P && P.id === p.id ? ' cur' : '');
      var top = document.createElement('div'); top.className = 'pt';
      var nm = document.createElement('b'); nm.textContent = p.name; top.appendChild(nm);
      if (P && P.id === p.id) { var tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = 'باز'; top.appendChild(tg); }
      var meta = document.createElement('div'); meta.className = 'muted small';
      meta.textContent = fa(p.nTracks || 0) + ' ترک · ' + fa(p.nClips || 0) + ' کلیپ · ' + (p.dur ? fmtDur(p.dur) : 'خالی') + ' · ' + relDate(p.updated);
      var acts = document.createElement('div'); acts.className = 'acts';
      function mk(label, fn, cls) {
        var b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = label;
        b.onclick = function (ev) { ev.stopPropagation(); fn(); }; acts.appendChild(b);
      }
      mk('✎ نام', async function () { var v = window.prompt('نام پروژه', p.name); if (v) { await renameProject(p.id, v); renderHome(); } });
      mk('⧉ نسخه‌ی جدید', function () { duplicateProject(p.id, false); });
      mk('🗑 حذف', function () { if (window.confirm('پروژه‌ی «' + p.name + '» برای همیشه حذف شود؟')) deleteProject(p.id); }, 'danger');
      card.appendChild(top); card.appendChild(meta); card.appendChild(acts);
      card.onclick = function () { openProject(p.id); };
      box.appendChild(card);
    });
  }
  async function showHome() {
    await saveNow();
    await renderHome();
    $('home').classList.remove('hidden');
  }
  function hideHome() { $('home').classList.add('hidden'); }
  $('btnProjects').onclick = showHome;
  $('hmClose').onclick = hideHome;
  $('hmNew').onclick = function () { createProject(); };

  // ───────── تنظیمات پروژه ─────────
  function openSettings() {
    $('stName').value = P ? P.name : '';
    $('stBpm').value = S.bpm; $('stSnap').checked = S.snap;
    $('stLat').value = cfg.latency; $('vLat').textContent = fa(cfg.latency) + ' میلی‌ثانیه';
    $('setModal').classList.remove('hidden');
  }
  $('btnSettings').onclick = openSettings;
  $('stClose').onclick = function () { $('setModal').classList.add('hidden'); };
  $('setModal').addEventListener('click', function (e) { if (e.target === $('setModal')) $('setModal').classList.add('hidden'); });
  $('stName').addEventListener('change', function () { if (P) renameProject(P.id, $('stName').value); });
  $('stBpm').addEventListener('change', function () { S.bpm = clamp(parseInt($('stBpm').value, 10) || 120, 30, 300); $('stBpm').value = S.bpm; dirty = true; markDirty(); });
  $('stSnap').addEventListener('change', function () { setSnap($('stSnap').checked); });
  $('stLat').addEventListener('input', function () {
    cfg.latency = +$('stLat').value; $('vLat').textContent = fa(cfg.latency) + ' میلی‌ثانیه';
    lsSet('seda.cfg', JSON.stringify(cfg));
  });
  $('stCopy').onclick = async function () {
    if (!P) return;
    $('setModal').classList.add('hidden');
    await duplicateProject(P.id, true);
  };

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
  function capPlugin(name) {
    var Cap = window.Capacitor;
    if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return null;
    return (Cap.Plugins && Cap.Plugins[name]) || (Cap.registerPlugin ? Cap.registerPlugin(name) : null);
  }
  // ذخیره‌ی مستقیم در Music/SedaStudio روی گوشی
  async function saveToDevice(bytes, name, mime) {
    var AS = capPlugin('AudioSaver');
    if (!AS) throw new Error('NO_PLUGIN');
    await AS.begin({ name: name, mime: mime });
    try {
      var CH = 3 * 256 * 1024;
      for (var o = 0; o < bytes.length; o += CH) {
        await AS.append({ data: toBase64(bytes.subarray(o, o + CH)) });
        $('busyMsg').textContent = 'در حال ذخیره روی گوشی… ' + fa(Math.round(Math.min(1, (o + CH) / bytes.length) * 100)) + '٪';
      }
      return await AS.finish();
    } catch (e) {
      try { await AS.abort(); } catch (e2) {}
      throw e;
    }
  }
  async function shareBytes(bytes, name) {
    var FS = capPlugin('Filesystem'), SH = capPlugin('Share');
    if (!FS || !SH) throw new Error('NO_SHARE');
    var w = await FS.writeFile({ path: name, data: toBase64(bytes), directory: 'CACHE' });
    await SH.share({ title: name, url: w.uri, dialogTitle: 'ذخیره یا ارسال آهنگ' });
  }
  function showResult(title, path, canShare) {
    $('resTitle').textContent = title;
    $('resPath').textContent = path;
    $('resShare').classList.toggle('hidden', !canShare);
    $('resModal').classList.remove('hidden');
  }
  function closeResult() { $('resModal').classList.add('hidden'); lastExport = null; }
  $('resClose').onclick = closeResult;
  $('resShare').onclick = async function () {
    if (!lastExport) return;
    try { await shareBytes(lastExport.bytes, lastExport.name); } catch (e) { toast('اشتراک‌گذاری ناموفق بود'); }
  };

  async function doExport() {
    var dur = totalDuration();
    if (!dur) { toast('چیزی برای خروجی گرفتن نیست'); return; }
    var base = ($('exName').value.trim() || 'آهنگ من').replace(/[\\/:*?"<>|]/g, '_');
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
      var bytes, mime, fname = base + '.' + fmt;
      if (fmt === 'wav') { $('busyMsg').textContent = 'در حال ساخت WAV…'; await sleep(20); bytes = DSP.encodeWAV(chans, sr); mime = 'audio/wav'; }
      else { bytes = await encodeMp3(chans, sr, 192); mime = 'audio/mpeg'; }

      var native = !!capPlugin('AudioSaver');
      if (native) {
        try {
          var r = await saveToDevice(bytes, fname, mime);
          lastExport = { bytes: bytes, name: fname };
          await busy(null);
          showResult('آهنگ روی گوشی ذخیره شد ✓', 'پوشه‌ی Music ← SedaStudio ← ' + fname + '\n(در برنامه‌ی موزیک یا فایل‌های گوشی پیدا می‌شود)', !!capPlugin('Share'));
          return;
        } catch (e) {
          toast('ذخیره‌ی مستقیم ممکن نشد؛ از منوی اشتراک‌گذاری ذخیره کنید');
          await shareBytes(bytes, fname);
        }
      } else {
        var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        var a = document.createElement('a'); a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('آهنگ آماده شد ✓');
      }
    } catch (e) {
      if (!(e && e.message && /cancel|dismiss|NO_SHARE/i.test(e.message))) toast('ساخت خروجی ناموفق بود');
    }
    await busy(null);
  }
  $('btnExport').onclick = function () {
    if (!totalDuration()) { toast('اول چیزی ضبط یا آپلود کنید'); return; }
    $('exName').value = P ? P.name : 'آهنگ من';
    $('modal').classList.remove('hidden');
  };
  $('exCancel').onclick = function () { $('modal').classList.add('hidden'); };
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
  $('exGo').onclick = doExport;

  // ───────── دکمه‌ی برگشت اندروید و ذخیره هنگام خروج ─────────
  function onBack() {
    var layers = ['resModal', 'modal', 'setModal'];
    for (var i = 0; i < layers.length; i++) {
      if (!$(layers[i]).classList.contains('hidden')) { if (layers[i] === 'resModal') closeResult(); else $(layers[i]).classList.add('hidden'); return; }
    }
    if ($('home').classList.contains('hidden')) { showHome(); return; }
    var A = capPlugin('App');
    if (A && A.exitApp) A.exitApp();
  }
  (function () {
    var A = capPlugin('App');
    if (A && A.addListener) A.addListener('backButton', onBack);
  })();
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', function () { saveNow(); });

  // ───────── راه‌اندازی ─────────
  window.addEventListener('resize', function () { updateLayout(); });
  if (window.ResizeObserver) new ResizeObserver(function () { updateLayout(); }).observe(scroller);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { dirty = true; });
  window.SedaStudio = {
    S: S, play: play, pause: pause, addClip: addClip, newTrack: newTrack, changed: changed, ensureCtx: ensureCtx,
    buildMix: buildMix, totalDuration: totalDuration, saveNow: saveNow, listProjects: listProjects,
    getP: function () { return P; }, hist: function () { return hist.length; }
  };
  syncUndoBtns();
  requestAnimationFrame(tick);

  (async function boot() {
    try { db = await dbOpen(); } catch (e) { db = null; }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    ensureCtx();
    if (!db) {
      toast('ذخیره‌ی پروژه روی این دستگاه ممکن نیست');
      P = { id: 'tmp', name: 'پروژه', created: Date.now() };
      showProject(); setSaveState('err');
      return;
    }
    var list = await listProjects();
    if (!list.length) await createProject('پروژه ۱');
    else { showProject(); await showHome(); }
  })();
})();
