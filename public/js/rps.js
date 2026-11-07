const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.expand();
  tg.ready();
  if (tg.MainButton) tg.MainButton.hide();
}

const initData = tg ? tg.initData : '';
const CHOICE_TEXT = ['石头', '剪刀', '布'];
const LABEL = ['石头', '剪刀', '布'];
const NOTE = ['稳住节奏', '切入反击', '后手包抄'];

function $(id) { return document.getElementById(id); }

let playing = false;
let wins = 0;
let draws = 0;
let losses = 0;
let netGain = 0;

const btns = Array.from(document.querySelectorAll('.choice-btn'));

btns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (playing) return;
    play(Number(btn.dataset.c));
  });
});

function setScore() {
  $('s-win').textContent = String(wins);
  $('s-draw').textContent = String(draws);
  $('s-lose').textContent = String(losses);
  $('net-gain').textContent = (netGain > 0 ? '+' : '') + netGain + ' GB';
  $('net-gain').style.color = netGain > 0 ? '#34d399' : netGain < 0 ? '#fb7185' : '#e2e8f0';
}

function setRoundState(text, sub, signal, mode) {
  $('result-text').textContent = text;
  $('result-sub').textContent = sub;
  $('round-signal').textContent = signal;
  $('round-mode').textContent = mode;
}

function setHandState(choice) {
  $('hand-user').textContent = CHOICE_TEXT[choice];
  $('fighter-user-note').textContent = LABEL[choice] + ' · ' + NOTE[choice];
}

function selectButton(choice) {
  btns.forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.c) === choice);
    b.classList.add('disabled');
  });
}

function resetButtons() {
  btns.forEach((b) => {
    b.classList.remove('disabled');
    b.classList.remove('active');
  });
}

function setRemainingText(remainingGB, playsLeft) {
  const remainingText = remainingGB === -1 ? '∞' : String(remainingGB);
  const playsNum = Number(playsLeft);
  const playsText = Number.isFinite(playsNum) ? Math.max(0, playsNum) : '--';
  $('remaining').textContent = '剩余流量 ' + remainingText + ' GB · 今日还可玩 ' + playsText + ' 次';
}

function applyOutcomeVisual(result) {
  const userHand = $('hand-user');
  userHand.classList.remove('win-glow', 'lose-glow', 'pulse');
  if (result === 'win') userHand.classList.add('win-glow', 'pulse');
  if (result === 'lose') userHand.classList.add('lose-glow', 'pulse');
}

async function play(choice) {
  playing = true;
  selectButton(choice);
  setHandState(choice);
  $('hand-user').className = 'hand hand-user bounce';
  $('hand-sys').className = 'hand hand-sys shaking';
  $('hand-sys').textContent = CHOICE_TEXT[0];
  $('fighter-sys-note').textContent = '系统正在判断...';
  setRoundState('对战中...', '系统正在出拳，稍等一秒看结果。', '对决进行中', '别急，这一回合马上揭晓');

  let index = 0;
  const spinner = setInterval(() => {
    $('hand-sys').textContent = CHOICE_TEXT[index % 3];
    index += 1;
  }, 130);

  try {
    const response = await fetch('/api/rps-play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, choice }),
    });
    const data = await response.json();

    await new Promise((resolve) => setTimeout(resolve, 900));
    clearInterval(spinner);

    $('hand-sys').className = 'hand hand-sys bounce';

    if (!data.ok) {
      $('hand-sys').textContent = '失败';
      $('fighter-sys-note').textContent = '本回合未开始';
      setRoundState(data.error || '出错了', '可以稍后再试，或者等次数恢复。', '无法出拳', '本回合未结算');
      if (Object.prototype.hasOwnProperty.call(data, 'remainingGB') || Object.prototype.hasOwnProperty.call(data, 'playsLeft')) {
        setRemainingText(data.remainingGB, data.playsLeft);
      } else {
        await loadProfile();
      }
      if (typeof data.dayNetGb === 'number') {
        netGain = data.dayNetGb;
        setScore();
      }
      resetButtons();
      playing = false;
      return;
    }

    $('hand-sys').textContent = CHOICE_TEXT[data.sysChoice];
    $('fighter-sys-note').textContent = LABEL[data.sysChoice] + ' · 系统已出拳';

    setTimeout(() => {
      $('hand-user').classList.remove('bounce', 'shaking');
      $('hand-sys').classList.remove('bounce', 'shaking');

      if (data.result === 'win') {
        wins += 1;
        netGain += 2;
        setRoundState('你赢了这一回合', '石头剪刀布里你压住了系统，流量 +2GB。', '胜利到手', '继续打，今天还能薅更多');
        $('result-sub').style.color = '#34d399';
      } else if (data.result === 'draw') {
        draws += 1;
        setRoundState('平局，再来一把', '双方同步出拳，没有收益也没有损失。', '打平', '平局不伤，继续下一回合');
        $('result-sub').style.color = '#fbbf24';
      } else {
        losses += 1;
        netGain -= 1;
        setRoundState('这回合输了', '系统压过了你，这局扣掉 1GB。', '失利', '别连点，换个节奏再来');
        $('result-sub').style.color = '#fb7185';
      }

      setScore();
      applyOutcomeVisual(data.result);
      setRemainingText(data.remainingGB, data.playsLeft);
      if (typeof data.dayNetGb === 'number') {
        netGain = data.dayNetGb;
        setScore();
      }

      setTimeout(() => {
        $('hand-user').classList.remove('win-glow', 'lose-glow', 'pulse');
        resetButtons();
        playing = false;
      }, 700);
    }, 180);
  } catch (_err) {
    clearInterval(spinner);
    $('hand-sys').className = 'hand hand-sys';
    $('hand-sys').textContent = '失败';
    $('fighter-sys-note').textContent = '网络异常';
    setRoundState('网络错误', '请求没有成功发到服务器，稍后再试。', '连接中断', '这一回合没有结算');
    resetButtons();
    playing = false;
  }
}

async function loadProfile() {
  try {
    const response = await fetch('/api/rps-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    const data = await response.json();
    if (!data.ok) {
      $('remaining').textContent = data.error || '暂时无法读取状态';
      return;
    }
    netGain = data.netGb || 0;
    setScore();
    setRemainingText(data.remainingGB, data.playsLeft);
  } catch (_err) {
    $('remaining').textContent = '状态读取失败，请稍后重试';
  }
}

setScore();
loadProfile();
