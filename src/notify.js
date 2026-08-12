import { getBotToken, larkApi } from './lark.js';

/**
 * DM cảnh báo cho quản trị, dùng chung cho canary và keepalive.
 *
 * Tách ra khỏi canary.js vì giờ có hai thứ cần báo động, và cả hai đều phải
 * tuân đúng một luật: **cảnh báo chết không được phép làm chết thứ đang cảnh
 * báo**. Hàm này không bao giờ ném.
 *
 * Đọc env lúc gọi chứ không lúc nạp module: file này có thể được import trước
 * config.js (nơi nạp .env), và biến đọc ở tầng module sẽ vĩnh viễn rỗng — một
 * cái bẫy im lặng, vì không gửi được cảnh báo trông y hệt không có gì để báo.
 */
export const alertTarget = () =>
  (process.env.ALERT_OPEN_ID || process.env.CANARY_ALERT_OPEN_ID || process.env.CANARY_OPEN_ID || '').trim();

export async function dmAdmin(text) {
  const to = alertTarget();
  if (!to) return false;
  try {
    await larkApi('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'open_id' },
      body: { receive_id: to, msg_type: 'text', content: JSON.stringify({ text }) },
      token: await getBotToken(),
    });
    return true;
  } catch (e) {
    console.error('[notify] không gửi được cảnh báo:', e.message);
    return false;
  }
}
