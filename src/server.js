import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { buildOAuthRouter, resolveBearer } from './oauth-as.js';
import { getValidAccessToken } from './lark-auth.js';
import { registerTools, TOOL_COUNT } from './tools/index.js';
import { listUsers } from './store.js';
import { auditEnabled, auditAuth, flushAudit } from './audit.js';
import { readFile, resetFiles } from './files.js';
import { startCanary } from './canary.js';
import { startKeepalive } from './keepalive.js';

resetFiles(); // file tạm của lần chạy trước không còn ai giữ link

const app = express();
app.disable('x-powered-by');

// Log truy cập — không có cái này thì không biết Claude đã gọi tới hay chưa
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    const ua = (req.headers['user-agent'] || '').slice(0, 40);
    // /files nhận bearer qua ?token= (browser không gửi được header Authorization).
    // Che giá trị token trước khi log — nếu không, bearer sống 30 ngày rơi vào stdout.
    const url = req.originalUrl.replace(/([?&]token=)[^&]*/gi, '$1[redacted]').slice(0, 90);
    console.log(`${new Date().toISOString().slice(11, 19)} ${res.statusCode} ${req.method} ${url} ${Date.now() - t}ms "${ua}"`);
  });
  next();
});

app.use(buildOAuthRouter());

app.get('/health', (_req, res) => res.json({ ok: true, tools: TOOL_COUNT, users: listUsers().length }));

// ── Tải file do tool xuất ra ──────────────────────────────────────────────
// Server không ghi được vào ổ đĩa người dùng, nên tool xuất file trả về link
// này. Vẫn yêu cầu bearer: file có thể chứa dữ liệu nội bộ.
app.get('/files/:id', (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
  const session = resolveBearer(bearer);
  if (!session) return res.status(401).send('Cần đăng nhập.');

  const f = readFile(req.params.id, session.openId);
  if (!f) return res.status(404).send('File không tồn tại hoặc đã hết hạn.');

  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
  f.stream.pipe(res);
});

/**
 * Ghi lại lượt bị từ chối ở cửa — có tiết chế.
 *
 * Đây là điểm mù lớn nhất của bảng audit: nó chỉ thấy những gì ĐÃ QUA được cửa
 * xác thực. Đúng lúc hỏng nặng nhất — không ai nối vào được — bảng sẽ hiển thị
 * "0 lỗi", vì im lặng và khoẻ mạnh trông giống hệt nhau.
 *
 * Nhưng URL này công khai qua tunnel, bot quét cổng cũng đâm vào đây. Không tiết
 * chế thì một con bot đủ sức bơm đầy bảng và đẩy log thật ra ngoài hàng đợi.
 * Nhiều nhất một dòng mỗi phút, kèm số lượt đã nuốt để vẫn thấy được quy mô.
 */
const DENY_EVERY_MS = 60_000;
let denyLoggedAt = 0;
let denySwallowed = 0;

function noteDenied(session, req) {
  denySwallowed++;
  if (Date.now() - denyLoggedAt < DENY_EVERY_MS) return;
  auditAuth({
    event: 'denied',
    // Gửi refresh token vào chỗ của access token là client cấu hình sai chứ
    // không phải người lạ — và ở trường hợp đó ta biết chính xác là ai.
    openId: session?.openId || null,
    userName: session?.name || null,
    clientId: session?.clientId || null,
    ok: false,
    errorMsg: session ? `sai loại token (${session.kind})` : 'thiếu bearer hoặc bearer không hợp lệ',
    detail: { swallowed: denySwallowed - 1, ua: (req.headers['user-agent'] || '').slice(0, 60) },
  });
  denyLoggedAt = Date.now();
  denySwallowed = 0;
}

// ── /mcp ──────────────────────────────────────────────────────────────────
// Stateless: mỗi request dựng server+transport riêng. Không có state dùng chung
// giữa các user, nên không có đường nào để danh tính lẫn nhau.
app.post('/mcp', express.json({ limit: '8mb' }), async (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = resolveBearer(bearer);

  if (!session || session.kind !== 'access') {
    noteDenied(session, req);
    // Bắt buộc theo spec MCP: chỉ cho Claude biết phải đi đâu để xin quyền
    res.set('WWW-Authenticate', `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Chưa xác thực' },
      id: req.body?.id ?? null,
    });
  }

  const mcp = new McpServer(
    { name: 'lark-mcp-remote', version: config.version },
    { capabilities: { tools: {} } },
  );

  // Token Lark được lấy lười, đúng lúc tool cần — và luôn qua khoá per-user
  registerTools(mcp, () => getValidAccessToken(session.openId), {
    openId: session.openId,
    name: session.name,
    clientId: session.clientId,
    clientApp: session.clientApp,
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    mcp.close();
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp]', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
});

// Stateless nên không hỗ trợ SSE stream mở sẵn
const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Chỉ hỗ trợ POST' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

const server = app.listen(config.port, () => {
  console.log(`Lark MCP remote v3 — http://localhost:${config.port}`);
  console.log(`  public : ${config.publicUrl}`);
  console.log(`  tools  : ${TOOL_COUNT}`);
  console.log(`  users  : ${listUsers().length} đã đăng nhập`);
  console.log(`  audit  : ${auditEnabled ? "Supabase → audit_logs (source='url')" : 'TẮT (thiếu SUPABASE_URL / SERVICE_ROLE_KEY)'}`);
  console.log(`  machine: ${auditEnabled ? "Supabase → machines (machine_id 'url-*')" : 'TẮT'}`);
  startCanary();
  startKeepalive();
});

// Tắt êm để không mất lô audit cuối cùng
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await flushAudit();
    process.exit(0);
  });
}
