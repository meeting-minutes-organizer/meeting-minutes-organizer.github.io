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
// 專有名詞訂正的欄位級合併。
// 草稿（draft）是「只存本機、不上雲」的暫存資料：若 terms 整包由 editStamp 較新的一邊決定，
// 只要對方那份較新（例如另一台裝置動過、或雲端剛被別的操作更新），使用者做到一半的草稿就會
// 被整包蓋掉、「套用全部訂正」按鈕跟著消失。因此改成逐詞聯集，草稿與已套用結果都不會遺失。
function mergeTerms(baseT, otherT) {
  const bItems = (baseT && baseT.items) || [];
  const oItems = (otherT && otherT.items) || [];
  if (!baseT && !otherT) return null;
  const map = new Map();
  // 先放 base：順序以它為準（＝畫面上看到的順序，重排會讓使用者對不上）
  for (const it of bItems) if (it && it.t) map.set(it.t, { ...it });
  // 再用 other 補：base 沒有的詞附在後面；同一個詞以 base 為準，但草稿與已套用結果「誰有就留誰」
  for (const it of oItems) {
    if (!it || !it.t) continue;
    const prev = map.get(it.t);
    if (!prev) {
      map.set(it.t, { ...it });
      continue;
    }
    map.set(it.t, { ...it, ...prev, draft: prev.draft || it.draft, applied: prev.applied || it.applied });
  }
  const items = Array.from(map.values()).map((it) => {
    // 草稿與已套用結果相同 → 這筆已經生效，不必再留草稿
    if (it.draft && it.applied && it.draft === it.applied) {
      const c = { ...it };
      delete c.draft;
      return c;
    }
    return it;
  });
  const scannedAt = Math.max((baseT && baseT.scannedAt) || 0, (otherT && otherT.scannedAt) || 0);
  const out = { ...(otherT || {}), ...(baseT || {}), items };
  if (scannedAt) out.scannedAt = scannedAt;
  return out;
}

export function mergeMeeting(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = editStamp(a) >= editStamp(b) ? a : b;
  const other = base === a ? b : a;
  const merged = { ...base };
  const chat = mergeChat(a.chat, b.chat);
  if (chat.length) merged.chat = chat;
  const terms = mergeTerms(base.terms, other.terms);
  if (terms) merged.terms = terms;
  // 學習筆記：整份取 editStamp 較新的那一份（內容彼此關聯，混合會半新半舊）；
  // 但只有一邊有的時候一定要留住，否則剛產生好的筆記會被沒有筆記的另一邊蓋掉。
  const notes = base.notes || other.notes;
  if (notes) merged.notes = notes;
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
  // cache:'no-store'：同步一定要讀到最新狀態，且下面的 raw 重抓絕不能命中這次的快取（見該處說明）
  const res = await fetch(apiUrl(c), { headers: authHeaders(c), cache: 'no-store' });
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
    // 空內容或大檔 → 用 raw media type 重新抓一次。
    // ⚠️ 這次請求「必須」換一個網址：GitHub 的回應帶 cache-control: max-age=60 卻沒有
    // Vary: Accept，瀏覽器會把上面那次（同網址）的回應直接餵回來——也就是那份沒有
    // meetings 的 metadata JSON，結果被誤判成「雲端資料格式異常」而整個同步中止。
    // 加上時間戳讓快取鍵不同，再配合 no-store 雙重保險（iOS Safari 的 cache 模式不一定可靠）。
    const rawRes = await fetch(`${apiUrl(c)}${apiUrl(c).includes('?') ? '&' : '?'}_=${Date.now()}`, {
      headers: { ...authHeaders(c), Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store',
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
    // 拿到的其實是 GitHub 的檔案資訊而非檔案內容 → 幾乎必然是上面說的快取問題
    if (doc && typeof doc === 'object' && doc.sha && 'encoding' in doc) {
      throw new Error('讀到的是檔案資訊而非內容（瀏覽器快取問題），請重新整理頁面後再同步一次');
    }
    const keys = doc && typeof doc === 'object' ? Object.keys(doc).slice(0, 5).join(',') : typeof doc;
    throw new Error(`雲端資料格式異常（收到：${keys}），為保護資料已中止同步`);
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
