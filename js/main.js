(function () {
  'use strict';

  // Shared numeric clamp used by the live dashboard/update loop.
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  var STORE_KEY = 'rev-my-dishwasher.settings.v1';
  var defaults = { carId: 'city-shifter', mode: 'test', manual: false, volume: 0.7, character: 0.65, crackle: 0.25, intensity: 0.55, units: 'kmh' };
  var settings = readSettings();
  // Start each new session in automatic; manual is an explicit in-session choice.
  settings.manual = false;
  var cars = (window.MOTORSOUND_CARS || []).filter(function (c) { return c.engine && c.vehicle; });
  var car = findCar(settings.carId) || cars.filter(function (c) { return c.id === 'city-shifter'; })[0] || cars[0];
  var vehicle = new Vehicle(car);
  var audio = new EngineAudio();
  var gps = new GpsSpeed(onGpsStatus);
  var engineOn = false;
  var gpsSpeed = 0;
  var gpsAccel = 0;
  var lastFrame = performance.now();
  var pads = { gas: 0, brake: 0, rev: 0 };
  var testAudioTimer = 0;
  var lastParamSent = 0;

  var $ = function (id) { return document.getElementById(id); };
  var ui = {
    gpsStatus: $('gpsStatus'), audioStatus: $('audioStatus'), rpmDial: $('rpmDial'), speedValue: $('speedValue'), speedUnit: $('speedUnit'), gearValue: $('gearValue'), rpmValue: $('rpmValue'),
    throttleText: $('throttleText'), throttleMeter: $('throttleMeter'), loadText: $('loadText'), loadMeter: $('loadMeter'), driveState: $('driveState'), gpsAccuracy: $('gpsAccuracy'),
    carSelect: $('carSelect'), carName: $('carName'), carTagline: $('carTagline'), engineBadge: $('engineBadge'), startButton: $('startButton'), startLabel: $('startLabel'), startNote: $('startNote'),
    testControls: $('testControls'), manualGears: $('manualGears'), manualGearLabel: $('manualGearLabel'), notice: $('notice'),
    runtimeStatus: $('runtimeStatus'),
    volumeSlider: $('volumeSlider'), characterSlider: $('characterSlider'), crackleSlider: $('crackleSlider'), intensitySlider: $('intensitySlider')
  };

  function readSettings() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { saved = {}; }
    var result = {};
    Object.keys(defaults).forEach(function (key) { result[key] = saved[key] !== undefined ? saved[key] : defaults[key]; });
    return result;
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* storage can be disabled */ }
  }

  function findCar(id) {
    for (var i = 0; i < cars.length; i++) if (cars[i].id === id) return cars[i];
    return null;
  }

  function text(el, value) { if (el) el.textContent = value; }
  function percent(n) { return Math.round(Math.max(0, Math.min(1, n)) * 100); }

  function setNotice(message, kind) {
    ui.notice.className = 'notice' + (kind ? ' ' + kind : '');
    text(ui.notice, message);
  }

  function engineLabel(c) {
    var type = c.engine.type;
    if (type === 'electric') return 'EV';
    if (type === 'thruster') return 'THRUSTER';
    if (type === 'haunted') return 'SPECIAL';
    var firing = c.engine.firing || [];
    var cylinders = firing.length;
    var label = cylinders ? String(cylinders) + ' CYL' : 'ENGINE';
    if (c.id === 'v8-muscle' || c.id === 'hellcat' || c.id === 'haunted-hearse') label = 'V8';
    if (c.id === 'ferrari-v12') label = 'V12';
    if (c.id === 'gt3' || c.id === 'city-shifter') label = 'FLAT-6';
    return label;
  }

  function renderCarList() {
    ui.carSelect.textContent = '';
    cars.forEach(function (c) {
      var option = document.createElement('option');
      option.value = c.id;
      option.textContent = c.name;
      ui.carSelect.appendChild(option);
    });
    ui.carSelect.value = car.id;
  }

  function renderCar() {
    text(ui.carName, car.name);
    text(ui.carTagline, car.tagline || 'Profilo sonoro');
    text(ui.engineBadge, engineLabel(car));
    ui.carSelect.value = car.id;
    document.title = 'Rev My Dishwasher — ' + car.name;
  }

  function setMode(mode) {
    settings.mode = mode === 'gps' ? 'gps' : 'test';
    document.querySelectorAll('[data-mode]').forEach(function (button) {
      var active = button.dataset.mode === settings.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    ui.testControls.hidden = settings.mode !== 'test';
    if (settings.mode === 'gps') {
      gpsSpeed = 0;
      gpsAccel = 0;
      if (engineOn) gps.start();
      text(ui.driveState, 'GPS DRIVE');
    } else {
      gps.stop();
      text(ui.driveState, 'TEST DRIVE');
    }
    saveSettings();
  }

  function setManual(enabled) {
    settings.manual = !!enabled && vehicle.ratios.length > 1;
    vehicle.setManual(settings.manual);
    $('autoButton').classList.toggle('active', !settings.manual);
    $('manualButton').classList.toggle('active', settings.manual);
    $('autoButton').setAttribute('aria-pressed', String(!settings.manual));
    $('manualButton').setAttribute('aria-pressed', String(settings.manual));
    ui.manualGears.hidden = !settings.manual;
    text(ui.manualGearLabel, String(vehicle.gear));
    saveSettings();
  }

  function stopEngine() {
    engineOn = false;
    gps.stop();
    audio.stop();
    ui.startButton.classList.remove('running');
    text(ui.startLabel, 'AVVIA MOTORE');
    text(ui.audioStatus.querySelector('span'), 'MOTORE SPENTO');
    ui.audioStatus.classList.remove('ok', 'active');
    text(ui.startNote, 'Audio in pausa. Premi di nuovo per riavviare il motore.');
    setNotice('Motore spento. Le impostazioni restano salvate su questo dispositivo.');
  }

  function startEngine() {
    if (engineOn) { stopEngine(); return; }
    audio.setVolume(settings.volume);
    setNotice('Inizializzazione del sintetizzatore…');
    ui.startButton.disabled = true;
    audio.start(car.engine).then(function () {
      engineOn = true;
      ui.startButton.disabled = false;
      ui.startButton.classList.add('running');
      text(ui.startLabel, 'SPEGNI MOTORE');
      text(ui.audioStatus.querySelector('span'), 'AUDIO ATTIVO');
      ui.audioStatus.classList.add('ok');
      text(ui.startNote, 'Motore acceso. In GPS Drive il suono segue la velocità rilevata.');
      if (settings.mode === 'gps') gps.start();
      setNotice('Motore acceso. Regola il volume e prova una breve accelerata.');
    }).catch(function (err) {
      ui.startButton.disabled = false;
      var message = err && err.message ? err.message : 'errore Web Audio.';
      setNotice('Impossibile avviare l’audio: ' + message, 'error');
      if (ui.runtimeStatus) ui.runtimeStatus.textContent = 'AUDIO ERRORE: ' + message;
      console.error('Rev My Dishwasher START:', err);
    });
  }

  function selectCar(id) {
    var next = findCar(id);
    if (!next || next.id === car.id) return;
    if (engineOn) stopEngine();
    if (testAudioTimer) { clearTimeout(testAudioTimer); testAudioTimer = 0; }
    audio.setEngine();
    car = next;
    settings.carId = car.id;
    vehicle = new Vehicle(car);
    renderCar();
    setManual(settings.manual);
    setNotice('Profilo selezionato: ' + car.name + '. Premi Avvia motore per ascoltarlo.');
    saveSettings();
  }

  function onGpsStatus(state) {
    var chip = ui.gpsStatus;
    chip.classList.remove('ok', 'active');
    if (state.status === 'ok') {
      chip.classList.add('ok');
      text(chip.querySelector('span'), 'GPS OK');
      text(ui.gpsAccuracy, state.accuracy ? '±' + Math.round(state.accuracy) + ' m' : 'SEGNALE GPS');
    } else if (state.status === 'waiting') {
      chip.classList.add('active');
      text(chip.querySelector('span'), 'GPS IN ATTESA');
      text(ui.gpsAccuracy, 'IN ATTESA DEL SEGNALE');
    } else if (state.status === 'denied' || state.status === 'unsupported' || state.status === 'error') {
      text(chip.querySelector('span'), state.status === 'denied' ? 'GPS NEGATO' : 'GPS NON DISPONIBILE');
      text(ui.gpsAccuracy, 'CONTROLLA I PERMESSI');
      if (engineOn && settings.mode === 'gps') setNotice(state.error || 'GPS non disponibile. Puoi passare a Test Drive.', 'warn');
    } else if (state.status === 'stale') {
      chip.classList.add('active');
      text(chip.querySelector('span'), 'GPS DEBOLE');
      text(ui.gpsAccuracy, 'ULTIMO SEGNALE');
    } else {
      text(chip.querySelector('span'), 'GPS OFF');
      text(ui.gpsAccuracy, '--');
    }
  }

  function setPad(name, value, button) {
    pads[name] = value ? 1 : 0;
    if (button) button.classList.toggle('active', !!value);
  }

  function bindHoldButton(button, key) {
    function down(event) {
      if (event.cancelable) event.preventDefault();
      setPad(key, 1, button);
      try { button.setPointerCapture(event.pointerId); } catch (e) { /* optional */ }
    }
    function up(event) {
      if (event && event.cancelable) event.preventDefault();
      setPad(key, 0, button);
    }
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('lostpointercapture', up);
    button.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function testAudio() {
    if (engineOn) {
      setNotice('Motore già acceso: usa REV per controllare l’audio.');
      return;
    }
    if (testAudioTimer) clearTimeout(testAudioTimer);
    audio.setVolume(settings.volume);
    audio.start(car.engine).then(function () {
      var e = car.engine;
      var idle = e.idleRpm || 800;
      var rpm = e.type === 'electric' ? Math.max(900, e.redlineRpm * 0.22) : idle + (e.redlineRpm - idle) * 0.38;
      audio.setParams({ rpm: rpm, load: 0.72, overrun: 0, cut: 0, character: settings.character, crackle: settings.crackle, whinePitch: 1, whineLevel: 1, speed: 9, rev: e.type === 'thruster' ? 0.8 : 0 });
      text(ui.audioStatus.querySelector('span'), 'TEST AUDIO');
      ui.audioStatus.classList.add('active');
      setNotice('Test audio in corso.');
      if (ui.runtimeStatus) ui.runtimeStatus.textContent = 'AUDIO: ' + audio.kind + ' · ' + audio.ctx.state + ' · ' + audio.ctx.sampleRate + ' Hz';
      testAudioTimer = setTimeout(function () {
        if (!engineOn) {
          audio.stop();
          text(ui.audioStatus.querySelector('span'), 'MOTORE SPENTO');
          ui.audioStatus.classList.remove('active');
        } else {
          setNotice('Test audio completato. Il motore resta acceso.');
        }
        testAudioTimer = 0;
      }, 1900);
    }).catch(function (err) {
      var message = err && err.message ? err.message : 'errore Web Audio.';
      setNotice('Test audio non riuscito: ' + message, 'error');
      if (ui.runtimeStatus) ui.runtimeStatus.textContent = 'AUDIO ERRORE: ' + message;
      console.error('Rev My Dishwasher TEST AUDIO:', err);
    });
  }

  function updateDisplay() {
    var speed = settings.units === 'mph' ? vehicle.speed * 2.236936 : vehicle.speed * 3.6;
    text(ui.speedValue, String(Math.round(speed)));
    text(ui.speedUnit, settings.units === 'mph' ? 'mph' : 'km/h');
    text(ui.gearValue, engineOn || vehicle.speed > 0.4 ? vehicle.gearLabel() : 'N');
    text(ui.rpmValue, String(Math.round(vehicle.rpm / 10) * 10));
    var maxRpm = car.engine.redlineRpm || 8000;
    var fraction = clamp(vehicle.rpm / maxRpm, 0, 1);
    ui.rpmDial.style.setProperty('--rpm-progress', (fraction * 270).toFixed(1) + 'deg');
    ui.rpmDial.classList.toggle('near-redline', vehicle.rpm > maxRpm * 0.88);
    var throttle = vehicle.neutral && pads.rev ? pads.rev : vehicle.throttle;
    var load = vehicle.load;
    text(ui.throttleText, percent(throttle) + '%');
    text(ui.loadText, percent(load) + '%');
    ui.throttleMeter.style.width = percent(throttle) + '%';
    ui.loadMeter.style.width = percent(load) + '%';
    text(ui.manualGearLabel, String(vehicle.gear));
    text(ui.driveState, settings.mode === 'gps' ? 'GPS DRIVE' : 'TEST DRIVE');
    $('downGear').disabled = vehicle.gear <= 1;
    $('upGear').disabled = vehicle.gear >= vehicle.ratios.length;
  }

  function tick(now) {
    try {
    var dt = Math.min(0.08, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    var input;
    if (settings.mode === 'gps') {
      var sample = gps.read();
      gpsSpeed += (sample.speed - gpsSpeed) * (1 - Math.exp(-dt / 0.22));
      gpsAccel += (sample.accel - gpsAccel) * (1 - Math.exp(-dt / 0.32));
      input = { source: 'gps', speed: gpsSpeed, accel: gpsAccel, rev: pads.rev };
    } else {
      input = { source: 'test', gas: pads.gas, brake: pads.brake, rev: pads.rev };
    }
    vehicle.update(dt, input, settings.intensity);

    if (engineOn && now - lastParamSent > 30) {
      if (vehicle.clicks.length) while (vehicle.clicks.length) audio.click(vehicle.clicks.shift());
      audio.clutch(vehicle.clutch);
      audio.setParams({
        rpm: vehicle.rpm,
        load: vehicle.load,
        overrun: vehicle.overrun,
        cut: vehicle.cut,
        character: settings.character,
        crackle: settings.crackle,
        whinePitch: 1,
        whineLevel: 1,
        speed: vehicle.speed,
        rev: vehicle.revPedal
      });
      lastParamSent = now;
    }
    updateDisplay();
    } catch (err) {
      console.error('Rev My Dishwasher update loop:', err);
      setNotice('Errore aggiornamento: ' + (err && err.message ? err.message : String(err)), 'error');
      if (ui.runtimeStatus) ui.runtimeStatus.textContent = 'APP ERRORE: ' + (err && err.message ? err.message : String(err));
    } finally {
      requestAnimationFrame(tick);
    }
  }

  function bindSliders() {
    [
      ['volumeSlider', 'volume', 'volumeValue'],
      ['characterSlider', 'character', 'characterValue'],
      ['crackleSlider', 'crackle', 'crackleValue'],
      ['intensitySlider', 'intensity', 'intensityValue']
    ].forEach(function (item) {
      var input = $(item[0]), key = item[1], output = $(item[2]);
      input.value = Math.round(settings[key] * 100);
      text(output, input.value + '%');
      input.addEventListener('input', function () {
        settings[key] = Number(input.value) / 100;
        text(output, input.value + '%');
        if (key === 'volume') audio.setVolume(settings.volume);
        saveSettings();
      });
    });
  }

  function bindUI() {
    ui.startButton.addEventListener('click', startEngine);
    ui.carSelect.addEventListener('change', function () { selectCar(ui.carSelect.value); });
    document.querySelectorAll('[data-mode]').forEach(function (button) {
      button.addEventListener('click', function () { setMode(button.dataset.mode); });
    });
    $('autoButton').addEventListener('click', function () { setManual(false); });
    $('manualButton').addEventListener('click', function () { setManual(true); });
    $('downGear').addEventListener('click', function () { vehicle.shift(-1); });
    $('upGear').addEventListener('click', function () { vehicle.shift(1); });
    bindHoldButton($('gasPedal'), 'gas');
    bindHoldButton($('brakePedal'), 'brake');
    bindHoldButton($('revButton'), 'rev');
    $('soundTestButton').addEventListener('click', testAudio);
    $('kmhButton').addEventListener('click', function () { setUnits('kmh'); });
    $('mphButton').addEventListener('click', function () { setUnits('mph'); });
  }

  function setUnits(unit) {
    settings.units = unit;
    $('kmhButton').classList.toggle('active', unit === 'kmh');
    $('mphButton').classList.toggle('active', unit === 'mph');
    saveSettings();
    updateDisplay();
  }

  renderCarList();
  renderCar();
  bindSliders();
  bindUI();
  setMode(settings.mode);
  setManual(settings.manual);
  setUnits(settings.units);
  setNotice('Pronto. Premi Avvia motore per iniziare.');
  window.__RMD_APP_READY = true;
  if (window.__RMD_BOOT) window.__RMD_BOOT.ready = true;
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = 'APP: OK · ' + (window.__RMD_BOOT ? window.__RMD_BOOT.version : 'no-diagnostic') + ' · ' + cars.length + ' profili · ' + (window.EngineDSP ? 'DSP OK' : 'DSP NON TROVATO');
  requestAnimationFrame(tick);

  window.addEventListener('pagehide', function () {
    gps.stop();
    audio.stop();
  });
})();
