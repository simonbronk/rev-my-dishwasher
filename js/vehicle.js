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
    if (!this.manual || this.ratios.length < 2) return;
    var next = clamp(this.gear + delta, 1, this.ratios.length);
    if (next === this.gear) return;
    this.gear = next;
    this.shiftLock = 0.32;
    this.clutch = 1;
    this.clutchUntil = performance.now() + 180;
    this.clicks.push(delta > 0 ? 1 : 0.85);
  };

  Vehicle.prototype.setManual = function (enabled) {
    this.manual = !!enabled && this.ratios.length > 1;
  };

  Vehicle.prototype._autoShift = function (dt, rpm, intensity) {
    this.shiftLock = Math.max(0, this.shiftLock - dt);
    if (this.manual || this.ratios.length < 2 || this.shiftLock > 0) return;

    var e = this.engine;
    var idle = e.idleRpm || 700;
    var redline = e.redlineRpm || 7000;
    var limiter = e.limiterRpm || redline;

    // TeslaSound uses two shift points: a low-load / relaxed point and a
    // high-load / full-throttle point. Some profiles provide their own values
    // (e.g. Shift Maniac: 6300 -> 8000 rpm; F1 Slipstream: 7000 -> 11600 rpm).
    // For the other automatic profiles, use a conventional ~2500 rpm cruise
    // shift and keep the full-load shift close to the limiter.
    var cruiseUp = e.cruiseUpshiftRpm || Math.max(2500, idle * 2);
    var fullUp = e.upshiftRpm || (e.hardCap ? limiter - 500 : Math.min(redline - 200, limiter - 250));
    cruiseUp = clamp(cruiseUp, idle + 250, limiter - 100);
    fullUp = clamp(Math.max(cruiseUp, fullUp), cruiseUp, limiter - 50);

    // More pedal means a later shift. Intensity raises or lowers how much
    // throttle demand is translated into a late-shift request. Squaring the
    // demand keeps light pedal inputs close to the cruise point, while a
    // hard press moves the shift point progressively towards fullUp.
    var intensityValue = clamp(intensity == null ? 0.55 : intensity, 0, 1);
    var shiftDemand = clamp(this.throttle * (0.55 + intensityValue * 0.9), 0, 1);
    var shiftBlend = shiftDemand * shiftDemand;
    var up = cruiseUp + (fullUp - cruiseUp) * shiftBlend;

    // Downshift at low engine speed, with hysteresis: do not undo an upshift
    // merely because the next ratio caused a normal drop in rpm.
    var down = e.downshiftRpm || Math.max(idle * 1.35, Math.min(cruiseUp * 0.2, 1900));

    if (rpm >= up && this.gear < this.ratios.length) {
      this.gear++;
      this.shiftLock = 0.32;
    } else if (rpm < down && this.gear > 1) {
      this.gear--;
      this.shiftLock = 0.24;
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

    this._autoShift(dt, rpm, intensity);
    if (!this.manual && this.engine.type !== 'electric') rpm = Math.max(idle, this.gearRpm(this.speed));
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
    this.load = clamp(Math.pow(pedalLoad, 0.82), 0, 1);
    var lifting = this.throttle < 0.07;
    this.overrun = lifting && (this.rpm > idle + 350 || this.speed > 1) ? clamp(0.28 + Math.max(0, -this.accel) * 0.18 + (brake * 0.35), 0, 1) : 0;
    this.cut = this.rpm >= limiter - 35 ? 1 : 0;
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
