/**
 * Khoảng thời gian — MỘT nguồn duy nhất cho trang, hai endpoint và bản dựng tĩnh.
 *
 * Trước đây mỗi bên tự hiểu lấy: `WINDOWS = [7, 30, 90]` là danh sách trắng ở
 * explore-schema, còn `windowDays = 30` chốt cứng trong compute.mjs. Hệ quả là
 * ô chọn "Khoảng" chỉ điều khiển đúng một biểu đồ ở cuối trang, trong khi mọi
 * con số phía trên vẫn là 30 ngày — người đọc không có cách nào biết điều đó.
 * Gom về đây để "khoảng đang xem" là MỘT khái niệm, ai hỏi cũng ra một đáp án.
 *
 * Hai việc file này làm:
 *   1. Chuẩn hoá + kẹp biên một khoảng do người dùng chọn (kể cả khoảng bịa từ
 *      query string) thành cặp mốc UTC đưa thẳng vào PostgREST.
 *   2. Cắt ngày/giờ theo GIỜ VIỆT NAM, không theo UTC — xem ghi chú bên dưới.
 */

/**
 * Múi giờ cố định +07:00, không đọc từ máy người xem.
 *
 * `created_at` là UTC. Cắt ngày bằng `slice(0, 10)` (bản cũ làm thế) tức là cắt
 * theo ngày UTC, mà ranh giới ngày UTC rơi vào **7 giờ sáng** giờ Việt Nam: mọi
 * lượt gọi từ 0h đến 7h sáng bị tính sang ngày HÔM TRƯỚC. Không ai để ý vì cột
 * nào cũng có số, chỉ là số nằm nhầm cột — và nó nhầm nhiều nhất đúng vào lúc
 * người ta bắt đầu ngày làm việc.
 *
 * Chốt cứng +07:00 chứ không lấy múi giờ trình duyệt: máy chủ tính một kiểu,
 * trình duyệt tính kiểu khác thì cùng một trang cho hai con số khác nhau tuỳ ai
 * mở. Cả tổ chức ngồi cùng một múi giờ, chốt cứng là đúng và kiểm tra được.
 */
export const TZ_MIN = 7 * 60;
const TZ_MS = TZ_MIN * 60000;
const DAY_MS = 86400000;

/**
 * Trần độ dài khoảng.
 *
 * Không phải con số cho đẹp: cả hai endpoint đọc hàng thô theo trang 1000 dòng
 * NỐI ĐUÔI nhau (xem vòng lặp ở api/explore.js và compute.mjs). Một khoảng đủ
 * dài là một chuỗi round-trip đủ dài để hàm serverless hết giờ — và nó sẽ hết
 * giờ vào lúc bảng audit đã lớn, tức là lúc không ai còn nhớ trần này ở đâu.
 * Chặn tại đây, chặn cả ở phía máy chủ, đừng tin trang gửi lên số hợp lệ.
 */
export const MAX_RANGE_DAYS = 180;

const shift = (iso) => new Date(new Date(iso).getTime() + TZ_MS);

/** 'YYYY-MM-DD' theo giờ VN của một mốc thời gian ISO. */
export const localDay = (iso) => shift(iso).toISOString().slice(0, 10);

/** '14:00' — giờ trong ngày theo giờ VN. */
export const localHour = (iso) => shift(iso).toISOString().slice(11, 13) + ':00';

/** Hôm nay theo giờ VN. */
export const today = () => new Date(Date.now() + TZ_MS).toISOString().slice(0, 10);

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** Cộng ngày trên chuỗi 'YYYY-MM-DD', không đụng tới múi giờ máy đang chạy. */
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/** Số ngày của khoảng, TÍNH CẢ hai đầu — 12/08→12/08 là 1 ngày, không phải 0. */
export const spanDays = (from, to) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;

/**
 * Mốc sẵn. Giữ preset BÊN CẠNH lịch chứ không thay bằng lịch:
 * chọn "30 ngày" là một cú bấm, còn qua lịch là mở, định vị tháng, bấm hai đầu,
 * đóng — bốn thao tác cho đúng thứ 90% lượt mở trang cần.
 */
export const PRESETS = [
  { key: 'today', label: 'Hôm nay', days: 1 },
  { key: '7d', label: '7 ngày', days: 7 },
  { key: '30d', label: '30 ngày', days: 30 },
  { key: '90d', label: '90 ngày', days: 90 },
];

export const DEFAULT_PRESET = '30d';

/** Mốc sẵn → cặp ngày. Tính lại mỗi lần gọi, để qua nửa đêm là nó tự trôi theo. */
export function presetRange(key) {
  const p = PRESETS.find((x) => x.key === key) || PRESETS.find((x) => x.key === DEFAULT_PRESET);
  const to = today();
  return { from: addDays(to, -(p.days - 1)), to, preset: p.key };
}

/**
 * Chuẩn hoá khoảng từ tham số bất kỳ (query string, URL dán tay, state của trang).
 *
 * KHÔNG bao giờ ném lỗi: một ngày viết sai trong URL mà làm trắng cả trang là
 * đổi một phiền toái nhỏ lấy một sự cố. Sai thì rơi về mốc mặc định, và trả kèm
 * `clamped` để trang nói cho người xem biết nó đã tự sửa gì.
 *
 * Trả về cả `since`/`until` dạng ISO UTC (`until` là mốc LOẠI TRỪ) để dùng thẳng
 * với `created_at=gte.…&created_at=lt.…`. Dùng `lt` chứ không `lte`: `lte` với
 * mốc cuối ngày phải viết `23:59:59.999`, và một lượt gọi rơi đúng phần nghìn
 * giây còn lại sẽ biến mất khỏi mọi con số mà không ai truy ra được.
 */
export function resolveRange(q = {}) {
  const notes = [];
  const max = today();

  // Có preset hợp lệ thì preset thắng: nó là ý định "luôn tính tới hôm nay",
  // còn cặp from/to đi kèm chỉ là ảnh chụp của ý định đó tại lúc dán link.
  const wanted = String(q.preset || '').trim();
  if (PRESETS.some((p) => p.key === wanted)) return finish(presetRange(wanted), notes);

  let from = String(q.from || '').trim();
  let to = String(q.to || '').trim();
  if (!isDay(from) || !isDay(to)) return finish(presetRange(DEFAULT_PRESET), notes);

  if (from > to) { const t = from; from = to; to = t; notes.push('Đã đổi chỗ hai đầu ngày cho đúng thứ tự.'); }
  if (to > max) { to = max; notes.push('Ngày cuối vượt quá hôm nay — đã kéo về hôm nay.'); }
  if (from > to) from = to;
  if (spanDays(from, to) > MAX_RANGE_DAYS) {
    from = addDays(to, -(MAX_RANGE_DAYS - 1));
    notes.push(`Khoảng dài quá ${MAX_RANGE_DAYS} ngày — đã cắt còn ${MAX_RANGE_DAYS} ngày gần nhất.`);
  }
  return finish({ from, to, preset: null }, notes);
}

function finish({ from, to, preset }, notes) {
  const startMs = Date.parse(from + 'T00:00:00Z') - TZ_MS;
  return {
    from, to, preset,
    days: spanDays(from, to),
    since: new Date(startMs).toISOString(),
    until: new Date(Date.parse(to + 'T00:00:00Z') - TZ_MS + DAY_MS).toISOString(),
    clamped: notes,
  };
}

/** Khoảng → tham số URL gọn nhất: mốc sẵn đi một chữ, khoảng tay đi hai ngày. */
export function rangeQuery(r) {
  return r.preset ? { preset: r.preset } : { from: r.from, to: r.to };
}
