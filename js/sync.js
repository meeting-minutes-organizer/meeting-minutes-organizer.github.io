// GitHub 雲端同步（選擇性）：把會議記錄存到使用者的「私人」repo 的 meetings.json，
// 達成電腦/手機跨裝置長期記憶。未設定權杖時完全不啟用（維持只存本機）。
//
// 同步文件格式：{ meetings: Meeting[], deleted: string[] }
//   deleted 為刪除墓碑（tombstone），讓刪除能跨裝置生效、避免已刪的記錄又被合併回來。

const CFG_KEY = 'gh_sync_config';

export function getSyncConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || null;
  } catch (_) {
    return null;
  }
}
export function setSyncConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}
export function clearSyncConfig() {
  localStorage.removeItem(CFG_KEY);
}
export function isEnabled() {
  const c = getSyncConfig();
  return !!(c && c.token && c.owner && c.repo);
}

// ---- 純合併邏輯（可測試）----
function stamp(m) {
  return m.updatedAt || m.createdAt || 0;
}
// 「真實編輯」時間戳：只在改逐字稿/摘要/標題/分類時 bump（見 app.js）。
// 翻譯、問答等衍生資料不會動它 → 合併時不會蓋掉別台裝置的真實編輯。
function editStamp(m) {
  return m.editedAt || m.updatedAt || m.createdAt || 0;
}
const ID_RE = /^[\w-]{1,64}$/; // 合法 id 白名單（防雲端注入惡意 id 到 HTML 屬性）

// 聊天問答：兩邊以 at 去重聯集（任一台問的問題都保留）
function mergeChat(a, b) {
  const seen = new Set();
  const out = [];
  for (const c of [...(a || []), ...(b || [])]) {
    if (!c) continue;
    const k = String(c.at || '') + '|' + String(c.q || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.sort((x, y) => (x.at || 0) - (y.at || 0));
}

// 合併同一場會議的兩個版本：主體（逐字稿/摘要/標題）取 editStamp 較新者，
// 聊天做聯集，翻譯只在同一逐字稿版本（editStamp 相同）時互補。
function mergeMeeting(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = editStamp(a) >= editStamp(b) ? a : b;
  const other = base === a ? b : a;
  const merged = { ...base };
  const chat = mergeChat(a.chat, b.chat);
  if (chat.length) merged.chat = chat;
  if (editStamp(a) === editStamp(b)) {
    // 同一逐字稿版本 → 兩邊翻譯互補（base 優先）
    merged.translations = { ...(other.translations || {}), ...(base.translations || {}) };
  }
  merged.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return merged;
}

const TOMB_TTL = 180 * 24 * 3600 * 1000; // 墓碑保留 180 天後可清理（避免無限膨脹）

// 合併兩邊的刪除時間表，並清掉「有時間戳且超過 TTL」的墓碑。
// 沒有時間戳的舊墓碑一律保留（保守，不會誤讓已刪的資料復活）。
function mergeTombstones(idsA, idsB, timesA, timesB, now) {
  const times = { ...(timesA || {}), ...(timesB || {}) };
  const all = new Set([...(idsA || []), ...(idsB || [])]);
  const kept = [];
  const keptTimes = {};
  for (const id of all) {
    const t = times[id];
    if (t && now - t > TOMB_TTL) continue; // 過期 → 清掉
    kept.push(id);
    if (t) keptTimes[id] = t;
  }
  return { ids: kept, times: keptTimes };
}

export function mergeState(a, b, now = Date.now()) {
  const A = a || { meetings: [], deleted: [] };
  const B = b || { meetings: [], deleted: [] };
  const tomb = mergeTombstones(A.deleted, B.deleted, A.deletedAt, B.deletedAt, now);
  const deleted = tomb.ids;
  const delSet = new Set(deleted);
  const byId = new Map();
  for (const m of [...(A.meetings || []), ...(B.meetings || [])]) {
    if (!m || !m.id || !ID_RE.test(m.id) || delSet.has(m.id)) continue;
    byId.set(m.id, mergeMeeting(byId.get(m.id), m));
  }
  const meetings = Array.from(byId.values()).sort((x, y) => y.createdAt - x.createdAt);
  // 分類群組合併（墓碑 + editStamp 較新者勝 + id 白名單）
  const gTomb = mergeTombstones(A.groupsDeleted, B.groupsDeleted, A.groupsDeletedAt, B.groupsDeletedAt, now);
  const groupsDeleted = gTomb.ids;
  const gDelSet = new Set(groupsDeleted);
  const gById = new Map();
  for (const g of [...(A.groups || []), ...(B.groups || [])]) {
    if (!g || !g.id || !ID_RE.test(g.id) || gDelSet.has(g.id)) continue;
    const prev = gById.get(g.id);
    if (!prev || editStamp(g) >= editStamp(prev)) gById.set(g.id, g);
  }
  const groups = Array.from(gById.values()).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  return { meetings, deleted, deletedAt: tomb.times, groups, groupsDeleted, groupsDeletedAt: gTomb.times };
}

// ---- UTF-8 安全的 base64（處理中文與大檔）----
export function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
export function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function apiUrl(c) {
  return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${c.path || 'meetings.json'}`;
}
function authHeaders(c) {
  return {
    Authorization: `Bearer ${c.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export async function pull() {
  const c = getSyncConfig();
  if (!c) throw new Error('尚未設定雲端同步');
  const res = await fetch(apiUrl(c), { headers: authHeaders(c) });
  if (res.status === 404) return { doc: { meetings: [], deleted: [], deletedAt: {}, groups: [], groupsDeleted: [], groupsDeletedAt: {} }, sha: null };
  if (res.status === 401) throw new Error('GitHub 權杖無效或已過期');
  if (!res.ok) throw new Error(`雲端讀取失敗 (${res.status})`);
  const data = await res.json();

  // 取得檔案原始文字內容。
  // GitHub Contents API：檔案 > 1MB 時 content 會是空字串、encoding='none'，
  // 此時必須改用 raw media type 才拿得到內容（支援到 100MB）。
  let raw;
  if (data.content && data.encoding === 'base64') {
    raw = b64decodeUtf8(data.content);
  } else {
    // 空內容或大檔 → 用 raw media type 重新抓一次
    const rawRes = await fetch(apiUrl(c), {
      headers: { ...authHeaders(c), Accept: 'application/vnd.github.raw+json' },
    });
    if (!rawRes.ok) throw new Error(`雲端讀取失敗 (raw ${rawRes.status})`);
    raw = await rawRes.text();
  }

  // 解析失敗 → 中止同步並報錯（絕不能 fallback 成空文件，否則會把雲端整庫覆寫清空）
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error('雲端資料解析失敗，為保護資料已中止同步（請稍後再試）');
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.meetings)) {
    throw new Error('雲端資料格式異常，為保護資料已中止同步');
  }
  doc.meetings = doc.meetings || [];
  doc.deleted = doc.deleted || [];
  doc.deletedAt = doc.deletedAt || {};
  doc.groups = doc.groups || [];
  doc.groupsDeleted = doc.groupsDeleted || [];
  doc.groupsDeletedAt = doc.groupsDeletedAt || {};
  return { doc, sha: data.sha };
}

// 上雲前把「翻譯」拿掉：翻譯是衍生資料（各裝置可自行重翻），且通常占整份體積一半以上。
// 不上雲 → 雲端檔案大幅變小、更慢碰到 GitHub 1MB 界線，也減少多裝置合併衝突。
// （本機 IndexedDB 仍保留完整翻譯，這裡只影響推到 GitHub 的內容。）
export function stripForCloud(doc) {
  return {
    ...doc,
    meetings: (doc.meetings || []).map((m) => {
      if (!m || !m.translations) return m;
      const copy = { ...m };
      delete copy.translations;
      return copy;
    }),
  };
}

export async function push(doc, sha) {
  const c = getSyncConfig();
  if (!c) throw new Error('尚未設定雲端同步');
  const body = {
    message: `update meetings (${new Date().toISOString()})`,
    content: b64encodeUtf8(JSON.stringify(stripForCloud(doc), null, 2)),
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(c), { method: 'PUT', headers: authHeaders(c), body: JSON.stringify(body) });
  if (res.status === 409) throw new Error('CONFLICT');
  if (res.status === 401) throw new Error('GitHub 權杖無效或已過期');
  if (!res.ok) throw new Error(`雲端寫入失敗 (${res.status})`);
  return res.json();
}
