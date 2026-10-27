// Auswahlmodus von yoink: Element unter der Maus umranden, ↑/↓ wechseln, Klick faengt,
// Ziehen faengt einen Bereich, Esc bricht ab. Wird bei jedem Kuerzel neu injiziert; ein zweiter
// Aufruf schaltet aus.
(() => {
  if (window.__yoinkAuswahl) { window.__yoinkAuswahl.umschalten(); return; }

  const FARBE = '#ff5a1f';
  const ZIEH_SCHWELLE = 6; // ab so vielen Pixeln Weg ist es Ziehen, kein Klick
  let aktiv = false;
  let ziehen = null; // { x0, y0, x, y, aktiv }
  // Extras (Taste E): Breiten 390/768, Durchscrollen hoher Elemente, Bewegung pruefen. Standard aus,
  // damit ein Fang schnell und klein bleibt.
  let extras = false;
  const HINWEIS = () => `Point and click to yoink. <b>Drag</b> to yoink an area. <b>↑</b> one level up, <b>↓</b> down, ` +
    `<b>E</b> extras ${extras ? '<b>on</b> (widths 390/768, scroll through, motion, offline copy of embedded code)' : 'off'}, <b>Esc</b> to quit.`;
  let aktuell = null;
  let wirt = null, rahmen = null, schild = null, hinweis = null;

  function bauen() {
    wirt = document.createElement('yoink-overlay');
    wirt.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647';
    const sr = wirt.attachShadow({ mode: 'closed' });
    sr.innerHTML = `
      <style>
        .rahmen { position: fixed; border: 2px solid ${FARBE}; background: rgba(255,90,31,0.08); box-sizing: border-box; display: none; }
        .schild { position: fixed; background: ${FARBE}; color: #fff; font: 600 11px/1.6 ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 3px; white-space: nowrap; display: none; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
        .hinweis { position: fixed; right: 16px; bottom: 16px; max-width: 360px; background: #141a33; color: #fff; font: 13px/1.45 system-ui, -apple-system, sans-serif; padding: 10px 14px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); display: none; }
        .hinweis b { color: ${FARBE}; }
      </style>
      <div class="rahmen"></div><div class="schild"></div><div class="hinweis"></div>`;
    rahmen = sr.querySelector('.rahmen');
    schild = sr.querySelector('.schild');
    hinweis = sr.querySelector('.hinweis');
    document.documentElement.appendChild(wirt);
  }

  function beschreiben(el) {
    let s = el.localName;
    if (el.id) s += '#' + el.id;
    const kl = [...el.classList].slice(0, 2);
    if (kl.length) s += '.' + kl.join('.');
    const r = el.getBoundingClientRect();
    s += `  ${Math.round(r.width)}×${Math.round(r.height)}`;
    // Gleich grosse Huelle mit runden Ecken, Rahmen oder Schatten: hier anbieten, nicht erst in der Notiz
    const h = window.__yoinkHuelle ? window.__yoinkHuelle(el) : null;
    if (h && h.element) s += `  ·  ↑${h.stufen > 1 ? '×' + h.stufen : ''} wrapper with ${h.merkmale.join(', ')}`;
    return s;
  }

  function zeigen(el) {
    aktuell = el;
    if (!el) { rahmen.style.display = schild.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(rahmen.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    schild.textContent = beschreiben(el);
    schild.style.display = 'block';
    schild.style.left = Math.max(0, r.left) + 'px';
    schild.style.top = (r.top > 22 ? r.top - 20 : Math.min(r.bottom + 2, innerHeight - 20)) + 'px';
  }

  let hinweisTimer = null;
  // dauer Infinity: bleibt stehen, bis die Auswahl endet (setTimeout liefe sonst sofort ab)
  function melden(html, dauer = 4000) {
    hinweis.innerHTML = html;
    hinweis.style.display = 'block';
    clearTimeout(hinweisTimer);
    if (Number.isFinite(dauer)) hinweisTimer = setTimeout(() => { hinweis.style.display = 'none'; }, dauer);
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function eigenes(el) { return el === wirt; }

  function zugRechteck(z) {
    const x = Math.min(z.x0, z.x), y = Math.min(z.y0, z.y);
    return { x, y, w: Math.abs(z.x - z.x0), h: Math.abs(z.y - z.y0) };
  }

  function beiDruck(e) {
    blocken(e);
    if (e.button === 0) ziehen = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, aktiv: false };
  }

  function beiZug(e) {
    if (!ziehen || !(e.buttons & 1)) return;
    if (!ziehen.aktiv && Math.hypot(e.clientX - ziehen.x0, e.clientY - ziehen.y0) < ZIEH_SCHWELLE) return;
    ziehen.aktiv = true;
    ziehen.x = e.clientX; ziehen.y = e.clientY;
    const r = zugRechteck(ziehen);
    aktuell = null;
    Object.assign(rahmen.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    schild.textContent = `Area  ${Math.round(r.w)}×${Math.round(r.h)}`;
    schild.style.display = 'block';
    schild.style.left = r.x + 'px';
    schild.style.top = (r.y > 22 ? r.y - 20 : r.y + r.h + 2) + 'px';
  }

  function beiLoslassen(e) {
    blocken(e);
    const z = ziehen;
    ziehen = null;
    if (!z || !z.aktiv) return;
    // Der click nach dem Loslassen gehoert zum Ziehen. fangen schaltet die Auswahl sofort ab, ohne
    // diesen Riegel landete er auf der Seite (Link, Knopf).
    const schlucken = (k) => { k.preventDefault(); k.stopImmediatePropagation(); };
    document.addEventListener('click', schlucken, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', schlucken, { capture: true }), 400);
    const b = window.__yoinkBereich(zugRechteck(z));
    fangen(b.element, { teil: b.ausschnitt, luecken: b.luecken });
  }

  // Mit der Sperre trifft der Zeiger das Element unter dem iframe. Liegt der Punkt in einem
  // eingebetteten Fenster und ist das getroffene Element dessen Vorfahr, ist das Fenster gemeint;
  // liegt etwas anderes darueber, bleibt es beim getroffenen Element.
  function unterZeiger(e) {
    const ziel = e.target;
    let bester = null, flaeche = Infinity;
    for (const f of document.querySelectorAll('iframe, frame, embed, object')) {
      const r = f.getBoundingClientRect();
      if (!r.width || !r.height || e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) continue;
      if (!(ziel && ziel.nodeType === 1 && ziel.contains(f))) continue;
      if (r.width * r.height < flaeche) { bester = f; flaeche = r.width * r.height; }
    }
    return bester || ziel;
  }

  function beiBewegung(e) {
    if (ziehen && ziehen.aktiv) return;
    const el = unterZeiger(e);
    if (!el || eigenes(el) || el.nodeType !== 1) return;
    if (el !== aktuell) zeigen(el);
  }

  function blocken(e) {
    if (!aktiv) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function beiKlick(e) {
    blocken(e);
    if (aktuell) fangen(aktuell);
  }

  function beiTaste(e) {
    if (!aktiv) return;
    if (e.key === 'Escape') { blocken(e); aus(); return; }
    if (e.key === 'e' || e.key === 'E') { blocken(e); extras = !extras; melden(HINWEIS(), Infinity); return; }
    if (e.key === 'ArrowUp' && aktuell && aktuell.parentElement && aktuell.parentElement !== document.documentElement) {
      blocken(e); zeigen(aktuell.parentElement);
    } else if (e.key === 'ArrowDown' && aktuell && aktuell.firstElementChild) {
      blocken(e); zeigen(aktuell.firstElementChild);
    }
  }

  // pointerdown abgefangen: Chrome schickt danach kein mousedown/mousemove/mouseup, das Ziehen
  // laeuft deshalb ueber pointermove
  const ZEIGER = ['mousedown', 'mouseup', 'dblclick', 'contextmenu'];

  // Ueber einem iframe kommen Maus und Klick nicht im Hauptdokument an, sondern im eingebetteten
  // Fenster. Waehrend der Auswahl nehmen eingebettete Fenster deshalb keine Zeiger-Ereignisse an:
  // dann trifft der Zeiger das iframe-Element selbst, und es ist als Ganzes anwaehlbar.
  let sperre = null;
  function an() {
    if (!wirt) bauen();
    aktiv = true;
    if (!sperre) {
      sperre = document.createElement('style');
      sperre.textContent = 'iframe, frame, embed, object { pointer-events: none !important; }';
      document.documentElement.appendChild(sperre);
    }
    document.addEventListener('mousemove', beiBewegung, true);
    document.addEventListener('click', beiKlick, true);
    document.addEventListener('pointerdown', beiDruck, true);
    document.addEventListener('pointermove', beiZug, true);
    document.addEventListener('pointerup', beiLoslassen, true);
    ZEIGER.forEach((t) => document.addEventListener(t, blocken, true));
    window.addEventListener('keydown', beiTaste, true);
    melden(HINWEIS(), Infinity);
  }

  function aus() {
    aktiv = false;
    if (sperre) { sperre.remove(); sperre = null; }
    document.removeEventListener('mousemove', beiBewegung, true);
    document.removeEventListener('click', beiKlick, true);
    document.removeEventListener('pointerdown', beiDruck, true);
    document.removeEventListener('pointermove', beiZug, true);
    document.removeEventListener('pointerup', beiLoslassen, true);
    ziehen = null;
    ZEIGER.forEach((t) => document.removeEventListener(t, blocken, true));
    window.removeEventListener('keydown', beiTaste, true);
    zeigen(null);
    if (hinweis) hinweis.style.display = 'none';
  }

  async function inZwischenablage(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* weiter mit Ersatzweg */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.documentElement.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  const warte = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // bereich: { teil: Rahmen im Element, luecken } aus der Bereichsauswahl, sonst das ganze Element
  //
  // Erst aufnehmen, dann erfassen: Seiten mit Endlosliste laden beim Scrollen der Aufnahme nach.
  // Danach erfasst, zeigt element.html denselben Stand wie das Sollbild.
  async function fangen(el, bereich = null) {
    aus();
    // iframe: srcdoc und fremde Fenster werden als Ganzes gefangen, eins derselben Domain von innen
    const rahmen = !bereich && el.localName === 'iframe' ? window.__yoinkRahmen(el) : null;
    if (rahmen && rahmen.art === 'gleich') el = rahmen.koerper;
    hinweis.style.display = 'none';
    await warte(); // Rahmen und Hinweis muessen aus dem Bild sein, bevor Chrome es aufnimmt
    if (extras && !bereich && el.getBoundingClientRect().height > innerHeight) {
      // lazy geladene Bilder bekommen erst beim Hinscrollen ihre Quelle
      melden('Scrolling through once so all images load …', 30000);
      try { await window.__yoinkDurchscrollen(el); } catch { /* Fang geht trotzdem */ }
      hinweis.style.display = 'none';
      await warte();
    }
    // 1. Aufnehmen: Seitenkopf aus, Element (bei hohen Elementen Stueck fuer Stueck) ins Bild,
    //    Sollbild und Standbilder der Medien
    const aufnehmen = (rect, medien) => chrome.runtime.sendMessage({ typ: 'aufnehmen', rect, medien, viewport: innerWidth, dpr: devicePixelRatio });
    let aufnahme;
    try {
      const teil = bereich ? bereich.teil : null;
      const medienNr = window.__yoinkMedienRechtecke(el, teil).map((m) => m.nr);
      // Bewegung: beim Klick, wenn das Element Medien hat (eine Aufnahme mehr, 0,55 s); beim Bereich nur als Extra
      aufnahme = await window.__yoinkSollbild(el, aufnehmen, { teil, medien: medienNr, bewegung: extras || (!bereich && medienNr.length > 0) });
    } catch (fehler) {
      aufnahme = { bild: '', standbilder: [], ausschnitt: null, luecken: [`Image not captured: ${fehler.message}`] };
    }
    // 2. Erfassen und Dateien sichern
    let erfasst;
    try {
      erfasst = window.__yoinkErfassen(el, bereich ? { teil: bereich.teil } : {});
    } catch (fehler) {
      melden(`<b>Not saved:</b> ${esc(fehler.message)}`, 6000);
      return;
    }
    melden('Yoinking … saving stylesheets, fonts and images.', 30000);
    const holer = (url) => chrome.runtime.sendMessage({ typ: 'holen', url });
    try {
      await window.__yoinkVervollstaendigen(erfasst, holer, { quellen: extras });
    } catch (fehler) {
      erfasst.meta.luecken.push(`Fonts and images not saved: ${fehler.message}`);
    }
    if (rahmen && rahmen.art !== 'srcdoc') { // srcdoc steht schon in erfasst.quelltexte
      const { koerper, quelle, ...daten } = rahmen; // das Dokument selbst geht nicht in die Nachricht
      erfasst.iframe = daten;
    }
    const luecken = erfasst.meta.luecken;
    if (bereich) luecken.push(...bereich.luecken);
    luecken.push(...aufnahme.luecken);
    // Bereich: element.html zeigt genau den Rahmen, der Ausschnitt zaehlt ab seiner Ecke
    const a = aufnahme.ausschnitt;
    erfasst.meta.ausschnitt = bereich ? (a ? { x: a.x - bereich.teil.x, y: a.y - bereich.teil.y, w: a.w, h: a.h } : null) : a;
    erfasst.meta.extras = extras;
    // Bewegt: zweite Aufnahme der Medien unterschied sich; null = nicht geprueft
    for (const m of erfasst.meta.medien || []) {
      m.bewegt = (aufnahme.geprueft || []).includes(m.nr) ? (aufnahme.bewegt || []).includes(m.nr) : null;
    }
    // 3. Extra: dieselbe Seite schmaler (390 und 768 px), Sollbild je Breite
    let breiten = { breiten: [], luecken: [], nachholen: [] };
    // Mit Originalcode im Fang rendert der Host die Breiten direkt aus source.html
    if (extras && !(erfasst.quelltexte || []).length) {
      melden('Capturing the widths 390 and 768 px …', 60000);
      hinweis.style.display = 'none';
      try {
        breiten = await window.__yoinkBreiten(erfasst.meta, [390, 768], aufnehmen);
      } catch (fehler) {
        breiten.luecken.push(`Widths not captured: ${fehler.message}`);
      }
      luecken.push(...breiten.luecken);
    }
    // Standbilder nur fuer Medien, die eins brauchen (ein lesbares Canvas bringt seine Pixel selbst)
    const brauchen = new Set((erfasst.meta.medien || []).filter((m) => m.standbild).map((m) => m.standbild.split('/').pop()));
    const standbilder = (aufnahme.standbilder || []).filter((s) => brauchen.has(s.datei));
    for (const datei of brauchen) {
      if (!standbilder.some((s) => s.datei === datei)) {
        const m = erfasst.meta.medien.find((x) => x.standbild.endsWith(datei));
        luecken.push(`Still image for ${m.art} ${m.nr} missing (not in the visible area), element.html shows nothing there`);
      }
    }

    // 2. Schreiben: Host legt Notiz und Anhang an und rendert den Vergleich
    melden('Saving and checking the render …', 30000);
    let antwort;
    try {
      antwort = await chrome.runtime.sendMessage({
        typ: 'gefangen', ...erfasst, bilder: [...erfasst.bilder, ...standbilder], bild: aufnahme.bild || '',
        breiten: breiten.breiten.map((b) => ({ breite: b.breite, base64: b.bild, ausschnitt: b.ausschnitt, hoehe: b.hoehe })),
        // Seite verbietet das Einbetten: der Host rendert diese Breiten selbst (ohne Anmeldung); die
        // rohe Adresse dient nur dem Rendern und wird nicht gespeichert
        breiten_nachholen: (breiten.nachholen || []).length
          ? { url: location.href, pfad: erfasst.meta.pfad, selektor: erfasst.meta.selektor, breiten: breiten.nachholen, dpr: devicePixelRatio }
          : null,
      });
    } catch (fehler) {
      antwort = { ok: false, fehler: fehler.message };
    }
    if (!antwort || !antwort.ok) {
      melden(`<b>Not saved:</b> ${esc((antwort && antwort.fehler) || 'no answer')}`, 10000);
      return;
    }
    const kopiert = await inZwischenablage(antwort.notiz);
    melden(`<b>Yoinked.</b><br>${esc(antwort.titel)}<br><small>${kopiert ? 'Path of README.md copied to the clipboard.' : 'Saved – the clipboard was not available.'}</small>`);
  }

  window.__yoinkAuswahl = { umschalten: () => (aktiv ? aus() : an()) };
  an();
})();
