import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  deleteDoc,
  doc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const cloudDb = getFirestore(firebaseApp);

const cloudEntriesRef = collection(cloudDb, "entries");
const cloudArchiveRef = collection(cloudDb, "archive");
const cloudSpeditionsRef = collection(cloudDb, "speditions");
const cloudErfasserRef = collection(cloudDb, "erfasser");

let localDb;
let chart = null;
let editingId = null;

const dbReq = indexedDB.open("PalettenDB_PRO_FIREBASE", 4);

dbReq.onupgradeneeded = (e) => {
  localDb = e.target.result;

  if (!localDb.objectStoreNames.contains("entries")) {
    localDb.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
  }
  if (!localDb.objectStoreNames.contains("archive")) {
    localDb.createObjectStore("archive", { keyPath: "id", autoIncrement: true });
  }
  if (!localDb.objectStoreNames.contains("speditions")) {
    localDb.createObjectStore("speditions", { keyPath: "id", autoIncrement: true });
  }
  if (!localDb.objectStoreNames.contains("erfasser")) {
    localDb.createObjectStore("erfasser", { keyPath: "id", autoIncrement: true });
  }
};

dbReq.onsuccess = async (e) => {
  localDb = e.target.result;
  setSyncStatus("Lokale Datenbank bereit.");
  await initialCloudSync();
  await renderMasterData();
  await renderAll();
  subscribeToCloud();
};

dbReq.onerror = () => {
  setSyncStatus("Fehler bei lokaler Datenbank.");
};

function setSyncStatus(text) {
  const el = document.getElementById("syncStatus");
  if (el) el.textContent = text;
}

function setImportStatus(text) {
  const el = document.getElementById("importStatus");
  if (el) el.textContent = text;
}

function txPromise(storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = localDb.transaction(storeNames, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllLocal(storeName) {
  return txPromise([storeName], "readonly", (tx) =>
    requestToPromise(tx.objectStore(storeName).getAll())
  );
}

async function clearLocal(storeName) {
  return txPromise([storeName], "readwrite", (tx) =>
    tx.objectStore(storeName).clear()
  );
}

async function addLocal(storeName, data) {
  return txPromise([storeName], "readwrite", (tx) =>
    tx.objectStore(storeName).add(data)
  );
}

async function putLocal(storeName, data) {
  return txPromise([storeName], "readwrite", (tx) =>
    tx.objectStore(storeName).put(data)
  );
}

async function deleteLocal(storeName, id) {
  return txPromise([storeName], "readwrite", (tx) =>
    tx.objectStore(storeName).delete(id)
  );
}

async function getLocalById(storeName, id) {
  return txPromise([storeName], "readonly", (tx) =>
    requestToPromise(tx.objectStore(storeName).get(id))
  );
}

function normalizeCloudDoc(id, data) {
  return {
    cloudId: id,
    name: data.name || "",
    datum: data.datum || "",
    spedition: data.spedition || "",
    erhalten: Number(data.erhalten || 0),
    abgegeben: Number(data.abgegeben || 0),
    erfasser: data.erfasser || "",
    lieferschein: data.lieferschein || "",
    notizen: data.notizen || "",
    createdAt: data.createdAt || Date.now()
  };
}

async function replaceLocalStore(storeName, items) {
  await clearLocal(storeName);
  for (const item of items) {
    await addLocal(storeName, item);
  }
}

async function initialCloudSync() {
  if (!navigator.onLine) {
    setSyncStatus("Offline-Modus: lokale Daten aktiv.");
    return;
  }

  try {
    const [entriesSnap, archiveSnap, speditionsSnap, erfasserSnap] = await Promise.all([
      getDocs(query(cloudEntriesRef, orderBy("datum"))),
      getDocs(query(cloudArchiveRef, orderBy("datum"))),
      getDocs(cloudSpeditionsRef),
      getDocs(cloudErfasserRef)
    ]);

    await replaceLocalStore("entries", entriesSnap.docs.map(d => normalizeCloudDoc(d.id, d.data())));
    await replaceLocalStore("archive", archiveSnap.docs.map(d => normalizeCloudDoc(d.id, d.data())));
    await replaceLocalStore("speditions", speditionsSnap.docs.map(d => normalizeCloudDoc(d.id, d.data())));
    await replaceLocalStore("erfasser", erfasserSnap.docs.map(d => normalizeCloudDoc(d.id, d.data())));

    setSyncStatus("Cloud-Sync erfolgreich.");
  } catch (err) {
    console.error(err);
    setSyncStatus("Cloud-Sync fehlgeschlagen. Lokale Daten werden verwendet.");
  }
}

function subscribeToCloud() {
  if (!navigator.onLine) return;

  onSnapshot(query(cloudEntriesRef, orderBy("datum")), async (snap) => {
    const current = snap.docs.map(d => normalizeCloudDoc(d.id, d.data()));
    await replaceLocalStore("entries", current);
    await renderAll();
  });

  onSnapshot(query(cloudArchiveRef, orderBy("datum")), async (snap) => {
    const current = snap.docs.map(d => normalizeCloudDoc(d.id, d.data()));
    await replaceLocalStore("archive", current);
    await renderAll();
  });

  onSnapshot(cloudSpeditionsRef, async (snap) => {
    const current = snap.docs.map(d => normalizeCloudDoc(d.id, d.data()));
    await replaceLocalStore("speditions", current);
    await renderMasterData();
  });

  onSnapshot(cloudErfasserRef, async (snap) => {
    const current = snap.docs.map(d => normalizeCloudDoc(d.id, d.data()));
    await replaceLocalStore("erfasser", current);
    await renderMasterData();
  });
}

async function renderMasterData() {
  const speditions = await getAllLocal("speditions");
  const erfasser = await getAllLocal("erfasser");

  const speditionSelect = document.getElementById("spedition");
  const currentSpedition = speditionSelect.value;
  speditionSelect.innerHTML = '<option value="">Bitte wählen</option>';

  speditions
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((s) => {
      const option = document.createElement("option");
      option.value = s.name;
      option.textContent = s.name;
      speditionSelect.appendChild(option);
    });

  if ([...speditionSelect.options].some(o => o.value === currentSpedition)) {
    speditionSelect.value = currentSpedition;
  }

  const erfasserSelect = document.getElementById("erfasser");
  const currentErfasser = erfasserSelect.value;
  erfasserSelect.innerHTML = '<option value="">Bitte wählen</option>';

  erfasser
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((e) => {
      const option = document.createElement("option");
      option.value = e.name;
      option.textContent = e.name;
      erfasserSelect.appendChild(option);
    });

  if ([...erfasserSelect.options].some(o => o.value === currentErfasser)) {
    erfasserSelect.value = currentErfasser;
  }

  const speditionsList = document.getElementById("speditionsList");
  speditionsList.innerHTML = "";
  speditions.forEach((s) => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    li.textContent = s.name;

    const btn = document.createElement("button");
    btn.className = "btn btn-sm btn-danger";
    btn.textContent = "Löschen";
    btn.onclick = () => deleteMasterData("speditions", s.id, s.cloudId);

    li.appendChild(btn);
    speditionsList.appendChild(li);
  });

  const erfasserList = document.getElementById("erfasserList");
  erfasserList.innerHTML = "";
  erfasser.forEach((e) => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    li.textContent = e.name;

    const btn = document.createElement("button");
    btn.className = "btn btn-sm btn-danger";
    btn.textContent = "Löschen";
    btn.onclick = () => deleteMasterData("erfasser", e.id, e.cloudId);

    li.appendChild(btn);
    erfasserList.appendChild(li);
  });
}

async function addMasterData(type, name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  const existing = await getAllLocal(type);
  const exists = existing.some(x => x.name.toLowerCase() === trimmed.toLowerCase());
  if (exists) return;

  const localItem = {
    name: trimmed,
    createdAt: Date.now()
  };

  await addLocal(type, localItem);
  await renderMasterData();

  if (!navigator.onLine) {
    setSyncStatus(`${type} lokal gespeichert (offline).`);
    return;
  }

  try {
    const ref = type === "speditions" ? cloudSpeditionsRef : cloudErfasserRef;
    await addDoc(ref, {
      name: trimmed,
      createdAt: Date.now()
    });
    setSyncStatus(`${type} synchronisiert.`);
  } catch (err) {
    console.error(err);
    setSyncStatus(`${type} lokal gespeichert, Cloud-Sync fehlgeschlagen.`);
  }
}

async function deleteMasterData(type, localId, cloudId) {
  await deleteLocal(type, localId);
  await renderMasterData();

  if (!navigator.onLine || !cloudId) {
    setSyncStatus(`${type} lokal gelöscht.`);
    return;
  }

  try {
    await deleteDoc(doc(cloudDb, type, cloudId));
    setSyncStatus(`${type} synchronisiert gelöscht.`);
  } catch (err) {
    console.error(err);
    setSyncStatus(`${type} lokal gelöscht, Cloud-Löschung fehlgeschlagen.`);
  }
}

async function addEntry(entry) {
  if (!navigator.onLine) {
    await addLocal("entries", {
      ...entry,
      createdAt: Date.now()
    });
    await renderAll();
    setSyncStatus("Eintrag lokal gespeichert (offline).");
    return;
  }

  try {
    await addDoc(cloudEntriesRef, {
      ...entry,
      createdAt: Date.now()
    });
    setSyncStatus("Eintrag in Cloud gespeichert.");
  } catch (err) {
    console.error(err);
    await addLocal("entries", {
      ...entry,
      createdAt: Date.now()
    });
    await renderAll();
    setSyncStatus("Cloud fehlgeschlagen, Eintrag lokal gespeichert.");
  }
}

async function updateEntry(localId, updatedEntry) {
  const localEntry = await getLocalById("entries", localId);
  if (!localEntry) return;

  const merged = {
    ...localEntry,
    ...updatedEntry
  };

  await putLocal("entries", merged);
  await renderAll();

  if (!navigator.onLine || !localEntry.cloudId) {
    setSyncStatus("Änderung lokal gespeichert.");
    return;
  }

  try {
    await updateDoc(doc(cloudDb, "entries", localEntry.cloudId), {
      datum: merged.datum,
      spedition: merged.spedition,
      erhalten: merged.erhalten,
      abgegeben: merged.abgegeben,
      erfasser: merged.erfasser,
      lieferschein: merged.lieferschein,
      notizen: merged.notizen
    });
    setSyncStatus("Eintrag aktualisiert.");
  } catch (err) {
    console.error(err);
    setSyncStatus("Lokal aktualisiert, Cloud-Update fehlgeschlagen.");
  }
}

async function startEditEntry(localId) {
  const entry = await getLocalById("entries", localId);
  if (!entry) return;

  editingId = localId;

  document.getElementById("datum").value = entry.datum || "";
  document.getElementById("spedition").value = entry.spedition || "";
  document.getElementById("erhalten").value = entry.erhalten ?? 0;
  document.getElementById("abgegeben").value = entry.abgegeben ?? 0;
  document.getElementById("erfasser").value = entry.erfasser || "";
  document.getElementById("lieferschein").value = entry.lieferschein || "";
  document.getElementById("notizen").value = entry.notizen || "";

  document.getElementById("saveBtn").textContent = "Änderungen speichern";
  document.getElementById("cancelEditBtn").style.display = "inline-block";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetFormState() {
  editingId = null;
  document.getElementById("entryForm").reset();
  document.getElementById("saveBtn").textContent = "Speichern";
  document.getElementById("cancelEditBtn").style.display = "none";
}

async function deleteEntry(localId) {
  const localEntry = await getLocalById("entries", localId);
  if (!localEntry) return;

  await addLocal("archive", {
    datum: localEntry.datum,
    spedition: localEntry.spedition,
    erhalten: localEntry.erhalten,
    abgegeben: localEntry.abgegeben,
    erfasser: localEntry.erfasser,
    lieferschein: localEntry.lieferschein,
    notizen: localEntry.notizen,
    createdAt: localEntry.createdAt || Date.now()
  });

  await deleteLocal("entries", localId);
  await renderAll();

  if (!navigator.onLine || !localEntry.cloudId) {
    setSyncStatus("Eintrag lokal archiviert.");
    return;
  }

  try {
    await addDoc(cloudArchiveRef, {
      datum: localEntry.datum,
      spedition: localEntry.spedition,
      erhalten: localEntry.erhalten,
      abgegeben: localEntry.abgegeben,
      erfasser: localEntry.erfasser,
      lieferschein: localEntry.lieferschein,
      notizen: localEntry.notizen,
      createdAt: localEntry.createdAt || Date.now()
    });

    await deleteDoc(doc(cloudDb, "entries", localEntry.cloudId));
    setSyncStatus("Eintrag archiviert.");
  } catch (err) {
    console.error(err);
    setSyncStatus("Lokal archiviert, Cloud-Aktivität fehlgeschlagen.");
  }
}

async function clearCurrentEntriesOnly() {
  const allEntries = await getAllLocal("entries");

  for (const entry of allEntries) {
    await addLocal("archive", {
      datum: entry.datum,
      spedition: entry.spedition,
      erhalten: entry.erhalten,
      abgegeben: entry.abgegeben,
      erfasser: entry.erfasser,
      lieferschein: entry.lieferschein,
      notizen: entry.notizen,
      createdAt: entry.createdAt || Date.now()
    });
  }

  await clearLocal("entries");
  await renderAll();

  if (!navigator.onLine) {
    setSyncStatus("Aktuelle Daten lokal archiviert.");
    return;
  }

  for (const entry of allEntries) {
    try {
      await addDoc(cloudArchiveRef, {
        datum: entry.datum,
        spedition: entry.spedition,
        erhalten: entry.erhalten,
        abgegeben: entry.abgegeben,
        erfasser: entry.erfasser,
        lieferschein: entry.lieferschein,
        notizen: entry.notizen,
        createdAt: entry.createdAt || Date.now()
      });

      if (entry.cloudId) {
        await deleteDoc(doc(cloudDb, "entries", entry.cloudId));
      }
    } catch (err) {
      console.error(err);
    }
  }

  setSyncStatus("Aktuelle Daten archiviert.");
}

async function renderAll() {
  await loadEntries();
  await updateStand();
  await updateChart();
}

async function loadEntries() {
  const filter = document.getElementById("filterSpedition").value.toLowerCase();
  const entries = await getAllLocal("entries");
  const tbody = document.querySelector("#entriesTable tbody");
  tbody.innerHTML = "";

  entries
    .sort((a, b) => a.datum.localeCompare(b.datum))
    .forEach((e) => {
      if (filter && !e.spedition.toLowerCase().includes(filter)) return;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${e.datum}</td>
        <td>${e.spedition}</td>
        <td>${e.lieferschein || ""}</td>
        <td>${e.erhalten}</td>
        <td>${e.abgegeben}</td>
        <td>${e.erfasser || ""}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm btn-primary">Bearbeiten</button>
            <button class="btn btn-sm btn-danger">Löschen</button>
          </div>
        </td>
      `;

      const buttons = tr.querySelectorAll("button");
      buttons[0].addEventListener("click", () => startEditEntry(e.id));
      buttons[1].addEventListener("click", () => deleteEntry(e.id));

      tbody.appendChild(tr);
    });
}

async function updateStand() {
  const entries = await getAllLocal("entries");
  const stand = {};

  entries.forEach((e) => {
    if (!stand[e.spedition]) stand[e.spedition] = 0;
    stand[e.spedition] += Number(e.erhalten) - Number(e.abgegeben);
  });

  const tbody = document.querySelector("#standTable tbody");
  tbody.innerHTML = "";

  Object.keys(stand).sort().forEach((spedition) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${spedition}</td><td>${stand[spedition]}</td>`;
    tbody.appendChild(tr);
  });
}

async function calculateTimeline() {
  const date = document.getElementById("timelineDate").value;
  if (!date) return;

  const entries = await getAllLocal("entries");
  const archive = await getAllLocal("archive");
  const all = [...entries, ...archive];
  const result = {};

  all.forEach((e) => {
    if (e.datum <= date) {
      if (!result[e.spedition]) result[e.spedition] = 0;
      result[e.spedition] += Number(e.erhalten) - Number(e.abgegeben);
    }
  });

  const tbody = document.querySelector("#timelineTable tbody");
  tbody.innerHTML = "";

  Object.keys(result).sort().forEach((spedition) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${spedition}</td><td>${result[spedition]}</td>`;
    tbody.appendChild(tr);
  });
}

async function updateChart() {
  const entries = await getAllLocal("entries");
  const data = entries.sort((a, b) => a.datum.localeCompare(b.datum));

  let sum = 0;
  const labels = [];
  const values = [];

  data.forEach((e) => {
    sum += Number(e.erhalten) - Number(e.abgegeben);
    labels.push(e.datum);
    values.push(sum);
  });

  if (chart) chart.destroy();

  chart = new Chart(document.getElementById("chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Palettenbestand",
          data: values
        }
      ]
    }
  });
}

// ---------- CSV Import ----------

function parseCSV(text) {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return [];

  const lines = cleaned.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const delimiter = lines[0].includes('";"') || lines[0].split(";").length > lines[0].split(",").length
    ? ";"
    : ",";

  function splitCsvLine(line, delimiterChar) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiterChar && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    result.push(current.trim());

    return result.map(value =>
      value.replace(/^"(.*)"$/, "$1").trim()
    );
  }

  const headers = splitCsvLine(lines[0], delimiter).map(h => h.replace(/^\uFEFF/, "").trim());

  return lines.slice(1).map(line => {
    const values = splitCsvLine(line, delimiter);
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = values[index] ?? "";
    });

    return obj;
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}
function normalizeDate(value) {
  const raw = (value || "").trim();
  if (!raw) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  return raw;
}
async function importSpeditionsCSV(file) {
  const text = await readFileAsText(file);
  const rows = parseCSV(text);

  const existing = await getAllLocal("speditions");
  const existingNames = new Set(existing.map(x => (x.name || "").toLowerCase()));

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const rawName =
      row.name ||
      row.Name ||
      row.spedition ||
      row.Spedition ||
      row.Speditionen ||
      row.speditionen ||
      "";

    const name = rawName.trim();

    if (!name) {
      skipped++;
      continue;
    }

    if (existingNames.has(name.toLowerCase())) {
      skipped++;
      continue;
    }

    await addLocal("speditions", {
      name,
      createdAt: Date.now()
    });

    existingNames.add(name.toLowerCase());
    imported++;

    if (navigator.onLine) {
      try {
        await addDoc(cloudSpeditionsRef, {
          name,
          createdAt: Date.now()
        });
      } catch (err) {
        console.error("Spedition Cloud-Import fehlgeschlagen:", err);
      }
    }
  }

  await renderMasterData();
  setImportStatus(`${imported} Spedition(en) importiert, ${skipped} übersprungen.`);
  setSyncStatus("Speditionen-Import abgeschlossen.");
}

async function importEntriesCSV(file) {
  const text = await readFileAsText(file);
  const rows = parseCSV(text);

  const localSpeditions = await getAllLocal("speditions");
  const localErfasser = await getAllLocal("erfasser");

  const speditionSet = new Set(localSpeditions.map(x => (x.name || "").toLowerCase()));
  const erfasserSet = new Set(localErfasser.map(x => (x.name || "").toLowerCase()));

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const spedition = (row.spedition || row.Spedition || "").trim();
    const erfasser = (row.erfasser || row.Erfasser || "").trim();

    const entry = {
      datum: normalizeDate(row.datum || row.Datum || ""),
      spedition,
      lieferschein: (
        row.lieferschein ||
        row.Lieferschein ||
        row.lieferscheinnummer ||
        row.Lieferscheinnummer ||
        row.lieferscheinnr ||
        row.Lieferscheinnr ||
        ""
      ).trim(),
      erhalten: parseInt((row.erhalten || row.Erhalten || "0").replace(",", "."), 10) || 0,
      abgegeben: parseInt((row.abgegeben || row.Abgegeben || "0").replace(",", "."), 10) || 0,
      erfasser,
      notizen: (row.notizen || row.Notizen || "").trim(),
      createdAt: Date.now()
    };

    if (!entry.datum || !entry.spedition || !entry.lieferschein) {
      skipped++;
      continue;
    }

    if (!speditionSet.has(entry.spedition.toLowerCase())) {
      await addLocal("speditions", {
        name: entry.spedition,
        createdAt: Date.now()
      });
      speditionSet.add(entry.spedition.toLowerCase());

      if (navigator.onLine) {
        try {
          await addDoc(cloudSpeditionsRef, {
            name: entry.spedition,
            createdAt: Date.now()
          });
        } catch (err) {
          console.error("Spedition Auto-Anlage fehlgeschlagen:", err);
        }
      }
    }

    if (entry.erfasser && !erfasserSet.has(entry.erfasser.toLowerCase())) {
      await addLocal("erfasser", {
        name: entry.erfasser,
        createdAt: Date.now()
      });
      erfasserSet.add(entry.erfasser.toLowerCase());

      if (navigator.onLine) {
        try {
          await addDoc(cloudErfasserRef, {
            name: entry.erfasser,
            createdAt: Date.now()
          });
        } catch (err) {
          console.error("Erfasser Auto-Anlage fehlgeschlagen:", err);
        }
      }
    }

    await addLocal("entries", entry);

    if (navigator.onLine) {
      try {
        await addDoc(cloudEntriesRef, entry);
      } catch (err) {
        console.error("Entry Cloud-Import fehlgeschlagen:", err);
      }
    }

    imported++;
  }

  await renderMasterData();
  await renderAll();

  setImportStatus(`${imported} Eintrag/Einträge importiert, ${skipped} übersprungen.`);
  setSyncStatus("Palettendaten-Import abgeschlossen.");
}

// ---------- Events ----------

document.getElementById("entryForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const entry = {
    datum: document.getElementById("datum").value,
    spedition: document.getElementById("spedition").value,
    erhalten: parseInt(document.getElementById("erhalten").value || "0", 10),
    abgegeben: parseInt(document.getElementById("abgegeben").value || "0", 10),
    erfasser: document.getElementById("erfasser").value,
    lieferschein: document.getElementById("lieferschein").value.trim(),
    notizen: document.getElementById("notizen").value.trim()
  };

  if (!entry.lieferschein) {
    alert("Bitte Lieferscheinnummer eingeben.");
    return;
  }

  if (editingId !== null) {
    await updateEntry(editingId, entry);
  } else {
    await addEntry(entry);
  }

  resetFormState();
});

document.getElementById("cancelEditBtn").addEventListener("click", () => {
  resetFormState();
});

document.getElementById("speditionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addMasterData("speditions", document.getElementById("newSpedition").value);
  document.getElementById("newSpedition").value = "";
});

document.getElementById("erfasserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addMasterData("erfasser", document.getElementById("newErfasser").value);
  document.getElementById("newErfasser").value = "";
});

document.getElementById("filterSpedition").addEventListener("input", loadEntries);
document.getElementById("calcTimeline").addEventListener("click", calculateTimeline);

document.getElementById("clearBtn").addEventListener("click", async () => {
  const ok = confirm("Aktuelle Daten löschen? Sie bleiben im Archiv und in der Timeline erhalten.");
  if (!ok) return;
  await clearCurrentEntriesOnly();
});

document.getElementById("exportCSV").addEventListener("click", async () => {
  const entries = await getAllLocal("entries");
  let csv = "datum,spedition,lieferschein,erhalten,abgegeben,erfasser,notizen\n";

  entries.forEach((e) => {
    csv += [
      e.datum,
      e.spedition,
      e.lieferschein || "",
      e.erhalten,
      e.abgegeben,
      e.erfasser || "",
      (e.notizen || "").replaceAll(",", " ")
    ].join(",") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "paletten_export.csv";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importSpeditionsBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("importSpeditionsFile");
  const file = fileInput.files[0];

  if (!file) {
    alert("Bitte eine Speditionen-CSV auswählen.");
    return;
  }

  try {
    setImportStatus("Speditionen-Import läuft ...");
    await importSpeditionsCSV(file);
    fileInput.value = "";
  } catch (err) {
    console.error(err);
    setImportStatus("Fehler beim Import der Speditionen.");
    alert("Fehler beim Import der Speditionen.");
  }
});

document.getElementById("importEntriesBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("importEntriesFile");
  const file = fileInput.files[0];

  if (!file) {
    alert("Bitte eine Palettenerfassung-CSV auswählen.");
    return;
  }

  try {
    setImportStatus("Palettendaten-Import läuft ...");
    await importEntriesCSV(file);
    fileInput.value = "";
  } catch (err) {
    console.error(err);
    setImportStatus("Fehler beim Import der Palettendaten.");
    alert("Fehler beim Import der Palettendaten.");
  }
});

window.addEventListener("online", () => {
  setSyncStatus("Wieder online.");
});

window.addEventListener("offline", () => {
  setSyncStatus("Offline-Modus aktiv.");
});