import fs from 'fs';
import path from 'path';
import { getTotalSlots } from './battleEngine.js';

// ==========================================
// UI生成（QuickReplyボタン・地図画像URL解決）モジュール
// ==========================================
export function makeQuickReply(items) {
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

export function resolveMapImageUrl(player, req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const baseUrl = process.env.BASE_URL || (host ? `https://${host}` : '');
  if (!baseUrl || !baseUrl.startsWith('https://')) return null;

  const isCh3 = player.chapter >= 3 || player.ch2Step >= 2;
  const isCh2 = !isCh3 && (player.chapter >= 2 || player.ch1Step >= 3);

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

export function getSmartButtons(player) {
  if (player.reservedLocation) {
    return [];
  }

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

  if (isCh3) {
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

  if (cur !== 'アジト') {
    buttons.push({ label: '⛺ アジトへ帰還(略奪&全快)', text: '出撃：帰還' });
  } else {
    buttons.push({ label: '🏰 アジト強化', text: 'アジト強化' });
  }

  return buttons;
}

export function getForgeButtons(player) {
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

export function getBaseUpgradeButtons(player) {
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