// ポケチップ — 仲間内ポーカー用チップ管理＋カード配布サーバー（依存ゼロ）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3300;
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 20;
// public/ があればそこ、無ければ同階層（フラット配置デプロイに対応）
const PUB = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const rooms = new Map();

// ---------- カード・役判定 ----------
const SUITS = ['s', 'h', 'd', 'c'];
function newDeck() {
  const d = [];
  for (let r = 2; r <= 14; r++) for (const s of SUITS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const CATNAMES = ['ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ'];

function eval5(cs) {
  const rs = cs.map(c => c.r).sort((a, b) => b - a);
  const flush = cs.every(c => c.s === cs[0].s);
  let sHigh = 0;
  const uniq = [...new Set(rs)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) sHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) sHigh = 5; // A-5
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

function best7(cards) {
  let best = -1;
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 7; j++) {
    const five = cards.filter((_, k) => k !== i && k !== j);
    const s = eval5(five);
    if (s > best) best = s;
  }
  return best;
}
const catOf = score => { let c = score; for (let i = 0; i < 5; i++) c = Math.floor(c / 15); return c; };

// 役の詳細説明（例: ツーペア（A・K））
const RANK_NAME = r => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' }[r] || String(r));
function describeHand(score) {
  const d = [];
  let s = score;
  for (let i = 0; i < 5; i++) { d.unshift(s % 15); s = Math.floor(s / 15); }
  const cat = s;
  const R = i => RANK_NAME(d[i]);
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
  return CATNAMES[cat] || '';
}

// ---------- エクイティ計算（モンテカルロ、リバー後は厳密） ----------
function equityCalc(actors, board, stub, iters = 800) {
  const res = Object.fromEntries(actors.map(a => [a.key, 0]));
  const need = 5 - board.length;
  if (need === 0) {
    const scores = actors.map(a => ({ a, s: best7([...a.cards, ...board]) }));
    const top = Math.max(...scores.map(x => x.s));
    const ws = scores.filter(x => x.s === top);
    ws.forEach(x => { res[x.a.key] = Math.round(1000 / ws.length) / 10; });
    if (ws.length === 1) res[ws[0].a.key] = 100;
    return res;
  }
  const deck = stub.slice();
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + crypto.randomInt(deck.length - i);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const full = board.concat(deck.slice(0, need));
    let top = -1, ws = [];
    for (const a of actors) {
      const s = best7([...a.cards, ...full]);
      if (s > top) { top = s; ws = [a]; }
      else if (s === top) ws.push(a);
    }
    for (const a of ws) res[a.key] += 1 / ws.length;
  }
  for (const k in res) res[k] = Math.round((res[k] / iters) * 1000) / 10;
  return res;
}

function updateEquity(room) {
  if (room.mode !== 'full') { room.equity = null; return; }
  const watch = room.spectators.length > 0 || room.allinReveal;
  const phaseOk = BETTING.includes(room.phase) || room.phase === 'rit' || room.phase === 'runout';
  const actors = room.players.filter(p => p.inHand && !p.folded && p.cards.length);
  if (!watch || !phaseOk || actors.length < 2) { room.equity = null; return; }
  room.equity = equityCalc(actors.map(p => ({ key: p.pub, cards: p.cards })), room.board, room.deck);
}

// ---------- ルーム ----------
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while (rooms.has(c));
  return c;
}

function makePlayer(name, stack, bot = false) {
  return {
    id: crypto.randomUUID(), // 秘密ID（本人認証用・本人にしか渡さない）
    pub: crypto.randomUUID().slice(0, 8), // 公開ID（表示・ディーラー操作の対象指定用）
    name, stack, buyIn: stack, bot,
    inHand: false, folded: false, allIn: false, sitout: false,
    streetBet: 0, totalBet: 0, cards: [], acted: false, lastAct: null,
  };
}

// ---------- BOT（コンピュータープレイヤー） ----------
const BOT_NAMES = ['タロウ', 'ハナ', 'ケンジ', 'ミカ', 'ゴロー', 'リン', 'ジュン', 'アキ', 'サトシ', 'ユイ'];

// 自分の手札＋ボードだけから勝率を推定（他人の手札は見ない＝フェア）
function botStrength(room, p, iters = 150) {
  const seen = new Set([...p.cards, ...room.board].map(c => c.r + c.s));
  const stub = [];
  for (let r = 2; r <= 14; r++) for (const s of SUITS) { if (!seen.has(r + s)) stub.push({ r, s }); }
  const need = 5 - room.board.length;
  let win = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need + 2; i++) {
      const j = i + crypto.randomInt(stub.length - i);
      [stub[i], stub[j]] = [stub[j], stub[i]];
    }
    const opp = stub.slice(0, 2);
    const full = room.board.concat(stub.slice(2, 2 + need));
    const mine = best7([...p.cards, ...full]);
    const theirs = best7([...opp, ...full]);
    win += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
  }
  return win / iters;
}

function botAct(room, p) {
  const need = room.currentBet - p.streetBet;
  const s = botStrength(room, p);
  const pot = room.pot + room.players.reduce((x, q) => x + q.streetBet, 0);
  const rnd = crypto.randomInt(100) / 100;
  const maxTo = p.streetBet + p.stack;
  const raiseTo = size => Math.min(maxTo, Math.max(room.currentBet + room.minRaise, room.currentBet + Math.round(pot * size / 10) * 10));
  try {
    if (need <= 0) {
      if ((s > 0.7 && rnd < 0.7) || (s < 0.35 && rnd < 0.08)) return playerAction(room, p, 'raise', { to: raiseTo(s > 0.85 ? 0.9 : 0.55) });
      return playerAction(room, p, 'check', {});
    }
    const odds = need / (pot + need);
    if (s > 0.85 && rnd < 0.65) return playerAction(room, p, 'raise', { to: raiseTo(0.8) });
    if (s > odds * 0.95 || rnd < 0.02) return playerAction(room, p, 'call', {});
    return playerAction(room, p, 'fold', {});
  } catch (e) {
    // サイズ不正等のフォールバック
    try { playerAction(room, p, need <= 0 ? 'check' : 'call', {}); }
    catch { try { playerAction(room, p, 'fold', {}); } catch {} }
  }
}

function createRoom({ name, title, mode, sb, bb, stack, turnSec }) {
  const room = {
    code: makeCode(), title, mode, sb, bb, startStack: stack,
    turnSeconds: turnSec,
    turnPid: null, turnDeadline: null, turnKey: null,
    players: [], dealerId: null,
    phase: 'lobby', handNum: 0, button: -1, sbIdx: -1, bbIdx: -1,
    deck: [], board: [], pot: 0, pots: null,
    currentBet: 0, minRaise: 0, turn: -1, lastRaiseFull: true,
    awaitDealer: false, buttonPin: -1,
    result: null, log: [], history: [], ledger: [],
    seq: 0, lastAction: null, // 演出用（カットイン）。undoでは巻き戻さない
    spectators: [], // 観戦者 {id, pub, name}
    equity: null, // {pub: %} 観戦者/オールイン時の表示用
    ritChoices: null, ritDeadline: null, // ランイット選択
    boards: null, runN: 1, runIdx: 0, baseBoard: null, runResults: null, // 複数ランアウト
    allinReveal: false, runToken: 0,
    streams: new Map(), // pid -> [res]
  };
  const p = makePlayer(name, stack);
  room.players.push(p);
  room.dealerId = p.id;
  rooms.set(room.code, room);
  addLog(room, `${name} がルームを作成（${mode === 'full' ? 'フルモード' : 'チップモード'} / ブラインド ${sb}/${bb}）`);
  return { room, p };
}

function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 60) room.log.shift();
}

// ---------- スナップショット（巻き戻し用・最大20段階） ----------
const SNAP_KEYS = ['mode', 'sb', 'bb', 'phase', 'handNum', 'button', 'sbIdx', 'bbIdx', 'deck', 'board', 'pot', 'pots', 'currentBet', 'minRaise', 'turn', 'lastRaiseFull', 'awaitDealer', 'buttonPin', 'result', 'log', 'dealerId', 'ledger', 'equity', 'ritChoices', 'ritDeadline', 'boards', 'runN', 'runIdx', 'baseBoard', 'runResults', 'allinReveal'];
const MAX_HISTORY = 20;
function snapshot(room, label) {
  const s = { label };
  for (const k of SNAP_KEYS) s[k] = JSON.parse(JSON.stringify(room[k] ?? null));
  s.players = JSON.parse(JSON.stringify(room.players));
  room.history.push(s);
  if (room.history.length > MAX_HISTORY) room.history.shift();
}
function undo(room) {
  const s = room.history.pop();
  if (!s) return false;
  for (const k of SNAP_KEYS) room[k] = s[k];
  room.players = s.players;
  room.runToken++; // 進行中のランアウトタイマーを無効化
  addLog(room, `ディーラーが操作を1手戻した${s.label ? `（${s.label} の前へ）` : ''}`);
  return true;
}

// ---------- 進行ヘルパー ----------
const eligible = p => !p.sitout && p.stack > 0;
const inHandOf = room => room.players.filter(p => p.inHand);
const activeOf = room => room.players.filter(p => p.inHand && !p.folded);
const canActOf = room => room.players.filter(p => p.inHand && !p.folded && !p.allIn);

function nextIdx(room, from, pred) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (pred(room.players[i])) return i;
  }
  return -1;
}

function pay(p, amount) {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.streetBet += a;
  p.totalBet += a;
  if (p.stack === 0) p.allIn = true;
  return a;
}

const BETTING = ['preflop', 'flop', 'turn', 'river'];
const HAND_ACTIVE = [...BETTING, 'showdown', 'rit', 'runout'];
const PHASE_JA = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン', rit: 'オールイン！', runout: 'ランアウト', result: 'ハンド終了', lobby: '待機中' };

function startHand(room) {
  const elig = room.players.filter(eligible);
  if (elig.length < 2) throw new Error('スタックのあるプレイヤーが2人以上必要です');
  room.handNum++;
  room.deck = room.mode === 'full' ? newDeck() : [];
  room.board = [];
  room.pot = 0;
  room.pots = null;
  room.result = null;
  room.awaitDealer = false;
  room.lastRaiseFull = true;
  room.equity = null;
  room.ritChoices = null; room.ritDeadline = null;
  room.boards = null; room.runN = 1; room.runIdx = 0; room.baseBoard = null; room.runResults = null;
  room.allinReveal = false;
  room.runToken++;
  for (const p of room.players) {
    p.inHand = eligible(p);
    p.folded = false; p.allIn = false;
    p.streetBet = 0; p.totalBet = 0;
    p.cards = []; p.acted = false; p.lastAct = null;
  }
  // ボタン移動（ディーラー指定があれば優先）
  if (room.buttonPin >= 0 && room.players[room.buttonPin]?.inHand) {
    room.button = room.buttonPin;
  } else {
    room.button = nextIdx(room, room.button < 0 ? room.players.length - 1 : room.button, p => p.inHand);
  }
  room.buttonPin = -1;
  const inHand = inHandOf(room);
  if (inHand.length === 2) {
    room.sbIdx = room.button;
    room.bbIdx = nextIdx(room, room.button, p => p.inHand);
  } else {
    room.sbIdx = nextIdx(room, room.button, p => p.inHand);
    room.bbIdx = nextIdx(room, room.sbIdx, p => p.inHand);
  }
  pay(room.players[room.sbIdx], room.sb);
  pay(room.players[room.bbIdx], room.bb);
  room.currentBet = room.bb;
  room.minRaise = room.bb;
  room.phase = 'preflop';
  if (room.mode === 'full') {
    for (const p of inHand) p.cards = [room.deck.pop(), room.deck.pop()];
  }
  room.turn = nextIdx(room, room.bbIdx, p => p.inHand && !p.folded && !p.allIn);
  fx(room, 'hand', null, null, `HAND #${room.handNum}`);
  addLog(room, `─ ハンド #${room.handNum} 開始（BTN: ${room.players[room.button].name}）`);
  if (room.turn < 0 || bettingDone(room)) endBettingRound(room);
}

function bettingDone(room) {
  const ca = canActOf(room);
  return ca.every(p => p.acted && p.streetBet === room.currentBet);
}

// ベット回収＋コールされなかった分の返却
function collectBets(room) {
  const act = activeOf(room);
  const bets = act.map(p => p.streetBet).sort((a, b) => b - a);
  const max = bets[0] || 0, second = bets[1] || 0;
  if (max > second) {
    const over = act.find(p => p.streetBet === max);
    over.stack += max - second;
    over.totalBet -= max - second;
    over.streetBet = second;
    if (over.allIn && over.stack > 0) over.allIn = false;
    if (max - second > 0) addLog(room, `${over.name} にコールされなかった ${max - second} を返却`);
  }
  for (const p of room.players) {
    room.pot += p.streetBet;
    p.streetBet = 0;
    p.acted = false;
    if (!p.folded && !p.allIn) p.lastAct = null; // 新ストリートでタグをクリア（フォールド/ALL INは残す）
  }
  room.currentBet = 0;
  room.minRaise = room.bb;
  room.lastRaiseFull = true;
}

function endBettingRound(room) {
  collectBets(room);
  if (activeOf(room).length <= 1) return awardToLast(room);
  // フルモード：ベット続行不能（オールイン対決）でボード未完成 → ランイット選択へ
  if (room.mode === 'full' && canActOf(room).length < 2 && room.phase !== 'river') return startRit(room);
  advanceStreet(room);
}

// ---------- オールイン対決：ランイット選択 → 複数ランアウト ----------
function startRit(room) {
  room.phase = 'rit';
  room.turn = -1;
  room.awaitDealer = false;
  room.allinReveal = true; // 手札を全員に公開
  room.ritChoices = {};
  room.ritDeadline = Date.now() + room.turnSeconds * 1000;
  fx(room, 'phase', null, null, 'ALL IN');
  addLog(room, 'オールイン対決！ 各自ランイット回数（1〜3回）を選択。少ない回数が採用（20秒無選択は1回扱い）');
}

function ritChoose(room, p, n) {
  if (room.phase !== 'rit') throw new Error('今はランイット選択中ではありません');
  if (!p.inHand || p.folded) throw new Error('このハンドの参加者のみ選択できます');
  n = Math.floor(Number(n));
  if (![1, 2, 3].includes(n)) throw new Error('1〜3回で選択してください');
  if (room.ritChoices[p.id]) throw new Error('選択済みです');
  room.ritChoices[p.id] = n;
  addLog(room, `${p.name}: ランイット ${n}回 を選択`);
  if (activeOf(room).every(q => room.ritChoices[q.id])) beginRunout(room);
}

function beginRunout(room) {
  const actors = activeOf(room);
  const N = Math.max(1, Math.min(...actors.map(p => room.ritChoices[p.id] || 1)));
  room.runN = N;
  room.runIdx = 0;
  room.phase = 'runout';
  room.ritDeadline = null;
  room.pots = computePots(room);
  room.boards = [];
  room.baseBoard = room.board.slice();
  room.runResults = [];
  addLog(room, `ランアウト開始（${N}回・ポット ${room.pot} を${N > 1 ? `${N}分割` : '一括'}）`);
  fx(room, 'phase', null, null, N > 1 ? `RUN IT ${N === 2 ? 'TWICE' : '3 TIMES'}` : 'RUN OUT');
  room.runToken++;
  const token = room.runToken;
  setTimeout(() => runStep(room, token), 1200);
}

function runStep(room, token) {
  if (!rooms.has(room.code) || room.runToken !== token || room.phase !== 'runout') return;
  let bd = room.boards[room.runIdx];
  if (!bd) { bd = room.baseBoard.slice(); room.boards[room.runIdx] = bd; }
  room.board = bd;
  if (bd.length < 5) {
    const n = bd.length < 3 ? 3 - bd.length : 1;
    for (let i = 0; i < n; i++) bd.push(room.deck.pop());
    broadcast(room); // リバー時はここでエクイティが100%/0%になる
    return void setTimeout(() => runStep(room, token), 1400);
  }
  awardRun(room);
  broadcast(room);
  if (room.runIdx + 1 < room.runN) {
    room.runIdx++;
    return void setTimeout(() => runStep(room, token), 1600);
  }
  room.phase = 'result';
  room.result = { lines: room.runResults, reveal: true };
  room.pot = 0;
  broadcast(room);
}

// 現在のランの分（ポット÷ラン数）を精算
function awardRun(room) {
  const runShare = amt => {
    const per = Math.floor(amt / room.runN);
    return room.runIdx === 0 ? amt - per * (room.runN - 1) : per; // 端数は1回目に寄せる
  };
  const scores = new Map();
  for (const p of activeOf(room)) scores.set(p.id, best7([...p.cards, ...room.board]));
  // このランの各自の役（マック以外）
  const handsLine = activeOf(room).map(p => `${p.name}=${describeHand(scores.get(p.id))}`).join(' / ');
  const handsPrefix = room.runN > 1 ? `RUN${room.runIdx + 1}: ` : '';
  room.runResults.push(handsPrefix + handsLine);
  addLog(room, handsPrefix + handsLine);
  let runTotal = 0;
  let topNames = '';
  for (let pi = room.pots.length - 1; pi >= 0; pi--) {
    const pot = room.pots[pi];
    const amt = runShare(pot.amount);
    if (amt <= 0) continue;
    const contenders = pot.eligible.filter(id => scores.has(id));
    const best = Math.max(...contenders.map(id => scores.get(id)));
    const winners = contenders.filter(id => scores.get(id) === best);
    const share = Math.floor(amt / winners.length);
    let rem = amt - share * winners.length;
    for (const id of winners) {
      const q = room.players.find(x => x.id === id);
      q.stack += share + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
    }
    room.pot -= amt;
    runTotal += amt;
    const names = winners.map(id => room.players.find(q => q.id === id).name).join('・');
    if (pi === 0) topNames = names;
    const label = (room.runN > 1 ? `RUN${room.runIdx + 1} ` : '') + (room.pots.length > 1 ? (pi === 0 ? 'メイン' : `サイド${pi}`) : '');
    const line = `${label ? label + ': ' : ''}${names} が ${amt} を獲得（${describeHand(best)}）`;
    room.runResults.push(line);
    addLog(room, line);
  }
  fx(room, 'win', topNames, runTotal);
}

function advanceStreet(room) {
  if (room.phase === 'river') return toShowdown(room);
  room.phase = BETTING[BETTING.indexOf(room.phase) + 1];
  fx(room, 'phase', null, null, room.phase.toUpperCase());
  if (room.mode === 'full') {
    const n = room.phase === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) room.board.push(room.deck.pop());
    addLog(room, `${PHASE_JA[room.phase]}`);
  }
  const ca = canActOf(room);
  if (ca.length >= 2) {
    room.awaitDealer = false;
    room.turn = nextIdx(room, room.button, p => p.inHand && !p.folded && !p.allIn);
  } else {
    room.turn = -1;
    if (room.mode === 'full') return advanceStreet(room); // オールイン時は自動でランアウト
    room.awaitDealer = true; // チップモード：ディーラーが実カードを配って進行
  }
}

function awardToLast(room) {
  const winner = activeOf(room)[0];
  winner.stack += room.pot;
  room.result = { lines: [`${winner.name} が ${room.pot} を獲得（全員フォールド）`], reveal: false };
  fx(room, 'win', winner.name, room.pot);
  addLog(room, room.result.lines[0]);
  room.pot = 0;
  room.turn = -1;
  room.awaitDealer = false;
  room.phase = 'result';
}

function computePots(room) {
  const inHand = inHandOf(room);
  const levels = [...new Set(inHand.filter(p => !p.folded).map(p => p.totalBet))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lv of levels) {
    let amt = 0;
    for (const p of inHand) amt += Math.max(0, Math.min(p.totalBet, lv) - prev);
    const elig = inHand.filter(p => !p.folded && p.totalBet >= lv).map(p => p.id);
    prev = lv;
    if (amt > 0) {
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === elig.length && last.eligible.every(id => elig.includes(id))) last.amount += amt;
      else pots.push({ amount: amt, eligible: elig, winners: null });
    }
  }
  return pots;
}

function splitPot(room, pot, winnerIds) {
  const share = Math.floor(pot.amount / winnerIds.length);
  let rem = pot.amount - share * winnerIds.length;
  // 端数はボタンの左隣から順
  const ordered = [];
  let i = room.button;
  for (let k = 0; k < room.players.length; k++) {
    i = (i + 1) % room.players.length;
    if (winnerIds.includes(room.players[i].id)) ordered.push(room.players[i]);
  }
  for (const w of ordered) {
    w.stack += share + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  }
  pot.winners = winnerIds;
}

function toShowdown(room) {
  room.turn = -1;
  room.pots = computePots(room);
  room.pot = 0;
  if (room.mode === 'full') {
    const lines = [];
    const scores = new Map();
    for (const p of activeOf(room)) scores.set(p.id, best7([...p.cards, ...room.board]));
    for (let pi = room.pots.length - 1; pi >= 0; pi--) {
      const pot = room.pots[pi];
      const contenders = pot.eligible.filter(id => scores.has(id));
      const bestScore = Math.max(...contenders.map(id => scores.get(id)));
      const winners = contenders.filter(id => scores.get(id) === bestScore);
      splitPot(room, pot, winners);
      const names = winners.map(id => room.players.find(p => p.id === id).name).join('・');
      const label = room.pots.length > 1 ? (pi === 0 ? 'メインポット' : `サイドポット${pi}`) : 'ポット';
      lines.unshift(`${names} が${label} ${pot.amount} を獲得（${describeHand(bestScore)}）`);
    }
    // ショーダウン参加者（マック以外）の役を明記
    for (const p of [...activeOf(room)].reverse()) lines.unshift(`${p.name}: ${describeHand(scores.get(p.id))}`);
    room.result = { lines, reveal: true };
    lines.forEach(l => addLog(room, l));
    const w0 = room.pots[room.pots.length - 1];
    const wNames = w0.winners.map(id => room.players.find(p => p.id === id).name).join('・');
    fx(room, 'win', wNames, room.pots.reduce((s, x) => s + x.amount, 0));
    room.phase = 'result';
  } else {
    room.phase = 'showdown';
    room.awaitDealer = false;
    fx(room, 'phase', null, null, 'SHOWDOWN');
    addLog(room, 'ショーダウン：ディーラーが勝者にポットを渡してください');
  }
}

// 公開ID or 秘密IDでプレイヤーを引く（他人の秘密IDは配信されないため、なりすまし不可）
const findP = (room, key) => room.players.find(x => x.pub === key || x.id === key);

// 退出処理（精算をledgerに記録）
function removePlayer(room, idx, how) {
  const q = room.players[idx];
  room.ledger.push({ name: q.name, buyIn: q.buyIn, cashOut: q.stack });
  addLog(room, `${q.name} が退出（${how}）バイイン ${q.buyIn} → 持ち帰り ${q.stack}（収支 ${q.stack - q.buyIn >= 0 ? '+' : ''}${q.stack - q.buyIn}）`);
  room.streams.delete(q.id);
  room.players.splice(idx, 1);
  if (room.button >= idx) room.button--;
  if (room.buttonPin >= idx) room.buttonPin--;
  if (q.id === room.dealerId && room.players.length) {
    room.dealerId = room.players[0].id;
    addLog(room, `ディーラー役を ${room.players[0].name} に引き継ぎ`);
  }
  if (!room.players.length) rooms.delete(room.code);
}

function leaveRoom(room, p) {
  if (HAND_ACTIVE.includes(room.phase) && p.inHand) {
    throw new Error('ハンド中は退出できません（フォールドしてハンド終了後に退出してください）');
  }
  removePlayer(room, room.players.indexOf(p), '自分で退出');
}

function fx(room, kind, name, amount, text) {
  room.lastAction = { seq: ++room.seq, kind, name: name || null, amount: amount ?? null, text: text || null };
}

// ---------- アクション ----------
function playerAction(room, p, act, data) {
  if (!BETTING.includes(room.phase)) throw new Error('今はベットできません');
  if (room.players[room.turn] !== p) throw new Error('あなたの番ではありません');
  const need = room.currentBet - p.streetBet;
  if (act === 'fold') {
    p.folded = true;
    p.lastAct = 'フォールド';
    addLog(room, `${p.name}: フォールド`);
    fx(room, 'fold', p.name);
    if (activeOf(room).length === 1) { collectBets(room); return awardToLast(room); }
  } else if (act === 'check') {
    if (need > 0) throw new Error('チェックできません');
    p.acted = true;
    p.lastAct = 'チェック';
    addLog(room, `${p.name}: チェック`);
    fx(room, 'check', p.name);
  } else if (act === 'call') {
    if (need <= 0) throw new Error('コールする額がありません');
    const paid = pay(p, need);
    p.acted = true;
    p.lastAct = p.allIn ? 'ALL IN' : 'コール';
    addLog(room, `${p.name}: コール ${paid}${p.allIn ? '（オールイン）' : ''}`);
    fx(room, p.allIn ? 'allin' : 'call', p.name, p.streetBet);
  } else if (act === 'raise') {
    const to = Math.floor(Number(data.to));
    if (!Number.isFinite(to) || to <= room.currentBet) throw new Error('レイズ額が不正です');
    const payAmt = to - p.streetBet;
    if (payAmt > p.stack) throw new Error('スタックが足りません');
    if (p.acted && !room.lastRaiseFull) throw new Error('ショートオールインの後は再レイズできません');
    const fullRaise = to >= room.currentBet + room.minRaise;
    if (!fullRaise && payAmt < p.stack) throw new Error(`最低 ${room.currentBet + room.minRaise} までレイズが必要です`);
    pay(p, payAmt);
    if (fullRaise) {
      room.minRaise = to - room.currentBet;
      room.lastRaiseFull = true;
      for (const q of canActOf(room)) if (q !== p) q.acted = false;
    } else {
      room.lastRaiseFull = false;
    }
    const wasBet = room.currentBet === 0; // そのストリート最初の賭け＝ベット、以降＝レイズ
    room.currentBet = to;
    p.acted = true;
    p.lastAct = p.allIn ? 'ALL IN' : (wasBet ? 'ベット' : 'レイズ');
    addLog(room, `${p.name}: ${p.allIn ? 'オールイン' : wasBet ? 'ベット' : 'レイズ'} ${to}`);
    fx(room, p.allIn ? 'allin' : (wasBet ? 'bet' : 'raise'), p.name, to);
  } else throw new Error('不明なアクション');

  if (BETTING.includes(room.phase)) {
    if (bettingDone(room)) endBettingRound(room);
    else room.turn = nextIdx(room, room.turn, q => q.inHand && !q.folded && !q.allIn && !(q.acted && q.streetBet === room.currentBet));
  }
}

function dealerAction(room, p, act, data) {
  if (p.id !== room.dealerId) throw new Error('ディーラーのみ操作できます');
  switch (act) {
    case 'startHand':
      if (HAND_ACTIVE.includes(room.phase)) throw new Error('ハンド進行中です');
      startHand(room);
      break;
    case 'nextStreet':
      if (room.mode !== 'chip' || !room.awaitDealer) throw new Error('今は進行できません');
      room.awaitDealer = false;
      advanceStreet(room);
      break;
    case 'assignPot': {
      if (room.phase !== 'showdown' || !room.pots) throw new Error('ショーダウン中のみ');
      const pot = room.pots[data.potIdx];
      if (!pot || pot.winners) throw new Error('このポットは割り当て済みです');
      const ids = (data.winnerIds || []).map(k => findP(room, k)).filter(Boolean).map(q => q.id).filter(id => pot.eligible.includes(id));
      if (!ids.length) throw new Error('勝者を選んでください');
      splitPot(room, pot, ids);
      const names = ids.map(id => room.players.find(q => q.id === id).name).join('・');
      fx(room, 'win', names, pot.amount);
      addLog(room, `${names} がポット ${pot.amount} を獲得`);
      if (room.pots.every(x => x.winners)) {
        room.result = { lines: ['ハンド終了'], reveal: false };
        room.phase = 'result';
      }
      break;
    }
    case 'proxyAct': {
      // 現在の手番プレイヤーの代理でフォールド/チェック/コール
      if (!['fold', 'check', 'call'].includes(data.sub)) throw new Error('代理はフォールド/チェック/コールのみ');
      if (!BETTING.includes(room.phase) || room.turn < 0) throw new Error('今は手番がありません');
      const q = room.players[room.turn];
      const li = room.log.length;
      playerAction(room, q, data.sub, {});
      if (room.log[li]) room.log[li] += '（ディーラー代理）';
      break;
    }
    case 'setBet': {
      // 現在のストリートのベット額を直接修正（誤操作の訂正用）
      if (!BETTING.includes(room.phase)) throw new Error('ベット中のみ修正できます');
      const q = findP(room, data.playerId);
      const to = Math.floor(Number(data.to));
      if (!q || !q.inHand || q.folded) throw new Error('修正できるのは参加中のプレイヤーのみ');
      if (!Number.isFinite(to) || to < 0) throw new Error('ベット額が不正です');
      const diff = to - q.streetBet;
      if (diff > q.stack) throw new Error('スタックが足りません');
      q.stack -= diff;
      q.streetBet = to;
      q.totalBet += diff;
      q.allIn = q.stack === 0;
      room.currentBet = Math.max(...activeOf(room).map(x => x.streetBet));
      addLog(room, `ディーラー修正: ${q.name} のベットを ${to} に変更`);
      break;
    }
    case 'adjustPot': {
      const d = Math.floor(Number(data.delta));
      if (!Number.isFinite(d)) throw new Error('不正な指定です');
      room.pot = Math.max(0, room.pot + d);
      addLog(room, `ディーラー修正: ポット ${d >= 0 ? '+' : ''}${d}（回収済み分 ${room.pot}）`);
      break;
    }
    case 'adjustStack': {
      const q = findP(room, data.playerId);
      const d = Math.floor(Number(data.delta));
      if (!q || !Number.isFinite(d)) throw new Error('不正な指定です');
      q.stack = Math.max(0, q.stack + d);
      addLog(room, `ディーラー修正: ${q.name} ${d >= 0 ? '+' : ''}${d}（現在 ${q.stack}）※収支に含めない訂正`);
      break;
    }
    case 'addBot': {
      if (room.mode !== 'full') throw new Error('BOTはフルモード専用です（チップモードはカードがないため）');
      const count = Math.min(Math.max(1, Math.floor(Number(data.count) || 1)), 10 - room.players.length);
      if (count < 1) throw new Error('満席です（最大10人）');
      for (let i = 0; i < count; i++) {
        const used = new Set(room.players.map(x => x.name));
        const base = BOT_NAMES.find(n => !used.has('🤖' + n)) || `BOT${room.players.length}`;
        const b = makePlayer('🤖' + base, room.startStack, true);
        room.players.push(b);
        addLog(room, `🤖 ${b.name} が着席（バイイン ${room.startStack}）`);
      }
      break;
    }
    case 'addChips': {
      // リバイ/アドオン：バイイン累計に計上する正式な追加
      const q = findP(room, data.playerId);
      const amt = Math.floor(Number(data.amount));
      if (!q || !Number.isFinite(amt) || amt <= 0) throw new Error('追加額が不正です');
      q.stack += amt;
      q.buyIn += amt;
      addLog(room, `💰 ${q.name} にチップ追加 ${amt}（バイイン累計 ${q.buyIn} / 現在 ${q.stack}）`);
      break;
    }
    case 'setBlinds': {
      const sb = Math.floor(Number(data.sb)), bb = Math.floor(Number(data.bb));
      if (!(sb > 0 && bb >= sb)) throw new Error('ブラインドが不正です');
      room.sb = sb; room.bb = bb;
      addLog(room, `ブラインド変更: ${sb}/${bb}`);
      break;
    }
    case 'setButton': {
      const idx = room.players.findIndex(x => x.pub === data.playerId || x.id === data.playerId);
      if (idx < 0) throw new Error('プレイヤーが見つかりません');
      room.buttonPin = idx;
      addLog(room, `次のハンドのボタン: ${room.players[idx].name}`);
      break;
    }
    case 'cancelHand': {
      if (room.phase === 'runout') throw new Error('ランアウト中は中止できません（終了までお待ちください）');
      if (!BETTING.includes(room.phase) && room.phase !== 'showdown' && room.phase !== 'rit') throw new Error('ハンド進行中のみ');
      for (const q of room.players) { q.stack += q.totalBet; q.totalBet = 0; q.streetBet = 0; }
      room.pot = 0; room.pots = null; room.turn = -1; room.awaitDealer = false;
      room.allinReveal = false; room.ritChoices = null; room.ritDeadline = null; room.equity = null;
      room.runToken++;
      room.result = { lines: ['ハンドを中止し、ベットを全員に返却しました'], reveal: false };
      room.phase = 'result';
      addLog(room, 'ハンド中止（ベット返却）');
      break;
    }
    case 'transferDealer': {
      const q = findP(room, data.playerId);
      if (!q) throw new Error('プレイヤーが見つかりません');
      if (q.bot) throw new Error('BOTにディーラー役は渡せません');
      room.dealerId = q.id;
      addLog(room, `ディーラー役を ${q.name} に交代`);
      break;
    }
    case 'toggleSit': {
      const q = findP(room, data.playerId);
      if (!q) throw new Error('プレイヤーが見つかりません');
      if (q.inHand && BETTING.includes(room.phase)) throw new Error('ハンド参加中は変更できません');
      q.sitout = !q.sitout;
      addLog(room, `${q.name} が${q.sitout ? '離席（観戦/専任ディーラー）' : '着席'}`);
      break;
    }
    case 'kick': {
      if (HAND_ACTIVE.includes(room.phase)) throw new Error('ハンド中は退出させられません');
      const idx = room.players.findIndex(x => x.pub === data.playerId || x.id === data.playerId);
      if (idx < 0) throw new Error('プレイヤーが見つかりません');
      if (room.players[idx].id === room.dealerId) throw new Error('自分は退出させられません');
      removePlayer(room, idx, 'ディーラー操作で退出');
      break;
    }
    case 'undo':
      if (!undo(room)) throw new Error('取り消せる操作がありません');
      break;
    default:
      throw new Error('不明な操作');
  }
}

// ---------- ビュー ----------
function view(room, pid) {
  const me = room.players.find(p => p.id === pid);
  const spec = !me && room.spectators.find(s => s.id === pid);
  const resultReveal = room.result?.reveal && (room.phase === 'result');
  // 手札公開条件：結果公開 / オールイン対決 / 観戦者（フルモードは常時）
  const revealAll = resultReveal || (room.allinReveal && ['rit', 'runout', 'result'].includes(room.phase));
  const specView = !!spec && room.mode === 'full';
  const displayPot = room.pot + room.players.reduce((s, p) => s + p.streetBet, 0);
  const v = {
    code: room.code, title: room.title, mode: room.mode, sb: room.sb, bb: room.bb,
    turnRemain: room.turnDeadline ? Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000)) : null,
    turnSeconds: room.turnSeconds,
    phase: room.phase, phaseJa: PHASE_JA[room.phase], handNum: room.handNum,
    pot: displayPot, board: room.board,
    button: room.button, sbIdx: room.sbIdx, bbIdx: room.bbIdx, turn: room.turn,
    awaitDealer: room.awaitDealer,
    undoCount: room.history.length,
    lastAction: room.lastAction,
    spectators: room.spectators.length,
    spectator: spec ? { name: spec.name } : null,
    equity: (spec || room.allinReveal) ? room.equity : null,
    boards: room.runN > 1 && room.boards && ['runout', 'result'].includes(room.phase) ? room.boards : null,
    runIdx: room.runIdx,
    rit: room.phase === 'rit' ? {
      remain: room.ritDeadline ? Math.max(0, Math.ceil((room.ritDeadline - Date.now()) / 1000)) : 0,
      total: room.turnSeconds,
      choices: room.players.filter(p => p.inHand && !p.folded).map(p => ({ id: p.pub, name: p.name, n: room.ritChoices?.[p.id] || null })),
      canChoose: !!(me && me.inHand && !me.folded && !room.ritChoices?.[me.id]),
    } : null,
    result: room.result,
    pots: room.phase === 'showdown' && room.pots ? room.pots.map(pt => ({
      amount: pt.amount,
      eligible: pt.eligible.map(id => room.players.find(q => q.id === id)?.pub).filter(Boolean),
      winners: pt.winners ? pt.winners.map(id => room.players.find(q => q.id === id)?.pub) : null,
    })) : null,
    log: room.log.slice(-25),
    ledger: room.ledger,
    players: room.players.map((p, i) => ({
      id: p.pub, name: p.name, stack: p.stack, streetBet: p.streetBet, buyIn: p.buyIn,
      bot: !!p.bot,
      connected: p.bot || (room.streams.get(p.id) || []).length > 0,
      inHand: p.inHand, folded: p.folded, allIn: p.allIn, sitout: p.sitout, lastAct: p.lastAct,
      isDealerRole: p.id === room.dealerId, you: p.id === pid, idx: i,
      cards: (p.id === pid || ((revealAll || specView) && p.inHand && !p.folded)) ? p.cards : p.cards.map(() => null),
    })),
  };
  if (me) {
    const need = Math.max(0, room.currentBet - me.streetBet);
    v.you = {
      id: me.pub, idx: room.players.indexOf(me), isDealer: me.id === room.dealerId,
      stack: me.stack, cards: me.cards, myBet: me.streetBet, buyIn: me.buyIn,
      myTurn: BETTING.includes(room.phase) && room.players[room.turn] === me,
      toCall: Math.min(need, me.stack),
      canCheck: need === 0,
      canRaise: me.stack + me.streetBet > room.currentBet && (!me.acted || room.lastRaiseFull),
      minTo: Math.min(room.currentBet + room.minRaise, me.streetBet + me.stack),
      maxTo: me.streetBet + me.stack,
    };
  }
  return v;
}

// アクションクロック：手番が変わる（＝seqが進む）たびに20秒をセット
function armClock(room) {
  if (BETTING.includes(room.phase) && room.turn >= 0) {
    const key = `${room.seq}:${room.players[room.turn].id}`;
    if (room.turnKey !== key) {
      room.turnKey = key;
      room.turnDeadline = Date.now() + room.turnSeconds * 1000;
    }
  } else {
    room.turnKey = null;
    room.turnDeadline = null;
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    // BOT: ランイット選択は即決
    if (room.phase === 'rit' && room.ritChoices) {
      let changed = false;
      for (const p of activeOf(room)) {
        if (p.bot && !room.ritChoices[p.id]) {
          room.ritChoices[p.id] = 1 + crypto.randomInt(3);
          addLog(room, `${p.name}: ランイット ${room.ritChoices[p.id]}回 を選択`);
          changed = true;
        }
      }
      if (changed) {
        if (activeOf(room).every(q => room.ritChoices[q.id]) && room.phase === 'rit') beginRunout(room);
        broadcast(room);
        continue;
      }
    }
    // BOT: 手番なら少し考えてからアクション
    if (BETTING.includes(room.phase) && room.turn >= 0 && room.players[room.turn]?.bot) {
      const p = room.players[room.turn];
      const key = `${room.seq}:${p.id}`;
      if (room.botKey !== key) {
        room.botKey = key;
        room.botAt = Date.now() + 900 + crypto.randomInt(1400);
      } else if (Date.now() >= room.botAt) {
        snapshot(room, `${p.name}: BOT`);
        try { botAct(room, p); } catch (e) { room.history.pop(); }
        broadcast(room);
      }
      continue;
    }
    // ランイット選択のタイムアウト → 未選択は1回扱い
    if (room.phase === 'rit' && room.ritDeadline && Date.now() > room.ritDeadline) {
      for (const p of activeOf(room)) {
        if (!room.ritChoices[p.id]) {
          room.ritChoices[p.id] = 1;
          addLog(room, `${p.name}: 時間切れ → 1回`);
        }
      }
      beginRunout(room);
      broadcast(room);
      continue;
    }
    if (!BETTING.includes(room.phase) || room.turn < 0 || !room.turnDeadline) continue;
    if (Date.now() < room.turnDeadline) continue;
    const p = room.players[room.turn];
    try {
      snapshot(room, `${p.name}: 時間切れ`);
      const canCheck = room.currentBet - p.streetBet <= 0;
      const li = room.log.length;
      playerAction(room, p, canCheck ? 'check' : 'fold', {});
      if (room.log[li]) room.log[li] += '（時間切れ）';
    } catch (e) {
      room.history.pop();
      room.turnDeadline = Date.now() + room.turnSeconds * 1000; // 想定外エラー時は再武装して停止を防ぐ
    }
    broadcast(room);
  }
}, 400);

function broadcast(room) {
  armClock(room);
  // エクイティ再計算（状態が変わった時だけ）
  const eqKey = `${room.seq}|${room.phase}|${room.runIdx}|${room.board.map(c => c.r + c.s).join('')}|${room.spectators.length}|${room.players.filter(p => p.folded).length}`;
  if (room._eqKey !== eqKey) { room._eqKey = eqKey; updateEquity(room); }
  for (const [pid, list] of room.streams) {
    const payload = `data: ${JSON.stringify(view(room, pid))}\n\n`;
    for (const res of list) { try { res.write(payload); } catch {} }
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
      const pid = url.searchParams.get('pid');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', // プロキシのバッファリング抑止
      });
      res.write(`: ${' '.repeat(2048)}\n\n`); // 中継のバッファを最初に押し流す
      if (!room || !(room.players.some(p => p.id === pid) || room.spectators.some(s => s.id === pid))) {
        res.write(`event: invalid\ndata: {}\n\n`);
        return res.end();
      }
      if (!room.streams.has(pid)) room.streams.set(pid, []);
      room.streams.get(pid).push(res);
      broadcast(room); // 全員にオンライン状態を反映（初回ビューもこれで届く）
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
      req.on('close', () => {
        clearInterval(hb);
        const list = room.streams.get(pid) || [];
        const i = list.indexOf(res);
        if (i >= 0) list.splice(i, 1);
        if (rooms.has(room.code)) broadcast(room);
      });
      return;
    }

    // SSEが使えない環境（一部プロキシ/トンネル）向けのポーリング用ビュー
    if (req.method === 'GET' && url.pathname === '/api/view') {
      const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
      const pid = url.searchParams.get('pid');
      if (!room || !(room.players.some(p => p.id === pid) || room.spectators.some(s => s.id === pid))) {
        return json(res, 404, { error: 'ルームが見つかりません' });
      }
      return json(res, 200, view(room, pid));
    }

    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      const list = [...rooms.values()].map(r => ({
        code: r.code, title: r.title || '', mode: r.mode,
        players: r.players.length, spectators: r.spectators.length,
        handNum: r.handNum, phase: PHASE_JA[r.phase] || r.phase,
        sb: r.sb, bb: r.bb,
      }));
      return json(res, 200, { rooms: list });
    }

    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 12);
      if (!name) return json(res, 400, { error: '名前を入力してください' });
      const mode = b.mode === 'full' ? 'full' : 'chip';
      const sb = Math.max(1, Math.floor(Number(b.sb) || 50));
      const bb = Math.max(sb, Math.floor(Number(b.bb) || 100));
      const stack = Math.max(bb, Math.floor(Number(b.stack) || 10000));
      const title = String(b.title || '').trim().slice(0, 20) || `${name}の卓`;
      const turnSec = (b.turnSec != null && String(b.turnSec).trim() !== '')
        ? Math.min(300, Math.max(5, Math.floor(Number(b.turnSec)) || 20))
        : TURN_SECONDS; // 未指定は環境変数デフォルト（テスト用の短縮にも使う）
      const { room, p } = createRoom({ name, title, mode, sb, bb, stack, turnSec });
      broadcast(room);
      return json(res, 200, { code: room.code, pid: p.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase().trim());
      if (!room) return json(res, 404, { error: 'ルームが見つかりません' });
      const name = String(b.name || '').trim().slice(0, 12);
      if (!name) return json(res, 400, { error: '名前を入力してください' });
      if (b.spectate) {
        const sp = { id: crypto.randomUUID(), pub: crypto.randomUUID().slice(0, 8), name };
        room.spectators.push(sp);
        addLog(room, `👁 ${name} が観戦参加`);
        broadcast(room);
        return json(res, 200, { code: room.code, pid: sp.id });
      }
      if (room.players.length >= 10) return json(res, 400, { error: '満席です（最大10人）' });
      if (b.stack == null || String(b.stack).trim() === '') return json(res, 400, { error: 'バイイン額を入力してください' });
      const stack = Math.floor(Number(b.stack));
      if (!Number.isFinite(stack) || stack < room.bb) return json(res, 400, { error: `バイインは ${room.bb}（BB）以上で指定してください` });
      const p = makePlayer(name, stack);
      room.players.push(p);
      addLog(room, `${name} が参加（バイイン ${stack}）`);
      broadcast(room);
      return json(res, 200, { code: room.code, pid: p.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/act') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      const p = room?.players.find(x => x.id === b.pid);
      const spec = !p && room ? room.spectators.find(s => s.id === b.pid) : null;
      if (!room || (!p && !spec)) return json(res, 404, { error: 'ルームまたはプレイヤーが見つかりません' });
      if (spec) {
        if (b.type !== 'leaveRoom') return json(res, 400, { error: '観戦者は操作できません' });
        room.spectators.splice(room.spectators.indexOf(spec), 1);
        room.streams.delete(spec.id);
        addLog(room, `👁 ${spec.name} が観戦終了`);
        broadcast(room);
        return json(res, 200, { ok: true });
      }
      const PLAYER_ACTS = ['fold', 'check', 'call', 'raise'];
      const DEALER_ACTS = ['startHand', 'nextStreet', 'assignPot', 'proxyAct', 'setBet', 'adjustPot', 'adjustStack', 'addChips', 'addBot', 'setBlinds', 'setButton', 'cancelHand', 'transferDealer', 'toggleSit', 'kick', 'undo'];
      const ACT_JA = { fold: 'フォールド', check: 'チェック', call: 'コール', raise: 'レイズ', startHand: 'ハンド開始', nextStreet: 'ストリート進行', assignPot: 'ポット授与', proxyAct: '代理アクション', setBet: 'ベット修正', adjustPot: 'ポット修正', adjustStack: 'チップ修正', addChips: 'チップ追加', addBot: 'BOT追加', setBlinds: 'ブラインド変更', setButton: 'ボタン指定', cancelHand: 'ハンド中止', transferDealer: 'ディーラー交代', toggleSit: '離席/着席', kick: '退出', leaveRoom: '退出' };
      let snapped = false;
      try {
        if (PLAYER_ACTS.includes(b.type)) {
          snapshot(room, `${p.name}: ${ACT_JA[b.type]}`); snapped = true;
          playerAction(room, p, b.type, b);
        } else if (b.type === 'ritChoose') {
          ritChoose(room, p, b.n);
        } else if (b.type === 'leaveRoom') {
          snapshot(room, `${p.name}: 退出`); snapped = true;
          leaveRoom(room, p);
        } else if (DEALER_ACTS.includes(b.type)) {
          if (b.type !== 'undo') { snapshot(room, ACT_JA[b.type]); snapped = true; }
          dealerAction(room, p, b.type, b);
        } else return json(res, 400, { error: '不明なアクション' });
      } catch (e) {
        if (snapped) room.history.pop();
        return json(res, 400, { error: e.message });
      }
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    // 静的ファイル
    let fp = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', // HTML/JS/CSSの食い違い（古いキャッシュ）防止
      });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: 'サーバーエラー' });
  }
});

server.listen(PORT, () => console.log(`ポケチップ起動: http://localhost:${PORT}`));
