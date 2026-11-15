import {
    MAP_LOCATIONS,
    DEFENSE_ENEMIES,
    TRUMP_ITEMS,
    GUERRILLA_RAID_TYPES,
    getGuerrillaEnemy,
  } from './gameData.js';
  import {
    getBaseName,
    getOverloadAwakenRate,
    tryBreakSlotMaterial,
    getCounterTrumpForBoss,
    calculateEffectiveStats,
    simulateBattle,
  } from './battleEngine.js';
  import { generateRaidNarrative, generateFactionReaction } from './aiService.js';
  import {
    getOrCreatePlayer,
    savePlayer,
    getAllPlayerIds,
    getSlotItemInfo,
    getTrumpItemDisplay,
    clearAwakenedSixthSlot,
    getCurrentLocationName,
    getRetreatLocation,
    addLootWithCap,
    formatLootList,
  } from './playerService.js';
  import { makeQuickReply, getSmartButtons } from './uiService.js';
  
  /**
   * Gemini API 連続呼び出し時のレート制限（429）衝突を回避する小休止ヘルパー
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  
  /**
   * 幕間劇（第2幕）が保留中の場合、QuickReplyの先頭に閲覧ボタンを差し込むヘルパー
   */
  function buildRaidQuickReply(player) {
    const baseButtons = getSmartButtons(player);
    if (player.pendingFactionStory) {
      return makeQuickReply([
        { label: '🍷 魔王城の反応を見る', text: '幕間劇を見る' },
        ...baseButtons,
      ].slice(0, 13));
    }
    return makeQuickReply(baseButtons);
  }
  
  /**
   * 現在時刻（JST）を基準に、今後の定時進軍枠（8:00 / 12:00 / 20:00）のリストを返す
   */
  export function getUpcomingScheduleSlots(count = 6) {
    const baseUtcMs = Date.now() + 10 * 60 * 1000;
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const baseJstDate = new Date(baseUtcMs + jstOffsetMs);
  
    const baseYear = baseJstDate.getUTCFullYear();
    const baseMonth = baseJstDate.getUTCMonth();
    const baseDay = baseJstDate.getUTCDate();
  
    const scheduleHours = [8, 12, 20];
    const slots = [];
  
    for (let dayOffset = 0; dayOffset <= 4 && slots.length < count; dayOffset++) {
      for (const hr of scheduleHours) {
        const slotJstMs = Date.UTC(baseYear, baseMonth, baseDay + dayOffset, hr, 0, 0);
        if (slotJstMs > baseUtcMs + jstOffsetMs) {
          const d = new Date(slotJstMs);
          const m = d.getUTCMonth() + 1;
          const day = d.getUTCDate();
          const h = d.getUTCHours();
          slots.push({
            fullLabel: `${m}/${day} ${h}:00`,
            hourLabel: `${h}:00`,
          });
          if (slots.length >= count) break;
        }
      }
    }
    return slots;
  }
  
  /**
   * 現在の章の通常略奪エリア一覧を返す
   */
  function getChapterNormalLocations(player) {
    const ch = (player.chapter >= 3 || player.ch2Step >= 2)
      ? 3
      : ((player.chapter >= 2 || player.ch1Step >= 3) ? 2 : 1);
  
    return Object.keys(MAP_LOCATIONS).filter((k) => {
      const loc = MAP_LOCATIONS[k];
      return loc.chapter === ch && !loc.isBoss && !loc.isStopper;
    });
  }
  
  /**
   * ゲリラ未発生時に25%の確率で新規ゲリラを発生させる
   * 完全ランダム型：パターンB（事前予告型 70%）／ パターンA（即開戦型 30%）
   */
  export function trySpawnGuerrillaRaid(player, forceSpawn = false, forcedPattern = null) {
    if (
      player.activeGuerilla &&
      ((player.activeGuerilla.waitTurns || 0) > 0 || player.activeGuerilla.remainingTurns > 0)
    ) {
      return null;
    }
  
    if (!forceSpawn && Math.random() >= 0.25) {
      return null;
    }
  
    const candidateLocs = getChapterNormalLocations(player);
    if (candidateLocs.length === 0) return null;
  
    const chosenLoc = candidateLocs[Math.floor(Math.random() * candidateLocs.length)];
    const allTypes = ['oil_cloth', 'acid_bottle', 'ash_bag'];
    let chosenType = null;
  
    if (player.revengeTarget && allTypes.includes(player.revengeTarget)) {
      if (Math.random() < 0.65) {
        chosenType = player.revengeTarget;
        // お目当てが実際に出現した時点で補正フラグを消去（チャンス1回提供完了）
        player.revengeTarget = null;
      } else {
        const others = allTypes.filter((t) => t !== player.revengeTarget);
        chosenType = others[Math.floor(Math.random() * others.length)];
      }
    } else {
      chosenType = allTypes[Math.floor(Math.random() * allTypes.length)];
    }
  
    // 完全ランダム振り分け（パターンB：事前予告 70% / パターンA：即開戦 30%）
    let isPatternB = Math.random() < 0.70;
    if (forcedPattern === 'A') isPatternB = false;
    if (forcedPattern === 'B') isPatternB = true;
  
    const slots = getUpcomingScheduleSlots(5);
    const startSlot = isPatternB ? (slots[1] || slots[0]) : slots[0];
    const endSlot = isPatternB ? (slots[3] || slots[2]) : (slots[2] || slots[1]);
  
    const startTimeText = startSlot ? startSlot.fullLabel : '次回定時';
    const endTimeText = endSlot ? endSlot.fullLabel : '翌定時';
    const startHourText = startSlot ? startSlot.hourLabel : '次回';
  
    player.activeGuerilla = {
      location: chosenLoc,
      typeKey: chosenType,
      pattern: isPatternB ? 'B' : 'A',
      waitTurns: isPatternB ? 1 : 0,
      remainingTurns: 3,
      startTimeText,
      endTimeText,
      startHourText,
    };
  
    const locName = MAP_LOCATIONS[chosenLoc]?.name || chosenLoc;
    const gType = GUERRILLA_RAID_TYPES[chosenType];
    const tItem = TRUMP_ITEMS[chosenType];
  
    if (isPatternB) {
      return `🦅【密偵の急報】『${locName}』を${gType.factionName}が襲撃する計画を察知！\n⏰ 襲撃予定：${startTimeText} 〜 ${endTimeText}（戦利品：${tItem.icon}${tItem.name}）`;
    }
    return `🦅【密偵の急報】『${locName}』にて${gType.factionName}が交戦を開始！\n⏰ 出現期間：${startTimeText} 〜 ${endTimeText}（戦利品：${tItem.icon}${tItem.name}）`;
  }
  
  /**
   * ゲリラ対象外の行動を取った際、待機枠または残り有効枠を1進める
   */
  function tickActiveGuerrilla(player) {
    if (!player.activeGuerilla) return '';
    const g = player.activeGuerilla;
    const stayLoc = MAP_LOCATIONS[g.location]?.name || g.location;
    const gType = GUERRILLA_RAID_TYPES[g.typeKey];
    const tItem = TRUMP_ITEMS[g.typeKey];
    const timeRange = (g.startTimeText && g.endTimeText)
      ? `${g.startTimeText} 〜 ${g.endTimeText}`
      : '現在出現中';
  
    // パターンBの開戦待ち（予告期間）の消化
    if ((g.waitTurns || 0) > 0) {
      g.waitTurns -= 1;
      if (g.waitTurns <= 0) {
        return `\n⚡【襲撃開始！】予告されていた『${stayLoc}』に${gType ? gType.factionName : '敵襲撃部隊'}が出現したぞ！（期間：${timeRange} / 戦利品：${tItem ? `${tItem.icon}${tItem.name}` : '切り札'}）`;
      }
      return `\n⏳【襲撃予告】『${stayLoc}』への${gType ? gType.factionName : '敵部隊'}襲撃は【${timeRange}】だ（戦利品：${tItem ? `${tItem.icon}${tItem.name}` : '切り札'}）`;
    }
  
    // 開戦後の有効期間カウントダウン
    g.remainingTurns -= 1;
    if (g.remainingTurns <= 0) {
      player.activeGuerilla = null;
      return `\n（※『${stayLoc}』で目撃されていた襲撃部隊は期間を終えて撤収したようだ）`;
    }
    return `\n⚡【襲撃発生中】『${stayLoc}』に${gType ? gType.factionName : '敵部隊'}が駐留中！（期間：${timeRange} / 戦利品：${tItem ? `${tItem.icon}${tItem.name}` : '切り札'}）`;
  }
  
  // ==========================================
  // 1. 特殊作戦①：ヴァルハイト城（3連撃チキンレースローグ）処理
  // ==========================================
  export async function executeCastleRogueStep(lineClient, userId, player) {
    clearAwakenedSixthSlot(player, true);
    player.pendingFactionStory = null;
  
    const castleData = MAP_LOCATIONS['ヴァルハイト城'];
    const nextFloorNum = (player.castleFloor || 0) + 1;
    const floorInfo = castleData.castleFloors[nextFloorNum] || castleData.castleFloors[1];
    const enemyPool = floorInfo.enemies || [floorInfo.enemy];
    const enemy = enemyPool[Math.floor(Math.random() * enemyPool.length)];
  
    const battleData = simulateBattle(player, enemy, 'ヴァルハイト城');
    player.reservedLocation = null;
  
    const guerrillaNote = tickActiveGuerrilla(player);
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
  
      if (nextFloorNum < 3) {
        story = await generateRaidNarrative(
          `ヴァルハイト城・${floorInfo.floorName}`,
          battleData,
          player,
          enemy,
          floorLootText,
          {
            locDesc: castleData.desc,
            sceneType: 'CASTLE',
          }
        );
  
        player.castleFloor = nextFloorNum;
        const nextFloorTitle = castleData.castleFloors[nextFloorNum + 1].floorName;
  
        messageText =
  `🏯【城郭強襲戦記：${floorInfo.floorName}】
  
  ${story}${guerrillaNote}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：ヴァルハイト城（第${nextFloorNum}層制圧）
  ❤️ 部隊HP：${player.hp} / ${battleData.stats.maxHp}（※城内での兵糧回復は不可）
  🎒 戦利品袋（未確定）：${totalBagText}
  ━━━━━━━━━━━━━━━━━━
  ⚠️【決断の時】
  ここで『⛺ 城外へ脱出』すれば袋の物資はすべて持ち帰れるが、残HPのまま『${nextFloorTitle}』へ突撃して敗れれば袋は【全没収】となる。行くか、引くか！？`;
      } else {
        const prevCastleWins = (player.bossWins && player.bossWins['ヴァルハイト城']) || 0;
        const isFirstCastleWin = prevCastleWins === 0;
        player.bossWins['ヴァルハイト城'] = prevCastleWins + 1;
  
        const addedResults = [];
        let anyCapped = false;
        for (const lootEntry of player.castleLoot) {
          const res = addLootWithCap(player, lootEntry.item, lootEntry.count);
          if (res.added > 0) addedResults.push({ item: lootEntry.item, count: res.added });
          if (res.capped) anyCapped = true;
        }
        const finalSecuredText = formatLootList(addedResults);
        const capWarn = anyCapped ? `（※一部物資は武器庫上限のため破棄）` : '';
  
        player.castleFloor = 0;
        player.castleLoot = [];
        player.currentLocation = 'アジト';
        player.hp = battleData.stats.maxHp;
  
        story = await generateRaidNarrative(
          `ヴァルハイト城・${floorInfo.floorName}`,
          battleData,
          player,
          enemy,
          floorLootText,
          { locDesc: castleData.desc, sceneType: 'CASTLE' }
        );
  
        if (isFirstCastleWin) {
          await sleep(800);
          player.pendingFactionStory = await generateFactionReaction(
            `ヴァルハイト城・${floorInfo.floorName}`,
            battleData,
            player,
            enemy
          );
        }
  
        const factionHook = isFirstCastleWin
          ? `\n🍷【魔王城・作戦会議室】難攻不落のヴァルハイト城陥落の報に、魔王城の上層部3派閥が激しく動揺しているようだ……！（▼下の『🍷 魔王城の反応を見る』から覗き見よ）`
          : '';
  
        messageText =
  `👑【城郭強襲戦記：ヴァルハイト城・天守閣完全制覇】
  
  ${story}
  
  🔥 魔軍卿 ガルガン：
  「ガハハハ！！ 天守閣のてっぺんまで綺麗にぶんどってきやがったな${player.name}！ 偽善者どもの泣きっ面が最高に愉快だぜ！！」${factionHook}${guerrillaNote}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}
  ❤️ 部隊HP：${player.hp} / ${battleData.stats.maxHp}（凱旋100%全快！）
  🎒 確定戦利品：${finalSecuredText}${capWarn}
  ━━━━━━━━━━━━━━━━━━`;
      }
    } else {
      const lostBagText = formatLootList(player.castleLoot);
      player.castleFloor = 0;
      player.castleLoot = [];
      player.hp = 1;
      player.currentLocation = getRetreatLocation('ヴァルハイト城');
  
      story = await generateRaidNarrative(
        `ヴァルハイト城・${floorInfo.floorName}`,
        battleData,
        player,
        enemy,
        '全没収',
        {
          locDesc: castleData.desc,
          sceneType: 'CASTLE',
        }
      );
  
      messageText =
  `💀【城郭強襲戦記：${floorInfo.floorName}・敗走】
  
  ${story}
  
  💥 城内でかき集めていた戦利品袋【 ${lostBagText} 】はすべて散逸したが、キメラ武器のスロットは無傷のまま城門前の『🌉 ヴァルハイト跳ね橋』へ踏みとどまった！
  ${battleData.hint}${guerrillaNote}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}（1歩後退）
  ❤️ 部隊HP：1 / ${battleData.stats.maxHp}（要「🍖 兵糧回復」）
  🎒 戦利品：全没収
  ━━━━━━━━━━━━━━━━━━`;
    }
  
    await savePlayer(player);
  
    try {
      await lineClient.pushMessage({
        to: userId,
        messages: [{
          type: 'text',
          text: messageText,
          quickReply: buildRaidQuickReply(player),
        }],
      });
    } catch (err) {
      console.error(`プッシュ送信エラー (${userId}):`, err);
    }
  }
  
  // ==========================================
  // 2. 特殊作戦②：夜間2地点連続略奪
  // ==========================================
  export async function executeTwoStepRaid(lineClient, userId, player, routeStr) {
    clearAwakenedSixthSlot(player, true);
    player.pendingFactionStory = null;
  
    const [step1Key, step2Key] = routeStr.split('>');
    const loc1 = MAP_LOCATIONS[step1Key];
    const loc2 = MAP_LOCATIONS[step2Key];
  
    player.reservedLocation = null;
  
    if (!loc1 || !loc2) return;
  
    const hadActiveGuerrillaBefore = Boolean(player.activeGuerilla);
    const guerrillaTickNote = tickActiveGuerrilla(player);
  
    const enemy1 = loc1.enemies[Math.floor(Math.random() * loc1.enemies.length)];
    const battle1 = simulateBattle(player, enemy1, step1Key);
    player.hp = battle1.finalPlayerHp;
  
    if (battle1.result !== 'WIN') {
      player.hp = 1;
      player.currentLocation = getRetreatLocation(step1Key);
  
      await savePlayer(player);
  
      const story1 = await generateRaidNarrative(loc1.name, battle1, player, enemy1, 'なし', {
        locDesc: loc1.desc,
        sceneType: 'RAID',
      });
  
      const failMsg =
  `🌙【夜間連続遠征記：${loc1.name}にて中断】
  
  ${story1}
  
  ${battle1.hint}${guerrillaTickNote}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}（第1地点より後退）
  ❤️ 部隊HP：1 / ${battle1.stats.maxHp}（要回復）
  🎒 戦利品：なし
  ━━━━━━━━━━━━━━━━━━`;
  
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
    let isCap1 = false;
    let rawDrop1 = '';
    const iconMap = { '王国鋼': '⛏️', '装甲板': '🛡️', '黒火薬': '🧨', '魔導石': '🔮', '兵糧': '🍞' };
  
    if (loc1.possibleLoot && loc1.possibleLoot.length > 0) {
      const drop1 = loc1.possibleLoot[Math.floor(Math.random() * loc1.possibleLoot.length)];
      rawDrop1 = drop1.item;
      const add1 = addLootWithCap(player, drop1.item, drop1.count);
      isCap1 = add1.capped;
      if (add1.added > 0) {
        loot1Text = `${iconMap[drop1.item] || '🎁'}${drop1.item}×${add1.added}${add1.capped ? '(上限到達)' : ''}`;
      } else {
        loot1Text = `${iconMap[drop1.item] || '🎁'}${drop1.item}（⚠️武器庫満杯のため破棄）`;
      }
    }
    player.currentLocation = step1Key;
  
    if (loc1.isStopper) {
      const spawnNotice = !hadActiveGuerrillaBefore ? trySpawnGuerrillaRaid(player) : null;
      const spawnLine = spawnNotice ? `\n\n${spawnNotice}` : guerrillaTickNote;
      await savePlayer(player);
      const story1 = await generateRaidNarrative(loc1.name, battle1, player, enemy1, loot1Text, {
        locDesc: loc1.desc,
        sceneType: 'RAID',
        isCapped: isCap1 && loot1Text.includes('破棄'),
        rawDropName: rawDrop1,
      });
      await lineClient.pushMessage({
        to: userId,
        messages: [{
          type: 'text',
          text:
  `🌙【夜間遠征記：重要拠点『${loc1.name}』制圧】
  
  ${story1}${spawnLine}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}
  ❤️ 部隊HP：${player.hp} / ${battle1.stats.maxHp}
  🎒 戦利品：${loot1Text}
  ━━━━━━━━━━━━━━━━━━`,
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
        autoHealLog = `🍖【幕間野営】焚き火を囲んで兵糧1袋を平らげ、部隊HPを100%全快（${player.hp}/${stats.maxHp}）して第2戦へ突入！（残兵糧:${player.inventory['兵糧']}袋）`;
      } else {
        autoHealLog = `⚠️【兵糧枯渇】手持ちの兵糧が0袋のため、傷を抱えたまま（HP:${player.hp}/${stats.maxHp}）第2地点『${loc2.name}』へ強行突入！`;
      }
    } else {
      autoHealLog = `✨【無傷進軍】かすり傷一つ負わぬまま（HP:${player.hp}/${stats.maxHp}）、勢いに乗って第2地点『${loc2.name}』へ突入！`;
    }
  
    const enemy2 = loc2.enemies[Math.floor(Math.random() * loc2.enemies.length)];
    const battle2 = simulateBattle(player, enemy2, step2Key);
    player.hp = battle2.finalPlayerHp;
  
    let loot2Text = 'なし';
    let isCap2 = false;
    let rawDrop2 = '';
    let step2Extra = '';
  
    if (battle2.result === 'WIN') {
      if (loc2.possibleLoot && loc2.possibleLoot.length > 0) {
        const drop2 = loc2.possibleLoot[Math.floor(Math.random() * loc2.possibleLoot.length)];
        rawDrop2 = drop2.item;
        const add2 = addLootWithCap(player, drop2.item, drop2.count);
        isCap2 = add2.capped;
        if (add2.added > 0) {
          loot2Text = `${iconMap[drop2.item] || '🎁'}${drop2.item}×${add2.added}${add2.capped ? '(上限到達)' : ''}`;
        } else {
          loot2Text = `${iconMap[drop2.item] || '🎁'}${drop2.item}（⚠️武器庫満杯のため破棄）`;
        }
      }
      player.currentLocation = step2Key;
  
      if (loc2.isDrawbridge) {
        step2Extra = `\n\n🔥 魔軍卿 ガルガン：\n「ガハハハ！ 跳ね橋の鉄鎖をぶっ千切ったな！ 目の前に口を開けた『🏯 ヴァルハイト城』へそのまま殴り込め${player.name}！！」`;
      }
    } else {
      player.hp = 1;
      player.currentLocation = step1Key;
      loot2Text = 'なし（第1地点へ1歩後退）';
      step2Extra = `\n\n${battle2.hint}`;
    }
  
    const spawnNotice = (!hadActiveGuerrillaBefore && battle2.result === 'WIN')
      ? trySpawnGuerrillaRaid(player)
      : null;
    const guerrillaFooter = spawnNotice ? `\n\n${spawnNotice}` : guerrillaTickNote;
  
    await savePlayer(player);
  
    const story1 = await generateRaidNarrative(loc1.name, battle1, player, enemy1, loot1Text, {
      locDesc: loc1.desc,
      sceneType: 'TWO_STEP',
      isCapped: isCap1 && loot1Text.includes('破棄'),
      rawDropName: rawDrop1,
    });
    await sleep(500);
    const story2 = await generateRaidNarrative(loc2.name, battle2, player, enemy2, loot2Text, {
      locDesc: loc2.desc,
      sceneType: 'TWO_STEP',
      isCapped: isCap2 && loot2Text.includes('破棄'),
      rawDropName: rawDrop2,
    });
  
    const combinedMessage =
  `🌙【夜間連続遠征記：${loc1.name} ➔ ${loc2.name}】
  
  ⚔️《第1幕：${loc1.name}》
  ${story1}
  
  ${autoHealLog}
  
  ⚔️《第2幕：${loc2.name}》
  ${story2}${step2Extra}${guerrillaFooter}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}
  ❤️ 部隊HP：${player.hp} / ${stats.maxHp}
  🎒 第1戦果：${loot1Text}
  🎒 第2戦果：${loot2Text}
  ━━━━━━━━━━━━━━━━━━`;
  
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
  // 3. 定時実行＆テスト即時決行エンジン
  // ==========================================
  export async function executeScheduledRaids(lineClient, targetUserId = null, forceDefense = false) {
    const userIds = targetUserId ? [targetUserId] : await getAllPlayerIds();
  
    for (const userId of userIds) {
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
        await executeCastleRogueStep(lineClient, userId, player);
        continue;
      }
  
      if (player.reservedLocation && player.reservedLocation.includes('>')) {
        await executeTwoStepRaid(lineClient, userId, player, player.reservedLocation);
        continue;
      }
  
      // 新規戦闘に入るため、前回の未読幕間劇があればクリアする
      player.pendingFactionStory = null;
  
      const currentChapter = (player.chapter >= 3 || player.ch2Step >= 2)
        ? 3
        : ((player.chapter >= 2 || player.ch1Step >= 3) ? 2 : 1);
      const defaultLoc = currentChapter === 3
        ? '中立交易区'
        : (currentChapter === 2 ? '農村' : '渓谷');
      const locKey = player.reservedLocation || (player.currentLocation !== 'アジト' ? player.currentLocation : defaultLoc);
      const locData = MAP_LOCATIONS[locKey] || MAP_LOCATIONS[defaultLoc];
  
      // 横取り奇襲戦の発火条件（開戦待ちwaitTurnsが0以下、かつ残り有効枠がある場合のみ）
      const isGuerrillaEncounter = Boolean(
        !forceDefense &&
        player.activeGuerilla &&
        (player.activeGuerilla.waitTurns || 0) <= 0 &&
        player.activeGuerilla.remainingTurns > 0 &&
        player.activeGuerilla.location === locKey
      );
  
      const triggerDefense = forceDefense || (!isGuerrillaEncounter && !locData.isBoss && !locData.isStopper && Math.random() < 0.15);
  
      // ----------------------------------------------------
      // A. 突発イベント：本陣アジト奇襲防衛戦
      // ----------------------------------------------------
      if (triggerDefense) {
        const defEnemy = DEFENSE_ENEMIES[Math.floor(Math.random() * DEFENSE_ENEMIES.length)];
        const baseName = getBaseName(player);
        const battleData = simulateBattle(player, defEnemy, '防衛戦', { isDefenseBattle: true });
  
        player.reservedLocation = null;
        player.useTrumpItem = false;
        player.currentLocation = 'アジト';
  
        let lootText = 'なし';
        let interludeText = '';
  
        if (battleData.result === 'WIN') {
          player.hp = battleData.stats.maxHp;
          const r1 = addLootWithCap(player, '王国鋼', 1);
          const r2 = addLootWithCap(player, '装甲板', 1);
          const r3 = addLootWithCap(player, '兵糧', 2);
          const parts = [];
          if (r1.added > 0) parts.push(`⛏️王国鋼×${r1.added}`);
          if (r2.added > 0) parts.push(`🛡️装甲板×${r2.added}`);
          if (r3.added > 0) parts.push(`🍞兵糧×${r3.added}`);
          lootText = parts.length > 0 ? parts.join(' / ') : '⚠️武器庫満杯のため全破棄';
  
          if (defEnemy.tauntLog) {
            interludeText = `\n\n${defEnemy.tauntLog}`;
          }
        } else {
          player.hp = 1;
          interludeText = `\n\n${battleData.hint}`;
        }
  
        const guerrillaTickNote = tickActiveGuerrilla(player);
        await savePlayer(player);
  
        const story = await generateRaidNarrative(`${baseName}`, battleData, player, defEnemy, lootText, {
          locDesc: `${player.name}の本陣『${baseName}』への敵奇襲部隊による強襲`,
          sceneType: 'DEFENSE',
        });
  
        const messageText =
  `🚨【緊急迎撃戦記：${baseName}防衛戦】
  
  ${story}${interludeText}${guerrillaTickNote}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}
  ❤️ 部隊HP：${player.hp} / ${battleData.stats.maxHp}${battleData.result === 'WIN' ? '（本陣全快！）' : '（重傷・要回復）'}
  🎒 鹵獲物資：${lootText}
  ━━━━━━━━━━━━━━━━━━`;
  
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
  
      // ----------------------------------------------------
      // A-2. 横取り奇襲戦（ゲリラ開戦中エリアへのカチ込み）
      // ----------------------------------------------------
      if (isGuerrillaEncounter) {
        let movedAwaySlotLostNotice = '';
        if (player.awakenedBoss && locKey !== player.awakenedBoss) {
          clearAwakenedSixthSlot(player, true);
          movedAwaySlotLostNotice = `\n（※別エリアへ移動したため、覚醒していた『第6スロット』は消滅した）`;
        }
  
        const gObj = player.activeGuerilla;
        const gTypeKey = gObj.typeKey;
        const gTypeInfo = GUERRILLA_RAID_TYPES[gTypeKey] || GUERRILLA_RAID_TYPES.acid_bottle;
        const trumpInfo = TRUMP_ITEMS[gTypeKey] || TRUMP_ITEMS.acid_bottle;
        const gEnemy = getGuerrillaEnemy(gTypeKey, currentChapter);
        const timeRange = (gObj.startTimeText && gObj.endTimeText)
          ? `${gObj.startTimeText} 〜 ${gObj.endTimeText}`
          : '現在出現中';
  
        const battleData = simulateBattle(player, gEnemy, locKey);
        player.hp = battleData.finalPlayerHp;
        player.reservedLocation = null;
        player.useTrumpItem = false;
  
        let lootText = '';
        let extraNotes = '';
  
        if (battleData.result === 'WIN') {
          player.currentLocation = locKey;
          player.activeGuerilla = null; // 勝利につきターゲット撤退・消滅
  
          // 現地素材の通常略奪も1個付与
          let normalDropStr = '';
          if (locData.possibleLoot && locData.possibleLoot.length > 0) {
            const dropObj = locData.possibleLoot[Math.floor(Math.random() * locData.possibleLoot.length)];
            const addRes = addLootWithCap(player, dropObj.item, dropObj.count);
            const iconMap = { '王国鋼': '⛏️', '装甲板': '🛡️', '黒火薬': '🧨', '魔導石': '🔮', '兵糧': '🍞' };
            if (addRes.added > 0) {
              normalDropStr = ` ＋ ${iconMap[dropObj.item] || '🎁'}${dropObj.item}×${addRes.added}`;
            }
          }
  
          // 切り札の獲得＆上書き（古い切り札は兵糧×1に変換）
          let overwriteNote = '';
          if (player.trumpItem) {
            const oldTrump = TRUMP_ITEMS[player.trumpItem];
            const rRation = addLootWithCap(player, '兵糧', 1);
            overwriteNote = `\n🔄（※所持していた『${oldTrump ? oldTrump.name : '旧切り札'}』を処分して🍞兵糧×${rRation.added}に変換し、新しい切り札で上書きした！）`;
          }
          player.trumpItem = gTypeKey;
  
          lootText = `${trumpInfo.icon}${trumpInfo.name}（切り札）${normalDropStr}`;
          extraNotes = `\n\n🔥【横取り成功！】${gTypeInfo.factionName}から対ボス切り札『${trumpInfo.icon}${trumpInfo.name}（${trumpInfo.shortDesc}）』を強奪した！${overwriteNote}${movedAwaySlotLostNotice}`;
        } else {
          player.hp = 1;
          player.currentLocation = getRetreatLocation(locKey);
          lootText = 'なし（返り討ち・後退）';
  
          player.activeGuerilla.remainingTurns -= 1;
          let remainNote = '';
          if (player.activeGuerilla.remainingTurns > 0) {
            remainNote = `\n⚡【再戦可能】${gTypeInfo.factionName}はまだ『${locData.name}』に留まっている！（出現期間：${timeRange}）`;
          } else {
            player.activeGuerilla = null;
            remainNote = `\n（※${gTypeInfo.factionName}は物資を回収して戦場から撤収した）`;
          }
          extraNotes = `\n\n${battleData.hint}${remainNote}${movedAwaySlotLostNotice}`;
        }
  
        await savePlayer(player);
  
        const story = await generateRaidNarrative(locData.name, battleData, player, gEnemy, lootText, {
          locDesc: `${locData.name}にて交戦中の『${gTypeInfo.factionName}』への横取り強襲`,
          sceneType: 'GUERRILLA',
        });
  
        const messageText =
  `⚡【横取り奇襲戦記：${locData.name}】
  
  ${story}${extraNotes}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}
  ❤️ 部隊HP：${player.hp} / ${battleData.stats.maxHp}${battleData.result !== 'WIN' ? '（瀕死・要「🍖 兵糧回復」）' : ''}
  🎒 強奪戦果：${lootText}
  🃏 所持切り札：${getTrumpItemDisplay(player)}
  ━━━━━━━━━━━━━━━━━━`;
  
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
  
      // ----------------------------------------------------
      // B. 通常略奪 ＆ 関門ボス戦 ＆ 帰還戦
      // ----------------------------------------------------
      let movedAwaySlotLostNotice = '';
      if (player.awakenedBoss && locKey !== player.awakenedBoss) {
        clearAwakenedSixthSlot(player, true);
        movedAwaySlotLostNotice = `\n（※別エリアへ移動したため、覚醒していた『第6スロット』は消滅した）`;
      }
  
      const usedSixthSlotKey = (player.awakenedBoss === locKey) ? player.sixthSlot : null;
      const usedSixthInfo = usedSixthSlotKey ? getSlotItemInfo(usedSixthSlotKey) : null;
  
      // ボス戦での切り札発動判定（雑魚戦では暴発させない安全装置付き）
      const activeTrumpKey = (locData.isBoss && player.trumpItem && player.useTrumpItem)
        ? player.trumpItem
        : null;
      const usedTrumpObj = activeTrumpKey ? TRUMP_ITEMS[activeTrumpKey] : null;
  
      const enemy = locData.enemies[Math.floor(Math.random() * locData.enemies.length)];
      const battleData = simulateBattle(player, enemy, locKey, { trumpItemKey: activeTrumpKey });
  
      if (usedSixthSlotKey) {
        player.sixthSlot = null;
      }
      if (activeTrumpKey) {
        player.trumpItem = null;
      }
      player.useTrumpItem = false;
  
      player.hp = battleData.finalPlayerHp;
      player.reservedLocation = null;
  
      // 既存のゲリラがあれば待機枠または残り枠を1進める
      const hadActiveGuerrillaBefore = Boolean(player.activeGuerilla);
      const guerrillaTickNote = tickActiveGuerrilla(player);
  
      let lootText = 'なし';
      let isCapped = false;
      let rawDropName = '';
      let interludeText = '';
      let shouldTriggerFactionReaction = false;
  
      if (battleData.result === 'WIN') {
        if (locData.isBoss) {
          player.awakenedBoss = null;
          player.sixthSlot = null;
          if (player.revengeTarget === getCounterTrumpForBoss(locKey, enemy)) {
            player.revengeTarget = null;
          }
        }
  
        if (locData.isBoss && usedSixthInfo) {
          lootText = `なし（🔥第6枠『${usedSixthInfo.item}』燃焼の代償）`;
        } else if (locData.isChallenge) {
          const rSteel = addLootWithCap(player, '王国鋼', 1);
          const rPlate = addLootWithCap(player, '装甲板', 1);
          const rPowder = addLootWithCap(player, '黒火薬', 1);
          const rStone = addLootWithCap(player, '魔導石', 1);
          lootText = `⛏️鋼×${rSteel.added} / 🛡️板×${rPlate.added} / 🧨火×${rPowder.added} / 🔮石×${rStone.added}`;
        } else if (locData.possibleLoot && locData.possibleLoot.length > 0) {
          const dropObj = locData.possibleLoot[Math.floor(Math.random() * locData.possibleLoot.length)];
          rawDropName = dropObj.item;
          const addRes = addLootWithCap(player, dropObj.item, dropObj.count);
          isCapped = addRes.capped;
          const iconMap = { '王国鋼': '⛏️', '装甲板': '🛡️', '黒火薬': '🧨', '魔導石': '🔮', '兵糧': '🍞' };
          const icon = iconMap[dropObj.item] || '🎁';
  
          if (addRes.added > 0) {
            lootText = `${icon}${dropObj.item} ×${addRes.added}${addRes.capped ? `（⚠️上限${addRes.cap}個に到達）` : ''}`;
          } else {
            lootText = `${icon}${dropObj.item}（⚠️武器庫満杯[上限${addRes.cap}個]のため破棄 ➔ アジトで拡張せよ）`;
          }
        }
  
        if (usedTrumpObj) {
          interludeText += `\n🃏【切り札消費】『${usedTrumpObj.name}』を発動し、敵の戦術を封じ込めた！`;
        }
  
        // 勝利時の進行フラグ更新 ＆ 幕間劇（第2幕）発火判定
        if (locData.isChallenge) {
          const prevWins = (player.bossWins && player.bossWins[locKey]) || 0;
          const isFirstBossWin = prevWins === 0;
          player.bossWins[locKey] = prevWins + 1;
          player.currentLocation = '礼拝堂';
  
          if (isFirstBossWin) {
            shouldTriggerFactionReaction = true;
            interludeText += `\n\n🍷【魔王城・作戦会議室】対魔神聖巨像アークエンゼル単独撃破の報が、魔王城の上層部3派閥を震撼させている……！（▼下の『🍷 魔王城の反応を見る』から覗き見よ）`;
          }
  
        } else if (locData.isReturn) {
          player.currentLocation = 'アジト';
          player.hp = battleData.stats.maxHp;
          interludeText += movedAwaySlotLostNotice;
  
        } else if (locData.isDrawbridge) {
          player.currentLocation = '跳ね橋';
          interludeText +=
  `\n\n🔥 魔軍卿 ガルガン：
  「ガハハハ！！ 跳ね橋は落ちたぞ！ 深い堀の向こうに口を開けた『🏯 ヴァルハイト城』へ、武器とHPを整えて突っ込め${player.name}！！」${movedAwaySlotLostNotice}`;
  
        } else if (locData.isBoss && !locData.isChallenge) {
          const prevWins = (player.bossWins && player.bossWins[locKey]) || 0;
          const isFirstBossWin = prevWins === 0;
          player.bossWins[locKey] = prevWins + 1;
  
          player.currentLocation = (
            locData.isChapter1FinalBoss ||
            locData.isChapter2FinalBoss ||
            locData.isChapter3FinalBoss
          ) ? 'アジト' : locKey;
  
          if (locKey !== '検問所' && isFirstBossWin) {
            shouldTriggerFactionReaction = true;
          }
  
          if (locKey === '検問所') {
            if (player.ch1Step === 0) player.ch1Step = 1;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n📜【人間軍・伝令兵の悲鳴】：
  「こ、国境検問所がガルガン軍の野良小隊に突破された！ 次の『前哨砦』を守るバルツ隊長に急報を送れッ！」`;
            }
  
          } else if (locKey === '前哨砦') {
            if (player.ch1Step === 1) player.ch1Step = 2;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n🍷【魔王城・作戦会議室】前哨砦陥落の報が届き、魔王城の上層部3派閥がざわつき始めたようだ……！（▼下の『🍷 魔王城の反応を見る』から覗き見よ）`;
            }
  
          } else if (locData.isChapter1FinalBoss) {
            player.ch1Step = 3;
            player.chapter = 2;
            player.hp = battleData.stats.maxHp;
            player.activeGuerilla = null;
            player.revengeTarget = null;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n👑【要塞門を居抜き乗っ取り！新戦域『聖涙川の教会平原』解禁！】
  🔥 魔軍卿 ガルガン：「ガハハハ！！ 見たか${player.name}！ ロシュの要塞門を奪い取って俺たちの新しい城にしてやったぜ！ 今頃、魔王城のエリートどもが真っ青になって泡を吹いてやがるはずだ！！」
  🍷（※下の『🍷 魔王城の反応を見る』から上層部3派閥の動揺を覗き見よ！）`;
            }
  
          } else if (locKey === '工房跡') {
            if (player.ch2Step === 0) player.ch2Step = 1;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n（※奥にそびえる平原大ボス『🏰 教会領大聖堂』への進路が開かれた！）
  🍷【魔王城・作戦会議室】猛毒の工房跡突破の報に、魔王城の上層部3派閥が動揺しているようだ……！（▼下の『🍷 魔王城の反応を見る』から覗き見よ）`;
            }
  
          } else if (locData.isChapter2FinalBoss) {
            player.ch2Step = 2;
            player.chapter = 3;
            player.hp = battleData.stats.maxHp;
            player.activeGuerilla = null;
            player.revengeTarget = null;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n👑【教会領大聖堂を乗っ取り！新戦域『覇権の万魔中央回廊』解禁！】
  🔥 魔軍卿 ガルガン：「ガハハハ！！ ${player.name}、よくやった！ 白亜の大聖堂を黒鉄と血煙に染め上げてやったぜ！ 次は万魔中央回廊の人間遠征軍へ雪崩れ込め！！」
  🍷（※下の『🍷 魔王城の反応を見る』から上層部3派閥の動揺を覗き見よ！）`;
            }
  
          } else if (locKey === '回廊関門') {
            if (player.ch3Step === 0) player.ch3Step = 1;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n（※人間軍の最高指導者ジークフリート元帥が待つ『🏰 遠征軍総本陣』への進路が開かれた！）
  🍷【魔王城・作戦会議室】正規軍すら抜けなかった白獅子陣突破の報に、魔王城の上層部3派閥が激震している……！（▼下の『🍷 魔王城の反応を見る』から覗き見よ）`;
            }
  
          } else if (locData.isChapter3FinalBoss) {
            player.ch3Step = 2;
            player.hp = battleData.stats.maxHp;
            if (isFirstBossWin) {
              interludeText +=
  `\n\n👑【万魔の王都・魔王城玉座の間からの伝令】
  絶対支配者・魔王：「フハハハハ！！ 見事だガルガン、そして${player.name}よ！ ようやく『使い捨ての駒』から『他の魔軍卿と獲物を食い合う資格』を得たな。さらに苛烈な戦場で人間王国の本隊を食い荒らし続けよ！」
  🔥 魔軍卿 ガルガン：「ガハハハハ！！ 聞いたか野郎ども！！ 城の玉座なんざ窮屈で御免だ！ 人間界のクソ騎士どもも、城のエリートどもも、終わりなき戦場で全部俺たちのキメラ斧の餌にしてやろうぜ！！」
  🍷（※下の『🍷 魔王城の反応を見る』から上層部3派閥の焦りを覗き見よ！）`;
            }
          }
        } else {
          player.currentLocation = locKey;
          interludeText += movedAwaySlotLostNotice;
        }
      } else {
        // 敗北時処理
        player.hp = 1;
        const retreatLoc = getRetreatLocation(locKey);
        player.currentLocation = retreatLoc;
  
        const failNotes = [];
        if (movedAwaySlotLostNotice) failNotes.push(movedAwaySlotLostNotice.trim());
        if (usedTrumpObj) {
          failNotes.push(`💨【切り札消費】『${usedTrumpObj.name}』を使用したが、敵を削り切れず消滅した。`);
        }
  
        if (locData.isBoss) {
          // 本編関門ボス敗北時、次回ゲリラ抽選用のリベンジ補正ターゲットを記録
          if (!locData.isChallenge && locKey !== '検問所') {
            player.revengeTarget = getCounterTrumpForBoss(locKey, enemy);
          }
  
          const brokenItemName = tryBreakSlotMaterial(player);
          if (brokenItemName) {
            failNotes.push(`💥【武具破損】退却時の衝撃で、基本枠に溶接していた『${brokenItemName}』が1個砕け散った！（「🔨 武器鍛造」で補充せよ）`);
          } else {
            failNotes.push(`🛡️【破損回避】防壁と装甲が衝撃を吸収し、武器スロットの破損を免れた！`);
          }
  
          if (usedSixthInfo) {
            failNotes.push(`💨【第6枠消滅】装填していた『${usedSixthInfo.item}』は限界燃焼し尽きて消滅した。`);
          }
  
          if (player.awakenedBoss === locKey) {
            failNotes.push(`🔥【第6スロット覚醒継続中】『${locData.name}』に挑み続ける限り、第6枠は維持される！（他エリア移動で消滅）`);
          } else {
            const awakenRate = getOverloadAwakenRate(player);
            if (Math.random() < awakenRate) {
              player.awakenedBoss = locKey;
              player.sixthSlot = null;
              failNotes.push(
  `🔥【限界突破：第6スロット覚醒！！】
  死闘の衝撃でキメラ武器の隠し機構が暴走し、イレギュラー枠『第6のスロット』が解放された！（「🔨 武器鍛造」から6枠目を装填可能。使い捨て・装着勝利時は戦利品なし・場所移動で消滅）`
              );
            }
          }
        }
  
        if (battleData.hint) failNotes.push(battleData.hint);
        interludeText = failNotes.length > 0 ? `\n\n${failNotes.join('\n')}` : '';
      }
  
      // 戦闘開始前にゲリラが存在しなかった場合のみ、25%で新規ゲリラを発生抽選
      const newGuerrillaNotice = (!hadActiveGuerrillaBefore && !player.activeGuerilla)
        ? trySpawnGuerrillaRaid(player)
        : null;
      if (newGuerrillaNotice) {
        interludeText += `\n\n${newGuerrillaNotice}`;
      } else if (guerrillaTickNote) {
        interludeText += `\n${guerrillaTickNote}`;
      }
  
      // シーン種別の判定
      let sceneType = 'RAID';
      if (locData.isChallenge) sceneType = 'CHALLENGE';
      else if (locData.isBoss) sceneType = 'BOSS';
      else if (locData.isReturn) sceneType = 'RETURN';
      else if (locData.isDrawbridge) sceneType = 'DRAWBRIDGE';
  
      // APIレート制限衝突を防ぐため、直列で第1幕 ➔ 小休止 ➔ 第2幕の順に生成
      const story = await generateRaidNarrative(locData.name, battleData, player, enemy, lootText, {
        locDesc: locData.desc,
        sceneType,
        isCapped: isCapped && lootText.includes('破棄'),
        rawDropName,
      });
  
      if (shouldTriggerFactionReaction) {
        await sleep(800);
        player.pendingFactionStory = await generateFactionReaction(locData.name, battleData, player, enemy);
      }
  
      await savePlayer(player);
  
      const hpNote = (battleData.result === 'WIN' && (locData.isReturn || locData.isChapter1FinalBoss || locData.isChapter2FinalBoss || locData.isChapter3FinalBoss))
        ? '（100%全快！）'
        : (battleData.result !== 'WIN' ? '（瀕死・要「🍖 兵糧回復」）' : '');
  
      const trumpLine = player.trumpItem ? `\n🃏 切り札：${getTrumpItemDisplay(player)}` : '';
  
      const messageText =
  `📯【遠征戦記：${locData.name}】
  
  ${story}${interludeText}
  
  ━━━━━━━━━━━━━━━━━━
  📍 現在地：${getCurrentLocationName(player)}
  ❤️ 部隊HP：${player.hp} / ${battleData.stats.maxHp}${hpNote}
  🎒 戦利品：${lootText}${trumpLine}
  ━━━━━━━━━━━━━━━━━━`;
  
      try {
        await lineClient.pushMessage({
          to: userId,
          messages: [{
            type: 'text',
            text: messageText,
            quickReply: buildRaidQuickReply(player),
          }],
        });
      } catch (err) {
        console.error(`プッシュ送信エラー (${userId}):`, err);
      }
    }
  }