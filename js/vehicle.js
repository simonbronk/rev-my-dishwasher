/*
 * Vehicle bridge for Rev My Dishwasher.
 * This file does not synthesize sound: it converts GPS / pedal input into the
 * parameter messages expected by the unmodified TeslaSound EngineDSP.
 */
(function (global) {
  'use strict';

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function Vehicle(car) {
    this.car = car;
    this.cfg = car.vehicle || {};
    this.engine = car.engine || {};
    this.ratios = this.cfg.ratios && this.cfg.ratios.length ? this.cfg.ratios.slice() : [1];
    this.gear = 1;
    this.manual = false;
    this.speed = 0;
    this.accel = 0;
    this.rpm = this.engine.idleRpm || 0;
    this.throttle = 0;
    this.load = 0;
    this.overrun = 0;
    this.cut = 0;
    this.revPedal = 0;
    this.clutch = 0;
    this.clutchUntil = 0;
    this.shiftLock = 0;
    this.pendingShift = null;
    this.shiftCutTimer = 0;
    this.clicks = [];
    this.neutral = false;
    this.maxSpeed = (this.cfg.maxSpeedKmh || 280) / 3.6;
  }

  Vehicle.prototype.gearRpm = function (speed, gear) {
    var circumference = this.cfg.tireCircumferenceM || 2.15;
    var finalDrive = this.cfg.finalDrive || 1;
    var ratio = this.ratios[clamp((gear || this.gear) - 1, 0, this.ratios.length - 1)] || 1;
    return Math.max(0, speed) / circumference * 60 * ratio * finalDrive;
  };

  Vehicle.prototype.gearLabel = function () {
    if (this.engine.type === 'electric' || this.ratios.length === 1) return 'D';
    return String(this.gear);
  };

  Vehicle.prototype.shift = function (delta) {
    if (!this.manual || this.ratios.length < 2 || this.pendingShift) return;
    var next = clamp(this.gear + delta, 1, this.ratios.length);
    if (next === this.gear) return;
    this._beginShift(next, true);
  };

  // A downshift is prepared at the engine speed dictated by the lower ratio.
  // The DSP receives the same rpm/load/clutch/cut signals as TeslaSound.
  Vehicle.prototype._beginShift = function (nextGear, manual) {
    var fromGear = this.gear;
    if (nextGear === fromGear || nextGear < 1 || nextGear > this.ratios.length) return false;

    var downshift = nextGear < fromGear;
    var idle = this.engine.idleRpm || 700;
    var redline = this.engine.redlineRpm || 7000;
    var limiter = this.engine.limiterRpm || redline;
    var currentRpm = Math.max(idle, this.rpm || this.gearRpm(this.speed, fromGear));
    var targetRpm = this.gearRpm(this.speed, nextGear);
    var combustion = this.engine.type !== 'electric' && this.engine.type !== 'thruster';

    // Do not select a lower ratio that would put the engine beyond its limiter.
    if (downshift && combustion && targetRpm > limiter + 35) return false;

    if (downshift && combustion && this.speed > 0.8 && targetRpm > currentRpm + 80) {
      // Briefly bring the engine to the lower gear's wheel-synchronous rpm
      // before engaging it: this is the rev-match used for downshifts.
      this.pendingShift = {
        fromGear: fromGear,
        toGear: nextGear,
        startRpm: currentRpm,
        targetRpm: targetRpm,
        elapsed: 0,
        duration: 0.18,
        manual: !!manual
      };
      this.shiftLock = 0.42;
    } else {
      this.gear = nextGear;
      this.shiftLock = downshift ? 0.22 : 0.18;
      if (manual) this.clicks.push(downshift ? 0.85 : 1);
    }

    if (manual) {
      this.clutch = 1;
      this.clutchUntil = performance.now() + 180;
    } else if (!downshift && combustion && this.throttle >= 0.8) {
      // The original DSP's cut input is also used for a full-throttle upshift.
      this.shiftCutTimer = Math.max(this.shiftCutTimer, 0.08);
    }
    return true;
  };

  Vehicle.prototype.setManual = function (enabled) {
    this.manual = !!enabled && this.ratios.length > 1;
  };

  Vehicle.prototype._autoShift = function (dt, rpm, intensity) {
    this.shiftLock = Math.max(0, this.shiftLock - dt);
    if (this.manual || this.pendingShift || this.ratios.length < 2 || this.shiftLock > 0) return;

    var e = this.engine;
    var idle = e.idleRpm || 700;
    var redline = e.redlineRpm || 7000;
    var limiter = e.limiterRpm || redline;
    var intensityValue = clamp(intensity == null ? 0.55 : intensity, 0, 1);

    // Automatic gearbox: the pedal position selects the shift strategy.
    // A gentle pedal uses a low comfort threshold; pressing harder moves the
    // upshift point towards the profile's sport/full-throttle values.
    var demand = clamp(this.throttle * (0.8 + intensityValue * 0.4), 0, 1);
    var comfortUp = e.comfortUpshiftRpm ||
      Math.max(idle + 700, Math.min(2600, redline * 0.32));
    comfortUp = clamp(comfortUp, idle + 250, limiter - 100);

    // Preserve each vehicle profile's own sporting and full-throttle shift
    // points, but do not use its racing/cruise value for light pedal inputs.
    var cruiseUp = e.cruiseUpshiftRpm ||
      Math.max(comfortUp + 900, Math.min(redline * 0.56, limiter - 550));
    var fullUp = e.upshiftRpm ||
      (e.hardCap ? limiter - 500 : Math.min(redline - 200, limiter - 250));
    cruiseUp = clamp(Math.max(comfortUp + 300, cruiseUp), comfortUp + 300, limiter - 100);
    fullUp = clamp(Math.max(cruiseUp, fullUp), cruiseUp, limiter - 50);

    // Progress from comfort to cruise upshifts over the first 75% of pedal
    // demand, then blend to the profile's full-throttle shift point.
    var up;
    if (demand <= 0.75) {
      var relaxedBlend = Math.pow(clamp(demand / 0.75, 0, 1), 1.65);
      up = comfortUp + (cruiseUp - comfortUp) * relaxedBlend;
    } else {
      var sportBlend = Math.pow(clamp((demand - 0.75) / 0.25, 0, 1), 1.15);
      up = cruiseUp + (fullUp - cruiseUp) * sportBlend;
    }

    // Kickdown: when the driver presses deeply at low/mid rpm, select the
    // lower ratio that brings the engine closest to its useful upper band,
    // without exceeding the limiter. Skip gears when the ratios call for it.
    if (demand >= 0.68 && this.gear > 1) {
      var kickdownTrigger = idle + (fullUp - idle) * 0.55;
      if (rpm < kickdownTrigger) {
        var kickdownTarget = idle + (fullUp - idle) * (0.68 + 0.08 * demand);
        var kickdownMax = Math.min(limiter - 300, kickdownTarget + (fullUp - idle) * 0.08);
        var bestGear = 0;
        var bestDifference = Infinity;
        for (var candidate = 1; candidate < this.gear; candidate++) {
          var candidateRpm = this.gearRpm(this.speed, candidate);
          if (candidateRpm <= rpm * 1.2 || candidateRpm > kickdownMax) continue;
          var difference = Math.abs(candidateRpm - kickdownTarget);
          if (difference < bestDifference) {
            bestDifference = difference;
            bestGear = candidate;
          }
        }
        if (bestGear && this._beginShift(bestGear, false)) return;
      }
    }

    // Low-rpm downshift with hysteresis: after an upshift, allow the expected
    // rpm drop before selecting the previous ratio again.
    var down = e.downshiftRpm ||
      Math.max(idle * 1.12, Math.min(idle + 220, comfortUp * 0.38));

    if (rpm >= up && this.gear < this.ratios.length) {
      this._beginShift(this.gear + 1, false);
    } else if (rpm < down && this.gear > 1) {
      this._beginShift(this.gear - 1, false);
    }
  };

  Vehicle.prototype.update = function (dt, input, intensity) {
    var e = this.engine, v = this.cfg;
    var idle = e.idleRpm || 0;
    var redline = e.redlineRpm || 7000;
    var limiter = e.limiterRpm || redline;
    var rev = clamp(input.rev || 0, 0, 1);
    var gas = clamp(input.gas || 0, 0, 1);
    var brake = clamp(input.brake || 0, 0, 1);
    var intensityScale = 0.75 + clamp(intensity == null ? 0.55 : intensity, 0, 1) * 0.5;
    var oldSpeed = this.speed;

    if (input.source === 'gps') {
      this.speed = clamp(input.speed || 0, 0, 120);
      this.accel = clamp(input.accel || 0, -10, 8);
      var mass = v.massKg || 1700;
      var cdA = v.cdA || 0.65;
      var crr = v.crr || 0.011;
      var drag = 0.5 * 1.225 * cdA * this.speed * this.speed;
      var rolling = mass * 9.81 * crr;
      var force = Math.max(0, mass * this.accel + drag + rolling);
      var powerKw = force * this.speed / 1000;
      var peakPower = (v.peakPowerKw || 350) * (v.drivetrainEff || 0.9);
      var accelDemand = Math.max(0, this.accel) / Math.max(1, v.maxAccel || 7);
      var powerDemand = powerKw / Math.max(1, peakPower);
      this.throttle = clamp(Math.max(accelDemand, powerDemand) * intensityScale, 0, 1);
    } else {
      var maxAccel = Math.max(1.5, v.maxAccel || 6.5) * intensityScale;
      var brakeDecel = 10.5;
      var dragAccel = 0.5 * 1.225 * (v.cdA || 0.65) * this.speed * this.speed / Math.max(900, v.massKg || 1700);
      var rollingAccel = 9.81 * (v.crr || 0.011);
      this.accel = gas * maxAccel - brake * brakeDecel - dragAccel - rollingAccel;
      this.speed = clamp(this.speed + this.accel * dt, 0, this.maxSpeed);
      if (brake > 0 && this.speed < 0.25) this.speed = 0;
      this.throttle = gas;
    }

    this.shiftCutTimer = Math.max(0, this.shiftCutTimer - dt);

    var rpm = this.gearRpm(this.speed);
    if (this.engine.type === 'electric') {
      this.gear = 1;
      rpm = this.speed < 0.25 ? 0 : rpm;
    } else if (this.speed < 0.6 && rev > 0) {
      rpm = idle + rev * Math.max(0, redline - idle) * 0.78;
    } else if (this.speed < 1.5 && this.throttle > 0.08 && this.ratios.length > 1) {
      var launch = e.launchRpm || idle;
      rpm = Math.max(rpm, idle + (launch - idle) * this.throttle);
    } else if (this.speed > 0.4 && this.engine.type !== 'thruster') {
      rpm = Math.max(idle, rpm);
    }

    var gearBeforeAutoShift = this.gear;
    this._autoShift(dt, rpm, intensity);

    // A downshift uses a short rev-match ramp before the lower ratio engages.
    // The target rpm is fixed at shift start, as in a real rev-match event.
    var shiftBlipLoad = 0;
    if (this.pendingShift) {
      var shifting = this.pendingShift;
      shifting.elapsed = Math.min(shifting.duration, shifting.elapsed + dt);
      var progress = clamp(shifting.elapsed / shifting.duration, 0, 1);
      var eased = progress * progress * (3 - 2 * progress);
      var matchedRpm = shifting.targetRpm;
      var rpmRise = Math.max(0, matchedRpm - shifting.startRpm);
      rpm = shifting.startRpm + (matchedRpm - shifting.startRpm) * eased;

      // The throttle blip is proportional to the rpm correction, not a
      // separate sound effect. It briefly opens the original engine model.
      var correction = clamp(rpmRise / Math.max(1, redline - idle), 0, 1);
      shiftBlipLoad = Math.sin(Math.PI * progress) * clamp(0.18 + correction * 1.15, 0, 0.85);

      if (progress >= 1) {
        this.gear = shifting.toGear;
        this.pendingShift = null;
        rpm = this.gearRpm(this.speed);
        this.shiftLock = Math.max(this.shiftLock, 0.14);
        if (shifting.manual) this.clicks.push(0.85);
      }
    } else {
      // An upshift engages the next ratio promptly, so the normal wheel-speed
      // calculation immediately produces the correct rpm drop.
      if (this.gear !== gearBeforeAutoShift) rpm = this.gearRpm(this.speed);
      else if (!this.manual && this.engine.type !== 'electric') rpm = Math.max(idle, this.gearRpm(this.speed));
    }

    if (this.engine.type === 'electric') rpm = this.speed / Math.max(0.1, v.tireCircumferenceM || 2.2) * 60 * (v.ratios && v.ratios[0] || 1) * (v.finalDrive || 1);
    if (this.speed < 0.4 && rev > 0 && this.engine.type !== 'electric') {
      rpm = idle + rev * Math.max(0, redline - idle) * 0.78;
    } else if (this.speed < 0.6 && this.throttle > 0.08 && this.engine.type !== 'electric' && this.engine.type !== 'thruster') {
      // With the virtual clutch disengaged at standstill, gas must raise RPM
      // even before the simulated vehicle starts rolling.
      var freeRevLimit = e.launchRpm || (idle + (redline - idle) * 0.35);
      rpm = Math.max(rpm, idle + (freeRevLimit - idle) * this.throttle);
    }
    if (this.engine.type === 'thruster') rpm = idle;
    this.rpm = clamp(rpm, idle, limiter + 120);

    var pedalLoad = this.throttle;
    if (this.speed < 0.5 && rev > 0 && this.engine.type !== 'thruster') pedalLoad = Math.max(pedalLoad, 0.12 + rev * 0.88);
    if (this.engine.type === 'thruster') pedalLoad = this.throttle;
    this.load = clamp(Math.max(Math.pow(pedalLoad, 0.82), shiftBlipLoad), 0, 1);
    var lifting = this.throttle < 0.07;
    this.overrun = !shiftBlipLoad && lifting && (this.rpm > idle + 350 || this.speed > 1) ? clamp(0.28 + Math.max(0, -this.accel) * 0.18 + (brake * 0.35), 0, 1) : 0;
    this.cut = this.rpm >= limiter - 35 || this.shiftCutTimer > 0 ? 1 : 0;
    this.revPedal = rev;
    this.neutral = this.speed < 0.5;
    if (this.clutch && performance.now() > this.clutchUntil) this.clutch = 0;

    // If the GPS reports a sharp deceleration, retain the true speed but avoid
    // deriving a negative engine load from it.
    if (input.source === 'gps' && this.speed > 0 && oldSpeed > this.speed + 0.2) this.overrun = Math.max(this.overrun, 0.25);
    return this;
  };

  global.Vehicle = Vehicle;
})(window);
