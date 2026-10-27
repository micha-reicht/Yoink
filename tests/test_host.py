"""Tests fuer host/yoink_host.py und installieren.sh.

Lauf: python3 -m unittest discover -q -s tests
"""
import base64
import datetime
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HIER = Path(__file__).resolve().parent
WERKZEUG = HIER.parent
sys.path.insert(0, str(WERKZEUG / "host"))
import yoink_host  # noqa: E402

HEUTE = datetime.date(2026, 10, 23)
PNG_1PX = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360f8ffff3f0005fe02fea7d6a4"
    "0000000049454e44ae426082")).decode()


def nachricht(**meta):
    m = {"url": "https://stripe.com/au", "titel": "Stripe", "label": "Create a card issuing programme",
         "selektor": "button.bento-card", "breite": 400, "hoehe": 676,
         "schriften": ["sohne-var"], "luecken": []}
    m.update(meta)
    return {"typ": "fangen", "html": "<!doctype html><p>x</p>", "css": "p{}", "bild_png_base64": PNG_1PX, "meta": m}


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return {z.split(":", 1)[0].strip() for z in m.group(1).splitlines() if ":" in z} if m else set()



class Fangen(unittest.TestCase):
    def setUp(self):
        self.render_vorher = yoink_host.RENDERN
        yoink_host.RENDERN = False
        self.addCleanup(setattr, yoink_host, "RENDERN", self.render_vorher)
        self.tmp = tempfile.TemporaryDirectory()
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_boeses_label_bleibt_in_der_halde(self):
        # Negativkontrolle zum Pfadschutz: Label und URL versuchen auszubrechen
        a = yoink_host.fangen(nachricht(label="../../../etc/passwd", url="https://../x"), self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        alle = [p for p in Path(self.tmp.name).rglob("*") if p.is_file()]
        self.assertTrue(all(self.ablage in p.parents for p in alle), alle)
        self.assertNotIn("/", Path(a["notiz"]).name)

    def test_slug_und_titel(self):
        self.assertEqual(yoink_host.slug("../Größe / Übersicht!"), "grosse-ubersicht")
        self.assertEqual(yoink_host.slug(""), "element")
        self.assertEqual(yoink_host.slug("/../"), "element")
        self.assertNotRegex(yoink_host.titel_fuer_datei("a/b\\c:[[x]]#^|"), r"[/\\:\[\]#^|]")

    def test_ohne_bild_keine_einbettung(self):
        n = nachricht()
        n["bild_png_base64"] = ""
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertNotIn("![[", Path(a["notiz"]).read_text())

    def test_ohne_html_fehler(self):
        n = nachricht()
        n["html"] = ""
        self.assertFalse(yoink_host.fangen(n, self.ablage, HEUTE)["ok"])

    def test_schriften_landen_im_anhang(self):
        n = nachricht(schriften=["DM Sans"])
        n["schriften"] = [{"datei": "dm-sans.woff2", "base64": base64.b64encode(b"wOF2abc").decode()}]
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"
        self.assertEqual((anhang / "fonts" / "dm-sans.woff2").read_bytes(), b"wOF2abc")
        text = Path(a["notiz"]).read_text()
        self.assertIn("DM Sans (1 file saved)", text)
        self.assertIn("[fonts/](fonts/) – font files", text)

    def test_boese_schriftnamen_werden_nicht_geschrieben(self):
        # Negativkontrolle: Namen, die ausbrechen oder keine Schrift sind
        n = nachricht()
        b = base64.b64encode(b"x").decode()
        n["schriften"] = [{"datei": d, "base64": b} for d in ("../../boese.woff2", "a/b.woff2", "skript.js", ".versteckt.woff2")]
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        alle = [p for p in Path(self.tmp.name).rglob("*") if p.is_file()]
        self.assertFalse([p for p in alle if p.suffix in (".woff2", ".js")], alle)
        self.assertEqual(Path(a["notiz"]).read_text().count("Font file rejected"), 4)

    def test_farben_mit_und_ohne_token(self):
        n = nachricht(farben=[
            {"farbe": "#f79009", "anzahl": 5, "wo": ["border-color"], "tokens": []},
            {"farbe": "#1a1a1a", "anzahl": 1, "wo": ["color"], "tokens": ["--text", "--text-stark", "--a", "--b"]},
        ])
        text = Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()
        self.assertIn("## Colours", text)
        self.assertIn("- `#f79009` · 5× · border-color · **no token**", text)
        self.assertIn("- `#1a1a1a` · 1× · color · `--text`, `--text-stark`, `--a` (+1)", text)

    def test_ohne_farben_kein_abschnitt(self):
        text = Path(yoink_host.fangen(nachricht(), self.ablage, HEUTE)["notiz"]).read_text()
        self.assertNotIn("## Colours", text)

    def test_luecken_stehen_in_der_notiz(self):
        a = yoink_host.fangen(nachricht(luecken=["canvas nicht lesbar"]), self.ablage, HEUTE)
        self.assertIn("- canvas nicht lesbar", Path(a["notiz"]).read_text())


class Ablage(unittest.TestCase):
    """Ablageordner kommt aus der Einstellung der Extension (Feld "ordner" der Nachricht). Ohne Ordner
    nichts schreiben, sondern nachfragen; nie ausserhalb des Ordners schreiben."""

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.basis = Path(self.tmp.name).resolve()
        self.ordner = self.basis / "catches"
        self.ordner.mkdir()
        self.nachbar = self.basis / "nachbar"
        self.nachbar.mkdir()

    def alle_dateien(self):
        return sorted(p for p in self.basis.rglob("*") if p.is_file())

    def test_ein_ordner_je_fang_mit_readme(self):
        n = nachricht()
        n["ordner"] = str(self.ordner)
        a = yoink_host.fangen(n, heute=HEUTE)
        self.assertTrue(a["ok"], a)
        fang = self.ordner / "2026-10-23-stripe-com-create-a-card-issuing-programme"
        self.assertEqual(Path(a["notiz"]), fang / "README.md")
        self.assertEqual(sorted(p.name for p in fang.iterdir()), ["README.md", "element.html", "image.png", "rules.css"])
        text = (fang / "README.md").read_text()
        self.assertIn("![Captured image](image.png)", text)
        self.assertIn("[element.html](element.html)", text)
        self.assertNotIn("![[", text)
        self.assertNotIn(str(self.basis), text, "absolute path in README")
        for kopf in ("# stripe.com – Create a card issuing programme", "## Files", "## Gaps"):
            self.assertIn(kopf, text)
        self.assertIn('source: "https://stripe.com/au"', text)

    def test_zweiter_fang_eigener_ordner(self):
        n = nachricht()
        n["ordner"] = str(self.ordner)
        a1, a2 = yoink_host.fangen(n, heute=HEUTE), yoink_host.fangen(dict(n, meta=dict(n["meta"])), heute=HEUTE)
        self.assertNotEqual(a1["notiz"], a2["notiz"])
        self.assertTrue((self.ordner / "2026-10-23-stripe-com-create-a-card-issuing-programme-2" / "README.md").is_file())

    def test_ohne_ordner_rueckfrage_und_nichts_geschrieben(self):
        for leer in (None, "", "   "):
            n = nachricht()
            if leer is not None:
                n["ordner"] = leer
            a = yoink_host.fangen(n, heute=HEUTE)
            self.assertFalse(a["ok"])
            self.assertTrue(a.get("kein_ordner"), a)
            self.assertIn("No folder", a["fehler"])
        self.assertEqual(self.alle_dateien(), [])

    def test_ohne_ordner_ueber_protokoll_nichts_in_home_oder_arbeitsordner(self):
        # wie Chrome den Host startet: kein Ordner in der Nachricht, HOME und Arbeitsordner beobachtet
        n = nachricht()
        daten = json.dumps(n).encode()
        p = subprocess.run([sys.executable, str(WERKZEUG / "host" / "yoink_host.py")], input=struct.pack("=I", len(daten)) + daten,
                           capture_output=True, timeout=60, cwd=self.nachbar, env={"HOME": str(self.nachbar), "PATH": "/usr/bin:/bin"})
        laenge = struct.unpack("=I", p.stdout[:4])[0]
        a = json.loads(p.stdout[4:4 + laenge])
        self.assertTrue(a.get("kein_ordner"), a)
        # Apples Python legt seinen Bytecode-Cache unter ~/Library/Caches/com.apple.python an; das ist
        # der Interpreter, nicht yoink
        python_cache = self.nachbar / "Library" / "Caches" / "com.apple.python"
        self.assertEqual([p for p in self.alle_dateien() if python_cache not in p.parents], [])

    def test_ordner_fehlt(self):
        n = nachricht()
        n["ordner"] = str(self.basis / "gibtsnicht")
        a = yoink_host.fangen(n, heute=HEUTE)
        self.assertFalse(a["ok"])
        self.assertIn("Folder not found", a["fehler"])
        self.assertFalse((self.basis / "gibtsnicht").exists())

    def test_relativer_pfad_abgelehnt(self):
        n = nachricht()
        n["ordner"] = "catches"
        a = yoink_host.fangen(n, heute=HEUTE)
        self.assertFalse(a["ok"])
        self.assertIn("full path", a["fehler"])
        self.assertEqual(self.alle_dateien(), [])

    def test_ordner_nicht_beschreibbar(self):
        self.ordner.chmod(0o555)
        self.addCleanup(self.ordner.chmod, 0o755)
        n = nachricht()
        n["ordner"] = str(self.ordner)
        a = yoink_host.fangen(n, heute=HEUTE)
        self.assertFalse(a["ok"])
        self.assertIn("not writable", a["fehler"])
        self.assertIn(str(self.ordner), a["fehler"])
        self.assertEqual(self.alle_dateien(), [])

    def test_nie_ausserhalb_des_ordners(self):
        # Negativkontrolle zum Pfadschutz: jeder Name zielt auf den vorhandenen Nachbarordner neben dem
        # Ablageordner (fonts/../../../nachbar = basis/nachbar)
        n = nachricht(label="../../nachbar/x", url="https://../../x")
        n["ordner"] = str(self.ordner)
        b = base64.b64encode(b"x").decode()
        n["schriften"] = [{"datei": "../../../nachbar/a.woff2", "base64": b}]
        n["bilder"] = [{"datei": "../../../nachbar/b.png", "base64": PNG_1PX}]
        n["quelltexte"] = [{"datei": "../../nachbar/source.html", "quelle": "<p>x</p>", "extern": []}]
        n["shader"] = [{"datei": "../../../nachbar/s.glsl", "quelle": "void main(){}"}]
        n["quellen"] = [{"datei": "../../../nachbar/q.css", "text": "p{}"}]
        n["nachladen"] = [{"url": "https://example.com/x.png", "ziel": "images/../../../nachbar/x.png", "art": "bilder"}]
        n["breiten"] = [{"breite": "../390", "base64": PNG_1PX}]
        a = yoink_host.fangen(n, heute=HEUTE)
        self.assertTrue(a["ok"], a)
        fang = Path(a["notiz"]).parent
        self.assertEqual(fang.parent, self.ordner)
        draussen = [p for p in self.alle_dateien() if fang not in p.parents]
        self.assertEqual(draussen, [])
        self.assertEqual(list(self.nachbar.iterdir()), [])

    def test_ordner_pruefen_nachricht(self):
        self.assertTrue(yoink_host.behandeln({"typ": "ordner_pruefen", "ordner": str(self.ordner)})["ok"])
        a = yoink_host.behandeln({"typ": "ordner_pruefen", "ordner": str(self.basis / "fehlt")})
        self.assertFalse(a["ok"])
        self.assertIn("Folder not found", a["fehler"])

    def test_ordner_waehlen_dialog_und_abbruch(self):
        # Der echte Dialog ist macOS "choose folder"; fuer Tests ersetzt YOINK_TEST_PICK die Antwort
        with unittest.mock.patch.dict("os.environ", {"YOINK_TEST_PICK": str(self.ordner)}):
            a = yoink_host.behandeln({"typ": "ordner_waehlen"})
        self.assertEqual(a, {"ok": True, "ordner": str(self.ordner)})
        with unittest.mock.patch.dict("os.environ", {"YOINK_TEST_PICK": "cancel"}):
            a = yoink_host.behandeln({"typ": "ordner_waehlen"})
        self.assertFalse(a["ok"])
        self.assertTrue(a.get("abgebrochen"))
        self.assertEqual(self.alle_dateien(), [])


class Server:
    """Kleiner HTTP-Server auf 127.0.0.1 mit festen Antworten."""
    ROUTEN = {
        "/stil.css": ("text/css; charset=utf-8", b"@font-face { font-family: Raleway; src: url(/r.woff2); }"),
        "/kein-css.css": ("text/html", b"<html>Login</html>"),
        "/r.woff2": ("font/woff2", b"wOF2raleway"),
        "/bg.png": ("image/png", base64.b64decode(PNG_1PX)),
        "/clip.mp4": ("video/mp4", b"mp4-test-video"),
        "/umleitung.css": None,
        "/werkzeug.js": ("text/javascript", b"window.werkzeug = 42;"),
        # wie das Tailwind-CDN: ein Skript, das zur Laufzeit gestaltet
        "/tw.js": ("text/javascript", b"document.addEventListener('DOMContentLoaded', function () { document.body.style.background = 'rgb(30,60,220)'; });"),
        "/schrift.css": ("text/css; charset=utf-8", b"@font-face { font-family: Probe; src: url(/f.woff2) format('woff2'); } body { font-family: Probe; }"),
        "/f.woff2": ("font/woff2", b"wOF2-probe"),
        "/szene.json": ("application/json", b'{"farbe": [30, 60, 220]}'),
        "/umami/x.js": ("text/javascript", b"window.verfolgt = 1;"),
        "/breiten.html": ("text/html; charset=utf-8", (
            b'<!doctype html><html><head><style>body{margin:0} .h{padding:30px} #ziel{height:120px;background:rgb(0,0,255)}'
            b' @media (max-width: 500px) { #ziel { background: rgb(255,0,0); } }'
            b' @media (min-width: 501px) and (max-width: 900px) { #ziel { background: rgb(0,160,0); } }'
            b'</style></head><body><header style="position:fixed;top:0;left:0;right:0;height:40px;background:rgb(0,0,0)"></header>'
            b'<div style="height:300px"></div><div class="h"><div id="ziel"></div></div><div style="height:2000px"></div></body></html>')),
    }

    def __enter__(self):
        routen = self.ROUTEN

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/umleitung.css":
                    self.send_response(302)
                    self.send_header("Location", "http://169.254.169.254/latest/meta-data")
                    self.end_headers()
                    return
                r = routen.get(self.path.split("?")[0])
                if not r:
                    self.send_response(404); self.end_headers(); return
                self.send_response(200)
                self.send_header("Content-Type", r[0])
                # wie Ressourcen, die zum Einbetten gedacht sind (CDN, Szenen): jede Herkunft erlaubt
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(r[1])

            def log_message(self, *a):
                pass

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.basis = f"http://127.0.0.1:{self.srv.server_address[1]}"
        return self

    def __exit__(self, *a):
        self.srv.shutdown()


class Netz(unittest.TestCase):
    """Holen und Nachladen: nur oeffentliche Adressen, ausser im Test ausdruecklich erlaubt."""

    def setUp(self):
        self.vorher = yoink_host.LOKAL_ERLAUBT
        yoink_host.LOKAL_ERLAUBT = True
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def tearDown(self):
        yoink_host.LOKAL_ERLAUBT = self.vorher
        self.tmp.cleanup()

    def test_holen_liefert_css(self):
        with Server() as s:
            a = yoink_host.behandeln({"typ": "holen", "url": s.basis + "/stil.css"})
        self.assertTrue(a["ok"], a)
        self.assertIn("font-family: Raleway", a["text"])

    def test_holen_lehnt_nicht_css_ab(self):
        with Server() as s:
            a = yoink_host.behandeln({"typ": "holen", "url": s.basis + "/kein-css.css"})
        self.assertFalse(a["ok"])
        self.assertIn("not CSS", a["fehler"])

    def test_negativkontrolle_lokale_adresse_ohne_erlaubnis(self):
        yoink_host.LOKAL_ERLAUBT = False
        with Server() as s:
            a = yoink_host.behandeln({"typ": "holen", "url": s.basis + "/stil.css"})
        self.assertFalse(a["ok"])
        self.assertIn("not public", a["fehler"])

    def test_umleitung_ins_interne_netz_wird_gestoppt(self):
        with Server() as s:
            a = yoink_host.behandeln({"typ": "holen", "url": s.basis + "/umleitung.css"})
        self.assertFalse(a["ok"], a)

    def test_holen_nur_http(self):
        a = yoink_host.behandeln({"typ": "holen", "url": "file:///etc/passwd"})
        self.assertFalse(a["ok"])

    def test_nachladen_schreibt_und_meldet_fehlschlag(self):
        with Server() as s:
            n = nachricht(schriften=["Raleway"])
            n["html"] = f'<style>@font-face{{src:url("fonts/r.woff2")}}</style><div style="background-image: url(&quot;images/weg.png&quot;)"></div>'
            n["css"] = 'x { background: url("images/weg.png"); }'
            n["nachladen"] = [
                {"url": s.basis + "/r.woff2", "ziel": "fonts/r.woff2", "art": "schriften", "familie": "Raleway"},
                {"url": s.basis + "/fehlt.png", "ziel": "images/weg.png", "art": "bilder"},
                {"url": s.basis + "/bg.png", "ziel": "../../boese.png", "art": "bilder"},
            ]
            a = yoink_host.fangen(n, self.ablage, HEUTE)
        anhang = Path(a["notiz"]).parent
        self.assertEqual((anhang / "fonts" / "r.woff2").read_bytes(), b"wOF2raleway")
        self.assertFalse((anhang / "images" / "weg.png").exists())
        html = (anhang / "element.html").read_text()
        self.assertIn(f"url(&quot;{s.basis}/fehlt.png&quot;)", html)  # Verweis zurueck auf die Quelle
        self.assertIn(f'url("{s.basis}/fehlt.png")', (anhang / "rules.css").read_text())
        text = Path(a["notiz"]).read_text()
        self.assertIn("not downloaded", text)
        self.assertIn("File rejected", text)
        alle = [p for p in Path(self.tmp.name).rglob("*") if p.is_file()]
        self.assertFalse([p for p in alle if p.name in ("boese.png", "weg.png")], alle)
        self.assertTrue(all(self.ablage in p.parents for p in alle), alle)

    def test_schrift_nicht_nachladbar_bekommt_ersatz_aus_der_erfassung(self):
        ersatz = "Substitute: Inter or DM Sans (free, Google Fonts; measured by width, x-height and cap height)"
        with Server() as s:
            n = nachricht(schriften=["Cash Sans", "Andere"], schriftErsatz={"Cash Sans": ersatz})
            n["nachladen"] = [
                {"url": s.basis + "/fehlt.woff2", "ziel": "fonts/cash.woff2", "art": "schriften", "familie": "Cash Sans"},
                {"url": s.basis + "/fehlt2.woff2", "ziel": "fonts/andere.woff2", "art": "schriften", "familie": "Andere"},
            ]
            text = Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()
        zeile = [z for z in text.splitlines() if "“Cash Sans” not downloaded" in z]
        self.assertTrue(zeile and zeile[0].endswith(ersatz), text)
        andere = [z for z in text.splitlines() if "“Andere” not downloaded" in z]
        self.assertTrue(andere and "Substitute" not in andere[0], text)  # ohne Angabe kein erfundener Ersatz

    def test_bilder_aus_der_nachricht(self):
        n = nachricht()
        n["bilder"] = [{"datei": "hero.png", "base64": PNG_1PX}, {"datei": "x.exe", "base64": PNG_1PX}]
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"
        self.assertTrue((anhang / "images" / "hero.png").is_file())
        self.assertFalse((anhang / "images" / "x.exe").exists())
        text = Path(a["notiz"]).read_text()
        self.assertIn("[images/](images/) – images", text)


class Medien(unittest.TestCase):
    """Video, Canvas, iframe: Quelle sichern, in der Notiz klar sagen, was der Inhalt ist."""

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "LOKAL_ERLAUBT", yoink_host.LOKAL_ERLAUBT)
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.LOKAL_ERLAUBT = True
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def anhang(self):
        return self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def test_video_wird_nachgeladen_falsche_endung_nicht(self):
        with Server() as s:
            n = nachricht()
            n["html"] = '<video src="videos/clip.mp4" poster="images/still-1.png"></video>'
            n["nachladen"] = [{"url": s.basis + "/clip.mp4", "ziel": "videos/clip.mp4", "art": "videos"},
                              {"url": s.basis + "/clip.mp4", "ziel": "videos/clip.exe", "art": "videos"}]
            a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertEqual((self.anhang() / "videos" / "clip.mp4").read_bytes(), b"mp4-test-video")
        self.assertFalse((self.anhang() / "videos" / "clip.exe").exists())
        text = Path(a["notiz"]).read_text()
        self.assertIn("[videos/](videos/) – video", text)
        self.assertIn("File rejected: `videos/clip.exe`", text)

    def test_inhalt_video_steht_oben(self):
        a = yoink_host.fangen(nachricht(medien=[{"nr": 1, "art": "Video", "anteil": 0.98}]), self.ablage, HEUTE)
        text = Path(a["notiz"]).read_text()
        self.assertIn("> [!warning] The content is a Video, not rebuildable HTML", text)
        self.assertLess(text.index("The content is a Video"), text.index("## Files"))
        self.assertIn("98%", text)

    def test_kleines_medium_ohne_warnung(self):
        # Gegenprobe: ein Video am Rand macht das Element nicht zum Video
        a = yoink_host.fangen(nachricht(medien=[{"nr": 1, "art": "Video", "anteil": 0.1}]), self.ablage, HEUTE)
        self.assertNotIn("[!warning]", Path(a["notiz"]).read_text())

    def test_standbilder_landen_in_bilder(self):
        n = nachricht(medien=[{"nr": 1, "art": "iframe", "anteil": 1}])
        n["bilder"] = [{"datei": "still-1.png", "base64": PNG_1PX}]
        yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue((self.anhang() / "images" / "still-1.png").is_file())


def png_einfarbig(breite, hoehe, rgb):
    return yoink_host.png_bytes(breite, hoehe, bytes(rgb) * (breite * hoehe))


class Render(unittest.TestCase):
    """Render-Vergleich beim Schreiben: element.html headless rendern, gegen image.png legen."""
    HTML = ('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}'
            'body{padding:24px;background:rgb(255,255,255)}</style></head><body>'
            '<div style="width:100px;height:50px;margin:7px 0 0 9px;background:rgb(220,20,60)"></div></body></html>')

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        self.addCleanup(setattr, yoink_host, "CHROME", yoink_host.CHROME)
        yoink_host.RENDERN = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def lauf(self, bild, **meta):
        n = nachricht(breite=100, hoehe=50, **meta)
        n["html"] = self.HTML
        n["bild_png_base64"] = base64.b64encode(bild).decode()
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text(), self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def test_gleiches_bild_kaum_abweichung(self):
        text, anhang = self.lauf(png_einfarbig(100, 50, (220, 20, 60)))
        m = re.search(r"\*\*Render check:\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        self.assertLess(float(m.group(1)), 1.0)
        self.assertFalse((anhang / "vergleich.png").exists())
        self.assertNotIn("differs from the captured image", text)

    def test_doppelte_dichte(self):
        text, _ = self.lauf(png_einfarbig(200, 100, (220, 20, 60)))
        m = re.search(r"\*\*Render check:\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        self.assertLess(float(m.group(1)), 1.0)

    def test_negativkontrolle_anderes_bild_wird_luecke(self):
        text, anhang = self.lauf(png_einfarbig(100, 50, (30, 60, 220)))
        self.assertIn("differs from the captured image by 100.0% in the render", text)
        self.assertTrue((anhang / "comparison.jpg").is_file())
        self.assertFalse((anhang / "vergleich.png").exists())
        self.assertIn("in comparison.jpg", text)
        self.assertNotIn("vergleich.png", text)
        b, h, _ = yoink_host.png_lesen(anhang / "comparison.jpg")
        self.assertEqual((b, h), (3 * 100 + 2 * 16, 50))


    WEBP_ROT = ("UklGRjYCAABXRUJQVlA4WAoAAAAgAAAAYwAAMQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggSAAAAFAEAJ0BKmQAMgA+MRiLRCIhoRCUACADBLSAOwAACs+dOnTp06dOnTp06OAA/vWJH/9CjZRMU///2Gf/7DP/9hn/9gsAAAAAAA==")
    WEBP_BLAU = ("UklGRjoCAABXRUJQVlA4WAoAAAAgAAAAYwAAMQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggTAAAAJAEAJ0BKmQAMgA+MRiLRCIhoRCUACADBLSAOwB+AAAKz506dOnTp06dOnTo4AD++R3b//6XB+lwfpcH/o43//zBK/IN1yAAAAAAAAA=")

    def lauf_webp(self, b64):
        n = nachricht(breite=100, hoehe=50)
        n["html"] = self.HTML
        n["bild_png_base64"] = b64
        n["bild_format"] = "webp"
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text(), self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def test_sollbild_als_webp(self):
        text, anhang = self.lauf_webp(self.WEBP_ROT)
        self.assertTrue((anhang / "image.webp").is_file())
        self.assertFalse((anhang / "image.png").exists())
        self.assertIn("![Captured image](image.webp)", text)
        self.assertIn("against image.webp", text)
        self.assertNotIn("image.png", text)
        m = re.search(r"\*\*Render check:\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        self.assertLess(float(m.group(1)), 1.0)

    def test_webp_negativkontrolle_falsche_farbe(self):
        text, _ = self.lauf_webp(self.WEBP_BLAU)
        self.assertIn("differs from the captured image by 100.0%", text)

    def test_ohne_chrome_meldet_es(self):
        yoink_host.CHROME = "/gibt/es/nicht/Chrome"
        text, _ = self.lauf(png_einfarbig(100, 50, (220, 20, 60)))
        self.assertIn("**Render check:** did not run (Google Chrome not found)", text)

    def test_png_hin_und_zurueck(self):
        with tempfile.TemporaryDirectory() as d:
            pfad = Path(d) / "x.png"
            daten = bytes(range(0, 2 * 3 * 3)) 
            pfad.write_bytes(yoink_host.png_bytes(3, 2, daten))
            self.assertEqual(yoink_host.png_lesen(pfad), (3, 2, [daten[:9], daten[9:]]))


class Ausschnitt(unittest.TestCase):
    """Sollbild zeigt nur einen Teil des Elements (sichtbarer Teil, Bereichsauswahl): verglichen wird
    genau dieser Teil, an seiner Stelle im Element."""
    HTML = ('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}'
            'body{padding:24px;background:rgb(255,255,255)}</style></head><body>'
            '<div style="width:100px;height:200px"><div style="height:100px;background:rgb(220,20,60)"></div>'
            '<div style="height:100px;background:rgb(30,60,220)"></div></div></body></html>')

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def lauf(self, bild, **meta):
        n = nachricht(breite=100, hoehe=200, **meta)
        n["html"] = self.HTML
        n["bild_png_base64"] = base64.b64encode(bild).decode()
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text()

    def anteil(self, text):
        m = re.search(r"\*\*Render check:\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        return float(m.group(1))

    def test_unterer_teil_an_seiner_stelle(self):
        text = self.lauf(png_einfarbig(100, 100, (30, 60, 220)), ausschnitt={"x": 0, "y": 100, "w": 100, "h": 100},
                         luecken=["Bild zeigt nur den sichtbaren Teil des Elements"])
        self.assertLess(self.anteil(text), 1.0)
        self.assertIn("only the 100 × 100 px section at (0, 100)", text)

    def test_doppelte_dichte_im_ausschnitt(self):
        text = self.lauf(png_einfarbig(200, 200, (30, 60, 220)), ausschnitt={"x": 0, "y": 100, "w": 100, "h": 100})
        self.assertLess(self.anteil(text), 1.0)

    def test_negativkontrolle_ohne_ausschnitt_falsche_stelle(self):
        # Gleiches Teilbild ohne Angabe der Stelle: oben liegt Rot, also fast alles anders
        text = self.lauf(png_einfarbig(100, 100, (30, 60, 220)))
        self.assertGreater(self.anteil(text), 90.0)
        self.assertNotIn("only the ", text)


def png_rechtecke(breite, hoehe, rechtecke, grund=(255, 255, 255)):
    """PNG mit farbigen Rechtecken [(x, y, w, h, (r, g, b)), ...] auf einfarbigem Grund."""
    zeilen = [bytearray(bytes(grund) * breite) for _ in range(hoehe)]
    for x, y, w, h, farbe in rechtecke:
        for yy in range(y, y + h):
            zeilen[yy][x * 3:(x + w) * 3] = bytes(farbe) * w
    return yoink_host.png_bytes(breite, hoehe, b"".join(bytes(z) for z in zeilen))


try:
    import numpy  # noqa: F401
    NUMPY = True
except ImportError:
    NUMPY = False


@unittest.skipUnless(NUMPY, "offset search needs numpy (optional)")
class Versatz(unittest.TestCase):
    """Weicht element.html nur durch einen Versatz ab, sagt die Notiz wo und um wie viel."""
    # unregelmaessige Streifen (kein Muster, das bei anderem Versatz auch passt) und ein Block,
    # der an seiner Stelle bleibt
    STREIFEN = [(40, 6), (52, 11), (70, 4), (79, 15), (101, 7), (115, 3), (124, 12), (143, 5), (155, 9), (170, 14)]
    BLOCK = (200, 30, 30, 60)

    def html(self, dx):
        teile = "".join(f'<div style="position:absolute;left:{x + dx}px;top:20px;width:{w}px;height:80px;background:rgb(0,0,0)"></div>'
                        for x, w in self.STREIFEN)
        x, y, w, h = self.BLOCK
        teile += f'<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;background:rgb(0,160,0)"></div>'
        return ('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}'
                'body{padding:24px;background:rgb(255,255,255)}</style></head><body>'
                f'<div style="position:relative;width:240px;height:120px;background:rgb(255,255,255)">{teile}</div></body></html>')

    def soll(self, farbe=(0, 0, 0)):
        x, y, w, h = self.BLOCK
        return png_rechtecke(240, 120, [(sx, 20, sw, 80, farbe) for sx, sw in self.STREIFEN] + [(x, y, w, h, (0, 160, 0))])

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def lauf(self, html, bild, **meta):
        n = nachricht(breite=240, hoehe=120, **meta)
        n["html"] = html
        n["bild_png_base64"] = base64.b64encode(bild).decode()
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text()

    def ohne_versatz(self, text):
        m = re.search(r"without offset ([\d.]+)%", text)
        self.assertTrue(m, text)
        return float(m.group(1))

    def test_streifen_8_px_nach_rechts_wird_benannt_und_luecke(self):
        flaechen = [{"name": "div.streifen", "x": 40, "y": 20, "w": 144, "h": 80},
                    {"name": "div.block", "x": 200, "y": 30, "w": 30, "h": 60}]
        text = self.lauf(self.html(8), self.soll(), flaechen=flaechen)
        self.assertRegex(text, r"\(matches `div\.streifen`\) shifted 8 px to the right")
        self.assertNotIn("div.block", text)
        self.assertNotRegex(text, r"nach unten|nach oben|nach links")
        self.assertLess(self.ohne_versatz(text), 1.0)
        self.assertIn("matches except for an offset", text)
        self.assertNotIn("Versatzsuche nur auf", text)

    def test_kleiner_versatz_unter_der_schwelle_steht_in_der_zeile(self):
        # nur der gruene Block verschoben: wenig Abweichung, trotzdem benannt, keine Luecke
        html = self.html(0).replace("left:200px", "left:203px")
        text = self.lauf(html, self.soll())
        self.assertRegex(text, r"Render check:\*\* [\d.]+% .*shifted 3 px to the right")
        self.assertNotIn("differs from the captured image", text)

    def test_grosser_versatz_40_px_wird_benannt(self):
        # block.xyz: 57 px lagen ausserhalb der alten Suchweite von 24 px
        text = self.lauf(self.html(40), self.soll())
        self.assertRegex(text, r"shifted 40 px to the right")

    def test_begrenzte_suche_steht_in_der_notiz(self):
        self.addCleanup(setattr, yoink_host, "VERSATZ_KACHELN_MAX", yoink_host.VERSATZ_KACHELN_MAX)
        yoink_host.VERSATZ_KACHELN_MAX = 1
        text = self.lauf(self.html(8), self.soll())
        self.assertRegex(text, r"offset search only on the 1 most conspicuous of \d+ tiles")

    def test_negativkontrolle_andere_farbe_ist_kein_versatz(self):
        text = self.lauf(self.html(0), self.soll(farbe=(0, 0, 220)))
        self.assertIn("differs from the captured image by", text)
        self.assertNotIn("verschoben", text)

    def test_versatz_der_nichts_erklaert_wird_nicht_genannt(self):
        # Streifen in anderer Farbe (echte Abweichung) plus ein 1-px-Versatz an einer Kante des
        # Blocks: der Versatz erklaert fast nichts und darf die Notiz nicht fuellen
        html = self.html(0).replace("left:200px", "left:201px")
        text = self.lauf(html, self.soll(farbe=(0, 0, 220)))
        self.assertIn("differs from the captured image by", text)
        self.assertNotIn("verschoben", text)

    def test_negativkontrolle_deckungsgleich_keine_versatzangabe(self):
        text = self.lauf(self.html(0), self.soll())
        self.assertNotIn("verschoben", text)
        self.assertNotIn("offset", text)

class Bewegt(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def notiz(self, n):
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text()

    def test_bewegter_canvas_mit_verweis_aufs_original(self):
        n = nachricht(medien=[{"nr": 1, "art": "Canvas", "anteil": 0.2, "bewegt": True,
                               "selektor": "div.hero > canvas#c", "lage": {"x": 0, "y": 1234}}])
        text = self.notiz(n)
        self.assertIn("> [!info] Moving effect, see the original", text)
        self.assertIn("https://stripe.com/au", text.split("[!info]")[1][:400])
        self.assertIn("`div.hero > canvas#c`", text)
        self.assertIn("1234 px from the top", text)

    def test_stilles_medium_ohne_hinweis(self):
        n = nachricht(medien=[{"nr": 1, "art": "Canvas", "anteil": 0.2, "bewegt": False, "selektor": "canvas#c", "lage": {"x": 0, "y": 5}}])
        self.assertNotIn("Moving effect", self.notiz(n))


class Breiten(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def test_bild_je_breite_und_falsche_breite_abgelehnt(self):
        n = nachricht()
        n["breiten"] = [{"breite": 390, "base64": PNG_1PX, "ausschnitt": {"x": 0, "y": 0, "w": 330, "h": 120}, "hoehe": 120},
                        {"breite": "../x", "base64": PNG_1PX}]
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"
        self.assertTrue((anhang / "image-390.png").is_file())
        self.assertEqual(sorted(x.name for x in anhang.iterdir() if x.name.startswith("image-")), ["image-390.png"])
        text = Path(a["notiz"]).read_text()
        self.assertIn("## Widths", text)
        self.assertIn("(image-390.png)", text)
        self.assertIn("Captured image of the same page in a narrower window", text)  # Gegenprobe: ohne Originalcode bleibt der alte Satz
        self.assertIn("Width rejected", text)

    def test_ohne_breiten_kein_abschnitt(self):
        a = yoink_host.fangen(nachricht(), self.ablage, HEUTE)
        self.assertNotIn("## Widths", Path(a["notiz"]).read_text())


class BreitenHost(unittest.TestCase):
    """Laesst die Seite sich nicht einbetten, rendert der Host die Breiten selbst (Chrome headless)."""

    def setUp(self):
        for name in ("RENDERN", "LOKAL_ERLAUBT"):
            self.addCleanup(setattr, yoink_host, name, getattr(yoink_host, name))
        yoink_host.RENDERN = False
        yoink_host.LOKAL_ERLAUBT = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def lauf(self, **auftrag):
        with Server() as s:
            n = nachricht()
            n["breiten_nachholen"] = {"url": s.basis + "/breiten.html", "dpr": 1, **auftrag}
            a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text(), self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def test_host_rendert_390_und_768(self):
        text, anhang = self.lauf(pfad="body > div:nth-of-type(2) > div", selektor="div#ziel", breiten=[390, 768])
        farben = []
        for b in (390, 768):
            breite, hoehe, zeilen = yoink_host.png_lesen(anhang / f"image-{b}.webp")
            self.assertEqual((breite, hoehe), (b - 60, 120))
            farben.append(tuple(zeilen[60][breite // 2 * 3:breite // 2 * 3 + 3]))
        # WebP rundet Farbwerte um wenige Stufen, die Vergleichsschwelle liegt bei 32
        for ist, soll in zip(farben, [(255, 0, 0), (0, 160, 0)]):
            self.assertTrue(all(abs(a - b) <= 3 for a, b in zip(ist, soll)), farben)
        self.assertIn("(image-390.webp)", text)
        self.assertIn("rendered by the host", text)

    def test_element_nicht_gefunden_wird_luecke(self):
        text, anhang = self.lauf(pfad="body > main", selektor="div#gibtsnicht", breiten=[390])
        self.assertFalse((anhang / "image-390.webp").exists())
        self.assertIn("Width 390 px (host): element not found there", text)

    def test_nur_oeffentliche_adressen(self):
        yoink_host.LOKAL_ERLAUBT = False
        text, anhang = self.lauf(pfad="body", selektor="div#ziel", breiten=[390])
        self.assertFalse((anhang / "image-390.webp").exists())
        self.assertIn("address not public", text)


class Quellen(unittest.TestCase):
    """Originale mitnehmen: srcdoc als source.html, Stylesheets in sources/, Shader in shader/."""
    QUELLE_ROT = ('<!doctype html><html><head><script src="https://cdn.example.org/x.js"></script></head>'
                  '<body style="margin:0;background:rgb(220,20,60)"></body></html>')

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "QUELLE_WARTEN", yoink_host.QUELLE_WARTEN)
        yoink_host.QUELLE_WARTEN = 1.5
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()
        self.anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def lauf(self, n):
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text()

    def srcdoc(self, bild_b64):
        n = nachricht(breite=100, hoehe=50, selektor="div.vorschau > iframe")
        n["bild_png_base64"] = bild_b64
        n["quelltexte"] = [{"datei": "source.html", "quelle": self.QUELLE_ROT, "extern": ["https://cdn.example.org/x.js"],
                            "x": 0, "y": 0, "breite": 100, "hoehe": 50}]
        return n

    def test_srcdoc_als_quelle_html_mit_render_vergleich(self):
        text = self.lauf(self.srcdoc(Render.WEBP_ROT))
        self.assertEqual((self.anhang / "source.html").read_text(encoding="utf-8"), self.QUELLE_ROT)
        m = re.search(r"\*\*Render source\.html:\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        self.assertLess(float(m.group(1)), 1.0)
        self.assertIn("https://cdn.example.org/x.js", text)
        self.assertIn("## Original source", text)

    def test_srcdoc_negativkontrolle_anderes_bild(self):
        text = self.lauf(self.srcdoc(Render.WEBP_BLAU))
        m = re.search(r"\*\*Render source\.html:\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        self.assertGreater(float(m.group(1)), 90.0)

    def test_fremdes_fenster_mit_adresse_und_hinweis(self):
        yoink_host.RENDERN = False
        n = nachricht()
        n["iframe"] = {"art": "fremd", "adresse": "https://andere.example/seite?x=…"}
        text = self.lauf(n)
        self.assertIn("> [!info] The component lives in a frame from another site", text)
        self.assertIn("https://andere.example/seite?x=…", text)
        self.assertFalse((self.anhang / "source.html").exists())

    def test_quellen_und_shader_mit_liste(self):
        yoink_host.RENDERN = False
        n = nachricht()
        n["quellen"] = [{"datei": "haupt.css", "text": "a{color:red}" * 300, "url": "https://x.example/haupt.css", "minifiziert": True},
                        {"datei": "../boese.css", "text": "x", "url": "https://x.example/b.css", "minifiziert": False}]
        n["shader"] = [{"datei": "canvas-1-vertex.glsl", "typ": "vertex", "quelle": "void main(){}"},
                       {"datei": "canvas-1-fragment.glsl", "typ": "fragment", "quelle": "void main(){gl_FragColor=vec4(1);}"}]
        text = self.lauf(n)
        self.assertEqual((self.anhang / "sources" / "haupt.css").read_text(), "a{color:red}" * 300)
        self.assertFalse(any(p.name == "boese.css" for p in Path(self.tmp.name).rglob("*")))
        self.assertRegex(text, r"\[haupt\.css\]\(sources/haupt\.css\) · 3\.5 KB · minified · https://x\.example/haupt\.css")
        self.assertIn("File rejected", text)
        self.assertEqual((self.anhang / "shader" / "canvas-1-fragment.glsl").read_text(), "void main(){gl_FragColor=vec4(1);}")
        self.assertIn("> [!info] Moving effect, shader code included", text)

    def test_ohne_quellen_und_shader_keine_abschnitte(self):
        yoink_host.RENDERN = False
        text = self.lauf(nachricht())
        self.assertNotIn("shader code", text)
        self.assertNotIn("## Originalquellen", text)


class Quelltexte(unittest.TestCase):
    """Mehrere srcdoc-iframes im Fang: je source-N.html, je Render gegen ihren Ausschnitt im Sollbild."""

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "QUELLE_WARTEN", yoink_host.QUELLE_WARTEN)
        yoink_host.QUELLE_WARTEN = 1.5
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def lauf(self, links, rechts):
        # Sollbild 200 x 50: links rot, rechts blau; zwei iframes je 100 x 50
        n = nachricht(breite=200, hoehe=50)
        n["bild_png_base64"] = base64.b64encode(png_rechtecke(200, 50, [(0, 0, 100, 50, (220, 20, 60)), (100, 0, 100, 50, (30, 60, 220))])).decode()
        quelle = lambda f: f'<!doctype html><body style="margin:0;background:rgb{f}"></body>'
        n["quelltexte"] = [{"datei": "source-1.html", "quelle": quelle(links), "extern": [], "x": 0, "y": 0, "breite": 100, "hoehe": 50},
                           {"datei": "source-2.html", "quelle": quelle(rechts), "extern": [], "x": 100, "y": 0, "breite": 100, "hoehe": 50}]
        n["meta"]["medien"] = [{"nr": 1, "art": "iframe", "anteil": 0.5, "quelltext": "source-1.html"},
                               {"nr": 2, "art": "iframe", "anteil": 0.5, "quelltext": "source-2.html"}]
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        self.assertTrue(a["ok"], a)
        return Path(a["notiz"]).read_text()

    def anteile(self, text):
        return [float(m) for m in re.findall(r"\*\*Render source-\d\.html:\*\* ([\d.]+)%", text)]

    def test_je_quelle_gegen_ihren_ausschnitt(self):
        text = self.lauf((220, 20, 60), (30, 60, 220))
        a = self.anteile(text)
        self.assertEqual(len(a), 2, text)
        self.assertTrue(all(x < 1.0 for x in a), a)
        anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"
        self.assertTrue((anhang / "source-1.html").is_file() and (anhang / "source-2.html").is_file())
        self.assertIn("> [!info] The component is included as original code in source-1.html", text)
        self.assertNotIn("kein nachbaubares HTML", text)

    def test_angeschnittenes_iframe_nur_sichtbarer_teil(self):
        # zweites iframe ragt 30 px unter das Sollbild hinaus (Rahmen schneidet es ab)
        n = nachricht(breite=200, hoehe=50)
        n["bild_png_base64"] = base64.b64encode(png_rechtecke(200, 50, [(0, 0, 100, 50, (220, 20, 60)), (100, 0, 100, 50, (30, 60, 220))])).decode()
        n["quelltexte"] = [{"datei": "source.html", "quelle": '<!doctype html><body style="margin:0;background:rgb(30,60,220)"></body>',
                            "extern": [], "x": 100, "y": 0, "breite": 100, "hoehe": 80}]
        a = yoink_host.fangen(n, self.ablage, HEUTE)
        text = Path(a["notiz"]).read_text()
        m = re.search(r"\*\*Render source\.html:\*\* ([\d.]+)% .*visible part only, 100 × 50 px", text)
        self.assertTrue(m, text)
        self.assertLess(float(m.group(1)), 1.0)

    def test_negativkontrolle_vertauscht(self):
        text = self.lauf((30, 60, 220), (220, 20, 60))
        a = self.anteile(text)
        self.assertEqual(len(a), 2, a)  # ohne Zeilen waere all() leer wahr
        self.assertTrue(all(x > 90.0 for x in a), a)
        # dieselbe Schwelle wie bei element.html: als Luecke
        self.assertIn("source-1.html differs from the captured image by", text)

    def test_js_quelle_vom_host_nachgeladen_und_gelistet(self):
        yoink_host.RENDERN = False
        yoink_host.LOKAL_ERLAUBT = True
        self.addCleanup(setattr, yoink_host, "LOKAL_ERLAUBT", False)
        with Server() as s:
            n = nachricht()
            n["nachladen"] = [{"url": s.basis + "/werkzeug.js", "ziel": "sources/werkzeug.js", "art": "quellen"},
                              {"url": s.basis + "/werkzeug.js", "ziel": "sources/boese.exe", "art": "quellen"}]
            text = Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()
        anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"
        self.assertEqual((anhang / "sources" / "werkzeug.js").read_text(), "window.werkzeug = 42;")
        self.assertRegex(text, r"werkzeug\.js\]\(sources/werkzeug\.js\) · 0\.0 KB · readable · http://127\.0\.0\.1:\d+/werkzeug\.js")
        self.assertIn("File rejected: `sources/boese.exe`", text)


class QuelleLokal(unittest.TestCase):
    """Mit E: was source.html nachlaedt, nach source-files/, dazu source-local.html ohne externe
    Verweise, gerendert ohne Netz. source.html bleibt unveraendert, Tracking nie."""

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "QUELLE_WARTEN", yoink_host.QUELLE_WARTEN)
        yoink_host.QUELLE_WARTEN = 1.5
        for name in ("RENDERN", "LOKAL_ERLAUBT"):
            self.addCleanup(setattr, yoink_host, name, getattr(yoink_host, name))
        yoink_host.RENDERN = True
        yoink_host.LOKAL_ERLAUBT = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()
        self.anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def quelle(self, basis):
        return (f'<!doctype html><html><head><script src="{basis}/tw.js"></script>'
                f'<link rel="stylesheet" href="{basis}/schrift.css">'
                '<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script></head>'
                f'<body style="margin:0"><img src="{basis}/bg.png" style="display:none"></body></html>')

    def lauf(self, extras):
        with Server() as s:
            q = self.quelle(s.basis)
            n = nachricht(breite=100, hoehe=50, extras=extras)
            n["bild_png_base64"] = Render.WEBP_BLAU
            n["quelltexte"] = [{"datei": "source.html", "quelle": q, "extern": [], "x": 0, "y": 0, "breite": 100, "hoehe": 50}]
            a = yoink_host.fangen(n, self.ablage, HEUTE)
            self.assertTrue(a["ok"], a)
            return q, Path(a["notiz"]).read_text()

    def test_quelle_lokal_offline_und_unveraendert(self):
        q, text = self.lauf(True)
        self.assertEqual((self.anhang / "source.html").read_text(), q, "source.html verändert")
        lokal = (self.anhang / "source-local.html").read_text()
        # der Shim fuehrt die Original-URLs nur als Suchschluessel; abgerufen wird nichts (siehe Lauf ohne Netz)
        ohne_shim = re.sub(r"<script>/\* yoink: serve.*?</script>", "", lokal, flags=re.S)
        self.assertNotRegex(ohne_shim, r"https?://", "externe URL in source-local.html")
        dateien = sorted(p.name for p in (self.anhang / "source-files").iterdir())
        self.assertEqual(dateien, ["bg.png", "f.woff2", "schrift.css", "tw.js"], dateien)
        self.assertNotRegex((self.anhang / "source-files" / "schrift.css").read_text(), r"url\(/f\.woff2\)")
        self.assertIn("url(f.woff2)", (self.anhang / "source-files" / "schrift.css").read_text())
        self.assertFalse(any("gtag" in p.name or "googletagmanager" in p.name for p in self.anhang.rglob("*")))
        m = re.search(r"\*\*Render source-local\.html \(offline\):\*\* ([\d.]+)%", text)
        self.assertTrue(m, text)
        self.assertLess(float(m.group(1)), 1.0)
        self.assertIn("Tracking", text)

    def test_negativkontrolle_ohne_netz_scheitert_das_original(self):
        # Die Netzsperre muss wirken: source.html laedt tw.js vom (lokalen) Server, ohne Netz bleibt sie weiss
        q, _ = self.lauf(True)
        meta = {"breite": 100, "hoehe": 50, "_bild": "image.webp"}
        r = yoink_host.render_quelle(self.anhang, meta, {"datei": "source.html", "x": 0, "y": 0, "breite": 100, "hoehe": 50}, offline=True)
        self.assertGreater(r["anteil"], 0.9, r)

    def test_gleicher_inhalt_unter_zwei_adressen_eine_datei(self):
        # wie das Tailwind-CDN: /3.4.17 leitet weiter, der Mitschnitt sieht eine zweite Adresse
        self.quelle = lambda b: (f'<!doctype html><html><head><script src="{b}/tw.js"></script>'
                                 f'<script src="{b}/tw.js?neu=1"></script></head><body></body></html>')
        self.lauf(True)
        dateien = sorted(p.name for p in (self.anhang / "source-files").iterdir())
        self.assertEqual(dateien, ["tw.js"], dateien)
        lokal = (self.anhang / "source-local.html").read_text()
        self.assertEqual(lokal.count('src="source-files/tw.js"'), 2, lokal[:400])

    def test_ohne_e_keine_quelle_dateien(self):
        _, text = self.lauf(False)
        self.assertFalse((self.anhang / "source-files").exists())
        self.assertFalse((self.anhang / "source-local.html").exists())

    def test_breiten_aus_quelle(self):
        yoink_host.RENDERN = False
        n = nachricht(breite=100, hoehe=50, extras=True)
        quelle = ('<!doctype html><html><head><style>body{margin:0} #k{height:120px;background:rgb(0,0,255)}'
                  '@media (max-width: 500px) { #k { background: rgb(255,0,0); } }'
                  '@media (min-width: 501px) and (max-width: 900px) { #k { background: rgb(0,160,0); } }'
                  '</style></head><body><div id="k"></div></body></html>')
        n["quelltexte"] = [{"datei": "source.html", "quelle": quelle, "extern": [], "x": 0, "y": 0, "breite": 100, "hoehe": 50}]
        text = Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()
        farben = []
        for b in (390, 768):
            breite, hoehe, zeilen = yoink_host.png_lesen(self.anhang / f"image-{b}.webp")
            self.assertEqual(breite, b)
            farben.append(tuple(zeilen[60][breite // 2 * 3:breite // 2 * 3 + 3]))
        for ist, soll in zip(farben, [(255, 0, 0), (0, 160, 0)]):
            self.assertTrue(all(abs(a - b) <= 3 for a, b in zip(ist, soll)), farben)
        self.assertIn("rendered from source", text)
        self.assertIn("The component from the original code in a narrower window", text)
        self.assertNotIn("Captured image of the same page", text)

    def test_leere_breite_nicht_abgelegt(self):
        # wie WebGL ohne Szene: schwarz. Kein leeres Bild als Breite, stattdessen eine Luecke
        yoink_host.RENDERN = False
        n = nachricht(breite=100, hoehe=50, extras=True)
        n["quelltexte"] = [{"datei": "source.html", "quelle": '<!doctype html><body style="margin:0;background:#000"></body>',
                            "extern": [], "x": 0, "y": 0, "breite": 100, "hoehe": 50}]
        text = Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()
        self.assertFalse((self.anhang / "image-390.webp").exists())
        self.assertIn("Width 390 px from source", text)
        self.assertIn("image blank, not saved", text)


class Hinweise(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def notiz(self, n):
        return Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()

    def test_bewegt_mit_quelle_laeuft_in_quelle(self):
        text = self.notiz(nachricht(medien=[{"nr": 1, "art": "iframe", "anteil": 0.9, "bewegt": True, "quelltext": "source.html",
                                             "selektor": "iframe", "lage": {"x": 0, "y": 10}}]))
        self.assertIn("The animation runs in source.html", text)
        self.assertNotIn("see the original", text)

    def test_bewegt_ohne_quelle_bleibt_original_ansehen(self):
        text = self.notiz(nachricht(medien=[{"nr": 1, "art": "Canvas", "anteil": 0.9, "bewegt": True, "selektor": "canvas", "lage": {"x": 0, "y": 10}}]))
        self.assertIn("Moving effect, see the original", text)

    def test_eingebettetes_skript_heisst_script(self):
        n = nachricht()
        n["quellen"] = [{"datei": "inline-1.js", "text": "var a = 1;", "url": "", "minifiziert": False},
                        {"datei": "inline-1.css", "text": "a{}", "url": "", "minifiziert": False}]
        text = self.notiz(n)
        self.assertIn("[inline-1.js](sources/inline-1.js) · 0.0 KB · readable · inline (<script>)", text)
        self.assertIn("[inline-1.css](sources/inline-1.css) · 0.0 KB · readable · inline (<style>)", text)


class BewegungImCode(unittest.TestCase):
    """Liegt source.html vor, liest yoink die Animation aus dem Code, ohne zweite Aufnahme und ohne E."""

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()

    def notiz(self, quelle):
        n = nachricht()
        n["quelltexte"] = [{"datei": "source.html", "quelle": quelle, "extern": [], "x": 0, "y": 0, "breite": 100, "hoehe": 50}]
        n["meta"]["medien"] = [{"nr": 1, "art": "iframe", "anteil": 0.9, "quelltext": "source.html"}]
        return Path(yoink_host.fangen(n, self.ablage, HEUTE)["notiz"]).read_text()

    def test_keyframes_und_zustaende(self):
        text = self.notiz("<style>@keyframes glimmen { to { opacity: .5 } } @keyframes welle { to { transform: translateY(-2px) } }"
                          ".k { animation: glimmen 2s infinite; } .k span { animation: welle 1s infinite; }"
                          ".k:hover { color: red } .k:focus { outline: 0 } .k:active { transform: scale(.98) }</style>"
                          '<button class="k">Los</button>')
        self.assertIn("> [!info] The animation runs in source.html", text)
        self.assertIn("2 keyframe animations (2 animation declarations)", text)
        self.assertIn("states for active, focus, hover", text)

    def test_tailwind_animate_und_raf(self):
        text = self.notiz('<div class="animate-spin hover:scale-105"></div>'
                          '<script>function schritt(t) { el.style.opacity = t % 2; requestAnimationFrame(schritt); } schritt(0);</script>')
        self.assertIn("> [!info] The animation runs in source.html", text)
        self.assertIn("animate-spin", text)
        self.assertIn("requestAnimationFrame", text)

    def test_ohne_animation_kein_hinweis(self):
        text = self.notiz('<style>.k { color: red; }</style><button class="k">Los</button>')
        self.assertNotIn("animation runs", text)

    def test_transition_ohne_zustandswechsel_zaehlt_nicht(self):
        text = self.notiz('<style>.k { transition: all .3s ease; }</style><button class="k">Los</button>')
        self.assertNotIn("animation runs", text)

    def test_raf_nur_fuers_layout_zaehlt_nicht(self):
        # aura.build, Fang -4: doppeltes requestAnimationFrame zum Zentrieren, keine Schleife
        text = self.notiz('<script>requestAnimationFrame(function() { requestAnimationFrame(function() { zentrieren(); }); });</script>')
        self.assertNotIn("animation runs", text)

    def test_animate_klasse_ohne_definition_zaehlt_nicht(self):
        # aura.build, Fang -4: animate-in ohne Plugin und ohne Regel bewegt nichts
        text = self.notiz('<h1 class="text-4xl animate-in">Titel</h1>')
        self.assertNotIn("animation runs", text)

    def test_eigene_animate_klasse_mit_definition_zaehlt(self):
        text = self.notiz("<script>tailwind.config = { theme: { extend: { animation: { schimmer: 'schimmer 2s linear infinite' } } } }</script>"
                          '<div class="animate-schimmer"></div>')
        self.assertIn("animation runs", text)

    def test_keyframes_ohne_verwendung_zaehlen_nicht(self):
        text = self.notiz('<style>@keyframes unbenutzt { to { opacity: 0 } } .k { color: red }</style><button class="k">Los</button>')
        self.assertNotIn("animation runs", text)


class Mitschnitt(unittest.TestCase):
    """Was source.html zur Laufzeit nachlaedt (fetch einer Szene), wird mitgeschnitten und in
    source-local.html eingebettet. "laeuft ohne Netz" nur ohne gescheiterte Anfrage, ohne Fehler
    in der Konsole und mit nicht leerem Bild."""

    @staticmethod
    def quelle(basis, mit_szene=True):
        # wie UnicornStudio: die Szenen-Adresse traegt bei jedem Laden einen neuen Zeitstempel
        laden = (f"fetch('{basis}/szene.json?v=' + Date.now()).then(function (r) {{ return r.json(); }}).then(starten);"
                 f"fetch('{basis}/umami/x.js').catch(function () {{}});" if mit_szene else "")
        return ('<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head><body>'
                '<canvas id="c" width="200" height="100"></canvas><script>'
                'var x = document.getElementById("c").getContext("2d"), t = 0;'
                'function starten(s) { (function schritt() { x.fillStyle = "#000"; x.fillRect(0, 0, 200, 100);'
                'x.fillStyle = "rgb(" + s.farbe.join(",") + ")"; x.fillRect((t += 4) % 160, 20, 40, 60);'
                'requestAnimationFrame(schritt); })(); }'
                + laden + '</script></body></html>')

    def setUp(self):
        self.addCleanup(setattr, yoink_host, "QUELLE_WARTEN", yoink_host.QUELLE_WARTEN)
        yoink_host.QUELLE_WARTEN = 1.5
        for name in ("RENDERN", "LOKAL_ERLAUBT", "MITSCHNITT"):
            self.addCleanup(setattr, yoink_host, name, getattr(yoink_host, name))
        yoink_host.RENDERN = True
        yoink_host.LOKAL_ERLAUBT = True
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ablage = Path(self.tmp.name) / "ablage"
        self.ablage.mkdir()
        self.anhang = self.ablage / "2026-10-23-stripe-com-create-a-card-issuing-programme"

    def lauf(self, quelle_fn, extras=True):
        with Server() as s:
            n = nachricht(breite=200, hoehe=100, extras=extras)
            n["bild_png_base64"] = Render.WEBP_BLAU
            n["quelltexte"] = [{"datei": "source.html", "quelle": quelle_fn(s.basis), "extern": [], "x": 0, "y": 0, "breite": 200, "hoehe": 100}]
            a = yoink_host.fangen(n, self.ablage, HEUTE)
            self.assertTrue(a["ok"], a)
            return Path(a["notiz"]).read_text()

    def test_szene_mitgeschnitten_laeuft_ohne_netz_und_bewegt_sich(self):
        text = self.lauf(self.quelle)
        self.assertTrue((self.anhang / "source-files" / "szene.json").is_file(), text)
        self.assertFalse(any("umami" in p.name or p.name == "x.js" for p in self.anhang.rglob("*")), "Tracking gesichert")
        self.assertRegex(text, r"source-local\.html runs offline \(0 failed requests, no console errors, image not blank\)")
        self.assertRegex(text, r"source-local\.html moves, [\d.]+% change in 0\.7 s")
        self.assertNotIn("does not run offline", text)

    def test_kleine_bewegung_zaehlt(self):
        # Ruhe-Animation wie beim Button: wenige Pixel aendern sich, trotzdem "moves".
        # Periode 1,7 s, damit kein Aufnahmeabstand zufaellig auf dieselbe Stellung faellt
        klein = lambda b: ('<!doctype html><body style="margin:0;background:#fff"><div id="p" style="position:absolute;left:10px;top:10px;'
                           'width:8px;height:8px;background:#00f"></div><script>var n = 0; setInterval(function () {'
                           'document.getElementById("p").style.left = (10 + (n++ % 17) * 9) + "px"; }, 100);</script></body>')
        text = self.lauf(klein, extras=False)
        self.assertRegex(text, r"source\.html moves, 0\.\d\d% change")

    def test_negativkontrolle_ohne_mitschnitt_schwarz_und_luecke(self):
        yoink_host.MITSCHNITT = False
        text = self.lauf(self.quelle)
        self.assertRegex(text, r"source-local\.html does not run offline: .*request.*failed")
        self.assertIn("image blank", text)
        self.assertNotRegex(text, r"source-local\.html runs offline \(")

    def test_leeres_bild_nie_laeuft_ohne_netz(self):
        text = self.lauf(lambda b: '<!doctype html><body style="margin:0;background:#000"></body>')
        self.assertNotRegex(text, r"runs offline \(")
        self.assertIn("image blank", text)

    def test_spaete_bewegung_mit_dritter_aufnahme(self):
        # WebGL unter Last: das erste neue Bild kommt erst nach den 0,7 s; die dritte Aufnahme sieht es
        spaet = lambda b: ('<!doctype html><body style="margin:0;background:#fff"><div id="p" style="position:absolute;left:10px;top:10px;'
                           'width:40px;height:40px;background:#00f"></div><script>addEventListener("load", function () { setTimeout(function () {'
                           'document.getElementById("p").style.left = "120px"; }, 2900); });</script></body>')
        text = self.lauf(spaet, extras=False)
        self.assertRegex(text, r"source\.html moves, [\d.]+% change in 2\.4 s")

    def test_negativkontrolle_stillstand_bleibt_stillstand(self):
        still = lambda b: ('<!doctype html><body style="margin:0;background:#fff"><div style="position:absolute;left:10px;top:10px;'
                           'width:40px;height:40px;background:#00f"></div></body>')
        text = self.lauf(still, extras=False)
        self.assertIn("source.html is still (no change in 2.4 s)", text)
        self.assertNotIn("moves", text)

    def test_quelle_online_bewegung_auch_ohne_e(self):
        text = self.lauf(self.quelle, extras=False)
        self.assertRegex(text, r"source\.html moves, [\d.]+% change in 0\.7 s")
        self.assertFalse((self.anhang / "source-local.html").exists())


class Schriftzeile(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, yoink_host, "RENDERN", yoink_host.RENDERN)
        yoink_host.RENDERN = False

    def notiz(self, **meta):
        with tempfile.TemporaryDirectory() as t:
            ablage = Path(t) / "ablage"
            ablage.mkdir()
            return Path(yoink_host.fangen(nachricht(**meta), ablage, HEUTE)["notiz"]).read_text()

    def test_weggelassene_schriften_genannt(self):
        text = self.notiz(schriftenWeggelassen=["neueMontreal"])
        self.assertIn("- **Fonts left out:** neueMontreal (no visible text in the element uses them)", text)

    def test_ohne_weggelassene_keine_zeile(self):
        self.assertNotIn("left out", self.notiz())


class Format(unittest.TestCase):
    """README.md: Frontmatter mit title, source, created, tags; nur relative Links."""

    def notiz(self):
        with tempfile.TemporaryDirectory() as t:
            return Path(yoink_host.fangen(nachricht(), t, HEUTE)["notiz"]).read_text()

    def test_frontmatter_felder(self):
        self.assertEqual(frontmatter(self.notiz()), {"title", "source", "created", "tags"})

    def test_negativkontrolle_fehlendes_feld_faellt_auf(self):
        ohne = re.sub(r"\ncreated: [^\n]*", "", self.notiz(), count=1)
        self.assertEqual({"title", "source", "created", "tags"} - frontmatter(ohne), {"created"})

    def test_nur_relative_links(self):
        text = self.notiz()
        ziele = re.findall(r"\]\(([^)]+)\)", text)
        self.assertGreaterEqual(len(ziele), 3, ziele)
        self.assertEqual([z for z in ziele if z.startswith(("/", "file:")) or ".." in z], [])


class Protokoll(unittest.TestCase):
    def rufen(self, obj, env=None):
        daten = json.dumps(obj).encode()
        p = subprocess.run([str(WERKZEUG / "host" / "yoink_host.py")], input=struct.pack("=I", len(daten)) + daten,
                           capture_output=True, env=env, timeout=20)
        n = struct.unpack("=I", p.stdout[:4])[0]
        return json.loads(p.stdout[4:4 + n])

    def test_ping_ueber_stdio(self):
        with tempfile.TemporaryDirectory() as t:
            a = self.rufen({"typ": "ping"}, env={"HOME": t, "PATH": "/usr/bin:/bin"})
            self.assertEqual(a, {"ok": True, "pong": True, "version": yoink_host.VERSION})

    def test_unbekannter_typ(self):
        a = self.rufen({"typ": "loeschen"})
        self.assertFalse(a["ok"])




class Pixelvergleich(unittest.TestCase):
    """zaehle_anders (Standardbibliothek) gegen die schlichte Zaehlung je Pixel."""

    @staticmethod
    def schlicht(a, b):
        return sum(1 for i in range(0, len(a), 3) if any(abs(a[i + k] - b[i + k]) > 32 for k in range(3)))

    def test_gleich_wie_schlicht_auf_zufall(self):
        import random
        r = random.Random(7)
        for n in (1, 5, 1000, 70000):  # 70000 Pixel: mehr als ein Stueck
            a = bytes(r.randrange(256) for _ in range(3 * n))
            b = bytes(min(255, max(0, x + r.choice((-60, -33, -32, 0, 32, 33, 60)))) for x in a)
            self.assertEqual(yoink_host.zaehle_anders(a, b), self.schlicht(a, b), n)

    def test_grenze_32_zaehlt_nicht_33_schon(self):
        # Negativkontrolle an der Schwelle, in beide Richtungen und je Kanal
        basis = bytes([100, 100, 100])
        for k in range(3):
            for d, soll in ((32, 0), (-32, 0), (33, 1), (-33, 1)):
                b = bytearray(basis)
                b[k] += d
                self.assertEqual(yoink_host.zaehle_anders(basis, bytes(b)), soll, (k, d))

    def test_extreme_werte(self):
        self.assertEqual(yoink_host.zaehle_anders(b"\x00\x00\x00\xff\xff\xff", b"\xff\xff\xff\x00\x00\x00"), 2)
        self.assertEqual(yoink_host.zaehle_anders(b"\xff" * 6, b"\xff" * 6), 0)



class Installation(unittest.TestCase):
    """install.sh/uninstall.sh in einem frischen HOME: ohne Adminrechte, klare Meldung, was fehlt,
    und nach uninstall.sh keine Reste ausser dem Ablageordner."""

    PYTHON_CACHE = Path("Library") / "Caches" / "com.apple.python"  # Apples Python, nicht yoink

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve() / "home"
        # wie ein Mac mit Chrome: Chromes Profilordner gibt es schon
        (self.home / "Library" / "Application Support" / "Google" / "Chrome" / "Default").mkdir(parents=True)
        (self.home / "Library" / "Caches").mkdir()
        self.anfang = self.bestand()

    def lauf(self, skript, **env):
        umgebung = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        umgebung.update(env)
        return subprocess.run(["/bin/bash", str(WERKZEUG / skript)], capture_output=True, text=True, env=umgebung, timeout=120)

    def bestand(self):
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*")
                      if self.home / self.PYTHON_CACHE not in p.parents and p != self.home / self.PYTHON_CACHE)

    def ext_id(self):
        key = json.loads((WERKZEUG / "extension" / "manifest.json").read_text())["key"]
        h = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
        return "".join(chr(ord("a") + int(c, 16)) for c in h)

    def test_installieren_registriert_host_mit_fester_id(self):
        r = self.lauf("install.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        ort = self.home / "Library" / "Application Support" / "yoink"
        self.assertTrue((ort / "host" / "yoink_host.py").is_file())
        self.assertTrue((ort / "extension" / "manifest.json").is_file())
        reg = json.loads((self.home / "Library/Application Support/Google/Chrome/NativeMessagingHosts/io.yoink.helper.json").read_text())
        self.assertEqual(reg["name"], "io.yoink.helper")
        self.assertEqual(reg["path"], str(ort / "host" / "yoink_host.py"))
        self.assertTrue(os.access(reg["path"], os.X_OK))
        self.assertEqual(reg["allowed_origins"], [f"chrome-extension://{self.ext_id()}/"])
        self.assertIn(str(ort / "extension"), r.stdout)
        self.assertIn("chrome://extensions", r.stdout)
        # der installierte Host antwortet
        daten = json.dumps({"typ": "ping"}).encode()
        p = subprocess.run([reg["path"]], input=struct.pack("=I", len(daten)) + daten, capture_output=True, timeout=30,
                           env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"})
        self.assertEqual(json.loads(p.stdout[4:])["ok"], True)

    def test_zweimal_installieren_geht(self):
        self.assertEqual(self.lauf("install.sh").returncode, 0)
        r = self.lauf("install.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue((self.home / "Library/Application Support/yoink/host/yoink_host.py").is_file())

    def test_ohne_chrome_klare_meldung_und_nichts_geschrieben(self):
        r = self.lauf("install.sh", YOINK_CHROME_DIRS=str(self.home / "keine-apps"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Google Chrome", r.stdout + r.stderr)
        self.assertEqual(self.bestand(), self.anfang)

    def test_ohne_command_line_tools_klare_meldung(self):
        r = self.lauf("install.sh", YOINK_XCODE_SELECT="/usr/bin/false")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("xcode-select --install", r.stdout + r.stderr)
        self.assertEqual(self.bestand(), self.anfang)

    def test_ohne_python_klare_meldung(self):
        r = self.lauf("install.sh", YOINK_PYTHON=str(self.home / "kein-python3"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("python3", r.stdout + r.stderr)
        self.assertEqual(self.bestand(), self.anfang)

    def test_deinstallieren_ohne_reste_ablage_bleibt(self):
        ablage = self.home / "Documents" / "yoink"
        ablage.mkdir(parents=True)
        (ablage / "fang.md").write_text("bleibt")
        vorher = self.bestand()
        self.assertEqual(self.lauf("install.sh").returncode, 0)
        self.assertNotEqual(self.bestand(), vorher)  # Gegenprobe: die Installation hat etwas angelegt
        r = self.lauf("uninstall.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.bestand(), vorher)
        self.assertEqual((ablage / "fang.md").read_text(), "bleibt")
        self.assertIn("chrome://extensions", r.stdout)

    def test_deinstallieren_aus_dem_installierten_ordner(self):
        # nach dem Loeschen des Zips: uninstall.sh liegt im installierten Ordner und raeumt ihn selbst weg
        self.assertEqual(self.lauf("install.sh").returncode, 0)
        installiert = self.home / "Library/Application Support/yoink/uninstall.sh"
        self.assertTrue(installiert.is_file())
        r = subprocess.run(["/bin/bash", str(installiert)], capture_output=True, text=True, timeout=60,
                           env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.bestand(), self.anfang)


if __name__ == "__main__":
    unittest.main()
