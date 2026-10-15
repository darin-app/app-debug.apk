import subprocess, time, sys, os, re
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable,'-m','http.server','8765','-d','www'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
errors=[]
try:
  with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
    c = b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,permissions=['microphone'],accept_downloads=True)
    pg = c.new_page()
    pg.on('console',lambda m: errors.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errors.append(str(e)))
    pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(500)
    # ۱) آپلود بیت و ویس
    with pg.expect_file_chooser() as fc: pg.click('#btnAddBeat')
    fc.value.set_files('/tmp/e2e/beat.wav'); pg.wait_for_timeout(800)
    with pg.expect_file_chooser() as fc: pg.click('#btnAddVoice')
    fc.value.set_files('/tmp/e2e/voice.wav'); pg.wait_for_timeout(800)
    n = pg.evaluate('SedaStudio.S.tracks.length'); print('tracks after upload:', n); assert n==2
    # ۲) حذف نویز روی ویس انتخاب‌شده
    rms=lambda: pg.evaluate('''()=>{const f=SedaStudio.S.tracks[1].clips[0].buffer.getChannelData(0);let s=0;for(let i=0;i<20000;i++)s+=f[i]*f[i];return Math.sqrt(s/20000)}''')
    before=rms(); pg.click('#edDenoise'); pg.wait_for_function("document.getElementById('busy').classList.contains('hidden')",timeout=20000); pg.wait_for_timeout(300)
    after=rms(); print('noise rms %.4f -> %.4f'%(before,after)); assert after<before*0.4
    assert not pg.is_hidden('#edRestore')
    # ۳) برش در ثانیه ۴
    pg.evaluate('SedaStudio.S.playhead=4'); pg.click('#edSplit'); pg.wait_for_timeout(200)
    k = pg.evaluate('SedaStudio.S.tracks[1].clips.length'); print('voice clips after split:', k); assert k==2
    # ۴) کم کردن صدا با اسلایدر
    pg.evaluate("(()=>{const e=document.getElementById('edGain');e.value=50;e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'))})()")
    assert abs(pg.evaluate('SedaStudio.S.tracks[1].clips[1].gain')-0.5)<1e-6
    # ۵) پخش
    pg.evaluate('SedaStudio.S.playhead=0'); pg.click('#btnPlay'); pg.wait_for_timeout(1200)
    ph = pg.evaluate('SedaStudio.S.playhead'); print('playhead after 1.2s play: %.2f'%ph); assert 0.7<ph<1.6
    pg.screenshot(path='/tmp/e2e/ui_playing.png'); pg.click('#btnPlay')
    # ۶) ضبط با میکروفون جعلی (۲ ثانیه)
    pg.evaluate('SedaStudio.S.playhead=0'); pg.click('#btnRec'); pg.wait_for_timeout(2200); pg.screenshot(path='/tmp/e2e/ui_recording.png'); pg.click('#btnRec')
    pg.wait_for_function("SedaStudio.S.tracks.length===3",timeout=8000)
    d = pg.evaluate('SedaStudio.S.tracks[2].clips[0].dur'); print('recorded dur %.2f'%d); assert 1.5<d<3.5
    # ۷) خروجی WAV و MP3
    for fmt in ['wav','mp3']:
        pg.click('#btnExport'); pg.click(f'.seg label:has(input[value={fmt}])')
        with pg.expect_download(timeout=60000) as dl: pg.click('#exGo')
        path=f'/tmp/e2e/out.{fmt}'; dl.value.save_as(path); print(fmt,'size',os.path.getsize(path), dl.value.suggested_filename)
        pg.wait_for_function("document.getElementById('busy').classList.contains('hidden')",timeout=30000)
    # ۸) عقب‌گرد
    pg.click('#btnUndo'); print('undo ok, tracks:', pg.evaluate('SedaStudio.S.tracks.length'))
    pg.evaluate('SedaStudio.S.playhead=0'); pg.wait_for_timeout(200); pg.screenshot(path='/tmp/e2e/ui_main.png')
    b.close()
finally:
  srv.terminate()
print('JS errors:', errors)
