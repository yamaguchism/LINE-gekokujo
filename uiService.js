import fs from 'fs';
import path from 'path';
import { getTotalSlots } from './battleEngine.js';
import { MAP_LOCATIONS, TRUMP_ITEMS, isBossGateCleared } from './gameData.js';

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

/**
 * プレイヤーが現在滞在している戦線（1:黒鉄の峡谷 / 2:聖涙川の教会平原 / 3:覇権の万魔中央回廊）を返す
 */
export function getActiveRegion(player) {
  const cur = player.currentLocation || 'アジト';
  if (cur !== 'アジト' && MAP_LOCATIONS[cur] && MAP_LOCATIONS[cur].chapter >= 1) {
    return MAP_LOCATIONS[cur].chapter;
  }
  if (cur === 'アジト' && [1, 2, 3].includes(player.selectedRegion)) {
    return player.selectedRegion;
  }
  if (player.currentBase === '廃砦') return 1;
  if (player.currentBase === '要塞門') return (player.ch1Step >= 3 || player.chapter >= 2) ? 2 : 1;
  if (player.currentBase === '大聖堂' || player.currentBase === '総本陣') return 3;

  if (player.chapter >= 3 || player.ch2Step >= 2) return 3;
  if (player.chapter >= 2 || player.ch1Step >= 3) return 2;
  return 1;
}

export function resolveMapImageUrl(player, req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const baseUrl = process.env.BASE_URL || (host ? `https://${host}` : '');
  if (!baseUrl || !baseUrl.startsWith('https://')) return null;

  const region = getActiveRegion(player);

  const candidates = [];
  if (region === 3) {
    candidates.push('chapter3_world_map.jpg', 'chapter3_map.jpg', 'chapter3_world_map.png', 'chapter3_map.png');
  } else if (region === 2) {
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

export function getBossTrumpConfirmButtons(locKey, trumpKey) {
  const t = TRUMP_ITEMS[trumpKey];
  const useLabel = t ? `${t.icon} ${t.name}を使う` : '🃏 切り札を使う';
  return [
    { label: useLabel, text: `切り札出撃：${locKey}：ON` },
    { label: '⚔️ 切り札を温存して挑む', text: `切り札出撃：${locKey}：OFF` },
    { label: '↩️ 進軍先を選び直す', text: '行動変更' },
  ];
}

export function getSmartButtons(player, forceShow = false) {
  // 1. 幕間劇（魔王城・王都）が保留中の場合は必ず単独ボタンでロックする
  if (player.pendingFactionStory) {
    return [
      { label: '🍷 魔王城の反応を見る', text: '幕間劇を見る' },
    ];
  }
  if (player.pendingKingdomStory) {
    return [
      { label: '👑 王都の密談を見る', text: '王都の密談を見る' },
    ];
  }

  if (player.reservedLocation && !forceShow) {
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
  const unlockedCh3 = player.chapter >= 3 || player.ch2Step >= 2;
  const unlockedCh2 = unlockedCh3 || player.chapter >= 2 || player.ch1Step >= 3;
  const cur = player.currentLocation || 'アジト';

  // ==========================================
  // A. 各アジト滞在時（境界アジトは2段階戦線選択）
  // ==========================================
  if (cur === 'アジト') {
    const base = player.currentBase || (unlockedCh3 ? '大聖堂' : (unlockedCh2 ? '要塞門' : '廃砦'));

    if (base === '総本陣' && unlockedCh3) {
      // 【遠征軍総本陣（最奥アジト）】：隣接戦線は第3戦線のみのため直接展開
      buttons.push({ label: '⚔️ 回廊関門へ移動(占領下)', text: '出撃：回廊関門' });
      buttons.push({ label: '🍷 交易区へ進軍(兵糧×2・石)', text: '出撃：中立交易区' });
      buttons.push({ label: '⚒️ 補給工廠へ進軍(板・鋼)', text: '出撃：補給工廠' });
      buttons.push({ label: '🌙 遠征：交易区➔宿営地(2連)', text: '遠征：中立交易区>前線宿営地' });
      buttons.push({ label: '🌙 遠征：工廠➔宿営地(2連)', text: '遠征：補給工廠>前線宿営地' });
      buttons.push({ label: '🏰 アジト強化', text: 'アジト強化' });

    } else if (base === '大聖堂' && unlockedCh3) {
      // 【大聖堂アジト（第2・第3戦線の境界）】
      if (player.selectedRegion === 3) {
        buttons.push({ label: '🍷 交易区へ進軍(兵糧×2・石)', text: '出撃：中立交易区' });
        buttons.push({ label: '⚒️ 補給工廠へ進軍(板・鋼)', text: '出撃：補給工廠' });
        buttons.push({ label: '🌙 遠征：交易区➔宿営地(2連)', text: '遠征：中立交易区>前線宿営地' });
        buttons.push({ label: '🌙 遠征：工廠➔宿営地(2連)', text: '遠征：補給工廠>前線宿営地' });
        buttons.push({ label: '↩️ 戦線を選び直す', text: '戦線を選び直す' });
      } else if (player.selectedRegion === 2) {
        buttons.push({ label: '🧪 工房跡へ移動(占領下)', text: '出撃：工房跡' });
        buttons.push({ label: '⛪ 礼拝堂へ移動(魔導石・火)', text: '出撃：礼拝堂' });
        buttons.push({ label: '🌾 農村へ移動(兵糧×2・鋼)', text: '出撃：農村' });
        buttons.push({ label: '⚒️ 兵站所へ移動(板・鋼)', text: '出撃：兵站所' });
        buttons.push({ label: '↩️ 戦線を選び直す', text: '戦線を選び直す' });
      } else {
        // 第1段階：隣接する2つの戦線名を表示
        buttons.push({ label: '聖涙川の教会平原', text: '戦線選択：2' });
        buttons.push({ label: '覇権の万魔中央回廊', text: '戦線選択：3' });
        buttons.push({ label: '🏰 アジト強化', text: 'アジト強化' });
      }

    } else if (base === '要塞門' && unlockedCh2) {
      // 【要塞門アジト（第1・第2戦線の境界）】
      if (player.selectedRegion === 2) {
        buttons.push({ label: '🌾 農村へ進軍(兵糧×2・鋼)', text: '出撃：農村' });
        buttons.push({ label: '⚒️ 兵站所へ進軍(板・鋼)', text: '出撃：兵站所' });
        buttons.push({ label: '🌙 遠征：農村➔礼拝堂(2連)', text: '遠征：農村>礼拝堂' });
        buttons.push({ label: '🌙 遠征：兵站所➔跳ね橋(2連)', text: '遠征：兵站所>跳ね橋' });
        buttons.push({ label: '↩️ 戦線を選び直す', text: '戦線を選び直す' });
      } else if (player.selectedRegion === 1) {
        buttons.push({ label: '🛡️ 前哨砦へ移動(占領下)', text: '出撃：前哨砦' });
        buttons.push({ label: '⛏️ 渓谷（鋼・板略奪）', text: '出撃：渓谷' });
        buttons.push({ label: '🍞 街道（火薬・兵糧×2）', text: '出撃：街道' });
        buttons.push({ label: '🌙 遠征：渓谷➔街道(2連)', text: '遠征：渓谷>街道' });
        buttons.push({ label: '↩️ 戦線を選び直す', text: '戦線を選び直す' });
      } else {
        // 第1段階：隣接する2つの戦線名を表示
        buttons.push({ label: '黒鉄の峡谷地帯', text: '戦線選択：1' });
        buttons.push({ label: '聖涙川の教会平原', text: '戦線選択：2' });
        buttons.push({ label: '🏰 アジト強化', text: 'アジト強化' });
      }

    } else {
      // 【荒れ野の廃砦（本拠地）】：黒鉄の峡谷地帯への出撃 ＋ 滞在コマンド
      buttons.push({ label: '⛏️ 渓谷（鋼・板略奪）', text: '出撃：渓谷' });
      buttons.push({ label: '🍞 街道（火薬・兵糧×2）', text: '出撃：街道' });

      if (!isBossGateCleared(player, '検問所')) {
        buttons.push({ label: '⚔️ 検問所（ガルシア）', text: '出撃：検問所' });
      } else if (!isBossGateCleared(player, '前哨砦')) {
        buttons.push({ label: '🛡️ 前哨砦（バルツ）', text: '出撃：前哨砦' });
        buttons.push({ label: '⚔️ 検問所へ移動(占領下)', text: '出撃：検問所' });
      } else if (!isBossGateCleared(player, '要塞門')) {
        buttons.push({ label: '🏰 要塞門（ロシュ）', text: '出撃：要塞門' });
        buttons.push({ label: '🛡️ 前哨砦へ移動(占領下)', text: '出撃：前哨砦' });
      } else {
        buttons.push({ label: '⚔️ 検問所へ移動(占領下)', text: '出撃：検問所' });
        buttons.push({ label: '🛡️ 前哨砦へ移動(占領下)', text: '出撃：前哨砦' });
      }

      buttons.push({ label: '🌙 遠征：渓谷➔街道(2連)', text: '遠征：渓谷>街道' });
      buttons.push({ label: '⛺ 廃砦に滞在（見回り・休息）', text: '滞在_廃砦' });
      buttons.push({ label: '🏰 アジト強化', text: 'アジト強化' });
    }

  // ==========================================
  // B. 前線拠点滞在時（現在地の戦線に応じて表示）
  // ==========================================
  } else {
    const locChapter = MAP_LOCATIONS[cur]?.chapter || getActiveRegion(player);

    if (locChapter === 3) {
      if (cur === '中立交易区') {
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
        if (isBossGateCleared(player, '回廊関門')) {
          buttons.push({ label: '⚔️ 回廊関門へ移動(占領下)', text: '出撃：回廊関門' });
        } else {
          buttons.push({ label: '⚔️ 回廊関門へ進軍(中ボス)', text: '出撃：回廊関門' });
        }
        buttons.push({ label: '💣 前線宿営地を継続略奪', text: '出撃：前線宿営地' });
        buttons.push({ label: '🍷 交易区へ後退(兵糧×2・石)', text: '出撃：中立交易区' });
        buttons.push({ label: '⚒️ 補給工廠へ後退(板・鋼)', text: '出撃：補給工廠' });

      } else if (cur === '回廊関門') {
        if (player.ch3Step >= 1 || isBossGateCleared(player, '回廊関門')) {
          if (isBossGateCleared(player, '遠征軍総本陣')) {
            buttons.push({ label: '🏰 遠征軍総本陣へ移動(占領下)', text: '出撃：遠征軍総本陣' });
          } else {
            buttons.push({ label: '🏰 遠征軍総本陣へ(回廊大ボス)', text: '出撃：遠征軍総本陣' });
          }
        }
        if (isBossGateCleared(player, '回廊関門')) {
          buttons.push({ label: '💣 前線宿営地へ移動(火薬・鋼)', text: '出撃：前線宿営地' });
          buttons.push({ label: '⚔️ 回廊関門を巡回(占領下)', text: '出撃：回廊関門' });
        } else {
          buttons.push({ label: '⚔️ 回廊関門を討伐(アルバート)', text: '出撃：回廊関門' });
          buttons.push({ label: '💣 前線宿営地へ後退(火薬・鋼)', text: '出撃：前線宿営地' });
        }

      } else if (cur === '遠征軍総本陣') {
        if (isBossGateCleared(player, '遠征軍総本陣')) {
          buttons.push({ label: '⚔️ 回廊関門へ移動(占領下)', text: '出撃：回廊関門' });
          buttons.push({ label: '🏰 遠征軍総本陣を巡回(占領下)', text: '出撃：遠征軍総本陣' });
        } else {
          buttons.push({ label: '🏰 遠征軍総本陣を討伐(元帥)', text: '出撃：遠征軍総本陣' });
          buttons.push({ label: '⚔️ 回廊関門へ後退', text: '出撃：回廊関門' });
        }

      } else {
        buttons.push({ label: '🍷 交易区へ進軍', text: '出撃：中立交易区' });
        buttons.push({ label: '⚒️ 補給工廠へ進軍', text: '出撃：補給工廠' });
      }

      // 第3戦線からのアジト帰還（大聖堂アジトへ）
      buttons.push({ label: '⛺ 大聖堂アジトへ帰還(略奪&全快)', text: '出撃：帰還_大聖堂' });

    } else if (locChapter === 2) {
      if (cur === '農村') {
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
        if (isBossGateCleared(player, '工房跡')) {
          buttons.push({ label: '🧪 工房跡へ移動(占領下)', text: '出撃：工房跡' });
        } else {
          buttons.push({ label: '🧪 工房跡へ進軍(中ボス)', text: '出撃：工房跡' });
        }
        buttons.push({ label: '💀 禁忌大霊廟へ突入(腕試し)', text: '出撃：大霊廟' });
        buttons.push({ label: '⛪ 礼拝堂を継続略奪', text: '出撃：礼拝堂' });
        buttons.push({ label: '🌾 農村へ移動(兵糧×2・鋼)', text: '出撃：農村' });
        buttons.push({ label: '🌙 遠征：農村➔兵站所(2連)', text: '遠征：農村>兵站所' });

      } else if (cur === '工房跡') {
        if ((player.ch2Step >= 1 || isBossGateCleared(player, '工房跡')) && !isBossGateCleared(player, '大聖堂')) {
          buttons.push({ label: '🏰 大聖堂へ進軍(平原大ボス)', text: '出撃：大聖堂' });
        }
        if (isBossGateCleared(player, '工房跡')) {
          buttons.push({ label: '⛪ 礼拝堂へ移動(魔導石・火)', text: '出撃：礼拝堂' });
          buttons.push({ label: '🌾 農村へ移動(兵糧×2・鋼)', text: '出撃：農村' });
          buttons.push({ label: '🧪 工房跡を巡回(占領下)', text: '出撃：工房跡' });
        } else {
          buttons.push({ label: '🧪 工房跡を討伐(錬金術師)', text: '出撃：工房跡' });
          buttons.push({ label: '⛪ 礼拝堂へ後退(魔導石・火)', text: '出撃：礼拝堂' });
        }

      } else if (cur === '大聖堂') {
        if (isBossGateCleared(player, '大聖堂')) {
          buttons.push({ label: '🧪 工房跡へ移動(占領下)', text: '出撃：工房跡' });
          buttons.push({ label: '⛪ 礼拝堂へ移動(魔導石・火)', text: '出撃：礼拝堂' });
        } else {
          buttons.push({ label: '🏰 大聖堂を討伐(聖堂重騎士)', text: '出撃：大聖堂' });
          buttons.push({ label: '🧪 工房跡へ移動', text: '出撃：工房跡' });
        }

      } else if (cur === '大霊廟') {
        buttons.push({ label: '💀 大霊廟に再挑戦(神聖巨像)', text: '出撃：大霊廟' });
        buttons.push({ label: '⛪ 礼拝堂へ地上脱出', text: '出撃：礼拝堂' });

      } else {
        buttons.push({ label: '🌾 農村へ進軍', text: '出撃：農村' });
        buttons.push({ label: '⚒️ 兵站所へ進軍', text: '出撃：兵站所' });
      }

      // 第2戦線からのアジト帰還（大聖堂制圧済みなら前後の両アジトへ帰還可能）
      if (unlockedCh3) {
        buttons.push({ label: '⛺ 大聖堂アジトへ帰還(回廊側)', text: '出撃：帰還_大聖堂' });
        buttons.push({ label: '⛺ 要塞門アジトへ帰還(峡谷側)', text: '出撃：帰還_要塞門' });
      } else {
        buttons.push({ label: '⛺ 要塞門アジトへ帰還(略奪&全快)', text: '出撃：帰還_要塞門' });
      }

    } else {
      // 第1戦線（黒鉄の峡谷地帯）滞在時
      if (cur === '検問所') {
        if (isBossGateCleared(player, '前哨砦')) {
          buttons.push({ label: '🛡️ 前哨砦へ移動(占領下)', text: '出撃：前哨砦' });
        } else {
          buttons.push({ label: '🛡️ 前哨砦（バルツ）', text: '出撃：前哨砦' });
        }
        buttons.push({ label: '⛏️ 渓谷（鋼・板略奪）', text: '出撃：渓谷' });
        buttons.push({ label: '🍞 街道（火薬・兵糧×2）', text: '出撃：街道' });
        if (isBossGateCleared(player, '検問所')) {
          buttons.push({ label: '⚔️ 検問所を巡回(占領下)', text: '出撃：検問所' });
        } else {
          buttons.push({ label: '⚔️ 検問所（ガルシア）', text: '出撃：検問所' });
        }

      } else if (cur === '前哨砦') {
        if (!isBossGateCleared(player, '要塞門')) {
          buttons.push({ label: '🏰 要塞門（ロシュ）', text: '出撃：要塞門' });
        }
        if (isBossGateCleared(player, '検問所')) {
          buttons.push({ label: '⚔️ 検問所へ移動(占領下)', text: '出撃：検問所' });
        }
        buttons.push({ label: '⛏️ 渓谷（鋼・板略奪）', text: '出撃：渓谷' });
        buttons.push({ label: '🍞 街道（火薬・兵糧×2）', text: '出撃：街道' });
        if (isBossGateCleared(player, '前哨砦')) {
          buttons.push({ label: '🛡️ 前哨砦を巡回(占領下)', text: '出撃：前哨砦' });
        } else {
          buttons.push({ label: '🛡️ 前哨砦（バルツ）', text: '出撃：前哨砦' });
        }

      } else {
        buttons.push({ label: '⛏️ 渓谷（鋼・板略奪）', text: '出撃：渓谷' });
        buttons.push({ label: '🍞 街道（火薬・兵糧×2）', text: '出撃：街道' });

        if (!isBossGateCleared(player, '検問所')) {
          buttons.push({ label: '⚔️ 検問所（ガルシア）', text: '出撃：検問所' });
        } else if (!isBossGateCleared(player, '前哨砦')) {
          buttons.push({ label: '🛡️ 前哨砦（バルツ）', text: '出撃：前哨砦' });
          buttons.push({ label: '⚔️ 検問所へ移動(占領下)', text: '出撃：検問所' });
        } else if (!isBossGateCleared(player, '要塞門')) {
          buttons.push({ label: '🏰 要塞門（ロシュ）', text: '出撃：要塞門' });
          buttons.push({ label: '🛡️ 前哨砦へ移動(占領下)', text: '出撃：前哨砦' });
        } else {
          buttons.push({ label: '⚔️ 検問所へ移動(占領下)', text: '出撃：検問所' });
          buttons.push({ label: '🛡️ 前哨砦へ移動(占領下)', text: '出撃：前哨砦' });
        }

        if (cur === '街道') {
          buttons.push({ label: '🌙 遠征：渓谷➔街道(2連)', text: '遠征：渓谷>街道' });
        } else if (cur === '渓谷') {
          buttons.push({ label: '🌙 遠征：街道➔渓谷(2連)', text: '遠征：街道>渓谷' });
        }
      }

      // 第1戦線からのアジト帰還（要塞門制圧済みなら本拠地『荒れ野の廃砦』と『要塞門アジト』の両方へ帰還可能）
      if (unlockedCh2) {
        buttons.push({ label: '⛺ 荒れ野の廃砦へ帰還(本拠地)', text: '出撃：帰還_廃砦' });
        buttons.push({ label: '⛺ 要塞門アジトへ帰還(平原側)', text: '出撃：帰還_要塞門' });
      } else {
        buttons.push({ label: '⛺ アジトへ帰還(略奪&全快)', text: '出撃：帰還_廃砦' });
      }
    }
  }

  // 聖剣所持中はいつでも放棄できるシンプルな『剣を捨てる』ボタンを表示
  if (player.legendaryRelic && player.legendaryRelic.hasRelic) {
    buttons.push({ label: '🗡️ 剣を捨てる', text: '剣を捨てる' });
  }

  // ゲリラ拠点および戦線ボタンの装飾（専用ボタンは増やさず、予告中は ⏳、開戦中は ⚡ を先頭に付与）
  if (
    player.activeGuerilla &&
    ((player.activeGuerilla.waitTurns || 0) > 0 || player.activeGuerilla.remainingTurns > 0)
  ) {
    const g = player.activeGuerilla;
    const gLoc = g.location;
    const gChapter = MAP_LOCATIONS[gLoc]?.chapter;
    const isWaiting = (g.waitTurns || 0) > 0;
    const prefix = isWaiting ? '⏳' : '⚡';

    for (const btn of buttons) {
      if (
        btn.text === `出撃：${gLoc}` ||
        (gChapter && btn.text === `戦線選択：${gChapter}`)
      ) {
        if (!btn.label.startsWith('⏳') && !btn.label.startsWith('⚡')) {
          btn.label = `${prefix}${btn.label}`;
        }
      }
    }
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