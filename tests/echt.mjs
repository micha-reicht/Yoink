// Ende-zu-Ende mit der echten Extension und dem echten Host an echten Seiten.
//
//   node echt.mjs <arbeitsordner> [ziel,ziel …]
//
// Ablauf wie bei Kolleg:innen: install.sh in ein Test-HOME (<arbeitsordner>/home), Extension aus dem
// installierten Ordner, Host ueber Chromes NativeMessagingHosts-Eintrag. Abweichungen, damit es headless
// geht: eine Kopie der Extension bekommt host_permissions <all_urls> (der Toolbar-Klick fuer activeTab
// laesst sich nicht druecken), der Eintrag liegt im Testprofil, und YOINK_TEST_PICK ersetzt den
// macOS-Ordnerdialog. Auf den Seiten wird nichts angeklickt ausser im Auswahlmodus von yoink.
//
// Phase "abbruch": kein Ordner gesetzt, Dialog abgebrochen -> nichts geschrieben, Einstellung leer.
// Phase "faenge": kein Ordner gesetzt, Dialog waehlt <arbeitsordner>/ablage -> erster Fang fragt, die
// weiteren nutzen die Einstellung.
import puppeteer from 'puppeteer-core';
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [,, arbeit, nur] = process.argv;
if (!arbeit) { console.error('Aufruf: node echt.mjs <arbeitsordner> [ziele]'); process.exit(2); }
rmSync(arbeit, { recursive: true, force: true });
const home = join(arbeit, 'home');
const ablage = join(arbeit, 'ablage');
mkdirSync(join(home, 'Library/Application Support/Google/Chrome'), { recursive: true });
mkdirSync(ablage, { recursive: true });

const homeVorher = alleDateienUndOrdner(home);
// 1. Installieren wie dokumentiert (Quelle: QUELLE oder der Werkzeugordner)
const quelle = process.env.QUELLE || fileURLToPath(new URL('..', import.meta.url));
const inst = spawnSync('/bin/bash', [join(quelle, 'install.sh')], { env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8' });
if (inst.status !== 0) { console.error(inst.stdout, inst.stderr); process.exit(1); }
const installiert = join(home, 'Library/Application Support/yoink');
const eintrag = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/io.yoink.helper.json');

export const ZIELE = {
  unicorn: { url: 'https://www.aura.build/component/A392B4D', art: 'iframe', extras: true },
  tagesschau: { url: 'https://www.tagesschau.de/', art: 'klick', finden: "document.querySelector('div#content > div.columns.twelve')" },
  pinterest: { url: 'https://de.pinterest.com/pin/1007750854137208059/', art: 'rahmen', fenster: [1920, 1200],
    finden: "[...document.querySelectorAll('div.Masonry_P')].sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0]" },
};

function alleDateienUndOrdner(ordner) {
  const aus = [];
  for (const n of readdirSync(ordner)) {
    const p = join(ordner, n);
    aus.push(p);
    if (lstatSync(p).isDirectory()) aus.push(...alleDateienUndOrdner(p));
  }
  return aus;
}

function alleDateien(ordner) {
  const aus = [];
  for (const n of readdirSync(ordner)) {
    if (n.startsWith('profil-')) continue; // Chrome-Profile der Testlaeufe gehoeren nicht zum Fang
    const p = join(ordner, n);
    const s = lstatSync(p);
    if (s.isDirectory()) aus.push(...alleDateien(p)); else aus.push(p);
  }
  return aus;
}

async function starten(pick, profilName) {
  // Testkopie der installierten Extension mit host_permissions; gleiche ID (kommt aus "key")
  const ext = join(arbeit, `ext-${profilName}`);
  cpSync(join(installiert, 'extension'), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const profil = join(arbeit, `profil-${profilName}`);
  mkdirSync(join(profil, 'NativeMessagingHosts'), { recursive: true });
  cpSync(eintrag, join(profil, 'NativeMessagingHosts/io.yoink.helper.json'));
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, pipe: true, enableExtensions: [ext], userDataDir: profil,
    args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    env: { ...process.env, YOINK_TEST_PICK: pick },
  });
  const swZiel = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
  return { browser, sw: await swZiel.worker() };
}

async function fang(browser, sw, name, z) {
  const p = await browser.newPage();
  const [w, h] = z.fenster || [1440, 900];
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await p.goto(z.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 9000));
  const ausdruck = z.finden || "document.querySelector('iframe[srcdoc]') || document.querySelector('iframe')";
  const r = await p.evaluate((a) => { const el = eval(a); if (!el) return null; el.scrollIntoView({ block: 'start' }); return true; }, ausdruck);
  if (!r) { await p.close(); return { name, fehler: 'Ziel auf der Seite nicht gefunden' }; }
  await new Promise((ok) => setTimeout(ok, 1200));
  const box = await p.evaluate((a) => { const b = eval(a).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }, ausdruck);
  const ok = await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u.split('#')[0] + '*' });
    if (!tab) return 'kein Tab';
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js', 'picker.js'] });
    return 'ok';
  }, p.url());
  if (ok !== 'ok') { await p.close(); return { name, fehler: `Auswahl nicht gestartet: ${ok}` }; }
  await new Promise((ok2) => setTimeout(ok2, 500));
  const vorher = new Set(alleDateien(arbeit));
  const t0 = Date.now();
  const mx = Math.max(5, box.x) + Math.min(box.w, w) / 2, my = Math.max(5, box.y) + Math.min(box.h, h - Math.max(0, box.y)) / 2;
  await p.mouse.move(mx - 30, my); await p.mouse.move(mx, my, { steps: 3 });
  if (z.extras) await p.keyboard.press('e');
  if (z.art === 'klick') {
    const hoch = await p.evaluate((a, x, y) => { const ziel = eval(a); let e = document.elementFromPoint(x, y), n = 0;
      while (e && e !== ziel && n < 30) { e = e.parentElement; n++; } return e === ziel ? n : -1; }, ausdruck, mx, my);
    if (hoch < 0) { await p.close(); return { name, fehler: 'Ziel liegt nicht unter dem Zeiger' }; }
    for (let i = 0; i < hoch; i++) await p.keyboard.press('ArrowUp');
  }
  if (z.art === 'rahmen') {
    const x0 = Math.max(2, box.x + 4), y0 = Math.max(2, box.y);
    const x1 = Math.min(w - 2, x0 + Math.min(1696, box.w - 2)), y1 = Math.min(h - 2, y0 + Math.min(1064, box.h));
    await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move(x1, y1, { steps: 10 }); await p.mouse.up();
  } else {
    await p.mouse.down(); await p.mouse.up(); // ohne Zeigerbewegung, sonst setzt mousemove die Ebene zurueck
  }
  let readme = null;
  const frist = z.warten || 240;
  for (let i = 0; i < frist && !readme; i++) {
    await new Promise((ok3) => setTimeout(ok3, 1000));
    readme = alleDateien(ablage).find((d) => d.endsWith('/README.md') && !vorher.has(d)) || null;
  }
  const sekunden = (Date.now() - t0) / 1000;
  await new Promise((ok4) => setTimeout(ok4, 1500));
  const neu = alleDateien(arbeit).filter((d) => !vorher.has(d) && !d.includes('/profil-'));
  await p.close();
  return { name, readme, sekunden, neu_ausserhalb_ablage: neu.filter((d) => !d.startsWith(ablage + '/')) };
}

const ergebnisse = { installiert: inst.stdout.includes('yoink is installed') };

// Phase abbruch
if (!nur || nur.split(',').includes('abbruch')) {
  const { browser, sw } = await starten('cancel', 'abbruch');
  const vorher = alleDateien(arbeit).filter((d) => !d.includes('/profil-'));
  const r = await fang(browser, sw, 'abbruch-tagesschau', { ...ZIELE.tagesschau, warten: 25 });
  const einstellung = await sw.evaluate(async () => (await chrome.storage.local.get('ordner')).ordner || null);
  const nachher = alleDateien(arbeit).filter((d) => !d.includes('/profil-'));
  await browser.close();
  ergebnisse.abbruch = { readme: r.readme, einstellung, neue_dateien: nachher.filter((d) => !vorher.includes(d)) };
}

// Phase faenge
if (!nur || nur.split(',').some((n) => ZIELE[n])) {
  const { browser, sw } = await starten(ablage, 'faenge');
  ergebnisse.einstellung_vorher = await sw.evaluate(async () => (await chrome.storage.local.get('ordner')).ordner || null);
  ergebnisse.faenge = [];
  for (const [name, z] of Object.entries(ZIELE)) {
    if (nur && !nur.split(',').includes(name)) continue;
    ergebnisse.faenge.push(await fang(browser, sw, name, z));
  }
  ergebnisse.einstellung_nachher = await sw.evaluate(async () => (await chrome.storage.local.get('ordner')).ordner || null);
  await browser.close();
}

// Deinstallieren wie dokumentiert (uninstall.sh aus dem entpackten Ordner), dann Reste im HOME zaehlen.
// Apples Python legt ~/Library/Caches/com.apple.python an; das ist der Interpreter, nicht yoink.
if (process.env.DEINSTALLIEREN) {
  const un = spawnSync('/bin/bash', [join(quelle, 'uninstall.sh')], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  const cache = join(home, 'Library/Caches');
  const nachher = alleDateienUndOrdner(home).filter((d) => d !== cache && !d.startsWith(cache + '/'));
  ergebnisse.deinstalliert = { exit: un.status, reste: nachher.filter((d) => !homeVorher.includes(d)),
    ablage_dateien: alleDateien(ablage).length, eintraege_im_home_vorher: homeVorher.length };
}

writeFileSync(join(arbeit, 'echt-ergebnis.json'), JSON.stringify(ergebnisse, null, 2));
console.log(JSON.stringify(ergebnisse, null, 2));
