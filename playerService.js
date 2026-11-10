import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { MAP_LOCATIONS } from './gameData.js';
import { getBaseName } from './battleEngine.js';

// ==========================================
// プレイヤーデータ永続化（完全独立セーブ ＆ ローカルバックアップ連動）
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
export const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (!supabase) {
  console.warn('⚠️ [警告] SUPABASE_URL または SUPABASE_ANON_KEY が未設定のためローカルファイル保存で動作します。');
} else {
  console.log('✅ Supabase 接続クライアント初期化完了');
}

const DB_FILE = path.resolve('players.json');

export function loadLocalPlayers() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    console.error('ローカルデータ読み込みエラー:', err);
    return {};
  }
}

export function saveLocalPlayers(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('ローカルデータ保存エラー:', err);
  }
}

export function createInitialPlayer(userId, displayName = 'シンジ') {
  const safeName = (displayName && typeof displayName === 'string' && displayName.trim())
    ? displayName.trim()
    : 'シンジ';

  return {
    userId,
    name: `${safeName}班`,
    leader: safeName,
    weapon: '無骨なキメラ断頭斧',
    baseHp: 100,
    baseAtk: 24,
    baseDef: 12,
    hp: 100,
    slots: { steel: 2, plate: 2, powder: 1, stone: 0 },
    awakenedBoss: null,
    sixthSlot: null,
    chapter: 1,
    ch1Step: 0,
    ch2Step: 0,
    ch3Step: 0,
    currentLocation: 'アジト',
    baseWallLevel: 1,
    baseArmoryLevel: 1,
    baseFurnaceLevel: 0,
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
    castleFloor: 0,
    castleLoot: [],
    reservedLocation: null,
    inventory: {
      '王国鋼': 2,
      '装甲板': 2,
      '黒火薬': 1,
      '魔導石': 0,
      '兵糧': 3,
    },
  };
}

export function normalizePlayer(p, userId) {
  p.userId = userId;
  p.baseHp = 100;
  p.baseAtk = 24;
  p.baseDef = 12;
  if (!p.leader) p.leader = 'シンジ';
  if (!p.name) p.name = `${p.leader}班`;
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

function rowToPlayer(row) {
  const uid = row.line_user_id;
  const raw = row.inventory;
  let p;
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

export async function loadPlayer(userId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('line_user_id', userId)
        .maybeSingle();
      if (error) {
        console.error(`Supabase 個別読み込みエラー (${userId}):`, error.message);
      } else if (data) {
        return rowToPlayer(data);
      }
    } catch (err) {
      console.error('Supabase 通信例外(loadPlayer):', err);
    }
  }
  const localData = loadLocalPlayers();
  if (localData[userId]) {
    return normalizePlayer(localData[userId], userId);
  }
  return null;
}

export async function savePlayer(player) {
  if (!player || !player.userId) return;
  const localData = loadLocalPlayers();
  localData[player.userId] = player;
  saveLocalPlayers(localData);
  if (!supabase) return;
  try {
    const row = {
      line_user_id: player.userId,
      hp: player.hp ?? 100,
      max_hp: player.baseHp ?? 100,
      current_stage: player.currentLocation || 'アジト',
      inventory: player,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('players')
      .upsert([row], { onConflict: 'line_user_id' });
    if (error) {
      console.error(`Supabase 個別保存(Upsert)エラー (${player.userId}):`, error.message);
    }
  } catch (err) {
    console.error('Supabase 通信例外(savePlayer):', err);
  }
}

export async function getOrCreatePlayer(userId, displayName = null) {
  let player = await loadPlayer(userId);
  if (!player) {
    player = createInitialPlayer(userId, displayName || 'シンジ');
  } else if (displayName && typeof displayName === 'string' && displayName.trim()) {
    const safeName = displayName.trim();
    player.leader = safeName;
    player.name = `${safeName}班`;
  }
  player = normalizePlayer(player, userId);
  await savePlayer(player);
  return { player };
}

export async function getAllPlayerIds() {
  const idSet = new Set();
  const localData = loadLocalPlayers();
  for (const uid of Object.keys(localData)) {
    idSet.add(uid);
  }
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('players')
        .select('line_user_id');
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          if (row.line_user_id) idSet.add(row.line_user_id);
        }
      }
    } catch (err) {
      console.error('Supabase 全ID取得例外:', err);
    }
  }
  return Array.from(idSet);
}

export function getSlotItemInfo(slotKey) {
  const map = {
    steel: { item: '王国鋼', label: '⛏️王国鋼(攻+7/防-2)' },
    plate: { item: '装甲板', label: '🛡️装甲板(防+6/攻-2)' },
    powder: { item: '黒火薬', label: '🧨黒火薬(会心+13%/回避+7%)' },
    stone: { item: '魔導石', label: '🔮魔導石(攻+3/吸血+20%/HP-6%)' },
  };
  return map[slotKey] || null;
}

export function clearAwakenedSixthSlot(player, returnUnusedMaterial = true) {
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

export function getCurrentLocationName(player) {
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

export function getRetreatLocation(locKey) {
  const retreatMap = {
    '検問所': '渓谷',
    '前哨砦': '街道',
    '要塞門': '前哨砦',
    '渓谷': 'アジト',
    '街道': 'アジト',
    '工房跡': '礼拝堂',
    '大聖堂': '工房跡',
    '大霊廟': '礼拝堂',
    'ヴァルハイト城': '跳ね橋',
    '跳ね橋': '兵站所',
    '礼拝堂': '農村',
    '農村': 'アジト',
    '兵站所': 'アジト',
    '遠征軍総本陣': '回廊関門',
    '回廊関門': '前線宿営地',
    '前線宿営地': '中立交易区',
    '中立交易区': 'アジト',
    '補給工廠': 'アジト',
  };
  return retreatMap[locKey] || 'アジト';
}

export function getReservedDisplayName(reservedLocation) {
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

export function getMaterialCap(player) {
  const lv = player.baseArmoryLevel || 1;
  return lv * 5;
}

export function getRationCap(player) {
  const lv = player.baseArmoryLevel || 1;
  return lv * 10;
}

export function addLootWithCap(player, itemName, count) {
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

export function formatLootList(lootArray) {
  if (!lootArray || lootArray.length === 0) return 'なし';
  const iconMap = {
    '王国鋼': '⛏️',
    '装甲板': '🛡️',
    '黒火薬': '🧨',
    '魔導石': '🔮',
    '兵糧': '🍞',
  };
  const summary = {};
  for (const entry of lootArray) {
    summary[entry.item] = (summary[entry.item] || 0) + entry.count;
  }
  return Object.entries(summary)
    .map(([item, count]) => `${iconMap[item] || '🎁'}${item}×${count}`)
    .join(' / ');
}