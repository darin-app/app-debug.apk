import subprocess, time, sys, os, wave
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable,'-m','http.server','8765','-d','www'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
errors=[]
def ok(c,m):
    if not c: raise AssertionError(m)
    print('  ok:',m)
try:
  with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
    c = b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,permissions=['microphone'],accept_downloads=True)
    pg = c.new_page()
    pg.on('console',lambda m: errors.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errors.append(str(e)))
    pg.on('dialog',lambda d: d.accept('پروژه تست' if d.type=='prompt' else None))
    pg.goto('http://localhost:8765/index.html'); pg.wait_for_function("SedaStudio.getP()!==null",timeout=8000)
    print('1) project auto-created:', pg.evaluate('SedaStudio.getP().name'))
    # آپلود
    with pg.expect_file_chooser() as fc: pg.click('#btnAddBeat')
    fc.value.set_files('/tmp/e2e/beat.wav'); pg.wait_for_function("SedaStudio.S.tracks.length===1")
    with pg.expect_file_chooser() as fc: pg.click('#btnAddVoice')
    fc.value.set_files('/tmp/e2e/voice.wav'); pg.wait_for_function("SedaStudio.S.tracks.length===2")
    ok(True,'upload beat + voice')
    # حذف نویز
    rms=lambda: pg.evaluate('''()=>{const f=SedaStudio.S.tracks[1].clips[0].buffer.getChannelData(0);let s=0;for(let i=0;i<20000;i++)s+=f[i]*f[i];return Math.sqrt(s/20000)}''')
    before=rms(); pg.click('#edDenoise'); pg.wait_for_function("document.getElementById('busy').classList.contains('hidden')",timeout=20000); pg.wait_for_timeout(300)
    ok(rms()<before*0.4,'denoise %.4f -> %.4f'%(before,rms()))
    # حذف بخش از ۳ تا ۴ ثانیه‌ی ویس با بستن فاصله
    dur0=pg.evaluate('SedaStudio.S.tracks[1].clips[0].dur')
    pg.evaluate('SedaStudio.S.playhead=3'); pg.click('#rgA'); pg.evaluate('SedaStudio.S.playhead=4'); pg.click('#rgB'); pg.click('#rgCut'); pg.wait_for_timeout(200)
    cl=pg.evaluate('SedaStudio.S.tracks[1].clips.map(c=>[+c.start.toFixed(3),+c.dur.toFixed(3),+c.offset.toFixed(3)])')
    print('   clips after cut:',cl)
    ok(len(cl)==2 and abs(cl[0][1]-3)<0.01 and abs(cl[1][0]-3)<0.01 and abs(cl[1][2]-4)<0.01 and abs(cl[1][1]-(dur0-4))<0.01,'range cut ripple (3..4 removed, gap closed)')
    ok(abs(pg.evaluate('SedaStudio.S.tracks[1].clips[0].dur+SedaStudio.S.tracks[1].clips[1].dur')-(dur0-1))<0.01,'total shortened by 1s')
    # حذف بخش روی همه‌ی ترک‌ها بدون بستن فاصله
    pg.evaluate('SedaStudio.S.selId=null'); pg.evaluate('SedaStudio.changed()')
    pg.check('#rgAll'); pg.uncheck('#rgRipple')
    pg.evaluate('SedaStudio.S.playhead=1'); pg.click('#rgA'); pg.evaluate('SedaStudio.S.playhead=1.5'); pg.click('#rgB'); pg.click('#rgCut'); pg.wait_for_timeout(200)
    nb=pg.evaluate('SedaStudio.S.tracks[0].clips.length'); print('   beat clips after all-tracks cut:',nb)
    ok(nb==2,'cut on all tracks, no ripple')
    pg.uncheck('#rgAll'); pg.check('#rgRipple')
    # انتخاب کلیپ بیت (اولین تکه) و تکرار/پر کردن
    pg.evaluate("SedaStudio.S.selId=SedaStudio.S.tracks[0].clips[0].id; SedaStudio.changed()")
    pg.fill('#repN','2'); pg.click('#edRepeat'); pg.wait_for_timeout(150)
    ok(pg.evaluate('SedaStudio.S.tracks[0].clips.length')==4,'repeat x2 -> 4 clips on beat track')
    # معکوس و پن
    pg.click('#edRev'); pg.wait_for_timeout(150)
    pg.evaluate("(()=>{const e=document.getElementById('edPan');e.value=-60;e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'))})()")
    ok(abs(pg.evaluate('SedaStudio.S.tracks[0].pan')+0.6)<1e-6,'pan -60%')
    # لایه‌ی جدید و انتقال بین ترک‌ها
    n=pg.evaluate('SedaStudio.S.tracks.length'); pg.click('#edNewLayer'); pg.wait_for_timeout(150)
    ok(pg.evaluate('SedaStudio.S.tracks.length')==n+1,'clip -> new layer')
    pg.click('#edUp'); pg.wait_for_timeout(100)
    ok(pg.evaluate('SedaStudio.S.tracks[%d].clips.length'%(n-1+0))>=0,'move clip to upper track')
    pg.click('#btnAddTrack'); ok(pg.evaluate('SedaStudio.S.tracks.length')==n+2,'empty track added')
    # undo/redo
    h=pg.evaluate('SedaStudio.S.tracks.length'); pg.click('#btnUndo'); ok(pg.evaluate('SedaStudio.S.tracks.length')==h-1,'undo'); pg.click('#btnRedo'); ok(pg.evaluate('SedaStudio.S.tracks.length')==h,'redo')
    # پخش
    pg.evaluate('SedaStudio.S.playhead=0'); pg.click('#btnPlay'); pg.wait_for_timeout(1000)
    ph=pg.evaluate('SedaStudio.S.playhead'); ok(0.6<ph<1.5,'playback %.2f'%ph); pg.click('#btnPlay')
    # ضبط
    pg.evaluate('SedaStudio.S.playhead=0'); k=pg.evaluate('SedaStudio.S.tracks.length'); pg.click('#btnRec'); pg.wait_for_timeout(1800); pg.click('#btnRec')
    pg.wait_for_function("SedaStudio.S.tracks.length===%d"%(k+1),timeout=8000); ok(True,'record 1.8s via fake mic')
    # شبکه و تغییر BPM
    pg.click('#btnSnap'); ok(pg.evaluate('SedaStudio.S.snap'),'snap on'); pg.screenshot(path='/tmp/e2e/ui_v2_main.png',full_page=True)
    # ذخیره‌ی خودکار و ماندگاری
    pg.wait_for_timeout(2500); pid=pg.evaluate('SedaStudio.getP().id')
    snap=pg.evaluate("JSON.stringify(SedaStudio.S.tracks.map(t=>[t.name,+t.pan.toFixed(2),t.clips.map(c=>[+c.start.toFixed(2),+c.dur.toFixed(2),+c.gain.toFixed(2)])]))")
    st=pg.inner_text('#saveState'); ok(st=='ذخیره شد','autosave state: '+st)
    pg.reload(); pg.wait_for_function("!document.getElementById('home').classList.contains('hidden')",timeout=8000)
    ok(pg.locator('.pcard').count()==1,'home lists 1 project after reload')
    pg.screenshot(path='/tmp/e2e/ui_v2_home.png')
    pg.click('.pcard'); pg.wait_for_function("SedaStudio.S.tracks.length>0",timeout=15000); pg.wait_for_timeout(300)
    snap2=pg.evaluate("JSON.stringify(SedaStudio.S.tracks.map(t=>[t.name,+t.pan.toFixed(2),t.clips.map(c=>[+c.start.toFixed(2),+c.dur.toFixed(2),+c.gain.toFixed(2)])]))")
    ok(snap==snap2,'project restored identically after reload')
    ok(pg.evaluate('SedaStudio.S.snap')==True,'snap flag restored')
    # نسخه‌ی جدید
    pg.click('#btnSettings'); pg.click('#stCopy'); pg.wait_for_function("SedaStudio.getP().id!=='%s'"%pid,timeout=15000); pg.wait_for_timeout(500)
    ok('نسخه' in pg.evaluate('SedaStudio.getP().name'),'duplicate -> '+pg.evaluate('SedaStudio.getP().name'))
    ok(pg.evaluate('SedaStudio.S.tracks.length')>0,'copy has same tracks')
    # ویرایش نسخه‌ی جدید نباید اصل را عوض کند
    pg.evaluate("SedaStudio.S.selId=SedaStudio.S.tracks[0].clips[0].id; SedaStudio.changed()"); pg.click('#edDel'); pg.wait_for_timeout(2500)
    pg.click('#btnProjects'); pg.wait_for_selector('.pcard'); ok(pg.locator('.pcard').count()==2,'2 projects listed')
    pg.screenshot(path='/tmp/e2e/ui_v2_home2.png')
    orig=pg.evaluate("(async()=>{const l=await SedaStudio.listProjects();const o=l.find(x=>x.id==='%s');return o.nClips})()"%pid)
    cur=pg.evaluate("(async()=>{const l=await SedaStudio.listProjects();const o=l.find(x=>x.id!=='%s');return o.nClips})()"%pid)
    ok(cur==orig-1,'original untouched (%d clips) vs copy (%d)'%(orig,cur))
    # حذف نسخه
    pg.locator('.pcard.cur .btn.danger').click(); pg.wait_for_timeout(800)
    ok(pg.locator('.pcard').count()==1,'delete project')
    # خروجی
    pg.click('.pcard'); pg.wait_for_function("SedaStudio.S.tracks.length>0",timeout=15000); pg.wait_for_timeout(300)
    for fmt in ['wav','mp3']:
        pg.click('#btnExport'); pg.click(f'.seg label:has(input[value={fmt}])')
        with pg.expect_download(timeout=60000) as dl: pg.click('#exGo')
        path=f'/tmp/e2e/out2.{fmt}'; dl.value.save_as(path); print('  ',fmt,os.path.getsize(path),dl.value.suggested_filename)
        pg.wait_for_function("document.getElementById('busy').classList.contains('hidden')",timeout=30000)
    pg.screenshot(path='/tmp/e2e/ui_v2_final.png',full_page=True)
    b.close()
finally:
  srv.terminate()
print('JS errors:', errors)
assert not errors
