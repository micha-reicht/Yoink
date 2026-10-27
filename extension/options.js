// Optionsseite von yoink: Ablageordner anzeigen, eintippen oder per Dialog waehlen. Gespeichert wird
// erst, wenn der Host den Ordner geprueft hat (vorhanden, beschreibbar).
const feld = document.getElementById('ordner');
const status = document.getElementById('status');

function zeigen(text, art = '') {
  status.textContent = text;
  status.className = art;
}

async function laden() {
  const { ordner } = await chrome.storage.local.get('ordner');
  feld.value = ordner || '';
  zeigen(ordner ? `Catches are saved to ${ordner}` : 'No save folder yet. Choose one, or yoink will ask on the first catch.');
}

document.getElementById('speichern').addEventListener('click', async () => {
  const wert = feld.value.trim();
  if (!wert) {
    await chrome.storage.local.remove('ordner');
    zeigen('Save folder removed. yoink will ask on the next catch.');
    return;
  }
  zeigen('Checking …');
  const a = await chrome.runtime.sendMessage({ typ: 'optionen_pruefen', ordner: wert });
  if (a && a.ok) {
    await chrome.storage.local.set({ ordner: a.ordner });
    feld.value = a.ordner;
    zeigen(`Saved. Catches go to ${a.ordner}`, 'ok');
  } else {
    zeigen((a && a.fehler) || 'Could not check the folder.', 'fehler');
  }
});

document.getElementById('waehlen').addEventListener('click', async () => {
  zeigen('A folder dialog opened – it may be behind this window.');
  const a = await chrome.runtime.sendMessage({ typ: 'optionen_waehlen' });
  if (a && a.ok) {
    feld.value = a.ordner;
    zeigen(`Saved. Catches go to ${a.ordner}`, 'ok');
  } else {
    zeigen((a && a.fehler) || 'No folder chosen.', a && a.abgebrochen ? '' : 'fehler');
  }
});

laden();
