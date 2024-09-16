(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.MSC = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";

/**
 *  Bluetooth handling module, including main state machine loop.
 *  This module interacts with browser for bluetooth comunications and pairing, and with SenecaMSC object.
 */

var APIState = require("./classes/APIState");
var log = require("loglevel");
var constants = require("./constants");
var utils = require("./utils");
var senecaModule = require("./classes/SenecaMSC");
var modbus = require("./modbusRtu");
var testData = require("./modbusTestData");

var btState = APIState.btState;
var State = constants.State;
var CommandType = constants.CommandType;
var ResultCode = constants.ResultCode;
var simulation = false;
var logging = false;
/*
 * Bluetooth constants
 */
const BlueToothMSC = {
	ServiceUuid: "0003cdd0-0000-1000-8000-00805f9b0131", // bluetooth modbus RTU service for Seneca MSC
	ModbusAnswerUuid: "0003cdd1-0000-1000-8000-00805f9b0131",     // modbus RTU answers
	ModbusRequestUuid: "0003cdd2-0000-1000-8000-00805f9b0131"    // modbus RTU requests
};


/**
 * Send the message using Bluetooth and wait for an answer
 * @param {ArrayBuffer} command modbus RTU packet to send
 * @returns {ArrayBuffer} the modbus RTU answer
 */
async function SendAndResponse(command) {

	if (command == null)
		return null;

	log.debug(">> " + utils.buf2hex(command));

	btState.response = null;
	btState.stats["requests"]++;

	var startTime = new Date().getTime();
	if (simulation) {
		btState.response = fakeResponse(command);
		await utils.sleep(5);
	}
	else {
		await btState.charWrite.writeValueWithoutResponse(command);
		while (btState.state == State.METER_INITIALIZING ||
            btState.state == State.BUSY) {
			if (btState.response != null) break;
			await new Promise(resolve => setTimeout(resolve, 35));
		}
	}

	var endTime = new Date().getTime();

	var answer = btState.response?.slice();
	btState.response = null;

	// Log the packets
	if (logging) {
		var packet = { "request": utils.buf2hex(command), "answer": utils.buf2hex(answer) };
		var packets = window.localStorage.getItem("ModbusRTUtrace");
		if (packets == null) {
			packets = []; // initialize array
		}
		else {
			packets = JSON.parse(packets); // Restore the json persisted object
		}
		packets.push(packet); // Add the new object
		window.localStorage.setItem("ModbusRTUtrace", JSON.stringify(packets));
	}

	btState.stats["responseTime"] = Math.round((1.0 * btState.stats["responseTime"] * (btState.stats["responses"] % 500) + (endTime - startTime)) / ((btState.stats["responses"] % 500) + 1));
	btState.stats["lastResponseTime"] = Math.round(endTime - startTime) + " ms";
	btState.stats["responses"]++;

	return answer;
}

let senecaMSC = new senecaModule.SenecaMSC(SendAndResponse);

/**
 * Main loop of the meter handler.
 * */
async function stateMachine() {
	var nextAction;
	var DELAY_MS = (simulation ? 20 : 750); // Update the status every X ms.
	var TIMEOUT_MS = (simulation ? 1000 : 30000); // Give up some operations after X ms.
	btState.started = true;

	log.debug("Current state:" + btState.state);

	// Consecutive state counted. Can be used to timeout.
	if (btState.state == btState.prev_state) {
		btState.state_cpt++;
	} else {
		btState.state_cpt = 0;
	}

	// Stop request from API
	if (btState.stopRequest) {
		btState.state = State.STOPPING;
	}

	log.debug("State:" + btState.state);
	switch (btState.state) {
	case State.NOT_CONNECTED: // initial state on Start()
		if (simulation) {
			nextAction = fakePairDevice;
		} else {
			nextAction = btPairDevice;
		}
		break;
	case State.CONNECTING: // waiting for connection to complete
		nextAction = undefined;
		break;
	case State.DEVICE_PAIRED: // connection complete, acquire meter state
		if (simulation) {
			nextAction = fakeSubscribe;
		} else {
			nextAction = btSubscribe;
		}
		break;
	case State.SUBSCRIBING: // waiting for Bluetooth interfaces
		nextAction = undefined;
		if (btState.state_cpt > (TIMEOUT_MS / DELAY_MS)) {
			// Timeout, try to resubscribe
			log.warn("Timeout in SUBSCRIBING");
			btState.state = State.DEVICE_PAIRED;
			btState.state_cpt = 0;
		}
		break;
	case State.METER_INIT: // ready to communicate, acquire meter status
		nextAction = meterInit;
		break;
	case State.METER_INITIALIZING: // reading the meter status
		if (btState.state_cpt > (TIMEOUT_MS / DELAY_MS)) {
			log.warn("Timeout in METER_INITIALIZING");
			// Timeout, try to resubscribe
			if (simulation) {
				nextAction = fakeSubscribe;
			} else {
				nextAction = btSubscribe;
			}
			btState.state_cpt = 0;
		}
		nextAction = undefined;
		break;
	case State.IDLE: // ready to process commands from API
		if (btState.command != null)
			nextAction = processCommand;
		else {
			nextAction = refresh;
		}
		break;
	case State.ERROR: // anytime an error happens
		nextAction = disconnect;
		break;
	case State.BUSY: // while a command in going on
		if (btState.state_cpt > (TIMEOUT_MS / DELAY_MS)) {
			log.warn("Timeout in BUSY");
			// Timeout, try to resubscribe
			if (simulation) {
				nextAction = fakeSubscribe;
			} else {
				nextAction = btSubscribe;
			}
			btState.state_cpt = 0;
		}
		nextAction = undefined;
		break;
	case State.STOPPING:
		nextAction = disconnect;
		break;
	case State.STOPPED: // after a disconnector or Stop() request, stops the state machine.
		nextAction = undefined;
		break;
	default:
		break;
	}

	btState.prev_state = btState.state;

	if (nextAction != undefined) {
		log.debug("\tExecuting:" + nextAction.name);
		try {
			await nextAction();
		}
		catch (e) {
			log.error("Exception in state machine", e);
		}
	}
	if (btState.state != State.STOPPED) {
		utils.sleep(DELAY_MS).then(() => stateMachine()); // Recheck status in DELAY_MS ms
	}
	else {
		log.debug("\tTerminating State machine");
		btState.started = false;
	}
}

/**
 * Called from state machine to execute a single command from btState.command property
 * */
async function processCommand() {
	try {
		var command = btState.command;
		var result = ResultCode.SUCCESS;

		if (command == null) {
			return;
		}
		btState.state = State.BUSY;
		btState.stats["commands"]++;

		log.info("\t\tExecuting command :" + command);

		// First set NONE because we don't want to write new setpoints with active generation
		result = await senecaMSC.switchOff();
		if (result != ResultCode.SUCCESS) {
			throw new Error("Cannot switch meter off before command write!");
		}

		// Now write the setpoint or setting
		if (utils.isGeneration(command.type) || utils.isSetting(command.type) && command.type != CommandType.OFF) {
			result = await senecaMSC.writeSetpoints(command.type, command.setpoint, command.setpoint2);
			if (result != ResultCode.SUCCESS) {
				throw new Error("Failure to write setpoints!");
			}
		}

		if (!utils.isSetting(command.type) &&
            utils.isValid(command.type) && command.type != CommandType.OFF)  // IF this is a setting, we're done.
		{
			// Now write the mode set
			result = await senecaMSC.changeMode(command.type);
			if (result != ResultCode.SUCCESS) {
				throw new Error("Failure to change meter mode!");
			}
		}

		// Caller expects a valid property in GetState() once command is executed.
		log.debug("\t\tRefreshing current state");
		await refresh();

		command.error = false;
		command.pending = false;
		btState.command = null;

		btState.state = State.IDLE;
		log.debug("\t\tCompleted command executed");
	}
	catch (err) {
		log.error("** error while executing command: " + err);
		btState.state = State.METER_INIT;
		btState.stats["exceptions"]++;
		if (err instanceof modbus.ModbusError)
			btState.stats["modbus_errors"]++;
		return;
	}
}

function getExpectedStateHex() {
	// Simulate current mode answer according to last command.
	var stateHex = (CommandType.OFF).toString(16);
	if (btState.command?.type != null) {
		stateHex = (btState.command.type).toString(16);
	}
	// Add trailing 0
	while (stateHex.length < 2)
		stateHex = "0" + stateHex;
	return stateHex;
}
/**
 * Used to simulate RTU answers
 * @param {ArrayBuffer} command real request
 * @returns {ArrayBuffer} fake answer
 */
function fakeResponse(command) {
	var commandHex = utils.buf2hex(command);
	var forgedAnswers = {
		"19 03 00 64 00 01 c6 0d": "19 03 02 00" + getExpectedStateHex() + " $$$$", // Current state
		"default 03": "19 03 06 0001 0001 0001 $$$$", // default answer for FC3
		"default 10": "19 10 00 d4 00 02 0001 0001 $$$$"
	}; // default answer for FC10

	// Start with the default answer
	var responseHex = forgedAnswers["default " + commandHex.split(" ")[1]];

	// Do we have a forged answer?
	if (forgedAnswers[commandHex] != undefined) {
		responseHex = forgedAnswers[commandHex];
	}
	else {
		// Look into registered traces
		var found = [];
		for (const trace of testData.testTraces) {
			if (trace["request"] === commandHex) {
				found.push(trace["answer"]);
			}
		}
		if (found.length > 0) {
			// Select a random answer from the registered trace
			responseHex = found[Math.floor((Math.random() * found.length))];
		}
		else {
			console.info(commandHex + " not found in test traces");
		}
	}

	// Compute CRC if needed
	if (responseHex.includes("$$$$")) {
		responseHex = responseHex.replace("$$$$", "");
		var crc = modbus.crc16(new Uint8Array(utils.hex2buf(responseHex))).toString(16);
		while (crc.length < 4)
			crc = "0" + crc;
		responseHex = responseHex + crc.substring(2, 4) + crc.substring(0, 2);
	}

	log.debug("<< " + responseHex);
	return utils.hex2buf(responseHex);
}

/**
 * Acquire the current mode and serial number of the device.
 * */
async function meterInit() {
	try {
		btState.state = State.METER_INITIALIZING;
		btState.meter.serial = await senecaMSC.getSerialNumber();
		log.info("\t\tSerial number:" + btState.meter.serial);

		btState.meter.mode = await senecaMSC.getCurrentMode();
		log.debug("\t\tCurrent mode:" + btState.meter.mode);

		btState.meter.battery = await senecaMSC.getBatteryVoltage();
		log.debug("\t\tBattery (V):" + btState.meter.battery);

		btState.state = State.IDLE;
	}
	catch (err) {
		log.warn("Error while initializing meter :" + err);
		btState.stats["exceptions"]++;
		btState.state = State.DEVICE_PAIRED;
		if (err instanceof modbus.ModbusError)
			btState.stats["modbus_errors"]++;
	}
}

/*
 * Close the bluetooth interface (unpair)
 * */
async function disconnect() {
	btState.command = null;
	try {
		if (btState.btDevice != null) {
			if (btState.btDevice?.gatt?.connected) {
				log.warn("* Calling disconnect on btdevice");
				// Avoid the event firing which may lead to auto-reconnect
				btState.btDevice.removeEventListener("gattserverdisconnected", onDisconnected);
				btState.btDevice.gatt.disconnect();
			}
		}
		btState.btService = null;
	}
	catch { }
	btState.state = State.STOPPED;
}

/**
 * Event called by browser BT api when the device disconnect
 * */
async function onDisconnected() {
	log.warn("* GATT Server disconnected event, will try to reconnect *");
	btState.btService = null;
	btState.stats["GATT disconnects"]++;
	btState.state = State.DEVICE_PAIRED; // Try to auto-reconnect the interfaces without pairing
}

/**
 * Joins the arguments into a single buffer
 * @returns {Buffer} concatenated buffer
 */
function arrayBufferConcat() {
	var length = 0;
	var buffer = null;

	for (var i in arguments) {
		buffer = arguments[i];
		length += buffer.byteLength;
	}

	var joined = new Uint8Array(length);
	var offset = 0;

	for (i in arguments) {
		buffer = arguments[i];
		joined.set(new Uint8Array(buffer), offset);
		offset += buffer.byteLength;
	}

	return joined.buffer;
}

/**
 * Event called by bluetooth characteristics when receiving data
 * @param {any} event
 */
function handleNotifications(event) {
	let value = event.target.value;
	if (value != null) {
		log.debug("<< " + utils.buf2hex(value.buffer));
		if (btState.response != null) {
			btState.response = arrayBufferConcat(btState.response, value.buffer);
		} else {
			btState.response = value.buffer.slice();
		}
	}
}

/**
 * This function will succeed only if called as a consequence of a user-gesture
 * E.g. button click. This is due to BlueTooth API security model.
 * */
async function btPairDevice() {
	btState.state = State.CONNECTING;
	var forceSelection = btState.options["forceDeviceSelection"];
	log.debug("btPairDevice(" + forceSelection + ")");
	try {
		if (typeof (navigator.bluetooth?.getAvailability) == "function") {
			const availability = await navigator.bluetooth.getAvailability();
			if (!availability) {
				log.error("Bluetooth not available in browser.");
				throw new Error("Browser does not provide bluetooth");
			}
		}
		var device = null;

		// Do we already have permission?
		if (typeof (navigator.bluetooth?.getDevices) == "function"
            && !forceSelection) {
			const availableDevices = await navigator.bluetooth.getDevices();
			availableDevices.forEach(function (dev, index) {
				log.debug("Found authorized device :" + dev.name);
				if (dev.name.startsWith("MSC"))
					device = dev;
			});
			log.debug("navigator.bluetooth.getDevices()=" + device);
		}
		// If not, request from user
		if (device == null) {
			device = await navigator.bluetooth
				.requestDevice({
					acceptAllDevices: false,
					filters: [{ namePrefix: "MSC" }],
					optionalServices: [BlueToothMSC.ServiceUuid]
				});
		}
		btState.btDevice = device;
		btState.state = State.DEVICE_PAIRED;
		log.info("Bluetooth device " + device.name + " connected.");
		await utils.sleep(500);
	}
	catch (err) {
		log.warn("** error while connecting: " + err.message);
		btState.btService = null;
		if (btState.charRead != null) {
			try {
				btState.charRead.stopNotifications();
			} catch (error) { }
		}
		btState.charRead = null;
		btState.charWrite = null;
		btState.state = State.ERROR;
		btState.stats["exceptions"]++;
	}
}

async function fakePairDevice() {
	btState.state = State.CONNECTING;
	var forceSelection = btState.options["forceDeviceSelection"];
	log.debug("fakePairDevice(" + forceSelection + ")");
	try {
		var device = { name: "FakeBTDevice", gatt: { connected: true } };
		btState.btDevice = device;
		btState.state = State.DEVICE_PAIRED;
		log.info("Bluetooth device " + device.name + " connected.");
		await utils.sleep(50);
	}
	catch (err) {
		log.warn("** error while connecting: " + err.message);
		btState.btService = null;
		btState.charRead = null;
		btState.charWrite = null;
		btState.state = State.ERROR;
		btState.stats["exceptions"]++;
	}
}

/**
 * Once the device is available, initialize the service and the 2 characteristics needed.
 * */
async function btSubscribe() {
	try {
		btState.state = State.SUBSCRIBING;
		btState.stats["subcribes"]++;
		let device = btState.btDevice;
		let server = null;

		if (!device?.gatt?.connected) {
			log.debug(`Connecting to GATT Server on ${device.name}...`);
			device.addEventListener("gattserverdisconnected", onDisconnected);
			try {
				if (btState.btService?.connected) {
					btState.btService.disconnect();
					btState.btService = null;
					await utils.sleep(100);
				}
			} catch (err) { }

			server = await device.gatt.connect();
			log.debug("> Found GATT server");
		}
		else {
			log.debug("GATT already connected");
			server = device.gatt;
		}

		btState.btService = await server.getPrimaryService(BlueToothMSC.ServiceUuid);
		if (btState.btService == null)
			throw new Error("GATT Service request failed");
		log.debug("> Found Serial service");
		btState.charWrite = await btState.btService.getCharacteristic(BlueToothMSC.ModbusRequestUuid);
		log.debug("> Found write characteristic");
		btState.charRead = await btState.btService.getCharacteristic(BlueToothMSC.ModbusAnswerUuid);
		log.debug("> Found read characteristic");
		btState.response = null;
		btState.charRead.addEventListener("characteristicvaluechanged", handleNotifications);
		btState.charRead.startNotifications();
		log.info("> Bluetooth interfaces ready.");
		btState.stats["last_connect"] = new Date().toISOString();
		await utils.sleep(50);
		btState.state = State.METER_INIT;
	}
	catch (err) {
		log.warn("** error while subscribing: " + err.message);
		if (btState.charRead != null) {
			try {
				if (btState.btDevice?.gatt?.connected) {
					btState.charRead.stopNotifications();
				}
				btState.btDevice?.gatt.disconnect();
			} catch (error) { }
		}
		btState.charRead = null;
		btState.charWrite = null;
		btState.state = State.DEVICE_PAIRED;
		btState.stats["exceptions"]++;
	}
}

async function fakeSubscribe() {
	try {
		btState.state = State.SUBSCRIBING;
		btState.stats["subcribes"]++;
		let device = btState.btDevice;
		let server = null;

		if (!device?.gatt?.connected) {
			log.debug(`Connecting to GATT Server on ${device.name}...`);
			device["gatt"]["connected"] = true;
			log.debug("> Found GATT server");
		}
		else {
			log.debug("GATT already connected");
			server = device.gatt;
		}

		btState.btService = {};
		log.debug("> Found Serial service");
		btState.charWrite = {};
		log.debug("> Found write characteristic");
		btState.charRead = {};
		log.debug("> Found read characteristic");
		btState.response = null;
		log.info("> Bluetooth interfaces ready.");
		btState.stats["last_connect"] = new Date().toISOString();
		await utils.sleep(10);
		btState.state = State.METER_INIT;
	}
	catch (err) {
		log.warn("** error while subscribing: " + err.message);
		btState.charRead = null;
		btState.charWrite = null;
		btState.state = State.DEVICE_PAIRED;
		btState.stats["exceptions"]++;
	}
}


/**
 * When idle, this function is called
 * */
async function refresh() {
	btState.state = State.BUSY;
	try {
		// Check the mode first
		var mode = await senecaMSC.getCurrentMode();

		if (mode != CommandType.NONE_UNKNOWN) {
			btState.meter.mode = mode;

			if (btState.meter.isGeneration()) {
				var setpoints = await senecaMSC.getSetpoints(btState.meter.mode);
				btState.lastSetpoint = setpoints;
			}

			if (btState.meter.isMeasurement()) {
				var meas = await senecaMSC.getMeasures(btState.meter.mode);
				btState.lastMeasure = meas;
			}
		}
		log.debug("\t\tFinished refreshing current state");
		btState.state = State.IDLE;
	}
	catch (err) {
		log.warn("Error while refreshing measure" + err);
		btState.state = State.DEVICE_PAIRED;
		btState.stats["exceptions"]++;
		if (err instanceof modbus.ModbusError)
			btState.stats["modbus_errors"]++;
	}
}

function SetSimulation(value) {
	simulation = value;
}

module.exports = { stateMachine, SendAndResponse, SetSimulation };
},{"./classes/APIState":2,"./classes/SenecaMSC":6,"./constants":7,"./modbusRtu":10,"./modbusTestData":11,"./utils":14,"loglevel":12}],2:[function(require,module,exports){
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
},{"../constants":7,"./MeterState":5}],3:[function(require,module,exports){
var constants = require("../constants");
var utils = require("../utils");
var CommandType = constants.CommandType;

/**
 * Command to the meter, may include setpoint
 * */
class Command {
	/**
     * Creates a new command
     * @param {CommandType} ctype
     */
	constructor(ctype = CommandType.NONE_UNKNOWN) {
		this.type = parseInt(ctype);
		this.setpoint = null;
		this.setpoint2 = null;
		this.error = false;
		this.pending = true;
		this.request = null;
		this.response = null;
	}

	static CreateNoSP(ctype) {
		var cmd = new Command(ctype);
		return cmd;
	}
	static CreateOneSP(ctype, setpoint) {
		var cmd = new Command(ctype);
		cmd.setpoint = parseFloat(setpoint);
		return cmd;
	}
	static CreateTwoSP(ctype, set1, set2) {
		var cmd = new Command(ctype);
		cmd.setpoint = parseFloat(set1);
		cmd.setpoint2 = parseFloat(set2);
		return cmd;
	}

	toString() {
		return "Type: " + utils.Parse(CommandType, this.type) + ", setpoint:" + this.setpoint + ", setpoint2: " + this.setpoint2 + ", pending:" + this.pending + ", error:" + this.error;
	}

	/**
     * Gets the default setpoint for this command type
     * @returns {Array} setpoint(s) expected
     */
	defaultSetpoint() {
		switch (this.type) {
		case CommandType.GEN_THERMO_B:
		case CommandType.GEN_THERMO_E:
		case CommandType.GEN_THERMO_J:
		case CommandType.GEN_THERMO_K:
		case CommandType.GEN_THERMO_L:
		case CommandType.GEN_THERMO_N:
		case CommandType.GEN_THERMO_R:
		case CommandType.GEN_THERMO_S:
		case CommandType.GEN_THERMO_T:
		case CommandType.GEN_Cu50_3W:
		case CommandType.GEN_Cu50_2W:
		case CommandType.GEN_Cu100_2W:
		case CommandType.GEN_Ni100_2W:
		case CommandType.GEN_Ni120_2W:
		case CommandType.GEN_PT100_2W:
		case CommandType.GEN_PT500_2W:
		case CommandType.GEN_PT1000_2W:
			return { "Temperature (°C)": 0.0 };
		case CommandType.GEN_V:
			return { "Voltage (V)": 0.0 };
		case CommandType.GEN_mV:
			return { "Voltage (mV)": 0.0 };
		case CommandType.GEN_mA_active:
		case CommandType.GEN_mA_passive:
			return { "Current (mA)": 0.0 };
		case CommandType.GEN_LoadCell:
			return { "Imbalance (mV/V)": 0.0 };
		case CommandType.GEN_Frequency:
			return { "Frequency (Hz)": 0.0 };
		case CommandType.GEN_PulseTrain:
			return { "Pulses count": 0, "Frequency (Hz)": 0.0 };
		case CommandType.SET_UThreshold_F:
			return { "Uthreshold (V)": 2.0 };
		case CommandType.SET_Sensitivity_uS:
			return { "Sensibility (uS)": 2.0 };
		case CommandType.SET_ColdJunction:
			return { "Cold junction compensation": 0.0 };
		case CommandType.SET_Ulow:
			return { "U low (V)": 0.0 / constants.MAX_U_GEN };
		case CommandType.SET_Uhigh:
			return { "U high (V)": 5.0 / constants.MAX_U_GEN };
		case CommandType.SET_ShutdownDelay:
			return { "Delay (s)": 60 * 5 };
		default:
			return {};
		}
	}
	isGeneration() {
		return utils.isGeneration(this.type);
	}
	isMeasurement() {
		return utils.isMeasurement(this.type);
	}
	isSetting() {
		return utils.isSetting(this.type);
	}
	isValid() {
		return (utils.isMeasurement(this.type) || utils.isGeneration(this.type) || utils.isSetting(this.type));
	}
}

module.exports = Command;
},{"../constants":7,"../utils":14}],4:[function(require,module,exports){
class CommandResult {
	value = 0.0;
	success = false;
	message = "";
	unit = "";
	secondary_value = 0.0;
	secondary_unit = "";
}

module.exports = CommandResult;
},{}],5:[function(require,module,exports){
var constants = require("../constants");

/**
 * Current state of the meter
 * */
class MeterState {
	constructor() {
		this.firmware = ""; // Firmware version
		this.serial = ""; // Serial number
		this.mode = constants.CommandType.NONE_UNKNOWN;
		this.battery = 0.0;
	}

	isMeasurement() {
		return this.mode > constants.CommandType.NONE_UNKNOWN && this.mode < constants.CommandType.OFF;
	}

	isGeneration() {
		return this.mode > constants.CommandType.OFF && this.mode < constants.CommandType.GEN_RESERVED;
	}
}

module.exports = MeterState;
},{"../constants":7}],6:[function(require,module,exports){
"use strict";

/**
 *  This module contains the SenecaMSC object, which provides the main operations for bluetooth module.
 *  It uses the modbus helper functions from senecaModbus / modbusRtu to interact with the meter with SendAndResponse function
 */
var log = require("loglevel");
var utils = require("../utils");
var senecaMB = require("../senecaModbus");
var modbus = require("../modbusRtu");
var constants = require("../constants");

var CommandType = constants.CommandType;
var ResultCode = constants.ResultCode;

const RESET_POWER_OFF = 6;
const SET_POWER_OFF = 7;
const CLEAR_AVG_MIN_MAX = 5;
const PULSE_CMD = 9;

class SenecaMSC {
	constructor(fnSendAndResponse) {
		this.SendAndResponse = fnSendAndResponse;
	}
	/**
     * Gets the meter serial number (12345_1234)
     * May throw ModbusError
     * @returns {string}
     */
	async getSerialNumber() {
		log.debug("\t\tReading serial number");
		var response = await this.SendAndResponse(senecaMB.makeSerialNumber());
		return senecaMB.parseSerialNumber(response);
	}

	/**
     * Gets the current mode set on the MSC device
     * May throw ModbusError
     * @returns {CommandType} active mode
     */
	async getCurrentMode() {
		log.debug("\t\tReading current mode");
		var response = await this.SendAndResponse(senecaMB.makeCurrentMode());
		return senecaMB.parseCurrentMode(response, CommandType.NONE_UNKNOWN);
	}

	/**
     * Gets the battery voltage from the meter for battery level indication
     * May throw ModbusError
     * @returns {number} voltage (V)
     */
	async getBatteryVoltage() {
		log.debug("\t\tReading battery voltage");
		var response = await this.SendAndResponse(senecaMB.makeBatteryLevel());
		return Math.round(senecaMB.parseBattery(response) * 100) / 100;
	}

	/**
     * Check measurement error flags from meter
     * May throw ModbusError
     * @returns {boolean}
     */
	async getQualityValid() {
		log.debug("\t\tReading measure quality bit");
		var response = await this.SendAndResponse(senecaMB.makeQualityBitRequest());
		return senecaMB.isQualityValid(response);
	}

	/**
     * Check generation error flags from meter
     * May throw ModbusError
     * @returns {boolean}
     */
	async getGenQualityValid(current_mode) {
		log.debug("\t\tReading generation quality bit");
		var response = await this.SendAndResponse(senecaMB.makeGenStatusRead());
		return senecaMB.parseGenStatus(response, current_mode);
	}

	/**
     * Reads the measurements from the meter, including error flags
     * May throw ModbusError
     * @param {CommandType} mode current meter mode 
     * @returns {array|null} measurement array (units, values, error flag)
     */
	async getMeasures(mode) {
		log.debug("\t\tReading measures");
		var valid = await this.getQualityValid();
		var response = await this.SendAndResponse(senecaMB.makeMeasureRequest(mode));
		if (response != null) {
			var meas = senecaMB.parseMeasure(response, mode);
			meas["error"] = !valid;
			return meas;
		}
		return null;
	}

	/**
     * Reads the active setpoints from the meter, including error flags
     * May throw ModbusError
     * @param {CommandType} mode current meter mode 
     * @returns {array|null} setpoints array (units, values, error flag)
     */
	async getSetpoints(mode) {
		log.debug("\t\tReading setpoints");
		var valid = await this.getGenQualityValid(mode);
		var response = await this.SendAndResponse(senecaMB.makeSetpointRead(mode));
		if (response != null) {
			var results = senecaMB.parseSetpointRead(response, mode);
			results["error"] = !valid;
			return results;
		}
		return null;
	}

	/**
     * Puts the meter in OFF mode
     * May throw ModbusError
     * @returns {ResultCode} result of the operation
     */
	async switchOff() {
		log.debug("\t\tSetting meter to OFF");
		var packet = senecaMB.makeModeRequest(CommandType.OFF);
		if (packet == null)
			return ResultCode.FAILED_NO_RETRY;

		await this.SendAndResponse(packet);
		await utils.sleep(100);

		return ResultCode.SUCCESS;
	}

	/**
     * Write the setpoints to the meter
     * May throw ModbusError
     * @param {CommandType} command_type type of generation command
     * @param {number} setpoint setpoint of generation
     * @param {number} setpoint2 facultative, second setpoint
     * @returns {ResultCode} result of the operation
     */
	async writeSetpoints(command_type, setpoint, setpoint2) {
		var startGen;
		log.debug("\t\tSetting command:"+ command_type + ", setpoint: " + setpoint + ", setpoint 2: " + setpoint2);
		var packets = senecaMB.makeSetpointRequest(command_type, setpoint, setpoint2);

		for(const p of packets) {
			var response = await this.SendAndResponse(p);
			if (response != null && !modbus.parseFC16checked(response, 0)) {
				return ResultCode.FAILED_SHOULD_RETRY;
			}
		}
        
		// Special handling of the SET Delay command
		switch (command_type) {
		case CommandType.SET_ShutdownDelay:
			startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, senecaMB.MSCRegisters.CMD, [RESET_POWER_OFF]);
			response = await this.SendAndResponse(startGen);
			if (!modbus.parseFC16checked(response, 1)) {
				return ResultCode.FAILED_NO_RETRY;
			}
			break;
		default:
			break;
		}
		return ResultCode.SUCCESS;
	}

	/**
     * Clear Avg/Min/Max statistics
     * May throw ModbusError
     * @returns {ResultCode} result of the operation
     */
	async clearStatistics() {
		log.debug("\t\tResetting statistics");
		var startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, senecaMB.MSCRegisters.CMD, [CLEAR_AVG_MIN_MAX]);
		var response = await this.SendAndResponse(startGen);
		if (!modbus.parseFC16checked(response, 1)) {
			return ResultCode.FAILED_NO_RETRY;
		}
		return ResultCode.SUCCESS;
	}

	/**
     * Begins the pulse generation
     * May throw ModbusError
     * @returns {ResultCode} result of the operation
     */
	async startPulseGen() {
		log.debug("\t\tStarting pulse generation");
		var startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, senecaMB.MSCRegisters.GEN_CMD, [PULSE_CMD, 2]); // Start with low
		var response = await this.SendAndResponse(startGen);
		if (!modbus.parseFC16checked(response, 2)) {
			return ResultCode.FAILED_NO_RETRY;
		}
		return ResultCode.SUCCESS;
	}

	/**
     * Begins the frequency generation
     * May throw ModbusError
     * @returns {ResultCode} result of the operation
     */
	async startFreqGen() {
		log.debug("\t\tStarting freq gen");
		var startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, senecaMB.MSCRegisters.GEN_CMD, [PULSE_CMD, 1]); // start gen
		var response = await this.SendAndResponse(startGen);
		if (!modbus.parseFC16checked(response, 2)) {
			return ResultCode.FAILED_NO_RETRY;
		}
		return ResultCode.SUCCESS;
	}

	/**
     * Disable auto power off to the meter
     * May throw ModbusError
     * @returns {ResultCode} result of the operation
     */
	async disablePowerOff() {
		log.debug("\t\tDisabling power off");
		var startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, senecaMB.MSCRegisters.CMD, [RESET_POWER_OFF]);
		await this.SendAndResponse(startGen);
		return ResultCode.SUCCESS;
	}

	/**
     * Changes the current mode on the meter
     * May throw ModbusError
     * @param {CommandType} command_type the new mode to set the meter in
     * @returns {ResultCode} result of the operation
     */
	async changeMode(command_type) {
		log.debug("\t\tSetting meter mode to :" + command_type);
		var packet = senecaMB.makeModeRequest(command_type);
		if (packet == null) {
			log.error("Could not generate modbus packet for command type", command_type);
			return ResultCode.FAILED_NO_RETRY;
		}

		var response = await this.SendAndResponse(packet);

		if (!modbus.parseFC16checked(response, 0)) {
			log.error("Could not generate modbus packet for command type", command_type);
			return ResultCode.FAILED_NO_RETRY;
		}

		var result = ResultCode.SUCCESS;

		// Some commands require additional command to be given to work properly, after a slight delay
		switch (command_type) {
		case CommandType.V:
		case CommandType.mV:
		case CommandType.mA_active:
		case CommandType.mA_passive:
		case CommandType.PulseTrain:
			await utils.sleep(1000);
			result = await this.clearStatistics();
			break;
		case CommandType.GEN_PulseTrain:
			await utils.sleep(1000);
			result = await this.startPulseGen();
			break;
		case CommandType.GEN_Frequency:
			await utils.sleep(1000);
			result = await this.startFreqGen();
			break;
		}

		if (result == ResultCode.SUCCESS) {
			result = await this.disablePowerOff();
		}

		return result;
	}
}

module.exports = { SenecaMSC };
},{"../constants":7,"../modbusRtu":10,"../senecaModbus":13,"../utils":14,"loglevel":12}],7:[function(require,module,exports){
/**
 * Command type, aka mode value to be written into MSC current state register
 * */
const CommandType = {
	NONE_UNKNOWN: 0, /*** MEASURING FEATURES AFTER THIS POINT *******/
	mA_passive: 1,
	mA_active: 2,
	V: 3,
	mV: 4,
	THERMO_J: 5, // Termocoppie
	THERMO_K: 6,
	THERMO_T: 7,
	THERMO_E: 8,
	THERMO_L: 9,
	THERMO_N: 10,
	THERMO_R: 11,
	THERMO_S: 12,
	THERMO_B: 13,
	PT100_2W: 14, // RTD 2 fili
	PT100_3W: 15,
	PT100_4W: 16,
	PT500_2W: 17,
	PT500_3W: 18,
	PT500_4W: 19,
	PT1000_2W: 20,
	PT1000_3W: 21,
	PT1000_4W: 22,
	Cu50_2W: 23,
	Cu50_3W: 24,
	Cu50_4W: 25,
	Cu100_2W: 26,
	Cu100_3W: 27,
	Cu100_4W: 28,
	Ni100_2W: 29,
	Ni100_3W: 30,
	Ni100_4W: 31,
	Ni120_2W: 32,
	Ni120_3W: 33,
	Ni120_4W: 34,
	LoadCell: 35,   // Celle di carico
	Frequency: 36,  // Frequenza
	PulseTrain: 37, // Conteggio impulsi
	RESERVED: 38,
	RESERVED_2: 40,
	OFF: 100, // ********* GENERATION AFTER THIS POINT *****************/
	GEN_mA_passive: 101,
	GEN_mA_active: 102,
	GEN_V: 103,
	GEN_mV: 104,
	GEN_THERMO_J: 105,
	GEN_THERMO_K: 106,
	GEN_THERMO_T: 107,
	GEN_THERMO_E: 108,
	GEN_THERMO_L: 109,
	GEN_THERMO_N: 110,
	GEN_THERMO_R: 111,
	GEN_THERMO_S: 112,
	GEN_THERMO_B: 113,
	GEN_PT100_2W: 114,
	GEN_PT500_2W: 117,
	GEN_PT1000_2W: 120,
	GEN_Cu50_2W: 123,
	GEN_Cu100_2W: 126,
	GEN_Ni100_2W: 129,
	GEN_Ni120_2W: 132,
	GEN_LoadCell: 135,
	GEN_Frequency: 136,
	GEN_PulseTrain: 137,
	GEN_RESERVED: 138,
	// Special settings below this points
	SETTING_RESERVED: 1000,
	SET_UThreshold_F: 1001,
	SET_Sensitivity_uS: 1002,
	SET_ColdJunction: 1003,
	SET_Ulow: 1004,
	SET_Uhigh: 1005,
	SET_ShutdownDelay: 1006
};




/*
 * Internal state machine descriptions
 */
const State = {
	NOT_CONNECTED: "Not connected",
	CONNECTING: "Bluetooth device pairing...",
	DEVICE_PAIRED: "Device paired",
	SUBSCRIBING: "Bluetooth interfaces connecting...",
	IDLE: "Idle",
	BUSY: "Busy",
	ERROR: "Error",
	STOPPING: "Closing BT interfaces...",
	STOPPED: "Stopped",
	METER_INIT: "Meter connected",
	METER_INITIALIZING: "Reading meter state..."
};

const ResultCode = {
	FAILED_NO_RETRY: 1,
	FAILED_SHOULD_RETRY: 2,
	SUCCESS: 0
};


const MAX_U_GEN = 27.0; // maximum voltage 

module.exports = {State, CommandType, ResultCode, MAX_U_GEN };

},{}],8:[function(require,module,exports){
"use strict";

const log = require("loglevel");
const constants = require("./constants");
const APIState = require("./classes/APIState");
const Command = require("./classes/Command");
const PublicAPI = require("./meterPublicAPI");
const TestData = require("./modbusTestData");

log.setLevel(log.levels.ERROR, true);

exports.Stop = PublicAPI.Stop;
exports.Pair = PublicAPI.Pair;
exports.Execute = PublicAPI.Execute;
exports.SimpleExecute = PublicAPI.SimpleExecute;
exports.GetState = PublicAPI.GetState;
exports.State = constants.State;
exports.CommandType = constants.CommandType;
exports.Command = Command;
exports.Parse = PublicAPI.Parse;
exports.log = log;
exports.GetStateJSON = PublicAPI.GetStateJSON;
exports.ExecuteJSON = PublicAPI.ExecuteJSON;
exports.SimpleExecuteJSON = PublicAPI.SimpleExecuteJSON;
exports.GetJsonTraces = TestData.GetJsonTraces;


},{"./classes/APIState":2,"./classes/Command":3,"./constants":7,"./meterPublicAPI":9,"./modbusTestData":11,"loglevel":12}],9:[function(require,module,exports){
/*
 * This file contains the public API of the meter, i.e. the functions designed
 * to be called from third party code.
 * 1- Pair() : bool
 * 2- Execute(Command) : bool + JSON version
 * 3- Stop() : bool
 * 4- GetState() : array + JSON version
 * 5- SimpleExecute(Command) : returns the updated measurement or null
 */

var CommandResult = require("./classes/CommandResult");
var APIState = require("./classes/APIState");
var constants = require("./constants");
var bluetooth = require("./bluetooth");
var utils = require("./utils");
var log = require("loglevel");
var meterApi = require("./meterApi");

var btState = APIState.btState;
var State = constants.State;

/**
 * Returns a copy of the current state
 * @returns {array} status of meter
 */
async function GetState() {
	let ready = false;
	let initializing = false;
	switch (btState.state) {
	// States requiring user input
	case State.ERROR:
	case State.STOPPED:
	case State.NOT_CONNECTED:
		ready = false;
		initializing = false;
		break;
	case State.BUSY:
	case State.IDLE:
		ready = true;
		initializing = false;
		break;
	case State.CONNECTING:
	case State.DEVICE_PAIRED:
	case State.METER_INIT:
	case State.METER_INITIALIZING:
	case State.SUBSCRIBING:
		initializing = true;
		ready = false;
		break;
	default:
		ready = false;
		initializing = false;
	}
	return {
		"lastSetpoint": btState.lastSetpoint,
		"lastMeasure": btState.lastMeasure,
		"deviceName": btState.btDevice ? btState.btDevice.name : "",
		"deviceSerial": btState.meter?.serial,
		"stats": btState.stats,
		"deviceMode": btState.meter?.mode,
		"status": btState.state,
		"batteryLevel": btState.meter?.battery,
		"ready": ready,
		"initializing": initializing
	};
}

/**
 * Provided for compatibility with Blazor
 * @returns {string} JSON state object
 */
async function GetStateJSON() {
	return JSON.stringify(await GetState());
}

/**
 * Execute command with setpoints, JSON version
 * @param {string} jsonCommand the command to execute
 * @returns {string} JSON command object
 */
async function ExecuteJSON(jsonCommand) {
	let command = JSON.parse(jsonCommand);
	// deserialized object has lost its methods, let's recreate a complete one.
	let command2 = meterApi.Command.CreateTwoSP(command.type, command.setpoint, command.setpoint2);
	return JSON.stringify(await Execute(command2));
}

async function SimpleExecuteJSON(jsonCommand) {
	let command = JSON.parse(jsonCommand);
	// deserialized object has lost its methods, let's recreate a complete one.
	let command2 = meterApi.Command.CreateTwoSP(command.type, command.setpoint, command.setpoint2);
	return JSON.stringify(await SimpleExecute(command2));
}

/**
 * Execute a command and returns the measurement or setpoint with error flag and message
 * @param {Command} command
 */
async function SimpleExecute(command) {
	const SIMPLE_EXECUTE_TIMEOUT_S = 5;
	var cr = new CommandResult();

	log.info("SimpleExecute called...");

	if (command == null) {
		cr.success = false;
		cr.message = "Invalid command";
		return cr;
	}

	command.pending = true; // In case caller does not set pending flag

	// Fail immediately if not paired.
	if (!btState.started) {
		cr.success = false;
		cr.message = "Device is not paired";
		log.warn(cr.message);
		return cr;
	}

	// Another command may be pending.
	if (btState.command != null && btState.command.pending) {
		cr.success = false;
		cr.message = "Another command is pending";
		log.warn(cr.message);
		return cr;
	}

	// Wait for completion of the command, or halt of the state machine
	btState.command = command;
	if (command != null) {
		await utils.waitForTimeout(() => !command.pending || btState.state == State.STOPPED, SIMPLE_EXECUTE_TIMEOUT_S);
	}

	// Check if error or timeouts
	if (command.error || command.pending) {
		cr.success = false;
		cr.message = "Error while executing the command.";
		log.warn(cr.message);

		// Reset the active command
		btState.command = null;
		return cr;
	}

	// State is updated by execute command, so we can use btState right away
	if (utils.isGeneration(command.type)) {
		cr.value = btState.lastSetpoint["Value"];
		cr.unit = btState.lastSetpoint["Unit"];
	}
	else if (utils.isMeasurement(command.type)) {
		cr.value = btState.lastMeasure["Value"];
		cr.unit = btState.lastMeasure["Unit"];
		cr.secondary_value = btState.lastMeasure["SecondaryValue"];
		cr.secondary_unit = btState.lastMeasure["SecondaryUnit"];
	}
	else {
		cr.value = 0.0; // Settings commands;
	}

	cr.success = true;
	cr.message = "Command executed successfully";
	return cr;
}

/**
 * External interface to require a command to be executed.
 * The bluetooth device pairing window will open if device is not connected.
 * This may fail if called outside a user gesture.
 * @param {Command} command
 */
async function Execute(command) {
	log.info("Execute called...");

	if (command == null)
		return null;

	command.pending = true;

	var cpt = 0;
	while (btState.command != null && btState.command.pending && cpt < 300) {
		log.debug("Waiting for current command to complete...");
		await utils.sleep(100);
		cpt++;
	}

	log.info("Setting new command :" + command);
	btState.command = command;

	// Start the regular state machine
	if (!btState.started) {
		btState.state = State.NOT_CONNECTED;
		await bluetooth.stateMachine();
	}

	// Wait for completion of the command, or halt of the state machine
	if (command != null) {
		await utils.waitFor(() => !command.pending || btState.state == State.STOPPED);
	}

	// Return the command object result
	return command;
}

/**
 * MUST BE CALLED FROM A USER GESTURE EVENT HANDLER
  * @returns {boolean} true if meter is ready to execute command
 * */
async function Pair(forceSelection = false) {
	log.info("Pair(" + forceSelection + ") called...");

	btState.options["forceDeviceSelection"] = forceSelection;

	if (!btState.started) {
		btState.state = State.NOT_CONNECTED;
		bluetooth.stateMachine(); // Start it
	}
	else if (btState.state == State.ERROR) {
		btState.state = State.NOT_CONNECTED; // Try to restart
	}
	await utils.waitFor(() => btState.state == State.IDLE || btState.state == State.STOPPED);
	log.info("Pairing completed, state :", btState.state);
	return (btState.state != State.STOPPED);
}

/**
 * Stops the state machine and disconnects bluetooth.
 * */
async function Stop() {
	log.info("Stop request received");

	btState.stopRequest = true;
	await utils.sleep(100);

	while (btState.started || (btState.state != State.STOPPED && btState.state != State.NOT_CONNECTED)) {
		btState.stopRequest = true;
		await utils.sleep(100);
	}
	btState.command = null;
	btState.stopRequest = false;
	log.warn("Stopped on request.");
	return true;
}

module.exports = { Stop, Pair, Execute, ExecuteJSON, SimpleExecute, SimpleExecuteJSON, GetState, GetStateJSON, log };
},{"./bluetooth":1,"./classes/APIState":2,"./classes/CommandResult":4,"./constants":7,"./meterApi":8,"./utils":14,"loglevel":12}],10:[function(require,module,exports){
"use strict";

/******************************** MODBUS RTU handling ***********************************************/

var log = require("loglevel");

const SENECA_MB_SLAVE_ID = 25; // Modbus RTU slave ID

class ModbusError extends Error {
	/**
     * Creates a new modbus error
     * @param {String} message message
     * @param {number} fc function code
     */
	contructor(message, fc) {
		this.message = message;
		this.fc = fc;
	}
}

/**
 * Returns the 4 bytes CRC code from the buffer contents
 * @param {ArrayBuffer} buffer
 */
function crc16(buffer) {
	var crc = 0xFFFF;
	var odd;

	for (var i = 0; i < buffer.length; i++) {
		crc = crc ^ buffer[i];

		for (var j = 0; j < 8; j++) {
			odd = crc & 0x0001;
			crc = crc >> 1;
			if (odd) {
				crc = crc ^ 0xA001;
			}
		}
	}

	return crc;
}

/**
 * Make a Modbus Read Holding Registers (FC=03) to serial port
 * 
 * @param {number} ID slave ID
 * @param {number} count number of registers to read
 * @param {number} register starting register
 */
function makeFC3(ID, count, register) {
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setUint8(0, ID);
	view.setUint8(1, 3);
	view.setUint16(2, register, false);
	view.setUint16(4, count, false);
	var crc = crc16(new Uint8Array(buffer.slice(0, -2)));
	view.setUint16(6, crc, true);
	return buffer;
}

/**
 * Write a Modbus "Preset Multiple Registers" (FC=16) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first register.
 * @param {Array} array the array of values to write to registers.
 */
function makeFC16(address, dataAddress, array) {
	const code = 16;

	// sanity check
	if (typeof address === "undefined" || typeof dataAddress === "undefined") {
		return;
	}

	let dataLength = array.length;

	const codeLength = 7 + 2 * dataLength;
	const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
	const dv = new DataView(buf);

	dv.setUint8(0, address);
	dv.setUint8(1, code);
	dv.setUint16(2, dataAddress, false);
	dv.setUint16(4, dataLength, false);
	dv.setUint8(6, dataLength * 2);

	// copy content of array to buf
	for (let i = 0; i < dataLength; i++) {
		dv.setUint16(7 + 2 * i, array[i], false);
	}
	const crc = crc16(new Uint8Array(buf.slice(0, -2)));
	// add crc bytes to buffer
	dv.setUint16(codeLength, crc, true);
	return buf;
}

/**
 * Returns the registers values from a FC03 answer by RTU slave
 * 
 * @param {ArrayBuffer} response
 */
function parseFC3(response) {
	if (!(response instanceof ArrayBuffer)) {
		return null;
	}
	const view = new DataView(response);

	// Invalid modbus packet
	if (response.length < 5)
		return;

	var computed_crc = crc16(new Uint8Array(response.slice(0, -2)));
	var actual_crc = view.getUint16(view.byteLength - 2, true);

	if (computed_crc != actual_crc) {
		throw new ModbusError("Wrong CRC (expected:" + computed_crc + ",got:" + actual_crc + ")", 3);
	}

	var address = view.getUint8(0);
	if (address != SENECA_MB_SLAVE_ID) {
		throw new ModbusError("Wrong slave ID :" + address, 3);
	}

	var fc = view.getUint8(1);
	if (fc > 128) {
		var exp = view.getUint8(2);
		throw new ModbusError("Exception by slave:" + exp, 3);
	}
	if (fc != 3) {
		throw new ModbusError("Wrong FC :" + fc, fc);
	}

	// Length in bytes from slave answer
	var length = view.getUint8(2);

	const buffer = new ArrayBuffer(length);
	const registers = new DataView(buffer);

	for (var i = 3; i < view.byteLength - 2; i += 2) {
		var reg = view.getInt16(i, false);
		registers.setInt16(i - 3, reg, false);
		var idx = ((i - 3) / 2 + 1);
		log.debug("\t\tRegister " + idx + "/" + (length / 2) + " = " + reg);
	}

	return registers;
}

/**
 * Check if the FC16 response is correct (CRC, return code) AND optionally matching the register length expected
 * @param {ArrayBuffer} response modbus rtu raw output
 * @param {number} expected number of expected written registers from slave. If <=0, it will not be checked.
 * @returns {boolean} true if all registers have been written
 */
function parseFC16checked(response, expected) {
	try {
		const result = parseFC16(response);
		return (expected <= 0 || result[1] === expected); // check if length is matching
	}
	catch (err) {
		log.error("FC16 answer error", err);
		return false;
	}
}

/**
 * Parse the answer to the write multiple registers from the slave
 * @param {ArrayBuffer} response
 */
function parseFC16(response) {
	const view = new DataView(response);

	if (response.length < 3)
		return;

	var slave = view.getUint8(0);

	if (slave != SENECA_MB_SLAVE_ID) {
		return;
	}

	var fc = view.getUint8(1);
	if (fc > 128) {
		var exp = view.getUint8(2);
		throw new ModbusError("Exception :" + exp, 16);
	}
	if (fc != 16) {
		throw new ModbusError("Wrong FC :" + fc, fc);
	}
	var computed_crc = crc16(new Uint8Array(response.slice(0, -2)));
	var actual_crc = view.getUint16(view.byteLength - 2, true);

	if (computed_crc != actual_crc) {
		throw new ModbusError("Wrong CRC (expected:" + computed_crc + ",got:" + actual_crc + ")", 16);
	}

	var address = view.getUint16(2, false);
	var length = view.getUint16(4, false);
	return [address, length];
}




/**
 * Converts with byte swap AB CD -> CD AB -> float
 * @param {DataView} dataView buffer view to process
 * @param {number} offset byte number where float into the buffer
 * @returns {number} converted value
 */
function getFloat32LEBS(dataView, offset) {
	const buff = new ArrayBuffer(4);
	const dv = new DataView(buff);
	dv.setInt16(0, dataView.getInt16(offset + 2, false), false);
	dv.setInt16(2, dataView.getInt16(offset, false), false);
	return dv.getFloat32(0, false);
}

/**
 * Converts with byte swap AB CD -> CD AB -> Uint32
 * @param {DataView} dataView buffer view to process
 * @param {number} offset byte number where float into the buffer
 * @returns {number} converted value
 */
function getUint32LEBS(dataView, offset) {
	const buff = new ArrayBuffer(4);
	const dv = new DataView(buff);
	dv.setInt16(0, dataView.getInt16(offset + 2, false), false);
	dv.setInt16(2, dataView.getInt16(offset, false), false);
	return dv.getUint32(0, false);
}

/**
 * Converts with byte swap AB CD -> CD AB -> float
 * @param {DataView} dataView buffer view to process
 * @param {number} offset byte number where float into the buffer
 * @param {value} number value to set
 */
function setFloat32LEBS(dataView, offset, value) {
	const buff = new ArrayBuffer(4);
	const dv = new DataView(buff);
	dv.setFloat32(0, value, false);
	dataView.setInt16(offset, dv.getInt16(2, false), false);
	dataView.setInt16(offset + 2, dv.getInt16(0, false), false);
}

/**
 * Converts with byte swap AB CD -> CD AB 
 * @param {DataView} dataView buffer view to process
 * @param {number} offset byte number where uint32 into the buffer
 * @param {number} value value to set
 */
function setUint32LEBS(dataView, offset, value) {
	const buff = new ArrayBuffer(4);
	const dv = new DataView(buff);
	dv.setUint32(0, value, false);
	dataView.setInt16(offset, dv.getInt16(2, false), false);
	dataView.setInt16(offset + 2, dv.getInt16(0, false), false);
}

module.exports = { makeFC3, getFloat32LEBS, makeFC16, setFloat32LEBS, setUint32LEBS, parseFC3, parseFC16, parseFC16checked, ModbusError, SENECA_MB_SLAVE_ID, getUint32LEBS, crc16 };
},{"loglevel":12}],11:[function(require,module,exports){
"use strict";

const testTraces = [
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 d9 3e 40 80 08 c2"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 01 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 05 ff ff",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 ff ff",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 02 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 02 19 87"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 80 00 39 76 c0 00 3a 2f 60 00 39 ed 07 67"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 80 00 39 76 c0 00 3a 2f c0 00 3a 2f a4 06"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 80 00 39 76 c0 00 3a 2f 80 00 39 76 71 0c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 03 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 03 d8 47"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 2d 5c 3c 86 2d 5c 3c 86 b6 d8 3c 4a b6 03"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 47 74 3c 11 2d 5c 3c 86 47 74 3c 11 96 2b"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c 88 7c 3b f9 2d 5c 3c 86 88 7c 3b f9 08 68"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 04 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 04 99 85"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c f4 e3 c0 ea f4 e3 c0 ea f4 e3 c0 ea 15 8c"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c f4 e3 c0 ea ec e4 c0 ea f4 e3 c0 ea 63 e6"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c f4 e3 c0 ea ec e4 c0 ea ec e4 c0 ea d4 87"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c fc e3 c0 ea ec e4 c0 ea fc e3 c0 ea 80 59"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c fc e3 c0 ea ec e4 c0 ea f4 e3 c0 ea 82 39"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 05 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 26 19 9c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 05 58 45"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 7f d2 c3 0d 4a ea"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 06 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 06 18 44"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 d1 00 c3 75 ca 19"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 20 00 81 86"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 33 d3 c3 76 4d 99"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 07 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 07 d9 84"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 00 90 c3 87 72 8d"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 fe b7 c3 86 32 ae"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 08 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 08 99 80"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 be 27 c2 eb e7 3e"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 bb ad c2 eb c6 18"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 09 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 09 58 40"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 1f b7 c2 d3 c5 3d"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 47 63 c2 d3 96 65"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 1d 55 c2 d3 64 b3"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0a ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0a 18 41"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 6b 5e c6 3e cd b4"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 63 7d c6 3e 3e 1e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0b ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0b d9 81"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 77 29 cf 7c fc 5f"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 60 ef cf 7d d8 16"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0c ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0c 98 43"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 34 51 cd ce e8 d7"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 a6 ea cd ce b4 4a"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 f9 ee cd cd a7 9e"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 a5 bc cd ce 54 1e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0d ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0d 59 83"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 54 76 cc b0 c7 6c"
	},
	{
		"request": "19 03 00 78 00 02 47 ca",
		"answer": "19 03 04 7c 6e cc b0 4e cb"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0e ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0e 19 82"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 4f 44 44 5b 36 b6 43 c7 5f 46"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 0f ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 0f d8 42"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 f0 75 c3 b3 1c 4e c3 c7 a2 f8"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 10 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 10 99 8a"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 5d 6f 44 5b 3e ed 43 c7 37 22"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 11 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 11 58 4a"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 fb b1 45 2f 4f 9a 45 7d 1b 92"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 12 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 12 18 4b"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 c6 b0 45 2a 6d 00 c5 7d 4e 48"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 13 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 13 d9 8b"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 fa ed 45 2f 4e fe 45 7d 06 78"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 14 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 14 98 49"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 42 7c 44 61 4f 9a 45 7d a5 9f"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 15 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 15 59 89"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 7f c0 c3 c0 87 98 c5 72 07 13"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 12 77 c3 cd 9b c1 c5 6b 3c 21"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 9d e8 c3 b7 13 a9 c5 77 69 77"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 82 d0 c3 ad f6 d6 c5 7b ce eb"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 57 89 c3 d4 4b 14 c5 67 d3 1e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 17 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 17 d8 48"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 41 06 44 2e 29 53 43 47 26 86"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 18 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 18 98 4c"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 ac 2f c4 45 25 a5 c3 47 e9 3e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 19 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 19 59 8c"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 4f 92 44 2e 35 c6 43 47 65 7f"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1a ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1a 19 8d"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 af 82 43 67 29 53 43 47 b1 33"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1b ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1b d8 4d"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 46 a7 c4 13 25 a5 c3 47 27 0d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1c ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1c 99 8f"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 cc 98 43 67 35 c6 43 47 5b 73"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1d ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1d 58 4f"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 70 e5 43 9a 36 b6 43 c7 90 be"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1e ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1e 18 4e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 04 34 c7 06 1c 4e c3 c7 71 15"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 1f ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 1f d9 8e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 6e df 43 9a 3e ed 43 c7 f9 8e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 20 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 20 99 9e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 df ef 43 89 36 b6 43 c7 f5 45"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 21 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 21 58 5e"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 6a 1e c5 dd 1c 4e c3 c7 18 82"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 22 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 22 18 5f"
	},
	{
		"request": "19 03 00 80 00 04 46 39",
		"answer": "19 03 08 e5 ed 43 89 3e ed 43 c7 26 5d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 23 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 23 d9 9f"
	},
	{
		"request": "19 03 00 00 00 04 47 d1",
		"answer": "19 03 08 7f 00 01 00 00 2c 00 01 ad cb"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 24 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 6a 48 3d d5 2e f3"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 25 ff ff",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 25 59 9d"
	},
	{
		"request": "19 03 00 96 00 04 a7 fd",
		"answer": "19 03 08 00 00 00 00 00 00 00 00 eb 77"
	},
	{
		"request": "19 10 00 d2 00 02 04 00 00 40 80 ff ff",
		"answer": "19 10 00 d2 00 02 e2 29"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 65 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 65 58 6d"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 d2 00 02 67 ea",
		"answer": "19 03 04 00 00 40 80 52 52"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 28 98 58"
	},
	{
		"request": "19 10 00 d2 00 02 04 00 00 41 20 ff ff",
		"answer": "19 10 00 d2 00 02 e2 29"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 66 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 66 18 6c"
	},
	{
		"request": "19 03 00 d2 00 02 67 ea",
		"answer": "19 03 04 00 00 41 20 53 ba"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 80 00 f9 86"
	},
	{
		"request": "19 10 00 d4 00 02 04 00 00 40 a0 b0 18",
		"answer": "19 10 00 d4 00 02 02 28"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 67 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 67 d9 ac"
	},
	{
		"request": "19 03 00 d4 00 02 87 eb",
		"answer": "19 03 04 00 00 41 20 53 ba"
	},
	{
		"request": "19 10 00 d4 00 02 04 70 a4 3f 9d 0a da",
		"answer": "19 10 00 d4 00 02 02 28"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 68 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 68 99 a8"
	},
	{
		"request": "19 03 00 d4 00 02 87 eb",
		"answer": "19 03 04 66 66 40 86 2c c7"
	},
	{
		"request": "19 10 00 dc 00 02 04 66 66 40 86 ff ff",
		"answer": "19 10 00 dc 00 02 83 ea"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 69 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 69 58 68"
	},
	{
		"request": "19 03 00 dc 00 02 06 29",
		"answer": "19 03 04 66 66 40 86 2c c7"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6a ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6a 18 69"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6b ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6b d9 a9"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6c ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6c 98 6b"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6e ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6e 19 aa"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6d ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6d 59 ab"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 6f ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 6f d8 6a"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 70 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 70 99 a2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 71 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 71 58 62"
	},
	{
		"request": "19 10 00 e4 00 02 04 00 00 41 c8 ff ff",
		"answer": "19 10 00 e4 00 02 02 27"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 72 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 72 18 63"
	},
	{
		"request": "19 03 00 e4 00 02 87 e4",
		"answer": "19 03 04 00 00 41 c8 53 f4"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 27 d8 5c"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cc e7 40 80 dd 35"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 75 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 75 59 a1"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cd 76 40 80 8d 24"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 78 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 78 98 64"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 7b ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 7b d8 65"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c7 4b 40 80 1f 30"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cc 58 40 80 ec d1"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 7e ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 7e 18 66"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cb c8 40 80 ed 88"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 81 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 81 58 26"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 ca a9 40 80 bd aa"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 84 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 84 98 25"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c5 9c 40 80 ae b0"
	},
	{
		"request": "19 10 00 d8 00 02 04 00 00 41 f0 ff ff",
		"answer": "19 10 00 d8 00 02 c2 2b"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 87 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 87 d8 24"
	},
	{
		"request": "19 03 00 d8 00 02 47 e8",
		"answer": "19 03 04 00 00 41 f0 52 26"
	},
	{
		"request": "19 10 00 fe 00 04 08 01 4d 00 00 01 4e 00 00 ff ff",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 88 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 ff ff",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 01 4d 00 00 01 4e 00 00 d6 54"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 aa af 40 80 43 ab"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c5 0c 40 80 ae 9d"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c9 89 40 80 bc 24"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 cb 39 40 80 bc 7b"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c7 db 40 80 1f 1d"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c6 bc 40 80 af 3e"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c4 7d 40 80 ff 7a"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c3 5e 40 80 0f c4"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c8 6b 40 80 1d ee"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c6 2c 40 80 af 13"
	},
	{
		"request": "19 10 00 e4 00 02 04 00 00 41 f0 ff ff",
		"answer": "19 10 00 e4 00 02 02 27"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 c2 ce 40 80 0e 15"
	},
	{
		"request": "19 10 00 c0 00 02 04 00 00 41 20 ff ff",
		"answer": "19 10 00 c0 00 02 42 2c"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 7d 41 40 77 5b ac"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fe 00 04 08 00 06 00 00 00 07 00 00 d3 67",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 88 90 b9",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 d0 dd",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 06 00 00 00 07 00 00 3c b6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fc 00 02 04 00 64 00 00 c3 c1",
		"answer": "19 10 00 fc 00 02 82 20"
	},
	{
		"request": "19 10 00 fe 00 04 08 00 28 00 00 00 28 00 00 2c ac",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 89 51 79",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 02 90 dc",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 28 00 00 00 28 00 00 c3 7d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 41 c9 40 77 d7 d6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 41 c9 40 77 d7 d6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 40 a9 40 77 d6 34"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 41 c9 40 77 d7 d6"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 40 a9 40 77 d6 34"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3f 8b 40 77 6f ea"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3e 6b 40 77 6f e0"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3e 6b 40 77 6f e0"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3d 4c 40 77 df af"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3c 2e 40 77 7f 8d"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 3b 0e 40 77 7f 33"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 01 5a 94",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 05 c4 88",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 01 59 86"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 84 00 06 86 39",
		"answer": "19 03 0c c0 00 3a 2f c0 00 3a 2f c0 00 3a 2f c3 65"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 01 08 00 02 04 00 00 00 00 81 39",
		"answer": "19 10 01 08 00 02 c2 2e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 01 06 00 02 04 a1 2f 3e bd c2 91",
		"answer": "19 10 01 06 00 02 a3 ed"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fc 00 02 04 00 0a 00 00 a2 1c",
		"answer": "19 10 00 fc 00 02 82 20"
	},
	{
		"request": "19 10 00 fe 00 04 08 00 64 00 00 00 64 00 00 60 bf",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 89 51 79",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 02 90 dc",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 00 64 00 00 00 64 00 00 8f 6e"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fe 00 04 08 03 e8 00 00 03 e8 00 00 ac cd",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 88 90 b9",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 d0 dd",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 03 e8 00 00 03 e8 00 00 43 1c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 0a 00 02 e7 d1",
		"answer": "19 03 04 5f 43 3a 90 93 3e"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 ae 00 02 a6 32",
		"answer": "19 03 04 ef e1 40 76 b6 f6"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 03 db 55",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fe 00 04 08 07 d0 00 00 07 d0 00 00 94 00",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 67 d1 35",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 01 d0 dd",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 88 98 20"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 07 d0 00 00 07 d0 00 00 7b d1"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 fc 00 02 04 00 05 00 00 92 1f",
		"answer": "19 10 00 fc 00 02 82 20"
	},
	{
		"request": "19 10 00 fe 00 04 08 20 8d 00 00 20 8e 00 00 30 5d",
		"answer": "19 10 00 fe 00 04 a3 e2"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 01 00 89 51 79",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 cf 00 02 04 00 09 00 02 90 dc",
		"answer": "19 10 00 cf 00 02 72 2f"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 89 59 e0"
	},
	{
		"request": "19 03 00 ca 00 01 a7 ec",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 fe 00 04 26 21",
		"answer": "19 03 08 20 8d 00 00 20 8e 00 00 df 8c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 24 9b 4f",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 10 00 6b 00 01 02 00 06 84 89",
		"answer": "19 10 00 6b 00 01 73 cd"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 24 98 5d"
	},
	{
		"request": "19 03 00 66 00 01 67 cd",
		"answer": "19 03 02 00 00 98 46"
	},
	{
		"request": "19 03 00 a4 00 02 86 30",
		"answer": "19 03 04 00 5c 3e 11 72 4c"
	},
	{
		"request": "19 10 00 6b 00 02 04 00 01 00 64 9a bf",
		"answer": "19 10 00 6b 00 02 33 cc"
	},
	{
		"request": "19 03 00 64 00 01 c6 0d",
		"answer": "19 03 02 00 64 99 ad"
	}
];

function uniqBy(a, key) {
	var seen = {};
	return a.filter(function (item) {
		var k = key(item);
		return seen.hasOwnProperty(k) ? false : (seen[k] = true);
	});
}

function sameMessage(trace) {
	return trace["request"] + " -> " + trace["answer"];
}

function GetJsonTraces() {
	testTraces = uniqBy(testTraces, sameMessage);
	return JSON.stringify(testTraces);
}

module.exports = { testTraces, GetJsonTraces };
},{}],12:[function(require,module,exports){
/*
* loglevel - https://github.com/pimterry/loglevel
*
* Copyright (c) 2013 Tim Perry
* Licensed under the MIT license.
*/
(function (root, definition) {
    "use strict";
    if (typeof define === 'function' && define.amd) {
        define(definition);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = definition();
    } else {
        root.log = definition();
    }
}(this, function () {
    "use strict";

    // Slightly dubious tricks to cut down minimized file size
    var noop = function() {};
    var undefinedType = "undefined";
    var isIE = (typeof window !== undefinedType) && (typeof window.navigator !== undefinedType) && (
        /Trident\/|MSIE /.test(window.navigator.userAgent)
    );

    var logMethods = [
        "trace",
        "debug",
        "info",
        "warn",
        "error"
    ];

    // Cross-browser bind equivalent that works at least back to IE6
    function bindMethod(obj, methodName) {
        var method = obj[methodName];
        if (typeof method.bind === 'function') {
            return method.bind(obj);
        } else {
            try {
                return Function.prototype.bind.call(method, obj);
            } catch (e) {
                // Missing bind shim or IE8 + Modernizr, fallback to wrapping
                return function() {
                    return Function.prototype.apply.apply(method, [obj, arguments]);
                };
            }
        }
    }

    // Trace() doesn't print the message in IE, so for that case we need to wrap it
    function traceForIE() {
        if (console.log) {
            if (console.log.apply) {
                console.log.apply(console, arguments);
            } else {
                // In old IE, native console methods themselves don't have apply().
                Function.prototype.apply.apply(console.log, [console, arguments]);
            }
        }
        if (console.trace) console.trace();
    }

    // Build the best logging method possible for this env
    // Wherever possible we want to bind, not wrap, to preserve stack traces
    function realMethod(methodName) {
        if (methodName === 'debug') {
            methodName = 'log';
        }

        if (typeof console === undefinedType) {
            return false; // No method possible, for now - fixed later by enableLoggingWhenConsoleArrives
        } else if (methodName === 'trace' && isIE) {
            return traceForIE;
        } else if (console[methodName] !== undefined) {
            return bindMethod(console, methodName);
        } else if (console.log !== undefined) {
            return bindMethod(console, 'log');
        } else {
            return noop;
        }
    }

    // These private functions always need `this` to be set properly

    function replaceLoggingMethods(level, loggerName) {
        /*jshint validthis:true */
        for (var i = 0; i < logMethods.length; i++) {
            var methodName = logMethods[i];
            this[methodName] = (i < level) ?
                noop :
                this.methodFactory(methodName, level, loggerName);
        }

        // Define log.log as an alias for log.debug
        this.log = this.debug;
    }

    // In old IE versions, the console isn't present until you first open it.
    // We build realMethod() replacements here that regenerate logging methods
    function enableLoggingWhenConsoleArrives(methodName, level, loggerName) {
        return function () {
            if (typeof console !== undefinedType) {
                replaceLoggingMethods.call(this, level, loggerName);
                this[methodName].apply(this, arguments);
            }
        };
    }

    // By default, we use closely bound real methods wherever possible, and
    // otherwise we wait for a console to appear, and then try again.
    function defaultMethodFactory(methodName, level, loggerName) {
        /*jshint validthis:true */
        return realMethod(methodName) ||
               enableLoggingWhenConsoleArrives.apply(this, arguments);
    }

    function Logger(name, defaultLevel, factory) {
      var self = this;
      var currentLevel;
      defaultLevel = defaultLevel == null ? "WARN" : defaultLevel;

      var storageKey = "loglevel";
      if (typeof name === "string") {
        storageKey += ":" + name;
      } else if (typeof name === "symbol") {
        storageKey = undefined;
      }

      function persistLevelIfPossible(levelNum) {
          var levelName = (logMethods[levelNum] || 'silent').toUpperCase();

          if (typeof window === undefinedType || !storageKey) return;

          // Use localStorage if available
          try {
              window.localStorage[storageKey] = levelName;
              return;
          } catch (ignore) {}

          // Use session cookie as fallback
          try {
              window.document.cookie =
                encodeURIComponent(storageKey) + "=" + levelName + ";";
          } catch (ignore) {}
      }

      function getPersistedLevel() {
          var storedLevel;

          if (typeof window === undefinedType || !storageKey) return;

          try {
              storedLevel = window.localStorage[storageKey];
          } catch (ignore) {}

          // Fallback to cookies if local storage gives us nothing
          if (typeof storedLevel === undefinedType) {
              try {
                  var cookie = window.document.cookie;
                  var location = cookie.indexOf(
                      encodeURIComponent(storageKey) + "=");
                  if (location !== -1) {
                      storedLevel = /^([^;]+)/.exec(cookie.slice(location))[1];
                  }
              } catch (ignore) {}
          }

          // If the stored level is not valid, treat it as if nothing was stored.
          if (self.levels[storedLevel] === undefined) {
              storedLevel = undefined;
          }

          return storedLevel;
      }

      function clearPersistedLevel() {
          if (typeof window === undefinedType || !storageKey) return;

          // Use localStorage if available
          try {
              window.localStorage.removeItem(storageKey);
              return;
          } catch (ignore) {}

          // Use session cookie as fallback
          try {
              window.document.cookie =
                encodeURIComponent(storageKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC";
          } catch (ignore) {}
      }

      /*
       *
       * Public logger API - see https://github.com/pimterry/loglevel for details
       *
       */

      self.name = name;

      self.levels = { "TRACE": 0, "DEBUG": 1, "INFO": 2, "WARN": 3,
          "ERROR": 4, "SILENT": 5};

      self.methodFactory = factory || defaultMethodFactory;

      self.getLevel = function () {
          return currentLevel;
      };

      self.setLevel = function (level, persist) {
          if (typeof level === "string" && self.levels[level.toUpperCase()] !== undefined) {
              level = self.levels[level.toUpperCase()];
          }
          if (typeof level === "number" && level >= 0 && level <= self.levels.SILENT) {
              currentLevel = level;
              if (persist !== false) {  // defaults to true
                  persistLevelIfPossible(level);
              }
              replaceLoggingMethods.call(self, level, name);
              if (typeof console === undefinedType && level < self.levels.SILENT) {
                  return "No console available for logging";
              }
          } else {
              throw "log.setLevel() called with invalid level: " + level;
          }
      };

      self.setDefaultLevel = function (level) {
          defaultLevel = level;
          if (!getPersistedLevel()) {
              self.setLevel(level, false);
          }
      };

      self.resetLevel = function () {
          self.setLevel(defaultLevel, false);
          clearPersistedLevel();
      };

      self.enableAll = function(persist) {
          self.setLevel(self.levels.TRACE, persist);
      };

      self.disableAll = function(persist) {
          self.setLevel(self.levels.SILENT, persist);
      };

      // Initialize with the right level
      var initialLevel = getPersistedLevel();
      if (initialLevel == null) {
          initialLevel = defaultLevel;
      }
      self.setLevel(initialLevel, false);
    }

    /*
     *
     * Top-level API
     *
     */

    var defaultLogger = new Logger();

    var _loggersByName = {};
    defaultLogger.getLogger = function getLogger(name) {
        if ((typeof name !== "symbol" && typeof name !== "string") || name === "") {
          throw new TypeError("You must supply a name when creating a logger.");
        }

        var logger = _loggersByName[name];
        if (!logger) {
          logger = _loggersByName[name] = new Logger(
            name, defaultLogger.getLevel(), defaultLogger.methodFactory);
        }
        return logger;
    };

    // Grab the current global log variable in case of overwrite
    var _log = (typeof window !== undefinedType) ? window.log : undefined;
    defaultLogger.noConflict = function() {
        if (typeof window !== undefinedType &&
               window.log === defaultLogger) {
            window.log = _log;
        }

        return defaultLogger;
    };

    defaultLogger.getLoggers = function getLoggers() {
        return _loggersByName;
    };

    // ES6 default export, for compatibility
    defaultLogger['default'] = defaultLogger;

    return defaultLogger;
}));

},{}],13:[function(require,module,exports){
"use strict";

/******************************* MODBUS RTU FUNCTIONS FOR SENECA **********************/

var modbus = require("./modbusRtu");
var constants = require("./constants");
var utils = require("./utils");

var CommandType = constants.CommandType;
const SENECA_MB_SLAVE_ID = modbus.SENECA_MB_SLAVE_ID; // Modbus RTU slave ID

/*
 * Modbus registers map. Each register is 2 bytes wide.
 */
const MSCRegisters = {
	SerialNumber: 10,
	CurrentMode: 100,
	MeasureFlags: 102,
	CMD: 107,
	AUX1: 108,
	LoadCellMeasure: 114,
	TempMeasure: 120,
	RtdTemperatureMeasure: 128,
	RtdResistanceMeasure: 130,
	FrequencyMeasure: 164,
	MinMeasure: 132,
	MaxMeasure: 134,
	InstantMeasure: 136,
	PowerOffDelay: 142,
	PowerOffRemaining: 146,
	PulseOFFMeasure: 150,
	PulseONMeasure: 152,
	Sensibility_uS_OFF: 166,
	Sensibility_uS_ON: 168,
	BatteryMeasure: 174,
	ColdJunction: 190,
	ThresholdU_Freq: 192,
	GenerationFlags: 202,
	GEN_CMD: 207,
	GEN_AUX1: 208,
	CurrentSetpoint: 210,
	VoltageSetpoint: 212,
	LoadCellSetpoint: 216,
	ThermoTemperatureSetpoint: 220,
	RTDTemperatureSetpoint: 228,
	PulsesCount: 252,
	FrequencyTICK1: 254,
	FrequencyTICK2: 256,
	GenUhighPerc: 262,
	GenUlowPerc: 264
};

/**
 * Generate the modbus RTU packet to read the serial number
 * */
function makeSerialNumber() {
	return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.SerialNumber);
}

/**
 * Generate the modbus RTU packet to read the current mode
 * */
function makeCurrentMode() {
	return modbus.makeFC3(SENECA_MB_SLAVE_ID, 1, MSCRegisters.CurrentMode);
}

/**
 * Generate the modbus RTU packet to read the current battery level
 * */
function makeBatteryLevel() {
	return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.BatteryMeasure);
}

/**
 * Parses the register with battery level
 * @param {ArrayBuffer} buffer FC3 answer 
 * @returns {number} battery level in V
 */
function parseBattery(buffer) {
	var registers = modbus.parseFC3(buffer);
	return modbus.getFloat32LEBS(registers, 0);
}

/**
 * Parse the Seneca MSC serial as per the UI interface
 * @param {ArrayBuffer} buffer modbus answer packet (FC3)
 */
function parseSerialNumber(buffer) {
	var registers = modbus.parseFC3(buffer);
	if (registers.length < 4) {
		throw new Error("Invalid serial number response");
	}
	const val1 = registers.getUint16(0, false);
	const val2 = registers.getUint16(2, false);
	const serial = ((val2 << 16) + val1).toString();
	if (serial.length > 5) {
		return serial.substr(0, 5) + "_" + serial.substr(5, serial.length - 5);
	}
	return serial;
}

/**
 * Parses the state of the meter. May throw.
 * @param {ArrayBuffer} buffer modbus answer packet (FC3)
 * @param {CommandType} currentMode if the registers contains an IGNORE value, returns the current mode
 * @returns {CommandType} meter mode
 */
function parseCurrentMode(buffer, currentMode) {
	var registers = modbus.parseFC3(buffer);
	if (registers.length < 2) {
		throw new Error("Invalid mode response");
	}
	const val1 = registers.getUint16(0, false);

	if (val1 == CommandType.RESERVED || val1 == CommandType.GEN_RESERVED || val1 == CommandType.RESERVED_2) { // Must be ignored, internal states of the meter
		return currentMode;
	}
	const value = utils.Parse(CommandType, val1);
	if (value == null)
		throw new Error("Unknown meter mode : " + value);

	return val1;
}
/**
 * Sets the current mode.
 * @param {number} mode
 * @returns {ArrayBuffer|null}
 */
function makeModeRequest(mode) {
	const value = utils.Parse(CommandType, mode);
	const CHANGE_STATUS = 1;

	// Filter invalid commands
	if (value == null || value == CommandType.NONE_UNKNOWN) {
		return null;
	}

	if (mode > CommandType.NONE_UNKNOWN && mode <= CommandType.OFF) { // Measurements
		return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CMD, [CHANGE_STATUS, mode]);
	}
	else if (mode > CommandType.OFF && mode < CommandType.GEN_RESERVED) { // Generations
		switch (mode) {
		case CommandType.GEN_THERMO_B:
		case CommandType.GEN_THERMO_E:
		case CommandType.GEN_THERMO_J:
		case CommandType.GEN_THERMO_K:
		case CommandType.GEN_THERMO_L:
		case CommandType.GEN_THERMO_N:
		case CommandType.GEN_THERMO_R:
		case CommandType.GEN_THERMO_S:
		case CommandType.GEN_THERMO_T:
			// Cold junction not configured
			return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GEN_CMD, [CHANGE_STATUS, mode]);
		case CommandType.GEN_Cu50_3W:
		case CommandType.GEN_Cu50_2W:
		case CommandType.GEN_Cu100_2W:
		case CommandType.GEN_Ni100_2W:
		case CommandType.GEN_Ni120_2W:
		case CommandType.GEN_PT100_2W:
		case CommandType.GEN_PT500_2W:
		case CommandType.GEN_PT1000_2W:
		default:
			// All the simple cases 
			return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GEN_CMD, [CHANGE_STATUS, mode]);
		}

	}
	return null;
}

/**
 * When the meter is measuring, make the modbus request of the value
 * @param {CommandType} mode
 * @returns {ArrayBuffer} modbus RTU packet
 */
function makeMeasureRequest(mode) {
	switch (mode) {
	case CommandType.OFF:
		return null;
	case CommandType.THERMO_B:
	case CommandType.THERMO_E:
	case CommandType.THERMO_J:
	case CommandType.THERMO_K:
	case CommandType.THERMO_L:
	case CommandType.THERMO_N:
	case CommandType.THERMO_R:
	case CommandType.THERMO_S:
	case CommandType.THERMO_T:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.TempMeasure);
	case CommandType.Cu50_2W:
	case CommandType.Cu50_3W:
	case CommandType.Cu50_4W:
	case CommandType.Cu100_2W:
	case CommandType.Cu100_3W:
	case CommandType.Cu100_4W:
	case CommandType.Ni100_2W:
	case CommandType.Ni100_3W:
	case CommandType.Ni100_4W:
	case CommandType.Ni120_2W:
	case CommandType.Ni120_3W:
	case CommandType.Ni120_4W:
	case CommandType.PT100_2W:
	case CommandType.PT100_3W:
	case CommandType.PT100_4W:
	case CommandType.PT500_2W:
	case CommandType.PT500_3W:
	case CommandType.PT500_4W:
	case CommandType.PT1000_2W:
	case CommandType.PT1000_3W:
	case CommandType.PT1000_4W:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.RtdTemperatureMeasure); // Temp-Ohm
	case CommandType.Frequency:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.FrequencyMeasure);
	case CommandType.PulseTrain:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.PulseOFFMeasure); // ON-OFF
	case CommandType.LoadCell:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.LoadCell);
	case CommandType.mA_passive:
	case CommandType.mA_active:
	case CommandType.V:
	case CommandType.mV:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 6, MSCRegisters.MinMeasure); // Min-Max-Meas
	default:
		throw new Error("Mode not managed :" + btState.meter.mode);
	}
}

/**
 * Parse the measure read from the meter
 * @param {ArrayBuffer} buffer modbus rtu answer (FC3)
 * @param {CommandType} mode current mode of the meter
 * @returns {array} an array with first element "Measure name (units)":Value, second Timestamp:acquisition
 */
function parseMeasure(buffer, mode) {
	var responseFC3 = modbus.parseFC3(buffer);
	var meas, meas2, min, max;

	// All measures are float
	if (responseFC3 == null)
		return {};

	switch (mode) {
	case CommandType.THERMO_B:
	case CommandType.THERMO_E:
	case CommandType.THERMO_J:
	case CommandType.THERMO_K:
	case CommandType.THERMO_L:
	case CommandType.THERMO_N:
	case CommandType.THERMO_R:
	case CommandType.THERMO_S:
		meas = modbus.getFloat32LEBS(responseFC3, 0);
		var value = Math.round(meas * 100) / 100;
		return {
			"Description": "Temperature",
			"Value": value,
			"Unit": "°C",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.Cu50_2W:
	case CommandType.Cu50_3W:
	case CommandType.Cu50_4W:
	case CommandType.Cu100_2W:
	case CommandType.Cu100_3W:
	case CommandType.Cu100_4W:
	case CommandType.Ni100_2W:
	case CommandType.Ni100_3W:
	case CommandType.Ni100_4W:
	case CommandType.Ni120_2W:
	case CommandType.Ni120_3W:
	case CommandType.Ni120_4W:
	case CommandType.PT100_2W:
	case CommandType.PT100_3W:
	case CommandType.PT100_4W:
	case CommandType.PT500_2W:
	case CommandType.PT500_3W:
	case CommandType.PT500_4W:
	case CommandType.PT1000_2W:
	case CommandType.PT1000_3W:
	case CommandType.PT1000_4W:
		meas = modbus.getFloat32LEBS(responseFC3, 0);
		meas2 = modbus.getFloat32LEBS(responseFC3, 4);
		return {
			"Description": "Temperature",
			"Value": Math.round(meas * 10) / 10,
			"Unit": "°C",
			"SecondaryDescription": "Resistance",
			"SecondaryValue": Math.round(meas2 * 10) / 10,
			"SecondaryUnit": "Ohms",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.Frequency:
		meas = modbus.getFloat32LEBS(responseFC3, 0);
		// Sensibilità mancanti
		return {
			"Description": "Frequency",
			"Value": Math.round(meas * 10) / 10,
			"Unit": "Hz",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.mA_active:
	case CommandType.mA_passive:
		min = modbus.getFloat32LEBS(responseFC3, 0);
		max = modbus.getFloat32LEBS(responseFC3, 4);
		meas = modbus.getFloat32LEBS(responseFC3, 8);
		return {
			"Description": "Current",
			"Value": Math.round(meas * 100) / 100,
			"Unit": "mA",
			"Minimum": Math.round(min * 100) / 100,
			"Maximum": Math.round(max * 100) / 100,
			"Timestamp": new Date().toISOString()
		};
	case CommandType.V:
		min = modbus.getFloat32LEBS(responseFC3, 0);
		max = modbus.getFloat32LEBS(responseFC3, 4);
		meas = modbus.getFloat32LEBS(responseFC3, 8);
		return {
			"Description": "Voltage",
			"Value": Math.round(meas * 100) / 100,
			"Unit": "V",
			"Minimum": Math.round(min * 100) / 100,
			"Maximum": Math.round(max * 100) / 100,
			"Timestamp": new Date().toISOString()
		};
	case CommandType.mV:
		min = modbus.getFloat32LEBS(responseFC3, 0);
		max = modbus.getFloat32LEBS(responseFC3, 4);
		meas = modbus.getFloat32LEBS(responseFC3, 8);
		return {
			"Description": "Voltage",
			"Value": Math.round(meas * 100) / 100,
			"Unit": "mV",
			"Minimum": Math.round(min * 100) / 100,
			"Maximum": Math.round(max * 100) / 100,
			"Timestamp": new Date().toISOString()
		};
	case CommandType.PulseTrain:
		meas = modbus.getUint32LEBS(responseFC3, 0);
		meas2 = modbus.getUint32LEBS(responseFC3, 4);
		// Soglia e sensibilità mancanti
		return {
			"Description": "Pulse ON",
			"Value": meas,
			"Unit": "",
			"SecondaryDescription": "Pulse OFF",
			"SecondaryValue": meas2,
			"SecondaryUnit": "",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.LoadCell:
		meas = Math.round(modbus.getFloat32LEBS(responseFC3, 0) * 1000) / 1000;
		// Kg mancanti
		// Sensibilità, tara, portata mancanti
		return {
			"Description": "Imbalance",
			"Value": meas,
			"Unit": "mV/V",
			"Timestamp": new Date().toISOString()
		};
	default:
		return {
			"Description": "Unknown",
			"Value": Math.round(meas * 1000) / 1000,
			"Unit": "?",
			"Timestamp": new Date().toISOString()
		};
	}
}

/**
 * Reads the status flags from measurement mode
 * @param {CommandType} mode
 * @returns {ArrayBuffer} modbus RTU request to send
 */
function makeQualityBitRequest(mode) {
	return modbus.makeFC3(SENECA_MB_SLAVE_ID, 1, MSCRegisters.MeasureFlags);
}

/**
 * Checks if the error bit status
 * @param {ArrayBuffer} buffer
 * @returns {boolean} true if there is no error
 */
function isQualityValid(buffer) {
	var responseFC3 = modbus.parseFC3(buffer);
	return ((responseFC3.getUint16(0, false) & (1 << 13)) == 0);
}

/**
 * Reads the generation flags status from the meter
 * @param {CommandType} mode
 * @returns {ArrayBuffer} modbus RTU request to send
 */
function makeGenStatusRead(mode) {
	return modbus.makeFC3(SENECA_MB_SLAVE_ID, 1, MSCRegisters.GenerationFlags);
}

/**
 * Checks if the error bit is NOT set in the generation flags
 * @param {ArrayBuffer} responseFC3
 * @returns {boolean} true if there is no error
 */
function parseGenStatus(buffer, mode) {
	var responseFC3 = modbus.parseFC3(buffer);
	switch (mode) {
	case CommandType.GEN_mA_active:
	case CommandType.GEN_mA_passive:
		return ((responseFC3.getUint16(0, false) & (1 << 15)) == 0) && // Gen error
                ((responseFC3.getUint16(0, false) & (1 << 14)) == 0); // Self generation I check
	default:
		return (responseFC3.getUint16(0, false) & (1 << 15)) == 0; // Gen error
	}
}


/**
 * Returns a buffer with the modbus-rtu request to be sent to Seneca
 * @param {CommandType} mode generation mode
 * @param {number} setpoint the value to set (mV/V/A/Hz/°C) except for pulses num_pulses
 * @param {number} setpoint2 frequency in Hz
 */
function makeSetpointRequest(mode, setpoint, setpoint2) {
	var TEMP, registers;
	var dt = new ArrayBuffer(4);
	var dv = new DataView(dt);

	modbus.setFloat32LEBS(dv, 0, setpoint);
	const sp = [dv.getUint16(0, false), dv.getUint16(2, false)];

	var dtInt = new ArrayBuffer(4);
	var dvInt = new DataView(dtInt);
	modbus.setUint32LEBS(dvInt, 0, setpoint);
	const spInt = [dvInt.getUint16(0, false), dvInt.getUint16(2, false)];

	switch (mode) {
	case CommandType.GEN_V:
	case CommandType.GEN_mV:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.VoltageSetpoint, sp)]; // V / mV setpoint
	case CommandType.GEN_mA_active:
	case CommandType.GEN_mA_passive:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CurrentSetpoint, sp)]; // I setpoint
	case CommandType.GEN_Cu50_3W:
	case CommandType.GEN_Cu50_2W:
	case CommandType.GEN_Cu100_2W:
	case CommandType.GEN_Ni100_2W:
	case CommandType.GEN_Ni120_2W:
	case CommandType.GEN_PT100_2W:
	case CommandType.GEN_PT500_2W:
	case CommandType.GEN_PT1000_2W:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.RTDTemperatureSetpoint, sp)]; // °C setpoint
	case CommandType.GEN_THERMO_B:
	case CommandType.GEN_THERMO_E:
	case CommandType.GEN_THERMO_J:
	case CommandType.GEN_THERMO_K:
	case CommandType.GEN_THERMO_L:
	case CommandType.GEN_THERMO_N:
	case CommandType.GEN_THERMO_R:
	case CommandType.GEN_THERMO_S:
	case CommandType.GEN_THERMO_T:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ThermoTemperatureSetpoint, sp)]; // °C setpoint
	case CommandType.GEN_LoadCell:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.LoadCellSetpoint, sp)]; // mV/V setpoint
	case CommandType.GEN_Frequency:
		dt = new ArrayBuffer(8); // 2 Uint32
		dv = new DataView(dt);

		// See Senecal manual manual
		// Max 20kHZ gen
		TEMP = Math.round(20000 / setpoint, 0);
		dv.setUint32(0, Math.floor(TEMP / 2), false); // TICK1
		dv.setUint32(4, TEMP - Math.floor(TEMP / 2), false); // TICK2

		// Byte-swapped little endian
		registers = [dv.getUint16(2, false), dv.getUint16(0, false),
			dv.getUint16(6, false), dv.getUint16(4, false)];

		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.FrequencyTICK1, registers)];

	case CommandType.GEN_PulseTrain:
		dt = new ArrayBuffer(12); // 3 Uint32 
		dv = new DataView(dt);

		// See Senecal manual manual
		// Max 20kHZ gen
		TEMP = Math.round(20000 / setpoint2, 0);

		dv.setUint32(0, setpoint, false); // NUM_PULSES
		dv.setUint32(4, Math.floor(TEMP / 2), false); // TICK1
		dv.setUint32(8, TEMP - Math.floor(TEMP / 2), false); // TICK2

		registers = [dv.getUint16(2, false), dv.getUint16(0, false)];
		var p1 = modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.PulsesCount, registers); // must split in two to stay <= 20 bytes for the full rtu packet
            
		registers = [ dv.getUint16(6, false), dv.getUint16(4, false),
			dv.getUint16(10, false), dv.getUint16(8, false)];
		var p2 = modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.FrequencyTICK1, registers);
		return [p1, p2];
	case CommandType.SET_UThreshold_F:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ThresholdU_Freq, sp)]; // U min for freq measurement
	case CommandType.SET_Sensitivity_uS:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.Sensibility_uS_OFF,
			[spInt[0], spInt[1], spInt[0], spInt[1]])]; // uV for pulse train measurement to ON / OFF
	case CommandType.SET_ColdJunction:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ColdJunction, sp)]; // unclear unit
	case CommandType.SET_Ulow:
		modbus.setFloat32LEBS(dv, 0, setpoint / constants.MAX_U_GEN); // Must convert V into a % 0..MAX_U_GEN
		var sp2 = [dv.getUint16(0, false), dv.getUint16(2, false)];
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GenUlowPerc, sp2)]; // U low for freq / pulse gen
	case CommandType.SET_Uhigh:
		modbus.setFloat32LEBS(dv, 0, setpoint / constants.MAX_U_GEN); // Must convert V into a % 0..MAX_U_GEN
		var sp3 = [dv.getUint16(0, false), dv.getUint16(2, false)];
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GenUhighPerc, sp3)]; // U high for freq / pulse gen            
	case CommandType.SET_ShutdownDelay:
		return [modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.PowerOffDelay, setpoint)]; // delay in sec
	case CommandType.OFF:
		return []; // No setpoint
	default:
		throw new Error("Not handled");
	}
	return [];
}

/**
 * Reads the setpoint
 * @param {CommandType} mode
 * @returns {ArrayBuffer} modbus RTU request
 */
function makeSetpointRead(mode) {
	switch (mode) {
	case CommandType.GEN_V:
	case CommandType.GEN_mV:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.VoltageSetpoint); // mV or V setpoint
	case CommandType.GEN_mA_active:
	case CommandType.GEN_mA_passive:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.CurrentSetpoint); // A setpoint
	case CommandType.GEN_Cu50_3W:
	case CommandType.GEN_Cu50_2W:
	case CommandType.GEN_Cu100_2W:
	case CommandType.GEN_Ni100_2W:
	case CommandType.GEN_Ni120_2W:
	case CommandType.GEN_PT100_2W:
	case CommandType.GEN_PT500_2W:
	case CommandType.GEN_PT1000_2W:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.RTDTemperatureSetpoint); // °C setpoint
	case CommandType.GEN_THERMO_B:
	case CommandType.GEN_THERMO_E:
	case CommandType.GEN_THERMO_J:
	case CommandType.GEN_THERMO_K:
	case CommandType.GEN_THERMO_L:
	case CommandType.GEN_THERMO_N:
	case CommandType.GEN_THERMO_R:
	case CommandType.GEN_THERMO_S:
	case CommandType.GEN_THERMO_T:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.ThermoTemperatureSetpoint); // °C setpoint
	case CommandType.GEN_Frequency:
	case CommandType.GEN_PulseTrain:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.FrequencyTICK1); // Frequency setpoint (TICKS)
	case CommandType.GEN_LoadCell:
		return modbus.makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.LoadCellSetpoint); // mV/V setpoint
	case CommandType.NONE_UNKNOWN:
	case CommandType.OFF:
		return null;
	}
	throw new Error("Not handled");
}

/**
 * Parses the answer about SetpointRead
 * @param {ArrayBuffer} registers FC3 parsed answer
 * @returns {number} the last setpoint
 */
function parseSetpointRead(buffer, mode) {
	// Round to two digits
	var registers = modbus.parseFC3(buffer);
	var rounded = Math.round(modbus.getFloat32LEBS(registers, 0) * 100) / 100;

	switch (mode) {
	case CommandType.GEN_mA_active:
	case CommandType.GEN_mA_passive:
		return {
			"Description": "Current",
			"Value": rounded,
			"Unit": "mA",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.GEN_V:
		return {
			"Description": "Voltage",
			"Value": rounded,
			"Unit": "V",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.GEN_mV:
		return {
			"Description": "Voltage",
			"Value": rounded,
			"Unit": "mV",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.GEN_LoadCell:
		return {
			"Description": "Imbalance",
			"Value": rounded,
			"Unit": "mV/V",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.GEN_Frequency:
	case CommandType.GEN_PulseTrain:
		var tick1 = modbus.getUint32LEBS(registers, 0);
		var tick2 = modbus.getUint32LEBS(registers, 4);
		var fON = 0.0;
		var fOFF = 0.0;
		if (tick1 != 0)
			fON = Math.round(1 / (tick1 * 2 / 20000.0) * 10.0) / 10; // Need one decimal place for HZ
		if (tick2 != 0)
			fOFF = Math.round(1 / (tick2 * 2 / 20000.0) * 10.0) / 10; // Need one decimal place for HZ
		return {
			"Description": "Frequency ON",
			"Value": fON,
			"Unit": "Hz",
			"SecondaryDescription": "Frequency OFF",
			"SecondaryValue": fOFF,
			"SecondaryUnit": "Hz",
			"Timestamp": new Date().toISOString()
		};
	case CommandType.GEN_Cu50_2W:
	case CommandType.GEN_Cu100_2W:
	case CommandType.GEN_Ni100_2W:
	case CommandType.GEN_Ni120_2W:
	case CommandType.GEN_PT100_2W:
	case CommandType.GEN_PT500_2W:
	case CommandType.GEN_PT1000_2W:
	case CommandType.GEN_THERMO_B:
	case CommandType.GEN_THERMO_E:
	case CommandType.GEN_THERMO_J:
	case CommandType.GEN_THERMO_K:
	case CommandType.GEN_THERMO_L:
	case CommandType.GEN_THERMO_N:
	case CommandType.GEN_THERMO_R:
	case CommandType.GEN_THERMO_S:
	case CommandType.GEN_THERMO_T:
		return {
			"Description": "Temperature",
			"Value": rounded,
			"Unit": "°C",
			"Timestamp": new Date().toISOString()
		};
	default:
		return {
			"Description": "Unknown",
			"Value": rounded,
			"Unit": "?",
			"Timestamp": new Date().toISOString()
		};
	}

}

module.exports = {
	MSCRegisters, makeSerialNumber, makeCurrentMode, makeBatteryLevel, parseBattery, parseSerialNumber,
	parseCurrentMode, makeModeRequest, makeMeasureRequest, parseMeasure, makeQualityBitRequest, isQualityValid,
	makeGenStatusRead, parseGenStatus, makeSetpointRequest, makeSetpointRead, parseSetpointRead
};
},{"./constants":7,"./modbusRtu":10,"./utils":14}],14:[function(require,module,exports){
var constants = require("./constants");
var CommandType = constants.CommandType;

let sleep = ms => new Promise(r => setTimeout(r, ms));
let waitFor = async function waitFor(f) {
	while (!f()) await sleep(100 + Math.random() * 25);
	return f();
};

let waitForTimeout = async function waitFor(f, timeoutSec) {
	var totalTimeMs = 0;
	while (!f() && totalTimeMs < timeoutSec * 1000) {
		var delayMs = 100 + Math.random() * 25;
		totalTimeMs += delayMs;
		await sleep(delayMs);
	}
	return f();
};

// These functions must exist stand-alone outside Command object as this object may come from JSON without them!
function isGeneration(ctype) {
	return (ctype > CommandType.OFF && ctype < CommandType.GEN_RESERVED);
}
function isMeasurement(ctype) {
	return (ctype > CommandType.NONE_UNKNOWN && ctype < CommandType.RESERVED);
}
function isSetting(ctype) {
	return (ctype == CommandType.OFF || ctype > CommandType.SETTING_RESERVED);
}
function isValid(ctype) {
	return (isMeasurement(ctype) || isGeneration(ctype) || isSetting(ctype));
}

/**
 * Helper function to convert a value into an enum value
 * 
 * @param {type} enumtype
 * @param {number} enumvalue
 */
function Parse(enumtype, enumvalue) {
	for (var enumName in enumtype) {
		if (enumtype[enumName] == enumvalue) {
			/*jshint -W061 */
			return eval([enumtype + "." + enumName]);
		}
	}
	return null;
}

/**
 * Helper function to dump arraybuffer as hex string
 * @param {ArrayBuffer} buffer
 */
function buf2hex(buffer) { // buffer is an ArrayBuffer
	return [...new Uint8Array(buffer)]
		.map(x => x.toString(16).padStart(2, "0"))
		.join(" ");
}

function hex2buf(input) {
	if (typeof input !== "string") {
		throw new TypeError("Expected input to be a string");
	}
	var hexstr = input.replace(/\s+/g, "");
	if ((hexstr.length % 2) !== 0) {
		throw new RangeError("Expected string to be an even number of characters");
	}

	const view = new Uint8Array(hexstr.length / 2);

	for (let i = 0; i < hexstr.length; i += 2) {
		view[i / 2] = parseInt(hexstr.substring(i, i + 2), 16);
	}

	return view.buffer;
}

module.exports = { sleep, waitFor, waitForTimeout, isGeneration, isMeasurement, isSetting, isValid, Parse, buf2hex, hex2buf };
},{"./constants":7}]},{},[8])(8)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY2xhc3Nlcy9TZW5lY2FNU0MuanMiLCJjb25zdGFudHMuanMiLCJtZXRlckFwaS5qcyIsIm1ldGVyUHVibGljQVBJLmpzIiwibW9kYnVzUnR1LmpzIiwibW9kYnVzVGVzdERhdGEuanMiLCJub2RlX21vZHVsZXMvbG9nbGV2ZWwvbGliL2xvZ2xldmVsLmpzIiwic2VuZWNhTW9kYnVzLmpzIiwidXRpbHMuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyb0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0dBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdlFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xqRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDelNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0cEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCl7ZnVuY3Rpb24gcihlLG4sdCl7ZnVuY3Rpb24gbyhpLGYpe2lmKCFuW2ldKXtpZighZVtpXSl7dmFyIGM9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZTtpZighZiYmYylyZXR1cm4gYyhpLCEwKTtpZih1KXJldHVybiB1KGksITApO3ZhciBhPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIraStcIidcIik7dGhyb3cgYS5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGF9dmFyIHA9bltpXT17ZXhwb3J0czp7fX07ZVtpXVswXS5jYWxsKHAuZXhwb3J0cyxmdW5jdGlvbihyKXt2YXIgbj1lW2ldWzFdW3JdO3JldHVybiBvKG58fHIpfSxwLHAuZXhwb3J0cyxyLGUsbix0KX1yZXR1cm4gbltpXS5leHBvcnRzfWZvcih2YXIgdT1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlLGk9MDtpPHQubGVuZ3RoO2krKylvKHRbaV0pO3JldHVybiBvfXJldHVybiByfSkoKSIsIlwidXNlIHN0cmljdFwiO1xyXG5cclxuLyoqXHJcbiAqICBCbHVldG9vdGggaGFuZGxpbmcgbW9kdWxlLCBpbmNsdWRpbmcgbWFpbiBzdGF0ZSBtYWNoaW5lIGxvb3AuXHJcbiAqICBUaGlzIG1vZHVsZSBpbnRlcmFjdHMgd2l0aCBicm93c2VyIGZvciBibHVldG9vdGggY29tdW5pY2F0aW9ucyBhbmQgcGFpcmluZywgYW5kIHdpdGggU2VuZWNhTVNDIG9iamVjdC5cclxuICovXHJcblxyXG52YXIgQVBJU3RhdGUgPSByZXF1aXJlKFwiLi9jbGFzc2VzL0FQSVN0YXRlXCIpO1xyXG52YXIgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKFwiLi91dGlsc1wiKTtcclxudmFyIHNlbmVjYU1vZHVsZSA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvU2VuZWNhTVNDXCIpO1xyXG52YXIgbW9kYnVzID0gcmVxdWlyZShcIi4vbW9kYnVzUnR1XCIpO1xyXG52YXIgdGVzdERhdGEgPSByZXF1aXJlKFwiLi9tb2RidXNUZXN0RGF0YVwiKTtcclxuXHJcbnZhciBidFN0YXRlID0gQVBJU3RhdGUuYnRTdGF0ZTtcclxudmFyIFN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbnZhciBSZXN1bHRDb2RlID0gY29uc3RhbnRzLlJlc3VsdENvZGU7XHJcbnZhciBzaW11bGF0aW9uID0gZmFsc2U7XHJcbnZhciBsb2dnaW5nID0gZmFsc2U7XHJcbi8qXHJcbiAqIEJsdWV0b290aCBjb25zdGFudHNcclxuICovXHJcbmNvbnN0IEJsdWVUb290aE1TQyA9IHtcclxuXHRTZXJ2aWNlVXVpZDogXCIwMDAzY2RkMC0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzFcIiwgLy8gYmx1ZXRvb3RoIG1vZGJ1cyBSVFUgc2VydmljZSBmb3IgU2VuZWNhIE1TQ1xyXG5cdE1vZGJ1c0Fuc3dlclV1aWQ6IFwiMDAwM2NkZDEtMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxXCIsICAgICAvLyBtb2RidXMgUlRVIGFuc3dlcnNcclxuXHRNb2RidXNSZXF1ZXN0VXVpZDogXCIwMDAzY2RkMi0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzFcIiAgICAvLyBtb2RidXMgUlRVIHJlcXVlc3RzXHJcbn07XHJcblxyXG5cclxuLyoqXHJcbiAqIFNlbmQgdGhlIG1lc3NhZ2UgdXNpbmcgQmx1ZXRvb3RoIGFuZCB3YWl0IGZvciBhbiBhbnN3ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gY29tbWFuZCBtb2RidXMgUlRVIHBhY2tldCB0byBzZW5kXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gdGhlIG1vZGJ1cyBSVFUgYW5zd2VyXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBTZW5kQW5kUmVzcG9uc2UoY29tbWFuZCkge1xyXG5cclxuXHRpZiAoY29tbWFuZCA9PSBudWxsKVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblxyXG5cdGxvZy5kZWJ1ZyhcIj4+IFwiICsgdXRpbHMuYnVmMmhleChjb21tYW5kKSk7XHJcblxyXG5cdGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cdGJ0U3RhdGUuc3RhdHNbXCJyZXF1ZXN0c1wiXSsrO1xyXG5cclxuXHR2YXIgc3RhcnRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblx0aWYgKHNpbXVsYXRpb24pIHtcclxuXHRcdGJ0U3RhdGUucmVzcG9uc2UgPSBmYWtlUmVzcG9uc2UoY29tbWFuZCk7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCg1KTtcclxuXHR9XHJcblx0ZWxzZSB7XHJcblx0XHRhd2FpdCBidFN0YXRlLmNoYXJXcml0ZS53cml0ZVZhbHVlV2l0aG91dFJlc3BvbnNlKGNvbW1hbmQpO1xyXG5cdFx0d2hpbGUgKGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuTUVURVJfSU5JVElBTElaSU5HIHx8XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuQlVTWSkge1xyXG5cdFx0XHRpZiAoYnRTdGF0ZS5yZXNwb25zZSAhPSBudWxsKSBicmVhaztcclxuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDM1KSk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHR2YXIgZW5kVGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG5cclxuXHR2YXIgYW5zd2VyID0gYnRTdGF0ZS5yZXNwb25zZT8uc2xpY2UoKTtcclxuXHRidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuXHJcblx0Ly8gTG9nIHRoZSBwYWNrZXRzXHJcblx0aWYgKGxvZ2dpbmcpIHtcclxuXHRcdHZhciBwYWNrZXQgPSB7IFwicmVxdWVzdFwiOiB1dGlscy5idWYyaGV4KGNvbW1hbmQpLCBcImFuc3dlclwiOiB1dGlscy5idWYyaGV4KGFuc3dlcikgfTtcclxuXHRcdHZhciBwYWNrZXRzID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKFwiTW9kYnVzUlRVdHJhY2VcIik7XHJcblx0XHRpZiAocGFja2V0cyA9PSBudWxsKSB7XHJcblx0XHRcdHBhY2tldHMgPSBbXTsgLy8gaW5pdGlhbGl6ZSBhcnJheVxyXG5cdFx0fVxyXG5cdFx0ZWxzZSB7XHJcblx0XHRcdHBhY2tldHMgPSBKU09OLnBhcnNlKHBhY2tldHMpOyAvLyBSZXN0b3JlIHRoZSBqc29uIHBlcnNpc3RlZCBvYmplY3RcclxuXHRcdH1cclxuXHRcdHBhY2tldHMucHVzaChwYWNrZXQpOyAvLyBBZGQgdGhlIG5ldyBvYmplY3RcclxuXHRcdHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbShcIk1vZGJ1c1JUVXRyYWNlXCIsIEpTT04uc3RyaW5naWZ5KHBhY2tldHMpKTtcclxuXHR9XHJcblxyXG5cdGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKCgxLjAgKiBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdICogKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgKGVuZFRpbWUgLSBzdGFydFRpbWUpKSAvICgoYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSAlIDUwMCkgKyAxKSk7XHJcblx0YnRTdGF0ZS5zdGF0c1tcImxhc3RSZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKGVuZFRpbWUgLSBzdGFydFRpbWUpICsgXCIgbXNcIjtcclxuXHRidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VzXCJdKys7XHJcblxyXG5cdHJldHVybiBhbnN3ZXI7XHJcbn1cclxuXHJcbmxldCBzZW5lY2FNU0MgPSBuZXcgc2VuZWNhTW9kdWxlLlNlbmVjYU1TQyhTZW5kQW5kUmVzcG9uc2UpO1xyXG5cclxuLyoqXHJcbiAqIE1haW4gbG9vcCBvZiB0aGUgbWV0ZXIgaGFuZGxlci5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gc3RhdGVNYWNoaW5lKCkge1xyXG5cdHZhciBuZXh0QWN0aW9uO1xyXG5cdHZhciBERUxBWV9NUyA9IChzaW11bGF0aW9uID8gMjAgOiA3NTApOyAvLyBVcGRhdGUgdGhlIHN0YXR1cyBldmVyeSBYIG1zLlxyXG5cdHZhciBUSU1FT1VUX01TID0gKHNpbXVsYXRpb24gPyAxMDAwIDogMzAwMDApOyAvLyBHaXZlIHVwIHNvbWUgb3BlcmF0aW9ucyBhZnRlciBYIG1zLlxyXG5cdGJ0U3RhdGUuc3RhcnRlZCA9IHRydWU7XHJcblxyXG5cdGxvZy5kZWJ1ZyhcIkN1cnJlbnQgc3RhdGU6XCIgKyBidFN0YXRlLnN0YXRlKTtcclxuXHJcblx0Ly8gQ29uc2VjdXRpdmUgc3RhdGUgY291bnRlZC4gQ2FuIGJlIHVzZWQgdG8gdGltZW91dC5cclxuXHRpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBidFN0YXRlLnByZXZfc3RhdGUpIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGVfY3B0Kys7XHJcblx0fSBlbHNlIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHR9XHJcblxyXG5cdC8vIFN0b3AgcmVxdWVzdCBmcm9tIEFQSVxyXG5cdGlmIChidFN0YXRlLnN0b3BSZXF1ZXN0KSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBJTkc7XHJcblx0fVxyXG5cclxuXHRsb2cuZGVidWcoXCJTdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG5cdHN3aXRjaCAoYnRTdGF0ZS5zdGF0ZSkge1xyXG5cdGNhc2UgU3RhdGUuTk9UX0NPTk5FQ1RFRDogLy8gaW5pdGlhbCBzdGF0ZSBvbiBTdGFydCgpXHJcblx0XHRpZiAoc2ltdWxhdGlvbikge1xyXG5cdFx0XHRuZXh0QWN0aW9uID0gZmFrZVBhaXJEZXZpY2U7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRuZXh0QWN0aW9uID0gYnRQYWlyRGV2aWNlO1xyXG5cdFx0fVxyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5DT05ORUNUSU5HOiAvLyB3YWl0aW5nIGZvciBjb25uZWN0aW9uIHRvIGNvbXBsZXRlXHJcblx0XHRuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOiAvLyBjb25uZWN0aW9uIGNvbXBsZXRlLCBhY3F1aXJlIG1ldGVyIHN0YXRlXHJcblx0XHRpZiAoc2ltdWxhdGlvbikge1xyXG5cdFx0XHRuZXh0QWN0aW9uID0gZmFrZVN1YnNjcmliZTtcclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdG5leHRBY3Rpb24gPSBidFN1YnNjcmliZTtcclxuXHRcdH1cclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6IC8vIHdhaXRpbmcgZm9yIEJsdWV0b290aCBpbnRlcmZhY2VzXHJcblx0XHRuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG5cdFx0aWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuXHRcdFx0Ly8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcblx0XHRcdGxvZy53YXJuKFwiVGltZW91dCBpbiBTVUJTQ1JJQklOR1wiKTtcclxuXHRcdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHRcdH1cclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuTUVURVJfSU5JVDogLy8gcmVhZHkgdG8gY29tbXVuaWNhdGUsIGFjcXVpcmUgbWV0ZXIgc3RhdHVzXHJcblx0XHRuZXh0QWN0aW9uID0gbWV0ZXJJbml0O1xyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc6IC8vIHJlYWRpbmcgdGhlIG1ldGVyIHN0YXR1c1xyXG5cdFx0aWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuXHRcdFx0bG9nLndhcm4oXCJUaW1lb3V0IGluIE1FVEVSX0lOSVRJQUxJWklOR1wiKTtcclxuXHRcdFx0Ly8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcblx0XHRcdGlmIChzaW11bGF0aW9uKSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGZha2VTdWJzY3JpYmU7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHRcdH1cclxuXHRcdG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLklETEU6IC8vIHJlYWR5IHRvIHByb2Nlc3MgY29tbWFuZHMgZnJvbSBBUElcclxuXHRcdGlmIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbClcclxuXHRcdFx0bmV4dEFjdGlvbiA9IHByb2Nlc3NDb21tYW5kO1xyXG5cdFx0ZWxzZSB7XHJcblx0XHRcdG5leHRBY3Rpb24gPSByZWZyZXNoO1xyXG5cdFx0fVxyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5FUlJPUjogLy8gYW55dGltZSBhbiBlcnJvciBoYXBwZW5zXHJcblx0XHRuZXh0QWN0aW9uID0gZGlzY29ubmVjdDtcclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuQlVTWTogLy8gd2hpbGUgYSBjb21tYW5kIGluIGdvaW5nIG9uXHJcblx0XHRpZiAoYnRTdGF0ZS5zdGF0ZV9jcHQgPiAoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG5cdFx0XHRsb2cud2FybihcIlRpbWVvdXQgaW4gQlVTWVwiKTtcclxuXHRcdFx0Ly8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcblx0XHRcdGlmIChzaW11bGF0aW9uKSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGZha2VTdWJzY3JpYmU7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHRcdH1cclxuXHRcdG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLlNUT1BQSU5HOlxyXG5cdFx0bmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLlNUT1BQRUQ6IC8vIGFmdGVyIGEgZGlzY29ubmVjdG9yIG9yIFN0b3AoKSByZXF1ZXN0LCBzdG9wcyB0aGUgc3RhdGUgbWFjaGluZS5cclxuXHRcdG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcblx0XHRicmVhaztcclxuXHRkZWZhdWx0OlxyXG5cdFx0YnJlYWs7XHJcblx0fVxyXG5cclxuXHRidFN0YXRlLnByZXZfc3RhdGUgPSBidFN0YXRlLnN0YXRlO1xyXG5cclxuXHRpZiAobmV4dEFjdGlvbiAhPSB1bmRlZmluZWQpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdEV4ZWN1dGluZzpcIiArIG5leHRBY3Rpb24ubmFtZSk7XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCBuZXh0QWN0aW9uKCk7XHJcblx0XHR9XHJcblx0XHRjYXRjaCAoZSkge1xyXG5cdFx0XHRsb2cuZXJyb3IoXCJFeGNlcHRpb24gaW4gc3RhdGUgbWFjaGluZVwiLCBlKTtcclxuXHRcdH1cclxuXHR9XHJcblx0aWYgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCkge1xyXG5cdFx0dXRpbHMuc2xlZXAoREVMQVlfTVMpLnRoZW4oKCkgPT4gc3RhdGVNYWNoaW5lKCkpOyAvLyBSZWNoZWNrIHN0YXR1cyBpbiBERUxBWV9NUyBtc1xyXG5cdH1cclxuXHRlbHNlIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFRlcm1pbmF0aW5nIFN0YXRlIG1hY2hpbmVcIik7XHJcblx0XHRidFN0YXRlLnN0YXJ0ZWQgPSBmYWxzZTtcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDYWxsZWQgZnJvbSBzdGF0ZSBtYWNoaW5lIHRvIGV4ZWN1dGUgYSBzaW5nbGUgY29tbWFuZCBmcm9tIGJ0U3RhdGUuY29tbWFuZCBwcm9wZXJ0eVxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZCgpIHtcclxuXHR0cnkge1xyXG5cdFx0dmFyIGNvbW1hbmQgPSBidFN0YXRlLmNvbW1hbmQ7XHJcblx0XHR2YXIgcmVzdWx0ID0gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cclxuXHRcdGlmIChjb21tYW5kID09IG51bGwpIHtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkJVU1k7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiY29tbWFuZHNcIl0rKztcclxuXHJcblx0XHRsb2cuaW5mbyhcIlxcdFxcdEV4ZWN1dGluZyBjb21tYW5kIDpcIiArIGNvbW1hbmQpO1xyXG5cclxuXHRcdC8vIEZpcnN0IHNldCBOT05FIGJlY2F1c2Ugd2UgZG9uJ3Qgd2FudCB0byB3cml0ZSBuZXcgc2V0cG9pbnRzIHdpdGggYWN0aXZlIGdlbmVyYXRpb25cclxuXHRcdHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy5zd2l0Y2hPZmYoKTtcclxuXHRcdGlmIChyZXN1bHQgIT0gUmVzdWx0Q29kZS5TVUNDRVNTKSB7XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBzd2l0Y2ggbWV0ZXIgb2ZmIGJlZm9yZSBjb21tYW5kIHdyaXRlIVwiKTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBOb3cgd3JpdGUgdGhlIHNldHBvaW50IG9yIHNldHRpbmdcclxuXHRcdGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSB7XHJcblx0XHRcdHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy53cml0ZVNldHBvaW50cyhjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuXHRcdFx0aWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJGYWlsdXJlIHRvIHdyaXRlIHNldHBvaW50cyFcIik7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHJcblx0XHRpZiAoIXV0aWxzLmlzU2V0dGluZyhjb21tYW5kLnR5cGUpICYmXHJcbiAgICAgICAgICAgIHV0aWxzLmlzVmFsaWQoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSAgLy8gSUYgdGhpcyBpcyBhIHNldHRpbmcsIHdlJ3JlIGRvbmUuXHJcblx0XHR7XHJcblx0XHRcdC8vIE5vdyB3cml0ZSB0aGUgbW9kZSBzZXRcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgc2VuZWNhTVNDLmNoYW5nZU1vZGUoY29tbWFuZC50eXBlKTtcclxuXHRcdFx0aWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJGYWlsdXJlIHRvIGNoYW5nZSBtZXRlciBtb2RlIVwiKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cclxuXHRcdC8vIENhbGxlciBleHBlY3RzIGEgdmFsaWQgcHJvcGVydHkgaW4gR2V0U3RhdGUoKSBvbmNlIGNvbW1hbmQgaXMgZXhlY3V0ZWQuXHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcblx0XHRhd2FpdCByZWZyZXNoKCk7XHJcblxyXG5cdFx0Y29tbWFuZC5lcnJvciA9IGZhbHNlO1xyXG5cdFx0Y29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcblx0XHRidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0Q29tcGxldGVkIGNvbW1hbmQgZXhlY3V0ZWRcIik7XHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy5lcnJvcihcIioqIGVycm9yIHdoaWxlIGV4ZWN1dGluZyBjb21tYW5kOiBcIiArIGVycik7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcblx0XHRpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG5cdFx0XHRidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG5cdFx0cmV0dXJuO1xyXG5cdH1cclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0RXhwZWN0ZWRTdGF0ZUhleCgpIHtcclxuXHQvLyBTaW11bGF0ZSBjdXJyZW50IG1vZGUgYW5zd2VyIGFjY29yZGluZyB0byBsYXN0IGNvbW1hbmQuXHJcblx0dmFyIHN0YXRlSGV4ID0gKENvbW1hbmRUeXBlLk9GRikudG9TdHJpbmcoMTYpO1xyXG5cdGlmIChidFN0YXRlLmNvbW1hbmQ/LnR5cGUgIT0gbnVsbCkge1xyXG5cdFx0c3RhdGVIZXggPSAoYnRTdGF0ZS5jb21tYW5kLnR5cGUpLnRvU3RyaW5nKDE2KTtcclxuXHR9XHJcblx0Ly8gQWRkIHRyYWlsaW5nIDBcclxuXHR3aGlsZSAoc3RhdGVIZXgubGVuZ3RoIDwgMilcclxuXHRcdHN0YXRlSGV4ID0gXCIwXCIgKyBzdGF0ZUhleDtcclxuXHRyZXR1cm4gc3RhdGVIZXg7XHJcbn1cclxuLyoqXHJcbiAqIFVzZWQgdG8gc2ltdWxhdGUgUlRVIGFuc3dlcnNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gY29tbWFuZCByZWFsIHJlcXVlc3RcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBmYWtlIGFuc3dlclxyXG4gKi9cclxuZnVuY3Rpb24gZmFrZVJlc3BvbnNlKGNvbW1hbmQpIHtcclxuXHR2YXIgY29tbWFuZEhleCA9IHV0aWxzLmJ1ZjJoZXgoY29tbWFuZCk7XHJcblx0dmFyIGZvcmdlZEFuc3dlcnMgPSB7XHJcblx0XHRcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCI6IFwiMTkgMDMgMDIgMDBcIiArIGdldEV4cGVjdGVkU3RhdGVIZXgoKSArIFwiICQkJCRcIiwgLy8gQ3VycmVudCBzdGF0ZVxyXG5cdFx0XCJkZWZhdWx0IDAzXCI6IFwiMTkgMDMgMDYgMDAwMSAwMDAxIDAwMDEgJCQkJFwiLCAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMzXHJcblx0XHRcImRlZmF1bHQgMTBcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwMDAxIDAwMDEgJCQkJFwiXHJcblx0fTsgLy8gZGVmYXVsdCBhbnN3ZXIgZm9yIEZDMTBcclxuXHJcblx0Ly8gU3RhcnQgd2l0aCB0aGUgZGVmYXVsdCBhbnN3ZXJcclxuXHR2YXIgcmVzcG9uc2VIZXggPSBmb3JnZWRBbnN3ZXJzW1wiZGVmYXVsdCBcIiArIGNvbW1hbmRIZXguc3BsaXQoXCIgXCIpWzFdXTtcclxuXHJcblx0Ly8gRG8gd2UgaGF2ZSBhIGZvcmdlZCBhbnN3ZXI/XHJcblx0aWYgKGZvcmdlZEFuc3dlcnNbY29tbWFuZEhleF0gIT0gdW5kZWZpbmVkKSB7XHJcblx0XHRyZXNwb25zZUhleCA9IGZvcmdlZEFuc3dlcnNbY29tbWFuZEhleF07XHJcblx0fVxyXG5cdGVsc2Uge1xyXG5cdFx0Ly8gTG9vayBpbnRvIHJlZ2lzdGVyZWQgdHJhY2VzXHJcblx0XHR2YXIgZm91bmQgPSBbXTtcclxuXHRcdGZvciAoY29uc3QgdHJhY2Ugb2YgdGVzdERhdGEudGVzdFRyYWNlcykge1xyXG5cdFx0XHRpZiAodHJhY2VbXCJyZXF1ZXN0XCJdID09PSBjb21tYW5kSGV4KSB7XHJcblx0XHRcdFx0Zm91bmQucHVzaCh0cmFjZVtcImFuc3dlclwiXSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdGlmIChmb3VuZC5sZW5ndGggPiAwKSB7XHJcblx0XHRcdC8vIFNlbGVjdCBhIHJhbmRvbSBhbnN3ZXIgZnJvbSB0aGUgcmVnaXN0ZXJlZCB0cmFjZVxyXG5cdFx0XHRyZXNwb25zZUhleCA9IGZvdW5kW01hdGguZmxvb3IoKE1hdGgucmFuZG9tKCkgKiBmb3VuZC5sZW5ndGgpKV07XHJcblx0XHR9XHJcblx0XHRlbHNlIHtcclxuXHRcdFx0Y29uc29sZS5pbmZvKGNvbW1hbmRIZXggKyBcIiBub3QgZm91bmQgaW4gdGVzdCB0cmFjZXNcIik7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHQvLyBDb21wdXRlIENSQyBpZiBuZWVkZWRcclxuXHRpZiAocmVzcG9uc2VIZXguaW5jbHVkZXMoXCIkJCQkXCIpKSB7XHJcblx0XHRyZXNwb25zZUhleCA9IHJlc3BvbnNlSGV4LnJlcGxhY2UoXCIkJCQkXCIsIFwiXCIpO1xyXG5cdFx0dmFyIGNyYyA9IG1vZGJ1cy5jcmMxNihuZXcgVWludDhBcnJheSh1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KSkpLnRvU3RyaW5nKDE2KTtcclxuXHRcdHdoaWxlIChjcmMubGVuZ3RoIDwgNClcclxuXHRcdFx0Y3JjID0gXCIwXCIgKyBjcmM7XHJcblx0XHRyZXNwb25zZUhleCA9IHJlc3BvbnNlSGV4ICsgY3JjLnN1YnN0cmluZygyLCA0KSArIGNyYy5zdWJzdHJpbmcoMCwgMik7XHJcblx0fVxyXG5cclxuXHRsb2cuZGVidWcoXCI8PCBcIiArIHJlc3BvbnNlSGV4KTtcclxuXHRyZXR1cm4gdXRpbHMuaGV4MmJ1ZihyZXNwb25zZUhleCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBY3F1aXJlIHRoZSBjdXJyZW50IG1vZGUgYW5kIHNlcmlhbCBudW1iZXIgb2YgdGhlIGRldmljZS5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gbWV0ZXJJbml0KCkge1xyXG5cdHRyeSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVElBTElaSU5HO1xyXG5cdFx0YnRTdGF0ZS5tZXRlci5zZXJpYWwgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0U2VyaWFsTnVtYmVyKCk7XHJcblx0XHRsb2cuaW5mbyhcIlxcdFxcdFNlcmlhbCBudW1iZXI6XCIgKyBidFN0YXRlLm1ldGVyLnNlcmlhbCk7XHJcblxyXG5cdFx0YnRTdGF0ZS5tZXRlci5tb2RlID0gYXdhaXQgc2VuZWNhTVNDLmdldEN1cnJlbnRNb2RlKCk7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRDdXJyZW50IG1vZGU6XCIgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cclxuXHRcdGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSA9IGF3YWl0IHNlbmVjYU1TQy5nZXRCYXR0ZXJ5Vm9sdGFnZSgpO1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0QmF0dGVyeSAoVik6XCIgKyBidFN0YXRlLm1ldGVyLmJhdHRlcnkpO1xyXG5cclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIkVycm9yIHdoaWxlIGluaXRpYWxpemluZyBtZXRlciA6XCIgKyBlcnIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0aWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuXHRcdFx0YnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbi8qXHJcbiAqIENsb3NlIHRoZSBibHVldG9vdGggaW50ZXJmYWNlICh1bnBhaXIpXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGRpc2Nvbm5lY3QoKSB7XHJcblx0YnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuXHR0cnkge1xyXG5cdFx0aWYgKGJ0U3RhdGUuYnREZXZpY2UgIT0gbnVsbCkge1xyXG5cdFx0XHRpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcblx0XHRcdFx0bG9nLndhcm4oXCIqIENhbGxpbmcgZGlzY29ubmVjdCBvbiBidGRldmljZVwiKTtcclxuXHRcdFx0XHQvLyBBdm9pZCB0aGUgZXZlbnQgZmlyaW5nIHdoaWNoIG1heSBsZWFkIHRvIGF1dG8tcmVjb25uZWN0XHJcblx0XHRcdFx0YnRTdGF0ZS5idERldmljZS5yZW1vdmVFdmVudExpc3RlbmVyKFwiZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZFwiLCBvbkRpc2Nvbm5lY3RlZCk7XHJcblx0XHRcdFx0YnRTdGF0ZS5idERldmljZS5nYXR0LmRpc2Nvbm5lY3QoKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG5cdH1cclxuXHRjYXRjaCB7IH1cclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBFRDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBicm93c2VyIEJUIGFwaSB3aGVuIHRoZSBkZXZpY2UgZGlzY29ubmVjdFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBvbkRpc2Nvbm5lY3RlZCgpIHtcclxuXHRsb2cud2FybihcIiogR0FUVCBTZXJ2ZXIgZGlzY29ubmVjdGVkIGV2ZW50LCB3aWxsIHRyeSB0byByZWNvbm5lY3QgKlwiKTtcclxuXHRidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcblx0YnRTdGF0ZS5zdGF0c1tcIkdBVFQgZGlzY29ubmVjdHNcIl0rKztcclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDsgLy8gVHJ5IHRvIGF1dG8tcmVjb25uZWN0IHRoZSBpbnRlcmZhY2VzIHdpdGhvdXQgcGFpcmluZ1xyXG59XHJcblxyXG4vKipcclxuICogSm9pbnMgdGhlIGFyZ3VtZW50cyBpbnRvIGEgc2luZ2xlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7QnVmZmVyfSBjb25jYXRlbmF0ZWQgYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBhcnJheUJ1ZmZlckNvbmNhdCgpIHtcclxuXHR2YXIgbGVuZ3RoID0gMDtcclxuXHR2YXIgYnVmZmVyID0gbnVsbDtcclxuXHJcblx0Zm9yICh2YXIgaSBpbiBhcmd1bWVudHMpIHtcclxuXHRcdGJ1ZmZlciA9IGFyZ3VtZW50c1tpXTtcclxuXHRcdGxlbmd0aCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuXHR9XHJcblxyXG5cdHZhciBqb2luZWQgPSBuZXcgVWludDhBcnJheShsZW5ndGgpO1xyXG5cdHZhciBvZmZzZXQgPSAwO1xyXG5cclxuXHRmb3IgKGkgaW4gYXJndW1lbnRzKSB7XHJcblx0XHRidWZmZXIgPSBhcmd1bWVudHNbaV07XHJcblx0XHRqb2luZWQuc2V0KG5ldyBVaW50OEFycmF5KGJ1ZmZlciksIG9mZnNldCk7XHJcblx0XHRvZmZzZXQgKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcblx0fVxyXG5cclxuXHRyZXR1cm4gam9pbmVkLmJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBibHVldG9vdGggY2hhcmFjdGVyaXN0aWNzIHdoZW4gcmVjZWl2aW5nIGRhdGFcclxuICogQHBhcmFtIHthbnl9IGV2ZW50XHJcbiAqL1xyXG5mdW5jdGlvbiBoYW5kbGVOb3RpZmljYXRpb25zKGV2ZW50KSB7XHJcblx0bGV0IHZhbHVlID0gZXZlbnQudGFyZ2V0LnZhbHVlO1xyXG5cdGlmICh2YWx1ZSAhPSBudWxsKSB7XHJcblx0XHRsb2cuZGVidWcoXCI8PCBcIiArIHV0aWxzLmJ1ZjJoZXgodmFsdWUuYnVmZmVyKSk7XHJcblx0XHRpZiAoYnRTdGF0ZS5yZXNwb25zZSAhPSBudWxsKSB7XHJcblx0XHRcdGJ0U3RhdGUucmVzcG9uc2UgPSBhcnJheUJ1ZmZlckNvbmNhdChidFN0YXRlLnJlc3BvbnNlLCB2YWx1ZS5idWZmZXIpO1xyXG5cdFx0fSBlbHNlIHtcclxuXHRcdFx0YnRTdGF0ZS5yZXNwb25zZSA9IHZhbHVlLmJ1ZmZlci5zbGljZSgpO1xyXG5cdFx0fVxyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFRoaXMgZnVuY3Rpb24gd2lsbCBzdWNjZWVkIG9ubHkgaWYgY2FsbGVkIGFzIGEgY29uc2VxdWVuY2Ugb2YgYSB1c2VyLWdlc3R1cmVcclxuICogRS5nLiBidXR0b24gY2xpY2suIFRoaXMgaXMgZHVlIHRvIEJsdWVUb290aCBBUEkgc2VjdXJpdHkgbW9kZWwuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0UGFpckRldmljZSgpIHtcclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuQ09OTkVDVElORztcclxuXHR2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuXHRsb2cuZGVidWcoXCJidFBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuXHR0cnkge1xyXG5cdFx0aWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0QXZhaWxhYmlsaXR5KSA9PSBcImZ1bmN0aW9uXCIpIHtcclxuXHRcdFx0Y29uc3QgYXZhaWxhYmlsaXR5ID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aC5nZXRBdmFpbGFiaWxpdHkoKTtcclxuXHRcdFx0aWYgKCFhdmFpbGFiaWxpdHkpIHtcclxuXHRcdFx0XHRsb2cuZXJyb3IoXCJCbHVldG9vdGggbm90IGF2YWlsYWJsZSBpbiBicm93c2VyLlwiKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJCcm93c2VyIGRvZXMgbm90IHByb3ZpZGUgYmx1ZXRvb3RoXCIpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHR2YXIgZGV2aWNlID0gbnVsbDtcclxuXHJcblx0XHQvLyBEbyB3ZSBhbHJlYWR5IGhhdmUgcGVybWlzc2lvbj9cclxuXHRcdGlmICh0eXBlb2YgKG5hdmlnYXRvci5ibHVldG9vdGg/LmdldERldmljZXMpID09IFwiZnVuY3Rpb25cIlxyXG4gICAgICAgICAgICAmJiAhZm9yY2VTZWxlY3Rpb24pIHtcclxuXHRcdFx0Y29uc3QgYXZhaWxhYmxlRGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0RGV2aWNlcygpO1xyXG5cdFx0XHRhdmFpbGFibGVEZXZpY2VzLmZvckVhY2goZnVuY3Rpb24gKGRldiwgaW5kZXgpIHtcclxuXHRcdFx0XHRsb2cuZGVidWcoXCJGb3VuZCBhdXRob3JpemVkIGRldmljZSA6XCIgKyBkZXYubmFtZSk7XHJcblx0XHRcdFx0aWYgKGRldi5uYW1lLnN0YXJ0c1dpdGgoXCJNU0NcIikpXHJcblx0XHRcdFx0XHRkZXZpY2UgPSBkZXY7XHJcblx0XHRcdH0pO1xyXG5cdFx0XHRsb2cuZGVidWcoXCJuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKT1cIiArIGRldmljZSk7XHJcblx0XHR9XHJcblx0XHQvLyBJZiBub3QsIHJlcXVlc3QgZnJvbSB1c2VyXHJcblx0XHRpZiAoZGV2aWNlID09IG51bGwpIHtcclxuXHRcdFx0ZGV2aWNlID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aFxyXG5cdFx0XHRcdC5yZXF1ZXN0RGV2aWNlKHtcclxuXHRcdFx0XHRcdGFjY2VwdEFsbERldmljZXM6IGZhbHNlLFxyXG5cdFx0XHRcdFx0ZmlsdGVyczogW3sgbmFtZVByZWZpeDogXCJNU0NcIiB9XSxcclxuXHRcdFx0XHRcdG9wdGlvbmFsU2VydmljZXM6IFtCbHVlVG9vdGhNU0MuU2VydmljZVV1aWRdXHJcblx0XHRcdFx0fSk7XHJcblx0XHR9XHJcblx0XHRidFN0YXRlLmJ0RGV2aWNlID0gZGV2aWNlO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcblx0XHRsb2cuaW5mbyhcIkJsdWV0b290aCBkZXZpY2UgXCIgKyBkZXZpY2UubmFtZSArIFwiIGNvbm5lY3RlZC5cIik7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCg1MDApO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG5cdFx0aWYgKGJ0U3RhdGUuY2hhclJlYWQgIT0gbnVsbCkge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHsgfVxyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuRVJST1I7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZmFrZVBhaXJEZXZpY2UoKSB7XHJcblx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcblx0dmFyIGZvcmNlU2VsZWN0aW9uID0gYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl07XHJcblx0bG9nLmRlYnVnKFwiZmFrZVBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuXHR0cnkge1xyXG5cdFx0dmFyIGRldmljZSA9IHsgbmFtZTogXCJGYWtlQlREZXZpY2VcIiwgZ2F0dDogeyBjb25uZWN0ZWQ6IHRydWUgfSB9O1xyXG5cdFx0YnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0bG9nLmluZm8oXCJCbHVldG9vdGggZGV2aWNlIFwiICsgZGV2aWNlLm5hbWUgKyBcIiBjb25uZWN0ZWQuXCIpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoNTApO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuRVJST1I7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIE9uY2UgdGhlIGRldmljZSBpcyBhdmFpbGFibGUsIGluaXRpYWxpemUgdGhlIHNlcnZpY2UgYW5kIHRoZSAyIGNoYXJhY3RlcmlzdGljcyBuZWVkZWQuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0U3Vic2NyaWJlKCkge1xyXG5cdHRyeSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1VCU0NSSUJJTkc7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wic3ViY3JpYmVzXCJdKys7XHJcblx0XHRsZXQgZGV2aWNlID0gYnRTdGF0ZS5idERldmljZTtcclxuXHRcdGxldCBzZXJ2ZXIgPSBudWxsO1xyXG5cclxuXHRcdGlmICghZGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuXHRcdFx0bG9nLmRlYnVnKGBDb25uZWN0aW5nIHRvIEdBVFQgU2VydmVyIG9uICR7ZGV2aWNlLm5hbWV9Li4uYCk7XHJcblx0XHRcdGRldmljZS5hZGRFdmVudExpc3RlbmVyKFwiZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZFwiLCBvbkRpc2Nvbm5lY3RlZCk7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0aWYgKGJ0U3RhdGUuYnRTZXJ2aWNlPy5jb25uZWN0ZWQpIHtcclxuXHRcdFx0XHRcdGJ0U3RhdGUuYnRTZXJ2aWNlLmRpc2Nvbm5lY3QoKTtcclxuXHRcdFx0XHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuXHRcdFx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHsgfVxyXG5cclxuXHRcdFx0c2VydmVyID0gYXdhaXQgZGV2aWNlLmdhdHQuY29ubmVjdCgpO1xyXG5cdFx0XHRsb2cuZGVidWcoXCI+IEZvdW5kIEdBVFQgc2VydmVyXCIpO1xyXG5cdFx0fVxyXG5cdFx0ZWxzZSB7XHJcblx0XHRcdGxvZy5kZWJ1ZyhcIkdBVFQgYWxyZWFkeSBjb25uZWN0ZWRcIik7XHJcblx0XHRcdHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG5cdFx0fVxyXG5cclxuXHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0gYXdhaXQgc2VydmVyLmdldFByaW1hcnlTZXJ2aWNlKEJsdWVUb290aE1TQy5TZXJ2aWNlVXVpZCk7XHJcblx0XHRpZiAoYnRTdGF0ZS5idFNlcnZpY2UgPT0gbnVsbClcclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiR0FUVCBTZXJ2aWNlIHJlcXVlc3QgZmFpbGVkXCIpO1xyXG5cdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCBTZXJpYWwgc2VydmljZVwiKTtcclxuXHRcdGJ0U3RhdGUuY2hhcldyaXRlID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c1JlcXVlc3RVdWlkKTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgd3JpdGUgY2hhcmFjdGVyaXN0aWNcIik7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c0Fuc3dlclV1aWQpO1xyXG5cdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljXCIpO1xyXG5cdFx0YnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFyYWN0ZXJpc3RpY3ZhbHVlY2hhbmdlZFwiLCBoYW5kbGVOb3RpZmljYXRpb25zKTtcclxuXHRcdGJ0U3RhdGUuY2hhclJlYWQuc3RhcnROb3RpZmljYXRpb25zKCk7XHJcblx0XHRsb2cuaW5mbyhcIj4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuXCIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuXHRcdGF3YWl0IHV0aWxzLnNsZWVwKDUwKTtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIioqIGVycm9yIHdoaWxlIHN1YnNjcmliaW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuXHRcdGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcblx0XHRcdFx0XHRidFN0YXRlLmNoYXJSZWFkLnN0b3BOb3RpZmljYXRpb25zKCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQuZGlzY29ubmVjdCgpO1xyXG5cdFx0XHR9IGNhdGNoIChlcnJvcikgeyB9XHJcblx0XHR9XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZha2VTdWJzY3JpYmUoKSB7XHJcblx0dHJ5IHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVUJTQ1JJQklORztcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJzdWJjcmliZXNcIl0rKztcclxuXHRcdGxldCBkZXZpY2UgPSBidFN0YXRlLmJ0RGV2aWNlO1xyXG5cdFx0bGV0IHNlcnZlciA9IG51bGw7XHJcblxyXG5cdFx0aWYgKCFkZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG5cdFx0XHRsb2cuZGVidWcoYENvbm5lY3RpbmcgdG8gR0FUVCBTZXJ2ZXIgb24gJHtkZXZpY2UubmFtZX0uLi5gKTtcclxuXHRcdFx0ZGV2aWNlW1wiZ2F0dFwiXVtcImNvbm5lY3RlZFwiXSA9IHRydWU7XHJcblx0XHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgR0FUVCBzZXJ2ZXJcIik7XHJcblx0XHR9XHJcblx0XHRlbHNlIHtcclxuXHRcdFx0bG9nLmRlYnVnKFwiR0FUVCBhbHJlYWR5IGNvbm5lY3RlZFwiKTtcclxuXHRcdFx0c2VydmVyID0gZGV2aWNlLmdhdHQ7XHJcblx0XHR9XHJcblxyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSB7fTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgU2VyaWFsIHNlcnZpY2VcIik7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IHt9O1xyXG5cdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCB3cml0ZSBjaGFyYWN0ZXJpc3RpY1wiKTtcclxuXHRcdGJ0U3RhdGUuY2hhclJlYWQgPSB7fTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgcmVhZCBjaGFyYWN0ZXJpc3RpY1wiKTtcclxuXHRcdGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cdFx0bG9nLmluZm8oXCI+IEJsdWV0b290aCBpbnRlcmZhY2VzIHJlYWR5LlwiKTtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJsYXN0X2Nvbm5lY3RcIl0gPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMCk7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogV2hlbiBpZGxlLCB0aGlzIGZ1bmN0aW9uIGlzIGNhbGxlZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKCkge1xyXG5cdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG5cdHRyeSB7XHJcblx0XHQvLyBDaGVjayB0aGUgbW9kZSBmaXJzdFxyXG5cdFx0dmFyIG1vZGUgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0Q3VycmVudE1vZGUoKTtcclxuXHJcblx0XHRpZiAobW9kZSAhPSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuXHRcdFx0YnRTdGF0ZS5tZXRlci5tb2RlID0gbW9kZTtcclxuXHJcblx0XHRcdGlmIChidFN0YXRlLm1ldGVyLmlzR2VuZXJhdGlvbigpKSB7XHJcblx0XHRcdFx0dmFyIHNldHBvaW50cyA9IGF3YWl0IHNlbmVjYU1TQy5nZXRTZXRwb2ludHMoYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHRcdFx0XHRidFN0YXRlLmxhc3RTZXRwb2ludCA9IHNldHBvaW50cztcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0aWYgKGJ0U3RhdGUubWV0ZXIuaXNNZWFzdXJlbWVudCgpKSB7XHJcblx0XHRcdFx0dmFyIG1lYXMgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0TWVhc3VyZXMoYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHRcdFx0XHRidFN0YXRlLmxhc3RNZWFzdXJlID0gbWVhcztcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0RmluaXNoZWQgcmVmcmVzaGluZyBjdXJyZW50IHN0YXRlXCIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgcmVmcmVzaGluZyBtZWFzdXJlXCIgKyBlcnIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdFx0aWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuXHRcdFx0YnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIFNldFNpbXVsYXRpb24odmFsdWUpIHtcclxuXHRzaW11bGF0aW9uID0gdmFsdWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBzdGF0ZU1hY2hpbmUsIFNlbmRBbmRSZXNwb25zZSwgU2V0U2ltdWxhdGlvbiB9OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi4vY29uc3RhbnRzXCIpO1xyXG52YXIgTWV0ZXJTdGF0ZSA9IHJlcXVpcmUoXCIuL01ldGVyU3RhdGVcIik7XHJcblxyXG4vLyBDdXJyZW50IHN0YXRlIG9mIHRoZSBibHVldG9vdGhcclxuY2xhc3MgQVBJU3RhdGUge1xyXG5cdGNvbnN0cnVjdG9yKCkge1xyXG5cdFx0dGhpcy5zdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG5cdFx0dGhpcy5wcmV2X3N0YXRlID0gY29uc3RhbnRzLlN0YXRlLk5PVF9DT05ORUNURUQ7XHJcblx0XHR0aGlzLnN0YXRlX2NwdCA9IDA7XHJcblxyXG5cdFx0dGhpcy5zdGFydGVkID0gZmFsc2U7IC8vIFN0YXRlIG1hY2hpbmUgc3RhdHVzXHJcblx0XHR0aGlzLnN0b3BSZXF1ZXN0ID0gZmFsc2U7IC8vIFRvIHJlcXVlc3QgZGlzY29ubmVjdFxyXG5cdFx0dGhpcy5sYXN0TWVhc3VyZSA9IHt9OyAvLyBBcnJheSB3aXRoIFwiTWVhc3VyZU5hbWVcIiA6IHZhbHVlXHJcblx0XHR0aGlzLmxhc3RTZXRwb2ludCA9IHt9OyAvLyBBcnJheSB3aXRoIFwiU2V0cG9pbnRUeXBlXCIgOiB2YWx1ZVxyXG5cclxuXHRcdC8vIHN0YXRlIG9mIGNvbm5lY3RlZCBtZXRlclxyXG5cdFx0dGhpcy5tZXRlciA9IG5ldyBNZXRlclN0YXRlKCk7XHJcblxyXG5cdFx0Ly8gbGFzdCBtb2RidXMgUlRVIGNvbW1hbmRcclxuXHRcdHRoaXMuY29tbWFuZCA9IG51bGw7XHJcblxyXG5cdFx0Ly8gbGFzdCBtb2RidXMgUlRVIGFuc3dlclxyXG5cdFx0dGhpcy5yZXNwb25zZSA9IG51bGw7XHJcblxyXG5cdFx0Ly8gYmx1ZXRvb3RoIHByb3BlcnRpZXNcclxuXHRcdHRoaXMuY2hhclJlYWQgPSBudWxsO1xyXG5cdFx0dGhpcy5jaGFyV3JpdGUgPSBudWxsO1xyXG5cdFx0dGhpcy5idFNlcnZpY2UgPSBudWxsO1xyXG5cdFx0dGhpcy5idERldmljZSA9IG51bGw7XHJcblxyXG5cdFx0Ly8gZ2VuZXJhbCBzdGF0aXN0aWNzIGZvciBkZWJ1Z2dpbmdcclxuXHRcdHRoaXMuc3RhdHMgPSB7XHJcblx0XHRcdFwicmVxdWVzdHNcIjogMCxcclxuXHRcdFx0XCJyZXNwb25zZXNcIjogMCxcclxuXHRcdFx0XCJtb2RidXNfZXJyb3JzXCI6IDAsXHJcblx0XHRcdFwiR0FUVCBkaXNjb25uZWN0c1wiOiAwLFxyXG5cdFx0XHRcImV4Y2VwdGlvbnNcIjogMCxcclxuXHRcdFx0XCJzdWJjcmliZXNcIjogMCxcclxuXHRcdFx0XCJjb21tYW5kc1wiOiAwLFxyXG5cdFx0XHRcInJlc3BvbnNlVGltZVwiOiAwLjAsXHJcblx0XHRcdFwibGFzdFJlc3BvbnNlVGltZVwiOiAwLjAsXHJcblx0XHRcdFwibGFzdF9jb25uZWN0XCI6IG5ldyBEYXRlKDIwMjAsIDEsIDEpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblxyXG5cdFx0dGhpcy5vcHRpb25zID0ge1xyXG5cdFx0XHRcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCI6IHRydWVcclxuXHRcdH07XHJcblx0fVxyXG59XHJcblxyXG5sZXQgYnRTdGF0ZSA9IG5ldyBBUElTdGF0ZSgpO1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IEFQSVN0YXRlLCBidFN0YXRlIH07IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuLi9jb25zdGFudHNcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuLi91dGlsc1wiKTtcclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5cclxuLyoqXHJcbiAqIENvbW1hbmQgdG8gdGhlIG1ldGVyLCBtYXkgaW5jbHVkZSBzZXRwb2ludFxyXG4gKiAqL1xyXG5jbGFzcyBDb21tYW5kIHtcclxuXHQvKipcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgY29tbWFuZFxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY3R5cGVcclxuICAgICAqL1xyXG5cdGNvbnN0cnVjdG9yKGN0eXBlID0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcblx0XHR0aGlzLnR5cGUgPSBwYXJzZUludChjdHlwZSk7XHJcblx0XHR0aGlzLnNldHBvaW50ID0gbnVsbDtcclxuXHRcdHRoaXMuc2V0cG9pbnQyID0gbnVsbDtcclxuXHRcdHRoaXMuZXJyb3IgPSBmYWxzZTtcclxuXHRcdHRoaXMucGVuZGluZyA9IHRydWU7XHJcblx0XHR0aGlzLnJlcXVlc3QgPSBudWxsO1xyXG5cdFx0dGhpcy5yZXNwb25zZSA9IG51bGw7XHJcblx0fVxyXG5cclxuXHRzdGF0aWMgQ3JlYXRlTm9TUChjdHlwZSkge1xyXG5cdFx0dmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuXHRcdHJldHVybiBjbWQ7XHJcblx0fVxyXG5cdHN0YXRpYyBDcmVhdGVPbmVTUChjdHlwZSwgc2V0cG9pbnQpIHtcclxuXHRcdHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcblx0XHRjbWQuc2V0cG9pbnQgPSBwYXJzZUZsb2F0KHNldHBvaW50KTtcclxuXHRcdHJldHVybiBjbWQ7XHJcblx0fVxyXG5cdHN0YXRpYyBDcmVhdGVUd29TUChjdHlwZSwgc2V0MSwgc2V0Mikge1xyXG5cdFx0dmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuXHRcdGNtZC5zZXRwb2ludCA9IHBhcnNlRmxvYXQoc2V0MSk7XHJcblx0XHRjbWQuc2V0cG9pbnQyID0gcGFyc2VGbG9hdChzZXQyKTtcclxuXHRcdHJldHVybiBjbWQ7XHJcblx0fVxyXG5cclxuXHR0b1N0cmluZygpIHtcclxuXHRcdHJldHVybiBcIlR5cGU6IFwiICsgdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIHRoaXMudHlwZSkgKyBcIiwgc2V0cG9pbnQ6XCIgKyB0aGlzLnNldHBvaW50ICsgXCIsIHNldHBvaW50MjogXCIgKyB0aGlzLnNldHBvaW50MiArIFwiLCBwZW5kaW5nOlwiICsgdGhpcy5wZW5kaW5nICsgXCIsIGVycm9yOlwiICsgdGhpcy5lcnJvcjtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogR2V0cyB0aGUgZGVmYXVsdCBzZXRwb2ludCBmb3IgdGhpcyBjb21tYW5kIHR5cGVcclxuICAgICAqIEByZXR1cm5zIHtBcnJheX0gc2V0cG9pbnQocykgZXhwZWN0ZWRcclxuICAgICAqL1xyXG5cdGRlZmF1bHRTZXRwb2ludCgpIHtcclxuXHRcdHN3aXRjaCAodGhpcy50eXBlKSB7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0XHRcdHJldHVybiB7IFwiVGVtcGVyYXR1cmUgKMKwQylcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG5cdFx0XHRyZXR1cm4geyBcIlZvbHRhZ2UgKFYpXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcblx0XHRcdHJldHVybiB7IFwiVm9sdGFnZSAobVYpXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuXHRcdFx0cmV0dXJuIHsgXCJDdXJyZW50IChtQSlcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuXHRcdFx0cmV0dXJuIHsgXCJJbWJhbGFuY2UgKG1WL1YpXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG5cdFx0XHRyZXR1cm4geyBcIkZyZXF1ZW5jeSAoSHopXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuXHRcdFx0cmV0dXJuIHsgXCJQdWxzZXMgY291bnRcIjogMCwgXCJGcmVxdWVuY3kgKEh6KVwiOiAwLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VUaHJlc2hvbGRfRjpcclxuXHRcdFx0cmV0dXJuIHsgXCJVdGhyZXNob2xkIChWKVwiOiAyLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NlbnNpdGl2aXR5X3VTOlxyXG5cdFx0XHRyZXR1cm4geyBcIlNlbnNpYmlsaXR5ICh1UylcIjogMi4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcblx0XHRcdHJldHVybiB7IFwiQ29sZCBqdW5jdGlvbiBjb21wZW5zYXRpb25cIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VbG93OlxyXG5cdFx0XHRyZXR1cm4geyBcIlUgbG93IChWKVwiOiAwLjAgLyBjb25zdGFudHMuTUFYX1VfR0VOIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VaGlnaDpcclxuXHRcdFx0cmV0dXJuIHsgXCJVIGhpZ2ggKFYpXCI6IDUuMCAvIGNvbnN0YW50cy5NQVhfVV9HRU4gfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcblx0XHRcdHJldHVybiB7IFwiRGVsYXkgKHMpXCI6IDYwICogNSB9O1xyXG5cdFx0ZGVmYXVsdDpcclxuXHRcdFx0cmV0dXJuIHt9O1xyXG5cdFx0fVxyXG5cdH1cclxuXHRpc0dlbmVyYXRpb24oKSB7XHJcblx0XHRyZXR1cm4gdXRpbHMuaXNHZW5lcmF0aW9uKHRoaXMudHlwZSk7XHJcblx0fVxyXG5cdGlzTWVhc3VyZW1lbnQoKSB7XHJcblx0XHRyZXR1cm4gdXRpbHMuaXNNZWFzdXJlbWVudCh0aGlzLnR5cGUpO1xyXG5cdH1cclxuXHRpc1NldHRpbmcoKSB7XHJcblx0XHRyZXR1cm4gdXRpbHMuaXNTZXR0aW5nKHRoaXMudHlwZSk7XHJcblx0fVxyXG5cdGlzVmFsaWQoKSB7XHJcblx0XHRyZXR1cm4gKHV0aWxzLmlzTWVhc3VyZW1lbnQodGhpcy50eXBlKSB8fCB1dGlscy5pc0dlbmVyYXRpb24odGhpcy50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcodGhpcy50eXBlKSk7XHJcblx0fVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IENvbW1hbmQ7IiwiY2xhc3MgQ29tbWFuZFJlc3VsdCB7XHJcblx0dmFsdWUgPSAwLjA7XHJcblx0c3VjY2VzcyA9IGZhbHNlO1xyXG5cdG1lc3NhZ2UgPSBcIlwiO1xyXG5cdHVuaXQgPSBcIlwiO1xyXG5cdHNlY29uZGFyeV92YWx1ZSA9IDAuMDtcclxuXHRzZWNvbmRhcnlfdW5pdCA9IFwiXCI7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ29tbWFuZFJlc3VsdDsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4uL2NvbnN0YW50c1wiKTtcclxuXHJcbi8qKlxyXG4gKiBDdXJyZW50IHN0YXRlIG9mIHRoZSBtZXRlclxyXG4gKiAqL1xyXG5jbGFzcyBNZXRlclN0YXRlIHtcclxuXHRjb25zdHJ1Y3RvcigpIHtcclxuXHRcdHRoaXMuZmlybXdhcmUgPSBcIlwiOyAvLyBGaXJtd2FyZSB2ZXJzaW9uXHJcblx0XHR0aGlzLnNlcmlhbCA9IFwiXCI7IC8vIFNlcmlhbCBudW1iZXJcclxuXHRcdHRoaXMubW9kZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV047XHJcblx0XHR0aGlzLmJhdHRlcnkgPSAwLjA7XHJcblx0fVxyXG5cclxuXHRpc01lYXN1cmVtZW50KCkge1xyXG5cdFx0cmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLk9GRjtcclxuXHR9XHJcblxyXG5cdGlzR2VuZXJhdGlvbigpIHtcclxuXHRcdHJldHVybiB0aGlzLm1vZGUgPiBjb25zdGFudHMuQ29tbWFuZFR5cGUuT0ZGICYmIHRoaXMubW9kZSA8IGNvbnN0YW50cy5Db21tYW5kVHlwZS5HRU5fUkVTRVJWRUQ7XHJcblx0fVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IE1ldGVyU3RhdGU7IiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG4vKipcclxuICogIFRoaXMgbW9kdWxlIGNvbnRhaW5zIHRoZSBTZW5lY2FNU0Mgb2JqZWN0LCB3aGljaCBwcm92aWRlcyB0aGUgbWFpbiBvcGVyYXRpb25zIGZvciBibHVldG9vdGggbW9kdWxlLlxyXG4gKiAgSXQgdXNlcyB0aGUgbW9kYnVzIGhlbHBlciBmdW5jdGlvbnMgZnJvbSBzZW5lY2FNb2RidXMgLyBtb2RidXNSdHUgdG8gaW50ZXJhY3Qgd2l0aCB0aGUgbWV0ZXIgd2l0aCBTZW5kQW5kUmVzcG9uc2UgZnVuY3Rpb25cclxuICovXHJcbnZhciBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuLi91dGlsc1wiKTtcclxudmFyIHNlbmVjYU1CID0gcmVxdWlyZShcIi4uL3NlbmVjYU1vZGJ1c1wiKTtcclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoXCIuLi9tb2RidXNSdHVcIik7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi4vY29uc3RhbnRzXCIpO1xyXG5cclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG52YXIgUmVzdWx0Q29kZSA9IGNvbnN0YW50cy5SZXN1bHRDb2RlO1xyXG5cclxuY29uc3QgUkVTRVRfUE9XRVJfT0ZGID0gNjtcclxuY29uc3QgU0VUX1BPV0VSX09GRiA9IDc7XHJcbmNvbnN0IENMRUFSX0FWR19NSU5fTUFYID0gNTtcclxuY29uc3QgUFVMU0VfQ01EID0gOTtcclxuXHJcbmNsYXNzIFNlbmVjYU1TQyB7XHJcblx0Y29uc3RydWN0b3IoZm5TZW5kQW5kUmVzcG9uc2UpIHtcclxuXHRcdHRoaXMuU2VuZEFuZFJlc3BvbnNlID0gZm5TZW5kQW5kUmVzcG9uc2U7XHJcblx0fVxyXG5cdC8qKlxyXG4gICAgICogR2V0cyB0aGUgbWV0ZXIgc2VyaWFsIG51bWJlciAoMTIzNDVfMTIzNClcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge3N0cmluZ31cclxuICAgICAqL1xyXG5cdGFzeW5jIGdldFNlcmlhbE51bWJlcigpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2VyaWFsIG51bWJlclwiKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VTZXJpYWxOdW1iZXIoKSk7XHJcblx0XHRyZXR1cm4gc2VuZWNhTUIucGFyc2VTZXJpYWxOdW1iZXIocmVzcG9uc2UpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBHZXRzIHRoZSBjdXJyZW50IG1vZGUgc2V0IG9uIHRoZSBNU0MgZGV2aWNlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtDb21tYW5kVHlwZX0gYWN0aXZlIG1vZGVcclxuICAgICAqL1xyXG5cdGFzeW5jIGdldEN1cnJlbnRNb2RlKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBjdXJyZW50IG1vZGVcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlQ3VycmVudE1vZGUoKSk7XHJcblx0XHRyZXR1cm4gc2VuZWNhTUIucGFyc2VDdXJyZW50TW9kZShyZXNwb25zZSwgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogR2V0cyB0aGUgYmF0dGVyeSB2b2x0YWdlIGZyb20gdGhlIG1ldGVyIGZvciBiYXR0ZXJ5IGxldmVsIGluZGljYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge251bWJlcn0gdm9sdGFnZSAoVilcclxuICAgICAqL1xyXG5cdGFzeW5jIGdldEJhdHRlcnlWb2x0YWdlKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBiYXR0ZXJ5IHZvbHRhZ2VcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlQmF0dGVyeUxldmVsKCkpO1xyXG5cdFx0cmV0dXJuIE1hdGgucm91bmQoc2VuZWNhTUIucGFyc2VCYXR0ZXJ5KHJlc3BvbnNlKSAqIDEwMCkgLyAxMDA7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIENoZWNrIG1lYXN1cmVtZW50IGVycm9yIGZsYWdzIGZyb20gbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XHJcbiAgICAgKi9cclxuXHRhc3luYyBnZXRRdWFsaXR5VmFsaWQoKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmUgcXVhbGl0eSBiaXRcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlUXVhbGl0eUJpdFJlcXVlc3QoKSk7XHJcblx0XHRyZXR1cm4gc2VuZWNhTUIuaXNRdWFsaXR5VmFsaWQocmVzcG9uc2UpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBDaGVjayBnZW5lcmF0aW9uIGVycm9yIGZsYWdzIGZyb20gbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XHJcbiAgICAgKi9cclxuXHRhc3luYyBnZXRHZW5RdWFsaXR5VmFsaWQoY3VycmVudF9tb2RlKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIGdlbmVyYXRpb24gcXVhbGl0eSBiaXRcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlR2VuU3RhdHVzUmVhZCgpKTtcclxuXHRcdHJldHVybiBzZW5lY2FNQi5wYXJzZUdlblN0YXR1cyhyZXNwb25zZSwgY3VycmVudF9tb2RlKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogUmVhZHMgdGhlIG1lYXN1cmVtZW50cyBmcm9tIHRoZSBtZXRlciwgaW5jbHVkaW5nIGVycm9yIGZsYWdzXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgY3VycmVudCBtZXRlciBtb2RlIFxyXG4gICAgICogQHJldHVybnMge2FycmF5fG51bGx9IG1lYXN1cmVtZW50IGFycmF5ICh1bml0cywgdmFsdWVzLCBlcnJvciBmbGFnKVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0TWVhc3VyZXMobW9kZSkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBtZWFzdXJlc1wiKTtcclxuXHRcdHZhciB2YWxpZCA9IGF3YWl0IHRoaXMuZ2V0UXVhbGl0eVZhbGlkKCk7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlTWVhc3VyZVJlcXVlc3QobW9kZSkpO1xyXG5cdFx0aWYgKHJlc3BvbnNlICE9IG51bGwpIHtcclxuXHRcdFx0dmFyIG1lYXMgPSBzZW5lY2FNQi5wYXJzZU1lYXN1cmUocmVzcG9uc2UsIG1vZGUpO1xyXG5cdFx0XHRtZWFzW1wiZXJyb3JcIl0gPSAhdmFsaWQ7XHJcblx0XHRcdHJldHVybiBtZWFzO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIFJlYWRzIHRoZSBhY3RpdmUgc2V0cG9pbnRzIGZyb20gdGhlIG1ldGVyLCBpbmNsdWRpbmcgZXJyb3IgZmxhZ3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1ldGVyIG1vZGUgXHJcbiAgICAgKiBAcmV0dXJucyB7YXJyYXl8bnVsbH0gc2V0cG9pbnRzIGFycmF5ICh1bml0cywgdmFsdWVzLCBlcnJvciBmbGFnKVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0U2V0cG9pbnRzKG1vZGUpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2V0cG9pbnRzXCIpO1xyXG5cdFx0dmFyIHZhbGlkID0gYXdhaXQgdGhpcy5nZXRHZW5RdWFsaXR5VmFsaWQobW9kZSk7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlU2V0cG9pbnRSZWFkKG1vZGUpKTtcclxuXHRcdGlmIChyZXNwb25zZSAhPSBudWxsKSB7XHJcblx0XHRcdHZhciByZXN1bHRzID0gc2VuZWNhTUIucGFyc2VTZXRwb2ludFJlYWQocmVzcG9uc2UsIG1vZGUpO1xyXG5cdFx0XHRyZXN1bHRzW1wiZXJyb3JcIl0gPSAhdmFsaWQ7XHJcblx0XHRcdHJldHVybiByZXN1bHRzO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIFB1dHMgdGhlIG1ldGVyIGluIE9GRiBtb2RlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgc3dpdGNoT2ZmKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciB0byBPRkZcIik7XHJcblx0XHR2YXIgcGFja2V0ID0gc2VuZWNhTUIubWFrZU1vZGVSZXF1ZXN0KENvbW1hbmRUeXBlLk9GRik7XHJcblx0XHRpZiAocGFja2V0ID09IG51bGwpXHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHJcblx0XHRhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcblx0XHRyZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBXcml0ZSB0aGUgc2V0cG9pbnRzIHRvIHRoZSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjb21tYW5kX3R5cGUgdHlwZSBvZiBnZW5lcmF0aW9uIGNvbW1hbmRcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludCBzZXRwb2ludCBvZiBnZW5lcmF0aW9uXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQyIGZhY3VsdGF0aXZlLCBzZWNvbmQgc2V0cG9pbnRcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgd3JpdGVTZXRwb2ludHMoY29tbWFuZF90eXBlLCBzZXRwb2ludCwgc2V0cG9pbnQyKSB7XHJcblx0XHR2YXIgc3RhcnRHZW47XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIGNvbW1hbmQ6XCIrIGNvbW1hbmRfdHlwZSArIFwiLCBzZXRwb2ludDogXCIgKyBzZXRwb2ludCArIFwiLCBzZXRwb2ludCAyOiBcIiArIHNldHBvaW50Mik7XHJcblx0XHR2YXIgcGFja2V0cyA9IHNlbmVjYU1CLm1ha2VTZXRwb2ludFJlcXVlc3QoY29tbWFuZF90eXBlLCBzZXRwb2ludCwgc2V0cG9pbnQyKTtcclxuXHJcblx0XHRmb3IoY29uc3QgcCBvZiBwYWNrZXRzKSB7XHJcblx0XHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHApO1xyXG5cdFx0XHRpZiAocmVzcG9uc2UgIT0gbnVsbCAmJiAhbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcblx0XHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX1NIT1VMRF9SRVRSWTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG4gICAgICAgIFxyXG5cdFx0Ly8gU3BlY2lhbCBoYW5kbGluZyBvZiB0aGUgU0VUIERlbGF5IGNvbW1hbmRcclxuXHRcdHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG5cdFx0XHRzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcblx0XHRcdHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cdFx0XHRpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAxKSkge1xyXG5cdFx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdFx0fVxyXG5cdFx0XHRicmVhaztcclxuXHRcdGRlZmF1bHQ6XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogQ2xlYXIgQXZnL01pbi9NYXggc3RhdGlzdGljc1xyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG5cdGFzeW5jIGNsZWFyU3RhdGlzdGljcygpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlc2V0dGluZyBzdGF0aXN0aWNzXCIpO1xyXG5cdFx0dmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtDTEVBUl9BVkdfTUlOX01BWF0pO1xyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cdFx0aWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMSkpIHtcclxuXHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogQmVnaW5zIHRoZSBwdWxzZSBnZW5lcmF0aW9uXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgc3RhcnRQdWxzZUdlbigpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFN0YXJ0aW5nIHB1bHNlIGdlbmVyYXRpb25cIik7XHJcblx0XHR2YXIgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtQVUxTRV9DTUQsIDJdKTsgLy8gU3RhcnQgd2l0aCBsb3dcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuXHRcdGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHRcdHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIEJlZ2lucyB0aGUgZnJlcXVlbmN5IGdlbmVyYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBzdGFydEZyZXFHZW4oKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRTdGFydGluZyBmcmVxIGdlblwiKTtcclxuXHRcdHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuR0VOX0NNRCwgW1BVTFNFX0NNRCwgMV0pOyAvLyBzdGFydCBnZW5cclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuXHRcdGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHRcdHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIERpc2FibGUgYXV0byBwb3dlciBvZmYgdG8gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgZGlzYWJsZVBvd2VyT2ZmKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0RGlzYWJsaW5nIHBvd2VyIG9mZlwiKTtcclxuXHRcdHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcblx0XHRhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcblx0XHRyZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBDaGFuZ2VzIHRoZSBjdXJyZW50IG1vZGUgb24gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGNvbW1hbmRfdHlwZSB0aGUgbmV3IG1vZGUgdG8gc2V0IHRoZSBtZXRlciBpblxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBjaGFuZ2VNb2RlKGNvbW1hbmRfdHlwZSkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciBtb2RlIHRvIDpcIiArIGNvbW1hbmRfdHlwZSk7XHJcblx0XHR2YXIgcGFja2V0ID0gc2VuZWNhTUIubWFrZU1vZGVSZXF1ZXN0KGNvbW1hbmRfdHlwZSk7XHJcblx0XHRpZiAocGFja2V0ID09IG51bGwpIHtcclxuXHRcdFx0bG9nLmVycm9yKFwiQ291bGQgbm90IGdlbmVyYXRlIG1vZGJ1cyBwYWNrZXQgZm9yIGNvbW1hbmQgdHlwZVwiLCBjb21tYW5kX3R5cGUpO1xyXG5cdFx0XHRyZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcblx0XHR9XHJcblxyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2UocGFja2V0KTtcclxuXHJcblx0XHRpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAwKSkge1xyXG5cdFx0XHRsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZCB0eXBlXCIsIGNvbW1hbmRfdHlwZSk7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHJcblx0XHR2YXIgcmVzdWx0ID0gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cclxuXHRcdC8vIFNvbWUgY29tbWFuZHMgcmVxdWlyZSBhZGRpdGlvbmFsIGNvbW1hbmQgdG8gYmUgZ2l2ZW4gdG8gd29yayBwcm9wZXJseSwgYWZ0ZXIgYSBzbGlnaHQgZGVsYXlcclxuXHRcdHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlY6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcblx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLmNsZWFyU3RhdGlzdGljcygpO1xyXG5cdFx0XHRicmVhaztcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcblx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLnN0YXJ0UHVsc2VHZW4oKTtcclxuXHRcdFx0YnJlYWs7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcblx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLnN0YXJ0RnJlcUdlbigpO1xyXG5cdFx0XHRicmVhaztcclxuXHRcdH1cclxuXHJcblx0XHRpZiAocmVzdWx0ID09IFJlc3VsdENvZGUuU1VDQ0VTUykge1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLmRpc2FibGVQb3dlck9mZigpO1xyXG5cdFx0fVxyXG5cclxuXHRcdHJldHVybiByZXN1bHQ7XHJcblx0fVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgU2VuZWNhTVNDIH07IiwiLyoqXHJcbiAqIENvbW1hbmQgdHlwZSwgYWthIG1vZGUgdmFsdWUgdG8gYmUgd3JpdHRlbiBpbnRvIE1TQyBjdXJyZW50IHN0YXRlIHJlZ2lzdGVyXHJcbiAqICovXHJcbmNvbnN0IENvbW1hbmRUeXBlID0ge1xyXG5cdE5PTkVfVU5LTk9XTjogMCwgLyoqKiBNRUFTVVJJTkcgRkVBVFVSRVMgQUZURVIgVEhJUyBQT0lOVCAqKioqKioqL1xyXG5cdG1BX3Bhc3NpdmU6IDEsXHJcblx0bUFfYWN0aXZlOiAyLFxyXG5cdFY6IDMsXHJcblx0bVY6IDQsXHJcblx0VEhFUk1PX0o6IDUsIC8vIFRlcm1vY29wcGllXHJcblx0VEhFUk1PX0s6IDYsXHJcblx0VEhFUk1PX1Q6IDcsXHJcblx0VEhFUk1PX0U6IDgsXHJcblx0VEhFUk1PX0w6IDksXHJcblx0VEhFUk1PX046IDEwLFxyXG5cdFRIRVJNT19SOiAxMSxcclxuXHRUSEVSTU9fUzogMTIsXHJcblx0VEhFUk1PX0I6IDEzLFxyXG5cdFBUMTAwXzJXOiAxNCwgLy8gUlREIDIgZmlsaVxyXG5cdFBUMTAwXzNXOiAxNSxcclxuXHRQVDEwMF80VzogMTYsXHJcblx0UFQ1MDBfMlc6IDE3LFxyXG5cdFBUNTAwXzNXOiAxOCxcclxuXHRQVDUwMF80VzogMTksXHJcblx0UFQxMDAwXzJXOiAyMCxcclxuXHRQVDEwMDBfM1c6IDIxLFxyXG5cdFBUMTAwMF80VzogMjIsXHJcblx0Q3U1MF8yVzogMjMsXHJcblx0Q3U1MF8zVzogMjQsXHJcblx0Q3U1MF80VzogMjUsXHJcblx0Q3UxMDBfMlc6IDI2LFxyXG5cdEN1MTAwXzNXOiAyNyxcclxuXHRDdTEwMF80VzogMjgsXHJcblx0TmkxMDBfMlc6IDI5LFxyXG5cdE5pMTAwXzNXOiAzMCxcclxuXHROaTEwMF80VzogMzEsXHJcblx0TmkxMjBfMlc6IDMyLFxyXG5cdE5pMTIwXzNXOiAzMyxcclxuXHROaTEyMF80VzogMzQsXHJcblx0TG9hZENlbGw6IDM1LCAgIC8vIENlbGxlIGRpIGNhcmljb1xyXG5cdEZyZXF1ZW5jeTogMzYsICAvLyBGcmVxdWVuemFcclxuXHRQdWxzZVRyYWluOiAzNywgLy8gQ29udGVnZ2lvIGltcHVsc2lcclxuXHRSRVNFUlZFRDogMzgsXHJcblx0UkVTRVJWRURfMjogNDAsXHJcblx0T0ZGOiAxMDAsIC8vICoqKioqKioqKiBHRU5FUkFUSU9OIEFGVEVSIFRISVMgUE9JTlQgKioqKioqKioqKioqKioqKiovXHJcblx0R0VOX21BX3Bhc3NpdmU6IDEwMSxcclxuXHRHRU5fbUFfYWN0aXZlOiAxMDIsXHJcblx0R0VOX1Y6IDEwMyxcclxuXHRHRU5fbVY6IDEwNCxcclxuXHRHRU5fVEhFUk1PX0o6IDEwNSxcclxuXHRHRU5fVEhFUk1PX0s6IDEwNixcclxuXHRHRU5fVEhFUk1PX1Q6IDEwNyxcclxuXHRHRU5fVEhFUk1PX0U6IDEwOCxcclxuXHRHRU5fVEhFUk1PX0w6IDEwOSxcclxuXHRHRU5fVEhFUk1PX046IDExMCxcclxuXHRHRU5fVEhFUk1PX1I6IDExMSxcclxuXHRHRU5fVEhFUk1PX1M6IDExMixcclxuXHRHRU5fVEhFUk1PX0I6IDExMyxcclxuXHRHRU5fUFQxMDBfMlc6IDExNCxcclxuXHRHRU5fUFQ1MDBfMlc6IDExNyxcclxuXHRHRU5fUFQxMDAwXzJXOiAxMjAsXHJcblx0R0VOX0N1NTBfMlc6IDEyMyxcclxuXHRHRU5fQ3UxMDBfMlc6IDEyNixcclxuXHRHRU5fTmkxMDBfMlc6IDEyOSxcclxuXHRHRU5fTmkxMjBfMlc6IDEzMixcclxuXHRHRU5fTG9hZENlbGw6IDEzNSxcclxuXHRHRU5fRnJlcXVlbmN5OiAxMzYsXHJcblx0R0VOX1B1bHNlVHJhaW46IDEzNyxcclxuXHRHRU5fUkVTRVJWRUQ6IDEzOCxcclxuXHQvLyBTcGVjaWFsIHNldHRpbmdzIGJlbG93IHRoaXMgcG9pbnRzXHJcblx0U0VUVElOR19SRVNFUlZFRDogMTAwMCxcclxuXHRTRVRfVVRocmVzaG9sZF9GOiAxMDAxLFxyXG5cdFNFVF9TZW5zaXRpdml0eV91UzogMTAwMixcclxuXHRTRVRfQ29sZEp1bmN0aW9uOiAxMDAzLFxyXG5cdFNFVF9VbG93OiAxMDA0LFxyXG5cdFNFVF9VaGlnaDogMTAwNSxcclxuXHRTRVRfU2h1dGRvd25EZWxheTogMTAwNlxyXG59O1xyXG5cclxuXHJcblxyXG5cclxuLypcclxuICogSW50ZXJuYWwgc3RhdGUgbWFjaGluZSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmNvbnN0IFN0YXRlID0ge1xyXG5cdE5PVF9DT05ORUNURUQ6IFwiTm90IGNvbm5lY3RlZFwiLFxyXG5cdENPTk5FQ1RJTkc6IFwiQmx1ZXRvb3RoIGRldmljZSBwYWlyaW5nLi4uXCIsXHJcblx0REVWSUNFX1BBSVJFRDogXCJEZXZpY2UgcGFpcmVkXCIsXHJcblx0U1VCU0NSSUJJTkc6IFwiQmx1ZXRvb3RoIGludGVyZmFjZXMgY29ubmVjdGluZy4uLlwiLFxyXG5cdElETEU6IFwiSWRsZVwiLFxyXG5cdEJVU1k6IFwiQnVzeVwiLFxyXG5cdEVSUk9SOiBcIkVycm9yXCIsXHJcblx0U1RPUFBJTkc6IFwiQ2xvc2luZyBCVCBpbnRlcmZhY2VzLi4uXCIsXHJcblx0U1RPUFBFRDogXCJTdG9wcGVkXCIsXHJcblx0TUVURVJfSU5JVDogXCJNZXRlciBjb25uZWN0ZWRcIixcclxuXHRNRVRFUl9JTklUSUFMSVpJTkc6IFwiUmVhZGluZyBtZXRlciBzdGF0ZS4uLlwiXHJcbn07XHJcblxyXG5jb25zdCBSZXN1bHRDb2RlID0ge1xyXG5cdEZBSUxFRF9OT19SRVRSWTogMSxcclxuXHRGQUlMRURfU0hPVUxEX1JFVFJZOiAyLFxyXG5cdFNVQ0NFU1M6IDBcclxufTtcclxuXHJcblxyXG5jb25zdCBNQVhfVV9HRU4gPSAyNy4wOyAvLyBtYXhpbXVtIHZvbHRhZ2UgXHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtTdGF0ZSwgQ29tbWFuZFR5cGUsIFJlc3VsdENvZGUsIE1BWF9VX0dFTiB9O1xyXG4iLCJcInVzZSBzdHJpY3RcIjtcclxuXHJcbmNvbnN0IGxvZyA9IHJlcXVpcmUoXCJsb2dsZXZlbFwiKTtcclxuY29uc3QgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xyXG5jb25zdCBBUElTdGF0ZSA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvQVBJU3RhdGVcIik7XHJcbmNvbnN0IENvbW1hbmQgPSByZXF1aXJlKFwiLi9jbGFzc2VzL0NvbW1hbmRcIik7XHJcbmNvbnN0IFB1YmxpY0FQSSA9IHJlcXVpcmUoXCIuL21ldGVyUHVibGljQVBJXCIpO1xyXG5jb25zdCBUZXN0RGF0YSA9IHJlcXVpcmUoXCIuL21vZGJ1c1Rlc3REYXRhXCIpO1xyXG5cclxubG9nLnNldExldmVsKGxvZy5sZXZlbHMuRVJST1IsIHRydWUpO1xyXG5cclxuZXhwb3J0cy5TdG9wID0gUHVibGljQVBJLlN0b3A7XHJcbmV4cG9ydHMuUGFpciA9IFB1YmxpY0FQSS5QYWlyO1xyXG5leHBvcnRzLkV4ZWN1dGUgPSBQdWJsaWNBUEkuRXhlY3V0ZTtcclxuZXhwb3J0cy5TaW1wbGVFeGVjdXRlID0gUHVibGljQVBJLlNpbXBsZUV4ZWN1dGU7XHJcbmV4cG9ydHMuR2V0U3RhdGUgPSBQdWJsaWNBUEkuR2V0U3RhdGU7XHJcbmV4cG9ydHMuU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcbmV4cG9ydHMuQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbmV4cG9ydHMuQ29tbWFuZCA9IENvbW1hbmQ7XHJcbmV4cG9ydHMuUGFyc2UgPSBQdWJsaWNBUEkuUGFyc2U7XHJcbmV4cG9ydHMubG9nID0gbG9nO1xyXG5leHBvcnRzLkdldFN0YXRlSlNPTiA9IFB1YmxpY0FQSS5HZXRTdGF0ZUpTT047XHJcbmV4cG9ydHMuRXhlY3V0ZUpTT04gPSBQdWJsaWNBUEkuRXhlY3V0ZUpTT047XHJcbmV4cG9ydHMuU2ltcGxlRXhlY3V0ZUpTT04gPSBQdWJsaWNBUEkuU2ltcGxlRXhlY3V0ZUpTT047XHJcbmV4cG9ydHMuR2V0SnNvblRyYWNlcyA9IFRlc3REYXRhLkdldEpzb25UcmFjZXM7XHJcblxyXG4iLCIvKlxyXG4gKiBUaGlzIGZpbGUgY29udGFpbnMgdGhlIHB1YmxpYyBBUEkgb2YgdGhlIG1ldGVyLCBpLmUuIHRoZSBmdW5jdGlvbnMgZGVzaWduZWRcclxuICogdG8gYmUgY2FsbGVkIGZyb20gdGhpcmQgcGFydHkgY29kZS5cclxuICogMS0gUGFpcigpIDogYm9vbFxyXG4gKiAyLSBFeGVjdXRlKENvbW1hbmQpIDogYm9vbCArIEpTT04gdmVyc2lvblxyXG4gKiAzLSBTdG9wKCkgOiBib29sXHJcbiAqIDQtIEdldFN0YXRlKCkgOiBhcnJheSArIEpTT04gdmVyc2lvblxyXG4gKiA1LSBTaW1wbGVFeGVjdXRlKENvbW1hbmQpIDogcmV0dXJucyB0aGUgdXBkYXRlZCBtZWFzdXJlbWVudCBvciBudWxsXHJcbiAqL1xyXG5cclxudmFyIENvbW1hbmRSZXN1bHQgPSByZXF1aXJlKFwiLi9jbGFzc2VzL0NvbW1hbmRSZXN1bHRcIik7XHJcbnZhciBBUElTdGF0ZSA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvQVBJU3RhdGVcIik7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XHJcbnZhciBibHVldG9vdGggPSByZXF1aXJlKFwiLi9ibHVldG9vdGhcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuL3V0aWxzXCIpO1xyXG52YXIgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG52YXIgbWV0ZXJBcGkgPSByZXF1aXJlKFwiLi9tZXRlckFwaVwiKTtcclxuXHJcbnZhciBidFN0YXRlID0gQVBJU3RhdGUuYnRTdGF0ZTtcclxudmFyIFN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgYSBjb3B5IG9mIHRoZSBjdXJyZW50IHN0YXRlXHJcbiAqIEByZXR1cm5zIHthcnJheX0gc3RhdHVzIG9mIG1ldGVyXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBHZXRTdGF0ZSgpIHtcclxuXHRsZXQgcmVhZHkgPSBmYWxzZTtcclxuXHRsZXQgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcblx0c3dpdGNoIChidFN0YXRlLnN0YXRlKSB7XHJcblx0Ly8gU3RhdGVzIHJlcXVpcmluZyB1c2VyIGlucHV0XHJcblx0Y2FzZSBTdGF0ZS5FUlJPUjpcclxuXHRjYXNlIFN0YXRlLlNUT1BQRUQ6XHJcblx0Y2FzZSBTdGF0ZS5OT1RfQ09OTkVDVEVEOlxyXG5cdFx0cmVhZHkgPSBmYWxzZTtcclxuXHRcdGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5CVVNZOlxyXG5cdGNhc2UgU3RhdGUuSURMRTpcclxuXHRcdHJlYWR5ID0gdHJ1ZTtcclxuXHRcdGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5DT05ORUNUSU5HOlxyXG5cdGNhc2UgU3RhdGUuREVWSUNFX1BBSVJFRDpcclxuXHRjYXNlIFN0YXRlLk1FVEVSX0lOSVQ6XHJcblx0Y2FzZSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc6XHJcblx0Y2FzZSBTdGF0ZS5TVUJTQ1JJQklORzpcclxuXHRcdGluaXRpYWxpemluZyA9IHRydWU7XHJcblx0XHRyZWFkeSA9IGZhbHNlO1xyXG5cdFx0YnJlYWs7XHJcblx0ZGVmYXVsdDpcclxuXHRcdHJlYWR5ID0gZmFsc2U7XHJcblx0XHRpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuXHR9XHJcblx0cmV0dXJuIHtcclxuXHRcdFwibGFzdFNldHBvaW50XCI6IGJ0U3RhdGUubGFzdFNldHBvaW50LFxyXG5cdFx0XCJsYXN0TWVhc3VyZVwiOiBidFN0YXRlLmxhc3RNZWFzdXJlLFxyXG5cdFx0XCJkZXZpY2VOYW1lXCI6IGJ0U3RhdGUuYnREZXZpY2UgPyBidFN0YXRlLmJ0RGV2aWNlLm5hbWUgOiBcIlwiLFxyXG5cdFx0XCJkZXZpY2VTZXJpYWxcIjogYnRTdGF0ZS5tZXRlcj8uc2VyaWFsLFxyXG5cdFx0XCJzdGF0c1wiOiBidFN0YXRlLnN0YXRzLFxyXG5cdFx0XCJkZXZpY2VNb2RlXCI6IGJ0U3RhdGUubWV0ZXI/Lm1vZGUsXHJcblx0XHRcInN0YXR1c1wiOiBidFN0YXRlLnN0YXRlLFxyXG5cdFx0XCJiYXR0ZXJ5TGV2ZWxcIjogYnRTdGF0ZS5tZXRlcj8uYmF0dGVyeSxcclxuXHRcdFwicmVhZHlcIjogcmVhZHksXHJcblx0XHRcImluaXRpYWxpemluZ1wiOiBpbml0aWFsaXppbmdcclxuXHR9O1xyXG59XHJcblxyXG4vKipcclxuICogUHJvdmlkZWQgZm9yIGNvbXBhdGliaWxpdHkgd2l0aCBCbGF6b3JcclxuICogQHJldHVybnMge3N0cmluZ30gSlNPTiBzdGF0ZSBvYmplY3RcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEdldFN0YXRlSlNPTigpIHtcclxuXHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgR2V0U3RhdGUoKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGNvbW1hbmQgd2l0aCBzZXRwb2ludHMsIEpTT04gdmVyc2lvblxyXG4gKiBAcGFyYW0ge3N0cmluZ30ganNvbkNvbW1hbmQgdGhlIGNvbW1hbmQgdG8gZXhlY3V0ZVxyXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBKU09OIGNvbW1hbmQgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlSlNPTihqc29uQ29tbWFuZCkge1xyXG5cdGxldCBjb21tYW5kID0gSlNPTi5wYXJzZShqc29uQ29tbWFuZCk7XHJcblx0Ly8gZGVzZXJpYWxpemVkIG9iamVjdCBoYXMgbG9zdCBpdHMgbWV0aG9kcywgbGV0J3MgcmVjcmVhdGUgYSBjb21wbGV0ZSBvbmUuXHJcblx0bGV0IGNvbW1hbmQyID0gbWV0ZXJBcGkuQ29tbWFuZC5DcmVhdGVUd29TUChjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuXHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgRXhlY3V0ZShjb21tYW5kMikpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBTaW1wbGVFeGVjdXRlSlNPTihqc29uQ29tbWFuZCkge1xyXG5cdGxldCBjb21tYW5kID0gSlNPTi5wYXJzZShqc29uQ29tbWFuZCk7XHJcblx0Ly8gZGVzZXJpYWxpemVkIG9iamVjdCBoYXMgbG9zdCBpdHMgbWV0aG9kcywgbGV0J3MgcmVjcmVhdGUgYSBjb21wbGV0ZSBvbmUuXHJcblx0bGV0IGNvbW1hbmQyID0gbWV0ZXJBcGkuQ29tbWFuZC5DcmVhdGVUd29TUChjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuXHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgU2ltcGxlRXhlY3V0ZShjb21tYW5kMikpO1xyXG59XHJcblxyXG4vKipcclxuICogRXhlY3V0ZSBhIGNvbW1hbmQgYW5kIHJldHVybnMgdGhlIG1lYXN1cmVtZW50IG9yIHNldHBvaW50IHdpdGggZXJyb3IgZmxhZyBhbmQgbWVzc2FnZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIFNpbXBsZUV4ZWN1dGUoY29tbWFuZCkge1xyXG5cdGNvbnN0IFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyA9IDU7XHJcblx0dmFyIGNyID0gbmV3IENvbW1hbmRSZXN1bHQoKTtcclxuXHJcblx0bG9nLmluZm8oXCJTaW1wbGVFeGVjdXRlIGNhbGxlZC4uLlwiKTtcclxuXHJcblx0aWYgKGNvbW1hbmQgPT0gbnVsbCkge1xyXG5cdFx0Y3Iuc3VjY2VzcyA9IGZhbHNlO1xyXG5cdFx0Y3IubWVzc2FnZSA9IFwiSW52YWxpZCBjb21tYW5kXCI7XHJcblx0XHRyZXR1cm4gY3I7XHJcblx0fVxyXG5cclxuXHRjb21tYW5kLnBlbmRpbmcgPSB0cnVlOyAvLyBJbiBjYXNlIGNhbGxlciBkb2VzIG5vdCBzZXQgcGVuZGluZyBmbGFnXHJcblxyXG5cdC8vIEZhaWwgaW1tZWRpYXRlbHkgaWYgbm90IHBhaXJlZC5cclxuXHRpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG5cdFx0Y3Iuc3VjY2VzcyA9IGZhbHNlO1xyXG5cdFx0Y3IubWVzc2FnZSA9IFwiRGV2aWNlIGlzIG5vdCBwYWlyZWRcIjtcclxuXHRcdGxvZy53YXJuKGNyLm1lc3NhZ2UpO1xyXG5cdFx0cmV0dXJuIGNyO1xyXG5cdH1cclxuXHJcblx0Ly8gQW5vdGhlciBjb21tYW5kIG1heSBiZSBwZW5kaW5nLlxyXG5cdGlmIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbCAmJiBidFN0YXRlLmNvbW1hbmQucGVuZGluZykge1xyXG5cdFx0Y3Iuc3VjY2VzcyA9IGZhbHNlO1xyXG5cdFx0Y3IubWVzc2FnZSA9IFwiQW5vdGhlciBjb21tYW5kIGlzIHBlbmRpbmdcIjtcclxuXHRcdGxvZy53YXJuKGNyLm1lc3NhZ2UpO1xyXG5cdFx0cmV0dXJuIGNyO1xyXG5cdH1cclxuXHJcblx0Ly8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG5cdGJ0U3RhdGUuY29tbWFuZCA9IGNvbW1hbmQ7XHJcblx0aWYgKGNvbW1hbmQgIT0gbnVsbCkge1xyXG5cdFx0YXdhaXQgdXRpbHMud2FpdEZvclRpbWVvdXQoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQsIFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyk7XHJcblx0fVxyXG5cclxuXHQvLyBDaGVjayBpZiBlcnJvciBvciB0aW1lb3V0c1xyXG5cdGlmIChjb21tYW5kLmVycm9yIHx8IGNvbW1hbmQucGVuZGluZykge1xyXG5cdFx0Y3Iuc3VjY2VzcyA9IGZhbHNlO1xyXG5cdFx0Y3IubWVzc2FnZSA9IFwiRXJyb3Igd2hpbGUgZXhlY3V0aW5nIHRoZSBjb21tYW5kLlwiO1xyXG5cdFx0bG9nLndhcm4oY3IubWVzc2FnZSk7XHJcblxyXG5cdFx0Ly8gUmVzZXQgdGhlIGFjdGl2ZSBjb21tYW5kXHJcblx0XHRidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cdFx0cmV0dXJuIGNyO1xyXG5cdH1cclxuXHJcblx0Ly8gU3RhdGUgaXMgdXBkYXRlZCBieSBleGVjdXRlIGNvbW1hbmQsIHNvIHdlIGNhbiB1c2UgYnRTdGF0ZSByaWdodCBhd2F5XHJcblx0aWYgKHV0aWxzLmlzR2VuZXJhdGlvbihjb21tYW5kLnR5cGUpKSB7XHJcblx0XHRjci52YWx1ZSA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVmFsdWVcIl07XHJcblx0XHRjci51bml0ID0gYnRTdGF0ZS5sYXN0U2V0cG9pbnRbXCJVbml0XCJdO1xyXG5cdH1cclxuXHRlbHNlIGlmICh1dGlscy5pc01lYXN1cmVtZW50KGNvbW1hbmQudHlwZSkpIHtcclxuXHRcdGNyLnZhbHVlID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlZhbHVlXCJdO1xyXG5cdFx0Y3IudW5pdCA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJVbml0XCJdO1xyXG5cdFx0Y3Iuc2Vjb25kYXJ5X3ZhbHVlID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlNlY29uZGFyeVZhbHVlXCJdO1xyXG5cdFx0Y3Iuc2Vjb25kYXJ5X3VuaXQgPSBidFN0YXRlLmxhc3RNZWFzdXJlW1wiU2Vjb25kYXJ5VW5pdFwiXTtcclxuXHR9XHJcblx0ZWxzZSB7XHJcblx0XHRjci52YWx1ZSA9IDAuMDsgLy8gU2V0dGluZ3MgY29tbWFuZHM7XHJcblx0fVxyXG5cclxuXHRjci5zdWNjZXNzID0gdHJ1ZTtcclxuXHRjci5tZXNzYWdlID0gXCJDb21tYW5kIGV4ZWN1dGVkIHN1Y2Nlc3NmdWxseVwiO1xyXG5cdHJldHVybiBjcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4dGVybmFsIGludGVyZmFjZSB0byByZXF1aXJlIGEgY29tbWFuZCB0byBiZSBleGVjdXRlZC5cclxuICogVGhlIGJsdWV0b290aCBkZXZpY2UgcGFpcmluZyB3aW5kb3cgd2lsbCBvcGVuIGlmIGRldmljZSBpcyBub3QgY29ubmVjdGVkLlxyXG4gKiBUaGlzIG1heSBmYWlsIGlmIGNhbGxlZCBvdXRzaWRlIGEgdXNlciBnZXN0dXJlLlxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEV4ZWN1dGUoY29tbWFuZCkge1xyXG5cdGxvZy5pbmZvKFwiRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG5cdGlmIChjb21tYW5kID09IG51bGwpXHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHJcblx0Y29tbWFuZC5wZW5kaW5nID0gdHJ1ZTtcclxuXHJcblx0dmFyIGNwdCA9IDA7XHJcblx0d2hpbGUgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsICYmIGJ0U3RhdGUuY29tbWFuZC5wZW5kaW5nICYmIGNwdCA8IDMwMCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiV2FpdGluZyBmb3IgY3VycmVudCBjb21tYW5kIHRvIGNvbXBsZXRlLi4uXCIpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHRcdGNwdCsrO1xyXG5cdH1cclxuXHJcblx0bG9nLmluZm8oXCJTZXR0aW5nIG5ldyBjb21tYW5kIDpcIiArIGNvbW1hbmQpO1xyXG5cdGJ0U3RhdGUuY29tbWFuZCA9IGNvbW1hbmQ7XHJcblxyXG5cdC8vIFN0YXJ0IHRoZSByZWd1bGFyIHN0YXRlIG1hY2hpbmVcclxuXHRpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7XHJcblx0XHRhd2FpdCBibHVldG9vdGguc3RhdGVNYWNoaW5lKCk7XHJcblx0fVxyXG5cclxuXHQvLyBXYWl0IGZvciBjb21wbGV0aW9uIG9mIHRoZSBjb21tYW5kLCBvciBoYWx0IG9mIHRoZSBzdGF0ZSBtYWNoaW5lXHJcblx0aWYgKGNvbW1hbmQgIT0gbnVsbCkge1xyXG5cdFx0YXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiAhY29tbWFuZC5wZW5kaW5nIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcblx0fVxyXG5cclxuXHQvLyBSZXR1cm4gdGhlIGNvbW1hbmQgb2JqZWN0IHJlc3VsdFxyXG5cdHJldHVybiBjb21tYW5kO1xyXG59XHJcblxyXG4vKipcclxuICogTVVTVCBCRSBDQUxMRUQgRlJPTSBBIFVTRVIgR0VTVFVSRSBFVkVOVCBIQU5ETEVSXHJcbiAgKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiBtZXRlciBpcyByZWFkeSB0byBleGVjdXRlIGNvbW1hbmRcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gUGFpcihmb3JjZVNlbGVjdGlvbiA9IGZhbHNlKSB7XHJcblx0bG9nLmluZm8oXCJQYWlyKFwiICsgZm9yY2VTZWxlY3Rpb24gKyBcIikgY2FsbGVkLi4uXCIpO1xyXG5cclxuXHRidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXSA9IGZvcmNlU2VsZWN0aW9uO1xyXG5cclxuXHRpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7XHJcblx0XHRibHVldG9vdGguc3RhdGVNYWNoaW5lKCk7IC8vIFN0YXJ0IGl0XHJcblx0fVxyXG5cdGVsc2UgaWYgKGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuRVJST1IpIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEOyAvLyBUcnkgdG8gcmVzdGFydFxyXG5cdH1cclxuXHRhd2FpdCB1dGlscy53YWl0Rm9yKCgpID0+IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuSURMRSB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQpO1xyXG5cdGxvZy5pbmZvKFwiUGFpcmluZyBjb21wbGV0ZWQsIHN0YXRlIDpcIiwgYnRTdGF0ZS5zdGF0ZSk7XHJcblx0cmV0dXJuIChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQpO1xyXG59XHJcblxyXG4vKipcclxuICogU3RvcHMgdGhlIHN0YXRlIG1hY2hpbmUgYW5kIGRpc2Nvbm5lY3RzIGJsdWV0b290aC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gU3RvcCgpIHtcclxuXHRsb2cuaW5mbyhcIlN0b3AgcmVxdWVzdCByZWNlaXZlZFwiKTtcclxuXHJcblx0YnRTdGF0ZS5zdG9wUmVxdWVzdCA9IHRydWU7XHJcblx0YXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcblx0d2hpbGUgKGJ0U3RhdGUuc3RhcnRlZCB8fCAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEICYmIGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuTk9UX0NPTk5FQ1RFRCkpIHtcclxuXHRcdGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHR9XHJcblx0YnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuXHRidFN0YXRlLnN0b3BSZXF1ZXN0ID0gZmFsc2U7XHJcblx0bG9nLndhcm4oXCJTdG9wcGVkIG9uIHJlcXVlc3QuXCIpO1xyXG5cdHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgU3RvcCwgUGFpciwgRXhlY3V0ZSwgRXhlY3V0ZUpTT04sIFNpbXBsZUV4ZWN1dGUsIFNpbXBsZUV4ZWN1dGVKU09OLCBHZXRTdGF0ZSwgR2V0U3RhdGVKU09OLCBsb2cgfTsiLCJcInVzZSBzdHJpY3RcIjtcclxuXHJcbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgUlRVIGhhbmRsaW5nICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqL1xyXG5cclxudmFyIGxvZyA9IHJlcXVpcmUoXCJsb2dsZXZlbFwiKTtcclxuXHJcbmNvbnN0IFNFTkVDQV9NQl9TTEFWRV9JRCA9IDI1OyAvLyBNb2RidXMgUlRVIHNsYXZlIElEXHJcblxyXG5jbGFzcyBNb2RidXNFcnJvciBleHRlbmRzIEVycm9yIHtcclxuXHQvKipcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgbW9kYnVzIGVycm9yXHJcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gbWVzc2FnZSBtZXNzYWdlXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gZmMgZnVuY3Rpb24gY29kZVxyXG4gICAgICovXHJcblx0Y29udHJ1Y3RvcihtZXNzYWdlLCBmYykge1xyXG5cdFx0dGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcclxuXHRcdHRoaXMuZmMgPSBmYztcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIHRoZSA0IGJ5dGVzIENSQyBjb2RlIGZyb20gdGhlIGJ1ZmZlciBjb250ZW50c1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGNyYzE2KGJ1ZmZlcikge1xyXG5cdHZhciBjcmMgPSAweEZGRkY7XHJcblx0dmFyIG9kZDtcclxuXHJcblx0Zm9yICh2YXIgaSA9IDA7IGkgPCBidWZmZXIubGVuZ3RoOyBpKyspIHtcclxuXHRcdGNyYyA9IGNyYyBeIGJ1ZmZlcltpXTtcclxuXHJcblx0XHRmb3IgKHZhciBqID0gMDsgaiA8IDg7IGorKykge1xyXG5cdFx0XHRvZGQgPSBjcmMgJiAweDAwMDE7XHJcblx0XHRcdGNyYyA9IGNyYyA+PiAxO1xyXG5cdFx0XHRpZiAob2RkKSB7XHJcblx0XHRcdFx0Y3JjID0gY3JjIF4gMHhBMDAxO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRyZXR1cm4gY3JjO1xyXG59XHJcblxyXG4vKipcclxuICogTWFrZSBhIE1vZGJ1cyBSZWFkIEhvbGRpbmcgUmVnaXN0ZXJzIChGQz0wMykgdG8gc2VyaWFsIHBvcnRcclxuICogXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBJRCBzbGF2ZSBJRFxyXG4gKiBAcGFyYW0ge251bWJlcn0gY291bnQgbnVtYmVyIG9mIHJlZ2lzdGVycyB0byByZWFkXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSByZWdpc3RlciBzdGFydGluZyByZWdpc3RlclxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMyhJRCwgY291bnQsIHJlZ2lzdGVyKSB7XHJcblx0Y29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKDgpO1xyXG5cdGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcoYnVmZmVyKTtcclxuXHR2aWV3LnNldFVpbnQ4KDAsIElEKTtcclxuXHR2aWV3LnNldFVpbnQ4KDEsIDMpO1xyXG5cdHZpZXcuc2V0VWludDE2KDIsIHJlZ2lzdGVyLCBmYWxzZSk7XHJcblx0dmlldy5zZXRVaW50MTYoNCwgY291bnQsIGZhbHNlKTtcclxuXHR2YXIgY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkoYnVmZmVyLnNsaWNlKDAsIC0yKSkpO1xyXG5cdHZpZXcuc2V0VWludDE2KDYsIGNyYywgdHJ1ZSk7XHJcblx0cmV0dXJuIGJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdyaXRlIGEgTW9kYnVzIFwiUHJlc2V0IE11bHRpcGxlIFJlZ2lzdGVyc1wiIChGQz0xNikgdG8gc2VyaWFsIHBvcnQuXHJcbiAqXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBhZGRyZXNzIHRoZSBzbGF2ZSB1bml0IGFkZHJlc3MuXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBkYXRhQWRkcmVzcyB0aGUgRGF0YSBBZGRyZXNzIG9mIHRoZSBmaXJzdCByZWdpc3Rlci5cclxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgdGhlIGFycmF5IG9mIHZhbHVlcyB0byB3cml0ZSB0byByZWdpc3RlcnMuXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlRkMxNihhZGRyZXNzLCBkYXRhQWRkcmVzcywgYXJyYXkpIHtcclxuXHRjb25zdCBjb2RlID0gMTY7XHJcblxyXG5cdC8vIHNhbml0eSBjaGVja1xyXG5cdGlmICh0eXBlb2YgYWRkcmVzcyA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0eXBlb2YgZGF0YUFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIpIHtcclxuXHRcdHJldHVybjtcclxuXHR9XHJcblxyXG5cdGxldCBkYXRhTGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xyXG5cclxuXHRjb25zdCBjb2RlTGVuZ3RoID0gNyArIDIgKiBkYXRhTGVuZ3RoO1xyXG5cdGNvbnN0IGJ1ZiA9IG5ldyBBcnJheUJ1ZmZlcihjb2RlTGVuZ3RoICsgMik7IC8vIGFkZCAyIGNyYyBieXRlc1xyXG5cdGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1Zik7XHJcblxyXG5cdGR2LnNldFVpbnQ4KDAsIGFkZHJlc3MpO1xyXG5cdGR2LnNldFVpbnQ4KDEsIGNvZGUpO1xyXG5cdGR2LnNldFVpbnQxNigyLCBkYXRhQWRkcmVzcywgZmFsc2UpO1xyXG5cdGR2LnNldFVpbnQxNig0LCBkYXRhTGVuZ3RoLCBmYWxzZSk7XHJcblx0ZHYuc2V0VWludDgoNiwgZGF0YUxlbmd0aCAqIDIpO1xyXG5cclxuXHQvLyBjb3B5IGNvbnRlbnQgb2YgYXJyYXkgdG8gYnVmXHJcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkYXRhTGVuZ3RoOyBpKyspIHtcclxuXHRcdGR2LnNldFVpbnQxNig3ICsgMiAqIGksIGFycmF5W2ldLCBmYWxzZSk7XHJcblx0fVxyXG5cdGNvbnN0IGNyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KGJ1Zi5zbGljZSgwLCAtMikpKTtcclxuXHQvLyBhZGQgY3JjIGJ5dGVzIHRvIGJ1ZmZlclxyXG5cdGR2LnNldFVpbnQxNihjb2RlTGVuZ3RoLCBjcmMsIHRydWUpO1xyXG5cdHJldHVybiBidWY7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIHRoZSByZWdpc3RlcnMgdmFsdWVzIGZyb20gYSBGQzAzIGFuc3dlciBieSBSVFUgc2xhdmVcclxuICogXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMyhyZXNwb25zZSkge1xyXG5cdGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpKSB7XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHR9XHJcblx0Y29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhyZXNwb25zZSk7XHJcblxyXG5cdC8vIEludmFsaWQgbW9kYnVzIHBhY2tldFxyXG5cdGlmIChyZXNwb25zZS5sZW5ndGggPCA1KVxyXG5cdFx0cmV0dXJuO1xyXG5cclxuXHR2YXIgY29tcHV0ZWRfY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkocmVzcG9uc2Uuc2xpY2UoMCwgLTIpKSk7XHJcblx0dmFyIGFjdHVhbF9jcmMgPSB2aWV3LmdldFVpbnQxNih2aWV3LmJ5dGVMZW5ndGggLSAyLCB0cnVlKTtcclxuXHJcblx0aWYgKGNvbXB1dGVkX2NyYyAhPSBhY3R1YWxfY3JjKSB7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBDUkMgKGV4cGVjdGVkOlwiICsgY29tcHV0ZWRfY3JjICsgXCIsZ290OlwiICsgYWN0dWFsX2NyYyArIFwiKVwiLCAzKTtcclxuXHR9XHJcblxyXG5cdHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50OCgwKTtcclxuXHRpZiAoYWRkcmVzcyAhPSBTRU5FQ0FfTUJfU0xBVkVfSUQpIHtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIHNsYXZlIElEIDpcIiArIGFkZHJlc3MsIDMpO1xyXG5cdH1cclxuXHJcblx0dmFyIGZjID0gdmlldy5nZXRVaW50OCgxKTtcclxuXHRpZiAoZmMgPiAxMjgpIHtcclxuXHRcdHZhciBleHAgPSB2aWV3LmdldFVpbnQ4KDIpO1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiRXhjZXB0aW9uIGJ5IHNsYXZlOlwiICsgZXhwLCAzKTtcclxuXHR9XHJcblx0aWYgKGZjICE9IDMpIHtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIEZDIDpcIiArIGZjLCBmYyk7XHJcblx0fVxyXG5cclxuXHQvLyBMZW5ndGggaW4gYnl0ZXMgZnJvbSBzbGF2ZSBhbnN3ZXJcclxuXHR2YXIgbGVuZ3RoID0gdmlldy5nZXRVaW50OCgyKTtcclxuXHJcblx0Y29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKGxlbmd0aCk7XHJcblx0Y29uc3QgcmVnaXN0ZXJzID0gbmV3IERhdGFWaWV3KGJ1ZmZlcik7XHJcblxyXG5cdGZvciAodmFyIGkgPSAzOyBpIDwgdmlldy5ieXRlTGVuZ3RoIC0gMjsgaSArPSAyKSB7XHJcblx0XHR2YXIgcmVnID0gdmlldy5nZXRJbnQxNihpLCBmYWxzZSk7XHJcblx0XHRyZWdpc3RlcnMuc2V0SW50MTYoaSAtIDMsIHJlZywgZmFsc2UpO1xyXG5cdFx0dmFyIGlkeCA9ICgoaSAtIDMpIC8gMiArIDEpO1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVnaXN0ZXIgXCIgKyBpZHggKyBcIi9cIiArIChsZW5ndGggLyAyKSArIFwiID0gXCIgKyByZWcpO1xyXG5cdH1cclxuXHJcblx0cmV0dXJuIHJlZ2lzdGVycztcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIGlmIHRoZSBGQzE2IHJlc3BvbnNlIGlzIGNvcnJlY3QgKENSQywgcmV0dXJuIGNvZGUpIEFORCBvcHRpb25hbGx5IG1hdGNoaW5nIHRoZSByZWdpc3RlciBsZW5ndGggZXhwZWN0ZWRcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2UgbW9kYnVzIHJ0dSByYXcgb3V0cHV0XHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBleHBlY3RlZCBudW1iZXIgb2YgZXhwZWN0ZWQgd3JpdHRlbiByZWdpc3RlcnMgZnJvbSBzbGF2ZS4gSWYgPD0wLCBpdCB3aWxsIG5vdCBiZSBjaGVja2VkLlxyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiBhbGwgcmVnaXN0ZXJzIGhhdmUgYmVlbiB3cml0dGVuXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCBleHBlY3RlZCkge1xyXG5cdHRyeSB7XHJcblx0XHRjb25zdCByZXN1bHQgPSBwYXJzZUZDMTYocmVzcG9uc2UpO1xyXG5cdFx0cmV0dXJuIChleHBlY3RlZCA8PSAwIHx8IHJlc3VsdFsxXSA9PT0gZXhwZWN0ZWQpOyAvLyBjaGVjayBpZiBsZW5ndGggaXMgbWF0Y2hpbmdcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLmVycm9yKFwiRkMxNiBhbnN3ZXIgZXJyb3JcIiwgZXJyKTtcclxuXHRcdHJldHVybiBmYWxzZTtcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgYW5zd2VyIHRvIHRoZSB3cml0ZSBtdWx0aXBsZSByZWdpc3RlcnMgZnJvbSB0aGUgc2xhdmVcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMxNihyZXNwb25zZSkge1xyXG5cdGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocmVzcG9uc2UpO1xyXG5cclxuXHRpZiAocmVzcG9uc2UubGVuZ3RoIDwgMylcclxuXHRcdHJldHVybjtcclxuXHJcblx0dmFyIHNsYXZlID0gdmlldy5nZXRVaW50OCgwKTtcclxuXHJcblx0aWYgKHNsYXZlICE9IFNFTkVDQV9NQl9TTEFWRV9JRCkge1xyXG5cdFx0cmV0dXJuO1xyXG5cdH1cclxuXHJcblx0dmFyIGZjID0gdmlldy5nZXRVaW50OCgxKTtcclxuXHRpZiAoZmMgPiAxMjgpIHtcclxuXHRcdHZhciBleHAgPSB2aWV3LmdldFVpbnQ4KDIpO1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiRXhjZXB0aW9uIDpcIiArIGV4cCwgMTYpO1xyXG5cdH1cclxuXHRpZiAoZmMgIT0gMTYpIHtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIEZDIDpcIiArIGZjLCBmYyk7XHJcblx0fVxyXG5cdHZhciBjb21wdXRlZF9jcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShyZXNwb25zZS5zbGljZSgwLCAtMikpKTtcclxuXHR2YXIgYWN0dWFsX2NyYyA9IHZpZXcuZ2V0VWludDE2KHZpZXcuYnl0ZUxlbmd0aCAtIDIsIHRydWUpO1xyXG5cclxuXHRpZiAoY29tcHV0ZWRfY3JjICE9IGFjdHVhbF9jcmMpIHtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIENSQyAoZXhwZWN0ZWQ6XCIgKyBjb21wdXRlZF9jcmMgKyBcIixnb3Q6XCIgKyBhY3R1YWxfY3JjICsgXCIpXCIsIDE2KTtcclxuXHR9XHJcblxyXG5cdHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG5cdHZhciBsZW5ndGggPSB2aWV3LmdldFVpbnQxNig0LCBmYWxzZSk7XHJcblx0cmV0dXJuIFthZGRyZXNzLCBsZW5ndGhdO1xyXG59XHJcblxyXG5cclxuXHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gZmxvYXRcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBjb252ZXJ0ZWQgdmFsdWVcclxuICovXHJcbmZ1bmN0aW9uIGdldEZsb2F0MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQpIHtcclxuXHRjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG5cdGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG5cdGR2LnNldEludDE2KDAsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCArIDIsIGZhbHNlKSwgZmFsc2UpO1xyXG5cdGR2LnNldEludDE2KDIsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCwgZmFsc2UpLCBmYWxzZSk7XHJcblx0cmV0dXJuIGR2LmdldEZsb2F0MzIoMCwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gVWludDMyXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRVaW50MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQpIHtcclxuXHRjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG5cdGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG5cdGR2LnNldEludDE2KDAsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCArIDIsIGZhbHNlKSwgZmFsc2UpO1xyXG5cdGR2LnNldEludDE2KDIsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCwgZmFsc2UpLCBmYWxzZSk7XHJcblx0cmV0dXJuIGR2LmdldFVpbnQzMigwLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBmbG9hdFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEBwYXJhbSB7dmFsdWV9IG51bWJlciB2YWx1ZSB0byBzZXRcclxuICovXHJcbmZ1bmN0aW9uIHNldEZsb2F0MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQsIHZhbHVlKSB7XHJcblx0Y29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuXHRjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuXHRkdi5zZXRGbG9hdDMyKDAsIHZhbHVlLCBmYWxzZSk7XHJcblx0ZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0LCBkdi5nZXRJbnQxNigyLCBmYWxzZSksIGZhbHNlKTtcclxuXHRkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQgKyAyLCBkdi5nZXRJbnQxNigwLCBmYWxzZSksIGZhbHNlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgdWludDMyIGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcGFyYW0ge251bWJlcn0gdmFsdWUgdmFsdWUgdG8gc2V0XHJcbiAqL1xyXG5mdW5jdGlvbiBzZXRVaW50MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQsIHZhbHVlKSB7XHJcblx0Y29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuXHRjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuXHRkdi5zZXRVaW50MzIoMCwgdmFsdWUsIGZhbHNlKTtcclxuXHRkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQsIGR2LmdldEludDE2KDIsIGZhbHNlKSwgZmFsc2UpO1xyXG5cdGRhdGFWaWV3LnNldEludDE2KG9mZnNldCArIDIsIGR2LmdldEludDE2KDAsIGZhbHNlKSwgZmFsc2UpO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgbWFrZUZDMywgZ2V0RmxvYXQzMkxFQlMsIG1ha2VGQzE2LCBzZXRGbG9hdDMyTEVCUywgc2V0VWludDMyTEVCUywgcGFyc2VGQzMsIHBhcnNlRkMxNiwgcGFyc2VGQzE2Y2hlY2tlZCwgTW9kYnVzRXJyb3IsIFNFTkVDQV9NQl9TTEFWRV9JRCwgZ2V0VWludDMyTEVCUywgY3JjMTYgfTsiLCJcInVzZSBzdHJpY3RcIjtcclxuXHJcbmNvbnN0IHRlc3RUcmFjZXMgPSBbXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZDkgM2UgNDAgODAgMDggYzJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDIgMTkgODdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODAgMDAgMzkgNzYgYzAgMDAgM2EgMmYgNjAgMDAgMzkgZWQgMDcgNjdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODAgMDAgMzkgNzYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYTQgMDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODAgMDAgMzkgNzYgYzAgMDAgM2EgMmYgODAgMDAgMzkgNzYgNzEgMGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDMgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDMgZDggNDdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgMmQgNWMgM2MgODYgMmQgNWMgM2MgODYgYjYgZDggM2MgNGEgYjYgMDNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgNDcgNzQgM2MgMTEgMmQgNWMgM2MgODYgNDcgNzQgM2MgMTEgOTYgMmJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODggN2MgM2IgZjkgMmQgNWMgM2MgODYgODggN2MgM2IgZjkgMDggNjhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDQgOTkgODVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZjQgZTMgYzAgZWEgZjQgZTMgYzAgZWEgZjQgZTMgYzAgZWEgMTUgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZjQgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZjQgZTMgYzAgZWEgNjMgZTZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZjQgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZWMgZTQgYzAgZWEgZDQgODdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZmMgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZmMgZTMgYzAgZWEgODAgNTlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZmMgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZjQgZTMgYzAgZWEgODIgMzlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjYgMTkgOWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDUgNTggNDVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgN2YgZDIgYzMgMGQgNGEgZWFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDYgMTggNDRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZDEgMDAgYzMgNzUgY2EgMTlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMjAgMDAgODEgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMzMgZDMgYzMgNzYgNGQgOTlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDcgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDcgZDkgODRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgOTAgYzMgODcgNzIgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZmUgYjcgYzMgODYgMzIgYWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDggZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDggOTkgODBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYmUgMjcgYzIgZWIgZTcgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYmIgYWQgYzIgZWIgYzYgMThcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDkgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDkgNTggNDBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMWYgYjcgYzIgZDMgYzUgM2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDcgNjMgYzIgZDMgOTYgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMWQgNTUgYzIgZDMgNjQgYjNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGEgMTggNDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNmIgNWUgYzYgM2UgY2QgYjRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjMgN2QgYzYgM2UgM2UgMWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGIgZDkgODFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNzcgMjkgY2YgN2MgZmMgNWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjAgZWYgY2YgN2QgZDggMTZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGMgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGMgOTggNDNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMzQgNTEgY2QgY2UgZTggZDdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYTYgZWEgY2QgY2UgYjQgNGFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZjkgZWUgY2QgY2QgYTcgOWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYTUgYmMgY2QgY2UgNTQgMWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGQgNTkgODNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNTQgNzYgY2MgYjAgYzcgNmNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgN2MgNmUgY2MgYjAgNGUgY2JcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGUgMTkgODJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNGYgNDQgNDQgNWIgMzYgYjYgNDMgYzcgNWYgNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGYgZDggNDJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZjAgNzUgYzMgYjMgMWMgNGUgYzMgYzcgYTIgZjhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTAgOTkgOGFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNWQgNmYgNDQgNWIgM2UgZWQgNDMgYzcgMzcgMjJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTEgNTggNGFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZmIgYjEgNDUgMmYgNGYgOWEgNDUgN2QgMWIgOTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTIgMTggNGJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggYzYgYjAgNDUgMmEgNmQgMDAgYzUgN2QgNGUgNDhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTMgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTMgZDkgOGJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZmEgZWQgNDUgMmYgNGUgZmUgNDUgN2QgMDYgNzhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTQgOTggNDlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNDIgN2MgNDQgNjEgNGYgOWEgNDUgN2QgYTUgOWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTUgNTkgODlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggN2YgYzAgYzMgYzAgODcgOTggYzUgNzIgMDcgMTNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMTIgNzcgYzMgY2QgOWIgYzEgYzUgNmIgM2MgMjFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggOWQgZTggYzMgYjcgMTMgYTkgYzUgNzcgNjkgNzdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggODIgZDAgYzMgYWQgZjYgZDYgYzUgN2IgY2UgZWJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNTcgODkgYzMgZDQgNGIgMTQgYzUgNjcgZDMgMWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTcgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTcgZDggNDhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNDEgMDYgNDQgMmUgMjkgNTMgNDMgNDcgMjYgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTggZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTggOTggNGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggYWMgMmYgYzQgNDUgMjUgYTUgYzMgNDcgZTkgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTkgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTkgNTkgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNGYgOTIgNDQgMmUgMzUgYzYgNDMgNDcgNjUgN2ZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWEgMTkgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggYWYgODIgNDMgNjcgMjkgNTMgNDMgNDcgYjEgMzNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWIgZDggNGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNDYgYTcgYzQgMTMgMjUgYTUgYzMgNDcgMjcgMGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWMgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWMgOTkgOGZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggY2MgOTggNDMgNjcgMzUgYzYgNDMgNDcgNWIgNzNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWQgNTggNGZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNzAgZTUgNDMgOWEgMzYgYjYgNDMgYzcgOTAgYmVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWUgMTggNGVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDQgMzQgYzcgMDYgMWMgNGUgYzMgYzcgNzEgMTVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWYgZDkgOGVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNmUgZGYgNDMgOWEgM2UgZWQgNDMgYzcgZjkgOGVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjAgOTkgOWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZGYgZWYgNDMgODkgMzYgYjYgNDMgYzcgZjUgNDVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjEgNTggNWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNmEgMWUgYzUgZGQgMWMgNGUgYzMgYzcgMTggODJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjIgMTggNWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZTUgZWQgNDMgODkgM2UgZWQgNDMgYzcgMjYgNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjMgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjMgZDkgOWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMDAgMDAgMDQgNDcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggN2YgMDAgMDEgMDAgMDAgMmMgMDAgMDEgYWQgY2JcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNmEgNDggM2QgZDUgMmUgZjNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjUgNTkgOWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgOTYgMDAgMDQgYTcgZmRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDAgMDAgMDAgMDAgMDAgMDAgMDAgZWIgNzdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgMDQgMDAgMDAgNDAgODAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgZTIgMjlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjUgNTggNmRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDIgMDAgMDIgNjcgZWFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDAgODAgNTIgNTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjggOTggNThcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgMDQgMDAgMDAgNDEgMjAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgZTIgMjlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjYgMTggNmNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDIgMDAgMDIgNjcgZWFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgMjAgNTMgYmFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgODAgMDAgZjkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDQgMDAgMDAgNDAgYTAgYjAgMThcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDIgMjhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjcgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjcgZDkgYWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDQgMDAgMDIgODcgZWJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgMjAgNTMgYmFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDQgNzAgYTQgM2YgOWQgMGEgZGFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDIgMjhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjggZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjggOTkgYThcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDQgMDAgMDIgODcgZWJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjYgNjYgNDAgODYgMmMgYzdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZGMgMDAgMDIgMDQgNjYgNjYgNDAgODYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZGMgMDAgMDIgODMgZWFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjkgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjkgNTggNjhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZGMgMDAgMDIgMDYgMjlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjYgNjYgNDAgODYgMmMgYzdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmEgMTggNjlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmIgZDkgYTlcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmMgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmMgOTggNmJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmUgMTkgYWFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmQgNTkgYWJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmYgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmYgZDggNmFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzAgOTkgYTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzEgNTggNjJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDQgMDAgMDAgNDEgYzggZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDIgMjdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzIgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzIgMTggNjNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZTQgMDAgMDIgODcgZTRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgYzggNTMgZjRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjcgZDggNWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2MgZTcgNDAgODAgZGQgMzVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzUgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzUgNTkgYTFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2QgNzYgNDAgODAgOGQgMjRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzggZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzggOTggNjRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgN2IgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgN2IgZDggNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzcgNGIgNDAgODAgMWYgMzBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2MgNTggNDAgODAgZWMgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgN2UgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgN2UgMTggNjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2IgYzggNDAgODAgZWQgODhcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODEgNTggMjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2EgYTkgNDAgODAgYmQgYWFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODQgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODQgOTggMjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzUgOWMgNDAgODAgYWUgYjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDggMDAgMDIgMDQgMDAgMDAgNDEgZjAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDggMDAgMDIgYzIgMmJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODcgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODcgZDggMjRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDggMDAgMDIgNDcgZThcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgZjAgNTIgMjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDEgNGQgMDAgMDAgMDEgNGUgMDAgMDAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODggZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDEgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDEgNGQgMDAgMDAgMDEgNGUgMDAgMDAgZDYgNTRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYWEgYWYgNDAgODAgNDMgYWJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzUgMGMgNDAgODAgYWUgOWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzkgODkgNDAgODAgYmMgMjRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2IgMzkgNDAgODAgYmMgN2JcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzcgZGIgNDAgODAgMWYgMWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzYgYmMgNDAgODAgYWYgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzQgN2QgNDAgODAgZmYgN2FcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzMgNWUgNDAgODAgMGYgYzRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzggNmIgNDAgODAgMWQgZWVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzYgMmMgNDAgODAgYWYgMTNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDQgMDAgMDAgNDEgZjAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDIgMjdcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzIgY2UgNDAgODAgMGUgMTVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgYzAgMDAgMDIgMDQgMDAgMDAgNDEgMjAgZmYgZmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgYzAgMDAgMDIgNDIgMmNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgN2QgNDEgNDAgNzcgNWIgYWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgZDMgNjdcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODggOTAgYjlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDEgZDAgZGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDYgMDAgMDAgMDAgMDcgMDAgMDAgM2MgYjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmMgMDAgMDIgMDQgMDAgNjQgMDAgMDAgYzMgYzFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmMgMDAgMDIgODIgMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgMmMgYWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODkgNTEgNzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDIgOTAgZGNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMjggMDAgMDAgMDAgMjggMDAgMDAgYzMgN2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDEgYzkgNDAgNzcgZDcgZDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDEgYzkgNDAgNzcgZDcgZDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDAgYTkgNDAgNzcgZDYgMzRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDEgYzkgNDAgNzcgZDcgZDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDAgYTkgNDAgNzcgZDYgMzRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2YgOGIgNDAgNzcgNmYgZWFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2UgNmIgNDAgNzcgNmYgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2UgNmIgNDAgNzcgNmYgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2QgNGMgNDAgNzcgZGYgYWZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2MgMmUgNDAgNzcgN2YgOGRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgM2IgMGUgNDAgNzcgN2YgMzNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDEgNWEgOTRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDUgYzQgODhcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDEgMDggMDAgMDIgMDQgMDAgMDAgMDAgMDAgODEgMzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDEgMDggMDAgMDIgYzIgMmVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDEgMDYgMDAgMDIgMDQgYTEgMmYgM2UgYmQgYzIgOTFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDEgMDYgMDAgMDIgYTMgZWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmMgMDAgMDIgMDQgMDAgMGEgMDAgMDAgYTIgMWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmMgMDAgMDIgODIgMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDAgNjQgMDAgMDAgMDAgNjQgMDAgMDAgNjAgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODkgNTEgNzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDIgOTAgZGNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgNjQgMDAgMDAgMDAgNjQgMDAgMDAgOGYgNmVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgNjQgMDAgMDAgMDAgNjQgMDAgMDAgOGYgNmVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgNjQgMDAgMDAgMDAgNjQgMDAgMDAgOGYgNmVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgNjQgMDAgMDAgMDAgNjQgMDAgMDAgOGYgNmVcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgYWMgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODggOTAgYjlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDEgZDAgZGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgNDMgMWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgNDMgMWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgNDMgMWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgNDMgMWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgNDMgMWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDMgZTggMDAgMDAgMDMgZTggMDAgMDAgNDMgMWNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZWYgZTEgNDAgNzYgYjYgZjZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDMgZGIgNTVcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgOTQgMDBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjcgZDEgMzVcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDEgZDAgZGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgN2IgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgN2IgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgN2IgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgN2IgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgN2IgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDcgZDAgMDAgMDAgMDcgZDAgMDAgMDAgN2IgZDFcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmMgMDAgMDIgMDQgMDAgMDUgMDAgMDAgOTIgMWZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmMgMDAgMDIgODIgMjBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgMzAgNWRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODkgNTEgNzlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDIgOTAgZGNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODkgNTkgZTBcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMjAgOGQgMDAgMDAgMjAgOGUgMDAgMDAgZGYgOGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjQgOWIgNGZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgODQgODlcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgNWMgM2UgMTEgNzIgNGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgNWMgM2UgMTEgNzIgNGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgNWMgM2UgMTEgNzIgNGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgNWMgM2UgMTEgNzIgNGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgNWMgM2UgMTEgNzIgNGNcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgOWEgYmZcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG5cdH0sXHJcblx0e1xyXG5cdFx0XCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuXHRcdFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG5cdH1cclxuXTtcclxuXHJcbmZ1bmN0aW9uIHVuaXFCeShhLCBrZXkpIHtcclxuXHR2YXIgc2VlbiA9IHt9O1xyXG5cdHJldHVybiBhLmZpbHRlcihmdW5jdGlvbiAoaXRlbSkge1xyXG5cdFx0dmFyIGsgPSBrZXkoaXRlbSk7XHJcblx0XHRyZXR1cm4gc2Vlbi5oYXNPd25Qcm9wZXJ0eShrKSA/IGZhbHNlIDogKHNlZW5ba10gPSB0cnVlKTtcclxuXHR9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FtZU1lc3NhZ2UodHJhY2UpIHtcclxuXHRyZXR1cm4gdHJhY2VbXCJyZXF1ZXN0XCJdICsgXCIgLT4gXCIgKyB0cmFjZVtcImFuc3dlclwiXTtcclxufVxyXG5cclxuZnVuY3Rpb24gR2V0SnNvblRyYWNlcygpIHtcclxuXHR0ZXN0VHJhY2VzID0gdW5pcUJ5KHRlc3RUcmFjZXMsIHNhbWVNZXNzYWdlKTtcclxuXHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkodGVzdFRyYWNlcyk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyB0ZXN0VHJhY2VzLCBHZXRKc29uVHJhY2VzIH07IiwiLypcbiogbG9nbGV2ZWwgLSBodHRwczovL2dpdGh1Yi5jb20vcGltdGVycnkvbG9nbGV2ZWxcbipcbiogQ29weXJpZ2h0IChjKSAyMDEzIFRpbSBQZXJyeVxuKiBMaWNlbnNlZCB1bmRlciB0aGUgTUlUIGxpY2Vuc2UuXG4qL1xuKGZ1bmN0aW9uIChyb290LCBkZWZpbml0aW9uKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgaWYgKHR5cGVvZiBkZWZpbmUgPT09ICdmdW5jdGlvbicgJiYgZGVmaW5lLmFtZCkge1xuICAgICAgICBkZWZpbmUoZGVmaW5pdGlvbik7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykge1xuICAgICAgICBtb2R1bGUuZXhwb3J0cyA9IGRlZmluaXRpb24oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByb290LmxvZyA9IGRlZmluaXRpb24oKTtcbiAgICB9XG59KHRoaXMsIGZ1bmN0aW9uICgpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIC8vIFNsaWdodGx5IGR1YmlvdXMgdHJpY2tzIHRvIGN1dCBkb3duIG1pbmltaXplZCBmaWxlIHNpemVcbiAgICB2YXIgbm9vcCA9IGZ1bmN0aW9uKCkge307XG4gICAgdmFyIHVuZGVmaW5lZFR5cGUgPSBcInVuZGVmaW5lZFwiO1xuICAgIHZhciBpc0lFID0gKHR5cGVvZiB3aW5kb3cgIT09IHVuZGVmaW5lZFR5cGUpICYmICh0eXBlb2Ygd2luZG93Lm5hdmlnYXRvciAhPT0gdW5kZWZpbmVkVHlwZSkgJiYgKFxuICAgICAgICAvVHJpZGVudFxcL3xNU0lFIC8udGVzdCh3aW5kb3cubmF2aWdhdG9yLnVzZXJBZ2VudClcbiAgICApO1xuXG4gICAgdmFyIGxvZ01ldGhvZHMgPSBbXG4gICAgICAgIFwidHJhY2VcIixcbiAgICAgICAgXCJkZWJ1Z1wiLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICAgXCJ3YXJuXCIsXG4gICAgICAgIFwiZXJyb3JcIlxuICAgIF07XG5cbiAgICAvLyBDcm9zcy1icm93c2VyIGJpbmQgZXF1aXZhbGVudCB0aGF0IHdvcmtzIGF0IGxlYXN0IGJhY2sgdG8gSUU2XG4gICAgZnVuY3Rpb24gYmluZE1ldGhvZChvYmosIG1ldGhvZE5hbWUpIHtcbiAgICAgICAgdmFyIG1ldGhvZCA9IG9ialttZXRob2ROYW1lXTtcbiAgICAgICAgaWYgKHR5cGVvZiBtZXRob2QuYmluZCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIG1ldGhvZC5iaW5kKG9iaik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBGdW5jdGlvbi5wcm90b3R5cGUuYmluZC5jYWxsKG1ldGhvZCwgb2JqKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyBNaXNzaW5nIGJpbmQgc2hpbSBvciBJRTggKyBNb2Rlcm5penIsIGZhbGxiYWNrIHRvIHdyYXBwaW5nXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gRnVuY3Rpb24ucHJvdG90eXBlLmFwcGx5LmFwcGx5KG1ldGhvZCwgW29iaiwgYXJndW1lbnRzXSk7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRyYWNlKCkgZG9lc24ndCBwcmludCB0aGUgbWVzc2FnZSBpbiBJRSwgc28gZm9yIHRoYXQgY2FzZSB3ZSBuZWVkIHRvIHdyYXAgaXRcbiAgICBmdW5jdGlvbiB0cmFjZUZvcklFKCkge1xuICAgICAgICBpZiAoY29uc29sZS5sb2cpIHtcbiAgICAgICAgICAgIGlmIChjb25zb2xlLmxvZy5hcHBseSkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nLmFwcGx5KGNvbnNvbGUsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEluIG9sZCBJRSwgbmF0aXZlIGNvbnNvbGUgbWV0aG9kcyB0aGVtc2VsdmVzIGRvbid0IGhhdmUgYXBwbHkoKS5cbiAgICAgICAgICAgICAgICBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuYXBwbHkoY29uc29sZS5sb2csIFtjb25zb2xlLCBhcmd1bWVudHNdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY29uc29sZS50cmFjZSkgY29uc29sZS50cmFjZSgpO1xuICAgIH1cblxuICAgIC8vIEJ1aWxkIHRoZSBiZXN0IGxvZ2dpbmcgbWV0aG9kIHBvc3NpYmxlIGZvciB0aGlzIGVudlxuICAgIC8vIFdoZXJldmVyIHBvc3NpYmxlIHdlIHdhbnQgdG8gYmluZCwgbm90IHdyYXAsIHRvIHByZXNlcnZlIHN0YWNrIHRyYWNlc1xuICAgIGZ1bmN0aW9uIHJlYWxNZXRob2QobWV0aG9kTmFtZSkge1xuICAgICAgICBpZiAobWV0aG9kTmFtZSA9PT0gJ2RlYnVnJykge1xuICAgICAgICAgICAgbWV0aG9kTmFtZSA9ICdsb2cnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlID09PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7IC8vIE5vIG1ldGhvZCBwb3NzaWJsZSwgZm9yIG5vdyAtIGZpeGVkIGxhdGVyIGJ5IGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXNcbiAgICAgICAgfSBlbHNlIGlmIChtZXRob2ROYW1lID09PSAndHJhY2UnICYmIGlzSUUpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFjZUZvcklFO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbnNvbGVbbWV0aG9kTmFtZV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIGJpbmRNZXRob2QoY29uc29sZSwgbWV0aG9kTmFtZSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uc29sZS5sb2cgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIGJpbmRNZXRob2QoY29uc29sZSwgJ2xvZycpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIG5vb3A7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGVzZSBwcml2YXRlIGZ1bmN0aW9ucyBhbHdheXMgbmVlZCBgdGhpc2AgdG8gYmUgc2V0IHByb3Blcmx5XG5cbiAgICBmdW5jdGlvbiByZXBsYWNlTG9nZ2luZ01ldGhvZHMobGV2ZWwsIGxvZ2dlck5hbWUpIHtcbiAgICAgICAgLypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsb2dNZXRob2RzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICB2YXIgbWV0aG9kTmFtZSA9IGxvZ01ldGhvZHNbaV07XG4gICAgICAgICAgICB0aGlzW21ldGhvZE5hbWVdID0gKGkgPCBsZXZlbCkgP1xuICAgICAgICAgICAgICAgIG5vb3AgOlxuICAgICAgICAgICAgICAgIHRoaXMubWV0aG9kRmFjdG9yeShtZXRob2ROYW1lLCBsZXZlbCwgbG9nZ2VyTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBEZWZpbmUgbG9nLmxvZyBhcyBhbiBhbGlhcyBmb3IgbG9nLmRlYnVnXG4gICAgICAgIHRoaXMubG9nID0gdGhpcy5kZWJ1ZztcbiAgICB9XG5cbiAgICAvLyBJbiBvbGQgSUUgdmVyc2lvbnMsIHRoZSBjb25zb2xlIGlzbid0IHByZXNlbnQgdW50aWwgeW91IGZpcnN0IG9wZW4gaXQuXG4gICAgLy8gV2UgYnVpbGQgcmVhbE1ldGhvZCgpIHJlcGxhY2VtZW50cyBoZXJlIHRoYXQgcmVnZW5lcmF0ZSBsb2dnaW5nIG1ldGhvZHNcbiAgICBmdW5jdGlvbiBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzKG1ldGhvZE5hbWUsIGxldmVsLCBsb2dnZXJOYW1lKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgIT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbCh0aGlzLCBsZXZlbCwgbG9nZ2VyTmFtZSk7XG4gICAgICAgICAgICAgICAgdGhpc1ttZXRob2ROYW1lXS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIEJ5IGRlZmF1bHQsIHdlIHVzZSBjbG9zZWx5IGJvdW5kIHJlYWwgbWV0aG9kcyB3aGVyZXZlciBwb3NzaWJsZSwgYW5kXG4gICAgLy8gb3RoZXJ3aXNlIHdlIHdhaXQgZm9yIGEgY29uc29sZSB0byBhcHBlYXIsIGFuZCB0aGVuIHRyeSBhZ2Fpbi5cbiAgICBmdW5jdGlvbiBkZWZhdWx0TWV0aG9kRmFjdG9yeShtZXRob2ROYW1lLCBsZXZlbCwgbG9nZ2VyTmFtZSkge1xuICAgICAgICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICAgICAgICByZXR1cm4gcmVhbE1ldGhvZChtZXRob2ROYW1lKSB8fFxuICAgICAgICAgICAgICAgZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlcy5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIExvZ2dlcihuYW1lLCBkZWZhdWx0TGV2ZWwsIGZhY3RvcnkpIHtcbiAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgIHZhciBjdXJyZW50TGV2ZWw7XG4gICAgICBkZWZhdWx0TGV2ZWwgPSBkZWZhdWx0TGV2ZWwgPT0gbnVsbCA/IFwiV0FSTlwiIDogZGVmYXVsdExldmVsO1xuXG4gICAgICB2YXIgc3RvcmFnZUtleSA9IFwibG9nbGV2ZWxcIjtcbiAgICAgIGlmICh0eXBlb2YgbmFtZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBzdG9yYWdlS2V5ICs9IFwiOlwiICsgbmFtZTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG5hbWUgPT09IFwic3ltYm9sXCIpIHtcbiAgICAgICAgc3RvcmFnZUtleSA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcGVyc2lzdExldmVsSWZQb3NzaWJsZShsZXZlbE51bSkge1xuICAgICAgICAgIHZhciBsZXZlbE5hbWUgPSAobG9nTWV0aG9kc1tsZXZlbE51bV0gfHwgJ3NpbGVudCcpLnRvVXBwZXJDYXNlKCk7XG5cbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gVXNlIGxvY2FsU3RvcmFnZSBpZiBhdmFpbGFibGVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cubG9jYWxTdG9yYWdlW3N0b3JhZ2VLZXldID0gbGV2ZWxOYW1lO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gVXNlIHNlc3Npb24gY29va2llIGFzIGZhbGxiYWNrXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmRvY3VtZW50LmNvb2tpZSA9XG4gICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9XCIgKyBsZXZlbE5hbWUgKyBcIjtcIjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGdldFBlcnNpc3RlZExldmVsKCkge1xuICAgICAgICAgIHZhciBzdG9yZWRMZXZlbDtcblxuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IHdpbmRvdy5sb2NhbFN0b3JhZ2Vbc3RvcmFnZUtleV07XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gRmFsbGJhY2sgdG8gY29va2llcyBpZiBsb2NhbCBzdG9yYWdlIGdpdmVzIHVzIG5vdGhpbmdcbiAgICAgICAgICBpZiAodHlwZW9mIHN0b3JlZExldmVsID09PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICB2YXIgY29va2llID0gd2luZG93LmRvY3VtZW50LmNvb2tpZTtcbiAgICAgICAgICAgICAgICAgIHZhciBsb2NhdGlvbiA9IGNvb2tpZS5pbmRleE9mKFxuICAgICAgICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPVwiKTtcbiAgICAgICAgICAgICAgICAgIGlmIChsb2NhdGlvbiAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IC9eKFteO10rKS8uZXhlYyhjb29raWUuc2xpY2UobG9jYXRpb24pKVsxXTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIElmIHRoZSBzdG9yZWQgbGV2ZWwgaXMgbm90IHZhbGlkLCB0cmVhdCBpdCBhcyBpZiBub3RoaW5nIHdhcyBzdG9yZWQuXG4gICAgICAgICAgaWYgKHNlbGYubGV2ZWxzW3N0b3JlZExldmVsXSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHN0b3JlZExldmVsID0gdW5kZWZpbmVkO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBzdG9yZWRMZXZlbDtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gY2xlYXJQZXJzaXN0ZWRMZXZlbCgpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gVXNlIGxvY2FsU3RvcmFnZSBpZiBhdmFpbGFibGVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oc3RvcmFnZUtleSk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBVc2Ugc2Vzc2lvbiBjb29raWUgYXMgZmFsbGJhY2tcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cuZG9jdW1lbnQuY29va2llID1cbiAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj07IGV4cGlyZXM9VGh1LCAwMSBKYW4gMTk3MCAwMDowMDowMCBVVENcIjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICB9XG5cbiAgICAgIC8qXG4gICAgICAgKlxuICAgICAgICogUHVibGljIGxvZ2dlciBBUEkgLSBzZWUgaHR0cHM6Ly9naXRodWIuY29tL3BpbXRlcnJ5L2xvZ2xldmVsIGZvciBkZXRhaWxzXG4gICAgICAgKlxuICAgICAgICovXG5cbiAgICAgIHNlbGYubmFtZSA9IG5hbWU7XG5cbiAgICAgIHNlbGYubGV2ZWxzID0geyBcIlRSQUNFXCI6IDAsIFwiREVCVUdcIjogMSwgXCJJTkZPXCI6IDIsIFwiV0FSTlwiOiAzLFxuICAgICAgICAgIFwiRVJST1JcIjogNCwgXCJTSUxFTlRcIjogNX07XG5cbiAgICAgIHNlbGYubWV0aG9kRmFjdG9yeSA9IGZhY3RvcnkgfHwgZGVmYXVsdE1ldGhvZEZhY3Rvcnk7XG5cbiAgICAgIHNlbGYuZ2V0TGV2ZWwgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgcmV0dXJuIGN1cnJlbnRMZXZlbDtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuc2V0TGV2ZWwgPSBmdW5jdGlvbiAobGV2ZWwsIHBlcnNpc3QpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGxldmVsID09PSBcInN0cmluZ1wiICYmIHNlbGYubGV2ZWxzW2xldmVsLnRvVXBwZXJDYXNlKCldICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgbGV2ZWwgPSBzZWxmLmxldmVsc1tsZXZlbC50b1VwcGVyQ2FzZSgpXTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiBsZXZlbCA9PT0gXCJudW1iZXJcIiAmJiBsZXZlbCA+PSAwICYmIGxldmVsIDw9IHNlbGYubGV2ZWxzLlNJTEVOVCkge1xuICAgICAgICAgICAgICBjdXJyZW50TGV2ZWwgPSBsZXZlbDtcbiAgICAgICAgICAgICAgaWYgKHBlcnNpc3QgIT09IGZhbHNlKSB7ICAvLyBkZWZhdWx0cyB0byB0cnVlXG4gICAgICAgICAgICAgICAgICBwZXJzaXN0TGV2ZWxJZlBvc3NpYmxlKGxldmVsKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbChzZWxmLCBsZXZlbCwgbmFtZSk7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gdW5kZWZpbmVkVHlwZSAmJiBsZXZlbCA8IHNlbGYubGV2ZWxzLlNJTEVOVCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFwiTm8gY29uc29sZSBhdmFpbGFibGUgZm9yIGxvZ2dpbmdcIjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IFwibG9nLnNldExldmVsKCkgY2FsbGVkIHdpdGggaW52YWxpZCBsZXZlbDogXCIgKyBsZXZlbDtcbiAgICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnNldERlZmF1bHRMZXZlbCA9IGZ1bmN0aW9uIChsZXZlbCkge1xuICAgICAgICAgIGRlZmF1bHRMZXZlbCA9IGxldmVsO1xuICAgICAgICAgIGlmICghZ2V0UGVyc2lzdGVkTGV2ZWwoKSkge1xuICAgICAgICAgICAgICBzZWxmLnNldExldmVsKGxldmVsLCBmYWxzZSk7XG4gICAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgc2VsZi5yZXNldExldmVsID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoZGVmYXVsdExldmVsLCBmYWxzZSk7XG4gICAgICAgICAgY2xlYXJQZXJzaXN0ZWRMZXZlbCgpO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5lbmFibGVBbGwgPSBmdW5jdGlvbihwZXJzaXN0KSB7XG4gICAgICAgICAgc2VsZi5zZXRMZXZlbChzZWxmLmxldmVscy5UUkFDRSwgcGVyc2lzdCk7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLmRpc2FibGVBbGwgPSBmdW5jdGlvbihwZXJzaXN0KSB7XG4gICAgICAgICAgc2VsZi5zZXRMZXZlbChzZWxmLmxldmVscy5TSUxFTlQsIHBlcnNpc3QpO1xuICAgICAgfTtcblxuICAgICAgLy8gSW5pdGlhbGl6ZSB3aXRoIHRoZSByaWdodCBsZXZlbFxuICAgICAgdmFyIGluaXRpYWxMZXZlbCA9IGdldFBlcnNpc3RlZExldmVsKCk7XG4gICAgICBpZiAoaW5pdGlhbExldmVsID09IG51bGwpIHtcbiAgICAgICAgICBpbml0aWFsTGV2ZWwgPSBkZWZhdWx0TGV2ZWw7XG4gICAgICB9XG4gICAgICBzZWxmLnNldExldmVsKGluaXRpYWxMZXZlbCwgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qXG4gICAgICpcbiAgICAgKiBUb3AtbGV2ZWwgQVBJXG4gICAgICpcbiAgICAgKi9cblxuICAgIHZhciBkZWZhdWx0TG9nZ2VyID0gbmV3IExvZ2dlcigpO1xuXG4gICAgdmFyIF9sb2dnZXJzQnlOYW1lID0ge307XG4gICAgZGVmYXVsdExvZ2dlci5nZXRMb2dnZXIgPSBmdW5jdGlvbiBnZXRMb2dnZXIobmFtZSkge1xuICAgICAgICBpZiAoKHR5cGVvZiBuYW1lICE9PSBcInN5bWJvbFwiICYmIHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiKSB8fCBuYW1lID09PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIllvdSBtdXN0IHN1cHBseSBhIG5hbWUgd2hlbiBjcmVhdGluZyBhIGxvZ2dlci5cIik7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgbG9nZ2VyID0gX2xvZ2dlcnNCeU5hbWVbbmFtZV07XG4gICAgICAgIGlmICghbG9nZ2VyKSB7XG4gICAgICAgICAgbG9nZ2VyID0gX2xvZ2dlcnNCeU5hbWVbbmFtZV0gPSBuZXcgTG9nZ2VyKFxuICAgICAgICAgICAgbmFtZSwgZGVmYXVsdExvZ2dlci5nZXRMZXZlbCgpLCBkZWZhdWx0TG9nZ2VyLm1ldGhvZEZhY3RvcnkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsb2dnZXI7XG4gICAgfTtcblxuICAgIC8vIEdyYWIgdGhlIGN1cnJlbnQgZ2xvYmFsIGxvZyB2YXJpYWJsZSBpbiBjYXNlIG9mIG92ZXJ3cml0ZVxuICAgIHZhciBfbG9nID0gKHR5cGVvZiB3aW5kb3cgIT09IHVuZGVmaW5lZFR5cGUpID8gd2luZG93LmxvZyA6IHVuZGVmaW5lZDtcbiAgICBkZWZhdWx0TG9nZ2VyLm5vQ29uZmxpY3QgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgIT09IHVuZGVmaW5lZFR5cGUgJiZcbiAgICAgICAgICAgICAgIHdpbmRvdy5sb2cgPT09IGRlZmF1bHRMb2dnZXIpIHtcbiAgICAgICAgICAgIHdpbmRvdy5sb2cgPSBfbG9nO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGRlZmF1bHRMb2dnZXI7XG4gICAgfTtcblxuICAgIGRlZmF1bHRMb2dnZXIuZ2V0TG9nZ2VycyA9IGZ1bmN0aW9uIGdldExvZ2dlcnMoKSB7XG4gICAgICAgIHJldHVybiBfbG9nZ2Vyc0J5TmFtZTtcbiAgICB9O1xuXG4gICAgLy8gRVM2IGRlZmF1bHQgZXhwb3J0LCBmb3IgY29tcGF0aWJpbGl0eVxuICAgIGRlZmF1bHRMb2dnZXJbJ2RlZmF1bHQnXSA9IGRlZmF1bHRMb2dnZXI7XG5cbiAgICByZXR1cm4gZGVmYXVsdExvZ2dlcjtcbn0pKTtcbiIsIlwidXNlIHN0cmljdFwiO1xyXG5cclxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiogTU9EQlVTIFJUVSBGVU5DVElPTlMgRk9SIFNFTkVDQSAqKioqKioqKioqKioqKioqKioqKioqL1xyXG5cclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoXCIuL21vZGJ1c1J0dVwiKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZShcIi4vdXRpbHNcIik7XHJcblxyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbmNvbnN0IFNFTkVDQV9NQl9TTEFWRV9JRCA9IG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQ7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbi8qXHJcbiAqIE1vZGJ1cyByZWdpc3RlcnMgbWFwLiBFYWNoIHJlZ2lzdGVyIGlzIDIgYnl0ZXMgd2lkZS5cclxuICovXHJcbmNvbnN0IE1TQ1JlZ2lzdGVycyA9IHtcclxuXHRTZXJpYWxOdW1iZXI6IDEwLFxyXG5cdEN1cnJlbnRNb2RlOiAxMDAsXHJcblx0TWVhc3VyZUZsYWdzOiAxMDIsXHJcblx0Q01EOiAxMDcsXHJcblx0QVVYMTogMTA4LFxyXG5cdExvYWRDZWxsTWVhc3VyZTogMTE0LFxyXG5cdFRlbXBNZWFzdXJlOiAxMjAsXHJcblx0UnRkVGVtcGVyYXR1cmVNZWFzdXJlOiAxMjgsXHJcblx0UnRkUmVzaXN0YW5jZU1lYXN1cmU6IDEzMCxcclxuXHRGcmVxdWVuY3lNZWFzdXJlOiAxNjQsXHJcblx0TWluTWVhc3VyZTogMTMyLFxyXG5cdE1heE1lYXN1cmU6IDEzNCxcclxuXHRJbnN0YW50TWVhc3VyZTogMTM2LFxyXG5cdFBvd2VyT2ZmRGVsYXk6IDE0MixcclxuXHRQb3dlck9mZlJlbWFpbmluZzogMTQ2LFxyXG5cdFB1bHNlT0ZGTWVhc3VyZTogMTUwLFxyXG5cdFB1bHNlT05NZWFzdXJlOiAxNTIsXHJcblx0U2Vuc2liaWxpdHlfdVNfT0ZGOiAxNjYsXHJcblx0U2Vuc2liaWxpdHlfdVNfT046IDE2OCxcclxuXHRCYXR0ZXJ5TWVhc3VyZTogMTc0LFxyXG5cdENvbGRKdW5jdGlvbjogMTkwLFxyXG5cdFRocmVzaG9sZFVfRnJlcTogMTkyLFxyXG5cdEdlbmVyYXRpb25GbGFnczogMjAyLFxyXG5cdEdFTl9DTUQ6IDIwNyxcclxuXHRHRU5fQVVYMTogMjA4LFxyXG5cdEN1cnJlbnRTZXRwb2ludDogMjEwLFxyXG5cdFZvbHRhZ2VTZXRwb2ludDogMjEyLFxyXG5cdExvYWRDZWxsU2V0cG9pbnQ6IDIxNixcclxuXHRUaGVybW9UZW1wZXJhdHVyZVNldHBvaW50OiAyMjAsXHJcblx0UlREVGVtcGVyYXR1cmVTZXRwb2ludDogMjI4LFxyXG5cdFB1bHNlc0NvdW50OiAyNTIsXHJcblx0RnJlcXVlbmN5VElDSzE6IDI1NCxcclxuXHRGcmVxdWVuY3lUSUNLMjogMjU2LFxyXG5cdEdlblVoaWdoUGVyYzogMjYyLFxyXG5cdEdlblVsb3dQZXJjOiAyNjRcclxufTtcclxuXHJcbi8qKlxyXG4gKiBHZW5lcmF0ZSB0aGUgbW9kYnVzIFJUVSBwYWNrZXQgdG8gcmVhZCB0aGUgc2VyaWFsIG51bWJlclxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlU2VyaWFsTnVtYmVyKCkge1xyXG5cdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5TZXJpYWxOdW1iZXIpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQ3VycmVudE1vZGUoKSB7XHJcblx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRNb2RlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBjdXJyZW50IGJhdHRlcnkgbGV2ZWxcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZUJhdHRlcnlMZXZlbCgpIHtcclxuXHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQmF0dGVyeU1lYXN1cmUpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSByZWdpc3RlciB3aXRoIGJhdHRlcnkgbGV2ZWxcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIEZDMyBhbnN3ZXIgXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGJhdHRlcnkgbGV2ZWwgaW4gVlxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VCYXR0ZXJ5KGJ1ZmZlcikge1xyXG5cdHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHRyZXR1cm4gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgU2VuZWNhIE1TQyBzZXJpYWwgYXMgcGVyIHRoZSBVSSBpbnRlcmZhY2VcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBhbnN3ZXIgcGFja2V0IChGQzMpXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZVNlcmlhbE51bWJlcihidWZmZXIpIHtcclxuXHR2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0aWYgKHJlZ2lzdGVycy5sZW5ndGggPCA0KSB7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHNlcmlhbCBudW1iZXIgcmVzcG9uc2VcIik7XHJcblx0fVxyXG5cdGNvbnN0IHZhbDEgPSByZWdpc3RlcnMuZ2V0VWludDE2KDAsIGZhbHNlKTtcclxuXHRjb25zdCB2YWwyID0gcmVnaXN0ZXJzLmdldFVpbnQxNigyLCBmYWxzZSk7XHJcblx0Y29uc3Qgc2VyaWFsID0gKCh2YWwyIDw8IDE2KSArIHZhbDEpLnRvU3RyaW5nKCk7XHJcblx0aWYgKHNlcmlhbC5sZW5ndGggPiA1KSB7XHJcblx0XHRyZXR1cm4gc2VyaWFsLnN1YnN0cigwLCA1KSArIFwiX1wiICsgc2VyaWFsLnN1YnN0cig1LCBzZXJpYWwubGVuZ3RoIC0gNSk7XHJcblx0fVxyXG5cdHJldHVybiBzZXJpYWw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZXMgdGhlIHN0YXRlIG9mIHRoZSBtZXRlci4gTWF5IHRocm93LlxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgbW9kYnVzIGFuc3dlciBwYWNrZXQgKEZDMylcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY3VycmVudE1vZGUgaWYgdGhlIHJlZ2lzdGVycyBjb250YWlucyBhbiBJR05PUkUgdmFsdWUsIHJldHVybnMgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiBAcmV0dXJucyB7Q29tbWFuZFR5cGV9IG1ldGVyIG1vZGVcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQ3VycmVudE1vZGUoYnVmZmVyLCBjdXJyZW50TW9kZSkge1xyXG5cdHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHRpZiAocmVnaXN0ZXJzLmxlbmd0aCA8IDIpIHtcclxuXHRcdHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbW9kZSByZXNwb25zZVwiKTtcclxuXHR9XHJcblx0Y29uc3QgdmFsMSA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMCwgZmFsc2UpO1xyXG5cclxuXHRpZiAodmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLlJFU0VSVkVEXzIpIHsgLy8gTXVzdCBiZSBpZ25vcmVkLCBpbnRlcm5hbCBzdGF0ZXMgb2YgdGhlIG1ldGVyXHJcblx0XHRyZXR1cm4gY3VycmVudE1vZGU7XHJcblx0fVxyXG5cdGNvbnN0IHZhbHVlID0gdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIHZhbDEpO1xyXG5cdGlmICh2YWx1ZSA9PSBudWxsKVxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtZXRlciBtb2RlIDogXCIgKyB2YWx1ZSk7XHJcblxyXG5cdHJldHVybiB2YWwxO1xyXG59XHJcbi8qKlxyXG4gKiBTZXRzIHRoZSBjdXJyZW50IG1vZGUuXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcnxudWxsfVxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZU1vZGVSZXF1ZXN0KG1vZGUpIHtcclxuXHRjb25zdCB2YWx1ZSA9IHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCBtb2RlKTtcclxuXHRjb25zdCBDSEFOR0VfU1RBVFVTID0gMTtcclxuXHJcblx0Ly8gRmlsdGVyIGludmFsaWQgY29tbWFuZHNcclxuXHRpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuXHRcdHJldHVybiBudWxsO1xyXG5cdH1cclxuXHJcblx0aWYgKG1vZGUgPiBDb21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgbW9kZSA8PSBDb21tYW5kVHlwZS5PRkYpIHsgLy8gTWVhc3VyZW1lbnRzXHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuXHR9XHJcblx0ZWxzZSBpZiAobW9kZSA+IENvbW1hbmRUeXBlLk9GRiAmJiBtb2RlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEKSB7IC8vIEdlbmVyYXRpb25zXHJcblx0XHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuXHRcdFx0Ly8gQ29sZCBqdW5jdGlvbiBub3QgY29uZmlndXJlZFxyXG5cdFx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0XHRkZWZhdWx0OlxyXG5cdFx0XHQvLyBBbGwgdGhlIHNpbXBsZSBjYXNlcyBcclxuXHRcdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG5cdFx0fVxyXG5cclxuXHR9XHJcblx0cmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXaGVuIHRoZSBtZXRlciBpcyBtZWFzdXJpbmcsIG1ha2UgdGhlIG1vZGJ1cyByZXF1ZXN0IG9mIHRoZSB2YWx1ZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSBwYWNrZXRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNZWFzdXJlUmVxdWVzdChtb2RlKSB7XHJcblx0c3dpdGNoIChtb2RlKSB7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fVDpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UZW1wTWVhc3VyZSk7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTUwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1NTBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEyMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDUwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfNFc6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUnRkVGVtcGVyYXR1cmVNZWFzdXJlKTsgLy8gVGVtcC1PaG1cclxuXHRjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lNZWFzdXJlKTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUHVsc2VPRkZNZWFzdXJlKTsgLy8gT04tT0ZGXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5Mb2FkQ2VsbDpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbCk7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNiwgTVNDUmVnaXN0ZXJzLk1pbk1lYXN1cmUpOyAvLyBNaW4tTWF4LU1lYXNcclxuXHRkZWZhdWx0OlxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiTW9kZSBub3QgbWFuYWdlZCA6XCIgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBtZWFzdXJlIHJlYWQgZnJvbSB0aGUgbWV0ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBydHUgYW5zd2VyIChGQzMpXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgY3VycmVudCBtb2RlIG9mIHRoZSBtZXRlclxyXG4gKiBAcmV0dXJucyB7YXJyYXl9IGFuIGFycmF5IHdpdGggZmlyc3QgZWxlbWVudCBcIk1lYXN1cmUgbmFtZSAodW5pdHMpXCI6VmFsdWUsIHNlY29uZCBUaW1lc3RhbXA6YWNxdWlzaXRpb25cclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlTWVhc3VyZShidWZmZXIsIG1vZGUpIHtcclxuXHR2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHR2YXIgbWVhcywgbWVhczIsIG1pbiwgbWF4O1xyXG5cclxuXHQvLyBBbGwgbWVhc3VyZXMgYXJlIGZsb2F0XHJcblx0aWYgKHJlc3BvbnNlRkMzID09IG51bGwpXHJcblx0XHRyZXR1cm4ge307XHJcblxyXG5cdHN3aXRjaCAobW9kZSkge1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fRTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19KOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0s6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTDpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19OOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUzpcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0dmFyIHZhbHVlID0gTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMDtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHZhbHVlLFxyXG5cdFx0XHRcIlVuaXRcIjogXCLCsENcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1NTBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTUwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEyMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDUwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzRXOlxyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHRtZWFzMiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMCkgLyAxMCxcclxuXHRcdFx0XCJVbml0XCI6IFwiwrBDXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJSZXNpc3RhbmNlXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VmFsdWVcIjogTWF0aC5yb3VuZChtZWFzMiAqIDEwKSAvIDEwLFxyXG5cdFx0XHRcIlNlY29uZGFyeVVuaXRcIjogXCJPaG1zXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0Ly8gU2Vuc2liaWxpdMOgIG1hbmNhbnRpXHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5XCIsXHJcblx0XHRcdFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTApIC8gMTAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIkh6XCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLm1BX2FjdGl2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcblx0XHRtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0bWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkN1cnJlbnRcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJtQVwiLFxyXG5cdFx0XHRcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5WOlxyXG5cdFx0bWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuXHRcdG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHRtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJVbml0XCI6IFwiVlwiLFxyXG5cdFx0XHRcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5tVjpcclxuXHRcdG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHRtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIm1WXCIsXHJcblx0XHRcdFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiTWF4aW11bVwiOiBNYXRoLnJvdW5kKG1heCAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcblx0XHRtZWFzID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0bWVhczIgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHQvLyBTb2dsaWEgZSBzZW5zaWJpbGl0w6AgbWFuY2FudGlcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJQdWxzZSBPTlwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IG1lYXMsXHJcblx0XHRcdFwiVW5pdFwiOiBcIlwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUHVsc2UgT0ZGXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VmFsdWVcIjogbWVhczIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VW5pdFwiOiBcIlwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5Mb2FkQ2VsbDpcclxuXHRcdG1lYXMgPSBNYXRoLnJvdW5kKG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCkgKiAxMDAwKSAvIDEwMDA7XHJcblx0XHQvLyBLZyBtYW5jYW50aVxyXG5cdFx0Ly8gU2Vuc2liaWxpdMOgLCB0YXJhLCBwb3J0YXRhIG1hbmNhbnRpXHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiSW1iYWxhbmNlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogbWVhcyxcclxuXHRcdFx0XCJVbml0XCI6IFwibVYvVlwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0ZGVmYXVsdDpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwMCkgLyAxMDAwLFxyXG5cdFx0XHRcIlVuaXRcIjogXCI/XCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgc3RhdHVzIGZsYWdzIGZyb20gbWVhc3VyZW1lbnQgbW9kZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSByZXF1ZXN0IHRvIHNlbmRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VRdWFsaXR5Qml0UmVxdWVzdChtb2RlKSB7XHJcblx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLk1lYXN1cmVGbGFncyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVja3MgaWYgdGhlIGVycm9yIGJpdCBzdGF0dXNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIHRoZXJlIGlzIG5vIGVycm9yXHJcbiAqL1xyXG5mdW5jdGlvbiBpc1F1YWxpdHlWYWxpZChidWZmZXIpIHtcclxuXHR2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHRyZXR1cm4gKChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTMpKSA9PSAwKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlYWRzIHRoZSBnZW5lcmF0aW9uIGZsYWdzIHN0YXR1cyBmcm9tIHRoZSBtZXRlclxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSByZXF1ZXN0IHRvIHNlbmRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VHZW5TdGF0dXNSZWFkKG1vZGUpIHtcclxuXHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuR2VuZXJhdGlvbkZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IGlzIE5PVCBzZXQgaW4gdGhlIGdlbmVyYXRpb24gZmxhZ3NcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VGQzNcclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgdGhlcmUgaXMgbm8gZXJyb3JcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlR2VuU3RhdHVzKGJ1ZmZlciwgbW9kZSkge1xyXG5cdHZhciByZXNwb25zZUZDMyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG5cdHN3aXRjaCAobW9kZSkge1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG5cdFx0cmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMCkgJiYgLy8gR2VuIGVycm9yXHJcbiAgICAgICAgICAgICAgICAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNCkpID09IDApOyAvLyBTZWxmIGdlbmVyYXRpb24gSSBjaGVja1xyXG5cdGRlZmF1bHQ6XHJcblx0XHRyZXR1cm4gKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNSkpID09IDA7IC8vIEdlbiBlcnJvclxyXG5cdH1cclxufVxyXG5cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIGEgYnVmZmVyIHdpdGggdGhlIG1vZGJ1cy1ydHUgcmVxdWVzdCB0byBiZSBzZW50IHRvIFNlbmVjYVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGdlbmVyYXRpb24gbW9kZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQgdGhlIHZhbHVlIHRvIHNldCAobVYvVi9BL0h6L8KwQykgZXhjZXB0IGZvciBwdWxzZXMgbnVtX3B1bHNlc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQyIGZyZXF1ZW5jeSBpbiBIelxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVNldHBvaW50UmVxdWVzdChtb2RlLCBzZXRwb2ludCwgc2V0cG9pbnQyKSB7XHJcblx0dmFyIFRFTVAsIHJlZ2lzdGVycztcclxuXHR2YXIgZHQgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcblx0dmFyIGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcblx0bW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCk7XHJcblx0Y29uc3Qgc3AgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcblxyXG5cdHZhciBkdEludCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuXHR2YXIgZHZJbnQgPSBuZXcgRGF0YVZpZXcoZHRJbnQpO1xyXG5cdG1vZGJ1cy5zZXRVaW50MzJMRUJTKGR2SW50LCAwLCBzZXRwb2ludCk7XHJcblx0Y29uc3Qgc3BJbnQgPSBbZHZJbnQuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHZJbnQuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcblxyXG5cdHN3aXRjaCAobW9kZSkge1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Wb2x0YWdlU2V0cG9pbnQsIHNwKV07IC8vIFYgLyBtViBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ3VycmVudFNldHBvaW50LCBzcCldOyAvLyBJIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlJURFRlbXBlcmF0dXJlU2V0cG9pbnQsIHNwKV07IC8vIMKwQyBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludCwgc3ApXTsgLy8gwrBDIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbFNldHBvaW50LCBzcCldOyAvLyBtVi9WIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG5cdFx0ZHQgPSBuZXcgQXJyYXlCdWZmZXIoOCk7IC8vIDIgVWludDMyXHJcblx0XHRkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG5cdFx0Ly8gU2VlIFNlbmVjYWwgbWFudWFsIG1hbnVhbFxyXG5cdFx0Ly8gTWF4IDIwa0haIGdlblxyXG5cdFx0VEVNUCA9IE1hdGgucm91bmQoMjAwMDAgLyBzZXRwb2ludCwgMCk7XHJcblx0XHRkdi5zZXRVaW50MzIoMCwgTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzFcclxuXHRcdGR2LnNldFVpbnQzMig0LCBURU1QIC0gTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzJcclxuXHJcblx0XHQvLyBCeXRlLXN3YXBwZWQgbGl0dGxlIGVuZGlhblxyXG5cdFx0cmVnaXN0ZXJzID0gW2R2LmdldFVpbnQxNigyLCBmYWxzZSksIGR2LmdldFVpbnQxNigwLCBmYWxzZSksXHJcblx0XHRcdGR2LmdldFVpbnQxNig2LCBmYWxzZSksIGR2LmdldFVpbnQxNig0LCBmYWxzZSldO1xyXG5cclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeVRJQ0sxLCByZWdpc3RlcnMpXTtcclxuXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuXHRcdGR0ID0gbmV3IEFycmF5QnVmZmVyKDEyKTsgLy8gMyBVaW50MzIgXHJcblx0XHRkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG5cdFx0Ly8gU2VlIFNlbmVjYWwgbWFudWFsIG1hbnVhbFxyXG5cdFx0Ly8gTWF4IDIwa0haIGdlblxyXG5cdFx0VEVNUCA9IE1hdGgucm91bmQoMjAwMDAgLyBzZXRwb2ludDIsIDApO1xyXG5cclxuXHRcdGR2LnNldFVpbnQzMigwLCBzZXRwb2ludCwgZmFsc2UpOyAvLyBOVU1fUFVMU0VTXHJcblx0XHRkdi5zZXRVaW50MzIoNCwgTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzFcclxuXHRcdGR2LnNldFVpbnQzMig4LCBURU1QIC0gTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzJcclxuXHJcblx0XHRyZWdpc3RlcnMgPSBbZHYuZ2V0VWludDE2KDIsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDAsIGZhbHNlKV07XHJcblx0XHR2YXIgcDEgPSBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUHVsc2VzQ291bnQsIHJlZ2lzdGVycyk7IC8vIG11c3Qgc3BsaXQgaW4gdHdvIHRvIHN0YXkgPD0gMjAgYnl0ZXMgZm9yIHRoZSBmdWxsIHJ0dSBwYWNrZXRcclxuICAgICAgICAgICAgXHJcblx0XHRyZWdpc3RlcnMgPSBbIGR2LmdldFVpbnQxNig2LCBmYWxzZSksIGR2LmdldFVpbnQxNig0LCBmYWxzZSksXHJcblx0XHRcdGR2LmdldFVpbnQxNigxMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoOCwgZmFsc2UpXTtcclxuXHRcdHZhciBwMiA9IG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSwgcmVnaXN0ZXJzKTtcclxuXHRcdHJldHVybiBbcDEsIHAyXTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VVGhyZXNob2xkX0Y6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5UaHJlc2hvbGRVX0ZyZXEsIHNwKV07IC8vIFUgbWluIGZvciBmcmVxIG1lYXN1cmVtZW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfU2Vuc2l0aXZpdHlfdVM6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5TZW5zaWJpbGl0eV91U19PRkYsXHJcblx0XHRcdFtzcEludFswXSwgc3BJbnRbMV0sIHNwSW50WzBdLCBzcEludFsxXV0pXTsgLy8gdVYgZm9yIHB1bHNlIHRyYWluIG1lYXN1cmVtZW50IHRvIE9OIC8gT0ZGXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfQ29sZEp1bmN0aW9uOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ29sZEp1bmN0aW9uLCBzcCldOyAvLyB1bmNsZWFyIHVuaXRcclxuXHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VbG93OlxyXG5cdFx0bW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCAvIGNvbnN0YW50cy5NQVhfVV9HRU4pOyAvLyBNdXN0IGNvbnZlcnQgViBpbnRvIGEgJSAwLi5NQVhfVV9HRU5cclxuXHRcdHZhciBzcDIgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HZW5VbG93UGVyYywgc3AyKV07IC8vIFUgbG93IGZvciBmcmVxIC8gcHVsc2UgZ2VuXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfVWhpZ2g6XHJcblx0XHRtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gY29uc3RhbnRzLk1BWF9VX0dFTik7IC8vIE11c3QgY29udmVydCBWIGludG8gYSAlIDAuLk1BWF9VX0dFTlxyXG5cdFx0dmFyIHNwMyA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdlblVoaWdoUGVyYywgc3AzKV07IC8vIFUgaGlnaCBmb3IgZnJlcSAvIHB1bHNlIGdlbiAgICAgICAgICAgIFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Qb3dlck9mZkRlbGF5LCBzZXRwb2ludCldOyAvLyBkZWxheSBpbiBzZWNcclxuXHRjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuXHRcdHJldHVybiBbXTsgLy8gTm8gc2V0cG9pbnRcclxuXHRkZWZhdWx0OlxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiTm90IGhhbmRsZWRcIik7XHJcblx0fVxyXG5cdHJldHVybiBbXTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlYWRzIHRoZSBzZXRwb2ludFxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSByZXF1ZXN0XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlU2V0cG9pbnRSZWFkKG1vZGUpIHtcclxuXHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlZvbHRhZ2VTZXRwb2ludCk7IC8vIG1WIG9yIFYgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5DdXJyZW50U2V0cG9pbnQpOyAvLyBBIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5SVERUZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludCk7IC8vIMKwQyBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeVRJQ0sxKTsgLy8gRnJlcXVlbmN5IHNldHBvaW50IChUSUNLUylcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbFNldHBvaW50KTsgLy8gbVYvViBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cdHRocm93IG5ldyBFcnJvcihcIk5vdCBoYW5kbGVkXCIpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSBhbnN3ZXIgYWJvdXQgU2V0cG9pbnRSZWFkXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlZ2lzdGVycyBGQzMgcGFyc2VkIGFuc3dlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSB0aGUgbGFzdCBzZXRwb2ludFxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VTZXRwb2ludFJlYWQoYnVmZmVyLCBtb2RlKSB7XHJcblx0Ly8gUm91bmQgdG8gdHdvIGRpZ2l0c1xyXG5cdHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHR2YXIgcm91bmRlZCA9IE1hdGgucm91bmQobW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCkgKiAxMDApIC8gMTAwO1xyXG5cclxuXHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJDdXJyZW50XCIsXHJcblx0XHRcdFwiVmFsdWVcIjogcm91bmRlZCxcclxuXHRcdFx0XCJVbml0XCI6IFwibUFcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHJvdW5kZWQsXHJcblx0XHRcdFwiVW5pdFwiOiBcIlZcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiByb3VuZGVkLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJtVlwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiSW1iYWxhbmNlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogcm91bmRlZCxcclxuXHRcdFx0XCJVbml0XCI6IFwibVYvVlwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcblx0XHR2YXIgdGljazEgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZWdpc3RlcnMsIDApO1xyXG5cdFx0dmFyIHRpY2syID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVnaXN0ZXJzLCA0KTtcclxuXHRcdHZhciBmT04gPSAwLjA7XHJcblx0XHR2YXIgZk9GRiA9IDAuMDtcclxuXHRcdGlmICh0aWNrMSAhPSAwKVxyXG5cdFx0XHRmT04gPSBNYXRoLnJvdW5kKDEgLyAodGljazEgKiAyIC8gMjAwMDAuMCkgKiAxMC4wKSAvIDEwOyAvLyBOZWVkIG9uZSBkZWNpbWFsIHBsYWNlIGZvciBIWlxyXG5cdFx0aWYgKHRpY2syICE9IDApXHJcblx0XHRcdGZPRkYgPSBNYXRoLnJvdW5kKDEgLyAodGljazIgKiAyIC8gMjAwMDAuMCkgKiAxMC4wKSAvIDEwOyAvLyBOZWVkIG9uZSBkZWNpbWFsIHBsYWNlIGZvciBIWlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeSBPTlwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IGZPTixcclxuXHRcdFx0XCJVbml0XCI6IFwiSHpcIixcclxuXHRcdFx0XCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeSBPRkZcIixcclxuXHRcdFx0XCJTZWNvbmRhcnlWYWx1ZVwiOiBmT0ZGLFxyXG5cdFx0XHRcIlNlY29uZGFyeVVuaXRcIjogXCJIelwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiByb3VuZGVkLFxyXG5cdFx0XHRcIlVuaXRcIjogXCLCsENcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGRlZmF1bHQ6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVW5rbm93blwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHJvdW5kZWQsXHJcblx0XHRcdFwiVW5pdFwiOiBcIj9cIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdH1cclxuXHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1xyXG5cdE1TQ1JlZ2lzdGVycywgbWFrZVNlcmlhbE51bWJlciwgbWFrZUN1cnJlbnRNb2RlLCBtYWtlQmF0dGVyeUxldmVsLCBwYXJzZUJhdHRlcnksIHBhcnNlU2VyaWFsTnVtYmVyLFxyXG5cdHBhcnNlQ3VycmVudE1vZGUsIG1ha2VNb2RlUmVxdWVzdCwgbWFrZU1lYXN1cmVSZXF1ZXN0LCBwYXJzZU1lYXN1cmUsIG1ha2VRdWFsaXR5Qml0UmVxdWVzdCwgaXNRdWFsaXR5VmFsaWQsXHJcblx0bWFrZUdlblN0YXR1c1JlYWQsIHBhcnNlR2VuU3RhdHVzLCBtYWtlU2V0cG9pbnRSZXF1ZXN0LCBtYWtlU2V0cG9pbnRSZWFkLCBwYXJzZVNldHBvaW50UmVhZFxyXG59OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuXHJcbmxldCBzbGVlcCA9IG1zID0+IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5sZXQgd2FpdEZvciA9IGFzeW5jIGZ1bmN0aW9uIHdhaXRGb3IoZikge1xyXG5cdHdoaWxlICghZigpKSBhd2FpdCBzbGVlcCgxMDAgKyBNYXRoLnJhbmRvbSgpICogMjUpO1xyXG5cdHJldHVybiBmKCk7XHJcbn07XHJcblxyXG5sZXQgd2FpdEZvclRpbWVvdXQgPSBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yKGYsIHRpbWVvdXRTZWMpIHtcclxuXHR2YXIgdG90YWxUaW1lTXMgPSAwO1xyXG5cdHdoaWxlICghZigpICYmIHRvdGFsVGltZU1zIDwgdGltZW91dFNlYyAqIDEwMDApIHtcclxuXHRcdHZhciBkZWxheU1zID0gMTAwICsgTWF0aC5yYW5kb20oKSAqIDI1O1xyXG5cdFx0dG90YWxUaW1lTXMgKz0gZGVsYXlNcztcclxuXHRcdGF3YWl0IHNsZWVwKGRlbGF5TXMpO1xyXG5cdH1cclxuXHRyZXR1cm4gZigpO1xyXG59O1xyXG5cclxuLy8gVGhlc2UgZnVuY3Rpb25zIG11c3QgZXhpc3Qgc3RhbmQtYWxvbmUgb3V0c2lkZSBDb21tYW5kIG9iamVjdCBhcyB0aGlzIG9iamVjdCBtYXkgY29tZSBmcm9tIEpTT04gd2l0aG91dCB0aGVtIVxyXG5mdW5jdGlvbiBpc0dlbmVyYXRpb24oY3R5cGUpIHtcclxuXHRyZXR1cm4gKGN0eXBlID4gQ29tbWFuZFR5cGUuT0ZGICYmIGN0eXBlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc01lYXN1cmVtZW50KGN0eXBlKSB7XHJcblx0cmV0dXJuIChjdHlwZSA+IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiBjdHlwZSA8IENvbW1hbmRUeXBlLlJFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc1NldHRpbmcoY3R5cGUpIHtcclxuXHRyZXR1cm4gKGN0eXBlID09IENvbW1hbmRUeXBlLk9GRiB8fCBjdHlwZSA+IENvbW1hbmRUeXBlLlNFVFRJTkdfUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzVmFsaWQoY3R5cGUpIHtcclxuXHRyZXR1cm4gKGlzTWVhc3VyZW1lbnQoY3R5cGUpIHx8IGlzR2VuZXJhdGlvbihjdHlwZSkgfHwgaXNTZXR0aW5nKGN0eXBlKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gY29udmVydCBhIHZhbHVlIGludG8gYW4gZW51bSB2YWx1ZVxyXG4gKiBcclxuICogQHBhcmFtIHt0eXBlfSBlbnVtdHlwZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gZW51bXZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBQYXJzZShlbnVtdHlwZSwgZW51bXZhbHVlKSB7XHJcblx0Zm9yICh2YXIgZW51bU5hbWUgaW4gZW51bXR5cGUpIHtcclxuXHRcdGlmIChlbnVtdHlwZVtlbnVtTmFtZV0gPT0gZW51bXZhbHVlKSB7XHJcblx0XHRcdC8qanNoaW50IC1XMDYxICovXHJcblx0XHRcdHJldHVybiBldmFsKFtlbnVtdHlwZSArIFwiLlwiICsgZW51bU5hbWVdKTtcclxuXHRcdH1cclxuXHR9XHJcblx0cmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gZHVtcCBhcnJheWJ1ZmZlciBhcyBoZXggc3RyaW5nXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlclxyXG4gKi9cclxuZnVuY3Rpb24gYnVmMmhleChidWZmZXIpIHsgLy8gYnVmZmVyIGlzIGFuIEFycmF5QnVmZmVyXHJcblx0cmV0dXJuIFsuLi5uZXcgVWludDhBcnJheShidWZmZXIpXVxyXG5cdFx0Lm1hcCh4ID0+IHgudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSlcclxuXHRcdC5qb2luKFwiIFwiKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGV4MmJ1ZihpbnB1dCkge1xyXG5cdGlmICh0eXBlb2YgaW5wdXQgIT09IFwic3RyaW5nXCIpIHtcclxuXHRcdHRocm93IG5ldyBUeXBlRXJyb3IoXCJFeHBlY3RlZCBpbnB1dCB0byBiZSBhIHN0cmluZ1wiKTtcclxuXHR9XHJcblx0dmFyIGhleHN0ciA9IGlucHV0LnJlcGxhY2UoL1xccysvZywgXCJcIik7XHJcblx0aWYgKChoZXhzdHIubGVuZ3RoICUgMikgIT09IDApIHtcclxuXHRcdHRocm93IG5ldyBSYW5nZUVycm9yKFwiRXhwZWN0ZWQgc3RyaW5nIHRvIGJlIGFuIGV2ZW4gbnVtYmVyIG9mIGNoYXJhY3RlcnNcIik7XHJcblx0fVxyXG5cclxuXHRjb25zdCB2aWV3ID0gbmV3IFVpbnQ4QXJyYXkoaGV4c3RyLmxlbmd0aCAvIDIpO1xyXG5cclxuXHRmb3IgKGxldCBpID0gMDsgaSA8IGhleHN0ci5sZW5ndGg7IGkgKz0gMikge1xyXG5cdFx0dmlld1tpIC8gMl0gPSBwYXJzZUludChoZXhzdHIuc3Vic3RyaW5nKGksIGkgKyAyKSwgMTYpO1xyXG5cdH1cclxuXHJcblx0cmV0dXJuIHZpZXcuYnVmZmVyO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgc2xlZXAsIHdhaXRGb3IsIHdhaXRGb3JUaW1lb3V0LCBpc0dlbmVyYXRpb24sIGlzTWVhc3VyZW1lbnQsIGlzU2V0dGluZywgaXNWYWxpZCwgUGFyc2UsIGJ1ZjJoZXgsIGhleDJidWYgfTsiXX0=
