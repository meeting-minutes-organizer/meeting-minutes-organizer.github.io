// 解析 MP4／M4A 的索引表，取出每一個 AAC 音框在檔案裡的位置與時間。
//
// 為什麼需要這個：瀏覽器的 decodeAudioData 必須「一次解完整個檔案」，而且是先用
// 原始規格解開（48kHz 立體聲 = 每小時約 1.38GB），之後才降取樣。142 分鐘的錄音
// 要 3.27GB，Chrome 配不出這麼大的記憶體，回報的是籠統的 EncodingError——
// 看起來像格式壞掉，其實是檔案太長。
//
// 有了索引，就能把檔案切成幾分鐘一段、逐段丟給 decodeAudioData，記憶體維持在幾百 MB。

const AAC_FRAME_SAMPLES = 1024;

function fail(name, msg) {
  const e = new Error(msg);
  e.name = name;
  return e;
}

function fourcc(view, o) {
  return String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
}

// MP4 的基本單位（box）：4 bytes 長度 + 4 bytes 型別 + 內容。長度為 1 代表改用 64 位元長度。
function readHeader(view, o, end) {
  if (o + 8 > end) return null;
  let size = view.getUint32(o);
  const type = fourcc(view, o + 4);
  let hs = 8;
  if (size === 1) {
    if (o + 16 > end) return null;
    size = Number(view.getBigUint64(o + 8));
    hs = 16;
  } else if (size === 0) {
    size = end - o;
  }
  if (size < hs) return null;
  return { type, start: o, body: o + hs, end: o + size };
}

function* boxes(view, start, end) {
  let o = start;
  for (;;) {
    const b = readHeader(view, o, end);
    if (!b || b.end > end) return; // 走訪記憶體中的 box 時不可越界
    yield b;
    o = b.end;
  }
}

function findBox(view, start, end, type) {
  for (const b of boxes(view, start, end)) if (b.type === type) return b;
  return null;
}

// 掃檔案最上層的 box。只讀每個 box 的前 16 bytes，不把整個檔案讀進記憶體。
async function findTopLevel(file, type) {
  let pos = 0;
  let guard = 0;
  while (pos + 8 <= file.size) {
    // 不是 MP4 的檔案照樣會被解出一堆亂數長度，設上限避免在這裡空轉
    if (++guard > 64) return null;
    const head = await file.slice(pos, Math.min(pos + 16, file.size)).arrayBuffer();
    const view = new DataView(head);
    const b = readHeader(view, 0, head.byteLength);
    if (!b) return null;
    // 長度欄位為 0 代表「一直到檔尾」，此時要用檔案大小而不是這 16 bytes 的視窗
    const size = view.getUint32(0) === 0 ? file.size - pos : b.end - b.start;
    if (b.type === type) return { type, body: pos + (b.body - b.start), end: pos + size };
    pos += size;
  }
  return null;
}

// ES 描述子用可變長度編碼：每個 byte 取低 7 bits，最高位為 1 代表還有下一個 byte。
function readDescLen(view, o) {
  let len = 0;
  let n = 0;
  let b;
  do {
    b = view.getUint8(o + n);
    len = (len << 7) | (b & 0x7f);
    n++;
  } while (b & 0x80 && n < 4);
  return { len, n };
}

// 從 esds 取出 AudioSpecificConfig（描述這段 AAC 用什麼參數編碼）
function parseEsds(view, start, end) {
  let o = start + 4; // version + flags
  while (o < end) {
    const tag = view.getUint8(o);
    o++;
    const { len, n } = readDescLen(view, o);
    o += n;
    const bodyEnd = o + len;
    if (tag === 0x03) {
      // ES_Descriptor：跳過 ES_ID 與可選欄位後，直接往下一層描述子走
      const flags = view.getUint8(o + 2);
      o += 3;
      if (flags & 0x80) o += 2;
      if (flags & 0x40) o += 1 + view.getUint8(o);
      if (flags & 0x20) o += 2;
      continue;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor：固定 13 bytes 後接 DecoderSpecificInfo
      o += 13;
      continue;
    }
    if (tag === 0x05) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = view.getUint8(o + i);
      return out;
    }
    o = bodyEnd;
  }
  return null;
}

// AudioSpecificConfig 的前 2 bytes：5 bits 編碼類型、4 bits 取樣率索引、4 bits 聲道設定
function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  const objType = asc[0] >> 3;
  const freqIdx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
  if (freqIdx === 15) return null; // 取樣率用 24 bits 明寫，錄音檔幾乎不會這樣，不支援
  const chCfg = (asc[1] >> 3) & 0x0f;
  if (objType < 1 || objType > 4 || chCfg < 1 || chCfg > 7) return null;
  return { objType, freqIdx, chCfg };
}

function findAudioTrak(view, moovStart, moovEnd) {
  for (const trak of boxes(view, moovStart, moovEnd)) {
    if (trak.type !== 'trak') continue;
    const mdia = findBox(view, trak.body, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(view, mdia.body, mdia.end, 'hdlr');
    if (!hdlr) continue;
    if (fourcc(view, hdlr.body + 8) === 'soun') return mdia;
  }
  return null;
}

/**
 * 讀出 m4a／mp4 裡音訊軌的完整索引。
 * 回傳每個音框的檔案位置（offsets）、長度（sizes）、起始時間（times，單位為 timescale）。
 * 不符合預期（不是 MP4、沒有 AAC 音軌、分段式 MP4…）就丟出錯誤，讓上層退回舊做法。
 */
export async function readM4aIndex(file) {
  const moov = await findTopLevel(file, 'moov');
  if (!moov) throw fail('MP4Unsupported', '找不到 moov 索引，不是標準的 MP4／M4A');
  const buf = await file.slice(moov.body, moov.end).arrayBuffer();
  const view = new DataView(buf);
  const end = buf.byteLength;

  const mdia = findAudioTrak(view, 0, end);
  if (!mdia) throw fail('MP4Unsupported', '找不到音訊軌');

  const mdhd = findBox(view, mdia.body, mdia.end, 'mdhd');
  if (!mdhd) throw fail('MP4Unsupported', '缺少 mdhd');
  const mdhdV = view.getUint8(mdhd.body);
  const timescale = mdhdV === 1 ? view.getUint32(mdhd.body + 20) : view.getUint32(mdhd.body + 12);
  if (!timescale) throw fail('MP4Unsupported', 'mdhd 的 timescale 為 0');

  const minf = findBox(view, mdia.body, mdia.end, 'minf');
  const stbl = minf && findBox(view, minf.body, minf.end, 'stbl');
  if (!stbl) throw fail('MP4Unsupported', '缺少 stbl 索引表');

  const stsd = findBox(view, stbl.body, stbl.end, 'stsd');
  if (!stsd) throw fail('MP4Unsupported', '缺少 stsd');
  const entry = stsd.body + 8; // version/flags + entry count
  const format = fourcc(view, entry + 4);
  if (format !== 'mp4a') throw fail('MP4Unsupported', `音訊格式是 ${format}，目前只支援 AAC（mp4a）`);
  const channels = view.getUint16(entry + 24);
  const sampleRate = view.getUint16(entry + 32) || timescale;
  const entryEnd = entry + view.getUint32(entry);
  const esds = findBox(view, entry + 36, entryEnd, 'esds');
  if (!esds) throw fail('MP4Unsupported', '缺少 esds，讀不到 AAC 參數');
  const cfg = parseAsc(parseEsds(view, esds.body, esds.end));
  if (!cfg) throw fail('MP4Unsupported', 'AAC 參數不是支援的形式');

  // stts：每個音框佔多少時間。錄音檔通常只有一筆（全部音框都是 1024 取樣）。
  const stts = findBox(view, stbl.body, stbl.end, 'stts');
  if (!stts) throw fail('MP4Unsupported', '缺少 stts');
  const sttsCount = view.getUint32(stts.body + 4);

  // stsz：每個音框的位元組長度
  const stsz = findBox(view, stbl.body, stbl.end, 'stsz');
  if (!stsz) throw fail('MP4Unsupported', '缺少 stsz');
  const uniformSize = view.getUint32(stsz.body + 4);
  const frameCount = view.getUint32(stsz.body + 8);
  if (!frameCount) throw fail('MP4Unsupported', '音訊軌沒有任何音框');

  // stsc：哪幾個 chunk 各放了幾個音框
  const stsc = findBox(view, stbl.body, stbl.end, 'stsc');
  if (!stsc) throw fail('MP4Unsupported', '缺少 stsc');
  const stscCount = view.getUint32(stsc.body + 4);

  // stco／co64：每個 chunk 在檔案裡的位置
  const stco = findBox(view, stbl.body, stbl.end, 'stco') || findBox(view, stbl.body, stbl.end, 'co64');
  if (!stco) throw fail('MP4Unsupported', '缺少 stco／co64');
  const wide = stco.type === 'co64';
  const chunkCount = view.getUint32(stco.body + 4);

  const sizes = new Uint32Array(frameCount);
  if (uniformSize) sizes.fill(uniformSize);
  else for (let i = 0; i < frameCount; i++) sizes[i] = view.getUint32(stsz.body + 12 + i * 4);

  // 逐 chunk 展開成「每個音框的檔案位置」
  const offsets = new Float64Array(frameCount);
  let f = 0;
  let sc = 0; // 目前用到第幾筆 stsc
  for (let c = 0; c < chunkCount && f < frameCount; c++) {
    while (sc + 1 < stscCount && view.getUint32(stsc.body + 8 + (sc + 1) * 12) <= c + 1) sc++;
    const perChunk = view.getUint32(stsc.body + 8 + sc * 12 + 4);
    let at = wide ? Number(view.getBigUint64(stco.body + 8 + c * 8)) : view.getUint32(stco.body + 8 + c * 4);
    for (let k = 0; k < perChunk && f < frameCount; k++) {
      offsets[f] = at;
      at += sizes[f];
      f++;
    }
  }
  if (f < frameCount) throw fail('MP4Unsupported', 'chunk 索引不完整，可能是分段式 MP4');

  // 逐音框累加時間
  const times = new Float64Array(frameCount);
  let t = 0;
  let idx = 0;
  for (let e = 0; e < sttsCount && idx < frameCount; e++) {
    const n = view.getUint32(stts.body + 8 + e * 8);
    const dt = view.getUint32(stts.body + 8 + e * 8 + 4);
    for (let k = 0; k < n && idx < frameCount; k++) {
      times[idx++] = t;
      t += dt;
    }
  }
  while (idx < frameCount) {
    times[idx++] = t;
    t += AAC_FRAME_SAMPLES;
  }

  return {
    timescale,
    sampleRate,
    channels,
    cfg,
    offsets,
    sizes,
    times,
    frameCount,
    durationSec: t / timescale,
  };
}

/**
 * 把 [from, to) 這段音框包成 ADTS 串流——也就是一個瀏覽器可以獨立解碼的 .aac 檔。
 * span 是這段音框在檔案裡的原始位元組，spanBase 是 span 的起始位置。
 */
export function buildAdts(index, from, to, span, spanBase) {
  const { offsets, sizes, cfg } = index;
  let total = 0;
  for (let i = from; i < to; i++) total += 7 + sizes[i];
  const out = new Uint8Array(total);
  let o = 0;
  for (let i = from; i < to; i++) {
    const len = 7 + sizes[i];
    out[o] = 0xff;
    out[o + 1] = 0xf1; // MPEG-4、無 CRC
    out[o + 2] = ((cfg.objType - 1) << 6) | ((cfg.freqIdx & 0x0f) << 2) | ((cfg.chCfg >> 2) & 0x01);
    out[o + 3] = ((cfg.chCfg & 0x03) << 6) | ((len >> 11) & 0x03);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 0x07) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    o += 7;
    const s = offsets[i] - spanBase;
    out.set(span.subarray(s, s + sizes[i]), o);
    o += sizes[i];
  }
  return out;
}

/** 找出「時間 >= sec」的第一個音框編號 */
export function frameAtTime(index, sec) {
  const target = sec * index.timescale;
  let lo = 0;
  let hi = index.frameCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
