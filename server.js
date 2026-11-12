import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi } from '@line/bot-sdk';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

import { MAP_LOCATIONS } from './gameData.js';
import {
  getTotalSlots,
  getBaseName,
  getBossBreakRate,
  getOverloadAwakenRate,
  calculateEffectiveStats,
} from './battleEngine.js';
import {
  createInitialPlayer,
  normalizePlayer,
  savePlayer,
  getOrCreatePlayer,
  getSlotItemInfo,
  getCurrentLocationName,
  getReservedDisplayName,
  getMaterialCap,
  getRationCap,
  addLootWithCap,
  formatLootList,
} from './playerService.js';
import {
  makeQuickReply,
  resolveMapImageUrl,
  getSmartButtons,
  getForgeButtons,
  getBaseUpgradeButtons,
} from './uiService.js';
import { executeScheduledRaids } from './raidService.js';

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

const app = express();

app.use('/public', express.static(path.resolve('public')));

// ==========================================
// 開幕プロローグ＆初回QuickReply生成ヘルパー
// ==========================================
function buildPrologueMessage(leaderName = 'シンジ') {
  const text =
`🩸 魔王軍最底辺・下剋上戦記

鼻腔を突く冷たい泥と、硝煙の匂い。
目を覚ましたお前の手には、屑鉄を強引に叩き合わせた不揃いな『キメラ断頭斧』が握られていた。

「おい、起きたか野良犬がッ！」
泥煙を割り、仁王立ちで唾を飛ばすのは頭目・魔軍卿ガルガン。
「気取ったエリート魔軍卿どもは、泥水を啜る俺たちを使い捨ての捨て駒にしやがった。兵も、鍛冶師も、兵糧一粒すら寄こさねえ。……だが俺は気に入ったぜ。てめえのその狂ったキメラ断頭斧の牙がな」

ガルガンは無造作に、わずかな鋼と乾パンが入った革袋を泥濘へ放り投げてきた。

「配給がねえなら、人間どもから力づくで奪うまでだ。
四の五の言わず、まずは国境を塞ぐ検問所をぶち破ってこい！${leaderName}班！」

━━━━━━━━━━━━━━━━━━
⛺ 本陣：荒れ野の廃砦（初期アジト）
🪓 初期武装：無骨なキメラ断頭斧（4/5枠：鋼2/板2/空1）
⏰ 定時進軍：毎日 8:00 / 12:00 / 20:00 自動決行
━━━━━━━━━━━━━━━━━━
▼ ガルガン軍の第一歩だ。検問所への突入戦術を選べ（※即座に開戦）`;

  return {
    type: 'text',
    text,
    quickReply: makeQuickReply([
      { label: '💥 正面突破（ガルシアの首級）', text: '初陣：正面' },
      { label: '🐀 兵站倉庫から急襲（奇襲）', text: '初陣：奇襲' },
    ]),
  };
}

// ==========================================
// 定時自動進軍スケジューラー（毎日 8:00 / 12:00 / 20:00）
// ==========================================
cron.schedule('0 8,12,20 * * *', async () => {
  console.log('>>> [定時時刻到来] 全小隊の一斉行動を開始...');
  await executeScheduledRaids(lineClient);
});

// ==========================================
// Web作戦地図 HTML 配信エンドポイント
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
// LINE Webhook メインルーティング
// ==========================================
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.status(200).end();

  const events = req.body.events || [];
  for (const event of events) {
    const userId = event.source?.userId;
    if (!userId) continue;

    // ------------------------------------------
    // 0. 友だち追加（follow）イベント：開幕プロローグ即時送信
    // ------------------------------------------
    if (event.type === 'follow') {
      let displayName = 'シンジ';
      try {
        const profile = await lineClient.getProfile(userId);
        if (profile && profile.displayName) {
          displayName = profile.displayName;
        }
      } catch (err) {
        console.warn(`LINEプロフィール取得失敗 (${userId}):`, err.message);
      }

      const { player } = await getOrCreatePlayer(userId, displayName);
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildPrologueMessage(player.leader)],
      });
      continue;
    }

    // テキストメッセージ以外はスキップ
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userText = event.message.text.trim();
    let { player } = await getOrCreatePlayer(userId);

    // ------------------------------------------
    // 0-B. プロローグ手動確認コマンド
    // ------------------------------------------
    if (userText === 'プロローグ') {
      let displayName = player.leader || 'シンジ';
      try {
        const profile = await lineClient.getProfile(userId);
        if (profile && profile.displayName) displayName = profile.displayName;
      } catch (_) {}
      const updated = await getOrCreatePlayer(userId, displayName);
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildPrologueMessage(updated.player.leader)],
      });
      continue;
    }

    // ------------------------------------------
    // 0-C. チュートリアル初陣（正面突破 or 兵站倉庫奇襲 ➔ 即時ガルシア戦）
    // ------------------------------------------
    if (userText === '初陣：正面' || userText === '初陣：奇襲') {
      const isFront = userText === '初陣：正面';
      const squadName = player.name || `${player.leader || 'シンジ'}班`;

      const openingScene = isFront
        ? `正面の防護柵をキメラ断頭斧で叩き割り、${squadName}が咆哮とともに突入！\n慌てて剣を抜いた検問所の守備隊長・新兵ガルシアが蒼白な顔で立ち塞がる！`
        : `裏手の兵站倉庫の天窓を蹴破り、${squadName}が闇に紛れて奇襲！\n乾パンを喉に詰まらせかけた守備隊長・新兵ガルシアが、悲鳴を上げながら剣を構えた！`;

      const lootResult = addLootWithCap(player, '王国鋼', 1);
      player.bossWins = player.bossWins || {};
      player.bossWins['検問所'] = (player.bossWins['検問所'] || 0) + 1;
      if ((player.ch1Step || 0) < 1) {
        player.ch1Step = 1;
      }
      player.currentLocation = '検問所';
      await savePlayer(player);

      const s = player.slots || { steel: 2, plate: 2, powder: 0, stone: 0 };
      const total = getTotalSlots(s);
      const capNotice = lootResult.capped ? '（※武器庫上限到達）' : '';

      const resultText =
`⚔️【初陣決着：国境の検問所】

${openingScene}

不揃いな『${player.weapon}（${total}/5枠）』が唸りを上げ、ガルシアの華奢な盾ごと兜を強引に叩き割った！
守備隊は恐慌状態に陥り、武器を捨てて潰走していく！

━━━━━━━━━━━━━━━━━━
🏆 勝敗：完全制圧（新兵ガルシア討取）
📦 略奪品：⛏️王国鋼 × 1 ${capNotice}
━━━━━━━━━━━━━━━━━━

「おいおい、初陣にしては上出来じゃねえか！ だがな、枠が1つ空いたままのナマクラ斧じゃ、この先の『前哨砦』じゃ通用しねえぞ」

ガルガンが泥にまみれた金槌を投げて寄こす。

「今奪ったばかりのその『王国鋼』を、断頭斧の空き枠に力ずくで叩き込め！ 武器ってのはこうやって現場で育てるもんだ！」`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: resultText,
          quickReply: makeQuickReply([
            { label: '🔨 奪った王国鋼を空き枠に溶接', text: 'チュートリアル：溶接' },
          ]),
        }],
      });
      continue;
    }

    // ------------------------------------------
    // 0-D. チュートリアル溶接（空き枠への充填 ➔ 本編ループ合流）
    // ------------------------------------------
    if (userText === 'チュートリアル：溶接') {
      const prevStats = calculateEffectiveStats(player);
      const s = player.slots;
      const total = getTotalSlots(s);
      const info = getSlotItemInfo('steel');

      if (total < 5) {
        if ((player.inventory['王国鋼'] || 0) > 0) {
          player.inventory['王国鋼'] -= 1;
        }
        player.slots.steel = (player.slots.steel || 0) + 1;
        await savePlayer(player);
      }

      const newTotal = getTotalSlots(player.slots);
      const newStats = calculateEffectiveStats(player);

      const weldText =
`🔨【${info.label} を溶接！（${newTotal}/5枠）】

火花と焦げた油の匂いが立ち込め、空いていた5枠目に『⛏️王国鋼』がガッチリと食い込んだ！

━━━━━━━━━━━━━━━━━━
🪓 現在の構成：⛏️鋼${player.slots.steel} / 🛡️板${player.slots.plate} / 🧨火${player.slots.powder} / 🔮石${player.slots.stone}
📊 実効能力：攻${prevStats.atk} ➔ ${newStats.atk} | 防${prevStats.def} ➔ ${newStats.def} | HP${player.hp}/${newStats.maxHp}
━━━━━━━━━━━━━━━━━━

「ヒャハハ！ いい重みが乗りやがったな！
……だがな、枠を埋めただけで勝てるほどこの先は甘くねえぞ。敵の盾が厚けりゃ『🧨黒火薬』を盛り、猛攻に耐えるなら『🛡️装甲板』に張り替える。『🔨 鍛冶』で枠を付け替えるのが生き残る鉄則だ」

ガルガンは血のついた作戦地図を広げた。

「さあ、ここからが本当の戦争（定時進軍：8時/12時/20時）だ。次の進軍先を選んで予約しておけ！」`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: weldText,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });
      continue;
    }

    // ------------------------------------------
    // 0-E. 魔王城・上層部3派閥の幕間劇（第2幕）閲覧コマンド
    // ------------------------------------------
    if (userText === '幕間劇を見る' || userText === '🍷 魔王城の反応を見る') {
      if (!player.pendingFactionStory) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `🍷 魔王城の作戦会議室の魔導通信はすでに途絶えているようだ。\n📍 現在地：${getCurrentLocationName(player)}\n▼ 下のボタンから次の行動を選択せよ。`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        continue;
      }

      const storyToDeliver = player.pendingFactionStory;
      player.pendingFactionStory = null;
      await savePlayer(player);

      const factionReplyText =
`${storyToDeliver}

━━━━━━━━━━━━━━━━━━
📍 現在地：${getCurrentLocationName(player)}
🔥 魔軍卿 ガルガン：「ガハハハ！ 城の連中が泡を吹いてやがるぜ！ さあ、次の進軍先を選んでさらに暴れ回れ！」`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: factionReplyText,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });
      continue;
    }

    // ------------------------------------------
    // A. 開幕・リセット・地図・行動選択メニュー
    // ------------------------------------------
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
        player = normalizePlayer(createInitialPlayer(userId, player.leader), userId);
        await savePlayer(player);
      }

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

    // ------------------------------------------
    // B. 予約解除
    // ------------------------------------------
    } else if (userText === '予約解除') {
      player.reservedLocation = null;
      await savePlayer(player);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `🔄 出撃予約を解除したぞ。\n📍 現在地：${getCurrentLocationName(player)}\n▼ 新しい進軍先を下から選べ。`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // B-1. 夜間2連遠征の予約（遠征：A>B）
    // ------------------------------------------
    } else if (userText.startsWith('遠征：')) {
      const routeStr = userText.replace('遠征：', '').trim();
      const [step1, step2] = routeStr.split('>');
      if (!step1 || !step2 || !MAP_LOCATIONS[step1] || !MAP_LOCATIONS[step2]) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 遠征ルートの指定が不正だ。下のボタンから選び直せ。',
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        continue;
      }

      player.reservedLocation = `${step1}>${step2}`;
      await savePlayer(player);

      const n1 = MAP_LOCATIONS[step1].name;
      const n2 = MAP_LOCATIONS[step2].name;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🌙【夜間2連遠征・出撃予約完了！】
進軍ルート：『${n1}』➔『${n2}』
・第1戦に勝利すると、そのまま第2戦へ連戦突入する！
・現在地：${getCurrentLocationName(player)}

※リッチメニューまたは下の『⚡ 今すぐ決行』で即座に連戦テストが可能だ。`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // B-2. ヴァルハイト城（3連撃チキンレース）の突撃・脱出コマンド
    // ------------------------------------------
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
        continue;
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
        await savePlayer(player);

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

▼ 続けて城へ再突撃するか、兵站所やアジトへ戻るかを選べ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        continue;
      }

      player.reservedLocation = '城郭：突撃';
      await savePlayer(player);

      const nextFloorNum = player.castleFloor + 1;
      const floorInfo = MAP_LOCATIONS['ヴァルハイト城'].castleFloors[nextFloorNum];
      const enemyNames = (floorInfo.enemies || []).map((e) => e.name).join(' / ');

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🔥【ヴァルハイト城・次階層への突撃予約完了！】
目標: 『${floorInfo.floorName}』
・出現候補の敵: ${enemyNames}
・現在の戦利品袋: 【 ${formatLootList(player.castleLoot)} 】
・引き継ぎ部隊HP: ${player.hp}/${calculateEffectiveStats(player).maxHp}

※下の『⚡ 今すぐ決行』を押すと、即座にこの階層の死闘を開始するぞ！`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // C. アジト強化メニュー ＆ 拠点改修実行
    // ------------------------------------------
    } else if (
      userText.startsWith('拠点改修：') ||
      userText.includes('アジト') ||
      userText.includes('拠点') ||
      userText.includes('改築') ||
      userText.includes('強化')
    ) {
      if (userText.startsWith('拠点改修：')) {
        const target = userText.replace('拠点改修：', '').trim();
        let replyText = '';

        if (target === '防壁') {
          const lv = player.baseWallLevel || 1;
          if (lv >= 3) {
            replyText = '⚠️ 防壁はすでに最大レベル（Lv3）まで強化済みだ！';
          } else {
            const costPlate = lv * 2;
            if ((player.inventory['装甲板'] || 0) < costPlate) {
              replyText = `⚠️ 装甲板が足りない！（必要: 🛡️装甲板×${costPlate} / 所持: ${player.inventory['装甲板'] || 0}）`;
            } else {
              player.inventory['装甲板'] -= costPlate;
              player.baseWallLevel = lv + 1;
              await savePlayer(player);
              replyText = `🏰【防壁強化完了：Lv${lv} ➔ Lv${player.baseWallLevel}】\n装甲板×${costPlate}を溶接し、本陣防壁を強化した！（防衛戦時の部隊防御ボーナス上昇）`;
            }
          }
        } else if (target === '武器庫') {
          const lv = player.baseArmoryLevel || 1;
          if (lv >= 3) {
            replyText = '⚠️ 武器庫はすでに最大レベル（Lv3）まで拡張済みだ！';
          } else {
            const costSteel = lv * 2;
            if ((player.inventory['王国鋼'] || 0) < costSteel) {
              replyText = `⚠️ 王国鋼が足りない！（必要: ⛏️王国鋼×${costSteel} / 所持: ${player.inventory['王国鋼'] || 0}）`;
            } else {
              player.inventory['王国鋼'] -= costSteel;
              player.baseArmoryLevel = lv + 1;
              await savePlayer(player);
              replyText = `📦【武器庫拡張完了：Lv${lv} ➔ Lv${player.baseArmoryLevel}】\n王国鋼×${costSteel}で棚を増設した！\n・各素材上限：${getMaterialCap(player)}個\n・兵糧上限：${getRationCap(player)}個`;
            }
          }
        } else if (target === '過負荷炉') {
          const lv = player.baseFurnaceLevel || 0;
          if (lv >= 3) {
            replyText = '⚠️ 過負荷炉はすでに最大レベル（Lv3）まで改造済みだ！';
          } else {
            const costPowder = (lv + 1) * 2;
            if ((player.inventory['黒火薬'] || 0) < costPowder) {
              replyText = `⚠️ 黒火薬が足りない！（必要: 🧨黒火薬×${costPowder} / 所持: ${player.inventory['黒火薬'] || 0}）`;
            } else {
              player.inventory['黒火薬'] -= costPowder;
              player.baseFurnaceLevel = lv + 1;
              await savePlayer(player);
              const rate = (getOverloadAwakenRate(player) * 100).toFixed(0);
              replyText = `🔥【過負荷炉改造完了：Lv${lv} ➔ Lv${player.baseFurnaceLevel}】\n黒火薬×${costPowder}を炉心に投下！ボス戦敗北時の『第6スロット覚醒率』が【${rate}%】に上昇した！`;
            }
          }
        }

        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: replyText,
            quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
          }],
        });
        continue;
      }

      const wallLv = player.baseWallLevel || 1;
      const armLv = player.baseArmoryLevel || 1;
      const furLv = player.baseFurnaceLevel || 0;
      const awakenRate = (getOverloadAwakenRate(player) * 100).toFixed(0);

      const baseGuide =
`⛺【本陣改築：${getBaseName(player)}】
奪った資材を投じて本陣設備を強化できるぞ。

🛡️ 防壁 Lv${wallLv}/3（防衛時の防御力UP）
📦 武器庫 Lv${armLv}/3（素材上限:${getMaterialCap(player)} / 兵糧上限:${getRationCap(player)}）
🔥 過負荷炉 Lv${furLv}/3（ボス敗北時の6枠覚醒率:${awakenRate}%）

📦 手持ち資材：
⛏️鋼:${player.inventory['王国鋼']} / 🛡️板:${player.inventory['装甲板']} / 🧨火:${player.inventory['黒火薬']} / 🔮石:${player.inventory['魔導石']}

▼ 強化したい設備を下から選べ。`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: baseGuide,
          quickReply: makeQuickReply(getBaseUpgradeButtons(player)),
        }],
      });

    // ------------------------------------------
    // D. 出撃予約（通常拠点・関門ボス）
    // ------------------------------------------
    } else if (
      userText.startsWith('出撃：') ||
      Object.keys(MAP_LOCATIONS).some((k) => userText.includes(k))
    ) {
      let matchedKey = null;
      if (userText.startsWith('出撃：')) {
        const candidate = userText.replace('出撃：', '').trim();
        if (MAP_LOCATIONS[candidate]) matchedKey = candidate;
      }
      if (!matchedKey) {
        for (const k of Object.keys(MAP_LOCATIONS)) {
          if (userText.includes(k)) {
            matchedKey = k;
            break;
          }
        }
      }

      if (!matchedKey || !MAP_LOCATIONS[matchedKey]) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 指定された進軍先が見つからないぞ。下のボタンから選べ。',
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        continue;
      }

      player.reservedLocation = matchedKey;
      await savePlayer(player);

      const loc = MAP_LOCATIONS[matchedKey];
      const stats = calculateEffectiveStats(player);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`⚔️【出撃予約完了：『${loc.name}』】
・作戦内容：${loc.desc || '敵陣強襲・物資略奪'}
・現在地：${getCurrentLocationName(player)}
・部隊戦力：HP${player.hp}/${stats.maxHp}（攻${stats.atk} / 防${stats.def}）

⏰ 次の定時（8:00 / 12:00 / 20:00）、または下の『⚡ 今すぐ決行』で進軍を開始するぞ！`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // E. テスト即時決行 ＆ テスト防衛戦
    // ------------------------------------------
    } else if (userText.includes('即時決行') || userText.includes('テスト防衛戦')) {
      const isDef = userText.includes('テスト防衛戦');
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: isDef
            ? '🚨 敵襲警報！本陣へ敵の奇襲部隊が接近中…！（数秒後にAI迎撃報告が届きます）'
            : `⏳ 定時到来！${player.name}が作戦行動を開始した…（数秒後にAI戦闘報告が届きます）`,
        }],
      });
      await executeScheduledRaids(lineClient, userId, isDef);

    // ------------------------------------------
    // F. 鍛冶場・キメラ武器改造
    // ------------------------------------------
    } else if (
      userText.includes('鍛造') ||
      userText.includes('鍛冶') ||
      userText.includes('改造') ||
      userText.includes('武器')
    ) {
      const s = player.slots;
      const total = getTotalSlots(s);
      const stats = calculateEffectiveStats(player);
      const breakRate = (getBossBreakRate(player) * 100).toFixed(0);
      const sixthInfo = player.sixthSlot ? getSlotItemInfo(player.sixthSlot)?.label : '未装着';
      const sixthLine = player.awakenedBoss
        ? `\n🔥【過負荷6枠目（対${player.awakenedBoss}限定）】：${sixthInfo}`
        : '';

      const forgeGuide =
`🔨【廃砦の鍛冶場：${player.weapon}】
基本スロット使用：${total}/5枠
（⛏️鋼:${s.steel || 0} / 🛡️板:${s.plate || 0} / 🧨火:${s.powder || 0} / 🔮石:${s.stone || 0}）${sixthLine}

📊 実効ステータス：
HP:${player.hp}/${stats.maxHp} | 攻:${stats.atk} | 防:${stats.def}
会心:${(stats.critRate * 100).toFixed(0)}% | 回避:${(stats.dodgeRate * 100).toFixed(0)}% | 吸血:${(stats.vampRate * 100).toFixed(0)}%
（ボス戦での武器損壊率：${breakRate}%）

📦 手持ち素材（上限${getMaterialCap(player)}）：
⛏️鋼:${player.inventory['王国鋼']} / 🛡️板:${player.inventory['装甲板']} / 🧨火:${player.inventory['黒火薬']} / 🔮石:${player.inventory['魔導石']}

▼ 下のボタンで素材を溶接、またはリセットせよ。`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: forgeGuide,
          quickReply: makeQuickReply(getForgeButtons(player)),
        }],
      });

    // ------------------------------------------
    // G-0. 独立第6スロット操作
    // ------------------------------------------
    } else if (userText.startsWith('6枠：')) {
      const action = userText.replace('6枠：', '').trim();
      if (!player.awakenedBoss) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 現在、過負荷炉の第6スロットは覚醒していないぞ。',
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        continue;
      }

      const keyMap = { '鋼': 'steel', '板': 'plate', '火': 'powder', '石': 'stone' };
      const slotKey = keyMap[action] || action;
      const info = getSlotItemInfo(slotKey);

      if (!info) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 装着する素材の指定が不正だ。',
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        continue;
      }

      if ((player.inventory[info.item] || 0) <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ 手持ちの『${info.item}』が足りないぞ！`,
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        continue;
      }

      if (player.sixthSlot) {
        const prevInfo = getSlotItemInfo(player.sixthSlot);
        if (prevInfo) {
          player.inventory[prevInfo.item] = (player.inventory[prevInfo.item] || 0) + 1;
        }
      }

      player.inventory[info.item] -= 1;
      player.sixthSlot = slotKey;
      await savePlayer(player);

      const stats = calculateEffectiveStats(player);
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🔥【過負荷・第6スロット装着完了！】
対『${player.awakenedBoss}』決戦用の第6枠に【${info.label}】をねじ込んだ！
実効能力: 攻${stats.atk} / 防${stats.def} / 会心${(stats.critRate * 100).toFixed(0)}% / 回避${(stats.dodgeRate * 100).toFixed(0)}%`,
          quickReply: makeQuickReply(getForgeButtons(player)),
        }],
      });

    // ------------------------------------------
    // G. 基本5枠スロット操作
    // ------------------------------------------
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
        await savePlayer(player);

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
        continue;
      }

      if (total >= 5) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 基本スロット（5枠）はすでに満杯だ！組み直す場合は『🔄 スロット全外し』を押せ。',
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        continue;
      }

      const keyMap = {
        '鋼': 'steel', '王国鋼': 'steel', 'steel': 'steel',
        '板': 'plate', '装甲板': 'plate', 'plate': 'plate',
        '火': 'powder', '黒火薬': 'powder', 'powder': 'powder',
        '石': 'stone', '魔導石': 'stone', 'stone': 'stone',
      };
      const slotKey = keyMap[type];
      const info = getSlotItemInfo(slotKey);

      if (!slotKey || !info) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 溶接する素材の指定が不正だ。下のボタンから選べ。',
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        continue;
      }

      if ((player.inventory[info.item] || 0) <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `⚠️ 手持ちの『${info.item}』が0個だ！戦場で奪ってこい！`,
            quickReply: makeQuickReply(getForgeButtons(player)),
          }],
        });
        continue;
      }

      player.inventory[info.item] -= 1;
      player.slots[slotKey] = (player.slots[slotKey] || 0) + 1;
      await savePlayer(player);

      const newTotal = getTotalSlots(player.slots);
      const stats = calculateEffectiveStats(player);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🔨【${info.label} を溶接！（${newTotal}/5枠）】
現在の構成：⛏️鋼${player.slots.steel} / 🛡️板${player.slots.plate} / 🧨火${player.slots.powder} / 🔮石${player.slots.stone}
実効能力：HP${player.hp}/${stats.maxHp} | 攻${stats.atk} | 防${stats.def} | 会心${(stats.critRate * 100).toFixed(0)}% | 回避${(stats.dodgeRate * 100).toFixed(0)}%`,
          quickReply: makeQuickReply(getForgeButtons(player)),
        }],
      });

    // ------------------------------------------
    // H. 兵糧によるHP回復・補給
    // ------------------------------------------
    } else if (
      userText.includes('回復') ||
      userText.includes('兵糧') ||
      userText.includes('兵舎') ||
      userText.includes('飯') ||
      userText.includes('補給')
    ) {
      const stats = calculateEffectiveStats(player);
      if (player.hp >= stats.maxHp) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `🍖 部隊のHPはすでに満タン（${player.hp}/${stats.maxHp}）だ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        continue;
      }

      if ((player.inventory['兵糧'] || 0) <= 0) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '⚠️ 手持ちの『🍞 兵糧』が0個だ！補給街道や農村を襲撃して奪ってこい！',
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        continue;
      }

      player.inventory['兵糧'] -= 1;
      const prevHp = player.hp;
      player.hp = stats.maxHp;
      await savePlayer(player);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text:
`🍞【兵糧を喰らい、部隊HPが全快した！】
・HP：${prevHp} ➔ ${player.hp}/${stats.maxHp}
・残り兵糧：🍞×${player.inventory['兵糧']}（上限${getRationCap(player)}）`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // I. 陣況・ステータス確認
    // ------------------------------------------
    } else if (
      userText.includes('ステータス') ||
      userText.includes('確認') ||
      userText.includes('陣況') ||
      userText.includes('状況')
    ) {
      const stats = calculateEffectiveStats(player);
      const s = player.slots;
      const curLoc = getCurrentLocationName(player);
      const resName = getReservedDisplayName(player.reservedLocation);

      const statusText =
`📋【${player.name}・現在の陣況報告】
📍 現在地：${curLoc}
🎯 次回予約：${resName}
❤️ 部隊HP：${player.hp} / ${stats.maxHp}

🪓 主武装：${player.weapon}
・溶接枠（${getTotalSlots(s)}/5）：⛏️鋼${s.steel} / 🛡️板${s.plate} / 🧨火${s.powder} / 🔮石${s.stone}
・実効能力：攻${stats.atk} / 防${stats.def} / 会心${(stats.critRate * 100).toFixed(0)}% / 回避${(stats.dodgeRate * 100).toFixed(0)}% / 吸血${(stats.vampRate * 100).toFixed(0)}%

📦 倉庫物資（素材上限:${getMaterialCap(player)} / 兵糧上限:${getRationCap(player)}）：
⛏️王国鋼：${player.inventory['王国鋼']}個
🛡️装甲板：${player.inventory['装甲板']}個
🧨黒火薬：${player.inventory['黒火薬']}個
🔮魔導石：${player.inventory['魔導石']}個
🍞兵糧：${player.inventory['兵糧']}個

🏰 本陣設備：防壁Lv${player.baseWallLevel} / 武器庫Lv${player.baseArmoryLevel} / 過負荷炉Lv${player.baseFurnaceLevel}`;

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: statusText,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // J. 開発テスト用・素材マックス裏ワザ
    // ------------------------------------------
    } else if (userText === '素材マックス' || userText === '素材MAX' || userText === '裏ワザ') {
      const matCap = getMaterialCap(player);
      const ratCap = getRationCap(player);
      player.inventory['王国鋼'] = matCap;
      player.inventory['装甲板'] = matCap;
      player.inventory['黒火薬'] = matCap;
      player.inventory['魔導石'] = matCap;
      player.inventory['兵糧'] = ratCap;
      player.hp = calculateEffectiveStats(player).maxHp;
      await savePlayer(player);

      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `🎁【開発用物資補給】全素材（${matCap}個）と兵糧（${ratCap}個）を上限まで補充し、HPを全快したぞ！`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // ------------------------------------------
    // K. デフォルト応答（未知のテキスト入力時）
    // ------------------------------------------
    } else {
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `📍 現在地：${getCurrentLocationName(player)}\n次回予約：『${getReservedDisplayName(player.reservedLocation)}』\n▼ 下のボタンから行動を選択せよ。（開幕ストーリーを見る場合は『プロローグ』と送信）`,
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