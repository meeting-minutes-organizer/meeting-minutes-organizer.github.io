// 在瀏覽器內把音檔切成多個時間段（各自輸出 16kHz 單聲道 WAV Blob）。
// 目的：讓每次辨識請求只送「一小段」音訊，大幅降低 token，避開免費層每分鐘上限。
// 若解碼失敗（格式不支援 / 記憶體不足），丟出錯誤讓上層改用整檔模式。

import { readM4aIndex, buildAdts, frameAtTime } from './mp4.js';

const TARGET_SR = 16000;

function encodeWav(samples, sampleRate) {
  const len = samples.length;
  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, 'data');
  view.setUint32(40, len * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    let s = samples[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

// 線性內插降頻到 16kHz（若已是 16k 直接回傳）
function downsample(data, srcRate, dstRate) {
  if (srcRate === dstRate) return data;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(data.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const frac = pos - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

// 用指定取樣率的 AudioContext 解碼。rate 傳 0 代表用瀏覽器預設取樣率。
// 注意：decodeAudioData 會「吃掉」傳進去的 ArrayBuffer（detach），
// 所以每次嘗試都必須從 File 重新讀一份，不能重用同一個 buffer。
async function decodeWithRate(file, rate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = rate ? new AC({ sampleRate: rate }) : new AC();
  } catch (_) {
    ctx = new AC();
  }
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    try {
      ctx.close();
    } catch (_) {}
  }
}

function describeErr(e) {
  if (!e) return '未回報原因';
  return `${e.name || 'Error'}: ${e.message || String(e)}`;
}

// 一次丟給瀏覽器解碼的長度。10 分鐘的 48kHz 立體聲約 230MB，手機也吃得下。
const DECODE_SEC = 600;

// m4a／mp4 專用：先讀出索引，再一段一段解碼。
// 這條路不受「整檔解碼」的記憶體上限影響，142 分鐘的錄音也切得動。
async function splitViaIndex(file, chunkSec, onProgress) {
  const idx = await readM4aIndex(file);
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new AC({ sampleRate: TARGET_SR });
  } catch (_) {
    ctx = new AC();
  }
  try {
    const durationSec = idx.durationSec;
    const n = Math.max(1, Math.ceil(durationSec / chunkSec));
    const chunks = [];
    for (let i = 0; i < n; i++) {
      const start = i * chunkSec;
      const end = Math.min(durationSec, start + chunkSec);
      const parts = [];
      let len = 0;
      for (let t = start; t < end; t += DECODE_SEC) {
        const a = t;
        const b = Math.min(end, t + DECODE_SEC);
        const from = frameAtTime(idx, a);
        const to = b >= durationSec ? idx.frameCount : frameAtTime(idx, b);
        if (to <= from) continue;
        const base = idx.offsets[from];
        const span = new Uint8Array(await file.slice(base, idx.offsets[to - 1] + idx.sizes[to - 1]).arrayBuffer());
        const decoded = await ctx.decodeAudioData(buildAdts(idx, from, to, span, base).buffer);
        const mono = downsample(decoded.getChannelData(0), decoded.sampleRate, TARGET_SR);
        parts.push(mono);
        len += mono.length;
      }
      if (!len) throw new Error(`第 ${i + 1} 段沒有解出任何音訊`);
      let all;
      if (parts.length === 1) {
        all = parts[0];
      } else {
        all = new Float32Array(len);
        let p = 0;
        for (const x of parts) {
          all.set(x, p);
          p += x.length;
        }
        parts.length = 0;
      }
      chunks.push({ start, end, blob: encodeWav(all, TARGET_SR) });
      if (onProgress) onProgress(i + 1, n);
    }
    return { mime: 'audio/wav', durationSec, chunks };
  } finally {
    try {
      ctx.close();
    } catch (_) {}
  }
}

export async function splitAudioToChunks(file, chunkSec, onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('瀏覽器不支援音訊切割');

  // m4a／mp4 先走索引切割。讀索引很快（幾十毫秒），失敗就退回原本的整檔解碼。
  let indexErr = null;
  try {
    return await splitViaIndex(file, chunkSec, onProgress);
  } catch (e) {
    indexErr = e;
  }

  let audioBuf = null;
  let firstErr = null;
  try {
    audioBuf = await decodeWithRate(file, TARGET_SR);
  } catch (e) {
    firstErr = e;
  }
  if (!audioBuf) {
    // 指定 16kHz 時，瀏覽器要在解碼的同時重新取樣，走的是另一段程式；
    // 有些檔案在這條路上會失敗，改用預設取樣率反而解得開（之後再由 downsample 降到 16k）。
    try {
      audioBuf = await decodeWithRate(file, 0);
    } catch (e) {
      const err = new Error(
        `分段切割 → ${describeErr(indexErr)}；整檔 16kHz → ${describeErr(firstErr)}；整檔預設取樣率 → ${describeErr(e)}`
      );
      err.name = 'DecodeFailed';
      throw err;
    }
  }

  const srcRate = audioBuf.sampleRate;
  const mono = downsample(audioBuf.getChannelData(0), srcRate, TARGET_SR);
  const durationSec = audioBuf.duration;
  const chunkSamples = Math.max(1, Math.floor(chunkSec * TARGET_SR));
  const chunks = [];
  const n = Math.ceil(mono.length / chunkSamples);
  for (let i = 0; i < n; i++) {
    const startS = i * chunkSamples;
    const endS = Math.min(mono.length, startS + chunkSamples);
    const blob = encodeWav(mono.subarray(startS, endS), TARGET_SR);
    chunks.push({ start: startS / TARGET_SR, end: endS / TARGET_SR, blob });
    if (onProgress) onProgress(i + 1, n);
  }
  return { mime: 'audio/wav', durationSec, chunks };
}
