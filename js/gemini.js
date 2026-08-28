// Gemini 客戶端：上傳長音檔（Files API）→ 等待處理 → 產生「語者分段逐字稿 + 摘要」
//
// 設計重點（對應需求：長錄音、多語者、手機穩定）：
// - 用 Files API 串流上傳，1 小時以上的大檔不佔滿手機記憶體。
// - thinkingBudget:0：關掉 2.5-flash 預設思考，避免思考 token 吃掉輸出額度導致長逐字稿被截斷。
// - maxOutputTokens 開到上限 65535，容納長逐字稿。
// - responseSchema 強制結構化輸出，segments 陣列做語者辨識。

import { recordUse, recordCooldown, getKeyStatus } from './usage.js';
import { getModelLock } from './settings.js';

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
// 依偏好把可用型號排名（分數高的在前）。取第一名用 pickModel()，
// 需要在首選忙線時退而求其次，就用整份排名。
export function rankModels(models, opts = {}) {
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
  return scored.map((x) => x.name);
}

// 只要最佳的那一個（絕大多數地方用這個）
export function pickModel(models, opts = {}) {
  const list = rankModels(models, opts);
  return list.length ? list[0] : null;
}

// 查型號結果快取（依 preferLite 分開），避免每次都打 ListModels、也避免單把金鑰冷卻就整個失敗
const modelCache = {};
const modelListCache = {};
export function clearModelCache() {
  for (const k in modelCache) delete modelCache[k];
  for (const k in modelListCache) delete modelListCache[k];
}

// 模型忙線記憶：503 是「這個模型現在扛不住」，跟金鑰無關。
// 記住 10 分鐘，期間所有選模型的地方都自動跳過它——
// 否則每一段、每一個功能都要重新撞一次同一面牆（一次 20 秒起跳）。
const BUSY_LS = 'model_busy_until';
// 存 localStorage：忙線記憶要撐得過重新整理。原本只放記憶體，
// 使用者一重開 App 就忘光，每一場都得重新撞一次 3.7 的牆。
function loadBusy() {
  try {
    const o = JSON.parse(localStorage.getItem(BUSY_LS)) || {};
    const m = new Map();
    for (const k in o) if (typeof o[k] === 'number' && o[k] > Date.now()) m.set(k, o[k]);
    return m;
  } catch (_) {
    return new Map();
  }
}
const modelBusyUntil = loadBusy();
function saveBusy() {
  try {
    localStorage.setItem(BUSY_LS, JSON.stringify(Object.fromEntries(modelBusyUntil)));
  } catch (_) {}
}
const MODEL_BUSY_MS = 10 * 60 * 1000;
export function markModelBusy(model, ms = MODEL_BUSY_MS) {
  if (!model) return;
  modelBusyUntil.set(model, Date.now() + ms);
  saveBusy();
}
export function isModelBusy(model) {
  const t = modelBusyUntil.get(model);
  if (!t) return false;
  if (Date.now() > t) {
    modelBusyUntil.delete(model);
    saveBusy();
    return false;
  }
  return true;
}
export function clearModelBusy() {
  modelBusyUntil.clear();
  try {
    localStorage.removeItem(BUSY_LS);
  } catch (_) {}
}
// 使用者指定的型號永遠排第一（它也忙線時 pickNonBusy 仍會往下跳，不會卡死）
function applyLock(list) {
  const lock = getModelLock();
  if (!lock || !list.includes(lock)) return list;
  return [lock, ...list.filter((x) => x !== lock)];
}
// 全部都在忙時退回第一名：用忙的模型碰運氣，也比直接沒有模型可用好
const pickNonBusy = (list) => list.find((m) => !isModelBusy(m)) || list[0];
// apiKeys 可為單把字串或多把陣列 → 多把時逐把嘗試查型號（某把冷卻/失敗會換下一把）
// opts.preferLite: 明確指定要不要用 Flash-Lite（辨識用全域設定；摘要/翻譯固定 false 品質優先）
async function resolveModel(apiKeys, opts = {}) {
  throwIfAborted();
  const lite = opts.preferLite != null ? opts.preferLite : preferLite;
  const ck = String(lite);
  if (modelCache[ck]) {
    const list = modelListCache[ck] && modelListCache[ck].length ? modelListCache[ck] : [modelCache[ck]];
    return pickNonBusy(applyLock(list));
  }
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
    const ranked = rankModels(data.models || [], { preferLite: lite });
    const name = ranked.length ? ranked[0] : null;
    if (name) {
      modelListCache[ck] = ranked;
      modelCache[ck] = name;
      return pickNonBusy(applyLock(ranked));
    }
    lastErr = new Error('這組金鑰找不到可用型號，請確認金鑰是否正確、或是否已啟用 Gemini API。');
  }
  throw lastErr || new Error('取得可用型號失敗');
}


// 進度回報統一格式：{ phase, pct, message, keyName }。pct 為 null 代表該階段無精確百分比。
function report(onProgress, phase, pct, message, keyName) {
  if (onProgress) onProgress({ phase, pct, message, keyName });
}

// 逾時的 fetch。
//
// 原本直接用 fetch()，沒有任何逾時：只要連線卡住（手機切網、基地台換手、
// Google 那端不回），這個 Promise 就永遠不 resolve——重試迴圈停在那一格，
// 備援也永遠輪不到。畫面看起來就是「卡在切換金鑰重試中好幾分鐘」。
// 逾時當成暫時性錯誤處理：換下一把金鑰，或觸發 Groq 備援。
const FETCH_TIMEOUT_MS = 90000;
export const TIMEOUT_MSG = '連線逾時';
async function fetchWithTimeout(url, init, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  // 使用者按停止時也要能立刻中斷這條連線，不必等逾時
  const onAbort = () => ctl.abort();
  abortWaiters.add(onAbort);
  try {
    return await fetch(url, { ...(init || {}), signal: ctl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      if (aborted) throw new Error(ABORT_MSG);
      throw new Error(TIMEOUT_MSG);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    abortWaiters.delete(onAbort);
  }
}

// 從回應中取出模型真正的答案。
//
// 思考型模型（gemini 3.x 起是預設）回傳的 parts 不只一段：可能夾帶「思考摘要」
// （帶 thought: true），也可能把長答案拆成好幾段 text。只讀 parts[0] 會拿到
// 思考內容或半截 JSON，解析必然失敗——而且錯誤看起來像「模型壞掉」，
// 實際上是我們沒把回應讀完整。
function candText(cand) {
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts
    .filter((p) => p && p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
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
  // 重試訊息會蓋掉原本的「辨識第 2/3 段…」，使用者就看不出跑到哪、是不是做了一半。
  // 把段號抽出來，重試與等待時都掛在前面。
  const partTag = (() => {
    const m = (label || '').match(/第\s*\d+\s*\/\s*\d+\s*[段支]/);
    return m ? `${m[0]} · ` : '';
  })();
  const vs = orderVariants(variants && variants.length ? variants : [{}]);
  const MAX_ROUNDS = 4;
  const MAX_TOTAL_WAIT = 150000; // 累計等待超過 ~2.5 分鐘就放棄（避免無限迴圈）
  let totalWait = 0;
  let vi = 0;
  let lastText = '';
  let lastStatus = 0;
  // Groq 備援只試一次（試過就記住），而且**為什麼沒成功要留下來**（見收場那一段）。
  let triedGroq = false;
  const groqNote = { reason: '' };
  const tryGroqRescue = async (st, text) => {
    const 忙 = /UNAVAILABLE|high demand|overloaded/i.test(text || '');
    // st === 0 代表連線層就失敗（逾時／斷線／CORS），根本沒拿到 HTTP 狀態。
    // 這一樣是「Gemini 這條路現在走不通」，備援該接手——原本被這道關卡擋掉。
    const 連線失敗 = !st;
    if (!(st === 429 || isTransientStatus(st) || 忙 || 連線失敗)) {
      groqNote.reason = `Gemini 的狀態是 ${st}，不屬於「額度／忙線／連線失敗」，備援不適用`;
      return null;
    }
    try {
      return await groqTextRescue(makeReq(vs[0]).body, onProgress, act, groqNote);
    } catch (e) {
      // 這裡以前是 `catch (_) {}`。備援自己炸掉是最需要講出來的一種，
      // 因為它長得跟「沒有備援」一模一樣。
      groqNote.reason = String(`Groq 回覆失敗：${(e && e.message) || e}`).slice(0, 200);
      return null;
    }
  };
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    let sawTransient = false;
    let retryMs = 0;
    for (let k = 0; k < vs.length; k++) {
      throwIfAborted();
      const v = vs[vi % vs.length];
      vi++;
      const multi = vs.length > 1;
      // 帶上第幾把金鑰／第幾輪：卡住時看得出「是不是還在動」。
      // 原本只寫「切換金鑰重試中…」，連線掛住時畫面完全靜止，無從分辨。
      const 進度 = multi ? `（金鑰 ${(vi - 1) % vs.length + 1}/${vs.length}${round ? `・第 ${round + 1} 輪` : ''}）` : '';
      report(
        onProgress,
        'transcribe',
        null,
        round === 0 && k === 0 ? label : multi ? `${partTag}切換金鑰重試中…${進度}` : `${partTag}重試中…（第 ${round} 次）`,
        v.name
      );
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
        res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      } catch (e) {
        if (isAbortError(e)) throw e;
        // 逾時／斷線：記下狀態，讓收場訊息與備援判斷有依據（原本這裡什麼都沒留）
        sawTransient = true;
        lastStatus = lastStatus || 0;
        lastText = (e && e.message) || '網路錯誤';
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
      // 真正要據以判斷的狀態：若下面做了去 thinkingConfig 的重試，改看那一次的結果
      let effStatus = res.status;
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
          effStatus = res2.status; // 例如原本 400、重試後變 429（額度用盡）
        } catch (_) {}
      }
      // 重試後若變成額度／伺服器問題 → 回到輪替流程換金鑰或等待，不能當成致命錯誤丟出
      if (effStatus !== res.status && isTransientStatus(effStatus)) {
        sawTransient = true;
        if (effStatus === 429) {
          const d = parseRetryDelayMs(lastText);
          retryMs = Math.max(retryMs, d);
          if (v.key) recordCooldown(v.key, d || 30000);
        }
        continue;
      }
      if (effStatus === 400) {
        // 「換一個音檔」只在請求真的帶了音檔時才是有效建議；
        // 摘要／加強／翻譯／問答都是純文字，講音檔只會誤導（使用者會以為它又去讀錄音）。
        const hasAudio = /file_data|fileData/.test(body);
        throw new Error(
          hasAudio
            ? `${act}失敗 (400)：這個檔案可能格式不支援或已損毀，建議換一個音檔（m4a／mp3／wav）再試。原始訊息：${lastText.slice(0, 200)}`
            : `${act}失敗 (400)：請求被拒絕。原始訊息：${lastText.slice(0, 200)}`
        );
      }
      throw new Error(`${act}失敗 (${effStatus})：${lastText.slice(0, 300)}`);
    }
    if (!sawTransient || round >= MAX_ROUNDS) break;
    // 503 忙線：換金鑰無效（每把打的都是同一個模型），打滿五輪只是空等。
    // 標記這個模型 10 分鐘內忙線（所有選模型的地方會自動跳過它），第 2 輪就放棄，
    // 把「換模型」的決定交還給上層。
    const 這輪忙線 = lastStatus === 503 || /UNAVAILABLE|high demand|overloaded/i.test(lastText || '');
    if (這輪忙線) {
      const m = /models\/([^:?/]+)/.exec((makeReq(vs[0]) || {}).url || '');
      if (m) markModelBusy(m[1]);
      if (round >= 1) break;
    }
    // 【2026-08-24】純文字請求不要等——第一輪全部金鑰都受限就直接轉 Groq。
    //
    // 舊版把 Groq 備援放在迴圈**跑完之後**（最多 5 輪／累計 2.5 分鐘）。對「帶音檔」
    // 的請求那是對的：Llama 聽不了聲音，等 Gemini 是唯一的路。但摘要／問答／翻譯／
    // 專有名詞抽取都是**純文字**，Groq 第一秒就做得了——讓使用者盯著倒數 2.5 分鐘，
    // 換到的是「等完之後才發現本來就不必等」。
    //
    // 503（模型忙線）尤其如此：換金鑰沒有用（每把金鑰打的都是同一個型號），
    // 而等待也只是賭 Google 的負載會掉下來。
    if (!triedGroq) {
      triedGroq = true;
      const 早救 = await tryGroqRescue(lastStatus, lastText);
      if (早救) return 早救;
    }
    const wait = Math.min(35000, retryMs || 8000 * (round + 1));
    if (totalWait + wait > MAX_TOTAL_WAIT) break;
    totalWait += wait;
    // 503 是「這個型號忙不過來」，不是金鑰的問題——措辭不要讓使用者去換金鑰或加額度。
    const 忙線 = lastStatus === 503 || /UNAVAILABLE|high demand|overloaded/i.test(lastText || '');
    report(
      onProgress,
      'transcribe',
      null,
      忙線
        ? `${partTag}型號忙線中（不是你的金鑰問題），等待 ${Math.round(wait / 1000)} 秒後再試…`
        : `${partTag}${vs.length > 1 ? '所有金鑰' : '額度'}暫時受限，等待 ${Math.round(wait / 1000)} 秒後再試…`
    );
    await sleep(wait);
    throwIfAborted();
  }
  if (lastStatus === 403 && /permission|not exist/i.test(lastText)) {
    throw new Error('雲端音檔已過期或無法存取，請按「新增會議」重新上傳這個檔案。');
  }
  // 收場前最後一搏（若迴圈裡那一次還沒試過，例如第一輪就 break 掉）。
  if (!triedGroq) {
    triedGroq = true;
    const 晚救 = await tryGroqRescue(lastStatus, lastText);
    if (晚救) return 晚救;
  }
  // 【2026-08-24】備援為什麼沒生效，一定要講出來。
  //
  // 舊版是 `catch (_) {}`——「Groq 也掛了」「金鑰無效」「prompt 是空的」「根本沒被叫到」
  // 四種情況長成同一句 Gemini 錯誤，使用者結構上分不出來，於是「看起來沒有轉 Groq」
  // 這個觀察永遠無法被證實或推翻。留痕不是禮貌，是讓人能判斷下一步做什麼。
  const 備援註 = groqNote.reason ? `\n（Groq 備援未生效：${groqNote.reason}）` : '';
  if (lastStatus === 503 || /UNAVAILABLE|high demand|overloaded/i.test(lastText || '')) {
    const err = new Error(
      `${act}失敗：這個型號現在忙不過來（503 高負載）。這**不是**你的金鑰或額度的問題——` +
        `每把金鑰打的都是同一個型號，換金鑰、加額度都沒有用。` +
        `建議：到設定改用另一個型號，或等幾分鐘再按一次。${備援註}`
    );
    err.geminiStatus = 503; // 結構化標記：isModelOverloaded 靠這個，不靠比對訊息文字
    throw err;
  }
  if (lastStatus === 429) {
    throw new Error(
      '額度受限，暫時無法完成。稍等 1–2 分鐘再按「繼續」通常就會繼續跑（進度已保存）。' +
        '若一直卡住，代表這段音檔對免費層的「每分鐘用量」太大，建議到 AI Studio 開通 API 付費（最有效），或用較短的錄音。' +
        備援註
    );
  }
  throw new Error(`${act}失敗 (${lastStatus || ''})：${(lastText || '請重試').slice(0, 300)}${備援註}`);
}

// 把「純文字的 Gemini 請求」轉成 Groq（Llama）請求，並把回覆包回 Gemini 的回應形狀，
// 讓上層所有解析程式（candText → JSON.parse → 各自的 schema 檢查）原封不動照用。
// 轉不了（帶音檔／沒設 Groq 金鑰）回傳 null，由呼叫端照原本的方式收場。
async function groqTextRescue(geminiBody, onProgress, act, note) {
  // 【2026-08-24】每一條「轉不了」都要寫進 note.reason。
  // 這支函式原本四個出口全部 `return null`，於是呼叫端只知道「沒救到」，
  // 分不出是「帶音檔本來就轉不了」還是「你根本沒填 Groq 金鑰」——
  // 而這兩件事使用者要做的處置完全不同。
  const 記 = (why) => {
    if (note) note.reason = why;
    return null;
  };
  if (/file_data|fileData/.test(geminiBody)) return 記('這個請求帶了音檔，Llama 聽不了聲音，只能等 Gemini');
  const { hasGroqKey, getGroqKey, groqChatText } = await import('./groq.js');
  if (!hasGroqKey()) {
    // 這是唯一「使用者當下就能自己修好」的原因，不能等到最後報錯才講——
    // 使用者常在等待中途就取消，那一行原因就永遠沒人看到。
    report(onProgress, 'transcribe', null, '⚠️ 這台裝置未設定 Groq 金鑰，無法啟用備援（設定 → Groq 備援金鑰）。繼續等 Gemini…');
    return 記('尚未設定 Groq 金鑰（設定 → 貼上 gsk_ 開頭的金鑰）');
  }
  const o = JSON.parse(geminiBody);
  const prompt = (o.contents || [])
    .map((c) => ((c && c.parts) || []).map((p) => (p && p.text) || '').join('\n'))
    .join('\n');
  if (!prompt.trim()) return 記('這個請求沒有可轉成純文字的內容');
  const wantJson = !!(o.generationConfig && o.generationConfig.responseMimeType === 'application/json');
  report(onProgress, 'transcribe', null, `Gemini 忙線／額度受限，${act}改用 Groq（Llama）…`);
  const content = await groqChatText(
    wantJson ? prompt + '\n\n只輸出符合上述要求的 JSON 物件，不要輸出任何其他文字。中文一律用繁體中文（台灣用語）。' : prompt,
    getGroqKey(),
    wantJson
  );
  const fake = { candidates: [{ content: { parts: [{ text: content }] } }] };
  return { ok: true, status: 200, json: async () => fake, text: async () => content };
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
        // t：這句開始的秒數（相對於這個音檔的開頭）。選填 —— 模型沒給也不能讓整段辨識失敗。
        properties: { speaker: { type: 'string' }, text: { type: 'string' }, t: { type: 'number' } },
        required: ['speaker', 'text'],
      },
    },
  },
  required: ['segments'],
};
const SEG_PROMPT =
  `你是專業會議記錄助理。請把這段會議錄音整理成「語者分段逐字稿」：\n` +
  `- 辨識不同說話者，標記「說話者1」「說話者2」…同一個人自始至終用同一標籤。\n` +
  // 舊寫法「中文一律使用繁體中文，英文保留原文」被新模型讀成「輸出要是中文」，
  // 整場英文會議被翻譯掉——逐字稿的第一原則必須明寫：照錄，不翻譯。
  `- 逐字稿要「原文照錄」：說話者說什麼語言就寫什麼語言，**絕對不可翻譯**。英文就寫英文、日文就寫日文。\n` +
  `- 只有說話內容本身是中文時，才以繁體中文（台灣用語）書寫，不用簡體。\n` +
  `- 每個 segment 格式 {"speaker":"說話者1","text":"…","t":秒數}，適度斷句。
` +
  `- t 是這句開始的「秒數」，相對於這個音檔開頭（整數即可）。抓不準就略過該句的 t，不要亂猜。`;

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
  const text = candText(cand);
  const truncated = cand && cand.finishReason === 'MAX_TOKENS';
  let segments = null;
  if (text) {
    try {
      segments = ((JSON.parse(text).segments) || []).map((s) => {
        // 時間戳只在「是有限的非負數字」時才留；模型偶爾會回負數或字串，寧可沒有也不要錯的
        const t = typeof s.t === 'number' && isFinite(s.t) && s.t >= 0 ? Math.round(s.t) : null;
        const out = { speaker: s.speaker, text: s.text };
        if (t != null) out.t = t;
        return out;
      });
    } catch (_) {
      segments = null;
    }
  }
  // 內容太密被截斷 / 回應解析不出來 → 對半再問一次
  if ((truncated || segments === null) && depth < 4 && end - start > 120) {
    if (whole) {
      // 切段模式：上傳的就是「這一段」的音檔，時間從 0 開始算。
      // 原本這條路完全沒有補救，一次失敗整段就報廢；改成在這個檔案內對半再問。
      const dur = end - start;
      const mid = Math.floor(dur / 2);
      const a = await transcribeWindow(uploads, mime, model, 0, mid, false, onProgress, label, depth + 1, hintSpeakers);
      const b = await transcribeWindow(uploads, mime, model, mid, dur, false, onProgress, label, depth + 1, hintSpeakers);
      return a.concat(b);
    }
    const mid = Math.floor((start + end) / 2);
    const a = await transcribeWindow(uploads, mime, model, start, mid, false, onProgress, label, depth + 1, hintSpeakers);
    const b = await transcribeWindow(uploads, mime, model, mid, end, false, onProgress, label, depth + 1, hintSpeakers);
    return a.concat(b);
  }
  if (segments === null) {
    if (truncated) throw new Error('這段錄音內容太密集，無法完整辨識，請重試一次。');
    // 把模型實際回了什麼帶出來。只寫「解析失敗」等於把唯一的線索丟掉，
    // 下次再發生還是只能猜（安全阻擋、空回應、格式跑掉是完全不同的問題）。
    const reason =
      (cand && cand.finishReason) ||
      (data && data.promptFeedback && data.promptFeedback.blockReason) ||
      '未回報';
    const peek = text ? `回應開頭：${String(text).slice(0, 120)}` : '這次回應沒有任何文字內容。';
    throw new Error(`辨識結果解析失敗，請重試一次。（型號 ${model}／finishReason: ${reason}）${peek}`);
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
    candText(data && data.candidates && data.candidates[0]);
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

// 音檔要上傳到「每一把金鑰的專案」才能輪替（Gemini 的檔案綁專案）。
// 但金鑰越多，上傳量就線性暴增：5 把 × 110 分鐘（4 段 × 55MB）= 1.1GB，手機根本傳不完。
// 因此設上限：只挑幾把上傳。挑選依據是「今日用得少、且沒在冷卻」的優先。
export const MAX_UPLOAD_KEYS = 3;
export function pickUploadKeys(kos, max = MAX_UPLOAD_KEYS) {
  const list = toKeyObjs(kos);
  if (list.length <= max) return list;
  return list
    .map((k, i) => {
      const st = k.key ? getKeyStatus(k.key) : { count: 0, cooling: 0 };
      return { k, i, cooling: st.cooling, count: st.count };
    })
    .sort((a, b) => (a.cooling !== b.cooling ? a.cooling - b.cooling : a.count !== b.count ? a.count - b.count : a.i - b.i))
    .slice(0, max)
    .map((x) => x.k);
}

// 整檔模式：每一次請求都要把「完整音檔」送出去。錄音只要超過一個時間窗，
// 就會被重複送好幾次（180 分鐘 = 每次 34.5 萬 token × 5 次），免費層必定卡死。
// 所以長錄音在無法切割時要明確失敗，而不是進入一個贏不了的重試迴圈。
export function canUseWholeMode(durationSec) {
  if (!durationSec) return true; // 長度未知 → 保守允許，不要擋掉本來能跑的短檔
  return durationSec <= WINDOW_SEC;
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
  const all = toKeyObjs(apiKeys);
  if (!all.length) throw new Error('尚未設定 API 金鑰，請先到設定填入。');
  report(onProgress, 'model', 3, '選擇辨識型號中…');
  const model = await resolveModel(all.map((k) => k.key));
  const kos = pickUploadKeys(all); // 金鑰太多時只挑幾把，避免上傳量暴增
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

// 首選型號忙線（503 高負載）時要換一個。回傳排名中的下一個，沒有就 null。
export async function nextModelForKeys(apiKeys, current, opts = {}) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) return null;
  const lite = opts.preferLite != null ? opts.preferLite : preferLite;
  const ck = String(lite);
  if (!modelListCache[ck]) {
    try {
      await resolveModel(kos.map((k) => k.key), opts);
    } catch (_) {
      return null;
    }
  }
  const list = applyLock(modelListCache[ck] || []);
  const i = list.indexOf(current);
  if (i < 0) return null;
  // 往清單下方找第一個「不在忙線中」的：3.6 也忙就再往下（3.6-lite、2.5…）
  for (let j = i + 1; j < list.length; j++) if (!isModelBusy(list[j])) return list[j];
  return null;
}

// 429 收場（所有金鑰輪完、等待也等完仍失敗）：這是「Gemini 額度暫時見底」。
// 判斷依據是上面 429 收場訊息的固定開頭；改那段訊息時這裡要一起改。
export function isQuotaStall(e) {
  return /額度受限，暫時無法完成/.test((e && e.message) || '');
}

// 內容被安全過濾器擋下（PROHIBITED_CONTENT / SAFETY）。
// 這不是重試能解的：對半再問、換金鑰都沒用，過濾器照樣擋。
// 唯一有效的出路是換一個沒有這種過濾的引擎（Whisper）或換型號。
export function isContentBlocked(e) {
  return /PROHIBITED_CONTENT|finishReason:\s*SAFETY|blockReason/i.test((e && e.message) || '');
}

// 把一批文字轉成繁體中文（台灣用語）。給 Groq（Whisper）備援路線用：
// Whisper 中文常輸出簡體。純文字請求 token 很便宜，固定走省額度模型。
// 轉換失敗不丟錯——寧可給簡體逐字稿，也不能讓已經辨識完的內容整段作廢。
const S2T_SCHEMA = {
  type: 'object',
  properties: { texts: { type: 'array', items: { type: 'string' } } },
  required: ['texts'],
};
export async function convertToTraditional(texts, apiKeys, onProgress) {
  const kos = toKeyObjs(apiKeys);
  if (!texts || !texts.length || !kos.length) return texts;
  let model;
  try {
    model = await resolveModel(kos.map((k) => k.key), { preferLite: true });
  } catch (_) {
    return texts;
  }
  const BATCH = 80;
  const out = texts.slice();
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    try {
      const res = await postJsonRotating(
        kos,
        (ko) => ({
          url: `${BASE}/v1beta/models/${model}:generateContent?key=${ko.key}`,
          body: JSON.stringify({
            contents: [{ parts: [{ text:
              `把下列 ${batch.length} 句裡的「簡體中文」轉成繁體中文（台灣用語）。只做簡繁與用語轉換，不改寫、不增刪內容、不合併句子。` +
              `不是中文的句子（英文、日文等）原樣輸出，絕對不可翻譯。` +
              `輸出 texts 陣列，長度必須是 ${batch.length}，順序不變。\n\n` +
              batch.map((t, j) => `${j + 1}. ${t}`).join('\n') }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: S2T_SCHEMA, maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
          }),
        }),
        onProgress,
        '轉繁體中'
      );
      const data = await res.json();
      const t = candText(data && data.candidates && data.candidates[0]);
      const arr = JSON.parse(t).texts;
      // 長度不符代表模型亂動了內容 → 這批放棄轉換，保留原文
      if (Array.isArray(arr) && arr.length === batch.length) {
        for (let j = 0; j < batch.length; j++) {
          const s = arr[j];
          if (typeof s === 'string' && s.trim()) out[i + j] = s.replace(/^\d+\.\s*/, '');
        }
      }
    } catch (e) {
      // 額度見底時每一批都會白白等一輪（一批最多等 2.5 分鐘）。
      // 第一批就撞牆代表後面的批次也過不了 → 直接放棄整個轉換，保留原文。
      if (isQuotaStall(e)) break;
      // 其他錯誤只放棄這一批，繼續下一批
    }
  }
  return out;
}

// 設定頁下拉選單用：回傳這把金鑰能用的完整型號清單（依品質排名），
// 並附上目前是否在忙線記憶中，讓使用者看得到「哪個現在塞車」。
export async function getModelChoices(apiKeys) {
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) return [];
  await resolveModel(kos.map((k) => k.key), { preferLite: false });
  return (modelListCache['false'] || []).map((m) => ({ name: m, busy: isModelBusy(m) }));
}

// 503／UNAVAILABLE：這是「這個型號現在忙不過來」，不是金鑰或音檔的問題。
// 換金鑰沒有用——每把金鑰打的都是同一個型號。
export function isModelOverloaded(e) {
  // 結構化標記優先：postJsonRotating 丟忙線錯誤時會掛上 geminiStatus。
  // 教訓：v89 把收場訊息改寫成中文「忙不過來（503 高負載）」（全形括號），
  // 這裡的 /\(503\)/（半形）就再也比對不到——「忙線換模型」整條鏈默默失效，
  // 直到使用者發現「錯誤裡看不到有試 3.6」。判斷不能只靠比對人類看的文字。
  if (e && e.geminiStatus === 503) return true;
  const m = (e && e.message) || '';
  return /\(503\)|UNAVAILABLE|high demand|overloaded|忙不過來|503 高負載/i.test(m);
}
// 把一個音檔（Blob/File）上傳到每一把金鑰的專案，回傳 { uploads:[{key,name,fileUri}], mime }
export async function uploadBlobToKeys(blob, apiKeys, onProgress, opts = {}) {
  const all = toKeyObjs(apiKeys);
  if (!all.length) throw new Error('尚未設定 API 金鑰');
  // opts.exact=true 表示呼叫端已經指定好要傳哪幾把（例如補傳缺席金鑰），不要再挑
  const kos = opts.exact ? all : pickUploadKeys(all);
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
export const SUMMARY_PROMPT =
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
  // 批次大 → 請求少。免費層真正稀缺的是「每日請求數」，不是單次請求的大小：
  // 142 分鐘的逐字稿用 80 句一批要打 12+ 次，240 句一批只要 4 次。
  // 安全網：單批輸出被截斷／解析失敗就對半重試，回到小批次，完整性不變。
  const BATCH = 240;
  const MIN_BATCH = 60;
  const total = segs.length;
  const all = [];
  const runRange = async (from, to) => {
    const text = segs.slice(from, to).map((s) => `${s.speaker}：${s.text}`).join('\n');
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
      `加強${meta.label}中…（第 ${from + 1}–${to} 句／共 ${total} 句）`
    );
    const data = await res.json();
    const out = candText(data && data.candidates && data.candidates[0]);
    let r = null;
    if (out) {
      try {
        r = JSON.parse(out);
      } catch (_) {
        r = null;
      }
    }
    if (!r) {
      // 輸出壞掉（截斷／格式跑掉）→ 對半重試；額度類錯誤不會走到這裡（上面直接 throw）
      if (to - from > MIN_BATCH) {
        const mid = (from + to) >> 1;
        await runRange(from, mid);
        await runRange(mid, to);
        return;
      }
      // 批次失敗就 throw（不可靜默吞掉 → 否則整區被「缺一批」的不完整清單取代）
      throw new Error(`加強${meta.label}時第 ${from + 1}–${to} 句解析失敗，請重試`);
    }
    if (Array.isArray(r.items)) all.push(...r.items);
  };
  for (let i = 0; i < total; i += BATCH) await runRange(i, Math.min(total, i + BATCH));
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
  const out = candText(data && data.candidates && data.candidates[0]);
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
    candText(data && data.candidates && data.candidates[0]);
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
  // 批次策略同 enhanceSection：批次大省請求數，單批壞掉就對半重試。
  const BATCH = 240;
  const MIN_BATCH = 60;
  const total = segs.length;
  const map = new Map(); // term → item（跨批次去重）
  const runRange = async (from, to) => {
    const text = segs.slice(from, to).map((s) => `${s.speaker}：${s.text}`).join('\n');
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
      `挑出專有名詞中…（第 ${from + 1}–${to} 句／共 ${total} 句）`
    );
    const data = await res.json();
    const out = candText(data && data.candidates && data.candidates[0]);
    let r = null;
    if (out) {
      try {
        r = JSON.parse(out);
      } catch (_) {
        r = null;
      }
    }
    if (!r) {
      if (to - from > MIN_BATCH) {
        const mid = (from + to) >> 1;
        await runRange(from, mid);
        await runRange(mid, to);
      }
      // 掃詞向來允許單批漏掉（寧可少挑幾個詞也不中斷整個掃描）→ 縮到最小仍壞就略過
      return;
    }
    for (const it of r.items || []) {
      const term = (it.term || '').trim();
      if (!term) continue;
      if (!map.has(term)) map.set(term, { t: term, cat: it.category || 'term', fix: (it.fix || '').trim() });
    }
  };
  for (let i = 0; i < total; i += BATCH) await runRange(i, Math.min(total, i + BATCH));
  const items = Array.from(map.values());
  if (items.length < 2) return items;
  return await groupTermVariants(items, variants, model, onProgress);
}

// 同一個名字常被聽成好幾種寫法（合訊／和迅／禾訊），而且往往散在不同批次，
// 批次內看不到彼此。這裡拿「全部詞彙」再問一次，把同一實體的寫法歸成一組：
// 之後訂正一次就能把所有寫法一起改掉，不必自己一個個發現、一個個補。
const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { terms: { type: 'array', items: { type: 'string' } }, best: { type: 'string' } },
        required: ['terms'],
      },
    },
  },
  required: ['groups'],
};

async function groupTermVariants(items, variants, model, onProgress) {
  const list = items.map((x) => x.t);
  const prompt =
    `以下是同一場會議逐字稿裡挑出的專有名詞清單。語音辨識常把同一個名字聽成好幾種寫法。\n` +
    `請找出「其實指同一個實體」的寫法，把它們歸成一組。\n` +
    `- 只在你有把握是同一個實體時才歸組（發音相近、字形相近、上下文明顯同指）。不確定就不要歸。\n` +
    `- 每組的 terms 只能填「清單裡出現過的字串」，不可自行新增。\n` +
    `- best 填這一組最可能的正確寫法（可以是清單裡沒有的正確字），無法判斷就留空字串。\n` +
    `- 只有一種寫法、沒有變體的詞，不要放進 groups。\n` +
    `只輸出 JSON {"groups":[{"terms":["…","…"],"best":"…"}]}。\n\n清單：\n` +
    list.map((t) => `- ${t}`).join('\n');
  let groups = [];
  try {
    const res = await postJsonRotating(
      variants,
      (v) => ({
        url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: GROUP_SCHEMA, maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }),
      onProgress,
      '比對同一名稱的不同寫法…'
    );
    const data = await res.json();
    const out = candText(data && data.candidates && data.candidates[0]);
    groups = (JSON.parse(out).groups) || [];
  } catch (_) {
    return items.map((x) => ({ ...x, alts: [] })); // 分組失敗不影響主流程
  }
  return mergeTermGroups(items, groups);
}

// 依分組結果合併：主寫法取「最先出現的那個」，其餘進 alts；best 當作建議寫法
export function mergeTermGroups(items, groups) {
  const byTerm = new Map(items.map((x) => [x.t, x]));
  const takenBy = new Map(); // 變體 → 主寫法
  const altsOf = new Map(); // 主寫法 → 變體清單
  for (const g of groups || []) {
    // 只認清單裡真的存在、且尚未被別組認領的詞（防模型憑空生詞或重複歸組）
    const terms = (g && Array.isArray(g.terms) ? g.terms : [])
      .map((t) => String(t || '').trim())
      .filter((t) => byTerm.has(t) && !takenBy.has(t));
    if (terms.length < 2) continue;
    const head = items.find((x) => terms.includes(x.t)).t; // 依原順序取最先出現的當主寫法
    const rest = terms.filter((t) => t !== head);
    rest.forEach((t) => takenBy.set(t, head));
    takenBy.set(head, head);
    altsOf.set(head, rest);
    const best = String((g && g.best) || '').trim();
    if (best) byTerm.get(head).fix = best;
  }
  return items
    .filter((x) => !takenBy.has(x.t) || takenBy.get(x.t) === x.t)
    .map((x) => ({ ...x, alts: altsOf.get(x.t) || [] }));
}

// ---- 學習筆記（研討會／上課用）----
// 會議摘要的框架是「決定了什麼」（待辦/重點/Q&A），對一頁頁過投影片的課程完全不適用：
// 表格會被壓成散文、概念沒有解釋、數字散落在句子裡。這裡改用「複習」的框架重整。
// 逐字稿沒有時間戳，所以章節用「原話錨點」定位，交給既有的文字比對跳到出處。
// 什麼才算「關鍵數據」——一次生成與分區加強共用同一套判準。
// 沒有這層篩選時，模型會把「四位講者」「5G」這種數字也當成數據列出來，複習時全是雜訊。
const FIGURE_RULE =
  `只收「數字本身承載技術或商業資訊」的：規格、量測值、效能、成本、比例、時程、產能、市場規模。
` +
  `以下一律「不算」關鍵數據，不要列出：
` +
  `  (a) 會議進行的數量（幾位講者、第幾頁投影片、休息幾分鐘、Q&A 幾分鐘）；
` +
  `  (b) 數字只是名稱的一部分（5G、3D、Q&A、B200、EMIB-T 這類型號、世代或代號）；
` +
  `  (c) 沒有單位也沒有比較基準的孤立數字。
` +
  `每筆拆成三欄：label＝這個數字在講什麼（主題在前，不含數字）；value＝數值連同單位；
` +
  `group＝主題分組名稱（4～8 字，例如「市場規模」「產能與良率」「公司與團隊」「技術規格」），
` +
  `同一類的數據要用「完全相同」的 group 名稱，讓它們能排在一起互相對照。
` +
  `例如 {"group":"市場規模","label":"2030 年 FOPLP／GCS 預估","value":"81.1 億美元"}。
` +
  `⚠️ 若一筆數據本質是「A 與 B 的對比」（例如 620×750 mm 可容納 9 個、300×300 mm 只能容納 1 個），
` +
  `不要硬塞成一行關鍵數據，改整理到「對照表」裡。
`;

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    outline: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, anchor: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } },
        required: ['title', 'points'],
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, plain: { type: 'string' }, why: { type: 'string' } },
        required: ['term', 'plain'],
      },
    },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          headers: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['title', 'headers', 'rows'],
      },
    },
    figures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { group: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' } },
        required: ['label', 'value'],
      },
    },
    quiz: {
      type: 'array',
      items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] },
    },
  },
  required: ['outline', 'concepts', 'tables', 'figures', 'quiz'],
};

const NOTES_PROMPT =
  `以下是一場研討會／課程的逐字稿。請整理成「複習用的學習筆記」，` +
  `使用與逐字稿相同的主要語言（中文用繁體中文、台灣用語）。\n` +
  `- outline（章節大綱）：依講述順序分節。title 為 8～20 字的主題；points 列出該節重點；` +
  `anchor 填該節開始處逐字稿中的「一句原話」（10～20 字，必須是逐字稿裡真的出現過的字串，供跳轉定位，不可自行改寫）。\n` +
  `- concepts（重要概念）：挑出需要理解的名詞或機制。term＝名詞本身；plain＝用白話說明它是什麼；why＝為什麼重要／用在哪裡。\n` +
  `- tables（對照表）：把「多項目 × 多屬性」的內容還原成表格（技術優缺點比較、規格對照、各家差異等）。` +
  `headers 是欄位名，rows 每一列的長度必須與 headers 相同。沒有適合的內容就回空陣列，不要硬湊。\n` +
  `- figures（關鍵數據）：` + FIGURE_RULE +
  `- quiz（自我測驗）：依內容出題幫助主動回想。a 必須是逐字稿裡找得到依據的答案；沒有答案的題目不要出。\n` +
  `務求忠於逐字稿，不可自行補充逐字稿沒有講到的知識。\n\n逐字稿：\n`;

const asStr = (x) => (typeof x === 'string' ? x.trim() : '');
const asArr = (x) => (Array.isArray(x) ? x : []);

// 把模型回傳正規化成穩定結構（欄位缺漏、表格列被回成字串等都要容忍）
export function normalizeNotes(r) {
  const o = r || {};
  return {
    outline: asArr(o.outline)
      .map((x) => ({ title: asStr(x && x.title), anchor: asStr(x && x.anchor), points: asArr(x && x.points).map(asStr).filter(Boolean) }))
      .filter((x) => x.title),
    concepts: asArr(o.concepts)
      .map((x) => ({ term: asStr(x && x.term), plain: asStr(x && x.plain), why: asStr(x && x.why) }))
      .filter((x) => x.term),
    tables: asArr(o.tables)
      .map((t) => {
        const headers = asArr(t && t.headers).map(asStr).filter(Boolean);
        const rows = asArr(t && t.rows)
          // 有時模型會把整列回成 "a | b | c" 字串而不是陣列
          .map((row) => (Array.isArray(row) ? row.map(asStr) : asStr(row).split('|').map((s) => s.trim())))
          .filter((row) => row.some(Boolean));
        return { title: asStr(t && t.title), headers, rows };
      })
      .filter((t) => t.headers.length && t.rows.length), // 沒有資料列的表格不留空殼
    figures: asArr(o.figures)
      .map((f) => {
        // 舊資料是「數值：說明」的純字串 → 轉成標籤在前、數值在後的新結構
        if (typeof f === 'string') {
          const t = f.trim();
          const m = t.match(/^([^：:]{1,24})[：:]\s*(.+)$/);
          return m ? { group: '', label: m[2].trim(), value: m[1].trim() } : { group: '', label: t, value: '' };
        }
        return { group: asStr(f && f.group), label: asStr(f && f.label), value: asStr(f && f.value) };
      })
      .filter((f) => f.label),
    quiz: asArr(o.quiz)
      .map((x) => ({ q: asStr(x && x.q), a: asStr(x && x.a) }))
      .filter((x) => x.q),
  };
}

// 產生學習筆記（整份逐字稿一次生成，快且省；不夠完整時再用分區加強補）
export async function generateNotes(segments, apiKeys, opts = {}) {
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false }); // 學習筆記固定用品質模型
  const text = (segments || []).map((s) => `${s.speaker}：${s.text}`).join('\n');
  const res = await postJsonRotating(
    kos.map((k) => ({ key: k.key, name: k.name })),
    (v) => ({
      url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
      body: JSON.stringify({
        contents: [{ parts: [{ text: NOTES_PROMPT + text }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: NOTES_SCHEMA,
          maxOutputTokens: 65535,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }),
    onProgress,
    '整理學習筆記中…'
  );
  const data = await res.json();
  const out =
    candText(data && data.candidates && data.candidates[0]);
  if (!out) throw new Error('未取得學習筆記，請重試。');
  let r;
  try {
    r = JSON.parse(out);
  } catch (_) {
    throw new Error('學習筆記解析失敗，請重試。');
  }
  return normalizeNotes(r);
}

// 學習筆記的分區加強：一次生成是「整份讀完憑印象整理」，長課程必漏。
// 這裡分批掃過整份逐字稿，確保每一段都被讀到，再跨批合併去重。
const NOTES_SECTIONS = {
  outline: { label: '章節大綱', instr: '逐一列出這段講述的「全部」章節，不要精簡、不要只挑重要的。title 為 8～20 字主題；points 為該節重點；anchor 填該節開始處逐字稿中的一句原話（10～20 字，必須真的出現過）' },
  concepts: { label: '重要概念', instr: '把這段出現、需要理解的名詞或機制「全部」列出，不要精簡、不要只挑最重要的幾個。term＝名詞；plain＝白話說明；why＝為什麼重要' },
  tables: { label: '對照表', instr: '把這段中「全部」可整理成「多項目 × 多屬性」的內容都還原成表格，不要精簡、不要只做一張。rows 每列長度必須與 headers 相同；沒有就回空陣列，不要硬湊' },
  figures: { label: '關鍵數據', instr: '列出這段裡符合下列標準的「全部」數據，不要精簡。\n' + FIGURE_RULE },
  quiz: { label: '自我測驗', instr: '針對這段的「每一個」重要知識點都出一題，全部列出，不要精簡、不要只出幾題；答案必須在這段裡找得到依據' },
};

export async function enhanceNotesSection(segments, section, apiKeys, opts = {}) {
  const meta = NOTES_SECTIONS[section];
  if (!meta) throw new Error('未知的區塊');
  const onProgress = opts.onProgress;
  const kos = toKeyObjs(apiKeys);
  if (!kos.length) throw new Error('尚未設定 API 金鑰');
  const model = await resolveModel(kos.map((k) => k.key), { preferLite: false });
  const variants = kos.map((k) => ({ key: k.key, name: k.name }));
  const schema = { type: 'object', properties: { [section]: NOTES_SCHEMA.properties[section] }, required: [section] };
  const segs = segments || [];
  const BATCH = 80;
  const nb = Math.max(1, Math.ceil(segs.length / BATCH));
  const all = [];
  for (let i = 0; i < segs.length; i += BATCH) {
    const text = segs.slice(i, i + BATCH).map((s) => `${s.speaker}：${s.text}`).join('\n');
    const prompt =
      `以下是一場研討會／課程逐字稿的其中一段。請${meta.instr}。` +
      `使用與逐字稿相同的主要語言，忠於逐字稿、不可自行補充沒講到的內容。` +
      `這段沒有相關內容就回空陣列。只輸出 JSON {"${section}":[...]}。\n\n逐字稿：\n` +
      text;
    const res = await postJsonRotating(
      variants,
      (v) => ({
        url: `${BASE}/v1beta/models/${model}:generateContent?key=${v.key}`,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 65535, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }),
      onProgress,
      `加強${meta.label}中…（${Math.floor(i / BATCH) + 1}/${nb}）`
    );
    const data = await res.json();
    const out = candText(data && data.candidates && data.candidates[0]);
    if (!out) throw new Error(`加強${meta.label}時第 ${Math.floor(i / BATCH) + 1} 批無回應，請重試`);
    let r;
    try {
      r = JSON.parse(out);
    } catch (_) {
      throw new Error(`加強${meta.label}時第 ${Math.floor(i / BATCH) + 1} 批解析失敗，請重試`);
    }
    all.push(...normalizeNotes({ [section]: r[section] })[section]);
  }
  return dedupeNotesItems(section, all);
}

// 跨批合併：各區的「同一件事」判準不同
export function dedupeNotesItems(section, all) {
  if (section === 'outline') {
    // 章節有順序，不可重排；只把相鄰的同名章節併起來（同一主題被切在兩批）
    const out = [];
    for (const o of all) {
      const prev = out[out.length - 1];
      if (prev && prev.title === o.title) {
        prev.points = prev.points.concat((o.points || []).filter((p) => !prev.points.includes(p)));
        continue; // anchor 保留最先出現的（那才是這節真正的開頭）
      }
      out.push({ ...o, points: (o.points || []).slice() });
    }
    return out;
  }
  const keyOf = { concepts: (x) => x.term, tables: (x) => x.title, quiz: (x) => x.q, figures: (x) => (x && x.label) || '' };
  const seen = new Set();
  const out = [];
  for (const x of all) {
    const k = keyOf[section](x);
    if (!k || seen.has(k)) continue; // 先出現的保留
    seen.add(k);
    out.push(x);
  }
  return out;
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
  const out = candText(cand);
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

  // 1b) 學習筆記（有才翻；結構固定，交給同一套「只翻值、不動結構」的流程）
  let notesOut = null;
  const srcNotes = opts.notes;
  const hasNotes =
    srcNotes && ['outline', 'concepts', 'tables', 'figures', 'quiz'].some((k) => (srcNotes[k] || []).length);
  if (hasNotes) {
    const raw = await translatePayload(
      variants,
      model,
      label,
      {
        outline: srcNotes.outline || [],
        concepts: srcNotes.concepts || [],
        tables: srcNotes.tables || [],
        figures: srcNotes.figures || [],
        quiz: srcNotes.quiz || [],
      },
      NOTES_SCHEMA,
      onProgress,
      `翻譯學習筆記成 ${label}…`
    );
    notesOut = normalizeNotes(raw);
  }

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
    ...(notesOut ? { notes: notesOut } : {}),
  };
}
