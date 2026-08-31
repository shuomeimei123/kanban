// kanban_sync.mjs —— 从飞书「分销商库存明细」长表全量重建 GitHub 看板(shuomeimei123/kanban/index.html)
// 零依赖(纯 node https)。本地和 GitHub Actions 共用。
// 重建 4 个数据区: ①主矩阵 tbody ②按品类预警 cat-grid ③各分销商明细 distcard ④const DETAILS(弹窗)
// 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET, GH_TOKEN, KANBAN_REPO(可选)
import https from 'https';
import { writeFileSync } from 'fs';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.KANBAN_REPO || 'shuomeimei123/kanban';
const FS_APP = 'AtZKb9C9DaTObjsz7rhcENn7nuf';
const FS_TABLE = 'tblG621wCpIOlwGZ';

const CATS = ['U盘', '移动硬盘', 'TF', 'SD', '硬盘盒'];
const DIST_NAMES = ['塔成科技','沈阳拓展','沈阳新明天','深圳旺源','多义德','新疆方联','甘肃百恩','河南自营','一路友你','石家庄路加','南京鑫蒙华','合肥易芯邦','成都锦鑫','杭州赛畅','重庆卡德','华林','金马士','鑫天润','贵州新正','长春瑞拓','长沙正森'];
const CHIP_SHOW = 12; // 按品类预警每类默认显示 chip 数

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
async function fsToken() {
  const r = await req('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', 'POST', {}, { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  if (!r.json.tenant_access_token) throw new Error('飞书 token 失败: ' + JSON.stringify(r.json));
  return r.json.tenant_access_token;
}
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
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return items;
}
function t(f) { return Array.isArray(f) ? (f[0] && f[0].text) : f; }
function num(f) { const v = typeof f === 'number' ? f : parseFloat(f); return isNaN(v) ? 0 : v; }
function fmt(n) {
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  const [i, d] = s.split('.');
  const iii = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return d ? iii + '.' + d : iii;
}

// 聚合: 分销商|型号|品类 -> {dist,sku,cat,stock,sale,weeks,status}
function buildData(records) {
  const map = new Map();
  for (const r of records) {
    const f = r.fields || {};
    const dist = t(f['分销商']), sku = t(f['产品型号']), cat = t(f['品类']);
    if (!dist || !sku || !CATS.includes(cat)) continue;
    const key = dist + '|' + sku + '|' + cat;
    const stock = num(f['库存']), sale = num(f['销量']);
    let weeks = null, status;
    if (sale > 0) {
      weeks = +(stock / sale).toFixed(1);
      status = weeks < 1 ? '缺货' : weeks < 2 ? '库存低' : weeks < 4 ? '偏低' : '正常';
    } else status = stock === 0 ? '缺货' : '正常';
    map.set(key, { dist, sku, cat, stock, sale, weeks, status });
  }
  return map;
}
function rank(st) { return st === '缺货' ? 0 : st === '库存低' ? 1 : st === '偏低' ? 2 : 3; }

// ① 主矩阵 tbody
function buildMatrix(data) {
  let rows = '';
  for (const name of DIST_NAMES) {
    const arr = [...data.values()].filter(d => d.dist === name);
    const byCat = {}; for (const c of CATS) byCat[c] = arr.filter(x => x.cat === c);
    let totalStock = 0, totalQty = 0, cells = '';
    for (const c of CATS) {
      const a = byCat[c];
      if (a.length === 0) { cells += '<td class="na">—</td>'; continue; }
      a.sort((x, y) => rank(x.status) - rank(y.status) || ((x.weeks ?? 999) - (y.weeks ?? 999)));
      const sum = a.reduce((s, x) => s + x.stock, 0);
      const qHuo = a.filter(x => x.status === '缺货').length;
      const qJing = a.filter(x => x.status === '库存低' || x.status === '偏低').length;
      totalStock += sum; totalQty += qHuo;
      const key = name + '|' + c;
      if (qHuo > 0) cells += `<td><span class="cell empty big clickable" data-key="${key}">${fmt(sum)}<i class="wk">缺${qHuo}</i></span></td>`;
      else if (qJing > 0) cells += `<td><span class="cell ok clickable" data-key="${key}">${fmt(sum)}<i class="wk">警${qJing}</i></span></td>`;
      else if (sum < 50) cells += `<td><span class="cell warn2" data-key="${key}">${fmt(sum)}</span></td>`;
      else cells += `<td><span class="cell ok" data-key="${key}">${fmt(sum)}</span></td>`;
    }
    const qtyCell = totalQty > 0 ? `<td class="tot red"><b>${totalQty}</b></td>` : '<td class="tot ">—</td>';
    rows += `<tr><td class="rowhead">${name}</td>${cells}<td class="tot"><b>${fmt(totalStock)}</b></td>${qtyCell}</tr>`;
  }
  return rows;
}

// ② 按品类预警 cat-grid
function buildWarnGrid(data) {
  let html = '';
  for (const c of CATS) {
    const arr = [...data.values()].filter(d => d.cat === c && d.status !== '正常')
      .sort((x, y) => rank(x.status) - rank(y.status) || ((x.weeks ?? 999) - (y.weeks ?? 999)));
    const qHuo = arr.filter(x => x.status === '缺货').length;
    const qJing = arr.filter(x => x.status === '库存低' || x.status === '偏低').length;
    const total = arr.length;
    let chips = '';
    const showN = Math.min(arr.length, CHIP_SHOW);
    for (let i = 0; i < showN; i++) {
      const x = arr[i];
      if (x.status === '缺货') chips += `<span class="chip chip-0">${x.dist}·${x.sku}</span>`;
      else chips += `<span class="chip chip-l">${x.dist}·${x.sku}(${x.weeks}周)</span>`;
    }
    const more = total > showN ? `<span class="more">+${total - showN}</span>` : '';
    html += `<div class="cata warn">
      <div class="cata-h"><b>${c}</b>
        <span class="cata-n">缺货 ${qHuo} · 低 ${qJing} · 共${total}</span>
      </div>
      <div class="cata-list">${chips}${more}</div>
    </div>`;
  }
  return html;
}

// ③ 各分销商明细 distcard
function buildDistCards(data) {
  let html = '';
  for (const name of DIST_NAMES) {
    const arr = [...data.values()].filter(d => d.dist === name);
    const totalStock = arr.reduce((s, x) => s + x.stock, 0);
    const totalHuo = arr.filter(x => x.status === '缺货').length;
    const totalSale = arr.reduce((s, x) => s + x.sale, 0);
    let grid = '';
    for (const c of CATS) {
      const a = arr.filter(x => x.cat === c);
      if (a.length === 0) { grid += `<div class="dc"><span class="dc-t">${c}</span><span class="na2">未经营</span></div>`; continue; }
      const sum = a.reduce((s, x) => s + x.stock, 0);
      const qHuo = a.filter(x => x.status === '缺货').length;
      const st = qHuo > 0 ? `<span class="st-0">缺${qHuo}</span>` : '';
      grid += `<div class="dc"><span class="dc-t">${c}</span><b>${fmt(sum)}</b>${st}<span class="dc-s">SKU ${a.length}</span></div>`;
    }
    html += `<div class="distcard">
      <div class="dc-head"><b>${name}</b><span class="dc-meta">总库存 ${fmt(totalStock)} · 缺货 ${totalHuo} · 本周销 ${fmt(totalSale)}</span></div>
      <div class="dc-grid">${grid}</div>
      <div class="trend-place" data-dist="${name}">📈 库存趋势：待积累历史数据（≥2期显示）</div>
    </div>`;
  }
  return html;
}

// ④ DETAILS
function buildDetails(data) {
  const out = [];
  for (const name of DIST_NAMES) {
    const per = {};
    for (const cat of CATS) {
      const arr = [...data.values()].filter(d => d.dist === name && d.cat === cat && d.status !== '正常')
        .sort((a, b) => rank(a.status) - rank(b.status) || ((a.weeks ?? 999) - (b.weeks ?? 999)));
      per[cat] = arr.map(x => ({ sku: x.sku, stock: x.stock, sale: x.sale, weeks: x.weeks, status: x.status }));
    }
    out.push({ name, per });
  }
  return out;
}

function findDetailsBounds(html) {
  const marker = 'const DETAILS = [';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('找不到 const DETAILS');
  const fnIdx = html.indexOf('\nfunction openDetail', start);
  const beforeFn = html.slice(start, fnIdx);
  const relEnd = beforeFn.lastIndexOf('];');
  if (relEnd < 0) throw new Error('找不到 DETAILS 结束标记');
  return { start, end: start + relEnd + 1, marker };
}
function replaceZone(html, zone, newContent, zoneId) {
  // zone: {startIdx, endIdx} 内容区(不含边界标签本身) 或 {startMark,endMark}
  if (zone.startIdx !== undefined) {
    return html.slice(0, zone.startIdx) + newContent + html.slice(zone.endIdx);
  }
  const s = html.indexOf(zone.startMark);
  const e = html.indexOf(zone.endMark, s + zone.startMark.length);
  if (s < 0 || e < 0) throw new Error('找不到区域 ' + zoneId + ' [' + zone.startMark + '..' + zone.endMark + ']');
  // 内容区 = startMark 之后 到 endMark 之�前的部分；保留 endMark 完整? 需要替换 startMark..endMark 之间的内容, 保留两边标签
  return html.slice(0, s + zone.startMark.length) + newContent + html.slice(e);
}

function rebuild(html, matrixRows, warnGrid, distCards, detailsJson) {
  // ① 矩阵 tbody: <tbody> ... </tbody>
  const tbS = html.indexOf('<tbody>');
  const tbE = html.indexOf('</tbody>', tbS);
  if (tbS < 0 || tbE < 0) throw new Error('找不到矩阵 tbody');
  let h = html.slice(0, tbS + '<tbody>'.length) + matrixRows + html.slice(tbE);

  // ② 按品类预警: <div class="cat-grid"> ... </div>(紧接 5 cata + 闭合)
  // cat-grid 从 <div class="cat-grid"> 到其闭合。用 下一个 '\n  </div>' 定位? 采用: cat-grid 内容 = 全部5个cata
  const cgS = h.indexOf('<div class="cat-grid">');
  // cat-grid 结束 = 其后的 '</div>\n  </div>' 之前。先找下一个 '<div class="box"' 作参考
  const nextBox = h.indexOf('<div class="box">', cgS + 10);
  // cat-grid 闭合 div: 在 nextBox 之前找最后一个 '</div>' 之前的 '</div>'(cat-grid自身)
  const cgSeg = h.slice(cgS, nextBox);
  // cat-grid 结束位置 = '</div>' (cgSeg 最后一个, 即 cgSeg 中最后 '</div>' 的后一个 '>' 前)
  const lastClose = cgSeg.lastIndexOf('</div>');
  const cgEnd = cgS + lastClose + '</div>'.length;
  h = h.slice(0, cgS + '<div class="cat-grid">'.length) + warnGrid + h.slice(cgEnd);

  // ③ 各分销商明细: <div class="distcard"> ... 最后一个 </div>(其后是 box 结束或 script)
  // distcard 容器: <div class="dist-card-wrap"> 或直接? 之前看到 每card 后是 '</div>' 结束 box
  // distcards 起始 = 第一个 <div class="distcard">, 结束 = 最后一个 </div> (在 DETAILS 前)
  const dcEmpty = '<div class="cata-list"></div>'; // noop
  void dcEmpty;
  const DETAILS_MARK = 'const DETAILS = [';
  const dsStart = h.indexOf(DETAILS_MARK);
  const segment = h.slice(cgEnd, dsStart); // 含 各分销商明细 box
  // 在该 segment 中, distcards 从第一个 <div class="distcard"> 开始, 到最后一个 '</div>\n    </div>' (box 闭合) 
  const dFirst = segment.indexOf('<div class="distcard">');
  // box 闭合: box 内最后一个 '</div>' 是 distcard 容器结束; 找 '</div>\n  </div>\n\n  <div class="box"' 模式太脆弱
  // 简化: distcards 结束于 DETAILS 前的 '</div>' 序列; 我们用 最后一个 '</div>' (在 DETAILS 前)
  const segBefore = h.slice(0, dsStart);
  const lastDiv = segBefore.lastIndexOf('</div>');
  const dcEnd = lastDiv + '</div>'.length;
  const dcContentStart = segBefore.indexOf('<div class="distcard">');
  if (dcContentStart < 0) throw new Error('找不到 distcard');
  h = h.slice(0, dcContentStart) + distCards + h.slice(dcEnd);

  // ④ DETAILS
  const db = findDetailsBounds(h);
  h = h.slice(0, db.start + db.marker.length) + detailsJson + h.slice(db.end);
  return h;
}

async function ghGet(path) {
  const r = await req('api.github.com', `/repos/${REPO}/contents/${path}`, 'GET', { Authorization: 'token ' + GH_TOKEN, 'User-Agent': 'clawd', 'Accept': 'application/vnd.github+json' });
  if (!r.json.content) throw new Error('gh get fail ' + path);
  return { sha: r.json.sha, content: Buffer.from(r.json.content, 'base64').toString('utf8') };
}
async function ghPut(path, content, sha, msg) {
  const r = await req('api.github.com', `/repos/${REPO}/contents/${path}`, 'PUT', { Authorization: 'token ' + GH_TOKEN, 'User-Agent': 'clawd', 'Accept': 'application/vnd.github+json' }, { message: msg, content: Buffer.from(content).toString('base64'), sha });
  return r.status === 200 || r.status === 201 ? r.json.commit : (() => { throw new Error('gh put fail: ' + JSON.stringify(r.json).slice(0, 250)); })();
}

async function main() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !GH_TOKEN) throw new Error('缺少 env');
  console.log('拉取飞书长表...');
  const tok = await fsToken();
  const records = await fetchFeishu(tok);
  console.log('飞书记录数:', records.length);
  const gh = await ghGet('index.html');
  const html = gh.content;

  const data = buildData(records);
  console.log('聚合型号数:', data.size);

  const matrixRows = buildMatrix(data);
  const warnGrid = buildWarnGrid(data);
  const distCards = buildDistCards(data);
  const details = buildDetails(data);
  const detailsJson = JSON.stringify(details).replace(/</g, '\\u003c');
  const need = details.reduce((s, d) => s + CATS.reduce((x, c) => x + d.per[c].length, 0), 0);
  console.log('需关注型号总数:', need);

  const newHtml = rebuild(html, matrixRows, warnGrid, distCards, detailsJson);
  console.log('新 index.html 长度:', newHtml.length, '(原', html.length, ')');
  if (process.env.WRITE_LOCAL) writeFileSync(process.env.WRITE_LOCAL, newHtml);
  if (process.env.DRY_RUN) { console.log('DRY_RUN: 不推送'); return; }

  const commit = await ghPut('index.html', newHtml, gh.sha, `同步分销商库存看板 ${new Date().toISOString().slice(0,16)}`);
  console.log('推送成功:', commit.sha.slice(0, 8));
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
