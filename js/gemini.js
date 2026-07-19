// Gemini 客戶端：上傳長音檔（Files API）→ 等待處理 → 產生「語者分段逐字稿 + 摘要」
//
// 設計重點（對應需求：長錄音、多語者、手機穩定）：
// - 用 Files API 串流上傳，1 小時以上的大檔不佔滿手機記憶體。
// - thinkingBudget:0：關掉 2.5-flash 預設思考，避免思考 token 吃掉輸出額度導致長逐字稿被截斷。
// - maxOutputTokens 開到上限 65535，容納長逐字稿。
// - responseSchema 強制結構化輸出，segments 陣列做語者辨識。

import { recordUse, recordCooldown } from './usage.js';

const BASE = 'https://generativelanguage.googleapis.com';

// 動態挑選型號：向 API 詢問目前可用的模型，挑最適合做「長音檔 + 語者辨識」的 flash 型號。
// 這樣 Google 汰換型號名稱（如 2.5-flash → 3.5-flash）時 App 不會壞。
export function pickModel(models) {
  const bad = /embedding|aqa|imagen|image|veo|tts|audio-native|gemma|learnlm|robotics|computer-use|live/i;
  const scored = (models || [])
    .map((m) => {
      const name = String(m.name || '').replace(/^models\//, '');
      const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
      if (!methods.includes('generateContent')) return null;
      if (bad.test(name)) return null;
      const ver = (name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
      let score = (ver ? parseFloat(ver) : 0) * 100;
      if (/flash/.test(name) && !/flash-lite/.test(name)) score += 40; // flash：快、免費額度高
      else if (/pro/.test(name)) score += 25;
      else if (/flash-lite/.test(name)) score += 15;
      if (/preview|exp|thinking|latest/.test(name)) score -= 12; // 偏好穩定版
      return { name, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].name : null;
}

async function resolveModel(apiKey) {
  const res = await fetch(`${BASE}/v1beta/models?key=${apiKey}`);
  if (!res.ok) throw new Error(`取得可用型號失敗 (${res.status})：${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const name = pickModel(data.models || []);
  if (!name) throw new Error('這組金鑰找不到可用的辨識型號，請確認金鑰是否正確、或是否已啟用 Gemini API。');
  return name;
}


// 進度回報統一格式：{ phase, pct, message, keyName }。pct 為 null 代表該階段無精確百分比。
function report(onProgress, phase, pct, message, keyName) {
  if (onProgress) onProgress({ phase, pct, message, keyName });
}

async function uploadFile(file, apiKey, onProgress) {
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
  if (!start.ok) throw new Error(`上傳啟動失敗 (${start.status})：${(await start.text()).slice(0, 200)}`);
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
        reject(new Error(`上傳失敗 (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('上傳失敗（網路中斷）'));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function isTransientStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
// 從 429 回應解析 Google 建議的等待秒數（retryDelay），回傳毫秒；沒有則回 0
export function parseRetryDelayMs(bodyText) {
  const m = bodyText && bodyText.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.min(65000, Math.ceil(parseFloat(m[1]) + 1) * 1000) : 0;
}

// 帶自動重試 + 多變體（金鑰/檔案）輪替的 POST：
// variants: 陣列，makeReq(variant) → { url, body }
// - 某變體 429/5xx/網路錯 → 立刻換下一個變體重試（多把金鑰各有各的每分鐘額度、各自的檔案）
// - 全部受限 → 依 Google 建議秒數等待後再整輪重試
async function postJsonRotating(variants, makeReq, onProgress, label) {
  const vs = variants && variants.length ? variants : [{}];
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
      const v = vs[vi % vs.length];
      vi++;
      const multi = vs.length > 1;
      report(onProgress, 'transcribe', null, round === 0 && k === 0 ? label : multi ? '切換金鑰重試中…' : `重試中…（第 ${round} 次）`, v.name);
      const { url, body } = makeReq(v);
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
      throw new Error(`辨識失敗 (${res.status})：${lastText.slice(0, 300)}`);
    }
    if (!sawTransient || round >= MAX_ROUNDS) break;
    const wait = Math.min(35000, retryMs || 8000 * (round + 1));
    if (totalWait + wait > MAX_TOTAL_WAIT) break;
    totalWait += wait;
    report(onProgress, 'transcribe', null, `${vs.length > 1 ? '所有金鑰' : '額度'}暫時受限，等待 ${Math.round(wait / 1000)} 秒後再試…`);
    await sleep(wait);
  }
  if (lastStatus === 403 && /permission|not exist/i.test(lastText)) {
    throw new Error('雲端音檔已過期或無法存取，請按「新增會議」重新上傳這個檔案。');
  }
  if (lastStatus === 429) {
    throw new Error('額度受限，暫時無法完成。稍等 1–2 分鐘再按「繼續」通常就會繼續跑（進度已保存）。若一直卡住，代表這段音檔對免費層的「每分鐘用量」太大，建議到 AI Studio 開通 API 付費（最有效），或用較短的錄音。');
  }
  throw new Error(`辨識失敗 (${lastStatus || ''})：${(lastText || '請重試').slice(0, 300)}`);
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
async function transcribeWindow(uploads, mime, model, start, end, whole, onProgress, label, depth) {
  const range = whole ? '' : `\n\n【只處理 ${mmss(start)} 到 ${mmss(end)} 這段時間範圍】的內容，此範圍以外請完全略過。說話者請從「說話者1」開始標記。`;
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
    const a = await transcribeWindow(uploads, mime, model, start, mid, false, onProgress, label, depth + 1);
    const b = await transcribeWindow(uploads, mime, model, mid, end, false, onProgress, label, depth + 1);
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
  for (let i = 0; i < n; i++) {
    const start = i * WINDOW_SEC;
    const end = Math.min(durationSec, (i + 1) * WINDOW_SEC);
    const label = n > 1 ? `辨識第 ${i + 1}/${n} 段（${mmss(start)}–${mmss(end)}）…` : '辨識語者與逐字稿中…';
    const segs = await transcribeWindow(uploads, mime, model, start, end, false, onProgress, label, 0);
    all.push(...segs);
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
  const r = JSON.parse(out);
  return { actionItems: r.actionItems || [], mainPoints: r.mainPoints || [], qa: r.qa || [] };
}

// 接受字串 / 字串陣列 / {key,name} 陣列，統一成 [{key, name}]（非空 key）
function toKeyObjs(keys) {
  const arr = Array.isArray(keys) ? keys : keys ? [keys] : [];
  return arr
    .map((k) => (typeof k === 'string' ? { key: k, name: '' } : { key: k.key, name: k.name || '' }))
    .filter((o) => o.key);
}

// 把音檔上傳到「每一把金鑰的專案」，回傳 { model, mime, uploads:[{key,name,fileUri}] }
// 這樣之後辨識輪替金鑰時，每把用自己的檔案，不會 403。
export async function uploadForJob(file, apiKeys, onProgress) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰，請先到設定填入。');
  report(onProgress, 'model', 3, '選擇辨識型號中…');
  const model = await resolveModel(kos[0].key);
  const uploads = [];
  let mime = file.type || 'audio/mpeg';
  for (let i = 0; i < kos.length; i++) {
    if (kos.length > 1) report(onProgress, 'upload', 5, `上傳音檔中…（金鑰 ${i + 1}/${kos.length}）`, kos[i].name);
    const info = await uploadFile(file, kos[i].key, onProgress);
    const active = await waitActive(info, kos[i].key, onProgress);
    uploads.push({ key: kos[i].key, name: kos[i].name, fileUri: active.uri });
    mime = active.mimeType || mime;
  }
  return { model, mime, uploads };
}
// 辨識單一時間段（含自動對半再切、多金鑰輪替）。uploads:[{key,fileUri}]
export function transcribeRange(uploads, mime, model, start, end, whole, onProgress, label) {
  return transcribeWindow(uploads, mime, model, start, end, whole, onProgress, label || '辨識中…', 0);
}

// 挑選型號（給切割模式一次用）
export async function pickModelForKeys(apiKeys) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  return resolveModel(kos[0].key);
}
// 把一個音檔（Blob/File）上傳到每一把金鑰的專案，回傳 { uploads:[{key,name,fileUri}], mime }
export async function uploadBlobToKeys(blob, apiKeys, onProgress) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  const uploads = [];
  let mime = blob.type || 'audio/mpeg';
  for (let i = 0; i < kos.length; i++) {
    const info = await uploadFile(blob, kos[i].key, onProgress);
    const active = await waitActive(info, kos[i].key, onProgress);
    uploads.push({ key: kos[i].key, name: kos[i].name, fileUri: active.uri });
    mime = active.mimeType || mime;
  }
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
  `以下是一段會議逐字稿。請依內容整理成三類（全部使用繁體中文）：\n` +
  `- actionItems（待辦事項）：逐條列出，每項結尾標註「[DRI: 負責人]」，判斷不出負責人就寫「[DRI: 待指派]」。\n` +
  `- mainPoints（會議重點）：逐條列出。\n` +
  `- qa（提問／Q&A）：格式「問：… 答：…」，若沒有問答就回傳空陣列。\n\n逐字稿：\n`;

export async function regenerateSummary(segments, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos[0].key);
  return summarizeSegments(segments, kos, model, onProgress);
}

// ---- 翻譯（純文字，很省；一次翻逐字稿+摘要）----
const LANG_LABEL = { en: 'English', ja: '日本語 (Japanese)' };
const TRANSLATE_SCHEMA = {
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
    actionItems: { type: 'array', items: { type: 'string' } },
    mainPoints: { type: 'array', items: { type: 'string' } },
    qa: { type: 'array', items: { type: 'string' } },
  },
  required: ['segments', 'actionItems', 'mainPoints', 'qa'],
};

export async function translateMeeting(transcript, summary, targetLang, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  const label = LANG_LABEL[targetLang] || targetLang;
  report(onProgress, 'model', 3, '選擇型號中…');
  const model = await resolveModel(kos[0].key);
  const payload = {
    segments: transcript || [],
    actionItems: (summary && summary.actionItems) || [],
    mainPoints: (summary && (summary.mainPoints || summary.keyPoints)) || [],
    qa: (summary && summary.qa) || [],
  };
  const prompt =
    `You are a professional meeting-notes translator. Translate ALL text values in the following meeting JSON into ${label}. ` +
    `Also translate the speaker labels (e.g. "說話者1" → an appropriate label such as "Speaker 1" / "話者1"). ` +
    `Keep the EXACT same JSON structure, the same array lengths and the same order — translate the values only, do NOT add, remove, merge or reorder items. ` +
    `In actionItems, keep the "[DRI: ...]" tag format. In qa keep the "問：/答：" style but in ${label} (e.g. "Q:/A:"). Output JSON only.\n\n` +
    JSON.stringify(payload);
  const variants = kos.map((k) => ({ key: k.key, name: k.name }));
  const res = await postJsonRotating(
    variants,
    (v) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: TRANSLATE_SCHEMA,
          maxOutputTokens: 65535,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }),
    onProgress,
    `翻譯成 ${label} 中…`
  );
  const data = await res.json();
  const out =
    data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!out) throw new Error('未取得翻譯結果，請重試。');
  const r = JSON.parse(out);
  return {
    transcript: r.segments || [],
    summary: { actionItems: r.actionItems || [], mainPoints: r.mainPoints || [], qa: r.qa || [] },
  };
}
