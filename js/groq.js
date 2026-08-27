// Groq（Whisper）語音轉文字：Gemini 卡死時的備援引擎。
//
// 定位：只在 Gemini 額度用盡或型號忙線時接手「這一段」的辨識，
// 讓長錄音一定跑得完。代價是 Whisper 分不出說話者（統一標「說話者」），
// 中文常輸出簡體（由上層再用 Gemini 純文字便宜地轉繁體）。
//
// 額度（免費層，2026-08 查證）：每天 28,800 秒音訊、每小時 7,200 秒、
// 單檔上限 25MB。額度與 Gemini 完全獨立，這正是它當備援的價值。

import { buildAdts, frameAtTime } from './mp4.js';
import { SUMMARY_PROMPT } from './gemini.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
// 文字模型不寫死。之前寫死 llama-3.3-70b-versatile，Groq 2026-06 把它
// 從免費層下架後備援就 404——跟 Gemini 那邊「模型跟著平台變」是同一類問題。
// 改成問 Groq 有什麼、按偏好挑（偏好順序：官方建議的替代者優先）。
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const LLM_PREFER = [/gpt-oss-120b/i, /qwen/i, /llama.*(70b|maverick|scout)/i, /gpt-oss/i, /llama/i];
// 不能拿來聊天的：語音、安全過濾、嵌入、語音合成
const LLM_EXCLUDE = /whisper|tts|guard|embed|allam|moderation/i;
let llmCache = null;
export function resetGroqModelCache() {
  llmCache = null;
}
async function pickGroqLLM(apiKey) {
  if (llmCache) return llmCache;
  const res = await fetchT(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } }, 20000);
  if (!res.ok) throw new Error(describeGroqError(res.status, await res.text()));
  const data = await res.json();
  const ids = ((data && data.data) || []).map((m) => m && m.id).filter((id) => id && !LLM_EXCLUDE.test(id));
  for (const re of LLM_PREFER) {
    const hit = ids.find((id) => re.test(id));
    if (hit) {
      llmCache = hit;
      return hit;
    }
  }
  if (ids.length) {
    llmCache = ids[0];
    return ids[0];
  }
  throw new Error('這把 Groq 金鑰查不到可用的文字模型。');
}

// 單一請求的上限：檔案 25MB（免費層）。留餘裕給 multipart 邊界與標頭。
const MAX_SLICE_BYTES = 23 * 1024 * 1024;
// 單一請求的音訊長度上限。太長的話一次 429 重傳成本高，20 分鐘是流量與成本的折衷。
const MAX_SLICE_SEC = 20 * 60;

const KEY = 'groq_api_key';
export function getGroqKey() {
  return (localStorage.getItem(KEY) || '').trim();
}
export function setGroqKey(v) {
  const k = (v || '').trim();
  if (k) localStorage.setItem(KEY, k);
  else localStorage.removeItem(KEY);
}
export function hasGroqKey() {
  return !!getGroqKey();
}

// 把 [startSec, endSec) 依「位元組上限 + 時間上限」切成多個音框範圍。
// 匯出是為了可測試：切錯位置（超過 25MB）會直接 413，必須有測試守著。
export function planGroqSlices(index, startSec, endSec) {
  const from = frameAtTime(index, startSec);
  const to = endSec >= index.durationSec ? index.frameCount : frameAtTime(index, endSec);
  const slices = [];
  let i = from;
  while (i < to) {
    let bytes = 0;
    const sliceStart = i;
    const tLimit = index.times[i] + MAX_SLICE_SEC * index.timescale;
    while (i < to && bytes + 7 + index.sizes[i] <= MAX_SLICE_BYTES && index.times[i] < tLimit) {
      bytes += 7 + index.sizes[i]; // 7 = 之後要加的 ADTS 標頭
      i++;
    }
    if (i === sliceStart) i++; // 單一音框就超限（理論上不會發生）：硬前進避免死迴圈
    slices.push({ from: sliceStart, to: i });
  }
  return slices;
}

function describeGroqError(status, bodyText) {
  if (status === 401) return 'Groq 金鑰無效，請到設定頁確認。';
  if (status === 413) return 'Groq 拒絕：檔案超過大小上限。';
  if (status === 429) return 'Groq 額度暫時用盡（每小時 2 小時音訊）。';
  return `Groq 辨識失敗 (${status})：${(bodyText || '').slice(0, 200)}`;
}

function parseRetryAfterMs(res, bodyText) {
  const h = res.headers && res.headers.get && res.headers.get('retry-after');
  if (h && isFinite(+h)) return (+h + 1) * 1000;
  const m = /try again in ([\d.]+)(m?s)/i.exec(bodyText || '');
  if (m) return m[2].toLowerCase() === 'ms' ? Math.ceil(+m[1]) + 1000 : Math.ceil(+m[1] * 1000) + 1000;
  return 30000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Groq 這邊同樣需要逾時：備援自己掛住的話，使用者只會看到畫面靜止，
// 比「備援失敗」更難判斷。上傳音訊給的時間長一些。
async function fetchT(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 90000);
  try {
    return await fetch(url, { ...(init || {}), signal: ctl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Groq 連線逾時');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 送一個音訊 Blob 給 Groq，回傳 [{speaker, text, t}]（t 為相對這個 Blob 開頭的秒數）。
// 429 依 Groq 指示的秒數等待後重試（最多 2 次）；其他錯誤直接丟出。
// Whisper 也可能被下架（跟文字模型同一課）。turbo 404 就退回標準版。
const WHISPER_MODELS = [GROQ_MODEL, 'whisper-large-v3'];
export async function groqTranscribeBlob(blob, apiKey, onLabel) {
  let mi = 0;
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('file', blob, 'chunk.aac');
    form.append('model', WHISPER_MODELS[mi]);
    form.append('language', 'zh');
    form.append('response_format', 'verbose_json');
    const res = await fetchT(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form }, 180000);
    if (res.ok) {
      const data = await res.json();
      const segs = (data && data.segments) || [];
      return segs
        .map((s) => {
          const text = (s.text || '').trim();
          const t = typeof s.start === 'number' && isFinite(s.start) && s.start >= 0 ? Math.round(s.start) : null;
          const out = { speaker: '說話者', text };
          if (t != null) out.t = t;
          return out;
        })
        .filter((s) => s.text);
    }
    const bodyText = await res.text();
    if (res.status === 404 && /model_not_found|does not exist/i.test(bodyText) && mi + 1 < WHISPER_MODELS.length) {
      mi++;
      continue;
    }
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(120000, parseRetryAfterMs(res, bodyText));
      if (onLabel) onLabel(`Groq 額度暫滿，等待 ${Math.round(wait / 1000)} 秒後重試…`);
      await sleep(wait);
      continue;
    }
    throw new Error(describeGroqError(res.status, bodyText));
  }
}

// 通用的 Groq（Llama）文字請求：送一段提示詞，回覆內容字串。
// wantJson 為真時開啟 JSON 模式（Llama 保證輸出合法 JSON）。
// 429 依 Groq 指示等待後重試（最多 2 次）；其他錯誤直接丟出。
export async function groqChatText(prompt, apiKey, wantJson, onLabel) {
  for (let attempt = 0; ; attempt++) {
    const model = await pickGroqLLM(apiKey);
    const body = {
      model,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    };
    if (wantJson) body.response_format = { type: 'json_object' };
    const res = await fetchT(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 120000);
    if (res.ok) {
      const data = await res.json();
      const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!out) throw new Error('Groq 沒有回傳內容，請重試。');
      return out;
    }
    const bodyText = await res.text();
    // 快取的模型剛好被下架 → 清掉快取重挑一次（清單會重新抓，挑到的就是還活著的）
    if (res.status === 404 && /model_not_found|does not exist/i.test(bodyText) && attempt < 2) {
      resetGroqModelCache();
      continue;
    }
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(120000, parseRetryAfterMs(res, bodyText));
      if (onLabel) onLabel(`Groq 額度暫滿，等待 ${Math.round(wait / 1000)} 秒後重試…`);
      await sleep(wait);
      continue;
    }
    throw new Error(describeGroqError(res.status, bodyText));
  }
}

// 摘要備援：Gemini 額度見底時，用 Groq 的 Llama 模型整理摘要。
// 中文品質低於 Gemini（尤其台灣用語），所以只當備援，不當主力。
// 提示詞沿用 Gemini 的那份，確保兩邊輸出同一種結構。
export async function groqSummarize(segments, apiKey, onLabel) {
  const text = (segments || []).map((s) => `${s.speaker}：${s.text}`).join('\n');
  const out = await groqChatText(
    SUMMARY_PROMPT + text +
      `\n\n只輸出一個 JSON 物件，鍵固定為：actionItems（字串陣列）、mainPoints（字串陣列）、qa（{q,a} 物件陣列）。不要輸出任何其他文字。中文一律用繁體中文（台灣用語）。`,
    apiKey,
    true,
    onLabel
  );
  let r;
  try {
    r = JSON.parse(out);
  } catch (_) {
    throw new Error('Groq 摘要結果解析失敗，請重試。');
  }
  return {
    actionItems: Array.isArray(r.actionItems) ? r.actionItems : [],
    mainPoints: Array.isArray(r.mainPoints) ? r.mainPoints : [],
    qa: Array.isArray(r.qa) ? r.qa : [],
  };
}

// 用 Groq 辨識 m4a 檔案的 [startSec, endSec) 這段。
// 直接從 MP4 索引取出壓縮音框（不解碼、不吃記憶體），包成 ADTS 分批送出。
// index 由呼叫端提供（readM4aIndex 的結果），讓多段共用同一份索引。
export async function groqTranscribeRange(file, index, startSec, endSec, apiKey, onLabel) {
  const slices = planGroqSlices(index, startSec, endSec);
  const all = [];
  for (let i = 0; i < slices.length; i++) {
    const { from, to } = slices[i];
    if (to <= from) continue;
    if (onLabel && slices.length > 1) onLabel(`Groq 辨識中…（${i + 1}/${slices.length}）`);
    const base = index.offsets[from];
    const last = index.offsets[to - 1] + index.sizes[to - 1];
    const span = new Uint8Array(await file.slice(base, last).arrayBuffer());
    const adts = buildAdts(index, from, to, span, base);
    const segs = await groqTranscribeBlob(new Blob([adts], { type: 'audio/aac' }), apiKey, onLabel);
    // t 是相對「這個 slice」的秒數 → 換算成相對整段（chunk）的秒數，與 Gemini 路線同一套約定
    const sliceOffset = index.times[from] / index.timescale - startSec;
    for (const s of segs) {
      if (s.t != null) s.t = Math.round(s.t + Math.max(0, sliceOffset));
      all.push(s);
    }
  }
  return all;
}
