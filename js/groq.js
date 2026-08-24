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
const GROQ_LLM = 'llama-3.3-70b-versatile';

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

// 送一個音訊 Blob 給 Groq，回傳 [{speaker, text, t}]（t 為相對這個 Blob 開頭的秒數）。
// 429 依 Groq 指示的秒數等待後重試（最多 2 次）；其他錯誤直接丟出。
export async function groqTranscribeBlob(blob, apiKey, onLabel) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('file', blob, 'chunk.aac');
    form.append('model', GROQ_MODEL);
    form.append('language', 'zh');
    form.append('response_format', 'verbose_json');
    const res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
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
    const body = {
      model: GROQ_LLM,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    };
    if (wantJson) body.response_format = { type: 'json_object' };
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!out) throw new Error('Groq 沒有回傳內容，請重試。');
      return out;
    }
    const bodyText = await res.text();
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
