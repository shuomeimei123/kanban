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
  // 分销商名归一化：门户老账号曾叫「塔城科技」，统一归并到「塔成科技」
  const ALIAS = { '塔城科技': '塔成科技' };
  for (const r of records) {
    const f = r.fields || {};
    const rawDist = t(f['分销商']), sku = t(f['产品型号']), cat = t(f['品类']);
    if (!rawDist || !sku || !CATS.includes(cat)) continue;
    const dist = ALIAS[rawDist] || rawDist;
    const key = dist + '|' + sku + '|' + cat;
    // 优先取「塔成科技」（新名）：若 key 已被塔成记录占用，则忽略归并进来的「塔城科技」来源记录
    if (map.has(key) && rawDist === '塔城科技') continue;
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
    rows += `<tr><td class="rowhead clickable" data-dist="${name}">${name} <i class="wkh">📋</i></td>${cells}<td class="tot"><b>${fmt(totalStock)}</b></td>${qtyCell}</tr>`;
  }
  return rows;
}

// ② 按品类预警 cat-grid
function buildWarnGrid(data) {
  let html = '';
  for (const c of CATS) {
    const arr = [...data.values()].filter(d => d.cat === c && d.status !== '正常' && DIST_NAMES.includes(d.dist))
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
function buildDistCards() {
  // v6: 不再平铺 21 个分销商卡片(太长), 改为一行提示: 点击上方矩阵的分销商名称查看该家完整明细
  return '<p class="dist-hint" style="padding:16px;color:#6b7280;font-size:14px">👆 点击上方「库存矩阵」表格中的<b>分销商名称</b>（如 塔成科技），即可查看该分销商的完整库存明细（全部型号）。</p>';
}

// ALLDATA: 每个分销商的全量型号数据(含正常型号), 供点击矩阵行头弹窗展示
function buildAllData(data) {
  const out = [];
  for (const name of DIST_NAMES) {
    const cats = {};
    for (const cat of CATS) {
      const arr = [...data.values()].filter(d => d.dist === name && d.cat === cat)
        .sort((a, b) => rank(a.status) - rank(b.status) || ((a.weeks ?? 999) - (b.weeks ?? 999)));
      cats[cat] = arr.map(x => ({ sku: x.sku, stock: x.stock, sale: x.sale, weeks: x.weeks, status: x.status }));
    }
    out.push({ name, cats });
  }
  return out;
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
  const marker = 'const DETAILS = '; // 不含 [ (detailsJson 带完整外层 [])
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('找不到 const DETAILS');
  const fnIdx = html.indexOf('\nfunction openDetail', start);
  const beforeFn = html.slice(start, fnIdx);
  const relEnd = beforeFn.lastIndexOf('];'); // ] 的位置
  if (relEnd < 0) throw new Error('找不到 DETAILS 结束标记');
  // end 指向 ']' 之后(即 ';' 处), 这样 h.slice(end) 保留 ';'
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

function rebuild(html, matrixRows, warnGrid, distHint, detailsJson, allDataJson, openDistJs) {
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
  const DETAILS_MARK = 'const DETAILS = [';
  const dsStart = h.indexOf(DETAILS_MARK);
  const segBefore = h.slice(0, dsStart);
  // ③ 各分销商明细: 整个 box 替换为提示(不再平铺21卡片). box 边界: 从 '各分销商明细' 所在 <div class="box"> 到「下钻弹窗」注释前
  const modalComment = segBefore.lastIndexOf('下钻弹窗'); // 注意 CSS注释也有「下钻弹窗」, 取最后一次(HTML注释, modal前)
  if (modalComment < 0) throw new Error('找不到「下钻弹窗」注释锚点');
  const lastDiv = segBefore.lastIndexOf('</div>', modalComment); // 各分销商明细 box 的闭合
  const dcEnd = lastDiv + '</div>'.length;
  // box 起始: '各分销商明细' 所在 box 的 <div class="box"> (向前找最近的 <div class="box">)
  const brand = segBefore.lastIndexOf('各分销商明细');
  const boxStart = segBefore.lastIndexOf('<div class="box">', brand);
  if (boxStart < 0) throw new Error('找不到各分销商明细 box');
  // 替换 boxStart..dcEnd 为: 新的精简提示 box (保留外层 <div class="box"> 结构)
  const newBox = `<div class="box">
    <h2>🏢 各分销商明细 <span class="tag">点击上方矩阵分销商名称查看该家全部型号</span></h2>
    ${distHint}
  </div>`;
  h = h.slice(0, boxStart) + newBox + h.slice(dcEnd);

  // ④ 插入 ALLDATA(全量型号) + ⑤ 追加 openDist JS: 放在 DETAILS 之前
  const ALLDATA_MARK = 'const DETAILS = ';
  const adStart = h.indexOf(ALLDATA_MARK);
  if (adStart < 0) throw new Error('找不到 DETAILS');
  h = h.slice(0, adStart) + 'const ALLDATA = ' + allDataJson + ';\n' + h.slice(adStart);

  // ⑥ DETAILS
  const db = findDetailsBounds(h);
  h = h.slice(0, db.start + db.marker.length) + detailsJson + h.slice(db.end);

  // ⑦ 在 </script> 前追加 openDist 函数 + 行头绑定
  const scriptEnd = h.lastIndexOf('</script>');
  if (scriptEnd < 0) throw new Error('找不到 </script>');
  h = h.slice(0, scriptEnd) + openDistJs + h.slice(scriptEnd);

  // ⑧ 追加 CSS: 行头可点击 + 分销商明细弹窗样式
  const styleEnd = h.lastIndexOf('</style>');
  if (styleEnd < 0) throw new Error('找不到 </style>');
  const extraCss = `
<style>
.rowhead.clickable{cursor:pointer;position:relative}
.rowhead.clickable:hover{background:#eff6ff}
.wkh{font-style:normal;font-size:10px;margin-left:3px;color:#2563eb}
.dist-cat-h{font-weight:700;margin:12px 0 4px;padding-bottom:4px;border-bottom:1px solid #e5e7eb;color:#1f2937;font-size:14px}
.m-empty.dim{color:#9ca3af}
</style>`;
  h = h.slice(0, styleEnd) + extraCss + h.slice(styleEnd);
  return h;
}

// 页面 JS: 点击矩阵行头分销商名 -> 弹出该分销商完整明细(全部型号, 按品类分组)
function buildOpenDistJs() {
  return `
function openDist(name){
  const rec = typeof ALLDATA !== 'undefined' ? ALLDATA.find(d => d.name === name) : null;
  if(!rec){ document.getElementById('modalTitle').textContent = name + '（无数据）'; document.getElementById('modalBody').innerHTML = '<div class="m-empty">暂无该分销商数据</div>'; document.getElementById('modalMask').classList.add('open'); return; }
  let html = '';
  const order = ['U盘','移动硬盘','TF','SD','硬盘盒'];
  for(const cat of order){
    const arr = rec.cats[cat] || [];
    html += '<div class="dist-cat-h">▸ ' + cat + ' <span class="dc-s">共 ' + arr.length + ' 款</span></div>';
    if(arr.length === 0){ html += '<div class="m-empty dim">未经营</div>'; continue; }
    html += '<div class="m-row head"><span>产品型号</span><span class="m-num">库存</span><span class="m-num">本周销</span><span class="m-num">可卖</span><span>状态</span></div>';
    html += arr.map(x => '<div class="m-row"><span class="sku">'+x.sku+'</span><span class="m-num"><b>'+x.stock+'</b></span><span class="m-num">'+(x.sale||'—')+'</span><span class="m-num">'+(x.weeks===null?'—':x.weeks+'周')+'</span><span class="m-st '+x.status+'">'+x.status+'</span></div>').join('');
  }
  document.getElementById('modalTitle').textContent = name + ' · 全部型号明细';
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalMask').classList.add('open');
}
document.querySelectorAll('.rowhead.clickable').forEach(el => {
  el.addEventListener('click', () => openDist(el.getAttribute('data-dist')));
});
`;
}

async function ghGet(path, ref) {
  const qs = ref ? '?ref=' + encodeURIComponent(ref) : '';
  const r = await req('api.github.com', `/repos/${REPO}/contents/${path}${qs}`, 'GET', { Authorization: 'token ' + GH_TOKEN, 'User-Agent': 'clawd', 'Accept': 'application/vnd.github+json' });
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
  // 基准内容: 若设 BASE_SHA 用该 commit 的 index.html(通常=原始完整版,含 modal); 提交 sha 必须用当前 HEAD
  const ghHead = await ghGet('index.html');
  let html;
  if (process.env.BASE_SHA) {
    const ghBase = await ghGet('index.html', process.env.BASE_SHA);
    html = ghBase.content;
    console.log('基准 index.html 取 base', process.env.BASE_SHA.slice(0,8), '长度', html.length, '; HEAD sha', ghHead.sha.slice(0,8));
  } else {
    html = ghHead.content;
  }

  const data = buildData(records);
  console.log('聚合型号数:', data.size);

  const matrixRows = buildMatrix(data);
  const warnGrid = buildWarnGrid(data);
  const distHint = buildDistCards(); // 不再平铺, 返回提示文案
  const allData = buildAllData(data);
  const allDataJson = JSON.stringify(allData).replace(/</g, '\\u003c');
  const openDistJs = buildOpenDistJs();
  const details = buildDetails(data);
  const detailsJson = JSON.stringify(details).replace(/</g, '\\u003c'); // 完整数组 [{...}] (marker 不含 [ )
  const need = details.reduce((s, d) => s + CATS.reduce((x, c) => x + d.per[c].length, 0), 0);
  console.log('需关注型号总数:', need);

  const newHtml = rebuild(html, matrixRows, warnGrid, distHint, detailsJson, allDataJson, openDistJs);
  console.log('新 index.html 长度:', newHtml.length, '(原', html.length, ')');
  if (process.env.WRITE_LOCAL) writeFileSync(process.env.WRITE_LOCAL, newHtml);
  if (process.env.DRY_RUN) { console.log('DRY_RUN: 不推送'); return; }

  const commit = await ghPut('index.html', newHtml, ghHead.sha, `同步分销商库存看板 ${new Date().toISOString().slice(0,16)}`);
  console.log('推送成功:', commit.sha.slice(0, 8));
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
