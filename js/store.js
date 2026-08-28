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
  const times = getTombstoneTimes();
  times[id] = Date.now(); // 記錄刪除時間，供合併時清理過期墓碑
  setTombstoneTimes(times);
}

// 備份匯出：包含會議、刪除墓碑、分類群組（讓沒開雲端同步的人也能完整還原）
export async function exportAll(extra = {}) {
  const meetings = await list();
  return JSON.stringify(
    {
      exportedAt: Date.now(),
      meetings,
      deleted: getTombstones(),
      deletedAt: getTombstoneTimes(),
      groups: extra.groups || [],
      groupsDeleted: extra.groupsDeleted || [],
      groupsDeletedAt: extra.groupsDeletedAt || {},
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
const TOMB_TIME_KEY = 'meeting_tombstone_times';
export function getTombstoneTimes() {
  try {
    return JSON.parse(localStorage.getItem(TOMB_TIME_KEY)) || {};
  } catch (_) {
    return {};
  }
}
export function setTombstoneTimes(map) {
  localStorage.setItem(TOMB_TIME_KEY, JSON.stringify(map || {}));
}

// 把雲端合併後的文件套用到本機：刪掉墓碑內的、寫入所有會議、更新墓碑。
// 在同一個 transaction 內「先讀當下的本機版本、合併後再寫」，
// 避免整批寫回時把同步期間才存進來的變更蓋掉。
function putMergedOne(m, mergeFn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        const g = os.get(m.id);
        g.onsuccess = () => {
          const cur = g.result;
          os.put(cur && mergeFn ? mergeFn(cur, m) : m);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

// doc：合併後要落地的狀態。mergeFn（選用）：寫回前與當下本機版本再合併一次。
// 同步流程是「讀快照 → 網路往返 → 整批寫回」，中間可能隔好幾秒（資料大、手機網路慢）。
// 這段期間使用者存的東西（例如專有名詞草稿）若被舊快照直接覆蓋就會無聲消失，
// 所以寫回時要再合併一次，而不是盲目覆寫。
export async function applyMerged(doc, mergeFn) {
  const meetings = doc.meetings || [];
  const deleted = doc.deleted || [];
  const delSet = new Set(deleted);
  for (const id of deleted) {
    await run('readwrite', (os) => os.delete(id));
  }
  for (const m of meetings) {
    if (!delSet.has(m.id)) await putMergedOne(m, mergeFn);
  }
  setTombstones(deleted);
  if (doc.deletedAt) setTombstoneTimes(doc.deletedAt);
}
