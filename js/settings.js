const OLD = 'gemini_api_key';
const KEY = 'gemini_api_keys';

// 金鑰清單：[{ name, key }]
export function getApiKeyEntries() {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) {
        return a.map((e) => ({ name: (e.name || '').trim(), key: (e.key || '').trim() })).filter((e) => e.key);
      }
    } catch (_) {}
  }
  // 遷移舊格式（單一或多行字串）
  const old = localStorage.getItem(OLD) || '';
  const keys = old.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return keys.map((k, i) => ({ name: keys.length > 1 ? `金鑰${i + 1}` : '', key: k }));
}
export function setApiKeyEntries(entries) {
  const clean = (entries || [])
    .map((e) => ({ name: (e.name || '').trim(), key: (e.key || '').trim() }))
    .filter((e) => e.key);
  localStorage.setItem(KEY, JSON.stringify(clean));
  localStorage.removeItem(OLD);
}
export function getApiKeys() {
  return Array.from(new Set(getApiKeyEntries().map((e) => e.key)));
}
export function getApiKey() {
  return getApiKeys()[0] || '';
}
export function hasApiKey() {
  return getApiKeys().length > 0;
}
// 便利：用字串（可多行）設定（測試 / 舊介面用）
export function setApiKey(value) {
  const keys = (value || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  setApiKeyEntries(keys.map((k) => ({ name: '', key: k })));
}
