// 螢幕恆亮（Screen Wake Lock）：長辨識期間避免螢幕自動變暗／鎖定，
// 因為畫面一暗、頁面就會被系統暫停，運算隨即中斷。
//
// ⚠️ 關鍵：依規範，頁面一轉到背景（切 App、螢幕鎖上）系統就會「自動釋放」這把鎖，
// 而且不會自己回來。只申請一次的話，第一次變暗之後就永遠失去保護 ——
// 所以必須在每次回到前景時重新申請。
let lock = null;
let wanted = false;

export function isSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator && !!navigator.wakeLock;
}
export function isHeld() {
  return !!lock;
}

async function acquire() {
  if (!wanted || lock || !isSupported()) return;
  try {
    const s = await navigator.wakeLock.request('screen');
    // 系統收走時把狀態同步掉，下次回前景才知道要重新申請
    if (s && typeof s.addEventListener === 'function') {
      s.addEventListener('release', () => {
        if (lock === s) lock = null;
      });
    }
    lock = s;
  } catch (_) {
    lock = null; // 不支援／被拒（低電量模式等）→ 靜默略過，不能讓辨識因此失敗
  }
}

// 開始需要恆亮（辨識任務開始時呼叫）
export async function start() {
  wanted = true;
  await acquire();
}

// 不再需要恆亮（任務結束／停止／失敗時呼叫）
export async function stop() {
  wanted = false;
  const s = lock;
  lock = null;
  if (s && typeof s.release === 'function') {
    try {
      await s.release();
    } catch (_) {}
  }
}

// 回到前景時呼叫：任務還在跑就把被系統收走的鎖重新拿回來
export async function onVisible() {
  await acquire();
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onVisible();
  });
}
