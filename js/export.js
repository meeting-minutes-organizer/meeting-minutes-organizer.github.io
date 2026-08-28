// 匯出：把一場會議產生成可列印/可下載的文件。
// - PDF：開新視窗載入乾淨排版後呼叫列印（中文字體用系統字體最穩，iPhone 也能存成 PDF）。
// - Word：產生 Word 可開啟的 .doc（HTML 格式），保留中文與排版、可再編輯。
import { formatDate } from './format.js';
import { buildDocxBytes, normalizeSections } from './docx.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function ol(items) {
  return items && items.length
    ? '<ol>' + items.map((i) => `<li>${esc(i)}</li>`).join('') + '</ol>'
    : '<p class="none">（無）</p>';
}

// 把「問：… 答：…」拆成問、答兩段
export function splitQA(item) {
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
function qaOl(items) {
  if (!items || !items.length) return '<p class="none">無</p>';
  return (
    '<ol>' +
    items
      .map((it) => {
        const { q, a } = splitQA(it);
        return `<li><div class="qa-q"><b style="color:#0a58ca">問：</b>${esc(q)}</div>${a ? `<div class="qa-a"><b style="color:#1a7f37">答：</b>${esc(a)}</div>` : ''}</li>`;
      })
      .join('') +
    '</ol>'
  );
}

// 逐字稿語者顏色（白底可讀的深色）
const SPK_COLORS = ['#0a58ca', '#1a7f37', '#b35900', '#8250df', '#cf222e', '#0a6d8a', '#9a6700'];
function speakerColorMap(segments) {
  const m = {};
  let i = 0;
  (segments || []).forEach((seg) => {
    if (!(seg.speaker in m)) {
      m[seg.speaker] = SPK_COLORS[i % SPK_COLORS.length];
      i++;
    }
  });
  return m;
}

export function safeFileName(title) {
  return (String(title || 'meeting').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'meeting').slice(0, 80);
}

// 會議內容主體 HTML（PDF 用）。opts 可關閉個別段落，例如 { actionItems: false }
export function meetingToHtmlBody(meeting, opts) {
  const want = normalizeSections(opts);
  const s = meeting.summary || {};
  const colors = speakerColorMap(meeting.transcript);
  const segs = (meeting.transcript || [])
    .map((seg) => `<p class="seg"><strong style="color:${colors[seg.speaker] || '#111'}">${esc(seg.speaker)}：</strong>${esc(seg.text)}</p>`)
    .join('');
  let html = `<h1>${esc(meeting.title)}</h1><p class="date">${esc(formatDate(meeting.createdAt))}</p>`;
  if (want.actionItems) html += `<h2>✅ 待辦事項 Action Item</h2>${ol(s.actionItems || [])}`;
  if (want.mainPoints) html += `<h2>📌 會議重點 Main Point</h2>${ol(s.mainPoints || s.keyPoints || [])}`;
  if (want.qa) html += `<h2>❓ 會議提問 Q&amp;A</h2>${qaOl(s.qa || [])}`;
  if (want.notes) html += notesHtml(meeting.notes);
  if (want.transcript) html += `<h2>🗣️ 逐字稿 Transcribe</h2>${segs || '<p class="none">（無逐字稿）</p>'}`;
  return html;
}

// 學習筆記（研討會／上課模式）。表格用真正的 <table>，不再壓成散文。
function notesHtml(n) {
  if (!n) return '';
  const none = '<p class="none">（無）</p>';
  const outline = (n.outline || [])
    .map((o, i) => `<p class="nt-h">${i + 1}. ${esc(o.title)}</p>${(o.points || []).length ? `<ul>${o.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}`)
    .join('');
  const concepts = (n.concepts || [])
    .map((c) => `<p class="nt-h">${esc(c.term)}</p><p>${esc(c.plain)}</p>${c.why ? `<p class="nt-why">→ ${esc(c.why)}</p>` : ''}`)
    .join('');
  const tables = (n.tables || [])
    .map((t) => {
      const head = (t.headers || []).map((h) => `<th>${esc(h)}</th>`).join('');
      const rows = (t.rows || [])
        .map((r) => `<tr>${(t.headers || []).map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`)
        .join('');
      return `${t.title ? `<p class="nt-h">${esc(t.title)}</p>` : ''}<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  // 關鍵數據：依主題分組，標籤在左、數值靠右——同主題的數字排在一起才好互相對照
  const figs = n.figures || [];
  let figures = none;
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
    figures = order
      .map(
        (g) =>
          `${order.length > 1 ? `<p class="nt-h">${esc(g)}</p>` : ''}<table class="fig"><tbody>` +
          byGroup.get(g).map((f) => `<tr><td>${esc(f.label)}</td><td class="fv">${esc(f.value)}</td></tr>`).join('') +
          `</tbody></table>`
      )
      .join('');
  }
  const quiz = (n.quiz || [])
    .map((q, i) => `<p class="nt-h">Q${i + 1}. ${esc(q.q)}</p><p>${esc(q.a)}</p>`)
    .join('');
  return (
    `<h2>📑 章節大綱 Outline</h2>${outline || none}` +
    `<h2>💡 重要概念 Concepts</h2>${concepts || none}` +
    `<h2>📊 對照表 Tables</h2>${tables || none}` +
    `<h2>🔢 關鍵數據 Key Figures</h2>${figures}` +
    `<h2>✍️ 自我測驗 Quiz</h2>${quiz || none}`
  );
}

const STYLE = `
  body{font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;line-height:1.7;color:#111;max-width:820px;margin:24px auto;padding:0 18px;}
  h1{font-size:22px;margin:0 0 4px;}
  .date{color:#666;margin:0 0 18px;}
  h2{font-size:16px;border-bottom:2px solid #0a84ff;padding-bottom:4px;margin:22px 0 8px;color:#0a6;}
  ul{margin:6px 0;padding-left:22px;} li{margin:5px 0;}
  p{margin:6px 0;} .seg{margin:4px 0;} .none{color:#999;}
  .nt-h{font-weight:700;margin:10px 0 2px;} .nt-why{color:#555;margin:2px 0 8px;}
  table{border-collapse:collapse;width:100%;margin:6px 0 14px;font-size:14px;page-break-inside:avoid;}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top;}
  th{background:#f2f2f2;font-weight:700;}
  table.fig td{border:none;border-bottom:1px dashed #ddd;padding:5px 0;}
  table.fig td.fv{text-align:right;font-weight:700;white-space:nowrap;padding-left:14px;}
  @media print{ body{margin:0;} }
`;

export function fullHtmlDoc(meeting, opts) {
  return (
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">` +
    `<title>${esc(meeting.title)}</title><style>${STYLE}</style></head>` +
    `<body>${meetingToHtmlBody(meeting, opts)}</body></html>`
  );
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

export function exportWord(meeting, opts) {
  // 產生真正的 .docx（Office Open XML），各平台可正常開啟。
  const blob = new Blob([buildDocxBytes(meeting, opts)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  downloadBlob(blob, safeFileName(meeting.title) + '.docx');
}

// iOS 從「主畫面圖示」開啟時是 standalone 模式，列印工作的名稱取自 manifest 的 App 名稱，
// 完全不理會 document.title → 存出來永遠叫 DD會議紀錄.pdf。桌機瀏覽器則正常使用 document.title。
export function isStandaloneIOS() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    navigator.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return ios && standalone;
}

// standalone iOS 專用：把內容開在一般 Safari 分頁再列印，那裡的列印名稱才會用網頁標題。
// 開不了新分頁（被擋）就回傳 false，交回原本的就地列印。
function printViaNewTab(meeting, opts) {
  let w = null;
  try {
    w = window.open('', '_blank');
  } catch (_) {
    return false;
  }
  if (!w || !w.document) return false;
  try {
    // ⚠️ iOS 從主畫面 App 開的新視窗「沒有 Safari 工具列」——沒有分享鈕、也沒有返回。
    // 所以這一頁必須自備「列印」與「關閉」按鈕，否則使用者會卡在這裡出不去。
    const bar =
      `<div class="bar">` +
      `<button type="button" onclick="window.print()">🖨️ 列印／儲存 PDF</button>` +
      `<button type="button" class="sec" onclick="window.close()">✕ 關閉</button>` +
      `</div>` +
      `<div class="tip">點上方<b>列印／儲存 PDF</b>，在預覽畫面用<b>分享鈕</b>存檔。` +
      `<br>檔名會是「${esc(safeFileName(meeting.title))}」。<br>完成後點<b>關閉</b>回到 App。</div>`;
    const barCss =
      `.bar{position:sticky;top:0;background:#fff;padding:10px 0 8px;display:flex;gap:8px;` +
      `border-bottom:1px solid #eee;margin-bottom:12px;z-index:9}` +
      `.bar button{flex:1;padding:14px;font-size:16px;font-weight:700;border:none;border-radius:12px;` +
      `background:#0a84ff;color:#fff}` +
      `.bar button.sec{flex:0 0 96px;background:#eee;color:#111}` +
      `.tip{background:#fff8e1;border:1px solid #ffe0a3;border-radius:10px;padding:10px 12px;` +
      `margin:0 0 14px;font-size:14px;line-height:1.6}` +
      `@media print{.bar,.tip{display:none!important}}`;
    w.document.write(
      fullHtmlDoc(meeting, opts).replace('<body>', `<body><style>${barCss}</style>${bar}`)
    );
    w.document.close();
    return true;
  } catch (_) {
    return false;
  }
}

export function exportPdf(meeting, opts) {
  if (isStandaloneIOS() && printViaNewTab(meeting, opts)) return 'newtab';
  // 在「原頁面」列印（不開新分頁，印完即回到 App）。
  // iOS 會出現列印預覽，可用分享鈕存成 PDF；桌機列印可選「另存為 PDF」。
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.appendChild(root);
  }
  root.innerHTML = meetingToHtmlBody(meeting, opts);
  // 存成 PDF 的預設檔名來自 document.title（不像 Word 可以直接指定），列印期間換成會議名稱。
  // ⚠️ 不能綁 afterprint 還原：iOS Safari 在使用者真正按下「儲存到檔案」之前就會觸發它，
  // 太早還原檔名就會變回 App 標題（DD會議紀錄.pdf）。改成等使用者回到 App 有實際操作時
  // 才還原，並設長逾時保險。標題在 PWA 全螢幕下看不到，暫時維持會議名稱沒有副作用。
  const prevTitle = document.title;
  document.title = safeFileName(meeting.title);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onInteract, true);
    document.removeEventListener('keydown', onInteract, true);
    root.innerHTML = '';
    document.title = prevTitle;
  };
  const onInteract = () => setTimeout(restore, 0);
  const timer = setTimeout(restore, 5 * 60 * 1000);
  document.addEventListener('pointerdown', onInteract, true);
  document.addEventListener('keydown', onInteract, true);
  window.print();
}
