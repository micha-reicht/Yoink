// Service Worker von yoink: Kuerzel/Icon -> Auswahlmodus einspielen; "aufnehmen" -> Sollbild und
// Standbilder der Medien ausschneiden; "gefangen" -> alles an den Host geben, der in den gewaehlten
// Ordner schreibt und den Render-Vergleich macht.
//
// Der Ablageordner kommt nur aus chrome.storage.local (Optionsseite oder Ordner-Dialog des Hosts),
// nie aus einer Nachricht der Seite.
const HOST = 'io.yoink.helper';
const TITEL = 'yoink (⌥⇧Y)';

function uebersetzen(text) {
  const t = String(text || '');
  if (/not found/i.test(t)) return 'yoink helper is not installed – run install.sh from the yoink folder';
  if (/forbidden/i.test(t)) return 'yoink helper refused access – extension ID does not match, run install.sh again';
  if (/exited|communicating/i.test(t)) return 'yoink helper crashed – see README, section “Troubleshooting”';
  if (/exceed|too large|size/i.test(t)) return 'Element too large, pick a smaller one';
  if (/cannot be scripted|cannot access|chrome:\/\//i.test(t)) return 'Chrome does not allow extensions on this page';
  return t;
}

async function ordnerLesen() {
  const { ordner } = await chrome.storage.local.get('ordner');
  return typeof ordner === 'string' && ordner.trim() ? ordner : '';
}

// Ordner-Dialog des Hosts (macOS "choose folder"); gewaehlter Ordner wird gespeichert
async function ordnerWaehlen() {
  const a = await chrome.runtime.sendNativeMessage(HOST, { typ: 'ordner_waehlen' });
  if (a && a.ok && a.ordner) await chrome.storage.local.set({ ordner: a.ordner });
  return a;
}

// Rechteck (CSS-Pixel im Viewport) aus der Aufnahme schneiden, auf den Viewport begrenzt
async function ausschneiden(voll, m, rect) {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  rect = { x, y, w: rect.w - (x - rect.x), h: rect.h - (y - rect.y) };
  const sx = Math.round(rect.x * m), sy = Math.round(rect.y * m);
  const sw = Math.min(voll.width - sx, Math.round(rect.w * m));
  const sh = Math.min(voll.height - sy, Math.round(rect.h * m));
  if (sw <= 0 || sh <= 0) return '';
  const leinwand = new OffscreenCanvas(sw, sh);
  leinwand.getContext('2d').drawImage(voll, sx, sy, sw, sh, 0, 0, sw, sh);
  // WebP 0,9: rund 13-mal kleiner als PNG, im Render-Vergleich ohne messbare Abweichung
  const bild = await leinwand.convertToBlob({ type: 'image/webp', quality: 0.9 });
  const bytes = new Uint8Array(await bild.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function zustandZeigen() {
  try {
    const a = await chrome.runtime.sendNativeMessage(HOST, { typ: 'ping' });
    if (!a || !a.ok) throw new Error('no answer');
    const ordner = await ordnerLesen();
    await chrome.action.setBadgeText({ text: ordner ? '' : '?' });
    await chrome.action.setTitle({ title: ordner ? `${TITEL} – saves to ${ordner}` : `${TITEL} – no save folder yet, you will be asked on the first catch` });
  } catch (e) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: `yoink – ${uebersetzen(e.message)}` });
  }
}

chrome.runtime.onInstalled.addListener(zustandZeigen);
chrome.runtime.onStartup.addListener(zustandZeigen);
chrome.storage.onChanged.addListener((aenderung) => { if (aenderung.ordner) zustandZeigen(); });

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js', 'picker.js'] });
  } catch (e) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: `yoink – ${uebersetzen(e.message)}` });
  }
});

chrome.runtime.onMessage.addListener((nachricht, absender, antworten) => {
  // Optionsseite: Ordner pruefen oder per Dialog waehlen. Nur von der eigenen Optionsseite, nie von einer Seite.
  const vonOptionen = !absender.tab && absender.url && absender.url.startsWith(chrome.runtime.getURL('options.html'));
  if (nachricht && nachricht.typ === 'optionen_pruefen' && vonOptionen) {
    chrome.runtime.sendNativeMessage(HOST, { typ: 'ordner_pruefen', ordner: String(nachricht.ordner || '') })
      .then(antworten, (e) => antworten({ ok: false, fehler: uebersetzen(e.message) }));
    return true;
  }
  if (nachricht && nachricht.typ === 'optionen_waehlen' && vonOptionen) {
    ordnerWaehlen().then(antworten, (e) => antworten({ ok: false, fehler: uebersetzen(e.message) }));
    return true;
  }
  if (nachricht && nachricht.typ === 'holen') {
    // Fremdes Stylesheet ueber den Host, weil die Seite es per CORS nicht lesen darf
    chrome.runtime.sendNativeMessage(HOST, { typ: 'holen', url: String(nachricht.url || ''), ua: navigator.userAgent })
      .then(antworten, (e) => antworten({ ok: false, fehler: uebersetzen(e.message) }));
    return true;
  }
  if (nachricht && nachricht.typ === 'aufnehmen') {
    // Sollbild und Standbilder der Medien aus einer Aufnahme; die Seite stellt danach sofort zurueck
    (async () => {
      try {
        const url = await chrome.tabs.captureVisibleTab(absender.tab.windowId, { format: 'png' });
        const voll = await createImageBitmap(await (await fetch(url)).blob());
        // Massstab aus dem echten Bild gegen die Viewport-Breite; devicePixelRatio nur als Ersatz
        const m = nachricht.viewport ? voll.width / nachricht.viewport : (nachricht.dpr || 1);
        const bild = nachricht.rect ? await ausschneiden(voll, m, nachricht.rect) : '';
        const standbilder = [];
        for (const r of nachricht.medien || []) {
          const b = await ausschneiden(voll, m, r);
          if (b) standbilder.push({ datei: `still-${r.nr}.webp`, base64: b });
        }
        antworten({ ok: true, bild, standbilder });
      } catch (e) {
        antworten({ ok: false, fehler: e.message });
      }
    })();
    return true;
  }
  if (!nachricht || nachricht.typ !== 'gefangen') return false;
  (async () => {
    try {
      // Ohne Ordner nichts schreiben: erst fragen (Dialog), bei Abbruch nichts gespeichert
      let ordner = await ordnerLesen();
      if (!ordner) {
        const wahl = await ordnerWaehlen();
        if (!wahl || !wahl.ok) {
          antworten({ ok: false, fehler: (wahl && wahl.fehler) || 'No folder chosen – nothing was saved.' });
          return;
        }
        ordner = wahl.ordner;
      }
      const antwort = await chrome.runtime.sendNativeMessage(HOST, {
        typ: 'fangen', ordner, html: nachricht.html, css: nachricht.css, meta: nachricht.meta, bild_png_base64: nachricht.bild || '',
        schriften: nachricht.schriften || [], bilder: nachricht.bilder || [], nachladen: nachricht.nachladen || [],
        breiten: nachricht.breiten || [],
        breiten_nachholen: nachricht.breiten_nachholen || null,
        iframe: nachricht.iframe || null, quellen: nachricht.quellen || [], shader: nachricht.shader || [],
        quelltexte: nachricht.quelltexte || [],
      });
      antworten(antwort);
    } catch (e) {
      antworten({ ok: false, fehler: uebersetzen(e.message) });
    }
  })();
  return true; // Antwort kommt asynchron
});
