const DB_NAME = 'meetings-db';
const STORE = 'meetings';
const JOBS = 'jobs';
const VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(JOBS)) {
        db.createObjectStore(JOBS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runOn(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const os = db.transaction(storeName, mode).objectStore(storeName);
        const req = fn(os);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}
function run(mode, fn) {
  return runOn(STORE, mode, fn);
}

// ---- 續傳任務（辨識到一半的會議）----
export async function saveJob(job) {
  await runOn(JOBS, 'readwrite', (os) => os.put(job));
  return job;
}
export async function getActiveJob() {
  const all = (await runOn(JOBS, 'readonly', (os) => os.getAll())) || [];
  return all.find((j) => !j.done) || null;
}
export async function clearJob(id) {
  await runOn(JOBS, 'readwrite', (os) => os.delete(id));
}

export async function save(meeting) {
  await run('readwrite', (os) => os.put(meeting));
  return meeting;
}

export async function get(id) {
  const result = await run('readonly', (os) => os.get(id));
  return result || null;
}

export async function list() {
  const all = (await run('readonly', (os) => os.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function remove(id) {
  await run('readwrite', (os) => os.delete(id));
  const t = getTombstones();
  if (!t.includes(id)) {
    t.push(id);
    setTombstones(t);
  }
}

// 備份匯出：包含會議、刪除墓碑、分類群組（讓沒開雲端同步的人也能完整還原）
export async function exportAll(extra = {}) {
  const meetings = await list();
  return JSON.stringify(
    {
      exportedAt: Date.now(),
      meetings,
      deleted: getTombstones(),
      groups: extra.groups || [],
      groupsDeleted: extra.groupsDeleted || [],
    },
    null,
    2
  );
}

// ---- 刪除墓碑（供雲端同步跨裝置刪除）----
const TOMB_KEY = 'meeting_tombstones';
export function getTombstones() {
  try {
    return JSON.parse(localStorage.getItem(TOMB_KEY)) || [];
  } catch (_) {
    return [];
  }
}
export function setTombstones(ids) {
  localStorage.setItem(TOMB_KEY, JSON.stringify(Array.from(new Set(ids || []))));
}

// 把雲端合併後的文件套用到本機：刪掉墓碑內的、寫入所有會議、更新墓碑。
export async function applyMerged(doc) {
  const meetings = doc.meetings || [];
  const deleted = doc.deleted || [];
  const delSet = new Set(deleted);
  for (const id of deleted) {
    await run('readwrite', (os) => os.delete(id));
  }
  for (const m of meetings) {
    if (!delSet.has(m.id)) await run('readwrite', (os) => os.put(m));
  }
  setTombstones(deleted);
}
