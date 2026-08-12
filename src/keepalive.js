import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listUsers, getUser } from './store.js';
import { getValidAccessToken } from './lark-auth.js';
import { auditAuth, flushAudit } from './audit.js';
import { dmAdmin } from './notify.js';

/**
 * Keepalive — giữ phiên Lark sống cho MỌI người, không chỉ tài khoản canary.
 *
 * Refresh token của Lark là cửa sổ TRƯỢT: mỗi lần xoay, Lark cấp phiếu mới với
 * hạn 7 ngày trọn vẹn. Đo trên dữ liệu thật để chắc, không đoán theo tài liệu —
 * `refreshExpiresAt` luôn cách `updatedAt` đúng 168h, kể cả ở tài khoản đã bị
 * canary xoay token hàng chục lần. Nên chỉ cần chạm vào một lần trong 7 ngày là
 * phiên sống mãi.
 *
 * Trước file này, đúng một người được hưởng điều đó, và là do vô tình: canary
 * chạy dưới danh nghĩa `CANARY_OPEN_ID` nên tiện thể xoay token cho họ mỗi 2
 * tiếng. Ai nghỉ dài hơn 7 ngày thì mất phiên, phải quét lại mã.
 *
 * Chi phí: một request tới token endpoint cho mỗi người mỗi lượt. Không gọi API
 * nghiệp vụ nào, không đụng dữ liệu của ai.
 *
 * ĐÂY LÀ ĐÁNH ĐỔI, KHÔNG PHẢI SỬA LỖI. Hết hạn sau 7 ngày im lặng vốn là một cơ
 * chế thu hồi tự nhiên: ai nghỉ việc thì quyền tự rụng mà không cần ai nhớ. Bật
 * cái này nghĩa là phiên sống tới khi có người CHỦ ĐỘNG thu hồi — nên
 * `npm run revoke` chuyển từ "nên làm" thành BẮT BUỘC trong quy trình offboarding.
 * Đặt `KEEPALIVE_EVERY_HOURS=0` để tắt.
 */

const EVERY_H = Number(process.env.KEEPALIVE_EVERY_HOURS ?? 12);
const STATE_FILE = path.join(config.dataDir, 'keepalive.json');

/** Dưới ngưỡng này thì coi là sắp rụng, đưa vào báo cáo hằng ngày. */
const DYING_H = 48;

/**
 * Thử lại tối đa ngần này lượt cho CÙNG một bản ghi token.
 *
 * Lark từ chối refresh token trong khi đồng hồ của ta vẫn thấy còn hạn là
 * chuyện có thật: admin gỡ app, người dùng đổi mật khẩu, tenant thu hồi quyền.
 * Không chặn thì cứ 12 tiếng lại một lượt gọi hỏng cộng một dòng audit, mãi
 * mãi. Mốc so sánh là `updatedAt` — người đó đăng nhập lại thì bản ghi đổi và
 * bộ đếm tự về 0, không cần ai đi dọn state bằng tay.
 */
const MAX_FAILS = 3;

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (s) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[keepalive] không ghi được state:', e.message);
  }
};

const today = () => new Date().toISOString().slice(0, 10);
const hoursLeft = (u) => (u.refreshExpiresAt - Date.now()) / 3_600_000;

export async function runKeepalive() {
  const state = loadState();
  const renewed = []; // đã xoay được token trong lượt này
  const dying = []; // còn sống nhưng dưới ngưỡng
  const newlyDead = []; // vừa mất phiên ở lượt này
  const recovered = []; // đã đăng nhập lại sau khi mất
  const netFail = []; // không hỏi được Lark — chưa kết luận gì
  let alive = 0;

  for (const openId of listUsers()) {
    const u = getUser(openId);
    if (!u) continue; // giải mã hỏng — việc của store, không phải của keepalive
    const who = u.name || openId.slice(0, 12);
    const prev = state[openId] || {};

    // Đã quá hạn thì KHÔNG gọi API. Chắc chắn hỏng, và mỗi lần gọi lại đẻ thêm
    // một dòng reauth_required cho một sự thật đã biết từ lượt trước.
    if (hoursLeft(u) <= 0) {
      if (!prev.dead) newlyDead.push(`${who} — quá 7 ngày không dùng`);
      state[openId] = { name: u.name, dead: true, reason: 'quá 7 ngày không dùng' };
      continue;
    }

    // Đã hỏng đủ số lượt trên đúng bản ghi này: dừng thử cho tới khi người đó
    // đăng nhập lại. Thử tiếp cũng chỉ nhận đúng câu trả lời cũ.
    if (prev.failedOn === u.updatedAt && (prev.fails || 0) >= MAX_FAILS) continue;

    try {
      await getValidAccessToken(openId);
      const after = getUser(openId);
      const left = hoursLeft(after);
      // `updatedAt` đổi nghĩa là ĐÃ xoay token thật, không phải dùng lại token
      // cũ còn hạn — phân biệt được thì mới biết keepalive có tác dụng gì không.
      if (after.updatedAt !== u.updatedAt) renewed.push(who);
      if (prev.dead || prev.fails) recovered.push(who);
      if (left < DYING_H) dying.push(`${who} (${left.toFixed(0)}h)`);
      alive++;
      state[openId] = { name: after.name, leftH: Math.round(left) };
    } catch (e) {
      // Lỗi mạng KHÔNG phải mất phiên — cùng lý do pollDeviceFlow tách 'network'
      // khỏi 'error'. Một cú fetch hỏng không được phép báo là người ta đã bị
      // đăng xuất, và càng không được phép đốt một lượt trong MAX_FAILS. Chỉ
      // ReauthRequired mới là câu trả lời dứt khoát từ phía Lark.
      if (!e.reauth) {
        netFail.push(`${who}: ${e.message}`);
        continue;
      }
      const fails = (prev.failedOn === u.updatedAt ? prev.fails || 0 : 0) + 1;
      if (!prev.dead) newlyDead.push(`${who} — ${e.message}`);
      state[openId] = { name: u.name, dead: true, fails, failedOn: u.updatedAt, reason: e.message };
    }
  }

  /**
   * Một dòng audit mỗi ngày, cộng thêm dòng mỗi khi có chuyển trạng thái.
   *
   * Chạy 2 lượt/ngày mà ghi hết là 2 dòng/ngày toàn "vẫn ổn" — nhỏ hơn cái bệnh
   * của canary nhưng cùng bản chất. Đổi lại, dòng nhịp tim này là chỗ DUY NHẤT
   * dashboard nhìn thấy được hạn refresh token: dữ liệu đó nằm trong
   * tokens.json mã hoá trên máy chủ, Supabase không có đường nào chạm tới.
   */
  const meta = state.__meta || {};
  const changed = newlyDead.length > 0 || recovered.length > 0;
  if (changed || meta.heartbeat !== today()) {
    state.__meta = { ...meta, heartbeat: today() };
    auditAuth({
      event: 'keepalive',
      ok: newlyDead.length === 0,
      errorMsg: newlyDead.length ? `${newlyDead.length} phiên vừa mất` : null,
      // Cắt danh sách ở 10 tên: audit cắt `args` ở 2000 ký tự, và một chuỗi
      // JSON bị cắt giữa chừng thì không parse được nữa — mất cả dòng chứ
      // không phải mất phần đuôi. Số đếm mới là thứ phải luôn đúng.
      detail: {
        alive,
        renewed: renewed.length,
        dyingCount: dying.length,
        deadCount: newlyDead.length,
        netFail: netFail.length,
        dying: dying.slice(0, 10),
        dead: newlyDead.slice(0, 10),
        recovered: recovered.slice(0, 10),
      },
    });
  }

  saveState(state);

  const lines = [];
  if (newlyDead.length) lines.push(`❌ Mất phiên Lark, cần đăng nhập lại:\n${newlyDead.map((s) => `• ${s}`).join('\n')}`);
  if (recovered.length) lines.push(`✅ Đã đăng nhập lại: ${recovered.join(', ')}`);
  if (lines.length) await dmAdmin(`Lark MCP — keepalive\n\n${lines.join('\n\n')}`);

  console.log(
    `[keepalive] ${alive} phiên sống, ${renewed.length} vừa gia hạn` +
      (dying.length ? `, sắp hết: ${dying.join(', ')}` : '') +
      (netFail.length ? `, không hỏi được: ${netFail.length}` : '') +
      (newlyDead.length ? `, MẤT: ${newlyDead.length}` : ''),
  );
}

export function startKeepalive() {
  if (!EVERY_H) return console.log('  keepal.: TẮT (KEEPALIVE_EVERY_HOURS=0)');
  console.log(`  keepal.: mỗi ${EVERY_H}h, giữ phiên Lark cho ${listUsers().length} người`);

  const tick = () => {
    runKeepalive()
      .catch((e) => console.error('[keepalive]', e.message))
      // Hẹn lượt sau khi lượt này XONG, giống canary: một lượt chạy lâu bất
      // thường không được phép để lượt kế chồng lên.
      .finally(() => setTimeout(tick, EVERY_H * 3_600_000).unref());
  };
  // Chậm hơn canary (15s) để hai thứ không cùng đập vào token endpoint lúc khởi
  // động. Khoá theo user vẫn bảo vệ được, nhưng xếp hàng thì không cần dùng tới.
  setTimeout(tick, 60_000).unref();
}

/**
 * Chạy tay: `npm run keepalive`. Dùng khi vừa dựng lại server sau một đợt tắt
 * dài và muốn biết ai còn ai mất NGAY, thay vì đợi lượt đầu tiên.
 *
 * Phải `flushAudit()` trước khi thoát: hàng đợi audit gom lô 5 giây, process
 * ngắn hơn thế thì dòng nhịp tim không bao giờ rời khỏi bộ nhớ.
 */
if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/keepalive.js')) {
  await runKeepalive();
  await flushAudit();
  process.exit(0);
}
