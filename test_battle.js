import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

// .env から安全にキーを読み込む
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. バトルの計算（裏方の電卓）
function simulateBattle(player, enemy) {
  const logs = [];
  let pHP = player.hp;
  let eHP = enemy.hp;
  let turn = 1;

  while (pHP > 0 && eHP > 0 && turn <= 10) {
    // プレイヤーの攻撃
    const pDmg = Math.max(5, player.atk - enemy.def);
    eHP -= pDmg;
    logs.push({
      turn,
      actor: player.name,
      action: player.weapon,
      damage: pDmg,
      targetRemainHp: Math.max(0, eHP),
    });

    if (eHP <= 0) break;

    // 敵の反撃
    const eDmg = Math.max(5, enemy.atk - player.def);
    pHP -= eDmg;
    logs.push({
      turn,
      actor: enemy.name,
      action: '強烈な体当たり',
      damage: eDmg,
      targetRemainHp: Math.max(0, pHP),
    });

    turn++;
  }

  return {
    result: pHP > 0 && eHP <= 0 ? 'WIN' : 'LOSE',
    finalPlayerHp: Math.max(0, pHP),
    events: logs,
  };
}

// 2. AIによる実況生成（アナウンサー）
async function generateBattleNarrative(battleData, player, enemy) {
  const prompt = `
あなたは危険な大坑道を舞台にしたハードボイルドな冒険日誌の記録官です。
以下の戦闘シミュレーション結果（JSON）をもとに、臨場感あふれる戦闘ログを日本語で作成してください。

【執筆ルール】
- 文字数は180〜220文字程度。
- 泥臭さ、金属音、火薬の熱、衝撃の手応えを強調する。
- データの改ざんは不可（勝敗や残りHPの危機感を厳密に反映する）。
- 「〜した。〜だった。」調の引き締まった硬派な文体にする。

【戦闘データ】
プレイヤー: ${player.name}（装備: ${player.weapon}）
敵: ${enemy.name}
結果: ${battleData.result}（プレイヤー最終HP: ${battleData.finalPlayerHp}）
戦闘経緯:
${JSON.stringify(battleData.events, null, 2)}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  return response.text;
}

// 3. 実行部分
async function main() {
  const player = { name: 'シンジ', hp: 80, atk: 28, def: 12, weapon: '削岩式パイルバンカー' };
  const enemy = { name: '硬質甲殻モグラ', hp: 70, atk: 22, def: 8 };

  console.log('--- 1. バトル計算中... ---');
  const battleData = simulateBattle(player, enemy);
  console.log(`勝敗: ${battleData.result} / プレイヤー残りHP: ${battleData.finalPlayerHp}`);

  console.log('\n--- 2. AIが実況を執筆中... ---');
  const story = await generateBattleNarrative(battleData, player, enemy);
  console.log('\n【完成した冒険ログ（LINEに届く文章）】\n');
  console.log(story);
}

main().catch(console.error);