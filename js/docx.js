// 產生「真正的」.docx（Office Open XML）：docx 本質是一個 zip，內含幾個 XML。
// 這裡用純 JS 自建最小可用的 docx（store 無壓縮 zip + 直接格式化的段落），
// 不需任何外部套件，Word / Pages / iOS / WeChat 都能開啟。
const enc = new TextEncoder();

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// 以 store（不壓縮）方式打包成 zip，回傳 Uint8Array
export function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = Uint8Array.from(
      [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0))
    );
    parts.push(local, name, f.bytes);
    central.push(
      Uint8Array.from(
        [].concat(
          u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
          u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
        )
      ),
      name
    );
    offset += local.length + name.length + size;
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = Uint8Array.from(
    [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0))
  );
  const all = [...parts, ...central, eocd];
  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function run(text, opts = {}) {
  const sz = opts.sz || 22;
  const b = opts.b ? '<w:b/>' : '';
  const color = opts.color ? `<w:color w:val="${opts.color}"/>` : '';
  return `<w:r><w:rPr>${b}${color}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
const para = (runs, pr) => `<w:p>${pr ? `<w:pPr>${pr}</w:pPr>` : ''}${runs}</w:p>`;
const title = (t) => para(run(t, { b: true, sz: 34 }));
const heading = (t) => para(run(t, { b: true, sz: 26 }), '<w:keepNext/><w:keepLines/>'); // 標題不與內容分頁
const line = (t, sz) => para(run(t, { sz: sz || 22 }));

const SPK_COLORS = ['0A58CA', '1A7F37', 'B35900', '8250DF', 'CF222E', '0A6D8A', '9A6700'];
function splitQA(item) {
  const s = String(item == null ? '' : item);
  const ai = s.search(/答\s*[：:]/);
  if (ai >= 0) {
    return {
      q: s.slice(0, ai).replace(/^\s*問\s*[：:]\s*/, '').trim(),
      a: s.slice(ai).replace(/^\s*答\s*[：:]\s*/, '').trim(),
    };
  }
  return { q: s.replace(/^\s*問\s*[：:]\s*/, '').trim(), a: '' };
}

function documentXml(meeting) {
  const s = meeting.summary || {};
  const actionItems = s.actionItems || [];
  const mainPoints = s.mainPoints || s.keyPoints || [];
  const qa = s.qa || [];
  const dateStr = (meeting.createdAt ? new Date(meeting.createdAt) : new Date()).toLocaleString('zh-TW');
  const body = [];
  body.push(title(meeting.title || '會議記錄'));
  body.push(line(dateStr, 18));
  body.push(heading('✅ 待辦事項 Action Item'));
  if (actionItems.length) actionItems.forEach((x, i) => body.push(line(`${i + 1}. ${x}`)));
  else body.push(line('（無）'));
  body.push(heading('📌 會議重點 Main Point'));
  if (mainPoints.length) mainPoints.forEach((x, i) => body.push(line(`${i + 1}. ${x}`)));
  else body.push(line('（無）'));
  body.push(heading('❓ 會議提問 Q&A'));
  if (qa.length) {
    qa.forEach((x, i) => {
      const { q, a } = splitQA(x);
      // 問與答同段、以換行分隔，並設 keepLines 讓整組不被分頁拆開（跟 PDF 一致）
      let runs = run(`${i + 1}. `, { b: true }) + run('問：', { b: true, color: '0A58CA' }) + run(q);
      if (a) runs += '<w:r><w:br/></w:r>' + run('答：', { b: true, color: '1A7F37' }) + run(a);
      body.push(para(runs, '<w:keepLines/>'));
    });
  } else body.push(line('無'));
  body.push(heading('🗣️ 逐字稿 Transcribe'));
  const segs = meeting.transcript || [];
  if (segs.length) {
    const colorMap = {};
    let ci = 0;
    segs.forEach((seg) => {
      if (!(seg.speaker in colorMap)) {
        colorMap[seg.speaker] = SPK_COLORS[ci % SPK_COLORS.length];
        ci++;
      }
      body.push(para(run(`${seg.speaker}：`, { b: true, color: colorMap[seg.speaker] }) + run(seg.text)));
    });
  } else body.push(line('（無逐字稿）'));

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    '</w:body></w:document>'
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

export function buildDocxBytes(meeting) {
  return zipStore([
    { name: '[Content_Types].xml', bytes: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', bytes: enc.encode(RELS) },
    { name: 'word/document.xml', bytes: enc.encode(documentXml(meeting)) },
  ]);
}
