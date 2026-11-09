import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

// ==========================================
// Gemini AI 実況生成モジュール (aiService.js)
// ==========================================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * 交戦データをもとに臨場感あふれる戦闘報告ログを生成する
 * （gemini-2.5-flash ➔ gemini-2.5-flash-lite ➔ 定型文の自動バックアップ機構付き）
 */
export async function generateRaidNarrative(locationName, battleData, player, enemy, lootText) {
  try {
    const s = player.slots;
    const dramaNotes = [];
    if (battleData.hadMiracleDodge) dramaNotes.push('敵の致命打を黒煙の奇跡的見切りで回避した瞬間');
    if (battleData.hadClutchCrit) dramaNotes.push('部隊壊滅寸前の窮地から火薬の爆破会心で逆転をもぎ取った瞬間');
    const dramaContext = dramaNotes.length > 0 ? `【注目演出】${dramaNotes.join('、')}を必ず強調して熱く描写せよ！` : '';
    const enemyPersona = enemy.quote
      ? `\n敵の人物像・セリフ: ${enemy.quote}${enemy.defeatQuote ? ` / 敗北時: ${enemy.defeatQuote}` : ''}`
      : '';

    const prompt = `
あなたは魔王軍ガルガン卿（他のエリート魔軍卿から見下されている現場叩き上げ幹部）麾下の従軍記録官です。
以下の交戦データをもとに、140〜180文字程度で荒々しく臨場感あふれる戦闘報告ログを作成してください。

戦場: ${locationName}
魔族部隊: ${player.name}（隊長: ${player.leader} / 主武装: ${player.weapon} [鋼:${s.steel} 板:${s.plate} 火:${s.powder} 石:${s.stone}]）
敵: ${enemy.name}${enemyPersona}
勝敗結果: ${battleData.result}（終了ターン: ${battleData.lastTurn}/8ターン / 部隊残HP: ${battleData.finalPlayerHp}/${battleData.stats.maxHp} / 敵残HP: ${battleData.remainEnemyHp}）
强奪戦利品: ${lootText}
${dramaContext}
戦闘経過ログ:
${JSON.stringify(battleData.events, null, 2)}

【描写ルール】
- プレイヤーたちは人間ではなく荒くれ魔族である。血煙、鉄錆、黒火薬の硝煙、容赦ない強奪のアウトローな空気感を出すこと。
- 敵に特有のセリフや個性（新米勇者、老兵、実験狂いの鬼才魔導士、ドS審問官、守銭奴傭兵など）がある場合、その鼻っ柱をへし折るピカレスクな痛快さを描写すること。
- 火薬の装甲貫通爆発や土壇場の逆転劇、黒煙での回避があればその瞬間を熱くハイライトすること。
- 敗北時は、なぜ押し負けたかを荒っぽく悔しがりながら直前の前線拠点へ1歩後退して再戦を誓う描写にすること。
- 文末は「〜した。〜だ。」調で歯切れよくまとめること。
`;

    let response;
    try {
      // 第1優先：メインモデル (gemini-2.5-flash)
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
    } catch (primaryErr) {
      // 第2優先：制限・混雑時は自動でバックアップモデル (gemini-2.5-flash-lite) へ切り替え
      console.warn('>>> [AI Backup] gemini-2.5-flash 制限またはエラーのため gemini-2.5-flash-lite へ自動切替:', primaryErr.message);
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: prompt,
      });
    }

    return response.text.trim();
  } catch (err) {
    // 第3優先：万一両方とも通信エラーの場合の安全な定型文フォールバック
    console.error('>>> AI実況生成エラー（定型文へフォールバック）:', err.message);
    if (battleData.result === 'WIN') {
      return `【${locationName}】の死闘を制した！${player.leader}率いる魔族小隊は${enemy.name}を力尽くでねじ伏せ、戦利品（${lootText}）を根こそぎ強奪した！`;
    } else {
      return `【${locationName}】の壁は厚かった。${enemy.name}の猛攻を前に決定打を欠き、シンジ班は血反吐を吐きながら直前の前線陣地へと1歩後退し、再戦の機会を窺った。`;
    }
  }
}