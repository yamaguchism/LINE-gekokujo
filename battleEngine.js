// ==========================================
// 戦闘数理・5枠パズル計算＆敗因分析エンジン (battleEngine.js)
// ==========================================

/**
 * 武器スロットの合計装着数を返す（基本5枠）
 */
export function getTotalSlots(slots) {
    return (slots.steel || 0) + (slots.plate || 0) + (slots.powder || 0) + (slots.stone || 0);
  }
  
  /**
   * 居抜き乗っ取りに対応した現在の本陣アジト名を返す（地勢型呼称パッケージC対応）
   */
  export function getBaseName(player) {
    if (player.ch3Step >= 2) return '占領した遠征軍総本陣（中央回廊・新本陣）';
    if (player.ch2Step >= 2 || player.chapter >= 3) return '占領した教会領大聖堂（教会平原・本陣）';
    if (player.ch1Step >= 3 || player.chapter >= 2) return '強奪した要塞門（峡谷地帯・本陣）';
    return '荒れ野の廃砦（初期アジト）';
  }
  
  /**
   * 防壁レベルに応じたボス敗走時のスロット破損率を返す
   */
  export function getBossBreakRate(player) {
    const lv = player.baseWallLevel || 1;
    if (lv >= 3) return 0.10;
    if (lv === 2) return 0.20;
    return 0.30;
  }
  
  /**
   * 過負荷炉レベルに応じたボス敗北時の「第6スロット覚醒確率」を返す
   * Lv0(未建造): 15%, Lv1: 25%, Lv2: 35%
   */
  export function getOverloadAwakenRate(player) {
    const lv = player.baseFurnaceLevel || 0;
    if (lv >= 2) return 0.35;
    if (lv === 1) return 0.25;
    return 0.15;
  }
  
  /**
   * ボス敗走時のスロット素材破損判定（基本5枠のみ対象）
   */
  export function tryBreakSlotMaterial(player) {
    const breakRate = getBossBreakRate(player);
    if (Math.random() >= breakRate) return null;
  
    const s = player.slots;
    const pool = [];
    for (let i = 0; i < (s.steel || 0); i++) pool.push({ key: 'steel', name: '⛏️王国鋼' });
    for (let i = 0; i < (s.plate || 0); i++) pool.push({ key: 'plate', name: '🛡️装甲板' });
    for (let i = 0; i < (s.powder || 0); i++) pool.push({ key: 'powder', name: '🧨黒火薬' });
    for (let i = 0; i < (s.stone || 0); i++) pool.push({ key: 'stone', name: '🔮魔導石' });
  
    if (pool.length === 0) return null;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    player.slots[chosen.key] = Math.max(0, player.slots[chosen.key] - 1);
    return chosen.name;
  }
  
  /**
   * 武器5枠強化パズル計算エンジン（黄金比完全準拠 ＋ 独立第6スロット加算対応）
   */
  export function calculateEffectiveStats(player) {
    const s = player.slots;
    const sixth = player.sixthSlot; // 'steel' | 'plate' | 'powder' | 'stone' | null
  
    const steelCount = (s.steel || 0) + (sixth === 'steel' ? 1 : 0);
    const plateCount = (s.plate || 0) + (sixth === 'plate' ? 1 : 0);
    const powderCount = (s.powder || 0) + (sixth === 'powder' ? 1 : 0);
    const stoneCount = (s.stone || 0) + (sixth === 'stone' ? 1 : 0);
  
    const maxHp = Math.max(20, Math.floor(player.baseHp * (1 - stoneCount * 0.06)));
    const atk = Math.max(5, player.baseAtk + (steelCount * 7) - (plateCount * 2) - (powderCount * 2) + (stoneCount * 3));
    const def = Math.max(0, player.baseDef + (plateCount * 6) - (steelCount * 2) - (powderCount * 1) - (stoneCount * 1));
    const critRate = Math.min(0.95, 0.10 + (powderCount * 0.13));
    const dodgeRate = Math.min(0.40, 0.05 + (powderCount * 0.07));
    const drainRate = Math.min(0.80, stoneCount * 0.20);
  
    return { maxHp, atk, def, critRate, dodgeRate, drainRate };
  }
  
  /**
   * 8ターン戦闘シミュレーター＆敗因アナライザー
   */
  export function simulateBattle(player, enemy, locKey, options = {}) {
    const stats = calculateEffectiveStats(player);
    const logs = [];
    let pHP = Math.min(player.hp || stats.maxHp, stats.maxHp);
    let eHP = enemy.hp;
    let turn = 1;
    let totalDamageDealt = 0;
    let playerTurnCount = 0;
    let tookRigidSword = false;
    let tookBerserkHit = false;
    let tookExecute = false;
    let hadMiracleDodge = false;
    let hadClutchCrit = false;
  
    if (options.isDefenseBattle && (player.baseWallLevel || 1) >= 1) {
      const wallDmg = (player.baseWallLevel || 1) * 10;
      eHP = Math.max(1, eHP - wallDmg);
      logs.push({
        turn: 0,
        actor: `${getBaseName(player)}の防衛機構`,
        action: `🛡️【廃鉄防壁Lv${player.baseWallLevel}の迎撃鉄杭】押し寄せる敵部隊を鉄杭で迎撃！`,
        damage: wallDmg,
        targetRemainHp: eHP,
      });
    }
  
    while (pHP > 0 && eHP > 0 && turn <= 8) {
      if (enemy.gimmick === 'POISON_GAS' && enemy.poisonDamage) {
        const pDmgFixed = enemy.poisonDamage;
        pHP -= pDmgFixed;
        logs.push({
          turn,
          actor: enemy.name,
          action: `🧪【猛毒ガス噴射】濃緑の劇薬ガスが装甲の隙間から肺を侵食！（防御無視 ${pDmgFixed} ダメージ）`,
          damage: pDmgFixed,
          targetRemainHp: Math.max(0, pHP),
        });
        if (pHP <= 0) break;
      }
  
      const isPinch = (pHP / stats.maxHp) <= 0.30;
      const currentCritRate = Math.min(1.0, stats.critRate + (isPinch ? 0.15 : 0.0));
      const isCritical = Math.random() < currentCritRate;
      let pDmg = 0;
  
      if (isCritical) {
        if (isPinch) hadClutchCrit = true;
        const effectiveDef = enemy.def * 0.5;
        pDmg = Math.max(2, Math.floor((stats.atk - effectiveDef) * 1.5));
        logs.push({
          turn,
          actor: `${player.leader}（シンジ班）`,
          action: isPinch
            ? `🔥【背水の陣・黒火薬一斉誘爆！】絶体絶命の危機から敵の装甲を粉砕する逆転会心撃！`
            : `💥【黒火薬炸裂・装甲半減貫通】敵の装甲を吹き飛ばす会心の一撃！`,
          damage: pDmg,
          targetRemainHp: Math.max(0, eHP - pDmg),
        });
      } else {
        pDmg = Math.max(1, stats.atk - enemy.def);
        logs.push({
          turn,
          actor: `${player.leader}（シンジ班）`,
          action: `🗡️ ${player.weapon}による斬撃`,
          damage: pDmg,
          targetRemainHp: Math.max(0, eHP - pDmg),
        });
      }
  
      totalDamageDealt += pDmg;
      playerTurnCount++;
      eHP -= pDmg;
  
      if (stats.drainRate > 0 && pHP > 0) {
        const stoneCount = (player.slots.stone || 0) + (player.sixthSlot === 'stone' ? 1 : 0);
        const drainHeal = Math.max(4 * stoneCount, Math.floor(pDmg * stats.drainRate));
        pHP = Math.min(stats.maxHp, pHP + drainHeal);
        logs.push({
          turn,
          actor: `${player.leader}（シンジ班）`,
          action: `🩸【魔導石の吸血脈動】敵の生命力を吸い取り HPが ${drainHeal} 回復！`,
          damage: 0,
          targetRemainHp: pHP,
        });
      }
  
      if (enemy.gimmick === 'REFLECT_SHIELD' && enemy.reflectRate && eHP > 0) {
        const rDmg = Math.max(1, Math.floor(pDmg * enemy.reflectRate));
        pHP -= rDmg;
        logs.push({
          turn,
          actor: enemy.name,
          action: `🛡️【神聖反射の荊】神聖盾が打撃の衝撃を跳ね返した！（反射 ${rDmg} ダメージ）`,
          damage: rDmg,
          targetRemainHp: Math.max(0, pHP),
        });
        if (pHP <= 0) break;
      }
  
      if (eHP <= 0) break;
  
      // 第3章大ボス：6ターン目終了時の防御・回避不能即死ギミック (EXECUTE_6T)
      if (enemy.gimmick === 'EXECUTE_6T' && turn >= 6) {
        const execDmg = 999;
        pHP = 0;
        tookExecute = true;
        logs.push({
          turn,
          actor: enemy.name,
          action: `⚖️【必殺：聖剣・最終断罪宣告】6ターン経過！光に満ちた聖剣から防御・回避不能の極大光波が放たれた！（強制即死 ${execDmg} ダメージ）`,
          damage: execDmg,
          targetRemainHp: 0,
        });
        break;
      }
  
      const isPlayerDodged = Math.random() < stats.dodgeRate;
      if (isPlayerDodged) {
        hadMiracleDodge = true;
        logs.push({
          turn,
          actor: enemy.name,
          action: `💨【黒煙の奇跡回避】火薬の黒煙が敵の目を眩ませ、致命打を完全に躱した！`,
          damage: 0,
          targetRemainHp: pHP,
        });
      } else {
        let enemyAtk = enemy.atk;
        let actionDesc = enemy.attackName || '通常攻撃';
  
        if (locKey === '要塞門' && (turn === 3 || turn === 6)) {
          enemyAtk = enemy.specialAtk || 46;
          actionDesc = `⚠️【必殺：断罪の剛剣】身の丈を超える大剣が唸りを上げて振り下ろされる！`;
          tookRigidSword = true;
        } else if (enemy.gimmick === 'BERSERK' && eHP <= Math.floor(enemy.hp * 0.5)) {
          enemyAtk = enemy.atk * 2;
          actionDesc = `🩸【猛将の覚悟・狂乱覚醒！】残りHP半減により鬼神の如く覚醒！攻撃力が2倍（${enemyAtk}）に跳ね上がった渾身の重戦斧！`;
          tookBerserkHit = true;
        }
  
        const eDmg = Math.max(1, enemyAtk - stats.def);
        pHP -= eDmg;
  
        logs.push({
          turn,
          actor: enemy.name,
          action: actionDesc,
          damage: eDmg,
          targetRemainHp: Math.max(0, pHP),
        });
      }
  
      turn++;
    }
  
    const isWin = pHP > 0 && eHP <= 0;
    const lastTurn = turn > 8 ? 8 : turn;
  
    let hint = '';
    if (!isWin) {
      const avgDamage = totalDamageDealt / (playerTurnCount || 1);
      const totalEquipped = getTotalSlots(player.slots);
      const totalPowder = (player.slots.powder || 0) + (player.sixthSlot === 'powder' ? 1 : 0);
  
      if (totalEquipped < 5) {
        hint = `💡【敗因分析】武器のスロットが [${totalEquipped}/5枠] しか埋まっていない！「鍛造」で5枠すべて埋めろ！`;
      } else if (tookExecute && pHP <= 0) {
        hint = `💡【敗因分析】6ターン目の即死技『最終断罪宣告（999ダメ）』が発動してしまった！この相手に持久戦は通用しない！『⛏️王国鋼』と『🧨黒火薬』を集中して積み、6ターン以内にHP180を削り切る超火力構成で挑め！`;
      } else if (enemy.gimmick === 'BERSERK' && tookBerserkHit && pHP <= 0) {
        hint = `💡【敗因分析】敵のHPが半分を切り『猛将の覚悟（攻撃力2倍：56）』の猛撃で粉砕された！『🛡️装甲板』と『🔮魔導石』で耐久・吸血を固めるか、『🧨黒火薬』の黒煙回避と背水会心で一気に押し切れ！`;
      } else if (enemy.gimmick === 'POISON_GAS' && pHP <= 0) {
        hint = `💡【敗因分析】猛毒ガス（毎T12固定ダメ）に削り殺された！『🔮魔導石』の吸血で毒を相殺するか、『🧨黒火薬』で毒殺される前に速攻で焼き切れ！`;
      } else if (enemy.gimmick === 'REFLECT_SHIELD' && pHP <= 0) {
        hint = `💡【敗因分析】神聖盾の反射ダメージ（30%）と重装甲（防20）に阻まれた！『🔮魔導石』を2〜3個積んで反射を上回る吸血（40%〜60%）を確保し、残りを『⛏️鋼』で固めて削り勝て！`;
      } else if (enemy.gimmick === 'SUPER_ARMOR' && avgDamage <= 4) {
        hint = `💡【敗因分析】対魔神聖巨像アークエンゼルの装甲（防御25）が分厚すぎる！『🧨黒火薬』の装甲半減貫通会心を叩き込むか、『⛏️鋼』を限界まで積め！`;
      } else if (totalPowder >= 4) {
        hint = `💡【敗因分析】『🧨黒火薬』を詰め込みすぎて基礎打点と装甲が脆い！芯となる『⛏️王国鋼』や『🛡️装甲板』を混ぜろ！`;
      } else if (avgDamage <= 3) {
        hint = `💡【敗因分析】敵の装甲（防御${enemy.def}）が厚くて刃が通っていない！『⛏️王国鋼』を増やして基礎攻撃力を引き上げろ！`;
      } else if (locKey === '要塞門' && tookRigidSword && pHP <= 0) {
        hint = `💡【敗因分析】ロシュの必殺『断罪の剛剣（攻46）』で粉砕された！『🛡️装甲板』を混ぜて防御を固めろ！`;
      } else if (lastTurn <= 4 && pHP <= 0) {
        hint = `💡【敗因分析】被ダメージが重すぎて早期壊滅した！出撃前に「回復」でHPを満タンにし、『🛡️装甲板』で防御を固めろ！`;
      } else if (lastTurn >= 8 && eHP > 0 && pHP > 0) {
        hint = `💡【敗因分析】8ターン時間切れだ！守りを固めすぎて火力が足りない！『🛡️装甲板』を削って『⛏️王国鋼』や『🧨黒火薬』に枠を回せ！`;
      } else if (eHP <= 25) {
        hint = `💡【敗因分析】惜しい！敵（${enemy.name}）の残りHPはあと【${Math.max(0, eHP)}】だった！あと1枠の微調整か会心が出れば突破できるぞ！`;
      } else {
        hint = `💡【敗因分析】敵の特性に合わせて「鍛造」で5枠の配合を組み直して再挑戦しろ！`;
      }
    }
  
    return {
      result: isWin ? 'WIN' : 'LOSE',
      finalPlayerHp: Math.max(0, pHP),
      events: logs,
      stats,
      hint,
      lastTurn,
      remainEnemyHp: Math.max(0, eHP),
      hadMiracleDodge,
      hadClutchCrit,
    };
  }