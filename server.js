import 'dotenv/config';
import express from 'express';
import { middleware, messagingApi } from '@line/bot-sdk';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

// 分割モジュールのインポート
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

// ==========================================
// 1. 各種設定（LINE API・Express初期化）
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

const app = express();

// public フォルダ内の画像を外部公開
app.use('/public', express.static(path.resolve('public')));

// ==========================================
// 2. 定時実行スケジュール（8時・12時・20時）
// ==========================================
cron.schedule('0 8,12,20 * * *', async () => {
  console.log('>>> [定時時刻到来] 全小隊の一斉行動を開始...');
  await executeScheduledRaids(lineClient);
});

// ==========================================
// 3. Web古地図配信エンドポイント（/map）
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
// 4. LINE Webhook ルーティング
// ==========================================
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.status(200).end();

  const events = req.body.events;
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userText = event.message.text.trim();
    const userId = event.source.userId;
    let { player } = await getOrCreatePlayer(userId);

    // A. 開幕・リセット・作戦地図・行動選択
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
        player = normalizePlayer(createInitialPlayer(userId), userId);
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

    // B. 予約解除（リッチメニュー「🔄 行動変更」連動）
    } else if (userText === '予約解除') {
      player.reservedLocation = null;
      await savePlayer(player);

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

▼ 続けて城へ再突入するか、兵站所やアジトへ戻るかを選べ！`,
            quickReply: makeQuickReply(getSmartButtons(player)),
          }],
        });
        return;
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
      await savePlayer(player);

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
        await savePlayer(player);

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
          await savePlayer(player);

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
          await savePlayer(player);

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
          await savePlayer(player);

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
    } else if (userText.startsWith('出撃：') || userText.includes('白銀城塞') || Object.keys(MAP_LOCATIONS).some((k) => userText.includes(k))) {
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
      await savePlayer(player);

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

    // E. テスト即時決行 ＆ テスト防衛戦
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
      await executeScheduledRaids(lineClient, userId, isDef);

    // F. 鍛冶場・キメラ武器改造
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

    // G-0. 独立第6スロット操作
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
        await savePlayer(player);

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

      await savePlayer(player);

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

      await savePlayer(player);

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

    // H. 回復・兵糧
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
      await savePlayer(player);

      const notice = player.reservedLocation ? `\n（※次回予約：『${getReservedDisplayName(player.reservedLocation)}』）` : '';
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `🍖【魔族の暴食補給】\n強奪した兵糧を引き裂いて貪り喰らい、荒くれどもの傷が100%全快した！（HP: ${player.hp}/${stats.maxHp}）\n残り兵糧: ${player.inventory['兵糧']}/${getRationCap(player)}袋${notice}\n\n▼ 傷は癒えたぞ！下のボタンからボスへの再突撃や進軍先を選べ！`,
          quickReply: makeQuickReply(getSmartButtons(player)),
        }],
      });

    // I. ステータス・陣況確認
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

    // ★ 開発テスト用裏ワザ：素材マックス補充
    } else if (userText === '素材マックス' || userText === '素材MAX' || userText === '裏ワザ') {
      const maxMat = Math.max(getMaterialCap(player), 15);
      const maxRat = Math.max(getRationCap(player), 30);
      player.inventory['王国鋼'] = maxMat;
      player.inventory['装甲板'] = maxMat;
      player.inventory['黒火薬'] = maxMat;
      player.inventory['魔導石'] = maxMat;
      player.inventory['兵糧'] = maxRat;
      await savePlayer(player);

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