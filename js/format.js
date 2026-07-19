function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(ts) {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function defaultTitle(fileName, ts) {
  const base = (fileName || '').replace(/\.[^.]+$/, '').trim();
  return base || `會議 ${formatDate(ts)}`;
}

// 把分段逐字稿（{speaker,text}[]）攤平成純文字，供複製與摘要片段使用
export function transcriptToText(segments) {
  return (segments || []).map((s) => `${s.speaker}：${s.text}`).join('\n');
}
