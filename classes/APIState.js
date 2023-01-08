var constants = require("../constants");
var MeterState = require("./MeterState");

// Current state of the bluetooth
class APIState {
	constructor() {
		this.state = constants.State.NOT_CONNECTED;
		this.prev_state = constants.State.NOT_CONNECTED;
		this.state_cpt = 0;

		this.started = false; // State machine status
		this.stopRequest = false; // To request disconnect
		this.lastMeasure = {}; // Array with "MeasureName" : value
		this.lastSetpoint = {}; // Array with "SetpointType" : value

		// state of connected meter
		this.meter = new MeterState();

		// last modbus RTU command
		this.command = null;

		// last modbus RTU answer
		this.response = null;

		// bluetooth properties
		this.charRead = null;
		this.charWrite = null;
		this.btService = null;
		this.btDevice = null;

		// general statistics for debugging
		this.stats = {
			"requests": 0,
			"responses": 0,
			"modbus_errors": 0,
			"GATT disconnects": 0,
			"exceptions": 0,
			"subcribes": 0,
			"commands": 0,
			"responseTime": 0.0,
			"lastResponseTime": 0.0,
			"last_connect": new Date(2020, 1, 1).toISOString()
		};

		this.options = {
			"forceDeviceSelection": true
		};
	}
}

let btState = new APIState();

module.exports = { APIState, btState };