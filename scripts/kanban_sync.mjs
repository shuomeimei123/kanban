// kanban_sync.mjs —— 从飞书「分销商库存明细」长表同步到 GitHub 看板(shuomeimei123/kanban/index.html)
// 零依赖(纯 node https)。本地和 GitHub Actions 共用。
// 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET, GH_TOKEN, KANBAN_REPO(可选,默认 shuomeimei123/kanban)
// 用法: node kanban_sync.mjs
import https from 'https';
import { writeFileSync } from 'fs';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.KANBAN_REPO || 'shuomeimei123/kanban';
const FS_APP = 'AtZKb9C9DaTObjsz7rhcENn7nuf';
const FS_TABLE = 'tblG621wCpIOlwGZ'; // 分销商库存明细长表

const CATS = ['U盘', '移动硬盘', 'TF', 'SD', '硬盘盒'];// per 固定品类顺序
// 看板 21 个分销商（排除「演示测试」等非真实账号）
const DIST_NAMES = ['塔成科技','沈阳拓展','沈阳新明天','深圳旺源','多义德','新疆方联','甘肃百恩','河南自营','一路友你','石家庄路加','南京鑫蒙华','合肥易芯邦','成都锦鑫','杭州赛畅','重庆卡德','华林','金马士','鑫天润','贵州新正','长春瑞拓','长沙正森'];

// ---- 通用 https 助手 ----
function req(host, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const r = https.request({ host, path, method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, timeout: 60000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { j = d; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('请求超时 ' + path)); });
    if (data) r.write(data); r.end();
  });
}

// ---- 飞书 token ----
async function fsToken() {
  const r = await req('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', 'POST', {}, { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  if (!r.json.tenant_access_token) throw new Error('飞书 token 失败: ' + JSON.stringify(r.json));
  return r.json.tenant_access_token;
}

// ---- 拉飞书长表全量 ----
async function fetchFeishu(tok) {
  const H = { Authorization: 'Bearer ' + tok };
  let items = [], pageToken = '', page = 0;
  do {
    page++;
    const qs = pageToken ? '?page_token=' + encodeURIComponent(pageToken) : '';
    const r = await req('open.feishu.cn', `/open-apis/bitable/v1/apps/${FS_APP}/tables/${FS_TABLE}/records/search${qs}`, 'POST', H, { page_size: 500 });
    if (!r.json.data) throw new Error('飞书 records 失败 page' + page + ': ' + JSON.stringify(r.json).slice(0, 200));
    const d = r.json.data;
    items = items.concat(d.items || []);
    console.log('  飞书 page', page, '本页', (d.items || []).length, 'has_more', d.has_more);
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return items;
}

// 取文本字段
function t(f) { return Array.isArray(f) ? (f[0] && f[0].text) : f; }
function num(f) { const v = typeof f === 'number' ? f : parseFloat(f); return isNaN(v) ? 0 : v; }

function weekNum(str) { const m = String(str).match(/\d+/); return m ? parseInt(m[0]) : 0; }

// ---- 生成 DETAILS 数组 ----
function buildDetails(records, distNames) {
  // 聚合: key=分销商|型号|品类
  const map = new Map();
  for (const r of records) {
    const f = r.fields || {};
    const dist = t(f['分销商']), sku = t(f['产品型号']), cat = t(f['品类']);
    if (!dist || !sku) continue;
    if (!CATS.includes(cat)) continue; // 只认已知品类
    const key = dist + '|' + sku + '|' + cat;
    const rec = { dist, sku, cat, stock: num(f['库存']), sale: num(f['销量']) };
    // upsert 语义下单 key 唯一；若历史残留多条，后出现(最后写入)覆盖
    map.set(key, rec);
  }
  // 按分销商分组
  const byDist = new Map(distNames.map(n => [n, { per: {} }]));
  for (const cat of CATS) {
    for (const [, v] of byDist) v.per[cat] = [];
  }
  for (const rec of map.values()) {
    const d = byDist.get(rec.dist);
    if (!d) continue; // 不在看板分销商清单内(如演示测试)则跳过
    // 计算 weeks & status
    let weeks = null, status;
    if (rec.sale > 0) {
      weeks = +(rec.stock / rec.sale).toFixed(1);
      status = weeks < 1 ? '缺货' : weeks < 2 ? '库存低' : weeks < 4 ? '偏低' : '正常';
    } else {
      status = rec.stock === 0 ? '缺货' : '正常';
    }
    if (status === '正常') continue; // 只保留需关注型号
    d.per[rec.cat].push({ sku: rec.sku, stock: rec.stock, sale: rec.sale, weeks, status });
  }
  // 转数组，品类内排序：缺货→库存低→偏低，再按 weeks 升序
  const out = [];
  for (const [name, v] of byDist) {
    const per = {};
    for (const cat of CATS) {
      const arr = v.per[cat].slice();
      const rank = { '缺货': 0, '库存低': 1, '偏低': 2 };
      arr.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.weeks ?? 999) - (b.weeks ?? 999)));
      per[cat] = arr;
    }
    out.push({ name, per });
  }
  return out;
}

// ---- 替换 index.html 中的 DETAILS ----
function findDetailsBounds(html) {
  const marker = 'const DETAILS = [';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('index.html 中找不到 ' + marker);
  // 定位 DETAILS 之后的 function openDetail，取其前最后一个 '];' 作为数组结尾
  const fnIdx = html.indexOf('\nfunction openDetail', start);
  if (fnIdx < 0) throw new Error('找不到 function openDetail');
  const beforeFn = html.slice(start, fnIdx);
  const relEnd = beforeFn.lastIndexOf('];');
  if (relEnd < 0) throw new Error('找不到 DETAILS 结束标记');
  const end = start + relEnd + 1; // end 指向 '];' 中的 ';' 位置（] 之后）
  return { start, end, marker };
}

function parseExistingDetails(html) {
  const { start, end, marker } = findDetailsBounds(html);
  const jsonStr = html.slice(start + marker.length, end); // 以 ']' 结尾的合法 JSON
  return JSON.parse(jsonStr);
}

function replaceDetails(html, detailsJson) {
  const { start, end, marker } = findDetailsBounds(html);
  const head = html.slice(0, start + marker.length);
  const tail = html.slice(end); // 从 '];' 的 ']' 开始
  return head + detailsJson + tail;
}

// ---- GitHub: 读取并更新 index.html ----
async function ghGet(path) {
  const r = await req('api.github.com', `/repos/${REPO}/contents/${path}`, 'GET', { Authorization: 'token ' + GH_TOKEN, 'User-Agent': 'clawd', 'Accept': 'application/vnd.github+json' });
  if (!r.json.content) throw new Error('gh get fail ' + path + ': ' + JSON.stringify(r.json).slice(0, 150));
  return { sha: r.json.sha, content: Buffer.from(r.json.content, 'base64').toString('utf8') };
}
async function ghPut(path, content, sha, msg) {
  const r = await req('api.github.com', `/repos/${REPO}/contents/${path}`, 'PUT', { Authorization: 'token ' + GH_TOKEN, 'User-Agent': 'clawd', 'Accept': 'application/vnd.github+json' }, { message: msg, content: Buffer.from(content).toString('base64'), sha });
  return r.status === 200 || r.status === 201 ? r.json.commit : (() => { throw new Error('gh put fail: ' + JSON.stringify(r.json).slice(0, 250)); })();
}

// ---- 主流程 ----
async function main() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !GH_TOKEN) throw new Error('缺少 env: FEISHU_APP_ID/FEISHU_APP_SECRET/GH_TOKEN');
  console.log('拉取飞书长表...');
  const tok = await fsToken();
  const records = await fetchFeishu(tok);
  console.log('飞书记录数:', records.length);

  console.log('读取当前看板 index.html...');
  const gh = await ghGet('index.html');
  const html = gh.content;

  // 分销商清单固定为 21 个真实账号
  const distNames = DIST_NAMES;
  console.log('看板分销商数:', distNames.length);

  const details = buildDetails(records, distNames);
  const json = JSON.stringify(details).replace(/</g, '\\u003c'); // 防 HTML 注入
  console.log('需关注型号总数:', details.reduce((s, d) => s + CATS.reduce((x, c) => x + d.per[c].length, 0), 0));

  const newHtml = replaceDetails(html, json);
  console.log('新 index.html 长度:', newHtml.length, '(原', html.length, ')');

  // 本地调试可选落盘
  if (process.env.WRITE_LOCAL) writeFileSync(process.env.WRITE_LOCAL, newHtml);

  console.log('推送 GitHub...');
  const commit = await ghPut('index.html', newHtml, gh.sha, `同步分销商库存看板 ${new Date().toISOString().slice(0,16)}`);
  console.log('推送成功:', commit.sha.slice(0, 8));
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
