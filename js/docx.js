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

// 匯出要包含哪些段落；未指定的一律視為要（保持舊行為）。
// 放在這裡而非 export.js，是因為 export.js 已經 import 本模組，反向 import 會形成循環相依。
export function normalizeSections(opts) {
  const o = opts || {};
  const on = (v) => v !== false;
  return {
    actionItems: on(o.actionItems),
    mainPoints: on(o.mainPoints),
    qa: on(o.qa),
    transcript: on(o.transcript),
    // 學習筆記預設「不」輸出：它是選用功能，多數會議沒有，預設帶上會讓舊行為改變
    notes: o.notes === true,
  };
}

// ---- Word 表格（OOXML）----
// docx 的表格是 w:tbl > w:tr > w:tc，每個 w:tc 內至少要有一個 w:p，否則 Word 會判定檔案損毀。
const TBL_W = 9638; // A4 去掉左右邊界後的可用寬度（twips），欄寬平均分配
function cell(text, widthTw, bold) {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${widthTw}" w:type="dxa"/>` +
    `${bold ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>` +
    `${para(run(text, { sz: 20, b: !!bold }))}</w:tc>`
  );
}
function tableXml(t) {
  const headers = (t.headers || []).filter((h) => h != null);
  if (!headers.length) return '';
  const w = Math.floor(TBL_W / headers.length);
  const grid = headers.map(() => `<w:gridCol w:w="${w}"/>`).join('');
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders>';
  const headRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h) => cell(h, w, true)).join('')}</w:tr>`;
  const bodyRows = (t.rows || [])
    // 依欄位數對齊：缺的補空白，多的截掉，避免產生欄數不一致的破損表格
    .map((r) => `<w:tr>${headers.map((_, i) => cell((r && r[i]) || '', w, false)).join('')}</w:tr>`)
    .join('');
  return (
    (t.title ? para(run(t.title, { b: true, sz: 22 }), '<w:keepNext/>') : '') +
    `<w:tbl><w:tblPr><w:tblW w:w="${TBL_W}" w:type="dxa"/>${borders}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headRow}${bodyRows}</w:tbl>` +
    para(run('', { sz: 12 })) // 表格後補一段空行，Word 不允許兩個表格直接相鄰
  );
}

// 關鍵數據的兩欄表：左欄標籤、右欄數值靠右
function figTableXml(rows) {
  const LW = Math.floor(TBL_W * 0.68);
  const RW = TBL_W - LW;
  const borders =
    '<w:tblBorders><w:insideH w:val="dashed" w:sz="4" w:color="D9D9D9"/></w:tblBorders>';
  const trs = rows
    .map(
      (f) =>
        `<w:tr><w:tc><w:tcPr><w:tcW w:w="${LW}" w:type="dxa"/></w:tcPr>${para(run(f.label || '', { sz: 20 }))}</w:tc>` +
        `<w:tc><w:tcPr><w:tcW w:w="${RW}" w:type="dxa"/></w:tcPr>` +
        `${para(run(f.value || '', { sz: 20, b: true }), '<w:jc w:val="right"/>')}</w:tc></w:tr>`
    )
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${TBL_W}" w:type="dxa"/>${borders}</w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${LW}"/><w:gridCol w:w="${RW}"/></w:tblGrid>${trs}</w:tbl>` +
    para(run('', { sz: 12 }))
  );
}

function notesBody(n) {
  const body = [];
  const none = () => body.push(line('（無）'));
  body.push(heading('📑 章節大綱 Outline'));
  if ((n.outline || []).length) {
    n.outline.forEach((o, i) => {
      body.push(para(run(`${i + 1}. ${o.title}`, { b: true }), '<w:keepNext/>'));
      (o.points || []).forEach((p) => body.push(line(`　・${p}`)));
    });
  } else none();
  body.push(heading('💡 重要概念 Concepts'));
  if ((n.concepts || []).length) {
    n.concepts.forEach((c) => {
      body.push(para(run(c.term, { b: true }), '<w:keepNext/>'));
      body.push(line(c.plain || ''));
      if (c.why) body.push(line(`→ ${c.why}`, 20));
    });
  } else none();
  body.push(heading('📊 對照表 Tables'));
  if ((n.tables || []).length) n.tables.forEach((t) => body.push(tableXml(t)));
  else none();
  body.push(heading('🔢 關鍵數據 Key Figures'));
  const figs = n.figures || [];
  if (figs.length) {
    const order = [];
    const byGroup = new Map();
    for (const f of figs) {
      const g = (f && f.group) || '其他';
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        order.push(g);
      }
      byGroup.get(g).push(f);
    }
    for (const g of order) {
      if (order.length > 1) body.push(para(run(g, { b: true }), '<w:keepNext/>'));
      // 用兩欄表格達成「標籤左、數值右」；無框線，只留底部虛線的視覺分隔
      body.push(figTableXml(byGroup.get(g)));
    }
  } else none();
  body.push(heading('✍️ 自我測驗 Quiz'));
  if ((n.quiz || []).length) {
    n.quiz.forEach((q, i) => {
      body.push(para(run(`Q${i + 1}. ${q.q}`, { b: true }), '<w:keepNext/>'));
      body.push(line(q.a || ''));
    });
  } else none();
  return body;
}

function documentXml(meeting, opts) {
  const want = normalizeSections(opts);
  const s = meeting.summary || {};
  const actionItems = s.actionItems || [];
  const mainPoints = s.mainPoints || s.keyPoints || [];
  const qa = s.qa || [];
  const dateStr = (meeting.createdAt ? new Date(meeting.createdAt) : new Date()).toLocaleString('zh-TW');
  const body = [];
  body.push(title(meeting.title || '會議記錄'));
  body.push(line(dateStr, 18));
  if (want.actionItems) {
    body.push(heading('✅ 待辦事項 Action Item'));
    if (actionItems.length) actionItems.forEach((x, i) => body.push(line(`${i + 1}. ${x}`)));
    else body.push(line('（無）'));
  }
  if (want.mainPoints) {
    body.push(heading('📌 會議重點 Main Point'));
    if (mainPoints.length) mainPoints.forEach((x, i) => body.push(line(`${i + 1}. ${x}`)));
    else body.push(line('（無）'));
  }
  if (want.qa) {
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
  }
  if (want.notes && meeting.notes) body.push(...notesBody(meeting.notes));
  if (want.transcript) {
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
  }

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

export function buildDocxBytes(meeting, opts) {
  return zipStore([
    { name: '[Content_Types].xml', bytes: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', bytes: enc.encode(RELS) },
    { name: 'word/document.xml', bytes: enc.encode(documentXml(meeting, opts)) },
  ]);
}
