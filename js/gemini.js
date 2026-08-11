// Gemini 客戶端：上傳長音檔（Files API）→ 等待處理 → 產生「語者分段逐字稿 + 摘要」
//
// 設計重點（對應需求：長錄音、多語者、手機穩定）：
// - 用 Files API 串流上傳，1 小時以上的大檔不佔滿手機記憶體。
// - thinkingBudget:0：關掉 2.5-flash 預設思考，避免思考 token 吃掉輸出額度導致長逐字稿被截斷。
// - maxOutputTokens 開到上限 65535，容納長逐字稿。
// - responseSchema 強制結構化輸出，segments 陣列做語者辨識。

import { recordUse, recordCooldown, getKeyStatus } from './usage.js';

const BASE = 'https://generativelanguage.googleapis.com';

// 省額度模式：偏好 Flash-Lite（免費層每分鐘 token 上限高很多，較不會撞 429）
let preferLite = false;
export function setPreferLite(v) {
  preferLite = !!v;
}

// 某些新模型（強制思考）不接受 thinkingBudget:0，會回 400。
// 一旦偵測到，本階段之後的請求都不再送 thinkingConfig。
let thinkingRejected = false;
export function resetThinkingFlag() {
  thinkingRejected = false;
}

// ---- 中斷（使用者按「停止辨識」）----
// 停止必須立即生效：除了不再發新請求，連「等待重試」的睡眠也要能被打斷，
// 否則按下停止後畫面還要卡完那 8～35 秒，跟當機沒兩樣。
let aborted = false;
const abortWaiters = new Set();
export function requestAbort() {
  aborted = true;
  for (const w of Array.from(abortWaiters)) w();
  abortWaiters.clear();
}
export function clearAbort() {
  aborted = false;
}
export function isAborted() {
  return aborted;
}
export const ABORT_MSG = '已停止這場辨識';
function throwIfAborted() {
  if (aborted) throw new Error(ABORT_MSG);
}
function isAbortError(e) {
  return !!(e && e.message === ABORT_MSG);
}

// 動態挑選型號：向 API 詢問目前可用的模型，挑最適合的。
// 這樣 Google 汰換型號名稱（如 2.5-flash → 3.5-flash）時 App 不會壞。
export function pickModel(models, opts = {}) {
  const lite = opts.preferLite != null ? opts.preferLite : preferLite;
  const bad = /embedding|aqa|imagen|image|veo|tts|audio-native|gemma|learnlm|robotics|computer-use|live/i;
  const scored = (models || [])
    .map((m) => {
      const name = String(m.name || '').replace(/^models\//, '');
      const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
      if (!methods.includes('generateContent')) return null;
      if (bad.test(name)) return null;
      const ver = (name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
      let score = (ver ? parseFloat(ver) : 0) * 100;
      const isLite = /flash-lite/.test(name);
      if (lite) {
        // 省額度：讓 flash-lite 勝過版本差（大幅加分）
        if (isLite) score += 300;
        else if (/flash/.test(name)) score += 20;
        else if (/pro/.test(name)) score += 8;
      } else {
        if (/flash/.test(name) && !isLite) score += 40; // flash：品質好
        else if (/pro/.test(name)) score += 25;
        else if (isLite) score += 15;
      }
      if (/preview|exp|thinking|latest/.test(name)) score -= 12; // 偏好穩定版
      return { name, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].name : null;
}

// 查型號結果快取（依 preferLite 分開），避免每次都打 ListModels、也避免單把金鑰冷卻就整個失敗
const modelCache = {};
export function clearModelCache() {
  for (const k in modelCache) delete modelCache[k];
}
// apiKeys 可為單把字串或多把陣列 → 多把時逐把嘗試查型號（某把冷卻/失敗會換下一把）
// opts.preferLite: 明確指定要不要用 Flash-Lite（辨識用全域設定；摘要/翻譯固定 false 品質優先）
async function resolveModel(apiKeys, opts = {}) {
  throwIfAborted();
  const lite = opts.preferLite != null ? opts.preferLite : preferLite;
  const ck = String(lite);
  if (modelCache[ck]) return modelCache[ck];
  const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
  if (!keys.length) throw new Error('尚未設定 API 金鑰');
  let lastErr = null;
  for (const key of keys) {
    let res;
    try {
      res = await fetch(`${BASE}/v1beta/models?key=${key}`);
    } catch (e) {
      lastErr = new Error('網路連線失敗，請確認網路。');
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`取得可用型號失敗 (${res.status})：${(await res.text()).slice(0, 150)}`);
      continue;
    }
    const data = await res.json();
    const name = pickModel(data.models || [], { preferLite: lite });
    if (name) {
      modelCache[ck] = name;
      return name;
    }
    lastErr = new Error('這組金鑰找不到可用型號，請確認金鑰是否正確、或是否已啟用 Gemini API。');
  }
  throw lastErr || new Error('取得可用型號失敗');
}


// 進度回報統一格式：{ phase, pct, message, keyName }。pct 為 null 代表該階段無精確百分比。
function report(onProgress, phase, pct, message, keyName) {
  if (onProgress) onProgress({ phase, pct, message, keyName });
}

async function uploadFile(file, apiKey, onProgress) {
  throwIfAborted();
  report(onProgress, 'upload', 5, '準備上傳…');
  const mime = file.type || 'audio/mpeg';
  const start = await fetch(`${BASE}/upload/v1beta/files?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: file.name || 'meeting-audio' } }),
  });
  if (!start.ok) {
    const err = new Error(`上傳啟動失敗 (${start.status})：${(await start.text()).slice(0, 200)}`);
    err.status = start.status; // 供上層判斷是否值得重試
    throw err;
  }
  const uploadUrl = start.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('未取得上傳網址');

  // 用 XHR 上傳位元組，才能取得真實上傳進度
  const info = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const frac = e.loaded / e.total;
        report(onProgress, 'upload', 5 + frac * 30, `上傳音檔中… ${Math.round(frac * 100)}%`);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).file);
        } catch (err) {
          reject(new Error('上傳回應解析失敗'));
        }
      } else {
        const err = new Error(`上傳失敗 (${xhr.status})`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => {
      const err = new Error('上傳失敗（網路中斷）');
      err.status = 0; // 網路層錯誤，值得重試
      reject(err);
    };
    xhr.send(file);
  });
  return info; // { uri, name, state, mimeType }
}

async function waitActive(fileInfo, apiKey, onProgress) {
  let state = fileInfo.state;
  let uri = fileInfo.uri;
  let name = fileInfo.name;
  let mimeType = fileInfo.mimeType;
  while (state === 'PROCESSING') {
    report(onProgress, 'processing', 40, '雲端處理音檔中…');
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`${BASE}/v1beta/${name}?key=${apiKey}`);
    if (!res.ok) throw new Error(`檔案狀態查詢失敗 (${res.status})`);
    const f = await res.json();
    state = f.state;
    uri = f.uri;
    name = f.name;
    mimeType = f.mimeType || mimeType;
  }
  if (state !== 'ACTIVE') throw new Error(`音檔處理失敗 (${state})`);
  return { uri, mimeType };
}

// 可被中斷的睡眠：按下停止時立刻醒來，不必等完退避秒數
const sleep = (ms) =>
  new Promise((resolve) => {
    if (aborted) return resolve();
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      abortWaiters.delete(wake);
      resolve();
    }, ms);
    abortWaiters.add(wake);
  });
export function isTransientStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
// 從 429 回應解析 Google 建議的等待秒數（retryDelay），回傳毫秒；沒有則回 0
export function parseRetryDelayMs(bodyText) {
  const m = bodyText && bodyText.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.min(65000, Math.ceil(parseFloat(m[1]) + 1) * 1000) : 0;
}

// 跨請求的輪替游標。少了它，每個請求都從第一把金鑰開始（只有前一把失敗才換下一把），
// 於是第三把幾乎永遠用不到，前面幾把卻不斷撞每分鐘上限。
let rrCursor = 0;
export function resetKeyRotation() {
  rrCursor = 0;
}
// 決定這次請求的嘗試順序：先輪替起點分散負載，再把「已知還在冷卻」的排到最後
// （冷卻資訊本來只拿來顯示，沒用在選鑰上 → 明知會 429 還是先打它，白白浪費一次呼叫）。
function orderVariants(vs) {
  if (vs.length < 2) return vs.slice();
  const start = rrCursor++ % vs.length;
  const rotated = vs.slice(start).concat(vs.slice(0, start));
  return rotated
    .map((v, i) => ({ v, i, cool: v.key ? getKeyStatus(v.key).cooling : 0 }))
    .sort((a, b) => (a.cool === b.cool ? a.i - b.i : a.cool - b.cool))
    .map((x) => x.v);
}

// 帶自動重試 + 多變體（金鑰/檔案）輪替的 POST：
// variants: 陣列，makeReq(variant) → { url, body }
// - 某變體 429/5xx/網路錯 → 立刻換下一個變體重試（多把金鑰各有各的每分鐘額度、各自的檔案）
// - 全部受限 → 依 Google 建議秒數等待後再整輪重試
async function postJsonRotating(variants, makeReq, onProgress, label) {
  // 錯誤訊息用當前動作命名（摘要/翻譯/問答/加強/辨識），不再一律寫「辨識失敗」誤導
  const act = (label || '處理').replace(/[…\.]+$/, '').replace(/中$/, '') || '處理';
  const vs = orderVariants(variants && variants.length ? variants : [{}]);
  const MAX_ROUNDS = 4;
  const MAX_TOTAL_WAIT = 150000; // 累計等待超過 ~2.5 分鐘就放棄（避免無限迴圈）
  let totalWait = 0;
  let vi = 0;
  let lastText = '';
  let lastStatus = 0;
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    let sawTransient = false;
    let retryMs = 0;
    for (let k = 0; k < vs.length; k++) {
      throwIfAborted();
      const v = vs[vi % vs.length];
      vi++;
      const multi = vs.length > 1;
      report(onProgress, 'transcribe', null, round === 0 && k === 0 ? label : multi ? '切換金鑰重試中…' : `重試中…（第 ${round} 次）`, v.name);
      const { url, body: rawBody } = makeReq(v);
      // 若本階段已知模型拒絕 thinkingBudget:0，主動移除該參數再送
      let body = rawBody;
      if (thinkingRejected && /thinking/i.test(rawBody)) {
        try {
          const o = JSON.parse(rawBody);
          if (o.generationConfig) delete o.generationConfig.thinkingConfig;
          body = JSON.stringify(o);
        } catch (_) {}
      }
      if (v.key) recordUse(v.key);
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      } catch (e) {
        sawTransient = true;
        continue;
      }
      if (res.ok) return res;
      lastText = await res.text();
      lastStatus = res.status;
      if (res.status === 429) {
        sawTransient = true;
        const d = parseRetryDelayMs(lastText);
        retryMs = Math.max(retryMs, d);
        if (v.key) recordCooldown(v.key, d || 30000);
        continue;
      }
      if (isTransientStatus(res.status)) {
        sawTransient = true;
        continue;
      }
      // 400 INVALID_ARGUMENT：常見於新模型不接受 thinkingBudget:0（強制思考）。
      // 自動改成「不帶 thinkingConfig」重試一次；成功就記住，本階段之後都不再送。
      if (res.status === 400 && !thinkingRejected && /thinking/i.test(body)) {
        try {
          const alt = JSON.parse(body);
          if (alt.generationConfig) delete alt.generationConfig.thinkingConfig;
          const res2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alt) });
          if (res2.ok) {
            thinkingRejected = true;
            return res2;
          }
          lastText = await res2.text();
          lastStatus = res2.status;
        } catch (_) {}
      }
      if (res.status === 400) {
        throw new Error(`${act}失敗 (400)：這個檔案可能格式不支援或已損毀，建議換一個音檔（m4a／mp3／wav）再試。原始訊息：${lastText.slice(0, 200)}`);
      }
      throw new Error(`${act}失敗 (${res.status})：${lastText.slice(0, 300)}`);
    }
    if (!sawTransient || round >= MAX_ROUNDS) break;
    const wait = Math.min(35000, retryMs || 8000 * (round + 1));
    if (totalWait + wait > MAX_TOTAL_WAIT) break;
    totalWait += wait;
    report(onProgress, 'transcribe', null, `${vs.length > 1 ? '所有金鑰' : '額度'}暫時受限，等待 ${Math.round(wait / 1000)} 秒後再試…`);
    await sleep(wait);
    throwIfAborted();
  }
  if (lastStatus === 403 && /permission|not exist/i.test(lastText)) {
    throw new Error('雲端音檔已過期或無法存取，請按「新增會議」重新上傳這個檔案。');
  }
  if (lastStatus === 429) {
    throw new Error('額度受限，暫時無法完成。稍等 1–2 分鐘再按「繼續」通常就會繼續跑（進度已保存）。若一直卡住，代表這段音檔對免費層的「每分鐘用量」太大，建議到 AI Studio 開通 API 付費（最有效），或用較短的錄音。');
  }
  throw new Error(`${act}失敗 (${lastStatus || ''})：${(lastText || '請重試').slice(0, 300)}`);
}

// ---- 逐字稿（可依時間分段，長錄音自動切割）----
const WINDOW_SEC = 40 * 60; // 每段最長 40 分鐘（減少呼叫次數與 token 用量，仍遠低於輸出上限）
const SEG_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { speaker: { type: 'string' }, text: { type: 'string' } },
        required: ['speaker', 'text'],
      },
    },
  },
  required: ['segments'],
};
const SEG_PROMPT =
  `你是專業會議記錄助理。請把這段會議錄音整理成「語者分段逐字稿」：\n` +
  `- 辨識不同說話者，標記「說話者1」「說話者2」…同一個人自始至終用同一標籤。\n` +
  `- 中文一律使用繁體中文（台灣用語），英文保留原文。\n` +
  `- 每個 segment 格式 {"speaker":"說話者1","text":"…"}，適度斷句。`;

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// uploads: [{ key, fileUri }]，每把金鑰用「自己上傳的那份檔案」，才不會 403
// hintSpeakers: 先前段落已出現的說話者標籤 → 提示模型沿用，改善跨段語者一致性
async function transcribeWindow(uploads, mime, model, start, end, whole, onProgress, label, depth, hintSpeakers) {
  const known =
    hintSpeakers && hintSpeakers.length
      ? `已知先前段落已出現的說話者：${hintSpeakers.join('、')}。同一個人請「沿用相同標籤」，只有真的新出現的人才給新的「說話者N」編號。`
      : '說話者請從「說話者1」開始標記。';
  const range = whole ? '' : `\n\n【只處理 ${mmss(start)} 到 ${mmss(end)} 這段時間範圍】的內容，此範圍以外請完全略過。${known}`;
  const res = await postJsonRotating(
    uploads,
    (u) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${u.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ file_data: { mime_type: mime, file_uri: u.fileUri } }, { text: SEG_PROMPT + range }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SEG_SCHEMA,
          maxOutputTokens: 65535,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }),
    onProgress,
    label
  );
  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
  const truncated = cand && cand.finishReason === 'MAX_TOKENS';
  let segments = null;
  if (text) {
    try {
      segments = (JSON.parse(text).segments) || [];
    } catch (_) {
      segments = null;
    }
  }
  // 內容太密被截斷 → 對半再切（有時間範圍時才能切）
  if ((truncated || segments === null) && !whole && depth < 4 && end - start > 120) {
    const mid = Math.floor((start + end) / 2);
    const a = await transcribeWindow(uploads, mime, model, start, mid, false, onProgress, label, depth + 1, hintSpeakers);
    const b = await transcribeWindow(uploads, mime, model, mid, end, false, onProgress, label, depth + 1, hintSpeakers);
    return a.concat(b);
  }
  if (segments === null) {
    if (truncated) throw new Error('這段錄音內容太密集，無法完整辨識，請重試一次。');
    throw new Error('辨識結果解析失敗，請重試一次。');
  }
  return segments;
}

async function transcribeAudio(uploads, mime, model, durationSec, onProgress) {
  if (!durationSec) {
    return transcribeWindow(uploads, mime, model, 0, 0, true, onProgress, '辨識語者與逐字稿中…', 0);
  }
  const n = Math.max(1, Math.ceil(durationSec / WINDOW_SEC));
  const all = [];
  const seen = [];
  for (let i = 0; i < n; i++) {
    const start = i * WINDOW_SEC;
    const end = Math.min(durationSec, (i + 1) * WINDOW_SEC);
    const label = n > 1 ? `辨識第 ${i + 1}/${n} 段（${mmss(start)}–${mmss(end)}）…` : '辨識語者與逐字稿中…';
    const segs = await transcribeWindow(uploads, mime, model, start, end, false, onProgress, label, 0, seen.length ? seen.slice() : null);
    all.push(...segs);
    for (const s of segs) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  }
  return all;
}

// 摘要是純文字（不含檔案），任何一把金鑰都能用 → 用 keys 輪替即可
async function summarizeSegments(segments, keys, model, onProgress) {
  const text = (segments || []).map((s) => `${s.speaker}：${s.text}`).join('\n');
  const variants = toKeyObjs(keys);
  const res = await postJsonRotating(
    variants,
    (v) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ text: SUMMARY_PROMPT + text }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SUMMARY_SCHEMA,
          maxOutputTokens: 65535,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }),
    onProgress,
    '整理摘要中…'
  );
  const data = await res.json();
  const out =
    data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!out) throw new Error('未取得摘要結果，請重試。');
  let r;
  try {
    r = JSON.parse(out);
  } catch (_) {
    throw new Error('摘要結果解析失敗，請按「繼續」重試。');
  }
  return { actionItems: r.actionItems || [], mainPoints: r.mainPoints || [], qa: r.qa || [] };
}

// 接受字串 / 字串陣列 / {key,name} 陣列，統一成 [{key, name}]（非空 key）
function toKeyObjs(keys) {
  const arr = Array.isArray(keys) ? keys : keys ? [keys] : [];
  return arr
    .map((k) => (typeof k === 'string' ? { key: k, name: '' } : { key: k.key, name: k.name || '' }))
    .filter((o) => o.key);
}

// 單把金鑰的上傳（含暫時性失敗重試）。
// 沒有重試時，一次 429／5xx／網路瞬斷就會讓這把金鑰被踢出整場任務的輪替名單，
// 之後辨識撞到額度上限只能乾等——這正是「有兩把金鑰卻不會切換」的根因。
const UPLOAD_TRIES = 3;
function isRetriableUpload(e) {
  const s = e && e.status;
  return s === 0 || s === 408 || s === 429 || (s >= 500 && s <= 599);
}
async function uploadOnce(file, ko, onProgress) {
  let lastErr = null;
  for (let attempt = 0; attempt < UPLOAD_TRIES; attempt++) {
    throwIfAborted();
    try {
      const info = await uploadFile(file, ko.key, onProgress);
      const active = await waitActive(info, ko.key, onProgress);
      return active;
    } catch (e) {
      if (isAbortError(e)) throw e;
      lastErr = e;
      if (!isRetriableUpload(e) || attempt === UPLOAD_TRIES - 1) break;
      const wait = 1500 * (attempt + 1);
      report(onProgress, 'upload', null, `${ko.name || '金鑰'} 上傳失敗，${Math.round(wait / 1000)} 秒後重試…`);
      await sleep(wait);
    }
  }
  throw lastErr;
}
// 依序把音檔上傳到指定的每一把金鑰；單把失敗會明確回報（不再靜默略過）
async function uploadToKeys(file, kos, onProgress, showIndex) {
  const uploads = [];
  let mime = file.type || 'audio/mpeg';
  let lastErr = null;
  for (let i = 0; i < kos.length; i++) {
    throwIfAborted();
    if (showIndex && kos.length > 1) report(onProgress, 'upload', 5, `上傳音檔中…（金鑰 ${i + 1}/${kos.length}）`, kos[i].name);
    try {
      const active = await uploadOnce(file, kos[i], onProgress);
      uploads.push({ key: kos[i].key, name: kos[i].name, fileUri: active.uri });
      mime = active.mimeType || mime;
    } catch (e) {
      if (isAbortError(e)) throw e;
      lastErr = e;
      // 靜默略過會讓使用者以為還有多把金鑰在輪替 → 明確告知這場少了哪一把
      report(onProgress, 'upload', null, `⚠️ ${kos[i].name || `金鑰${i + 1}`} 上傳失敗，本場將無法用它輪替`);
    }
  }
  return { uploads, mime, lastErr };
}
// 找出還沒上傳過這個檔案的金鑰（續傳時用來補傳，恢復輪替能力）
export function missingKeyEntries(uploads, apiKeys) {
  const have = new Set((uploads || []).map((u) => u.key));
  return toKeyObjs(apiKeys).filter((k) => !have.has(k.key));
}

// 把音檔上傳到「每一把金鑰的專案」，回傳 { model, mime, uploads:[{key,name,fileUri}] }
// 這樣之後辨識輪替金鑰時，每把用自己的檔案，不會 403。
export async function uploadForJob(file, apiKeys, onProgress) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰，請先到設定填入。');
  report(onProgress, 'model', 3, '選擇辨識型號中…');
  const model = await resolveModel(kos.map((k) => k.key));
  const { uploads, mime, lastErr } = await uploadToKeys(file, kos, onProgress, true);
  if (!uploads.length) throw lastErr || new Error('音檔上傳失敗（所有金鑰皆無法使用）');
  return { model, mime, uploads };
}
// 辨識單一時間段（含自動對半再切、多金鑰輪替）。uploads:[{key,fileUri}]
// hintSpeakers: 先前段落的說話者標籤，提示模型沿用（跨段一致性）
export function transcribeRange(uploads, mime, model, start, end, whole, onProgress, label, hintSpeakers) {
  return transcribeWindow(uploads, mime, model, start, end, whole, onProgress, label || '辨識中…', 0, hintSpeakers);
}

// 挑選型號。opts.preferLite 可覆寫（辨識用全域省額度設定；摘要傳 false 用品質模型）
export async function pickModelForKeys(apiKeys, opts = {}) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  return resolveModel(kos.map((k) => k.key), opts);
}
// 把一個音檔（Blob/File）上傳到每一把金鑰的專案，回傳 { uploads:[{key,name,fileUri}], mime }
export async function uploadBlobToKeys(blob, apiKeys, onProgress) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  const { uploads, mime, lastErr } = await uploadToKeys(blob, kos, onProgress, false);
  if (!uploads.length) throw lastErr || new Error('音檔上傳失敗（所有金鑰皆無法使用）');
  return { uploads, mime };
}
// 對整份逐字稿產生摘要（純文字，任何金鑰可用）
export async function summarize(segments, apiKeys, model, onProgress) {
  return summarizeSegments(segments, apiKeys, model, onProgress);
}

export async function transcribeAndSummarize(file, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const durationSec = opts.durationSec || 0;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰，請先到設定填入。');
  const { model, mime, uploads } = await uploadForJob(file, kos, onProgress);
  const segments = await transcribeAudio(uploads, mime, model, durationSec, onProgress);
  report(onProgress, 'summary', null, '整理摘要中…');
  const summary = await summarizeSegments(segments, kos, model, onProgress);
  return { transcript: segments, summary };
}

// 只根據既有逐字稿重新整理摘要（不需重傳音檔，快又省額度）
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    actionItems: { type: 'array', items: { type: 'string' } },
    mainPoints: { type: 'array', items: { type: 'string' } },
    qa: { type: 'array', items: { type: 'string' } },
  },
  required: ['actionItems', 'mainPoints', 'qa'],
};
const SUMMARY_PROMPT =
  `以下是一段會議逐字稿。請依內容整理成三類，並使用「與逐字稿相同的主要語言」` +
  `（逐字稿主要是中文就用繁體中文、主要是英文就用英文、主要是日文就用日文）：\n` +
  `- actionItems（待辦事項）：逐條列出，每項結尾標註「[DRI: 負責人]」，判斷不出負責人就寫「[DRI: 待指派]」（英文用 [DRI: TBD]）。\n` +
  `- mainPoints（會議重點）：逐條列出，每條寫成「標題：說明」（標題為 4～14 字的名詞短語，接全形冒號再寫說明；英文用「Title: …」），每條只講一個議題。\n` +
  `- qa（提問／Q&A）：格式「問：… 答：…」（英文用「Q: … A: …」），若沒有問答就回傳空陣列。\n\n逐字稿：\n`;

// 加強單一區塊：分段掃過整份逐字稿，抓出「完整、不遺漏」的清單（解決 Q&A 只有幾筆的問題）
const SECTION_META = {
  actionItems: {
    label: '待辦事項',
    instr: '逐條列出「所有」待辦／後續行動（action items），不要精簡、不要遺漏；每項結尾標「[DRI: 負責人]」，判斷不出就標「[DRI: 待指派]」（英文用 [DRI: TBD]）',
    polishInstr: `- 每項結尾保留「[DRI: 負責人]」標註（英文用 [DRI: …]）；合併多條時，多位負責人可並列在同一個標註內。\n`,
  },
  mainPoints: {
    label: '會議重點',
    instr:
      '逐條列出「所有」重要重點與結論，力求完整、不要精簡；每條寫成「標題：說明」的點列格式' +
      '（標題為 4～14 字的名詞短語，點出這條在講什麼，後接全形冒號與說明；英文用「Title: 說明」）',
    cap: 2,
    polishInstr:
      `- 每條必須是「標題：說明」的點列格式：先寫 4～14 字的名詞短語標題，接全形冒號，再寫說明（英文用「Title: …」）。不可寫成沒有標題的長篇論述。\n` +
      `- 每條只講「一個」議題；不同議題（例如需求、技術優缺點、成本、市場數據）一律各自一條，不可壓縮成同一條。\n` +
      `- 說明務必保留原始的具體資訊（數字、單位、比例、日期、人名、結論）。\n`,
  },
  qa: {
    label: '會議提問 Q&A',
    instr:
      '把逐字稿中「每一組」提問與回答都抓出來（務必全部、不要只挑幾個），格式「問：… 答：…」（英文用「Q: … A: …」）。' +
      '問題必須「離開逐字稿也看得懂」：把「此類形態」「這個」「那部分」「上述」等代名詞或指示詞，' +
      '依上下文展開成具體名詞（例如「此類形態的產品」→「Brick 型態的伺服器電源」）；' +
      '若上下文不足以完全確定所指，仍要依前後文做出最合理的推測，並在該詞後標註「（推測）」，不可原封不動留著看不懂的指示詞',
    allowDrop: true, // 只有 Q&A 做價值篩選：議程性、寒暄、零資訊的問答不進會議記錄
    polishInstr:
      `- 維持「問：… 答：…」格式（英文用「Q: … A: …」）；針對同一議題的多組問答合併成一條，答案濃縮成重點結論。\n` +
      `- 問題必須自足：仍帶有「此類」「這個」「那部分」等指涉不明的詞時，依清單其他條目的脈絡改寫成具體名詞；` +
      `無法完全確定時，做出最合理的推測並標註「（推測）」，例如「問：Brick 型態的伺服器電源（推測）是否為貴司首款產品？」。\n` +
      `- 價值篩選：把「不該進會議記錄」的條目標成 drop:true（text 留空字串）。符合以下任一即標 drop：\n` +
      `  (a) 議程或流程安排（要不要先做簡介、能不能快速帶過、時間夠不夠、換下一頁、要不要休息）；\n` +
      `  (b) 設備或連線確認（聽得到嗎、畫面有出來嗎）、純寒暄與出席確認；\n` +
      `  (c) 答案只是複述問題或僅表示同意，問答雙方都沒有提供任何實質資訊。\n` +
      `- 以下一律「不可」標 drop：涉及技術、規格、時程、成本、產能、商務條件、責任歸屬、風險的問答；` +
      `答案為「尚未決定／待確認／再回覆」的也必須保留（那是有意義的狀態）。\n` +
      `- 標 drop 應是少數；若你想標掉的超過三成，代表判斷過於嚴格，請重新檢視並只保留最明確的議程性條目。\n`,
  },
};
const ITEMS_SCHEMA = { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] };

export async function enhanceSection(segments, section, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const meta = SECTION_META[section];
  if (!meta) throw new Error('未知的區塊');
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false }); // 加強固定用品質模型
  const variants = kos.map((k) => ({ key: k.key, name: k.name }));
  const segs = segments || [];
  const BATCH = 80;
  const nb = Math.max(1, Math.ceil(segs.length / BATCH));
  const all = [];
  for (let i = 0; i < segs.length; i += BATCH) {
    const text = segs.slice(i, i + BATCH).map((s) => `${s.speaker}：${s.text}`).join('\n');
    const prompt =
      `以下是一段會議逐字稿。請${meta.instr}。使用與逐字稿相同的主要語言。務求完整、不要遺漏、不要精簡。` +
      `若這段沒有相關內容就回傳空陣列。只輸出 JSON {"items":[...]}。\n\n逐字稿：\n` +
      text;
    const res = await postJsonRotating(
      variants,
      (v) => ({
        url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: ITEMS_SCHEMA, maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }),
      onProgress,
      `加強${meta.label}中…（${Math.floor(i / BATCH) + 1}/${nb}）`
    );
    const data = await res.json();
    const out = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    // 批次失敗就 throw（不可靜默吞掉 → 否則整區被「缺一批」的不完整清單取代）
    if (!out) throw new Error(`加強${meta.label}時第 ${Math.floor(i / BATCH) + 1} 批無回應，請重試`);
    let r;
    try {
      r = JSON.parse(out);
    } catch (_) {
      throw new Error(`加強${meta.label}時第 ${Math.floor(i / BATCH) + 1} 批解析失敗，請重試`);
    }
    if (Array.isArray(r.items)) all.push(...r.items);
  }
  if (!all.length) return all;
  return polishItems(all, meta, model, variants, onProgress);
}

// 第二階段：逐條改寫成書面語＋只合併「同一個問題／同一件事」的重複條目。
// 模型須為每條輸出附上涵蓋的原始編號（src）；程式據此做保底——
// 沒被涵蓋的原始條目自動補回、一條涵蓋太多（合併過頭）就拆回原文，確保永遠不會比抓全階段少內容。
const MERGE_CAP = 3; // 一條輸出最多涵蓋幾條原始條目（各區可用 meta.cap 覆寫）
const POLISH_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          src: { type: 'array', items: { type: 'integer' } },
          drop: { type: 'boolean' }, // 僅 Q&A 使用：標記為不該進會議記錄的議程性／零資訊條目
        },
        required: ['text', 'src'],
      },
    },
  },
  required: ['items'],
};

async function polishItems(all, meta, model, variants, onProgress) {
  const n = all.length;
  const cap = meta.cap || MERGE_CAP;
  const polishPrompt =
    `以下是從會議逐字稿分批擷取的「${meta.label}」原始清單，共 ${n} 條（已編號）。請逐條改寫成正式會議記錄：\n` +
    `- 每一條都改寫成精簡的書面語，刪除口語贅字（如「那個」「就是說」「嗯」），不要照抄逐字稿原文，但保留具體資訊（數字、日期、人名、結論）。\n` +
    `- 只有當多條記錄的是「同一個問題／同一件事」（重複、追問、或同一件事分次提到）才可合併成一條；不同的問題即使屬於同一主題，也必須各自保留一條。合併是例外而非常態，輸出條數應與原始條數相近。\n` +
    `- 一條輸出最多合併 ${cap} 條原始條目。\n` +
    `- 每條輸出都要在 src 列出它涵蓋的原始編號；${n} 條原始編號每一條都必須被涵蓋，不可遺漏、不可自行新增內容。\n` +
    `- 使用與原始清單相同的主要語言。\n` +
    meta.polishInstr +
    `只輸出 JSON {"items":[{"text":"...","src":[編號]}]}。\n\n原始清單：\n` +
    all.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const res = await postJsonRotating(
    variants,
    (v) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ text: polishPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: POLISH_SCHEMA, maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }),
    onProgress,
    `整理潤飾${meta.label}中…`
  );
  const data = await res.json();
  const out = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!out) throw new Error(`整理${meta.label}時無回應，請重試`);
  let r;
  try {
    r = JSON.parse(out);
  } catch (_) {
    throw new Error(`整理${meta.label}時解析失敗，請重試`);
  }
  if (!Array.isArray(r.items)) throw new Error(`整理${meta.label}後結果為空，請重試`);

  let built = assemblePolished(r.items, all, n, cap, !!meta.allowDrop);
  // 過度篩選保護：略過太多就整批不採納，退回「只潤飾不篩選」。
  // 門檻用 max(2, 40%) —— 條目少時比例天生浮動，不該因此觸發。
  if (built.dropped > Math.max(2, n * 0.4) || !built.list.length) {
    built = assemblePolished(r.items, all, n, cap, false);
  }
  if (!built.list.length) throw new Error(`整理${meta.label}後結果為空，請重試`);
  // 讓呼叫端能顯示「另略過 N 則」，使篩選對使用者可見（不可列舉 → 不會被寫進 IndexedDB）
  Object.defineProperty(built.list, 'dropped', { value: built.dropped, enumerable: false });
  return built.list;
}

// 依模型回傳組出最終清單。honorDrop=false 時忽略所有 drop 標記（等於只潤飾不篩選）。
// ord 取涵蓋的最小原始編號，以維持會議先後順序。
function assemblePolished(items, all, n, cap, honorDrop) {
  const covered = new Set();
  const outs = [];
  let dropped = 0;
  for (const it of items) {
    const isDrop = honorDrop && !!(it && it.drop === true);
    const text = it && typeof it.text === 'string' ? it.text.trim() : '';
    if (!isDrop && !text) continue;
    const src = (Array.isArray(it && it.src) ? it.src : [])
      .map((x) => Math.trunc(Number(x)))
      .filter((x) => x >= 1 && x <= n && !covered.has(x));
    if (!src.length) continue;
    if (isDrop) {
      src.forEach((x) => covered.add(x));
      dropped += src.length;
      continue;
    }
    if (src.length > cap) {
      for (const x of src) {
        covered.add(x);
        outs.push({ ord: x, text: all[x - 1] });
      }
      continue;
    }
    src.forEach((x) => covered.add(x));
    outs.push({ ord: Math.min(...src), text });
  }
  // 沒被涵蓋也沒被標略過的 → 補回原文（防漏保證不變）
  for (let x = 1; x <= n; x++) if (!covered.has(x)) outs.push({ ord: x, text: all[x - 1] });
  outs.sort((a, b) => a.ord - b.ord);
  return { list: outs.map((o) => o.text), dropped };
}

// 問答：根據整份逐字稿+摘要回答使用者問題（純文字，固定品質模型）
export async function askMeeting(transcript, summary, question, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false }); // 問答固定用品質模型
  const variants = kos.map((k) => ({ key: k.key, name: k.name }));
  const s = summary || {};
  const text = (transcript || []).map((seg) => `${seg.speaker}：${seg.text}`).join('\n');
  const prompt =
    `你是會議記錄助理。請「只根據」下方會議逐字稿與摘要回答使用者的問題；` +
    `會議中沒有提到的就明白說「會議中沒有提到」，不要自行編造。` +
    `用使用者提問的語言回答，精簡、必要時分點。用純文字回答，不要使用 Markdown 符號（如 ** 或 #）。\n\n` +
    `【摘要】\n待辦：${(s.actionItems || []).join('；') || '（無）'}\n` +
    `重點：${(s.mainPoints || s.keyPoints || []).join('；') || '（無）'}\n\n` +
    `【逐字稿】\n${text}\n\n【使用者的問題】${question}`;
  const res = await postJsonRotating(
    variants,
    (v) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }),
    onProgress,
    '思考回答中…'
  );
  const data = await res.json();
  const out =
    data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!out) throw new Error('未取得回答，請重試。');
  return out.trim();
}

export async function regenerateSummary(segments, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false }); // 摘要固定用品質模型
  return summarizeSegments(segments, kos, model, onProgress);
}

// ---- 專有名詞抽取：從逐字稿挑出人名/公司/產品/地名/國家/術語，優先挑可能被聽錯拼錯的 ----
const TERMS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          category: { type: 'string', enum: ['person', 'org', 'product', 'place', 'country', 'term'] },
          fix: { type: 'string' },
        },
        required: ['term', 'category'],
      },
    },
  },
  required: ['items'],
};
export async function extractTerms(segments, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false }); // 固定用品質模型
  const variants = kos.map((k) => ({ key: k.key, name: k.name }));
  const segs = segments || [];
  const BATCH = 80;
  const nb = Math.max(1, Math.ceil(segs.length / BATCH));
  const map = new Map(); // term → item（跨批次去重）
  for (let i = 0; i < segs.length; i += BATCH) {
    const text = segs.slice(i, i + BATCH).map((s) => `${s.speaker}：${s.text}`).join('\n');
    const prompt =
      `以下是一段會議逐字稿。請挑出裡面的「專有名詞」：人名(person)、公司或組織(org)、產品(product)、地名(place)、國家(country)、專業術語(term)。\n` +
      `重點：優先挑出「可能被語音辨識聽錯或拼錯」的詞。一般常見字詞不要放。\n` +
      `每筆回傳 {"term":"逐字稿中實際出現的寫法","category":"person|org|product|place|country|term","fix":"若你判斷它明顯拼錯/聽錯，給一個最可能的正確寫法；不確定就留空字串"}。\n` +
      `只輸出 JSON {"items":[...]}。逐字稿：\n` +
      text;
    const res = await postJsonRotating(
      variants,
      (v) => ({
        url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: TERMS_SCHEMA, maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }),
      onProgress,
      `挑出專有名詞中…（${Math.floor(i / BATCH) + 1}/${nb}）`
    );
    const data = await res.json();
    const out = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!out) continue;
    try {
      const r = JSON.parse(out);
      for (const it of r.items || []) {
        const term = (it.term || '').trim();
        if (!term) continue;
        if (!map.has(term)) map.set(term, { t: term, cat: it.category || 'term', fix: (it.fix || '').trim() });
      }
    } catch (_) {}
  }
  return Array.from(map.values());
}

// ---- 翻譯（純文字，很省）：固定用品質模型；逐字稿分批翻避免超過輸出上限 ----
const LANG_LABEL = { zh: '繁體中文 (Traditional Chinese)', en: 'English', ja: '日本語 (Japanese)' };
const SUMMARY_TR_SCHEMA = {
  type: 'object',
  properties: {
    actionItems: { type: 'array', items: { type: 'string' } },
    mainPoints: { type: 'array', items: { type: 'string' } },
    qa: { type: 'array', items: { type: 'string' } },
  },
  required: ['actionItems', 'mainPoints', 'qa'],
};

async function translatePayload(variants, model, label, payload, schema, onProgress, progressMsg) {
  const prompt =
    `You are a professional meeting-notes translator. The source text may MIX several languages (e.g. Chinese, English, Japanese). ` +
    `Translate EVERYTHING in the following JSON into ${label}, so the entire output is uniformly in ${label} (translate the parts that are already in another language too). ` +
    `Translate speaker labels too (e.g. "說話者1" → "Speaker 1" / "話者1"). ` +
    `Keep the EXACT same JSON structure, the same array lengths and order — translate values only; do NOT add, remove, merge or reorder items. ` +
    `Keep any "[DRI: ...]" tag; render "問：/答：" as the ${label} equivalent (e.g. "Q:/A:"). Output JSON only.\n\n` +
    JSON.stringify(payload);
  const res = await postJsonRotating(
    variants,
    (v) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          maxOutputTokens: 65535,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }),
    onProgress,
    progressMsg
  );
  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  const out = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
  if (!out) throw new Error('未取得翻譯結果，請重試。');
  try {
    return JSON.parse(out);
  } catch (_) {
    throw new Error('翻譯結果解析失敗，請重試。');
  }
}

export async function translateMeeting(transcript, summary, targetLang, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  const label = LANG_LABEL[targetLang] || targetLang;
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false }); // 翻譯固定用品質模型
  const variants = kos.map((k) => ({ key: k.key, name: k.name }));

  // 1) 摘要（小，一次）
  const sumOut = await translatePayload(
    variants,
    model,
    label,
    {
      actionItems: (summary && summary.actionItems) || [],
      mainPoints: (summary && (summary.mainPoints || summary.keyPoints)) || [],
      qa: (summary && summary.qa) || [],
    },
    SUMMARY_TR_SCHEMA,
    onProgress,
    `翻譯摘要成 ${label}…`
  );

  // 2) 逐字稿（分批，避免長逐字稿超過輸出上限被截斷）
  const segs = transcript || [];
  const BATCH = 60;
  const nb = Math.max(1, Math.ceil(segs.length / BATCH));
  const outSegs = [];
  for (let i = 0; i < segs.length; i += BATCH) {
    const batch = segs.slice(i, i + BATCH);
    const r = await translatePayload(
      variants,
      model,
      label,
      { segments: batch },
      SEG_SCHEMA,
      onProgress,
      `翻譯逐字稿成 ${label}…（${Math.floor(i / BATCH) + 1}/${nb}）`
    );
    outSegs.push(...(r.segments || []));
  }

  return {
    transcript: outSegs,
    summary: { actionItems: sumOut.actionItems || [], mainPoints: sumOut.mainPoints || [], qa: sumOut.qa || [] },
  };
}
