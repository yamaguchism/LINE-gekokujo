// ==========================================
// 作戦マップ・敵ステータス・ドロップ・接続ノード定義（第1章＆第2章 完全統合版）
// ==========================================

export const MAP_LOCATIONS = {
  // ==========================================
  // 【共通：アジトへの凱旋路（常設ファストトラベル）】
  // ==========================================
  '帰還': {
    chapter: 0,
    name: 'アジトへの凱旋路',
    desc: '退路を塞ぐ人間軍の哨戒兵を蹴散らして物資を奪い、本陣アジトへ帰還してHPを100%全快する。',
    enemies: [
      { name: '人間軍の追撃哨戒兵', hp: 50, atk: 19, def: 8, attackName: 'ショートスピア突撃' },
      { name: '国境警備の輜重兵', hp: 55, atk: 20, def: 9, attackName: 'メイス振り回し' },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
      { item: '黒火薬', count: 1 },
      { item: '兵糧', count: 2 },
    ],
    isBoss: false,
    isStopper: true,
    isReturn: true,
  },

  // ==========================================
  // 【第1章：国境要塞突破編】
  // ==========================================
  '渓谷': {
    chapter: 1,
    name: '黒鉄渓谷',
    shortLabel: '⛏️ 渓谷',
    desc: '鉱石と武具の略奪地。『⛏️王国鋼（攻撃）』と『🛡️装甲板（防御）』を強奪する。',
    connectedTo: ['街道', '検問所', '前哨砦', '要塞門'],
    enemies: [
      { name: '鉱山巡回兵', hp: 45, atk: 18, def: 8, attackName: '錆びたツルハシの一撃' },
      { name: '渓谷の軽装見張り番', hp: 55, atk: 20, def: 9, attackName: 'クロスボウ狙撃' },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },
  '街道': {
    chapter: 1,
    name: '補給街道',
    shortLabel: '🍞 街道',
    desc: '王国軍の兵站路。『🧨黒火薬（会心/回避）』または『🍞兵糧×2袋（HP全快用）』を積んだ荷車を襲う。',
    connectedTo: ['渓谷', '検問所', '前哨砦', '要塞門'],
    enemies: [
      { name: '輜重隊の護衛歩兵', hp: 55, atk: 20, def: 8, attackName: 'ハルバードの突進' },
      { name: '補給隊の守備兵長', hp: 65, atk: 22, def: 10, attackName: 'ブロードソード連撃' },
    ],
    possibleLoot: [
      { item: '黒火薬', count: 1 },
      { item: '兵糧', count: 2 },
    ],
    isBoss: false,
    isStopper: false,
  },

  // 第1章 3段階関門ボス
  '検問所': {
    chapter: 1,
    bossStep: 0,
    name: '国境検問所（小ボス）',
    shortLabel: '⚔️ 検問所',
    desc: '要塞門の第1関門。新兵ガルシアが守る前線拠点。',
    connectedTo: ['渓谷', '街道', '前哨砦'],
    enemies: [
      { name: '新兵ガルシア', hp: 60, atk: 19, def: 5, attackName: '新兵の必死な剣撃' },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
  },
  '前哨砦': {
    chapter: 1,
    bossStep: 1,
    name: '前哨砦（中ボス）',
    shortLabel: '🛡️ 前哨砦',
    desc: '要塞門の第2関門。分厚い甲冑を纏う魔導重装兵バルツ（防御18）が立ち塞がる。',
    connectedTo: ['渓谷', '街道', '要塞門'],
    enemies: [
      { name: '魔導重装兵バルツ', hp: 95, atk: 28, def: 18, attackName: 'ヘビーメイス粉砕打' },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '黒火薬', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
  },
  '要塞門': {
    chapter: 1,
    bossStep: 2,
    name: '人間軍の要塞門（第1章大ボス）',
    shortLabel: '🏰 要塞門',
    desc: '第1章の最終関門。3・6ターン目に必殺『断罪の剛剣（攻46）』を放つ守備隊長ロシュが鎮座する。',
    connectedTo: ['渓谷', '街道'],
    enemies: [
      { name: '守備隊長ロシュ', hp: 135, atk: 30, def: 15, specialAtk: 46, attackName: '断罪の剛剣' },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
      { item: '黒火薬', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
    isChapter1FinalBoss: true,
  },

  // ==========================================
  // 【第2章：王国穀倉・教会領侵入編（地続きノード構造）】
  // ==========================================
  // 通常略奪エリア
  '農村': {
    chapter: 2,
    name: '豊穣の農村',
    shortLabel: '🌾 農村',
    desc: '人間軍の穀倉地帯。『🍞兵糧×2袋』と、村の守備歩兵から『⛏️王国鋼』を強奪する。',
    connectedTo: ['礼拝堂', '兵站所'],
    enemies: [
      { name: '農村の徴募自警兵', hp: 60, atk: 22, def: 9, attackName: '鋭利なピッチフォーク' },
      { name: '穀倉守備の王国歩兵', hp: 70, atk: 24, def: 11, attackName: '軍用ブロードソード' },
    ],
    possibleLoot: [
      { item: '兵糧', count: 2 },
      { item: '王国鋼', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },
  '兵站所': {
    chapter: 2,
    name: '聖堂騎士団の兵站所',
    shortLabel: '⚒️ 兵站所',
    desc: '騎士団の武器補給工房。『🛡️装甲板』と『⛏️王国鋼』の備蓄を分捕る。奥にはヴァルハイト城の跳ね橋が見える。',
    connectedTo: ['農村', '跳ね橋'],
    enemies: [
      { name: '兵站工房の従卒', hp: 65, atk: 23, def: 12, attackName: '鍛造金槌の殴打' },
      { name: '補給警備の准騎士', hp: 75, atk: 25, def: 14, attackName: 'バスタードソード一閃' },
    ],
    possibleLoot: [
      { item: '装甲板', count: 1 },
      { item: '王国鋼', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },
  '礼拝堂': {
    chapter: 2,
    name: '異端の教会礼拝堂',
    shortLabel: '⛪ 礼拝堂',
    desc: '聖職者が魔力実験を行っていた隠れ寺院。『🔮魔導石（吸血）』と『🧨黒火薬』を強奪する。',
    connectedTo: ['農村', '工房跡', '大霊廟'],
    enemies: [
      { name: '異端の狂信修道士', hp: 60, atk: 24, def: 10, attackName: '異端審問の火炎術' },
      { name: '礼拝堂の護送司祭', hp: 70, atk: 25, def: 11, attackName: '光の戒律打' },
    ],
    possibleLoot: [
      { item: '魔導石', count: 1 },
      { item: '黒火薬', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },

  // ==========================================
  // 【第2章：ヴァルハイト跳ね橋（独立1マス・攻城前哨戦）】
  // ==========================================
  '跳ね橋': {
    chapter: 2,
    name: 'ヴァルハイト跳ね橋',
    shortLabel: '🌉 跳ね橋',
    desc: '【攻城前哨戦】ヴァルハイト城へ続く巨大な跳ね橋。橋梁警備隊を蹴散らして鉄鎖を断ち切り、城攻めの道を開く！',
    connectedTo: ['ヴァルハイト城', '兵站所'],
    enemies: [
      {
        name: 'ヴァルハイト跳ね橋警備隊＆弩弓兵',
        hp: 72,
        atk: 25,
        def: 12,
        attackName: '城壁クロスボウ斉射',
        quote: '「何だこの野良魔族どもは！？ 跳ね橋の鎖を絶対に死守しろ！」',
        defeatQuote: '「うわぁぁっ！ 鎖が切られたぞ、跳ね橋が落ちるぅぅ！！」',
      },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
    ],
    isBoss: false,
    isStopper: true, // 必ず足が止まり、鎖断ち演出が発生するストッパーノード
    isDrawbridge: true,
  },

  // ==========================================
  // 【第2章：ヴァルハイト城（3連撃チキンレースローグ）】
  // ==========================================
  'ヴァルハイト城': {
    chapter: 2,
    name: 'ヴァルハイト城（3連撃強襲）',
    shortLabel: '🏯 ヴァルハイト城',
    desc: '【3連撃チキンレース】「真実の城」を掲げる欺瞞の巨城！外郭・内城・天守閣でイカれた人間どもを蹴散らせ！負ければ城内戦利品は全没収！',
    connectedTo: ['跳ね橋'],
    // 階層別のランダム敵プール（狂気の人類カタログ）と戦利品
    castleFloors: {
      1: {
        floorName: '第1層：外郭・跳ね橋門',
        enemies: [
          {
            name: '教会認定・新米勇者レオン',
            hp: 68,
            atk: 24,
            def: 11,
            attackName: '聖剣の見様見真似スラッシュ',
            quote: '「僕がこの聖なる光で、野蛮な魔族どもを成敗して英雄になるんだ！」',
            defeatQuote: '「うわぁぁん！ せっかく教会に買ってもらったピカピカの白銀鎧がぁぁ！」',
          },
          {
            name: '城郭警備の老練兵マクシミリアン',
            hp: 75,
            atk: 22,
            def: 15,
            attackName: '歴戦の死角突き',
            quote: '「へっ、お貴族様の近衛騎士なんざ寝てやがる。城の守りは俺のような老いぼれの仕事よ」',
            defeatQuote: '「……ケッ、小汚ねえキメラ斧だが、いい腕してやがるぜクソ魔族め……」',
          },
          {
            name: '外郭巡回の軍用猟犬群',
            hp: 62,
            atk: 27,
            def: 8,
            attackName: '飢えた牙の群がり噛みつき',
            quote: '「グルルルッ！！（血の匂いに狂った軍用犬の群れが鎖を引きちぎって襲いかかる！）」',
            defeatQuote: '「キャンキャンッ！！（猟犬どもは尻尾を巻いて城内へと逃げ散った！）」',
          },
        ],
        loot: [{ item: '王国鋼', count: 1 }],
      },
      2: {
        floorName: '第2層：内城・近衛詰め所',
        enemies: [
          {
            name: '禁忌の鬼才魔導士ベルンハルト',
            hp: 82,
            atk: 31,
            def: 8,
            attackName: '禁忌術式・灰燼魔導砲',
            quote: '「フハハハ！ 素晴らしい！ 野良魔族の筋繊維とキメラ骨格、我が実験台に誂え向きではないか！」',
            defeatQuote: '「馬鹿な……我が至高の魔導理論が、ただの鉄塊の物理暴力ごときに砕かれるだと……！？」',
            bonusLoot: [{ item: '魔導石', count: 1 }],
          },
          {
            name: '断罪の異端審問官エリザベート',
            hp: 90,
            atk: 24,
            def: 12,
            attackName: '聖別された拷問鉄串',
            gimmick: 'POISON_GAS',
            poisonDamage: 8,
            quote: '「主の慈悲です。あなた方の汚らわしい魂を、この焼けた鉄串で清めてあげましょう」',
            defeatQuote: '「ひぃっ……！ お、おやめなさい！ 私の純白の法衣に血と泥をつけないでぇぇ！」',
          },
          {
            name: '強欲の傭兵隊長グスタフ',
            hp: 100,
            atk: 25,
            def: 18,
            attackName: '金塗れのヘビーハルバード',
            quote: '「教会の旦那方がいくら払うと思ってやがる？ てめえらの首は俺の別荘と上等なワインに化けるんだよ！」',
            defeatQuote: '「おい待て！ 金ならやる！ 溜め込んだ兵糧も全部やるから命だけは助けてくれぇぇ！」',
            bonusLoot: [{ item: '兵糧', count: 2 }],
          },
        ],
        loot: [
          { item: '装甲板', count: 1 },
          { item: '黒火薬', count: 1 },
        ],
      },
      3: {
        floorName: '最深部：天守閣・玉座の間',
        enemies: [
          {
            name: 'ヴァルハイト城主・聖騎士長ヴァイス',
            hp: 140,
            atk: 32,
            def: 18,
            attackName: '虚飾の白銀断罪剣',
            quote: '「下賤な魔族どもめ！『真実の城』の威光にひれ伏し、我が栄達の礎となれ！」',
            defeatQuote: '「ぐあああっ！！ わ、私が築き上げた地位と財宝が……野良魔族ごときに全部奪われるなどぉぉ！」',
          },
          {
            name: '鉄拳の破戒僧ボルドー',
            hp: 132,
            atk: 36,
            def: 13,
            attackName: '福音・頭蓋砕きの剛鉄拳',
            quote: '「祈りでは魔族は浄化できん！ 神が下されたこの剛腕と鉄拳こそが唯一の福音よッ！！」',
            defeatQuote: '「ガハッ……！ 見事な剛力……神よ、我が鉄拳はついに届きませんでしたか……！」',
          },
          {
            name: '城内秘蔵・神聖守護ゴーレム',
            hp: 145,
            atk: 28,
            def: 21,
            attackName: '白銀巨腕のなぎ払い',
            gimmick: 'REFLECT_SHIELD',
            reflectRate: 0.20,
            quote: '「【神聖防衛機構・起動】侵入セシ魔族ヲ、物理反射障壁ニテ完全排除セヨ――」',
            defeatQuote: '「ピガガガ……動力炉、魔導石コア崩壊……機能完全停止シマス……」',
          },
        ],
        loot: [
          { item: '魔導石', count: 1 },
          { item: '王国鋼', count: 1 },
          { item: '装甲板', count: 1 },
          { item: '兵糧', count: 2 },
        ],
      },
    },
    enemies: [
      { name: '教会認定・新米勇者レオン', hp: 68, atk: 24, def: 11, attackName: '聖剣の見様見真似スラッシュ' },
    ],
    isBoss: false,
    isStopper: true,
    isCastleRogue: true,
  },

  // ==========================================
  // 【第2章：本編ボス連戦】
  // ==========================================
  '工房跡': {
    chapter: 2,
    bossStep: 0,
    name: '錬金術師の工房跡（中ボス）',
    shortLabel: '🧪 工房跡',
    desc: '第2章第1関門。毎ターン防御無視の毒ガス（12ダメージ）を放つ従軍錬金術師が待ち構える。',
    connectedTo: ['礼拝堂', '大聖堂'],
    enemies: [
      {
        name: '従軍錬金術師',
        hp: 145,
        atk: 24,
        def: 14,
        attackName: '劇薬フラスコ投擲',
        gimmick: 'POISON_GAS',
        poisonDamage: 12,
      },
    ],
    possibleLoot: [
      { item: '魔導石', count: 1 },
      { item: '黒火薬', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
  },
  '大聖堂': {
    chapter: 2,
    bossStep: 1,
    name: '教会領大聖堂（第2章大ボス）',
    shortLabel: '🏰 大聖堂',
    desc: '第2章最終関門。受けたダメージの30%を跳ね返す【荊の反射盾】を持つ聖堂重騎士が鎮座する。',
    connectedTo: ['工房跡'],
    enemies: [
      {
        name: '聖堂重騎士',
        hp: 125,
        atk: 30,
        def: 20,
        attackName: '聖別の大槌',
        gimmick: 'REFLECT_SHIELD',
        reflectRate: 0.30,
      },
    ],
    possibleLoot: [
      { item: '魔導石', count: 1 },
      { item: '装甲板', count: 1 },
      { item: '王国鋼', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
    isChapter2FinalBoss: true,
  },

  // ==========================================
  // 【第2章：聖堂地下の禁忌大霊廟（単発超難度チャレンジ）】
  // ==========================================
  '大霊廟': {
    chapter: 2,
    name: '聖堂地下の禁忌大霊廟（チャレンジ）',
    shortLabel: '💀 大霊廟',
    desc: '【高難度・腕試しの聖地】礼拝堂の地下最深部。教会が魔族殲滅のために封印していた対魔神聖兵器を解体すれば全素材を一括強奪！',
    connectedTo: ['礼拝堂'],
    enemies: [
      {
        name: '教会秘匿・対魔神聖巨像アークエンゼル',
        hp: 180,
        atk: 36,
        def: 25,
        attackName: '断罪の神聖波動破',
        gimmick: 'SUPER_ARMOR',
      },
    ],
    isChallenge: true,
    isBoss: true,
    isStopper: true,
  },

  // ==========================================
  // 【第3章：英傑拮抗戦線（中央回廊・人間遠征軍総本陣）】
  // ==========================================
  '中立交易区': {
    chapter: 3,
    name: '王都外郭・中立交易区',
    shortLabel: '🍷 交易区',
    desc: '両軍の緩衝地帯となっている闇市場と歓楽街。高級な保存食（🍞兵糧×2）や秘蔵の『🔮魔導石』を力尽くで徴発する。',
    connectedTo: ['補給工廠', '前線宿営地'],
    enemies: [
      { name: '中立地帯の強欲な密売人', hp: 75, atk: 26, def: 12, attackName: '仕込み隠し銃' },
      { name: '貴族魔族派の私設用心棒', hp: 80, atk: 27, def: 13, attackName: '装飾大剣の斬撃' },
    ],
    possibleLoot: [
      { item: '兵糧', count: 2 },
      { item: '魔導石', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },
  '補給工廠': {
    chapter: 3,
    name: '魔王正規軍・補給工廠',
    shortLabel: '⚒️ 補給工廠',
    desc: '前線で人間軍と睨み合う正規軍の武具集積所。魔王の認可状を突きつけ、最高峰の『🛡️装甲板』と『⛏️王国鋼』を強引に受領する。',
    connectedTo: ['中立交易区', '前線宿営地'],
    enemies: [
      { name: '正規軍の傲慢な兵站将校', hp: 82, atk: 26, def: 15, attackName: '軍制ハルバード突撃' },
      { name: '人間軍の補給線破壊工作兵', hp: 75, atk: 28, def: 12, attackName: '双剣の急襲' },
    ],
    possibleLoot: [
      { item: '装甲板', count: 1 },
      { item: '王国鋼', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },
  '前線宿営地': {
    chapter: 3,
    name: '人間遠征軍・前線宿営地',
    shortLabel: '💣 前線宿営地',
    desc: '回廊関門の手前に築かれた人間遠征軍の野営陣地。王立工廠特製の『🧨黒火薬』と鍛え抜かれた『⛏️王国鋼』を強奪する。',
    connectedTo: ['中立交易区', '補給工廠', '回廊関門'],
    enemies: [
      { name: '遠征軍の精鋭銃槍兵', hp: 80, atk: 29, def: 13, attackName: '王立銃剣の斉射突き' },
      { name: '王国選抜の先遣騎士', hp: 85, atk: 27, def: 15, attackName: 'ランスチャージ' },
    ],
    possibleLoot: [
      { item: '黒火薬', count: 1 },
      { item: '王国鋼', count: 1 },
    ],
    isBoss: false,
    isStopper: false,
  },
  '回廊関門': {
    chapter: 3,
    bossStep: 0,
    name: '激突の回廊関門（第3章中ボス）',
    shortLabel: '⚔️ 回廊関門',
    desc: '第3章第1関門。残りHP50%以下で猛将の覚悟により攻撃力が2倍（56）に跳ね上がる近衛重装騎士長アルバートが塞ぐ。',
    connectedTo: ['前線宿営地', '遠征軍総本陣'],
    enemies: [
      {
        name: '近衛重装騎士長アルバート',
        hp: 170,
        atk: 28,
        def: 16,
        attackName: '白獅子の重戦斧連撃',
        gimmick: 'BERSERK',
        quote: '「魔王軍の雑兵風情が、我が陣を抜けると思うな！ ここより先は一歩たりとも通さんッ！！」',
        defeatQuote: '「ぐあああっ……！ バカな、正規軍すら退けた我が白獅子陣が、こんな野良小隊の蛮勇に砕かれるとは……！」',
      },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
  },
  '遠征軍総本陣': {
    chapter: 3,
    bossStep: 1,
    name: '人間王国・遠征軍総本陣（第3章大ボス）',
    shortLabel: '🏰 遠征軍総本陣',
    desc: '第3章最終関門。6ターン目終了時に全魔力を解放した即死光波（999ダメ）を放つ聖騎士元帥ジークフリートが鎮座する。',
    connectedTo: ['回廊関門'],
    enemies: [
      {
        name: '聖騎士元帥ジークフリート',
        hp: 180,
        atk: 32,
        def: 18,
        attackName: '王家の聖剣閃',
        gimmick: 'EXECUTE_6T',
        quote: '「我が名はジークフリート。王国の正義と光の剣にかけて貴公らの野望を断つ。……6ターンだ。我が聖剣が光に満ちる刻、貴公らの命運は尽きる」',
        defeatQuote: '「なんという凄まじい猛攻だ……！ 我が聖剣が光を放つ前に、力尽くで装甲ごとねじ伏せるとは……見事だ、魔族の戦士よ……」',
      },
    ],
    possibleLoot: [
      { item: '王国鋼', count: 1 },
      { item: '装甲板', count: 1 },
      { item: '黒火薬', count: 1 },
      { item: '魔導石', count: 1 },
    ],
    isBoss: true,
    isStopper: true,
    isChapter3FinalBoss: true,
  },
};

// ==========================================
// アジト防衛戦 襲撃敵データ（魔軍卿の世界観準拠）
// ==========================================
export const DEFENSE_ENEMIES = [
  {
    name: '人間軍の奪還急襲隊',
    hp: 65,
    atk: 21,
    def: 9,
    attackName: 'クロスボウ斉射',
    tauntLog: '📡【通信傍受】人間軍司令部：『ば、馬鹿な！奪われた拠点を急襲した精鋭隊が全滅し、物資まで根こそぎ奪い取られただと…！？』',
  },
  {
    name: '正規軍閥派の刺客・黒鉄重装兵',
    hp: 72,
    atk: 23,
    def: 11,
    attackName: '軍用ハルバードの一閃',
    tauntLog: '📡【魔王城・通信傍受】正規軍閥派の魔軍卿：『ええい、軍規も知らぬガルガンのチンピラどもめ！密かに差し向けた我が兵を返り討ちにして武具まで剥ぐとは…軍の風紀が乱れるわ！！』',
  },
  {
    name: '貴族魔族派の密使・白銀の暗殺爪',
    hp: 68,
    atk: 25,
    def: 9,
    attackName: '暗殺連撃',
    tauntLog: '📡【魔王城・通信傍受】貴族魔族派の魔軍卿：『下等な野良犬風情が、我が息のかかった刺客を屠るなど…！血統なき者どもが調子に乗るでない…！』',
  },
];