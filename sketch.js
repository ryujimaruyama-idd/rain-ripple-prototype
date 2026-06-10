// ===============================
// ESP32 Wi-Fi設定
// ===============================

// ESP32のIPアドレス
// 変わった場合はここだけ変更
const ESP32_IP = "192.168.10.109";

// ポンプへの送信を使うか
const USE_ESP32 = true;

// ポンプの強さ上限
// 強すぎる場合は 0.25〜0.35 くらいに下げる
const PUMP_STRENGTH_LIMIT = 0.45;

// ポンプに送る頻度の調整
// 小さいほど送信が弱くなる
const PUMP_RATE_SCALE = 0.35;

// ポンプ送信の最短間隔 ms
const DROP_SEND_INTERVAL = 900;


// ===============================
// 音解析設定
// ===============================

let audioContext;
let micStream;
let analyser;
let timeDataArray;
let frequencyDataArray;

const FFT_SIZE = 2048;

let started = false;
let errorMessage = "";
let micButton;

let currentVolume = 0;
let smoothedVolume = 0;
let currentDb = -100;
let currentHz = 0;

let noiseFloor = 0.015;
let triggerThreshold = 0.045;

let lastDropSendTime = 0;
let lastVisualDropTime = 0;


// ===============================
// ビジュアル設定
// ===============================

let ripples = [];
let drops = [];
let particles = [];

let bgTop;
let bgBottom;

let wifiStatus = "Wi-Fi waiting";
let lastWifiSendTime = 0;


// ===============================
// p5 setup
// ===============================

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  textFont("sans-serif");

  bgTop = color(5, 7, 10);
  bgBottom = color(14, 20, 28);

  sendIdleCommand();

  createStartMicButton();
}


// ===============================
// Start Mic ボタン
// ===============================

function createStartMicButton() {
  micButton = createButton("Start Mic");
  micButton.position(24, 24);

  micButton.style("font-size", "20px");
  micButton.style("padding", "14px 22px");
  micButton.style("border-radius", "999px");
  micButton.style("border", "1px solid rgba(255,255,255,0.4)");
  micButton.style("background", "rgba(255,255,255,0.14)");
  micButton.style("color", "#ffffff");
  micButton.style("backdrop-filter", "blur(8px)");
  micButton.style("-webkit-backdrop-filter", "blur(8px)");
  micButton.style("z-index", "9999");

  micButton.mousePressed(startMicFromButton);

  micButton.elt.addEventListener(
    "touchend",
    function (event) {
      event.preventDefault();
      startMicFromButton();
    },
    { passive: false }
  );
}


async function startMicFromButton() {
  errorMessage = "マイクを起動中...";

  try {
    await startMic();

    if (started) {
      errorMessage = "";
      if (micButton) {
        micButton.hide();
      }
    }
  } catch (error) {
    console.error("startMicFromButton error:", error);
    errorMessage = `マイク起動エラー: ${error.name} / ${error.message}`;
  }
}


// ===============================
// マイク開始
// ===============================

async function startMic() {
  try {
    console.log("start mic");

    if (!navigator.mediaDevices) {
      errorMessage =
        "navigator.mediaDevices が使えません。このURLではマイクが許可されていない可能性があります。";
      console.error(errorMessage);
      return;
    }

    if (!navigator.mediaDevices.getUserMedia) {
      errorMessage =
        "getUserMedia が使えません。HTTPSで開いているか確認してください。";
      console.error(errorMessage);
      return;
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    console.log("mic stream started:", micStream);
    console.log("audio tracks:", micStream.getAudioTracks());

    const source = audioContext.createMediaStreamSource(micStream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.25;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;

    source.connect(analyser);

    timeDataArray = new Float32Array(analyser.fftSize);
    frequencyDataArray = new Uint8Array(analyser.frequencyBinCount);

    started = true;
    errorMessage = "";

    console.log("mic ready");
  } catch (error) {
    console.error("mic error:", error);
    errorMessage = `マイク起動エラー: ${error.name} / ${error.message}`;
  }
}


// ===============================
// p5 draw
// ===============================

function draw() {
  drawBackground();

  if (started && analyser) {
    analyzeSound();
    updateRippleGeneration();
  }

  updateVisuals();
  drawVisuals();
  drawUI();
}


// ===============================
// 背景
// ===============================

function drawBackground() {
  for (let y = 0; y < height; y++) {
    const t = y / height;
    const c = lerpColor(bgTop, bgBottom, t);
    stroke(c);
    line(0, y, width, y);
  }

  noStroke();
  fill(255, 255, 255, 8);

  for (let i = 0; i < 40; i++) {
    const x = noise(i * 2.1, frameCount * 0.002) * width;
    const y = noise(i * 8.7, frameCount * 0.002) * height;
    circle(x, y, 1.2);
  }
}


// ===============================
// 音解析
// ===============================

function analyzeSound() {
  analyser.getFloatTimeDomainData(timeDataArray);
  analyser.getByteFrequencyData(frequencyDataArray);

  let sum = 0;

  for (let i = 0; i < timeDataArray.length; i++) {
    const v = timeDataArray[i];
    sum += v * v;
  }

  currentVolume = Math.sqrt(sum / timeDataArray.length);
  smoothedVolume = lerp(smoothedVolume, currentVolume, 0.12);

  currentDb = 20 * Math.log10(Math.max(smoothedVolume, 0.00001));

  currentHz = estimateMainFrequency();
}


function estimateMainFrequency() {
  let maxValue = 0;
  let maxIndex = 0;

  for (let i = 0; i < frequencyDataArray.length; i++) {
    if (frequencyDataArray[i] > maxValue) {
      maxValue = frequencyDataArray[i];
      maxIndex = i;
    }
  }

  const nyquist = audioContext.sampleRate / 2;
  const frequency = (maxIndex / frequencyDataArray.length) * nyquist;

  return frequency;
}


// ===============================
// 音から波紋生成
// ===============================

function updateRippleGeneration() {
  const now = millis();

  const soundAmount = constrain(
    (smoothedVolume - noiseFloor) / triggerThreshold,
    0,
    1
  );

  if (soundAmount > 0.18 && now - lastVisualDropTime > 160) {
    const x = map(noise(frameCount * 0.013, soundAmount * 2.0), 0, 1, width * 0.18, width * 0.82);
    const y = map(noise(frameCount * 0.011, soundAmount * 4.0), 0, 1, height * 0.28, height * 0.78);

    createDrop(x, y, soundAmount);
    lastVisualDropTime = now;
  }

  if (soundAmount > 0.35 && now - lastDropSendTime > DROP_SEND_INTERVAL) {
    const strength = constrain(soundAmount * PUMP_RATE_SCALE, 0, 1);
    sendDropCommand(strength);
    lastDropSendTime = now;
  }
}


// ===============================
// ビジュアル生成
// ===============================

function createDrop(x, y, strength) {
  drops.push({
    x: x,
    y: y,
    r: map(strength, 0, 1, 4, 14),
    life: 1,
    strength: strength
  });

  ripples.push({
    x: x,
    y: y,
    r: 4,
    speed: map(strength, 0, 1, 1.6, 4.2),
    maxR: map(strength, 0, 1, 80, 260),
    life: 1,
    strength: strength
  });

  const count = floor(map(strength, 0, 1, 2, 14));

  for (let i = 0; i < count; i++) {
    const angle = random(TWO_PI);
    const speed = random(0.4, 2.3) * strength;

    particles.push({
      x: x,
      y: y,
      vx: cos(angle) * speed,
      vy: sin(angle) * speed - random(0.2, 1.0),
      size: random(1.5, 4.0),
      life: 1
    });
  }
}


// ===============================
// ビジュアル更新
// ===============================

function updateVisuals() {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];

    r.r += r.speed;
    r.life = 1 - r.r / r.maxR;

    if (r.life <= 0) {
      ripples.splice(i, 1);
    }
  }

  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];

    d.life -= 0.035;
    d.r += 0.2;

    if (d.life <= 0) {
      drops.splice(i, 1);
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];

    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.03;
    p.life -= 0.025;

    if (p.life <= 0) {
      particles.splice(i, 1);
    }
  }
}


// ===============================
// ビジュアル描画
// ===============================

function drawVisuals() {
  blendMode(ADD);

  for (const r of ripples) {
    noFill();

    const alpha = 110 * r.life;
    const weight = map(r.life, 0, 1, 0.5, 2.2);

    stroke(130, 190, 255, alpha);
    strokeWeight(weight);
    ellipse(r.x, r.y, r.r * 2, r.r * 0.72);

    stroke(255, 255, 255, alpha * 0.35);
    strokeWeight(weight * 0.45);
    ellipse(r.x, r.y, r.r * 1.3, r.r * 0.46);
  }

  for (const d of drops) {
    noStroke();
    fill(180, 220, 255, 170 * d.life);
    circle(d.x, d.y, d.r);

    fill(255, 255, 255, 120 * d.life);
    circle(d.x - d.r * 0.18, d.y - d.r * 0.22, d.r * 0.35);
  }

  for (const p of particles) {
    noStroke();
    fill(170, 220, 255, 130 * p.life);
    circle(p.x, p.y, p.size);
  }

  blendMode(BLEND);
}


// ===============================
// UI描画
// ===============================

function drawUI() {
  noStroke();

  fill(255, 255, 255, 210);
  textSize(13);
  textAlign(LEFT, TOP);

  let y = 24;

  if (!started) {
    y = 86;
    fill(255, 255, 255, 180);
    text("Start Mic を押してください", 24, y);
    y += 24;
  } else {
    fill(255, 255, 255, 220);
    text("MIC: ON", 24, y);
    y += 22;

    fill(255, 255, 255, 160);
    text(`volume: ${smoothedVolume.toFixed(4)}`, 24, y);
    y += 20;
    text(`dB: ${currentDb.toFixed(1)}`, 24, y);
    y += 20;
    text(`main Hz: ${currentHz.toFixed(0)}`, 24, y);
    y += 24;

    drawVolumeMeter(24, y, 180, 8);
    y += 26;
  }

  fill(255, 255, 255, 150);
  text(wifiStatus, 24, y);
  y += 22;

  if (errorMessage) {
    fill(255, 120, 120, 230);
    text(errorMessage, 24, y, width - 48);
  }

  drawGuideText();
}


function drawVolumeMeter(x, y, w, h) {
  const amount = constrain(smoothedVolume / 0.12, 0, 1);

  noStroke();
  fill(255, 255, 255, 35);
  rect(x, y, w, h, h / 2);

  fill(150, 210, 255, 190);
  rect(x, y, w * amount, h, h / 2);
}


function drawGuideText() {
  const guide = "D: test drop / S: stop";

  textAlign(RIGHT, BOTTOM);
  textSize(12);
  fill(255, 255, 255, 90);
  text(guide, width - 24, height - 24);
}


// ===============================
// ESP32通信
// ===============================

async function sendDropCommand(strength) {
  if (!USE_ESP32) {
    wifiStatus = "ESP32 disabled";
    return;
  }

  const limitedStrength = strength * PUMP_STRENGTH_LIMIT;
  const safeStrength = constrain(limitedStrength, 0, PUMP_STRENGTH_LIMIT);

  const url = `http://${ESP32_IP}/drop?strength=${safeStrength.toFixed(3)}`;

  try {
    await fetch(url, {
      method: "GET",
      mode: "cors"
    });

    wifiStatus = `SEND WIFI: DROP ${safeStrength.toFixed(3)}`;
    lastWifiSendTime = millis();
    console.log("SEND WIFI:", url);
  } catch (error) {
    wifiStatus = "Wi-Fi DROP send failed";
    console.error("Wi-Fi DROP send failed:", error);
  }
}


async function sendIdleCommand() {
  if (!USE_ESP32) return;

  const url = `http://${ESP32_IP}/idle`;

  try {
    await fetch(url, {
      method: "GET",
      mode: "cors"
    });

    wifiStatus = "SEND WIFI: IDLE";
    console.log("SEND WIFI:", url);
  } catch (error) {
    wifiStatus = "Wi-Fi IDLE send failed";
    console.error("Wi-Fi IDLE send failed:", error);
  }
}


async function sendStopCommand() {
  if (!USE_ESP32) return;

  const url = `http://${ESP32_IP}/stop`;

  try {
    await fetch(url, {
      method: "GET",
      mode: "cors"
    });

    wifiStatus = "SEND WIFI: STOP";
    console.log("SEND WIFI:", url);
  } catch (error) {
    wifiStatus = "Wi-Fi STOP send failed";
    console.error("Wi-Fi STOP send failed:", error);
  }
}


// ===============================
// キーボード操作
// ===============================

function keyPressed() {
  if (key === "d" || key === "D") {
    createDrop(random(width * 0.25, width * 0.75), random(height * 0.35, height * 0.7), 1.0);
    sendDropCommand(1.0);
  }

  if (key === "s" || key === "S") {
    sendStopCommand();
  }
}


// ===============================
// 画面サイズ変更
// ===============================

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}