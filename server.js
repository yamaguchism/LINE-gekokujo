import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi } from '@line/bot-sdk';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// 1. 分割した各専門モジュールのインポート
import { MAP_LOCATIONS, DEFENSE_ENEMIES } from './gameData.js';
import {
  getTotalSlots,
  getBaseName,
  getBossBreakRate,
  getOverloadAwakenRate,
  tryBreakSlotMaterial,
  calculateEffectiveStats,
  simulateBattle,
} from './battleEngine.js';
import { generateRaidNarrative } from './aiService.js';

// ==========================================
// 2. 各種設定（環境変数＆LINE API・Supabase初期化）
// ==========================================
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET || process.env.CHANNEL_SECRET;

const lineConfig = {
  channelSecret,
  channelAccessToken,
};

const { MessagingApiClient } = messagingApi;
const lineClient = new MessagingApiClient({
  channelAccessToken,
});

// Supabase クライアント初期化
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (!supabase) {
  console.warn('⚠️ [警告] SUPABASE_URL または SUPABASE_ANON_KEY が未設定のためローカルファイル保存で動作します。');
} else {
  console.log('✅ Supabase 接続クライアント初期化完了');
}

const app = express();

// public フォルダ内の画像（chapter3_world_map.png 等）を外部公開
app.use('/public', express.static(path.resolve('public')));

// ==========================================
// 3. プレイヤーデータ永続化（Supabase ＆ ローカルバックアップ連動）＆自動マイグレーション
// ==========================================
const DB_FILE = path.resolve('players.json');

function loadLocalPlayers() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    console.error('ローカルデータ読み込みエラー:', err);
    return {};
  }
}

function saveLocalPlayers(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('ローカルデータ保存エラー:', err);
  }
}

function createInitialPlayer(userId) {
  return {
    userId,
    name: 'シンジ班',
    leader: 'シンジ',
    weapon: '無骨なキメラ断頭斧',
    baseHp: 100,
    baseAtk: 24,
    baseDef: 12,
    hp: 100,
    // 5枠素材スロット（全地勢共通・黄金比確定値）
    slots: {
      steel: 2,   // 王国鋼: 攻+7, 防-2
      plate: 2,   // 装甲板: 防+6, 攻-2
      powder: 1,  // 黒火薬: 会心+13%, 回避+7%, 攻-2, 防-1
      stone: 0,   // 魔導石: 攻+3, 防-1, HP-6%, 吸収+20%
    },
    // ★ 復讐の独立第6スロット状態
    awakenedBoss: null, // 現在第6スロットが覚醒している対象ボスKey（nullなら未覚醒）
    sixthSlot: null,    // 独立第6枠に装填中の素材Key ('steel' | 'plate' | 'powder' | 'stone' | null)
    chapter: 1,
    ch1Step: 0, // 0:検問所(ガルシア), 1:前哨砦(バルツ), 2:要塞門(ロシュ), 3:要塞門乗っ取り完了
    ch2Step: 0, // 0:工房跡(従軍錬金術師), 1:大聖堂(聖堂重騎士), 2:聖涙川の教会平原完全制圧
    ch3Step: 0, // 0:回廊関門(アルバート), 1:遠征軍総本陣(ジークフリート), 2:覇権の万魔中央回廊完全制圧
    currentLocation: 'アジト', // 'アジト' または 各エリアキー
    baseWallLevel: 1,    // 防壁Lv (Lv1:破損30%, Lv2:20%, Lv3:10%)
    baseArmoryLevel: 1,  // 武器庫Lv (Lv1:上限5個, Lv2:10個, Lv3:15個)
    baseFurnaceLevel: 0, // 過負荷炉Lv (Lv0:6枠覚醒15%, Lv1:25%, Lv2:35%)
    bossWins: {
      '検問所': 0,
      '前哨砦': 0,
      '要塞門': 0,
      '工房跡': 0,
      '大聖堂': 0,
      '大霊廟': 0,
      'ヴァルハイト城': 0,
      '回廊関門': 0,
      '遠征軍総本陣': 0,
    },
    // ヴァルハイト城（3連撃チキンレースローグ）進行状態
    castleFloor: 0, // 0:未突入, 1:第1層突破済, 2:第2層突破済
    castleLoot: [], // 城内で一時キープ中の戦利品配列 [{ item, count }]
    reservedLocation: null, // 単一ノード名 または '農村>礼拝堂' のような2連ルート
    inventory: {
      '王国鋼': 2,
      '装甲板': 2,
      '黒火薬': 1,
      '魔導石': 0,
      '兵糧': 3,
    },
  };
}

// プレイヤーデータの欠損補完＆マイグレーション（既存ロジック完全維持）
function normalizePlayer(p, userId) {
  p.userId = userId;
  // 黄金比基礎値の固定
  p.baseHp = 100;
  p.baseAtk = 24;
  p.baseDef = 12;
  if (!p.leader) p.leader = 'シンジ';
  if (!p.name) p.name = 'シンジ班';
  if (!p.weapon) p.weapon = '無骨なキメラ断頭斧';
  if (p.ch1Step === undefined) p.ch1Step = 0;
  if (p.ch2Step === undefined) p.ch2Step = 0;
  if (p.ch3Step === undefined) p.ch3Step = 0;
  if (p.chapter === undefined) {
    p.chapter = p.ch2Step >= 2 ? 3 : (p.ch1Step >= 3 ? 2 : 1);
  }
  if (p.ch2Step >= 2 && p.chapter < 3) p.chapter = 3;
  if (!p.currentLocation) p.currentLocation = 'アジト';
  if (!p.baseWallLevel) p.baseWallLevel = 1;
  if (!p.baseArmoryLevel) p.baseArmoryLevel = 1;
  if (p.baseFurnaceLevel === undefined) p.baseFurnaceLevel = 0;
  if (p.awakenedBoss === undefined) p.awakenedBoss = null;
  if (p.sixthSlot === undefined) p.sixthSlot = null;
  if (!p.bossWins) p.bossWins = {};
  if (p.castleFloor === undefined) p.castleFloor = 0;
  if (!Array.isArray(p.castleLoot)) p.castleLoot = [];

  // 旧名称『白銀城塞』からの自動マイグレーション保護
  if (p.currentLocation === '白銀城塞') p.currentLocation = 'ヴァルハイト城';
  if (p.reservedLocation === '白銀城塞') p.reservedLocation = 'ヴァルハイト城';
  if (p.bossWins['白銀城塞'] && !p.bossWins['ヴァルハイト城']) {
    p.bossWins['ヴァルハイト城'] = p.bossWins['白銀城塞'];
  }

  delete p.rankPoints;

  if (!p.slots) p.slots = { steel: 2, plate: 2, powder: 1, stone: 0 };
  if (p.slots.stone === undefined) p.slots.stone = 0;

  if (!p.inventory) p.inventory = {};
  if (p.inventory['王国鋼'] === undefined) p.inventory['王国鋼'] = 2;
  if (p.inventory['装甲板'] === undefined) p.inventory['装甲板'] = 2;
  if (p.inventory['黒火薬'] === undefined) p.inventory['黒火薬'] = 1;
  if (p.inventory['魔導石'] === undefined) p.inventory['魔導石'] = 0;
  if (p.inventory['兵糧'] === undefined) p.inventory['兵糧'] = 3;

  if (p.hp === undefined || p.hp <= 0) p.hp = p.baseHp;

  return p;
}

// Supabaseの行データからプレイヤーオブジェクトを復元するヘルパー
function rowToPlayer(row) {
  const uid = row.line_user_id;
  const raw = row.inventory;
  let p;
  // inventory(JSONB)にプレイヤー全体のオブジェクトが保存されている場合はそれを展開
  if (raw && typeof raw === 'object' && ('slots' in raw || 'ch1Step' in raw || 'userId' in raw)) {
    p = { ...raw };
  } else {
    p = createInitialPlayer(uid);
    if (raw && typeof raw === 'object') {
      p.inventory = { ...p.inventory, ...raw };
    }
  }
  if (typeof row.hp === 'number') p.hp = row.hp;
  if (row.current_stage) p.currentLocation = row.current_stage;
  return normalizePlayer(p, uid);
}

// 全プレイヤーデータの読み込み（Supabase優先 ＋ ローカルフォールバック）
async function loadAllPlayers() {
  const localData = loadLocalPlayers();
  if (!supabase) return localData;

  try {
    const { data, error } = await supabase.from('players').select('*');
    if (error) {
      console.error('Supabase 全件読み込みエラー:', error.message);
      return localData;
    }
    const merged = { ...localData };
    for (const row of data || []) {
      if (!row.line_user_id) continue;
      merged[row.line_user_id] = rowToPlayer(row);
    }
    saveLocalPlayers(merged);
    return merged;
  } catch (err) {
    console.error('Supabase 通信例外(loadAllPlayers):', err);
    return localData;
  }
}

// 全プレイヤーデータの保存（Supabase Upsert ＋ ローカル保存）
async function saveAllPlayers(allPlayers) {
  saveLocalPlayers(allPlayers);
  if (!supabase) return;

  try {
    const rows = Object.entries(allPlayers).map(([uid, p]) => ({
      line_user_id: uid,
      hp: p.hp ?? 100,
      max_hp: p.baseHp ?? 100,
      current_stage: p.currentLocation || 'アジト',
      inventory: p, // JSONBカラムに全ステータス・スロット・進行度・所持品を丸ごと格納
      updated_at: new Date().toISOString(),
    }));

    if (rows.length === 0) return;

    const { error } = await supabase
      .from('players')
      .upsert(rows, { onConflict: 'line_user_id' });

    if (error) {
      console.error('Supabase 保存(Upsert)エラー:', error.message);
    }
  } catch (err) {
    console.error('Supabase 通信例外(saveAllPlayers):', err);
  }
}

// 単一プレイヤーの取得または新規作成（Supabase直結）
async function getOrCreatePlayer(userId) {
  const players = await loadAllPlayers();
  if (!players[userId]) {
    players[userId] = createInitialPlayer(userId);
  }
  const p = normalizePlayer(players[userId], userId);
  players[userId] = p;
  await saveAllPlayers(players);
  return { player: p, allPlayers: players };
}

// 第6枠の素材キーと表示名の変換ヘルパー
function getSlotItemInfo(slotKey) {
  const map = {
    steel: { item: '王国鋼', label: '⛏️王国鋼(攻+7/防-2)' },
    plate: { item: '装甲板', label: '🛡️装甲板(防+6/攻-2)' },
    powder: { item: '黒火薬', label: '🧨黒火薬(会心+13%/回避+7%)' },
    stone: { item: '魔導石', label: '🔮魔導石(攻+3/吸血+20%/HP-6%)' },
  };
  return map[slotKey] || null;
}

// 場所移動時などに覚醒中の第6スロットを消滅させるヘルパー
function clearAwakenedSixthSlot(player, returnUnusedMaterial = true) {
  if (!player.awakenedBoss && !player.sixthSlot) return false;
  if (returnUnusedMaterial && player.sixthSlot) {
    const info = getSlotItemInfo(player.sixthSlot);
    if (info) {
      player.inventory[info.item] = (player.inventory[info.item] || 0) + 1;
    }
  }
  player.awakenedBoss = null;
  player.sixthSlot = null;
  return true;
}

function getCurrentLocationName(player) {
  if (!player.currentLocation || player.currentLocation === 'アジト') {
    return `⛺ ${getBaseName(player)}`;
  }
  if (player.currentLocation === 'ヴァルハイト城' && player.castleFloor > 0) {
    const floorNames = { 1: '第1層：跳ね橋門制圧済', 2: '第2層：内城詰め所制圧済' };
    return `🏯 ヴァルハイト城（${floorNames[player.castleFloor] || '強襲中'}）`;
  }
  const loc = MAP_LOCATIONS[player.currentLocation];
  return loc ? `🔥 ${loc.name}（前線駐留中）` : `⛺ ${getBaseName(player)}`;
}

// 敗走時の「1歩後退（直前ノード）」を返す関数
function getRetreatLocation(locKey) {
  const retreatMap = {
    // 黒鉄の峡谷地帯
    '検問所': '渓谷',
    '前哨砦': '街道',
    '要塞門': '前哨砦',
    '渓谷': 'アジト',
    '街道': 'アジト',
    // 聖涙川の教会平原
    '工房跡': '礼拝堂',
    '大聖堂': '工房跡',
    '大霊廟': '礼拝堂',
    'ヴァルハイト城': '跳ね橋',
    '跳ね橋': '兵站所',
    '礼拝堂': '農村',
    '農村': 'アジト',
    '兵站所': 'アジト',
    // 覇権の万魔中央回廊
    '遠征軍総本陣': '回廊関門',
    '回廊関門': '前線宿営地',
    '前線宿営地': '中立交易区',
    '中立交易区': 'アジト',
    '補給工廠': 'アジト',
  };
  return retreatMap[locKey] || 'アジト';
}

function getReservedDisplayName(reservedLocation) {
  if (!reservedLocation) return '未予約';
  if (reservedLocation === '城郭：突撃') return '🏯 ヴァルハイト城（次階層へ突撃）';
  if (reservedLocation.includes('>')) {
    const [step1, step2] = reservedLocation.split('>');
    const n1 = MAP_LOCATIONS[step1] ? MAP_LOCATIONS[step1].name : step1;
    const n2 = MAP_LOCATIONS[step2] ? MAP_LOCATIONS[step2].name : step2;
    return `🌙 夜間2連遠征：${n1} ➔ ${n2}`;
  }
  return MAP_LOCATIONS[reservedLocation] ? MAP_LOCATIONS[reservedLocation].name : reservedLocation;
}

function getMaterialCap(player) {
  const lv = player.baseArmoryLevel || 1;
  return lv * 5;
}

function getRationCap(player) {
  const lv = player.baseArmoryLevel || 1;
  return lv * 10;
}

function addLootWithCap(player, itemName, count) {
  const cap = itemName === '兵糧' ? getRationCap(player) : getMaterialCap(player);
  const current = player.inventory[itemName] || 0;
  if (current >= cap) {
    return { added: 0, capped: true, cap };
  }
  const nextVal = Math.min(cap, current + count);
  const added = nextVal - current;
  player.inventory[itemName] = nextVal;
  return { added, capped: nextVal >= cap && added < count, cap };
}

function formatLootList(lootArray) {
  if (!lootArray || lootArray.length === 0) return 'なし';
  const iconMap = { '王国鋼': '⛏️', '装甲板': '🛡️', '黒火薬': '🧨', '魔導石': '🔮', '兵糧': '🍞' };
  const summary = {};
  for (const entry of lootArray) {
    summary[entry.item] = (summary[entry.item] || 0) + entry.count;
  }
  return Object.entries(summary)
    .map(([item, count]) => `${iconMap[item] || '🎁'}${item}×${count}`)
    .join(' / ');
}

function makeQuickReply(items) {
  if (!items || items.length === 0) return undefined;
  return {
    items: items.slice(0, 13).map((item) => ({
      type: 'action',
      action: {
        type: 'message',
        label: item.label.slice(0, 20),
        text: item.text,
      },
    })),
  };
}

/**
 * プレイヤーの進行状況に応じた地図画像の公開URLを解決する
 */
function resolveMapImageUrl(player, req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const baseUrl = process.env.BASE_URL || (host ? `https://${host}` : '');
  if (!baseUrl || !baseUrl.startsWith('https://')) return null;

  const isCh3 = player.chapter >= 3 || player.ch2Step >= 2;
  const isCh2 = !isCh3 && (player.chapter >= 2 || player.ch1Step >= 3);

  // ★軽量JPEG（.jpg）を最優先で探索し、なければPNGを探す
  const candidates = [];
  if (isCh3) {
    candidates.push('chapter3_world_map.jpg', 'chapter3_map.jpg', 'chapter3_world_map.png', 'chapter3_map.png');
  } else if (isCh2) {
    candidates.push('chapter2_world_map.jpg', 'chapter2_map.jpg', 'chapter2_world_map.png', 'chapter2_map.png');
  } else {
    candidates.push('chapter1_world_map.jpg', 'chapter1_map.jpg', 'chapter1_world_map.png', 'chapter1_map.png');
  }

  for (const fileName of candidates) {
    const filePath = path.resolve('public', fileName);
    if (fs.existsSync(filePath)) {
      return `${baseUrl}/public/${fileName}`;
    }
  }
  return null;
}

// ==========================================
// 4. 動的作戦地図＆進路ナビゲーション生成エンジン（地勢型パッケージC適用・AA全廃版）
// ==========================================
function generateDynamicMapGuide(player) {
  const cur = player.currentLocation || 'アジト';
  const isCh3 = player.chapter >= 3 || player.ch2Step >= 2;
  const isCh2 = !isCh3 && (player.chapter >= 2 || player.ch1Step >= 3);

  // ----------------------------------------------------
  // 【黒鉄の峡谷地帯】（旧：第1章）
  // ----------------------------------------------------
  if (!isCh2 && !isCh3) {
    const stepNames = ['①国境検問所（新兵ガルシア）', '②前哨砦（魔導重装兵バルツ）', '③人間軍の要塞門（守備隊長ロシュ）'];
    const curTarget = stepNames[player.ch1Step] || '要塞門突破完了！';

    return `🗺️【黒鉄の峡谷地帯：進軍地勢案内】
📍 現在地：${getCurrentLocationName(player)}
🎯 作戦目標：『${curTarget}』

━━━━━━━━━━━━━━━━━━━━━
🧭【現在地から進軍可能なルート】
・⛏️ 黒鉄渓谷 ➔ 『⛏️王国鋼』『🛡️装甲板』を強奪
・🍞 補給街道 ➔ 『🧨黒火薬』『🍞兵糧×2袋』を強奪
・⚔️ 前線関門 ➔ 守備隊を粉砕して要塞門を奪い取れ！
・⛺ アジト帰還 ➔ 兵糧消費ゼロで部隊HP100%全快！`;
  }

  // ----------------------------------------------------
  // 【覇権の万魔中央回廊】（旧：第3章）
  // ----------------------------------------------------
  if (isCh3 && !['農村', '兵站所', '礼拝堂', '工房跡', '大聖堂', '跳ね橋', 'ヴァルハイト城', '大霊廟'].includes(cur)) {
    let advice3 = '';
    if (cur === 'アジト') {
      advice3 = `① 🍷 中立交易区へ進軍
   └ 兵糧×2と魔導石を徴発し、前線宿営地へ迫る北ルート
② ⚒️ 補給工廠へ進軍
   └ 装甲板と王国鋼を強奪し、前線宿営地へ迫る南ルート
③ 🌉 旧領・跳ね橋へ遠征
   └ 聖涙川の教会平原『ヴァルハイト城（3連強襲）』へ`;
    } else if (cur === '中立交易区') {
      advice3 = `① 💣 前線宿営地へ進軍
   └ 黒火薬と王国鋼を奪い、中ボス『回廊関門』へ迫る！
② ⚒️ 補給工廠へ移動
   └ 装甲板と王国鋼を補充する南北連絡路
③ ⛺ 本陣へ帰還
   └ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
    } else if (cur === '補給工廠') {
      advice3 = `① 💣 前線宿営地へ進軍
   └ 黒火薬と王国鋼を奪い、中ボス『回廊関門』へ迫る！
② 🍷 中立交易区へ移動
   └ 兵糧×2と魔導石を補充する南北連絡路
③ ⛺ 本陣へ帰還
   └ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
    } else if (cur === '前線宿営地') {
      advice3 = `① ⚔️ 回廊関門へ進軍
   └ 回廊中ボス『近衛重装騎士長アルバート』を討伐せよ！
② 🍷 交易区 / ⚒️ 補給工廠へ移動
   └ 物資と兵糧の調達・ビルド調整
③ ⛺ 本陣へ帰還
   └ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
    } else if (cur === '回廊関門') {
      advice3 = `① 🏰 遠征軍総本陣へ進軍
   └ 回廊大ボス『聖騎士元帥ジークフリート』を粉砕せよ！
② 💣 前線宿営地へ後退
   └ 黒火薬と王国鋼を集めて超火力ビルドを構築
③ ⛺ 本陣へ帰還
   └ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
    } else {
      advice3 = `・周囲の拠点で資材を集め、キメラ武器の5枠を最適化して英傑たちに挑め！`;
    }

    let obj3 = '';
    if (player.ch3Step === 0) {
      obj3 = '回廊中ボス『⚔️ 近衛重装騎士長アルバート（回廊関門）』を撃破せよ！（※HP半減で攻撃力56に狂乱覚醒！）';
    } else if (player.ch3Step === 1) {
      obj3 = '回廊大ボス『🏰 聖騎士元帥ジークフリート（遠征軍総本陣）』を6ターン以内に削り切れ！（※鋼と火薬の超火力必須！）';
    } else {
      obj3 = '👑 覇権の万魔中央回廊 完全制圧完了！！（遠征軍総本陣を占領支配中！）';
    }

    return `🗺️【覇権の万魔中央回廊：進軍地勢案内】
📍 現在地：${getCurrentLocationName(player)}
🎯 作戦目標：${obj3}

━━━━━━━━━━━━━━━━━━━━━
🧭【現在地（${cur}）からの進路案内】
${advice3}`;
  }

  // ----------------------------------------------------
  // 【聖涙川の教会平原】（旧：第2章）
  // ----------------------------------------------------
  let localAdvice = '';
  if (cur === 'アジト') {
    localAdvice = `① 🌾 農村へ進軍 ➔ 兵糧×2と鋼を奪取し、北東の礼拝堂・本編ボス方面へ向かうルート
② ⚒️ 兵站所へ進軍 ➔ 装甲板と鋼を奪取し、南東の跳ね橋・ヴァルハイト城へ向かうルート`;
  } else if (cur === '農村') {
    localAdvice = `① ⛪ 礼拝堂へ進軍 ➔ 魔導石と火薬を奪取！奥の中ボス『工房跡』への本編侵攻路
② ⚒️ 兵站所へ移動 ➔ 装甲板を補充し、城攻め（跳ね橋）へ向かう連絡路
③ ⛺ 本陣へ帰還 ➔ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
  } else if (cur === '兵站所') {
    localAdvice = `① 🌉 跳ね橋へ進軍 ➔ 攻城前哨戦！鉄鎖を両断してヴァルハイト城への道を開く
② 🌾 農村へ移動 ➔ 兵糧を補充し、本編攻略（礼拝堂方面）へ合流する連絡路
③ ⛺ 本陣へ帰還 ➔ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
  } else if (cur === '礼拝堂') {
    localAdvice = `① 🧪 工房跡へ進軍 ➔ 平原中ボス『従軍錬金術師（猛毒ガス）』を討伐！
② 💀 禁忌大霊廟へ突入 ➔ 【単発腕試し】超重装甲の神聖巨像を倒せば全素材一括強奪！
③ 🌾 農村へ移動 ➔ 兵糧補充のために後退
④ ⛺ 本陣へ帰還 ➔ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
  } else if (cur === '工房跡') {
    localAdvice = `① 🏰 大聖堂へ進軍 ➔ 平原大ボス『聖堂重騎士（反射盾）』を叩き割り教会平原を制圧！
② ⛪ 礼拝堂へ後退 ➔ 魔導石を補充してスロットを再調整
③ ⛺ 本陣へ帰還 ➔ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
  } else if (cur === '跳ね橋') {
    localAdvice = `① 🏯 ヴァルハイト城へ突入 ➔ 【3連撃チキンレース】外郭・内城・天守の宝物庫を強奪！
② ⚒️ 兵站所へ後退 ➔ 態勢を立て直して物資補充
③ ⛺ 本陣へ帰還 ➔ 兵糧消費ゼロで部隊HP100%全快＆本陣強化`;
  } else if (cur === 'ヴァルハイト城') {
    localAdvice = `⚠️【城郭強襲潜入中】城内での兵糧回復は不可！
・『城郭：突撃』で残HPのまま次階層へ挑むか、『城郭：脱出』で戦利品を抱えて跳ね橋へ脱出せよ！`;
  } else {
    localAdvice = `・周囲のエリアへ進軍して素材を略奪するか、『⛺ アジトへ帰還』で体勢を立て直せ！`;
  }

  let objective = '';
  if (player.ch2Step === 0) {
    objective = '平原中ボス『🧪 従軍錬金術師（工房跡）』を倒し、大聖堂への道を開け！';
  } else if (player.ch2Step === 1) {
    objective = '平原大ボス『🏰 聖堂重騎士（大聖堂）』を撃破し、聖涙川の教会平原を完全制圧せよ！';
  } else {
    objective = '聖涙川の教会平原 制圧完了！『🏯 ヴァルハイト城』天守閣制覇や『💀 大霊廟』を極めろ！';
  }

  return `🗺️【聖涙川の教会平原：進軍地勢案内】
📍 現在地：${getCurrentLocationName(player)}
🎯 作戦目標：${objective}

━━━━━━━━━━━━━━━━━━━━━
🧭【現在地（${cur}）からの進路案内】
${localAdvice}`;
}

// ==========================================
// 5. 地続きノードマップ＆スマート行動選択ボタン生成（★行先選択のみに純化）
// ==========================================
function getSmartButtons(player) {
  // ★すでに行動選択（予約）済みの場合はピコんボタンを出さない（変更時はリッチメニュー「行動変更」から）
  if (player.reservedLocation) {
    return [];
  }

  // ヴァルハイト城潜入中は「次階層へ突撃」か「城外へ脱出」の行先のみ
  if (player.currentLocation === 'ヴァルハイト城' && player.castleFloor > 0) {
    const nextFloorLabel = player.castleFloor === 1
      ? '🏰 内城・第2層へ突撃(HP引継)'
      : '👑 天守閣・最深部へ突撃(ボス)';
    return [
      { label: nextFloorLabel, text: '城郭：突撃' },
      { label: '⛺ 戦利品を持って城外へ脱出', text: '城郭：脱出' },
    ];
  }

  const buttons = [];
  const isCh3 = player.chapter >= 3 || player.ch2Step >= 2;
  const isCh2 = !isCh3 && (player.chapter >= 2 || player.ch1Step >= 3);
  const cur = player.currentLocation || 'アジト';

  // 地勢ごとの完全独立ルーティング（回復・鍛造・地図等のリッチメニュー重複ボタンは全廃し、行先のみ表示）
  if (isCh3) {
    // ==========================================
    // 【覇権の万魔中央回廊】
    // ==========================================
    if (cur === 'アジト') {
      buttons.push({ label: '🍷 交易区へ進軍(兵糧×2・石)', text: '出撃：中立交易区' });
      buttons.push({ label: '⚒️ 補給工廠へ進軍(板・鋼)', text: '出撃：補給工廠' });
      buttons.push({ label: '🌙 遠征：交易区➔宿営地(2連)', text: '遠征：中立交易区>前線宿営地' });
      buttons.push({ label: '🌙 遠征：工廠➔宿営地(2連)', text: '遠征：補給工廠>前線宿営地' });
      buttons.push({ label: '🌉 旧領：跳ね橋(ヴァルハイト城)', text: '出撃：跳ね橋' });

    } else if (cur === '中立交易区') {
      buttons.push({ label: '💣 前線宿営地へ進軍(火薬・鋼)', text: '出撃：前線宿営地' });
      buttons.push({ label: '⚒️ 補給工廠へ移動(板・鋼)', text: '出撃：補給工廠' });
      buttons.push({ label: '🍷 交易区を継続略奪', text: '出撃：中立交易区' });
      buttons.push({ label: '🌙 遠征：工廠➔宿営地(2連)', text: '遠征：補給工廠>前線宿営地' });

    } else if (cur === '補給工廠') {
      buttons.push({ label: '💣 前線宿営地へ進軍(火薬・鋼)', text: '出撃：前線宿営地' });
      buttons.push({ label: '🍷 交易区へ移動(兵糧×2・石)', text: '出撃：中立交易区' });
      buttons.push({ label: '⚒️ 補給工廠を継続略奪', text: '出撃：補給工廠' });
      buttons.push({ label: '🌙 遠征：交易区➔宿営地(2連)', text: '遠征：中立交易区>前線宿営地' });

    } else if (cur === '前線宿営地') {
      buttons.push({ label: '⚔️ 回廊関門へ進軍(中ボス)', text: '出撃：回廊関門' });
      buttons.push({ label: '💣 前線宿営地を継続略奪', text: '出撃：前線宿営地' });
      buttons.push({ label: '🍷 交易区へ後退(兵糧×2・石)', text: '出撃：中立交易区' });
      buttons.push({ label: '⚒️ 補給工廠へ後退(板・鋼)', text: '出撃：補給工廠' });

    } else if (cur === '回廊関門') {
      if (player.ch3Step >= 1) {
        buttons.push({ label: '🏰 遠征軍総本陣へ(回廊大ボス)', text: '出撃：遠征軍総本陣' });
      }
      buttons.push({ label: '⚔️ 回廊関門を討伐(アルバート)', text: '出撃：回廊関門' });
      buttons.push({ label: '💣 前線宿営地へ後退(火薬・鋼)', text: '出撃：前線宿営地' });

    } else if (cur === '遠征軍総本陣') {
      buttons.push({ label: '🏰 遠征軍総本陣を討伐(元帥)', text: '出撃：遠征軍総本陣' });
      buttons.push({ label: '⚔️ 回廊関門へ後退', text: '出撃：回廊関門' });

    } else if (cur === '跳ね橋') {
      buttons.push({ label: '🏯 城門突破！ヴァルハイト城へ', text: '出撃：ヴァルハイト城' });

    } else {
      buttons.push({ label: '🍷 交易区へ進軍', text: '出撃：中立交易区' });
      buttons.push({ label: '⚒️ 補給工廠へ進軍', text: '出撃：補給工廠' });
    }

  } else if (isCh2) {
    // ==========================================
    // 【聖涙川の教会平原】
    // ==========================================
    if (cur === 'アジト') {
      buttons.push({ label: '🌾 農村へ進軍(兵糧×2・鋼)', text: '出撃：農村' });
      buttons.push({ label: '⚒️ 兵站所へ進軍(板・鋼)', text: '出撃：兵站所' });
      buttons.push({ label: '🌙 遠征：農村➔礼拝堂(2連)', text: '遠征：農村>礼拝堂' });
      buttons.push({ label: '🌙 遠征：兵站所➔跳ね橋(2連)', text: '遠征：兵站所>跳ね橋' });

    } else if (cur === '農村') {
      buttons.push({ label: '⛪ 礼拝堂へ進軍(魔導石・火)', text: '出撃：礼拝堂' });
      buttons.push({ label: '⚒️ 兵站所へ移動(板・鋼)', text: '出撃：兵站所' });
      buttons.push({ label: '🌾 農村を継続略奪', text: '出撃：農村' });
      buttons.push({ label: '🌙 遠征：兵站所➔跳ね橋(2連)', text: '遠征：兵站所>跳ね橋' });

    } else if (cur === '兵站所') {
      buttons.push({ label: '🌉 跳ね橋へ進軍(攻城前哨戦)', text: '出撃：跳ね橋' });
      buttons.push({ label: '🌾 農村へ移動(兵糧×2・鋼)', text: '出撃：農村' });
      buttons.push({ label: '⚒️ 兵站所を継続略奪', text: '出撃：兵站所' });
      buttons.push({ label: '🌙 遠征：農村➔礼拝堂(2連)', text: '遠征：農村>礼拝堂' });

    } else if (cur === '跳ね橋') {
      buttons.push({ label: '🏯 城門突破！ヴァルハイト城へ', text: '出撃：ヴァルハイト城' });
      buttons.push({ label: '⚒️ 兵站所へ一時後退', text: '出撃：兵站所' });

    } else if (cur === '礼拝堂') {
      buttons.push({ label: '🧪 工房跡へ進軍(中ボス)', text: '出撃：工房跡' });
      buttons.push({ label: '💀 禁忌大霊廟へ突入(腕試し)', text: '出撃：大霊廟' });
      buttons.push({ label: '⛪ 礼拝堂を継続略奪', text: '出撃：礼拝堂' });
      buttons.push({ label: '🌾 農村へ移動(兵糧×2・鋼)', text: '出撃：農村' });
      buttons.push({ label: '🌙 遠征：農村➔兵站所(2連)', text: '遠征：農村>兵站所' });

    } else if (cur === '工房跡') {
      if (player.ch2Step >= 1) {
        buttons.push({ label: '🏰 大聖堂へ進軍(平原大ボス)', text: '出撃：大聖堂' });
      }
      buttons.push({ label: '🧪 工房跡を討伐(錬金術師)', text: '出撃：工房跡' });
      buttons.push({ label: '⛪ 礼拝堂へ後退(魔導石・火)', text: '出撃：礼拝堂' });

    } else if (cur === '大聖堂') {
      buttons.push({ label: '🏰 大聖堂を討伐(聖堂重騎士)', text: '出撃：大聖堂' });
      buttons.push({ label: '🧪 工房跡へ移動', text: '出撃：工房跡' });

    } else if (cur === '大霊廟') {
      buttons.push({ label: '💀 大霊廟に再挑戦(神聖巨像)', text: '出撃：大霊廟' });
      buttons.push({ label: '⛪ 礼拝堂へ地上脱出', text: '出撃：礼拝堂' });

    } else {
      buttons.push({ label: '🌾 農村へ進軍', text: '出撃：農村' });
      buttons.push({ label: '⚒️ 兵站所へ進軍', text: '出撃：兵站所' });
    }

  } else {
    // ==========================================
    // 【黒鉄の峡谷地帯】
    // ==========================================
    buttons.push({ label: '⛏️ 渓谷（鋼・板略奪）', text: '出撃：渓谷' });
    buttons.push({ label: '🍞 街道（火薬・兵糧×2）', text: '出撃：街道' });

    if (player.ch1Step === 0) {
      buttons.push({ label: '⚔️ 検問所（ガルシア）', text: '出撃：検問所' });
    } else if (player.ch1Step === 1) {
      buttons.push({ label: '🛡️ 前哨砦（バルツ）', text: '出撃：前哨砦' });
    } else {
      buttons.push({ label: '🏰 要塞門（ロシュ）', text: '出撃：要塞門' });
    }

    if (cur === 'アジト' || cur === '街道') {
      buttons.push({ label: '🌙 遠征：渓谷➔街道(2連)', text: '遠征：渓谷>街道' });
    } else if (cur === '渓谷') {
      buttons.push({ label: '🌙 遠征：街道➔渓谷(2連)', text: '遠征：街道>渓谷' });
    }
  }

  // 前線にいる時は「アジトへ帰還」を行先として追加、アジト滞在中は「アジト強化」を表示
  if (cur !== 'アジト') {
    buttons.push({ label: '⛺ アジトへ帰還(略奪&全快)', text: '出撃：帰還' });
  } else {
    buttons.push({ label: '🏰 アジト強化', text: 'アジト強化' });
  }

  return buttons;
}

// 鍛冶場用のスロット操作ボタン（基本5枠 ＋ 覚醒中は独立第6枠の自由付け替え・解除）
function getForgeButtons(player) {
  const s = player.slots;
  const total = getTotalSlots(s);
  const buttons = [];

  if (total < 5) {
    if ((player.inventory['王国鋼'] || 0) > 0) {
      buttons.push({ label: `⛏️ 鋼を込める(残${player.inventory['王国鋼']})`, text: 'スロット：鋼' });
    }
    if ((player.inventory['装甲板'] || 0) > 0) {
      buttons.push({ label: `🛡️ 板を込める(残${player.inventory['装甲板']})`, text: 'スロット：板' });
    }
    if ((player.inventory['黒火薬'] || 0) > 0) {
      buttons.push({ label: `🧨 火薬を込める(残${player.inventory['黒火薬']})`, text: 'スロット：火' });
    }
    if ((player.inventory['魔導石'] || 0) > 0) {
      buttons.push({ label: `🔮 魔導石を込める(残${player.inventory['魔導石']})`, text: 'スロット：石' });
    }
  }
  if (total > 0) {
    buttons.push({ label: '🔄 5枠すべて外す(初期化)', text: 'スロット：リセット' });
  }

  // ★ 第6スロット覚醒中：独立した6枠目の装着・付け替え・解除ボタン
  if (player.awakenedBoss) {
    if ((player.inventory['王国鋼'] || 0) > 0 && player.sixthSlot !== 'steel') {
      buttons.push({ label: `🔥 6枠目：鋼(残${player.inventory['王国鋼']})`, text: '6枠：鋼' });
    }
    if ((player.inventory['装甲板'] || 0) > 0 && player.sixthSlot !== 'plate') {
      buttons.push({ label: `🔥 6枠目：板(残${player.inventory['装甲板']})`, text: '6枠：板' });
    }
    if ((player.inventory['黒火薬'] || 0) > 0 && player.sixthSlot !== 'powder') {
      buttons.push({ label: `🔥 6枠目：火(残${player.inventory['黒火薬']})`, text: '6枠：火' });
    }
    if ((player.inventory['魔導石'] || 0) > 0 && player.sixthSlot !== 'stone') {
      buttons.push({ label: `🔥 6枠目：石(残${player.inventory['魔導石']})`, text: '6枠：石' });
    }
    if (player.sixthSlot) {
      buttons.push({ label: '❌ 6枠目を外す(5枠扱いに戻す)', text: '6枠：外す' });
    }
  }

  return buttons;
}

// アジト強化ボタン（防壁・武器庫・過負荷炉）
function getBaseUpgradeButtons(player) {
  const buttons = [];
  const wallLv = player.baseWallLevel || 1;
  const armoryLv = player.baseArmoryLevel || 1;
  const furnaceLv = player.baseFurnaceLevel || 0;

  if (wallLv < 3) {
    const cost = wallLv === 1 ? 3 : 5;
    buttons.push({
      label: `🛡️ 防壁Lv${wallLv + 1}へ(板${cost}個)`,
      text: '拠点改修：防壁',
    });
  }
  if (armoryLv < 3) {
    const cost = armoryLv === 1 ? 3 : 5;
    buttons.push({
      label: `⛏️ 武器庫Lv${armoryLv + 1}へ(鋼${cost}個)`,
      text: '拠点改修：武器庫',
    });
  }
  if (furnaceLv < 2) {
    const cost = furnaceLv === 0 ? 3 : 5;
    buttons.push({
      label: `🔥 過負荷炉Lv${furnaceLv + 1}へ(火${cost}個)`,
      text: '拠点改修：過負荷炉',
    });
  }

  return buttons;
}

// ==========================================
// 6. 特殊作戦①：ヴァルハイト城（3連撃チキンレースローグ）処理
// ==========================================
async function executeCastleRogueStep(userId, player) {
  // 別エリア移動扱いとして覚醒中の第6スロットがあれば消滅
  clearAwakenedSixthSlot(player, true);

  const castleData = MAP_LOCATIONS['ヴァルハイト城'];
  const nextFloorNum = (player.castleFloor || 0) + 1;
  const floorInfo = castleData.castleFloors[nextFloorNum] || castleData.castleFloors[1];
  const enemyPool = floorInfo.enemies || [floorInfo.enemy];
  const enemy = enemyPool[Math.floor(Math.random() * enemyPool.length)];

  const battleData = simulateBattle(player, enemy, 'ヴァルハイト城');
  player.reservedLocation = null;

  const quoteHeader = enemy.quote ? `🗣️ ${enemy.name}：\n${enemy.quote}\n\n` : '';
  const defeatFooter = (battleData.result === 'WIN' && enemy.defeatQuote)
    ? `\n💬 撃破時の断末魔：\n${enemy.defeatQuote}\n`
    : '';

  let story = '';
  let messageText = '';

  if (battleData.result === 'WIN') {
    player.hp = battleData.finalPlayerHp;
    player.currentLocation = 'ヴァルハイト城';

    const combinedFloorLoot = [...(floorInfo.loot || []), ...(enemy.bonusLoot || [])];
    for (const itemObj of combinedFloorLoot) {
      player.castleLoot.push({ item: itemObj.item, count: itemObj.count });
    }
    const floorLootText = formatLootList(combinedFloorLoot);
    const totalBagText = formatLootList(player.castleLoot);

    story = await generateRaidNarrative(`ヴァルハイト城・${floorInfo.floorName}`, battleData, player, enemy, floorLootText);

    if (nextFloorNum < 3) {
      player.castleFloor = nextFloorNum;
      const nextFloorTitle = castleData.castleFloors[nextFloorNum + 1].floorName;

      messageText =
`🏯【ヴァルハイト城・${floorInfo.floorName} 突破！！】
${quoteHeader}${story}${defeatFooter}
====================
🔥【城郭強襲チキンレース：現在 第${nextFloorNum}層制圧】
・撃破した敵: ${enemy.name}
・今回奪った物資: ${floorLootText}
・🎒 城内戦利品袋（未確定）: 【 ${totalBagText} 】
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}（※城内での兵糧回復は不可！）

⚠️【決断の時】
ここで『⛺ 戦利品を持って城外へ脱出』すれば袋の物資は100%持ち帰れる！
だが、残HPのまま『${nextFloorTitle}』へ突撃して敗北すれば、袋の戦利品は【すべて全没収】となる！
行くか、引くか！？下のボタンで決断しろ！
====================`;
    } else {
      player.bossWins['ヴァルハイト城'] = (player.bossWins['ヴァルハイト城'] || 0) + 1;

      const addedResults = [];
      let anyCapped = false;
      for (const lootEntry of player.castleLoot) {
        const res = addLootWithCap(player, lootEntry.item, lootEntry.count);
        if (res.added > 0) addedResults.push({ item: lootEntry.item, count: res.added });
        if (res.capped) anyCapped = true;
      }
      const finalSecuredText = formatLootList(addedResults);
      const capWarn = anyCapped ? `\n（※一部素材が武器庫の保管上限に達した！アジトで武器庫を拡張しろ！）` : '';

      player.castleFloor = 0;
      player.castleLoot = [];
      player.currentLocation = 'アジト';
      player.hp = battleData.stats.maxHp;

      messageText =
`👑【ヴァルハイト城・天守閣完全制覇！！】
${quoteHeader}${story}${defeatFooter}
====================
🏯【3連撃チキンレース完全勝利：城内宝物庫を根こそぎ強奪！！】
外郭・内城・天守閣の3連戦を勝ち抜き、最深部を守護していた『${enemy.name}』を叩き潰して城内の全資材を本陣へ持ち帰った！

📡【魔王城・緊急傍受】貴族魔族派の魔軍卿：
『な、なんだと！？ 聖涙川の教会平原が誇る真実の城・ヴァルハイト城が、ガルガン軍の野良犬小隊に天守まで荒らされて丸裸にされただと！？ 我ら名門の立場はどうなるのだ！！』

🔥 魔軍卿 ガルガン：
『ガハハハ！！ 天守閣のてっぺんまで綺麗にぶんどってきやがったなシンジ班！ 偽善者どもの泣きっ面が最高に愉快だぜ！！』

・確定持ち帰り戦利品: ${finalSecuredText}${capWarn}
・現在地: ${getCurrentLocationName(player)}（凱旋HP100%全快！）
====================

▼ 下のボタンから次回の行動を選べ。`;
    }
  } else {
    const lostBagText = formatLootList(player.castleLoot);
    player.castleFloor = 0;
    player.castleLoot = [];
    player.hp = 1;
    player.currentLocation = getRetreatLocation('ヴァルハイト城');

    story = await generateRaidNarrative(`ヴァルハイト城・${floorInfo.floorName}`, battleData, player, enemy, '全没収');

    messageText =
`💀【ヴァルハイト城・強襲失敗（戦利品袋 全没収）】
${quoteHeader}${story}

====================
💥【欲をかいた代償：城内戦利品ロスト＆跳ね橋へ後退】
『${floorInfo.floorName}』の『${enemy.name}』に押し潰され、城内でかき集めていた戦利品袋【 ${lostBagText} 】をすべて投げ捨てて城門前の『🌉 ヴァルハイト跳ね橋』まで退却した……！
（※キメラ武器の装着スロット素材は破損せず無傷！）

・現在地: ${getCurrentLocationName(player)}（1歩後退で踏みとどまった！）
・部隊残HP: 1/${battleData.stats.maxHp}（要回復！）
🔥 リッチメニューの「🍖 兵糧回復」で傷を癒やし、すぐ目の前のヴァルハイト城へ再突撃できるぞ！
${battleData.hint}
====================`;
  }

  const latestAll = await loadAllPlayers();
  latestAll[userId] = player;
  await saveAllPlayers(latestAll);

  try {
    await lineClient.pushMessage({
      to: userId,
      messages: [{
        type: 'text',
        text: messageText,
        quickReply: makeQuickReply(getSmartButtons(player)),
      }],
    });
  } catch (err) {
    console.error(`プッシュ送信エラー (${userId}):`, err);
  }
}

// ==========================================
// 7. 特殊作戦②：夜間2地点連続略奪
// ==========================================
async function executeTwoStepRaid(userId, player, routeStr) {
  // 別エリア移動扱いとして覚醒中の第6スロットがあれば消滅
  clearAwakenedSixthSlot(player, true);

  const [step1Key, step2Key] = routeStr.split('>');
  const loc1 = MAP_LOCATIONS[step1Key];
  const loc2 = MAP_LOCATIONS[step2Key];

  player.reservedLocation = null;

  if (!loc1 || !loc2) return;

  const enemy1 = loc1.enemies[Math.floor(Math.random() * loc1.enemies.length)];
  const battle1 = simulateBattle(player, enemy1, step1Key);
  player.hp = battle1.finalPlayerHp;

  if (battle1.result !== 'WIN') {
    player.hp = 1;
    player.currentLocation = getRetreatLocation(step1Key);

    const latestAll = await loadAllPlayers();
    latestAll[userId] = player;
    await saveAllPlayers(latestAll);

    const story1 = await generateRaidNarrative(loc1.name, battle1, player, enemy1, 'なし');
    const failMsg =
`🌙【夜間2地点遠征・第1地点で敗退】
${story1}

====================
【遠征中断：${loc1.name}にて後退】
第1地点『${loc1.name}』の突破に失敗したため、第2地点『${loc2.name}』へ進めず後退した。
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: 1/${battle1.stats.maxHp}
${battle1.hint}
====================`;

    await lineClient.pushMessage({
      to: userId,
      messages: [{
        type: 'text',
        text: failMsg,
        quickReply: makeQuickReply(getSmartButtons(player)),
      }],
    });
    return;
  }

  let loot1Text = 'なし';
  let cap1Notice = '';
  const iconMap = { '王国鋼': '⛏️', '装甲板': '🛡️', '黒火薬': '🧨', '魔導石': '🔮', '兵糧': '🍞' };

  if (loc1.possibleLoot && loc1.possibleLoot.length > 0) {
    const drop1 = loc1.possibleLoot[Math.floor(Math.random() * loc1.possibleLoot.length)];
    const add1 = addLootWithCap(player, drop1.item, drop1.count);
    loot1Text = `${iconMap[drop1.item] || '🎁'}${drop1.item} ×${add1.added}`;
    if (add1.capped) cap1Notice = `（※${drop1.item}上限到達）`;
  }
  player.currentLocation = step1Key;

  if (loc1.isStopper) {
    const latestAll = await loadAllPlayers();
    latestAll[userId] = player;
    await saveAllPlayers(latestAll);
    const story1 = await generateRaidNarrative(loc1.name, battle1, player, enemy1, loot1Text);
    await lineClient.pushMessage({
      to: userId,
      messages: [{
        type: 'text',
        text: `🌙【遠征報告：重要拠点『${loc1.name}』で停止】\n${story1}\n\n・強奪品: ${loot1Text}\n・現在地: ${getCurrentLocationName(player)}`,
        quickReply: makeQuickReply(getSmartButtons(player)),
      }],
    });
    return;
  }

  let autoHealLog = '';
  const stats = calculateEffectiveStats(player);
  if (player.hp < stats.maxHp) {
    if ((player.inventory['兵糧'] || 0) > 0) {
      player.inventory['兵糧'] -= 1;
      player.hp = stats.maxHp;
      autoHealLog = `🍖【進軍野営・自動兵糧補給】第2地点への突撃前、手持ちの兵糧1袋を消費して部隊HPを100%全快（${player.hp}/${stats.maxHp}）した！（残り兵糧: ${player.inventory['兵糧']}袋）`;
    } else {
      autoHealLog = `⚠️【兵糧枯渇】手持ちの兵糧が0袋のため、残HP（${player.hp}/${stats.maxHp}）のまま第2地点『${loc2.name}』へ強行突入した！`;
    }
  } else {
    autoHealLog = `✨【無傷突破】部隊HPは満タン（${player.hp}/${stats.maxHp}）のまま第2地点『${loc2.name}』へ突入！`;
  }

  const enemy2 = loc2.enemies[Math.floor(Math.random() * loc2.enemies.length)];
  const battle2 = simulateBattle(player, enemy2, step2Key);
  player.hp = battle2.finalPlayerHp;

  let loot2Text = 'なし';
  let cap2Notice = '';
  let step2ResultBlock = '';

  if (battle2.result === 'WIN') {
    if (loc2.possibleLoot && loc2.possibleLoot.length > 0) {
      const drop2 = loc2.possibleLoot[Math.floor(Math.random() * loc2.possibleLoot.length)];
      const add2 = addLootWithCap(player, drop2.item, drop2.count);
      loot2Text = `${iconMap[drop2.item] || '🎁'}${drop2.item} ×${add2.added}`;
      if (add2.capped) cap2Notice = `（※${drop2.item}上限到達）`;
    }
    player.currentLocation = step2Key;

    let drawbridgeHype = '';
    if (loc2.isDrawbridge) {
      drawbridgeHype =
`\n\n🔥【決戦前夜：ヴァルハイト跳ね橋を落としたぞ！！】
警備隊を血祭りにあげ、跳ね橋を吊っていた極太の鉄鎖をキメラ斧で両断した！
轟音とともに巨大な跳ね橋が落ち、深い堀の向こうに【🏯 ヴァルハイト城】の大城門が口を開けた！
魔軍卿ガルガン：『ガハハハ！橋は落ちたぞ！ここから先は天守への殴り込みだ！覚悟を決めて突っ込めシンジ班！！』`;
    }

    step2ResultBlock =
`✅【第2戦：${loc2.name}（勝利！）】
・撃破: ${enemy2.name}（${battle2.lastTurn}T制圧）
・強奪品: ${loot2Text}${cap2Notice}${drawbridgeHype}`;
  } else {
    player.hp = 1;
    player.currentLocation = step1Key;
    step2ResultBlock =
`❌【第2戦：${loc2.name}（1歩後退…）】
・交戦: ${enemy2.name}に阻まれたが、本陣までは戻らず第1地点『${loc1.name}』に踏みとどまった！（※第1戦の戦利品『${loot1Text}』は無事確保！）
${battle2.hint}`;
  }

  const latestAll = await loadAllPlayers();
  latestAll[userId] = player;
  await saveAllPlayers(latestAll);

  const story1 = await generateRaidNarrative(loc1.name, battle1, player, enemy1, loot1Text);
  const story2 = await generateRaidNarrative(loc2.name, battle2, player, enemy2, loot2Text);

  const combinedMessage =
`🌙【夜間2地点連続略奪・統合報告】
━━━━━━━━━━━━━━
⚔️ 第1襲撃地：${loc1.name}
${story1}

✅【第1戦：${loc1.name}（勝利！）】
・撃破: ${enemy1.name}（${battle1.lastTurn}T制圧）
・強奪品: ${loot1Text}${cap1Notice}
━━━━━━━━━━━━━━
${autoHealLog}
━━━━━━━━━━━━━━
⚔️ 第2襲撃地：${loc2.name}
${story2}

${step2ResultBlock}
━━━━━━━━━━━━━━
📍 現在地: ${getCurrentLocationName(player)}
❤️ 部隊残HP: ${player.hp}/${stats.maxHp}

▼ 次回の行動を下のボタンから予約しろ。`;

  try {
    await lineClient.pushMessage({
      to: userId,
      messages: [{
        type: 'text',
        text: combinedMessage,
        quickReply: makeQuickReply(getSmartButtons(player)),
      }],
    });
  } catch (err) {
    console.error(`プッシュ送信エラー (${userId}):`, err);
  }
}

// ==========================================
// 8. 定時実行＆テスト即時決行エンジン
// ==========================================
cron.schedule('0 8,12,20 * * *', async () => {
  console.log('>>> [定時時刻到来] 全小隊の一斉行動を開始...');
  await executeScheduledRaids();
});

async function executeScheduledRaids(targetUserId = null, forceDefense = false) {
  const players = await loadAllPlayers();
  const userIds = targetUserId ? [targetUserId] : Object.keys(players);

  for (const userId of userIds) {
    if (!players[userId] && !targetUserId) continue;
    const { player } = await getOrCreatePlayer(userId);

    if (
      player.reservedLocation === 'ヴァルハイト城' ||
      player.reservedLocation === '城郭：突撃' ||
      (player.currentLocation === 'ヴァルハイト城' && player.castleFloor > 0 && !player.reservedLocation)
    ) {
      if (player.reservedLocation === 'ヴァルハイト城') {
        player.castleFloor = 0;
        player.castleLoot = [];
      }
      await executeCastleRogueStep(userId, player);
      continue;
    }

    if (player.reservedLocation && player.reservedLocation.includes('>')) {
      await executeTwoStepRaid(userId, player, player.reservedLocation);
      continue;
    }

    const defaultLoc = (player.chapter >= 3 || player.ch2Step >= 2)
      ? '中立交易区'
      : ((player.chapter >= 2 || player.ch1Step >= 3) ? '農村' : '渓谷');
    const locKey = player.reservedLocation || (player.currentLocation !== 'アジト' ? player.currentLocation : defaultLoc);
    const locData = MAP_LOCATIONS[locKey] || MAP_LOCATIONS[defaultLoc];

    const triggerDefense = forceDefense || (!locData.isBoss && !locData.isStopper && Math.random() < 0.15);

    if (triggerDefense) {
      const defEnemy = DEFENSE_ENEMIES[Math.floor(Math.random() * DEFENSE_ENEMIES.length)];
      const baseName = getBaseName(player);
      const battleData = simulateBattle(player, defEnemy, '防衛戦', { isDefenseBattle: true });

      player.reservedLocation = null;
      player.currentLocation = 'アジト';

      let lootText = 'なし';
      let summaryText = '';

      if (battleData.result === 'WIN') {
        player.hp = battleData.stats.maxHp;
        const r1 = addLootWithCap(player, '王国鋼', 1);
        const r2 = addLootWithCap(player, '装甲板', 1);
        const r3 = addLootWithCap(player, '兵糧', 2);
        lootText = `⛏️王国鋼×${r1.added} / 🛡️装甲板×${r2.added} / 🍞兵糧×${r3.added}`;

        summaryText =
`\n\n====================
🛡️【突発イベント：アジト奇襲防衛に大勝利！！】
${baseName}へ攻め込んできた『${defEnemy.name}』を迎撃杭とキメラ武器で返り討ちにし、連中の軍事物資を丸ごと剥ぎ取ってやった！
${defEnemy.tauntLog}

・強奪戦利品: ${lootText}
・本陣凱旋ボーナス: 部隊HPが100%全快！（${player.hp}/${battleData.stats.maxHp}）
・現在地: ${getCurrentLocationName(player)}
====================`;
      } else {
        player.hp = 1;
        summaryText =
`\n\n【アジト防衛失敗：被害発生】
奇襲部隊に押し込まれ、部隊は重傷を負った！（残HP: 1/${battleData.stats.maxHp}）
\n${battleData.hint}`;
      }

      const latestAll = await loadAllPlayers();
      latestAll[userId] = player;
      await saveAllPlayers(latestAll);

      const story = await generateRaidNarrative(`${baseName}（防衛戦）`, battleData, player, defEnemy, lootText);
      const messageText =
`🚨【緊急迎撃報告：${baseName}防衛戦】
${story}${summaryText}

▼ 現在アジトに滞在中だ。次回の出撃先またはアジト強化を選べ。`;

      try {
        await lineClient.pushMessage({
          to: userId,
          messages: [{
            type: 'text',
            text: messageText,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
      } catch (err) {
        console.error(`プッシュ送信エラー (${userId}):`, err);
      }
      continue;
    }

    // ★ 場所移動による第6スロット消滅判定（覚醒対象ボス以外の場所へ移動した場合）
    let movedAwaySlotLostNotice = '';
    if (player.awakenedBoss && locKey !== player.awakenedBoss) {
      clearAwakenedSixthSlot(player, true);
      movedAwaySlotLostNotice = `\n（※場所を移動したため、覚醒していた『第6スロット』は消滅した）`;
    }

    // ★ 今回のボス戦で使用した第6枠の素材を記録（戦闘後に使い捨て消滅＆戦利品判定用）
    const usedSixthSlotKey = (player.awakenedBoss === locKey) ? player.sixthSlot : null;
    const usedSixthInfo = usedSixthSlotKey ? getSlotItemInfo(usedSixthSlotKey) : null;

    const enemy = locData.enemies[Math.floor(Math.random() * locData.enemies.length)];
    const battleData = simulateBattle(player, enemy, locKey);

    // ★ 第6枠に入れていた素材は勝っても負けても使い捨てで消滅！
    if (usedSixthSlotKey) {
      player.sixthSlot = null;
    }

    player.hp = battleData.finalPlayerHp;
    player.reservedLocation = null;

    let lootText = 'なし';
    let summaryText = '';

    if (battleData.result === 'WIN') {
      let capNotice = '';
      let sixthWinNotice = '';

      // ★ ボスに勝利したら第6枠は消滅
      if (locData.isBoss) {
        player.awakenedBoss = null;
        player.sixthSlot = null;
      }

      // ★ 6枠目に素材を付けて勝った場合は戦利品無し！付けなければ5枠勝利扱いで全戦利品獲得！
      if (locData.isBoss && usedSixthInfo) {
        lootText = `なし（🔥6枠目『${usedSixthInfo.item}』使用のため戦利品なし）`;
        sixthWinNotice = `\n🔥【6枠覚醒突破】6枠目に装填した『${usedSixthInfo.item}』は使い捨てで消滅し、6枠使用の代償として戦利品は無しとなった！（第6スロットは消滅し通常の5枠へ戻った）`;
      } else if (locData.isChallenge) {
        const rSteel = addLootWithCap(player, '王国鋼', 1);
        const rPlate = addLootWithCap(player, '装甲板', 1);
        const rPowder = addLootWithCap(player, '黒火薬', 1);
        const rStone = addLootWithCap(player, '魔導石', 1);
        lootText = `⛏️鋼×${rSteel.added} / 🛡️板×${rPlate.added} / 🧨火×${rPowder.added} / 🔮石×${rStone.added}`;
      } else if (locData.possibleLoot && locData.possibleLoot.length > 0) {
        const dropObj = locData.possibleLoot[Math.floor(Math.random() * locData.possibleLoot.length)];
        const addRes = addLootWithCap(player, dropObj.item, dropObj.count);
        const iconMap = { '王国鋼': '⛏️', '装甲板': '🛡️', '黒火薬': '🧨', '魔導石': '🔮', '兵糧': '🍞' };
        const icon = iconMap[dropObj.item] || '🎁';
        lootText = `${icon}${dropObj.item} ×${addRes.added}`;
        if (addRes.capped) {
          capNotice = `\n（※『${dropObj.item}』が保管上限[${addRes.cap}個]に達した！アジトで『武器庫』を拡張しろ！）`;
        }
      }

      if (locData.isChallenge) {
        player.bossWins[locKey] = (player.bossWins[locKey] || 0) + 1;
        player.currentLocation = '礼拝堂';

        summaryText =
`\n\n====================
💀【チャレンジ完全制覇：対魔神聖巨像を粉砕！！】
人間教会が地下最深部に秘匿していた『対魔神聖巨像アークエンゼル』を解体・スクラップにし、組み込まれていた最高級の全資材をごっそり強奪した！

📡【魔王城・緊急傍受】エリート魔道派の魔軍卿：
『な……何だと！？ 教会が我が魔王軍を殲滅すべく極秘建造していた神聖決戦巨像を、あのような野良のチンピラどもが単独でスクラップにしただと！？ 計算が合わん……あり得ん！！』

・強奪戦利品: ${lootText}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
====================`;

      } else if (locData.isReturn) {
        player.currentLocation = 'アジト';
        player.hp = battleData.stats.maxHp;

        summaryText =
`\n\n====================
⛺【アジト凱旋完了＆部隊HP 100%全快！】
追撃兵を蹴散らして戦利品（${lootText}）を強奪し、${getBaseName(player)}へ帰還した！
本陣の肉を貪り喰らい、兵糧消費ゼロで部隊の傷が完全に癒えたぞ！${capNotice}${movedAwaySlotLostNotice}

・強奪品: ${lootText}
・部隊HP: ${player.hp}/${battleData.stats.maxHp}（完全回復！）
・現在地: ${getCurrentLocationName(player)}
★ 現在アジト滞在中！「🏰 アジト強化」で防壁・武器庫・過負荷炉を改築できるぞ！
====================`;

      } else if (locData.isDrawbridge) {
        player.currentLocation = '跳ね橋';
        summaryText =
`\n\n====================
🌉【攻城前哨戦突破：ヴァルハイト跳ね橋を落としたぞ！！】
橋梁警備兵を血祭りにあげ、跳ね橋を吊っていた極太の鉄鎖をキメラ斧で叩き切った！
ズガァァン！！と轟音を立てて巨大な跳ね橋が落ち、深い堀の向こうに【🏯 ヴァルハイト城】の黒鉄の大城門が口を開けた！

🔥 魔軍卿 ガルガン：
『ガハハハ！！ 橋は落ちたぞ！ ここから先は引き返せねえ天守への3連殴り込みだ！ 武器とHPを整えて突っ込めシンジ班！！』

・強奪品: ${lootText}${capNotice}${movedAwaySlotLostNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
★ 下の『🏯 城門突破！ヴァルハイト城へ』で3連撃チキンレースへ挑めるぞ！
====================`;

      } else if (locData.isBoss && !locData.isChallenge) {
        player.bossWins[locKey] = (player.bossWins[locKey] || 0) + 1;
        player.currentLocation = (
          locData.isChapter1FinalBoss ||
          locData.isChapter2FinalBoss ||
          locData.isChapter3FinalBoss
        ) ? 'アジト' : locKey;

        if (locKey === '検問所') {
          if (player.ch1Step === 0) player.ch1Step = 1;
          summaryText =
`\n\n====================
⚔️【国境検問所を制圧！】
新兵ガルシアを叩き潰し、黒鉄の峡谷地帯の防衛線をこじ開けた！
📡【魔王城・通信傍受】正規軍閥派の連絡官：『なにっ、ガルガン軍の野良犬どもが検問所を抜いただと！？まぐれだ、次のバルツの重装甲で叩き潰されるわ！』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
====================`;

        } else if (locKey === '前哨砦') {
          if (player.ch1Step === 1) player.ch1Step = 2;
          summaryText =
`\n\n====================
🛡️【前哨砦を粉砕！】
魔導重装兵バルツの鉄壁の甲冑を打ち砕いた！
📡【魔王城・通信傍受】貴族魔族派の魔軍卿：『下等な野蛮人どもがバルツを抜いたか……だが要塞門には名将ロシュがいる。あやつらなど剛剣の錆となるわ！』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
====================`;

        } else if (locData.isChapter1FinalBoss) {
          player.ch1Step = 3;
          player.chapter = 2;
          player.hp = battleData.stats.maxHp;
          summaryText =
`\n\n====================
👑【黒鉄の峡谷地帯 完全制圧：要塞門を居抜き乗っ取り！！】
守備隊長ロシュの剛剣を粉砕し、国境最大の『人間軍の要塞門』を丸ごと乗っ取った！
今日からここが俺たちの新本陣だ！（※アジト設備レベルは新本陣へ100%引き継がれた！）
さらに目の前には人間どもの豊かな教会領が広がり、新戦域【聖涙川の教会平原】が解禁されたぞ！

📡【魔王城・緊急通信】貴族魔族派の魔軍卿：
『バカな……！ 我らが見下していたガルガンの野良犬どもが、ロシュの要塞門を奪い取って城にしただとぉぉ！？』

🔥 魔軍卿 ガルガン：
『ガハハハ！！ 見たかシンジ班！ エリートどもの蒼ざめたツラが最高の酒の肴だぜ！ この勢いで教会平原の魔導石も城も全部ぶんどるぞ！！』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}（HP全快！）
====================`;

        } else if (locKey === '工房跡') {
          if (player.ch2Step === 0) player.ch2Step = 1;
          summaryText =
`\n\n====================
🧪【錬金術師の工房跡を制圧！】
猛毒ガスを放つ従軍錬金術師をねじ伏せ、教会の秘術庫をこじ開けた！
これで奥にそびえる教会平原の大ボス『聖堂重騎士』が守る【🏰 教会領大聖堂】への道が開かれたぞ！

📡【魔王城・通信傍受】エリート魔道派の魔軍卿：
『毒ガスによる損耗計算を無視して突破しただと……？ 理屈に合わん、あの野良魔族どもは一体何を武器に組み込んでいるのだ……！』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
====================`;

        } else if (locData.isChapter2FinalBoss) {
          player.ch2Step = 2;
          player.chapter = 3;
          player.hp = battleData.stats.maxHp;
          summaryText =
`\n\n====================
👑【聖涙川の教会平原 完全制圧：教会領大聖堂を乗っ取り！！】
神聖反射盾を誇る聖堂重騎士を叩き割り、教会平原の最高拠点『大聖堂』を占領した！
白亜の聖堂を黒鉄と血煙で染め上げ、俺たちの新たな本陣とする！
さらに世界の中心たる激戦域【覇権の万魔中央回廊】が解禁されたぞ！

📡【魔王城・緊急最高幹部会議】
貴族魔族派の魔軍卿：『信じられん……教会領の大聖堂が、野良上がりのガルガン軍に占領されただと……！？』
正規軍閥派の魔軍卿：『ぐぬぬ……魔王様も御前会議でガルガン卿の手柄を絶賛しておられる……！』

🔥 魔軍卿 ガルガン：
『ガハハハ！！ シンジ班、よくやった！ エリートどもが悔し涙を流しながら歯ぎしりしてやがるぜ！ 次は万魔中央回廊の人間遠征軍へ雪崩れ込むぞ！！』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}（HP全快！）
====================`;

        } else if (locKey === '回廊関門') {
          if (player.ch3Step === 0) player.ch3Step = 1;
          summaryText =
`\n\n====================
⚔️【激突の回廊関門を突破：猛将アルバートを撃破！！】
残りHP半減から攻撃力2倍（56）の鬼神と化した『近衛重装騎士長アルバート』の重戦斧を真っ向から受け止め、キメラ武器で粉砕した！
これで人間軍の最高指導者『聖騎士元帥ジークフリート』が待つ【🏰 遠征軍総本陣】への道が開かれたぞ！

📡【魔王城・前線司令部傍受】正規軍閥派の魔軍卿：
『ば、馬鹿な……！ 我が正規軍の重装師団が何ヶ月も抜くことができなかったアルバートの白獅子陣を、ガルガンの野良小隊が単独でぶち抜いただと！？』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
====================`;

        } else if (locData.isChapter3FinalBoss) {
          player.ch3Step = 2;
          player.hp = battleData.stats.maxHp;
          summaryText =
`\n\n====================
👑【覇権の万魔中央回廊 完全制圧：聖騎士元帥ジークフリートを討ち取り、遠征軍総本陣を乗っ取り！！】
聖剣が光に満ちる6ターン目の即死宣告が放たれる前に、超火力のキメラ武装で人間王国最高峰の英傑『ジークフリート元帥』を力尽くでねじ伏せた！
人間遠征軍の総本陣を丸ごと占領し、今日からここが俺たちの新本陣だ！

👑【万魔の王都・魔王城玉座の間】
絶対支配者・魔王：
『フハハハハ！！ 見事だガルガン、そしてシンジ班よ！ 正規軍閥も貴族派も手を出せなかったジークフリートの首を、貴様ら野良の牙が喰い千切ったか！ これより万魔中央回廊の覇権と戦利品はすべて貴様らのものだ！！』

🔥 魔軍卿 ガルガン：
『ガハハハハ！！ 聞いたか野郎ども！！ 魔王様の御前でエリート魔軍卿どもが真っ青になって震えてやがるぜ！ 俺たちの下剋上、ここに極まれりだァァ！！』

・強奪品: ${lootText}${capNotice}${sixthWinNotice}
・現在地: ${getCurrentLocationName(player)}（HP全快！）
====================`;
        }
      } else if (!locData.isChallenge) {
        player.currentLocation = locKey;
        summaryText =
`\n\n【略奪戦果】
・作戦地: ${locData.name}
・強奪品: ${lootText}${capNotice}${movedAwaySlotLostNotice}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}
（※前線に駐留中。隣接エリアへ進軍するか、『⛺ アジトへ帰還』で本陣に戻ってタダ飯全快＆アジト強化を行え）`;
      }
    } else {
      player.hp = 1;
      const retreatLoc = getRetreatLocation(locKey);
      player.currentLocation = retreatLoc;

      let breakNotice = '';
      let sixthAwakenNotice = '';

      if (locData.isBoss) {
        const brokenItemName = tryBreakSlotMaterial(player);
        if (brokenItemName) {
          breakNotice = `\n💥【武具破損！】敵の猛撃を受けて後退する際、キメラ武器の基本枠に溶接していた『${brokenItemName}』が1個砕け散ってしまった…！（「🔨 武器鍛造」で空き枠を補充しろ！）`;
        } else {
          breakNotice = `\n🛡️【破損回避】防壁と装甲のおかげで、後退時の基本5枠スロット破損は免れた！`;
        }

        // ★ 6枠目の素材を装填して負けた場合の消滅ログ
        if (usedSixthInfo) {
          sixthAwakenNotice += `\n💨【第6枠素材消滅】第6スロットに装填していた『${usedSixthInfo.item}』は使い捨てのため燃え尽きて消滅した！`;
        }

        // ★ ボス敗北時の第6スロット覚醒判定（すでにこのボスに対して覚醒中なら継続、未覚醒なら確率判定）
        if (player.awakenedBoss === locKey) {
          sixthAwakenNotice += `\n🔥【第6スロット覚醒継続中！】『${locData.name}』に挑み続ける限り、第6スロットは継続しているぞ！（他の場所へ移動すると消滅）`;
        } else {
          const awakenRate = getOverloadAwakenRate(player);
          if (Math.random() < awakenRate) {
            player.awakenedBoss = locKey;
            player.sixthSlot = null;
            sixthAwakenNotice +=
`\n\n🔥【武器が覚醒したぞ！！（第6スロット解放）】
死闘の衝撃でキメラ武器が限界覚醒し、イレギュラーボーナス『第6のスロット』が解放された！（覚醒率 ${(awakenRate * 100).toFixed(0)}%）
『${locData.name}』に挑み続ける間、リッチメニューの「🔨 武器鍛造」から独立した【6枠目】に素材を装填できるぞ！
（※6枠目の素材は使い捨てで負けたら毎回消滅。6枠目に素材を付けて勝つと戦利品無し、付けずに勝てば5枠勝利扱いで戦利品獲得！場所を移動すると6枠目は消滅する）`;
          }
        }
      }

      const retryGuide = retreatLoc !== 'アジト'
        ? `\n🔥【前線1歩後退：即リベンジ可能！】\n本陣まで戻らず、すぐ手前の『${getCurrentLocationName(player)}』で踏みとどまったぞ！\nリッチメニューの「🍖 兵糧回復」で傷を癒やし、「🔨 武器鍛造」でスロットを組み直せば、すぐ『${locData.name}』へ再突撃できる！`
        : `\n⛺ リッチメニューの「🍖 兵糧回復」を使うか、本陣の備蓄を整えて再出撃しろ！`;

      summaryText =
`\n\n【作戦失敗：1歩後退（${getCurrentLocationName(player)}）】
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${battleData.stats.maxHp}（要回復！）${breakNotice}${sixthAwakenNotice}${movedAwaySlotLostNotice}${retryGuide}
\n${battleData.hint}`;
    }

    const latestAll = await loadAllPlayers();
    latestAll[userId] = player;
    await saveAllPlayers(latestAll);

    const story = await generateRaidNarrative(locData.name, battleData, player, enemy, lootText);

    const messageText =
`【定時作戦報告：${locData.name}】
${story}${summaryText}

▼ 次回の進軍先を下のボタンから選べ。`;

    try {
      await lineClient.pushMessage({
        to: userId,
        messages: [{
          type: 'text',
          text: messageText,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });
    } catch (err) {
      console.error(`プッシュ送信エラー (${userId}):`, err);
    }
  }
}

// ==========================================
// 9. Web古地図配信エンドポイント（/map）
// ==========================================
app.get('/map', (req, res) => {
  const mapCh3Path = path.resolve('chapter3_world_map_complete.html');
  const mapCh2Path = path.resolve('chapter2_world_map.html');
  if (fs.existsSync(mapCh3Path)) {
    res.sendFile(mapCh3Path);
  } else if (fs.existsSync(mapCh2Path)) {
    res.sendFile(mapCh2Path);
  } else {
    res.status(404).send('地図ファイルが見つかりません。');
  }
});

// ==========================================
// 10. LINE Webhook ルーティング（リッチメニュー6枠完全連動）
// ==========================================
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.status(200).end();

  const events = req.body.events;
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userText = event.message.text.trim();
    const userId = event.source.userId;
    let { player, allPlayers } = await getOrCreatePlayer(userId);

    // A. 開幕・リセット・作戦地図・行動選択（★画像主役・長文テキスト全廃版）
    if (
      userText === '開幕' ||
      userText === 'リセット' ||
      userText === '地図' ||
      userText === '作戦地図' ||
      userText === '出撃' ||
      userText === '行動選択' ||
      userText === 'メニュー'
    ) {
      if (userText === '開幕' || userText === 'リセット') {
        player = createInitialPlayer(userId);
        allPlayers[userId] = player;
        await saveAllPlayers(allPlayers);
      }

      // ★長文の進路案内やコンディションを全廃し、画面を占有しない極小テキストに限定！
      const curLocName = getCurrentLocationName(player);
      const reservedName = getReservedDisplayName(player.reservedLocation);
      const resNotice = player.reservedLocation ? `（次回予約: 『${reservedName}』）` : '';
      const minimalText = `📍 現在地：${curLocName} ${resNotice}\n▼ 下のボタンから進軍先を選べ。`;

      const mapImageUrl = resolveMapImageUrl(player, req);
      const replyMessages = [];

      if (mapImageUrl) {
        replyMessages.push({
          type: 'image',
          originalContentUrl: mapImageUrl,
          previewImageUrl: mapImageUrl,
        });
      }

      replyMessages.push({
        type: 'text',
        text: minimalText,
        quickReply: makeQuickReply(getSmartButtons(player)),
      });

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: replyMessages,
      });

    // B. 予約解除（リッチメニュー「🔄 行動変更」連動）
    } else if (userText === '予約解除') {
      player.reservedLocation = null;
      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: '🔄 行動予約を一旦取り消した。下のボタンから新しい進軍先を選べ。',
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // B-2. ヴァルハイト城（3連撃チキンレース）の突撃・脱出コマンド
    } else if (userText === '城郭：突撃' || userText === '城郭：脱出') {
      if (player.currentLocation !== 'ヴァルハイト城' || player.castleFloor <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 現在はヴァルハイト城の内部にはいないぞ！下のボタンから進軍先を選べ。',
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (userText === '城郭：脱出') {
        const addedList = [];
        let anyCap = false;
        for (const entry of player.castleLoot) {
          const r = addLootWithCap(player, entry.item, entry.count);
          if (r.added > 0) addedList.push({ item: entry.item, count: r.added });
          if (r.capped) anyCap = true;
        }
        const securedText = formatLootList(addedList);
        const capNote = anyCap ? '\n（※一部素材が武器庫上限に達した！）' : '';

        player.castleFloor = 0;
        player.castleLoot = [];
        player.reservedLocation = null;
        player.currentLocation = '跳ね橋';
        allPlayers[userId] = player;
        await saveAllPlayers(allPlayers);

        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text:
`⛺【ヴァルハイト城から戦利品を抱えて無事脱出成功！！】
深追いせず、城内で奪った戦利品袋を背負って『🌉 ヴァルハイト跳ね橋』へと引き揚げた！
袋の中身がすべて部隊の正式な所持品として確定したぞ！

・確定獲得した戦利品: 【 ${securedText} 】${capNote}
・現在地: ${getCurrentLocationName(player)}
・部隊残HP: ${player.hp}/${calculateEffectiveStats(player).maxHp}

▼ 続けて城へ再突入するか、兵站所やアジトへ戻るかを選べ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      player.reservedLocation = '城郭：突撃';
      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      const nextFloorNum = player.castleFloor + 1;
      const floorInfo = MAP_LOCATIONS['ヴァルハイト城'].castleFloors[nextFloorNum];
      const enemyNames = (floorInfo.enemies || []).map(e => e.name).join(' / ');

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🔥【ヴァルハイト城・次階層への突撃予約完了！】
目標: 『${floorInfo.floorName}』
・出現候補の敵: ${enemyNames}（※いずれか1隊とランダム遭遇！）
・現在の戦利品袋: 【 ${formatLootList(player.castleLoot)} 】
・引き継ぎ部隊HP: ${player.hp}/${calculateEffectiveStats(player).maxHp}

※リッチメニューの「⚡ 即時決行」で今すぐ突入、変更する場合は「🔄 行動変更」を押せ！`,
        }],
      });

    // B-3. 夜間2地点連続略奪（遠征：A>B）の予約
    } else if (userText.startsWith('遠征：') && userText.includes('>')) {
      const route = userText.replace('遠征：', '').trim();
      const [step1Key, step2Key] = route.split('>');
      const loc1 = MAP_LOCATIONS[step1Key];
      const loc2 = MAP_LOCATIONS[step2Key];

      if (!loc1 || !loc2) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 指定された遠征ルートが見つからないぞ。下のボタンから選べ。',
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (loc1.isStopper) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ 『${loc1.name}』は重要拠点（ストッパー）のため素通りできない！まずは1歩で『${loc1.name}』へ進軍しろ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      player.reservedLocation = route;
      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      const loseSlotWarn = player.awakenedBoss
        ? `\n⚠️【注意】現在『${MAP_LOCATIONS[player.awakenedBoss]?.name || player.awakenedBoss}』に対して第6スロットが覚醒中だ！別の場所へ移動すると第6スロットは消滅するぞ！`
        : '';

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🌙【夜間2地点連続略奪・予約完了】
進軍ルート: 『${loc1.name}』 ➔ 『${loc2.name}』
・第1戦: ${loc1.name}を襲撃して素材強奪
・野営補給: 傷ついた場合、手持ちの『🍞兵糧』を自動で1袋食べてHP100%全快！（所持: ${player.inventory['兵糧']}袋）
・第2戦: そのまま『${loc2.name}』へ突入して連続略奪！${loseSlotWarn}

※リッチメニューの「⚡ 即時決行」で今すぐ決行、変更する場合は「🔄 行動変更」を押せ！`,
        }],
      });

    // C. アジト強化・拠点改修・帰還
    } else if (
      userText.includes('アジト') ||
      userText.includes('拠点') ||
      userText.includes('増築') ||
      userText.includes('改築') ||
      userText.startsWith('拠点改修：')
    ) {
      if (userText.includes('帰還') || userText.startsWith('出撃：')) {
        if (player.currentLocation === 'アジト') {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `⛺ すでに本陣『${getBaseName(player)}』に滞在しているぞ！出撃先を選ぶか、そのまま「アジト強化」を行え。`,
              quickReply: makeQuickReply(getSmartButtons(player)),
            }],
          });
          return;
        }
        player.reservedLocation = '帰還';
        allPlayers[userId] = player;
        await saveAllPlayers(allPlayers);

        const loseSlotWarn = player.awakenedBoss
          ? `\n⚠️【注意】本陣へ帰還すると、現在覚醒中の『第6スロット』は消滅するぞ！`
          : '';

        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text:
`⛺【アジト帰還（強襲凱旋）予約完了】
次回定時、退路の人間軍哨戒部隊を蹴散らして物資を奪いながら『${getBaseName(player)}』へ帰還する！
・帰還ボーナス: 到着と同時に部隊HPが100%全快（兵糧消費ゼロ）＆アジト強化が解禁！${loseSlotWarn}

※リッチメニューの「⚡ 即時決行」で今すぐ帰還、変更する場合は「🔄 行動変更」を押せ！`,
          }],
        });
        return;
      }

      if (player.currentLocation !== 'アジト') {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text:
`⚠️ おいシンジ、いま俺たちは【${getCurrentLocationName(player)}】のド真ん中だぞ！
遠征先で本陣の大工仕事なんかできるわけがねえ。
アジトを改築したけりゃ、下の『⛺ アジトへ帰還(略奪&全快)』を選んで一度本陣に戻ってからにしろ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (userText.startsWith('拠点改修：')) {
        const target = userText.replace('拠点改修：', '').trim();

        if (target === '防壁') {
          const lv = player.baseWallLevel || 1;
          if (lv >= 3) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{
                type: 'text',
                text: '🛡️ 防壁はすでに最大レベル（Lv3：ボス敗走時の破損率10%）に達しているぞ！',
                quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
              }],
            });
            return;
          }
          const cost = lv === 1 ? 3 : 5;
          if ((player.inventory['装甲板'] || 0) < cost) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{
                type: 'text',
                text: `⚠️ 防壁Lv${lv + 1}への改修には『🛡️装甲板 ×${cost}個』が必要だ！（手持ち: ${player.inventory['装甲板'] || 0}個）`,
                quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
              }],
            });
            return;
          }

          player.inventory['装甲板'] -= cost;
          player.baseWallLevel = lv + 1;
          allPlayers[userId] = player;
          await saveAllPlayers(allPlayers);

          const newBreakRate = (getBossBreakRate(player) * 100).toFixed(0);
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text:
`🔨【アジト防壁強化完了！】
奪った装甲板${cost}枚を本陣の外壁に打ち付け、防壁が【Lv${player.baseWallLevel}】に進化した！
・ボス敗走時の素材破損率: ${newBreakRate}% に軽減！
・防衛戦の迎撃鉄杭ダメージ: ${player.baseWallLevel * 10} ダメージに強化！`,
              quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
            }],
          });
          return;

        } else if (target === '武器庫') {
          const lv = player.baseArmoryLevel || 1;
          if (lv >= 3) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{
                type: 'text',
                text: '⛏️ 武器庫はすでに最大レベル（Lv3：各素材15個・兵糧30袋まで保管可能）に達しているぞ！',
                quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
              }],
            });
            return;
          }
          const cost = lv === 1 ? 3 : 5;
          if ((player.inventory['王国鋼'] || 0) < cost) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{
                type: 'text',
                text: `⚠️ 武器庫Lv${lv + 1}への拡張には『⛏️王国鋼 ×${cost}個』が必要だ！（手持ち: ${player.inventory['王国鋼'] || 0}個）`,
                quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
              }],
            });
            return;
          }

          player.inventory['王国鋼'] -= cost;
          player.baseArmoryLevel = lv + 1;
          allPlayers[userId] = player;
          await saveAllPlayers(allPlayers);

          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text:
`🔨【アジト武器庫拡張完了！】
王国鋼${cost}個で頑丈な鉄棚を増設し、武器庫が【Lv${player.baseArmoryLevel}】に拡張された！
・手持ち素材の保管上限: 各 ${getMaterialCap(player)}個 まで拡大！
・兵糧の保管上限: ${getRationCap(player)}袋 まで拡大！`,
              quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
            }],
          });
          return;

        } else if (target === '過負荷炉') {
          const lv = player.baseFurnaceLevel || 0;
          if (lv >= 2) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{
                type: 'text',
                text: '🔥 過負荷炉はすでに最大レベル（Lv2：ボス敗北時の第6スロット覚醒率35%）に達しているぞ！',
                quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
              }],
            });
            return;
          }
          const cost = lv === 0 ? 3 : 5;
          if ((player.inventory['黒火薬'] || 0) < cost) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{
                type: 'text',
                text: `⚠️ 過負荷炉Lv${lv + 1}への改修には『🧨黒火薬 ×${cost}個』が必要だ！（手持ち: ${player.inventory['黒火薬'] || 0}個）`,
                quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
              }],
            });
            return;
          }

          player.inventory['黒火薬'] -= cost;
          player.baseFurnaceLevel = lv + 1;
          allPlayers[userId] = player;
          await saveAllPlayers(allPlayers);

          const newAwakenRate = (getOverloadAwakenRate(player) * 100).toFixed(0);
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text:
`🔥【アジト過負荷炉 改修完了！】
黒火薬${cost}樽を鍛冶炉の心臓部に組み込み、過負荷炉が【Lv${player.baseFurnaceLevel}】に進化した！
・ボス敗北時の『第6スロット』覚醒確率: ${newAwakenRate}% に上昇！`,
              quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
            }],
          });
          return;
        }
      }

      const wallLv = player.baseWallLevel || 1;
      const armoryLv = player.baseArmoryLevel || 1;
      const furnaceLv = player.baseFurnaceLevel || 0;
      const breakRate = (getBossBreakRate(player) * 100).toFixed(0);
      const awakenRate = (getOverloadAwakenRate(player) * 100).toFixed(0);
      const wallNextText = wallLv < 3 ? `次Lv${wallLv + 1}（要: 🛡️装甲板×${wallLv === 1 ? 3 : 5}）` : 'MAX到達';
      const armoryNextText = armoryLv < 3 ? `次Lv${armoryLv + 1}（要: ⛏️王国鋼×${armoryLv === 1 ? 3 : 5}）` : 'MAX到達';
      const furnaceNextText = furnaceLv < 2 ? `次Lv${furnaceLv + 1}（要: 🧨黒火薬×${furnaceLv === 0 ? 3 : 5}）` : 'MAX到達';

      const baseGuide =
`🏰【${getBaseName(player)}：要塞化改修】
現在地: ${getCurrentLocationName(player)}
（※拠点を乗っ取っても、強化レベルは100%引き継がれる！）

① 🛡️ 防壁レベル: Lv${wallLv}/3 ［${wallNextText}］
   ・効果: ボス敗走時の破損率 ${breakRate}%（Lv1:30% ➔ Lv2:20% ➔ Lv3:10%）
   ・迎撃: 防衛戦の開幕鉄杭ダメージ ${wallLv * 10}

② ⛏️ 武器庫レベル: Lv${armoryLv}/3 ［${armoryNextText}］
   ・効果: 手持ち素材の保管上限 各${getMaterialCap(player)}個 / 兵糧${getRationCap(player)}袋

③ 🔥 過負荷炉レベル: Lv${furnaceLv}/2 ［${furnaceNextText}］
   ・効果: ボス敗北時の『第6スロット』覚醒率 ${awakenRate}%（初期15% ➔ Lv1:25% ➔ Lv2:35%）

【手持ちの資材】
⛏️鋼: ${player.inventory['王国鋼']}/${getMaterialCap(player)}個 | 🛡️板: ${player.inventory['装甲板']}/${getMaterialCap(player)}個 | 🧨火: ${player.inventory['黒火薬']}/${getMaterialCap(player)}個 | 🔮石: ${player.inventory['魔導石']}/${getMaterialCap(player)}個

▼ 下のボタンから強化したい設備を選べ。`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: baseGuide,
          quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
        }],
      });

    // D. 出撃予約（単一ノード進軍）
    } else if (userText.startsWith('出撃：') || userText.includes('白銀城塞') || Object.keys(MAP_LOCATIONS).some(k => userText.includes(k))) {
      let matchedKey = null;
      if (userText.includes('白銀城塞')) {
        matchedKey = 'ヴァルハイト城';
      } else {
        for (const k of Object.keys(MAP_LOCATIONS)) {
          if (userText.includes(k)) {
            matchedKey = k;
            break;
          }
        }
      }

      if (!matchedKey) matchedKey = (player.chapter >= 2 || player.ch1Step >= 3) ? '農村' : '渓谷';
      const loc = MAP_LOCATIONS[matchedKey];

      if (matchedKey === '帰還' && player.currentLocation === 'アジト') {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⛺ すでに本陣『${getBaseName(player)}』に滞在しているぞ！他の出撃先を選べ。`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (matchedKey === 'ヴァルハイト城' && player.currentLocation !== '跳ね橋' && player.currentLocation !== 'ヴァルハイト城') {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ ヴァルハイト城へ突入するには、まず『⚒️ 兵站所』から『🌉 跳ね橋』へ進軍して橋を落とせ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (loc.chapter === 1 && loc.bossStep !== undefined && loc.bossStep > player.ch1Step) {
        const names = ['国境検問所（新兵ガルシア）', '前哨砦（魔導重装兵バルツ）', '人間軍の要塞門（守備隊長ロシュ）'];
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ まだそこへは進軍できない！まずは黒鉄の峡谷地帯『${names[player.ch1Step]}』を突破しろ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (loc.chapter === 2 && loc.bossStep !== undefined && loc.bossStep > player.ch2Step) {
        const names2 = ['錬金術師の工房跡（従軍錬金術師）', '教会領大聖堂（聖堂重騎士）'];
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ まだそこへは進軍できない！まずは聖涙川の教会平原『${names2[player.ch2Step]}』を突破しろ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (loc.chapter === 3 && loc.bossStep !== undefined && loc.bossStep > player.ch3Step) {
        const names3 = ['激突の回廊関門（近衛重装騎士長アルバート）', '遠征軍総本陣（聖騎士元帥ジークフリート）'];
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ まだそこへは進軍できない！まずは覇権の万魔中央回廊『${names3[player.ch3Step]}』を突破しろ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      player.reservedLocation = matchedKey;
      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      let breakRiskNote = '';
      if (loc.isCastleRogue) {
        breakRiskNote = `\n🔥【3連撃チキンレース】第1層・第2層・天守閣の最大3連戦！途中で脱出すれば戦利品確定、負ければ城内戦利品は全没収で『🌉 跳ね橋』へ後退（※装着スロットは破損しない）！`;
      } else if (loc.isBoss) {
        breakRiskNote = `\n⚠️【ボス戦注意】敗走すると ${(getBossBreakRate(player) * 100).toFixed(0)}% の確率で装着素材が1個砕け散るが、本陣までは戻されず直前マスへ1歩後退してすぐ再挑戦できるぞ！`;
      }

      if (player.awakenedBoss) {
        if (matchedKey === player.awakenedBoss) {
          const sixthLabel = player.sixthSlot ? getSlotItemInfo(player.sixthSlot).label : '未装填（空：5枠勝利扱い）';
          breakRiskNote += `\n🔥【第6スロット覚醒継続中】現在の6枠目: ${sixthLabel}`;
        } else {
          breakRiskNote += `\n⚠️【注意】対象ボス（${MAP_LOCATIONS[player.awakenedBoss]?.name || player.awakenedBoss}）以外の場所へ移動すると、覚醒中の『第6スロット』は消滅するぞ！`;
        }
      }

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🚩【行動予約完了】
次回定時の目標を『${loc.name}』に設定した！
・現在地: ${getCurrentLocationName(player)}
・内容: ${loc.desc}${breakRiskNote}

※リッチメニューの「⚡ 即時決行」で今すぐ突撃、変更する場合は「🔄 行動変更」を押せ！`,
        }],
      });

    // E. テスト即時決行 ＆ テスト防衛戦（リッチメニュー「⚡ 即時決行」連動）
    } else if (userText.includes('即時決行') || userText.includes('テスト防衛戦')) {
      const isDef = userText.includes('テスト防衛戦');
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: isDef
            ? '🚨 敵襲警報！本陣へ敵の奇襲部隊が接近中…！（数秒後にAI迎撃報告が届きます）'
            : '⏳ 定時到来！シンジ班が作戦行動を開始した…（数秒後にAI戦闘報告が届きます）',
        }],
      });
      await executeScheduledRaids(userId, isDef);

    // F. 鍛冶場・キメラ武器改造（リッチメニュー「🔨 武器鍛造」連動：基本5枠＋独立第6枠）
    } else if (userText.includes('鍛造') || userText.includes('鍛冶') || userText.includes('改造') || userText.includes('武器')) {
      const s = player.slots;
      const total = getTotalSlots(s);
      const stats = calculateEffectiveStats(player);
      const cap = getMaterialCap(player);

      const stoneInfo = s.stone > 0 ? `\n・🔮 魔導石: ${s.stone}枠 (攻+${s.stone * 3} / 防-${s.stone * 1} / HP-${s.stone * 6}% / 吸血+${s.stone * 20}%)` : '';

      let sixthSection = '';
      if (player.awakenedBoss) {
        const bossTitle = MAP_LOCATIONS[player.awakenedBoss]?.name || player.awakenedBoss;
        const sixthInfo = player.sixthSlot ? getSlotItemInfo(player.sixthSlot).label : '【空（未装填：このまま勝てば5枠勝利扱い）】';
        sixthSection =
`\n\n🔥【覚醒・独立第6スロット（対：${bossTitle}）】
・6枠目: ${sixthInfo}
（※6枠目の素材は使い捨てで戦闘後に消滅。装着して勝つと戦利品無し。場所移動で6枠目消滅）`;
      }

      const forgeGuide =
`🔨【キメラ武器5枠鍛造】（現在地: ${getCurrentLocationName(player)}）
主武装: ${player.weapon}
基本枠状況: [${total}/5枠 装着中]
・⛏️ 王国鋼: ${s.steel}枠 (攻+${s.steel * 7} / 防-${s.steel * 2})
・🛡️ 装甲板: ${s.plate}枠 (防+${s.plate * 6} / 攻-${s.plate * 2})
・🧨 黒火薬: ${s.powder}枠 (会心+${s.powder * 13}% / 回避+${s.powder * 7}% / 攻-${s.powder * 2} / 防-${s.powder * 1})${stoneInfo}${sixthSection}

【実効ステータス】
HP: ${player.hp}/${stats.maxHp} | 攻撃: ${stats.atk} | 防御: ${stats.def}
会心率: ${(stats.critRate * 100).toFixed(0)}% [背水時:${Math.min(100, (stats.critRate + 0.15) * 100).toFixed(0)}%] (装甲50%貫通×1.5倍)
回避率: ${(stats.dodgeRate * 100).toFixed(0)}% (黒煙回避)
吸血率: ${(stats.drainRate * 100).toFixed(0)}% (与ダメージ吸収回復)

【手持ち素材（上限: 各${cap}個）】
⛏️鋼: ${player.inventory['王国鋼']}個 | 🛡️板: ${player.inventory['装甲板']}個 | 🧨火: ${player.inventory['黒火薬']}個 | 🔮石: ${player.inventory['魔導石']}個

▼ 下のボタンで素材を溶接・付け替えろ。`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: forgeGuide,
          quickReply: makeQuickReply(getForgeButtons(player)),
        }],
      });

    // G-0. 独立第6スロット操作（覚醒中のみ・自由付け替え＆解除）
    } else if (userText.startsWith('6枠：')) {
      if (!player.awakenedBoss) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 現在『第6スロット』は覚醒していないぞ！（ボス戦敗北時に一定確率で覚醒する）',
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        return;
      }

      const type = userText.replace('6枠：', '').trim();

      if (type === '外す' || type === '解除' || type === 'リセット') {
        if (player.sixthSlot) {
          const prevInfo = getSlotItemInfo(player.sixthSlot);
          if (prevInfo) {
            player.inventory[prevInfo.item] = (player.inventory[prevInfo.item] || 0) + 1;
          }
          player.sixthSlot = null;
        }
        const stats = calculateEffectiveStats(player);
        if (player.hp > stats.maxHp) player.hp = stats.maxHp;
        allPlayers[userId] = player;
        await saveAllPlayers(allPlayers);

        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text:
`❌【第6スロット解除（5枠状態へ復帰）】
6枠目の素材を取り外して手持ちに戻し、6枠目を【空】にしたぞ！
（※このまま6枠目に付けずにボスに勝てば、通常通り5枠での勝利扱いとなり戦利品をすべて獲得できる！）

【最新ステータス】
HP: ${player.hp}/${stats.maxHp} | 攻撃: ${stats.atk} | 防御: ${stats.def} | 会心: ${(stats.critRate * 100).toFixed(0)}% | 吸血: ${(stats.drainRate * 100).toFixed(0)}%`,
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        return;
      }

      let itemKey = '';
      let slotKey = '';
      if (type === '鋼' || type === '鉄') { itemKey = '王国鋼'; slotKey = 'steel'; }
      if (type === '板' || type === '盾') { itemKey = '装甲板'; slotKey = 'plate'; }
      if (type === '火' || type === '火薬') { itemKey = '黒火薬'; slotKey = 'powder'; }
      if (type === '石' || type === '魔導石') { itemKey = '魔導石'; slotKey = 'stone'; }

      if (!itemKey || (player.inventory[itemKey] || 0) <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ 手持ちの『${itemKey || '素材'}』が足りない！`,
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        return;
      }

      // すでに別の素材が6枠目に入っていた場合は手持ちに返却して付け替える
      if (player.sixthSlot) {
        const prevInfo = getSlotItemInfo(player.sixthSlot);
        if (prevInfo) {
          player.inventory[prevInfo.item] = (player.inventory[prevInfo.item] || 0) + 1;
        }
      }

      player.inventory[itemKey] -= 1;
      player.sixthSlot = slotKey;
      const newStats = calculateEffectiveStats(player);
      if (player.hp > newStats.maxHp) player.hp = newStats.maxHp;

      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🔥【覚醒・第6スロット装填完了！】
独立第6枠に『${itemKey}』を装填した！（基本5枠: ⛏️鋼${player.slots.steel}/🛡️板${player.slots.plate}/🧨火${player.slots.powder}/🔮石${player.slots.stone} ＋ 🔥6枠目:${itemKey}）
⚠️ 6枠目の素材は使い捨てで戦闘後に消滅し、勝っても戦利品は無しになるぞ！（5枠扱いに戻すなら「❌ 6枠目を外す」を押せ）

【最新ステータス（6枠合算）】
HP: ${player.hp}/${newStats.maxHp} | 攻撃: ${newStats.atk} | 防御: ${newStats.def} | 会心: ${(newStats.critRate * 100).toFixed(0)}% | 吸血: ${(newStats.drainRate * 100).toFixed(0)}%`,
          quickReply: makeQuickReply(getForgeButtons(player)),
        }],
      });

    // G. 基本5枠スロット操作
    } else if (userText.startsWith('スロット：')) {
      const type = userText.replace('スロット：', '').trim();
      const s = player.slots;
      const total = getTotalSlots(s);

      if (type === 'リセット') {
        player.inventory['王国鋼'] = (player.inventory['王国鋼'] || 0) + (s.steel || 0);
        player.inventory['装甲板'] = (player.inventory['装甲板'] || 0) + (s.plate || 0);
        player.inventory['黒火薬'] = (player.inventory['黒火薬'] || 0) + (s.powder || 0);
        player.inventory['魔導石'] = (player.inventory['魔導石'] || 0) + (s.stone || 0);
        player.slots = { steel: 0, plate: 0, powder: 0, stone: 0 };
        allPlayers[userId] = player;
        await saveAllPlayers(allPlayers);

        const stats = calculateEffectiveStats(player);
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text:
`🔄【基本5枠スロット初期化】
基本5枠に溶接していた素材をすべて引き剥がし、手元に回収した！（現在 0/5枠）
実効能力: 攻${stats.atk} / 防${stats.def} / 会心${(stats.critRate * 100).toFixed(0)}% / 回避${(stats.dodgeRate * 100).toFixed(0)}%
手持ち: ⛏️鋼${player.inventory['王国鋼']} / 🛡️板${player.inventory['装甲板']} / 🧨火${player.inventory['黒火薬']} / 🔮石${player.inventory['魔導石']}

▼ 下のボタンから新しく5枠を組み直せ。`,
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        return;
      }

      if (total >= 5) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 基本の5枠はすでにすべて埋まっている！「🔄 5枠すべて外す(初期化)」を押してから組み直すか、覚醒中なら「🔥 6枠目」のボタンを押せ。',
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        return;
      }

      let itemKey = '';
      let slotKey = '';
      if (type === '鋼' || type === '鉄') { itemKey = '王国鋼'; slotKey = 'steel'; }
      if (type === '板' || type === '盾') { itemKey = '装甲板'; slotKey = 'plate'; }
      if (type === '火' || type === '火薬') { itemKey = '黒火薬'; slotKey = 'powder'; }
      if (type === '石' || type === '魔導石') { itemKey = '魔導石'; slotKey = 'stone'; }

      if (!itemKey || (player.inventory[itemKey] || 0) <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ 手持ちの『${itemKey || '素材'}』が足りない！戦場へ出撃して奪ってこい！`,
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        return;
      }

      player.inventory[itemKey] -= 1;
      player.slots[slotKey] += 1;
      const newStats = calculateEffectiveStats(player);
      if (player.hp > newStats.maxHp) player.hp = newStats.maxHp;

      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      const newTotal = getTotalSlots(player.slots);
      const sixthNote = player.awakenedBoss
        ? `\n🔥 覚醒第6枠: [${player.sixthSlot ? getSlotItemInfo(player.sixthSlot).item : '未装填(空)'}]`
        : '';

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🔨【キメラ溶接成功】『${itemKey}』を基本枠に打ち込んだ！
基本枠状況: [${newTotal}/5枠] (⛏️鋼:${player.slots.steel} / 🛡️板:${player.slots.plate} / 🧨火:${player.slots.powder} / 🔮石:${player.slots.stone})${sixthNote}

【最新ステータス】
HP: ${player.hp}/${newStats.maxHp} | 攻撃: ${newStats.atk} | 防御: ${newStats.def} | 会心: ${(newStats.critRate * 100).toFixed(0)}% | 吸血: ${(newStats.drainRate * 100).toFixed(0)}%
残り手持ち: 鋼${player.inventory['王国鋼']} / 板${player.inventory['装甲板']} / 火${player.inventory['黒火薬']} / 石${player.inventory['魔導石']}

${newTotal < 5 ? '▼ 続けて残りの枠を込めろ。' : '✅ 5枠すべて完成した！リッチメニューの「🗺️ 作戦地図」から出撃先を選んで突撃しろ！'}`,
          quickReply: makeQuickReply(getForgeButtons(player)),
        }],
      });

    // H. 回復・兵糧（リッチメニュー「🍖 兵糧回復」連動）
    } else if (userText.includes('回復') || userText.includes('兵糧') || userText.includes('兵舎') || userText.includes('飯') || userText.includes('補給')) {
      if (player.currentLocation === 'ヴァルハイト城' && player.castleFloor > 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ いまは【🏯 ヴァルハイト城】の強襲作戦中だ！敵城のど真ん中で悠長に飯を食ってる暇はねえ！\n残りのHPで次の階層へ『突撃』するか、戦利品袋を持って『城外へ脱出』しろ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      const rations = player.inventory['兵糧'] || 0;
      const stats = calculateEffectiveStats(player);

      if (player.hp >= stats.maxHp) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `🍖 部隊のHPはすでに満タンだ！（HP: ${player.hp}/${stats.maxHp} / 残り兵糧: ${rations}袋）`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      if (rations <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 兵糧が底をついている！街道や農村、交易区で兵糧×2袋を強奪するか、『⛺ アジトへ帰還』で本陣に戻ってタダ飯全快しろ！',
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
      }

      player.inventory['兵糧'] -= 1;
      player.hp = stats.maxHp;
      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      const notice = player.reservedLocation ? `\n（※次回予約：『${getReservedDisplayName(player.reservedLocation)}』）` : '';
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `🍖【魔族の暴食補給】\n強奪した兵糧を引き裂いて貪り喰らい、荒くれどもの傷が100%全快した！（HP: ${player.hp}/${stats.maxHp}）\n残り兵糧: ${player.inventory['兵糧']}/${getRationCap(player)}袋${notice}\n\n▼ 傷は癒えたぞ！下のボタンからボスへの再突撃や進軍先を選べ！`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // I. ステータス・陣況確認（リッチメニュー「📋 陣況確認」連動）
    } else if (userText.includes('ステータス') || userText.includes('確認') || userText.includes('陣況') || userText.includes('状況')) {
      const stats = calculateEffectiveStats(player);
      const s = player.slots;
      const total = getTotalSlots(s);

      let currentTarget = '';
      if (player.chapter === 1 && player.ch1Step < 3) {
        const step1 = ['国境検問所（ガルシア）', '前哨砦（バルツ）', '人間軍の要塞門（ロシュ）'];
        currentTarget = `黒鉄の峡谷地帯：${step1[player.ch1Step]}`;
      } else if (player.chapter === 2 && player.ch2Step < 2) {
        const step2 = ['錬金術師の工房跡（従軍錬金術師）', '教会領大聖堂（聖堂重騎士）'];
        currentTarget = `聖涙川の教会平原：${step2[player.ch2Step]}`;
      } else {
        const step3 = ['激突の回廊関門（騎士長アルバート）', '遠征軍総本陣（元帥ジークフリート）', '👑 覇権の万魔中央回廊 完全制圧済み！'];
        currentTarget = `覇権の万魔中央回廊：${step3[player.ch3Step] || step3[2]}`;
      }

      const locName = getReservedDisplayName(player.reservedLocation);
      const cap = getMaterialCap(player);
      const castleBagLine = (player.currentLocation === 'ヴァルハイト城' && player.castleFloor > 0)
        ? `\n・🎒 城内戦利品袋: ${formatLootList(player.castleLoot)}`
        : '';

      const sixthStatusLine = player.awakenedBoss
        ? `\n・🔥 覚醒第6枠（対${MAP_LOCATIONS[player.awakenedBoss]?.name || player.awakenedBoss}）: ${player.sixthSlot ? getSlotItemInfo(player.sixthSlot).label : '未装填（空）'}`
        : '';

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`📋【ガルガン軍 シンジ班：陣況報告】
所属: 魔王軍最高幹部 ガルガン卿麾下
現在地: ${getCurrentLocationName(player)}${castleBagLine}
戦域進捗: ${currentTarget}
次回行動予約: 『${locName}』

【本陣設備（${getBaseName(player)}）】
・🛡️ 防壁: Lv${player.baseWallLevel}/3 (破損率 ${(getBossBreakRate(player) * 100).toFixed(0)}%)
・⛏️ 武器庫: Lv${player.baseArmoryLevel}/3 (保管上限 各${cap}個)
・🔥 過負荷炉: Lv${player.baseFurnaceLevel || 0}/2 (6枠覚醒率 ${(getOverloadAwakenRate(player) * 100).toFixed(0)}%)

【キメラ主武装】
${player.weapon} [${total}/5枠]
・⛏️ 鋼: ${s.steel}枠 | 🛡️ 板: ${s.plate}枠 | 🧨 火: ${s.powder}枠 | 🔮 石: ${s.stone}枠${sixthStatusLine}

【実効戦闘能力】
・部隊HP: ${player.hp} / ${stats.maxHp}
・攻撃力: ${stats.atk} | 防御力: ${stats.def}
・会心率: ${(stats.critRate * 100).toFixed(0)}% [背水時:${Math.min(100, (stats.critRate + 0.15) * 100).toFixed(0)}%]
・回避率: ${(stats.dodgeRate * 100).toFixed(0)}%
・吸血率: ${(stats.drainRate * 100).toFixed(0)}%

【手持ちの略奪資材】
・⛏️ 王国鋼: ${player.inventory['王国鋼']}/${cap}個
・🛡️ 装甲板: ${player.inventory['装甲板']}/${cap}個
・🧨 黒火薬: ${player.inventory['黒火薬']}/${cap}個
・🔮 魔導石: ${player.inventory['魔導石']}/${cap}個
・🍞 兵糧: ${player.inventory['兵糧']}/${getRationCap(player)}袋`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ★ 開発テスト用裏ワザ：素材マックス補充（他機能に一切干渉しない独立ブロック）
    } else if (userText === '素材マックス' || userText === '素材MAX' || userText === '裏ワザ') {
      const maxMat = Math.max(getMaterialCap(player), 15);
      const maxRat = Math.max(getRationCap(player), 30);
      player.inventory['王国鋼'] = maxMat;
      player.inventory['装甲板'] = maxMat;
      player.inventory['黒火薬'] = maxMat;
      player.inventory['魔導石'] = maxMat;
      player.inventory['兵糧'] = maxRat;
      allPlayers[userId] = player;
      await saveAllPlayers(allPlayers);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`💎【裏ワザ発動：全素材＆兵糧MAX補充完了！】
ガルガン卿の隠し倉庫から最高級物資をすべて運び込んだぞ！
・⛏️ 王国鋼: ${player.inventory['王国鋼']}個
・🛡️ 装甲板: ${player.inventory['装甲板']}個
・🧨 黒火薬: ${player.inventory['黒火薬']}個
・🔮 魔導石: ${player.inventory['魔導石']}個
・🍞 兵糧: ${player.inventory['兵糧']}袋

▼ 好きなだけ「🔨 鍛造」や「🏰 アジト強化」を試して進軍しろ！`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // J. デフォルト案内
    } else {
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `現在地は【${getCurrentLocationName(player)}】だ。下のボタンから次回定時の進軍先を選べ。`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🔥 魔王軍ガルガン軍・画像配信＆地勢型統合サーバー稼働中 (Port: ${PORT})`);
  console.log(`===================================================`);
});