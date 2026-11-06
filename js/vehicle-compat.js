/*
 * vehicle-compat.js — small adapter for Rev My Dishwasher's manual controls.
 *
 * vehicle.js itself is the original TeslaSound drivetrain. This file only
 * exposes the extra manual buttons used by our page; the original automatic
 * shifting and engine model remain untouched.
 */
(function (global) {
  'use strict';

  var Vehicle = global.Vehicle;
  if (typeof Vehicle !== 'function') throw new Error('vehicle.js must load before vehicle-compat.js');

  Vehicle.prototype.setManual = function (enabled) {
    this.manualMode = !!enabled && this.p.ratios.length > 1;
  };

  var originalAutoShift = Vehicle.prototype._autoShift;
  Vehicle.prototype._autoShift = function (braking) {
    if (this.manualMode) return;
    return originalAutoShift.call(this, braking);
  };

  var originalStartShift = Vehicle.prototype._startShift;
  Vehicle.prototype._startShift = function (to) {
    if (this.manualMode && this.p.gearbox !== 'manual') {
      this._startHandShift(to, to > this.gear);
      return;
    }
    return originalStartShift.call(this, to);
  };

  Vehicle.prototype.shiftGear = function (delta) {
    if (!this.manualMode || !this.running || this.neutral || this.shift) return false;
    if (delta !== -1 && delta !== 1) return false;

    var next = Math.max(1, Math.min(this.p.ratios.length, this.gear + delta));
    if (next === this.gear) return false;

    // Block a user-requested downshift if wheel speed would over-rev the engine.
    var limiter = this.e.limiterRpm || this.e.redlineRpm || Infinity;
    if (next < this.gear && this.gearRpm(next) > limiter - 50) return false;

    this._startShift(next);
    return true;
  };
})(window);
