import { getApiKeys, getApiKeyEntries, setApiKeyEntries, hasApiKey, getModelPref, setModelPref } from './settings.js';
import { getKeyStatus } from './usage.js';
import { list, get, save, remove, exportAll, getTombstones, applyMerged, saveJob, getActiveJob, clearJob } from './store.js';
import { uploadForJob, transcribeRange, summarize, regenerateSummary, pickModelForKeys, uploadBlobToKeys, setPreferLite } from './gemini.js';
import { splitAudioToChunks } from './audio.js';
import { formatDate, defaultTitle, transcriptToText } from './format.js';
import { matchMeeting } from './search.js';
import { exportPdf, exportWord, splitQA } from './export.js';
import * as sync from './sync.js';
import { mergeState } from './sync.js';

const APP_VERSION = 'v30';

// 套用辨識模型偏好（省額度模式 → Flash-Lite）
setPreferLite(getModelPref() === 'lite');

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('backBtn');
const backupBtn = document.getElementById('backupBtn');

document.getElementById('homeTab').onclick = () => (location.hash = '#/');
document.getElementById('newTab').onclick = () => (location.hash = '#/new');
document.getElementById('settingsBtn').onclick = () => (location.hash = '#/settings');
backBtn.onclick = () => (location.hash = '#/');
backupBtn.onclick = () => onExport();

const SPEAKER_PALETTE = ['#0a84ff', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'm' + Date.now() + Math.round(performance.now());
}
function setHeader(text, showBack, showBackup) {
  titleEl.textContent = text;
  backBtn.hidden = !showBack;
  backupBtn.hidden = !showBackup;
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
async function syncNow(silent) {
  if (!sync.isEnabled() || syncing) return;
  syncing = true;
  try {
    if (!silent) toast('雲端同步中…');
    let remote = await sync.pull();
    let merged = mergeState({ meetings: await list(), deleted: getTombstones() }, remote.doc);
    await applyMerged(merged);
    try {
      await sync.push(merged, remote.sha);
    } catch (e) {
      if (e.message === 'CONFLICT') {
        remote = await sync.pull();
        merged = mergeState({ meetings: await list(), deleted: getTombstones() }, remote.doc);
        await applyMerged(merged);
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
  }
}

async function renderList() {
  const meetings = await list();
  setHeader('DD會議紀錄', false, meetings.length > 0);
  if (!meetings.length) {
    view.innerHTML = `<div class="empty">還沒有會議記錄<br>點下方「＋ 新增會議」上傳錄音檔</div>`;
    return;
  }
  const cardHtml = (m) => {
    const mp = (m.summary && (m.summary.mainPoints || m.summary.keyPoints)) || [];
    const snip = mp.length ? mp.join('、') : transcriptToText(m.transcript).slice(0, 60);
    return `<div class="card tap" data-id="${m.id}">
        <h3>${esc(m.title)}</h3>
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
    });
  };
  draw('');
  const si = document.getElementById('search');
  si.oninput = () => draw(si.value);
}

async function onExport() {
  const json = await exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `meetings-backup-${formatDate(Date.now()).replace(/[: ]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
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
  delete clean._file;
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
  const m = await get(id);
  if (!m) {
    location.hash = '#/';
    return;
  }
  setHeader('會議詳情', true);
  let lang = 'zh';

  const olHtml = (arr) =>
    arr && arr.length
      ? `<ol class="list">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`
      : `<div class="meta" style="padding-left:4px">（無）</div>`;
  const qaHtml = (arr) =>
    arr && arr.length
      ? `<ol class="list qa">${arr
          .map((x) => {
            const { q, a } = splitQA(x);
            return `<li><div class="qa-q"><b>問：</b>${esc(q)}</div>${a ? `<div class="qa-a"><b>答：</b>${esc(a)}</div>` : ''}</li>`;
          })
          .join('')}</ol>`
      : `<div class="meta" style="padding-left:4px">無</div>`;
  const numbered = (arr) => (arr || []).map((x, i) => `${i + 1}. ${x}`).join('\n');
  const qaText = (arr) =>
    arr && arr.length
      ? arr.map((x, i) => { const { q, a } = splitQA(x); return `${i + 1}. 問：${q}\n   答：${a}`; }).join('\n')
      : '無';

  const contentFor = (l) => {
    if (l === 'zh') return { transcript: m.transcript || [], summary: m.summary || {} };
    const t = m.translations && m.translations[l];
    return t ? { transcript: t.transcript || [], summary: t.summary || {} } : null;
  };
  const viewMeeting = () => {
    const c = contentFor(lang) || contentFor('zh');
    return Object.assign({}, m, { transcript: c.transcript, summary: c.summary });
  };

  view.innerHTML = `
    <div class="card">
      <input type="text" id="titleInput" value="${esc(m.title)}" />
      <div class="meta" style="margin-top:8px">${formatDate(m.createdAt)}</div>
      <div class="lang-toggle" id="langToggle">
        <button data-l="zh" class="active">中文</button>
        <button data-l="en">English</button>
        <button data-l="ja">日本語</button>
      </div>
      <button class="big" id="shareBtn" style="margin-top:12px">📤 分享待辦與重點</button>
      <div class="export-row">
        <button class="btn-export" id="pdfBtn">📄 匯出 PDF</button>
        <button class="btn-export" id="wordBtn">📝 匯出 Word (docx)</button>
      </div>
    </div>
    <div id="detailBody"></div>
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
    const segHtml = (c.transcript || [])
      .map((seg) => `<div class="seg"><span class="spk" style="color:${colors[seg.speaker] || 'var(--ink)'}">${esc(seg.speaker)}</span>${esc(seg.text)}</div>`)
      .join('');
    const isZh = l === 'zh';
    const speakers = Object.keys(colors);
    const chipsHtml =
      isZh && speakers.length
        ? `<div class="spk-rename">${speakers
            .map((sp) => `<button class="spk-chip" data-spk="${esc(sp)}" style="color:${colors[sp]};border-color:${colors[sp]}">✎ ${esc(sp)}</button>`)
            .join('')}</div>`
        : '';
    bodyEl.innerHTML = `
      <div class="card">
        <div class="section-title" style="margin-top:0">✅ 待辦事項 Action Item <button class="copy" data-copy="ai">複製</button></div>
        ${olHtml(actionItems)}
        <div class="section-title">📌 會議重點 Main Point <button class="copy" data-copy="mp">複製</button></div>
        ${olHtml(mainPoints)}
        <div class="section-title">❓ 會議提問 Q&amp;A <button class="copy" data-copy="qa">複製</button></div>
        ${qaHtml(qa)}
        ${isZh ? '<button class="btn-regen" id="regenBtn">🔄 重新整理摘要（用逐字稿重跑，不需重傳音檔）</button>' : ''}
      </div>
      <div class="section-title">🗣️ 逐字稿 <button class="copy" data-copy="tr">複製</button></div>
      ${chipsHtml ? `<div class="hint" style="margin:0 4px 6px">點下方語者可改名（例如「說話者1」→「陳經理」）</div>${chipsHtml}` : ''}
      <div class="transcript-box">${segHtml || '<div class="meta">（無逐字稿）</div>'}</div>`;

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

    if (isZh) {
      const rb = document.getElementById('regenBtn');
      if (rb) rb.onclick = doRegen;
      bodyEl.querySelectorAll('.spk-chip').forEach((chip) => {
        chip.onclick = async () => {
          const cur = chip.dataset.spk;
          const nn = prompt(`把「${cur}」改成：`, cur);
          if (nn && nn.trim() && nn.trim() !== cur) {
            const name = nn.trim();
            m.transcript.forEach((seg) => {
              if (seg.speaker === cur) seg.speaker = name;
            });
            m.translations = {}; // 原文改了，清掉舊翻譯
            m.updatedAt = Date.now();
            await save(m);
            syncNow();
            renderDetail(id);
          }
        };
      });
    }
  };

  async function doRegen() {
    if (!hasApiKey()) {
      alert('請先到 ⚙︎ 設定填入 Gemini 金鑰');
      return;
    }
    if (!(m.transcript && m.transcript.length)) {
      alert('這場沒有逐字稿，無法重整摘要');
      return;
    }
    if (!confirm('用現有逐字稿重新整理摘要？會覆蓋目前的待辦／重點／Q&A。')) return;
    const btn = document.getElementById('regenBtn');
    btn.disabled = true;
    const old = btn.textContent;
    try {
      const summary = await regenerateSummary(m.transcript, getApiKeyEntries(), {
        onProgress: (info) => (btn.textContent = '⏳ ' + (info && info.message ? info.message : '處理中…')),
      });
      m.summary = summary;
      m.translations = {}; // 摘要改了，清掉舊翻譯
      m.updatedAt = Date.now();
      await save(m);
      syncNow();
      renderDetail(id);
      toast('摘要已更新 ✓');
    } catch (e) {
      alert('重整失敗：' + (e && e.message ? e.message : e));
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  const setLang = async (l) => {
    document.querySelectorAll('#langToggle button').forEach((b) => b.classList.toggle('active', b.dataset.l === l));
    if (l !== 'zh' && !contentFor(l)) {
      if (!hasApiKey()) {
        alert('請先到 ⚙︎ 設定填入 Gemini 金鑰');
        document.querySelectorAll('#langToggle button').forEach((b) => b.classList.toggle('active', b.dataset.l === 'zh'));
        return;
      }
      lang = l;
      drawBody(l); // 顯示「翻譯中…」
      try {
        const tr = await translateMeeting(m.transcript, m.summary, l, getApiKeyEntries(), {
          onProgress: (info) => {
            const el = document.getElementById('tprogmsg');
            if (el && info && info.message) el.textContent = info.message;
          },
        });
        m.translations = m.translations || {};
        m.translations[l] = tr;
        m.updatedAt = Date.now();
        await save(m);
        syncNow();
        if (lang === l) drawBody(l);
      } catch (e) {
        alert('翻譯失敗：' + (e && e.message ? e.message : e));
        lang = 'zh';
        setLang('zh');
      }
    } else {
      lang = l;
      drawBody(l);
    }
  };
  document.querySelectorAll('#langToggle button').forEach((b) => (b.onclick = () => setLang(b.dataset.l)));

  document.getElementById('pdfBtn').onclick = () => exportPdf(viewMeeting());
  document.getElementById('wordBtn').onclick = () => exportWord(viewMeeting());
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

  document.getElementById('titleInput').onchange = async (e) => {
    m.title = e.target.value.trim() || m.title;
    m.updatedAt = Date.now();
    await save(m);
    syncNow();
  };
  document.getElementById('del').onclick = async () => {
    if (confirm('確定刪除這場會議記錄？此動作無法復原。')) {
      await remove(id);
      location.hash = '#/';
      syncNow();
    }
  };

  drawBody('zh');
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
}

function router() {
  const h = location.hash || '#/';
  if (h.startsWith('#/m/')) return renderDetail(h.slice(4));
  if (h === '#/new') return renderNew();
  if (h === '#/settings') return renderSettings();
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
  location.reload();
}
