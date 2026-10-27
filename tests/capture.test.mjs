// Tests fuer extension/capture.js im installierten Chrome (headless, ohne Extension).
// Lauf: cd tools/yoink/tests && npm install && npm test
//
// Maßstab ist das Ergebnis: element.html gerendert muss aussehen wie das Original.
// Negativkontrolle: nacktes outerHTML ohne Styles muss denselben Vergleich verfehlen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AUSWAHL = readFileSync(fileURLToPath(new URL('../extension/picker.js', import.meta.url)), 'utf8');
const ERFASSEN = readFileSync(fileURLToPath(new URL('../extension/capture.js', import.meta.url)), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

const KARTE_CSS = `
  body { background: #eef2ff; font-family: Georgia, serif; margin: 0; padding: 40px; }
  .karte { display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 24px; border-radius: 16px;
    background: linear-gradient(135deg, #4f46e5, #9333ea); color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,.25);
    font-family: Helvetica, Arial, sans-serif; }
  .karte h3 { margin: 0; font-size: 22px; letter-spacing: -.02em; }
  .karte p { margin: 0; font-size: 14px; line-height: 1.5; opacity: .85; }
  .karte .knopf { align-self: flex-start; padding: 8px 14px; border: 0; border-radius: 999px; background: #fff; color: #4f46e5; font-weight: 700; }
  .karte .knopf:hover { background: #ffe; }
  @media (max-width: 5000px) { .karte { border: 2px solid rgba(255,255,255,.4); } }
  @keyframes puls { from { transform: scale(1); } to { transform: scale(1.02); } }
  .karte .punkt { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; animation: puls 1s paused; }
  .karte img { width: 16px; height: 16px; }
  .fremd { color: red; }
  .badge::before { content: "NEU"; display: inline-block; padding: 2px 6px; border-radius: 4px; background: #f59e0b; color: #111; font-size: 11px; margin-right: 6px; }
`;

const KARTE_HTML = `
  <div class="fremd">fremd</div>
  <div class="karte" id="ziel">
    <span class="punkt"></span>
    <h3 class="badge">Karte</h3>
    <p>Ein Absatz mit Text, der umbricht und zeigt, ob Schrift und Zeilenhöhe passen.</p>
    <button class="knopf" onclick="alert(1)">Los</button>
    <input type="hidden" name="csrf" value="geheim-token">
    <input type="text" value="geheim-eingabe">
    <a href="javascript:alert(1)">js</a> <a href="/relativ">rel</a>
    <img src="/image.png" alt="">
    <script>window.x = 1</script>
  </div>`;

const ZUSTAND_CSS = `
  .kachel { padding: 8px; border: 1px solid #ddd; }
  .kachel[aria-pressed="true"] { background: #fef3d6; border-color: #f79009; }
  .kachel[aria-pressed="false"] { background: #ffffff; }
  .kachel:not([aria-pressed="true"]):hover { background: #fafafa; }
  .fremd-zustand[aria-pressed="false"] { color: red; }
`;
const KACHELN = (...w) => w.map((v, i) => `<button class="kachel" aria-pressed="${v}">K${i}</button>`).join('');
const FREMD_SCHRIFT_CSS = `@font-face { font-family: Fremdschrift; src: url(/fremd.woff2) format("woff2"); }
.mit-fremd-bg { background-image: url(/fremd-bg.png); }
.nicht-im-element { color: red; }`;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
const SRCDOC = '<!doctype html><html><head><title>Anmeldung mit Glas</title><script src="https://cdn.tailwindcss.com/3.4.1"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body style="margin:0;background:#2563eb;color:#fff;font:16px sans-serif"><form class="p-4 backdrop-blur"><input placeholder="Mail"> <button>Los</button></form></body></html>';
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const SCHRIFT = Buffer.from('wOF2-test-schriftdatei-' + 'x'.repeat(200));

let browser, server, fremdServer, basis, fremdBasis;

function starten(routen) {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      const r = routen[req.url.split('?')[0]];
      if (!r) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': r[0].startsWith('text/') ? `${r[0]}; charset=utf-8` : r[0], ...(r[2] || {}) });
      res.end(r[1]);
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

before(async () => {
  fremdServer = await starten({
    '/fremd-schrift.css': ['text/css', FREMD_SCHRIFT_CSS],
    '/fremd.woff2': ['font/woff2', SCHRIFT],
    '/fremd-bg.png': ['image/png', PNG],
    '/fremd-seite.html': ['text/html', '<!doctype html><html><body style="margin:0;background:#16a34a">fremd</body></html>'],
    '/fremd.css': ['text/css', '.nur-fremd { width: 200px; padding: 20px; background: rgb(14, 165, 233); border-radius: 12px; color: #fff; font: 700 18px/1.3 Helvetica, sans-serif; }'] });
  fremdBasis = `http://127.0.0.1:${fremdServer.address().port}`;
  server = await starten({
    '/karte.html': ['text/html', `<!doctype html><html><head><style>${KARTE_CSS}</style></head><body>${KARTE_HTML}</body></html>`],
    '/fremd.html': ['text/html', `<!doctype html><html><head><link rel="stylesheet" href="${fremdBasis}/fremd.css"></head><body style="margin:0;padding:40px;background:#fff7ed"><div class="nur-fremd" id="ziel">Nur fremdes Stylesheet</div></body></html>`],
    '/leinwand.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:40px"><div id="ziel" style="position:absolute;top:30px;left:50px;padding:8px;background:#eee"><canvas width="80" height="40"></canvas></div><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#e11d48';c.fillRect(0,0,80,40);</script></body></html>`],
    '/image.png': ['image/png', PNG],
    '/zustand.html': ['text/html', `<!doctype html><html><head><style>${ZUSTAND_CSS}</style></head><body><div id="ziel">${KACHELN('true', 'true', 'true')}</div></body></html>`],
    '/zustand-gemischt.html': ['text/html', `<!doctype html><html><head><style>${ZUSTAND_CSS}</style></head><body><div id="ziel">${KACHELN('true', 'false', 'true')}</div></body></html>`],
    '/zustand-skript.html': ['text/html', `<!doctype html><html><head><style>.an { background: #fef3d6; } .aus { background: #fff; }</style></head><body><div id="ziel"><button class="an" aria-pressed="true">A</button><button class="an" aria-pressed="true">B</button></div></body></html>`],
    '/schrift.html': ['text/html', `<!doctype html><html><head><style>
      @font-face { font-family: Testschrift; src: url(/schriften/test-schrift.woff2) format("woff2"); }
      @font-face { font-family: Fehlschrift; src: url(/schriften/fehlt.woff2) format("woff2"); }
      #ziel { font-family: Testschrift, Fehlschrift, sans-serif; }
    </style></head><body><p id="ziel">Text</p></body></html>`],
    '/schriften/test-schrift.woff2': ['font/woff2', SCHRIFT],
    '/fremdschrift.html': ['text/html', `<!doctype html><html><head><link rel="stylesheet" href="${fremdBasis}/fremd-schrift.css"></head><body><div id="ziel"><p style="font-family: Fremdschrift, sans-serif">Fremd</p><p style="font-family: Helvetica, sans-serif">System</p><div class="mit-fremd-bg" style="width: 20px; height: 20px"></div></div></body></html>`],
    '/leer.html': ['text/html', `<!doctype html><html><body style="margin:0"><section id="ziel" style="position: relative; height: 200px; background: #eee"><div class="inhalt">Text</div><div class="form-unten welle" style="position: absolute; left: 0; right: 0; top: 210px"></div><div class="deko" style="width: 20px; height: 20px; background: red"></div><span class="trenner"></span></section></body></html>`],
    '/bilder.html': ['text/html', `<!doctype html><html><body><div id="ziel" style="width: 100px; height: 60px; background-image: url(/bg.png?v=1&x=2)"><img src="/image.png" alt=""><div style="width: 10px; height: 10px; background: linear-gradient(red, blue)"></div><div style="width: 10px; height: 10px; background-image: url(data:image/png;base64,${PNG.toString('base64')})"></div><div style="width: 10px; height: 10px; background-image: url(${fremdBasis}/fremd-bg.png)"></div></div></body></html>`],
    '/bg.png': ['image/png', PNG],
    '/kopf.html': ['text/html', `<!doctype html><html><body style="margin:0;height:3000px"><header id="kopf" style="position:fixed;top:0;left:0;right:0;height:100px;background:#c00;z-index:10"><span id="kopf-kind" style="visibility:visible;display:block;height:50px;background:#900">Kind</span></header><div id="badge" style="position:fixed;right:0;bottom:0;width:20px;height:20px;background:#0c0"></div><div style="height:500px"></div><div id="ziel" style="height:850px;background:#00f"><div id="innen" style="position:sticky;top:0;height:10px;background:#ff0"></div></div><div id="ueber" style="position:absolute;top:520px;left:0;width:300px;height:60px;background:#0f0">Überlagert</div><div id="neben" style="position:absolute;top:1400px;left:0;width:300px;height:60px;background:#0f0">Darunter</div></body></html>`],
    '/kopf-skript.html': ['text/html', `<!doctype html><html><body style="margin:0;height:3000px"><header id="kopf" style="height:80px;background:#c00;top:0;left:0;right:0">Kopf</header><div style="height:600px"></div><div id="ziel" style="height:880px;background:#00f"></div><script>addEventListener('scroll', () => setTimeout(() => { const k = document.getElementById('kopf'); if (scrollY > 0) { k.style.position = 'fixed'; } else { k.style.position = ''; } }, 100));</script></body></html>`],
    '/rahmen.html': ['text/html', `<!doctype html><html><head><style>*, ::before, ::after { border: 0 solid; box-sizing: border-box; }</style></head><body style="margin:0;padding:20px;background:#fff"><div id="ziel" style="font: 16px Helvetica, Arial, sans-serif; padding: 10px; width: 300px"><p style="margin:0">Text ohne Rahmen</p><span style="border-width:2px;border-color:#000">mit Rahmen</span></div></body></html>`],
    '/titel.html': ['text/html', `<!doctype html><html><body><div id="ziel"><button><h2 style="height:0;overflow:hidden;margin:0">Menü</h2></button><h2 style="display:none">Versteckt</h2><h3>Echte Überschrift</h3><p>Text</p></div></body></html>`],
    '/gewicht.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px;font: 400 16px Helvetica, Arial, sans-serif;color:#222;background:#fff"><div id="ziel" style="width:300px"><h3 class="dach" style="font-weight:400;font-size:16px;margin:0">Austausch geheimer Informationen</h3><a href="#x" style="color:inherit;text-decoration:none">Link in Textfarbe</a> <b style="font-weight:inherit">nicht fett</b></div></body></html>`],
    '/lazy.html': ['text/html', `<!doctype html><html><body><div id="ziel"><img loading="lazy" decoding="async" alt="Poster" src="/image.png" style="width:100px;height:100px"></div></body></html>`],
    '/pseudoschrift.html': ['text/html', `<!doctype html><html><head><style>
      @font-face { font-family: Iconschrift; src: url(/schriften/icon.woff2) format("woff2"); }
      @font-face { font-family: Fehlicon; src: url(/schriften/fehlt-icon.woff2) format("woff2"); }
      .a::before { content: "x"; font-family: Iconschrift; }
      .b::before { content: "y"; font-family: Fehlicon; }
    </style></head><body><div id="ziel" style="font-family: Helvetica"><span class="a"></span> <span class="b"></span> Text</div></body></html>`],
    '/schriften/icon.woff2': ['font/woff2', SCHRIFT],
    '/css/haupt.css': ['text/css', `:root { --pfeil: url(../icon/pfeil.svg); }
      #ziel .knopf { width: 20px; height: 20px; background-image: var(--pfeil); }
      #ziel .knopf:hover { background-image: url(../icon/hover.svg); }
      #ziel .punkt { background-image: url(data:image/gif;base64,R0lGODlhAQABAAAAACw=); }`],
    '/icon/pfeil.svg': ['image/svg+xml', SVG],
    '/icon/hover.svg': ['image/svg+xml', SVG],
    '/relativ.html': ['text/html', `<!doctype html><html><head><link rel="stylesheet" href="/css/haupt.css"></head><body><div id="ziel"><span class="knopf" style="display:inline-block"></span><span class="punkt"></span></div></body></html>`],
    '/rauschen.html': ['text/html', `<!doctype html><html><body><div id="ziel" style="position:relative"><div style="display:none"><button aria-pressed="false">a</button><button aria-pressed="false">b</button><span class="leer-weg"></span></div><div style="opacity:0"><span class="leer-durchsichtig"></span></div><p>Text <span class="leer-sichtbar"></span></p></div></body></html>`],
    '/video.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px;background:#fff"><div id="ziel" style="width:320px;height:200px;border-radius:16px;overflow:hidden;border:1px solid #ccc"><div id="mitte" style="width:320px;height:200px;position:relative;background:#111"><video id="v" src="/clip.mp4" preload="none" autoplay muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video></div></div></body></html>`],
    '/video-source.html': ['text/html', `<!doctype html><html><body><div id="ziel" style="width:400px"><p>Text daneben mit genug Fläche, damit das Video klein bleibt.</p><div style="height:300px;background:#eee"></div><video width="40" height="30" preload="none"><source src="/clip.webm" type="video/webm"></video></div></body></html>`],
    '/video-strom.html': ['text/html', `<!doctype html><html><body><div id="ziel"><video id="v" width="200" height="100"></video></div><script>document.getElementById('v').src = URL.createObjectURL(new Blob(['x'], { type: 'video/mp4' }));</script></body></html>`],
    '/webgl.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><div id="ziel" style="width:200px;padding:10px;background:#eee"><canvas id="c" width="200" height="100"></canvas><iframe src="/karte.html?token=geheim123" width="200" height="80" style="border:0"></iframe></div><script>const g=document.getElementById('c').getContext('webgl');g.clearColor(1,0,0,1);g.clear(g.COLOR_BUFFER_BIT);</script></body></html>`],
    '/huelle-gross.html': ['text/html', `<!doctype html><html><body><div style="width:600px;border-radius:16px;overflow:hidden;padding:40px;background:#eee"><div id="ziel" style="width:200px;height:100px;background:#00f"></div></div></body></html>`],
    '/huelle-schlicht.html': ['text/html', `<!doctype html><html><body><div style="width:200px"><div id="ziel" style="width:200px;height:100px;background:#00f"></div></div></body></html>`],
    '/clip.mp4': ['video/mp4', Buffer.from('mp4-test')],
    '/nur-medium.html': ['text/html', `<!doctype html><html><body><div id="ziel" style="width:200px;height:120px"><div><video aria-label="Screenshot of Notion" src="/clip.mp4" width="200" height="120"></video></div></div><div id="leer" style="width:50px;height:50px;background:#eee"></div></body></html>`],
    '/lazy-liste.html': ['text/html', `<!doctype html><html><head><title>Lazyseite - Testseite</title></head><body style="margin:0"><div id="ziel" style="width:300px">${
      Array.from({ length: 10 }, (_, i) => `<div class="eintrag"><h3>Video ${i + 1}</h3><img data-src="/image.png?n=${i}" alt="" style="width:100px;height:50px;display:block;visibility:hidden" onload="this.style.visibility='visible'"><div style="height:300px"></div></div>`).join('')
    }<div style="display:none"><img alt="versteckt"></div></div><script>
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && e.target.dataset.src) { e.target.src = e.target.dataset.src; io.unobserve(e.target); } }));
      document.querySelectorAll('img[data-src]').forEach((i) => io.observe(i));
    </script></body></html>`],
    '/menue-liste.html': ['text/html', `<!doctype html><html><head><title>Menüseite</title></head><body><nav id="ziel"><h2>Menü</h2><ul>${Array.from({ length: 6 }, (_, i) => `<li class="punkt"><a href="#${i}">Punkt ${i}</a></li>`).join('')}</ul></nav></body></html>`],
    '/streifen.html': ['text/html', `<!doctype html><html><head><title>Streifen</title></head><body style="margin:0;padding:0 0 400px 40px"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:rgb(255,0,0);z-index:5"></header><div style="height:100px"></div><div id="ziel" style="width:300px">${
      ['rgb(0,0,255)', 'rgb(0,128,0)', 'rgb(255,165,0)', 'rgb(128,0,128)', 'rgb(0,128,128)', 'rgb(128,128,0)', 'rgb(0,0,0)', 'rgb(255,192,203)']
        .map((c) => `<div style="height:300px;background:${c}"></div>`).join('')
    }</div></body></html>`],
    '/schrift-leer.html': ['text/html', `<!doctype html><html><head><style>
      @font-face { font-family: Leerschrift; src: url(/schriften/leer.woff2) format("woff2"); }
      @font-face { font-family: Testschrift; src: url(/schriften/test-schrift.woff2) format("woff2"); }
      #ziel { font-family: Leerschrift, sans-serif; }
    </style></head><body><div id="ziel"><div style="width:50px;height:50px;background:#00f"></div><p style="font-family:Testschrift">Text</p><span style="display:none">versteckt</span></div></body></html>`],
    '/schrift-genutzt.html': ['text/html', `<!doctype html><html><head><style>
      @font-face { font-family: Leerschrift; src: url(/schriften/leer.woff2) format("woff2"); }
      #ziel { font-family: Leerschrift, sans-serif; }
    </style></head><body><div id="ziel"><div style="width:50px;height:50px;background:#00f"></div><span>sichtbar</span></div></body></html>`],
    '/schriften/leer.woff2': ['font/woff2', SCHRIFT],
    '/bereich.html': ['text/html', `<!doctype html><html><body style="margin:0"><div id="kopf" style="position:fixed;top:0;left:0;width:1040px;height:40px;background:#c00;z-index:3"><span style="position:absolute;left:30px;top:10px;width:60px;height:20px;background:#fff">Kopf</span></div><div id="wrap" style="box-sizing:border-box;display:flex;align-items:flex-start;gap:20px;padding:20px;width:1040px"><div id="a" style="width:200px;height:150px;background:#00f;flex:none"><h3 style="margin:0">A</h3></div><div id="b" style="width:200px;height:150px;background:#0a0;flex:none">B</div><div id="c" style="width:560px;height:600px;background:#ccc;flex:none">C</div></div></body></html>`],
    '/zieh.html': ['text/html', `<!doctype html><html><body style="margin:0"><div id="wrap" style="display:flex;gap:20px;padding:20px"><div id="a" style="width:200px;height:150px;background:#00f;flex:none"></div><div id="b" style="width:200px;height:150px;background:#0a0;flex:none"><button id="knopf" onclick="window.__geklickt = (window.__geklickt || 0) + 1" style="display:block;width:100%;height:100%;border:0;background:#0a0;color:#fff">B</button></div></div></body></html>`],
    '/wachsend.html': ['text/html', `<!doctype html><html><body style="margin:0;padding-bottom:2000px"><div id="ziel" style="width:300px"><div style="height:1700px;background:rgb(0,0,255)"></div></div><script>
      let gewachsen = false;
      addEventListener('scroll', () => { if (!gewachsen && scrollY > 500) { gewachsen = true; const d = document.createElement('div'); d.style.cssText = 'height:900px;background:rgb(255,0,0)'; document.getElementById('ziel').appendChild(d); } });
    </script></body></html>`],
    '/nachladen.html': ['text/html', `<!doctype html><html><body style="margin:0;padding-bottom:1500px"><div id="ziel" style="width:300px;height:2400px;background:#eee"><div class="eintrag" style="height:100px;background:#00f"></div><div class="eintrag" style="height:100px;background:#0a0"></div></div><script>
      // laedt beim ersten Weg nach unten nach, das ist die Aufnahme (Durchscrollen ist seit 0.9.0 ein Extra)
      let oben = true, wege = 0;
      addEventListener('scroll', () => { if (scrollY < 100) oben = true; if (oben && scrollY > 300) { oben = false; if (++wege !== 1) return; for (let i = 0; i < 3; i++) { const d = document.createElement('div'); d.className = 'eintrag neu'; d.style.cssText = 'height:100px;background:#f80'; document.getElementById('ziel').appendChild(d); } } });
    </script></body></html>`],
    '/verschoben.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:40px;background:#fff"><div style="position:relative;width:600px;height:300px"><div id="ziel" style="position:absolute;left:0;top:0;transform:translate(8px, 5px);width:200px;height:100px;box-sizing:border-box;border:4px solid #000;background:#fc0"><span id="kind" style="display:inline-block;transform:translateX(6px);width:20px;height:20px;background:#00f"></span></div></div></body></html>`],
    '/kulisse.svg': ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="200" height="200" fill="#e11d48"/><rect x="200" width="200" height="200" fill="#2563eb"/></svg>')],
    '/kulisse.html': ['text/html', `<!doctype html><html><body style="margin:0;background:#fff"><section style="margin:30px;padding:40px;width:400px;height:200px;background:#333 url(/kulisse.svg) no-repeat 0 0 / 400px 200px;border:5px solid #999"><h2 id="ziel" style="margin:0 0 0 110px;width:200px;color:#fff;font:700 28px/1.2 Helvetica, Arial, sans-serif">Über dem Bild</h2></section></body></html>`],
    '/kulisse-ohne.html': ['text/html', `<!doctype html><html><body style="margin:0;background:#fff"><section style="padding:40px;background:#334"><h2 id="ziel" style="margin:0;width:200px;color:#fff;font:700 28px/1.2 Helvetica, Arial, sans-serif">Auf Farbe</h2></section></body></html>`],
    '/collapse.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:40px;background:#fff"><section id="ziel" style="background:#222;width:300px"><h2 style="margin:57px 0 10px;color:#fff;font:700 24px/1.2 Helvetica, Arial, sans-serif">Kopf</h2><p style="margin:0;color:#ccc;font:16px/1.4 Helvetica, Arial, sans-serif">Text</p></section></body></html>`],
    '/collapse-nicht.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:40px;background:#fff"><section id="ziel" style="background:#222;width:300px;padding-top:1px"><h2 style="margin:57px 0 10px;color:#fff;font:700 24px/1.2 Helvetica, Arial, sans-serif">Kopf</h2></section></body></html>`],
    '/canvas-viele.html': ['text/html', `<!doctype html><html><body><div id="ziel" style="width:400px;height:300px;background:#eee">${'<canvas width="10" height="10" style="display:inline-block"></canvas>'.repeat(6)}</div></body></html>`],
    '/schrift-data.html': ['text/html', `<!doctype html><html><head><style>@font-face { font-family: Datenschrift; src: url(data:font/woff2;base64,${SCHRIFT.toString('base64')}) format("woff2"); } #ziel { font-family: Datenschrift, sans-serif; }</style></head><body><p id="ziel">Text</p></body></html>`],
    '/bewegt.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><div id="ziel" style="width:220px;padding:10px;background:#eee"><canvas id="c" width="200" height="100"></canvas></div><script>const x = document.getElementById('c').getContext('2d'); let n = 0; (function malen() { x.fillStyle = 'hsl(' + (n++ * 7 % 360) + ', 80%, 50%)'; x.fillRect(0, 0, 200, 100); requestAnimationFrame(malen); })();</script></body></html>`],
    '/still.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><div id="ziel" style="width:220px;padding:10px;background:#eee"><canvas id="c" width="200" height="100"></canvas></div><script>const x = document.getElementById('c').getContext('2d'); x.fillStyle = '#e11d48'; x.fillRect(0, 0, 200, 100);</script></body></html>`],
    '/breiten.html': ['text/html', `<!doctype html><html><head><style>body{margin:0} .huelle{padding:30px} #ziel{height:120px;background:rgb(0,0,255)} @media (max-width: 500px) { #ziel { background: rgb(255,0,0); } } @media (min-width: 501px) and (max-width: 900px) { #ziel { background: rgb(0,160,0); } }</style></head><body><div class="huelle"><div><div id="ziel"></div></div></div></body></html>`],
    '/einbetten-verboten.html': ['text/html', `<!doctype html><html><body><div class="huelle"><div id="ziel" style="height:50px;background:#00f"></div></div></body></html>`, { 'x-frame-options': 'DENY' }],
    '/rahmenbrecher.html': ['text/html', `<!doctype html><html><body><div id="ziel" style="height:50px;background:#00f"></div><script>if (top !== self) top.location.href = '/weg.html';</script></body></html>`],
    '/rahmen-ohne-sandbox.html': ['text/html', `<!doctype html><html><body><iframe src="/rahmenbrecher.html" width="300" height="100"></iframe></body></html>`],
    '/weg.html': ['text/html', `<!doctype html><html><body>weg</body></html>`],
    '/raster.html': ['text/html', `<!doctype html><html><head><style>
      @font-face { font-family: Aussenschrift; src: url(/schriften/aussen.woff2) format("woff2"); }
      body { margin: 0; padding: 20px; background: #fff; font: 16px/1.3 Helvetica, Arial, sans-serif; }
      #raster { position: relative; display: flex; flex-wrap: wrap; gap: 20px; width: 680px; padding: 20px; background: #f4f4f5; }
      .karte { width: 200px; height: 150px; box-sizing: border-box; padding: 12px; border-radius: 12px; color: #fff; }
      .karte h3 { margin: 0 0 8px; font-size: 18px; }
      .karte img { width: 40px; height: 40px; display: block; }
    </style></head><body><div id="raster">
      <div class="karte" style="background:#2563eb"><h3>Karte 1</h3><img src="/innen.png" alt=""></div>
      <div class="karte" style="background:#16a34a"><h3>Karte 2</h3></div>
      <div class="karte" style="background:#9333ea"><h3>Karte 3</h3></div>
      <div class="karte" style="background:#ea580c"><h3>Karte 4</h3></div>
      <div class="karte" style="background:#0891b2"><h3>Karte 5</h3></div>
      <div class="karte" style="background:#be123c;color:rgb(1,2,3);font-family:Aussenschrift, sans-serif"><h3>Karte 6</h3><img src="/aussen.png" alt=""></div>
      <div style="position:absolute;right:0;bottom:0;width:60px;height:20px;background:#000;color:#fff">Abzeichen</div>
    </div></body></html>`],
    '/innen.png': ['image/png', PNG],
    '/aussen.png': ['image/png', PNG],
    '/schriften/aussen.woff2': ['font/woff2', SCHRIFT],
    '/rahmen-srcdoc.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><div id="karte" style="padding:20px;background:#eee"><iframe id="r" sandbox="allow-scripts" srcdoc="${escAttr(SRCDOC)}" style="display:block;width:300px;height:150px;border:0"></iframe></div></body></html>`],
    '/rahmen-gleich.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><iframe id="r" src="/karte.html" style="display:block;width:480px;height:420px;border:0"></iframe></body></html>`],
    '/rahmen-fremd.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><iframe id="r" src="${fremdBasis}/fremd-seite.html?token=geheim123" style="display:block;width:300px;height:120px;border:0"></iframe></body></html>`],
    '/quellen-weg.html': ['text/html', `<!doctype html><html><head><style>#ziel { padding: 8px; background: #fef3c7; }</style><style>.gibt-es-nicht { color: red; }</style></head><body><div id="ziel">Text</div></body></html>`],
    '/shader.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><div id="ziel" style="width:200px;padding:10px;background:#111"><canvas id="c" width="200" height="100"></canvas></div><script>
      const gl = document.getElementById('c').getContext('webgl');
      const VS = 'attribute vec2 p;\\nvoid main() { gl_Position = vec4(p, 0.0, 1.0); }';
      const FS = 'precision mediump float;\\nuniform float t;\\nvoid main() { gl_FragColor = vec4(0.5 + 0.5 * sin(t), 0.2, 0.8, 1.0); }';
      const mach = (typ, q) => { const s = gl.createShader(typ); gl.shaderSource(s, q); gl.compileShader(s); return s; };
      const prog = gl.createProgram(); gl.attachShader(prog, mach(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, mach(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      window.__VS = VS; window.__FS = FS;
    </script></body></html>`],
    '/rahmen-zwei.html': ['text/html', `<!doctype html><html><body style="margin:0;padding:20px"><section id="ziel" style="display:flex;gap:20px;padding:20px;background:#eee"><iframe sandbox="allow-scripts" srcdoc="${escAttr('<body style="margin:0;background:#dc143c">eins</body>')}" style="width:200px;height:100px;border:0"></iframe><iframe sandbox="allow-scripts" srcdoc="${escAttr('<body style="margin:0;background:#1e3cdc">zwei</body>')}" style="width:200px;height:100px;border:0"></iframe><iframe src="${fremdBasis}/fremd-seite.html" style="width:200px;height:100px;border:0"></iframe></section></body></html>`],
    '/skripte.html': ['text/html', `<!doctype html><html><head><script src="/werkzeug.js"></script><script>window.innen = 1;</script></head><body><div id="ziel">Text</div></body></html>`],
    '/werkzeug.js': ['text/javascript', 'window.werkzeug = function () { return 42; };'],
    '/tracking.html': ['text/html', `<!doctype html><html><head><script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script><script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('config', 'G-TEST');</script><script defer src="https://cloud.umami.is/script.js" data-website-id="x"></script><script src="/werkzeug.js"></script></head><body><div id="ziel">Text</div></body></html>`],
    '/farben.html': ['text/html', `<!doctype html><html><head><style>
      :root { --marke: #4f46e5; --marke-zwei: rgb(79, 70, 229); --abstand: 8px; --kanaele: 217 119 6; }
      #ziel { color: var(--marke); background: #f79009; padding: 8px; }
    </style></head><body><div id="ziel">Farbe</div></body></html>`],
  });
  basis = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
});

after(async () => {
  await browser?.close();
  server?.close();
  fremdServer?.close();
});

async function neueSeite() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  return p;
}

async function fangen(pfad) {
  const p = await neueSeite();
  await p.goto(basis + pfad, { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const erg = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#ziel')));
  const original = await (await p.$('#ziel')).screenshot({ encoding: 'base64' });
  const roh = await p.evaluate(() => document.querySelector('#ziel').outerHTML);
  await p.close();
  return { ...erg, original, roh };
}

async function rendern(html) {
  const p = await neueSeite();
  await p.setContent(html, { waitUntil: 'load' });
  const bild = await (await p.$('body > *')).screenshot({ encoding: 'base64' });
  await p.close();
  return bild;
}

// Anteil abweichender Pixel (Kanaldifferenz > 32). Groessenunterschied > 1 px zaehlt als 1.
async function abweichung(a, b) {
  const p = await neueSeite();
  const r = await p.evaluate(async (a, b) => {
    const laden = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
    const [ia, ib] = await Promise.all([laden(a), laden(b)]);
    if (Math.abs(ia.width - ib.width) > 1 || Math.abs(ia.height - ib.height) > 1) return { anteil: 1, groesse: [ia.width, ia.height, ib.width, ib.height] };
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const daten = (i) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = daten(ia), db = daten(ib);
    let anders = 0;
    for (let k = 0; k < da.length; k += 4) {
      if (Math.max(Math.abs(da[k] - db[k]), Math.abs(da[k + 1] - db[k + 1]), Math.abs(da[k + 2] - db[k + 2])) > 32) anders++;
    }
    return { anteil: anders / (w * h) };
  }, a, b);
  await p.close();
  return r;
}

const nackt = (outer) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{padding:24px}</style></head><body>${outer}</body></html>`;

test('Karte: element.html sieht aus wie das Original', async () => {
  const e = await fangen('/karte.html');
  const treu = await abweichung(e.original, await rendern(e.html));
  assert.ok(treu.anteil < 0.01, `zu viele abweichende Pixel: ${JSON.stringify(treu)}`);
});

test('Negativkontrolle: nacktes outerHTML verfehlt den Vergleich', async () => {
  const e = await fangen('/karte.html');
  const ohne = await abweichung(e.original, await rendern(nackt(e.roh)));
  assert.ok(ohne.anteil > 0.10, `Vergleich erkennt fehlende Styles nicht: ${JSON.stringify(ohne)}`);
});

test('Bereinigung: keine Skripte, Handler, Formularwerte, javascript-URLs', async () => {
  const { html } = await fangen('/karte.html');
  for (const verboten of ['geheim-token', 'geheim-eingabe', '<script', 'onclick', 'javascript:', 'window.x']) {
    assert.ok(!html.includes(verboten), `steht noch drin: ${verboten}`);
  }
  assert.ok(html.includes(`href="${basis}/relativ"`), 'relative URL nicht absolut gemacht');
});

test('Pseudo-Element ::before wird übertragen', async () => {
  const { html } = await fangen('/karte.html');
  assert.match(html, /\[data-yoink="\d+"\]::before \{[^}]*content: "NEU"/);
});

test('rules.css: passende Regeln mit Hover, Media, Keyframes – fremde Regel nicht', async () => {
  const { css } = await fangen('/karte.html');
  assert.ok(css.includes('.karte .knopf:hover'), 'Hover-Regel fehlt');
  assert.match(css, /@media \(max-width: 5000px\) \{\s*\.karte \{/);
  assert.ok(css.includes('@keyframes puls'), 'Keyframes fehlen');
  assert.ok(!css.includes('.fremd'), 'Regel für fremdes Element wurde mitgenommen');
});

test('Fremdes Stylesheet: unlesbar gemeldet, element.html trotzdem treu', async () => {
  const e = await fangen('/fremd.html');
  assert.ok(e.meta.luecken.some((l) => l.includes('not readable')), JSON.stringify(e.meta.luecken));
  assert.ok(e.css.includes(`${fremdBasis}/fremd.css`), 'unlesbare URL fehlt im Kopf von rules.css');
  const treu = await abweichung(e.original, await rendern(e.html));
  assert.ok(treu.anteil < 0.01, JSON.stringify(treu));
  const ohne = await abweichung(e.original, await rendern(nackt(e.roh)));
  assert.ok(ohne.anteil > 0.10, `Negativkontrolle: ${JSON.stringify(ohne)}`);
});

test('Canvas wird Standbild, absolute Wurzel wird relative', async () => {
  const e = await fangen('/leinwand.html');
  assert.ok(!e.html.includes('<canvas'), 'canvas nicht ersetzt');
  assert.match(e.html, /<img src="data:image\/png;base64,/);
  assert.ok(e.meta.luecken.some((l) => l.includes('still image')));
  assert.ok(e.meta.luecken.some((l) => l.includes('position: absolute')));
  const treu = await abweichung(e.original, await rendern(e.html));
  assert.ok(treu.anteil < 0.01, JSON.stringify(treu));
});

test('Metadaten: Label, Selektor, Größe, Schrift', async () => {
  const { meta } = await fangen('/karte.html');
  assert.equal(meta.label, 'Karte');
  assert.equal(meta.selektor, 'div#ziel');
  assert.equal(meta.breite, 372); // 320 + 2*24 Padding + 2*2 Rand
  assert.ok(meta.schriften.includes('Helvetica'), JSON.stringify(meta.schriften));
});

test('Zustand: alle Kacheln gleich gedrückt → Lücke gemeldet, Regeln für den anderen Zustand in rules.css', async () => {
  const e = await fangen('/zustand.html');
  const l = e.meta.luecken.find((x) => x.includes('aria-pressed'));
  assert.ok(l, `keine Zustands-Lücke: ${JSON.stringify(e.meta.luecken)}`);
  assert.match(l, /3 element/);
  assert.match(l, /"true"/);
  assert.match(l, /rules\.css/);
  assert.ok(e.css.includes('.kachel[aria-pressed="false"]'), 'Regel für den abgewählten Zustand fehlt');
  assert.ok(e.css.includes(':not([aria-pressed="true"]):hover'), ':not-Variante fehlt');
  assert.ok(!e.css.includes('.fremd-zustand'), 'Zustandsregel eines fremden Elements mitgenommen');
});

test('Zustand gemischt: beide Zustände im Fund → keine Zustands-Lücke', async () => {
  const e = await fangen('/zustand-gemischt.html');
  assert.ok(!e.meta.luecken.some((x) => x.includes('aria-pressed')), JSON.stringify(e.meta.luecken));
});

test('Zustand per Skript umgeschaltet: Lücke sagt, dass keine Regeln gefunden wurden', async () => {
  const e = await fangen('/zustand-skript.html');
  const l = e.meta.luecken.find((x) => x.includes('aria-pressed'));
  assert.ok(l, JSON.stringify(e.meta.luecken));
  assert.match(l, /No rules/);
});

test('Schriften: Datei gesichert, URLs auf lokale Kopie, fehlende Datei als Lücke', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/schrift.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const e = await p.evaluate(async () => {
    const erg = window.__yoinkErfassen(document.querySelector('#ziel'));
    await window.__yoinkVervollstaendigen(erg);
    return erg;
  });
  await p.close();
  assert.equal(e.schriften.length, 1, JSON.stringify(e.schriften.map((s) => s.datei)));
  assert.equal(e.schriften[0].datei, 'test-schrift.woff2');
  assert.deepEqual(Buffer.from(e.schriften[0].base64, 'base64'), SCHRIFT);
  assert.ok(e.html.includes('url("fonts/test-schrift.woff2")'), 'element.html zeigt nicht auf die Kopie');
  assert.ok(!e.html.includes(`${basis}/schriften/test-schrift.woff2`), 'element.html zeigt noch auf die Quelle');
  assert.ok(e.css.includes('url("fonts/test-schrift.woff2")'), 'rules.css zeigt nicht auf die Kopie');
  assert.ok(e.meta.luecken.some((x) => x.includes('Fehlschrift')), JSON.stringify(e.meta.luecken));
});

test('Farben: Token erkannt, Farbe ohne Token als solche markiert, Nicht-Farben ignoriert', async () => {
  const { meta } = await fangen('/farben.html');
  const marke = meta.farben.find((f) => f.farbe === '#4f46e5');
  const orange = meta.farben.find((f) => f.farbe === '#f79009');
  assert.ok(marke && orange, JSON.stringify(meta.farben));
  assert.deepEqual(marke.tokens, ['--marke', '--marke-zwei']);
  assert.deepEqual(orange.tokens, []);
  assert.ok(marke.wo.includes('color') && orange.wo.includes('background-color'), JSON.stringify(meta.farben));
});

test('URL: IDs und Tokens raus, harmlose Parameter bleiben', async () => {
  const uuid = '1bf58539-72b0-48ef-9b6b-ffc49f35bec6';
  const e = await fangen(`/karte.html?user=${uuid}&tab=2&access_token=abc&ref=x%40y.de`);
  assert.ok(!e.meta.url.includes(uuid) && !e.html.includes(uuid) && !e.css.includes(uuid), e.meta.url);
  assert.ok(!e.meta.url.includes('abc') && !e.meta.url.includes('x%40y.de'), e.meta.url);
  assert.ok(e.meta.url.includes('tab=2'), e.meta.url);
  assert.ok(e.meta.url.includes('user=…'), e.meta.url);
});

async function vervollstaendigt(pfad, holerText, optionen = {}) {
  const p = await neueSeite();
  await p.goto(basis + pfad, { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const e = await p.evaluate(async (holerText, optionen) => {
    const erg = window.__yoinkErfassen(document.querySelector('#ziel'));
    const holer = holerText == null ? null : async () => ({ ok: true, text: holerText });
    await window.__yoinkVervollstaendigen(erg, holer, optionen);
    return erg;
  }, holerText, optionen);
  await p.close();
  return e;
}

test('Fremdes Stylesheet nicht holbar: benutzte Webschrift ohne Datei als eigene Lücke, Systemschrift nicht', async () => {
  const e = await vervollstaendigt('/fremdschrift.html', null);
  const l = e.meta.luecken.find((x) => x.includes('“Fremdschrift”'));
  assert.ok(l, JSON.stringify(e.meta.luecken));
  assert.match(l, /without a saved file/);
  assert.ok(!e.meta.luecken.some((x) => x.includes('Helvetica')), 'Systemschrift als Lücke gemeldet');
  assert.ok(e.meta.luecken.some((x) => x.includes('not readable')), 'unlesbares Stylesheet nicht mehr gemeldet');
});

test('Fremdes Stylesheet über den Holer: Regeln nachgeholt, Schrift zum Nachladen, keine Unlesbar-Lücke', async () => {
  const e = await vervollstaendigt('/fremdschrift.html', FREMD_SCHRIFT_CSS);
  assert.ok(e.css.includes('fetched afterwards'), 'kein nachgeholter Block in rules.css');
  assert.match(e.css, /@font-face \{[^}]*Fremdschrift/);
  assert.ok(e.css.includes('.mit-fremd-bg'), 'passende Regel aus dem fremden Blatt fehlt');
  assert.ok(!e.css.includes('.nicht-im-element'), 'fremde Regel ohne Bezug mitgenommen');
  assert.ok(!e.meta.luecken.some((x) => x.includes('not readable')), JSON.stringify(e.meta.luecken));
  const n = e.nachladen.find((x) => x.url === `${fremdBasis}/fremd.woff2`);
  assert.ok(n && n.ziel === 'fonts/fremd.woff2', JSON.stringify(e.nachladen));
  assert.ok(e.html.includes('url("fonts/fremd.woff2")'), 'element.html zeigt nicht auf die Kopie');
  assert.ok(!e.meta.luecken.some((x) => x.includes('“Fremdschrift”')), 'Lücke trotz Nachladen');
});

test('Leere Elemente: namentlich mit Grund, sichtbare Deko-Fläche nicht', async () => {
  const e = await vervollstaendigt('/leer.html', null);
  const l = e.meta.luecken.find((x) => x.includes('.form-unten'));
  assert.ok(l, JSON.stringify(e.meta.luecken));
  assert.match(l, /0 px high/);
  assert.match(l, /outside/);
  assert.match(l, /empty on the page too/);
  assert.ok(!e.meta.luecken.some((x) => x.includes('.deko')), 'sichtbare Deko als leer gemeldet');
  assert.ok(!e.meta.luecken.some((x) => x.includes('.inhalt')), 'Element mit Text als leer gemeldet');
});

test('Bilder: Hintergrund und img gesichert und lokal verwiesen, fremdes zum Nachladen, data/Verlauf unberührt', async () => {
  const e = await vervollstaendigt('/bilder.html', null);
  const namen = e.bilder.map((b) => b.datei).sort();
  assert.deepEqual(namen, ['bg.png', 'image.png'], JSON.stringify(namen));
  assert.deepEqual(Buffer.from(e.bilder.find((b) => b.datei === 'bg.png').base64, 'base64'), PNG);
  assert.ok(!e.html.includes(`${basis}/bg.png`), 'element.html zeigt noch auf die Quelle des Hintergrunds');
  assert.ok(!e.html.includes(`${basis}/image.png`), 'element.html zeigt noch auf die Quelle des img');
  assert.ok(e.html.includes('images/bg.png') && e.html.includes('src="images/image.png"'), 'lokale Verweise fehlen');
  const n = e.nachladen.find((x) => x.url === `${fremdBasis}/fremd-bg.png`);
  assert.ok(n && n.ziel === 'images/fremd-bg.png', JSON.stringify(e.nachladen));
  assert.ok(e.html.includes('data:image/png;base64,'), 'data-URL angefasst');
  assert.ok(e.html.includes('linear-gradient'), 'Verlauf angefasst');
});

test('Bild vorbereiten: überdeckender fixed-Kopf aus, Element ganz im Bild, danach alles zurück', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/kopf.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const r = await p.evaluate(async () => {
    const el = document.querySelector('#ziel');
    const vis = (id) => getComputedStyle(document.getElementById(id)).visibility;
    const zurueck = await window.__yoinkBildVorbereiten(el);
    const b = el.getBoundingClientRect();
    const waehrend = { kindDeckt: getComputedStyle(document.getElementById('kopf')).opacity, kopf: vis('kopf'), badge: vis('badge'), innen: vis('innen'), ueber: vis('ueber'), neben: vis('neben'), oben: b.top, unten: b.bottom, hoehe: innerHeight };
    zurueck();
    return { waehrend, danach: { kopf: vis('kopf'), deckkraft: getComputedStyle(document.getElementById('kopf')).opacity, scroll: scrollY } };
  });
  await p.close();
  assert.equal(r.waehrend.kopf, 'hidden', JSON.stringify(r));
  assert.equal(r.waehrend.kindDeckt, '0', 'Kind mit visibility: visible bleibt sichtbar');
  assert.equal(r.waehrend.badge, 'visible', 'Badge überdeckt nicht und wurde trotzdem ausgeblendet');
  assert.equal(r.waehrend.innen, 'visible', 'sticky im Element selbst ausgeblendet');
  assert.equal(r.waehrend.ueber, 'hidden', 'absolut darübergelegtes Element nicht ausgeblendet');
  assert.equal(r.waehrend.neben, 'visible', 'nicht überdeckendes Element ausgeblendet');
  assert.ok(r.waehrend.oben >= 0 && r.waehrend.unten <= r.waehrend.hoehe, `Element nicht ganz im Bild: ${JSON.stringify(r)}`);
  assert.equal(r.danach.kopf, 'visible');
  assert.equal(r.danach.deckkraft, '1', 'Deckkraft nicht zurückgesetzt');
  assert.equal(r.danach.scroll, 0, 'Scrollposition nicht zurückgesetzt');
});

test('Titel aus der ersten sichtbaren Überschrift, versteckte übersprungen', async () => {
  const { meta } = await fangen('/titel.html');
  assert.equal(meta.label, 'Echte Überschrift');
});

test('Schriftgewicht: h3 mit font-weight 400 bleibt normal, Link behält Textfarbe', async () => {
  const e = await fangen('/gewicht.html');
  assert.match(e.html, /<h3 class="dach" style="[^"]*font-weight: 400/);
  const treu = await abweichung(e.original, await rendern(e.html));
  assert.ok(treu.anteil < 0.01, `Render weicht ab: ${JSON.stringify(treu)}`);
});

test('Lazy-Bild: loading="lazy" und decoding="async" entfernt, übrige Attribute bleiben', async () => {
  const { html } = await fangen('/lazy.html');
  assert.ok(!html.includes('loading="lazy"') && !html.includes('decoding="async"'), html.slice(html.indexOf('<img'), html.indexOf('<img') + 200));
  assert.ok(html.includes('alt="Poster"'));
});

test('Schrift in ::before: @font-face mitgenommen und gesichert, fehlende Datei als Lücke', async () => {
  const e = await vervollstaendigt('/pseudoschrift.html', null);
  assert.ok(e.meta.schriften.includes('Iconschrift'), JSON.stringify(e.meta.schriften));
  assert.match(e.css, /@font-face \{[^}]*Iconschrift/);
  assert.ok(e.schriften.some((s) => s.datei === 'icon.woff2'), JSON.stringify(e.schriften.map((s) => s.datei)));
  assert.ok(e.meta.luecken.some((l) => l.includes('“Fehlicon”')), JSON.stringify(e.meta.luecken));
});

test('Relative url() aus Custom Properties und Zustandsregeln: absolut oder lokal, Icons gesichert, data unberührt', async () => {
  const e = await vervollstaendigt('/relativ.html', null);
  assert.ok(!/url\(\s*["']?\.\.\//.test(e.css), 'relativer Verweis übrig: ' + (e.css.match(/url\([^)]*\.\.\/[^)]*\)/) || [''])[0]);
  const namen = e.bilder.map((b) => b.datei).sort();
  assert.deepEqual(namen, ['hover.svg', 'pfeil.svg'], JSON.stringify(namen));
  assert.ok(e.css.includes('url(images/pfeil.svg)') || e.css.includes('url("images/pfeil.svg")'), 'Custom Property zeigt nicht auf die Kopie');
  assert.ok(e.css.includes('url("images/hover.svg")'), 'Hover-Regel zeigt nicht auf die Kopie');
  assert.ok(e.css.includes('data:image/gif;base64'), 'data-URL angefasst');
});

test('Rauschen: versteckte Bereiche erzeugen keine Zustands- und keine Leer-Aufzählung', async () => {
  const e = await fangen('/rauschen.html');
  assert.ok(!e.meta.luecken.some((l) => l.includes('aria-pressed')), JSON.stringify(e.meta.luecken));
  const l = e.meta.luecken.find((x) => x.startsWith('Empty elements'));
  assert.ok(l && l.includes('.leer-sichtbar'), JSON.stringify(e.meta.luecken));
  assert.ok(!l.includes('.leer-weg') && !l.includes('.leer-durchsichtig'), l);
  assert.match(l, /2 in hidden areas/);
});

test('Rauschen: viele leere Elemente nur als Zahl, ohne Namen', async () => {
  const p = await neueSeite();
  await p.setContent(`<div id="ziel"><p>Text</p>${[1, 2, 3, 4, 5].map((i) => `<span class="leer${i}"></span>`).join('')}</div>`);
  await p.addScriptTag({ content: ERFASSEN });
  const meta = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#ziel')).meta);
  await p.close();
  const l = meta.luecken.find((x) => x.includes('empty elements'));
  assert.ok(l && l.startsWith('5 empty elements'), JSON.stringify(meta.luecken));
  assert.ok(!l.includes('.leer1'), l);
});

test('Rahmen: border-style ohne Breite (Tailwind-Reset) wird nicht zu 3-px-Rahmen', async () => {
  const e = await fangen('/rahmen.html');
  assert.match(e.html, /<p style="[^"]*border-top-width: 0px/);
  const treu = await abweichung(e.original, await rendern(e.html));
  assert.ok(treu.anteil < 0.01, `Render weicht ab: ${JSON.stringify(treu)}`);
});

test('Bild vorbereiten wartet auf den Kopf, den die Seite erst nach dem Scrollen fixiert (Gegenprobe ohne Pause)', async () => {
  const lauf = async (pause) => {
    const p = await neueSeite();
    await p.goto(basis + '/kopf-skript.html', { waitUntil: 'load' });
    await p.addScriptTag({ content: ERFASSEN });
    const v = await p.evaluate(async (pause) => {
      const zurueck = await window.__yoinkBildVorbereiten(document.querySelector('#ziel'), pause);
      const k = document.getElementById('kopf');
      const w = { vis: getComputedStyle(k).visibility, pos: getComputedStyle(k).position };
      zurueck();
      return w;
    }, pause);
    await p.close();
    return v;
  };
  const mit = await lauf(350);
  assert.equal(mit.vis, 'hidden', `mit Pause: ${JSON.stringify(mit)}`);
  const ohne = await lauf(0);
  assert.equal(ohne.vis, 'visible', `Gegenprobe ohne Pause sollte den Kopf verpassen: ${JSON.stringify(ohne)}`);
});

// --- 0.5.0: Video, Canvas, iframe, Hülle -----------------------------------------------------

test('Video: Quelle zum Nachladen, Standbild als Poster, autoplay aus, Inhalt als Video gemeldet', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/video.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const e = await p.evaluate(async () => {
    const erg = window.__yoinkErfassen(document.querySelector('#v'));
    await window.__yoinkVervollstaendigen(erg, null);
    return erg;
  });
  await p.close();
  const n = e.nachladen.find((x) => x.art === 'videos');
  assert.ok(n && n.url === `${basis}/clip.mp4` && n.ziel === 'videos/clip.mp4', JSON.stringify(e.nachladen));
  assert.match(e.html, /<video [^>]*src="videos\/clip\.mp4"/);
  assert.match(e.html, /<video [^>]*poster="images\/still-1\.webp"/);
  assert.ok(!/<video [^>]*\sautoplay/.test(e.html), 'autoplay steht noch drin');
  assert.equal(e.meta.medien.length, 1);
  assert.equal(e.meta.medien[0].art, 'Video');
  assert.ok(e.meta.medien[0].anteil > 0.95, JSON.stringify(e.meta.medien));
  assert.ok(e.meta.luecken.some((l) => l.includes('Content is a Video, not rebuildable HTML')), JSON.stringify(e.meta.luecken));
});

test('Video klein im Element: Quelle aus <source>, Lücke ohne „Inhalt ist Video“', async () => {
  const e = await vervollstaendigt('/video-source.html', null);
  const n = e.nachladen.find((x) => x.art === 'videos');
  assert.ok(n && n.ziel === 'videos/clip.webm', JSON.stringify(e.nachladen));
  assert.ok(!e.html.includes('<source'), 'source-Kind steht noch drin, obwohl src gesetzt ist');
  assert.ok(e.meta.medien[0].anteil < 0.5, JSON.stringify(e.meta.medien));
  assert.ok(!e.meta.luecken.some((l) => l.includes('Content is a Video')), 'kleines Video als Hauptinhalt gemeldet');
  assert.ok(e.meta.luecken.some((l) => l.includes('Contains a Video')), JSON.stringify(e.meta.luecken));
});

test('Video als Stream (blob:): nicht nachladbar, Lücke sagt es, Poster trotzdem', async () => {
  const e = await vervollstaendigt('/video-strom.html', null);
  assert.ok(!e.nachladen.some((x) => x.art === 'videos'), JSON.stringify(e.nachladen));
  assert.ok(!e.html.includes('blob:'), 'blob-URL in element.html');
  assert.match(e.html, /poster="images\/still-1\.webp"/);
  assert.ok(e.meta.luecken.some((l) => l.includes('stream')), JSON.stringify(e.meta.luecken));
});

test('Ohne Medien: keine Medienliste, kein Video zum Nachladen (Gegenprobe)', async () => {
  const e = await vervollstaendigt('/karte.html', null);
  assert.deepEqual(e.meta.medien, []);
  assert.ok(!e.nachladen.some((x) => x.art === 'videos'));
  assert.ok(!e.html.includes('still-'), 'Standbild-Verweis ohne Medium');
});

test('WebGL-Canvas und iframe: Standbild statt Platzhalter, iframe-Quelle gesäubert vermerkt', async () => {
  const e = await fangen('/webgl.html');
  assert.ok(!e.html.includes('<canvas') && !e.html.includes('<iframe'), 'canvas/iframe nicht ersetzt');
  assert.match(e.html, /<img [^>]*src="images\/still-1\.webp"/);
  assert.match(e.html, /<img [^>]*src="images\/still-2\.webp"/);
  assert.ok(!e.html.includes('not transferred') && !e.html.includes('dashed'), 'alter Platzhalter steht noch drin');
  assert.deepEqual(e.meta.medien.map((m) => m.art), ['Canvas', 'iframe']);
  assert.ok(e.meta.medien[1].quelle.includes('/karte.html') && !e.meta.medien[1].quelle.includes('geheim123'), JSON.stringify(e.meta.medien));
});

test('Medien-Rechtecke: je Medium eins, in derselben Reihenfolge wie die Standbild-Nummern', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/webgl.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const r = await p.evaluate(() => window.__yoinkMedienRechtecke(document.querySelector('#ziel')));
  await p.close();
  assert.equal(r.length, 2, JSON.stringify(r));
  assert.deepEqual(r.map((x) => [x.nr, Math.round(x.w), Math.round(x.h)]), [[1, 200, 100], [2, 200, 80]]);
  assert.ok(r[1].y > r[0].y, 'Reihenfolge stimmt nicht');
});

test('Hülle: gleich große Hülle mit runden Ecken wird gemeldet, mit Hinweis auf ↑', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/video.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  // Video in #mitte (gleich groß, schlicht) in #ziel (1 px Rahmen, runde Ecken, schneidet ab)
  const meta = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#v')).meta);
  await p.close();
  const l = meta.luecken.find((x) => x.includes('Wrapper'));
  assert.ok(l, JSON.stringify(meta.luecken));
  assert.match(l, /rounded corners 16px/);
  assert.match(l, /↑/);
});

test('Hülle: größere oder schlichte Hülle wird nicht gemeldet (Gegenprobe)', async () => {
  for (const s of ['/huelle-gross.html', '/huelle-schlicht.html']) {
    const { meta } = await fangen(s);
    assert.ok(!meta.luecken.some((x) => x.includes('Wrapper')), `${s}: ${JSON.stringify(meta.luecken)}`);
  }
});

test('Titel ohne Text: Beschriftung eines Kindes (aria-label, alt), sonst Selektor (Gegenprobe)', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/nur-medium.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const [mit, ohne, video] = await p.evaluate(() => [
    window.__yoinkErfassen(document.querySelector('#ziel')).meta,
    window.__yoinkErfassen(document.querySelector('#leer')).meta.label,
    window.__yoinkErfassen(document.querySelector('video')).meta,
  ]);
  await p.close();
  assert.equal(mit.label, 'Screenshot of Notion');
  assert.equal(ohne, 'div#leer');
  const l = video.luecken.find((x) => x.startsWith('Content is a Video'));
  assert.ok(l && !/:\s*\.$/.test(l), `Lücke ohne Inhalt nach dem Doppelpunkt: ${l}`);
  assert.match(l, /still image from the captured image as poster/);
  assert.match(l, /videos\/clip\.mp4/);
});

// --- 0.6.0: Lazy-Bilder, zusammengesetztes Sollbild, Titel bei Listen, Schriften, Bereich ------

// Aufnahme wie die Extension (captureVisibleTab + ausschneiden), hier mit page.screenshot
async function mitAufnahme(p) {
  await p.exposeFunction('__testBildschirm', () => p.screenshot({ encoding: 'base64', captureBeyondViewport: false }));
  await p.evaluate(() => {
    const bitmap = async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const schneiden = async (voll, m, r) => {
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      const sx = Math.round(x * m), sy = Math.round(y * m);
      const sw = Math.min(voll.width - sx, Math.round((r.w - (x - r.x)) * m)), sh = Math.min(voll.height - sy, Math.round((r.h - (y - r.y)) * m));
      if (sw <= 0 || sh <= 0) return '';
      const c = new OffscreenCanvas(sw, sh); c.getContext('2d').drawImage(voll, sx, sy, sw, sh, 0, 0, sw, sh);
      const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    };
    window.__testAufnehmen = async (rect, medien) => {
      const voll = await bitmap(await window.__testBildschirm());
      const m = voll.width / innerWidth;
      const standbilder = [];
      for (const r of medien || []) { const b = await schneiden(voll, m, r); if (b) standbilder.push({ datei: `still-${r.nr}.webp`, base64: b }); }
      return { ok: true, bild: rect ? await schneiden(voll, m, rect) : '', standbilder };
    };
    window.__testPixel = async (b64, punkte) => {
      const i = await bitmap(b64);
      const c = new OffscreenCanvas(i.width, i.height); const x = c.getContext('2d'); x.drawImage(i, 0, 0);
      return { breite: i.width, hoehe: i.height, farben: punkte.map(([px, py]) => (py < i.height ? [...x.getImageData(px, py, 1, 1).data.slice(0, 3)] : null)) };
    };
  });
}

test('Lazy-Bilder: ohne Durchscrollen als Lücke mit Zahl (versteckte nicht gezählt), nach Durchscrollen alle geladen', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/lazy-liste.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const vorher = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#ziel')));
  const l = vorher.meta.luecken.find((x) => /images? without a source/.test(x));
  assert.ok(l, `Gegenprobe: fehlende Quellen nicht gemeldet: ${JSON.stringify(vorher.meta.luecken)}`);
  const m = l.match(/(\d+) of (\d+)/);
  assert.ok(m && Number(m[1]) >= 5 && Number(m[2]) === 10, l);
  const nachher = await p.evaluate(async () => {
    scrollTo(0, 0);
    const vorY = scrollY;
    await window.__yoinkDurchscrollen(document.querySelector('#ziel'), { pause: 120 });
    const erg = window.__yoinkErfassen(document.querySelector('#ziel'));
    return { erg, zurueck: scrollY === vorY };
  });
  await p.close();
  assert.ok(nachher.zurueck, 'Scrollposition nicht wiederhergestellt');
  assert.ok(!nachher.erg.meta.luecken.some((x) => /without a source/.test(x)), JSON.stringify(nachher.erg.meta.luecken));
  assert.equal((nachher.erg.html.match(/<img [^>]*src="http[^"]*image\.png/g) || []).length, 10);
});

test('Titel bei Liste: Überschrift aus einem Eintrag wird nicht Titel, sondern Rolle und Seitentitel', async () => {
  const { meta } = await fangen('/lazy-liste.html');
  assert.equal(meta.label, 'List with 10 items – Lazyseite');
});

test('Titel bei Liste: Überschrift über der Liste bleibt Titel (Gegenprobe)', async () => {
  const { meta } = await fangen('/menue-liste.html');
  assert.equal(meta.label, 'Menü');
});

test('Sollbild zusammengesetzt: hohes Element in Ausschnitten, jeder Streifen an seiner Stelle, fixer Kopf nicht im Bild', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/streifen.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  await mitAufnahme(p);
  const punkte = Array.from({ length: 8 }, (_, i) => [150, 150 + 300 * i]).concat([[150, 5], [150, 305], [150, 605]]);
  const erg = await p.evaluate(async (punkte) => {
    const s = await window.__yoinkSollbild(document.querySelector('#ziel'), window.__testAufnehmen, { pause: 50 });
    return { ausschnitt: s.ausschnitt, luecken: s.luecken, px: await window.__testPixel(s.bild, punkte), scrollY };
  }, punkte);
  const einzel = await p.evaluate(async (punkte) => {
    const s = await window.__yoinkSollbild(document.querySelector('#ziel'), window.__testAufnehmen, { pause: 50, maxSchritte: 1 });
    return { ausschnitt: s.ausschnitt, luecken: s.luecken, px: await window.__testPixel(s.bild, punkte) };
  }, punkte);
  await p.close();
  const soll = [[0, 0, 255], [0, 128, 0], [255, 165, 0], [128, 0, 128], [0, 128, 128], [128, 128, 0], [0, 0, 0], [255, 192, 203]];
  const nah = (a, b) => a && b.every((v, i) => Math.abs(v - a[i]) <= 8);
  assert.deepEqual([erg.px.breite, erg.px.hoehe], [300, 2400]);
  assert.deepEqual(erg.ausschnitt, { x: 0, y: 0, w: 300, h: 2400 });
  soll.forEach((f, i) => assert.ok(nah(erg.px.farben[i], f), `Streifen ${i + 1}: ${erg.px.farben[i]} statt ${f}`));
  erg.px.farben.slice(8).forEach((f) => assert.ok(!nah(f, [255, 0, 0]), `Kopf im Bild: ${f}`));
  assert.ok(!erg.luecken.some((x) => x.includes('only the visible part')), JSON.stringify(erg.luecken));
  assert.equal(erg.scrollY, 0, 'Scrollposition nicht zurück');
  // Gegenprobe: ein Ausschnitt deckt nicht alles, das Bild sagt es und die unteren Streifen fehlen
  assert.ok(einzel.ausschnitt.h < 2400, JSON.stringify(einzel.ausschnitt));
  assert.ok(einzel.luecken.some((x) => x.includes('only the visible part')), JSON.stringify(einzel.luecken));
  assert.ok(!nah(einzel.px.farben[7], soll[7]), 'letzter Streifen trotz eines Ausschnitts im Bild');
});

test('Schriften: ohne sichtbaren Text weggelassen und genannt, sichtbar genutzte bleiben', async () => {
  const e = await vervollstaendigt('/schrift-leer.html', null);
  assert.ok(!/Leerschrift/.test(e.html.match(/<style>[\s\S]*?<\/style>/)[0]), '@font-face Leerschrift in element.html');
  assert.ok(!e.css.includes('leer.woff2'), '@font-face Leerschrift in rules.css');
  assert.ok(!e.schriften.some((s) => s.familie === 'Leerschrift'), JSON.stringify(e.schriften.map((s) => s.datei)));
  assert.ok(e.schriften.some((s) => s.familie === 'Testschrift'), 'Testschrift fehlt');
  assert.deepEqual(e.meta.schriftenWeggelassen, ['Leerschrift']);
  assert.ok(!e.meta.schriften.includes('Leerschrift'), JSON.stringify(e.meta.schriften));
});

test('Schriften: sichtbarer Text mit der Schrift hält sie im Fang (Gegenprobe)', async () => {
  const e = await vervollstaendigt('/schrift-genutzt.html', null);
  assert.ok(e.schriften.some((s) => s.familie === 'Leerschrift'), JSON.stringify(e.schriften.map((s) => s.datei)));
  assert.deepEqual(e.meta.schriftenWeggelassen || [], []);
});

test('Bereich: kleinstes gemeinsames Elternelement, Ausschnitt auf den Rahmen', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/bereich.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const [zwei, eine] = await p.evaluate(() => [
    { x: 15, y: 15, w: 430, h: 160 }, // um A und B
    { x: 16, y: 17, w: 208, h: 156 }, // knapp um A
  ].map((r) => { const b = window.__yoinkBereich(r); return { id: b.element.id, ausschnitt: b.ausschnitt, verhaeltnis: b.verhaeltnis, luecken: b.luecken }; }));
  await p.close();
  assert.equal(zwei.id, 'wrap');
  assert.deepEqual(zwei.ausschnitt, { x: 15, y: 15, w: 430, h: 160 });
  assert.ok(zwei.verhaeltnis > 9 && zwei.verhaeltnis < 10.5, String(zwei.verhaeltnis));
  assert.deepEqual(zwei.luecken, [], 'Verhältnis-Lücke, obwohl der Fang auf den Rahmen beschnitten wird');
  assert.equal(eine.id, 'a');
  assert.deepEqual(eine.ausschnitt, { x: 0, y: 0, w: 200, h: 150 }, 'Rahmen nicht auf das Element beschnitten');
  assert.deepEqual(eine.luecken, []);
});

// auswahl.js mit echter Maus; chrome.runtime ist nachgebildet, Aufnahme wie oben
async function auswahlSeite(pfad = '/zieh.html') {
  const p = await neueSeite();
  await p.goto(basis + pfad, { waitUntil: 'load' });
  await mitAufnahme(p);
  await p.evaluate(() => {
    window.__nachrichten = [];
    Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: { sendMessage: async (m) => {
      window.__nachrichten.push(m.typ === 'gefangen' ? { typ: m.typ, meta: m.meta, bild: (m.bild || '').length, html: m.html, breiten: (m.breiten || []).length, iframe: m.iframe || null, quelltexte: m.quelltexte || [], quellen: m.quellen || [], bildB64: m.bild || '' } : { typ: m.typ });
      if (m.typ === 'aufnehmen') return window.__testAufnehmen(m.rect, m.medien);
      if (m.typ === 'holen') return { ok: false };
      return { ok: true, notiz: 'n', titel: 't' };
    } } } });
  });
  await p.addScriptTag({ content: ERFASSEN });
  await p.addScriptTag({ content: AUSWAHL });
  return p;
}
const fangWarten = (p) => p.waitForFunction(() => window.__nachrichten.find((n) => n.typ === 'gefangen'), { timeout: 15000 }).then((h) => h.jsonValue());

test('Ziehen: Bereich wird gefangen, der Klick nach dem Loslassen erreicht den Knopf nicht', async () => {
  // Gegenprobe der Messung: ohne yoink löst derselbe Zug den Link aus
  const roh = await neueSeite();
  await roh.goto(basis + '/zieh.html', { waitUntil: 'load' });
  await roh.mouse.move(250, 30); await roh.mouse.down(); await roh.mouse.move(430, 160, { steps: 8 }); await roh.mouse.up();
  assert.equal(await roh.evaluate(() => window.__geklickt), 1, 'Messaufbau erkennt keinen Klick');
  await roh.close();

  const p = await auswahlSeite();
  await p.mouse.move(250, 30); await p.mouse.down(); await p.mouse.move(430, 160, { steps: 8 }); await p.mouse.up();
  const n = await fangWarten(p);
  await new Promise((ok) => setTimeout(ok, 500));
  const klicks = await p.evaluate(() => window.__geklickt || 0);
  await p.close();
  assert.equal(klicks, 0, 'Klick nach dem Ziehen ist auf der Seite gelandet');
  assert.equal(n.meta.selektor, 'div#b');
  assert.deepEqual(n.meta.rahmen, { x: 10, y: 10, w: 180, h: 130 });
  assert.deepEqual([n.meta.breite, n.meta.hoehe], [180, 130]);
  assert.ok(n.bild > 0, 'kein Sollbild');
});

test('Ziehen: einfacher Klick bleibt Elementfang, ganzes Element (Gegenprobe)', async () => {
  const p = await auswahlSeite();
  await p.mouse.click(100, 80);
  const n = await fangWarten(p);
  await p.close();
  assert.equal(n.meta.selektor, 'div#a');
  assert.deepEqual(n.meta.ausschnitt, { x: 0, y: 0, w: 200, h: 150 });
  assert.ok(!n.meta.luecken.some((l) => l.includes('Bereichsauswahl')), JSON.stringify(n.meta.luecken));
});

test('Sollbild endet, wo das Element beim Fang endete, auch wenn die Seite beim Scrollen nachlädt', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/wachsend.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  await mitAufnahme(p);
  const erg = await p.evaluate(async () => {
    const s = await window.__yoinkSollbild(document.querySelector('#ziel'), window.__testAufnehmen, { pause: 50 });
    return { ausschnitt: s.ausschnitt, px: await window.__testPixel(s.bild, [[150, 1690], [150, 1750]]), jetzt: document.querySelector('#ziel').getBoundingClientRect().height };
  });
  await p.close();
  assert.equal(erg.jetzt, 2600, 'Seite ist nicht nachgewachsen, Test misst nichts');
  assert.deepEqual(erg.ausschnitt, { x: 0, y: 0, w: 300, h: 1700 });
  assert.equal(erg.px.hoehe, 1700);
  assert.equal(erg.px.farben[1], null, 'nachgeladener Teil im Sollbild');
});

test('Reihenfolge: was die Seite beim Aufnehmen nachlädt, steht auch in element.html, und die Notiz sagt es', async () => {
  const p = await auswahlSeite('/nachladen.html');
  await p.mouse.click(150, 600);
  const n = await fangWarten(p);
  await p.close();
  assert.equal((n.html.match(/class="eintrag neu"/g) || []).length, 3, 'nachgeladene Einträge fehlen in element.html, das Sollbild zeigt sie');
  assert.ok(n.meta.luecken.some((l) => l.includes('loaded more content')), JSON.stringify(n.meta.luecken));
});

// --- 0.7.0: verschobene Wurzel, Kulisse aus dem Hintergrund der Umgebung ---------------------

// Render wie der Host: Ausschnitt ab (24, 24) in Größe des Originals, nicht die verschobene Box
async function rendernAbRand(html, w, h) {
  const p = await neueSeite();
  await p.setContent(html, { waitUntil: 'load' });
  await p.addStyleTag({ content: 'body > :first-child { margin: 0 !important; }' });
  const bild = await p.screenshot({ encoding: 'base64', clip: { x: 24, y: 24, width: w, height: h } });
  await p.close();
  return bild;
}

test('Verschobene Wurzel (transform: translate): element.html sitzt deckungsgleich, Lücke nennt die Verschiebung', async () => {
  const e = await fangen('/verschoben.html');
  const treu = await abweichung(e.original, await rendernAbRand(e.html, 200, 100));
  assert.ok(treu.anteil < 0.01, `Versatz im Render: ${JSON.stringify(treu)}`);
  assert.ok(e.meta.luecken.some((l) => /shifted by transform \(8, 5\) px/.test(l)), JSON.stringify(e.meta.luecken));
  // Gegenprobe: die Verschiebung eines Kindes gehört zum Aussehen und bleibt
  assert.match(e.html, /<span id="kind" style="[^"]*transform: matrix\(1, 0, 0, 1, 6, 0\)/);
});

test('Kulisse: Hintergrundbild der Umgebung steht hinter dem Element, an der richtigen Stelle', async () => {
  const e = await fangen('/kulisse.html');
  assert.match(e.html, /data-yoink-kulisse/);
  const treu = await abweichung(e.original, await rendernAbRand(e.html, 200, 34));
  assert.ok(treu.anteil < 0.01, `Kulisse falsch: ${JSON.stringify(treu)}`);
  assert.ok(e.meta.luecken.some((l) => l.includes('as a backdrop')), JSON.stringify(e.meta.luecken));
  assert.ok(!e.meta.luecken.some((l) => l.includes('only the colour')), JSON.stringify(e.meta.luecken));
  const v = await vervollstaendigt('/kulisse.html', null);
  assert.ok(v.bilder.some((b) => b.datei === 'kulisse.svg'), JSON.stringify(v.bilder.map((b) => b.datei)));
  assert.match(v.html, /url\(&quot;images\/kulisse\.svg&quot;\)/);
});

test('Kulisse: Umgebung nur mit Farbe bekommt keine (Gegenprobe)', async () => {
  const e = await fangen('/kulisse-ohne.html');
  assert.ok(!e.html.includes('data-yoink-kulisse'), 'Kulisse ohne Hintergrundbild');
  assert.ok(!e.meta.luecken.some((l) => l.includes('backdrop')), JSON.stringify(e.meta.luecken));
});

test('Flächen: größte sichtbare Teile mit Lage im Element, kleine nicht (für Versatz-Namen)', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/bereich.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const meta = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#wrap')).meta);
  await p.close();
  const a = (meta.flaechen || []).find((f) => f.name === 'div#a');
  assert.deepEqual(a && [a.x, a.y, a.w, a.h], [20, 20, 200, 150], JSON.stringify(meta.flaechen));
  assert.ok(!meta.flaechen.some((f) => f.name.startsWith('h3')), 'kleine Überschrift als Fläche');
});

// --- 0.8.0: Margin-Collapse, Canvas-Zeile, Schriften, bewegte Medien, Breiten -----------------

test('Margin-Collapse: Außenabstand des ersten Kindes, der auf der Seite aus dem Element fällt, verschiebt element.html nicht', async () => {
  const e = await fangen('/collapse.html');
  const treu = await abweichung(e.original, await rendernAbRand(e.html, 300, 61));
  assert.ok(treu.anteil < 0.01, `Versatz durch Margin-Collapse: ${JSON.stringify(treu)}`);
  assert.ok(e.meta.luecken.some((l) => /margin collapse/.test(l) && l.includes('57 px')), JSON.stringify(e.meta.luecken));
});

test('Margin-Collapse: mit Innenabstand der Wurzel bleibt der Außenabstand (Gegenprobe)', async () => {
  const e = await fangen('/collapse-nicht.html');
  assert.match(e.html, /<h2 style="[^"]*margin-top: 57px/);
  assert.ok(!e.meta.luecken.some((l) => /margin collapse/.test(l)), JSON.stringify(e.meta.luecken));
});

test('Canvas: viele gleiche Medien in einer Zeile mit Zahl, kleiner Anteil als „unter 1 %“', async () => {
  const { meta } = await fangen('/canvas-viele.html');
  const l = meta.luecken.filter((x) => x.includes('Canvas'));
  assert.equal(l.length, 1, JSON.stringify(l));
  assert.match(l[0], /^6× Canvas/);
  assert.match(l[0], /under 1%/);
  assert.ok(!l[0].includes('(0 %'), l[0]);
});

test('Canvas: ein einzelnes Medium ohne Zahl davor (Gegenprobe)', async () => {
  const { meta } = await fangen('/leinwand.html');
  const l = meta.luecken.filter((x) => x.includes('Canvas'));
  assert.equal(l.length, 1);
  assert.ok(!/^\d+×/.test(l[0]), l[0]);
});

test('Schrift als data:-URL in @font-face gilt als gesichert, keine Lücke', async () => {
  const e = await vervollstaendigt('/schrift-data.html', null);
  assert.ok(!e.meta.luecken.some((l) => l.includes('Datenschrift')), JSON.stringify(e.meta.luecken));
  assert.match(e.html, /@font-face \{ font-family: Datenschrift; src: url\("data:font\/woff2/);
});

test('Schrift ohne Datei: Lücke schlägt einen freien Ersatz vor, ungemessen als solcher markiert', async () => {
  const e = await vervollstaendigt('/schrift.html', null);
  const l = e.meta.luecken.find((x) => x.includes('“Fehlschrift”'));
  assert.ok(l, JSON.stringify(e.meta.luecken));
  assert.match(l, /Substitute: [A-Z][^;]+ \(free/);
  assert.match(l, /not measured/);
});

test('Schriftersatz: gemessene Maße einer Tabellenschrift finden genau diese, Serifenmaße keine Grotesk', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/karte.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const r = await p.evaluate(() => {
    const t = window.__yoinkSchriftTabelle;
    const inter = t.find((x) => x.name === 'Inter');
    const serif = t.find((x) => x.art === 'serif');
    return {
      inter: window.__yoinkSchriftErsatz({ ...inter, breite: inter.breite * 1.01 }, 'sans-serif')[0].name,
      serifArt: window.__yoinkSchriftErsatz(serif, 'serif').map((x) => x.art),
    };
  });
  await p.close();
  assert.equal(r.inter, 'Inter');
  assert.ok(r.serifArt.length && r.serifArt.every((a) => a === 'serif'), JSON.stringify(r));
});

test('Bewegter Canvas: zwei Aufnahmen unterscheiden sich, Medium als bewegt markiert, mit Lage und Selektor', async () => {
  const p = await auswahlSeite('/bewegt.html');
  await p.mouse.click(25, 25);
  const n = await fangWarten(p);
  await p.close();
  const m = n.meta.medien[0];
  assert.equal(m.bewegt, true, JSON.stringify(n.meta.medien));
  assert.match(m.selektor, /canvas#c/);
  assert.ok(m.lage && m.lage.y >= 20, JSON.stringify(m));
});

test('Stiller Canvas wird nicht als bewegt markiert (Gegenprobe)', async () => {
  const p = await auswahlSeite('/still.html');
  await p.mouse.click(25, 25);
  const n = await fangWarten(p);
  await p.close();
  assert.equal(n.meta.medien[0].bewegt, false, JSON.stringify(n.meta.medien));
});

test('Pfad: eindeutiger Pfad von body aus findet das Element wieder', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/breiten.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const ok = await p.evaluate(() => { const m = window.__yoinkErfassen(document.querySelector('#ziel')).meta; return document.querySelector(m.pfad) === document.querySelector('#ziel') && m.pfad.startsWith('body'); });
  await p.close();
  assert.ok(ok);
});

async function breitenLauf(pfad) {
  const p = await neueSeite();
  await p.goto(basis + pfad, { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  await mitAufnahme(p);
  const r = await p.evaluate(async () => {
    const meta = window.__yoinkErfassen(document.querySelector('#ziel')).meta;
    const b = await window.__yoinkBreiten(meta, [390, 768], window.__testAufnehmen, { warten: 300 });
    const farben = [];
    for (const x of b.breiten) farben.push((await window.__testPixel(x.bild, [[20, 20]])).farben[0]);
    return { breiten: b.breiten.map((x) => ({ breite: x.breite, ausschnitt: x.ausschnitt })), farben, luecken: b.luecken, nachholen: b.nachholen, pfad: location.pathname, rahmen: document.querySelectorAll('iframe').length };
  });
  await p.close();
  return r;
}

test('Breiten: Sollbild bei 390 und 768 px aus einem iframe derselben Seite, Media Queries greifen', async () => {
  const r = await breitenLauf('/breiten.html');
  assert.deepEqual(r.breiten.map((b) => b.breite), [390, 768], JSON.stringify(r));
  assert.deepEqual(r.farben, [[255, 0, 0], [0, 160, 0]]);
  assert.deepEqual(r.breiten.map((b) => b.ausschnitt.w), [330, 708]);
  assert.equal(r.rahmen, 0, 'iframe nicht wieder entfernt');
});

test('Breiten: Seite verbietet Einbetten → kein Bild, beide Breiten an den Host (Gegenprobe)', async () => {
  const r = await breitenLauf('/einbetten-verboten.html');
  assert.equal(r.breiten.length, 0);
  assert.deepEqual(r.nachholen, [390, 768]);
  assert.equal(r.rahmen, 0);
});

test('Breiten: einbettbare Seite braucht den Host nicht', async () => {
  const r = await breitenLauf('/breiten.html');
  assert.deepEqual(r.nachholen, []);
});

test('Breiten: Rahmenbrecher-Skript der Seite kann die Seite nicht wegnavigieren (Sandbox)', async () => {
  // Gegenprobe der Messung: ohne Sandbox reißt das Skript die Seite weg
  const roh = await neueSeite();
  await roh.goto(basis + '/rahmen-ohne-sandbox.html', { waitUntil: 'load' });
  await new Promise((ok) => setTimeout(ok, 800));
  assert.equal(new URL(roh.url()).pathname, '/weg.html', 'Messaufbau: Rahmenbrecher wirkt nicht');
  await roh.close();
  const r = await breitenLauf('/rahmenbrecher.html');
  assert.equal(r.pfad, '/rahmenbrecher.html');
});

// --- 0.9.0: Bereich auf den Rahmen zugeschnitten, Extras nur auf Taste, WebP ------------------

async function rasterRahmen(p) {
  return p.evaluate(() => {
    const k = [...document.querySelectorAll('.karte')];
    const a = k[0].getBoundingClientRect(), b = k[1].getBoundingClientRect();
    return { x: Math.round(a.left - 5), y: Math.round(a.top - 5), w: Math.round(b.left + 100 - (a.left - 5)), h: Math.round(a.height + 10) };
  });
}

test('Bereich schneidet zu: nur was im Rahmen liegt, Layout deckungsgleich, Bilder/Schriften/Farben nur von innen', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/raster.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const r = await rasterRahmen(p);
  const original = await p.screenshot({ encoding: 'base64', clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
  const e = await p.evaluate(async (r) => {
    const b = window.__yoinkBereich(r);
    const erg = window.__yoinkErfassen(b.element, { teil: b.ausschnitt });
    const html0 = erg.html;
    await window.__yoinkVervollstaendigen(erg, null);
    return { html0, html: erg.html, meta: erg.meta, bilder: erg.bilder.map((x) => x.datei), schriften: erg.schriften.map((x) => x.familie), nachladen: erg.nachladen.map((x) => x.url) };
  }, r);
  await p.close();
  assert.ok(e.html.includes('Karte 1') && e.html.includes('Karte 2'), 'Inhalt im Rahmen fehlt');
  for (const weg of ['Karte 3', 'Karte 4', 'Karte 6', 'Abzeichen', 'aussen.png', 'Aussenschrift']) assert.ok(!e.html.includes(weg), `außerhalb des Rahmens im Fang: ${weg}`);
  assert.ok(e.bilder.includes('innen.png'), JSON.stringify(e.bilder));
  assert.ok(!e.schriften.includes('Aussenschrift') && !e.nachladen.some((u) => u.includes('aussen')), JSON.stringify(e));
  assert.ok(!e.meta.farben.some((f) => f.farbe === '#010203'), 'Farbe von außerhalb des Rahmens gezählt');
  assert.deepEqual([e.meta.breite, e.meta.hoehe], [r.w, r.h]);
  const treu = await abweichung(original, await rendernAbRand(e.html0, r.w, r.h));
  assert.ok(treu.anteil < 0.01, `Layout im Rahmen verrutscht: ${JSON.stringify(treu)}`);
});

test('Bereich schneidet zu: ohne Rahmen (Klick) bleibt alles im Fang (Gegenprobe)', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/raster.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const html = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#raster')).html);
  await p.close();
  for (const da of ['Karte 1', 'Karte 6', 'Abzeichen']) assert.ok(html.includes(da), da);
});

test('Extras: ohne Taste keine Breiten, mit E schon', async () => {
  const ohne = await auswahlSeite('/breiten.html');
  await ohne.mouse.click(100, 60);
  const n1 = await fangWarten(ohne);
  await ohne.close();
  assert.equal(n1.breiten, 0, 'Breiten ohne Extras aufgenommen');
  const mit = await auswahlSeite('/breiten.html');
  await mit.mouse.move(100, 60);
  await mit.keyboard.press('e');
  await mit.mouse.click(100, 60);
  const n2 = await fangWarten(mit);
  await mit.close();
  assert.equal(n2.breiten, 2, 'E schaltet die Breiten nicht zu');
});

test('Sollbild: zusammengesetztes Bild ist WebP, Format wird mitgeliefert', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/streifen.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  await mitAufnahme(p);
  const s = await p.evaluate(async () => { const s = await window.__yoinkSollbild(document.querySelector('#ziel'), window.__testAufnehmen, { pause: 50 }); return { kopf: atob(s.bild.slice(0, 20)).slice(0, 12), format: s.format }; });
  await p.close();
  assert.equal(s.format, 'webp');
  assert.match(s.kopf, /^RIFF....WEBP/s);
});

// --- 0.10.0: iframes, Originalquellen, Shader ---------------------------------------------------

async function rahmenMitte(p) {
  return p.evaluate(() => { const r = document.querySelector('#r').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
}

test('iframe ist im Auswahlmodus als Ganzes anwählbar, srcdoc kommt unverändert mit', async () => {
  const p = await auswahlSeite('/rahmen-srcdoc.html');
  const [x, y] = await rahmenMitte(p);
  await p.mouse.move(x - 20, y); await p.mouse.move(x, y);
  await p.mouse.click(x, y);
  const n = await fangWarten(p);
  await p.close();
  assert.match(n.meta.selektor, /iframe#r$/);
  assert.equal(n.quelltexte.length, 1, JSON.stringify(n.quelltexte.map((q) => q.datei)));
  assert.equal(n.quelltexte[0].datei, 'source.html');
  assert.equal(n.quelltexte[0].quelle, SRCDOC, 'srcdoc verändert');
  assert.deepEqual(n.quelltexte[0].extern.sort(), ['https://cdn.tailwindcss.com/3.4.1', 'https://fonts.googleapis.com/css2?family=Inter']);
});

test('iframe derselben Domain: darin gefangen wie auf einer normalen Seite', async () => {
  const p = await auswahlSeite('/rahmen-gleich.html');
  const [x, y] = await rahmenMitte(p);
  await p.mouse.move(x - 20, y); await p.mouse.move(x, y);
  await p.mouse.click(x, y);
  const n = await fangWarten(p);
  const px = await p.evaluate((b) => window.__testPixel(b, [[5, 5]]), n.bildB64);
  await p.close();
  assert.equal(n.iframe && n.iframe.art, 'gleich');
  assert.ok(n.html.includes('Karte') && n.html.includes('linear-gradient'), 'Inhalt des iframes fehlt in element.html');
  // Sollbild an der Stelle des iframes: oben links liegt der Hintergrund von body im iframe (#eef2ff),
  // ohne Versatz laege dort der weisse Rand der Seite
  assert.deepEqual(px.farben[0], [238, 242, 255], `Sollbild nicht im iframe ausgeschnitten: ${px.farben[0]}`);
  assert.ok(!n.html.includes('<iframe'), 'iframe statt Inhalt gefangen');
});

test('iframe fremder Domain: Adresse gesäubert, kein Quelltext, Hinweis (Gegenprobe)', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/rahmen-fremd.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const e = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#r')));
  await p.close();
  assert.equal(e.iframe.art, 'fremd');
  assert.ok(e.iframe.adresse.includes('/fremd-seite.html') && !e.iframe.adresse.includes('geheim123'), e.iframe.adresse);
  assert.ok(!e.iframe.quelle, 'Quelltext einer fremden Seite');
});

test('Originalquellen: Stylesheets mit passenden Regeln unverändert gesichert, ohne passende Regel nicht', async () => {
  const e = await vervollstaendigt('/quellen-weg.html', null, { quellen: true });
  // nur Stylesheets; Skripte kommen mit E ebenfalls (eigener Test), hier steckt auch capture.js als <script>
  const q = (e.quellen || []).filter((x) => x.datei.endsWith('.css'));
  assert.equal(q.length, 1, JSON.stringify(q.map((x) => x.datei)));
  assert.equal(q[0].text, '#ziel { padding: 8px; background: #fef3c7; }');
  assert.equal(q[0].minifiziert, false);
  const f = await vervollstaendigt('/fremd.html', '.nur-fremd { width: 200px; padding: 20px; }', { quellen: true });
  assert.ok((f.quellen || []).some((x) => x.url.endsWith('/fremd.css') && x.text === '.nur-fremd { width: 200px; padding: 20px; }'), JSON.stringify(f.quellen));
});

test('Shader: GLSL des aktiven Programms wird mitgelesen', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/shader.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const r = await p.evaluate(() => { const e = window.__yoinkErfassen(document.querySelector('#ziel')); return { shader: e.shader, vs: window.__VS, fs: window.__FS, luecken: e.meta.luecken }; });
  await p.close();
  assert.deepEqual(r.shader.map((s) => [s.typ, s.quelle]), [['vertex', r.vs], ['fragment', r.fs]]);
  assert.ok(r.luecken.some((l) => l.includes('shader code included')), JSON.stringify(r.luecken));
});

test('Shader: Canvas 2D hat keinen, Hinweis sagt es (Gegenprobe)', async () => {
  const { meta, ...rest } = await fangen('/leinwand.html');
  assert.deepEqual(rest.shader || [], []);
  assert.ok(meta.luecken.some((l) => l.includes('Canvas 2D')), JSON.stringify(meta.luecken));
});

test('Medium als Wurzel (Canvas, iframe direkt gewählt): element.html zeigt das Standbild, nicht das leere Medium', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/shader.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const canvas = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#c')).html);
  await p.goto(basis + '/rahmen-srcdoc.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const rahmen = await p.evaluate(() => window.__yoinkErfassen(document.querySelector('#r')).html);
  await p.close();
  for (const [name, html, tag] of [['Canvas', canvas, '<canvas'], ['iframe', rahmen, '<iframe']]) {
    const body = html.slice(html.indexOf('<body>'));
    assert.ok(!body.includes(tag), `${name}: leeres Medium in element.html`);
    assert.match(body, /<img [^>]*src="images\/still-1\.webp"/, `${name}: Standbild fehlt`);
  }
});

test('Titel eines iframes: title-Attribut, sonst <title> aus srcdoc, sonst „Eingebettetes Fenster“', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/rahmen-srcdoc.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const titel = await p.evaluate(() => {
    const r = document.querySelector('#r');
    const a = window.__yoinkErfassen(r).meta.label;
    r.setAttribute('title', 'Vorschau Login');
    const b = window.__yoinkErfassen(r).meta.label;
    r.removeAttribute('title'); r.setAttribute('srcdoc', '<p>ohne Titel</p>');
    const c = window.__yoinkErfassen(r).meta.label;
    return [a, b, c];
  });
  await p.close();
  assert.deepEqual(titel, ['Anmeldung mit Glas', 'Vorschau Login', 'Embedded frame']);
});

// --- 0.11.0: srcdoc überall im Fang, Originalquellen nur mit E ---------------------------------

test('srcdoc im Elternelement und im Rahmen: Quelltext immer dabei, nie „fremde Seite“', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/rahmen-srcdoc.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const r = await p.evaluate(() => {
    const karte = document.querySelector('#karte');
    const eltern = window.__yoinkErfassen(karte);
    const k = karte.getBoundingClientRect();
    const b = window.__yoinkBereich({ x: k.left, y: k.top, w: k.width, h: k.height });
    const rahmen = window.__yoinkErfassen(b.element, { teil: b.ausschnitt });
    return { eltern: { q: eltern.quelltexte, l: eltern.meta.luecken, m: eltern.meta.medien }, rahmen: { q: rahmen.quelltexte, l: rahmen.meta.luecken } };
  });
  await p.close();
  for (const [name, f] of Object.entries(r)) {
    assert.equal(f.q.length, 1, `${name}: ${JSON.stringify(f.q)}`);
    assert.equal(f.q[0].quelle, SRCDOC, `${name}: Quelltext verändert`);
    assert.equal(f.q[0].datei, 'source.html');
    assert.ok(!f.l.some((l) => /other site|not transferable/.test(l)), `${name}: ${JSON.stringify(f.l)}`);
    assert.ok(f.l.some((l) => l.includes('original code in source.html')), `${name}: ${JSON.stringify(f.l)}`);
  }
  assert.equal(r.eltern.m[0].quelltext, 'source.html');
  // Lage im Fang: #karte hat 20 px Innenabstand
  assert.deepEqual([r.eltern.q[0].x, r.eltern.q[0].y, r.eltern.q[0].breite, r.eltern.q[0].hoehe], [20, 20, 300, 150]);
});

test('Zwei srcdoc-iframes: source-1.html und source-2.html; fremdes iframe ohne Quelltext (Gegenprobe)', async () => {
  const e = await fangen('/rahmen-zwei.html');
  assert.deepEqual(e.quelltexte.map((q) => [q.datei, q.quelle.includes('eins') ? 'eins' : 'zwei']), [['source-1.html', 'eins'], ['source-2.html', 'zwei']]);
  assert.ok(e.meta.luecken.some((l) => /other site/.test(l)), 'fremdes iframe nicht mehr gemeldet');
});

test('Originalquellen ohne E: keine Dateien (Gegenprobe)', async () => {
  const e = await vervollstaendigt('/quellen-weg.html', null);
  assert.deepEqual(e.quellen || [], []);
  assert.ok(!(e.nachladen || []).some((n) => n.art === 'quellen'));
});

test('Originalquellen mit E: auch alle Skripte der Seite, eingebettete und verlinkte', async () => {
  const e = await vervollstaendigt('/skripte.html', null, { quellen: true });
  const js = (e.quellen || []).filter((q) => q.datei.endsWith('.js'));
  assert.ok(js.some((q) => q.datei === 'werkzeug.js' && q.text === 'window.werkzeug = function () { return 42; };'), JSON.stringify(js.map((q) => q.datei)));
  assert.ok(js.some((q) => /^inline-\d+\.js$/.test(q.datei) && q.text === 'window.innen = 1;'), JSON.stringify(js.map((q) => q.datei)));
});

// --- 0.12.0: Originalcode-Komponente mit E, Tracking nie -------------------------------------

test('E bei vorhandener source.html: keine Originalquellen der umgebenden Seite', async () => {
  const p = await neueSeite();
  await p.goto(basis + '/rahmen-srcdoc.html', { waitUntil: 'load' });
  await p.addScriptTag({ content: ERFASSEN });
  const e = await p.evaluate(async () => { const erg = window.__yoinkErfassen(document.querySelector('#karte')); await window.__yoinkVervollstaendigen(erg, null, { quellen: true }); return erg; });
  await p.close();
  assert.equal(e.quelltexte.length, 1);
  assert.deepEqual(e.quellen || [], [], 'Seitenquellen trotz source.html');
  assert.ok(!(e.nachladen || []).some((n) => n.art === 'quellen'));
});

test('Tracking-Skripte werden nie gesichert, andere Skripte schon (Gegenprobe)', async () => {
  const e = await vervollstaendigt('/tracking.html', null, { quellen: true });
  const alle = [...(e.quellen || []).map((q) => q.datei + ' ' + q.url + ' ' + q.text), ...(e.nachladen || []).map((n) => n.url)].join('\n');
  assert.ok(!/googletagmanager|umami|gtag\(/.test(alle), alle);
  assert.ok((e.quellen || []).some((q) => q.datei === 'werkzeug.js'), alle);
});
