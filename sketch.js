let audioContext;
let analyser;
let micStream;

let timeDataArray;
let frequencyDataArray;

let started = false;
let errorMessage = "";

const FFT_SIZE = 4096;

// 騒音計のような正のdBに近づけるための補正値
const DB_CALIBRATION_OFFSET = 100;

// ===== ESP32 Wi-Fi =====
// ESP32のIPアドレス
// ESP32のSerial Monitorに出たIPに合わせて変更
const ESP32_IP = "192.168.10.109";

const USE_ESP32 = true;

let wifiStatus = "ESP32 Wi-Fi waiting";
let lastWifiSendTime = 0;
// ======================

// ===== Pump Output Limit =====
// Web側では、波紋発生時に送るDROPの強さと頻度を制限する。
const PUMP_STRENGTH_LIMIT = 0.45; // 1回のDROPの強さ。0.0〜1.0
const PUMP_RATE_SCALE = 0.35;     // DROPの発生回数を抑える倍率
// =============================

// ===== 1秒ごとに平均dB / Hzを更新 =====
const AVERAGE_UPDATE_INTERVAL = 1000;
let samples = [];
let lastAverageUpdateTime = 0;

let heldAverageDb = 0;
let heldAverageHz = 0;
let averageReady = false;
// =====================================

// ===== 波紋 =====
let ripples = [];
let lastDropCheckTime = 0;

// 0.5秒ごとに発生判定
const DROP_CHECK_INTERVAL = 500;
// =================

// ===== Mic Button =====
let micButton;
// ======================

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont("sans-serif");

  createMicButton();

  sendIdleCommand();
}

function createMicButton() {
  micButton = createButton("Start Mic");
  micButton.position(20, 70);
  micButton.style("background", "#111");
  micButton.style("color", "#ddd");
  micButton.style("border", "1px solid #555");
  micButton.style("padding", "6px 10px");
  micButton.style("font-size", "12px");

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

    if (started && micButton) {
      micButton.hide();
    }
  } catch (error) {
    console.error("startMicFromButton error:", error);
    errorMessage = `マイクを開始できませんでした: ${error.name} / ${error.message}`;
  }
}

async function sendDropCommand(strength) {
  if (!USE_ESP32) return;

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
    lastWifiSendTime = millis();

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
    lastWifiSendTime = millis();

    console.log("SEND WIFI:", url);
  } catch (error) {
    wifiStatus = "Wi-Fi STOP send failed";
    console.error("Wi-Fi STOP send failed:", error);
  }
}

async function startMic() {
  try {
    console.log("start mic");

    if (!navigator.mediaDevices) {
      errorMessage =
        "navigator.mediaDevices が使えません。HTTPSで開いているか確認してください。";
      console.error(errorMessage);
      return;
    }

    if (!navigator.mediaDevices.getUserMedia) {
      errorMessage =
        "getUserMedia が使えません。Safariのマイク設定を確認してください。";
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
    analyser.smoothingTimeConstant = 0.2;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;

    source.connect(analyser);

    timeDataArray = new Float32Array(analyser.fftSize);
    frequencyDataArray = new Float32Array(analyser.frequencyBinCount);

    samples = [];
    lastAverageUpdateTime = millis();
    lastDropCheckTime = millis();

    heldAverageDb = 0;
    heldAverageHz = 0;
    averageReady = false;

    started = true;
    errorMessage = "";

    console.log("mic ready");
  } catch (error) {
    console.error("mic error:", error);
    errorMessage = `マイクを開始できませんでした: ${error.name} / ${error.message}`;
  }
}

function draw() {
  background(0);

  if (!started) {
    drawWaitingScreen();
    return;
  }

  if (errorMessage !== "") {
    fill(240);
    textSize(16);
    textAlign(LEFT, TOP);
    text(errorMessage, 40, 120);
    return;
  }

  analyser.getFloatTimeDomainData(timeDataArray);
  analyser.getFloatFrequencyData(frequencyDataArray);

  const currentDb = getDbFromTimeData(timeDataArray);

  const currentHz = getDominantFrequencyFromFFT(
    frequencyDataArray,
    audioContext.sampleRate,
    analyser.fftSize
  );

  updateAverageEverySecond(currentDb, currentHz);

  const displayAverageDb = averageReady ? heldAverageDb : currentDb;
  const displayAverageHz = averageReady ? heldAverageHz : currentHz;

  const dropsPerHalfSecond = dbToDropsPerHalfSecond(displayAverageDb);
  const rippleStrength = hzToRippleStrength(displayAverageHz, displayAverageDb);

  updateRippleGeneration(dropsPerHalfSecond, rippleStrength);
  updateAndDrawRipples();

  drawInfo({
    currentDb: currentDb,
    currentHz: currentHz,
    averageDb: displayAverageDb,
    averageHz: displayAverageHz,
    dropsPerHalfSecond: dropsPerHalfSecond,
    rippleStrength: rippleStrength
  });

  drawBars({
    averageDb: displayAverageDb,
    averageHz: displayAverageHz,
    dropsPerHalfSecond: dropsPerHalfSecond
  });

  drawUpdateClock();

  drawFrequencyGraph(
    frequencyDataArray,
    audioContext.sampleRate,
    analyser.fftSize
  );
}

function drawWaitingScreen() {
  background(0);

  fill(240);
  textSize(16);
  textAlign(LEFT, TOP);
  text("Start Mic を押してマイクを開始してください", 40, 120);

  fill(120);
  textSize(12);
  text("iPad Safariでは、GitHub PagesのURLから開いてください", 40, 150);

  fill(120);
  textSize(12);
  text(wifiStatus, 40, 180);

  if (errorMessage !== "") {
    fill(240, 120, 120);
    textSize(12);
    text(errorMessage, 40, 210, width - 80);
  }

  drawIdleRipple();
}

function drawIdleRipple() {
  const area = getSimulationArea();
  const cx = area.x + area.w * 0.50;
  const cy = area.y + area.h * 0.78;

  noFill();

  stroke(20, 220, 225, 90);
  strokeWeight(1.5);
  circle(cx, cy, 120);

  stroke(20, 220, 225, 50);
  strokeWeight(1);
  circle(cx, cy, 260);

  stroke(20, 220, 225, 30);
  circle(cx, cy, 420);

  fill(150);
  noStroke();
  textSize(10);
  textAlign(LEFT, TOP);
  text("ripple simulation", area.x + 20, 50);
}

function getDbFromTimeData(buffer) {
  let sumSquares = 0;

  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
  }

  const rms = Math.sqrt(sumSquares / buffer.length);
  const dbfs = 20 * Math.log10(rms + 0.000001);
  const estimatedDb = dbfs + DB_CALIBRATION_OFFSET;

  return constrain(estimatedDb, 0, 120);
}

function getDominantFrequencyFromFFT(data, sampleRate, fftSize) {
  let peakIndex = 0;
  let peakDb = -Infinity;

  const binWidth = sampleRate / fftSize;
  const startBin = Math.floor(20 / binWidth);
  const endBin = Math.min(data.length - 1, Math.floor(20000 / binWidth));

  for (let i = startBin; i <= endBin; i++) {
    if (data[i] > peakDb) {
      peakDb = data[i];
      peakIndex = i;
    }
  }

  return peakIndex * binWidth;
}

function updateAverageEverySecond(db, hz) {
  const now = millis();

  samples.push({
    db: db,
    hz: hz
  });

  if (now - lastAverageUpdateTime >= AVERAGE_UPDATE_INTERVAL) {
    let sumDb = 0;
    let sumHz = 0;

    for (let i = 0; i < samples.length; i++) {
      sumDb += samples[i].db;
      sumHz += samples[i].hz;
    }

    heldAverageDb = sumDb / samples.length;
    heldAverageHz = sumHz / samples.length;

    averageReady = true;
    samples = [];
    lastAverageUpdateTime = now;
  }
}

function dbToDropsPerHalfSecond(db) {
  let drops;

  if (db >= 70) {
    drops = 4.00;
  } else if (db <= 40) {
    drops = 0.50;
  } else if (db <= 55) {
    drops = map(db, 40, 55, 0.50, 1.50);
  } else {
    drops = map(db, 55, 70, 1.50, 4.00);
  }

  return drops * PUMP_RATE_SCALE;
}

function hzToRippleStrength(freq, db) {
  if (db >= 70) {
    return 0.75;
  }

  const freqMin = 20;
  const freqMax = 20000;

  const raw = constrain(mapLog(freq, freqMin, freqMax, 0, 1), 0, 1);

  return constrain(map(raw, 0, 1, 0.40, 0.75), 0.40, 0.75);
}

function updateRippleGeneration(dropsPerHalfSecond, strength) {
  const now = millis();

  while (now - lastDropCheckTime >= DROP_CHECK_INTERVAL) {
    const wholeDrops = floor(dropsPerHalfSecond);
    const probabilityDrop = dropsPerHalfSecond - wholeDrops;

    for (let i = 0; i < wholeDrops; i++) {
      createRipple(strength);
      sendDropCommand(strength);
    }

    if (random() < probabilityDrop) {
      createRipple(strength);
      sendDropCommand(strength);
    }

    lastDropCheckTime += DROP_CHECK_INTERVAL;
  }
}

function createRipple(strength) {
  const area = getSimulationArea();

  const cx = area.x + area.w * 0.50;
  const cy = area.y + area.h * 0.78;

  const maxRadius = map(strength, 0, 1, 285, 840);
  const growSpeed = map(strength, 0, 1, 1.8, 6.2);
  const alpha = map(strength, 0, 1, 145, 255);
  const strokeW = map(strength, 0, 1, 1.4, 3.7);

  ripples.push({
    x: cx,
    y: cy,
    radius: 2,
    maxRadius: maxRadius,
    growSpeed: growSpeed,
    alpha: alpha,
    strokeW: strokeW,
    strength: strength
  });
}

function updateAndDrawRipples() {
  drawSimulationLabel();

  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];

    r.radius += r.growSpeed;

    const life = 1 - r.radius / r.maxRadius;
    const currentAlpha = max(0, r.alpha * life);

    const redValue = map(r.strength, 0, 1, 20, 45);
    const greenValue = map(r.strength, 0, 1, 215, 255);
    const blueValue = map(r.strength, 0, 1, 220, 255);

    noFill();

    stroke(redValue, greenValue, blueValue, currentAlpha);
    strokeWeight(r.strokeW * life + 0.35);
    circle(r.x, r.y, r.radius * 2);

    stroke(redValue, greenValue, blueValue, currentAlpha * 0.40);
    strokeWeight(1.0);
    circle(r.x, r.y, r.radius * 2.18);

    stroke(redValue, greenValue, blueValue, currentAlpha * 0.20);
    strokeWeight(0.6);
    circle(r.x, r.y, r.radius * 1.72);

    if (r.radius >= r.maxRadius) {
      ripples.splice(i, 1);
    }
  }
}

function getSimulationArea() {
  return {
    x: width * 0.42,
    y: 0,
    w: width * 0.55,
    h: height * 0.58
  };
}

function drawSimulationLabel() {
  const area = getSimulationArea();

  noStroke();
  fill(150);
  textSize(10);
  textAlign(LEFT, TOP);
  text("ripple simulation", area.x + 20, 50);
}

function getAverageUpdateProgress() {
  const elapsed = millis() - lastAverageUpdateTime;
  return constrain(elapsed / AVERAGE_UPDATE_INTERVAL, 0, 1);
}

function getNextAverageUpdateSeconds() {
  const elapsed = millis() - lastAverageUpdateTime;
  const remain = max(0, AVERAGE_UPDATE_INTERVAL - elapsed);
  return remain / 1000;
}

function drawInfo(info) {
  const boxLeft = 40;
  const boxTop = 40;
  const boxWidth = 360;

  const labelX = boxLeft;
  const valueX = boxLeft + boxWidth;
  const lineHeight = 28;

  const rows = [
    { label: "current dB", value: `${info.currentDb.toFixed(1)} dB` },
    { label: "1s avg dB", value: `${info.averageDb.toFixed(1)} dB` },
    { label: "current Hz", value: `${info.currentHz.toFixed(1)} Hz` },
    { label: "1s avg Hz", value: `${info.averageHz.toFixed(1)} Hz` },
    { label: "event rate", value: `${info.dropsPerHalfSecond.toFixed(2)} / 0.5 sec` },
    { label: "strength", value: `${(info.rippleStrength * 100).toFixed(0)} %` },
    { label: "next update", value: `${getNextAverageUpdateSeconds().toFixed(2)} sec` }
  ];

  textSize(14);

  for (let i = 0; i < rows.length; i++) {
    const y = boxTop + i * lineHeight;

    fill(140);
    textAlign(LEFT, TOP);
    text(rows[i].label, labelX, y);

    fill(240);
    textAlign(RIGHT, TOP);
    text(rows[i].value, valueX, y);
  }

  textSize(10);
  fill(110);
  textAlign(RIGHT, TOP);
  text(
    "RMS dB / FFT dominant Hz",
    valueX,
    boxTop + lineHeight * rows.length + 8
  );
}

function drawBars(info) {
  const panelLeft = 40;
  const panelTop = 300;
  const panelWidth = 360;

  const barWidth = panelWidth;
  const barHeight = 2;

  const dbMin = 0;
  const dbMax = 100;

  const hzMin = 20;
  const hzMax = 20000;

  const rateMin = 0;
  const rateMax = 2.5;

  const averageDbAmount = constrain(
    map(info.averageDb, dbMin, dbMax, 0, 1),
    0,
    1
  );

  const averageHzAmount = constrain(
    mapLog(info.averageHz, hzMin, hzMax, 0, 1),
    0,
    1
  );

  const eventRateAmount = constrain(
    map(info.dropsPerHalfSecond, rateMin, rateMax, 0, 1),
    0,
    1
  );

  noStroke();

  fill(140);
  textSize(10);
  textAlign(LEFT, TOP);
  text("sound monitor", panelLeft, panelTop);

  const dbY = panelTop + 30;

  fill(120);
  text("1s avg dB", panelLeft, dbY - 16);

  textAlign(RIGHT, TOP);
  text(`${info.averageDb.toFixed(1)} dB`, panelLeft + panelWidth, dbY - 16);

  fill(45);
  rect(panelLeft, dbY, barWidth, barHeight, 1);

  fill(95, 170, 170);
  rect(panelLeft, dbY, barWidth * averageDbAmount, barHeight, 1);

  const thresholdX = panelLeft + barWidth * constrain(
    map(55, dbMin, dbMax, 0, 1),
    0,
    1
  );

  stroke(245, 120);
  strokeWeight(1);
  line(thresholdX, dbY - 4, thresholdX, dbY + barHeight + 4);

  const hzY = dbY + 44;

  noStroke();
  fill(120);
  textAlign(LEFT, TOP);
  text("1s avg Hz", panelLeft, hzY - 16);

  textAlign(RIGHT, TOP);
  text(`${info.averageHz.toFixed(1)} Hz`, panelLeft + panelWidth, hzY - 16);

  fill(45);
  rect(panelLeft, hzY, barWidth, barHeight, 1);

  fill(95, 170, 170);
  rect(panelLeft, hzY, barWidth * averageHzAmount, barHeight, 1);

  const rateY = hzY + 44;

  fill(120);
  textAlign(LEFT, TOP);
  text("event rate", panelLeft, rateY - 16);

  textAlign(RIGHT, TOP);
  text(`${info.dropsPerHalfSecond.toFixed(2)} / 0.5 sec`, panelLeft + panelWidth, rateY - 16);

  fill(45);
  rect(panelLeft, rateY, barWidth, barHeight, 1);

  fill(95, 170, 170);
  rect(panelLeft, rateY, barWidth * eventRateAmount, barHeight, 1);
}

function drawUpdateClock() {
  const progress = getAverageUpdateProgress();

  const panelLeft = 40;
  const panelTop = 485;

  const clockSize = 52;
  const cx = panelLeft + clockSize / 2;
  const cy = panelTop + clockSize / 2;

  noStroke();
  fill(140);
  textSize(10);
  textAlign(LEFT, TOP);
  text("1s update cycle", panelLeft, panelTop - 18);

  noFill();
  stroke(245, 45);
  strokeWeight(1);
  circle(cx, cy, clockSize);

  const startAngle = -HALF_PI;
  const endAngle = startAngle + TWO_PI * progress;

  stroke(95, 170, 170, 190);
  strokeWeight(2);
  noFill();
  arc(cx, cy, clockSize, clockSize, startAngle, endAngle);

  fill(125);
  noStroke();
  textSize(10);
  textAlign(LEFT, TOP);
  text(
    `${progress.toFixed(2)} / 1.00 sec`,
    panelLeft + 76,
    panelTop + 10
  );

  fill(180);
  text(
    `${getNextAverageUpdateSeconds().toFixed(2)} sec until update`,
    panelLeft + 76,
    panelTop + 28
  );
}

function drawFrequencyGraph(data, sampleRate, fftSize) {
  const graphW = width * 0.6;
  const graphH = 180;

  const graphX = 150;
  const graphY = height - graphH - 160;

  noFill();
  stroke(245, 35);
  strokeWeight(1);
  rect(graphX, graphY, graphW, graphH);

  noStroke();
  fill(120);
  textSize(10);
  textAlign(LEFT, TOP);
  text("FFT frequency spectrum", graphX, graphY - 18);

  drawFrequencyGrid(graphX, graphY, graphW, graphH);

  const minFreq = 20;
  const maxFreq = 20000;

  noFill();
  strokeWeight(1.5);

  let prevX = null;
  let prevY = null;

  for (let i = 1; i < data.length; i++) {
    const freq = i * sampleRate / fftSize;

    if (freq < minFreq || freq > maxFreq) continue;

    const x = graphX + mapLog(freq, minFreq, maxFreq, 0, graphW);

    const y = graphY + map(
      data[i],
      analyser.minDecibels,
      analyser.maxDecibels,
      graphH,
      0
    );

    const freqAmount = constrain(
      mapLog(freq, minFreq, maxFreq, 0, 1),
      0,
      1
    );

    const dbAmount = constrain(
      map(data[i], analyser.minDecibels, analyser.maxDecibels, 0, 1),
      0,
      1
    );

    if (prevX !== null) {
      const greenValue = map(dbAmount, 0, 1, 120, 190);
      const blueValue = map(freqAmount, 0, 1, 135, 200);
      const alphaValue = map(dbAmount, 0, 1, 80, 180);

      stroke(80, greenValue, blueValue, alphaValue);
      line(prevX, prevY, x, y);
    }

    prevX = x;
    prevY = y;
  }
}

function drawFrequencyGrid(x, y, w, h) {
  stroke(245, 18);
  strokeWeight(1);

  const freqTicks = [
    20, 50, 100, 200, 500,
    1000, 2000, 5000, 10000, 20000
  ];

  for (let f of freqTicks) {
    const gx = x + mapLog(f, 20, 20000, 0, w);

    stroke(245, 20);
    line(gx, y, gx, y + h);

    noStroke();
    fill(100);
    textSize(8);
    textAlign(CENTER, TOP);
    text(formatFreqLabel(f), gx, y + h + 6);
  }

  const dbTicks = [-100, -80, -60, -40, -20];

  for (let db of dbTicks) {
    const gy = y + map(db, analyser.minDecibels, analyser.maxDecibels, h, 0);

    stroke(245, 20);
    line(x, gy, x + w, gy);

    noStroke();
    fill(100);
    textSize(8);
    textAlign(RIGHT, CENTER);
    text(db, x - 6, gy);
  }
}

function formatFreqLabel(freq) {
  if (freq >= 1000) {
    return freq / 1000 + "k";
  }

  return String(freq);
}

function mapLog(value, inMin, inMax, outMin, outMax) {
  if (value <= 0) {
    return outMin;
  }

  const logMin = Math.log10(inMin);
  const logMax = Math.log10(inMax);
  const logValue = Math.log10(value);

  return map(logValue, logMin, logMax, outMin, outMax);
}

function keyPressed() {
  if (key === "d" || key === "D") {
    createRipple(1.0);
    sendDropCommand(1.0);
  }

  if (key === "s" || key === "S") {
    sendStopCommand();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}