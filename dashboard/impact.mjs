/**
 * Lượt gọi nào THẬT SỰ chạm tới người dùng — nguồn duy nhất cho câu hỏi đó.
 *
 * Dashboard KHÔNG đếm lỗi thô. Phần lớn dòng `ok = false` là Lark đã trả lời
 * đàng hoàng, chỉ là trả "không": thiếu quyền, sai tham số, quá hạn mức. Model
 * đọc câu trả lời đó rồi đi đường khác hoặc gọi lại cho đúng, người dùng không
 * thấy gì cả. Đưa chúng lên bảng thì bảng lúc nào cũng đỏ lòm trong khi mọi
 * thứ chạy mượt — mà một cảnh báo luôn bật là một cảnh báo không ai đọc.
 *
 * Chỉ tính khi Lark KHÔNG trả lời được: endpoint trả HTML/404 (`non_json`)
 * hoặc mạng đứt. Đó là lúc model buộc phải nói với người dùng "không dùng
 * được tool này" — đúng thứ cần biết.
 *
 * Tách khỏi compute.mjs vì trang biểu đồ cũng cần đúng luật này. Để mỗi bên
 * tự định nghĩa thì hai trang cùng tên sẽ tô đỏ hai tập khác nhau.
 */

const RESCUE_MS = 5 * 60_000;

const isNoResponse = (r) =>
  r.lark_code === 'non_json' ||
  (!r.lark_code && /timeout|abort|fetch failed|network|econn|etimedout|socket|getaddrinfo/i.test(r.error_msg || ''));

/**
 * `lark_api_call` là cửa thoát hiểm: model tự đưa `method` + `path` bất kỳ.
 * 404 ở đây nghĩa là đường dẫn gõ sai, không phải hệ thống hỏng — mà 404 lại
 * trả về HTML nên nó rơi đúng vào `non_json`.
 *
 * Đánh đổi có thật: Lark đổi endpoint cũng ra 404 y hệt, và ở đây ta bỏ qua.
 * Chấp nhận được vì việc canh API đổi thuộc về canary.js, nơi đường dẫn do ta
 * cố định nên 404 chỉ có thể là Lark đổi thật.
 */
const RAW_TOOLS = new Set(['lark_api_call']);

/**
 * Tham số trỏ ra ngoài Lark thì hỏng là do người dùng đưa nhầm thứ.
 *
 * Đã gặp: một lượt `sheets_table_get` nhận link **Google Sheets**. Không tool
 * Lark nào mở được nó, nhưng lỗi trả về vẫn là 404 non_json nên bảng đọc thành
 * "hệ thống không phản hồi".
 *
 * Chỉ loại khi host KHÔNG thuộc Lark — link `.larksuite.com` hỏng vẫn tính,
 * vì đó mới đúng là thứ ta có trách nhiệm mở được.
 */
const LARK_HOST = /(^|\.)(larksuite\.com|feishu\.cn|larkoffice\.com)$/i;

function pointsOutsideLark(args) {
  const urls = String(args || '').match(/https?:\/\/[^\s"'\\]+/g);
  if (!urls) return false;
  return urls.some((u) => {
    try { return !LARK_HOST.test(new URL(u).hostname); } catch { return false; }
  });
}

/** Lỗi do người dùng/model đưa sai đầu vào — không phải hệ thống hỏng. */
const isUserInput = (r) => RAW_TOOLS.has(r.tool_name) || pointsOutsideLark(r.args);

/**
 * Trả về Set các dòng lỗi ĐÃ tới tay người dùng.
 *
 * Vẫn lọc "được cứu": nếu cùng người có lượt THÀNH CÔNG trong 5 phút kế tiếp
 * (model thử lại hoặc đi đường khác), coi như không tới tay người dùng.
 *
 * Đánh chỉ mục theo người rồi tìm nhị phân, không quét chéo toàn bộ: cửa sổ 90
 * ngày kèm cả nguồn zip đã lên chín nghìn dòng, mà quét chéo thì đó là tám
 * mươi triệu phép so — đủ để hàm serverless hết giờ.
 */
export function impactedSet(rows) {
  const okByUser = new Map();
  for (const r of rows) {
    if (r.ok !== true) continue;
    const k = r.user_name || '';
    if (!okByUser.has(k)) okByUser.set(k, []);
    okByUser.get(k).push(+new Date(r.created_at));
  }
  for (const a of okByUser.values()) a.sort((x, y) => x - y);

  /** Có lượt thành công nào của người này rơi vào (t, t + 5 phút] không? */
  const rescued = (user, t) => {
    const a = okByUser.get(user || '');
    if (!a) return false;
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m + 1; else hi = m; }
    return lo < a.length && a[lo] - t <= RESCUE_MS;
  };

  const out = new Set();
  for (const r of rows) {
    if (r.ok !== false || !isNoResponse(r)) continue;
    if (isUserInput(r)) continue;
    if (rescued(r.user_name, +new Date(r.created_at))) continue;
    out.add(r);
  }
  return out;
}
