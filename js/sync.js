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
export function mergeState(a, b) {
  const A = a || { meetings: [], deleted: [] };
  const B = b || { meetings: [], deleted: [] };
  const deleted = Array.from(new Set([...(A.deleted || []), ...(B.deleted || [])]));
  const delSet = new Set(deleted);
  const byId = new Map();
  for (const m of [...(A.meetings || []), ...(B.meetings || [])]) {
    if (!m || !m.id || delSet.has(m.id)) continue;
    const prev = byId.get(m.id);
    if (!prev || stamp(m) >= stamp(prev)) byId.set(m.id, m);
  }
  const meetings = Array.from(byId.values()).sort((x, y) => y.createdAt - x.createdAt);
  return { meetings, deleted };
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
  if (res.status === 404) return { doc: { meetings: [], deleted: [] }, sha: null };
  if (res.status === 401) throw new Error('GitHub 權杖無效或已過期');
  if (!res.ok) throw new Error(`雲端讀取失敗 (${res.status})`);
  const data = await res.json();
  let doc;
  try {
    doc = JSON.parse(b64decodeUtf8(data.content));
  } catch (_) {
    doc = { meetings: [], deleted: [] };
  }
  doc.meetings = doc.meetings || [];
  doc.deleted = doc.deleted || [];
  return { doc, sha: data.sha };
}

export async function push(doc, sha) {
  const c = getSyncConfig();
  if (!c) throw new Error('尚未設定雲端同步');
  const body = {
    message: `update meetings (${new Date().toISOString()})`,
    content: b64encodeUtf8(JSON.stringify(doc, null, 2)),
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(c), { method: 'PUT', headers: authHeaders(c), body: JSON.stringify(body) });
  if (res.status === 409) throw new Error('CONFLICT');
  if (res.status === 401) throw new Error('GitHub 權杖無效或已過期');
  if (!res.ok) throw new Error(`雲端寫入失敗 (${res.status})`);
  return res.json();
}
