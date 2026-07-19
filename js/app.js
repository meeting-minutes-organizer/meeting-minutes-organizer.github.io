import { getApiKeys, getApiKeyEntries, setApiKeyEntries, hasApiKey, getModelPref, setModelPref } from './settings.js';
import { getKeyStatus } from './usage.js';
import { list, get, save, remove, exportAll, getTombstones, applyMerged, saveJob, getActiveJob, clearJob } from './store.js';
import { uploadForJob, transcribeRange, summarize, pickModelForKeys, uploadBlobToKeys, setPreferLite, enhanceSection, translateMeeting, askMeeting } from './gemini.js';
import { getGroups, setGroups, getGroupTombstones, setGroupTombstones, addGroup, renameGroup, removeGroup, groupName, groupColor } from './groups.js';
import { splitAudioToChunks } from './audio.js';
import { formatDate, defaultTitle, transcriptToText } from './format.js';
import { matchMeeting } from './search.js';
import { exportPdf, exportWord, splitQA } from './export.js';
import * as sync from './sync.js';
import { mergeState } from './sync.js';

const APP_VERSION = 'v40';

// 套用辨識模型偏好（省額度模式 → Flash-Lite）
setPreferLite(getModelPref() === 'lite');

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('backBtn');
const backupBtn = document.getElementById('backupBtn');

document.getElementById('homeTab').onclick = () => (location.hash = '#/');
const groupsTabEl = document.getElementById('groupsTab');
if (groupsTabEl) groupsTabEl.onclick = () => (location.hash = '#/groups');
document.getElementById('newTab').onclick = () => (location.hash = '#/new');
document.getElementById('settingsBtn').onclick = () => (location.hash = '#/settings');
backBtn.onclick = () => (location.hash = '#/');
backupBtn.onclick = () => onExport();

const SPEAKER_PALETTE = ['#0a84ff', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00'];

function esc(s) {
  // 含引號跳脫：避免把使用者/AI/雲端文字插進 HTML 屬性時被注入（attribute injection XSS）
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now() + Math.round(performance.now());
}
function setHeader(text, showBack, showBackup) {
  titleEl.textContent = text;
  backBtn.hidden = !showBack;
  backupBtn.hidden = !showBackup;
  backBtn.onclick = () => (location.hash = '#/'); // 預設返回清單，個別頁面可覆寫
}
// 找出「這條摘要最可能出自哪一段逐字稿」：用字元二字組（bigram）重疊評分，免 API、即時
export function bestSegIndex(text, transcript) {
  const clean = (s) =>
    String(s == null ? '' : s)
      .replace(/\[DRI:[^\]]*\]/g, '')
      .replace(/^問：|^答：|^Q:\s*|^A:\s*/g, '')
      .toLowerCase();
  const t = clean(text);
  const grams = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (/\S\S/.test(g)) grams.add(g);
  }
  if (!grams.size) return -1;
  let best = -1;
  let bestScore = 0;
  (transcript || []).forEach((seg, i) => {
    const st = clean((seg.speaker || '') + (seg.text || ''));
    let score = 0;
    grams.forEach((g) => {
      if (st.includes(g)) score++;
    });
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= 2 ? best : -1;
}

// 逐字稿指紋：段數 + 各段語者/文字長度，用來偵測「翻譯期間原文是否被改動」
function transcriptFingerprint(transcript) {
  const t = transcript || [];
  return t.length + ':' + t.map((s) => (s.speaker || '').length + '.' + (s.text || '').length).join(',');
}

function speakerColors(segments) {
  const map = {};
  let i = 0;
  (segments || []).forEach((s) => {
    if (!(s.speaker in map)) {
      map[s.speaker] = SPEAKER_PALETTE[i % SPEAKER_PALETTE.length];
      i++;
    }
  });
  return map;
}

// ---- 雲端同步 ----
function defaultSyncConfig() {
  return sync.getSyncConfig() || { token: '', owner: '', repo: '', path: 'meetings.json' };
}
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

// 辨識中防止誤關頁面
let transcribing = false;
window.addEventListener('beforeunload', (e) => {
  if (transcribing) {
    e.preventDefault();
    e.returnValue = '辨識還在進行中，離開會中斷，確定要離開嗎？';
    return e.returnValue;
  }
});

let syncing = false;
let pendingSync = false;
async function syncNow(silent) {
  if (!sync.isEnabled()) return;
  // 同步進行中又有新變更 → 標記 pending，等這輪結束後自動再跑一次（不丟失變更）
  if (syncing) {
    pendingSync = true;
    return;
  }
  syncing = true;
  try {
    if (!silent) toast('雲端同步中…');
    const localState = async () => ({
      meetings: await list(),
      deleted: getTombstones(),
      groups: getGroups(),
      groupsDeleted: getGroupTombstones(),
    });
    const applyGroups = (merged) => {
      setGroups(merged.groups || []);
      setGroupTombstones(merged.groupsDeleted || []);
    };
    let remote = await sync.pull();
    let merged = mergeState(await localState(), remote.doc);
    await applyMerged(merged);
    applyGroups(merged);
    try {
      await sync.push(merged, remote.sha);
    } catch (e) {
      if (e.message === 'CONFLICT') {
        remote = await sync.pull();
        merged = mergeState(await localState(), remote.doc);
        await applyMerged(merged);
        applyGroups(merged);
        await sync.push(merged, remote.sha);
      } else {
        throw e;
      }
    }
    toast('雲端已同步 ✓');
  } catch (e) {
    toast('同步失敗：' + (e && e.message ? e.message : e));
  } finally {
    syncing = false;
    // 這輪同步期間若有新變更被標記 → 自動再跑一次，確保不遺漏
    if (pendingSync) {
      pendingSync = false;
      syncNow(true);
    }
  }
}

// 底部彈出的分類選單：回傳群組 id / null（移出分類）/ undefined（取消）
function pickGroup(current) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'sheet-ov';
    const gs = getGroups();
    ov.innerHTML = `<div class="sheet">
      <div class="sheet-title">設定分類</div>
      ${gs.map((g) => `<button class="sheet-btn${g.id === current ? ' cur' : ''}" data-g="${g.id}"><span class="g-dot" style="background:${groupColor(g.id)}"></span>${esc(g.name)}${g.id === current ? ' ✓' : ''}</button>`).join('')}
      <button class="sheet-btn" data-g="__new">➕ 新增群組</button>
      ${current ? '<button class="sheet-btn" data-g="__none">🚫 移出分類</button>' : ''}
      <button class="sheet-btn cancel" data-g="__cancel">取消</button>
    </div>`;
    document.body.appendChild(ov);
    const done = (v) => {
      ov.remove();
      resolve(v);
    };
    ov.onclick = (e) => {
      if (e.target === ov) done(undefined);
    };
    ov.querySelectorAll('.sheet-btn').forEach((b) => {
      b.onclick = () => {
        const g = b.dataset.g;
        if (g === '__cancel') return done(undefined);
        if (g === '__none') return done(null);
        if (g === '__new') {
          const name = prompt('新群組名稱：');
          if (!name || !name.trim()) return done(undefined);
          const ng = addGroup(name);
          return done(ng ? ng.id : undefined);
        }
        done(g);
      };
    });
  });
}

// groupId：undefined = 全部；'__none' = 未分類；其他 = 該群組
async function renderList(groupId) {
  const all = await list();
  const gs = getGroups();
  const known = new Set(gs.map((g) => g.id));
  const meetings =
    groupId === '__none'
      ? all.filter((m) => !m.group || !known.has(m.group))
      : groupId
        ? all.filter((m) => m.group === groupId)
        : all;
  const title = groupId === '__none' ? '🗂 未分類' : groupId ? `📂 ${groupName(groupId) || '分類'}` : 'DD會議紀錄';
  setHeader(title, !!groupId, meetings.length > 0);
  if (groupId) backBtn.onclick = () => (location.hash = '#/groups');
  if (!meetings.length) {
    view.innerHTML = `<div class="empty">${groupId ? '這個分類還沒有會議<br>到「清單」點會議卡片上的分類標籤加入' : '還沒有會議記錄<br>點下方「＋ 新增會議」上傳錄音檔'}</div>`;
    return;
  }
  const cardHtml = (m) => {
    const mp = (m.summary && (m.summary.mainPoints || m.summary.keyPoints)) || [];
    const snip = mp.length ? mp.join('、') : transcriptToText(m.transcript).slice(0, 60);
    const gn = m.group && known.has(m.group) ? groupName(m.group) : '';
    const gc = gn ? groupColor(m.group) : '';
    return `<div class="card tap" data-id="${m.id}">
        <div class="card-top"><h3>${esc(m.title)}</h3><button class="grp-chip${gn ? ' has' : ''}" type="button"${gn ? ` style="color:${gc};border-color:${gc};background:color-mix(in srgb, ${gc} 14%, transparent)"` : ''}><span class="g-dot" style="background:${gc || 'var(--muted)'}"></span>${esc(gn || '未分類')}</button></div>
        <div class="meta">${formatDate(m.createdAt)}</div>
        <div class="snippet">${esc(snip)}</div>
      </div>`;
  };
  view.innerHTML = `<input type="search" id="search" class="search" placeholder="🔍 搜尋標題或內容" autocomplete="off" />
    <div id="listBody"></div>`;
  const body = document.getElementById('listBody');
  const draw = (q) => {
    const filtered = meetings.filter((m) => matchMeeting(m, q));
    body.innerHTML = filtered.length
      ? filtered.map(cardHtml).join('')
      : '<div class="empty">找不到符合的會議</div>';
    body.querySelectorAll('.card').forEach((c) => {
      c.onclick = () => (location.hash = '#/m/' + c.dataset.id);
      const chip = c.querySelector('.grp-chip');
      if (chip)
        chip.onclick = async (e) => {
          e.stopPropagation();
          const m = meetings.find((x) => x.id === c.dataset.id);
          if (!m) return;
          const r = await pickGroup(m.group);
          if (r === undefined) return;
          const fresh = (await get(m.id)) || m;
          if (r === null) delete fresh.group;
          else fresh.group = r;
          const now = Date.now();
          fresh.updatedAt = now;
          fresh.editedAt = now; // 分類是真實編輯
          await save(fresh);
          syncNow();
          router();
        };
    });
  };
  draw('');
  const si = document.getElementById('search');
  si.oninput = () => draw(si.value);
}

// 分類頁：群組清單（新增／改名／刪除／點入看該組會議）
async function renderGroups() {
  const meetings = await list();
  setHeader('分類', false, false);
  const gs = getGroups();
  const known = new Set(gs.map((g) => g.id));
  const count = (gid) => meetings.filter((m) => m.group === gid).length;
  const unCount = meetings.filter((m) => !m.group || !known.has(m.group)).length;
  view.innerHTML = `
    <button class="big" id="addGroupBtn">➕ 新增群組</button>
    <div id="groupList" style="margin-top:12px">
      ${gs
        .map((g) => {
          const gc = groupColor(g.id);
          return `<div class="card tap group-card" data-g="${g.id}" style="border-left:5px solid ${gc}">
            <div class="card-top">
              <h3><span class="g-ico" style="background:color-mix(in srgb, ${gc} 20%, transparent);color:${gc}">📁</span>${esc(g.name)}</h3>
              <span class="grp-ops"><button class="grp-op g-edit" type="button" title="改名">✎</button><button class="grp-op g-del" type="button" title="刪除">🗑</button></span></div>
            <div class="meta" style="color:${gc};font-weight:600">${count(g.id)} 場會議</div>
          </div>`;
        })
        .join('')}
      ${unCount ? `<div class="card tap group-card" data-g="__none" style="border-left:5px solid var(--muted)"><div class="card-top"><h3><span class="g-ico" style="background:color-mix(in srgb, var(--muted) 20%, transparent)">🗂</span>未分類</h3></div><div class="meta">${unCount} 場會議</div></div>` : ''}
      ${!gs.length && !unCount ? '<div class="empty">還沒有群組<br>點上方「＋ 新增群組」建立</div>' : ''}
    </div>`;
  document.getElementById('addGroupBtn').onclick = () => {
    const name = prompt('新群組名稱：');
    if (name && name.trim()) {
      addGroup(name);
      syncNow(true);
      renderGroups();
    }
  };
  view.querySelectorAll('#groupList .card').forEach((c) => {
    c.onclick = () => (location.hash = '#/g/' + c.dataset.g);
    const ed = c.querySelector('.g-edit');
    const del = c.querySelector('.g-del');
    if (ed)
      ed.onclick = (e) => {
        e.stopPropagation();
        const g = gs.find((x) => x.id === c.dataset.g);
        const nn = prompt('群組改名：', g ? g.name : '');
        if (nn && nn.trim()) {
          renameGroup(c.dataset.g, nn);
          syncNow(true);
          renderGroups();
        }
      };
    if (del)
      del.onclick = async (e) => {
        e.stopPropagation();
        const n = count(c.dataset.g);
        if (!confirm(`刪除這個群組？${n ? `裡面的 ${n} 場會議不會被刪，會變成「未分類」。` : ''}`)) return;
        removeGroup(c.dataset.g);
        syncNow(true);
        renderGroups();
      };
  });
}

async function onExport() {
  const json = await exportAll({ groups: getGroups(), groupsDeleted: getGroupTombstones() });
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `meetings-backup-${formatDate(Date.now()).replace(/[: ]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// 匯入備份：解析 JSON → 用現成的 mergeState 與本機合併（天然去重，不覆蓋較新的資料）
async function importBackup(file) {
  const text = await file.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_) {
    throw new Error('這不是有效的備份檔（JSON 解析失敗）');
  }
  if (!doc || !Array.isArray(doc.meetings)) {
    throw new Error('備份檔格式不符（找不到 meetings）');
  }
  const local = {
    meetings: await list(),
    deleted: getTombstones(),
    groups: getGroups(),
    groupsDeleted: getGroupTombstones(),
  };
  const merged = mergeState(local, {
    meetings: doc.meetings || [],
    deleted: doc.deleted || [],
    groups: doc.groups || [],
    groupsDeleted: doc.groupsDeleted || [],
  });
  await applyMerged(merged);
  setGroups(merged.groups || []);
  setGroupTombstones(merged.groupsDeleted || []);
  syncNow(true);
  return merged.meetings.length;
}

function renderNew() {
  setHeader('新增會議', true);
  if (!hasApiKey()) {
    view.innerHTML = `<div class="card">請先到右上角 ⚙︎ 設定，填入你的 Gemini API 金鑰。
      <button class="big" id="toSettings">前往設定</button></div>`;
    document.getElementById('toSettings').onclick = () => (location.hash = '#/settings');
    return;
  }
  view.innerHTML = `
    <div class="card">
      <p style="margin-top:0">選擇會議錄音檔（mp3 / m4a / wav 等）</p>
      <label for="audio" class="file-pick" id="filePick">
        <span class="fp-icon">📁</span>
        <span class="fp-main">點此選擇錄音檔（可多選）</span>
        <span class="fp-name" id="fileName">尚未選擇檔案</span>
      </label>
      <input type="file" id="audio" accept="audio/*,.m4a,.mp3,.wav,.aac,.caf,.aiff" multiple hidden />
      <button class="big" id="go">開始辨識</button>
      <div class="warn">長會議可以<b>分成 2~4 支較短的錄音一次選取</b>（每支建議 1 小時內），App 會依<b>檔名順序</b>接成一份逐字稿——免費層更順、更不會卡。過程請保持螢幕開啟、勿切換 App。</div>
      <details class="hint" style="margin-top:12px">
        <summary style="cursor:pointer;font-weight:600">📌 錄音在「語音備忘錄」裡？點這看怎麼匯入</summary>
        <div style="margin-top:8px">
          iPhone 不允許網頁直接讀取語音備忘錄，只要先匯出一次即可：<br>
          1. 開「語音備忘錄」App → 點該則錄音<br>
          2. 點 <b>⋯ 或分享鈕</b> → <b>儲存到「檔案」</b> → 選個位置<br>
          3. 回這裡按上面的欄位 → <b>選擇檔案</b> → 找到那個 .m4a 選取
        </div>
      </details>
      <div class="progress" id="prog" hidden></div>
    </div>`;
  const prog = document.getElementById('prog');
  const goBtn = document.getElementById('go');

  document.getElementById('audio').onchange = (e) => {
    const fs = Array.from(e.target.files || []);
    const nameEl = document.getElementById('fileName');
    if (!fs.length) {
      nameEl.textContent = '尚未選擇檔案';
    } else if (fs.length === 1) {
      nameEl.textContent = fs[0].name;
    } else {
      const sorted = fs.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      nameEl.textContent = `已選 ${fs.length} 支（依此順序接合）：\n` + sorted.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
    }
    document.getElementById('filePick').classList.toggle('picked', !!fs.length);
  };

  goBtn.onclick = async () => {
    const fs = Array.from(document.getElementById('audio').files || []);
    if (!fs.length) {
      alert('請先選擇音檔');
      return;
    }
    await startNewTranscription(fs);
  };
}

// ===== 可續傳的辨識任務 =====
const WINDOW_SEC = 40 * 60; // 每段最長 40 分鐘（減少呼叫次數與 token 用量）
let jobRunning = false;

function mmssApp(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function buildWindows(durationSec) {
  if (!durationSec) return [{ start: 0, end: 0, whole: true, segments: null }];
  const n = Math.max(1, Math.ceil(durationSec / WINDOW_SEC));
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({ start: i * WINDOW_SEC, end: Math.min(durationSec, (i + 1) * WINDOW_SEC), whole: false, segments: null });
  }
  return arr;
}
async function persistJob(job) {
  const clean = { ...job };
  // 原始音檔（單檔 _file / 多檔 _files）都是暫存的大物件，絕不寫進 IndexedDB
  // （否則多檔長錄音會把數百 MB File 反覆序列化進 DB，iOS 上極慢甚至爆配額）
  delete clean._file;
  delete clean._files;
  await saveJob(clean);
}

// 進度條 UI（回傳控制器）
function createProgress(container, estSec) {
  const startAt = Date.now();
  let barPct = 0;
  let easeTimer = null;
  const q = (sel) => container.querySelector(sel);
  const fmt = () => {
    const s = Math.floor((Date.now() - startAt) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  container.innerHTML = `
    <div class="prog-bar"><div class="prog-fill" id="pf"></div></div>
    <div class="prog-label" id="pl">準備中…</div>
    <div class="prog-key" id="pk" hidden></div>
    <div class="prog-time" id="pt">已等待 0:00</div>`;
  const setBar = (p) => {
    barPct = Math.max(barPct, Math.min(100, p));
    const pf = q('#pf');
    if (pf) pf.style.width = barPct + '%';
  };
  const setLabel = (t) => {
    const pl = q('#pl');
    if (pl) pl.textContent = t;
  };
  const timeTimer = setInterval(() => {
    const pt = q('#pt');
    if (pt) pt.textContent = '已等待 ' + fmt();
  }, 1000);
  const stopEase = () => {
    if (easeTimer) {
      clearInterval(easeTimer);
      easeTimer = null;
    }
  };
  const easeTo = (target, sec) => {
    stopEase();
    const from = barPct;
    const es = Date.now();
    easeTimer = setInterval(() => {
      const el = (Date.now() - es) / 1000;
      setBar(from + (target - from) * Math.min(1, el / Math.max(5, sec)));
      if (barPct >= target - 0.5) stopEase();
    }, 400);
  };
  const setKey = (name) => {
    const pk = q('#pk');
    if (!pk) return;
    if (name) {
      pk.textContent = '🔑 目前使用：' + name;
      pk.hidden = false;
    } else {
      pk.hidden = true;
    }
  };
  const onProgress = (info) => {
    if (!info) return;
    if (info.pct != null) {
      stopEase();
      setBar(info.pct);
    }
    if (info.message) setLabel(info.message);
    if (info.keyName !== undefined) setKey(info.keyName);
  };
  const stop = () => {
    stopEase();
    clearInterval(timeTimer);
  };
  return { onProgress, setBar, setLabel, easeTo, stopEase, stop };
}

async function processJob(job, container) {
  const est = Math.max(30, Math.round((job.durationSec || 0) * 0.5) + 25);
  const ui = createProgress(container, est);
  transcribing = true;
  jobRunning = true;
  let wakeLock = null;
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
  const prepared = () => job.chunks && job.chunks.length && job.chunks.every((c) => c.uploads && c.uploads.length);
  try {
    // 1) 準備（上傳；單檔會嘗試切割）——只在尚未備妥時做，需要原始檔（一次前景完成）
    if (!prepared()) {
      const entries = getApiKeyEntries();
      ui.setBar(4);
      ui.setLabel('選擇型號中…');
      job.model = job.model || (await pickModelForKeys(entries));

      if (job.multiFile) {
        // 多檔模式：使用者自己分段錄好，每支檔案 = 一段（不需在手機上切割）
        if (!job._files) throw new Error('原始音檔已不在，請按「新增會議」重新選擇檔案。');
        job.mode = 'multi';
        const m = job.chunks.length;
        for (let i = 0; i < m; i++) {
          if (job.chunks[i].uploads && job.chunks[i].uploads.length) continue;
          ui.setBar(6 + (i / m) * 30);
          ui.setLabel(`上傳第 ${i + 1}/${m} 支（${job._files[i].name}）…`);
          const r = await uploadBlobToKeys(job._files[i], entries, ui.onProgress);
          job.chunks[i].uploads = r.uploads;
          job.chunks[i].mime = r.mime;
        }
      } else {
        if (!job._file) throw new Error('原始音檔已不在，請按「新增會議」重新選擇檔案。');
        // 嘗試把單一音檔切成小段（每段 30 分鐘），大幅降低每次請求 token
        let blobs = null;
        try {
          ui.setLabel('切割音檔中…');
          const r = await splitAudioToChunks(job._file, 30 * 60, (i, n) => ui.setLabel(`切割音檔中…（${i}/${n} 段）`));
          blobs = r.chunks;
          job.durationSec = r.durationSec || job.durationSec;
        } catch (_) {
          blobs = null; // 解碼失敗 → 改用整檔模式
        }
        if (blobs && blobs.length) {
          job.mode = 'split';
          job.chunks = blobs.map((c) => ({ start: c.start, end: c.end, uploads: null, mime: 'audio/wav', segments: null }));
          for (let i = 0; i < blobs.length; i++) {
            ui.setBar(8 + (i / blobs.length) * 28);
            ui.setLabel(`上傳第 ${i + 1}/${blobs.length} 段…`);
            const r = await uploadBlobToKeys(blobs[i].blob, entries, ui.onProgress);
            job.chunks[i].uploads = r.uploads;
            job.chunks[i].mime = r.mime;
            blobs[i].blob = null; // 釋放記憶體
          }
        } else {
          // 後備：整檔上傳 + 時間範圍提示（每把金鑰各一份）
          job.mode = 'whole';
          const up = await uploadForJob(job._file, entries, ui.onProgress);
          job.model = up.model;
          job.chunks = buildWindows(job.durationSec).map((w) => ({ start: w.start, end: w.end, whole: w.whole, uploads: up.uploads, mime: up.mime, segments: null }));
        }
      }
      await persistJob(job); // 全部上傳完成後才可續傳
    }

    // 2) 逐段辨識（每段完成即存檔）
    const n = job.chunks.length;
    for (let i = 0; i < n; i++) {
      if (job.chunks[i].segments) continue;
      const c = job.chunks[i];
      const base = 40 + (i / n) * 52;
      const next = 40 + ((i + 1) / n) * 52;
      ui.setBar(base);
      ui.easeTo(next, est / n);
      let label = '辨識語者與逐字稿中…';
      if (n > 1) label = job.mode === 'multi' ? `辨識第 ${i + 1}/${n} 支…` : `辨識第 ${i + 1}/${n} 段（${mmssApp(c.start)}–${mmssApp(c.end)}）…`;
      const whole = job.mode === 'whole' ? !!c.whole : true;
      c.segments = await transcribeRange(c.uploads, c.mime || job.mime, job.model, c.start || 0, c.end || 0, whole, ui.onProgress, label);
      ui.stopEase();
      await persistJob(job);
      ui.setBar(next);
    }
    // 3) 摘要（重點/待辦/Q&A 很重要 → 固定用品質模型，不受省額度影響）
    ui.setLabel('整理摘要中…');
    ui.easeTo(99, 20);
    const allSegs = job.chunks.reduce((acc, c) => acc.concat(c.segments || []), []);
    const summaryModel = await pickModelForKeys(getApiKeyEntries(), { preferLite: false });
    const summary = await summarize(allSegs, getApiKeyEntries(), summaryModel, ui.onProgress);
    ui.stopEase();
    ui.setBar(100);
    ui.setLabel('完成！');
    // 4) 存成會議、清除任務
    const meeting = { id: uid(), title: job.title, createdAt: job.createdAt, updatedAt: Date.now(), transcript: allSegs, summary };
    await save(meeting);
    await clearJob(job.id);
    jobRunning = false;
    transcribing = false;
    location.hash = '#/m/' + meeting.id;
    syncNow();
  } catch (e) {
    ui.stop();
    jobRunning = false;
    transcribing = false;
    const canResume = prepared();
    container.innerHTML = `<div class="err">❌ ${esc(e && e.message ? e.message : '發生未知錯誤')}</div>
      <div class="hint" style="margin-top:6px">${canResume ? '進度已保存，可從中斷處繼續。' : '請重新選擇檔案再試。'}</div>
      <button class="big" id="retryJob">${canResume ? '繼續辨識' : '返回'}</button>`;
    const rb = document.getElementById('retryJob');
    if (rb) rb.onclick = () => (prepared() ? openJobProgress(job) : (location.hash = '#/new'));
    refreshResumeBanner();
  } finally {
    if (wakeLock) {
      try {
        await wakeLock.release();
      } catch (_) {}
    }
  }
}

async function openJobProgress(job) {
  const existing = document.getElementById('resume-banner');
  if (existing) existing.remove();
  setHeader('辨識中', true);
  view.innerHTML = `
    <div class="card">
      <div class="warn">辨識進行中。你可以<b>在 App 內</b>切到其他畫面去忙別的，它會繼續跑；就算切出 App 造成中斷，回來也會<b>從這裡接續</b>（iPhone 無法讓網頁在背景繼續運算）。</div>
      <div class="progress" id="jobprog"></div>
    </div>`;
  await processJob(job, document.getElementById('jobprog'));
}

async function startNewTranscription(files) {
  // 防止辨識中又開第二個任務（兩者共用 job id 'active' 會互相覆寫、燒雙倍額度）
  if (jobRunning) {
    alert('已有一場辨識正在進行中，請等它完成或先返回查看進度。');
    return;
  }
  const active = await getActiveJob();
  if (active && !active.done) {
    if (!confirm('偵測到尚有未完成的辨識任務。要「捨棄」它並開始新的嗎？\n（按取消可回上一頁從中斷處繼續）')) {
      return;
    }
    await clearJob(active.id);
  }
  const list = (Array.isArray(files) ? files.slice() : [files]).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
  const now = Date.now();
  let job;
  if (list.length > 1) {
    // 多檔模式：使用者自己分段錄好的多支檔案，依檔名順序接成一份
    const durs = await Promise.all(list.map(getAudioDuration));
    job = {
      id: 'active',
      _files: list,
      multiFile: true,
      title: defaultTitle(list[0].name, now),
      createdAt: now,
      durationSec: durs.reduce((a, b) => a + (b || 0), 0),
      chunks: list.map((f) => ({ name: f.name, uploads: null, mime: null, segments: null })),
      mode: 'multi',
      model: null,
      mime: null,
      done: false,
    };
  } else {
    const file = list[0];
    job = {
      id: 'active',
      _file: file,
      title: defaultTitle(file.name, now),
      createdAt: now,
      durationSec: await getAudioDuration(file),
      chunks: null,
      mode: null,
      model: null,
      mime: null,
      done: false,
    };
  }
  await openJobProgress(job);
}

async function refreshResumeBanner() {
  const existing = document.getElementById('resume-banner');
  if (existing) existing.remove();
  if (jobRunning) return;
  const job = await getActiveJob();
  if (!job || !job.chunks || !job.chunks.length || !job.chunks.every((c) => c.uploads && c.uploads.length)) return;
  const doneCount = job.chunks.filter((c) => c.segments).length;
  const b = document.createElement('div');
  b.id = 'resume-banner';
  b.className = 'install-banner';
  b.innerHTML = `<span>⏳ 有一場辨識未完成（${doneCount}/${job.chunks.length} 段），點此繼續</span>`;
  b.onclick = () => {
    b.remove();
    openJobProgress(job);
  };
  document.body.appendChild(b);
}

// 讀取音檔長度（秒），用於估算辨識時間；失敗回傳 0
function getAudioDuration(file) {
  return new Promise((resolve) => {
    try {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (d) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(d);
      };
      a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
      a.onerror = () => done(0);
      a.src = url;
      setTimeout(() => done(0), 4000);
    } catch (_) {
      resolve(0);
    }
  });
}

async function renderDetail(id) {
  let m = await get(id);
  if (!m) {
    location.hash = '#/';
    return;
  }
  setHeader('會議詳情', true);
  let lang = 'orig';

  // 統一存檔：存前先從 DB 重讀最新版，把本次變更套在最新資料上再存
  // → 避免畫面重繪或另一個 async handler 用「舊的 m」整份覆寫（stale closure 競態）。
  // opts.edit=true 代表真實內容編輯（逐字稿/摘要/標題/分類），會 bump editedAt；
  // 翻譯、問答等衍生資料不傳 edit → 只動 updatedAt，合併時不會蓋掉別台的真實編輯。
  const persist = async (mutate, opts = {}) => {
    const fresh = (await get(id)) || m;
    mutate(fresh);
    const now = Date.now();
    fresh.updatedAt = now;
    if (opts.edit) fresh.editedAt = now;
    await save(fresh);
    m = fresh;
    if (opts.sync !== false) syncNow();
    return fresh;
  };

  const olHtml = (arr, key) =>
    arr && arr.length
      ? `<ol class="list">${arr.map((x, i) => `<li data-jump="${key}:${i}">${esc(x)}</li>`).join('')}</ol>`
      : `<div class="meta" style="padding-left:4px">（無）</div>`;
  const qaHtml = (arr) =>
    arr && arr.length
      ? `<ol class="list qa">${arr
          .map((x, i) => {
            const { q, a } = splitQA(x);
            return `<li data-jump="qa:${i}"><div class="qa-q"><b>問：</b>${esc(q)}</div>${a ? `<div class="qa-a"><b>答：</b>${esc(a)}</div>` : ''}</li>`;
          })
          .join('')}</ol>`
      : `<div class="meta" style="padding-left:4px">無</div>`;
  const numbered = (arr) => (arr || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
  const qaText = (arr) =>
    arr && arr.length
      ? arr.map((x, i) => { const { q, a } = splitQA(x); return `${i + 1}. 問：${q}\n   答：${a}`; }).join('\n')
      : '無';

  const contentFor = (l) => {
    if (l === 'orig') return { transcript: m.transcript || [], summary: m.summary || {} };
    const t = m.translations && m.translations[l];
    return t ? { transcript: t.transcript || [], summary: t.summary || {} } : null;
  };
  const viewMeeting = () => {
    const c = contentFor(lang) || contentFor('orig');
    return Object.assign({}, m, { transcript: c.transcript, summary: c.summary });
  };

  view.innerHTML = `
    <div class="card">
      <input type="text" id="titleInput" value="${esc(m.title)}" />
      <div class="meta" style="margin-top:8px">${formatDate(m.createdAt)}</div>
      <div class="lang-toggle" id="langToggle">
        <button data-l="orig" class="active">原文</button>
        <button data-l="zh">中文</button>
        <button data-l="en">English</button>
        <button data-l="ja">日本語</button>
      </div>
      <div class="act-grid">
        <button class="act-btn primary" id="shareBtn">📤 分享</button>
        <button class="act-btn" id="pdfBtn">📄 PDF</button>
        <button class="act-btn" id="wordBtn">📝 Word</button>
      </div>
      <div class="act-grid">
        <button class="act-btn" data-enh="actionItems">✅ 加強待辦</button>
        <button class="act-btn" data-enh="mainPoints">📌 加強重點</button>
        <button class="act-btn" data-enh="qa">❓ 加強Q&A</button>
      </div>
    </div>
    <div id="detailBody"></div>
    <div class="card" id="chatCard">
      <div class="section-title" style="margin-top:0">💬 問這場會議 <button class="copy" id="chatClear" hidden>清除紀錄</button></div>
      <div id="chatLog"></div>
      <textarea id="chatInput" rows="2" placeholder="輸入問題，例如：這場會議最後的結論是什麼？"></textarea>
      <button class="big" id="chatAsk">送出問題</button>
      <div class="hint">AI 只根據這場會議的逐字稿回答；問答會存在這場會議裡。</div>
    </div>
    <button class="big danger" id="del" style="margin-top:16px">刪除這場會議</button>`;

  const bodyEl = document.getElementById('detailBody');

  const drawBody = (l) => {
    const c = contentFor(l);
    if (!c) {
      bodyEl.innerHTML = `<div class="card"><div class="progress"><div class="spinner"></div><div id="tprogmsg">翻譯中…</div></div></div>`;
      return;
    }
    const s = c.summary || {};
    const actionItems = s.actionItems || [];
    const mainPoints = s.mainPoints || s.keyPoints || [];
    const qa = s.qa || [];
    const colors = speakerColors(c.transcript);
    const isOrig = l === 'orig';
    const segHtml = (c.transcript || [])
      .map((seg, i) => `<div class="seg" data-seg="${i}"${isOrig ? ` data-i="${i}"` : ''}><span class="spk" style="color:${colors[seg.speaker] || 'var(--ink)'}">${esc(seg.speaker)}</span>${esc(seg.text)}</div>`)
      .join('');
    const speakers = Object.keys(colors);
    const chipsHtml =
      isOrig && speakers.length
        ? `<div class="spk-rename">${speakers
            .map((sp) => `<button class="spk-chip" data-spk="${esc(sp)}" style="color:${colors[sp]};border-color:${colors[sp]}">✎ ${esc(sp)}</button>`)
            .join('')}</div>`
        : '';
    // 摺疊狀態（跨會議記住偏好）
    const COLL_KEY = 'sec_collapsed';
    const getColl = () => {
      try {
        return JSON.parse(localStorage.getItem(COLL_KEY)) || {};
      } catch (_) {
        return {};
      }
    };
    const setCollapsed = (k, v) => {
      const cc = getColl();
      cc[k] = v ? 1 : 0;
      localStorage.setItem(COLL_KEY, JSON.stringify(cc));
      const b = bodyEl.querySelector(`[data-secbody="${k}"]`);
      const ch = bodyEl.querySelector(`.sec-head[data-sec="${k}"] .chev`);
      if (b) b.hidden = !!v;
      if (ch) ch.textContent = v ? '▸' : '▾';
    };
    const coll = getColl();
    const secHead = (k, title, copyKey, extra) =>
      `<div class="section-title sec-head" data-sec="${k}"${extra ? ` style="${extra}"` : ''}><span class="sec-t">${title}</span><span class="sec-right"><button class="copy" data-copy="${copyKey}">複製</button><span class="chev">${coll[k] ? '▸' : '▾'}</span></span></div>`;

    bodyEl.innerHTML = `
      <div class="card">
        ${secHead('ai', '✅ 待辦事項 Action Item', 'ai', 'margin-top:0')}
        <div class="sec-body" data-secbody="ai"${coll.ai ? ' hidden' : ''}>${olHtml(actionItems, 'ai')}</div>
        ${secHead('mp', '📌 會議重點 Main Point', 'mp')}
        <div class="sec-body" data-secbody="mp"${coll.mp ? ' hidden' : ''}>${olHtml(mainPoints, 'mp')}</div>
        ${secHead('qa', '❓ 會議提問 Q&amp;A', 'qa')}
        <div class="sec-body" data-secbody="qa"${coll.qa ? ' hidden' : ''}>${qaHtml(qa)}</div>
        <div class="hint" style="margin-top:10px">點各區標題可摺疊／展開；<b>點任一條內容</b>可跳到它在逐字稿中的出處</div>
      </div>
      ${secHead('tr', '🗣️ 逐字稿', 'tr')}
      <div class="sec-body" data-secbody="tr"${coll.tr ? ' hidden' : ''}>
        ${isOrig ? `<div class="hint" style="margin:0 4px 6px">點語者可改名；<b>點段落文字可直接修改錯字</b></div>` : ''}
        ${chipsHtml || ''}
        <div class="transcript-box">${segHtml || '<div class="meta">（無逐字稿）</div>'}</div>
      </div>`;

    // 摺疊/展開（點「複製」不觸發）
    bodyEl.querySelectorAll('.sec-head').forEach((h) => {
      h.onclick = (e) => {
        if (e.target.closest('.copy')) return;
        const k = h.dataset.sec;
        setCollapsed(k, !getColl()[k]);
      };
    });

    // 點摘要條目 → 跳到逐字稿出處（本機文字比對，不耗額度）
    const jumpTo = (idx) => {
      setCollapsed('tr', false);
      const target = bodyEl.querySelector(`.seg[data-seg="${idx}"]`);
      if (!target) return;
      if (target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 2400);
    };
    const arrMap = { ai: actionItems, mp: mainPoints, qa };
    bodyEl.querySelectorAll('[data-jump]').forEach((li) => {
      li.onclick = () => {
        const [k, iStr] = li.dataset.jump.split(':');
        const itemText = (arrMap[k] || [])[+iStr] || '';
        const idx = bestSegIndex(itemText, c.transcript || []);
        if (idx < 0) {
          toast('找不到明確的逐字稿出處');
          return;
        }
        jumpTo(idx);
      };
    });

    const texts = { ai: numbered(actionItems), mp: numbered(mainPoints), qa: qaText(qa), tr: transcriptToText(c.transcript) };
    bodyEl.querySelectorAll('.copy').forEach((b) => {
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(texts[b.dataset.copy] || '');
          const old = b.textContent;
          b.textContent = '已複製';
          setTimeout(() => (b.textContent = old), 1200);
        } catch (_) {
          alert('複製失敗，請手動選取');
        }
      };
    });

    if (isOrig) {
      // 點段落 → 直接編輯逐字稿文字
      bodyEl.querySelectorAll('.seg[data-i]').forEach((el) => {
        el.onclick = () => {
          if (el.querySelector('textarea')) return; // 已在編輯中
          const i = +el.dataset.i;
          const seg = m.transcript[i];
          if (!seg) return;
          el.innerHTML = `<span class="spk" style="color:${colors[seg.speaker] || 'var(--ink)'}">${esc(seg.speaker)}</span>
            <textarea class="seg-edit" rows="3"></textarea>
            <div class="seg-edit-ops"><button class="act-btn primary seg-save" type="button">儲存</button><button class="act-btn seg-cancel" type="button">取消</button></div>`;
          const ta = el.querySelector('textarea');
          ta.value = seg.text;
          ta.focus();
          el.querySelector('.seg-cancel').onclick = (e) => {
            e.stopPropagation();
            drawBody('orig');
          };
          el.querySelector('.seg-save').onclick = async (e) => {
            e.stopPropagation();
            const nt = ta.value.trim();
            if (nt && nt !== seg.text) {
              const segIdx = i;
              await persist((fresh) => {
                if (fresh.transcript && fresh.transcript[segIdx]) fresh.transcript[segIdx].text = nt;
                fresh.translations = {}; // 原文改了，清掉舊翻譯
              }, { edit: true });
              toast('已修改 ✓');
            }
            drawBody('orig');
          };
        };
      });
      bodyEl.querySelectorAll('.spk-chip').forEach((chip) => {
        chip.onclick = async () => {
          const cur = chip.dataset.spk;
          const nn = prompt(`把「${cur}」改成：`, cur);
          if (nn && nn.trim() && nn.trim() !== cur) {
            const name = nn.trim();
            await persist((fresh) => {
              (fresh.transcript || []).forEach((seg) => {
                if (seg.speaker === cur) seg.speaker = name;
              });
              fresh.translations = {}; // 原文改了，清掉舊翻譯
            }, { edit: true });
            renderDetail(id);
          }
        };
      });
    }
  };

  const setLang = async (l) => {
    document.querySelectorAll('#langToggle button').forEach((b) => b.classList.toggle('active', b.dataset.l === l));
    if (l !== 'orig' && !contentFor(l)) {
      lang = l;
      if (!hasApiKey()) {
        bodyEl.innerHTML = `<div class="card"><div class="err">請先到右上角 ⚙︎ 設定，填入你的 Gemini API 金鑰，才能翻譯。<br>（金鑰是每台裝置各自設定的）</div><button class="big secondary" id="backZh" style="margin-top:10px">返回原文</button></div>`;
        document.getElementById('backZh').onclick = () => setLang('orig');
        return;
      }
      drawBody(l); // 顯示「翻譯中…」
      try {
        const fp = transcriptFingerprint(m.transcript); // 翻譯前記錄逐字稿指紋
        const tr = await translateMeeting(m.transcript, m.summary, l, getApiKeyEntries(), {
          onProgress: (info) => {
            const el = document.getElementById('tprogmsg');
            if (el && info && info.message) el.textContent = info.message;
          },
        });
        // 翻譯期間若原文被改過（指紋不符）→ 丟棄這份翻譯，不落盤（避免存下對不上的翻譯）
        const cur = await get(id);
        if (cur && transcriptFingerprint(cur.transcript) !== fp) {
          if (lang === l) {
            setLang('orig');
            toast('原文已變更，請重新翻譯');
          }
          return;
        }
        await persist((fresh) => {
          fresh.translations = fresh.translations || {};
          fresh.translations[l] = tr;
        });
        if (lang === l) drawBody(l);
      } catch (e) {
        if (lang !== l) return; // 使用者已切走
        bodyEl.innerHTML = `<div class="card"><div class="err">❌ 翻譯失敗：${esc(e && e.message ? e.message : e)}</div>
          <button class="big" id="retryTr" style="margin-top:10px">重試翻譯</button>
          <button class="big secondary" id="backZh" style="margin-top:8px">返回原文</button></div>`;
        document.getElementById('retryTr').onclick = () => {
          if (m.translations) delete m.translations[l];
          setLang(l);
        };
        document.getElementById('backZh').onclick = () => setLang('orig');
      }
    } else {
      lang = l;
      drawBody(l);
    }
  };
  document.querySelectorAll('#langToggle button').forEach((b) => (b.onclick = () => setLang(b.dataset.l)));

  document.getElementById('pdfBtn').onclick = () => exportPdf(viewMeeting());
  document.getElementById('wordBtn').onclick = () => exportWord(viewMeeting());

  // 加強某一區塊（分段掃整份逐字稿抓完整清單）
  const doEnhance = async (section, btn) => {
    if (!hasApiKey()) {
      alert('請先到 ⚙︎ 設定填入 Gemini 金鑰');
      return;
    }
    if (!(m.transcript && m.transcript.length)) {
      alert('這場沒有逐字稿，無法加強');
      return;
    }
    const nameMap = { actionItems: '待辦事項', mainPoints: '會議重點', qa: '會議提問 Q&A' };
    if (!confirm(`重新從整份逐字稿抓出「完整的${nameMap[section]}」？會取代目前這一區的內容（其他區不變）。`)) return;
    const old = btn.textContent;
    document.querySelectorAll('.act-btn').forEach((x) => (x.disabled = true));
    try {
      const items = await enhanceSection(m.transcript, section, getApiKeyEntries(), {
        onProgress: (info) => (btn.textContent = '⏳ ' + (info && info.message ? info.message : '處理中…')),
      });
      await persist((fresh) => {
        fresh.summary = fresh.summary || {};
        fresh.summary[section] = items;
        fresh.translations = {}; // 內容改了 → 清掉舊翻譯
      }, { edit: true });
      renderDetail(id);
      toast(`已加強${nameMap[section]}（共 ${items.length} 筆）`);
    } catch (e) {
      alert('加強失敗：' + (e && e.message ? e.message : e));
      document.querySelectorAll('.act-btn').forEach((x) => (x.disabled = false));
      btn.textContent = old;
    }
  };
  document.querySelectorAll('[data-enh]').forEach((b) => (b.onclick = () => doEnhance(b.dataset.enh, b)));

  document.getElementById('shareBtn').onclick = async () => {
    const v = viewMeeting();
    const s = v.summary || {};
    const num = (arr) => (arr || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
    const text =
      `【${v.title}】\n${formatDate(v.createdAt)}\n\n` +
      `■ 待辦事項\n${num(s.actionItems) || '（無）'}\n\n` +
      `■ 會議重點\n${num(s.mainPoints || s.keyPoints) || '（無）'}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: v.title, text });
      } catch (_) {}
    } else {
      try {
        await navigator.clipboard.writeText(text);
        toast('已複製到剪貼簿，可貼給同事');
      } catch (_) {
        alert(text);
      }
    }
  };

  // 問答：把逐字稿+問題丟給品質模型回答，紀錄存在這場會議
  const chatLogEl = document.getElementById('chatLog');
  const chatClearBtn = document.getElementById('chatClear');
  const fmtAnswer = (a) =>
    esc(a)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>') // AI 偶爾用 **粗體**，正確顯示
      .replace(/\n/g, '<br>');
  const drawChat = () => {
    const items = m.chat || [];
    chatLogEl.innerHTML = items
      .map(
        (c, i) =>
          `<div class="chat-q">🙋 ${esc(c.q)}</div>
           <div class="chat-a">${fmtAnswer(c.a)}<div class="chat-ops"><button class="copy chat-copy" data-ci="${i}">複製回答</button></div></div>`
      )
      .join('');
    chatClearBtn.hidden = !items.length;
    chatLogEl.querySelectorAll('.chat-copy').forEach((b) => {
      b.onclick = async () => {
        const it = (m.chat || [])[+b.dataset.ci];
        if (!it) return;
        try {
          await navigator.clipboard.writeText(it.a);
          b.textContent = '已複製 ✓';
          setTimeout(() => (b.textContent = '複製回答'), 1200);
        } catch (_) {
          alert('複製失敗，請長按文字手動選取');
        }
      };
    });
  };
  drawChat();
  chatClearBtn.onclick = async () => {
    if (!confirm('清除這場會議的所有問答紀錄？')) return;
    await persist((fresh) => {
      fresh.chat = [];
    });
    drawChat();
  };
  document.getElementById('chatAsk').onclick = async () => {
    const inp = document.getElementById('chatInput');
    const q = inp.value.trim();
    if (!q) return;
    if (!hasApiKey()) {
      alert('請先到 ⚙︎ 設定填入 Gemini 金鑰');
      return;
    }
    if (!(m.transcript && m.transcript.length)) {
      alert('這場沒有逐字稿，無法問答');
      return;
    }
    const btn = document.getElementById('chatAsk');
    btn.disabled = true;
    btn.textContent = '⏳ 思考中…';
    try {
      const a = await askMeeting(m.transcript, m.summary, q, getApiKeyEntries(), {
        onProgress: (info) => (btn.textContent = '⏳ ' + (info && info.message ? info.message : '思考中…')),
      });
      await persist((fresh) => {
        fresh.chat = fresh.chat || [];
        fresh.chat.push({ q, a, at: Date.now() });
      });
      inp.value = '';
      drawChat();
      chatLogEl.lastElementChild && chatLogEl.lastElementChild.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      alert('問答失敗：' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false;
      btn.textContent = '送出問題';
    }
  };

  document.getElementById('titleInput').onchange = async (e) => {
    const nt = e.target.value.trim();
    await persist((fresh) => {
      fresh.title = nt || fresh.title;
    }, { edit: true });
  };
  document.getElementById('del').onclick = async () => {
    if (confirm('確定刪除這場會議記錄？此動作無法復原。')) {
      await remove(id);
      location.hash = '#/';
      syncNow();
    }
  };

  drawBody('orig');
}

function renderSettings() {
  setHeader('設定', true);
  const cfg = defaultSyncConfig();
  const enabled = sync.isEnabled();
  view.innerHTML = `
    <div class="card">
      <p style="margin-top:0"><b>Gemini API 金鑰</b></p>
      <div id="keyList"></div>
      <button class="big secondary" id="addKey">➕ 新增一把金鑰</button>
      <button class="big" id="saveKey" style="margin-top:8px">儲存</button>
      <div id="usageBox"></div>
      <div class="hint">
        金鑰只存在這支手機（不會上傳到任何伺服器）。到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a> → API Keys 複製免費金鑰。<br>
        <b>多把金鑰</b>：每格填一把、可自己命名，撞到用量上限時會自動換下一把。⚠️ 每把要建在<b>不同專案</b>才有各自的額度（長錄音會各上傳一份音檔）。<br>
        <b>用量</b>為本機統計（今日在這支手機呼叫幾次），非 Google 官方剩餘額度。
      </div>
    </div>
    <div class="card">
      <p style="margin-top:0"><b>🎚️ 辨識模型</b></p>
      <div class="lang-toggle" id="modelToggle">
        <button data-mp="auto" class="${getModelPref() === 'lite' ? '' : 'active'}">自動（品質優先）</button>
        <button data-mp="lite" class="${getModelPref() === 'lite' ? 'active' : ''}">省額度（較不會卡）</button>
      </div>
      <div class="hint">
        免費層一直撞到「用量上限（429）」跑不動時，切到<b>省額度</b>：改用 <b>Flash-Lite</b> 模型，免費層每分鐘額度大很多（約 4 倍），長錄音較不會卡；代價是辨識品質略降一點。可隨時切回。
      </div>
    </div>
    <div class="card">
      <p style="margin-top:0"><b>☁️ GitHub 雲端同步（跨裝置記憶）</b>
        <span class="meta">${enabled ? '｜狀態：已開啟' : '｜狀態：未開啟（只存本機）'}</span></p>
      <input type="password" id="ghToken" placeholder="貼上你的 GitHub 權杖（token）" value="${esc(cfg.token || '')}" autocomplete="off" />
      <input type="text" id="ghRepo" placeholder="你的帳號/你的資料庫repo（例：myname/my-notes-data）" value="${cfg.owner && cfg.repo ? esc(cfg.owner + '/' + cfg.repo) : ''}" style="margin-top:8px" />
      <button class="big" id="saveSync">儲存並同步</button>
      <button class="big secondary" id="syncBtn" style="margin-top:8px">立即同步</button>
      <button class="big secondary" id="clearSync" style="margin-top:8px">關閉同步（僅存本機）</button>
      <div class="hint">
        <b>不填也能用</b>（記錄只存這支手機）。要跨裝置才需要設定，全部用<b>你自己的</b> GitHub：<br>
        1. 在 GitHub 建一個<b>私人 repo</b>（例如 <code>my-notes-data</code>），把「你的帳號/repo名」填在上面欄位。<br>
        2. 到 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained tokens</a> → Repository access 選那個 repo → Permissions 的 <b>Contents</b> 設 <b>Read and write</b> → 產生後貼到上面。<br>
        權杖與記錄都只存你自己的裝置與你自己的 repo。
      </div>
    </div>
    <div class="card">
      <p style="margin-top:0"><b>💾 備份 / 還原</b></p>
      <button class="big secondary" id="exportBtn">⬇️ 匯出備份檔</button>
      <button class="big secondary" id="importBtn" style="margin-top:8px">⬆️ 匯入備份檔</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden />
      <div class="hint">
        匯出會把<b>全部會議 + 分類群組</b>存成一個 JSON 檔。換手機或重灌時，用「匯入備份檔」還原——匯入會與現有資料<b>智慧合併</b>（不會覆蓋較新的內容、不會產生重複）。
      </div>
    </div>
    <div class="card">
      <p style="margin-top:0"><b>ℹ️ 關於／更新</b></p>
      <div class="meta" style="margin-bottom:10px">目前版本：${APP_VERSION}</div>
      <button class="big secondary" id="forceUpdateBtn">🔄 檢查並載入最新版</button>
      <div class="hint">若畫面沒更新到最新，按這顆會清除快取並重新載入最新版。</div>
    </div>`;
  // 金鑰清單（可命名、可新增/刪除）
  const keyList = document.getElementById('keyList');
  const addRow = (entry) => {
    const div = document.createElement('div');
    div.className = 'key-row';
    div.innerHTML = `
      <input type="text" class="key-name" placeholder="名稱（如：私人）" value="${esc((entry && entry.name) || '')}" autocomplete="off" />
      <input type="password" class="key-val" placeholder="貼上金鑰" value="${esc((entry && entry.key) || '')}" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <button class="key-del" type="button" title="刪除">✕</button>`;
    div.querySelector('.key-del').onclick = () => div.remove();
    keyList.appendChild(div);
  };
  const existingEntries = getApiKeyEntries();
  (existingEntries.length ? existingEntries : [{ name: '', key: '' }]).forEach(addRow);
  document.getElementById('addKey').onclick = () => addRow({ name: '', key: '' });
  document.getElementById('saveKey').onclick = () => {
    const rows = Array.from(keyList.querySelectorAll('.key-row')).map((r) => ({
      name: r.querySelector('.key-name').value,
      key: r.querySelector('.key-val').value,
    }));
    setApiKeyEntries(rows);
    toast(`已儲存 ${getApiKeys().length} 把金鑰`);
    drawUsage();
  };

  // 本機用量顯示（今日次數 + 冷卻狀態），每秒更新冷卻倒數；離開設定頁自動停止
  const usageBox = document.getElementById('usageBox');
  const drawUsage = () => {
    if (!document.body.contains(usageBox)) return false;
    const entries = getApiKeyEntries();
    if (!entries.length) {
      usageBox.innerHTML = '';
      return true;
    }
    usageBox.innerHTML =
      '<div class="usage-list">' +
      entries
        .map((e, i) => {
          const st = getKeyStatus(e.key);
          const name = e.name || `金鑰${i + 1}`;
          const status = st.cooling ? `<span class="u-cool">冷卻中 ${st.cooling}s</span>` : '<span class="u-stat">可用</span>';
          return `<div class="usage-row"><span class="u-name">${esc(name)}</span><span><span class="u-stat">今日 ${st.count} 次 ｜ </span>${status}</span></div>`;
        })
        .join('') +
      '</div>';
    return true;
  };
  drawUsage();
  const usageTimer = setInterval(() => {
    if (!drawUsage()) clearInterval(usageTimer);
  }, 1000);

  // 辨識模型偏好切換
  document.querySelectorAll('#modelToggle button').forEach((b) => {
    b.onclick = () => {
      const mp = b.dataset.mp;
      setModelPref(mp);
      setPreferLite(mp === 'lite');
      document.querySelectorAll('#modelToggle button').forEach((x) => x.classList.toggle('active', x.dataset.mp === mp));
      toast(mp === 'lite' ? '已切換到省額度（Flash-Lite）' : '已切換到自動（品質優先）');
    };
  });

  document.getElementById('saveSync').onclick = async () => {
    const token = document.getElementById('ghToken').value.trim();
    const repoField = document.getElementById('ghRepo').value.trim();
    const [owner, repo] = repoField.split('/');
    if (!token || !owner || !repo) {
      alert('請填入權杖與 owner/repo');
      return;
    }
    sync.setSyncConfig({ token, owner, repo, path: 'meetings.json' });
    await syncNow();
    router();
  };
  document.getElementById('syncBtn').onclick = () => syncNow();
  document.getElementById('clearSync').onclick = () => {
    sync.clearSyncConfig();
    toast('已關閉雲端同步');
    router();
  };
  document.getElementById('forceUpdateBtn').onclick = () => {
    toast('更新中…');
    forceUpdate();
  };

  // 備份 / 還原
  document.getElementById('exportBtn').onclick = () => onExport();
  const importInput = document.getElementById('importFile');
  document.getElementById('importBtn').onclick = () => importInput.click();
  importInput.onchange = async (e) => {
    const f = (e.target.files || [])[0];
    if (!f) return;
    try {
      toast('匯入中…');
      const n = await importBackup(f);
      toast(`匯入完成，目前共 ${n} 場會議 ✓`);
    } catch (err) {
      alert('匯入失敗：' + (err && err.message ? err.message : err));
    } finally {
      importInput.value = ''; // 允許重選同一個檔案
    }
  };
}

function router() {
  const h = location.hash || '#/';
  if (h.startsWith('#/m/')) return renderDetail(h.slice(4));
  if (h === '#/new') return renderNew();
  if (h === '#/settings') return renderSettings();
  if (h === '#/groups') return renderGroups();
  if (h.startsWith('#/g/')) return renderList(h.slice(4));
  return renderList();
}
window.addEventListener('hashchange', router);
router();

// 啟動時若已開啟雲端同步：先拉取合併，再重新整理當前畫面
if (sync.isEnabled()) {
  syncNow(true).then(() => router());
}

// 啟動畫面：載入後淡出移除
function hideSplash() {
  const sp = document.getElementById('splash');
  if (!sp) return;
  setTimeout(() => {
    sp.classList.add('hide');
    setTimeout(() => sp.remove(), 500);
  }, 550);
}
if (document.readyState === 'complete') hideSplash();
else window.addEventListener('load', hideSplash);

// 「加入主畫面」教學：只在 iPhone 用瀏覽器（非已安裝）且未關閉過時顯示
function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
function maybeShowInstallHint() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isIOS || isStandalone() || localStorage.getItem('install_hint_dismissed')) return;
  const b = document.createElement('div');
  b.className = 'install-banner';
  b.innerHTML = `<span>📲 想像 App 一樣用？點下方 <b>分享鈕</b> → <b>加入主畫面</b></span><span class="x" id="closeHint">×</span>`;
  document.body.appendChild(b);
  document.getElementById('closeHint').onclick = () => {
    localStorage.setItem('install_hint_dismissed', '1');
    b.remove();
  };
}
maybeShowInstallHint();

// 未完成的辨識任務：啟動時、以及每次回到前景時，顯示「繼續」橫幅
refreshResumeBanner();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshResumeBanner();
});

// 註冊 Service Worker（PWA / 離線）+ 自動更新
let refreshing = false;
if ('serviceWorker' in navigator) {
  // 有新版 SW 接手時自動重新載入（僅在已安裝過的情況，避免首次安裝就重整）
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }
  window.addEventListener('load', () => {
    // updateViaCache:'none' → 不用瀏覽器快取的 sw.js，每次都抓最新版檢查更新
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update();
        setInterval(() => reg.update(), 60 * 60 * 1000);
      })
      .catch(() => {});
  });
}

// 強制載入最新版：清掉 SW 與所有快取後重整（設定頁按鈕使用）
async function forceUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {}
  // 用帶時間戳的網址重新載入，強制繞過 iOS 的 HTTP 快取（GitHub Pages 有 10 分鐘快取）
  const u = new URL(location.href);
  u.searchParams.set('fresh', String(Date.now()));
  location.replace(u.toString());
}
