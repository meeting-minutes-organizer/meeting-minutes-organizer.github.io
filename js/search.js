// 會議搜尋：比對標題、逐字稿、摘要文字（不分大小寫）
export function meetingSearchText(m) {
  const s = m.summary || {};
  const segs = (m.transcript || []).map((x) => `${x.speaker} ${x.text}`).join(' ');
  return [
    m.title || '',
    segs,
    ...(s.actionItems || []),
    ...(s.mainPoints || s.keyPoints || []),
    ...(s.qa || []),
  ]
    .join(' ')
    .toLowerCase();
}

export function matchMeeting(m, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return meetingSearchText(m).includes(q);
}
