// 分類群組：存 localStorage，隨雲端同步文件（doc.groups / doc.groupsDeleted）跨裝置。
// 群組 = { id, name, updatedAt }；會議用 m.group 指到群組 id。

const KEY = 'meeting_groups';
const TOMB = 'meeting_group_tombstones';

export function getGroups() {
  try {
    return (JSON.parse(localStorage.getItem(KEY)) || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  } catch (_) {
    return [];
  }
}
export function setGroups(gs) {
  localStorage.setItem(KEY, JSON.stringify(gs || []));
}
export function getGroupTombstones() {
  try {
    return JSON.parse(localStorage.getItem(TOMB)) || [];
  } catch (_) {
    return [];
  }
}
export function setGroupTombstones(ids) {
  localStorage.setItem(TOMB, JSON.stringify(Array.from(new Set(ids || []))));
}

export function addGroup(name) {
  const g = {
    id: 'g' + Date.now() + Math.random().toString(36).slice(2, 6),
    name: String(name || '').trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!g.name) return null;
  const gs = getGroups();
  gs.push(g);
  setGroups(gs);
  return g;
}
export function renameGroup(id, name) {
  const n = String(name || '').trim();
  if (!n) return;
  const gs = getGroups().map((g) => (g.id === id ? { ...g, name: n, updatedAt: Date.now() } : g));
  setGroups(gs);
}
export function removeGroup(id) {
  setGroups(getGroups().filter((g) => g.id !== id));
  const t = getGroupTombstones();
  if (!t.includes(id)) {
    t.push(id);
    setGroupTombstones(t);
  }
}
export function groupName(id) {
  const g = getGroups().find((x) => x.id === id);
  return g ? g.name : '';
}
