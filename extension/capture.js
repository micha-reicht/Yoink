// Erfassungslogik von yoink. Reines DOM, ohne Chrome-APIs, damit die Tests sie
// direkt in eine Seite laden koennen. Stellt window.__yoinkErfassen(element) bereit:
//
//   -> { html, css, schriftQuellen, meta: { url, titel, label, selektor, breite, hoehe, schriften,
//                                          farben, luecken } }
//
// Dazu window.__yoinkVervollstaendigen(ergebnis, holer?): holt nicht lesbare Stylesheets ueber den
// Holer nach, sichert Schrift- und Bilddateien (ergebnis.schriften / .bilder = [{ datei, base64 }],
// URLs auf schriften/ bzw. bilder/ umgebogen) und listet in ergebnis.nachladen, was der Host
// selbst laden soll.
//
// html: eigenstaendige Seite. Jeder Knoten traegt seine wirksamen Styles als style-Attribut,
//       nur Abweichungen vom Browser-Standard (Vergleich mit einem frischen Element gleichen
//       Tags in einem leeren iframe). Vererbte Eigenschaften nur dort, wo sie sich gegenueber
//       dem Elternknoten aendern, am Wurzelknoten gegenueber dem Standard.
// css:  die echten Regeln der Seite, die auf den Ausschnitt passen, inkl. Zustaenden,
//       @media, @keyframes und @font-face. Nicht lesbare Stylesheets stehen oben im Kommentar.
//       Regeln fuer andere Zustaende (aria-pressed="false", :checked …) kommen mit, wenn sie
//       passen wuerden, sobald man den Zustand ausblendet.
// farben: jede verwendete Farbe mit den Tokens (Custom Properties), die genau diesen Wert haben.
// url:  Query-Werte, die wie IDs, Tokens oder Mails aussehen, sind durch "…" ersetzt.
// medien: Video, Canvas, iframe (object, embed) mit Flaechenanteil. Ihr Inhalt ist kein HTML;
//       element.html zeigt dort ein Standbild aus dem Sollbild (bilder/still-N.webp), das die
//       Extension beim Aufnehmen ausschneidet. Die Rechtecke dafuer liefert
//       window.__yoinkMedienRechtecke(element), in derselben Nummerierung.
(() => {
  if (window.__yoinkErfassen) return;

  const SVG = 'http://www.w3.org/2000/svg';
  const HTML = 'http://www.w3.org/1999/xhtml';

  // Vererbte Eigenschaften (Chrome-Longhands). Eine Eigenschaft hier, die in Wahrheit nicht
  // vererbt wird, ginge am Kind verloren, wenn sie dem Elternwert gleicht – Liste daher eng.
  const ERBLICH = new Set(`border-collapse border-spacing caption-side caret-color clip-rule
    color color-interpolation color-interpolation-filters color-rendering color-scheme cursor
    direction dominant-baseline empty-cells fill fill-opacity fill-rule font-family
    font-feature-settings font-kerning font-optical-sizing font-palette font-size
    font-size-adjust font-stretch font-style font-synthesis-small-caps font-synthesis-style
    font-synthesis-weight font-variant-alternates font-variant-caps font-variant-east-asian
    font-variant-emoji font-variant-ligatures font-variant-numeric font-variant-position
    font-variation-settings font-weight forced-color-adjust hyphenate-character hyphens
    image-orientation image-rendering letter-spacing line-break line-height list-style-image
    list-style-position list-style-type marker-end marker-mid marker-start orphans
    overflow-wrap paint-order pointer-events print-color-adjust quotes ruby-position
    shape-rendering stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin
    stroke-miterlimit stroke-opacity stroke-width tab-size text-align text-align-last
    text-anchor text-combine-upright text-decoration-skip-ink text-emphasis-color
    text-emphasis-position text-emphasis-style text-indent text-orientation text-rendering
    text-shadow text-size-adjust text-transform text-underline-offset text-underline-position
    text-wrap-mode text-wrap-style visibility white-space white-space-collapse widows
    word-break word-spacing writing-mode -webkit-font-smoothing -webkit-text-fill-color
    -webkit-text-stroke-color -webkit-text-stroke-width -webkit-locale
    -webkit-tap-highlight-color`.split(/\s+/).filter(Boolean));

  const WEBKIT_OK = new Set(['-webkit-font-smoothing', '-webkit-text-stroke-width',
    '-webkit-text-stroke-color', '-webkit-text-fill-color', '-webkit-line-clamp',
    '-webkit-box-orient', '-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-position',
    '-webkit-mask-repeat', '-webkit-background-clip', '-webkit-backdrop-filter']);

  // Logische Doppelungen (margin-block-start, inline-size …); die physischen reichen.
  const LOGISCH = /(^|-)(block|inline)(-|$)/;

  const ENTFERNEN = new Set(['script', 'noscript', 'template', 'style', 'link', 'meta', 'base']);
  const URL_ATTRIBUTE = ['src', 'href', 'poster', 'action', 'data', 'xlink:href'];
  const MEDIEN = { video: 'Video', canvas: 'Canvas', iframe: 'iframe', object: 'object', embed: 'embed' };
  const MEDIEN_HAUPT = 0.5; // ab diesem Flaechenanteil ist das Medium der Inhalt
  const MAX_KNOTEN = 20000;

  // Umschaltbare Zustaende: Attribute und Pseudoklassen, die eine Regel an einen Zustand binden
  const ZUSTANDS_ATTR = 'aria-pressed|aria-checked|aria-selected|aria-expanded|aria-current|aria-disabled|data-state|data-selected|data-active|data-checked|data-open|data-disabled|open|checked|selected|disabled';
  const NICHT_ZUSTAND = new RegExp(`:not\\(\\s*\\[\\s*(?:${ZUSTANDS_ATTR})\\b[^\\]]*\\]\\s*\\)`, 'g');
  const ATTR_ZUSTAND = new RegExp(`\\[\\s*(?:${ZUSTANDS_ATTR})(?:\\s*[~|^$*]?=\\s*[^\\]]*)?\\]`, 'g');
  const PSEUDO_ZUSTAND = /:(checked|disabled|enabled|indeterminate|open)\b/g;
  // Am Element beobachtete Zustaende: Schluessel -> Wert je Knoten
  const BEOBACHTET = ['aria-pressed', 'aria-checked', 'aria-selected', 'aria-expanded', 'data-state'];

  // Dokument und Fenster des Elements, das gerade erfasst wird. Meist die Seite selbst, bei einem
  // iframe derselben Domain dessen Dokument. erfassen und vervollstaendigen setzen beides.
  let D = document, W = window;
  const dokumentSetzen = (d) => { D = d || document; W = D.defaultView || window; };

  // --- URL saeubern ---------------------------------------------------------------------------

  const HEIKLER_NAME = /(^|[_-])(user|uid|userid|id|token|auth|session|sid|email|mail|key|code|jwt|sig|signature|secret|password|pass|login|account|customer|kunde)([_-]|$)|token|session|auth|email|passw/i;
  const HEIKLER_WERT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|@|^[A-Za-z0-9_\-.]{24,}$|^\d{6,}$/i;

  function saeubern(u) {
    let url;
    try { url = new URL(u, D.baseURI); } catch { return u; }
    if (!/^https?:$/.test(url.protocol)) return u;
    const neu = new URLSearchParams();
    let geaendert = false;
    for (const [n, v] of url.searchParams) {
      if (HEIKLER_NAME.test(n) || HEIKLER_WERT.test(v)) { neu.append(n, '…'); geaendert = true; } else neu.append(n, v);
    }
    if (geaendert) url.search = neu.toString();
    if (url.hash.includes('=')) { url.hash = ''; geaendert = true; }
    return geaendert ? url.href.replace(/%E2%80%A6/gi, '…') : u;
  }

  // --- Farben normalisieren -------------------------------------------------------------------

  let farbKontext = null;
  function farbe(v) {
    if (!v) return null;
    if (!farbKontext) farbKontext = new OffscreenCanvas(1, 1).getContext('2d');
    const fremd = ['#010203', '#040506'];
    const erg = fremd.map((f) => { farbKontext.fillStyle = f; farbKontext.fillStyle = v.trim(); return farbKontext.fillStyle; });
    if (erg[0] !== erg[1]) return null; // ungueltig: der Platzhalter blieb stehen
    const m = erg[0].match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
    if (!m) return erg[0];
    const a = Number(m[4]);
    if (a === 0) return 'transparent';
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]) + hex(Math.round(a * 255));
  }

  function relevant(p) {
    if (p.startsWith('--')) return false;
    if (p.startsWith('-webkit-')) return WEBKIT_OK.has(p);
    return !LOGISCH.test(p);
  }

  function absolut(u, basis) {
    try { return new URL(u, basis || D.baseURI).href; } catch { return u; }
  }

  function urlsInCss(text, basis) {
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (ganz, q, u) => {
      if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:\/\/)/i.test(u.trim())) return ganz;
      return `url("${absolut(u.trim(), basis)}")`;
    });
  }

  // --- Browser-Standard je Tag ---------------------------------------------------------------

  function standardRechner() {
    let rahmen = null;
    const cache = new Map();
    function dok() {
      if (!rahmen) {
        rahmen = D.createElement('iframe');
        rahmen.setAttribute('aria-hidden', 'true');
        rahmen.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;visibility:hidden;border:0';
        D.documentElement.appendChild(rahmen);
        const d = rahmen.contentDocument;
        d.open(); d.write('<!doctype html><html><head></head><body></body></html>'); d.close();
      }
      return rahmen.contentDocument;
    }
    function werte(node, pseudo) {
      const ns = node.namespaceURI || HTML;
      // a mit href ist ein Link (eigene Farbe, Cursor), ohne href nicht
      const link = node.localName === 'a' && typeof node.hasAttribute === 'function' && node.hasAttribute('href');
      const key = `${ns}|${node.localName}|${pseudo || ''}|${link ? 'href' : ''}`;
      if (cache.has(key)) return cache.get(key);
      const d = dok();
      let el;
      try { el = ns === HTML ? d.createElement(node.localName) : d.createElementNS(ns, node.localName); }
      catch { el = d.createElement('span'); }
      if (link) el.setAttribute('href', '#');
      let huelle = null;
      if (ns === SVG && node.localName !== 'svg') { huelle = d.createElementNS(SVG, 'svg'); huelle.appendChild(el); d.body.appendChild(huelle); }
      else d.body.appendChild(el);
      const cs = rahmen.contentWindow.getComputedStyle(el, pseudo || null);
      const w = {};
      for (let i = 0; i < cs.length; i++) w[cs[i]] = cs.getPropertyValue(cs[i]);
      (huelle || el).remove();
      cache.set(key, w);
      return w;
    }
    function aufraeumen() { if (rahmen) rahmen.remove(); rahmen = null; }
    return { werte, aufraeumen };
  }

  // neutral: Standardwerte eines span (bzw. g in SVG). Weicht der Standard des Tags davon ab
  // (h3 fett, a blau, b fett), ist ein erblicher Wert gleich dem Elternwert trotzdem noetig.
  function deklarationen(cs, std, eltern, istWurzel, neutral) {
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (!relevant(p)) continue;
      const v = cs.getPropertyValue(p);
      if (ERBLICH.has(p) && !istWurzel && eltern) {
        if (eltern.getPropertyValue(p) === v && (!neutral || std[p] === neutral[p])) continue; // kommt vom Elternknoten
      } else if (std[p] === v) continue;
      out.push([p, v]);
    }
    // Breite gehoert zum Stil: bei border-style none rechnet der Browser die Breite auf 0, deshalb
    // gleicht sie dem Standard und fiele weg – in der Kopie gilt dann solid mit 3 px (medium).
    const da = new Set(out.map(([p]) => p));
    for (const [stil, breite] of [['border-top-style', 'border-top-width'], ['border-right-style', 'border-right-width'],
      ['border-bottom-style', 'border-bottom-width'], ['border-left-style', 'border-left-width'],
      ['outline-style', 'outline-width'], ['column-rule-style', 'column-rule-width']]) {
      const s = cs.getPropertyValue(stil);
      // nur wenn der Stil gesetzt wird; sonst gilt die Breite des Browsers ohnehin, und eine
      // ausdrueckliche Breite schaltet bei Formularfeldern die native Darstellung ab
      if (da.has(stil) && s !== 'none' && s !== 'hidden' && !da.has(breite)) out.push([breite, cs.getPropertyValue(breite)]);
    }
    return out;
  }

  const alsText = (decl) => decl.map(([p, v]) => `${p}: ${v}`).join('; ');

  // --- Beschreibung -------------------------------------------------------------------------

  function selektor(el) {
    const teile = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 4; n = n.parentElement, i++) {
      if (n.id) { teile.unshift(`${n.localName}#${CSS.escape(n.id)}`); break; }
      const kl = [...n.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      teile.unshift(n.localName + kl);
      if (n === D.body) break;
    }
    return teile.join(' > ');
  }

  // Eindeutiger Pfad von body aus (nth-of-type), um das Element in einer zweiten Kopie der Seite
  // wiederzufinden (Breiten)
  function pfad(el) {
    const teile = [];
    for (let n = el; n && n !== D.body && n.parentElement; n = n.parentElement) {
      const gleiche = [...n.parentElement.children].filter((c) => c.localName === n.localName);
      teile.unshift(gleiche.length > 1 ? `${n.localName}:nth-of-type(${gleiche.indexOf(n) + 1})` : n.localName);
    }
    return ['body', ...teile].join(' > ');
  }

  function sichtbar(x) {
    if (x.checkVisibility && !x.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Sichtbare Medien im Element, in Dokumentreihenfolge. erfassen und __yoinkMedienRechtecke
  // zaehlen beide hierueber, damit Standbild-Nummer und Rechteck zusammenpassen.
  // teil: nur Medien, die den Rahmen der Bereichsauswahl schneiden
  function medienListe(root, teil = null) {
    const r0 = root.getBoundingClientRect();
    const imTeil = (o) => {
      if (!teil) return true;
      const b = o.getBoundingClientRect();
      return b.right > r0.left + teil.x && b.left < r0.left + teil.x + teil.w && b.bottom > r0.top + teil.y && b.top < r0.top + teil.y + teil.h;
    };
    return [root, ...root.querySelectorAll('*')].filter((o) => (o.namespaceURI || HTML) === HTML && MEDIEN[o.localName] && sichtbar(o) && imTeil(o));
  }

  function medienRechtecke(root, teil = null) {
    return medienListe(root, teil).map((o, i) => { const r = o.getBoundingClientRect(); return { nr: i + 1, x: r.left, y: r.top, w: r.width, h: r.height }; });
  }

  // Gleich grosse Huellen ueber dem Element (bis auf ihren Rahmen), die etwas zum Bild beitragen:
  // runde Ecken, die abschneiden, Rahmen, Schatten. Das Sollbild zeigt sie mit, der Fang nicht.
  function huelle(el) {
    const r = el.getBoundingClientRect();
    const merkmale = [];
    let ziel = null, stufen = 0;
    for (let a = el.parentElement, i = 1; a && a !== D.body && a !== D.documentElement && i <= 6; a = a.parentElement, i++) {
      const b = a.getBoundingClientRect();
      if (Math.abs(b.left - r.left) > 4 || Math.abs(b.top - r.top) > 4 || Math.abs(b.right - r.right) > 4 || Math.abs(b.bottom - r.bottom) > 4) break;
      const cs = W.getComputedStyle(a);
      const vorher = merkmale.length;
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      if (radius > 0 && cs.overflow !== 'visible') merkmale.push(`rounded corners ${Math.round(radius)}px`);
      if (['top', 'right', 'bottom', 'left'].some((s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && !/^(none|hidden)$/.test(cs.getPropertyValue(`border-${s}-style`)))) merkmale.push('border');
      if (cs.boxShadow !== 'none' && (cs.boxShadow.match(/rgba?\([^)]*\)/g) || []).some((c) => !/,\s*0\)$/.test(c))) merkmale.push('shadow');
      if (merkmale.length > vorher) { ziel = a; stufen = i; }
    }
    return { element: ziel, stufen, merkmale: [...new Set(merkmale)] };
  }

  // Liegt x in einem von vielen gleichartigen Eintraegen (Videoliste, Kartenraster)? Dann gehoert
  // eine Ueberschrift dort zu einem Eintrag und taugt nicht als Titel des ganzen Elements.
  const LISTE_MIN = 4;
  const signatur = (n) => `${n.localName}.${n.classList[0] || ''}`;
  function eintraege(root, x, innen = null) {
    for (let a = x; a && a !== root && root.contains(a); a = a.parentElement) {
      const p = a.parentElement;
      if (!p) break;
      const s = signatur(a);
      const gleich = [...p.children].filter((c) => signatur(c) === s && (!innen || innen.has(c))).length;
      if (gleich >= LISTE_MIN) return gleich;
    }
    return 0;
  }
  const ROLLEN = { nav: 'Navigation', aside: 'Sidebar', ul: 'List', ol: 'List', menu: 'Menu', table: 'Table', header: 'Header', footer: 'Footer', main: 'Main area', form: 'Form' };
  const ROLLEN_ARIA = { navigation: 'Navigation', list: 'List', listbox: 'List', menu: 'Menu', menubar: 'Menu', grid: 'Grid', complementary: 'Sidebar', feed: 'Feed', tablist: 'Tabs', table: 'Table' };
  function listenTitel(el, n) {
    const rolle = ROLLEN_ARIA[el.getAttribute('role')] || ROLLEN[el.localName] || 'List';
    // Seitentitel ohne Anhang wie " - Videoportal" oder " | Shop"
    const seite = (D.title || '').replace(/\s+[-|–—·]\s+[^-|–—·]{1,25}$/, '').replace(/\s+/g, ' ').trim();
    return `${rolle} with ${n} items${seite ? ` – ${seite}` : ''}`.slice(0, 90);
  }

  // innen: bei der Bereichsauswahl nur Knoten im Rahmen
  function label(el, innen = null) {
    const kurz = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    const aria = el.getAttribute('aria-label');
    if (aria && kurz(aria)) return kurz(aria);
    if (el.localName === 'iframe') {
      // eingebettetes Fenster: eigener Titel, sonst <title> aus dem srcdoc
      const titel = el.getAttribute('title') || ((el.getAttribute('srcdoc') || '').match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
      return kurz(titel) || 'Embedded frame';
    }
    const h = [el, ...el.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .find((x) => x.matches('h1,h2,h3,h4,h5,h6') && sichtbar(x) && kurz(x.innerText) && (!innen || innen.has(x)));
    if (h) {
      const n = eintraege(el, h, innen);
      return n ? listenTitel(el, n) : kurz(h.innerText);
    }
    const zeile = (el.innerText || '').split('\n').map((z) => z.trim()).find(Boolean);
    if (zeile) {
      const gang = D.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let t = gang.nextNode();
      while (t && !(t.textContent.trim() && t.parentElement && sichtbar(t.parentElement) && (!innen || innen.has(t.parentElement)))) t = gang.nextNode();
      const n = t ? eintraege(el, t.parentElement, innen) : 0;
      return n ? listenTitel(el, n) : kurz(zeile);
    }
    // ohne Text (Video, Bild, Grafik): Beschriftung des ersten sichtbaren Kindes
    const beschriftet = [...el.querySelectorAll('[aria-label], img[alt], [title]')]
      .find((x) => sichtbar(x) && kurz(x.getAttribute('aria-label') || x.getAttribute('alt') || x.getAttribute('title')));
    if (beschriftet) return kurz(beschriftet.getAttribute('aria-label') || beschriftet.getAttribute('alt') || beschriftet.getAttribute('title'));
    return selektor(el);
  }

  // Wurzel: Verschiebung per transform/translate setzt das Element nur an seinen Platz (Masonry-
  // Raster). Das Sollbild ist an der verschobenen Box ausgeschnitten; bliebe die
  // Verschiebung, saesse element.html um genau diesen Betrag daneben. Aussenabstand ebenso: er
  // liegt ausserhalb des Elements und wuerde die Kulisse gegen das Element verschieben.
  function wurzelEntschieben(decl, cs, k, luecken) {
    let tx = 0, ty = 0;
    const m = cs.transform.match(/^matrix(3d)?\((.*)\)$/);
    if (m) {
      const w = m[2].split(',').map(Number);
      const [ix, iy] = m[1] ? [12, 13] : [4, 5];
      tx = w[ix]; ty = w[iy];
      if (tx || ty) {
        w[ix] = 0; w[iy] = 0;
        const eins = m[1] ? '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1' : '1,0,0,1,0,0';
        const j = decl.findIndex(([p]) => p === 'transform');
        if (j >= 0) {
          if (w.join(',') === eins) decl.splice(j, 1);
          else decl[j][1] = `matrix${m[1] || ''}(${w.join(', ')})`;
        }
      }
    }
    if (cs.translate && cs.translate !== 'none') {
      const [x = '0', y = '0'] = cs.translate.split(/\s+/);
      tx += parseFloat(x) || 0; ty += parseFloat(y) || 0;
      const j = decl.findIndex(([p]) => p === 'translate');
      if (j >= 0) decl.splice(j, 1);
    }
    if (tx || ty) {
      luecken.push(`Root was shifted by transform (${Math.round(tx * 10) / 10}, ${Math.round(ty * 10) / 10}) px, removed in element.html – it only places the element on the page`);
    }
    const rand = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'].map((p) => cs.getPropertyValue(p));
    if (rand.some((v) => parseFloat(v))) {
      for (let j = decl.length - 1; j >= 0; j--) if (/^margin-/.test(decl[j][0])) decl.splice(j, 1);
      k.setAttribute('data-yoink-margin', rand.join(' '));
    }
  }

  // Hintergrund hinter dem Element: Farbe fuer body; liegt naeher ein Bild oder Verlauf, wird es als
  // Kulisse nachgestellt (eigenes div hinter dem Element, gleiche Lage, gleiche background-Werte)
  const KULISSE = ['background-image', 'background-position', 'background-size', 'background-repeat', 'background-color',
    'background-origin', 'background-clip', 'background-blend-mode', 'padding-top', 'padding-right', 'padding-bottom',
    'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
  function umgebungsHintergrund(el, luecken, bildQuellen) {
    let kulisse = null;
    const ohneFarbe = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = W.getComputedStyle(a);
      if (!kulisse && cs.backgroundImage && cs.backgroundImage !== 'none') {
        const e = el.getBoundingClientRect(), b = a.getBoundingClientRect();
        const werte = KULISSE.map((p) => `${p}: ${cs.getPropertyValue(p)}`);
        werte.push('border-style: solid', 'border-color: transparent', 'box-sizing: border-box');
        kulisse = { x: b.left - e.left, y: b.top - e.top, w: b.width, h: b.height, style: werte.join('; ') };
        for (const m of cs.backgroundImage.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
          if (!/^data:/i.test(m[2])) bildQuellen.push({ url: absolut(m[2]) });
        }
        luecken.push(`Background of the surroundings comes from \`${selektor(a).split(' > ').pop()}\` (image or gradient), recreated in element.html as a backdrop behind the element (data-yoink-kulisse) – not part of the element` +
          (cs.backgroundAttachment.includes('fixed') ? '; background-attachment: fixed, scrolls with the backdrop, only approximate' : ''));
        if (!ohneFarbe(cs.backgroundColor)) return { farbe: cs.backgroundColor, kulisse };
        continue;
      }
      if (!ohneFarbe(cs.backgroundColor)) return { farbe: cs.backgroundColor, kulisse };
    }
    return { farbe: 'rgb(255, 255, 255)', kulisse };
  }

  // Fuer jeden Knoten: liegt er ausserhalb des Rahmens? Innen ist, was den Rahmen schneidet, und
  // jeder Vorfahr davon. Ohne Rahmen ist nichts aussen.
  function imRahmen(root, orig, index, teil) {
    const aussen = orig.map(() => false);
    if (!teil) return aussen;
    const r0 = root.getBoundingClientRect();
    const R = { l: r0.left + teil.x, t: r0.top + teil.y, r: r0.left + teil.x + teil.w, b: r0.top + teil.y + teil.h };
    const schneidet = orig.map((o) => {
      const b = o.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.right > R.l && b.left < R.r && b.bottom > R.t && b.top < R.b;
    });
    for (let i = orig.length - 1; i >= 0; i--) {
      if (!schneidet[i]) continue;
      // Vorfahren mit hinein; rueckwaerts durchlaufen, also endet der Weg am ersten schon markierten
      for (let a = orig[i].parentElement; a && index.has(a) && !schneidet[index.get(a)]; a = a.parentElement) schneidet[index.get(a)] = true;
    }
    return schneidet.map((s, i) => i !== 0 && !s);
  }

  // Knoten ausserhalb des Rahmens: absolut positioniert faellt er weg (kein Einfluss aufs Layout),
  // sonst bleibt er als leere, unsichtbare Huelle mit seiner Groesse und seinen Abstaenden stehen
  function aussenHuelle(o, k, cs, wegdamit) {
    if (/^(absolute|fixed)$/.test(cs.position) || cs.display === 'none') { wegdamit.push(k); return; }
    const r = o.getBoundingClientRect();
    k.replaceChildren();
    for (const a of [...k.attributes]) if (!['class', 'id'].includes(a.name)) k.removeAttribute(a.name);
    const lage = ['display', 'position', 'top', 'left', 'right', 'bottom', 'float', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-self',
      'order', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'transform'].map((p) => [p, cs.getPropertyValue(p)]).filter(([, v]) => v && v !== 'auto' && v !== 'none' && v !== 'normal');
    const anzeige = cs.display === 'inline' ? 'inline-block' : cs.display;
    k.setAttribute('style', [...lage.filter(([p]) => p !== 'display').map(([p, v]) => `${p}: ${v}`),
      `display: ${anzeige}`, `width: ${r.width}px`, `height: ${r.height}px`, 'box-sizing: border-box', 'visibility: hidden'].join('; '));
    k.setAttribute('data-yoink-aussen', '');
  }

  // Margin-Collapse: der Aussenabstand oben des ersten Kindes faellt auf der Seite durch die Wurzel
  // nach aussen (Wurzel ohne Innenabstand und Rahmen oben). In element.html fiele er vor die Wurzel
  // und schoebe alles nach unten (gemessen: 57 px). Erkannt daran, dass das Kind trotz Abstand
  // buendig mit der Oberkante abschliesst; dann wird sein Abstand in der Kopie 0.
  function randKollaps(root, index, kopie, luecken) {
    const funde = [];
    for (let eltern = root, tiefe = 0; eltern && tiefe < 6; tiefe++) {
      const cs = W.getComputedStyle(eltern);
      if (!/^(block|list-item)$/.test(cs.display) || cs.overflow !== 'visible' || /^(absolute|fixed)$/.test(cs.position) || cs.float !== 'none') break;
      if (parseFloat(cs.paddingTop) || parseFloat(cs.borderTopWidth)) break;
      let kind = null;
      for (const n of eltern.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) break;
        if (n.nodeType !== 1) continue;
        const kc = W.getComputedStyle(n);
        if (kc.display === 'none' || /^(absolute|fixed)$/.test(kc.position) || kc.float !== 'none') continue;
        kind = n; break;
      }
      if (!kind) break;
      const rand = parseFloat(W.getComputedStyle(kind).marginTop) || 0;
      if (!rand || Math.abs(kind.getBoundingClientRect().top - eltern.getBoundingClientRect().top) > 0.5) break;
      const k = kopie[index.get(kind)];
      if (k) { k.style.setProperty('margin-top', '0px'); funde.push(`\`${kind.localName}${kind.classList[0] ? '.' + kind.classList[0] : ''}\` (${Math.round(rand)} px)`); }
      eltern = kind;
    }
    if (funde.length) luecken.push(`Top margin of ${funde.join(', ')} collapses out of the element on the page (margin collapse), set to 0 in element.html`);
  }

  // Groesste sichtbare Teile mit Lage im Element (CSS-Pixel). Der Host benennt damit einen
  // verschobenen Bereich ("passt zu img.img_G").
  const FLAECHE_MIN = 0.02, FLAECHEN_MAX = 40;
  function flaechenSammeln(root, orig, teil = null) {
    const e = root.getBoundingClientRect();
    // Koordinaten im Fang: bei der Bereichsauswahl im Rahmen
    const r0 = teil ? { left: e.left + teil.x, top: e.top + teil.y, width: teil.w, height: teil.h } : e;
    const gesamt = r0.width * r0.height;
    if (!gesamt) return [];
    return orig.slice(1)
      .filter((o) => !ENTFERNEN.has(o.localName) && sichtbar(o))
      .map((o) => ({ o, r: o.getBoundingClientRect() }))
      .filter(({ r }) => r.width * r.height >= gesamt * FLAECHE_MIN)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
      .slice(0, FLAECHEN_MAX)
      .map(({ o, r }) => ({
        name: o.id ? `${o.localName}#${o.id}` : `${o.localName}${[...o.classList].slice(0, 2).map((c) => '.' + c).join('')}`,
        x: Math.round(r.left - r0.left), y: Math.round(r.top - r0.top), w: Math.round(r.width), h: Math.round(r.height),
      }));
  }

  // --- Regeln der Seite ---------------------------------------------------------------------

  // innen: bei der Bereichsauswahl zaehlen nur Regeln, die auf Knoten im Rahmen passen
  function regelnSammeln(root, verwendet, innen = null) {
    const vorfahren = [];
    for (let a = root.parentElement; a; a = a.parentElement) vorfahren.push(a);
    const unlesbar = [];
    const zusatz = { fontFace: [], keyframes: [], schriftQuellen: [], weggelassen: new Set(), eingebettet: new Set() };
    const zustandsRegeln = [];
    const ZUSTAND = /::?(hover|focus-visible|focus-within|focus|active|visited|before|after|placeholder|marker|selection|first-line|first-letter)\b/g;

    const probe = innen
      ? (s) => { try { return (innen.has(root) && root.matches(s)) || [...root.querySelectorAll(s)].some((x) => innen.has(x)); } catch { return false; } }
      : (s) => { try { return root.matches(s) || !!root.querySelector(s); } catch { return false; } };
    const passt = (sel) => probe(sel) || (ZUSTAND.test(sel) && probe(sel.replace(ZUSTAND, ':is(*)')));
    const ohneZustand = (sel) => sel.replace(NICHT_ZUSTAND, ':is(*)').replace(ATTR_ZUSTAND, ':is(*)').replace(PSEUDO_ZUSTAND, ':is(*)');
    const passtOhneZustand = (sel) => { const n = ohneZustand(sel); ZUSTAND.lastIndex = 0; return n !== sel && passt(n); };
    const passtVorfahr = (sel) => vorfahren.some((a) => { try { return a.matches(sel); } catch { return false; } });

    function kopf(r) { return r.cssText.slice(0, r.cssText.indexOf('{')).trim(); }

    function rec(regeln, basis) {
      const out = [];
      for (const r of regeln) {
        if (r instanceof CSSStyleRule) {
          ZUSTAND.lastIndex = 0;
          if (passt(r.selectorText)) { out.push(urlsInCss(r.cssText, basis)); continue; }
          ZUSTAND.lastIndex = 0;
          if (passtOhneZustand(r.selectorText)) { out.push(urlsInCss(r.cssText, basis)); zustandsRegeln.push(r.selectorText); continue; }
          const vars = [];
          for (let i = 0; i < r.style.length; i++) {
            const p = r.style[i];
            if (p.startsWith('--')) vars.push(`${p}: ${urlsInCss(r.style.getPropertyValue(p), basis)}`);
          }
          if (vars.length && passtVorfahr(r.selectorText)) out.push(`${r.selectorText} { ${vars.join('; ')} }`);
        } else if (r instanceof CSSKeyframesRule) {
          if (verwendet.animationen.has(r.name)) { out.push(r.cssText); zusatz.keyframes.push(r.cssText); }
        } else if (r instanceof CSSFontFaceRule) {
          const fam = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
          // nur im Stapel, aber kein sichtbarer Text damit: weglassen und nennen
          if (!verwendet.schriften.has(fam) && verwendet.alleSchriften.has(fam)) zusatz.weggelassen.add(r.style.getPropertyValue('font-family').replace(/["']/g, '').trim());
          if (verwendet.schriften.has(fam)) {
            const t = urlsInCss(r.cssText, basis);
            out.push(t); zusatz.fontFace.push(t);
            const familie = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
            for (const m of t.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
              if (!/^data:/i.test(m[2])) zusatz.schriftQuellen.push({ familie, url: m[2] });
              else zusatz.eingebettet.add(familie.toLowerCase()); // Datei steckt in der Regel selbst
            }
          }
        } else if (r instanceof CSSImportRule) {
          try { out.push(...rec(r.styleSheet.cssRules, r.styleSheet.href || basis)); }
          catch { unlesbar.push(r.href); }
        } else if (r.cssRules) { // @media, @supports, @container, @layer
          const innen = rec(r.cssRules, basis);
          if (innen.length) out.push(`${kopf(r)} {\n${innen.join('\n')}\n}`);
        }
      }
      return out;
    }

    const teile = [];
    const genutzt = []; // Stylesheets mit mindestens einer passenden Regel: { url } oder { text } (inline)
    const blaetter = [...D.styleSheets, ...(D.adoptedStyleSheets || [])];
    for (const blatt of blaetter) {
      if (blatt.disabled) continue;
      let regeln;
      try { regeln = blatt.cssRules; } catch { unlesbar.push(blatt.href || '(eingebettet)'); continue; }
      const t = rec(regeln, blatt.href || D.baseURI);
      if (t.length) {
        teile.push(`/* from ${blatt.href || 'inline <style>'} */\n${t.join('\n')}`);
        if (blatt.href) genutzt.push({ url: blatt.href });
        else if (blatt.ownerNode && blatt.ownerNode.textContent) genutzt.push({ text: blatt.ownerNode.textContent });
      }
    }
    return { teile, unlesbar, zusatz, zustandsRegeln, genutzt, ausRegeln: (regeln, basis) => rec(regeln, basis) };
  }

  // --- Zustaende ----------------------------------------------------------------------------

  function zustaendePruefen(orig, zustandsRegeln, luecken) {
    const werte = new Map(); // Schluessel -> [Wert je Knoten]
    const merken = (k, v) => { if (!werte.has(k)) werte.set(k, []); werte.get(k).push(v); };
    for (const o of orig) {
      if (!sichtbar(o)) continue; // versteckte Player-Knoepfe u. ae. sind kein Zustand des Elements
      for (const a of BEOBACHTET) if (o.hasAttribute(a)) merken(a, o.getAttribute(a));
      if (o.localName === 'input' && /^(checkbox|radio)$/i.test(o.type)) merken('checked', o.checked ? 'on' : 'off');
      if (o.localName === 'details') merken('open', o.open ? 'open' : 'closed');
    }
    for (const [k, liste] of werte) {
      const verschieden = new Set(liste);
      if (verschieden.size !== 1) continue;
      const passend = zustandsRegeln.filter((s) => s.includes(k)).length;
      luecken.push(`State: ${liste.length} element(s) with ${k}, all "${liste[0]}" – the other state is not in the catch. ` +
        (passend
          ? `${passend} rule(s) for other states are in rules.css.`
          : 'No rules for it in the readable stylesheets; the page probably switches by script.') +
        ' For the full picture, switch the state and yoink again.');
    }
  }

  // --- Farben -------------------------------------------------------------------------------

  function farbenSammeln(root, orig, csListe) {
    const tokens = new Map(); // Farbe -> [Token]
    const rcs = W.getComputedStyle(root);
    for (let i = 0; i < rcs.length; i++) {
      const p = rcs[i];
      if (!p.startsWith('--')) continue;
      const f = farbe(rcs.getPropertyValue(p));
      if (!f || f === 'transparent') continue;
      if (!tokens.has(f)) tokens.set(f, []);
      tokens.get(f).push(p);
    }
    const genutzt = new Map(); // Farbe -> { anzahl, wo:Set }
    const zaehlen = (v, wo) => {
      const f = farbe(v);
      if (!f || f === 'transparent') return;
      if (!genutzt.has(f)) genutzt.set(f, { anzahl: 0, wo: new Set() });
      const g = genutzt.get(f); g.anzahl++; g.wo.add(wo);
    };
    orig.forEach((o, i) => {
      if (ENTFERNEN.has(o.localName)) return;
      const cs = csListe[i];
      if ([...o.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) zaehlen(cs.color, 'color');
      zaehlen(cs.backgroundColor, 'background-color');
      for (const s of ['top', 'right', 'bottom', 'left']) {
        if (parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none') zaehlen(cs.getPropertyValue(`border-${s}-color`), 'border-color');
      }
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) zaehlen(cs.outlineColor, 'outline-color');
      if (o.namespaceURI === SVG) {
        if (cs.fill && cs.fill !== 'none') zaehlen(cs.fill, 'fill');
        if (cs.stroke && cs.stroke !== 'none') zaehlen(cs.stroke, 'stroke');
      }
    });
    return [...genutzt].sort((a, b) => b[1].anzahl - a[1].anzahl).map(([f, g]) => ({
      farbe: f, anzahl: g.anzahl, wo: [...g.wo], tokens: (tokens.get(f) || []).sort(),
    }));
  }

  // --- Vervollstaendigen (async, nach erfassen) -------------------------------------------
  //
  // 1. Nicht lesbare Stylesheets ueber den Holer (Extension: Host) nachholen und gegen das
  //    Element lesen.  2. Schrift- und Bilddateien abrufen und lokal verweisen; was die Seite
  //    nicht abrufen darf (CORS, zu gross), laedt der Host beim Schreiben (erg.nachladen).
  //    3. Jede benutzte Webschrift ohne gesicherte Datei als eigene Luecke.

  // Ordner im Fang je Dateiart
  const ORDNER = { schriften: 'fonts', bilder: 'images', videos: 'videos', quellen: 'sources' };
  const ARTEN = {
    schriften: { endungen: /\.(woff2|woff|ttf|otf)$/i, ersatz: 'woff2', einzel: 3 * 1024 * 1024, gesamt: 12 * 1024 * 1024 },
    bilder: { endungen: /\.(png|jpe?g|webp|gif|svg|avif)$/i, ersatz: 'png', einzel: 15 * 1024 * 1024, gesamt: 30 * 1024 * 1024 },
  };
  const GENERISCH = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|math|emoji|fangsong|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial)$/i;

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function umbiegen(erg, url, ziel) {
    for (const form of new Set([url, url.replace(/&/g, '&amp;')])) {
      const muster = new RegExp(`url\\(\\s*(&quot;|['"]?)${escRe(form)}\\1\\s*\\)`, 'g');
      erg.html = erg.html.replace(muster, (_, q) => `url(${q}${ziel}${q})`);
      erg.css = erg.css.replace(muster, (_, q) => `url(${q}${ziel}${q})`);
      erg.html = erg.html.split(`src="${form}"`).join(`src="${ziel}"`);
    }
  }

  async function dateienSichern(erg, art) {
    const cfg = ARTEN[art];
    const quellen = (art === 'schriften' ? erg.schriftQuellen : erg.bildQuellen) || [];
    const luecken = erg.meta.luecken;
    const vergeben = new Set();
    const gesehen = new Set();
    let summe = 0;
    for (const { familie, url } of quellen) {
      if (gesehen.has(url)) continue;
      gesehen.add(url);
      let host = url, pfad = '';
      try { const u = new URL(url); host = u.host; pfad = u.pathname.split('/').pop() || ''; } catch { /* bleibt */ }
      const name = art === 'schriften' ? `Font “${familie}”` : `Image \`${pfad || url}\``;
      const ersatz = art === 'schriften' ? `. ${ersatzFuer(erg, familie)}` : '';
      const endungAusPfad = (pfad.match(cfg.endungen) || [, ''])[1].toLowerCase();
      const dateiname = (endung) => {
        const stamm = pfad.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60) || (art === 'schriften' ? 'schrift' : 'bild');
        let d = `${stamm}.${endung}`;
        for (let n = 2; vergeben.has(d); n++) d = `${stamm}-${n}.${endung}`;
        vergeben.add(d);
        return d;
      };
      const nachladen = () => {
        // scheitert der Host, haengt er den Ersatz an seine Luecke
        if (art === 'schriften') (erg.meta.schriftErsatz = erg.meta.schriftErsatz || {})[familie] = ersatzFuer(erg, familie);
        const ziel = `${ORDNER[art]}/${dateiname(endungAusPfad || cfg.ersatz)}`;
        erg.nachladen.push({ url, ziel, art, familie: familie || null });
        umbiegen(erg, url, ziel);
      };
      let antwort;
      try {
        const steuer = new AbortController();
        const uhr = setTimeout(() => steuer.abort(), 8000);
        antwort = await fetch(url, { signal: steuer.signal });
        clearTimeout(uhr);
      } catch (e) {
        if (e.name === 'AbortError') luecken.push(`${name} not saved (timeout), file stays on ${host}${ersatz}`);
        else nachladen(); // CORS oder Netz: der Host versucht es ohne Seitenkontext
        continue;
      }
      if (!antwort.ok) { luecken.push(`${name} not saved (HTTP ${antwort.status}), file stays on ${host}${ersatz}`); continue; }
      const bytes = new Uint8Array(await antwort.arrayBuffer());
      if (bytes.length > cfg.einzel || summe + bytes.length > cfg.gesamt) { nachladen(); continue; } // zu gross fuer die Nachricht
      summe += bytes.length;
      let endung = endungAusPfad;
      if (!endung) {
        const typ = antwort.headers.get('content-type') || '';
        endung = (typ.match(/(woff2|woff|ttf|otf|png|jpe?g|webp|gif|avif)/) || [, ''])[1] || (/svg/.test(typ) ? 'svg' : cfg.ersatz);
      }
      const datei = dateiname(endung);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      erg[art].push({ datei, base64: btoa(bin), familie: familie || null });
      umbiegen(erg, url, `${ORDNER[art]}/${datei}`);
    }
  }

  // Bilder, auf die nur rules.css zeigt (Hover, andere Zustaende, Custom Properties)
  const CSS_BILDER_MAX = 80;
  function cssBilderMerken(erg) {
    const bekannt = new Set([...(erg.bildQuellen || []), ...(erg.schriftQuellen || [])].map((q) => q.url));
    let n = 0;
    for (const m of erg.css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const u = m[2];
      if (!/^https?:/i.test(u) || bekannt.has(u) || !/\.(png|jpe?g|webp|gif|svg|avif)([?#]|$)/i.test(u)) continue;
      if (n++ >= CSS_BILDER_MAX) { erg.meta.luecken.push(`More than ${CSS_BILDER_MAX} images in rules.css, the rest stay linked`); break; }
      bekannt.add(u);
      erg.bildQuellen.push({ url: u });
    }
  }

  // Freie Schriften (Google Fonts) mit gemessenen Maßen je em, Gewicht 400. Gemessen 2026-10-26 in
  // Chrome mit tests/schriftmasse.mjs: breite = mittlere Laufweite a–z, xHoehe/versal = Oberkante
  // x/H, schmal = Breite i / Breite m.
  const SCHRIFT_TABELLE = [
    ['Inter', 'sans-serif', 0.535, 0.546, 0.728, 0.276], ['Roboto', 'sans-serif', 0.499, 0.528, 0.711, 0.277],
    ['Open Sans', 'sans-serif', 0.522, 0.535, 0.714, 0.273], ['Lato', 'sans-serif', 0.495, 0.507, 0.717, 0.312],
    ['Montserrat', 'sans-serif', 0.571, 0.525, 0.7, 0.254], ['Poppins', 'sans-serif', 0.561, 0.548, 0.697, 0.239],
    ['DM Sans', 'sans-serif', 0.519, 0.504, 0.7, 0.269], ['Manrope', 'sans-serif', 0.521, 0.54, 0.72, 0.275],
    ['Work Sans', 'sans-serif', 0.546, 0.5, 0.66, 0.279], ['IBM Plex Sans', 'sans-serif', 0.504, 0.516, 0.698, 0.286],
    ['Source Sans 3', 'sans-serif', 0.472, 0.486, 0.656, 0.297], ['Nunito Sans', 'sans-serif', 0.506, 0.486, 0.705, 0.271],
    ['Figtree', 'sans-serif', 0.507, 0.5, 0.7, 0.273], ['Plus Jakarta Sans', 'sans-serif', 0.539, 0.536, 0.745, 0.252],
    ['Space Grotesk', 'sans-serif', 0.553, 0.489, 0.7, 0.285], ['Raleway', 'sans-serif', 0.525, 0.521, 0.71, 0.237],
    ['Outfit', 'sans-serif', 0.497, 0.475, 0.694, 0.262], ['Instrument Sans', 'sans-serif', 0.523, 0.51, 0.72, 0.26],
    ['Geist', 'sans-serif', 0.515, 0.53, 0.71, 0.278], ['Rubik', 'sans-serif', 0.53, 0.52, 0.7, 0.272],
    ['Karla', 'sans-serif', 0.519, 0.479, 0.628, 0.319], ['Archivo', 'sans-serif', 0.496, 0.526, 0.686, 0.262],
    ['Public Sans', 'sans-serif', 0.528, 0.517, 0.723, 0.286], ['Barlow', 'sans-serif', 0.484, 0.506, 0.7, 0.308],
    ['Mulish', 'sans-serif', 0.521, 0.502, 0.705, 0.271],
    ['Source Serif 4', 'serif', 0.548, 0.492, 0.67, 0.345], ['Merriweather', 'serif', 0.559, 0.555, 0.743, 0.326],
    ['Lora', 'serif', 0.526, 0.5, 0.7, 0.314], ['Playfair Display', 'serif', 0.508, 0.515, 0.708, 0.33],
    ['EB Garamond', 'serif', 0.437, 0.405, 0.653, 0.315], ['Libre Baskerville', 'serif', 0.587, 0.53, 0.77, 0.318],
    ['IBM Plex Serif', 'serif', 0.539, 0.516, 0.698, 0.331], ['Crimson Pro', 'serif', 0.459, 0.42, 0.573, 0.326],
    ['Fraunces', 'serif', 0.537, 0.47, 0.7, 0.321], ['Newsreader', 'serif', 0.485, 0.44, 0.676, 0.337],
    ['Instrument Serif', 'serif', 0.388, 0.51, 0.72, 0.317], ['DM Serif Display', 'serif', 0.513, 0.481, 0.66, 0.321],
    ['JetBrains Mono', 'monospace', 0.6, 0.55, 0.73, 1], ['IBM Plex Mono', 'monospace', 0.6, 0.516, 0.698, 1],
    ['Roboto Mono', 'monospace', 0.6, 0.528, 0.711, 1], ['Space Mono', 'monospace', 0.612, 0.496, 0.7, 1],
    ['Fira Code', 'monospace', 0.6, 0.526, 0.688, 1], ['Source Code Pro', 'monospace', 0.6, 0.486, 0.656, 1],
  ].map(([name, art, breite, xHoehe, versal, schmal]) => ({ name, art, breite, xHoehe, versal, schmal }));
  const UNGEMESSEN = { 'sans-serif': ['Inter', 'DM Sans'], serif: ['Source Serif 4', 'Lora'], monospace: ['JetBrains Mono', 'IBM Plex Mono'] };

  // Naechste Schriften gleicher Art nach Laufweite (doppelt gewichtet), x-Hoehe und Versalhoehe
  function schriftErsatz(masse, art) {
    const abstand = (s) => 2 * Math.abs(s.breite - masse.breite) / s.breite + Math.abs(s.xHoehe - masse.xHoehe) / s.xHoehe + Math.abs(s.versal - masse.versal) / s.versal;
    return SCHRIFT_TABELLE.filter((s) => s.art === art).sort((a, b) => abstand(a) - abstand(b)).slice(0, 2);
  }

  // Maße einer Schrift, wie die Seite sie rendert; null, wenn sie dort nicht geladen ist
  function schriftMessen(familie) {
    try {
      if (!D.fonts || ![...D.fonts].some((f) => f.family.replace(/["']/g, '') === familie && f.status === 'loaded')) return null;
      const c = new OffscreenCanvas(10, 10).getContext('2d');
      c.font = `100px "${familie}", monospace`;
      const w = (t) => c.measureText(t).width / 100, oben = (t) => c.measureText(t).actualBoundingBoxAscent / 100;
      return { breite: w('abcdefghijklmnopqrstuvwxyz') / 26, xHoehe: oben('x'), versal: oben('H'), schmal: w('i') / w('m') };
    } catch { return null; }
  }

  function ersatzText(familie, stapel) {
    const masse = schriftMessen(familie);
    const art = masse ? (masse.schmal > 0.9 ? 'monospace' : /(^|,)\s*serif\b/i.test(stapel) ? 'serif' : 'sans-serif')
      : /monospace/i.test(stapel) ? 'monospace' : /(^|,)\s*serif\b/i.test(stapel) ? 'serif' : 'sans-serif';
    if (masse) return `Substitute: ${schriftErsatz(masse, art).map((s) => s.name).join(' or ')} (free, Google Fonts; measured by width, x-height and cap height)`;
    return `Substitute: ${UNGEMESSEN[art].join(' or ')} (free, Google Fonts; not measured, by kind ${art} only, the font is not loaded on the page)`;
  }

  function ersatzFuer(erg, familie) {
    const k = KONTEXT.get(erg);
    return ersatzText(familie, (k && k.stapel.get(String(familie || '').toLowerCase())) || '');
  }

  function schriftLueckenPruefen(erg, unlesbarAnzahl, eingebettet = new Set()) {
    const klein = (s) => String(s || '').replace(/["']/g, '').trim().toLowerCase();
    const web = new Set([...(D.fonts || [])].map((f) => klein(f.family)));
    for (const q of erg.schriftQuellen || []) web.add(klein(q.familie));
    const gesichert = new Set([...erg.schriften, ...erg.nachladen.filter((n) => n.art === 'schriften')].map((s) => klein(s.familie)));
    for (const f of eingebettet) gesichert.add(f);
    for (const f of erg.meta.schriften || []) {
      if (!f || GENERISCH.test(f) || gesichert.has(klein(f)) || !web.has(klein(f))) continue;
      if (erg.meta.luecken.some((l) => l.includes(`“${f}”`))) continue;
      erg.meta.luecken.push(`Font “${f}” without a saved file – ${unlesbarAnzahl ? 'its @font-face is probably in the unreadable stylesheet' : 'no downloadable @font-face found'}. ${ersatzFuer(erg, f)}.`);
    }
  }

  // quellen: Originalquellen (Stylesheets mit passenden Regeln, alle Skripte der Seite) mitnehmen,
  // nur mit Extras (Taste E)
  async function vervollstaendigen(erg, holer, { quellen = false } = {}) {
    const k = KONTEXT.get(erg);
    dokumentSetzen(k && k.ctx.dokument);
    if (k && holer && k.ctx.unlesbar.length) {
      for (const url of [...k.ctx.unlesbar]) {
        let a;
        try { a = await holer(url); } catch (e) { a = { ok: false, fehler: e.message }; }
        if (!a || !a.ok || typeof a.text !== 'string') continue;
        let blatt;
        try { blatt = new CSSStyleSheet(); blatt.replaceSync(a.text.replace(/@import[^;]*;/g, '')); } catch { continue; }
        const regeln = k.ausRegeln(blatt.cssRules, url);
        k.ctx.unlesbar = k.ctx.unlesbar.filter((u) => u !== url);
        if (regeln.length) {
          k.ctx.nachgeholt.push(`/* from ${url} (fetched afterwards, not readable via CORS) */\n${regeln.join('\n')}`);
          k.ctx.genutzt.push({ url, text: a.text });
        }
      }
      zusammensetzen(erg, k.ctx);
    }
    // Mit Originalcode im Fang (source.html) gehoeren die Dateien der umgebenden Seite nicht dazu;
    // was source.html selbst nachlaedt, sichert der Host (source-files/)
    if (k && quellen && !(erg.quelltexte || []).length) await quellenSichern(erg, k.ctx.genutzt);
    cssBilderMerken(erg);
    await dateienSichern(erg, 'schriften');
    await dateienSichern(erg, 'bilder');
    schriftLueckenPruefen(erg, k ? k.ctx.unlesbar.length : 0, k ? k.ctx.zusatz.eingebettet : undefined);
    KONTEXT.delete(erg);
    delete erg.schriftQuellen;
    delete erg.bildQuellen;
    return erg;
  }

  // Originalquellen: die Stylesheets, aus denen passende Regeln kamen, unveraendert (fuer das
  // Verstehen, nicht zum Ausfuehren). Eingebettete aus dem <style>, verlinkte per fetch, sonst vom
  // Holer (Host). Grenzen: 2 MB je Datei, 6 MB zusammen.
  const QUELLE_EINZEL = 2 * 1024 * 1024, QUELLE_GESAMT = 6 * 1024 * 1024, SKRIPTE_GESAMT = 8 * 1024 * 1024;
  // Tracking nie sichern: Adressen der bekannten Dienste und eingebettete Schnipsel, die sie aufrufen
  const TRACKING_ADRESSE = /(googletagmanager|google-analytics|analytics\.google|doubleclick|umami|promotekit|plausible|segment\.(com|io)|hotjar|clarity\.ms|connect\.facebook|posthog|mixpanel|fullstory|heapanalytics|matomo|piwik|cloudflareinsights)/i;
  const TRACKING_INLINE = /\bgtag\(|\bdataLayer\b|\bfbq\(|\b_paq\b|\bumami\b|\bposthog\b|\bmixpanel\b/;
  const minifiziert = (text) => { const z = text.split('\n'); return text.length > 1000 && text.length / z.length > 300; };
  async function quellenSichern(erg, genutzt) {
    erg.quellen = [];
    const vergeben = new Set();
    let summe = 0, inline = 0;
    for (const g of genutzt) {
      if (g.url && TRACKING_ADRESSE.test(g.url)) continue;
      let text = g.text, name;
      if (g.url) {
        let pfad = '';
        try { pfad = new URL(g.url).pathname.split('/').pop() || ''; } catch { /* bleibt */ }
        name = pfad.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60) || 'stil';
        if (typeof text !== 'string') {
          try { const a = await fetch(g.url); if (a.ok) text = await a.text(); } catch { /* CORS: hat der Holer schon */ }
        }
      } else {
        name = `inline-${++inline}`;
      }
      if (typeof text !== 'string') { erg.meta.luecken.push(`Original source \`${g.url}\` not saved (not downloadable)`); continue; }
      const groesse = new Blob([text]).size;
      if (groesse > QUELLE_EINZEL || summe + groesse > QUELLE_GESAMT) { erg.meta.luecken.push(`Original source \`${g.url || name}\` not saved (too large, ${Math.round(groesse / 1024)} KB)`); continue; }
      summe += groesse;
      let datei = `${name}.css`;
      for (let n = 2; vergeben.has(datei); n++) datei = `${name}-${n}.css`;
      vergeben.add(datei);
      erg.quellen.push({ datei, text, url: g.url ? saeubern(g.url) : '', minifiziert: minifiziert(text) });
    }
    // Alle Skripte der Seite bis 8 MB: eingebettete aus dem <script>, verlinkte
    // per fetch; was die Seite nicht lesen darf, laedt der Host (nachladen, Grenze dort)
    let js = 0, inlineJs = 0;
    for (const s of D.scripts) {
      const typ = (s.getAttribute('type') || '').toLowerCase();
      if (typ && !/(java|ecma)script|module/.test(typ)) continue; // JSON, Vorlagen
      let text = null, url = '', name;
      if (s.src ? TRACKING_ADRESSE.test(s.src) : TRACKING_INLINE.test(s.textContent || '')) continue;
      if (s.src) {
        url = s.src;
        let pfad = '';
        try { pfad = new URL(url).pathname.split('/').pop() || ''; } catch { /* bleibt */ }
        name = pfad.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60) || 'skript';
        try { const a = await fetch(url); if (a.ok) text = await a.text(); } catch { text = null; }
      } else {
        text = s.textContent || '';
        if (!text.trim()) continue;
        name = `inline-${++inlineJs}`;
      }
      let datei = `${name}.js`;
      for (let n = 2; vergeben.has(datei); n++) datei = `${name}-${n}.js`;
      vergeben.add(datei);
      if (typeof text !== 'string') { erg.nachladen.push({ url, ziel: `sources/${datei}`, art: 'quellen', familie: null }); continue; }
      const groesse = new Blob([text]).size;
      if (js + groesse > SKRIPTE_GESAMT) { erg.meta.luecken.push(`Script \`${url || datei}\` not saved (scripts over 8 MB in total)`); continue; }
      js += groesse;
      erg.quellen.push({ datei, text, url: url ? saeubern(url) : '', minifiziert: minifiziert(text) });
    }
  }

  // --- Hauptfunktion ------------------------------------------------------------------------

  // teil: Rahmen der Bereichsauswahl {x, y, w, h} im Element. Dann kommt nur in den Fang, was den
  // Rahmen schneidet; Teile ausserhalb fallen weg (absolut positioniert) oder bleiben als leere,
  // unsichtbare Huelle fester Groesse stehen, damit das Layout im Rahmen nicht verrutscht.
  function erfassen(root, { teil = null } = {}) {
    dokumentSetzen(root.ownerDocument);
    const luecken = [];
    const orig = [root, ...root.querySelectorAll('*')];
    if (orig.length > MAX_KNOTEN && !teil) throw new Error(`Element too large (${orig.length} nodes), pick a smaller one`);
    const klon = root.cloneNode(true);
    const kopie = [klon, ...klon.querySelectorAll('*')];

    const std = standardRechner();
    const csListe = orig.map((o) => W.getComputedStyle(o));
    const index = new Map(orig.map((o, i) => [o, i]));
    const aussen = imRahmen(root, orig, index, teil);
    const innenListe = orig.filter((o, i) => !aussen[i]);
    const innenCs = csListe.filter((c, i) => !aussen[i]);
    const innen = new Set(innenListe);
    const pseudoRegeln = [];
    // schriften: Familien, mit denen sichtbarer Text gesetzt ist; alleSchriften: jeder Stapel
    const verwendet = { schriften: new Set(), alleSchriften: new Set(), animationen: new Set() };
    const textSchriften = new Set();
    const wegdamit = [];
    const bildQuellen = [];
    const pseudoSchriften = new Set();
    const rootRect = root.getBoundingClientRect();
    const fang = teil ? { x: rootRect.left + teil.x, y: rootRect.top + teil.y } : { x: rootRect.left, y: rootRect.top };
    const medienliste = medienListe(root, teil);
    const medien = { liste: medienliste, eintraege: [], videoNamen: new Set(), nachladen: [], shader: [], quelltexte: [], fang,
      srcdocZahl: medienliste.filter((o) => o.localName === 'iframe' && o.getAttribute('srcdoc')).length, flaeche: teil ? teil.w * teil.h : rootRect.width * rootRect.height };
    let pseudoId = 0;
    let shadow = 0;

    try {
      orig.forEach((o, i) => {
        const k = kopie[i];
        if (aussen[i] && !aussen[index.get(o.parentElement)]) { aussenHuelle(o, k, csListe[i], wegdamit); return; }
        if (aussen[i]) return; // steckt in einer Huelle, die ihre Kinder schon verloren hat
        if (ENTFERNEN.has(o.localName)) { wegdamit.push(k); return; }
        const cs = csListe[i];
        const elternCs = i === 0 ? null : csListe[index.get(o.parentElement)];
        const ns = o.namespaceURI || HTML;
        const neutral = std.werte({ namespaceURI: ns, localName: ns === SVG ? 'g' : 'span' });
        const decl = deklarationen(cs, std.werte(o), elternCs, i === 0, neutral);

        if (i === 0 && /^(absolute|fixed|sticky)$/.test(cs.position)) {
          for (let j = decl.length - 1; j >= 0; j--) if (/^(position|top|right|bottom|left|inset)$/.test(decl[j][0])) decl.splice(j, 1);
          decl.push(['position', 'relative']);
          luecken.push(`Wurzel war position: ${cs.position}, in element.html auf relative gesetzt`);
        }
        if (i === 0) wurzelEntschieben(decl, cs, k, luecken);
        k.setAttribute('style', alsText(decl));

        const familien = cs.fontFamily.split(',').map((f) => f.replace(/["']/g, '').trim());
        familien.forEach((f) => verwendet.alleSchriften.add(f.toLowerCase()));
        if (zeigtText(o)) {
          familien.forEach((f) => verwendet.schriften.add(f.toLowerCase()));
          textSchriften.add(familien[0]);
        }
        cs.animationName.split(',').map((a) => a.trim()).filter((a) => a && a !== 'none').forEach((a) => verwendet.animationen.add(a));
        if (o.shadowRoot) shadow++;

        for (const pz of ['::before', '::after']) {
          const pcs = W.getComputedStyle(o, pz);
          const inhalt = pcs.getPropertyValue('content');
          if (!inhalt || inhalt === 'none' || inhalt === 'normal') continue;
          const pf = pcs.fontFamily.split(',').map((f) => f.replace(/["']/g, '').trim());
          pf.forEach((f) => verwendet.alleSchriften.add(f.toLowerCase()));
          if (sichtbar(o)) {
            pf.forEach((f) => verwendet.schriften.add(f.toLowerCase()));
            pseudoSchriften.add(pf[0]);
          }
          if (!k.hasAttribute('data-yoink')) k.setAttribute('data-yoink', String(++pseudoId));
          const pd = deklarationen(pcs, std.werte(o, pz), cs, false);
          if (!pd.some(([p]) => p === 'content')) pd.push(['content', inhalt]);
          pseudoRegeln.push(`[data-yoink="${k.getAttribute('data-yoink')}"]${pz} { ${alsText(pd)} }`);
        }
        bereinigen(o, k, cs, wegdamit, luecken, medien);
        bilderMerken(o, cs, bildQuellen);
      });
    } finally {
      std.aufraeumen();
    }
    wegdamit.forEach((k) => k.remove());
    const wurzel = medien.wurzel || klon;
    if (shadow) luecken.push(`${shadow} element(s) with shadow DOM whose content is not captured`);

    randKollaps(root, index, kopie, luecken);
    if (teil) {
      // im Rahmen-Div so verschoben, dass genau der Rahmen sichtbar ist
      for (const [p, v] of [['margin-top', -teil.y], ['margin-left', -teil.x], ['margin-right', 0], ['margin-bottom', 0]]) wurzel.style.setProperty(p, `${v}px`);
    }
    medienMelden(medien, luecken);
    const h = teil ? { element: null } : huelle(root);
    if (h.element) {
      luecken.push(`Wrapper \`${selektor(h.element).split(' > ').pop()}\` has the same size and is not in the catch (${h.merkmale.join(', ')}) – the captured image shows it. ` +
        `For the whole picture, yoink ${h.stufen} level${h.stufen === 1 ? '' : 's'} higher (↑ while picking).`);
    }

    const defs = fremdeSvgVerweise(root, wurzel, luecken);
    const { teile, unlesbar, zusatz, zustandsRegeln, genutzt, ausRegeln } = regelnSammeln(root, verwendet, teil ? innen : null);
    zustaendePruefen(innenListe, zustandsRegeln, luecken);
    leereMelden(root, innenListe, innenCs, luecken);
    quellenlosMelden(innenListe, luecken);

    const rect = root.getBoundingClientRect();
    const meta = {
      url: saeubern(W.location.href),
      titel: D.title,
      label: label(root, teil ? innen : null),
      selektor: selektor(root),
      pfad: pfad(root),
      breite: Math.round(teil ? teil.w : rect.width),
      hoehe: Math.round(teil ? teil.h : rect.height),
      rahmen: teil ? { x: Math.round(teil.x), y: Math.round(teil.y), w: Math.round(teil.w), h: Math.round(teil.h) } : null,
      elementGroesse: teil ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      schriften: [...new Set([...textSchriften, ...pseudoSchriften])],
      farben: farbenSammeln(root, innenListe, innenCs),
      flaechen: flaechenSammeln(root, innenListe, teil),
      medien: medien.eintraege,
      luecken,
    };

    const umgebung = umgebungsHintergrund(root, luecken, bildQuellen);
    const ctx = {
      meta, hg: umgebung.farbe, kulisse: umgebung.kulisse, rahmen: meta.rahmen, dokument: D, lang: D.documentElement.lang || 'de',
      klonHtml: wurzel.outerHTML, defs, zusatz, pseudoRegeln, teile, unlesbar: [...unlesbar], nachgeholt: [], genutzt,
    };
    const erg = { meta, schriftQuellen: zusatz.schriftQuellen, bildQuellen, nachladen: [...medien.nachladen], schriften: [], bilder: [],
      shader: medien.shader, quelltexte: medien.quelltexte, iframe: null };
    if (root.localName === 'iframe') {
      const info = rahmenInfo(root);
      if (info.art !== 'srcdoc') { delete info.koerper; erg.iframe = info; } // srcdoc steht in quelltexte
    }
    zusammensetzen(erg, ctx);
    // Schriftstapel je erster Familie, fuer die Art des Ersatzes (serif, sans-serif, monospace)
    const stapel = new Map();
    csListe.forEach((cs) => { const f = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase(); if (!stapel.has(f)) stapel.set(f, cs.fontFamily); });
    KONTEXT.set(erg, { ctx, ausRegeln, stapel });
    return erg;
  }

  const KONTEXT = new WeakMap(); // Ergebnis -> Zustand fuer das Nachholen, nie serialisiert
  const UNLESBAR = 'not readable (other domain)';

  function zusammensetzen(erg, ctx) {
    const { meta, zusatz } = ctx;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // Kulisse nach dem Element, damit es erstes Kind von body bleibt; z-index -1 legt sie dahinter
    const k = ctx.kulisse;
    // Bereichsauswahl: Element in einem Div in Rahmengroesse, das ueberstehendes abschneidet
    const r = ctx.rahmen;
    const kulisseHtml = k ? `<div data-yoink-kulisse aria-hidden="true" style="${esc(`position: absolute; left: ${r ? k.x - r.x : 24 + k.x}px; top: ${r ? k.y - r.y : 24 + k.y}px; width: ${k.w}px; height: ${k.h}px; z-index: -1; pointer-events: none; ${k.style}`)}"></div>\n` : '';
    const koerper = r
      ? `<div data-yoink-rahmen style="position: relative; width: ${r.w}px; height: ${r.h}px; overflow: hidden">\n${ctx.klonHtml}\n${kulisseHtml}</div>\n`
      : `${ctx.klonHtml}\n${kulisseHtml}`;
    erg.html = `<!doctype html>
<html lang="${esc(ctx.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yoink: ${esc(meta.label)}</title>
<!-- Source: ${esc(meta.url)} · Selector: ${esc(meta.selektor)} · caught with yoink -->
<style>
html, body { margin: 0; }
body { padding: 24px; background: ${ctx.hg}; }
${[...zusatz.fontFace, ...zusatz.keyframes, ...ctx.pseudoRegeln].join('\n')}
</style>
</head>
<body>
${koerper}${ctx.defs}
</body>
</html>
`;
    const alle = [...ctx.teile, ...ctx.nachgeholt];
    erg.css = `/* yoink – rules of the page that match the catch
   Source: ${meta.url}
   Selector: ${meta.selektor}
${ctx.unlesbar.length ? '   Not readable (other domain):\n' + ctx.unlesbar.map((u) => '     ' + u).join('\n') + '\n' : ''}*/

${alle.join('\n\n') || '/* no matching rules in readable stylesheets */'}
`;
    meta.schriftenWeggelassen = [...zusatz.weggelassen].filter((f) => !meta.schriften.includes(f)).sort();
    const l = meta.luecken;
    for (let i = l.length - 1; i >= 0; i--) if (l[i].includes(UNLESBAR)) l.splice(i, 1);
    if (ctx.unlesbar.length) {
      l.push(`${ctx.unlesbar.length} Stylesheet(s) ${UNLESBAR} (${ctx.unlesbar.map((u) => { try { return new URL(u).host; } catch { return u; } }).join(', ')}) – rules.css incomplete, styles in element.html complete anyway`);
    }
  }

  // Hintergrundbilder (auch der Pseudo-Elemente) und img-Quellen merken
  function bilderMerken(o, cs, quellen) {
    const aus = (wert) => {
      for (const m of String(wert || '').matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
        if (!/^data:/i.test(m[2])) quellen.push({ url: absolut(m[2]) });
      }
    };
    aus(cs.backgroundImage);
    for (const pz of ['::before', '::after']) {
      const pcs = W.getComputedStyle(o, pz);
      if (pcs.content && pcs.content !== 'none' && pcs.content !== 'normal') aus(pcs.backgroundImage);
    }
    if (o.localName === 'img' && o.currentSrc && !/^data:/i.test(o.currentSrc)) quellen.push({ url: o.currentSrc });
  }

  // Elemente ohne Inhalt namentlich nennen, damit der Nachbau nicht nach einer verlorenen Form sucht
  const KEIN_INHALT_NOETIG = new Set(['img', 'input', 'br', 'hr', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed', 'svg', 'picture', 'source', 'wbr', 'textarea', 'select', 'track', 'col', 'area']);
  const LEER_NAMEN_MAX = 3;
  function leereMelden(root, orig, csListe, luecken) {
    const r0 = root.getBoundingClientRect();
    const funde = [];
    let versteckt = 0;
    orig.forEach((o, i) => {
      if (i === 0 || ENTFERNEN.has(o.localName) || o.namespaceURI !== HTML || KEIN_INHALT_NOETIG.has(o.localName) || o.shadowRoot) return;
      if (o.children.length || (o.textContent || '').trim()) return;
      if (['::before', '::after'].some((pz) => { const c = W.getComputedStyle(o, pz).content; return c && c !== 'none' && c !== 'normal'; })) return;
      const eltern = o.parentElement;
      if (eltern && eltern.checkVisibility && !eltern.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { versteckt++; return; }
      const r = o.getBoundingClientRect();
      const gruende = [];
      if (r.height === 0) gruende.push('0 px high');
      else if (r.width === 0) gruende.push('0 px wide');
      if (r.bottom <= r0.top || r.top >= r0.bottom || r.right <= r0.left || r.left >= r0.right) gruende.push('outside the captured section');
      if (!gruende.length) return; // sichtbare leere Flaeche ist Deko, die element.html traegt
      const kl = [...o.classList].slice(0, 2).map((c) => '.' + c).join('');
      funde.push(`\`${o.localName}${o.id ? '#' + o.id : ''}${kl}\` – ${gruende.join(', ')}`);
    });
    if (!funde.length) return;
    const dazu = versteckt ? ` (+${versteckt} in hidden areas)` : '';
    // Wenige mit Namen (eine Form, die man sonst suchen wuerde), viele nur als Zahl, damit sie
    // die echten Luecken nicht verdecken
    if (funde.length <= LEER_NAMEN_MAX) luecken.push(`Empty elements, empty on the page too (nothing lost): ${funde.join('; ')}${dazu}`);
    else luecken.push(`${funde.length} empty elements without content (0 px or outside the captured section), empty on the page too – not listed one by one${dazu}`);
  }

  // Bilder, die die Seite erst beim Hinscrollen laedt (lazy): ohne Quelle zeigt element.html dort
  // nichts. Gezaehlt wird, was im Layout steht; visibility zaehlt nicht mit, weil manche Seiten
  // ein Bild bis zum Laden unsichtbar halten.
  const imLayout = (o) => (!o.checkVisibility || o.checkVisibility()) && o.getBoundingClientRect().width > 0;
  const ohneQuelle = (o) => !o.currentSrc && !(o.getAttribute('src') || '').trim();
  function quellenlosMelden(orig, luecken) {
    const alle = orig.filter((o) => o.localName === 'img' && imLayout(o));
    const ohne = alle.filter(ohneQuelle);
    if (ohne.length) {
      luecken.push(`${ohne.length} of ${alle.length} images without a source (lazy, not loaded) – element.html shows nothing there. ` +
        'With extras (key E) yoink scrolls through tall elements once before the catch; what is still missing then, the page only loads when really viewed.');
    }
  }

  // Traegt das Element selbst sichtbaren Text? Nur dann zaehlt seine Schrift.
  function zeigtText(o) {
    const text = [...o.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || /^(input|textarea|select)$/.test(o.localName);
    return text && sichtbar(o);
  }

  function bereinigen(o, k, cs, wegdamit, luecken, medien) {
    for (const a of [...k.attributes]) {
      const n = a.name.toLowerCase();
      const v = a.value.trim();
      if (n.startsWith('on') || n === 'nonce') { k.removeAttribute(a.name); continue; }
      if (/^javascript:/i.test(v)) {
        // Link bleibt Link (Farbe, Unterstreichung), nur ohne Skript
        if (n === 'href' && (o.localName === 'a' || o.localName === 'area')) k.setAttribute(a.name, '#'); else k.removeAttribute(a.name);
        continue;
      }
      if (URL_ATTRIBUTE.includes(n) && v && !v.startsWith('#') && !/^data:/i.test(v)) {
        k.setAttribute(a.name, (n === 'href' || n === 'action') && !/^(img|image|use|link)$/.test(o.localName) ? saeubern(absolut(v)) : absolut(v));
      }
      if (n === 'srcset') k.setAttribute(a.name, v.split(',').map((t) => { const [u, ...r] = t.trim().split(/\s+/); return [absolut(u), ...r].join(' '); }).join(', '));
    }
    switch (o.localName) {
      case 'input':
        if ((o.type || '').toLowerCase() === 'hidden') { wegdamit.push(k); return; }
        k.removeAttribute('value');
        break;
      case 'textarea': k.textContent = ''; break;
      case 'img':
        k.removeAttribute('loading'); k.removeAttribute('decoding'); // statische Kopie: sofort laden
        if (o.currentSrc) { k.setAttribute('src', o.currentSrc); k.removeAttribute('srcset'); k.removeAttribute('sizes'); }
        break;
      case 'source':
        if (o.parentElement && o.parentElement.localName === 'picture') wegdamit.push(k); // img traegt currentSrc
        break;
      case 'video': case 'canvas': case 'iframe': case 'object': case 'embed': {
        const nr = medien.liste.indexOf(o) + 1;
        if (!nr) { // versteckt: kein Standbild moeglich, wie bisher behandeln
          if (o.localName !== 'video' && o.localName !== 'canvas') ersetzen(k, platzhalter(cs, `${o.localName} – not transferred`), medien);
          break;
        }
        medium(o, k, cs, nr, medien);
        break;
      }
    }
  }

  // Externe Verweise in einem Quelltext (Skripte, Stylesheets, Bilder, @import): nur nennen
  function externeVerweise(html) {
    const urls = new Set();
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) urls.add(m[1].startsWith('//') ? 'https:' + m[1] : m[1]);
    for (const m of html.matchAll(/(?:@import\s+(?:url\()?|url\()\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) urls.add(m[1].startsWith('//') ? 'https:' + m[1] : m[1]);
    return [...urls];
  }

  // Was in einem iframe steckt: srcdoc (Quelltext unveraendert, auch ohne same-origin lesbar, weil
  // er am iframe im Hauptdokument steht), gleiche Domain (Dokument zugaenglich) oder fremd (Adresse)
  function rahmenInfo(iframe) {
    const r = iframe.getBoundingClientRect();
    const groesse = { breite: Math.round(r.width), hoehe: Math.round(r.height) };
    const srcdoc = iframe.getAttribute('srcdoc');
    if (srcdoc) return { art: 'srcdoc', quelle: srcdoc, extern: externeVerweise(srcdoc), ...groesse };
    let dok = null;
    try { dok = iframe.contentDocument; } catch { dok = null; }
    const adresse = iframe.getAttribute('src') ? saeubern(absolut(iframe.getAttribute('src'))) : '';
    if (dok && dok.body) return { art: 'gleich', adresse, koerper: dok.body, ...groesse };
    return { art: 'fremd', adresse, ...groesse };
  }

  // Shader des aktiven Programms einer WebGL-Leinwand (GLSL, wie die Seite ihn uebergeben hat).
  // getContext mit dem vorhandenen Typ liefert den bestehenden Kontext; null bei Canvas 2D.
  // -> [{ typ, quelle }], [] bei WebGL ohne aktives Programm, null ohne WebGL
  function shaderLesen(canvas) {
    let gl = null;
    for (const art of ['webgl2', 'webgl', 'experimental-webgl']) {
      try { gl = canvas.getContext(art); } catch { gl = null; }
      if (gl) break;
    }
    if (!gl) return null;
    try {
      const prog = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!prog) return [];
      return (gl.getAttachedShaders(prog) || []).map((s) => ({
        typ: gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER ? 'vertex' : 'fragment',
        quelle: gl.getShaderSource(s) || '',
      })).filter((s) => s.quelle);
    } catch { return []; }
  }

  // Kopie eines Mediums ersetzen. Ist das Medium selbst die Wurzel des Fangs, hat seine Kopie keinen
  // Elternknoten; dann wird der Ersatz zur neuen Wurzel (medien.wurzel).
  function ersetzen(k, ersatz, medien) {
    if (k.parentNode) k.replaceWith(ersatz);
    else medien.wurzel = ersatz;
  }

  // Ein sichtbares Medium: Quelle sichern, so weit es geht, und das Standbild einsetzen
  function medium(o, k, cs, nr, medien) {
    const r = o.getBoundingClientRect();
    const eintrag = { nr, art: MEDIEN[o.localName], anteil: medien.flaeche ? Math.min(1, (r.width * r.height) / medien.flaeche) : 0, standbild: `images/still-${nr}.webp`, hinweise: [],
      selektor: selektor(o), lage: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY) } };
    medien.eintraege.push(eintrag);
    const standbildImg = (alt) => {
      const img = D.createElement('img');
      img.setAttribute('src', eintrag.standbild); img.setAttribute('alt', alt);
      img.setAttribute('style', `${k.getAttribute('style') || ''}; object-fit: fill`);
      return img;
    };
    if (o.localName === 'video') {
      const quelle = o.currentSrc || (o.getAttribute('src') ? absolut(o.getAttribute('src')) : '') ||
        [...o.querySelectorAll('source[src]')].map((s) => absolut(s.getAttribute('src')))[0] || '';
      if (o.getAttribute('poster')) k.setAttribute('data-yoink-poster', absolut(o.getAttribute('poster')));
      k.setAttribute('poster', eintrag.standbild);
      if (k.hasAttribute('autoplay')) {
        k.removeAttribute('autoplay'); k.setAttribute('data-yoink-autoplay', '');
        eintrag.hinweise.push('autoplay turned off so the still image stays (data-yoink-autoplay)');
      }
      for (const s of [...k.querySelectorAll('source')]) s.remove();
      eintrag.hinweise.unshift('still image from the captured image as poster');
      if (/^https?:/i.test(quelle)) {
        let pfad = ''; try { pfad = new URL(quelle).pathname.split('/').pop() || ''; } catch { /* bleibt */ }
        const endung = ((pfad.match(/\.(mp4|webm|mov|m4v|ogv)$/i) || [, 'mp4'])[1]).toLowerCase();
        const stamm = pfad.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60) || 'video';
        let datei = `${stamm}.${endung}`;
        for (let n = 2; medien.videoNamen.has(datei); n++) datei = `${stamm}-${n}.${endung}`;
        medien.videoNamen.add(datei);
        k.setAttribute('src', `videos/${datei}`);
        medien.nachladen.push({ url: quelle, ziel: `videos/${datei}`, art: 'videos', familie: null });
        eintrag.quelle = saeubern(quelle);
        eintrag.hinweise.push(`video file to videos/${datei}`);
      } else {
        k.removeAttribute('src');
        eintrag.hinweise.push(quelle ? `video plays as a stream (${quelle.split(':')[0]}:), file cannot be saved` : 'video without a source');
      }
      return;
    }
    if (o.localName === 'canvas') {
      const sh = shaderLesen(o);
      if (sh && sh.length) {
        sh.forEach((s, i) => medien.shader.push({ ...s, datei: `canvas-${nr}-${s.typ}${sh.filter((x) => x.typ === s.typ).length > 1 ? '-' + (i + 1) : ''}.glsl` }));
        eintrag.hinweise.push(`WebGL, shader code included (shader/canvas-${nr}-*.glsl, ${sh.length} shaders of the active program)`);
      } else if (sh) {
        eintrag.hinweise.push('WebGL without an active shader program, shaders not readable');
      } else {
        eintrag.hinweise.push('Canvas 2D: drawn by script, no shader; motion only in the original');
      }
      let url = null;
      try {
        url = o.toDataURL('image/png');
        const leer = D.createElement('canvas'); leer.width = o.width; leer.height = o.height;
        if (url === leer.toDataURL('image/png')) url = null; // WebGL ohne Puffer oder wirklich leer
      } catch { url = null; } // fremde Bilder im Canvas
      if (url) {
        const img = standbildImg('canvas still');
        img.setAttribute('src', url);
        ersetzen(k, img, medien);
        eintrag.standbild = null; // die Pixel kommen aus dem Canvas selbst
        eintrag.hinweise.push('canvas taken as a still image from its own pixels, motion missing');
      } else {
        ersetzen(k, standbildImg('canvas still'), medien);
        eintrag.hinweise.push('canvas not readable (WebGL or images from other sites), still image from the captured image');
      }
      return;
    }
    // iframe mit srcdoc: der Quelltext steht im Attribut im Hauptdokument, auch ohne same-origin.
    // Er kommt unveraendert mit (source.html bzw. source-N.html), Lage im Fang fuer den Render-Vergleich.
    const srcdoc = o.localName === 'iframe' ? o.getAttribute('srcdoc') : null;
    if (srcdoc) {
      const datei = medien.srcdocZahl === 1 ? 'source.html' : `source-${medien.quelltexte.length + 1}.html`;
      medien.quelltexte.push({ datei, quelle: srcdoc, extern: externeVerweise(srcdoc), x: Math.round(r.left - medien.fang.x), y: Math.round(r.top - medien.fang.y),
        breite: Math.round(r.width), hoehe: Math.round(r.height) });
      eintrag.quelltext = datei;
      ersetzen(k, standbildImg('iframe still'), medien);
      eintrag.hinweise.push(`component included as original code in ${datei} (srcdoc, unchanged), element.html shows a still image`);
      return;
    }
    // iframe, object, embed: fremde Seite oder Plugin, nur die Adresse laesst sich festhalten
    const q = o.getAttribute('src') || o.getAttribute('data') || '';
    const img = standbildImg(`${o.localName} still`);
    if (q && !/^(javascript|data|blob):/i.test(q)) { eintrag.quelle = saeubern(absolut(q)); img.setAttribute('data-yoink-quelle', eintrag.quelle); }
    ersetzen(k, img, medien);
    eintrag.hinweise.push(`other site${eintrag.quelle ? ` (${eintrag.quelle})` : ''}, content not transferable, still image from the captured image`);
  }

  const prozentText = (a) => (a > 0 && a < 0.01 ? 'under 1%' : `${Math.round(a * 100)}%`);
  // Gleiche Medien mit gleichen Hinweisen stehen in einer Zeile mit Zahl
  function medienMelden(medien, luecken) {
    const gruppen = new Map();
    for (const m of medien.eintraege) {
      const schluessel = m.anteil >= MEDIEN_HAUPT || m.quelltext ? `einzeln|${m.nr}` : `${m.art}|${m.hinweise.join('; ')}`;
      if (!gruppen.has(schluessel)) gruppen.set(schluessel, []);
      gruppen.get(schluessel).push(m);
    }
    for (const liste of gruppen.values()) {
      const m = liste[0];
      const anteil = liste.reduce((s, x) => s + x.anteil, 0);
      const kopf = m.quelltext
        ? `${m.art} with original code in ${m.quelltext} (covers ${prozentText(anteil)} of the area)`
        : m.anteil >= MEDIEN_HAUPT
        ? `Content is a ${m.art}, not rebuildable HTML (covers ${prozentText(anteil)} of the area)`
        : liste.length > 1
          ? `${liste.length}× ${m.art} (together ${prozentText(anteil)} of the area), no rebuildable HTML there`
          : `Contains a ${m.art} (${prozentText(anteil)} of the area), no rebuildable HTML there`;
      luecken.push(`${kopf}: ${m.hinweise.join('; ')}.`);
    }
  }

  function platzhalter(cs, text) {
    const d = D.createElement('div');
    d.setAttribute('style', `width: ${cs.width}; height: ${cs.height}; display: ${cs.display === 'inline' ? 'inline-block' : cs.display}; box-sizing: border-box; border: 1px dashed rgb(150, 150, 150); color: rgb(110, 110, 110); font: 12px/1.4 system-ui, sans-serif; padding: 8px; background: repeating-linear-gradient(45deg, rgba(0,0,0,0.03) 0 8px, transparent 8px 16px)`);
    d.textContent = text;
    return d;
  }

  // <use href="#id"> und url(#id), deren Ziel ausserhalb des Elements liegt, mitnehmen
  function fremdeSvgVerweise(root, klon, luecken) {
    const ids = new Set();
    for (const el of [klon, ...klon.querySelectorAll('*')]) {
      for (const a of el.attributes) {
        const m1 = (a.name === 'href' || a.name === 'xlink:href') && a.value.match(/^#(.+)$/);
        if (m1) ids.add(m1[1]);
        for (const m of a.value.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) ids.add(m[1]);
      }
    }
    const teile = [];
    for (const id of ids) {
      if (root.querySelector(`#${CSS.escape(id)}`)) continue;
      const ziel = D.getElementById(id);
      if (ziel) teile.push(ziel.outerHTML);
      else luecken.push(`SVG reference #${id} without a target on the page`);
    }
    return teile.length ? `<svg xmlns="${SVG}" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>${teile.join('')}</defs></svg>` : '';
  }

  // Vor dem Bildausschnitt: Element ganz ins Bild holen, wenn es passt, und fixed/sticky-
  // Elemente ausserhalb, die es ueberdecken (Seitenkopf, Banner), ausblenden. Gibt eine
  // Funktion zurueck, die alles wiederherstellt. Wartet nach dem Scrollen, weil viele Seiten
  // ihren Kopf erst per Skript auf fixed setzen, wenn gescrollt wurde.
  const bilder2 = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  // teil: {x, y, w, h} im Element (Bereichsauswahl). Dann wird nicht gescrollt, der Rahmen liegt
  // schon im Bild; verborgen wird, was den Rahmen ueberdeckt.
  const imElement = (el, teil) => {
    const e = el.getBoundingClientRect();
    return { left: e.left + teil.x, top: e.top + teil.y, right: e.left + teil.x + teil.w, bottom: e.top + teil.y + teil.h, width: teil.w, height: teil.h };
  };
  async function bildVorbereiten(el, pause = 350, teil = null) {
    const W = el.ownerDocument.defaultView, D = el.ownerDocument; // auch im iframe der Breiten
    const vorher = [W.scrollX, W.scrollY];
    let r = el.getBoundingClientRect();
    if (!teil && r.height <= W.innerHeight && (r.top < 0 || r.bottom > W.innerHeight)) {
      W.scrollBy({ top: r.top - Math.max(0, (W.innerHeight - r.height) / 2), behavior: 'instant' });
    }
    await new Promise((ok) => setTimeout(ok, pause));
    await bilder2();
    r = teil ? imElement(el, teil) : el.getBoundingClientRect();
    const aus = [];
    // visibility allein reicht nicht: Kinder duerfen visibility: visible setzen (auf echten Seiten gesehen).
    // opacity 0 kann kein Kind aufheben.
    const verbergen = (x) => {
      if (aus.some(([y]) => y === x)) return false;
      aus.push([x, ['visibility', 'opacity'].map((p) => [p, x.style.getPropertyValue(p), x.style.getPropertyPriority(p)])]);
      x.style.setProperty('visibility', 'hidden', 'important');
      x.style.setProperty('opacity', '0', 'important');
      return true;
    };
    for (const x of D.querySelectorAll('body *')) {
      if (el.contains(x) || x.contains(el) || x.localName === 'yoink-overlay') continue;
      const pos = W.getComputedStyle(x).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const b = x.getBoundingClientRect();
      if (!b.width || !b.height || b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom) continue;
      verbergen(x);
    }
    // Abtasten: was im Ausschnitt oben liegt und nicht zum Element gehoert (Kopf im Seitenfluss,
    // absolut darueber gelegte Leisten), bis zur hoechsten Huelle ausserhalb des Elements ausblenden
    for (let runde = 0; runde < 3; runde++) {
      let neu = false;
      // Raster etwa alle 40 px, damit auch schmale Leisten getroffen werden
      const spalten = Math.min(40, Math.max(3, Math.ceil(r.width / 40))), zeilen = Math.min(40, Math.max(3, Math.ceil(r.height / 40)));
      for (let i = 0; i < spalten; i++) {
        for (let j = 0; j < zeilen; j++) {
          const px = r.left + 2 + (r.width - 4) * (i / (spalten - 1)), py = r.top + 2 + (r.height - 4) * (j / (zeilen - 1));
          if (px < 0 || py < 0 || px >= W.innerWidth || py >= W.innerHeight) continue;
          const oben = D.elementFromPoint(px, py);
          if (!oben || el.contains(oben) || oben.contains(el) || oben.localName === 'yoink-overlay') continue;
          let h = oben;
          while (h.parentElement && !h.parentElement.contains(el)) h = h.parentElement;
          if (h !== D.body && h !== D.documentElement && verbergen(h)) neu = true;
        }
      }
      if (!neu) break;
    }
    await bilder2();
    return () => {
      for (const [x, alt] of aus) for (const [p, v, prio] of alt) { if (v) x.style.setProperty(p, v, prio); else x.style.removeProperty(p); }
      W.scrollTo({ left: vorher[0], top: vorher[1], behavior: 'instant' });
    };
  }

  // --- Hohe Elemente: durchscrollen und Sollbild aus Ausschnitten -------------------------------

  const MAX_SCHRITTE = 12;        // hoechstens so viele Bildschirmhoehen pro Sollbild
  const AUFNAHME_ABSTAND = 550;   // Chrome erlaubt zwei Aufnahmen pro Sekunde
  const warten = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // Einmal durch das Element scrollen, damit lazy geladene Bilder ihre Quelle bekommen; danach
  // auf die Bilder warten (hoechstens 3 s) und zur alten Stelle zurueck.
  async function durchscrollen(el, { pause = 400, maxSchritte = MAX_SCHRITTE } = {}) {
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= innerHeight) return { schritte: 0 };
    const vorher = [scrollX, scrollY];
    const start = scrollY + r.top, ende = start + r.height;
    let schritte = 0;
    for (let y = start; schritte < maxSchritte; y += innerHeight * 0.8) {
      scrollTo({ left: vorher[0], top: Math.min(y, ende - innerHeight * 0.5), behavior: 'instant' });
      schritte++;
      await warten(pause);
      if (y + innerHeight >= ende) break;
    }
    // Zweite Runde: zu jedem Bild, das noch keine Quelle hat, einzeln hin (hoechstens 10)
    const fehlend = [...el.querySelectorAll('img')].filter((i) => imLayout(i) && ohneQuelle(i)).slice(0, 10);
    for (const i of fehlend) {
      if (!ohneQuelle(i)) continue;
      i.scrollIntoView({ block: 'center', behavior: 'instant' });
      await warten(pause);
    }
    const offen = [...el.querySelectorAll('img')].filter((i) => i.getAttribute('src') && !i.complete);
    await Promise.race([Promise.all(offen.map((i) => new Promise((ok) => { i.addEventListener('load', ok, { once: true }); i.addEventListener('error', ok, { once: true }); }))), warten(3000)]);
    scrollTo({ left: vorher[0], top: vorher[1], behavior: 'instant' });
    await bilder2();
    return { schritte };
  }

  // Bilder des Fangs als WebP: bei 0,9 rund 13-mal kleiner als PNG, im Render-Vergleich (Schwelle 32)
  // gemessen 0,00 % zusaetzliche Abweichung (Nachrichten-Teaser, 2026-10-26)
  const BILD_FORMAT = { type: 'image/webp', quality: 0.9 };
  const formatVon = (b64) => (String(b64 || '').startsWith('UklGR') ? 'webp' : 'png');
  const bitmapAus = (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));

  // Ausschnitte [{x, y, w, h, bild}] (CSS-Pixel im Element) zu einem PNG zusammensetzen
  async function bildZusammensetzen(teile) {
    const bilder = await Promise.all(teile.map((t) => bitmapAus(t.bild)));
    const m = bilder[0].width / teile[0].w;
    const x0 = Math.min(...teile.map((t) => t.x)), y0 = Math.min(...teile.map((t) => t.y));
    const breite = Math.max(...teile.map((t) => t.x + t.w)) - x0, hoehe = Math.max(...teile.map((t) => t.y + t.h)) - y0;
    const c = new OffscreenCanvas(Math.round(breite * m), Math.round(hoehe * m));
    const x = c.getContext('2d');
    teile.forEach((t, i) => x.drawImage(bilder[i], Math.round((t.x - x0) * m), Math.round((t.y - y0) * m)));
    const b = new Uint8Array(await (await c.convertToBlob(BILD_FORMAT)).arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { bild: btoa(s), ausschnitt: { x: Math.round(x0), y: Math.round(y0), w: Math.round(breite), h: Math.round(hoehe) } };
  }

  const schnittMitBild = (r, W = window) => {
    const x = Math.max(0, r.left), y = Math.max(0, r.top), rr = Math.min(W.innerWidth, r.right), u = Math.min(W.innerHeight, r.bottom);
    return rr > x && u > y ? { x, y, w: rr - x, h: u - y } : null;
  };

  // Sollbild aufnehmen. aufnehmen(rect, medienRechtecke) -> {ok, bild, standbilder} (Extension:
  // captureVisibleTab und ausschneiden). Passt das Element nicht in die Hoehe des Fensters, wird
  // es in Bildschirmhoehen aufgenommen und zusammengesetzt. teil: Rahmen der Bereichsauswahl im
  // Element. medien: Nummern der Medien, die ein Standbild brauchen.
  // -> { bild, standbilder, ausschnitt: {x, y, w, h} im Element oder null, luecken }
  async function sollbild(el, aufnehmen, { teil = null, pause = 350, maxSchritte = MAX_SCHRITTE, medien = [], bewegung = true } = {}) {
    const W = el.ownerDocument.defaultView; // auch im iframe der Breiten
    const luecken = [];
    const brauchen = new Set(medien);
    const standbilder = new Map();
    let zuletzt = 0;
    // Element in einem iframe derselben Domain: Rechtecke liegen im Fenster des iframes, die
    // Aufnahme im obersten Fenster. Versatz aller umgebenden iframes addieren.
    const versatz = { x: 0, y: 0 };
    try {
      for (let w = W; w && w.frameElement && w !== window; w = w.parent) {
        const f = w.frameElement, r = f.getBoundingClientRect(), cs = w.parent.getComputedStyle(f);
        versatz.x += r.left + f.clientLeft + parseFloat(cs.paddingLeft);
        versatz.y += r.top + f.clientTop + parseFloat(cs.paddingTop);
      }
    } catch { /* fremdes Fenster dazwischen: ohne Versatz */ }
    const verschoben = (r) => (r ? { ...r, x: r.x + versatz.x, y: r.y + versatz.y } : r);
    const aufnahme = async (rect, alleMedien) => {
      await warten(Math.max(0, zuletzt + AUFNAHME_ABSTAND - Date.now()));
      zuletzt = Date.now();
      const sichtbareMedien = medienRechtecke(el, teil).filter((m) => brauchen.has(m.nr) && !standbilder.has(m.nr) &&
        (alleMedien || (m.y >= -1 && m.y + m.h <= W.innerHeight + 1))).map(verschoben);
      const a = await aufnehmen(verschoben(rect), sichtbareMedien);
      if (!a || !a.ok) throw new Error((a && a.fehler) || 'no answer');
      for (const s of a.standbilder || []) standbilder.set(Number(s.datei.match(/\d+/)[0]), s);
      return a.bild;
    };
    const knotenVorher = el.querySelectorAll('*').length;
    const fertig = (bild, ausschnitt) => {
      const knoten = el.querySelectorAll('*').length;
      if (knoten !== knotenVorher) {
        luecken.push(`The page loaded more content during the capture (${knotenVorher} → ${knoten} elements in the element). ` +
          'element.html shows the state afterwards; what was already in the image may have changed.');
      }
      return { bild, ausschnitt, luecken, standbilder: [...standbilder.values()], bewegt, geprueft, format: formatVon(bild) };
    };
    // Bewegt sich ein Medium (Canvas-Animation, WebGL)? Zweite Aufnahme seines Standbilds, Vergleich
    const bewegt = [], geprueft = [];
    const bewegungPruefen = async () => {
      const rechtecke = medienRechtecke(el, teil).filter((m) => standbilder.has(m.nr)).map(verschoben);
      if (!rechtecke.length) return;
      await warten(Math.max(0, zuletzt + AUFNAHME_ABSTAND - Date.now()));
      zuletzt = Date.now();
      const a = await aufnehmen(null, rechtecke);
      for (const s of (a && a.standbilder) || []) {
        const nr = Number(s.datei.match(/\d+/)[0]);
        geprueft.push(nr);
        if (s.base64 !== standbilder.get(nr).base64) bewegt.push(nr);
      }
    };
    const ganz = el.getBoundingClientRect();

    if (teil || ganz.height <= W.innerHeight || maxSchritte <= 1) {
      const zurueck = await bildVorbereiten(el, pause, teil);
      try {
        const e = el.getBoundingClientRect();
        const s = schnittMitBild(teil ? imElement(el, teil) : e, W);
        if (!s) { luecken.push('Element not in the visible area, no image'); return fertig('', null); }
        const ausschnitt = { x: Math.round(s.x - e.left), y: Math.round(s.y - e.top), w: Math.round(s.w), h: Math.round(s.h) };
        const soll = teil || { w: e.width, h: e.height };
        if (s.w < soll.w - 1 || s.h < soll.h - 1) {
          luecken.push(`Image shows only the visible part of the element (${ausschnitt.w} × ${ausschnitt.h} of ${Math.round(soll.w)} × ${Math.round(soll.h)} px), render check only there`);
        }
        const bild = await aufnahme(s, true);
        if (bewegung) await bewegungPruefen();
        return fertig(bild, ausschnitt);
      } catch (fehler) {
        luecken.push(`Image not captured: ${fehler.message}`);
        return fertig('', null);
      } finally {
        zurueck();
      }
    }

    // Hoch: Bildschirmhoehe fuer Bildschirmhoehe, jeder Ausschnitt mit eigenem Verbergen des Kopfes
    const vorher = [W.scrollX, W.scrollY];
    const teile = [];
    const mitlaufend = [...el.querySelectorAll('*')].filter((x) => /^(sticky|fixed)$/.test(W.getComputedStyle(x).position) && sichtbar(x)).length;
    try {
      let oben = 0;
      for (let i = 0; i < maxSchritte && oben < ganz.height - 1; i++) {
        W.scrollBy({ top: el.getBoundingClientRect().top + oben, behavior: 'instant' });
        const zurueck = await bildVorbereiten(el, pause);
        try {
          const e = el.getBoundingClientRect();
          const s = schnittMitBild(e, W);
          const y = s ? s.y - e.top : -1;
          if (!s || (teile.length && y <= teile[teile.length - 1].y)) break; // laesst sich nicht weiter scrollen
          // Seiten mit Endlosliste laden beim Scrollen nach; das Sollbild endet, wo das Element beim
          // Fang endete
          const h = Math.min(s.h, ganz.height - y);
          if (h < 1) break;
          teile.push({ x: s.x - e.left, y, w: s.w, h, bild: await aufnahme({ ...s, h }, false) });
          oben = y + h;
        } finally {
          zurueck();
        }
      }
    } catch (fehler) {
      luecken.push(`Image not fully captured: ${fehler.message}`);
    } finally {
      W.scrollTo({ left: vorher[0], top: vorher[1], behavior: 'instant' });
    }
    if (!teile.length || teile.some((t) => !t.bild)) {
      if (!teile.length) luecken.push('Element not in the visible area, no image');
      return fertig(teile[0] ? teile[0].bild : '', teile[0] ? { x: Math.round(teile[0].x), y: Math.round(teile[0].y), w: Math.round(teile[0].w), h: Math.round(teile[0].h) } : null);
    }
    const { bild, ausschnitt } = await bildZusammensetzen(teile);
    if (ausschnitt.h < ganz.height - 1 || ausschnitt.w < ganz.width - 1) {
      luecken.push(`Image shows only the top part of the element (${ausschnitt.w} × ${ausschnitt.h} of ${Math.round(ganz.width)} × ${Math.round(ganz.height)} px, at most ${maxSchritte} screen heights), render check only there`);
    }
    if (mitlaufend) luecken.push(`Captured image stitched from ${teile.length} sections; ${mitlaufend} scrolling parts (sticky/fixed) in the element may appear several times`);
    return fertig(bild, ausschnitt);
  }

  // --- Breiten: dieselbe Seite schmaler ---------------------------------------------------------
  //
  // Die Seite wird in einem iframe derselben Adresse mit fester Breite geladen (gleicher Ursprung,
  // gleiche Cookies), das Element ueber seinen Pfad wiedergefunden und wie sonst aufgenommen. Der
  // iframe liegt oben links ueber der Seite, damit captureVisibleTab ihn sieht. sandbox ohne
  // allow-top-navigation, allow-forms, allow-popups: Skripte der Seite laufen, koennen aber weder
  // die Seite wegnavigieren noch etwas abschicken.
  const BREITE_LADEN = 15000;
  async function breitenAufnehmen(meta, breiten, aufnehmen, { warten: ruhe = 1500 } = {}) {
    const ergebnis = [], luecken = [], nachholen = [];
    for (const breite of breiten) {
      if (breite >= innerWidth) { luecken.push(`Width ${breite} px not captured: the window is not wider`); continue; }
      const rahmen = document.createElement('iframe');
      rahmen.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      rahmen.setAttribute('aria-hidden', 'true');
      rahmen.style.cssText = `position: fixed; left: 0; top: 0; width: ${breite}px; height: ${innerHeight}px; border: 0; margin: 0; padding: 0; z-index: 2147483646; background: #fff`;
      const geladen = new Promise((ok) => rahmen.addEventListener('load', ok, { once: true }));
      rahmen.src = location.href;
      document.documentElement.appendChild(rahmen);
      try {
        await Promise.race([geladen, warten(BREITE_LADEN)]);
        await warten(ruhe);
        let d = null;
        try { d = rahmen.contentDocument; } catch { d = null; }
        if (!d || !d.body || d.location.href === 'about:blank') {
          nachholen.push(breite); // Seite verbietet das Einbetten: der Host rendert diese Breite selbst
          continue;
        }
        const suchen = (s) => { try { return s ? d.querySelector(s) : null; } catch { return null; } };
        const el = suchen(meta.pfad) || suchen(meta.selektor);
        if (!el || !el.getBoundingClientRect().width) {
          luecken.push(`Width ${breite} px: element not found there – the page is built differently at this width`);
          continue;
        }
        el.scrollIntoView({ block: 'start', behavior: 'instant' });
        const s = await sollbild(el, aufnehmen, { pause: 350 });
        if (s.bild) ergebnis.push({ breite, bild: s.bild, ausschnitt: s.ausschnitt, hoehe: Math.round(el.getBoundingClientRect().height) });
        for (const l of s.luecken) luecken.push(`Width ${breite} px: ${l.replace(/, render check only there/, '')}`); // je Breite gibt es keinen Render-Vergleich
      } catch (fehler) {
        luecken.push(`Width ${breite} px not captured: ${fehler.message}`);
      } finally {
        rahmen.remove();
      }
    }
    return { breiten: ergebnis, luecken, nachholen };
  }

  // --- Bereichsauswahl -------------------------------------------------------------------------


  // Rahmen {x, y, w, h} im Fenster -> kleinstes gemeinsames Elternelement aller Elemente, die
  // mindestens zur Haelfte im Rahmen liegen, und der Rahmen darin (auf das Element beschnitten).
  // Fixierte und mitlaufende Teile (Seitenkopf) zaehlen nicht: sie liegen nur zufaellig ueber dem
  // Rahmen, und die Aufnahme blendet sie aus.
  function mitlaufend(o) {
    for (let a = o; a && a !== document.body; a = a.parentElement) if (/^(fixed|sticky)$/.test(getComputedStyle(a).position)) return true;
    return false;
  }
  function bereich(rahmen) {
    const R = { l: rahmen.x, t: rahmen.y, r: rahmen.x + rahmen.w, b: rahmen.y + rahmen.h };
    let gemeinsam = null;
    for (const o of document.body.querySelectorAll('*')) {
      if (o.localName === 'yoink-overlay' || ENTFERNEN.has(o.localName)) continue;
      const b = o.getBoundingClientRect();
      const flaeche = b.width * b.height;
      if (flaeche <= 0) continue;
      const ix = Math.min(b.right, R.r) - Math.max(b.left, R.l), iy = Math.min(b.bottom, R.b) - Math.max(b.top, R.t);
      if (ix <= 0 || iy <= 0 || ix * iy < flaeche * 0.5 || !sichtbar(o) || mitlaufend(o)) continue;
      if (!gemeinsam) gemeinsam = o;
      while (!gemeinsam.contains(o)) gemeinsam = gemeinsam.parentElement;
    }
    if (!gemeinsam) gemeinsam = document.elementFromPoint(R.l + rahmen.w / 2, R.t + rahmen.h / 2) || document.body;
    if (gemeinsam === document.documentElement) gemeinsam = document.body;
    const e = gemeinsam.getBoundingClientRect();
    const l = Math.max(R.l, e.left), t = Math.max(R.t, e.top), r = Math.min(R.r, e.right), u = Math.min(R.b, e.bottom);
    const ausschnitt = { x: Math.round(l - e.left), y: Math.round(t - e.top), w: Math.round(Math.max(0, r - l)), h: Math.round(Math.max(0, u - t)) };
    const verhaeltnis = ausschnitt.w * ausschnitt.h ? (e.width * e.height) / (ausschnitt.w * ausschnitt.h) : Infinity;
    const luecken = [];
    // seit 0.9.0 schneidet erfassen auf den Rahmen zu; ein grosses Elternelement blaeht den Fang nicht mehr auf
    return { element: gemeinsam, ausschnitt, verhaeltnis, luecken };
  }

  window.__yoinkErfassen = erfassen;
  window.__yoinkBildVorbereiten = bildVorbereiten;
  window.__yoinkDurchscrollen = durchscrollen;
  window.__yoinkSollbild = sollbild;
  window.__yoinkBereich = bereich;
  window.__yoinkBreiten = breitenAufnehmen;
  window.__yoinkRahmen = rahmenInfo;
  window.__yoinkSchriftTabelle = SCHRIFT_TABELLE;
  window.__yoinkSchriftErsatz = schriftErsatz;
  window.__yoinkMedienRechtecke = medienRechtecke;
  window.__yoinkHuelle = huelle;
  window.__yoinkVervollstaendigen = vervollstaendigen;
})();
