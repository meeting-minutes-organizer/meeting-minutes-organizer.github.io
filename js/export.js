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
  if (want.transcript) html += `<h2>🗣️ 逐字稿 Transcribe</h2>${segs || '<p class="none">（無逐字稿）</p>'}`;
  return html;
}

const STYLE = `
  body{font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;line-height:1.7;color:#111;max-width:820px;margin:24px auto;padding:0 18px;}
  h1{font-size:22px;margin:0 0 4px;}
  .date{color:#666;margin:0 0 18px;}
  h2{font-size:16px;border-bottom:2px solid #0a84ff;padding-bottom:4px;margin:22px 0 8px;color:#0a6;}
  ul{margin:6px 0;padding-left:22px;} li{margin:5px 0;}
  p{margin:6px 0;} .seg{margin:4px 0;} .none{color:#999;}
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
    const hint =
      `<div class="tip">👆 請按 Safari 的<b>分享鈕</b> → <b>列印</b> → 再用分享鈕儲存 PDF。` +
      `<br>檔名會是「${esc(safeFileName(meeting.title))}」。</div>`;
    w.document.write(
      fullHtmlDoc(meeting, opts).replace(
        '<body>',
        `<body><style>.tip{background:#fff8e1;border:1px solid #ffe0a3;border-radius:10px;padding:10px 12px;margin:0 0 14px;font-size:14px;line-height:1.6}@media print{.tip{display:none}}</style>${hint}`
      )
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
