// 在瀏覽器內把音檔切成多個時間段（各自輸出 16kHz 單聲道 WAV Blob）。
// 目的：讓每次辨識請求只送「一小段」音訊，大幅降低 token，避開免費層每分鐘上限。
// 若解碼失敗（格式不支援 / 記憶體不足），丟出錯誤讓上層改用整檔模式。

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

export async function splitAudioToChunks(file, chunkSec, onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('瀏覽器不支援音訊切割');
  const arrayBuf = await file.arrayBuffer();
  let ctx;
  try {
    ctx = new AC({ sampleRate: TARGET_SR });
  } catch (_) {
    ctx = new AC();
  }
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  try {
    ctx.close();
  } catch (_) {}

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
