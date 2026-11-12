import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

// ==========================================
// Gemini AI 戦記小説＆魔王城幕間劇生成モジュール (aiService.js)
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
    traits.push('王国鋼の重厚な打撃');
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
 * Gemini API 呼び出し共通ラッパー（2.5-flash ➔ 2.5-flash-lite 自動フォールバック）
 */
async function callGeminiWithFallback(prompt) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text.trim();
  } catch (primaryErr) {
    console.warn('>>> [AI Backup] gemini-2.5-flash 制限またはエラーのため gemini-2.5-flash-lite へ自動切替:', primaryErr.message);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: prompt,
    });
    return response.text.trim();
  }
}

/**
 * 第1幕：交戦データと戦場の情景をもとにダークファンタジー戦記を生成する
 */
export async function generateRaidNarrative(locationName, battleData, player, enemy, lootText, options = {}) {
  const {
    locDesc = '',
    sceneType = 'RAID', // 'RAID' | 'BOSS' | 'CHALLENGE' | 'CASTLE' | 'RETURN' | 'DEFENSE' | 'DRAWBRIDGE' | 'TWO_STEP'
    isCapped = false,
    rawDropName = '',
  } = options;

  const isBossNode = locationName.includes('ボス') || locationName.includes('関門') || Boolean(enemy?.isBoss);
  const isClimax = sceneType === 'BOSS' || sceneType === 'CHALLENGE' || sceneType === 'CASTLE' || isBossNode;

  try {
    const s = player.slots || { steel: 0, plate: 0, powder: 0, stone: 0 };
    const hasPowder = (s.powder || 0) >= 1 || player.sixthSlot === 'powder';
    const weaponStyle = describeWeaponStyle(player);
    const isRoutineWin = (sceneType === 'RAID' || sceneType === 'DRAWBRIDGE') && !isClimax && battleData.result === 'WIN';

    // 戦闘ハイライトの抽出（火薬の有無と矛盾しないよう厳密に分岐）
    const highlights = [];
    if (battleData.hadMiracleDodge) {
      if (hasPowder) {
        highlights.push('仕込み黒火薬が噴き上げた黒煙に紛れ、敵の致命的な一撃を紙一重で見切って躱した瞬間');
      } else {
        highlights.push('泥濘に足を取られたと見せかけて半歩沈み込み、斧側面の装甲板で敵の凶刃を火花とともに逸らした紙一重の回避');
      }
    }
    if (battleData.hadClutchCrit) {
      if (hasPowder) {
        highlights.push('部隊が血塗れで壊滅寸前の窮地に陥った刹那、背水の黒火薬が一斉誘爆して敵の装甲ごと吹き飛ばした逆転撃');
      } else {
        highlights.push('部隊が壊滅寸前の窮地に追い込まれた刹那、全身の体重と怨念を乗せた渾身の鉄塊撃で敵の防備を粉砕した逆転劇');
      }
    }
    if (battleData.result === 'WIN' && battleData.finalPlayerHp <= battleData.stats.maxHp * 0.25) {
      highlights.push('部隊が半壊し血塗れになりながらも、執念で死闘を制した荒い息遣い');
    } else if (!isRoutineWin && battleData.result === 'WIN' && battleData.lastTurn <= 3) {
      highlights.push('開戦からわずか数合の打ち合いで敵を圧倒・粉砕した暴力的な突破力');
    }

    // 敵ギミックの描写指示
    if (enemy.gimmick === 'POISON_GAS') {
      highlights.push('肺を焼く濃緑の猛毒ガスが戦場に充満する苦悶の空気');
    } else if (enemy.gimmick === 'REFLECT_SHIELD') {
      highlights.push('殴りつけるたびに衝撃が跳ね返る神聖反射盾の厄介さと、それを質量と執念でねじ伏せる攻防');
    } else if (enemy.gimmick === 'BERSERK') {
      highlights.push('手傷を負った敵が血走った目で狂乱覚醒し、倍化した怪力で得物を振り回す脅威');
    } else if (enemy.gimmick === 'EXECUTE_6T') {
      highlights.push('聖剣が刻一刻と破滅の光を溜め込むカウントダウンの焦燥感');
    } else if (enemy.gimmick === 'SUPER_ARMOR') {
      highlights.push('尋常な刃では傷一つ付かない神聖巨像の超重装甲');
    }

    // シーン別の構成ルール（3段階の熱量・文字数メリハリ制御）
    let sceneInstruction = '';
    if (isClimax) {
      sceneInstruction = `
【シーン構成：強敵・ボスとの激突（目標：340〜420文字、2〜3段落 / 熱量：最大）】
ここは物語の重大な山場だ。平時の周回とは明確に一線を画す、血と鉄と泥が沸騰するような死闘を全力で描け。
1. 導入：戦場（${locationName}）の視覚・聴覚的な緊張感と、立ち塞がる『${enemy.name}』の圧倒的な威圧感やセリフからいきなり書き始めよ。
2. 激突：敵の猛攻による肉体の軋み（骨が鳴る音、火花、泥水）と、こちらの『${player.weapon}（${weaponStyle}）』による重く泥臭い応酬を描け。
3. 決着：${battleData.result === 'WIN' ? '決定打が敵の装甲ごと肉体を叩き潰して崩れ落ちる瞬間と、格上のエリートを泥濘に引きずり下ろした下剋上のカタルシスで締めくくれ。' : '敵の圧倒的な壁（装甲や狂乱の猛撃）に阻まれ、血反吐を吐きながら悔しげに直前の前線拠点へ1歩退却し、武器を鍛え直しての再戦を誓う屈辱の場面で締めくくれ。'}`;
    } else if (sceneType === 'DEFENSE') {
      sceneInstruction = `
【シーン構成：本陣アジト奇襲防衛戦（目標：170〜230文字厳守、2段落 / トーン：冷酷・電撃処刑）】
長々しい苦戦描写は不要だ。縄張りに土足で踏み込んできた愚かな人間軍を、罠と火力で「手際よくミンチにして身ぐるみ剥がす」スピーディな迎撃劇を描け。
1. 開幕：夜霧や砂塵を突いて本陣へ接近した『${enemy.name}』を、防壁の迎撃鉄杭が容赦なく串刺しにして出鼻を挫く場面から始めよ。
2. 処刑：怯んだ敵隊列へ飛び出し、『${player.weapon}』の暴力で一息に粉砕して物資を剥ぎ取る悪党の冷徹な手際で締めくくれ。`;
    } else if (sceneType === 'RETURN') {
      sceneInstruction = `
【シーン構成：本陣アジトへの強襲凱旋（目標：180〜240文字、2段落）】
1. 退路を塞ぐ人間軍の哨戒兵（${enemy.name}）を蹴散らし、物資を奪い取って突破する荒々しい撤収戦を描け。
2. 仲間の待つ本陣へ帰還し、焚き火の火照りと鍋の湯気の中で泥と血を拭い、部隊の傷が癒えていく野性の活気で締めくくれ。`;
    } else if (sceneType === 'TWO_STEP') {
      sceneInstruction = `
【シーン構成：連続強襲作戦の1幕（目標：140〜190文字厳守、1〜2段落）】
1. 戦場（${locationName}：${locDesc}）の情景と、奇襲の勢いで『${enemy.name}』を蹴散らす場面を短く鋭く描け。
2. 戦利品（${lootText}）を素早く回収し、息つく間もなく次の標的へと泥を蹴って駆け出す疾走感で締めくくれ。`;
    } else if (battleData.result !== 'WIN') {
      sceneInstruction = `
【シーン構成：略奪失敗・痛恨の後退（目標：200〜260文字、2段落）】
1. 戦場（${locationName}）での『${enemy.name}』との交戦。こちらの『${player.weapon}』の打撃が通りきらず、思わぬ猛反撃を食らう焦燥感を描け。
2. 泥水を噛みながら舌打ち一つで1歩後退し、装備の組み替えや補給の必要性を痛感する生々しい撤退シーンで締めくくれ。`;
    } else {
      sceneInstruction = `
【シーン構成：平時の略奪ルーチン（目標：110〜150文字厳守、1〜2段落 / トーン：乾いた日常・簡潔）】
※絶対にボス戦のような大長編や大げさな叙事詩にするな！毎日届く定時報告として、スマホで3秒で小気味よく読める「乾いた戦場のスナップショット」に削ぎ落とせ。
1. 戦場（${locationName}：${locDesc}）の空気感の中、『${enemy.name}』を『${player.weapon}』の一撃で手早く片付けるプロの手際を簡潔に描け（スロット効果を全部説明する必要はない）。
2. 荷車や敵の懐から戦利品（${lootText}）を無造作に奪い取り、騒ぎになる前に撤収する泥臭い日常感でスパッと締めくくれ。`;
    }

    let lootInstruction = `強奪戦利品: ${lootText}`;
    if (battleData.result === 'WIN' && isCapped && rawDropName) {
      lootInstruction = `戦利品状況: 現地で『${rawDropName}』を奪い取ったが、すでに部隊の背嚢（武器庫）が満杯でこれ以上持ち切れず、隊長が舌打ちしながら余った『${rawDropName}』を泥濘へ蹴り捨てた（または荷車ごと叩き壊した）場面を終盤に必ず描け（※「×0を強奪した」とは絶対に書くな）。`;
    }

    const enemyPersona = enemy.quote
      ? `\n敵の人物像・登場セリフ: ${enemy.quote}${enemy.defeatQuote ? `\n敵の断末魔・敗北セリフ: ${enemy.defeatQuote}` : ''}\n（※ボス戦ではこれらのセリフを劇中に組み込め。平時周回ではテンポ優先で省略してよい）`
      : '';

    const prompt = `
あなたは往年の名作テキストRPG『みんなdeクエスト』の専属シナリオライターであり、魔王軍ガルガン卿麾下の従軍記録官です。
以下のデータをもとに、プレイヤー（隊長：${player.leader}）が戦場の空気を肌で感じるダークファンタジー戦記を執筆してください。

【戦場情報】
場所: ${locationName}
背景設定: ${locDesc || '人間軍と魔族が覇権を争う最前線'}
主人公部隊: ${player.name}（隊長名: ${player.leader} / 主武装: ${player.weapon} [鋼:${s.steel} 板:${s.plate} 火:${s.powder} 石:${s.stone}]）
武器の特徴: ${weaponStyle}
※重要：黒火薬スロットが「0」の場合、火薬の爆発や黒煙の描写は絶対に書くな。装備している素材（鋼・板・火薬・石）のうち、実際に数値が1以上のものだけを描写せよ。
交戦相手: ${enemy.name}（攻撃技: ${enemy.attackName || '通常攻撃'}）${enemyPersona}
勝敗結果: ${battleData.result}
${lootInstruction}
${highlights.length > 0 ? `【劇中に織り込むべきハイライト】\n- ${highlights.join('\n- ')}` : ''}

戦闘経過データ（参考）:
${JSON.stringify(battleData.events)}

${sceneInstruction}

【絶対遵守の執筆ルール（違反厳禁）】
1. 名前連呼の禁止：隊長名「${player.leader}」および部隊名「${player.name}」という固有名詞は、文章全体を通して【合計1回まで】しか出してはならない。2回目以降は主語を省略するか、「隊長」「男」「一行」などの代名詞を使え。
2. AI手癖・陳腐表現の禁止：「電光石火」「剛腕」「閃く」「唇の端に笑みを刻む」「満足げな笑み」「不敵な笑み」「夜の闇へと消え去った」「夜闇へと消えた」「奇跡」は一切使用禁止。『${player.weapon}』は鋭く閃く刀ではなく、質量で叩き潰す・抉る・へし折る無骨な凶器として描け。
3. 書き出しの多様化：毎回「〇〇の匂いが立ち込める」から書き始めるな。足元の泥が跳ねる音、鉄具の軋み、冷たい風、敵兵の荒い息など、導入の切り口を固定化するな。
4. ゲーム内部のシステム用語（「ターン」「HP」「攻撃力56」「×0個」など）をそのまま地の文やセリフに出すな。すべて物語の表現に翻訳せよ。
5. 指定された目標文字数を厳守し、文末は「〜した。〜だ。」調の硬派なピカレスク文体で統一せよ。
`;

    return await callGeminiWithFallback(prompt);
  } catch (err) {
    console.error('>>> AI実況生成エラー（戦記風定型文へフォールバック）:', err.message);
    const quoteLine = (isClimax && enemy.quote) ? `${enemy.quote}\n` : '';
    const defeatLine = (isClimax && battleData.result === 'WIN' && enemy.defeatQuote) ? `\n${enemy.defeatQuote}` : '';

    if (battleData.result === 'WIN') {
      if (!isClimax && (sceneType === 'RAID' || sceneType === 'DRAWBRIDGE')) {
        const shortLoot = (isCapped && rawDropName)
          ? `奪った『${rawDropName}』は背嚢に入りきらず、隊長は舌打ちして余剰分を泥濘へ蹴り飛ばした。`
          : `転がった荷から戦利品（${lootText}）を手早く回収し、追っ手が集まる前に戦場を後にした。`;
        return `【${locationName}】の物陰から飛び出した${player.name}は、迎え撃つ『${enemy.name}』へ『${player.weapon}』を叩き込んだ。鈍い破砕音とともに護衛を蹴散らす。${shortLoot}`;
      }

      const lootPhrase = (isCapped && rawDropName)
        ? `転がった『${rawDropName}』に手を伸ばすが、背嚢はすでに限界まで軋んでいる。隊長は舌打ちして余剰分を蹴り飛ばすと、硝煙のくすぶる戦場を後にした。`
        : `崩れ落ちた敵の傍らから戦利品（${lootText}）を荒々しく剥ぎ取ると、隊長は血と煤に塗れた斧を肩に担ぎ、戦場を後にした。`;
      return `【${locationName}】に荒くれ魔族たちの咆哮が響き渡る。\n${quoteLine}迎え撃つ『${enemy.name}』の猛攻が火花を散らすが、${player.leader}は『${player.weapon}』を渾身の力で振り抜き、敵の防備を力尽くで粉砕した！${defeatLine}\n\n${lootPhrase}`;
    } else {
      return `【${locationName}】に張り巡らされた敵の防衛網は想像以上に分厚かった。\n${quoteLine}『${enemy.name}』の容赦ない猛撃に晒され、骨を軋ませながら『${player.weapon}』で応戦するも決定打には届かない。${player.leader}は血反吐を吐きながら退却の号令を下し、再戦の牙を研ぐため直前の前線陣地へと1歩後退した。`;
    }
  }
}

/**
 * ボス戦の進行度（全8段階）に応じて、幕間劇で開示する裏設定と3人の態度変化を取得する
 */
function getStageLoreConfig(locationName, enemyName = '') {
  const target = `${locationName} ${enemyName}`;

  // 1章①：前哨砦（魔導重装兵バルツ）
  if (target.includes('前哨砦') || target.includes('バルツ')) {
    return {
      stageTitle: '第1章・中ボス突破（建前の同格と兵糧干殺し）',
      lorePiece:
        '魔王の気まぐれで野良上がりのガルガンに自分たちと建前上対等の『魔軍卿』の称号が与えられたこと。だが、それを認めないヴァルガスとゼノビアが裏で軍の権限を使い、ガルガン軍への武器・兵糧の配給を完全に止めて戦場で野垂れ死にさせるはずだったこと。',
      attitudeGuide:
        '・ヴァルガス：まだ余裕があり「まぐれだ、次の要塞門を守る名将ロシュに叩き潰される」と鼻で笑いつつも、野良犬が同じ魔軍卿を名乗ることに不快感を示す。\n' +
        '・ゼノビア：「配給を完全に止めているはずなのに、なぜ人間軍の物資を現地調達して重装兵を破れるのか」と計算違いに眉をひそめる。\n' +
        '・バルザック：腕を組んで静観し、「ほう、干殺しにされた野良犬がまだ生きて吠えてやがるか」と短く呟く程度（まだ正面戦線の話は出さない）。',
    };
  }

  // 1章②：要塞門（名将ロシュ）
  if (target.includes('要塞門') || target.includes('ロシュ')) {
    return {
      stageTitle: '第1章・大ボス突破（密輸古道の発覚）',
      lorePiece:
        'なぜ人間軍の分厚い正面防衛網を無視して要塞門が内側から落ちたのか。ガルガン一味の廃砦の奥に、人間軍の補給線（横っ腹）へ直接抜けられる秘密の獣道『密輸古道』が存在していた事実がここで明かされる。',
      attitudeGuide:
        '・ヴァルガス：要塞門を居抜きで奪われ、手にしたワイングラスを握り潰して「なぜ野良犬どもが勝手に城を持っているのだ！」と激昂する。\n' +
        '・ゼノビア：密輸古道からの奇襲ルートと、魔力ゼロのキメラ武器による物理突破の異常性に焦りを滲ませる。\n' +
        '・バルザック：初めて身を乗り出し、「裏の獣道から人間軍の喉元に直接食い込んだか。面白い牙を持ってやがる」と興味を示す。',
    };
  }

  // 2章①：魔導工房跡（毒ガス戦）
  if (target.includes('工房跡')) {
    return {
      stageTitle: '第2章・中ボス突破（『断崖の恥辱』のトラウマ）',
      lorePiece:
        'かつて密輸古道の発見功績を独り占めしようとガルガンの廃砦を単独強襲したゼノビア（エリート魔道軍）が、地形を活かした落とし穴・黒火薬・屑鉄武器の泥臭いゲリラ戦に足元をすくわれて大敗し、生き恥をさらして敗走した過去――『断崖の恥辱』の因縁が明かされる。',
      attitudeGuide:
        '・ゼノビア：濃緑の毒ガスすら力技で突破した報告に、『断崖の恥辱』で味わった悪夢が蘇り、普段の冷静さを失って唇を噛む。\n' +
        '・ヴァルガス：動揺するゼノビアを見て、「かつて貴様のエリート魔道軍が野良犬の罠に嵌まって敗走した『断崖の恥辱』……まだ克服できていないようだな」と嫌味たっぷりに皮肉る。\n' +
        '・バルザック：二人の醜い言い争いを鼻で笑い、ガルガン軍のしぶとさを評価する。',
    };
  }

  // 2章②：礼拝堂（対魔神聖巨像アークエンゼル）
  if (target.includes('礼拝堂') || target.includes('アークエンゼル')) {
    return {
      stageTitle: '第2章・チャレンジボス突破（倉庫焼き討ちの過去と魔導理論の崩壊）',
      lorePiece:
        '『断崖の恥辱』で敗走する際、ゼノビアが腹いせの魔導砲撃でガルガンの隠し倉庫と蓄えをすべて灰にした過去。それなのに、無一文から奪い集めた鉄屑と火薬の溶接武器だけで、教会が極秘建造した対魔神聖巨像までスクラップにした異常性。',
      attitudeGuide:
        '・ゼノビア：「あの時、奴らの倉庫も蓄えもすべて焼き払ったはずなのに……なぜ魔力反応ゼロの継ぎ接ぎの斧で神聖巨像の超重装甲が砕けるのですか！」と魔導理論が崩壊して青ざめる。\n' +
        '・ヴァルガス：教会の決戦兵器すら単独で破壊した暴力の前に言葉を失いかける。\n' +
        '・バルザック：「蓄えを焼かれた野良犬が、現地調達の牙だけで巨像を噛み砕いたか。ますます気に入ったぜ」と低く笑う。',
    };
  }

  // 2章③：ヴァルハイト城（天守閣制覇）
  if (target.includes('ヴァルハイト')) {
    return {
      stageTitle: '第2章・城郭制覇（闇市横流しの過去と略奪軍団への変貌）',
      lorePiece:
        'かつて人間界の酒や鋼をかすめ取って魔界の闇市に細々と横流ししていたコソ泥集団が、魔王に『魔軍卿』の名を与えられたことで、難攻不落のヴァルハイト城を天守閣まで丸裸にする最悪の略奪軍団へと変貌した皮肉。',
      attitudeGuide:
        '・ヴァルガス：城の莫大な軍需物資をすべてガルガン軍に独占され、「昔は闇市に酒を流すコソ泥だったくせに、我ら貴族の取り分まで根こそぎ奪う気か！」と浅ましく取り乱す。\n' +
        '・ゼノビア：城の防衛階層を休まずぶち抜いたキメラ武器の継戦能力に脅威を感じる。\n' +
        '・バルザック：自分の手で奪い取る実力主義を肯定し、貴族の焦りを嘲笑う。',
    };
  }

  // 2章④：教会領大聖堂（第2章大ボス）
  if (target.includes('大聖堂')) {
    return {
      stageTitle: '第2章・大ボス突破（正面戦線『選抜遠征騎士団』の動揺）',
      lorePiece:
        '人間軍の後方中枢である白亜の大聖堂まで陥落したことで、ついに正面戦線でバルザックの魔王軍正規軍と何ヶ月も睨み合っていた人間王国の最強部隊『選抜遠征騎士団』が、背後と補給を完全に断たれる恐怖で浮足立ち始めた全体戦況が明かされる。',
      attitudeGuide:
        '・バルザック：戦況水晶を見て豪快に笑い、「ガルガンの野良犬どもが後ろの大聖堂まで食い破ったおかげで、正面で俺たちと睨み合っていた『選抜遠征騎士団』の連中が浮足立ってやがる。城で吠えてる貴族より、よっぽど大局を動かしてやがるぜ」と公言する。\n' +
        '・ヴァルガス＆ゼノビア：使い捨ての捨て駒だったはずのガルガン軍が、戦争の主導権を握り始めた事実に戦慄する。',
    };
  }

  // 3章①：回廊関門（白獅子陣のアルバート）
  if (target.includes('回廊関門') || target.includes('アルバート')) {
    return {
      stageTitle: '第3章・中ボス突破（魔王の真意と獲物の奪い合い）',
      lorePiece:
        '正規軍の重装師団ですら抜けなかった『白獅子陣のアルバート』をガルガン軍が単独突破。魔王が野良犬に『魔軍卿』の座を与えた本当の狙いは、単なる先陣ではなく「腐りかけた他の魔軍卿どもの尻に火をつけ、獲物を競わせる噛みつき犬」として放つことだったと露わになる。',
      attitudeGuide:
        '・ヴァルガス＆ゼノビア：「このままではジークフリート元帥の首まであの野良犬に奪われ、我らの地位が根底から覆されるぞ！」と本気の恐怖に駆られる。\n' +
        '・バルザック：笑みを消し、歴戦の武人としての殺気を放ちながら「白獅子を抜いたか……だが総大将ジークフリートの首は俺の獲物だ。野良犬どもに横取りされてたまるか」とライバルとして牙を剥く。',
    };
  }

  // 3章②：遠征軍総本陣（ジークフリート元帥）およびその先
  return {
    stageTitle: '第3章・大ボス突破（終わりなき下剋上の螺旋）',
    lorePiece:
      '人間遠征軍の最高指導者ジークフリート元帥すらキメラの牙の前に沈んだ。だが、ガルガンは城の玉座など見向きもせず戦場に居座り続ける。人間王国本土からはさらなる報復の大軍が動き出し、4人の魔軍卿が互いの首と覇権を喰い合う「終わりのない魔界の生存競争」が幕を開ける。',
    attitudeGuide:
      '・ヴァルガス＆ゼノビア：もはや誰一人としてガルガン軍を「ドブネズミ」や「使い捨て」とは呼べず、油断すれば次は自分たちが引きずり下ろされるという畏怖に震える。\n' +
      '・バルザック：「ククッ、玉座なんざ興味ねえってツラだな。いいだろう、人間王国の増援も、てめえらの首も、戦場でまとめて決着をつけてやる」と、終わらない戦乱の始まりを告げる。',
  };
}

/**
 * 第2幕：ボス撃破時にボタンを押すと開く「魔王城・上層部3派閥の幕間劇」を生成する
 * （全8段階のマトリクスに基づき、裏設定と3人の態度が一切ダブらず段階的に変化する）
 */
export async function generateFactionReaction(locationName, battleData, player, enemy) {
  const weaponStyle = describeWeaponStyle(player);

  // システム数値（ターンやHP）をAIがそのまま口走らないよう、物語の戦況表現へ事前翻訳して渡す
  let paceDesc = '激しい攻防の末に敵の防衛網を突き崩した真っ向勝負';
  if (battleData.lastTurn <= 3) {
    paceDesc = '開戦からわずか数合の打ち合いで敵を粉砕した電撃的な瞬殺劇';
  } else if (battleData.lastTurn >= 7) {
    paceDesc = '泥沼の長期戦の末に執念で敵の息の根を止めた死闘';
  }

  const hpRatio = battleData.finalPlayerHp / (battleData.stats?.maxHp || 100);
  let damageDesc = '相応の手傷を負いながらも戦線を突破';
  if (hpRatio >= 0.8) {
    damageDesc = 'ほとんど損害を出さず無傷に近い余力を残しての完勝';
  } else if (hpRatio <= 0.3) {
    damageDesc = '部隊が壊滅寸前の血塗れになりながらも辛うじて掴み取った薄氷の勝利';
  }

  const stageConfig = getStageLoreConfig(locationName, enemy?.name || '');

  const prompt = `
あなたはダークファンタジー戦記『LINEde下剋上』のメインシナリオライターです。
魔王軍の最底辺部隊である「ガルガン軍・${player.name}（隊長：${player.leader}）」が、要衝【${locationName}】にて人間軍の守将『${enemy.name}』を撃破しました。

その戦報が魔王城の作戦会議室（魔導水晶の戦況盤）に届いた瞬間の、**上層部3派閥の魔軍卿たちの掛け合い（幕間劇）**を執筆してください。
※重要：説明口調のナレーションで設定を解説するのは厳禁。3人のセリフと態度の中から、今回の「裏設定のピース」が読者に自然と浮かび上がるように描くこと。

【今回の撃破データ】
・進行段階：${stageConfig.stageTitle}
・陥落した人間軍拠点：${locationName}（守将：${enemy.name}）
・使用された武装：${player.weapon}（特徴：${weaponStyle}）
・戦況の推移：${paceDesc}（${damageDesc}）

【登場する上層部3派閥の魔軍卿（建前上はガルガンと全員同じ序列の『魔軍卿』）】
1. 貴族魔族軍・魔軍卿 ヴァルガス（血統・体面主義の傲慢な貴族）
2. エリート魔道軍・魔軍卿 ゼノビア（技術・知性至上主義の冷徹な女傑）
3. 魔王軍正規軍・魔軍卿 バルザック（現場主義・百戦錬磨の古参猛将）

【今回初めて明かす裏設定のピース（必ず会話の中に織り込め）】
${stageConfig.lorePiece}

【今回の3人の態度・温度感の指針（ワンパターン化を防ぎ、この段階の空気感を厳守せよ）】
${stageConfig.attitudeGuide}

【絶対遵守の執筆ルール（違反厳禁）】
1. 文字数と構成：280〜360文字程度（3段落構成）。
2. 見出し：先頭に必ず「🍷【魔王城・作戦会議室：上層部の亀裂】」という見出しを付けること。
3. ゲーム用語（メタ発言）の完全禁止：「〇ターン」「HP」「ステータス」「スロット」「数値1」といったゲームのシステム用語をセリフや地の文に絶対に出すな。「わずか数合の打ち合いで」「無傷のまま」「異常な質量と爆圧で」など、すべてファンタジー戦記の言葉で語らせよ。
4. 呼称ルール：「第四軍」「四天王」「第一魔軍卿」といった数字や序列は絶対に出すな。全員が建前上は同じ『魔軍卿』である。
5. バルザックの口調統制：バルザックは正規軍を率いる歴戦の魔軍卿である。「ヒャハッ！」のようなチンピラじみた軽い笑い声は絶対に使わせるな。「ハッ」「ククッ」「フン」など、低く重みのある武人として描け。
6. 武器描写の正確性：今回の武器の特徴（${weaponStyle}）をゼノビアやヴァルガスのセリフの中に自然に織り込め（装着していない素材の能力は絶対に語るな）。
`;

  try {
    return await callGeminiWithFallback(prompt);
  } catch (err) {
    console.error('>>> 幕間劇AI生成エラー（定型文へフォールバック）:', err.message);
    return `🍷【魔王城・作戦会議室：上層部の亀裂】\n\n戦況盤の魔導水晶に【${locationName}・陥落】の紅い光が灯った瞬間、貴族魔族軍の魔軍卿ヴァルガスが卓を叩いて立ち上がった。\n「馬鹿な！『${enemy.name}』の陣が、あのガルガン軍の野良犬どもに抜かれただと！？ 武器も兵糧も配給を止めているはずの連中が、なぜこれほどの戦果を上げている！」\n\n隣で水晶の波形を解析していたエリート魔道軍の魔軍卿ゼノビアが、冷ややかな声で遮る。「奇妙ですね。魔力反応ゼロの『${player.weapon}（${weaponStyle}）』が、常識外の破壊力で人間軍の防備を粉砕しています。私の戦術予測ではあり得ない誤差です」\n\n腕を組んでいた魔王軍正規軍の魔軍卿バルザックが、低く鼻を鳴らして笑った。「ハッ、理屈などどうでもいい。泥水をすすって牙を研いだ野良犬が、人間軍の要衝を食い破ったのは事実だ。……面白い戦局になってきたじゃねえか」`;
  }
}