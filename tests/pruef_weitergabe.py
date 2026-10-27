#!/usr/bin/python3
"""Prueft einen Ordner (den Zip-Inhalt) vor der Weitergabe: keine Mailadressen (egal welche Domain,
der Local-Part kann ein Name sein), keine Benutzerpfade, keine internen Namen und Werkzeuge, keine
Testfaenge. Meldet den Nenner (Dateien, Zeilen, Pruefungen) und jeden Fund mit Datei und Zeile.

    pruef_weitergabe.py <ordner>          Exit 0 ohne Fund, 1 mit Fund
    pruef_weitergabe.py --selftest        Negativkontrolle: erfundener Name im Local-Part und /Users/<name>
"""
import re
import shutil
import sys
import tempfile
from pathlib import Path

MAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
BENUTZERPFAD = re.compile(r"/(?:Users|home)/(?!you\b|<)[A-Za-z0-9._-]+")
# Interne Namen, Werkzeuge und Ablageorte, die nie ins Zip duerfen: ein regulaerer Ausdruck je Zeile
# in tests/intern-woerter.txt. Die Datei bleibt lokal (.gitignore), damit die Liste selbst nicht im
# Repo steht. Ohne Datei gilt nur der allgemeine Teil.
_LISTE = Path(__file__).resolve().parent / "intern-woerter.txt"
_EIGENE = [z.strip() for z in _LISTE.read_text(encoding="utf-8").splitlines()
           if z.strip() and not z.startswith("#")] if _LISTE.exists() else []
WERKZEUGE = "|".join([r"scratchpad", r"\.claude/"] + _EIGENE)


def eigene_namen():
    """Namen dessen, der baut: Benutzerkonto, voller Name des Kontos, git-Name. Zur Laufzeit gelesen,
    damit kein Name im Code steht. Teile unter 4 Zeichen fallen weg (zu viele Zufallstreffer)."""
    import getpass
    import subprocess
    def lauf(befehl):
        try:
            return subprocess.run(befehl, capture_output=True, text=True, timeout=5).stdout.strip()
        except OSError:
            return ""
    # Konto und voller Name werden zerlegt (Vor- und Nachname einzeln). Der git-Name bleibt ganz: er ist
    # oft ein Handle wie "vorname-wort", dessen Teile gewoehnliche Woerter sein koennen.
    roh = [getpass.getuser(), lauf(["/usr/bin/id", "-F"])]
    teile = {w.lower() for r in roh for w in re.split(r"[^A-Za-zÄÖÜäöüß]+", r or "") if len(w) >= 4}
    git_name = lauf(["/usr/bin/git", "config", "user.name"]).lower()
    if len(git_name) >= 4:
        teile.add(git_name)
    teile |= {w.replace("ü", "ue").replace("ö", "oe").replace("ä", "ae") for w in teile}
    return sorted(teile)


INTERN = re.compile("|".join([WERKZEUGE] + [re.escape(n) for n in eigene_namen()]), re.I)
TESTSEITEN = re.compile(r"tagesschau|pinterest|youtube|aura\.build|unicorn|stripe\.com|block\.xyz|refero|hms-pv", re.I)
# Dateien, die nur ein Fang hat: ein Testfang im Zip waere echter Fremdinhalt
FANGDATEIEN = re.compile(r"^(image(-\d+)?\.(webp|png)|comparison\.jpg|source(-local|-\d+)?\.html|element\.html|rules\.css)$")
ERLAUBT_MAIL = set()
# PNG (Icons): nur Bild-Abschnitte. Text, EXIF und Zeitstempel koennen Namen und Pfade tragen.
PNG_SIGNATUR = b"\x89PNG\r\n\x1a\n"
PNG_BILD = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"sRGB", b"gAMA", b"cHRM", b"pHYs", b"sBIT", b"bKGD"}


def png_abschnitte(daten):
    """Abschnitts-Typen eines PNG, oder None, wenn es keins ist oder es abgeschnitten ist."""
    if not daten.startswith(PNG_SIGNATUR):
        return None
    typen, pos = [], len(PNG_SIGNATUR)
    while pos + 8 <= len(daten):
        laenge = int.from_bytes(daten[pos:pos + 4], "big")
        typen.append(daten[pos + 4:pos + 8])
        pos += 12 + laenge
    return typen if pos == len(daten) and typen[-1:] == [b"IEND"] else None


def pruefen(ordner):
    ordner = Path(ordner)
    funde, dateien, zeilen = [], 0, 0
    for p in sorted(ordner.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(ordner)
        dateien += 1
        if FANGDATEIEN.match(p.name) or (p.name == "README.md" and len(rel.parts) > 2):
            funde.append((str(rel), 0, "Fang-Datei", p.name))
        if p.suffix.lower() == ".png":
            typen = png_abschnitte(p.read_bytes())
            if typen is None:
                funde.append((str(rel), 0, "Binaerdatei", "kein vollstaendiges PNG"))
            for t in sorted({t for t in typen or [] if t not in PNG_BILD}):
                funde.append((str(rel), 0, "PNG-Metadaten", t.decode("latin-1")))
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            funde.append((str(rel), 0, "Binaerdatei", "nicht pruefbar"))
            continue
        for nr, z in enumerate(text.splitlines(), 1):
            zeilen += 1
            for m in MAIL.finditer(z):
                if m.group(0).lower() not in ERLAUBT_MAIL:
                    lokal = m.group(0).split("@")[0]
                    art = "Mailadresse (Local-Part sieht nach Name aus)" if re.fullmatch(r"[A-Za-z]+[._-][A-Za-z]+", lokal) else "Mailadresse"
                    funde.append((str(rel), nr, art, m.group(0)))
            for m in BENUTZERPFAD.finditer(z):
                funde.append((str(rel), nr, "Benutzerpfad", m.group(0)))
            for m in INTERN.finditer(z):
                funde.append((str(rel), nr, "interner Name", m.group(0)))
            for m in TESTSEITEN.finditer(z):
                funde.append((str(rel), nr, "Testseite", m.group(0)))
    return funde, dateien, zeilen


def melden(funde, dateien, zeilen):
    print(f"geprueft: {dateien} Dateien, {zeilen} Zeilen, 6 Pruefungen (Mail, Benutzerpfad, interne Namen, Testseiten, Fang-Dateien, PNG-Metadaten)")
    for f in funde:
        print(f"  FUND {f[0]}:{f[1]} – {f[2]}: {f[3]}")
    print(f"Funde: {len(funde)}")


def selbsttest():
    """Negativkontrolle, die genau die gesuchte Eigenschaft verletzt: ein erfundener Personenname im
    Local-Part einer Mailadresse mit erfundener Domain und ein /Users/<name>-Pfad. Beide muessen
    gefunden werden; ohne den Einbau darf die Kopie nichts melden."""
    quelle = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as t:
        kopie = Path(t) / "inhalt"
        kopie.mkdir()
        for name in ("README.md", "install.sh", "uninstall.sh"):
            shutil.copy(quelle / name, kopie / name)
        shutil.copytree(quelle / "extension", kopie / "extension")
        (kopie / "host").mkdir()
        shutil.copy(quelle / "host" / "yoink_host.py", kopie / "host" / "yoink_host.py")
        sauber, _, _ = pruefen(kopie)
        assert sauber == [], f"Ausgangsstand nicht sauber: {sauber}"
        with open(kopie / "extension" / "options.js", "a", encoding="utf-8") as f:
            f.write("\n// Rueckfragen an jana.vogelsang@brightwave-studio.example\n// Vorlage: /Users/jvogelsang/Desktop/yoink\n")
        funde, _, _ = pruefen(kopie)
        werte = {(f[2], f[3]) for f in funde}
        assert ("Mailadresse (Local-Part sieht nach Name aus)", "jana.vogelsang@brightwave-studio.example") in werte, funde
        assert ("Benutzerpfad", "/Users/jvogelsang") in werte, funde
        assert len(funde) == 2, funde
        # PNG mit Text-Abschnitt (wie ihn Bildprogramme mit Autor oder Quellpfad schreiben): muss auffallen
        icon = kopie / "extension" / "icons" / "icon-16.png"
        if icon.exists():
            roh = icon.read_bytes()
            text = b"Comment\x00/Users/jvogelsang/Desktop/logo.png"
            chunk = len(text).to_bytes(4, "big") + b"tEXt" + text + b"\x00\x00\x00\x00"
            icon.write_bytes(roh[:-12] + chunk + roh[-12:])
            assert ("PNG-Metadaten", "tEXt") in {(f[2], f[3]) for f in pruefen(kopie)[0]}
        # eigener Name: zur Laufzeit gelesen, muss ebenso gefunden werden
        name = next(iter(eigene_namen()), None)
        if name:
            (kopie / "notiz.txt").write_text(f"von {name.title()}\n", encoding="utf-8")
            assert any(f[2] == "interner Name" and f[3].lower() == name for f in pruefen(kopie)[0]), name
    print("selbsttest ok: 4 von 4 eingebauten Funden erkannt (Name im Local-Part, /Users/<name>, PNG-Textabschnitt, eigener Name), Ausgangsstand 0 Funde")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selbsttest()
        sys.exit(0)
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    f, d, z = pruefen(sys.argv[1])
    melden(f, d, z)
    sys.exit(1 if f else 0)
