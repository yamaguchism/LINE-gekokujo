import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

// ==========================================
// Gemini AI 戦記小説生成モジュール (aiService.js)
// ==========================================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * 武器スロットの構成から、戦闘スタイルの描写指針を言語化する
 */
function describeWeaponStyle(player) {
  const s = player.slots || { steel: 0, plate: 0, powder: 0, stone: 0 };
  const sixth = player.sixthSlot;
  const traits = [];

  if ((s.steel || 0) >= 3 || sixth === 'steel') {
    traits.push('王国鋼を過剰溶接した超重量・剛力粉砕仕様');
  } else if ((s.steel || 0) >= 1) {
    traits.push('王国鋼の重厚な斬撃');
  }

  if ((s.plate || 0) >= 3 || sixth === 'plate') {
    traits.push('分厚い装甲板を幾重にも張り巡らせた鉄壁の重装仕様');
  } else if ((s.plate || 0) >= 1) {
    traits.push('装甲板で敵の刃を受け止める堅牢さ');
  }

  if ((s.powder || 0) >= 2 || sixth === 'powder') {
    traits.push('黒火薬の連装誘爆による装甲貫通爆発と黒煙の攪乱');
  } else if ((s.powder || 0) === 1) {
    traits.push('仕込み黒火薬の炸裂と硝煙');
  }

  if ((s.stone || 0) >= 2 || sixth === 'stone') {
    traits.push('複数の魔導石が禍々しい紫光を放ち、斬りつけた敵から生気を強引に啜り取る吸血呪装');
  } else if ((s.stone || 0) === 1) {
    traits.push('魔導石の妖しい脈動による生命力吸収');
  }

  if (sixth) {
    traits.push('限界覚醒した第6スロットが赤熱し火花を散らす暴走状態');
  }

  return traits.length > 0 ? traits.join(' ＋ ') : '無骨な鉄塊を振り回す荒々しい肉弾戦';
}

/**
 * 交戦データと戦場の情景をもとに『みんなdeクエスト』調の濃密な冒険戦記を生成する
 * （gemini-2.5-flash ➔ gemini-2.5-flash-lite ➔ 重厚定型文の自動バックアップ機構付き）
 */
export async function generateRaidNarrative(locationName, battleData, player, enemy, lootText, options = {}) {
  const {
    locDesc = '',
    sceneType = 'RAID', // 'RAID' | 'BOSS' | 'CHALLENGE' | 'CASTLE' | 'RETURN' | 'DEFENSE' | 'DRAWBRIDGE' | 'TWO_STEP'
    isCapped = false,
    rawDropName = '',
  } = options;

  try {
    const s = player.slots || { steel: 0, plate: 0, powder: 0, stone: 0 };
    const weaponStyle = describeWeaponStyle(player);
    const isClimax = sceneType === 'BOSS' || sceneType === 'CHALLENGE' || sceneType === 'CASTLE';
    const isRoutineWin = (sceneType === 'RAID' || sceneType === 'DRAWBRIDGE') && battleData.result === 'WIN';

    // 戦闘ハイライトの抽出（平時周回の勝利時は過剰演出を避けるため最小限に抑える）
    const highlights = [];
    if (battleData.hadMiracleDodge) {
      highlights.push('立ち込める黒火薬の黒煙に紛れ、敵の致命的な一撃を紙一重で見切って躱した瞬間');
    }
    if (battleData.hadClutchCrit) {
      highlights.push('部隊が血塗れで壊滅寸前の窮地に陥った刹那、背水の黒火薬が一斉誘爆して敵の装甲ごと吹き飛ばした逆転撃');
    }
    if (battleData.result === 'WIN' && battleData.finalPlayerHp <= battleData.stats.maxHp * 0.25) {
      highlights.push(`残りHPわずか${battleData.finalPlayerHp}という薄氷の死闘を制した生々しい息遣い`);
    } else if (!isRoutineWin && battleData.result === 'WIN' && battleData.lastTurn <= 3) {
      highlights.push(`${battleData.lastTurn}ターンで敵を圧倒・蹂躙した電撃的な暴力`);
    }

    // 敵ギミックの描写指示
    if (enemy.gimmick === 'POISON_GAS') {
      highlights.push('肺を焼く濃緑の猛毒ガスが戦場に充満する苦悶の空気');
    } else if (enemy.gimmick === 'REFLECT_SHIELD') {
      highlights.push('殴りつけるたびに衝撃が跳ね返る神聖反射盾の厄介さと、それを力と吸血でねじ伏せる攻防');
    } else if (enemy.gimmick === 'BERSERK') {
      highlights.push('手傷を負った敵が血走った目で狂乱覚醒し、倍化した剛力で戦斧を振り回す恐怖');
    } else if (enemy.gimmick === 'EXECUTE_6T') {
      highlights.push('聖剣が刻一刻と破滅の光を溜め込むカウントダウンの焦燥感');
    } else if (enemy.gimmick === 'SUPER_ARMOR') {
      highlights.push('尋常な刃では傷一つ付かない神聖巨像の超重装甲');
    }

    // ==========================================
    // シーン別の構成ルール（3段階の熱量・文字数メリハリ制御）
    // ==========================================
    let sceneInstruction = '';
    if (isClimax) {
      // 【超激熱：長尺 340〜420文字】ボス戦・挑戦・ヴァルハイト城郭戦
      sceneInstruction = `
【シーン構成：強敵・ボスとの激突（目標：340〜420文字、2〜3段落 / 熱量：最大）】
ここは物語の重大な山場だ。平時の周回とは明確に一線を画す、血と鉄と泥が沸騰するような死闘を全力で描け。
1. 導入：戦場（${locationName}）の重苦しい空気と、立ち塞がる『${enemy.name}』の圧倒的な威圧感やセリフからいきなり書き始めよ。
2. 激突：敵の猛攻による肉体の軋み（骨が鳴る音、火花、血煙）と、こちらの『${player.weapon}（${weaponStyle}）』による執念の応酬を五感で描け。
3. 決着：${battleData.result === 'WIN' ? '決定打が敵の装甲ごと肉体を粉砕して崩れ落ちる瞬間と、格上のエリートを泥濘に引きずり下ろした下剋上のカタルシスで締めくくれ。' : '敵の圧倒的な壁（装甲や狂乱の猛撃）に阻まれ、血反吐を吐きながら悔しげに直前の前線拠点へ1歩退却し、武器を鍛え直しての再戦を誓う屈辱の場面で締めくくれ。'}`;
    } else if (sceneType === 'DEFENSE') {
      // 【冷徹な処刑：中尺 170〜230文字】本陣アジト防衛戦
      sceneInstruction = `
【シーン構成：本陣アジト奇襲防衛戦（目標：170〜230文字厳守、2段落 / トーン：冷酷・電撃処刑）】
長々しい苦戦描写は不要だ。縄張りに土足で踏み込んできた愚かな人間軍を、罠と火力で「手際よくミンチにして身ぐるみ剥がす」スピーディな迎撃劇を描け。
1. 開幕：夜霧や砂塵を突いて本陣へ接近した『${enemy.name}』を、防壁の迎撃鉄杭が容赦なく串刺しにして出鼻を挫く場面から始めよ。
2. 処刑：怯んだ敵隊列へ飛び出し、『${player.weapon}』の暴力で一息に粉砕して物資を剥ぎ取る悪党の冷徹な手際で締めくくれ。`;
    } else if (sceneType === 'RETURN') {
      // 【野性の安堵：中尺 180〜240文字】本陣への強襲凱旋
      sceneInstruction = `
【シーン構成：本陣アジトへの強襲凱旋（目標：180〜240文字、2段落）】
1. 退路を塞ぐ人間軍の哨戒兵（${enemy.name}）を蹴散らし、物資を奪い取って突破する荒々しい撤収戦を描け。
2. 仲間の待つ本陣へ帰還し、焚き火の煙と焼ける肉の匂いの中で泥と血を拭い、部隊の傷が癒えていく野性の活気で締めくくれ。`;
    } else if (sceneType === 'TWO_STEP') {
      // 【疾走：中短尺 150〜200文字】夜間2連遠征の第1幕
      sceneInstruction = `
【シーン構成：連続強襲作戦の1幕（目標：150〜200文字厳守、1〜2段落）】
1. 戦場（${locationName}：${locDesc}）の情景と、奇襲の勢いで『${enemy.name}』を蹴散らす場面を短く鋭く描け。
2. 戦利品（${lootText}）を素早く回収し、息つく間もなく次の戦場へと駆け出す疾走感で締めくくれ。`;
    } else if (battleData.result !== 'WIN') {
      // 【挫折：中尺 200〜260文字】通常拠点での敗北・撤退時
      sceneInstruction = `
【シーン構成：略奪失敗・痛恨の後退（目標：200〜260文字、2段落）】
1. 戦場（${locationName}）での『${enemy.name}』との交戦。こちらの『${player.weapon}』の刃が通りきらず、思わぬ猛反撃を食らう焦燥感を描け。
2. 泥水を噛みながら舌打ち一つで1歩後退し、装備の組み替えや補給の必要性を痛感する生々しい撤退シーンで締めくくれ。`;
    } else {
      // 【微熱・乾いた日常：短尺 110〜150文字厳守】平時の略奪周回（RAID / DRAWBRIDGE 勝利時）
      sceneInstruction = `
【シーン構成：平時の略奪ルーチン（目標：110〜150文字厳守、1〜2段落 / トーン：乾いた日常・簡潔）】
※絶対にボス戦のような大長編や大げさな叙事詩にするな！毎日届く定時報告として、スマホで3秒で小気味よく読める「乾いた戦場のスナップショット」に削ぎ落とせ。
1. 戦場（${locationName}：${locDesc}）の匂いや空気感の中、『${enemy.name}』を『${player.weapon}』の一撃で手早く片付けるプロの手際を簡潔に描け（スロット効果を全部長々と説明する必要はない。最も特徴的な1要素だけでよい）。
2. 荷車や敵の懐から戦利品（${lootText}）を無造作に奪い取り、騒ぎになる前に撤収する泥臭い日常感でスパッと締めくくれ。`;
    }

    // 戦利品・倉庫あふれの描写指示（ハードコードの「シンジ」を排除し「隊長」に統一）
    let lootInstruction = `強奪戦利品: ${lootText}`;
    if (battleData.result === 'WIN' && isCapped && rawDropName) {
      lootInstruction = `戦利品状況: 現地で『${rawDropName}』を奪い取ったが、すでに部隊の背嚢（武器庫）が満杯でこれ以上持ち切れず、隊長が舌打ちしながら余った『${rawDropName}』を泥濘へ蹴り捨てた（または荷車ごと叩き壊した）場面を終盤に必ず描け（※「×0を強奪した」とは絶対に書くな）。`;
    }

    const enemyPersona = enemy.quote
      ? `\n敵の人物像・登場セリフ: ${enemy.quote}${enemy.defeatQuote ? `\n敵の断末魔・敗北セリフ: ${enemy.defeatQuote}` : ''}\n（※ボス戦ではこれらのセリフを劇中に組み込め。平時周回ではテンポ優先で省略・圧縮してよい）`
      : '';

    const prompt = `
あなたは往年の名作テキストRPG『みんなdeクエスト』の専属シナリオライターであり、魔王軍ガルガン卿麾下の従軍記録官です。
以下のデータをもとに、プレイヤー（隊長：${player.leader}）が戦場の空気を肌で感じるダークファンタジー戦記を執筆してください。

【戦場情報】
場所: ${locationName}
背景設定: ${locDesc || '人間軍と魔族が覇権を争う最前線'}
主人公部隊: ${player.name}（隊長名: ${player.leader} / 主武装: ${player.weapon} [鋼:${s.steel} 板:${s.plate} 火:${s.powder} 石:${s.stone}]）
武器の特徴: ${weaponStyle}
交戦相手: ${enemy.name}（攻撃技: ${enemy.attackName || '通常攻撃'}）${enemyPersona}
勝敗結果: ${battleData.result}（決着ターン: ${battleData.lastTurn}/8ターン / 部隊残HP: ${battleData.finalPlayerHp}/${battleData.stats.maxHp} / 敵残HP: ${battleData.remainEnemyHp}）
${lootInstruction}
${highlights.length > 0 ? `【劇中に織り込むべきハイライト】\n- ${highlights.join('\n- ')}` : ''}

戦闘経過データ（参考）:
${JSON.stringify(battleData.events)}

${sceneInstruction}

【絶対遵守の執筆ルール（違反厳禁）】
1. 名前連呼の禁止：隊長名「${player.leader}」および部隊名「${player.name}」という固有名詞は、文章全体を通して【合計1回まで】しか出してはならない（別名での勝手な言い換えも禁止）。2回目以降は主語を省略するか、「隊長」「その剛腕」「一行」などの代名詞を使え。
2. 陳腐なラノベ定型句の禁止：「電光石火」「唇の端に笑みを刻む」「満足げな笑み」「不敵な笑み」「夜の闇へと消え去った」「奇跡」といった気取った手垢まみれの表現は一切使用禁止。泥水、鉄錆、硝煙、乾パンや脂の匂いなど、最底辺のざらついたリアリティで描け。
3. 冒頭に「【〇〇】の死闘を制した！」のような機械的な要約文を置くな。1行目から戦場の情景・音・匂い・動きで読者を引き込め。
4. ゲーム内部のシステム数値（「攻撃力56」「HP半減で2倍」「×0個」など）をそのまま地の文で説明するな。すべて物語の表現に翻訳せよ。
5. 指定された目標文字数を厳守し、文末は「〜した。〜だ。」調の硬派なピカレスク文体で統一せよ。
`;

    let response;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
    } catch (primaryErr) {
      console.warn('>>> [AI Backup] gemini-2.5-flash 制限またはエラーのため gemini-2.5-flash-lite へ自動切替:', primaryErr.message);
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: prompt,
      });
    }

    return response.text.trim();
  } catch (err) {
    console.error('>>> AI実況生成エラー（戦記風定型文へフォールバック）:', err.message);
    const isClimax = sceneType === 'BOSS' || sceneType === 'CHALLENGE' || sceneType === 'CASTLE';
    const quoteLine = (isClimax && enemy.quote) ? `${enemy.quote}\n` : '';
    const defeatLine = (isClimax && battleData.result === 'WIN' && enemy.defeatQuote) ? `\n${enemy.defeatQuote}` : '';

    if (battleData.result === 'WIN') {
      if (!isClimax && (sceneType === 'RAID' || sceneType === 'DRAWBRIDGE')) {
        // 平時周回フォールバック（短尺・乾いた日常）
        const shortLoot = (isCapped && rawDropName)
          ? `奪った『${rawDropName}』は背嚢に入りきらず、隊長は舌打ちして余剰分を泥濘へ蹴り飛ばした。`
          : `転がった荷から戦利品（${lootText}）を手早く回収し、追っ手が集まる前に戦場を後にした。`;
        return `【${locationName}】の物陰から飛び出した${player.name}は、迎え撃つ『${enemy.name}』へ『${player.weapon}』を叩き込んだ。鈍い破砕音とともに護衛を蹴散らす。${shortLoot}`;
      }

      const lootPhrase = (isCapped && rawDropName)
        ? `転がった『${rawDropName}』に手を伸ばすが、背嚢はすでに限界まで軋んでいる。隊長は舌打ちして余剰分を蹴り飛ばすと、硝煙の立ち込める戦場を後にした。`
        : `崩れ落ちた敵の傍らから戦利品（${lootText}）を荒々しく剥ぎ取ると、隊長は血と煤に塗れた斧を肩に担ぎ、硝煙のくすぶる戦場を後にした。`;
      return `硝煙と鉄錆の匂いが立ち込める【${locationName}】に、荒くれ魔族たちの咆哮が響き渡る。\n${quoteLine}迎え撃つ『${enemy.name}』の猛攻が火花を散らすが、${player.leader}は『${player.weapon}』を渾身の力で振り抜き、敵の防備を力尽くで粉砕した！${defeatLine}\n\n${lootPhrase}`;
    } else {
      return `【${locationName}】に張り巡らされた敵の防衛網は想像以上に分厚かった。\n${quoteLine}『${enemy.name}』の容赦ない猛撃に晒され、骨を軋ませながら『${player.weapon}』で応戦するも決定打には届かない。${player.leader}は血反吐を吐きながら退却の号令を下し、再戦の牙を研ぐため直前の前線陣地へと1歩後退した。`;
    }
  }
}