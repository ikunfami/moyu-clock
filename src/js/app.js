const STORAGE_KEY = 'moyu-clock-v1';

// state = { days: { 'YYYY-MM-DD': { focus, slack, sessions: [{mode,start,end}] } }, running: {mode,start}|null }
let state = { days: {}, running: null };
let lastNotify = { focus: 0, slack: 0 };
let mockMode = false;
let mockBackup = null;

/* ---------- 基础工具 ---------- */
function dayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function ensureDay(key) {
  if (!state.days[key]) state.days[key] = { focus: 0, slack: 0, sessions: [] };
  return state.days[key];
}
function today() { return ensureDay(dayKey()); }
function fmtHMS(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
function fmtShort(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}
function fmtHM(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}
function copyText(text, okMsg) {
  navigator.clipboard.writeText(text)
    .then(() => toast(okMsg))
    .catch(() => toast('复制失败，请手动复制：' + text));
}

/* ---------- 持久化 ---------- */
function save() {
  if (mockMode) return; // 示例数据预览不写盘
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('保存失败', e); }
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && data.days) state = { days: data.days, running: data.running || null };
    }
  } catch (e) { state = { days: {}, running: null }; }
  // 如果上次是运行中状态被关闭，把已流逝的时间结算掉
  if (state.running) settleRunning();
  // 合并历史遗留的碎片 session（旧版本每秒一条）
  for (const key of Object.keys(state.days)) sanitizeDay(state.days[key]);
}
function sanitizeDay(day) {
  const out = [];
  for (const s of day.sessions || []) {
    const prev = out[out.length - 1];
    if (prev && prev.mode === s.mode && s.start - prev.end <= 1500) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      out.push({ mode: s.mode, start: s.start, end: s.end });
    }
  }
  day.sessions = out;
}

// 把时间戳方案下流逝的时间结算进对应日期（天然支持跨天）
function settleRunning() {
  const now = Date.now();
  const run = state.running;
  if (!run || now - run.start < 1000) return;
  // 跨天：在午夜处断开 session，新的一天开一条新 session
  if (dayKey(new Date(run.start)) !== dayKey(new Date(now))) {
    const eod = new Date(run.start);
    eod.setHours(23, 59, 59, 999);
    accumulate(eod.getTime());
    run.start = eod.getTime() + 1;
    const t = run.start;
    ensureDay(dayKey()).sessions.push({ mode: run.mode, start: t, end: t });
  }
  accumulate(now);
  run.start = now;
}

// 把 run.start 到 until 之间的整秒数记入对应日期，并更新当天未关闭的 session
function accumulate(until) {
  const run = state.running;
  const sec = Math.floor((until - run.start) / 1000);
  if (sec <= 0) return;
  const day = ensureDay(dayKey(new Date(until)));
  day[run.mode] += sec;
  const sess = day.sessions[day.sessions.length - 1];
  if (sess && sess.mode === run.mode) sess.end = until;
}

/* ---------- 核心操作 ---------- */
function start(mode) {
  if (mockMode) exitMock();
  state.lastMode = mode;
  const t = Date.now();
  state.running = { mode, start: t };
  today().sessions.push({ mode, start: t, end: t });
  save(); updateUI();
}
function pause() {
  if (!state.running) return;
  settleRunning();
  state.running = null;
  save(); updateUI();
}
function resume() {
  if (state.running || !state.lastMode) return;
  start(state.lastMode);
}
function switchMode() {
  if (!state.running) return;
  state.lastMode = state.running.mode === 'focus' ? 'slack' : 'focus';
  start(state.lastMode);
}

/* ---------- 每秒心跳 ---------- */
setInterval(() => {
  if (state.running) { settleRunning(); save(); }
  updateUI();
  checkNotify();
}, 1000);

/* ---------- 通知 ---------- */
function checkNotify() {
  if (mockMode) return;
  if (!('Notification' in window) || Notification.permission !== 'granted' || !state.running) return;
  const day = today();
  const f2h = Math.floor(day.focus / 7200);
  if (state.running.mode === 'focus' && f2h > lastNotify.focus && day.focus > 0) {
    new Notification('MOYU·时钟', { body: `已专注 ${fmtShort(day.focus)}，起来走走吧` });
  }
  lastNotify.focus = f2h;
  const s30 = Math.floor(day.slack / 1800);
  if (state.running.mode === 'slack' && s30 > lastNotify.slack && day.slack > 0) {
    new Notification('MOYU·时钟', { body: `已 moyu ${fmtShort(day.slack)}，该回来干活了` });
  }
  lastNotify.slack = s30;
}
document.getElementById('notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast('这个浏览器不支持通知'); return; }
  const p = await Notification.requestPermission();
  updateNotifyBtn();
  toast(p === 'granted' ? '提醒已开启' : '通知权限被拒绝');
});
function updateNotifyBtn() {
  const btn = document.getElementById('notifyBtn');
  if (!('Notification' in window)) { btn.textContent = '通知不可用'; return; }
  btn.textContent = Notification.permission === 'granted' ? '提醒已开启' : '开启提醒';
}

/* ---------- UI 渲染 ---------- */
function updateUI() {
  const day = today();
  const running = state.running;
  const isFocus = running ? running.mode === 'focus' : (state.lastMode !== 'slack');

  const timer = document.getElementById('timer');
  const mainBtn = document.getElementById('mainBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const label = document.getElementById('modeLabel');

  if (running) {
    timer.textContent = fmtHMS(running.mode === 'focus' ? day.focus : day.slack);
    timer.className = 'timer ' + running.mode;
    label.textContent = running.mode === 'focus' ? '专注中… 按空格去moyu' : 'moyu中… 按空格回来干活';
    mainBtn.textContent = running.mode === 'focus' ? 'moyu一下' : '回来干活';
    mainBtn.className = 'btn ' + (running.mode === 'focus' ? 'slack' : 'focus');
    pauseBtn.style.display = '';
    pauseBtn.textContent = '暂停';
  } else {
    const shown = (state.lastMode === 'slack') ? day.slack : day.focus;
    timer.textContent = fmtHMS(shown);
    timer.className = 'timer idle';
    label.textContent = day.focus + day.slack > 0 ? '已暂停，按 Esc 或点按钮继续' : '还没开始，点下面按钮';
    mainBtn.textContent = (state.lastMode === 'slack') ? '开始moyu' : '开始专注';
    mainBtn.className = 'btn ' + (isFocus ? 'focus' : 'slack');
    pauseBtn.style.display = 'none';
  }

  document.body.className = running ? 'mode-' + running.mode : '';

  const total = day.focus + day.slack;
  document.getElementById('todayFocus').textContent = fmtShort(day.focus);
  document.getElementById('todaySlack').textContent = fmtShort(day.slack);
  document.getElementById('slackRate').textContent = total > 0 ? Math.round(day.slack / total * 100) + '%' : '--';

  renderHistory();
  renderTimeline();
  updateChart();
  updateMockBanner();
  renderWorktimeHint();
}

function renderHistory() {
  if (!chartHist) return;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const it = state.days[key] || { focus: 0, slack: 0 };
    days.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), focus: it.focus, slack: it.slack });
  }
  chartHist.setOption({
    grid: { left: 48, right: 12, top: 32, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2c2c4a',
      borderWidth: 0,
      textStyle: { color: '#eee', fontSize: 12 },
      formatter: ps => {
        const f = ps[0].value, s = ps[1].value;
        const total = f + s;
        const rate = total > 0 ? Math.round(s / total * 100) : 0;
        return `${ps[0].name}<br>专注 ${fmtShort(f)}<br>moyu ${fmtShort(s)}<br>moyu率 ${rate}%`;
      }
    },
    legend: { data: ['专注', 'moyu'], textStyle: { color: '#999' }, top: 2, icon: 'roundRect' },
    xAxis: {
      type: 'category',
      data: days.map(d => d.label),
      axisLabel: { color: '#777' },
      axisLine: { lineStyle: { color: '#333355' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#777', formatter: v => fmtShort(v) },
      splitLine: { lineStyle: { color: '#22223e' } }
    },
    series: [
      {
        name: '专注', type: 'bar', stack: 'total', barWidth: 22,
        data: days.map(d => d.focus),
        itemStyle: { color: '#00b894', borderRadius: [3, 3, 0, 0] }
      },
      {
        name: 'moyu', type: 'bar', stack: 'total',
        data: days.map(d => d.slack),
        itemStyle: { color: '#e17055', borderRadius: [3, 3, 0, 0] }
      }
    ]
  });
}

function renderTimeline() {
  const box = document.getElementById('timeline');
  const sessions = today().sessions.slice().reverse().slice(0, 18);
  if (!sessions.length) {
    box.innerHTML = '<div class="tl-empty">今天还没有记录</div>';
    return;
  }
  box.innerHTML = sessions.map(s => {
    const dur = Math.max(1, Math.round((s.end - s.start) / 1000));
    const name = s.mode === 'focus' ? '专注' : 'moyu';
    return `<div class="tl-item">
      <span class="tl-time">${fmtHM(s.start)} – ${fmtHM(s.end)}</span>
      <span class="tl-mode ${s.mode}">${name}</span>
      <span class="tl-dur">${fmtShort(dur)}</span>
    </div>`;
  }).join('');
}

/* ---------- 工作时间设置 ---------- */
const WT_KEY = 'moyu-worktime-v1';
const WT_DEFAULT = {
  morning:   { enabled: true,  range: ['08:00', '12:00'] },
  afternoon: { enabled: true,  range: ['13:00', '18:00'] },
  night:     { enabled: false, range: ['19:00', '22:00'] },
};
let worktime = loadWorktime();

function loadWorktime() {
  try {
    const raw = localStorage.getItem(WT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
// 返回启用时段的 [startMin, endMin] 列表（按开始时间排序），无有效时段返回 null
function workRanges() {
  const wt = worktime || WT_DEFAULT;
  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const arr = Object.values(wt)
    .filter(p => p.enabled && Array.isArray(p.range) && p.range[0] && p.range[1])
    .map(p => [toMin(p.range[0]), toMin(p.range[1])])
    .sort((a, b) => a[0] - b[0]);
  return arr.length ? arr : null;
}
// Element Plus 弹窗
function initWorktimeUI() {
  if (!window.Vue || !window.ElementPlus) return;
  const { createApp, reactive, ref } = Vue;
  const names = { morning: '上午', afternoon: '下午', night: '夜晚' };
  const app = createApp({
    setup() {
      const visible = ref(false);
      const form = reactive(JSON.parse(JSON.stringify(worktime || WT_DEFAULT)));
      function open() {
        Object.assign(form, JSON.parse(JSON.stringify(worktime || WT_DEFAULT)));
        visible.value = true;
      }
      function save() {
        for (const k of Object.keys(form)) {
          if (form[k].enabled && (!Array.isArray(form[k].range) || !form[k].range[0] || !form[k].range[1])) {
            ElementPlus.ElMessage.warning(`请补全「${names[k]}」的时间范围，或关闭该时段`);
            return;
          }
        }
        worktime = JSON.parse(JSON.stringify(form));
        try { localStorage.setItem(WT_KEY, JSON.stringify(worktime)); }
        catch (e) { console.warn('保存失败', e); }
        visible.value = false;
        updateChart();
        ElementPlus.ElMessage.success('已保存');
      }
      window.__openWorktime = open;
      return { visible, form, names, save };
    },
  });
  app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
  app.mount('#worktime-app');
  document.getElementById('worktimeBtn').addEventListener('click', () => window.__openWorktime && window.__openWorktime());
  document.getElementById('worktimeHint').addEventListener('click', () => window.__openWorktime && window.__openWorktime());
}

/* ---------- ECharts 今日曲线 ---------- */
let chart = null;
let chartHist = null;
function initChart() {
  if (!window.echarts) {
    document.getElementById('chart').innerHTML = '<div class="tl-empty">图表加载失败：需要联网加载 ECharts</div>';
    return;
  }
  chart = echarts.init(document.getElementById('chart'));
  chartHist = echarts.init(document.getElementById('historyList'));
  window.addEventListener('resize', () => {
    if (chart) chart.resize();
    if (chartHist) chartHist.resize();
  });
}
function cumulativeSeries(mode) {
  const segs = today().sessions
    .filter(s => s.mode === mode)
    .sort((a, b) => a.start - b.start);
  const data = [];
  let cum = 0;
  for (const s of segs) {
    if (!data.length) data.push([s.start, 0]);
    cum += Math.max(1, Math.round((s.end - s.start) / 1000));
    data.push([s.end, cum]);
  }
  return data;
}
function updateChart() {
  if (!chart) return;
  const ranges = workRanges();
  const baseStart = ranges ? ranges[0][0] : 8 * 60;
  const baseEnd = ranges ? ranges[ranges.length - 1][1] : 18 * 60;
  const atMin = min => { const d = new Date(); d.setHours(0, min, 0, 0); return d.getTime(); };
  const dayStart = atMin(baseStart);
  let maxT = atMin(baseEnd);
  // 数据超出最后时段末尾时，x 轴自动向右延长
  for (const s of today().sessions) if (s.end > maxT) maxT = s.end;
  if (state.running) maxT = Math.max(maxT, Date.now());
  // 时段之间的休息间隙（如图 12:00–13:00 午休）
  const gaps = [];
  if (ranges) {
    let cursor = ranges[0][1];
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] > cursor) gaps.push([cursor, ranges[i][0]]);
      cursor = Math.max(cursor, ranges[i][1]);
    }
  }
  chart.setOption({
    grid: { left: 52, right: 20, top: 40, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2c2c4a',
      borderWidth: 0,
      textStyle: { color: '#eee', fontSize: 12 },
      formatter: ps => {
        const t = new Date(ps[0].value[0]);
        const hm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
        return hm + '<br>' + ps.map(p => `${p.marker}${p.seriesName} ${fmtShort(p.value[1])}`).join('<br>');
      }
    },
    legend: { data: ['专注', 'moyu'], textStyle: { color: '#999' }, top: 4, icon: 'roundRect' },
    xAxis: {
      type: 'time', min: dayStart, max: maxT,
      axisLabel: { color: '#777', formatter: '{HH}:{mm}' },
      axisLine: { lineStyle: { color: '#333355' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#777', formatter: v => fmtShort(v) },
      splitLine: { lineStyle: { color: '#22223e' } }
    },
    series: [
      {
        name: '专注', type: 'line', smooth: true, showSymbol: false,
        data: cumulativeSeries('focus'),
        lineStyle: { color: '#2ee6a8', width: 2.5 },
        itemStyle: { color: '#2ee6a8' },
        areaStyle: { color: 'rgba(46,230,168,0.10)' },
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(255,255,255,0.04)' },
          data: gaps.map(([gs, ge]) => [{ xAxis: atMin(gs) }, { xAxis: atMin(ge) }])
        }
      },
      {
        name: 'moyu', type: 'line', smooth: true, showSymbol: false,
        data: cumulativeSeries('slack'),
        lineStyle: { color: '#ff7a59', width: 2.5 },
        itemStyle: { color: '#ff7a59' },
        areaStyle: { color: 'rgba(255,122,89,0.10)' }
      }
    ]
  });
}

/* ---------- 工具按钮 ---------- */
document.getElementById('reportBtn').addEventListener('click', () => {
  const day = today();
  const total = day.focus + day.slack;
  const rate = total > 0 ? Math.round(day.slack / total * 100) : 0;
  copyText(`今日moyu战绩：专注 ${fmtShort(day.focus)}，moyu ${fmtShort(day.slack)}，moyu率 ${rate}%。`, '战绩已复制，快去群里炫耀吧');
});

document.getElementById('weekBtn').addEventListener('click', () => {
  let f = 0, s = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const it = state.days[dayKey(d)];
    if (it) { f += it.focus; s += it.slack; }
  }
  const total = f + s;
  const rate = total > 0 ? Math.round(s / total * 100) : 0;
  copyText(`本周moyu战报：专注 ${fmtShort(f)}，moyu ${fmtShort(s)}，moyu率 ${rate}%。`, '战报已复制');
});

document.getElementById('exportBtn').addEventListener('click', () => {
  if (mockMode) exitMock();
  const blob = new Blob([JSON.stringify(state.days, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'moyu-data-' + dayKey() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (!confirm('确定清空今天的全部记录吗？')) return;
  if (mockMode) exitMock();
  pause();
  state.days[dayKey()] = { focus: 0, slack: 0, sessions: [] };
  save(); updateUI();
  toast('今日已重置');
});

// 清空全部历史数据
document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (!confirm('确定清空全部历史数据吗？\n此操作不可恢复，建议先「导出数据」备份。')) return;
  pause();
  mockMode = false;
  mockBackup = null;
  state.days = {};
  save(); updateUI();
  toast('已清空全部数据');
});

// 进入示例数据预览：只改内存，不写盘，刷新或任何真实操作即恢复
document.getElementById('mockBtn').addEventListener('click', () => {
  if (!mockMode && !confirm('进入示例数据预览？\n预览只显示在页面上，不影响真实数据，刷新页面即恢复。')) return;
  pause();
  if (!mockMode) {
    mockBackup = JSON.parse(JSON.stringify(state.days));
    mockMode = true;
  }
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    state.days[dayKey(d)] = genMockDay(d);
  }
  updateUI();
  toast('已进入示例数据预览');
});

document.getElementById('exitMockBtn').addEventListener('click', () => {
  exitMock();
  toast('已恢复真实数据');
});

function exitMock() {
  if (!mockMode) return;
  state.days = mockBackup || {};
  mockBackup = null;
  mockMode = false;
  save(); updateUI();
}

function updateMockBanner() {
  document.getElementById('mockBanner').style.display = mockMode ? '' : 'none';
}

// 底部提示行显示工作时间，点击可打开设置
function renderWorktimeHint() {
  const el = document.getElementById('worktimeHint');
  const sep = document.getElementById('worktimeHintSep');
  const wt = worktime || WT_DEFAULT;
  const names = { morning: '上午', afternoon: '下午', night: '夜晚' };
  const parts = Object.keys(wt)
    .filter(k => wt[k].enabled && Array.isArray(wt[k].range) && wt[k].range[0] && wt[k].range[1])
    .map(k => `${names[k]} ${wt[k].range[0]}–${wt[k].range[1]}`);
  el.textContent = parts.length ? '⏰ 工作时间 ' + parts.join(' · ') : '';
  sep.style.display = parts.length ? '' : 'none';
}

// 生成某一天的 8:00–18:00 模拟记录
function genMockDay(date) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const at = (h, m) => { const d = new Date(date); d.setHours(h, m, 0, 0); return d.getTime(); };
  const sessions = [];
  let focus = 0, slack = 0;
  const lunchS = at(12, 0), lunchE = at(13, 0);
  const limit = at(18, 0);
  let t = at(8, 0);
  let isFocus = true;
  while (t < limit) {
    let end = Math.min(t + (isFocus ? rnd(30, 70) : rnd(5, 25)) * 60000, limit);
    if (t < lunchE && end > lunchS) { t = lunchE; isFocus = true; continue; } // 午休不计
    const mode = isFocus ? 'focus' : 'slack';
    sessions.push({ mode, start: Math.round(t), end: Math.round(end) });
    if (isFocus) focus += Math.round((end - t) / 1000);
    else slack += Math.round((end - t) / 1000);
    t = end;
    isFocus = !isFocus;
  }
  return { focus, slack, sessions };
}

/* ---------- 主按钮 / 键盘 ---------- */
document.getElementById('mainBtn').addEventListener('click', () => {
  if (state.running) switchMode();
  else start(state.lastMode === 'slack' ? 'slack' : 'focus');
});
document.getElementById('pauseBtn').addEventListener('click', pause);

document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (state.running) switchMode();
    else start(state.lastMode === 'slack' ? 'slack' : 'focus');
  }
  if (e.code === 'Escape') {
    if (state.running) pause();
    else resume();
  }
});

window.addEventListener('beforeunload', () => { if (state.running) settleRunning(); save(); });

/* ---------- 单独计时 ---------- */
const solo = { running: false, startTs: 0, elapsed: 0, timerId: null };
const soloOverlay = document.getElementById('soloOverlay');
function soloNow() { return solo.elapsed + (solo.running ? Date.now() - solo.startTs : 0); }
function soloRender() {
  document.getElementById('soloTime').textContent = fmtHMS(Math.floor(soloNow() / 1000));
}
function soloSyncBtns() {
  document.getElementById('soloStartBtn').disabled = solo.running;
  document.getElementById('soloPauseBtn').disabled = !solo.running;
}
function soloStart() {
  if (solo.running) return;
  solo.running = true;
  solo.startTs = Date.now();
  solo.timerId = setInterval(soloRender, 250);
  soloRender(); soloSyncBtns();
}
function soloPause() {
  if (!solo.running) return;
  solo.elapsed += Date.now() - solo.startTs;
  solo.running = false;
  clearInterval(solo.timerId);
  soloRender(); soloSyncBtns();
}
document.getElementById('soloBtn').addEventListener('click', () => {
  soloOverlay.classList.toggle('open');
  soloRender();
});
document.getElementById('soloStartBtn').addEventListener('click', soloStart);
document.getElementById('soloPauseBtn').addEventListener('click', soloPause);
document.getElementById('soloCloseBtn').addEventListener('click', () => {
  soloOverlay.classList.remove('open');
});
// 点击模态遮罩层关闭
soloOverlay.addEventListener('click', e => {
  if (e.target === soloOverlay) soloOverlay.classList.remove('open');
});

/* ---------- 初始化 ---------- */
document.getElementById('todayDate').textContent =
  new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
load();
updateNotifyBtn();
initChart();
initWorktimeUI();
updateUI();
// 本地没有工作时间设置时，自动弹出设置窗口
if (!localStorage.getItem(WT_KEY)) {
  setTimeout(() => window.__openWorktime && window.__openWorktime(), 400);
}
