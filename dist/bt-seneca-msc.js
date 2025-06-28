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
		if (btState.state_cpt > Math.floor(TIMEOUT_MS / DELAY_MS)) {
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
		if (btState.state_cpt > Math.floor(TIMEOUT_MS / DELAY_MS)) {
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
		if (btState.state_cpt > Math.floor(TIMEOUT_MS / DELAY_MS)) {
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
		utils.sleep(DELAY_MS).then(() => stateMachine()).catch((err) => {
			log.error("State machine error:", err);
			btState.state = State.ERROR;
		}); // Recheck status in DELAY_MS ms
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
			// Prevent memory leak by limiting maximum response buffer size
			const MAX_RESPONSE_SIZE = 1024; // 1KB limit for modbus responses
			const newSize = btState.response.byteLength + value.buffer.byteLength;
			if (newSize > MAX_RESPONSE_SIZE) {
				log.warn("Response buffer too large, resetting");
				btState.response = value.buffer.slice();
			} else {
				btState.response = arrayBufferConcat(btState.response, value.buffer);
			}
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

		// emulated continuity checker
		this.continuity = false;

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
const { btState } = require("./APIState");

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
		case CommandType.Continuity:
			btState.continuity = true;
			break;
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
},{"../constants":7,"../modbusRtu":10,"../senecaModbus":13,"../utils":14,"./APIState":2,"loglevel":12}],7:[function(require,module,exports){
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
	Continuity: 41,
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

const ContinuityImpl = CommandType.Cu50_2W;
const ContinuityThresholdOhms = 75;

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

module.exports = {State, CommandType, ResultCode, MAX_U_GEN, ContinuityImpl, ContinuityThresholdOhms};

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
		try {
			await bluetooth.stateMachine();
		} catch (err) {
			log.error("Failed to start state machine:", err);
			command.error = true;
			command.pending = false;
			return command;
		}
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
		bluetooth.stateMachine().catch((err) => {
			log.error("State machine failed during pairing:", err);
			btState.state = State.ERROR;
		}); // Start it
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
	constructor(message, fc) {
		super(message);
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

    var _loggersByName = {};
    var defaultLogger = null;

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

    function replaceLoggingMethods() {
        /*jshint validthis:true */
        var level = this.getLevel();

        // Replace the actual methods.
        for (var i = 0; i < logMethods.length; i++) {
            var methodName = logMethods[i];
            this[methodName] = (i < level) ?
                noop :
                this.methodFactory(methodName, level, this.name);
        }

        // Define log.log as an alias for log.debug
        this.log = this.debug;

        // Return any important warnings.
        if (typeof console === undefinedType && level < this.levels.SILENT) {
            return "No console available for logging";
        }
    }

    // In old IE versions, the console isn't present until you first open it.
    // We build realMethod() replacements here that regenerate logging methods
    function enableLoggingWhenConsoleArrives(methodName) {
        return function () {
            if (typeof console !== undefinedType) {
                replaceLoggingMethods.call(this);
                this[methodName].apply(this, arguments);
            }
        };
    }

    // By default, we use closely bound real methods wherever possible, and
    // otherwise we wait for a console to appear, and then try again.
    function defaultMethodFactory(methodName, _level, _loggerName) {
        /*jshint validthis:true */
        return realMethod(methodName) ||
               enableLoggingWhenConsoleArrives.apply(this, arguments);
    }

    function Logger(name, factory) {
      // Private instance variables.
      var self = this;
      /**
       * The level inherited from a parent logger (or a global default). We
       * cache this here rather than delegating to the parent so that it stays
       * in sync with the actual logging methods that we have installed (the
       * parent could change levels but we might not have rebuilt the loggers
       * in this child yet).
       * @type {number}
       */
      var inheritedLevel;
      /**
       * The default level for this logger, if any. If set, this overrides
       * `inheritedLevel`.
       * @type {number|null}
       */
      var defaultLevel;
      /**
       * A user-specific level for this logger. If set, this overrides
       * `defaultLevel`.
       * @type {number|null}
       */
      var userLevel;

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
                  var cookieName = encodeURIComponent(storageKey);
                  var location = cookie.indexOf(cookieName + "=");
                  if (location !== -1) {
                      storedLevel = /^([^;]+)/.exec(
                          cookie.slice(location + cookieName.length + 1)
                      )[1];
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
          } catch (ignore) {}

          // Use session cookie as fallback
          try {
              window.document.cookie =
                encodeURIComponent(storageKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC";
          } catch (ignore) {}
      }

      function normalizeLevel(input) {
          var level = input;
          if (typeof level === "string" && self.levels[level.toUpperCase()] !== undefined) {
              level = self.levels[level.toUpperCase()];
          }
          if (typeof level === "number" && level >= 0 && level <= self.levels.SILENT) {
              return level;
          } else {
              throw new TypeError("log.setLevel() called with invalid level: " + input);
          }
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
          if (userLevel != null) {
            return userLevel;
          } else if (defaultLevel != null) {
            return defaultLevel;
          } else {
            return inheritedLevel;
          }
      };

      self.setLevel = function (level, persist) {
          userLevel = normalizeLevel(level);
          if (persist !== false) {  // defaults to true
              persistLevelIfPossible(userLevel);
          }

          // NOTE: in v2, this should call rebuild(), which updates children.
          return replaceLoggingMethods.call(self);
      };

      self.setDefaultLevel = function (level) {
          defaultLevel = normalizeLevel(level);
          if (!getPersistedLevel()) {
              self.setLevel(level, false);
          }
      };

      self.resetLevel = function () {
          userLevel = null;
          clearPersistedLevel();
          replaceLoggingMethods.call(self);
      };

      self.enableAll = function(persist) {
          self.setLevel(self.levels.TRACE, persist);
      };

      self.disableAll = function(persist) {
          self.setLevel(self.levels.SILENT, persist);
      };

      self.rebuild = function () {
          if (defaultLogger !== self) {
              inheritedLevel = normalizeLevel(defaultLogger.getLevel());
          }
          replaceLoggingMethods.call(self);

          if (defaultLogger === self) {
              for (var childName in _loggersByName) {
                _loggersByName[childName].rebuild();
              }
          }
      };

      // Initialize all the internal levels.
      inheritedLevel = normalizeLevel(
          defaultLogger ? defaultLogger.getLevel() : "WARN"
      );
      var initialLevel = getPersistedLevel();
      if (initialLevel != null) {
          userLevel = normalizeLevel(initialLevel);
      }
      replaceLoggingMethods.call(self);
    }

    /*
     *
     * Top-level API
     *
     */

    defaultLogger = new Logger();

    defaultLogger.getLogger = function getLogger(name) {
        if ((typeof name !== "symbol" && typeof name !== "string") || name === "") {
            throw new TypeError("You must supply a name when creating a logger.");
        }

        var logger = _loggersByName[name];
        if (!logger) {
            logger = _loggersByName[name] = new Logger(
                name,
                defaultLogger.methodFactory
            );
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
const { Command } = require("./meterApi");
const { btState } = require("./classes/APIState");

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

	if (val1 == constants.ContinuityImpl && btState.continuity)
	{
		return CommandType.Continuity;
	}
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

	btState.continuity = false;

	if (mode > CommandType.NONE_UNKNOWN && mode <= CommandType.OFF) { // Measurements
		if (mode == CommandType.Continuity)
		{
			mode = constants.ContinuityImpl;
			btState.continuity = true;
		}
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
	case CommandType.Continuity:
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
	case CommandType.Continuity:
		meas2 = modbus.getFloat32LEBS(responseFC3, 4);
		return {
			"Description": "Continuity",
			"Value": (meas2 < constants.ContinuityThresholdOhms) ? 1 : 0,
			"Unit": "None",
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
},{"./classes/APIState":2,"./constants":7,"./meterApi":8,"./modbusRtu":10,"./utils":14}],14:[function(require,module,exports){
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
	return (ctype > CommandType.NONE_UNKNOWN && ctype < CommandType.RESERVED || ctype == CommandType.Continuity);
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
			return enumtype[enumName];
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

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY2xhc3Nlcy9TZW5lY2FNU0MuanMiLCJjb25zdGFudHMuanMiLCJtZXRlckFwaS5qcyIsIm1ldGVyUHVibGljQVBJLmpzIiwibW9kYnVzUnR1LmpzIiwibW9kYnVzVGVzdERhdGEuanMiLCJub2RlX21vZHVsZXMvbG9nbGV2ZWwvbGliL2xvZ2xldmVsLmpzIiwic2VuZWNhTW9kYnVzLmpzIiwidXRpbHMuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaHBCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2UkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5UEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeFFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xqRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcldBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9xQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCl7ZnVuY3Rpb24gcihlLG4sdCl7ZnVuY3Rpb24gbyhpLGYpe2lmKCFuW2ldKXtpZighZVtpXSl7dmFyIGM9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZTtpZighZiYmYylyZXR1cm4gYyhpLCEwKTtpZih1KXJldHVybiB1KGksITApO3ZhciBhPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIraStcIidcIik7dGhyb3cgYS5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGF9dmFyIHA9bltpXT17ZXhwb3J0czp7fX07ZVtpXVswXS5jYWxsKHAuZXhwb3J0cyxmdW5jdGlvbihyKXt2YXIgbj1lW2ldWzFdW3JdO3JldHVybiBvKG58fHIpfSxwLHAuZXhwb3J0cyxyLGUsbix0KX1yZXR1cm4gbltpXS5leHBvcnRzfWZvcih2YXIgdT1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlLGk9MDtpPHQubGVuZ3RoO2krKylvKHRbaV0pO3JldHVybiBvfXJldHVybiByfSkoKSIsIlwidXNlIHN0cmljdFwiO1xyXG5cclxuLyoqXHJcbiAqICBCbHVldG9vdGggaGFuZGxpbmcgbW9kdWxlLCBpbmNsdWRpbmcgbWFpbiBzdGF0ZSBtYWNoaW5lIGxvb3AuXHJcbiAqICBUaGlzIG1vZHVsZSBpbnRlcmFjdHMgd2l0aCBicm93c2VyIGZvciBibHVldG9vdGggY29tdW5pY2F0aW9ucyBhbmQgcGFpcmluZywgYW5kIHdpdGggU2VuZWNhTVNDIG9iamVjdC5cclxuICovXHJcblxyXG52YXIgQVBJU3RhdGUgPSByZXF1aXJlKFwiLi9jbGFzc2VzL0FQSVN0YXRlXCIpO1xyXG52YXIgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKFwiLi91dGlsc1wiKTtcclxudmFyIHNlbmVjYU1vZHVsZSA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvU2VuZWNhTVNDXCIpO1xyXG52YXIgbW9kYnVzID0gcmVxdWlyZShcIi4vbW9kYnVzUnR1XCIpO1xyXG52YXIgdGVzdERhdGEgPSByZXF1aXJlKFwiLi9tb2RidXNUZXN0RGF0YVwiKTtcclxuXHJcbnZhciBidFN0YXRlID0gQVBJU3RhdGUuYnRTdGF0ZTtcclxudmFyIFN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbnZhciBSZXN1bHRDb2RlID0gY29uc3RhbnRzLlJlc3VsdENvZGU7XHJcbnZhciBzaW11bGF0aW9uID0gZmFsc2U7XHJcbnZhciBsb2dnaW5nID0gZmFsc2U7XHJcbi8qXHJcbiAqIEJsdWV0b290aCBjb25zdGFudHNcclxuICovXHJcbmNvbnN0IEJsdWVUb290aE1TQyA9IHtcclxuXHRTZXJ2aWNlVXVpZDogXCIwMDAzY2RkMC0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzFcIiwgLy8gYmx1ZXRvb3RoIG1vZGJ1cyBSVFUgc2VydmljZSBmb3IgU2VuZWNhIE1TQ1xyXG5cdE1vZGJ1c0Fuc3dlclV1aWQ6IFwiMDAwM2NkZDEtMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxXCIsICAgICAvLyBtb2RidXMgUlRVIGFuc3dlcnNcclxuXHRNb2RidXNSZXF1ZXN0VXVpZDogXCIwMDAzY2RkMi0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzFcIiAgICAvLyBtb2RidXMgUlRVIHJlcXVlc3RzXHJcbn07XHJcblxyXG5cclxuLyoqXHJcbiAqIFNlbmQgdGhlIG1lc3NhZ2UgdXNpbmcgQmx1ZXRvb3RoIGFuZCB3YWl0IGZvciBhbiBhbnN3ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gY29tbWFuZCBtb2RidXMgUlRVIHBhY2tldCB0byBzZW5kXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gdGhlIG1vZGJ1cyBSVFUgYW5zd2VyXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBTZW5kQW5kUmVzcG9uc2UoY29tbWFuZCkge1xyXG5cclxuXHRpZiAoY29tbWFuZCA9PSBudWxsKVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblxyXG5cdGxvZy5kZWJ1ZyhcIj4+IFwiICsgdXRpbHMuYnVmMmhleChjb21tYW5kKSk7XHJcblxyXG5cdGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cdGJ0U3RhdGUuc3RhdHNbXCJyZXF1ZXN0c1wiXSsrO1xyXG5cclxuXHR2YXIgc3RhcnRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblx0aWYgKHNpbXVsYXRpb24pIHtcclxuXHRcdGJ0U3RhdGUucmVzcG9uc2UgPSBmYWtlUmVzcG9uc2UoY29tbWFuZCk7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCg1KTtcclxuXHR9XHJcblx0ZWxzZSB7XHJcblx0XHRhd2FpdCBidFN0YXRlLmNoYXJXcml0ZS53cml0ZVZhbHVlV2l0aG91dFJlc3BvbnNlKGNvbW1hbmQpO1xyXG5cdFx0d2hpbGUgKGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuTUVURVJfSU5JVElBTElaSU5HIHx8XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuQlVTWSkge1xyXG5cdFx0XHRpZiAoYnRTdGF0ZS5yZXNwb25zZSAhPSBudWxsKSBicmVhaztcclxuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDM1KSk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHR2YXIgZW5kVGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG5cclxuXHR2YXIgYW5zd2VyID0gYnRTdGF0ZS5yZXNwb25zZT8uc2xpY2UoKTtcclxuXHRidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuXHJcblx0Ly8gTG9nIHRoZSBwYWNrZXRzXHJcblx0aWYgKGxvZ2dpbmcpIHtcclxuXHRcdHZhciBwYWNrZXQgPSB7IFwicmVxdWVzdFwiOiB1dGlscy5idWYyaGV4KGNvbW1hbmQpLCBcImFuc3dlclwiOiB1dGlscy5idWYyaGV4KGFuc3dlcikgfTtcclxuXHRcdHZhciBwYWNrZXRzID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKFwiTW9kYnVzUlRVdHJhY2VcIik7XHJcblx0XHRpZiAocGFja2V0cyA9PSBudWxsKSB7XHJcblx0XHRcdHBhY2tldHMgPSBbXTsgLy8gaW5pdGlhbGl6ZSBhcnJheVxyXG5cdFx0fVxyXG5cdFx0ZWxzZSB7XHJcblx0XHRcdHBhY2tldHMgPSBKU09OLnBhcnNlKHBhY2tldHMpOyAvLyBSZXN0b3JlIHRoZSBqc29uIHBlcnNpc3RlZCBvYmplY3RcclxuXHRcdH1cclxuXHRcdHBhY2tldHMucHVzaChwYWNrZXQpOyAvLyBBZGQgdGhlIG5ldyBvYmplY3RcclxuXHRcdHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbShcIk1vZGJ1c1JUVXRyYWNlXCIsIEpTT04uc3RyaW5naWZ5KHBhY2tldHMpKTtcclxuXHR9XHJcblxyXG5cdGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKCgxLjAgKiBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdICogKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgKGVuZFRpbWUgLSBzdGFydFRpbWUpKSAvICgoYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSAlIDUwMCkgKyAxKSk7XHJcblx0YnRTdGF0ZS5zdGF0c1tcImxhc3RSZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKGVuZFRpbWUgLSBzdGFydFRpbWUpICsgXCIgbXNcIjtcclxuXHRidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VzXCJdKys7XHJcblxyXG5cdHJldHVybiBhbnN3ZXI7XHJcbn1cclxuXHJcbmxldCBzZW5lY2FNU0MgPSBuZXcgc2VuZWNhTW9kdWxlLlNlbmVjYU1TQyhTZW5kQW5kUmVzcG9uc2UpO1xyXG5cclxuLyoqXHJcbiAqIE1haW4gbG9vcCBvZiB0aGUgbWV0ZXIgaGFuZGxlci5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gc3RhdGVNYWNoaW5lKCkge1xyXG5cdHZhciBuZXh0QWN0aW9uO1xyXG5cdHZhciBERUxBWV9NUyA9IChzaW11bGF0aW9uID8gMjAgOiA3NTApOyAvLyBVcGRhdGUgdGhlIHN0YXR1cyBldmVyeSBYIG1zLlxyXG5cdHZhciBUSU1FT1VUX01TID0gKHNpbXVsYXRpb24gPyAxMDAwIDogMzAwMDApOyAvLyBHaXZlIHVwIHNvbWUgb3BlcmF0aW9ucyBhZnRlciBYIG1zLlxyXG5cdGJ0U3RhdGUuc3RhcnRlZCA9IHRydWU7XHJcblxyXG5cdGxvZy5kZWJ1ZyhcIkN1cnJlbnQgc3RhdGU6XCIgKyBidFN0YXRlLnN0YXRlKTtcclxuXHJcblx0Ly8gQ29uc2VjdXRpdmUgc3RhdGUgY291bnRlZC4gQ2FuIGJlIHVzZWQgdG8gdGltZW91dC5cclxuXHRpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBidFN0YXRlLnByZXZfc3RhdGUpIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGVfY3B0Kys7XHJcblx0fSBlbHNlIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHR9XHJcblxyXG5cdC8vIFN0b3AgcmVxdWVzdCBmcm9tIEFQSVxyXG5cdGlmIChidFN0YXRlLnN0b3BSZXF1ZXN0KSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBJTkc7XHJcblx0fVxyXG5cclxuXHRsb2cuZGVidWcoXCJTdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG5cdHN3aXRjaCAoYnRTdGF0ZS5zdGF0ZSkge1xyXG5cdGNhc2UgU3RhdGUuTk9UX0NPTk5FQ1RFRDogLy8gaW5pdGlhbCBzdGF0ZSBvbiBTdGFydCgpXHJcblx0XHRpZiAoc2ltdWxhdGlvbikge1xyXG5cdFx0XHRuZXh0QWN0aW9uID0gZmFrZVBhaXJEZXZpY2U7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRuZXh0QWN0aW9uID0gYnRQYWlyRGV2aWNlO1xyXG5cdFx0fVxyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5DT05ORUNUSU5HOiAvLyB3YWl0aW5nIGZvciBjb25uZWN0aW9uIHRvIGNvbXBsZXRlXHJcblx0XHRuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOiAvLyBjb25uZWN0aW9uIGNvbXBsZXRlLCBhY3F1aXJlIG1ldGVyIHN0YXRlXHJcblx0XHRpZiAoc2ltdWxhdGlvbikge1xyXG5cdFx0XHRuZXh0QWN0aW9uID0gZmFrZVN1YnNjcmliZTtcclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdG5leHRBY3Rpb24gPSBidFN1YnNjcmliZTtcclxuXHRcdH1cclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6IC8vIHdhaXRpbmcgZm9yIEJsdWV0b290aCBpbnRlcmZhY2VzXHJcblx0XHRuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG5cdFx0aWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gTWF0aC5mbG9vcihUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcblx0XHRcdC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG5cdFx0XHRsb2cud2FybihcIlRpbWVvdXQgaW4gU1VCU0NSSUJJTkdcIik7XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0XHRidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcblx0XHR9XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLk1FVEVSX0lOSVQ6IC8vIHJlYWR5IHRvIGNvbW11bmljYXRlLCBhY3F1aXJlIG1ldGVyIHN0YXR1c1xyXG5cdFx0bmV4dEFjdGlvbiA9IG1ldGVySW5pdDtcclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuTUVURVJfSU5JVElBTElaSU5HOiAvLyByZWFkaW5nIHRoZSBtZXRlciBzdGF0dXNcclxuXHRcdGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IE1hdGguZmxvb3IoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG5cdFx0XHRsb2cud2FybihcIlRpbWVvdXQgaW4gTUVURVJfSU5JVElBTElaSU5HXCIpO1xyXG5cdFx0XHQvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuXHRcdFx0aWYgKHNpbXVsYXRpb24pIHtcclxuXHRcdFx0XHRuZXh0QWN0aW9uID0gZmFrZVN1YnNjcmliZTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcblx0XHRcdH1cclxuXHRcdFx0YnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG5cdFx0fVxyXG5cdFx0bmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuSURMRTogLy8gcmVhZHkgdG8gcHJvY2VzcyBjb21tYW5kcyBmcm9tIEFQSVxyXG5cdFx0aWYgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsKVxyXG5cdFx0XHRuZXh0QWN0aW9uID0gcHJvY2Vzc0NvbW1hbmQ7XHJcblx0XHRlbHNlIHtcclxuXHRcdFx0bmV4dEFjdGlvbiA9IHJlZnJlc2g7XHJcblx0XHR9XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLkVSUk9SOiAvLyBhbnl0aW1lIGFuIGVycm9yIGhhcHBlbnNcclxuXHRcdG5leHRBY3Rpb24gPSBkaXNjb25uZWN0O1xyXG5cdFx0YnJlYWs7XHJcblx0Y2FzZSBTdGF0ZS5CVVNZOiAvLyB3aGlsZSBhIGNvbW1hbmQgaW4gZ29pbmcgb25cclxuXHRcdGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IE1hdGguZmxvb3IoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG5cdFx0XHRsb2cud2FybihcIlRpbWVvdXQgaW4gQlVTWVwiKTtcclxuXHRcdFx0Ly8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcblx0XHRcdGlmIChzaW11bGF0aW9uKSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGZha2VTdWJzY3JpYmU7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHRcdH1cclxuXHRcdG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLlNUT1BQSU5HOlxyXG5cdFx0bmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLlNUT1BQRUQ6IC8vIGFmdGVyIGEgZGlzY29ubmVjdG9yIG9yIFN0b3AoKSByZXF1ZXN0LCBzdG9wcyB0aGUgc3RhdGUgbWFjaGluZS5cclxuXHRcdG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcblx0XHRicmVhaztcclxuXHRkZWZhdWx0OlxyXG5cdFx0YnJlYWs7XHJcblx0fVxyXG5cclxuXHRidFN0YXRlLnByZXZfc3RhdGUgPSBidFN0YXRlLnN0YXRlO1xyXG5cclxuXHRpZiAobmV4dEFjdGlvbiAhPSB1bmRlZmluZWQpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdEV4ZWN1dGluZzpcIiArIG5leHRBY3Rpb24ubmFtZSk7XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCBuZXh0QWN0aW9uKCk7XHJcblx0XHR9XHJcblx0XHRjYXRjaCAoZSkge1xyXG5cdFx0XHRsb2cuZXJyb3IoXCJFeGNlcHRpb24gaW4gc3RhdGUgbWFjaGluZVwiLCBlKTtcclxuXHRcdH1cclxuXHR9XHJcblx0aWYgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCkge1xyXG5cdFx0dXRpbHMuc2xlZXAoREVMQVlfTVMpLnRoZW4oKCkgPT4gc3RhdGVNYWNoaW5lKCkpLmNhdGNoKChlcnIpID0+IHtcclxuXHRcdFx0bG9nLmVycm9yKFwiU3RhdGUgbWFjaGluZSBlcnJvcjpcIiwgZXJyKTtcclxuXHRcdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkVSUk9SO1xyXG5cdFx0fSk7IC8vIFJlY2hlY2sgc3RhdHVzIGluIERFTEFZX01TIG1zXHJcblx0fVxyXG5cdGVsc2Uge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0VGVybWluYXRpbmcgU3RhdGUgbWFjaGluZVwiKTtcclxuXHRcdGJ0U3RhdGUuc3RhcnRlZCA9IGZhbHNlO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIENhbGxlZCBmcm9tIHN0YXRlIG1hY2hpbmUgdG8gZXhlY3V0ZSBhIHNpbmdsZSBjb21tYW5kIGZyb20gYnRTdGF0ZS5jb21tYW5kIHByb3BlcnR5XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kKCkge1xyXG5cdHRyeSB7XHJcblx0XHR2YXIgY29tbWFuZCA9IGJ0U3RhdGUuY29tbWFuZDtcclxuXHRcdHZhciByZXN1bHQgPSBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblxyXG5cdFx0aWYgKGNvbW1hbmQgPT0gbnVsbCkge1xyXG5cdFx0XHRyZXR1cm47XHJcblx0XHR9XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuQlVTWTtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJjb21tYW5kc1wiXSsrO1xyXG5cclxuXHRcdGxvZy5pbmZvKFwiXFx0XFx0RXhlY3V0aW5nIGNvbW1hbmQgOlwiICsgY29tbWFuZCk7XHJcblxyXG5cdFx0Ly8gRmlyc3Qgc2V0IE5PTkUgYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIHdyaXRlIG5ldyBzZXRwb2ludHMgd2l0aCBhY3RpdmUgZ2VuZXJhdGlvblxyXG5cdFx0cmVzdWx0ID0gYXdhaXQgc2VuZWNhTVNDLnN3aXRjaE9mZigpO1xyXG5cdFx0aWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IHN3aXRjaCBtZXRlciBvZmYgYmVmb3JlIGNvbW1hbmQgd3JpdGUhXCIpO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIE5vdyB3cml0ZSB0aGUgc2V0cG9pbnQgb3Igc2V0dGluZ1xyXG5cdFx0aWYgKHV0aWxzLmlzR2VuZXJhdGlvbihjb21tYW5kLnR5cGUpIHx8IHV0aWxzLmlzU2V0dGluZyhjb21tYW5kLnR5cGUpICYmIGNvbW1hbmQudHlwZSAhPSBDb21tYW5kVHlwZS5PRkYpIHtcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgc2VuZWNhTVNDLndyaXRlU2V0cG9pbnRzKGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpO1xyXG5cdFx0XHRpZiAocmVzdWx0ICE9IFJlc3VsdENvZGUuU1VDQ0VTUykge1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gd3JpdGUgc2V0cG9pbnRzIVwiKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cclxuXHRcdGlmICghdXRpbHMuaXNTZXR0aW5nKGNvbW1hbmQudHlwZSkgJiZcclxuICAgICAgICAgICAgdXRpbHMuaXNWYWxpZChjb21tYW5kLnR5cGUpICYmIGNvbW1hbmQudHlwZSAhPSBDb21tYW5kVHlwZS5PRkYpICAvLyBJRiB0aGlzIGlzIGEgc2V0dGluZywgd2UncmUgZG9uZS5cclxuXHRcdHtcclxuXHRcdFx0Ly8gTm93IHdyaXRlIHRoZSBtb2RlIHNldFxyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCBzZW5lY2FNU0MuY2hhbmdlTW9kZShjb21tYW5kLnR5cGUpO1xyXG5cdFx0XHRpZiAocmVzdWx0ICE9IFJlc3VsdENvZGUuU1VDQ0VTUykge1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gY2hhbmdlIG1ldGVyIG1vZGUhXCIpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gQ2FsbGVyIGV4cGVjdHMgYSB2YWxpZCBwcm9wZXJ0eSBpbiBHZXRTdGF0ZSgpIG9uY2UgY29tbWFuZCBpcyBleGVjdXRlZC5cclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlZnJlc2hpbmcgY3VycmVudCBzdGF0ZVwiKTtcclxuXHRcdGF3YWl0IHJlZnJlc2goKTtcclxuXHJcblx0XHRjb21tYW5kLmVycm9yID0gZmFsc2U7XHJcblx0XHRjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuXHRcdGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcblxyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRDb21wbGV0ZWQgY29tbWFuZCBleGVjdXRlZFwiKTtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLmVycm9yKFwiKiogZXJyb3Igd2hpbGUgZXhlY3V0aW5nIGNvbW1hbmQ6IFwiICsgZXJyKTtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHRcdGlmIChlcnIgaW5zdGFuY2VvZiBtb2RidXMuTW9kYnVzRXJyb3IpXHJcblx0XHRcdGJ0U3RhdGUuc3RhdHNbXCJtb2RidXNfZXJyb3JzXCJdKys7XHJcblx0XHRyZXR1cm47XHJcblx0fVxyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRFeHBlY3RlZFN0YXRlSGV4KCkge1xyXG5cdC8vIFNpbXVsYXRlIGN1cnJlbnQgbW9kZSBhbnN3ZXIgYWNjb3JkaW5nIHRvIGxhc3QgY29tbWFuZC5cclxuXHR2YXIgc3RhdGVIZXggPSAoQ29tbWFuZFR5cGUuT0ZGKS50b1N0cmluZygxNik7XHJcblx0aWYgKGJ0U3RhdGUuY29tbWFuZD8udHlwZSAhPSBudWxsKSB7XHJcblx0XHRzdGF0ZUhleCA9IChidFN0YXRlLmNvbW1hbmQudHlwZSkudG9TdHJpbmcoMTYpO1xyXG5cdH1cclxuXHQvLyBBZGQgdHJhaWxpbmcgMFxyXG5cdHdoaWxlIChzdGF0ZUhleC5sZW5ndGggPCAyKVxyXG5cdFx0c3RhdGVIZXggPSBcIjBcIiArIHN0YXRlSGV4O1xyXG5cdHJldHVybiBzdGF0ZUhleDtcclxufVxyXG4vKipcclxuICogVXNlZCB0byBzaW11bGF0ZSBSVFUgYW5zd2Vyc1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBjb21tYW5kIHJlYWwgcmVxdWVzdFxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IGZha2UgYW5zd2VyXHJcbiAqL1xyXG5mdW5jdGlvbiBmYWtlUmVzcG9uc2UoY29tbWFuZCkge1xyXG5cdHZhciBjb21tYW5kSGV4ID0gdXRpbHMuYnVmMmhleChjb21tYW5kKTtcclxuXHR2YXIgZm9yZ2VkQW5zd2VycyA9IHtcclxuXHRcdFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIjogXCIxOSAwMyAwMiAwMFwiICsgZ2V0RXhwZWN0ZWRTdGF0ZUhleCgpICsgXCIgJCQkJFwiLCAvLyBDdXJyZW50IHN0YXRlXHJcblx0XHRcImRlZmF1bHQgMDNcIjogXCIxOSAwMyAwNiAwMDAxIDAwMDEgMDAwMSAkJCQkXCIsIC8vIGRlZmF1bHQgYW5zd2VyIGZvciBGQzNcclxuXHRcdFwiZGVmYXVsdCAxMFwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDAwMDEgMDAwMSAkJCQkXCJcclxuXHR9OyAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMxMFxyXG5cclxuXHQvLyBTdGFydCB3aXRoIHRoZSBkZWZhdWx0IGFuc3dlclxyXG5cdHZhciByZXNwb25zZUhleCA9IGZvcmdlZEFuc3dlcnNbXCJkZWZhdWx0IFwiICsgY29tbWFuZEhleC5zcGxpdChcIiBcIilbMV1dO1xyXG5cclxuXHQvLyBEbyB3ZSBoYXZlIGEgZm9yZ2VkIGFuc3dlcj9cclxuXHRpZiAoZm9yZ2VkQW5zd2Vyc1tjb21tYW5kSGV4XSAhPSB1bmRlZmluZWQpIHtcclxuXHRcdHJlc3BvbnNlSGV4ID0gZm9yZ2VkQW5zd2Vyc1tjb21tYW5kSGV4XTtcclxuXHR9XHJcblx0ZWxzZSB7XHJcblx0XHQvLyBMb29rIGludG8gcmVnaXN0ZXJlZCB0cmFjZXNcclxuXHRcdHZhciBmb3VuZCA9IFtdO1xyXG5cdFx0Zm9yIChjb25zdCB0cmFjZSBvZiB0ZXN0RGF0YS50ZXN0VHJhY2VzKSB7XHJcblx0XHRcdGlmICh0cmFjZVtcInJlcXVlc3RcIl0gPT09IGNvbW1hbmRIZXgpIHtcclxuXHRcdFx0XHRmb3VuZC5wdXNoKHRyYWNlW1wiYW5zd2VyXCJdKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0aWYgKGZvdW5kLmxlbmd0aCA+IDApIHtcclxuXHRcdFx0Ly8gU2VsZWN0IGEgcmFuZG9tIGFuc3dlciBmcm9tIHRoZSByZWdpc3RlcmVkIHRyYWNlXHJcblx0XHRcdHJlc3BvbnNlSGV4ID0gZm91bmRbTWF0aC5mbG9vcigoTWF0aC5yYW5kb20oKSAqIGZvdW5kLmxlbmd0aCkpXTtcclxuXHRcdH1cclxuXHRcdGVsc2Uge1xyXG5cdFx0XHRjb25zb2xlLmluZm8oY29tbWFuZEhleCArIFwiIG5vdCBmb3VuZCBpbiB0ZXN0IHRyYWNlc1wiKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdC8vIENvbXB1dGUgQ1JDIGlmIG5lZWRlZFxyXG5cdGlmIChyZXNwb25zZUhleC5pbmNsdWRlcyhcIiQkJCRcIikpIHtcclxuXHRcdHJlc3BvbnNlSGV4ID0gcmVzcG9uc2VIZXgucmVwbGFjZShcIiQkJCRcIiwgXCJcIik7XHJcblx0XHR2YXIgY3JjID0gbW9kYnVzLmNyYzE2KG5ldyBVaW50OEFycmF5KHV0aWxzLmhleDJidWYocmVzcG9uc2VIZXgpKSkudG9TdHJpbmcoMTYpO1xyXG5cdFx0d2hpbGUgKGNyYy5sZW5ndGggPCA0KVxyXG5cdFx0XHRjcmMgPSBcIjBcIiArIGNyYztcclxuXHRcdHJlc3BvbnNlSGV4ID0gcmVzcG9uc2VIZXggKyBjcmMuc3Vic3RyaW5nKDIsIDQpICsgY3JjLnN1YnN0cmluZygwLCAyKTtcclxuXHR9XHJcblxyXG5cdGxvZy5kZWJ1ZyhcIjw8IFwiICsgcmVzcG9uc2VIZXgpO1xyXG5cdHJldHVybiB1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFjcXVpcmUgdGhlIGN1cnJlbnQgbW9kZSBhbmQgc2VyaWFsIG51bWJlciBvZiB0aGUgZGV2aWNlLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBtZXRlckluaXQoKSB7XHJcblx0dHJ5IHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc7XHJcblx0XHRidFN0YXRlLm1ldGVyLnNlcmlhbCA9IGF3YWl0IHNlbmVjYU1TQy5nZXRTZXJpYWxOdW1iZXIoKTtcclxuXHRcdGxvZy5pbmZvKFwiXFx0XFx0U2VyaWFsIG51bWJlcjpcIiArIGJ0U3RhdGUubWV0ZXIuc2VyaWFsKTtcclxuXHJcblx0XHRidFN0YXRlLm1ldGVyLm1vZGUgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0Q3VycmVudE1vZGUoKTtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdEN1cnJlbnQgbW9kZTpcIiArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblxyXG5cdFx0YnRTdGF0ZS5tZXRlci5iYXR0ZXJ5ID0gYXdhaXQgc2VuZWNhTVNDLmdldEJhdHRlcnlWb2x0YWdlKCk7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRCYXR0ZXJ5IChWKTpcIiArIGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSk7XHJcblxyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgaW5pdGlhbGl6aW5nIG1ldGVyIDpcIiArIGVycik7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcblx0XHRpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG5cdFx0XHRidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG5cdH1cclxufVxyXG5cclxuLypcclxuICogQ2xvc2UgdGhlIGJsdWV0b290aCBpbnRlcmZhY2UgKHVucGFpcilcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gZGlzY29ubmVjdCgpIHtcclxuXHRidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cdHRyeSB7XHJcblx0XHRpZiAoYnRTdGF0ZS5idERldmljZSAhPSBudWxsKSB7XHJcblx0XHRcdGlmIChidFN0YXRlLmJ0RGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuXHRcdFx0XHRsb2cud2FybihcIiogQ2FsbGluZyBkaXNjb25uZWN0IG9uIGJ0ZGV2aWNlXCIpO1xyXG5cdFx0XHRcdC8vIEF2b2lkIHRoZSBldmVudCBmaXJpbmcgd2hpY2ggbWF5IGxlYWQgdG8gYXV0by1yZWNvbm5lY3RcclxuXHRcdFx0XHRidFN0YXRlLmJ0RGV2aWNlLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJnYXR0c2VydmVyZGlzY29ubmVjdGVkXCIsIG9uRGlzY29ubmVjdGVkKTtcclxuXHRcdFx0XHRidFN0YXRlLmJ0RGV2aWNlLmdhdHQuZGlzY29ubmVjdCgpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcblx0fVxyXG5cdGNhdGNoIHsgfVxyXG5cdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUEVEO1xyXG59XHJcblxyXG4vKipcclxuICogRXZlbnQgY2FsbGVkIGJ5IGJyb3dzZXIgQlQgYXBpIHdoZW4gdGhlIGRldmljZSBkaXNjb25uZWN0XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIG9uRGlzY29ubmVjdGVkKCkge1xyXG5cdGxvZy53YXJuKFwiKiBHQVRUIFNlcnZlciBkaXNjb25uZWN0ZWQgZXZlbnQsIHdpbGwgdHJ5IHRvIHJlY29ubmVjdCAqXCIpO1xyXG5cdGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuXHRidFN0YXRlLnN0YXRzW1wiR0FUVCBkaXNjb25uZWN0c1wiXSsrO1xyXG5cdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOyAvLyBUcnkgdG8gYXV0by1yZWNvbm5lY3QgdGhlIGludGVyZmFjZXMgd2l0aG91dCBwYWlyaW5nXHJcbn1cclxuXHJcbi8qKlxyXG4gKiBKb2lucyB0aGUgYXJndW1lbnRzIGludG8gYSBzaW5nbGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtCdWZmZXJ9IGNvbmNhdGVuYXRlZCBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGFycmF5QnVmZmVyQ29uY2F0KCkge1xyXG5cdHZhciBsZW5ndGggPSAwO1xyXG5cdHZhciBidWZmZXIgPSBudWxsO1xyXG5cclxuXHRmb3IgKHZhciBpIGluIGFyZ3VtZW50cykge1xyXG5cdFx0YnVmZmVyID0gYXJndW1lbnRzW2ldO1xyXG5cdFx0bGVuZ3RoICs9IGJ1ZmZlci5ieXRlTGVuZ3RoO1xyXG5cdH1cclxuXHJcblx0dmFyIGpvaW5lZCA9IG5ldyBVaW50OEFycmF5KGxlbmd0aCk7XHJcblx0dmFyIG9mZnNldCA9IDA7XHJcblxyXG5cdGZvciAoaSBpbiBhcmd1bWVudHMpIHtcclxuXHRcdGJ1ZmZlciA9IGFyZ3VtZW50c1tpXTtcclxuXHRcdGpvaW5lZC5zZXQobmV3IFVpbnQ4QXJyYXkoYnVmZmVyKSwgb2Zmc2V0KTtcclxuXHRcdG9mZnNldCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuXHR9XHJcblxyXG5cdHJldHVybiBqb2luZWQuYnVmZmVyO1xyXG59XHJcblxyXG4vKipcclxuICogRXZlbnQgY2FsbGVkIGJ5IGJsdWV0b290aCBjaGFyYWN0ZXJpc3RpY3Mgd2hlbiByZWNlaXZpbmcgZGF0YVxyXG4gKiBAcGFyYW0ge2FueX0gZXZlbnRcclxuICovXHJcbmZ1bmN0aW9uIGhhbmRsZU5vdGlmaWNhdGlvbnMoZXZlbnQpIHtcclxuXHRsZXQgdmFsdWUgPSBldmVudC50YXJnZXQudmFsdWU7XHJcblx0aWYgKHZhbHVlICE9IG51bGwpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIjw8IFwiICsgdXRpbHMuYnVmMmhleCh2YWx1ZS5idWZmZXIpKTtcclxuXHRcdGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIHtcclxuXHRcdFx0Ly8gUHJldmVudCBtZW1vcnkgbGVhayBieSBsaW1pdGluZyBtYXhpbXVtIHJlc3BvbnNlIGJ1ZmZlciBzaXplXHJcblx0XHRcdGNvbnN0IE1BWF9SRVNQT05TRV9TSVpFID0gMTAyNDsgLy8gMUtCIGxpbWl0IGZvciBtb2RidXMgcmVzcG9uc2VzXHJcblx0XHRcdGNvbnN0IG5ld1NpemUgPSBidFN0YXRlLnJlc3BvbnNlLmJ5dGVMZW5ndGggKyB2YWx1ZS5idWZmZXIuYnl0ZUxlbmd0aDtcclxuXHRcdFx0aWYgKG5ld1NpemUgPiBNQVhfUkVTUE9OU0VfU0laRSkge1xyXG5cdFx0XHRcdGxvZy53YXJuKFwiUmVzcG9uc2UgYnVmZmVyIHRvbyBsYXJnZSwgcmVzZXR0aW5nXCIpO1xyXG5cdFx0XHRcdGJ0U3RhdGUucmVzcG9uc2UgPSB2YWx1ZS5idWZmZXIuc2xpY2UoKTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRidFN0YXRlLnJlc3BvbnNlID0gYXJyYXlCdWZmZXJDb25jYXQoYnRTdGF0ZS5yZXNwb25zZSwgdmFsdWUuYnVmZmVyKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBlbHNlIHtcclxuXHRcdFx0YnRTdGF0ZS5yZXNwb25zZSA9IHZhbHVlLmJ1ZmZlci5zbGljZSgpO1xyXG5cdFx0fVxyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFRoaXMgZnVuY3Rpb24gd2lsbCBzdWNjZWVkIG9ubHkgaWYgY2FsbGVkIGFzIGEgY29uc2VxdWVuY2Ugb2YgYSB1c2VyLWdlc3R1cmVcclxuICogRS5nLiBidXR0b24gY2xpY2suIFRoaXMgaXMgZHVlIHRvIEJsdWVUb290aCBBUEkgc2VjdXJpdHkgbW9kZWwuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0UGFpckRldmljZSgpIHtcclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuQ09OTkVDVElORztcclxuXHR2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuXHRsb2cuZGVidWcoXCJidFBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuXHR0cnkge1xyXG5cdFx0aWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0QXZhaWxhYmlsaXR5KSA9PSBcImZ1bmN0aW9uXCIpIHtcclxuXHRcdFx0Y29uc3QgYXZhaWxhYmlsaXR5ID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aC5nZXRBdmFpbGFiaWxpdHkoKTtcclxuXHRcdFx0aWYgKCFhdmFpbGFiaWxpdHkpIHtcclxuXHRcdFx0XHRsb2cuZXJyb3IoXCJCbHVldG9vdGggbm90IGF2YWlsYWJsZSBpbiBicm93c2VyLlwiKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJCcm93c2VyIGRvZXMgbm90IHByb3ZpZGUgYmx1ZXRvb3RoXCIpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHR2YXIgZGV2aWNlID0gbnVsbDtcclxuXHJcblx0XHQvLyBEbyB3ZSBhbHJlYWR5IGhhdmUgcGVybWlzc2lvbj9cclxuXHRcdGlmICh0eXBlb2YgKG5hdmlnYXRvci5ibHVldG9vdGg/LmdldERldmljZXMpID09IFwiZnVuY3Rpb25cIlxyXG4gICAgICAgICAgICAmJiAhZm9yY2VTZWxlY3Rpb24pIHtcclxuXHRcdFx0Y29uc3QgYXZhaWxhYmxlRGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0RGV2aWNlcygpO1xyXG5cdFx0XHRhdmFpbGFibGVEZXZpY2VzLmZvckVhY2goZnVuY3Rpb24gKGRldiwgaW5kZXgpIHtcclxuXHRcdFx0XHRsb2cuZGVidWcoXCJGb3VuZCBhdXRob3JpemVkIGRldmljZSA6XCIgKyBkZXYubmFtZSk7XHJcblx0XHRcdFx0aWYgKGRldi5uYW1lLnN0YXJ0c1dpdGgoXCJNU0NcIikpXHJcblx0XHRcdFx0XHRkZXZpY2UgPSBkZXY7XHJcblx0XHRcdH0pO1xyXG5cdFx0XHRsb2cuZGVidWcoXCJuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKT1cIiArIGRldmljZSk7XHJcblx0XHR9XHJcblx0XHQvLyBJZiBub3QsIHJlcXVlc3QgZnJvbSB1c2VyXHJcblx0XHRpZiAoZGV2aWNlID09IG51bGwpIHtcclxuXHRcdFx0ZGV2aWNlID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aFxyXG5cdFx0XHRcdC5yZXF1ZXN0RGV2aWNlKHtcclxuXHRcdFx0XHRcdGFjY2VwdEFsbERldmljZXM6IGZhbHNlLFxyXG5cdFx0XHRcdFx0ZmlsdGVyczogW3sgbmFtZVByZWZpeDogXCJNU0NcIiB9XSxcclxuXHRcdFx0XHRcdG9wdGlvbmFsU2VydmljZXM6IFtCbHVlVG9vdGhNU0MuU2VydmljZVV1aWRdXHJcblx0XHRcdFx0fSk7XHJcblx0XHR9XHJcblx0XHRidFN0YXRlLmJ0RGV2aWNlID0gZGV2aWNlO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcblx0XHRsb2cuaW5mbyhcIkJsdWV0b290aCBkZXZpY2UgXCIgKyBkZXZpY2UubmFtZSArIFwiIGNvbm5lY3RlZC5cIik7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCg1MDApO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG5cdFx0aWYgKGJ0U3RhdGUuY2hhclJlYWQgIT0gbnVsbCkge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHsgfVxyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuRVJST1I7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZmFrZVBhaXJEZXZpY2UoKSB7XHJcblx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcblx0dmFyIGZvcmNlU2VsZWN0aW9uID0gYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl07XHJcblx0bG9nLmRlYnVnKFwiZmFrZVBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuXHR0cnkge1xyXG5cdFx0dmFyIGRldmljZSA9IHsgbmFtZTogXCJGYWtlQlREZXZpY2VcIiwgZ2F0dDogeyBjb25uZWN0ZWQ6IHRydWUgfSB9O1xyXG5cdFx0YnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0bG9nLmluZm8oXCJCbHVldG9vdGggZGV2aWNlIFwiICsgZGV2aWNlLm5hbWUgKyBcIiBjb25uZWN0ZWQuXCIpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoNTApO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuRVJST1I7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIE9uY2UgdGhlIGRldmljZSBpcyBhdmFpbGFibGUsIGluaXRpYWxpemUgdGhlIHNlcnZpY2UgYW5kIHRoZSAyIGNoYXJhY3RlcmlzdGljcyBuZWVkZWQuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0U3Vic2NyaWJlKCkge1xyXG5cdHRyeSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1VCU0NSSUJJTkc7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wic3ViY3JpYmVzXCJdKys7XHJcblx0XHRsZXQgZGV2aWNlID0gYnRTdGF0ZS5idERldmljZTtcclxuXHRcdGxldCBzZXJ2ZXIgPSBudWxsO1xyXG5cclxuXHRcdGlmICghZGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuXHRcdFx0bG9nLmRlYnVnKGBDb25uZWN0aW5nIHRvIEdBVFQgU2VydmVyIG9uICR7ZGV2aWNlLm5hbWV9Li4uYCk7XHJcblx0XHRcdGRldmljZS5hZGRFdmVudExpc3RlbmVyKFwiZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZFwiLCBvbkRpc2Nvbm5lY3RlZCk7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0aWYgKGJ0U3RhdGUuYnRTZXJ2aWNlPy5jb25uZWN0ZWQpIHtcclxuXHRcdFx0XHRcdGJ0U3RhdGUuYnRTZXJ2aWNlLmRpc2Nvbm5lY3QoKTtcclxuXHRcdFx0XHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuXHRcdFx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHsgfVxyXG5cclxuXHRcdFx0c2VydmVyID0gYXdhaXQgZGV2aWNlLmdhdHQuY29ubmVjdCgpO1xyXG5cdFx0XHRsb2cuZGVidWcoXCI+IEZvdW5kIEdBVFQgc2VydmVyXCIpO1xyXG5cdFx0fVxyXG5cdFx0ZWxzZSB7XHJcblx0XHRcdGxvZy5kZWJ1ZyhcIkdBVFQgYWxyZWFkeSBjb25uZWN0ZWRcIik7XHJcblx0XHRcdHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG5cdFx0fVxyXG5cclxuXHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0gYXdhaXQgc2VydmVyLmdldFByaW1hcnlTZXJ2aWNlKEJsdWVUb290aE1TQy5TZXJ2aWNlVXVpZCk7XHJcblx0XHRpZiAoYnRTdGF0ZS5idFNlcnZpY2UgPT0gbnVsbClcclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiR0FUVCBTZXJ2aWNlIHJlcXVlc3QgZmFpbGVkXCIpO1xyXG5cdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCBTZXJpYWwgc2VydmljZVwiKTtcclxuXHRcdGJ0U3RhdGUuY2hhcldyaXRlID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c1JlcXVlc3RVdWlkKTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgd3JpdGUgY2hhcmFjdGVyaXN0aWNcIik7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c0Fuc3dlclV1aWQpO1xyXG5cdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljXCIpO1xyXG5cdFx0YnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkLmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFyYWN0ZXJpc3RpY3ZhbHVlY2hhbmdlZFwiLCBoYW5kbGVOb3RpZmljYXRpb25zKTtcclxuXHRcdGJ0U3RhdGUuY2hhclJlYWQuc3RhcnROb3RpZmljYXRpb25zKCk7XHJcblx0XHRsb2cuaW5mbyhcIj4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuXCIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuXHRcdGF3YWl0IHV0aWxzLnNsZWVwKDUwKTtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIioqIGVycm9yIHdoaWxlIHN1YnNjcmliaW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuXHRcdGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcblx0XHRcdFx0XHRidFN0YXRlLmNoYXJSZWFkLnN0b3BOb3RpZmljYXRpb25zKCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQuZGlzY29ubmVjdCgpO1xyXG5cdFx0XHR9IGNhdGNoIChlcnJvcikgeyB9XHJcblx0XHR9XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZha2VTdWJzY3JpYmUoKSB7XHJcblx0dHJ5IHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVUJTQ1JJQklORztcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJzdWJjcmliZXNcIl0rKztcclxuXHRcdGxldCBkZXZpY2UgPSBidFN0YXRlLmJ0RGV2aWNlO1xyXG5cdFx0bGV0IHNlcnZlciA9IG51bGw7XHJcblxyXG5cdFx0aWYgKCFkZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG5cdFx0XHRsb2cuZGVidWcoYENvbm5lY3RpbmcgdG8gR0FUVCBTZXJ2ZXIgb24gJHtkZXZpY2UubmFtZX0uLi5gKTtcclxuXHRcdFx0ZGV2aWNlW1wiZ2F0dFwiXVtcImNvbm5lY3RlZFwiXSA9IHRydWU7XHJcblx0XHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgR0FUVCBzZXJ2ZXJcIik7XHJcblx0XHR9XHJcblx0XHRlbHNlIHtcclxuXHRcdFx0bG9nLmRlYnVnKFwiR0FUVCBhbHJlYWR5IGNvbm5lY3RlZFwiKTtcclxuXHRcdFx0c2VydmVyID0gZGV2aWNlLmdhdHQ7XHJcblx0XHR9XHJcblxyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSB7fTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgU2VyaWFsIHNlcnZpY2VcIik7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IHt9O1xyXG5cdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCB3cml0ZSBjaGFyYWN0ZXJpc3RpY1wiKTtcclxuXHRcdGJ0U3RhdGUuY2hhclJlYWQgPSB7fTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgcmVhZCBjaGFyYWN0ZXJpc3RpY1wiKTtcclxuXHRcdGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cdFx0bG9nLmluZm8oXCI+IEJsdWV0b290aCBpbnRlcmZhY2VzIHJlYWR5LlwiKTtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJsYXN0X2Nvbm5lY3RcIl0gPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMCk7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogV2hlbiBpZGxlLCB0aGlzIGZ1bmN0aW9uIGlzIGNhbGxlZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKCkge1xyXG5cdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG5cdHRyeSB7XHJcblx0XHQvLyBDaGVjayB0aGUgbW9kZSBmaXJzdFxyXG5cdFx0dmFyIG1vZGUgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0Q3VycmVudE1vZGUoKTtcclxuXHJcblx0XHRpZiAobW9kZSAhPSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuXHRcdFx0YnRTdGF0ZS5tZXRlci5tb2RlID0gbW9kZTtcclxuXHJcblx0XHRcdGlmIChidFN0YXRlLm1ldGVyLmlzR2VuZXJhdGlvbigpKSB7XHJcblx0XHRcdFx0dmFyIHNldHBvaW50cyA9IGF3YWl0IHNlbmVjYU1TQy5nZXRTZXRwb2ludHMoYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHRcdFx0XHRidFN0YXRlLmxhc3RTZXRwb2ludCA9IHNldHBvaW50cztcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0aWYgKGJ0U3RhdGUubWV0ZXIuaXNNZWFzdXJlbWVudCgpKSB7XHJcblx0XHRcdFx0dmFyIG1lYXMgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0TWVhc3VyZXMoYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHRcdFx0XHRidFN0YXRlLmxhc3RNZWFzdXJlID0gbWVhcztcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0RmluaXNoZWQgcmVmcmVzaGluZyBjdXJyZW50IHN0YXRlXCIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgcmVmcmVzaGluZyBtZWFzdXJlXCIgKyBlcnIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG5cdFx0aWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuXHRcdFx0YnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIFNldFNpbXVsYXRpb24odmFsdWUpIHtcclxuXHRzaW11bGF0aW9uID0gdmFsdWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBzdGF0ZU1hY2hpbmUsIFNlbmRBbmRSZXNwb25zZSwgU2V0U2ltdWxhdGlvbiB9OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi4vY29uc3RhbnRzXCIpO1xyXG52YXIgTWV0ZXJTdGF0ZSA9IHJlcXVpcmUoXCIuL01ldGVyU3RhdGVcIik7XHJcblxyXG4vLyBDdXJyZW50IHN0YXRlIG9mIHRoZSBibHVldG9vdGhcclxuY2xhc3MgQVBJU3RhdGUge1xyXG5cdGNvbnN0cnVjdG9yKCkge1xyXG5cdFx0dGhpcy5zdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG5cdFx0dGhpcy5wcmV2X3N0YXRlID0gY29uc3RhbnRzLlN0YXRlLk5PVF9DT05ORUNURUQ7XHJcblx0XHR0aGlzLnN0YXRlX2NwdCA9IDA7XHJcblxyXG5cdFx0dGhpcy5zdGFydGVkID0gZmFsc2U7IC8vIFN0YXRlIG1hY2hpbmUgc3RhdHVzXHJcblx0XHR0aGlzLnN0b3BSZXF1ZXN0ID0gZmFsc2U7IC8vIFRvIHJlcXVlc3QgZGlzY29ubmVjdFxyXG5cdFx0dGhpcy5sYXN0TWVhc3VyZSA9IHt9OyAvLyBBcnJheSB3aXRoIFwiTWVhc3VyZU5hbWVcIiA6IHZhbHVlXHJcblx0XHR0aGlzLmxhc3RTZXRwb2ludCA9IHt9OyAvLyBBcnJheSB3aXRoIFwiU2V0cG9pbnRUeXBlXCIgOiB2YWx1ZVxyXG5cclxuXHRcdC8vIHN0YXRlIG9mIGNvbm5lY3RlZCBtZXRlclxyXG5cdFx0dGhpcy5tZXRlciA9IG5ldyBNZXRlclN0YXRlKCk7XHJcblxyXG5cdFx0Ly8gbGFzdCBtb2RidXMgUlRVIGNvbW1hbmRcclxuXHRcdHRoaXMuY29tbWFuZCA9IG51bGw7XHJcblxyXG5cdFx0Ly8gbGFzdCBtb2RidXMgUlRVIGFuc3dlclxyXG5cdFx0dGhpcy5yZXNwb25zZSA9IG51bGw7XHJcblxyXG5cdFx0Ly8gYmx1ZXRvb3RoIHByb3BlcnRpZXNcclxuXHRcdHRoaXMuY2hhclJlYWQgPSBudWxsO1xyXG5cdFx0dGhpcy5jaGFyV3JpdGUgPSBudWxsO1xyXG5cdFx0dGhpcy5idFNlcnZpY2UgPSBudWxsO1xyXG5cdFx0dGhpcy5idERldmljZSA9IG51bGw7XHJcblxyXG5cdFx0Ly8gZW11bGF0ZWQgY29udGludWl0eSBjaGVja2VyXHJcblx0XHR0aGlzLmNvbnRpbnVpdHkgPSBmYWxzZTtcclxuXHJcblx0XHQvLyBnZW5lcmFsIHN0YXRpc3RpY3MgZm9yIGRlYnVnZ2luZ1xyXG5cdFx0dGhpcy5zdGF0cyA9IHtcclxuXHRcdFx0XCJyZXF1ZXN0c1wiOiAwLFxyXG5cdFx0XHRcInJlc3BvbnNlc1wiOiAwLFxyXG5cdFx0XHRcIm1vZGJ1c19lcnJvcnNcIjogMCxcclxuXHRcdFx0XCJHQVRUIGRpc2Nvbm5lY3RzXCI6IDAsXHJcblx0XHRcdFwiZXhjZXB0aW9uc1wiOiAwLFxyXG5cdFx0XHRcInN1YmNyaWJlc1wiOiAwLFxyXG5cdFx0XHRcImNvbW1hbmRzXCI6IDAsXHJcblx0XHRcdFwicmVzcG9uc2VUaW1lXCI6IDAuMCxcclxuXHRcdFx0XCJsYXN0UmVzcG9uc2VUaW1lXCI6IDAuMCxcclxuXHRcdFx0XCJsYXN0X2Nvbm5lY3RcIjogbmV3IERhdGUoMjAyMCwgMSwgMSkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHJcblx0XHR0aGlzLm9wdGlvbnMgPSB7XHJcblx0XHRcdFwiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIjogdHJ1ZVxyXG5cdFx0fTtcclxuXHR9XHJcbn1cclxuXHJcbmxldCBidFN0YXRlID0gbmV3IEFQSVN0YXRlKCk7XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgQVBJU3RhdGUsIGJ0U3RhdGUgfTsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4uL2NvbnN0YW50c1wiKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZShcIi4uL3V0aWxzXCIpO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcblxyXG4vKipcclxuICogQ29tbWFuZCB0byB0aGUgbWV0ZXIsIG1heSBpbmNsdWRlIHNldHBvaW50XHJcbiAqICovXHJcbmNsYXNzIENvbW1hbmQge1xyXG5cdC8qKlxyXG4gICAgICogQ3JlYXRlcyBhIG5ldyBjb21tYW5kXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjdHlwZVxyXG4gICAgICovXHJcblx0Y29uc3RydWN0b3IoY3R5cGUgPSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuXHRcdHRoaXMudHlwZSA9IHBhcnNlSW50KGN0eXBlKTtcclxuXHRcdHRoaXMuc2V0cG9pbnQgPSBudWxsO1xyXG5cdFx0dGhpcy5zZXRwb2ludDIgPSBudWxsO1xyXG5cdFx0dGhpcy5lcnJvciA9IGZhbHNlO1xyXG5cdFx0dGhpcy5wZW5kaW5nID0gdHJ1ZTtcclxuXHRcdHRoaXMucmVxdWVzdCA9IG51bGw7XHJcblx0XHR0aGlzLnJlc3BvbnNlID0gbnVsbDtcclxuXHR9XHJcblxyXG5cdHN0YXRpYyBDcmVhdGVOb1NQKGN0eXBlKSB7XHJcblx0XHR2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG5cdFx0cmV0dXJuIGNtZDtcclxuXHR9XHJcblx0c3RhdGljIENyZWF0ZU9uZVNQKGN0eXBlLCBzZXRwb2ludCkge1xyXG5cdFx0dmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuXHRcdGNtZC5zZXRwb2ludCA9IHBhcnNlRmxvYXQoc2V0cG9pbnQpO1xyXG5cdFx0cmV0dXJuIGNtZDtcclxuXHR9XHJcblx0c3RhdGljIENyZWF0ZVR3b1NQKGN0eXBlLCBzZXQxLCBzZXQyKSB7XHJcblx0XHR2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG5cdFx0Y21kLnNldHBvaW50ID0gcGFyc2VGbG9hdChzZXQxKTtcclxuXHRcdGNtZC5zZXRwb2ludDIgPSBwYXJzZUZsb2F0KHNldDIpO1xyXG5cdFx0cmV0dXJuIGNtZDtcclxuXHR9XHJcblxyXG5cdHRvU3RyaW5nKCkge1xyXG5cdFx0cmV0dXJuIFwiVHlwZTogXCIgKyB1dGlscy5QYXJzZShDb21tYW5kVHlwZSwgdGhpcy50eXBlKSArIFwiLCBzZXRwb2ludDpcIiArIHRoaXMuc2V0cG9pbnQgKyBcIiwgc2V0cG9pbnQyOiBcIiArIHRoaXMuc2V0cG9pbnQyICsgXCIsIHBlbmRpbmc6XCIgKyB0aGlzLnBlbmRpbmcgKyBcIiwgZXJyb3I6XCIgKyB0aGlzLmVycm9yO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBHZXRzIHRoZSBkZWZhdWx0IHNldHBvaW50IGZvciB0aGlzIGNvbW1hbmQgdHlwZVxyXG4gICAgICogQHJldHVybnMge0FycmF5fSBzZXRwb2ludChzKSBleHBlY3RlZFxyXG4gICAgICovXHJcblx0ZGVmYXVsdFNldHBvaW50KCkge1xyXG5cdFx0c3dpdGNoICh0aGlzLnR5cGUpIHtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuXHRcdFx0cmV0dXJuIHsgXCJUZW1wZXJhdHVyZSAowrBDKVwiOiAwLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcblx0XHRcdHJldHVybiB7IFwiVm9sdGFnZSAoVilcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuXHRcdFx0cmV0dXJuIHsgXCJWb2x0YWdlIChtVilcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG5cdFx0XHRyZXR1cm4geyBcIkN1cnJlbnQgKG1BKVwiOiAwLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG5cdFx0XHRyZXR1cm4geyBcIkltYmFsYW5jZSAobVYvVilcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcblx0XHRcdHJldHVybiB7IFwiRnJlcXVlbmN5IChIeilcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG5cdFx0XHRyZXR1cm4geyBcIlB1bHNlcyBjb3VudFwiOiAwLCBcIkZyZXF1ZW5jeSAoSHopXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfVVRocmVzaG9sZF9GOlxyXG5cdFx0XHRyZXR1cm4geyBcIlV0aHJlc2hvbGQgKFYpXCI6IDIuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfU2Vuc2l0aXZpdHlfdVM6XHJcblx0XHRcdHJldHVybiB7IFwiU2Vuc2liaWxpdHkgKHVTKVwiOiAyLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX0NvbGRKdW5jdGlvbjpcclxuXHRcdFx0cmV0dXJuIHsgXCJDb2xkIGp1bmN0aW9uIGNvbXBlbnNhdGlvblwiOiAwLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1Vsb3c6XHJcblx0XHRcdHJldHVybiB7IFwiVSBsb3cgKFYpXCI6IDAuMCAvIGNvbnN0YW50cy5NQVhfVV9HRU4gfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VoaWdoOlxyXG5cdFx0XHRyZXR1cm4geyBcIlUgaGlnaCAoVilcIjogNS4wIC8gY29uc3RhbnRzLk1BWF9VX0dFTiB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfU2h1dGRvd25EZWxheTpcclxuXHRcdFx0cmV0dXJuIHsgXCJEZWxheSAocylcIjogNjAgKiA1IH07XHJcblx0XHRkZWZhdWx0OlxyXG5cdFx0XHRyZXR1cm4ge307XHJcblx0XHR9XHJcblx0fVxyXG5cdGlzR2VuZXJhdGlvbigpIHtcclxuXHRcdHJldHVybiB1dGlscy5pc0dlbmVyYXRpb24odGhpcy50eXBlKTtcclxuXHR9XHJcblx0aXNNZWFzdXJlbWVudCgpIHtcclxuXHRcdHJldHVybiB1dGlscy5pc01lYXN1cmVtZW50KHRoaXMudHlwZSk7XHJcblx0fVxyXG5cdGlzU2V0dGluZygpIHtcclxuXHRcdHJldHVybiB1dGlscy5pc1NldHRpbmcodGhpcy50eXBlKTtcclxuXHR9XHJcblx0aXNWYWxpZCgpIHtcclxuXHRcdHJldHVybiAodXRpbHMuaXNNZWFzdXJlbWVudCh0aGlzLnR5cGUpIHx8IHV0aWxzLmlzR2VuZXJhdGlvbih0aGlzLnR5cGUpIHx8IHV0aWxzLmlzU2V0dGluZyh0aGlzLnR5cGUpKTtcclxuXHR9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ29tbWFuZDsiLCJjbGFzcyBDb21tYW5kUmVzdWx0IHtcclxuXHR2YWx1ZSA9IDAuMDtcclxuXHRzdWNjZXNzID0gZmFsc2U7XHJcblx0bWVzc2FnZSA9IFwiXCI7XHJcblx0dW5pdCA9IFwiXCI7XHJcblx0c2Vjb25kYXJ5X3ZhbHVlID0gMC4wO1xyXG5cdHNlY29uZGFyeV91bml0ID0gXCJcIjtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBDb21tYW5kUmVzdWx0OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi4vY29uc3RhbnRzXCIpO1xyXG5cclxuLyoqXHJcbiAqIEN1cnJlbnQgc3RhdGUgb2YgdGhlIG1ldGVyXHJcbiAqICovXHJcbmNsYXNzIE1ldGVyU3RhdGUge1xyXG5cdGNvbnN0cnVjdG9yKCkge1xyXG5cdFx0dGhpcy5maXJtd2FyZSA9IFwiXCI7IC8vIEZpcm13YXJlIHZlcnNpb25cclxuXHRcdHRoaXMuc2VyaWFsID0gXCJcIjsgLy8gU2VyaWFsIG51bWJlclxyXG5cdFx0dGhpcy5tb2RlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTjtcclxuXHRcdHRoaXMuYmF0dGVyeSA9IDAuMDtcclxuXHR9XHJcblxyXG5cdGlzTWVhc3VyZW1lbnQoKSB7XHJcblx0XHRyZXR1cm4gdGhpcy5tb2RlID4gY29uc3RhbnRzLkNvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiB0aGlzLm1vZGUgPCBjb25zdGFudHMuQ29tbWFuZFR5cGUuT0ZGO1xyXG5cdH1cclxuXHJcblx0aXNHZW5lcmF0aW9uKCkge1xyXG5cdFx0cmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5PRkYgJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRDtcclxuXHR9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gTWV0ZXJTdGF0ZTsiLCJcInVzZSBzdHJpY3RcIjtcclxuXHJcbi8qKlxyXG4gKiAgVGhpcyBtb2R1bGUgY29udGFpbnMgdGhlIFNlbmVjYU1TQyBvYmplY3QsIHdoaWNoIHByb3ZpZGVzIHRoZSBtYWluIG9wZXJhdGlvbnMgZm9yIGJsdWV0b290aCBtb2R1bGUuXHJcbiAqICBJdCB1c2VzIHRoZSBtb2RidXMgaGVscGVyIGZ1bmN0aW9ucyBmcm9tIHNlbmVjYU1vZGJ1cyAvIG1vZGJ1c1J0dSB0byBpbnRlcmFjdCB3aXRoIHRoZSBtZXRlciB3aXRoIFNlbmRBbmRSZXNwb25zZSBmdW5jdGlvblxyXG4gKi9cclxudmFyIGxvZyA9IHJlcXVpcmUoXCJsb2dsZXZlbFwiKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZShcIi4uL3V0aWxzXCIpO1xyXG52YXIgc2VuZWNhTUIgPSByZXF1aXJlKFwiLi4vc2VuZWNhTW9kYnVzXCIpO1xyXG52YXIgbW9kYnVzID0gcmVxdWlyZShcIi4uL21vZGJ1c1J0dVwiKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuLi9jb25zdGFudHNcIik7XHJcbmNvbnN0IHsgYnRTdGF0ZSB9ID0gcmVxdWlyZShcIi4vQVBJU3RhdGVcIik7XHJcblxyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbnZhciBSZXN1bHRDb2RlID0gY29uc3RhbnRzLlJlc3VsdENvZGU7XHJcblxyXG5jb25zdCBSRVNFVF9QT1dFUl9PRkYgPSA2O1xyXG5jb25zdCBTRVRfUE9XRVJfT0ZGID0gNztcclxuY29uc3QgQ0xFQVJfQVZHX01JTl9NQVggPSA1O1xyXG5jb25zdCBQVUxTRV9DTUQgPSA5O1xyXG5cclxuY2xhc3MgU2VuZWNhTVNDIHtcclxuXHRjb25zdHJ1Y3RvcihmblNlbmRBbmRSZXNwb25zZSkge1xyXG5cdFx0dGhpcy5TZW5kQW5kUmVzcG9uc2UgPSBmblNlbmRBbmRSZXNwb25zZTtcclxuXHR9XHJcblx0LyoqXHJcbiAgICAgKiBHZXRzIHRoZSBtZXRlciBzZXJpYWwgbnVtYmVyICgxMjM0NV8xMjM0KVxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7c3RyaW5nfVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0U2VyaWFsTnVtYmVyKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBzZXJpYWwgbnVtYmVyXCIpO1xyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVNlcmlhbE51bWJlcigpKTtcclxuXHRcdHJldHVybiBzZW5lY2FNQi5wYXJzZVNlcmlhbE51bWJlcihyZXNwb25zZSk7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIEdldHMgdGhlIGN1cnJlbnQgbW9kZSBzZXQgb24gdGhlIE1TQyBkZXZpY2VcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge0NvbW1hbmRUeXBlfSBhY3RpdmUgbW9kZVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0Q3VycmVudE1vZGUoKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIGN1cnJlbnQgbW9kZVwiKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VDdXJyZW50TW9kZSgpKTtcclxuXHRcdHJldHVybiBzZW5lY2FNQi5wYXJzZUN1cnJlbnRNb2RlKHJlc3BvbnNlLCBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBHZXRzIHRoZSBiYXR0ZXJ5IHZvbHRhZ2UgZnJvbSB0aGUgbWV0ZXIgZm9yIGJhdHRlcnkgbGV2ZWwgaW5kaWNhdGlvblxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7bnVtYmVyfSB2b2x0YWdlIChWKVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0QmF0dGVyeVZvbHRhZ2UoKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIGJhdHRlcnkgdm9sdGFnZVwiKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VCYXR0ZXJ5TGV2ZWwoKSk7XHJcblx0XHRyZXR1cm4gTWF0aC5yb3VuZChzZW5lY2FNQi5wYXJzZUJhdHRlcnkocmVzcG9uc2UpICogMTAwKSAvIDEwMDtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogQ2hlY2sgbWVhc3VyZW1lbnQgZXJyb3IgZmxhZ3MgZnJvbSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7Ym9vbGVhbn1cclxuICAgICAqL1xyXG5cdGFzeW5jIGdldFF1YWxpdHlWYWxpZCgpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgbWVhc3VyZSBxdWFsaXR5IGJpdFwiKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VRdWFsaXR5Qml0UmVxdWVzdCgpKTtcclxuXHRcdHJldHVybiBzZW5lY2FNQi5pc1F1YWxpdHlWYWxpZChyZXNwb25zZSk7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIENoZWNrIGdlbmVyYXRpb24gZXJyb3IgZmxhZ3MgZnJvbSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7Ym9vbGVhbn1cclxuICAgICAqL1xyXG5cdGFzeW5jIGdldEdlblF1YWxpdHlWYWxpZChjdXJyZW50X21vZGUpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgZ2VuZXJhdGlvbiBxdWFsaXR5IGJpdFwiKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VHZW5TdGF0dXNSZWFkKCkpO1xyXG5cdFx0cmV0dXJuIHNlbmVjYU1CLnBhcnNlR2VuU3RhdHVzKHJlc3BvbnNlLCBjdXJyZW50X21vZGUpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBSZWFkcyB0aGUgbWVhc3VyZW1lbnRzIGZyb20gdGhlIG1ldGVyLCBpbmNsdWRpbmcgZXJyb3IgZmxhZ3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1ldGVyIG1vZGUgXHJcbiAgICAgKiBAcmV0dXJucyB7YXJyYXl8bnVsbH0gbWVhc3VyZW1lbnQgYXJyYXkgKHVuaXRzLCB2YWx1ZXMsIGVycm9yIGZsYWcpXHJcbiAgICAgKi9cclxuXHRhc3luYyBnZXRNZWFzdXJlcyhtb2RlKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmVzXCIpO1xyXG5cdFx0dmFyIHZhbGlkID0gYXdhaXQgdGhpcy5nZXRRdWFsaXR5VmFsaWQoKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VNZWFzdXJlUmVxdWVzdChtb2RlKSk7XHJcblx0XHRpZiAocmVzcG9uc2UgIT0gbnVsbCkge1xyXG5cdFx0XHR2YXIgbWVhcyA9IHNlbmVjYU1CLnBhcnNlTWVhc3VyZShyZXNwb25zZSwgbW9kZSk7XHJcblx0XHRcdG1lYXNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuXHRcdFx0cmV0dXJuIG1lYXM7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogUmVhZHMgdGhlIGFjdGl2ZSBzZXRwb2ludHMgZnJvbSB0aGUgbWV0ZXIsIGluY2x1ZGluZyBlcnJvciBmbGFnc1xyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGN1cnJlbnQgbWV0ZXIgbW9kZSBcclxuICAgICAqIEByZXR1cm5zIHthcnJheXxudWxsfSBzZXRwb2ludHMgYXJyYXkgKHVuaXRzLCB2YWx1ZXMsIGVycm9yIGZsYWcpXHJcbiAgICAgKi9cclxuXHRhc3luYyBnZXRTZXRwb2ludHMobW9kZSkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBzZXRwb2ludHNcIik7XHJcblx0XHR2YXIgdmFsaWQgPSBhd2FpdCB0aGlzLmdldEdlblF1YWxpdHlWYWxpZChtb2RlKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VTZXRwb2ludFJlYWQobW9kZSkpO1xyXG5cdFx0aWYgKHJlc3BvbnNlICE9IG51bGwpIHtcclxuXHRcdFx0dmFyIHJlc3VsdHMgPSBzZW5lY2FNQi5wYXJzZVNldHBvaW50UmVhZChyZXNwb25zZSwgbW9kZSk7XHJcblx0XHRcdHJlc3VsdHNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuXHRcdFx0cmV0dXJuIHJlc3VsdHM7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogUHV0cyB0aGUgbWV0ZXIgaW4gT0ZGIG1vZGVcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBzd2l0Y2hPZmYoKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIG1ldGVyIHRvIE9GRlwiKTtcclxuXHRcdHZhciBwYWNrZXQgPSBzZW5lY2FNQi5tYWtlTW9kZVJlcXVlc3QoQ29tbWFuZFR5cGUuT0ZGKTtcclxuXHRcdGlmIChwYWNrZXQgPT0gbnVsbClcclxuXHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cclxuXHRcdGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHBhY2tldCk7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cclxuXHRcdHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIFdyaXRlIHRoZSBzZXRwb2ludHMgdG8gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGNvbW1hbmRfdHlwZSB0eXBlIG9mIGdlbmVyYXRpb24gY29tbWFuZFxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHNldHBvaW50IG9mIGdlbmVyYXRpb25cclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludDIgZmFjdWx0YXRpdmUsIHNlY29uZCBzZXRwb2ludFxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyB3cml0ZVNldHBvaW50cyhjb21tYW5kX3R5cGUsIHNldHBvaW50LCBzZXRwb2ludDIpIHtcclxuXHRcdHZhciBzdGFydEdlbjtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFNldHRpbmcgY29tbWFuZDpcIisgY29tbWFuZF90eXBlICsgXCIsIHNldHBvaW50OiBcIiArIHNldHBvaW50ICsgXCIsIHNldHBvaW50IDI6IFwiICsgc2V0cG9pbnQyKTtcclxuXHRcdHZhciBwYWNrZXRzID0gc2VuZWNhTUIubWFrZVNldHBvaW50UmVxdWVzdChjb21tYW5kX3R5cGUsIHNldHBvaW50LCBzZXRwb2ludDIpO1xyXG5cclxuXHRcdGZvcihjb25zdCBwIG9mIHBhY2tldHMpIHtcclxuXHRcdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2UocCk7XHJcblx0XHRcdGlmIChyZXNwb25zZSAhPSBudWxsICYmICFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMCkpIHtcclxuXHRcdFx0XHRyZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfU0hPVUxEX1JFVFJZO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcbiAgICAgICAgXHJcblx0XHQvLyBTcGVjaWFsIGhhbmRsaW5nIG9mIHRoZSBTRVQgRGVsYXkgY29tbWFuZFxyXG5cdFx0c3dpdGNoIChjb21tYW5kX3R5cGUpIHtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcblx0XHRcdHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtSRVNFVF9QT1dFUl9PRkZdKTtcclxuXHRcdFx0cmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcblx0XHRcdGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcblx0XHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cdFx0XHR9XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0ZGVmYXVsdDpcclxuXHRcdFx0YnJlYWs7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBDbGVhciBBdmcvTWluL01heCBzdGF0aXN0aWNzXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgY2xlYXJTdGF0aXN0aWNzKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVzZXR0aW5nIHN0YXRpc3RpY3NcIik7XHJcblx0XHR2YXIgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkNNRCwgW0NMRUFSX0FWR19NSU5fTUFYXSk7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcblx0XHRpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAxKSkge1xyXG5cdFx0XHRyZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBCZWdpbnMgdGhlIHB1bHNlIGdlbmVyYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBzdGFydFB1bHNlR2VuKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0U3RhcnRpbmcgcHVsc2UgZ2VuZXJhdGlvblwiKTtcclxuXHRcdHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuR0VOX0NNRCwgW1BVTFNFX0NNRCwgMl0pOyAvLyBTdGFydCB3aXRoIGxvd1xyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cdFx0aWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMikpIHtcclxuXHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogQmVnaW5zIHRoZSBmcmVxdWVuY3kgZ2VuZXJhdGlvblxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG5cdGFzeW5jIHN0YXJ0RnJlcUdlbigpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFN0YXJ0aW5nIGZyZXEgZ2VuXCIpO1xyXG5cdFx0dmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbUFVMU0VfQ01ELCAxXSk7IC8vIHN0YXJ0IGdlblxyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cdFx0aWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMikpIHtcclxuXHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogRGlzYWJsZSBhdXRvIHBvd2VyIG9mZiB0byB0aGUgbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBkaXNhYmxlUG93ZXJPZmYoKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHREaXNhYmxpbmcgcG93ZXIgb2ZmXCIpO1xyXG5cdFx0dmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtSRVNFVF9QT1dFUl9PRkZdKTtcclxuXHRcdGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuXHRcdHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIENoYW5nZXMgdGhlIGN1cnJlbnQgbW9kZSBvbiB0aGUgbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY29tbWFuZF90eXBlIHRoZSBuZXcgbW9kZSB0byBzZXQgdGhlIG1ldGVyIGluXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG5cdGFzeW5jIGNoYW5nZU1vZGUoY29tbWFuZF90eXBlKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIG1ldGVyIG1vZGUgdG8gOlwiICsgY29tbWFuZF90eXBlKTtcclxuXHRcdHZhciBwYWNrZXQgPSBzZW5lY2FNQi5tYWtlTW9kZVJlcXVlc3QoY29tbWFuZF90eXBlKTtcclxuXHRcdGlmIChwYWNrZXQgPT0gbnVsbCkge1xyXG5cdFx0XHRsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZCB0eXBlXCIsIGNvbW1hbmRfdHlwZSk7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG5cclxuXHRcdGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcblx0XHRcdGxvZy5lcnJvcihcIkNvdWxkIG5vdCBnZW5lcmF0ZSBtb2RidXMgcGFja2V0IGZvciBjb21tYW5kIHR5cGVcIiwgY29tbWFuZF90eXBlKTtcclxuXHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cdFx0fVxyXG5cclxuXHRcdHZhciByZXN1bHQgPSBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblxyXG5cdFx0Ly8gU29tZSBjb21tYW5kcyByZXF1aXJlIGFkZGl0aW9uYWwgY29tbWFuZCB0byBiZSBnaXZlbiB0byB3b3JrIHByb3Blcmx5LCBhZnRlciBhIHNsaWdodCBkZWxheVxyXG5cdFx0c3dpdGNoIChjb21tYW5kX3R5cGUpIHtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuQ29udGludWl0eTpcclxuXHRcdFx0YnRTdGF0ZS5jb250aW51aXR5ID0gdHJ1ZTtcclxuXHRcdFx0YnJlYWs7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlY6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcblx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLmNsZWFyU3RhdGlzdGljcygpO1xyXG5cdFx0XHRicmVhaztcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcblx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLnN0YXJ0UHVsc2VHZW4oKTtcclxuXHRcdFx0YnJlYWs7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcblx0XHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLnN0YXJ0RnJlcUdlbigpO1xyXG5cdFx0XHRicmVhaztcclxuXHRcdH1cclxuXHJcblx0XHRpZiAocmVzdWx0ID09IFJlc3VsdENvZGUuU1VDQ0VTUykge1xyXG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLmRpc2FibGVQb3dlck9mZigpO1xyXG5cdFx0fVxyXG5cclxuXHRcdHJldHVybiByZXN1bHQ7XHJcblx0fVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgU2VuZWNhTVNDIH07IiwiLyoqXHJcbiAqIENvbW1hbmQgdHlwZSwgYWthIG1vZGUgdmFsdWUgdG8gYmUgd3JpdHRlbiBpbnRvIE1TQyBjdXJyZW50IHN0YXRlIHJlZ2lzdGVyXHJcbiAqICovXHJcbmNvbnN0IENvbW1hbmRUeXBlID0ge1xyXG5cdE5PTkVfVU5LTk9XTjogMCwgLyoqKiBNRUFTVVJJTkcgRkVBVFVSRVMgQUZURVIgVEhJUyBQT0lOVCAqKioqKioqL1xyXG5cdG1BX3Bhc3NpdmU6IDEsXHJcblx0bUFfYWN0aXZlOiAyLFxyXG5cdFY6IDMsXHJcblx0bVY6IDQsXHJcblx0VEhFUk1PX0o6IDUsIC8vIFRlcm1vY29wcGllXHJcblx0VEhFUk1PX0s6IDYsXHJcblx0VEhFUk1PX1Q6IDcsXHJcblx0VEhFUk1PX0U6IDgsXHJcblx0VEhFUk1PX0w6IDksXHJcblx0VEhFUk1PX046IDEwLFxyXG5cdFRIRVJNT19SOiAxMSxcclxuXHRUSEVSTU9fUzogMTIsXHJcblx0VEhFUk1PX0I6IDEzLFxyXG5cdFBUMTAwXzJXOiAxNCwgLy8gUlREIDIgZmlsaVxyXG5cdFBUMTAwXzNXOiAxNSxcclxuXHRQVDEwMF80VzogMTYsXHJcblx0UFQ1MDBfMlc6IDE3LFxyXG5cdFBUNTAwXzNXOiAxOCxcclxuXHRQVDUwMF80VzogMTksXHJcblx0UFQxMDAwXzJXOiAyMCxcclxuXHRQVDEwMDBfM1c6IDIxLFxyXG5cdFBUMTAwMF80VzogMjIsXHJcblx0Q3U1MF8yVzogMjMsXHJcblx0Q3U1MF8zVzogMjQsXHJcblx0Q3U1MF80VzogMjUsXHJcblx0Q3UxMDBfMlc6IDI2LFxyXG5cdEN1MTAwXzNXOiAyNyxcclxuXHRDdTEwMF80VzogMjgsXHJcblx0TmkxMDBfMlc6IDI5LFxyXG5cdE5pMTAwXzNXOiAzMCxcclxuXHROaTEwMF80VzogMzEsXHJcblx0TmkxMjBfMlc6IDMyLFxyXG5cdE5pMTIwXzNXOiAzMyxcclxuXHROaTEyMF80VzogMzQsXHJcblx0TG9hZENlbGw6IDM1LCAgIC8vIENlbGxlIGRpIGNhcmljb1xyXG5cdEZyZXF1ZW5jeTogMzYsICAvLyBGcmVxdWVuemFcclxuXHRQdWxzZVRyYWluOiAzNywgLy8gQ29udGVnZ2lvIGltcHVsc2lcclxuXHRSRVNFUlZFRDogMzgsXHJcblx0UkVTRVJWRURfMjogNDAsXHJcblx0Q29udGludWl0eTogNDEsXHJcblx0T0ZGOiAxMDAsIC8vICoqKioqKioqKiBHRU5FUkFUSU9OIEFGVEVSIFRISVMgUE9JTlQgKioqKioqKioqKioqKioqKiovXHJcblx0R0VOX21BX3Bhc3NpdmU6IDEwMSxcclxuXHRHRU5fbUFfYWN0aXZlOiAxMDIsXHJcblx0R0VOX1Y6IDEwMyxcclxuXHRHRU5fbVY6IDEwNCxcclxuXHRHRU5fVEhFUk1PX0o6IDEwNSxcclxuXHRHRU5fVEhFUk1PX0s6IDEwNixcclxuXHRHRU5fVEhFUk1PX1Q6IDEwNyxcclxuXHRHRU5fVEhFUk1PX0U6IDEwOCxcclxuXHRHRU5fVEhFUk1PX0w6IDEwOSxcclxuXHRHRU5fVEhFUk1PX046IDExMCxcclxuXHRHRU5fVEhFUk1PX1I6IDExMSxcclxuXHRHRU5fVEhFUk1PX1M6IDExMixcclxuXHRHRU5fVEhFUk1PX0I6IDExMyxcclxuXHRHRU5fUFQxMDBfMlc6IDExNCxcclxuXHRHRU5fUFQ1MDBfMlc6IDExNyxcclxuXHRHRU5fUFQxMDAwXzJXOiAxMjAsXHJcblx0R0VOX0N1NTBfMlc6IDEyMyxcclxuXHRHRU5fQ3UxMDBfMlc6IDEyNixcclxuXHRHRU5fTmkxMDBfMlc6IDEyOSxcclxuXHRHRU5fTmkxMjBfMlc6IDEzMixcclxuXHRHRU5fTG9hZENlbGw6IDEzNSxcclxuXHRHRU5fRnJlcXVlbmN5OiAxMzYsXHJcblx0R0VOX1B1bHNlVHJhaW46IDEzNyxcclxuXHRHRU5fUkVTRVJWRUQ6IDEzOCxcclxuXHQvLyBTcGVjaWFsIHNldHRpbmdzIGJlbG93IHRoaXMgcG9pbnRzXHJcblx0U0VUVElOR19SRVNFUlZFRDogMTAwMCxcclxuXHRTRVRfVVRocmVzaG9sZF9GOiAxMDAxLFxyXG5cdFNFVF9TZW5zaXRpdml0eV91UzogMTAwMixcclxuXHRTRVRfQ29sZEp1bmN0aW9uOiAxMDAzLFxyXG5cdFNFVF9VbG93OiAxMDA0LFxyXG5cdFNFVF9VaGlnaDogMTAwNSxcclxuXHRTRVRfU2h1dGRvd25EZWxheTogMTAwNlxyXG59O1xyXG5cclxuY29uc3QgQ29udGludWl0eUltcGwgPSBDb21tYW5kVHlwZS5DdTUwXzJXO1xyXG5jb25zdCBDb250aW51aXR5VGhyZXNob2xkT2htcyA9IDc1O1xyXG5cclxuLypcclxuICogSW50ZXJuYWwgc3RhdGUgbWFjaGluZSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmNvbnN0IFN0YXRlID0ge1xyXG5cdE5PVF9DT05ORUNURUQ6IFwiTm90IGNvbm5lY3RlZFwiLFxyXG5cdENPTk5FQ1RJTkc6IFwiQmx1ZXRvb3RoIGRldmljZSBwYWlyaW5nLi4uXCIsXHJcblx0REVWSUNFX1BBSVJFRDogXCJEZXZpY2UgcGFpcmVkXCIsXHJcblx0U1VCU0NSSUJJTkc6IFwiQmx1ZXRvb3RoIGludGVyZmFjZXMgY29ubmVjdGluZy4uLlwiLFxyXG5cdElETEU6IFwiSWRsZVwiLFxyXG5cdEJVU1k6IFwiQnVzeVwiLFxyXG5cdEVSUk9SOiBcIkVycm9yXCIsXHJcblx0U1RPUFBJTkc6IFwiQ2xvc2luZyBCVCBpbnRlcmZhY2VzLi4uXCIsXHJcblx0U1RPUFBFRDogXCJTdG9wcGVkXCIsXHJcblx0TUVURVJfSU5JVDogXCJNZXRlciBjb25uZWN0ZWRcIixcclxuXHRNRVRFUl9JTklUSUFMSVpJTkc6IFwiUmVhZGluZyBtZXRlciBzdGF0ZS4uLlwiXHJcbn07XHJcblxyXG5jb25zdCBSZXN1bHRDb2RlID0ge1xyXG5cdEZBSUxFRF9OT19SRVRSWTogMSxcclxuXHRGQUlMRURfU0hPVUxEX1JFVFJZOiAyLFxyXG5cdFNVQ0NFU1M6IDBcclxufTtcclxuXHJcblxyXG5jb25zdCBNQVhfVV9HRU4gPSAyNy4wOyAvLyBtYXhpbXVtIHZvbHRhZ2UgXHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtTdGF0ZSwgQ29tbWFuZFR5cGUsIFJlc3VsdENvZGUsIE1BWF9VX0dFTiwgQ29udGludWl0eUltcGwsIENvbnRpbnVpdHlUaHJlc2hvbGRPaG1zfTtcclxuIiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG5jb25zdCBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbmNvbnN0IGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcclxuY29uc3QgQVBJU3RhdGUgPSByZXF1aXJlKFwiLi9jbGFzc2VzL0FQSVN0YXRlXCIpO1xyXG5jb25zdCBDb21tYW5kID0gcmVxdWlyZShcIi4vY2xhc3Nlcy9Db21tYW5kXCIpO1xyXG5jb25zdCBQdWJsaWNBUEkgPSByZXF1aXJlKFwiLi9tZXRlclB1YmxpY0FQSVwiKTtcclxuY29uc3QgVGVzdERhdGEgPSByZXF1aXJlKFwiLi9tb2RidXNUZXN0RGF0YVwiKTtcclxuXHJcbmxvZy5zZXRMZXZlbChsb2cubGV2ZWxzLkVSUk9SLCB0cnVlKTtcclxuXHJcbmV4cG9ydHMuU3RvcCA9IFB1YmxpY0FQSS5TdG9wO1xyXG5leHBvcnRzLlBhaXIgPSBQdWJsaWNBUEkuUGFpcjtcclxuZXhwb3J0cy5FeGVjdXRlID0gUHVibGljQVBJLkV4ZWN1dGU7XHJcbmV4cG9ydHMuU2ltcGxlRXhlY3V0ZSA9IFB1YmxpY0FQSS5TaW1wbGVFeGVjdXRlO1xyXG5leHBvcnRzLkdldFN0YXRlID0gUHVibGljQVBJLkdldFN0YXRlO1xyXG5leHBvcnRzLlN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG5leHBvcnRzLkNvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5leHBvcnRzLkNvbW1hbmQgPSBDb21tYW5kO1xyXG5leHBvcnRzLlBhcnNlID0gUHVibGljQVBJLlBhcnNlO1xyXG5leHBvcnRzLmxvZyA9IGxvZztcclxuZXhwb3J0cy5HZXRTdGF0ZUpTT04gPSBQdWJsaWNBUEkuR2V0U3RhdGVKU09OO1xyXG5leHBvcnRzLkV4ZWN1dGVKU09OID0gUHVibGljQVBJLkV4ZWN1dGVKU09OO1xyXG5leHBvcnRzLlNpbXBsZUV4ZWN1dGVKU09OID0gUHVibGljQVBJLlNpbXBsZUV4ZWN1dGVKU09OO1xyXG5leHBvcnRzLkdldEpzb25UcmFjZXMgPSBUZXN0RGF0YS5HZXRKc29uVHJhY2VzO1xyXG5cclxuIiwiLypcclxuICogVGhpcyBmaWxlIGNvbnRhaW5zIHRoZSBwdWJsaWMgQVBJIG9mIHRoZSBtZXRlciwgaS5lLiB0aGUgZnVuY3Rpb25zIGRlc2lnbmVkXHJcbiAqIHRvIGJlIGNhbGxlZCBmcm9tIHRoaXJkIHBhcnR5IGNvZGUuXHJcbiAqIDEtIFBhaXIoKSA6IGJvb2xcclxuICogMi0gRXhlY3V0ZShDb21tYW5kKSA6IGJvb2wgKyBKU09OIHZlcnNpb25cclxuICogMy0gU3RvcCgpIDogYm9vbFxyXG4gKiA0LSBHZXRTdGF0ZSgpIDogYXJyYXkgKyBKU09OIHZlcnNpb25cclxuICogNS0gU2ltcGxlRXhlY3V0ZShDb21tYW5kKSA6IHJldHVybnMgdGhlIHVwZGF0ZWQgbWVhc3VyZW1lbnQgb3IgbnVsbFxyXG4gKi9cclxuXHJcbnZhciBDb21tYW5kUmVzdWx0ID0gcmVxdWlyZShcIi4vY2xhc3Nlcy9Db21tYW5kUmVzdWx0XCIpO1xyXG52YXIgQVBJU3RhdGUgPSByZXF1aXJlKFwiLi9jbGFzc2VzL0FQSVN0YXRlXCIpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xyXG52YXIgYmx1ZXRvb3RoID0gcmVxdWlyZShcIi4vYmx1ZXRvb3RoXCIpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKFwiLi91dGlsc1wiKTtcclxudmFyIGxvZyA9IHJlcXVpcmUoXCJsb2dsZXZlbFwiKTtcclxudmFyIG1ldGVyQXBpID0gcmVxdWlyZShcIi4vbWV0ZXJBcGlcIik7XHJcblxyXG52YXIgYnRTdGF0ZSA9IEFQSVN0YXRlLmJ0U3RhdGU7XHJcbnZhciBTdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZTtcclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIGEgY29weSBvZiB0aGUgY3VycmVudCBzdGF0ZVxyXG4gKiBAcmV0dXJucyB7YXJyYXl9IHN0YXR1cyBvZiBtZXRlclxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gR2V0U3RhdGUoKSB7XHJcblx0bGV0IHJlYWR5ID0gZmFsc2U7XHJcblx0bGV0IGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG5cdHN3aXRjaCAoYnRTdGF0ZS5zdGF0ZSkge1xyXG5cdC8vIFN0YXRlcyByZXF1aXJpbmcgdXNlciBpbnB1dFxyXG5cdGNhc2UgU3RhdGUuRVJST1I6XHJcblx0Y2FzZSBTdGF0ZS5TVE9QUEVEOlxyXG5cdGNhc2UgU3RhdGUuTk9UX0NPTk5FQ1RFRDpcclxuXHRcdHJlYWR5ID0gZmFsc2U7XHJcblx0XHRpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuQlVTWTpcclxuXHRjYXNlIFN0YXRlLklETEU6XHJcblx0XHRyZWFkeSA9IHRydWU7XHJcblx0XHRpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuXHRcdGJyZWFrO1xyXG5cdGNhc2UgU3RhdGUuQ09OTkVDVElORzpcclxuXHRjYXNlIFN0YXRlLkRFVklDRV9QQUlSRUQ6XHJcblx0Y2FzZSBTdGF0ZS5NRVRFUl9JTklUOlxyXG5cdGNhc2UgU3RhdGUuTUVURVJfSU5JVElBTElaSU5HOlxyXG5cdGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6XHJcblx0XHRpbml0aWFsaXppbmcgPSB0cnVlO1xyXG5cdFx0cmVhZHkgPSBmYWxzZTtcclxuXHRcdGJyZWFrO1xyXG5cdGRlZmF1bHQ6XHJcblx0XHRyZWFkeSA9IGZhbHNlO1xyXG5cdFx0aW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcblx0fVxyXG5cdHJldHVybiB7XHJcblx0XHRcImxhc3RTZXRwb2ludFwiOiBidFN0YXRlLmxhc3RTZXRwb2ludCxcclxuXHRcdFwibGFzdE1lYXN1cmVcIjogYnRTdGF0ZS5sYXN0TWVhc3VyZSxcclxuXHRcdFwiZGV2aWNlTmFtZVwiOiBidFN0YXRlLmJ0RGV2aWNlID8gYnRTdGF0ZS5idERldmljZS5uYW1lIDogXCJcIixcclxuXHRcdFwiZGV2aWNlU2VyaWFsXCI6IGJ0U3RhdGUubWV0ZXI/LnNlcmlhbCxcclxuXHRcdFwic3RhdHNcIjogYnRTdGF0ZS5zdGF0cyxcclxuXHRcdFwiZGV2aWNlTW9kZVwiOiBidFN0YXRlLm1ldGVyPy5tb2RlLFxyXG5cdFx0XCJzdGF0dXNcIjogYnRTdGF0ZS5zdGF0ZSxcclxuXHRcdFwiYmF0dGVyeUxldmVsXCI6IGJ0U3RhdGUubWV0ZXI/LmJhdHRlcnksXHJcblx0XHRcInJlYWR5XCI6IHJlYWR5LFxyXG5cdFx0XCJpbml0aWFsaXppbmdcIjogaW5pdGlhbGl6aW5nXHJcblx0fTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFByb3ZpZGVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggQmxhem9yXHJcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEpTT04gc3RhdGUgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBHZXRTdGF0ZUpTT04oKSB7XHJcblx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IEdldFN0YXRlKCkpO1xyXG59XHJcblxyXG4vKipcclxuICogRXhlY3V0ZSBjb21tYW5kIHdpdGggc2V0cG9pbnRzLCBKU09OIHZlcnNpb25cclxuICogQHBhcmFtIHtzdHJpbmd9IGpzb25Db21tYW5kIHRoZSBjb21tYW5kIHRvIGV4ZWN1dGVcclxuICogQHJldHVybnMge3N0cmluZ30gSlNPTiBjb21tYW5kIG9iamVjdFxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gRXhlY3V0ZUpTT04oanNvbkNvbW1hbmQpIHtcclxuXHRsZXQgY29tbWFuZCA9IEpTT04ucGFyc2UoanNvbkNvbW1hbmQpO1xyXG5cdC8vIGRlc2VyaWFsaXplZCBvYmplY3QgaGFzIGxvc3QgaXRzIG1ldGhvZHMsIGxldCdzIHJlY3JlYXRlIGEgY29tcGxldGUgb25lLlxyXG5cdGxldCBjb21tYW5kMiA9IG1ldGVyQXBpLkNvbW1hbmQuQ3JlYXRlVHdvU1AoY29tbWFuZC50eXBlLCBjb21tYW5kLnNldHBvaW50LCBjb21tYW5kLnNldHBvaW50Mik7XHJcblx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IEV4ZWN1dGUoY29tbWFuZDIpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZUpTT04oanNvbkNvbW1hbmQpIHtcclxuXHRsZXQgY29tbWFuZCA9IEpTT04ucGFyc2UoanNvbkNvbW1hbmQpO1xyXG5cdC8vIGRlc2VyaWFsaXplZCBvYmplY3QgaGFzIGxvc3QgaXRzIG1ldGhvZHMsIGxldCdzIHJlY3JlYXRlIGEgY29tcGxldGUgb25lLlxyXG5cdGxldCBjb21tYW5kMiA9IG1ldGVyQXBpLkNvbW1hbmQuQ3JlYXRlVHdvU1AoY29tbWFuZC50eXBlLCBjb21tYW5kLnNldHBvaW50LCBjb21tYW5kLnNldHBvaW50Mik7XHJcblx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IFNpbXBsZUV4ZWN1dGUoY29tbWFuZDIpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4ZWN1dGUgYSBjb21tYW5kIGFuZCByZXR1cm5zIHRoZSBtZWFzdXJlbWVudCBvciBzZXRwb2ludCB3aXRoIGVycm9yIGZsYWcgYW5kIG1lc3NhZ2VcclxuICogQHBhcmFtIHtDb21tYW5kfSBjb21tYW5kXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBTaW1wbGVFeGVjdXRlKGNvbW1hbmQpIHtcclxuXHRjb25zdCBTSU1QTEVfRVhFQ1VURV9USU1FT1VUX1MgPSA1O1xyXG5cdHZhciBjciA9IG5ldyBDb21tYW5kUmVzdWx0KCk7XHJcblxyXG5cdGxvZy5pbmZvKFwiU2ltcGxlRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG5cdGlmIChjb21tYW5kID09IG51bGwpIHtcclxuXHRcdGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuXHRcdGNyLm1lc3NhZ2UgPSBcIkludmFsaWQgY29tbWFuZFwiO1xyXG5cdFx0cmV0dXJuIGNyO1xyXG5cdH1cclxuXHJcblx0Y29tbWFuZC5wZW5kaW5nID0gdHJ1ZTsgLy8gSW4gY2FzZSBjYWxsZXIgZG9lcyBub3Qgc2V0IHBlbmRpbmcgZmxhZ1xyXG5cclxuXHQvLyBGYWlsIGltbWVkaWF0ZWx5IGlmIG5vdCBwYWlyZWQuXHJcblx0aWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuXHRcdGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuXHRcdGNyLm1lc3NhZ2UgPSBcIkRldmljZSBpcyBub3QgcGFpcmVkXCI7XHJcblx0XHRsb2cud2Fybihjci5tZXNzYWdlKTtcclxuXHRcdHJldHVybiBjcjtcclxuXHR9XHJcblxyXG5cdC8vIEFub3RoZXIgY29tbWFuZCBtYXkgYmUgcGVuZGluZy5cclxuXHRpZiAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcpIHtcclxuXHRcdGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuXHRcdGNyLm1lc3NhZ2UgPSBcIkFub3RoZXIgY29tbWFuZCBpcyBwZW5kaW5nXCI7XHJcblx0XHRsb2cud2Fybihjci5tZXNzYWdlKTtcclxuXHRcdHJldHVybiBjcjtcclxuXHR9XHJcblxyXG5cdC8vIFdhaXQgZm9yIGNvbXBsZXRpb24gb2YgdGhlIGNvbW1hbmQsIG9yIGhhbHQgb2YgdGhlIHN0YXRlIG1hY2hpbmVcclxuXHRidFN0YXRlLmNvbW1hbmQgPSBjb21tYW5kO1xyXG5cdGlmIChjb21tYW5kICE9IG51bGwpIHtcclxuXHRcdGF3YWl0IHV0aWxzLndhaXRGb3JUaW1lb3V0KCgpID0+ICFjb21tYW5kLnBlbmRpbmcgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVELCBTSU1QTEVfRVhFQ1VURV9USU1FT1VUX1MpO1xyXG5cdH1cclxuXHJcblx0Ly8gQ2hlY2sgaWYgZXJyb3Igb3IgdGltZW91dHNcclxuXHRpZiAoY29tbWFuZC5lcnJvciB8fCBjb21tYW5kLnBlbmRpbmcpIHtcclxuXHRcdGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuXHRcdGNyLm1lc3NhZ2UgPSBcIkVycm9yIHdoaWxlIGV4ZWN1dGluZyB0aGUgY29tbWFuZC5cIjtcclxuXHRcdGxvZy53YXJuKGNyLm1lc3NhZ2UpO1xyXG5cclxuXHRcdC8vIFJlc2V0IHRoZSBhY3RpdmUgY29tbWFuZFxyXG5cdFx0YnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuXHRcdHJldHVybiBjcjtcclxuXHR9XHJcblxyXG5cdC8vIFN0YXRlIGlzIHVwZGF0ZWQgYnkgZXhlY3V0ZSBjb21tYW5kLCBzbyB3ZSBjYW4gdXNlIGJ0U3RhdGUgcmlnaHQgYXdheVxyXG5cdGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSkge1xyXG5cdFx0Y3IudmFsdWUgPSBidFN0YXRlLmxhc3RTZXRwb2ludFtcIlZhbHVlXCJdO1xyXG5cdFx0Y3IudW5pdCA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVW5pdFwiXTtcclxuXHR9XHJcblx0ZWxzZSBpZiAodXRpbHMuaXNNZWFzdXJlbWVudChjb21tYW5kLnR5cGUpKSB7XHJcblx0XHRjci52YWx1ZSA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJWYWx1ZVwiXTtcclxuXHRcdGNyLnVuaXQgPSBidFN0YXRlLmxhc3RNZWFzdXJlW1wiVW5pdFwiXTtcclxuXHRcdGNyLnNlY29uZGFyeV92YWx1ZSA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJTZWNvbmRhcnlWYWx1ZVwiXTtcclxuXHRcdGNyLnNlY29uZGFyeV91bml0ID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlNlY29uZGFyeVVuaXRcIl07XHJcblx0fVxyXG5cdGVsc2Uge1xyXG5cdFx0Y3IudmFsdWUgPSAwLjA7IC8vIFNldHRpbmdzIGNvbW1hbmRzO1xyXG5cdH1cclxuXHJcblx0Y3Iuc3VjY2VzcyA9IHRydWU7XHJcblx0Y3IubWVzc2FnZSA9IFwiQ29tbWFuZCBleGVjdXRlZCBzdWNjZXNzZnVsbHlcIjtcclxuXHRyZXR1cm4gY3I7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRlcm5hbCBpbnRlcmZhY2UgdG8gcmVxdWlyZSBhIGNvbW1hbmQgdG8gYmUgZXhlY3V0ZWQuXHJcbiAqIFRoZSBibHVldG9vdGggZGV2aWNlIHBhaXJpbmcgd2luZG93IHdpbGwgb3BlbiBpZiBkZXZpY2UgaXMgbm90IGNvbm5lY3RlZC5cclxuICogVGhpcyBtYXkgZmFpbCBpZiBjYWxsZWQgb3V0c2lkZSBhIHVzZXIgZ2VzdHVyZS5cclxuICogQHBhcmFtIHtDb21tYW5kfSBjb21tYW5kXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlKGNvbW1hbmQpIHtcclxuXHRsb2cuaW5mbyhcIkV4ZWN1dGUgY2FsbGVkLi4uXCIpO1xyXG5cclxuXHRpZiAoY29tbWFuZCA9PSBudWxsKVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblxyXG5cdGNvbW1hbmQucGVuZGluZyA9IHRydWU7XHJcblxyXG5cdHZhciBjcHQgPSAwO1xyXG5cdHdoaWxlIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbCAmJiBidFN0YXRlLmNvbW1hbmQucGVuZGluZyAmJiBjcHQgPCAzMDApIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIldhaXRpbmcgZm9yIGN1cnJlbnQgY29tbWFuZCB0byBjb21wbGV0ZS4uLlwiKTtcclxuXHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblx0XHRjcHQrKztcclxuXHR9XHJcblxyXG5cdGxvZy5pbmZvKFwiU2V0dGluZyBuZXcgY29tbWFuZCA6XCIgKyBjb21tYW5kKTtcclxuXHRidFN0YXRlLmNvbW1hbmQgPSBjb21tYW5kO1xyXG5cclxuXHQvLyBTdGFydCB0aGUgcmVndWxhciBzdGF0ZSBtYWNoaW5lXHJcblx0aWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgYmx1ZXRvb3RoLnN0YXRlTWFjaGluZSgpO1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdGxvZy5lcnJvcihcIkZhaWxlZCB0byBzdGFydCBzdGF0ZSBtYWNoaW5lOlwiLCBlcnIpO1xyXG5cdFx0XHRjb21tYW5kLmVycm9yID0gdHJ1ZTtcclxuXHRcdFx0Y29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcblx0XHRcdHJldHVybiBjb21tYW5kO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Ly8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG5cdGlmIChjb21tYW5kICE9IG51bGwpIHtcclxuXHRcdGF3YWl0IHV0aWxzLndhaXRGb3IoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQpO1xyXG5cdH1cclxuXHJcblx0Ly8gUmV0dXJuIHRoZSBjb21tYW5kIG9iamVjdCByZXN1bHRcclxuXHRyZXR1cm4gY29tbWFuZDtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1VU1QgQkUgQ0FMTEVEIEZST00gQSBVU0VSIEdFU1RVUkUgRVZFTlQgSEFORExFUlxyXG4gICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgbWV0ZXIgaXMgcmVhZHkgdG8gZXhlY3V0ZSBjb21tYW5kXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIFBhaXIoZm9yY2VTZWxlY3Rpb24gPSBmYWxzZSkge1xyXG5cdGxvZy5pbmZvKFwiUGFpcihcIiArIGZvcmNlU2VsZWN0aW9uICsgXCIpIGNhbGxlZC4uLlwiKTtcclxuXHJcblx0YnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl0gPSBmb3JjZVNlbGVjdGlvbjtcclxuXHJcblx0aWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG5cdFx0Ymx1ZXRvb3RoLnN0YXRlTWFjaGluZSgpLmNhdGNoKChlcnIpID0+IHtcclxuXHRcdFx0bG9nLmVycm9yKFwiU3RhdGUgbWFjaGluZSBmYWlsZWQgZHVyaW5nIHBhaXJpbmc6XCIsIGVycik7XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuXHRcdH0pOyAvLyBTdGFydCBpdFxyXG5cdH1cclxuXHRlbHNlIGlmIChidFN0YXRlLnN0YXRlID09IFN0YXRlLkVSUk9SKSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDsgLy8gVHJ5IHRvIHJlc3RhcnRcclxuXHR9XHJcblx0YXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiBidFN0YXRlLnN0YXRlID09IFN0YXRlLklETEUgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVEKTtcclxuXHRsb2cuaW5mbyhcIlBhaXJpbmcgY29tcGxldGVkLCBzdGF0ZSA6XCIsIGJ0U3RhdGUuc3RhdGUpO1xyXG5cdHJldHVybiAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFN0b3BzIHRoZSBzdGF0ZSBtYWNoaW5lIGFuZCBkaXNjb25uZWN0cyBibHVldG9vdGguXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIFN0b3AoKSB7XHJcblx0bG9nLmluZm8oXCJTdG9wIHJlcXVlc3QgcmVjZWl2ZWRcIik7XHJcblxyXG5cdGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlO1xyXG5cdGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblxyXG5cdHdoaWxlIChidFN0YXRlLnN0YXJ0ZWQgfHwgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCAmJiBidFN0YXRlLnN0YXRlICE9IFN0YXRlLk5PVF9DT05ORUNURUQpKSB7XHJcblx0XHRidFN0YXRlLnN0b3BSZXF1ZXN0ID0gdHJ1ZTtcclxuXHRcdGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblx0fVxyXG5cdGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcblx0YnRTdGF0ZS5zdG9wUmVxdWVzdCA9IGZhbHNlO1xyXG5cdGxvZy53YXJuKFwiU3RvcHBlZCBvbiByZXF1ZXN0LlwiKTtcclxuXHRyZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IFN0b3AsIFBhaXIsIEV4ZWN1dGUsIEV4ZWN1dGVKU09OLCBTaW1wbGVFeGVjdXRlLCBTaW1wbGVFeGVjdXRlSlNPTiwgR2V0U3RhdGUsIEdldFN0YXRlSlNPTiwgbG9nIH07IiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiogTU9EQlVTIFJUVSBoYW5kbGluZyAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKi9cclxuXHJcbnZhciBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcblxyXG5jb25zdCBTRU5FQ0FfTUJfU0xBVkVfSUQgPSAyNTsgLy8gTW9kYnVzIFJUVSBzbGF2ZSBJRFxyXG5cclxuY2xhc3MgTW9kYnVzRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcblx0LyoqXHJcbiAgICAgKiBDcmVhdGVzIGEgbmV3IG1vZGJ1cyBlcnJvclxyXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IG1lc3NhZ2UgbWVzc2FnZVxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IGZjIGZ1bmN0aW9uIGNvZGVcclxuICAgICAqL1xyXG5cdGNvbnN0cnVjdG9yKG1lc3NhZ2UsIGZjKSB7XHJcblx0XHRzdXBlcihtZXNzYWdlKTtcclxuXHRcdHRoaXMubWVzc2FnZSA9IG1lc3NhZ2U7XHJcblx0XHR0aGlzLmZjID0gZmM7XHJcblx0fVxyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgNCBieXRlcyBDUkMgY29kZSBmcm9tIHRoZSBidWZmZXIgY29udGVudHNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBjcmMxNihidWZmZXIpIHtcclxuXHR2YXIgY3JjID0gMHhGRkZGO1xyXG5cdHZhciBvZGQ7XHJcblxyXG5cdGZvciAodmFyIGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7XHJcblx0XHRjcmMgPSBjcmMgXiBidWZmZXJbaV07XHJcblxyXG5cdFx0Zm9yICh2YXIgaiA9IDA7IGogPCA4OyBqKyspIHtcclxuXHRcdFx0b2RkID0gY3JjICYgMHgwMDAxO1xyXG5cdFx0XHRjcmMgPSBjcmMgPj4gMTtcclxuXHRcdFx0aWYgKG9kZCkge1xyXG5cdFx0XHRcdGNyYyA9IGNyYyBeIDB4QTAwMTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0cmV0dXJuIGNyYztcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ha2UgYSBNb2RidXMgUmVhZCBIb2xkaW5nIFJlZ2lzdGVycyAoRkM9MDMpIHRvIHNlcmlhbCBwb3J0XHJcbiAqIFxyXG4gKiBAcGFyYW0ge251bWJlcn0gSUQgc2xhdmUgSURcclxuICogQHBhcmFtIHtudW1iZXJ9IGNvdW50IG51bWJlciBvZiByZWdpc3RlcnMgdG8gcmVhZFxyXG4gKiBAcGFyYW0ge251bWJlcn0gcmVnaXN0ZXIgc3RhcnRpbmcgcmVnaXN0ZXJcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VGQzMoSUQsIGNvdW50LCByZWdpc3Rlcikge1xyXG5cdGNvbnN0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcig4KTtcclxuXHRjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KGJ1ZmZlcik7XHJcblx0dmlldy5zZXRVaW50OCgwLCBJRCk7XHJcblx0dmlldy5zZXRVaW50OCgxLCAzKTtcclxuXHR2aWV3LnNldFVpbnQxNigyLCByZWdpc3RlciwgZmFsc2UpO1xyXG5cdHZpZXcuc2V0VWludDE2KDQsIGNvdW50LCBmYWxzZSk7XHJcblx0dmFyIGNyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KGJ1ZmZlci5zbGljZSgwLCAtMikpKTtcclxuXHR2aWV3LnNldFVpbnQxNig2LCBjcmMsIHRydWUpO1xyXG5cdHJldHVybiBidWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXcml0ZSBhIE1vZGJ1cyBcIlByZXNldCBNdWx0aXBsZSBSZWdpc3RlcnNcIiAoRkM9MTYpIHRvIHNlcmlhbCBwb3J0LlxyXG4gKlxyXG4gKiBAcGFyYW0ge251bWJlcn0gYWRkcmVzcyB0aGUgc2xhdmUgdW5pdCBhZGRyZXNzLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gZGF0YUFkZHJlc3MgdGhlIERhdGEgQWRkcmVzcyBvZiB0aGUgZmlyc3QgcmVnaXN0ZXIuXHJcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IHRoZSBhcnJheSBvZiB2YWx1ZXMgdG8gd3JpdGUgdG8gcmVnaXN0ZXJzLlxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMTYoYWRkcmVzcywgZGF0YUFkZHJlc3MsIGFycmF5KSB7XHJcblx0Y29uc3QgY29kZSA9IDE2O1xyXG5cclxuXHQvLyBzYW5pdHkgY2hlY2tcclxuXHRpZiAodHlwZW9mIGFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIgfHwgdHlwZW9mIGRhdGFBZGRyZXNzID09PSBcInVuZGVmaW5lZFwiKSB7XHJcblx0XHRyZXR1cm47XHJcblx0fVxyXG5cclxuXHRsZXQgZGF0YUxlbmd0aCA9IGFycmF5Lmxlbmd0aDtcclxuXHJcblx0Y29uc3QgY29kZUxlbmd0aCA9IDcgKyAyICogZGF0YUxlbmd0aDtcclxuXHRjb25zdCBidWYgPSBuZXcgQXJyYXlCdWZmZXIoY29kZUxlbmd0aCArIDIpOyAvLyBhZGQgMiBjcmMgYnl0ZXNcclxuXHRjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWYpO1xyXG5cclxuXHRkdi5zZXRVaW50OCgwLCBhZGRyZXNzKTtcclxuXHRkdi5zZXRVaW50OCgxLCBjb2RlKTtcclxuXHRkdi5zZXRVaW50MTYoMiwgZGF0YUFkZHJlc3MsIGZhbHNlKTtcclxuXHRkdi5zZXRVaW50MTYoNCwgZGF0YUxlbmd0aCwgZmFsc2UpO1xyXG5cdGR2LnNldFVpbnQ4KDYsIGRhdGFMZW5ndGggKiAyKTtcclxuXHJcblx0Ly8gY29weSBjb250ZW50IG9mIGFycmF5IHRvIGJ1ZlxyXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YUxlbmd0aDsgaSsrKSB7XHJcblx0XHRkdi5zZXRVaW50MTYoNyArIDIgKiBpLCBhcnJheVtpXSwgZmFsc2UpO1xyXG5cdH1cclxuXHRjb25zdCBjcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShidWYuc2xpY2UoMCwgLTIpKSk7XHJcblx0Ly8gYWRkIGNyYyBieXRlcyB0byBidWZmZXJcclxuXHRkdi5zZXRVaW50MTYoY29kZUxlbmd0aCwgY3JjLCB0cnVlKTtcclxuXHRyZXR1cm4gYnVmO1xyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgcmVnaXN0ZXJzIHZhbHVlcyBmcm9tIGEgRkMwMyBhbnN3ZXIgYnkgUlRVIHNsYXZlXHJcbiAqIFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzMocmVzcG9uc2UpIHtcclxuXHRpZiAoIShyZXNwb25zZSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSkge1xyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cdGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocmVzcG9uc2UpO1xyXG5cclxuXHQvLyBJbnZhbGlkIG1vZGJ1cyBwYWNrZXRcclxuXHRpZiAocmVzcG9uc2UubGVuZ3RoIDwgNSlcclxuXHRcdHJldHVybjtcclxuXHJcblx0dmFyIGNvbXB1dGVkX2NyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KHJlc3BvbnNlLnNsaWNlKDAsIC0yKSkpO1xyXG5cdHZhciBhY3R1YWxfY3JjID0gdmlldy5nZXRVaW50MTYodmlldy5ieXRlTGVuZ3RoIC0gMiwgdHJ1ZSk7XHJcblxyXG5cdGlmIChjb21wdXRlZF9jcmMgIT0gYWN0dWFsX2NyYykge1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgQ1JDIChleHBlY3RlZDpcIiArIGNvbXB1dGVkX2NyYyArIFwiLGdvdDpcIiArIGFjdHVhbF9jcmMgKyBcIilcIiwgMyk7XHJcblx0fVxyXG5cclxuXHR2YXIgYWRkcmVzcyA9IHZpZXcuZ2V0VWludDgoMCk7XHJcblx0aWYgKGFkZHJlc3MgIT0gU0VORUNBX01CX1NMQVZFX0lEKSB7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBzbGF2ZSBJRCA6XCIgKyBhZGRyZXNzLCAzKTtcclxuXHR9XHJcblxyXG5cdHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcblx0aWYgKGZjID4gMTI4KSB7XHJcblx0XHR2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIkV4Y2VwdGlvbiBieSBzbGF2ZTpcIiArIGV4cCwgMyk7XHJcblx0fVxyXG5cdGlmIChmYyAhPSAzKSB7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG5cdH1cclxuXHJcblx0Ly8gTGVuZ3RoIGluIGJ5dGVzIGZyb20gc2xhdmUgYW5zd2VyXHJcblx0dmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDgoMik7XHJcblxyXG5cdGNvbnN0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcihsZW5ndGgpO1xyXG5cdGNvbnN0IHJlZ2lzdGVycyA9IG5ldyBEYXRhVmlldyhidWZmZXIpO1xyXG5cclxuXHRmb3IgKHZhciBpID0gMzsgaSA8IHZpZXcuYnl0ZUxlbmd0aCAtIDI7IGkgKz0gMikge1xyXG5cdFx0dmFyIHJlZyA9IHZpZXcuZ2V0SW50MTYoaSwgZmFsc2UpO1xyXG5cdFx0cmVnaXN0ZXJzLnNldEludDE2KGkgLSAzLCByZWcsIGZhbHNlKTtcclxuXHRcdHZhciBpZHggPSAoKGkgLSAzKSAvIDIgKyAxKTtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlZ2lzdGVyIFwiICsgaWR4ICsgXCIvXCIgKyAobGVuZ3RoIC8gMikgKyBcIiA9IFwiICsgcmVnKTtcclxuXHR9XHJcblxyXG5cdHJldHVybiByZWdpc3RlcnM7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVjayBpZiB0aGUgRkMxNiByZXNwb25zZSBpcyBjb3JyZWN0IChDUkMsIHJldHVybiBjb2RlKSBBTkQgb3B0aW9uYWxseSBtYXRjaGluZyB0aGUgcmVnaXN0ZXIgbGVuZ3RoIGV4cGVjdGVkXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlIG1vZGJ1cyBydHUgcmF3IG91dHB1dFxyXG4gKiBAcGFyYW0ge251bWJlcn0gZXhwZWN0ZWQgbnVtYmVyIG9mIGV4cGVjdGVkIHdyaXR0ZW4gcmVnaXN0ZXJzIGZyb20gc2xhdmUuIElmIDw9MCwgaXQgd2lsbCBub3QgYmUgY2hlY2tlZC5cclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgYWxsIHJlZ2lzdGVycyBoYXZlIGJlZW4gd3JpdHRlblxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgZXhwZWN0ZWQpIHtcclxuXHR0cnkge1xyXG5cdFx0Y29uc3QgcmVzdWx0ID0gcGFyc2VGQzE2KHJlc3BvbnNlKTtcclxuXHRcdHJldHVybiAoZXhwZWN0ZWQgPD0gMCB8fCByZXN1bHRbMV0gPT09IGV4cGVjdGVkKTsgLy8gY2hlY2sgaWYgbGVuZ3RoIGlzIG1hdGNoaW5nXHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy5lcnJvcihcIkZDMTYgYW5zd2VyIGVycm9yXCIsIGVycik7XHJcblx0XHRyZXR1cm4gZmFsc2U7XHJcblx0fVxyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIGFuc3dlciB0byB0aGUgd3JpdGUgbXVsdGlwbGUgcmVnaXN0ZXJzIGZyb20gdGhlIHNsYXZlXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMTYocmVzcG9uc2UpIHtcclxuXHRjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHJlc3BvbnNlKTtcclxuXHJcblx0aWYgKHJlc3BvbnNlLmxlbmd0aCA8IDMpXHJcblx0XHRyZXR1cm47XHJcblxyXG5cdHZhciBzbGF2ZSA9IHZpZXcuZ2V0VWludDgoMCk7XHJcblxyXG5cdGlmIChzbGF2ZSAhPSBTRU5FQ0FfTUJfU0xBVkVfSUQpIHtcclxuXHRcdHJldHVybjtcclxuXHR9XHJcblxyXG5cdHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcblx0aWYgKGZjID4gMTI4KSB7XHJcblx0XHR2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIkV4Y2VwdGlvbiA6XCIgKyBleHAsIDE2KTtcclxuXHR9XHJcblx0aWYgKGZjICE9IDE2KSB7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG5cdH1cclxuXHR2YXIgY29tcHV0ZWRfY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkocmVzcG9uc2Uuc2xpY2UoMCwgLTIpKSk7XHJcblx0dmFyIGFjdHVhbF9jcmMgPSB2aWV3LmdldFVpbnQxNih2aWV3LmJ5dGVMZW5ndGggLSAyLCB0cnVlKTtcclxuXHJcblx0aWYgKGNvbXB1dGVkX2NyYyAhPSBhY3R1YWxfY3JjKSB7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBDUkMgKGV4cGVjdGVkOlwiICsgY29tcHV0ZWRfY3JjICsgXCIsZ290OlwiICsgYWN0dWFsX2NyYyArIFwiKVwiLCAxNik7XHJcblx0fVxyXG5cclxuXHR2YXIgYWRkcmVzcyA9IHZpZXcuZ2V0VWludDE2KDIsIGZhbHNlKTtcclxuXHR2YXIgbGVuZ3RoID0gdmlldy5nZXRVaW50MTYoNCwgZmFsc2UpO1xyXG5cdHJldHVybiBbYWRkcmVzcywgbGVuZ3RoXTtcclxufVxyXG5cclxuXHJcblxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IGZsb2F0XHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRGbG9hdDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0KSB7XHJcblx0Y29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuXHRjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuXHRkdi5zZXRJbnQxNigwLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQgKyAyLCBmYWxzZSksIGZhbHNlKTtcclxuXHRkdi5zZXRJbnQxNigyLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQsIGZhbHNlKSwgZmFsc2UpO1xyXG5cdHJldHVybiBkdi5nZXRGbG9hdDMyKDAsIGZhbHNlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IFVpbnQzMlxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGNvbnZlcnRlZCB2YWx1ZVxyXG4gKi9cclxuZnVuY3Rpb24gZ2V0VWludDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0KSB7XHJcblx0Y29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuXHRjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuXHRkdi5zZXRJbnQxNigwLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQgKyAyLCBmYWxzZSksIGZhbHNlKTtcclxuXHRkdi5zZXRJbnQxNigyLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQsIGZhbHNlKSwgZmFsc2UpO1xyXG5cdHJldHVybiBkdi5nZXRVaW50MzIoMCwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gZmxvYXRcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcGFyYW0ge3ZhbHVlfSBudW1iZXIgdmFsdWUgdG8gc2V0XHJcbiAqL1xyXG5mdW5jdGlvbiBzZXRGbG9hdDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0LCB2YWx1ZSkge1xyXG5cdGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcblx0Y29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcblx0ZHYuc2V0RmxvYXQzMigwLCB2YWx1ZSwgZmFsc2UpO1xyXG5cdGRhdGFWaWV3LnNldEludDE2KG9mZnNldCwgZHYuZ2V0SW50MTYoMiwgZmFsc2UpLCBmYWxzZSk7XHJcblx0ZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0ICsgMiwgZHYuZ2V0SW50MTYoMCwgZmFsc2UpLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiBcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIHVpbnQzMiBpbnRvIHRoZSBidWZmZXJcclxuICogQHBhcmFtIHtudW1iZXJ9IHZhbHVlIHZhbHVlIHRvIHNldFxyXG4gKi9cclxuZnVuY3Rpb24gc2V0VWludDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0LCB2YWx1ZSkge1xyXG5cdGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcblx0Y29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcblx0ZHYuc2V0VWludDMyKDAsIHZhbHVlLCBmYWxzZSk7XHJcblx0ZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0LCBkdi5nZXRJbnQxNigyLCBmYWxzZSksIGZhbHNlKTtcclxuXHRkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQgKyAyLCBkdi5nZXRJbnQxNigwLCBmYWxzZSksIGZhbHNlKTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IG1ha2VGQzMsIGdldEZsb2F0MzJMRUJTLCBtYWtlRkMxNiwgc2V0RmxvYXQzMkxFQlMsIHNldFVpbnQzMkxFQlMsIHBhcnNlRkMzLCBwYXJzZUZDMTYsIHBhcnNlRkMxNmNoZWNrZWQsIE1vZGJ1c0Vycm9yLCBTRU5FQ0FfTUJfU0xBVkVfSUQsIGdldFVpbnQzMkxFQlMsIGNyYzE2IH07IiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG5jb25zdCB0ZXN0VHJhY2VzID0gW1xyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGQ5IDNlIDQwIDgwIDA4IGMyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAxIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA1IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAyIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAyIDE5IDg3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIDgwIDAwIDM5IDc2IGMwIDAwIDNhIDJmIDYwIDAwIDM5IGVkIDA3IDY3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIDgwIDAwIDM5IDc2IGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGE0IDA2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIDgwIDAwIDM5IDc2IGMwIDAwIDNhIDJmIDgwIDAwIDM5IDc2IDcxIDBjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAzIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAzIGQ4IDQ3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIDJkIDVjIDNjIDg2IDJkIDVjIDNjIDg2IGI2IGQ4IDNjIDRhIGI2IDAzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIDQ3IDc0IDNjIDExIDJkIDVjIDNjIDg2IDQ3IDc0IDNjIDExIDk2IDJiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIDg4IDdjIDNiIGY5IDJkIDVjIDNjIDg2IDg4IDdjIDNiIGY5IDA4IDY4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA0IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA0IDk5IDg1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGY0IGUzIGMwIGVhIGY0IGUzIGMwIGVhIGY0IGUzIGMwIGVhIDE1IDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGY0IGUzIGMwIGVhIGVjIGU0IGMwIGVhIGY0IGUzIGMwIGVhIDYzIGU2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGY0IGUzIGMwIGVhIGVjIGU0IGMwIGVhIGVjIGU0IGMwIGVhIGQ0IDg3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGZjIGUzIGMwIGVhIGVjIGU0IGMwIGVhIGZjIGUzIGMwIGVhIDgwIDU5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGZjIGUzIGMwIGVhIGVjIGU0IGMwIGVhIGY0IGUzIGMwIGVhIDgyIDM5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA1IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI2IDE5IDljXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA1IDU4IDQ1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDdmIGQyIGMzIDBkIDRhIGVhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA2IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA2IDE4IDQ0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGQxIDAwIGMzIDc1IGNhIDE5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDIwIDAwIDgxIDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDMzIGQzIGMzIDc2IDRkIDk5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA3IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA3IGQ5IDg0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDkwIGMzIDg3IDcyIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGZlIGI3IGMzIDg2IDMyIGFlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA4IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA4IDk5IDgwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGJlIDI3IGMyIGViIGU3IDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGJiIGFkIGMyIGViIGM2IDE4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA5IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA5IDU4IDQwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDFmIGI3IGMyIGQzIGM1IDNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQ3IDYzIGMyIGQzIDk2IDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDFkIDU1IGMyIGQzIDY0IGIzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBhIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBhIDE4IDQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDZiIDVlIGM2IDNlIGNkIGI0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDYzIDdkIGM2IDNlIDNlIDFlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBiIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBiIGQ5IDgxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDc3IDI5IGNmIDdjIGZjIDVmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDYwIGVmIGNmIDdkIGQ4IDE2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBjIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBjIDk4IDQzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDM0IDUxIGNkIGNlIGU4IGQ3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGE2IGVhIGNkIGNlIGI0IDRhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGY5IGVlIGNkIGNkIGE3IDllXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGE1IGJjIGNkIGNlIDU0IDFlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBkIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBkIDU5IDgzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDU0IDc2IGNjIGIwIGM3IDZjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDdjIDZlIGNjIGIwIDRlIGNiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBlIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBlIDE5IDgyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDRmIDQ0IDQ0IDViIDM2IGI2IDQzIGM3IDVmIDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBmIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBmIGQ4IDQyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGYwIDc1IGMzIGIzIDFjIDRlIGMzIGM3IGEyIGY4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDEwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDEwIDk5IDhhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDVkIDZmIDQ0IDViIDNlIGVkIDQzIGM3IDM3IDIyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDExIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDExIDU4IDRhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGZiIGIxIDQ1IDJmIDRmIDlhIDQ1IDdkIDFiIDkyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDEyIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDEyIDE4IDRiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGM2IGIwIDQ1IDJhIDZkIDAwIGM1IDdkIDRlIDQ4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDEzIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDEzIGQ5IDhiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGZhIGVkIDQ1IDJmIDRlIGZlIDQ1IDdkIDA2IDc4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE0IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE0IDk4IDQ5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDQyIDdjIDQ0IDYxIDRmIDlhIDQ1IDdkIGE1IDlmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE1IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE1IDU5IDg5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDdmIGMwIGMzIGMwIDg3IDk4IGM1IDcyIDA3IDEzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDEyIDc3IGMzIGNkIDliIGMxIGM1IDZiIDNjIDIxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDlkIGU4IGMzIGI3IDEzIGE5IGM1IDc3IDY5IDc3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDgyIGQwIGMzIGFkIGY2IGQ2IGM1IDdiIGNlIGViXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDU3IDg5IGMzIGQ0IDRiIDE0IGM1IDY3IGQzIDFlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE3IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE3IGQ4IDQ4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDQxIDA2IDQ0IDJlIDI5IDUzIDQzIDQ3IDI2IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE4IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE4IDk4IDRjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGFjIDJmIGM0IDQ1IDI1IGE1IGMzIDQ3IGU5IDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE5IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE5IDU5IDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDRmIDkyIDQ0IDJlIDM1IGM2IDQzIDQ3IDY1IDdmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFhIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFhIDE5IDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGFmIDgyIDQzIDY3IDI5IDUzIDQzIDQ3IGIxIDMzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFiIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFiIGQ4IDRkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDQ2IGE3IGM0IDEzIDI1IGE1IGMzIDQ3IDI3IDBkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFjIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFjIDk5IDhmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGNjIDk4IDQzIDY3IDM1IGM2IDQzIDQ3IDViIDczXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFkIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFkIDU4IDRmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDcwIGU1IDQzIDlhIDM2IGI2IDQzIGM3IDkwIGJlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFlIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFlIDE4IDRlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA0IDM0IGM3IDA2IDFjIDRlIGMzIGM3IDcxIDE1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFmIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFmIGQ5IDhlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDZlIGRmIDQzIDlhIDNlIGVkIDQzIGM3IGY5IDhlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIwIDk5IDllXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGRmIGVmIDQzIDg5IDM2IGI2IDQzIGM3IGY1IDQ1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIxIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIxIDU4IDVlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDZhIDFlIGM1IGRkIDFjIDRlIGMzIGM3IDE4IDgyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIyIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIyIDE4IDVmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IGU1IGVkIDQzIDg5IDNlIGVkIDQzIGM3IDI2IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIzIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIzIGQ5IDlmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDAwIDAwIDA0IDQ3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDdmIDAwIDAxIDAwIDAwIDJjIDAwIDAxIGFkIGNiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDI0IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDZhIDQ4IDNkIGQ1IDJlIGYzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDI1IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI1IDU5IDlkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDk2IDAwIDA0IGE3IGZkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDAwIDAwIDAwIDAwIDAwIDAwIDAwIGViIDc3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIDA0IDAwIDAwIDQwIDgwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIGUyIDI5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY1IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY1IDU4IDZkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQyIDAwIDAyIDY3IGVhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQwIDgwIDUyIDUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI4IDk4IDU4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIDA0IDAwIDAwIDQxIDIwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIGUyIDI5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY2IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY2IDE4IDZjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQyIDAwIDAyIDY3IGVhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIDIwIDUzIGJhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDgwIDAwIGY5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDA0IDAwIDAwIDQwIGEwIGIwIDE4XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDAyIDI4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY3IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY3IGQ5IGFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQ0IDAwIDAyIDg3IGViXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIDIwIDUzIGJhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDA0IDcwIGE0IDNmIDlkIDBhIGRhXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDAyIDI4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY4IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY4IDk5IGE4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQ0IDAwIDAyIDg3IGViXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDY2IDY2IDQwIDg2IDJjIGM3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGRjIDAwIDAyIDA0IDY2IDY2IDQwIDg2IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGRjIDAwIDAyIDgzIGVhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY5IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY5IDU4IDY4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGRjIDAwIDAyIDA2IDI5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDY2IDY2IDQwIDg2IDJjIGM3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZhIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZhIDE4IDY5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZiIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZiIGQ5IGE5XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZjIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZjIDk4IDZiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZlIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZlIDE5IGFhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZkIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZkIDU5IGFiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZmIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZmIGQ4IDZhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDcwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDcwIDk5IGEyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDcxIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDcxIDU4IDYyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDA0IDAwIDAwIDQxIGM4IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDAyIDI3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDcyIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDcyIDE4IDYzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGU0IDAwIDAyIDg3IGU0XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIGM4IDUzIGY0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI3IGQ4IDVjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNjIGU3IDQwIDgwIGRkIDM1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDc1IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDc1IDU5IGExXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNkIDc2IDQwIDgwIDhkIDI0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDc4IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDc4IDk4IDY0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDdiIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDdiIGQ4IDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM3IDRiIDQwIDgwIDFmIDMwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNjIDU4IDQwIDgwIGVjIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDdlIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDdlIDE4IDY2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNiIGM4IDQwIDgwIGVkIDg4XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDgxIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDgxIDU4IDI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNhIGE5IDQwIDgwIGJkIGFhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg0IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg0IDk4IDI1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM1IDljIDQwIDgwIGFlIGIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQ4IDAwIDAyIDA0IDAwIDAwIDQxIGYwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQ4IDAwIDAyIGMyIDJiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg3IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg3IGQ4IDI0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQ4IDAwIDAyIDQ3IGU4XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIGYwIDUyIDI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDAxIDRkIDAwIDAwIDAxIDRlIDAwIDAwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg4IGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAxIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAxIDRkIDAwIDAwIDAxIDRlIDAwIDAwIGQ2IDU0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGFhIGFmIDQwIDgwIDQzIGFiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM1IDBjIDQwIDgwIGFlIDlkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM5IDg5IDQwIDgwIGJjIDI0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNiIDM5IDQwIDgwIGJjIDdiXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM3IGRiIDQwIDgwIDFmIDFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM2IGJjIDQwIDgwIGFmIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM0IDdkIDQwIDgwIGZmIDdhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGMzIDVlIDQwIDgwIDBmIGM0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM4IDZiIDQwIDgwIDFkIGVlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM2IDJjIDQwIDgwIGFmIDEzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDA0IDAwIDAwIDQxIGYwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDAyIDI3XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGMyIGNlIDQwIDgwIDBlIDE1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGMwIDAwIDAyIDA0IDAwIDAwIDQxIDIwIGZmIGZmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGMwIDAwIDAyIDQyIDJjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDdkIDQxIDQwIDc3IDViIGFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIGQzIDY3XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg4IDkwIGI5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAxIGQwIGRkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDA2IDAwIDAwIDAwIDA3IDAwIDAwIDNjIGI2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZjIDAwIDAyIDA0IDAwIDY0IDAwIDAwIGMzIGMxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZjIDAwIDAyIDgyIDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIDJjIGFjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg5IDUxIDc5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAyIDkwIGRjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDI4IDAwIDAwIDAwIDI4IDAwIDAwIGMzIDdkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQxIGM5IDQwIDc3IGQ3IGQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQxIGM5IDQwIDc3IGQ3IGQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQwIGE5IDQwIDc3IGQ2IDM0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQxIGM5IDQwIDc3IGQ3IGQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQwIGE5IDQwIDc3IGQ2IDM0XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNmIDhiIDQwIDc3IDZmIGVhXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNlIDZiIDQwIDc3IDZmIGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNlIDZiIDQwIDc3IDZmIGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNkIDRjIDQwIDc3IGRmIGFmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNjIDJlIDQwIDc3IDdmIDhkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDNiIDBlIDQwIDc3IDdmIDMzXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAxIDVhIDk0XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA1IGM0IDg4XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAxIDA4IDAwIDAyIDA0IDAwIDAwIDAwIDAwIDgxIDM5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAxIDA4IDAwIDAyIGMyIDJlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAxIDA2IDAwIDAyIDA0IGExIDJmIDNlIGJkIGMyIDkxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAxIDA2IDAwIDAyIGEzIGVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZjIDAwIDAyIDA0IDAwIDBhIDAwIDAwIGEyIDFjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZjIDAwIDAyIDgyIDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDAwIDY0IDAwIDAwIDAwIDY0IDAwIDAwIDYwIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg5IDUxIDc5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAyIDkwIGRjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDY0IDAwIDAwIDAwIDY0IDAwIDAwIDhmIDZlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDY0IDAwIDAwIDAwIDY0IDAwIDAwIDhmIDZlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDY0IDAwIDAwIDAwIDY0IDAwIDAwIDhmIDZlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDY0IDAwIDAwIDAwIDY0IDAwIDAwIDhmIDZlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIGFjIGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg4IDkwIGI5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAxIGQwIGRkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIDQzIDFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIDQzIDFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIDQzIDFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIDQzIDFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIDQzIDFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAzIGU4IDAwIDAwIDAzIGU4IDAwIDAwIDQzIDFjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IGVmIGUxIDQwIDc2IGI2IGY2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAzIGRiIDU1XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDk0IDAwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY3IGQxIDM1XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAxIGQwIGRkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDdiIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDdiIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDdiIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDdiIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDdiIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA3IGQwIDAwIDAwIDA3IGQwIDAwIDAwIDdiIGQxXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZjIDAwIDAyIDA0IDAwIDA1IDAwIDAwIDkyIDFmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZjIDAwIDAyIDgyIDIwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIDMwIDVkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg5IDUxIDc5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAyIDkwIGRjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg5IDU5IGUwXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA4IDIwIDhkIDAwIDAwIDIwIDhlIDAwIDAwIGRmIDhjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDI0IDliIDRmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IDg0IDg5XCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDVjIDNlIDExIDcyIDRjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDVjIDNlIDExIDcyIDRjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDVjIDNlIDExIDcyIDRjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDVjIDNlIDExIDcyIDRjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDVjIDNlIDExIDcyIDRjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IDlhIGJmXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuXHR9LFxyXG5cdHtcclxuXHRcdFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcblx0XHRcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuXHR9XHJcbl07XHJcblxyXG5mdW5jdGlvbiB1bmlxQnkoYSwga2V5KSB7XHJcblx0dmFyIHNlZW4gPSB7fTtcclxuXHRyZXR1cm4gYS5maWx0ZXIoZnVuY3Rpb24gKGl0ZW0pIHtcclxuXHRcdHZhciBrID0ga2V5KGl0ZW0pO1xyXG5cdFx0cmV0dXJuIHNlZW4uaGFzT3duUHJvcGVydHkoaykgPyBmYWxzZSA6IChzZWVuW2tdID0gdHJ1ZSk7XHJcblx0fSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbWVNZXNzYWdlKHRyYWNlKSB7XHJcblx0cmV0dXJuIHRyYWNlW1wicmVxdWVzdFwiXSArIFwiIC0+IFwiICsgdHJhY2VbXCJhbnN3ZXJcIl07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIEdldEpzb25UcmFjZXMoKSB7XHJcblx0dGVzdFRyYWNlcyA9IHVuaXFCeSh0ZXN0VHJhY2VzLCBzYW1lTWVzc2FnZSk7XHJcblx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KHRlc3RUcmFjZXMpO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgdGVzdFRyYWNlcywgR2V0SnNvblRyYWNlcyB9OyIsIi8qXG4qIGxvZ2xldmVsIC0gaHR0cHM6Ly9naXRodWIuY29tL3BpbXRlcnJ5L2xvZ2xldmVsXG4qXG4qIENvcHlyaWdodCAoYykgMjAxMyBUaW0gUGVycnlcbiogTGljZW5zZWQgdW5kZXIgdGhlIE1JVCBsaWNlbnNlLlxuKi9cbihmdW5jdGlvbiAocm9vdCwgZGVmaW5pdGlvbikge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGlmICh0eXBlb2YgZGVmaW5lID09PSAnZnVuY3Rpb24nICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKGRlZmluaXRpb24pO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBkZWZpbml0aW9uKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcm9vdC5sb2cgPSBkZWZpbml0aW9uKCk7XG4gICAgfVxufSh0aGlzLCBmdW5jdGlvbiAoKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICAvLyBTbGlnaHRseSBkdWJpb3VzIHRyaWNrcyB0byBjdXQgZG93biBtaW5pbWl6ZWQgZmlsZSBzaXplXG4gICAgdmFyIG5vb3AgPSBmdW5jdGlvbigpIHt9O1xuICAgIHZhciB1bmRlZmluZWRUeXBlID0gXCJ1bmRlZmluZWRcIjtcbiAgICB2YXIgaXNJRSA9ICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlKSAmJiAodHlwZW9mIHdpbmRvdy5uYXZpZ2F0b3IgIT09IHVuZGVmaW5lZFR5cGUpICYmIChcbiAgICAgICAgL1RyaWRlbnRcXC98TVNJRSAvLnRlc3Qod2luZG93Lm5hdmlnYXRvci51c2VyQWdlbnQpXG4gICAgKTtcblxuICAgIHZhciBsb2dNZXRob2RzID0gW1xuICAgICAgICBcInRyYWNlXCIsXG4gICAgICAgIFwiZGVidWdcIixcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgIFwid2FyblwiLFxuICAgICAgICBcImVycm9yXCJcbiAgICBdO1xuXG4gICAgdmFyIF9sb2dnZXJzQnlOYW1lID0ge307XG4gICAgdmFyIGRlZmF1bHRMb2dnZXIgPSBudWxsO1xuXG4gICAgLy8gQ3Jvc3MtYnJvd3NlciBiaW5kIGVxdWl2YWxlbnQgdGhhdCB3b3JrcyBhdCBsZWFzdCBiYWNrIHRvIElFNlxuICAgIGZ1bmN0aW9uIGJpbmRNZXRob2Qob2JqLCBtZXRob2ROYW1lKSB7XG4gICAgICAgIHZhciBtZXRob2QgPSBvYmpbbWV0aG9kTmFtZV07XG4gICAgICAgIGlmICh0eXBlb2YgbWV0aG9kLmJpbmQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiBtZXRob2QuYmluZChvYmopO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gRnVuY3Rpb24ucHJvdG90eXBlLmJpbmQuY2FsbChtZXRob2QsIG9iaik7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgLy8gTWlzc2luZyBiaW5kIHNoaW0gb3IgSUU4ICsgTW9kZXJuaXpyLCBmYWxsYmFjayB0byB3cmFwcGluZ1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEZ1bmN0aW9uLnByb3RvdHlwZS5hcHBseS5hcHBseShtZXRob2QsIFtvYmosIGFyZ3VtZW50c10pO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUcmFjZSgpIGRvZXNuJ3QgcHJpbnQgdGhlIG1lc3NhZ2UgaW4gSUUsIHNvIGZvciB0aGF0IGNhc2Ugd2UgbmVlZCB0byB3cmFwIGl0XG4gICAgZnVuY3Rpb24gdHJhY2VGb3JJRSgpIHtcbiAgICAgICAgaWYgKGNvbnNvbGUubG9nKSB7XG4gICAgICAgICAgICBpZiAoY29uc29sZS5sb2cuYXBwbHkpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZy5hcHBseShjb25zb2xlLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBJbiBvbGQgSUUsIG5hdGl2ZSBjb25zb2xlIG1ldGhvZHMgdGhlbXNlbHZlcyBkb24ndCBoYXZlIGFwcGx5KCkuXG4gICAgICAgICAgICAgICAgRnVuY3Rpb24ucHJvdG90eXBlLmFwcGx5LmFwcGx5KGNvbnNvbGUubG9nLCBbY29uc29sZSwgYXJndW1lbnRzXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbnNvbGUudHJhY2UpIGNvbnNvbGUudHJhY2UoKTtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCB0aGUgYmVzdCBsb2dnaW5nIG1ldGhvZCBwb3NzaWJsZSBmb3IgdGhpcyBlbnZcbiAgICAvLyBXaGVyZXZlciBwb3NzaWJsZSB3ZSB3YW50IHRvIGJpbmQsIG5vdCB3cmFwLCB0byBwcmVzZXJ2ZSBzdGFjayB0cmFjZXNcbiAgICBmdW5jdGlvbiByZWFsTWV0aG9kKG1ldGhvZE5hbWUpIHtcbiAgICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdkZWJ1ZycpIHtcbiAgICAgICAgICAgIG1ldGhvZE5hbWUgPSAnbG9nJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyBObyBtZXRob2QgcG9zc2libGUsIGZvciBub3cgLSBmaXhlZCBsYXRlciBieSBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzXG4gICAgICAgIH0gZWxzZSBpZiAobWV0aG9kTmFtZSA9PT0gJ3RyYWNlJyAmJiBpc0lFKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhY2VGb3JJRTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25zb2xlW21ldGhvZE5hbWVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBiaW5kTWV0aG9kKGNvbnNvbGUsIG1ldGhvZE5hbWUpO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbnNvbGUubG9nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBiaW5kTWV0aG9kKGNvbnNvbGUsICdsb2cnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBub29wO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVGhlc2UgcHJpdmF0ZSBmdW5jdGlvbnMgYWx3YXlzIG5lZWQgYHRoaXNgIHRvIGJlIHNldCBwcm9wZXJseVxuXG4gICAgZnVuY3Rpb24gcmVwbGFjZUxvZ2dpbmdNZXRob2RzKCkge1xuICAgICAgICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICAgICAgICB2YXIgbGV2ZWwgPSB0aGlzLmdldExldmVsKCk7XG5cbiAgICAgICAgLy8gUmVwbGFjZSB0aGUgYWN0dWFsIG1ldGhvZHMuXG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbG9nTWV0aG9kcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdmFyIG1ldGhvZE5hbWUgPSBsb2dNZXRob2RzW2ldO1xuICAgICAgICAgICAgdGhpc1ttZXRob2ROYW1lXSA9IChpIDwgbGV2ZWwpID9cbiAgICAgICAgICAgICAgICBub29wIDpcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGhvZEZhY3RvcnkobWV0aG9kTmFtZSwgbGV2ZWwsIHRoaXMubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBEZWZpbmUgbG9nLmxvZyBhcyBhbiBhbGlhcyBmb3IgbG9nLmRlYnVnXG4gICAgICAgIHRoaXMubG9nID0gdGhpcy5kZWJ1ZztcblxuICAgICAgICAvLyBSZXR1cm4gYW55IGltcG9ydGFudCB3YXJuaW5ncy5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlID09PSB1bmRlZmluZWRUeXBlICYmIGxldmVsIDwgdGhpcy5sZXZlbHMuU0lMRU5UKSB7XG4gICAgICAgICAgICByZXR1cm4gXCJObyBjb25zb2xlIGF2YWlsYWJsZSBmb3IgbG9nZ2luZ1wiO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gSW4gb2xkIElFIHZlcnNpb25zLCB0aGUgY29uc29sZSBpc24ndCBwcmVzZW50IHVudGlsIHlvdSBmaXJzdCBvcGVuIGl0LlxuICAgIC8vIFdlIGJ1aWxkIHJlYWxNZXRob2QoKSByZXBsYWNlbWVudHMgaGVyZSB0aGF0IHJlZ2VuZXJhdGUgbG9nZ2luZyBtZXRob2RzXG4gICAgZnVuY3Rpb24gZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlcyhtZXRob2ROYW1lKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgIT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgICAgICB0aGlzW21ldGhvZE5hbWVdLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gQnkgZGVmYXVsdCwgd2UgdXNlIGNsb3NlbHkgYm91bmQgcmVhbCBtZXRob2RzIHdoZXJldmVyIHBvc3NpYmxlLCBhbmRcbiAgICAvLyBvdGhlcndpc2Ugd2Ugd2FpdCBmb3IgYSBjb25zb2xlIHRvIGFwcGVhciwgYW5kIHRoZW4gdHJ5IGFnYWluLlxuICAgIGZ1bmN0aW9uIGRlZmF1bHRNZXRob2RGYWN0b3J5KG1ldGhvZE5hbWUsIF9sZXZlbCwgX2xvZ2dlck5hbWUpIHtcbiAgICAgICAgLypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cbiAgICAgICAgcmV0dXJuIHJlYWxNZXRob2QobWV0aG9kTmFtZSkgfHxcbiAgICAgICAgICAgICAgIGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXMuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBMb2dnZXIobmFtZSwgZmFjdG9yeSkge1xuICAgICAgLy8gUHJpdmF0ZSBpbnN0YW5jZSB2YXJpYWJsZXMuXG4gICAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgICAvKipcbiAgICAgICAqIFRoZSBsZXZlbCBpbmhlcml0ZWQgZnJvbSBhIHBhcmVudCBsb2dnZXIgKG9yIGEgZ2xvYmFsIGRlZmF1bHQpLiBXZVxuICAgICAgICogY2FjaGUgdGhpcyBoZXJlIHJhdGhlciB0aGFuIGRlbGVnYXRpbmcgdG8gdGhlIHBhcmVudCBzbyB0aGF0IGl0IHN0YXlzXG4gICAgICAgKiBpbiBzeW5jIHdpdGggdGhlIGFjdHVhbCBsb2dnaW5nIG1ldGhvZHMgdGhhdCB3ZSBoYXZlIGluc3RhbGxlZCAodGhlXG4gICAgICAgKiBwYXJlbnQgY291bGQgY2hhbmdlIGxldmVscyBidXQgd2UgbWlnaHQgbm90IGhhdmUgcmVidWlsdCB0aGUgbG9nZ2Vyc1xuICAgICAgICogaW4gdGhpcyBjaGlsZCB5ZXQpLlxuICAgICAgICogQHR5cGUge251bWJlcn1cbiAgICAgICAqL1xuICAgICAgdmFyIGluaGVyaXRlZExldmVsO1xuICAgICAgLyoqXG4gICAgICAgKiBUaGUgZGVmYXVsdCBsZXZlbCBmb3IgdGhpcyBsb2dnZXIsIGlmIGFueS4gSWYgc2V0LCB0aGlzIG92ZXJyaWRlc1xuICAgICAgICogYGluaGVyaXRlZExldmVsYC5cbiAgICAgICAqIEB0eXBlIHtudW1iZXJ8bnVsbH1cbiAgICAgICAqL1xuICAgICAgdmFyIGRlZmF1bHRMZXZlbDtcbiAgICAgIC8qKlxuICAgICAgICogQSB1c2VyLXNwZWNpZmljIGxldmVsIGZvciB0aGlzIGxvZ2dlci4gSWYgc2V0LCB0aGlzIG92ZXJyaWRlc1xuICAgICAgICogYGRlZmF1bHRMZXZlbGAuXG4gICAgICAgKiBAdHlwZSB7bnVtYmVyfG51bGx9XG4gICAgICAgKi9cbiAgICAgIHZhciB1c2VyTGV2ZWw7XG5cbiAgICAgIHZhciBzdG9yYWdlS2V5ID0gXCJsb2dsZXZlbFwiO1xuICAgICAgaWYgKHR5cGVvZiBuYW1lID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHN0b3JhZ2VLZXkgKz0gXCI6XCIgKyBuYW1lO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgbmFtZSA9PT0gXCJzeW1ib2xcIikge1xuICAgICAgICBzdG9yYWdlS2V5ID0gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBwZXJzaXN0TGV2ZWxJZlBvc3NpYmxlKGxldmVsTnVtKSB7XG4gICAgICAgICAgdmFyIGxldmVsTmFtZSA9IChsb2dNZXRob2RzW2xldmVsTnVtXSB8fCAnc2lsZW50JykudG9VcHBlckNhc2UoKTtcblxuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICAvLyBVc2UgbG9jYWxTdG9yYWdlIGlmIGF2YWlsYWJsZVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Vbc3RvcmFnZUtleV0gPSBsZXZlbE5hbWU7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBVc2Ugc2Vzc2lvbiBjb29raWUgYXMgZmFsbGJhY2tcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cuZG9jdW1lbnQuY29va2llID1cbiAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj1cIiArIGxldmVsTmFtZSArIFwiO1wiO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gZ2V0UGVyc2lzdGVkTGV2ZWwoKSB7XG4gICAgICAgICAgdmFyIHN0b3JlZExldmVsO1xuXG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHN0b3JlZExldmVsID0gd2luZG93LmxvY2FsU3RvcmFnZVtzdG9yYWdlS2V5XTtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBGYWxsYmFjayB0byBjb29raWVzIGlmIGxvY2FsIHN0b3JhZ2UgZ2l2ZXMgdXMgbm90aGluZ1xuICAgICAgICAgIGlmICh0eXBlb2Ygc3RvcmVkTGV2ZWwgPT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgIHZhciBjb29raWUgPSB3aW5kb3cuZG9jdW1lbnQuY29va2llO1xuICAgICAgICAgICAgICAgICAgdmFyIGNvb2tpZU5hbWUgPSBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSk7XG4gICAgICAgICAgICAgICAgICB2YXIgbG9jYXRpb24gPSBjb29raWUuaW5kZXhPZihjb29raWVOYW1lICsgXCI9XCIpO1xuICAgICAgICAgICAgICAgICAgaWYgKGxvY2F0aW9uICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgIHN0b3JlZExldmVsID0gL14oW147XSspLy5leGVjKFxuICAgICAgICAgICAgICAgICAgICAgICAgICBjb29raWUuc2xpY2UobG9jYXRpb24gKyBjb29raWVOYW1lLmxlbmd0aCArIDEpXG4gICAgICAgICAgICAgICAgICAgICAgKVsxXTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIElmIHRoZSBzdG9yZWQgbGV2ZWwgaXMgbm90IHZhbGlkLCB0cmVhdCBpdCBhcyBpZiBub3RoaW5nIHdhcyBzdG9yZWQuXG4gICAgICAgICAgaWYgKHNlbGYubGV2ZWxzW3N0b3JlZExldmVsXSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHN0b3JlZExldmVsID0gdW5kZWZpbmVkO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBzdG9yZWRMZXZlbDtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gY2xlYXJQZXJzaXN0ZWRMZXZlbCgpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gVXNlIGxvY2FsU3RvcmFnZSBpZiBhdmFpbGFibGVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oc3RvcmFnZUtleSk7XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gVXNlIHNlc3Npb24gY29va2llIGFzIGZhbGxiYWNrXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmRvY3VtZW50LmNvb2tpZSA9XG4gICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9OyBleHBpcmVzPVRodSwgMDEgSmFuIDE5NzAgMDA6MDA6MDAgVVRDXCI7XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBub3JtYWxpemVMZXZlbChpbnB1dCkge1xuICAgICAgICAgIHZhciBsZXZlbCA9IGlucHV0O1xuICAgICAgICAgIGlmICh0eXBlb2YgbGV2ZWwgPT09IFwic3RyaW5nXCIgJiYgc2VsZi5sZXZlbHNbbGV2ZWwudG9VcHBlckNhc2UoKV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBsZXZlbCA9IHNlbGYubGV2ZWxzW2xldmVsLnRvVXBwZXJDYXNlKCldO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHlwZW9mIGxldmVsID09PSBcIm51bWJlclwiICYmIGxldmVsID49IDAgJiYgbGV2ZWwgPD0gc2VsZi5sZXZlbHMuU0lMRU5UKSB7XG4gICAgICAgICAgICAgIHJldHVybiBsZXZlbDtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwibG9nLnNldExldmVsKCkgY2FsbGVkIHdpdGggaW52YWxpZCBsZXZlbDogXCIgKyBpbnB1dCk7XG4gICAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvKlxuICAgICAgICpcbiAgICAgICAqIFB1YmxpYyBsb2dnZXIgQVBJIC0gc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9waW10ZXJyeS9sb2dsZXZlbCBmb3IgZGV0YWlsc1xuICAgICAgICpcbiAgICAgICAqL1xuXG4gICAgICBzZWxmLm5hbWUgPSBuYW1lO1xuXG4gICAgICBzZWxmLmxldmVscyA9IHsgXCJUUkFDRVwiOiAwLCBcIkRFQlVHXCI6IDEsIFwiSU5GT1wiOiAyLCBcIldBUk5cIjogMyxcbiAgICAgICAgICBcIkVSUk9SXCI6IDQsIFwiU0lMRU5UXCI6IDV9O1xuXG4gICAgICBzZWxmLm1ldGhvZEZhY3RvcnkgPSBmYWN0b3J5IHx8IGRlZmF1bHRNZXRob2RGYWN0b3J5O1xuXG4gICAgICBzZWxmLmdldExldmVsID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIGlmICh1c2VyTGV2ZWwgIT0gbnVsbCkge1xuICAgICAgICAgICAgcmV0dXJuIHVzZXJMZXZlbDtcbiAgICAgICAgICB9IGVsc2UgaWYgKGRlZmF1bHRMZXZlbCAhPSBudWxsKSB7XG4gICAgICAgICAgICByZXR1cm4gZGVmYXVsdExldmVsO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gaW5oZXJpdGVkTGV2ZWw7XG4gICAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgc2VsZi5zZXRMZXZlbCA9IGZ1bmN0aW9uIChsZXZlbCwgcGVyc2lzdCkge1xuICAgICAgICAgIHVzZXJMZXZlbCA9IG5vcm1hbGl6ZUxldmVsKGxldmVsKTtcbiAgICAgICAgICBpZiAocGVyc2lzdCAhPT0gZmFsc2UpIHsgIC8vIGRlZmF1bHRzIHRvIHRydWVcbiAgICAgICAgICAgICAgcGVyc2lzdExldmVsSWZQb3NzaWJsZSh1c2VyTGV2ZWwpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIE5PVEU6IGluIHYyLCB0aGlzIHNob3VsZCBjYWxsIHJlYnVpbGQoKSwgd2hpY2ggdXBkYXRlcyBjaGlsZHJlbi5cbiAgICAgICAgICByZXR1cm4gcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwoc2VsZik7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnNldERlZmF1bHRMZXZlbCA9IGZ1bmN0aW9uIChsZXZlbCkge1xuICAgICAgICAgIGRlZmF1bHRMZXZlbCA9IG5vcm1hbGl6ZUxldmVsKGxldmVsKTtcbiAgICAgICAgICBpZiAoIWdldFBlcnNpc3RlZExldmVsKCkpIHtcbiAgICAgICAgICAgICAgc2VsZi5zZXRMZXZlbChsZXZlbCwgZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHNlbGYucmVzZXRMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICB1c2VyTGV2ZWwgPSBudWxsO1xuICAgICAgICAgIGNsZWFyUGVyc2lzdGVkTGV2ZWwoKTtcbiAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbChzZWxmKTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuZW5hYmxlQWxsID0gZnVuY3Rpb24ocGVyc2lzdCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoc2VsZi5sZXZlbHMuVFJBQ0UsIHBlcnNpc3QpO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5kaXNhYmxlQWxsID0gZnVuY3Rpb24ocGVyc2lzdCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoc2VsZi5sZXZlbHMuU0lMRU5ULCBwZXJzaXN0KTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYucmVidWlsZCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBpZiAoZGVmYXVsdExvZ2dlciAhPT0gc2VsZikge1xuICAgICAgICAgICAgICBpbmhlcml0ZWRMZXZlbCA9IG5vcm1hbGl6ZUxldmVsKGRlZmF1bHRMb2dnZXIuZ2V0TGV2ZWwoKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlcGxhY2VMb2dnaW5nTWV0aG9kcy5jYWxsKHNlbGYpO1xuXG4gICAgICAgICAgaWYgKGRlZmF1bHRMb2dnZXIgPT09IHNlbGYpIHtcbiAgICAgICAgICAgICAgZm9yICh2YXIgY2hpbGROYW1lIGluIF9sb2dnZXJzQnlOYW1lKSB7XG4gICAgICAgICAgICAgICAgX2xvZ2dlcnNCeU5hbWVbY2hpbGROYW1lXS5yZWJ1aWxkKCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICAvLyBJbml0aWFsaXplIGFsbCB0aGUgaW50ZXJuYWwgbGV2ZWxzLlxuICAgICAgaW5oZXJpdGVkTGV2ZWwgPSBub3JtYWxpemVMZXZlbChcbiAgICAgICAgICBkZWZhdWx0TG9nZ2VyID8gZGVmYXVsdExvZ2dlci5nZXRMZXZlbCgpIDogXCJXQVJOXCJcbiAgICAgICk7XG4gICAgICB2YXIgaW5pdGlhbExldmVsID0gZ2V0UGVyc2lzdGVkTGV2ZWwoKTtcbiAgICAgIGlmIChpbml0aWFsTGV2ZWwgIT0gbnVsbCkge1xuICAgICAgICAgIHVzZXJMZXZlbCA9IG5vcm1hbGl6ZUxldmVsKGluaXRpYWxMZXZlbCk7XG4gICAgICB9XG4gICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbChzZWxmKTtcbiAgICB9XG5cbiAgICAvKlxuICAgICAqXG4gICAgICogVG9wLWxldmVsIEFQSVxuICAgICAqXG4gICAgICovXG5cbiAgICBkZWZhdWx0TG9nZ2VyID0gbmV3IExvZ2dlcigpO1xuXG4gICAgZGVmYXVsdExvZ2dlci5nZXRMb2dnZXIgPSBmdW5jdGlvbiBnZXRMb2dnZXIobmFtZSkge1xuICAgICAgICBpZiAoKHR5cGVvZiBuYW1lICE9PSBcInN5bWJvbFwiICYmIHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiKSB8fCBuYW1lID09PSBcIlwiKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiWW91IG11c3Qgc3VwcGx5IGEgbmFtZSB3aGVuIGNyZWF0aW5nIGEgbG9nZ2VyLlwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBsb2dnZXIgPSBfbG9nZ2Vyc0J5TmFtZVtuYW1lXTtcbiAgICAgICAgaWYgKCFsb2dnZXIpIHtcbiAgICAgICAgICAgIGxvZ2dlciA9IF9sb2dnZXJzQnlOYW1lW25hbWVdID0gbmV3IExvZ2dlcihcbiAgICAgICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgICAgIGRlZmF1bHRMb2dnZXIubWV0aG9kRmFjdG9yeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbG9nZ2VyO1xuICAgIH07XG5cbiAgICAvLyBHcmFiIHRoZSBjdXJyZW50IGdsb2JhbCBsb2cgdmFyaWFibGUgaW4gY2FzZSBvZiBvdmVyd3JpdGVcbiAgICB2YXIgX2xvZyA9ICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlKSA/IHdpbmRvdy5sb2cgOiB1bmRlZmluZWQ7XG4gICAgZGVmYXVsdExvZ2dlci5ub0NvbmZsaWN0ID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlICYmXG4gICAgICAgICAgICAgICB3aW5kb3cubG9nID09PSBkZWZhdWx0TG9nZ2VyKSB7XG4gICAgICAgICAgICB3aW5kb3cubG9nID0gX2xvZztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBkZWZhdWx0TG9nZ2VyO1xuICAgIH07XG5cbiAgICBkZWZhdWx0TG9nZ2VyLmdldExvZ2dlcnMgPSBmdW5jdGlvbiBnZXRMb2dnZXJzKCkge1xuICAgICAgICByZXR1cm4gX2xvZ2dlcnNCeU5hbWU7XG4gICAgfTtcblxuICAgIC8vIEVTNiBkZWZhdWx0IGV4cG9ydCwgZm9yIGNvbXBhdGliaWxpdHlcbiAgICBkZWZhdWx0TG9nZ2VyWydkZWZhdWx0J10gPSBkZWZhdWx0TG9nZ2VyO1xuXG4gICAgcmV0dXJuIGRlZmF1bHRMb2dnZXI7XG59KSk7XG4iLCJcInVzZSBzdHJpY3RcIjtcclxuXHJcbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqIE1PREJVUyBSVFUgRlVOQ1RJT05TIEZPUiBTRU5FQ0EgKioqKioqKioqKioqKioqKioqKioqKi9cclxuXHJcbnZhciBtb2RidXMgPSByZXF1aXJlKFwiLi9tb2RidXNSdHVcIik7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuL3V0aWxzXCIpO1xyXG5jb25zdCB7IENvbW1hbmQgfSA9IHJlcXVpcmUoXCIuL21ldGVyQXBpXCIpO1xyXG5jb25zdCB7IGJ0U3RhdGUgfSA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvQVBJU3RhdGVcIik7XHJcblxyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbmNvbnN0IFNFTkVDQV9NQl9TTEFWRV9JRCA9IG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQ7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbi8qXHJcbiAqIE1vZGJ1cyByZWdpc3RlcnMgbWFwLiBFYWNoIHJlZ2lzdGVyIGlzIDIgYnl0ZXMgd2lkZS5cclxuICovXHJcbmNvbnN0IE1TQ1JlZ2lzdGVycyA9IHtcclxuXHRTZXJpYWxOdW1iZXI6IDEwLFxyXG5cdEN1cnJlbnRNb2RlOiAxMDAsXHJcblx0TWVhc3VyZUZsYWdzOiAxMDIsXHJcblx0Q01EOiAxMDcsXHJcblx0QVVYMTogMTA4LFxyXG5cdExvYWRDZWxsTWVhc3VyZTogMTE0LFxyXG5cdFRlbXBNZWFzdXJlOiAxMjAsXHJcblx0UnRkVGVtcGVyYXR1cmVNZWFzdXJlOiAxMjgsXHJcblx0UnRkUmVzaXN0YW5jZU1lYXN1cmU6IDEzMCxcclxuXHRGcmVxdWVuY3lNZWFzdXJlOiAxNjQsXHJcblx0TWluTWVhc3VyZTogMTMyLFxyXG5cdE1heE1lYXN1cmU6IDEzNCxcclxuXHRJbnN0YW50TWVhc3VyZTogMTM2LFxyXG5cdFBvd2VyT2ZmRGVsYXk6IDE0MixcclxuXHRQb3dlck9mZlJlbWFpbmluZzogMTQ2LFxyXG5cdFB1bHNlT0ZGTWVhc3VyZTogMTUwLFxyXG5cdFB1bHNlT05NZWFzdXJlOiAxNTIsXHJcblx0U2Vuc2liaWxpdHlfdVNfT0ZGOiAxNjYsXHJcblx0U2Vuc2liaWxpdHlfdVNfT046IDE2OCxcclxuXHRCYXR0ZXJ5TWVhc3VyZTogMTc0LFxyXG5cdENvbGRKdW5jdGlvbjogMTkwLFxyXG5cdFRocmVzaG9sZFVfRnJlcTogMTkyLFxyXG5cdEdlbmVyYXRpb25GbGFnczogMjAyLFxyXG5cdEdFTl9DTUQ6IDIwNyxcclxuXHRHRU5fQVVYMTogMjA4LFxyXG5cdEN1cnJlbnRTZXRwb2ludDogMjEwLFxyXG5cdFZvbHRhZ2VTZXRwb2ludDogMjEyLFxyXG5cdExvYWRDZWxsU2V0cG9pbnQ6IDIxNixcclxuXHRUaGVybW9UZW1wZXJhdHVyZVNldHBvaW50OiAyMjAsXHJcblx0UlREVGVtcGVyYXR1cmVTZXRwb2ludDogMjI4LFxyXG5cdFB1bHNlc0NvdW50OiAyNTIsXHJcblx0RnJlcXVlbmN5VElDSzE6IDI1NCxcclxuXHRGcmVxdWVuY3lUSUNLMjogMjU2LFxyXG5cdEdlblVoaWdoUGVyYzogMjYyLFxyXG5cdEdlblVsb3dQZXJjOiAyNjRcclxufTtcclxuXHJcbi8qKlxyXG4gKiBHZW5lcmF0ZSB0aGUgbW9kYnVzIFJUVSBwYWNrZXQgdG8gcmVhZCB0aGUgc2VyaWFsIG51bWJlclxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlU2VyaWFsTnVtYmVyKCkge1xyXG5cdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5TZXJpYWxOdW1iZXIpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQ3VycmVudE1vZGUoKSB7XHJcblx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRNb2RlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBjdXJyZW50IGJhdHRlcnkgbGV2ZWxcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZUJhdHRlcnlMZXZlbCgpIHtcclxuXHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQmF0dGVyeU1lYXN1cmUpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSByZWdpc3RlciB3aXRoIGJhdHRlcnkgbGV2ZWxcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIEZDMyBhbnN3ZXIgXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGJhdHRlcnkgbGV2ZWwgaW4gVlxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VCYXR0ZXJ5KGJ1ZmZlcikge1xyXG5cdHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHRyZXR1cm4gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgU2VuZWNhIE1TQyBzZXJpYWwgYXMgcGVyIHRoZSBVSSBpbnRlcmZhY2VcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBhbnN3ZXIgcGFja2V0IChGQzMpXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZVNlcmlhbE51bWJlcihidWZmZXIpIHtcclxuXHR2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0aWYgKHJlZ2lzdGVycy5sZW5ndGggPCA0KSB7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHNlcmlhbCBudW1iZXIgcmVzcG9uc2VcIik7XHJcblx0fVxyXG5cdGNvbnN0IHZhbDEgPSByZWdpc3RlcnMuZ2V0VWludDE2KDAsIGZhbHNlKTtcclxuXHRjb25zdCB2YWwyID0gcmVnaXN0ZXJzLmdldFVpbnQxNigyLCBmYWxzZSk7XHJcblx0Y29uc3Qgc2VyaWFsID0gKCh2YWwyIDw8IDE2KSArIHZhbDEpLnRvU3RyaW5nKCk7XHJcblx0aWYgKHNlcmlhbC5sZW5ndGggPiA1KSB7XHJcblx0XHRyZXR1cm4gc2VyaWFsLnN1YnN0cigwLCA1KSArIFwiX1wiICsgc2VyaWFsLnN1YnN0cig1LCBzZXJpYWwubGVuZ3RoIC0gNSk7XHJcblx0fVxyXG5cdHJldHVybiBzZXJpYWw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZXMgdGhlIHN0YXRlIG9mIHRoZSBtZXRlci4gTWF5IHRocm93LlxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgbW9kYnVzIGFuc3dlciBwYWNrZXQgKEZDMylcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY3VycmVudE1vZGUgaWYgdGhlIHJlZ2lzdGVycyBjb250YWlucyBhbiBJR05PUkUgdmFsdWUsIHJldHVybnMgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiBAcmV0dXJucyB7Q29tbWFuZFR5cGV9IG1ldGVyIG1vZGVcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQ3VycmVudE1vZGUoYnVmZmVyLCBjdXJyZW50TW9kZSkge1xyXG5cdHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHRpZiAocmVnaXN0ZXJzLmxlbmd0aCA8IDIpIHtcclxuXHRcdHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbW9kZSByZXNwb25zZVwiKTtcclxuXHR9XHJcblx0Y29uc3QgdmFsMSA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMCwgZmFsc2UpO1xyXG5cclxuXHRpZiAodmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLlJFU0VSVkVEXzIpIHsgLy8gTXVzdCBiZSBpZ25vcmVkLCBpbnRlcm5hbCBzdGF0ZXMgb2YgdGhlIG1ldGVyXHJcblx0XHRyZXR1cm4gY3VycmVudE1vZGU7XHJcblx0fVxyXG5cdGNvbnN0IHZhbHVlID0gdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIHZhbDEpO1xyXG5cdGlmICh2YWx1ZSA9PSBudWxsKVxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtZXRlciBtb2RlIDogXCIgKyB2YWx1ZSk7XHJcblxyXG5cdGlmICh2YWwxID09IGNvbnN0YW50cy5Db250aW51aXR5SW1wbCAmJiBidFN0YXRlLmNvbnRpbnVpdHkpXHJcblx0e1xyXG5cdFx0cmV0dXJuIENvbW1hbmRUeXBlLkNvbnRpbnVpdHk7XHJcblx0fVxyXG5cdHJldHVybiB2YWwxO1xyXG59XHJcbi8qKlxyXG4gKiBTZXRzIHRoZSBjdXJyZW50IG1vZGUuXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcnxudWxsfVxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZU1vZGVSZXF1ZXN0KG1vZGUpIHtcclxuXHRjb25zdCB2YWx1ZSA9IHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCBtb2RlKTtcclxuXHRjb25zdCBDSEFOR0VfU1RBVFVTID0gMTtcclxuXHJcblx0Ly8gRmlsdGVyIGludmFsaWQgY29tbWFuZHNcclxuXHRpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuXHRcdHJldHVybiBudWxsO1xyXG5cdH1cclxuXHJcblx0YnRTdGF0ZS5jb250aW51aXR5ID0gZmFsc2U7XHJcblxyXG5cdGlmIChtb2RlID4gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOICYmIG1vZGUgPD0gQ29tbWFuZFR5cGUuT0ZGKSB7IC8vIE1lYXN1cmVtZW50c1xyXG5cdFx0aWYgKG1vZGUgPT0gQ29tbWFuZFR5cGUuQ29udGludWl0eSlcclxuXHRcdHtcclxuXHRcdFx0bW9kZSA9IGNvbnN0YW50cy5Db250aW51aXR5SW1wbDtcclxuXHRcdFx0YnRTdGF0ZS5jb250aW51aXR5ID0gdHJ1ZTtcclxuXHRcdH1cclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG5cdH1cclxuXHRlbHNlIGlmIChtb2RlID4gQ29tbWFuZFR5cGUuT0ZGICYmIG1vZGUgPCBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQpIHsgLy8gR2VuZXJhdGlvbnNcclxuXHRcdHN3aXRjaCAobW9kZSkge1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG5cdFx0XHQvLyBDb2xkIGp1bmN0aW9uIG5vdCBjb25maWd1cmVkXHJcblx0XHRcdHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR0VOX0NNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuXHRcdGRlZmF1bHQ6XHJcblx0XHRcdC8vIEFsbCB0aGUgc2ltcGxlIGNhc2VzIFxyXG5cdFx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcblx0XHR9XHJcblxyXG5cdH1cclxuXHRyZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdoZW4gdGhlIG1ldGVyIGlzIG1lYXN1cmluZywgbWFrZSB0aGUgbW9kYnVzIHJlcXVlc3Qgb2YgdGhlIHZhbHVlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHBhY2tldFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZU1lYXN1cmVSZXF1ZXN0KG1vZGUpIHtcclxuXHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuXHRcdHJldHVybiBudWxsO1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fRTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19KOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0s6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTDpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19OOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19UOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlRlbXBNZWFzdXJlKTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkNvbnRpbnVpdHk6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTUwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1NTBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEyMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDUwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfNFc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfNFc6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUnRkVGVtcGVyYXR1cmVNZWFzdXJlKTsgLy8gVGVtcC1PaG1cclxuXHRjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lNZWFzdXJlKTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUHVsc2VPRkZNZWFzdXJlKTsgLy8gT04tT0ZGXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5Mb2FkQ2VsbDpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbCk7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNiwgTVNDUmVnaXN0ZXJzLk1pbk1lYXN1cmUpOyAvLyBNaW4tTWF4LU1lYXNcclxuXHRkZWZhdWx0OlxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiTW9kZSBub3QgbWFuYWdlZCA6XCIgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBtZWFzdXJlIHJlYWQgZnJvbSB0aGUgbWV0ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBydHUgYW5zd2VyIChGQzMpXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgY3VycmVudCBtb2RlIG9mIHRoZSBtZXRlclxyXG4gKiBAcmV0dXJucyB7YXJyYXl9IGFuIGFycmF5IHdpdGggZmlyc3QgZWxlbWVudCBcIk1lYXN1cmUgbmFtZSAodW5pdHMpXCI6VmFsdWUsIHNlY29uZCBUaW1lc3RhbXA6YWNxdWlzaXRpb25cclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlTWVhc3VyZShidWZmZXIsIG1vZGUpIHtcclxuXHR2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHR2YXIgbWVhcywgbWVhczIsIG1pbiwgbWF4O1xyXG5cclxuXHQvLyBBbGwgbWVhc3VyZXMgYXJlIGZsb2F0XHJcblx0aWYgKHJlc3BvbnNlRkMzID09IG51bGwpXHJcblx0XHRyZXR1cm4ge307XHJcblxyXG5cdHN3aXRjaCAobW9kZSkge1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fRTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19KOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0s6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTDpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19OOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUzpcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0dmFyIHZhbHVlID0gTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMDtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHZhbHVlLFxyXG5cdFx0XHRcIlVuaXRcIjogXCLCsENcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1NTBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTUwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEyMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDUwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzRXOlxyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHRtZWFzMiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMCkgLyAxMCxcclxuXHRcdFx0XCJVbml0XCI6IFwiwrBDXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJSZXNpc3RhbmNlXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VmFsdWVcIjogTWF0aC5yb3VuZChtZWFzMiAqIDEwKSAvIDEwLFxyXG5cdFx0XHRcIlNlY29uZGFyeVVuaXRcIjogXCJPaG1zXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkNvbnRpbnVpdHk6XHJcblx0XHRtZWFzMiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiQ29udGludWl0eVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IChtZWFzMiA8IGNvbnN0YW50cy5Db250aW51aXR5VGhyZXNob2xkT2htcykgPyAxIDogMCxcclxuXHRcdFx0XCJVbml0XCI6IFwiTm9uZVwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUmVzaXN0YW5jZVwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeVZhbHVlXCI6IE1hdGgucm91bmQobWVhczIgKiAxMCkgLyAxMCxcclxuXHRcdFx0XCJTZWNvbmRhcnlVbml0XCI6IFwiT2htc1wiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5GcmVxdWVuY3k6XHJcblx0XHRtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuXHRcdC8vIFNlbnNpYmlsaXTDoCBtYW5jYW50aVxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwKSAvIDEwLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJIelwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG5cdFx0bWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuXHRcdG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHRtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJDdXJyZW50XCIsXHJcblx0XHRcdFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJVbml0XCI6IFwibUFcIixcclxuXHRcdFx0XCJNaW5pbXVtXCI6IE1hdGgucm91bmQobWluICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuXHRcdG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHRtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIlZcIixcclxuXHRcdFx0XCJNaW5pbXVtXCI6IE1hdGgucm91bmQobWluICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUubVY6XHJcblx0XHRtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0bWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJtVlwiLFxyXG5cdFx0XHRcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuXHRcdG1lYXMyID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG5cdFx0Ly8gU29nbGlhIGUgc2Vuc2liaWxpdMOgIG1hbmNhbnRpXHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiUHVsc2UgT05cIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBtZWFzLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJcIixcclxuXHRcdFx0XCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIlB1bHNlIE9GRlwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeVZhbHVlXCI6IG1lYXMyLFxyXG5cdFx0XHRcIlNlY29uZGFyeVVuaXRcIjogXCJcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTG9hZENlbGw6XHJcblx0XHRtZWFzID0gTWF0aC5yb3VuZChtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApICogMTAwMCkgLyAxMDAwO1xyXG5cdFx0Ly8gS2cgbWFuY2FudGlcclxuXHRcdC8vIFNlbnNpYmlsaXTDoCwgdGFyYSwgcG9ydGF0YSBtYW5jYW50aVxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkltYmFsYW5jZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IG1lYXMsXHJcblx0XHRcdFwiVW5pdFwiOiBcIm1WL1ZcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGRlZmF1bHQ6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVW5rbm93blwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMDApIC8gMTAwMCxcclxuXHRcdFx0XCJVbml0XCI6IFwiP1wiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0fVxyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHN0YXR1cyBmbGFncyBmcm9tIG1lYXN1cmVtZW50IG1vZGVcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlUXVhbGl0eUJpdFJlcXVlc3QobW9kZSkge1xyXG5cdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDEsIE1TQ1JlZ2lzdGVycy5NZWFzdXJlRmxhZ3MpO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2tzIGlmIHRoZSBlcnJvciBiaXQgc3RhdHVzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiB0aGVyZSBpcyBubyBlcnJvclxyXG4gKi9cclxuZnVuY3Rpb24gaXNRdWFsaXR5VmFsaWQoYnVmZmVyKSB7XHJcblx0dmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0cmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDEzKSkgPT0gMCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgZ2VuZXJhdGlvbiBmbGFncyBzdGF0dXMgZnJvbSB0aGUgbWV0ZXJcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlR2VuU3RhdHVzUmVhZChtb2RlKSB7XHJcblx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLkdlbmVyYXRpb25GbGFncyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVja3MgaWYgdGhlIGVycm9yIGJpdCBpcyBOT1Qgc2V0IGluIHRoZSBnZW5lcmF0aW9uIGZsYWdzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlRkMzXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIHRoZXJlIGlzIG5vIGVycm9yXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUdlblN0YXR1cyhidWZmZXIsIG1vZGUpIHtcclxuXHR2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuXHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuXHRcdHJldHVybiAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNSkpID09IDApICYmIC8vIEdlbiBlcnJvclxyXG4gICAgICAgICAgICAgICAgKChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTQpKSA9PSAwKTsgLy8gU2VsZiBnZW5lcmF0aW9uIEkgY2hlY2tcclxuXHRkZWZhdWx0OlxyXG5cdFx0cmV0dXJuIChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTUpKSA9PSAwOyAvLyBHZW4gZXJyb3JcclxuXHR9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGJ1ZmZlciB3aXRoIHRoZSBtb2RidXMtcnR1IHJlcXVlc3QgdG8gYmUgc2VudCB0byBTZW5lY2FcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBnZW5lcmF0aW9uIG1vZGVcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHRoZSB2YWx1ZSB0byBzZXQgKG1WL1YvQS9Iei/CsEMpIGV4Y2VwdCBmb3IgcHVsc2VzIG51bV9wdWxzZXNcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50MiBmcmVxdWVuY3kgaW4gSHpcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlcXVlc3QobW9kZSwgc2V0cG9pbnQsIHNldHBvaW50Mikge1xyXG5cdHZhciBURU1QLCByZWdpc3RlcnM7XHJcblx0dmFyIGR0ID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG5cdHZhciBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG5cdG1vZGJ1cy5zZXRGbG9hdDMyTEVCUyhkdiwgMCwgc2V0cG9pbnQpO1xyXG5cdGNvbnN0IHNwID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cclxuXHR2YXIgZHRJbnQgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcblx0dmFyIGR2SW50ID0gbmV3IERhdGFWaWV3KGR0SW50KTtcclxuXHRtb2RidXMuc2V0VWludDMyTEVCUyhkdkludCwgMCwgc2V0cG9pbnQpO1xyXG5cdGNvbnN0IHNwSW50ID0gW2R2SW50LmdldFVpbnQxNigwLCBmYWxzZSksIGR2SW50LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cclxuXHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50LCBzcCldOyAvLyBWIC8gbVYgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRTZXRwb2ludCwgc3ApXTsgLy8gSSBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5SVERUZW1wZXJhdHVyZVNldHBvaW50LCBzcCldOyAvLyDCsEMgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQsIHNwKV07IC8vIMKwQyBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuTG9hZENlbGxTZXRwb2ludCwgc3ApXTsgLy8gbVYvViBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuXHRcdGR0ID0gbmV3IEFycmF5QnVmZmVyKDgpOyAvLyAyIFVpbnQzMlxyXG5cdFx0ZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuXHRcdC8vIFNlZSBTZW5lY2FsIG1hbnVhbCBtYW51YWxcclxuXHRcdC8vIE1heCAyMGtIWiBnZW5cclxuXHRcdFRFTVAgPSBNYXRoLnJvdW5kKDIwMDAwIC8gc2V0cG9pbnQsIDApO1xyXG5cdFx0ZHYuc2V0VWludDMyKDAsIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0sxXHJcblx0XHRkdi5zZXRVaW50MzIoNCwgVEVNUCAtIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0syXHJcblxyXG5cdFx0Ly8gQnl0ZS1zd2FwcGVkIGxpdHRsZSBlbmRpYW5cclxuXHRcdHJlZ2lzdGVycyA9IFtkdi5nZXRVaW50MTYoMiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMCwgZmFsc2UpLFxyXG5cdFx0XHRkdi5nZXRVaW50MTYoNiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoNCwgZmFsc2UpXTtcclxuXHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSwgcmVnaXN0ZXJzKV07XHJcblxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcblx0XHRkdCA9IG5ldyBBcnJheUJ1ZmZlcigxMik7IC8vIDMgVWludDMyIFxyXG5cdFx0ZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuXHRcdC8vIFNlZSBTZW5lY2FsIG1hbnVhbCBtYW51YWxcclxuXHRcdC8vIE1heCAyMGtIWiBnZW5cclxuXHRcdFRFTVAgPSBNYXRoLnJvdW5kKDIwMDAwIC8gc2V0cG9pbnQyLCAwKTtcclxuXHJcblx0XHRkdi5zZXRVaW50MzIoMCwgc2V0cG9pbnQsIGZhbHNlKTsgLy8gTlVNX1BVTFNFU1xyXG5cdFx0ZHYuc2V0VWludDMyKDQsIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0sxXHJcblx0XHRkdi5zZXRVaW50MzIoOCwgVEVNUCAtIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0syXHJcblxyXG5cdFx0cmVnaXN0ZXJzID0gW2R2LmdldFVpbnQxNigyLCBmYWxzZSksIGR2LmdldFVpbnQxNigwLCBmYWxzZSldO1xyXG5cdFx0dmFyIHAxID0gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlB1bHNlc0NvdW50LCByZWdpc3RlcnMpOyAvLyBtdXN0IHNwbGl0IGluIHR3byB0byBzdGF5IDw9IDIwIGJ5dGVzIGZvciB0aGUgZnVsbCBydHUgcGFja2V0XHJcbiAgICAgICAgICAgIFxyXG5cdFx0cmVnaXN0ZXJzID0gWyBkdi5nZXRVaW50MTYoNiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoNCwgZmFsc2UpLFxyXG5cdFx0XHRkdi5nZXRVaW50MTYoMTAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDgsIGZhbHNlKV07XHJcblx0XHR2YXIgcDIgPSBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5VElDSzEsIHJlZ2lzdGVycyk7XHJcblx0XHRyZXR1cm4gW3AxLCBwMl07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfVVRocmVzaG9sZF9GOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVGhyZXNob2xkVV9GcmVxLCBzcCldOyAvLyBVIG1pbiBmb3IgZnJlcSBtZWFzdXJlbWVudFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NlbnNpdGl2aXR5X3VTOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuU2Vuc2liaWxpdHlfdVNfT0ZGLFxyXG5cdFx0XHRbc3BJbnRbMF0sIHNwSW50WzFdLCBzcEludFswXSwgc3BJbnRbMV1dKV07IC8vIHVWIGZvciBwdWxzZSB0cmFpbiBtZWFzdXJlbWVudCB0byBPTiAvIE9GRlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuU0VUX0NvbGRKdW5jdGlvbjpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNvbGRKdW5jdGlvbiwgc3ApXTsgLy8gdW5jbGVhciB1bml0XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfVWxvdzpcclxuXHRcdG1vZGJ1cy5zZXRGbG9hdDMyTEVCUyhkdiwgMCwgc2V0cG9pbnQgLyBjb25zdGFudHMuTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcblx0XHR2YXIgc3AyID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR2VuVWxvd1BlcmMsIHNwMildOyAvLyBVIGxvdyBmb3IgZnJlcSAvIHB1bHNlIGdlblxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VoaWdoOlxyXG5cdFx0bW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCAvIGNvbnN0YW50cy5NQVhfVV9HRU4pOyAvLyBNdXN0IGNvbnZlcnQgViBpbnRvIGEgJSAwLi5NQVhfVV9HRU5cclxuXHRcdHZhciBzcDMgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HZW5VaGlnaFBlcmMsIHNwMyldOyAvLyBVIGhpZ2ggZm9yIGZyZXEgLyBwdWxzZSBnZW4gICAgICAgICAgICBcclxuXHRjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUG93ZXJPZmZEZWxheSwgc2V0cG9pbnQpXTsgLy8gZGVsYXkgaW4gc2VjXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcblx0XHRyZXR1cm4gW107IC8vIE5vIHNldHBvaW50XHJcblx0ZGVmYXVsdDpcclxuXHRcdHRocm93IG5ldyBFcnJvcihcIk5vdCBoYW5kbGVkXCIpO1xyXG5cdH1cclxuXHRyZXR1cm4gW107XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgc2V0cG9pbnRcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVNldHBvaW50UmVhZChtb2RlKSB7XHJcblx0c3dpdGNoIChtb2RlKSB7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5Wb2x0YWdlU2V0cG9pbnQpOyAvLyBtViBvciBWIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQ3VycmVudFNldHBvaW50KTsgLy8gQSBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuUlREVGVtcGVyYXR1cmVTZXRwb2ludCk7IC8vIMKwQyBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQpOyAvLyDCsEMgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSk7IC8vIEZyZXF1ZW5jeSBzZXRwb2ludCAoVElDS1MpXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuTG9hZENlbGxTZXRwb2ludCk7IC8vIG1WL1Ygc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuXHRcdHJldHVybiBudWxsO1xyXG5cdH1cclxuXHR0aHJvdyBuZXcgRXJyb3IoXCJOb3QgaGFuZGxlZFwiKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgYW5zd2VyIGFib3V0IFNldHBvaW50UmVhZFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZWdpc3RlcnMgRkMzIHBhcnNlZCBhbnN3ZXJcclxuICogQHJldHVybnMge251bWJlcn0gdGhlIGxhc3Qgc2V0cG9pbnRcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlU2V0cG9pbnRSZWFkKGJ1ZmZlciwgbW9kZSkge1xyXG5cdC8vIFJvdW5kIHRvIHR3byBkaWdpdHNcclxuXHR2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0dmFyIHJvdW5kZWQgPSBNYXRoLnJvdW5kKG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZWdpc3RlcnMsIDApICogMTAwKSAvIDEwMDtcclxuXHJcblx0c3dpdGNoIChtb2RlKSB7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiQ3VycmVudFwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHJvdW5kZWQsXHJcblx0XHRcdFwiVW5pdFwiOiBcIm1BXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiByb3VuZGVkLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJWXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogcm91bmRlZCxcclxuXHRcdFx0XCJVbml0XCI6IFwibVZcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkltYmFsYW5jZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHJvdW5kZWQsXHJcblx0XHRcdFwiVW5pdFwiOiBcIm1WL1ZcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG5cdFx0dmFyIHRpY2sxID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVnaXN0ZXJzLCAwKTtcclxuXHRcdHZhciB0aWNrMiA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlZ2lzdGVycywgNCk7XHJcblx0XHR2YXIgZk9OID0gMC4wO1xyXG5cdFx0dmFyIGZPRkYgPSAwLjA7XHJcblx0XHRpZiAodGljazEgIT0gMClcclxuXHRcdFx0Zk9OID0gTWF0aC5yb3VuZCgxIC8gKHRpY2sxICogMiAvIDIwMDAwLjApICogMTAuMCkgLyAxMDsgLy8gTmVlZCBvbmUgZGVjaW1hbCBwbGFjZSBmb3IgSFpcclxuXHRcdGlmICh0aWNrMiAhPSAwKVxyXG5cdFx0XHRmT0ZGID0gTWF0aC5yb3VuZCgxIC8gKHRpY2syICogMiAvIDIwMDAwLjApICogMTAuMCkgLyAxMDsgLy8gTmVlZCBvbmUgZGVjaW1hbCBwbGFjZSBmb3IgSFpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3kgT05cIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBmT04sXHJcblx0XHRcdFwiVW5pdFwiOiBcIkh6XCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3kgT0ZGXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VmFsdWVcIjogZk9GRixcclxuXHRcdFx0XCJTZWNvbmRhcnlVbml0XCI6IFwiSHpcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlRlbXBlcmF0dXJlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogcm91bmRlZCxcclxuXHRcdFx0XCJVbml0XCI6IFwiwrBDXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRkZWZhdWx0OlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlVua25vd25cIixcclxuXHRcdFx0XCJWYWx1ZVwiOiByb3VuZGVkLFxyXG5cdFx0XHRcIlVuaXRcIjogXCI/XCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHR9XHJcblxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtcclxuXHRNU0NSZWdpc3RlcnMsIG1ha2VTZXJpYWxOdW1iZXIsIG1ha2VDdXJyZW50TW9kZSwgbWFrZUJhdHRlcnlMZXZlbCwgcGFyc2VCYXR0ZXJ5LCBwYXJzZVNlcmlhbE51bWJlcixcclxuXHRwYXJzZUN1cnJlbnRNb2RlLCBtYWtlTW9kZVJlcXVlc3QsIG1ha2VNZWFzdXJlUmVxdWVzdCwgcGFyc2VNZWFzdXJlLCBtYWtlUXVhbGl0eUJpdFJlcXVlc3QsIGlzUXVhbGl0eVZhbGlkLFxyXG5cdG1ha2VHZW5TdGF0dXNSZWFkLCBwYXJzZUdlblN0YXR1cywgbWFrZVNldHBvaW50UmVxdWVzdCwgbWFrZVNldHBvaW50UmVhZCwgcGFyc2VTZXRwb2ludFJlYWRcclxufTsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcblxyXG5sZXQgc2xlZXAgPSBtcyA9PiBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxubGV0IHdhaXRGb3IgPSBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yKGYpIHtcclxuXHR3aGlsZSAoIWYoKSkgYXdhaXQgc2xlZXAoMTAwICsgTWF0aC5yYW5kb20oKSAqIDI1KTtcclxuXHRyZXR1cm4gZigpO1xyXG59O1xyXG5cclxubGV0IHdhaXRGb3JUaW1lb3V0ID0gYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihmLCB0aW1lb3V0U2VjKSB7XHJcblx0dmFyIHRvdGFsVGltZU1zID0gMDtcclxuXHR3aGlsZSAoIWYoKSAmJiB0b3RhbFRpbWVNcyA8IHRpbWVvdXRTZWMgKiAxMDAwKSB7XHJcblx0XHR2YXIgZGVsYXlNcyA9IDEwMCArIE1hdGgucmFuZG9tKCkgKiAyNTtcclxuXHRcdHRvdGFsVGltZU1zICs9IGRlbGF5TXM7XHJcblx0XHRhd2FpdCBzbGVlcChkZWxheU1zKTtcclxuXHR9XHJcblx0cmV0dXJuIGYoKTtcclxufTtcclxuXHJcbi8vIFRoZXNlIGZ1bmN0aW9ucyBtdXN0IGV4aXN0IHN0YW5kLWFsb25lIG91dHNpZGUgQ29tbWFuZCBvYmplY3QgYXMgdGhpcyBvYmplY3QgbWF5IGNvbWUgZnJvbSBKU09OIHdpdGhvdXQgdGhlbSFcclxuZnVuY3Rpb24gaXNHZW5lcmF0aW9uKGN0eXBlKSB7XHJcblx0cmV0dXJuIChjdHlwZSA+IENvbW1hbmRUeXBlLk9GRiAmJiBjdHlwZSA8IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCk7XHJcbn1cclxuZnVuY3Rpb24gaXNNZWFzdXJlbWVudChjdHlwZSkge1xyXG5cdHJldHVybiAoY3R5cGUgPiBDb21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgY3R5cGUgPCBDb21tYW5kVHlwZS5SRVNFUlZFRCB8fCBjdHlwZSA9PSBDb21tYW5kVHlwZS5Db250aW51aXR5KTtcclxufVxyXG5mdW5jdGlvbiBpc1NldHRpbmcoY3R5cGUpIHtcclxuXHRyZXR1cm4gKGN0eXBlID09IENvbW1hbmRUeXBlLk9GRiB8fCBjdHlwZSA+IENvbW1hbmRUeXBlLlNFVFRJTkdfUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzVmFsaWQoY3R5cGUpIHtcclxuXHRyZXR1cm4gKGlzTWVhc3VyZW1lbnQoY3R5cGUpIHx8IGlzR2VuZXJhdGlvbihjdHlwZSkgfHwgaXNTZXR0aW5nKGN0eXBlKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gY29udmVydCBhIHZhbHVlIGludG8gYW4gZW51bSB2YWx1ZVxyXG4gKiBcclxuICogQHBhcmFtIHt0eXBlfSBlbnVtdHlwZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gZW51bXZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBQYXJzZShlbnVtdHlwZSwgZW51bXZhbHVlKSB7XHJcblx0Zm9yICh2YXIgZW51bU5hbWUgaW4gZW51bXR5cGUpIHtcclxuXHRcdGlmIChlbnVtdHlwZVtlbnVtTmFtZV0gPT0gZW51bXZhbHVlKSB7XHJcblx0XHRcdHJldHVybiBlbnVtdHlwZVtlbnVtTmFtZV07XHJcblx0XHR9XHJcblx0fVxyXG5cdHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogSGVscGVyIGZ1bmN0aW9uIHRvIGR1bXAgYXJyYXlidWZmZXIgYXMgaGV4IHN0cmluZ1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGJ1ZjJoZXgoYnVmZmVyKSB7IC8vIGJ1ZmZlciBpcyBhbiBBcnJheUJ1ZmZlclxyXG5cdHJldHVybiBbLi4ubmV3IFVpbnQ4QXJyYXkoYnVmZmVyKV1cclxuXHRcdC5tYXAoeCA9PiB4LnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpXHJcblx0XHQuam9pbihcIiBcIik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhleDJidWYoaW5wdXQpIHtcclxuXHRpZiAodHlwZW9mIGlucHV0ICE9PSBcInN0cmluZ1wiKSB7XHJcblx0XHR0aHJvdyBuZXcgVHlwZUVycm9yKFwiRXhwZWN0ZWQgaW5wdXQgdG8gYmUgYSBzdHJpbmdcIik7XHJcblx0fVxyXG5cdHZhciBoZXhzdHIgPSBpbnB1dC5yZXBsYWNlKC9cXHMrL2csIFwiXCIpO1xyXG5cdGlmICgoaGV4c3RyLmxlbmd0aCAlIDIpICE9PSAwKSB7XHJcblx0XHR0aHJvdyBuZXcgUmFuZ2VFcnJvcihcIkV4cGVjdGVkIHN0cmluZyB0byBiZSBhbiBldmVuIG51bWJlciBvZiBjaGFyYWN0ZXJzXCIpO1xyXG5cdH1cclxuXHJcblx0Y29uc3QgdmlldyA9IG5ldyBVaW50OEFycmF5KGhleHN0ci5sZW5ndGggLyAyKTtcclxuXHJcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBoZXhzdHIubGVuZ3RoOyBpICs9IDIpIHtcclxuXHRcdHZpZXdbaSAvIDJdID0gcGFyc2VJbnQoaGV4c3RyLnN1YnN0cmluZyhpLCBpICsgMiksIDE2KTtcclxuXHR9XHJcblxyXG5cdHJldHVybiB2aWV3LmJ1ZmZlcjtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IHNsZWVwLCB3YWl0Rm9yLCB3YWl0Rm9yVGltZW91dCwgaXNHZW5lcmF0aW9uLCBpc01lYXN1cmVtZW50LCBpc1NldHRpbmcsIGlzVmFsaWQsIFBhcnNlLCBidWYyaGV4LCBoZXgyYnVmIH07Il19
