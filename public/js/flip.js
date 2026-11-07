const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
  if (tg.MainButton) tg.MainButton.hide();
}

const initData = tg ? tg.initData : '';
const cards = Array.from(document.querySelectorAll('.card'));
let flipping = false;
let usedCards = new Set();
let revealBoard = null;

function $(id) { return document.getElementById(id); }

function setStatusText(remainingGB, playsLeft, netGb) {
  const remainingText = remainingGB === -1 ? '∞' : String(remainingGB);
  $('status-text').textContent = `剩余流量 ${remainingText} GB · 今日还可翻 ${Math.max(0, Number(playsLeft) || 0)} 次 · 今日净收益 ${netGb > 0 ? '+' : ''}${netGb || 0} GB`;
}

function setResult(title, sub, color) {
  $('result-title').textContent = title;
  $('result-sub').textContent = sub;
  $('result-sub').style.color = color || '#9eb1c7';
}

function iconForPrize(gb) {
  if (gb > 0) return '+';
  if (gb < 0) return '−';
  return '○';
}

function revealCard(card, prize, actual = false) {
  const back = card.querySelector('.card-back');
  const face = card.querySelector('.card-face');
  const prizeText = card.querySelector('.card-prize');

  if (back) back.style.opacity = '0';
  card.classList.add('revealed', 'disabled');
  card.classList.remove('flash-win', 'flash-lose', 'ghost-reveal');

  if (!actual) {
    card.classList.add('ghost-reveal');
  } else if ((prize.gb || 0) >= 0) {
    card.classList.add('flash-win');
  } else {
    card.classList.add('flash-lose');
  }

  face.textContent = iconForPrize(prize.gb || 0);
  prizeText.textContent = prize.label || '谢谢参与';
}

function revealAll(board) {
  if (!Array.isArray(board) || board.length !== cards.length) return;
  revealBoard = board;
  board.forEach((prize, index) => {
    if (!prize) return;
    revealCard(cards[index], prize, Boolean(prize.actual));
  });
}

function paintUsedCards() {
  cards.forEach((card) => {
    const index = Number(card.dataset.index);
    if (usedCards.has(index)) {
      if (revealBoard && revealBoard[index]) {
        revealCard(card, revealBoard[index], true);
        return;
      }
      card.classList.add('disabled', 'revealed');
      const back = card.querySelector('.card-back');
      if (back) back.style.opacity = '0';
      card.querySelector('.card-face').textContent = '●';
      card.querySelector('.card-prize').textContent = '已翻开';
    }
  });
}

async function loadProfile() {
  try {
    const response = await fetch('/api/flip-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    const data = await response.json();
    if (!data.ok) {
      $('status-text').textContent = data.error || '暂时无法读取翻卡状态';
      return;
    }
    usedCards = new Set(data.usedCards || []);
    revealBoard = Array.isArray(data.revealBoard) ? data.revealBoard : null;
    setStatusText(data.remainingGB, data.playsLeft, data.netGb || 0);
    if (revealBoard) {
      revealAll(revealBoard);
      setResult('今日牌池已揭晓', '你已经翻完 3 张，剩下的牌面也全部打开了。', '#f8e6b6');
    } else {
      paintUsedCards();
    }
  } catch (_err) {
    $('status-text').textContent = '翻卡状态读取失败，请稍后重试';
  }
}

cards.forEach((card) => {
  card.addEventListener('click', async () => {
    if (flipping) return;
    const index = Number(card.dataset.index);
    if (usedCards.has(index)) return;

    flipping = true;
    card.classList.add('disabled');
    setResult('正在翻卡...', '看看这张卡里藏着什么。', '#9eb1c7');

    try {
      const response = await fetch('/api/flip-draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, cardIndex: index }),
      });
      const data = await response.json();

      if (!data.ok) {
        setResult(data.error || '翻卡失败', '今天的翻卡机会可能已经用完了。', '#fbbf24');
        if (Object.prototype.hasOwnProperty.call(data, 'remainingGB')) {
          revealBoard = Array.isArray(data.revealBoard) ? data.revealBoard : revealBoard;
          if (revealBoard) {
            revealAll(revealBoard);
          }
          setStatusText(data.remainingGB, data.playsLeft, data.netGb || 0);
        } else {
          await loadProfile();
        }
        flipping = false;
        return;
      }

      usedCards.add(index);
      revealCard(card, { label: data.prizeLabel, gb: data.prizeGb }, true);

      setResult(data.prizeLabel, data.prizeGb > 0 ? `流量已到账，直接 +${data.prizeGb} GB` : data.prizeGb < 0 ? `这次手气一般，扣掉 ${Math.abs(data.prizeGb)} GB` : '这张卡没有流量奖励，但今天还有机会。', data.prizeGb > 0 ? '#34d399' : data.prizeGb < 0 ? '#fb7185' : '#fbbf24');
      setStatusText(data.remainingGB, data.playsLeft, data.netGb || 0);
      revealBoard = Array.isArray(data.revealBoard) ? data.revealBoard : null;
      if (revealBoard) {
        window.setTimeout(() => {
          revealAll(revealBoard);
          setResult('今日牌池已揭晓', '你翻完 3 张后，剩下的牌也全部打开了。', '#f8e6b6');
        }, 500);
      }
    } catch (_err) {
      setResult('网络错误', '请求没有成功发到服务器，请稍后再试。', '#fb7185');
      card.classList.remove('disabled');
    } finally {
      flipping = false;
    }
  });
});

loadProfile();
