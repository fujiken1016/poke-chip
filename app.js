// ポケチップ クライアント
const $ = id => document.getElementById(id);
let S = { code: null, pid: null, view: null, es: null };
let raiseOpen = false;
// 演出用の前回状態
let FX = { seq: null, board: 0, hand: 0, pot: null, bets: {}, myTurn: false, deadlineAt: null, clockTotal: 20 };

// ---------- サウンド（WebAudio合成・アセット不要） ----------
let AC = null;
let muted = localStorage.getItem('pokechip_mute') === '1';
function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
document.addEventListener('pointerdown', () => { try { ac(); } catch {} }, { once: true });
function tone(f, dur, type = 'sine', g = 0.15, delay = 0) {
  if (muted) return;
  try {
    const a = ac(), t = a.currentTime + delay;
    const o = a.createOscillator(), v = a.createGain();
    o.type = type; o.frequency.value = f;
    v.gain.setValueAtTime(g, t);
    v.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(v); v.connect(a.destination);
    o.start(t); o.stop(t + dur);
  } catch {}
}
function noiseHit(dur = 0.12, g = 0.07, delay = 0) {
  if (muted) return;
  try {
    const a = ac(), t = a.currentTime + delay;
    const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = a.createBufferSource(), v = a.createGain();
    s.buffer = buf;
    v.gain.setValueAtTime(g, t);
    s.connect(v); v.connect(a.destination);
    s.start(t);
  } catch {}
}
const SND = {
  chip() { noiseHit(.04, .05); tone(1900, .06, 'triangle', .12); tone(2500, .08, 'triangle', .09, .045); },
  bigchip() { for (let i = 0; i < 3; i++) { tone(1700 + i * 350, .06, 'triangle', .11, i * .06); noiseHit(.04, .04, i * .06); } },
  check() { tone(210, .07, 'square', .12); tone(150, .09, 'square', .1, .07); },
  fold() { noiseHit(.16, .05); },
  allin() { tone(160, .3, 'sawtooth', .13); tone(95, .42, 'sawtooth', .11, .06); this.bigchip(); },
  win() { [880, 1100, 1320, 1760].forEach((f, i) => tone(f, .16, 'triangle', .14, i * .09)); noiseHit(.3, .04, .1); },
  turn() { tone(880, .1, 'sine', .18); tone(1320, .16, 'sine', .16, .11); },
  phase() { tone(520, .07, 'sine', .07); },
};
const CUTIN_SND = { fold: 'fold', check: 'check', call: 'chip', bet: 'bigchip', raise: 'bigchip', allin: 'allin', win: 'win', phase: 'phase', hand: 'phase' };

// ---------- アクションクロック（横棒メーター・ローカル描画） ----------
setInterval(() => {
  const meters = document.querySelectorAll('.tmeter');
  if (!meters.length) return;
  const remainMs = FX.deadlineAt != null ? Math.max(0, FX.deadlineAt - Date.now()) : null;
  const pct = remainMs != null ? Math.min(100, (remainMs / (FX.clockTotal * 1000)) * 100) : 0;
  const danger = remainMs != null && remainMs <= 5000;
  meters.forEach(m => {
    const fill = m.querySelector('.tmeter-fill');
    if (fill) fill.style.width = pct + '%';
    m.classList.toggle('danger', danger);
  });
}, 150);

// ---------- カットイン演出 ----------
const CUTIN_TEXT = {
  fold: () => 'FOLD',
  check: () => 'CHECK',
  call: a => `CALL ${a.amount != null ? fmt(a.amount) : ''}`,
  bet: a => `BET ${a.amount != null ? fmt(a.amount) : ''}`,
  raise: a => `RAISE ${a.amount != null ? fmt(a.amount) : ''}`,
  allin: a => `ALL IN ${a.amount != null ? fmt(a.amount) : ''}`,
  win: a => a.text || `WIN +${a.amount != null ? fmt(a.amount) : ''}`,
  phase: a => a.text,
  hand: a => a.text,
};
let cutinTimer = null;
function showCutin(a) {
  // WIN演出：自分が勝った時だけド派手に。負けは非表示、不参加/観戦なら「○○ WIN」
  if (a.kind === 'win') {
    const me = S.view?.players.find(p => p.you);
    const winners = (a.name || '').split('・');
    animateChipsToWinners(winners); // 誰が勝ってチップが移動したか全員に見せる
    const iWon = me && winners.includes(me.name);
    if (!iWon) {
      const participated = me && me.inHand && !me.folded;
      if (participated) return; // ショーダウン負け：結果ボックスだけで十分
      a = { ...a, name: '', text: `${a.name} WIN`, amount: null, othersWin: true };
    }
  }
  const fn = CUTIN_TEXT[a.kind];
  if (!fn) return 0;
  const band = $('cutinBand');
  $('cutinName').textContent = a.name || '';
  $('cutinText').textContent = fn(a);
  band.className = 'cutin-band k-' + a.kind;
  $('cutin').classList.remove('hidden');
  void band.offsetWidth; // アニメーション再トリガー
  const sndKey = a.kind === 'win' && a.othersWin ? 'phase' : CUTIN_SND[a.kind];
  if (sndKey) SND[sndKey]();
  const dur = a.kind === 'win' ? 1600 : a.kind === 'allin' ? 1250 : 1000;
  clearTimeout(cutinTimer);
  cutinTimer = setTimeout(() => $('cutin').classList.add('hidden'), dur);
  return dur;
}

// ---------- 演出キュー（1更新で複数イベントでも順番に見せる） ----------
let cutinQueue = [], cutinBusy = false;
function enqueueCutins(evs) {
  cutinQueue.push(...evs);
  if (!cutinBusy) playNextCutin();
}
function playNextCutin() {
  const ev = cutinQueue.shift();
  if (!ev) {
    cutinBusy = false;
    render(); // 演出が終わってから結果表示を出す
    return;
  }
  cutinBusy = true;
  const dur = showCutin(ev) || 0;
  // 溜まっている時は早送り（最後の1件＝勝敗などはしっかり見せる）
  const backlog = cutinQueue.length;
  const wait = dur ? (backlog >= 3 ? Math.min(dur, 420) : backlog >= 1 ? Math.min(dur, 750) : dur) + 150 : 0;
  setTimeout(playNextCutin, wait);
}

// ---------- ポットのカウントアップ／ダウン ----------
function setPot(n) {
  const el = $('potAmt');
  const from = FX.pot;
  FX.pot = n;
  if (from == null || from === n) { el.textContent = fmt(n); return; }
  // ポットが増える（ベット集約）は素早く、勝者に流れて減る時はゆっくり見せる
  const dur = n < from ? 1300 : 400;
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = fmt(Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3))));
    if (k < 1 && FX.pot === n) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- ポットのチップが勝者へ飛ぶ演出 ----------
function animateChipsToWinners(winnerNames) {
  const wrap = $('tableWrap'), potEl = $('potLine');
  if (!wrap || !potEl || !winnerNames.length) return;
  const wr = wrap.getBoundingClientRect();
  const pr = potEl.getBoundingClientRect();
  const sx = pr.left + pr.width / 2 - wr.left;
  const sy = pr.top + pr.height / 2 - wr.top;
  const seats = [...document.querySelectorAll('.tseat')];
  winnerNames.forEach(nm => {
    const seat = seats.find(s => (s.querySelector('.pnm')?.textContent || '').includes(nm));
    if (!seat) return;
    const sr = seat.getBoundingClientRect();
    const ex = sr.left + sr.width / 2 - wr.left;
    const ey = sr.top + sr.height / 2 - wr.top;
    for (let i = 0; i < 7; i++) {
      const chip = document.createElement('div');
      chip.className = 'flychip';
      chip.style.left = sx + 'px';
      chip.style.top = sy + 'px';
      wrap.appendChild(chip);
      const delay = i * 90;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        chip.style.transition = `transform 1s cubic-bezier(.45,.05,.3,1) ${delay}ms, opacity .35s ${900 + delay}ms`;
        chip.style.transform = `translate(${ex - sx}px, ${ey - sy}px) scale(.7)`;
        chip.style.opacity = '0';
      }));
      setTimeout(() => chip.remove(), 2200 + delay);
    }
    // 勝者アバターを一瞬光らせる
    seat.classList.add('win-glow');
    setTimeout(() => seat.classList.remove('win-glow'), 1800);
  });
}

// ---------- 通信 ----------
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '通信エラー');
  return j;
}

function act(type, extra = {}) {
  showErr('tableErr', '');
  api('/api/act', { code: S.code, pid: S.pid, type, ...extra }).catch(e => showErr('tableErr', e.message));
}

function connect() {
  if (S.es) S.es.close();
  stopPoll();
  S.gotSse = false;
  S.es = new EventSource(`/events?code=${S.code}&pid=${S.pid}`);
  S.es.onmessage = e => {
    S.gotSse = true; S.errCount = 0;
    stopPoll();
    S.view = JSON.parse(e.data); render();
  };
  S.es.addEventListener('invalid', () => {
    leave(true);
    showErr('joinErr', 'このルームは終了しています（サーバー再起動等）。ホームに戻りました');
  });
  S.es.onerror = () => {
    S.errCount = (S.errCount || 0) + 1;
    if (!S.view && S.errCount >= 2) $('roomTitle').textContent = '再接続中…';
    if (S.errCount >= 2) startPoll();
  };
  // トンネル等でSSEが届かない環境 → 自動でポーリングに切替
  setTimeout(() => { if (!S.gotSse && S.code) startPoll(); }, 3500);
}

// ---------- ポーリングフォールバック ----------
function startPoll() {
  if (S.pollTimer || !S.code) return;
  const tick = async () => {
    if (!S.code) return;
    try {
      const r = await fetch(`/api/view?code=${S.code}&pid=${S.pid}`);
      if (r.status === 404) {
        leave(true);
        showErr('joinErr', 'このルームは終了しています。ホームに戻りました');
        return;
      }
      if (r.ok) { S.view = await r.json(); render(); }
    } catch {}
  };
  tick();
  S.pollTimer = setInterval(tick, 1200);
}
function stopPoll() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

function enter(code, pid) {
  S.code = code; S.pid = pid;
  sessionStorage.setItem('pokechip', JSON.stringify({ code, pid }));
  saveHist(code, { pid });
  $('home').classList.add('hidden');
  $('table').classList.remove('hidden');
  // ビュー受信前でもコードは即表示
  $('roomCode').textContent = code;
  $('roomTitle').textContent = '接続中…';
  connect();
}

// ---------- ルーム履歴（再入室用・端末ごと） ----------
function getHist() {
  try { return JSON.parse(localStorage.getItem('pokechip_hist') || '{}'); } catch { return {}; }
}
function saveHist(code, data) {
  const h = getHist();
  h[code] = { ...(h[code] || {}), ...data, ts: Date.now() };
  localStorage.setItem('pokechip_hist', JSON.stringify(h));
}

// ---------- 開催中ルーム一覧 ----------
async function loadRooms() {
  const el = $('roomList');
  try {
    const r = await fetch('/api/rooms').then(x => x.json());
    const hist = getHist();
    if (!r.rooms.length) {
      el.innerHTML = '<div class="rl-empty">開催中のルームはありません。下から作成してください</div>';
      return;
    }
    el.innerHTML = '';
    r.rooms.forEach(rm => {
      const row = document.createElement('div');
      row.className = 'rl-row';
      row.innerHTML = `<div class="rl-info"><div class="rl-title">${esc(rm.title || rm.code)}</div>` +
        `<div class="rl-sub">${rm.code} ・ ${rm.mode === 'full' ? 'フル' : 'チップ'} ・ ${rm.sb}/${rm.bb} ・ ${rm.players}人${rm.spectators ? `＋👁${rm.spectators}` : ''} ・ ${esc(rm.phase)}</div></div>`;
      const btn = document.createElement('button');
      const mine = hist[rm.code]?.pid;
      if (mine) {
        btn.className = 'primary small';
        btn.textContent = '再入室';
        btn.onclick = () => enter(rm.code, mine);
      } else {
        btn.className = 'small';
        btn.textContent = '参加';
        btn.onclick = () => { $('joinCode').value = rm.code; $('joinCode').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('name').focus(); };
      }
      row.appendChild(btn);
      el.appendChild(row);
    });
  } catch {
    el.innerHTML = '<div class="rl-empty">一覧を取得できませんでした</div>';
  }
}
$('btnRoomsRefresh').onclick = e => { e.preventDefault(); loadRooms(); };
setInterval(() => { if (!$('home').classList.contains('hidden')) loadRooms(); }, 7000);

function leave(silent) {
  if (S.es) S.es.close();
  stopPoll();
  sessionStorage.removeItem('pokechip');
  S = { code: null, pid: null, view: null, es: null };
  $('table').classList.add('hidden');
  $('home').classList.remove('hidden');
  if (!silent) location.reload();
  else loadRooms();
}

function showErr(id, msg) { $(id).textContent = msg; if (msg) setTimeout(() => { if ($(id).textContent === msg) $(id).textContent = ''; }, 4000); }

// ---------- カード描画 ----------
const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
function cardEl(c, small, deal, delay) {
  const d = document.createElement('div');
  d.className = 'pcard' + (small ? ' small' : '');
  if (deal) { d.classList.add('deal'); if (delay) d.style.animationDelay = delay + 'ms'; }
  if (!c) { d.classList.add('back'); return d; }
  d.classList.add('s-' + c.s); // 4色デッキ（スートごとの地色）
  d.innerHTML = `<span class="csuit">${SUIT[c.s]}</span><span class="crank">${RANK[c.r] || c.r}</span>`;
  return d;
}

// アバター（名前から安定生成：絵文字キャラ＋色）
const AVATARS = ['🐺', '🦊', '🐱', '🐼', '🦁', '🐸', '🐯', '🐰', '🐻', '🦉', '🐨', '🐷', '🦅', '🐙', '🦈', '🐲'];
function nameHash(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
const avatarEmoji = name => AVATARS[nameHash(name) % AVATARS.length];
const avatarColor = name => `hsl(${nameHash(name) % 360}, 40%, 38%)`;

// 数値の3桁区切り表示
const fmt = n => Number(n).toLocaleString('en-US');
// 席プレート/チップ用の短縮表示（大きい額でプレート幅が崩れないように）
const fmtShort = n => {
  n = Number(n);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (Math.abs(n) >= 1e5) return (n / 1e3).toFixed(0) + 'K';
  return n.toLocaleString('en-US');
};

// ---------- 手役のリアルタイム判定（クライアント側） ----------
const RANK_NAME = r => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' }[r] || String(r));
function eval5(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a);
  const flush = cs.every(c => c.s === cs[0].s);
  let sHigh = 0;
  const uniq = [...new Set(rs)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) sHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) sHigh = 5;
  }
  const cnt = {};
  rs.forEach(r => (cnt[r] = (cnt[r] || 0) + 1));
  const groups = Object.entries(cnt).map(([r, c]) => ({ r: +r, c })).sort((a, b) => b.c - a.c || b.r - a.r);
  let cat, tb;
  if (flush && sHigh) { cat = 8; tb = [sHigh]; }
  else if (groups[0].c === 4) { cat = 7; tb = [groups[0].r, groups[1].r]; }
  else if (groups[0].c === 3 && groups[1].c === 2) { cat = 6; tb = [groups[0].r, groups[1].r]; }
  else if (flush) { cat = 5; tb = rs; }
  else if (sHigh) { cat = 4; tb = [sHigh]; }
  else if (groups[0].c === 3) { cat = 3; tb = [groups[0].r, groups[1].r, groups[2].r]; }
  else if (groups[0].c === 2 && groups[1].c === 2) { cat = 2; tb = [groups[0].r, groups[1].r, groups[2].r]; }
  else if (groups[0].c === 2) { cat = 1; tb = [groups[0].r, groups[1].r, groups[2].r, groups[3].r]; }
  else { cat = 0; tb = rs; }
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tb[i] || 0);
  return score;
}
function describeScore(score) {
  const d = [];
  let s = score;
  for (let i = 0; i < 5; i++) { d.unshift(s % 15); s = Math.floor(s / 15); }
  const cat = s, R = i => RANK_NAME(d[i]);
  switch (cat) {
    case 0: return `ハイカード（${R(0)}）`;
    case 1: return `ワンペア（${R(0)}）`;
    case 2: return `ツーペア（${R(0)}・${R(1)}）`;
    case 3: return `スリーカード（${R(0)}）`;
    case 4: return `ストレート（${R(0)}ハイ）`;
    case 5: return `フラッシュ（${R(0)}ハイ）`;
    case 6: return `フルハウス（${R(0)}・${R(1)}）`;
    case 7: return `フォーカード（${R(0)}）`;
    case 8: return d[0] === 14 ? 'ロイヤルフラッシュ' : `ストレートフラッシュ（${R(0)}ハイ）`;
  }
  return '';
}
function handText(cards) { // 2〜7枚から現在の役名
  const cs = cards.filter(c => c && c.r);
  if (cs.length < 2) return '';
  if (cs.length < 5) {
    const rs = cs.map(c => c.r).sort((a, b) => b - a);
    return cs.length === 2 && cs[0].r === cs[1].r ? `ワンペア（${RANK_NAME(rs[0])}）` : `ハイカード（${RANK_NAME(rs[0])}）`;
  }
  let best = -1;
  const n = cs.length;
  const evalC = five => { const s = eval5(five); if (s > best) best = s; };
  if (n === 5) evalC(cs);
  else if (n === 6) { for (let i = 0; i < 6; i++) evalC(cs.filter((_, k) => k !== i)); }
  else { for (let i = 0; i < 6; i++) for (let j = i + 1; j < 7; j++) evalC(cs.filter((_, k) => k !== i && k !== j)); }
  return describeScore(best);
}

// ---------- 描画 ----------
function render() {
  const v = S.view;
  if (!v) return;
  const you = v.you;
  const betting = ['preflop', 'flop', 'turn', 'river'].includes(v.phase);

  // カットイン（初回接続時は発火させない／未再生ぶんを順番に再生）
  const q = v.fxq && v.fxq.length ? v.fxq : (v.lastAction ? [v.lastAction] : []);
  if (q.length) {
    if (FX.seq === null) FX.seq = q[q.length - 1].seq; // 初回は過去分を流さない
    else {
      const pending = q.filter(e => e.seq > FX.seq);
      if (pending.length) {
        FX.seq = pending[pending.length - 1].seq;
        enqueueCutins(pending);
      }
    }
  }

  $('roomTitle').textContent = v.title || '';
  $('roomCode').textContent = v.code;
  $('modeLabel').textContent = v.mode === 'full' ? 'フル' : 'チップ';
  const myNm = v.players.find(p => p.you)?.name;
  $('myName').textContent = myNm ? `👤 ${myNm}` : (v.spectator ? `👁 ${v.spectator.name}` : '');
  $('blinds').textContent = `${v.sb}/${v.bb}`;
  $('phaseLabel').textContent = (v.handNum ? `HAND #${v.handNum} ・ ` : '') + v.phaseJa;
  setPot(v.pot);

  // アクションクロックの締切を同期（ベット中の手番 or ランイット選択）
  if (v.phase === 'rit' && v.rit) {
    FX.deadlineAt = Date.now() + v.rit.remain * 1000;
    FX.clockTotal = v.rit.total;
  } else if (v.turnRemain != null && betting) {
    FX.deadlineAt = Date.now() + v.turnRemain * 1000;
    FX.clockTotal = v.turnSeconds || 20;
  } else {
    FX.deadlineAt = null;
  }

  // ボード（新しいカードだけ配布アニメーション。ランイット複数回は行を分けて表示）
  const board = $('board');
  board.innerHTML = '';
  if (v.mode === 'full') {
    if (v.boards && v.boards.length > 1) {
      let total = 0;
      const prev = FX.board;
      v.boards.forEach((bd, k) => {
        const row = document.createElement('div');
        row.className = 'board-row' + (v.phase === 'runout' && k === v.runIdx ? ' active' : '');
        const lb = document.createElement('span');
        lb.className = 'run-label';
        lb.textContent = `RUN${k + 1}`;
        row.appendChild(lb);
        bd.forEach(c => { row.appendChild(cardEl(c, true, total >= prev, (total - prev) * 130)); total++; });
        board.appendChild(row);
      });
      if (total < FX.board) FX.board = 0;
      FX.board = total;
    } else {
      if (v.board.length < FX.board) FX.board = 0; // 新ハンド等でリセット
      v.board.forEach((c, i) => board.appendChild(cardEl(c, false, i >= FX.board, (i - FX.board) * 110)));
      FX.board = v.board.length;
      // 空きスロット（ハンド中は5枠を常時表示）
      if (v.handNum && ['preflop', 'flop', 'turn', 'river', 'rit', 'runout', 'showdown'].includes(v.phase)) {
        for (let i = v.board.length; i < 5; i++) {
          const s = document.createElement('div');
          s.className = 'slot';
          board.appendChild(s);
        }
      }
    }
  }

  // 招待ヒント（待機中 or プレイヤーが足りない時に卓の中央へ）
  const showInvite = v.phase === 'lobby' || (v.players.length < 2 && !['preflop', 'flop', 'turn', 'river', 'showdown', 'rit', 'runout'].includes(v.phase));
  $('inviteHint').classList.toggle('hidden', !showInvite);
  if (showInvite) $('inviteHint').querySelector('.ih-code').textContent = `参加コード: ${v.code}`;

  // 結果表示（アクション演出が流れ終わってから出す）
  const rb = $('resultBox');
  if (v.result && (v.phase === 'result') && !cutinBusy) {
    rb.innerHTML = v.result.lines.map(l => `<div>${esc(l)}</div>`).join('');
    rb.classList.remove('hidden');
  } else rb.classList.add('hidden');

  // プレイヤー一覧ヘッダー
  const online = v.players.filter(p => p.connected).length;
  $('playersHead').innerHTML = `<span>PLAYERS <b>${v.players.length}</b>/10${v.spectators ? ` ・👁 ${v.spectators}` : ''}</span><span class="oncount">🟢 オンライン ${online}</span>`;

  // ---- 楕円テーブル配置（自分が下中央） ----
  const seats = $('seats');
  seats.innerHTML = '';
  const n = v.players.length;
  seats.className = n >= 7 ? 'compact' : ''; // 多人数はプレート/アバターを縮小
  const meIdx = you ? you.idx : 0;
  const posOf = (r, rx, ry) => {
    const th = Math.PI / 2 + (r * 2 * Math.PI) / n; // r=0 → 真下、時計回り
    return { x: 50 + rx * Math.cos(th), y: 50 + ry * Math.sin(th) };
  };
  const SEAT_RX = 40, SEAT_RY = 41; // 席の楕円半径（下段席がフッターに被らない高さ）
  v.players.forEach((p, i) => {
    const r = (i - meIdx + n) % n;
    const pos = posOf(r, SEAT_RX, SEAT_RY); // 縦長楕円に沿って配置
    const seat = document.createElement('div');
    seat.className = 'tseat' + (i === v.turn && betting ? ' turn' : '') + (p.folded ? ' folded' : '') + (p.sitout ? ' sitout' : '');
    seat.style.left = pos.x + '%';
    seat.style.top = pos.y + '%';

    // 手札：自分は表向きで扇形（GG風）、相手は裏面（公開時は表）
    const tc = document.createElement('div');
    tc.className = 'tcards';
    if (v.handNum && p.inHand && !p.folded && (v.mode === 'full' ? p.cards.length : true)) {
      if (v.mode === 'full') {
        const cs = p.you ? (you?.cards || p.cards) : p.cards;
        if (p.you) tc.classList.add('mine');
        if (cs[0]) tc.classList.add('up'); // 表向き＝アバターより前面に
        cs.forEach(c => tc.appendChild(cardEl(c, true)));
      } else {
        tc.appendChild(cardEl(null, true));
        tc.appendChild(cardEl(null, true));
      }
    }
    seat.appendChild(tc);

    // アバター（GG風・絵文字キャラ / BOTは🤖）
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = p.bot ? '🤖' : avatarEmoji(p.name);
    av.style.background = p.bot ? '#3a4358' : avatarColor(p.name);
    seat.appendChild(av);

    // ネームプレート（＋エクイティ表示）
    const pl = p.stack + p.streetBet - p.buyIn;
    const plCls = pl > 0 ? 'pl-plus' : pl < 0 ? 'pl-minus' : 'pl-zero';
    const eq = v.equity && p.inHand && !p.folded ? v.equity[p.id] : null;
    const plate = document.createElement('div');
    plate.className = 'plate';
    plate.innerHTML =
      `<div class="pnm"><span class="dot ${p.connected ? 'on' : 'off'}"></span>${esc(p.name)}${p.isDealerRole ? '🎩' : ''}</div>` +
      `<div class="pstk">${fmtShort(p.stack)}<span class="plmini ${plCls}">${pl >= 0 ? '+' : ''}${fmtShort(pl)}</span></div>` +
      (eq != null ? `<div class="eqv${eq >= 50 ? ' lead' : ''}">${eq}%</div>` : '');
    seat.appendChild(plate);

    // 現在の手役ピル（カードが見えているプレイヤーのみ・GGの "Two Pair" 相当）
    if (v.mode === 'full' && p.inHand && !p.folded && p.cards.length && (p.you ? you?.cards?.length : p.cards[0])) {
      const ht = handText([...(p.you ? you.cards : p.cards), ...v.board]);
      if (ht) {
        const hr = document.createElement('div');
        hr.className = 'handrank';
        hr.textContent = ht;
        seat.appendChild(hr);
      }
    }
    // 手番の残り時間メーター
    if (i === v.turn && betting) {
      const m = document.createElement('div');
      m.className = 'tmeter seatmeter';
      m.innerHTML = '<div class="tmeter-fill"></div>';
      seat.appendChild(m);
    }

    // SB/BBバッジ
    if ((betting || v.phase === 'showdown') && (i === v.sbIdx || i === v.bbIdx)) {
      const bd = document.createElement('div');
      bd.className = 'blindbadge ' + (i === v.sbIdx ? 'sb' : 'bb');
      bd.textContent = i === v.sbIdx ? 'SB' : 'BB';
      seat.appendChild(bd);
    }

    // アクションタグ
    if (i === v.turn && betting) {
      // 手番：吹き出し表示（メーターはプレート下）
      const say = document.createElement('div');
      say.className = 'saybubble';
      say.textContent = p.you ? 'あなたの番！' : 'どうする…？';
      seat.appendChild(say);
    } else if (p.sitout) {
      seat.appendChild(tag('離席'));
    } else if (p.mucked) {
      seat.appendChild(tag('マック', 'fold'));
    } else if (v.handNum && !p.inHand && betting) {
      seat.appendChild(tag('待ち'));
    } else if (p.lastAct && (betting || v.phase === 'showdown')) {
      const cls = p.lastAct === 'フォールド' ? 'fold' : p.lastAct === 'ALL IN' ? 'allin' : p.lastAct === 'レイズ' ? 'raise' : p.lastAct === 'ベット' ? 'bet' : p.lastAct === 'コール' ? 'call' : 'check';
      seat.appendChild(tag(p.lastAct, cls));
    }
    seats.appendChild(seat);

    // ベット額チップ：プレート帯とPOTの中間の「内側リング」に固定
    // （席からの割合だと左右席でプレートに乗るため、独立した小さめ楕円に配置）
    if (p.streetBet > 0) {
      const bpos = r === 0 ? posOf(r, 22, 26) : posOf(r, 25, 31);
      const bb = document.createElement('div');
      bb.className = 'bet-bubble';
      bb.style.left = bpos.x + '%';
      bb.style.top = bpos.y + '%';
      bb.innerHTML = `<span class="chipicon"></span>${fmtShort(p.streetBet)}`;
      if (p.streetBet > (FX.bets[p.id] || 0)) bb.classList.add('bump');
      seats.appendChild(bb);
    }
    FX.bets[p.id] = p.streetBet;

    // ディーラーボタン
    if (i === v.button && v.handNum) {
      const th = Math.PI / 2 + (r * 2 * Math.PI) / n + 0.38;
      const db = document.createElement('div');
      db.className = 'dbtn';
      db.style.left = (50 + 27 * Math.cos(th)) + '%';
      db.style.top = (50 + 37 * Math.sin(th)) + '%';
      db.textContent = 'D';
      seats.appendChild(db);
    }
  });

  // ログ
  $('log').innerHTML = v.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('');

  // 収支表
  const rows = v.players.map(p => {
    const now = p.stack + p.streetBet;
    const pl = now - p.buyIn;
    return `<div class="lg-row${p.you ? ' me' : ''}"><span class="lg-nm">${esc(p.name)}</span><span>${fmt(p.buyIn)}</span><span>${fmt(now)}</span><span class="${pl > 0 ? 'pl-plus' : pl < 0 ? 'pl-minus' : ''}">${pl >= 0 ? '+' : ''}${fmt(pl)}</span></div>`;
  }).join('');
  const gone = v.ledger.map(e => {
    const pl = e.cashOut - e.buyIn;
    return `<div class="lg-row gone"><span class="lg-nm">${esc(e.name)}（退出済）</span><span>${fmt(e.buyIn)}</span><span>${fmt(e.cashOut)}</span><span class="${pl > 0 ? 'pl-plus' : pl < 0 ? 'pl-minus' : ''}">${pl >= 0 ? '+' : ''}${fmt(pl)}</span></div>`;
  }).join('');
  $('ledger').innerHTML = `<div class="lg-row lg-head"><span class="lg-nm">プレイヤー</span><span>バイイン</span><span>現在</span><span>収支</span></div>${rows}${gone}` +
    (['preflop', 'flop', 'turn', 'river', 'showdown'].includes(v.phase) ? '<div class="lg-note">※ハンド中：ポットに入っている分は「現在」に含まれません</div>' : '');

  // 自分のスタック・現在の手役（カードは卓上の自席に表示）
  const mh = $('myHandRank'); // 古いHTMLキャッシュでも描画が止まらないようガード
  if (you) {
    $('myStack').textContent = fmt(you.stack);
    if (mh) {
      const ht = v.mode === 'full' && you.cards.length ? handText([...you.cards, ...v.board]) : '';
      mh.textContent = ht;
      mh.classList.toggle('hidden', !ht);
    }
  } else if (v.spectator) {
    $('myStackLine').textContent = '👁 観戦モード（全ハンド＋エクイティ表示）';
    if (mh) mh.classList.add('hidden');
  }

  // 卓下部のゲーム情報
  const fi = $('feltInfo');
  if (fi) {
    let s = `${v.mode === 'full' ? "NL HOLD'EM" : 'チップモード'} ・ ${v.sb}/${v.bb}`;
    if (v.ante) s += ` ・ ante ${v.ante}`;
    if (v.streamMode) s += ' ・ 📺配信';
    if (v.blindUpRemain != null) s += ` ・ UP ${Math.floor(v.blindUpRemain / 60)}:${String(v.blindUpRemain % 60).padStart(2, '0')}`;
    fi.textContent = s;
  }

  // アクションバー
  const myTurn = you && you.myTurn;
  if (myTurn && !FX.myTurn) { SND.turn(); try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch {} }
  FX.myTurn = !!myTurn;
  // 予約アクションがあれば手番到来時に自動実行（実行したら以降の描画はスキップ）
  if (myTurn && runPreActionIfMyTurn(v)) return;
  $('turnBanner').classList.toggle('hidden', !myTurn);
  $('turnMeter').classList.toggle('hidden', !myTurn);
  $('actions').classList.toggle('hidden', !myTurn || raiseOpen);
  if (!myTurn) { raiseOpen = false; }
  $('raiseRow').classList.toggle('hidden', !(myTurn && raiseOpen));
  if (myTurn && raiseOpen) updateRaiseQuick();
  if (myTurn) {
    const cc = $('btnCheckCall');
    if (you.canCheck) { cc.textContent = 'チェック'; cc.disabled = false; }
    else { cc.textContent = `コール ${fmt(you.toCall)}`; cc.disabled = false; }
    $('btnRaiseOpen').disabled = !you.canRaise;
    const isBet = v.phase !== 'preflop' && v.players.every(p => !p.streetBet);
    $('btnRaiseOpen').textContent = isBet ? 'ベット' : 'レイズ';
    $('btnRaise').textContent = isBet ? 'ベット' : 'レイズ';
  }
  // 事前アクション：ハンド参加中で自分の番でない時だけ表示
  const inHandNow = betting && you && you.stack >= 0 && v.players.find(p => p.you)?.inHand && !v.players.find(p => p.you)?.folded && !v.players.find(p => p.you)?.allIn;
  const showPre = inHandNow && !myTurn;
  $('preActions').classList.toggle('hidden', !showPre);
  if (!showPre && preAction) clearPre();
  if (showPre) {
    // 次に自分が直面する状況で「チェック」が使えるかは未確定。両方出しておく
    $('paCheckWrap').style.display = '';
    $('paCallWrap').style.display = '';
  }

  // マック時の「見せる」ボタン（結果画面・自分がショーダウン参加者）
  let showBtn = $('btnShowCards');
  if (you && you.canShow) {
    if (!showBtn) {
      showBtn = document.createElement('button');
      showBtn.id = 'btnShowCards';
      showBtn.className = 'act call';
      showBtn.textContent = '🃏 手札を見せる';
      showBtn.onclick = () => act('showCards');
      $('myInfo').after(showBtn);
    }
    showBtn.classList.remove('hidden');
  } else if (showBtn) showBtn.classList.add('hidden');

  // 自動離席からの復帰ボタン
  let unsitBtn = $('btnUnsit');
  if (you && you.sitout) {
    if (!unsitBtn) {
      unsitBtn = document.createElement('button');
      unsitBtn.id = 'btnUnsit';
      unsitBtn.className = 'act call';
      unsitBtn.textContent = '▶ 着席する（ハンドに復帰）';
      unsitBtn.onclick = () => act('unsit');
      $('myInfo').after(unsitBtn);
    }
    unsitBtn.classList.remove('hidden');
  } else if (unsitBtn) unsitBtn.classList.add('hidden');

  // ハンド履歴
  renderHistory(v);

  // ディーラーパネル
  renderDealer(v, you, betting);
  renderPotAssign(v, you);
  renderRit(v);
}

// ---------- ハンド履歴 ----------
function renderHistory(v) {
  const el = $('handHistory');
  if (!el) return;
  const hist = v.handHistory || [];
  if (!hist.length) { el.innerHTML = '<div class="rl-empty">まだハンドがありません</div>'; return; }
  el.innerHTML = hist.map(h => {
    const boardStr = bd => (bd || []).map(c => c ? (RANK[c.r] || c.r) + SUIT[c.s] : '').join(' ');
    const board = h.boards && h.boards.length > 1
      ? h.boards.map((b, i) => `RUN${i + 1}: ${boardStr(b)}`).join(' / ')
      : boardStr(h.board);
    const hands = (h.hands || []).map(p => `${esc(p.name)} ${p.cards.map(c => (RANK[c.r] || c.r) + SUIT[c.s]).join('')}${p.hand ? '（' + p.hand + '）' : ''}`).join('、');
    const win = (h.lines || []).filter(l => l.includes('獲得')).join(' / ');
    return `<div class="hh-item"><div class="hh-head">#${h.handNum} <span class="hh-board">${esc(board)}</span></div>` +
      (hands ? `<div class="hh-hands">${hands}</div>` : '') +
      `<div class="hh-win">${esc(win)}</div></div>`;
  }).join('');
}

// ---------- ランイット選択パネル ----------
function renderRit(v) {
  const el = $('ritPanel');
  if (v.phase !== 'rit' || !v.rit) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="rit-title">⚡ オールイン対決！ ランイット回数を選択</div>
    <div class="rit-note">全員が選択したら開始。<b>少ない回数が採用</b>（未選択のまま時間切れ＝1回）</div>
    <div class="tmeter"><div class="tmeter-fill"></div></div>
    <div class="rit-status">${v.rit.choices.map(c => `<span class="${c.n ? 'done' : ''}">${esc(c.name)}: ${c.n ? c.n + '回' : '選択中…'}</span>`).join('')}</div>`;
  if (v.rit.canChoose) {
    const row = document.createElement('div');
    row.className = 'rit-btns';
    [1, 2, 3].forEach(n => {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = `${n}回`;
      b.onclick = () => act('ritChoose', { n });
      row.appendChild(b);
    });
    el.appendChild(row);
  }
}

function tag(txt, cls) {
  const t = document.createElement('div');
  t.className = 'tag' + (cls ? ' ' + cls : '');
  t.textContent = txt;
  return t;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderDealer(v, you, betting) {
  const panel = $('dealerPanel');
  if (!you || !you.isDealer) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const btns = $('dealerBtns');
  btns.innerHTML = '';
  const mk = (label, fn, cls) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    btns.appendChild(b);
  };
  if (v.phase === 'lobby' || v.phase === 'result') {
    mk(v.handNum ? '▶ 次のハンドを開始' : '▶ ハンドを開始', () => act('startHand'), 'go');
    if (v.mode === 'full') {
      mk('🤖 BOT追加', () => {
        const n = prompt(`追加するBOTの数（残り席 ${10 - v.players.length}）`, '1');
        if (n == null || !n.trim()) return;
        act('addBot', { count: n });
      });
    }
    mk('ブラインド変更', () => {
      const sb = prompt('SB', v.sb); if (sb == null) return;
      const bb = prompt('BB', v.bb); if (bb == null) return;
      act('setBlinds', { sb, bb });
    });
    mk('アンティ変更', () => {
      const ante = prompt('アンティ額（0=なし）', v.ante || 0); if (ante == null) return;
      act('setAnte', { ante });
    });
    if (v.spectators > 0 || v.streamMode) {
      mk(v.streamMode ? '🔒 配信モードOFF' : '📺 配信モードON', () => {
        if (!v.streamMode && !confirm('配信モードをONにすると観戦者に全員の手札が見えます。共謀防止のため、信頼できる観戦者のみの時に使ってください。ONにしますか？')) return;
        act('toggleStream');
      });
    }
  }
  if (v.mode === 'chip' && v.awaitDealer) mk('▶ 次のストリートへ（実カードを配ってから）', () => act('nextStreet'), 'go');
  if (betting && v.turn >= 0) {
    const cur = v.players[v.turn];
    if (cur && !cur.you) {
      mk(`代理: ${cur.name} をフォールド`, () => { if (confirm(`${cur.name} の代理でフォールドしますか？`)) act('proxyAct', { sub: 'fold' }); });
      mk(`代理: チェック/コール`, () => act('proxyAct', { sub: cur.streetBet >= Math.max(...v.players.map(p => p.streetBet)) ? 'check' : 'call' }));
    }
  }
  if (betting || v.phase === 'showdown') {
    mk('±ポット修正', () => {
      const d = prompt(`回収済みポットの増減（例: 500 / -500）`, '');
      if (d == null || d.trim() === '') return;
      act('adjustPot', { delta: d });
    });
    mk('ハンド中止（ベット返却）', () => { if (confirm('このハンドを中止して全ベットを返却しますか？')) act('cancelHand'); }, 'warn');
  }
  if (v.undoCount > 0) mk(`↩ 1手戻す（あと${v.undoCount}回）`, () => { if (confirm('直前の操作を取り消して1手前の状態に戻しますか？')) act('undo'); }, 'warn');

  const dp = $('dealerPlayers');
  dp.innerHTML = '';
  v.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'dp-row';
    const nm = document.createElement('span');
    nm.textContent = `${p.name}（${fmt(p.stack)}）`;
    row.appendChild(nm);
    const bbuy = document.createElement('button');
    bbuy.textContent = '＋追加';
    bbuy.onclick = () => {
      const amt = prompt(`${p.name} へのチップ追加（リバイ/アドオン・収支に計上）`, '');
      if (amt == null || amt.trim() === '') return;
      act('addChips', { playerId: p.id, amount: amt });
    };
    row.appendChild(bbuy);
    const badd = document.createElement('button');
    badd.textContent = '±修正';
    badd.onclick = () => {
      const d = prompt(`${p.name} のスタック増減（誤り訂正用・収支に計上しない。例: 500 / -300）`, '');
      if (d == null || d.trim() === '') return;
      act('adjustStack', { playerId: p.id, delta: d });
    };
    row.appendChild(badd);
    if (['preflop', 'flop', 'turn', 'river'].includes(v.phase) && p.inHand && !p.folded) {
      const bbet = document.createElement('button');
      bbet.textContent = 'ベット修正';
      bbet.onclick = () => {
        const to = prompt(`${p.name} の現在のベット額を修正（現在 ${p.streetBet}）`, p.streetBet);
        if (to == null || to.trim() === '') return;
        act('setBet', { playerId: p.id, to });
      };
      row.appendChild(bbet);
    }
    if (v.phase === 'lobby' || v.phase === 'result') {
      const bbtn = document.createElement('button');
      bbtn.textContent = '次BTN';
      bbtn.onclick = () => act('setButton', { playerId: p.id });
      row.appendChild(bbtn);
      const bsit = document.createElement('button');
      bsit.textContent = p.sitout ? '着席' : '離席';
      bsit.onclick = () => act('toggleSit', { playerId: p.id });
      row.appendChild(bsit);
      if (!p.you) {
        const bd = document.createElement('button');
        bd.textContent = '🎩交代';
        bd.onclick = () => { if (confirm(`ディーラー役を ${p.name} に渡しますか？`)) act('transferDealer', { playerId: p.id }); };
        row.appendChild(bd);
        const bk = document.createElement('button');
        bk.textContent = '退出';
        bk.onclick = () => { if (confirm(`${p.name} を退出させますか？`)) act('kick', { playerId: p.id }); };
        row.appendChild(bk);
      }
    }
    dp.appendChild(row);
  });
}

let assignSel = {}; // potIdx -> Set(playerId)
function renderPotAssign(v, you) {
  const box = $('potAssign');
  if (!(v.phase === 'showdown' && v.pots && you && you.isDealer)) {
    box.classList.add('hidden');
    if (v.phase !== 'showdown') assignSel = {};
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '<b>🏆 勝者を選んでポットを渡す</b>（同点チョップは複数選択）';
  v.pots.forEach((pot, pi) => {
    const blk = document.createElement('div');
    blk.className = 'pot-block';
    const label = v.pots.length > 1 ? (pi === 0 ? 'メインポット' : `サイドポット${pi}`) : 'ポット';
    const title = document.createElement('div');
    title.className = 'pot-title';
    title.textContent = `${label}: ${fmt(pot.amount)}` + (pot.winners ? ' ✓ 済' : '');
    blk.appendChild(title);
    if (!pot.winners) {
      if (!assignSel[pi]) assignSel[pi] = new Set();
      const cand = document.createElement('div');
      cand.className = 'cand';
      pot.eligible.forEach(id => {
        const p = v.players.find(x => x.id === id);
        if (!p || p.folded) return;
        const b = document.createElement('button');
        b.textContent = p.name;
        b.className = assignSel[pi].has(id) ? 'sel' : '';
        b.onclick = () => { assignSel[pi].has(id) ? assignSel[pi].delete(id) : assignSel[pi].add(id); render(); };
        cand.appendChild(b);
      });
      blk.appendChild(cand);
      const give = document.createElement('button');
      give.className = 'primary give';
      give.textContent = 'このポットを渡す';
      give.onclick = () => {
        if (!assignSel[pi].size) return showErr('tableErr', '勝者を選んでください');
        act('assignPot', { potIdx: pi, winnerIds: [...assignSel[pi]] });
        delete assignSel[pi];
      };
      blk.appendChild(give);
    }
    box.appendChild(blk);
  });
}

// ---------- ホーム操作 ----------
$('btnCreate').onclick = async () => {
  try {
    const j = await api('/api/create', {
      name: $('name').value,
      title: $('roomTitleInput').value,
      mode: document.querySelector('input[name=mode]:checked').value,
      sb: $('sb').value, bb: $('bb').value, stack: $('stack').value,
      turnSec: $('turnSec').value,
      ante: $('ante').value, blindUpMin: $('blindUpMin').value,
      ritRule: document.querySelector('input[name=ritRule]:checked')?.value || 'min',
    });
    enter(j.code, j.pid);
  } catch (e) { showErr('createErr', e.message); }
};

// コード欄には招待URLを貼ってもOK（?join=XXXX や末尾のコードを自動抽出）
function extractCode(v) {
  v = String(v || '').trim();
  const m = v.match(/[?&#]join=([A-Za-z0-9]{4})/) || v.match(/\b([A-Za-z0-9]{4})\s*$/);
  return (m ? m[1] : v).toUpperCase();
}
$('btnJoin').onclick = async () => {
  const spectate = $('specChk').checked;
  const code = extractCode($('joinCode').value);
  if (!code) return showErr('joinErr', 'ルームコード（4文字）か招待URLを入力してください');
  if (!$('name').value.trim()) return showErr('joinErr', '上のニックネームを入力してください');
  if (!spectate && !$('joinStack').value.trim()) return showErr('joinErr', 'バイイン（持ち点）を入力してください');
  try {
    const j = await api('/api/join', { name: $('name').value, code, stack: $('joinStack').value, spectate });
    enter(j.code, j.pid);
  } catch (e) { showErr('joinErr', e.message); }
};

// 招待モーダル
function openInvite() {
  const code = S.view?.code || S.code;
  if (!code) return;
  $('inviteModal').classList.remove('hidden');
  $('inviteModal').querySelector('.im-code').textContent = code;
  $('inviteUrl').value = `${location.origin}/?join=${code}`;
  $('btnShare').classList.toggle('hidden', !navigator.share);
}
$('btnInvite').onclick = openInvite;
$('btnInvite2').onclick = openInvite;
$('btnInviteClose').onclick = () => $('inviteModal').classList.add('hidden');
$('inviteModal').onclick = e => { if (e.target.id === 'inviteModal') e.target.classList.add('hidden'); };
$('inviteUrl').onclick = e => { e.target.select(); e.target.setSelectionRange(0, 999); };
$('btnCopyUrl').onclick = async e => {
  const inp = $('inviteUrl');
  inp.select();
  inp.setSelectionRange(0, 999);
  let ok = false;
  try { await navigator.clipboard.writeText(inp.value); ok = true; } catch {}
  if (!ok) { try { ok = document.execCommand('copy'); } catch {} }
  e.target.textContent = ok ? '✓ コピーしました' : 'URLを長押しでコピーして';
  setTimeout(() => { e.target.textContent = 'URLをコピー'; }, 1800);
};
$('btnShare').onclick = () => {
  navigator.share({ title: 'ポケチップ', text: `ポーカーやろう！参加コード: ${S.view?.code || S.code}`, url: $('inviteUrl').value }).catch(() => {});
};

// ミュート切替
function renderMute() { $('btnMute').textContent = muted ? '🔇' : '🔊'; }
$('btnMute').onclick = () => {
  muted = !muted;
  localStorage.setItem('pokechip_mute', muted ? '1' : '0');
  if (!muted) SND.chip();
  renderMute();
};
renderMute();
$('btnLeave').onclick = async () => {
  const y = S.view?.you;
  if (!y) {
    // 観戦者はサーバー側からも退出
    try { await api('/api/act', { code: S.code, pid: S.pid, type: 'leaveRoom' }); } catch {}
    return leave();
  }
  const now = y.stack + y.myBet;
  const pl = now - y.buyIn;
  if (!confirm(`退出して精算しますか？\n\nバイイン: ${y.buyIn}\n現在: ${now}\n収支: ${pl >= 0 ? '+' : ''}${pl}\n\n※精算は収支表に記録されます`)) return;
  try {
    await api('/api/act', { code: S.code, pid: S.pid, type: 'leaveRoom' });
    leave();
  } catch (e) { showErr('tableErr', e.message); }
};

// ---------- アクション操作 ----------
$('btnFold').onclick = () => act('fold'); // 確認なしで即フォールド
$('btnCheckCall').onclick = () => act(S.view.you.canCheck ? 'check' : 'call');
// レイズ用クイックボタンの内容を状況で組み立てる
// ・そのストリート最初の賭け（オープンベット, currentBet=0）→ ポット基準（½・¾・ポット）
// ・プリフロップ最初のレイズ（currentBet=BB）→ BB基準の 2x / 2.5x / 3x
// ・リレイズ（既にベット/レイズあり）→ 対象ベット額の ×2 / ×2.5 / ×3
function raiseQuickConfig(v) {
  const y = v.you;
  const clamp = to => Math.max(y.minTo, Math.min(y.maxTo, to));
  const round = n => Math.round(n / 10) * 10;
  const curBet = y.myBet + y.toCall; // コール対象額（相手の最大ベット）
  if (curBet <= 0) {
    // オープンベット（ポストフロップ）
    return [
      { label: '½ポット', to: clamp(round(v.pot / 2)) },
      { label: '¾ポット', to: clamp(round(v.pot * 3 / 4)) },
      { label: 'ポット', to: clamp(round(v.pot)) },
    ];
  }
  const preOpen = v.phase === 'preflop' && curBet === v.bb; // プリフロップ最初のレイズ
  return [2, 2.5, 3].map(m => ({
    label: preOpen ? `${m}x` : `×${m}`,
    to: clamp(round(curBet * m)),
  }));
}
function updateRaiseQuick() {
  const v = S.view;
  if (!v || !v.you) return;
  const cfg = raiseQuickConfig(v);
  const btns = document.querySelectorAll('.raise-quick button');
  btns.forEach((b, i) => {
    if (i < 3) {
      b.textContent = cfg[i].label;
      b.dataset.to = cfg[i].to;
    } else {
      b.textContent = 'オールイン';
      b.dataset.to = v.you.maxTo;
    }
  });
}

// スライダー位置(0-100) ⇔ レイズ額(minTo〜maxTo) の相互変換
function sliderToAmount(pct) {
  const y = S.view.you;
  const raw = y.minTo + (y.maxTo - y.minTo) * (pct / 100);
  return Math.max(y.minTo, Math.min(y.maxTo, Math.round(raw / 10) * 10));
}
function amountToSlider(amt) {
  const y = S.view.you;
  if (y.maxTo <= y.minTo) return 0;
  return Math.max(0, Math.min(100, Math.round((amt - y.minTo) / (y.maxTo - y.minTo) * 100)));
}
function setRaiseAmount(amt) {
  const y = S.view.you;
  amt = Math.max(y.minTo, Math.min(y.maxTo, amt));
  $('raiseTo').value = amt;
  $('raiseSlider').value = amountToSlider(amt);
}
$('btnRaiseOpen').onclick = () => {
  raiseOpen = true;
  updateRaiseQuick();
  const first = document.querySelector('.raise-quick button');
  setRaiseAmount(first ? +first.dataset.to : S.view.you.minTo);
  render();
};
$('btnRaiseCancel').onclick = () => { raiseOpen = false; render(); };
$('btnRaise').onclick = () => { raiseOpen = false; act('raise', { to: $('raiseTo').value }); };
$('raiseSlider').oninput = () => { $('raiseTo').value = sliderToAmount(+$('raiseSlider').value); };
$('raiseTo').oninput = () => { const v = +$('raiseTo').value; if (Number.isFinite(v)) $('raiseSlider').value = amountToSlider(v); };
document.querySelectorAll('.raise-quick button').forEach(b => {
  b.onclick = () => { if (b.dataset.to) setRaiseAmount(+b.dataset.to); };
});

// ---------- 事前アクション（プリアクション） ----------
let preAction = null; // 'checkfold' | 'check' | 'call'
function clearPre() { preAction = null; ['paCheckFold', 'paCheck', 'paCall'].forEach(id => { const el = $(id); if (el) el.checked = false; }); }
[['paCheckFold', 'checkfold'], ['paCheck', 'check'], ['paCall', 'call']].forEach(([id, kind]) => {
  const el = $(id);
  if (el) el.onchange = () => {
    if (el.checked) { clearPre(); el.checked = true; preAction = kind; }
    else preAction = null;
  };
});
// 手番が来たら予約アクションを自動実行（renderから呼ばれる）
function runPreActionIfMyTurn(v) {
  const y = v.you;
  if (!y || !y.myTurn || !preAction || raiseOpen) return false;
  const p = preAction;
  if (p === 'checkfold') { const t = y.canCheck ? 'check' : 'fold'; clearPre(); act(t); return true; }
  if (p === 'check') { if (y.canCheck) { clearPre(); act('check'); return true; } clearPre(); return false; /* ベットが入ったら取消 */ }
  if (p === 'call') { clearPre(); act(y.canCheck ? 'check' : 'call'); return true; }
  return false;
}

// ---------- 復帰 ----------
(() => {
  // URL復帰: #code=XXXX&pid=... または ?code=XXXX&pid=...（自分のpidのみ有効。処理後はURLから消す）
  const qs = location.hash.includes('pid=') ? location.hash.slice(1) : (location.search.includes('pid=') ? location.search.slice(1) : '');
  if (qs) {
    const h = new URLSearchParams(qs);
    const code = h.get('code'), pid = h.get('pid');
    history.replaceState(null, '', location.pathname);
    if (code && pid) return enter(code.toUpperCase(), pid);
  }
  // 招待リンク: ?join=XXXX → コード入力済みの参加画面
  const jn = new URLSearchParams(location.search).get('join');
  if (jn) {
    history.replaceState(null, '', location.pathname);
    $('joinCode').value = jn.toUpperCase();
    $('name').focus();
  }
  const saved = sessionStorage.getItem('pokechip');
  if (saved) {
    try { const { code, pid } = JSON.parse(saved); enter(code, pid); return; } catch {}
  }
  loadRooms();
})();
