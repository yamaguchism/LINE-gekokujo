import { MAP_LOCATIONS, DEFENSE_ENEMIES } from './gameData.js';
import {
  getBaseName,
  getOverloadAwakenRate,
  tryBreakSlotMaterial,
  calculateEffectiveStats,
  simulateBattle,
} from './battleEngine.js';
import { generateRaidNarrative } from './aiService.js';
import {
  getOrCreatePlayer,
  savePlayer,
  getAllPlayerIds,
  getSlotItemInfo,
  clearAwakenedSixthSlot,
  getCurrentLocationName,
  getRetreatLocation,
  addLootWithCap,
  formatLootList,
} from './playerService.js';
import { makeQuickReply, getSmartButtons } from './uiService.js';

// ==========================================
// 1. 特殊作戦①：ヴァルハイト城（3連撃チキンレースローグ）処理
// ==========================================
export async function executeCastleRogueStep(lineClient, userId, player) {
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

  await savePlayer(player);

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
// 2. 特殊作戦②：夜間2地点連続略奪
// ==========================================
export async function executeTwoStepRaid(lineClient, userId, player, routeStr) {
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

    await savePlayer(player);

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
    await savePlayer(player);
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

  await savePlayer(player);

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

      await savePlayer(player);

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

    let movedAwaySlotLostNotice = '';
    if (player.awakenedBoss && locKey !== player.awakenedBoss) {
      clearAwakenedSixthSlot(player, true);
      movedAwaySlotLostNotice = `\n（※場所を移動したため、覚醒していた『第6スロット』は消滅した）`;
    }

    const usedSixthSlotKey = (player.awakenedBoss === locKey) ? player.sixthSlot : null;
    const usedSixthInfo = usedSixthSlotKey ? getSlotItemInfo(usedSixthSlotKey) : null;

    const enemy = locData.enemies[Math.floor(Math.random() * locData.enemies.length)];
    const battleData = simulateBattle(player, enemy, locKey);

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

      if (locData.isBoss) {
        player.awakenedBoss = null;
        player.sixthSlot = null;
      }

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

        if (usedSixthInfo) {
          sixthAwakenNotice += `\n💨【第6枠素材消滅】第6スロットに装填していた『${usedSixthInfo.item}』は使い捨てのため燃え尽きて消滅した！`;
        }

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

    await savePlayer(player);

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