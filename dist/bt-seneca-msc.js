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

		// Refresh battery status regularly (every 10 refresh cycles to avoid excessive communication)
		if (!btState.batteryRefreshCounter) {
			btState.batteryRefreshCounter = 0;
		}
		btState.batteryRefreshCounter++;

		if (btState.batteryRefreshCounter >= 10) {
			btState.meter.battery = await senecaMSC.getBatteryVoltage();
			log.debug("\t\tBattery refreshed: " + btState.meter.battery + "V");
			btState.batteryRefreshCounter = 0;
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

		// battery refresh counter for regular battery status updates
		this.batteryRefreshCounter = 0;

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
			"lastResponseTime": "",
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

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY2xhc3Nlcy9TZW5lY2FNU0MuanMiLCJjb25zdGFudHMuanMiLCJtZXRlckFwaS5qcyIsIm1ldGVyUHVibGljQVBJLmpzIiwibW9kYnVzUnR1LmpzIiwibW9kYnVzVGVzdERhdGEuanMiLCJub2RlX21vZHVsZXMvbG9nbGV2ZWwvbGliL2xvZ2xldmVsLmpzIiwic2VuZWNhTW9kYnVzLmpzIiwidXRpbHMuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3cEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0dBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZSQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4UUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbGpGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyV0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL3FCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKXtmdW5jdGlvbiByKGUsbix0KXtmdW5jdGlvbiBvKGksZil7aWYoIW5baV0pe2lmKCFlW2ldKXt2YXIgYz1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlO2lmKCFmJiZjKXJldHVybiBjKGksITApO2lmKHUpcmV0dXJuIHUoaSwhMCk7dmFyIGE9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitpK1wiJ1wiKTt0aHJvdyBhLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsYX12YXIgcD1uW2ldPXtleHBvcnRzOnt9fTtlW2ldWzBdLmNhbGwocC5leHBvcnRzLGZ1bmN0aW9uKHIpe3ZhciBuPWVbaV1bMV1bcl07cmV0dXJuIG8obnx8cil9LHAscC5leHBvcnRzLHIsZSxuLHQpfXJldHVybiBuW2ldLmV4cG9ydHN9Zm9yKHZhciB1PVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmUsaT0wO2k8dC5sZW5ndGg7aSsrKW8odFtpXSk7cmV0dXJuIG99cmV0dXJuIHJ9KSgpIiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG4vKipcclxuICogIEJsdWV0b290aCBoYW5kbGluZyBtb2R1bGUsIGluY2x1ZGluZyBtYWluIHN0YXRlIG1hY2hpbmUgbG9vcC5cclxuICogIFRoaXMgbW9kdWxlIGludGVyYWN0cyB3aXRoIGJyb3dzZXIgZm9yIGJsdWV0b290aCBjb211bmljYXRpb25zIGFuZCBwYWlyaW5nLCBhbmQgd2l0aCBTZW5lY2FNU0Mgb2JqZWN0LlxyXG4gKi9cclxuXHJcbnZhciBBUElTdGF0ZSA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvQVBJU3RhdGVcIik7XHJcbnZhciBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuL3V0aWxzXCIpO1xyXG52YXIgc2VuZWNhTW9kdWxlID0gcmVxdWlyZShcIi4vY2xhc3Nlcy9TZW5lY2FNU0NcIik7XHJcbnZhciBtb2RidXMgPSByZXF1aXJlKFwiLi9tb2RidXNSdHVcIik7XHJcbnZhciB0ZXN0RGF0YSA9IHJlcXVpcmUoXCIuL21vZGJ1c1Rlc3REYXRhXCIpO1xyXG5cclxudmFyIGJ0U3RhdGUgPSBBUElTdGF0ZS5idFN0YXRlO1xyXG52YXIgU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxudmFyIFJlc3VsdENvZGUgPSBjb25zdGFudHMuUmVzdWx0Q29kZTtcclxudmFyIHNpbXVsYXRpb24gPSBmYWxzZTtcclxudmFyIGxvZ2dpbmcgPSBmYWxzZTtcclxuLypcclxuICogQmx1ZXRvb3RoIGNvbnN0YW50c1xyXG4gKi9cclxuY29uc3QgQmx1ZVRvb3RoTVNDID0ge1xyXG5cdFNlcnZpY2VVdWlkOiBcIjAwMDNjZGQwLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMVwiLCAvLyBibHVldG9vdGggbW9kYnVzIFJUVSBzZXJ2aWNlIGZvciBTZW5lY2EgTVNDXHJcblx0TW9kYnVzQW5zd2VyVXVpZDogXCIwMDAzY2RkMS0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzFcIiwgICAgIC8vIG1vZGJ1cyBSVFUgYW5zd2Vyc1xyXG5cdE1vZGJ1c1JlcXVlc3RVdWlkOiBcIjAwMDNjZGQyLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMVwiICAgIC8vIG1vZGJ1cyBSVFUgcmVxdWVzdHNcclxufTtcclxuXHJcblxyXG4vKipcclxuICogU2VuZCB0aGUgbWVzc2FnZSB1c2luZyBCbHVldG9vdGggYW5kIHdhaXQgZm9yIGFuIGFuc3dlclxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBjb21tYW5kIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHNlbmRcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSB0aGUgbW9kYnVzIFJUVSBhbnN3ZXJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIFNlbmRBbmRSZXNwb25zZShjb21tYW5kKSB7XHJcblxyXG5cdGlmIChjb21tYW5kID09IG51bGwpXHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHJcblx0bG9nLmRlYnVnKFwiPj4gXCIgKyB1dGlscy5idWYyaGV4KGNvbW1hbmQpKTtcclxuXHJcblx0YnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcblx0YnRTdGF0ZS5zdGF0c1tcInJlcXVlc3RzXCJdKys7XHJcblxyXG5cdHZhciBzdGFydFRpbWUgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcclxuXHRpZiAoc2ltdWxhdGlvbikge1xyXG5cdFx0YnRTdGF0ZS5yZXNwb25zZSA9IGZha2VSZXNwb25zZShjb21tYW5kKTtcclxuXHRcdGF3YWl0IHV0aWxzLnNsZWVwKDUpO1xyXG5cdH1cclxuXHRlbHNlIHtcclxuXHRcdGF3YWl0IGJ0U3RhdGUuY2hhcldyaXRlLndyaXRlVmFsdWVXaXRob3V0UmVzcG9uc2UoY29tbWFuZCk7XHJcblx0XHR3aGlsZSAoYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkcgfHxcclxuXHRcdFx0YnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5CVVNZKSB7XHJcblx0XHRcdGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIGJyZWFrO1xyXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzUpKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdHZhciBlbmRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblxyXG5cdHZhciBhbnN3ZXIgPSBidFN0YXRlLnJlc3BvbnNlPy5zbGljZSgpO1xyXG5cdGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cclxuXHQvLyBMb2cgdGhlIHBhY2tldHNcclxuXHRpZiAobG9nZ2luZykge1xyXG5cdFx0dmFyIHBhY2tldCA9IHsgXCJyZXF1ZXN0XCI6IHV0aWxzLmJ1ZjJoZXgoY29tbWFuZCksIFwiYW5zd2VyXCI6IHV0aWxzLmJ1ZjJoZXgoYW5zd2VyKSB9O1xyXG5cdFx0dmFyIHBhY2tldHMgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJNb2RidXNSVFV0cmFjZVwiKTtcclxuXHRcdGlmIChwYWNrZXRzID09IG51bGwpIHtcclxuXHRcdFx0cGFja2V0cyA9IFtdOyAvLyBpbml0aWFsaXplIGFycmF5XHJcblx0XHR9XHJcblx0XHRlbHNlIHtcclxuXHRcdFx0cGFja2V0cyA9IEpTT04ucGFyc2UocGFja2V0cyk7IC8vIFJlc3RvcmUgdGhlIGpzb24gcGVyc2lzdGVkIG9iamVjdFxyXG5cdFx0fVxyXG5cdFx0cGFja2V0cy5wdXNoKHBhY2tldCk7IC8vIEFkZCB0aGUgbmV3IG9iamVjdFxyXG5cdFx0d2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKFwiTW9kYnVzUlRVdHJhY2VcIiwgSlNPTi5zdHJpbmdpZnkocGFja2V0cykpO1xyXG5cdH1cclxuXHJcblx0YnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlVGltZVwiXSA9IE1hdGgucm91bmQoKDEuMCAqIGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZVRpbWVcIl0gKiAoYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSAlIDUwMCkgKyAoZW5kVGltZSAtIHN0YXJ0VGltZSkpIC8gKChidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VzXCJdICUgNTAwKSArIDEpKTtcclxuXHRidFN0YXRlLnN0YXRzW1wibGFzdFJlc3BvbnNlVGltZVwiXSA9IE1hdGgucm91bmQoZW5kVGltZSAtIHN0YXJ0VGltZSkgKyBcIiBtc1wiO1xyXG5cdGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0rKztcclxuXHJcblx0cmV0dXJuIGFuc3dlcjtcclxufVxyXG5cclxubGV0IHNlbmVjYU1TQyA9IG5ldyBzZW5lY2FNb2R1bGUuU2VuZWNhTVNDKFNlbmRBbmRSZXNwb25zZSk7XHJcblxyXG4vKipcclxuICogTWFpbiBsb29wIG9mIHRoZSBtZXRlciBoYW5kbGVyLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBzdGF0ZU1hY2hpbmUoKSB7XHJcblx0dmFyIG5leHRBY3Rpb247XHJcblx0dmFyIERFTEFZX01TID0gKHNpbXVsYXRpb24gPyAyMCA6IDc1MCk7IC8vIFVwZGF0ZSB0aGUgc3RhdHVzIGV2ZXJ5IFggbXMuXHJcblx0dmFyIFRJTUVPVVRfTVMgPSAoc2ltdWxhdGlvbiA/IDEwMDAgOiAzMDAwMCk7IC8vIEdpdmUgdXAgc29tZSBvcGVyYXRpb25zIGFmdGVyIFggbXMuXHJcblx0YnRTdGF0ZS5zdGFydGVkID0gdHJ1ZTtcclxuXHJcblx0bG9nLmRlYnVnKFwiQ3VycmVudCBzdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG5cclxuXHQvLyBDb25zZWN1dGl2ZSBzdGF0ZSBjb3VudGVkLiBDYW4gYmUgdXNlZCB0byB0aW1lb3V0LlxyXG5cdGlmIChidFN0YXRlLnN0YXRlID09IGJ0U3RhdGUucHJldl9zdGF0ZSkge1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZV9jcHQrKztcclxuXHR9IGVsc2Uge1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG5cdH1cclxuXHJcblx0Ly8gU3RvcCByZXF1ZXN0IGZyb20gQVBJXHJcblx0aWYgKGJ0U3RhdGUuc3RvcFJlcXVlc3QpIHtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUElORztcclxuXHR9XHJcblxyXG5cdGxvZy5kZWJ1ZyhcIlN0YXRlOlwiICsgYnRTdGF0ZS5zdGF0ZSk7XHJcblx0c3dpdGNoIChidFN0YXRlLnN0YXRlKSB7XHJcblx0XHRjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6IC8vIGluaXRpYWwgc3RhdGUgb24gU3RhcnQoKVxyXG5cdFx0XHRpZiAoc2ltdWxhdGlvbikge1xyXG5cdFx0XHRcdG5leHRBY3Rpb24gPSBmYWtlUGFpckRldmljZTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRuZXh0QWN0aW9uID0gYnRQYWlyRGV2aWNlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBTdGF0ZS5DT05ORUNUSU5HOiAvLyB3YWl0aW5nIGZvciBjb25uZWN0aW9uIHRvIGNvbXBsZXRlXHJcblx0XHRcdG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOiAvLyBjb25uZWN0aW9uIGNvbXBsZXRlLCBhY3F1aXJlIG1ldGVyIHN0YXRlXHJcblx0XHRcdGlmIChzaW11bGF0aW9uKSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGZha2VTdWJzY3JpYmU7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBTdGF0ZS5TVUJTQ1JJQklORzogLy8gd2FpdGluZyBmb3IgQmx1ZXRvb3RoIGludGVyZmFjZXNcclxuXHRcdFx0bmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuXHRcdFx0aWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gTWF0aC5mbG9vcihUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcblx0XHRcdFx0Ly8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcblx0XHRcdFx0bG9nLndhcm4oXCJUaW1lb3V0IGluIFNVQlNDUklCSU5HXCIpO1xyXG5cdFx0XHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0XHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHRcdFx0fVxyXG5cdFx0XHRicmVhaztcclxuXHRcdGNhc2UgU3RhdGUuTUVURVJfSU5JVDogLy8gcmVhZHkgdG8gY29tbXVuaWNhdGUsIGFjcXVpcmUgbWV0ZXIgc3RhdHVzXHJcblx0XHRcdG5leHRBY3Rpb24gPSBtZXRlckluaXQ7XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc6IC8vIHJlYWRpbmcgdGhlIG1ldGVyIHN0YXR1c1xyXG5cdFx0XHRpZiAoYnRTdGF0ZS5zdGF0ZV9jcHQgPiBNYXRoLmZsb29yKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuXHRcdFx0XHRsb2cud2FybihcIlRpbWVvdXQgaW4gTUVURVJfSU5JVElBTElaSU5HXCIpO1xyXG5cdFx0XHRcdC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG5cdFx0XHRcdGlmIChzaW11bGF0aW9uKSB7XHJcblx0XHRcdFx0XHRuZXh0QWN0aW9uID0gZmFrZVN1YnNjcmliZTtcclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0bmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcblx0XHRcdH1cclxuXHRcdFx0bmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuXHRcdFx0YnJlYWs7XHJcblx0XHRjYXNlIFN0YXRlLklETEU6IC8vIHJlYWR5IHRvIHByb2Nlc3MgY29tbWFuZHMgZnJvbSBBUElcclxuXHRcdFx0aWYgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsKVxyXG5cdFx0XHRcdG5leHRBY3Rpb24gPSBwcm9jZXNzQ29tbWFuZDtcclxuXHRcdFx0ZWxzZSB7XHJcblx0XHRcdFx0bmV4dEFjdGlvbiA9IHJlZnJlc2g7XHJcblx0XHRcdH1cclxuXHRcdFx0YnJlYWs7XHJcblx0XHRjYXNlIFN0YXRlLkVSUk9SOiAvLyBhbnl0aW1lIGFuIGVycm9yIGhhcHBlbnNcclxuXHRcdFx0bmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBTdGF0ZS5CVVNZOiAvLyB3aGlsZSBhIGNvbW1hbmQgaW4gZ29pbmcgb25cclxuXHRcdFx0aWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gTWF0aC5mbG9vcihUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcblx0XHRcdFx0bG9nLndhcm4oXCJUaW1lb3V0IGluIEJVU1lcIik7XHJcblx0XHRcdFx0Ly8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcblx0XHRcdFx0aWYgKHNpbXVsYXRpb24pIHtcclxuXHRcdFx0XHRcdG5leHRBY3Rpb24gPSBmYWtlU3Vic2NyaWJlO1xyXG5cdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuXHRcdFx0fVxyXG5cdFx0XHRuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG5cdFx0XHRicmVhaztcclxuXHRcdGNhc2UgU3RhdGUuU1RPUFBJTkc6XHJcblx0XHRcdG5leHRBY3Rpb24gPSBkaXNjb25uZWN0O1xyXG5cdFx0XHRicmVhaztcclxuXHRcdGNhc2UgU3RhdGUuU1RPUFBFRDogLy8gYWZ0ZXIgYSBkaXNjb25uZWN0b3Igb3IgU3RvcCgpIHJlcXVlc3QsIHN0b3BzIHRoZSBzdGF0ZSBtYWNoaW5lLlxyXG5cdFx0XHRuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG5cdFx0XHRicmVhaztcclxuXHRcdGRlZmF1bHQ6XHJcblx0XHRcdGJyZWFrO1xyXG5cdH1cclxuXHJcblx0YnRTdGF0ZS5wcmV2X3N0YXRlID0gYnRTdGF0ZS5zdGF0ZTtcclxuXHJcblx0aWYgKG5leHRBY3Rpb24gIT0gdW5kZWZpbmVkKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRFeGVjdXRpbmc6XCIgKyBuZXh0QWN0aW9uLm5hbWUpO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgbmV4dEFjdGlvbigpO1xyXG5cdFx0fVxyXG5cdFx0Y2F0Y2ggKGUpIHtcclxuXHRcdFx0bG9nLmVycm9yKFwiRXhjZXB0aW9uIGluIHN0YXRlIG1hY2hpbmVcIiwgZSk7XHJcblx0XHR9XHJcblx0fVxyXG5cdGlmIChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQpIHtcclxuXHRcdHV0aWxzLnNsZWVwKERFTEFZX01TKS50aGVuKCgpID0+IHN0YXRlTWFjaGluZSgpKS5jYXRjaCgoZXJyKSA9PiB7XHJcblx0XHRcdGxvZy5lcnJvcihcIlN0YXRlIG1hY2hpbmUgZXJyb3I6XCIsIGVycik7XHJcblx0XHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuXHRcdH0pOyAvLyBSZWNoZWNrIHN0YXR1cyBpbiBERUxBWV9NUyBtc1xyXG5cdH1cclxuXHRlbHNlIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFRlcm1pbmF0aW5nIFN0YXRlIG1hY2hpbmVcIik7XHJcblx0XHRidFN0YXRlLnN0YXJ0ZWQgPSBmYWxzZTtcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDYWxsZWQgZnJvbSBzdGF0ZSBtYWNoaW5lIHRvIGV4ZWN1dGUgYSBzaW5nbGUgY29tbWFuZCBmcm9tIGJ0U3RhdGUuY29tbWFuZCBwcm9wZXJ0eVxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZCgpIHtcclxuXHR0cnkge1xyXG5cdFx0dmFyIGNvbW1hbmQgPSBidFN0YXRlLmNvbW1hbmQ7XHJcblx0XHR2YXIgcmVzdWx0ID0gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cclxuXHRcdGlmIChjb21tYW5kID09IG51bGwpIHtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkJVU1k7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wiY29tbWFuZHNcIl0rKztcclxuXHJcblx0XHRsb2cuaW5mbyhcIlxcdFxcdEV4ZWN1dGluZyBjb21tYW5kIDpcIiArIGNvbW1hbmQpO1xyXG5cclxuXHRcdC8vIEZpcnN0IHNldCBOT05FIGJlY2F1c2Ugd2UgZG9uJ3Qgd2FudCB0byB3cml0ZSBuZXcgc2V0cG9pbnRzIHdpdGggYWN0aXZlIGdlbmVyYXRpb25cclxuXHRcdHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy5zd2l0Y2hPZmYoKTtcclxuXHRcdGlmIChyZXN1bHQgIT0gUmVzdWx0Q29kZS5TVUNDRVNTKSB7XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBzd2l0Y2ggbWV0ZXIgb2ZmIGJlZm9yZSBjb21tYW5kIHdyaXRlIVwiKTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBOb3cgd3JpdGUgdGhlIHNldHBvaW50IG9yIHNldHRpbmdcclxuXHRcdGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSB7XHJcblx0XHRcdHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy53cml0ZVNldHBvaW50cyhjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuXHRcdFx0aWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJGYWlsdXJlIHRvIHdyaXRlIHNldHBvaW50cyFcIik7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHJcblx0XHRpZiAoIXV0aWxzLmlzU2V0dGluZyhjb21tYW5kLnR5cGUpICYmXHJcblx0XHRcdHV0aWxzLmlzVmFsaWQoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSAgLy8gSUYgdGhpcyBpcyBhIHNldHRpbmcsIHdlJ3JlIGRvbmUuXHJcblx0XHR7XHJcblx0XHRcdC8vIE5vdyB3cml0ZSB0aGUgbW9kZSBzZXRcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgc2VuZWNhTVNDLmNoYW5nZU1vZGUoY29tbWFuZC50eXBlKTtcclxuXHRcdFx0aWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJGYWlsdXJlIHRvIGNoYW5nZSBtZXRlciBtb2RlIVwiKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cclxuXHRcdC8vIENhbGxlciBleHBlY3RzIGEgdmFsaWQgcHJvcGVydHkgaW4gR2V0U3RhdGUoKSBvbmNlIGNvbW1hbmQgaXMgZXhlY3V0ZWQuXHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcblx0XHRhd2FpdCByZWZyZXNoKCk7XHJcblxyXG5cdFx0Y29tbWFuZC5lcnJvciA9IGZhbHNlO1xyXG5cdFx0Y29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcblx0XHRidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0Q29tcGxldGVkIGNvbW1hbmQgZXhlY3V0ZWRcIik7XHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy5lcnJvcihcIioqIGVycm9yIHdoaWxlIGV4ZWN1dGluZyBjb21tYW5kOiBcIiArIGVycik7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcblx0XHRpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG5cdFx0XHRidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG5cdFx0cmV0dXJuO1xyXG5cdH1cclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0RXhwZWN0ZWRTdGF0ZUhleCgpIHtcclxuXHQvLyBTaW11bGF0ZSBjdXJyZW50IG1vZGUgYW5zd2VyIGFjY29yZGluZyB0byBsYXN0IGNvbW1hbmQuXHJcblx0dmFyIHN0YXRlSGV4ID0gKENvbW1hbmRUeXBlLk9GRikudG9TdHJpbmcoMTYpO1xyXG5cdGlmIChidFN0YXRlLmNvbW1hbmQ/LnR5cGUgIT0gbnVsbCkge1xyXG5cdFx0c3RhdGVIZXggPSAoYnRTdGF0ZS5jb21tYW5kLnR5cGUpLnRvU3RyaW5nKDE2KTtcclxuXHR9XHJcblx0Ly8gQWRkIHRyYWlsaW5nIDBcclxuXHR3aGlsZSAoc3RhdGVIZXgubGVuZ3RoIDwgMilcclxuXHRcdHN0YXRlSGV4ID0gXCIwXCIgKyBzdGF0ZUhleDtcclxuXHRyZXR1cm4gc3RhdGVIZXg7XHJcbn1cclxuLyoqXHJcbiAqIFVzZWQgdG8gc2ltdWxhdGUgUlRVIGFuc3dlcnNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gY29tbWFuZCByZWFsIHJlcXVlc3RcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBmYWtlIGFuc3dlclxyXG4gKi9cclxuZnVuY3Rpb24gZmFrZVJlc3BvbnNlKGNvbW1hbmQpIHtcclxuXHR2YXIgY29tbWFuZEhleCA9IHV0aWxzLmJ1ZjJoZXgoY29tbWFuZCk7XHJcblx0dmFyIGZvcmdlZEFuc3dlcnMgPSB7XHJcblx0XHRcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCI6IFwiMTkgMDMgMDIgMDBcIiArIGdldEV4cGVjdGVkU3RhdGVIZXgoKSArIFwiICQkJCRcIiwgLy8gQ3VycmVudCBzdGF0ZVxyXG5cdFx0XCJkZWZhdWx0IDAzXCI6IFwiMTkgMDMgMDYgMDAwMSAwMDAxIDAwMDEgJCQkJFwiLCAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMzXHJcblx0XHRcImRlZmF1bHQgMTBcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwMDAxIDAwMDEgJCQkJFwiXHJcblx0fTsgLy8gZGVmYXVsdCBhbnN3ZXIgZm9yIEZDMTBcclxuXHJcblx0Ly8gU3RhcnQgd2l0aCB0aGUgZGVmYXVsdCBhbnN3ZXJcclxuXHR2YXIgcmVzcG9uc2VIZXggPSBmb3JnZWRBbnN3ZXJzW1wiZGVmYXVsdCBcIiArIGNvbW1hbmRIZXguc3BsaXQoXCIgXCIpWzFdXTtcclxuXHJcblx0Ly8gRG8gd2UgaGF2ZSBhIGZvcmdlZCBhbnN3ZXI/XHJcblx0aWYgKGZvcmdlZEFuc3dlcnNbY29tbWFuZEhleF0gIT0gdW5kZWZpbmVkKSB7XHJcblx0XHRyZXNwb25zZUhleCA9IGZvcmdlZEFuc3dlcnNbY29tbWFuZEhleF07XHJcblx0fVxyXG5cdGVsc2Uge1xyXG5cdFx0Ly8gTG9vayBpbnRvIHJlZ2lzdGVyZWQgdHJhY2VzXHJcblx0XHR2YXIgZm91bmQgPSBbXTtcclxuXHRcdGZvciAoY29uc3QgdHJhY2Ugb2YgdGVzdERhdGEudGVzdFRyYWNlcykge1xyXG5cdFx0XHRpZiAodHJhY2VbXCJyZXF1ZXN0XCJdID09PSBjb21tYW5kSGV4KSB7XHJcblx0XHRcdFx0Zm91bmQucHVzaCh0cmFjZVtcImFuc3dlclwiXSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdGlmIChmb3VuZC5sZW5ndGggPiAwKSB7XHJcblx0XHRcdC8vIFNlbGVjdCBhIHJhbmRvbSBhbnN3ZXIgZnJvbSB0aGUgcmVnaXN0ZXJlZCB0cmFjZVxyXG5cdFx0XHRyZXNwb25zZUhleCA9IGZvdW5kW01hdGguZmxvb3IoKE1hdGgucmFuZG9tKCkgKiBmb3VuZC5sZW5ndGgpKV07XHJcblx0XHR9XHJcblx0XHRlbHNlIHtcclxuXHRcdFx0Y29uc29sZS5pbmZvKGNvbW1hbmRIZXggKyBcIiBub3QgZm91bmQgaW4gdGVzdCB0cmFjZXNcIik7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHQvLyBDb21wdXRlIENSQyBpZiBuZWVkZWRcclxuXHRpZiAocmVzcG9uc2VIZXguaW5jbHVkZXMoXCIkJCQkXCIpKSB7XHJcblx0XHRyZXNwb25zZUhleCA9IHJlc3BvbnNlSGV4LnJlcGxhY2UoXCIkJCQkXCIsIFwiXCIpO1xyXG5cdFx0dmFyIGNyYyA9IG1vZGJ1cy5jcmMxNihuZXcgVWludDhBcnJheSh1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KSkpLnRvU3RyaW5nKDE2KTtcclxuXHRcdHdoaWxlIChjcmMubGVuZ3RoIDwgNClcclxuXHRcdFx0Y3JjID0gXCIwXCIgKyBjcmM7XHJcblx0XHRyZXNwb25zZUhleCA9IHJlc3BvbnNlSGV4ICsgY3JjLnN1YnN0cmluZygyLCA0KSArIGNyYy5zdWJzdHJpbmcoMCwgMik7XHJcblx0fVxyXG5cclxuXHRsb2cuZGVidWcoXCI8PCBcIiArIHJlc3BvbnNlSGV4KTtcclxuXHRyZXR1cm4gdXRpbHMuaGV4MmJ1ZihyZXNwb25zZUhleCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBY3F1aXJlIHRoZSBjdXJyZW50IG1vZGUgYW5kIHNlcmlhbCBudW1iZXIgb2YgdGhlIGRldmljZS5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gbWV0ZXJJbml0KCkge1xyXG5cdHRyeSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVElBTElaSU5HO1xyXG5cdFx0YnRTdGF0ZS5tZXRlci5zZXJpYWwgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0U2VyaWFsTnVtYmVyKCk7XHJcblx0XHRsb2cuaW5mbyhcIlxcdFxcdFNlcmlhbCBudW1iZXI6XCIgKyBidFN0YXRlLm1ldGVyLnNlcmlhbCk7XHJcblxyXG5cdFx0YnRTdGF0ZS5tZXRlci5tb2RlID0gYXdhaXQgc2VuZWNhTVNDLmdldEN1cnJlbnRNb2RlKCk7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRDdXJyZW50IG1vZGU6XCIgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cclxuXHRcdGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSA9IGF3YWl0IHNlbmVjYU1TQy5nZXRCYXR0ZXJ5Vm9sdGFnZSgpO1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0QmF0dGVyeSAoVik6XCIgKyBidFN0YXRlLm1ldGVyLmJhdHRlcnkpO1xyXG5cclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cud2FybihcIkVycm9yIHdoaWxlIGluaXRpYWxpemluZyBtZXRlciA6XCIgKyBlcnIpO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0aWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuXHRcdFx0YnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbi8qXHJcbiAqIENsb3NlIHRoZSBibHVldG9vdGggaW50ZXJmYWNlICh1bnBhaXIpXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGRpc2Nvbm5lY3QoKSB7XHJcblx0YnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuXHR0cnkge1xyXG5cdFx0aWYgKGJ0U3RhdGUuYnREZXZpY2UgIT0gbnVsbCkge1xyXG5cdFx0XHRpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcblx0XHRcdFx0bG9nLndhcm4oXCIqIENhbGxpbmcgZGlzY29ubmVjdCBvbiBidGRldmljZVwiKTtcclxuXHRcdFx0XHQvLyBBdm9pZCB0aGUgZXZlbnQgZmlyaW5nIHdoaWNoIG1heSBsZWFkIHRvIGF1dG8tcmVjb25uZWN0XHJcblx0XHRcdFx0YnRTdGF0ZS5idERldmljZS5yZW1vdmVFdmVudExpc3RlbmVyKFwiZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZFwiLCBvbkRpc2Nvbm5lY3RlZCk7XHJcblx0XHRcdFx0YnRTdGF0ZS5idERldmljZS5nYXR0LmRpc2Nvbm5lY3QoKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG5cdH1cclxuXHRjYXRjaCB7IH1cclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBFRDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBicm93c2VyIEJUIGFwaSB3aGVuIHRoZSBkZXZpY2UgZGlzY29ubmVjdFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBvbkRpc2Nvbm5lY3RlZCgpIHtcclxuXHRsb2cud2FybihcIiogR0FUVCBTZXJ2ZXIgZGlzY29ubmVjdGVkIGV2ZW50LCB3aWxsIHRyeSB0byByZWNvbm5lY3QgKlwiKTtcclxuXHRidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcblx0YnRTdGF0ZS5zdGF0c1tcIkdBVFQgZGlzY29ubmVjdHNcIl0rKztcclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDsgLy8gVHJ5IHRvIGF1dG8tcmVjb25uZWN0IHRoZSBpbnRlcmZhY2VzIHdpdGhvdXQgcGFpcmluZ1xyXG59XHJcblxyXG4vKipcclxuICogSm9pbnMgdGhlIGFyZ3VtZW50cyBpbnRvIGEgc2luZ2xlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7QnVmZmVyfSBjb25jYXRlbmF0ZWQgYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBhcnJheUJ1ZmZlckNvbmNhdCgpIHtcclxuXHR2YXIgbGVuZ3RoID0gMDtcclxuXHR2YXIgYnVmZmVyID0gbnVsbDtcclxuXHJcblx0Zm9yICh2YXIgaSBpbiBhcmd1bWVudHMpIHtcclxuXHRcdGJ1ZmZlciA9IGFyZ3VtZW50c1tpXTtcclxuXHRcdGxlbmd0aCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuXHR9XHJcblxyXG5cdHZhciBqb2luZWQgPSBuZXcgVWludDhBcnJheShsZW5ndGgpO1xyXG5cdHZhciBvZmZzZXQgPSAwO1xyXG5cclxuXHRmb3IgKGkgaW4gYXJndW1lbnRzKSB7XHJcblx0XHRidWZmZXIgPSBhcmd1bWVudHNbaV07XHJcblx0XHRqb2luZWQuc2V0KG5ldyBVaW50OEFycmF5KGJ1ZmZlciksIG9mZnNldCk7XHJcblx0XHRvZmZzZXQgKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcblx0fVxyXG5cclxuXHRyZXR1cm4gam9pbmVkLmJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBibHVldG9vdGggY2hhcmFjdGVyaXN0aWNzIHdoZW4gcmVjZWl2aW5nIGRhdGFcclxuICogQHBhcmFtIHthbnl9IGV2ZW50XHJcbiAqL1xyXG5mdW5jdGlvbiBoYW5kbGVOb3RpZmljYXRpb25zKGV2ZW50KSB7XHJcblx0bGV0IHZhbHVlID0gZXZlbnQudGFyZ2V0LnZhbHVlO1xyXG5cdGlmICh2YWx1ZSAhPSBudWxsKSB7XHJcblx0XHRsb2cuZGVidWcoXCI8PCBcIiArIHV0aWxzLmJ1ZjJoZXgodmFsdWUuYnVmZmVyKSk7XHJcblx0XHRpZiAoYnRTdGF0ZS5yZXNwb25zZSAhPSBudWxsKSB7XHJcblx0XHRcdC8vIFByZXZlbnQgbWVtb3J5IGxlYWsgYnkgbGltaXRpbmcgbWF4aW11bSByZXNwb25zZSBidWZmZXIgc2l6ZVxyXG5cdFx0XHRjb25zdCBNQVhfUkVTUE9OU0VfU0laRSA9IDEwMjQ7IC8vIDFLQiBsaW1pdCBmb3IgbW9kYnVzIHJlc3BvbnNlc1xyXG5cdFx0XHRjb25zdCBuZXdTaXplID0gYnRTdGF0ZS5yZXNwb25zZS5ieXRlTGVuZ3RoICsgdmFsdWUuYnVmZmVyLmJ5dGVMZW5ndGg7XHJcblx0XHRcdGlmIChuZXdTaXplID4gTUFYX1JFU1BPTlNFX1NJWkUpIHtcclxuXHRcdFx0XHRsb2cud2FybihcIlJlc3BvbnNlIGJ1ZmZlciB0b28gbGFyZ2UsIHJlc2V0dGluZ1wiKTtcclxuXHRcdFx0XHRidFN0YXRlLnJlc3BvbnNlID0gdmFsdWUuYnVmZmVyLnNsaWNlKCk7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0YnRTdGF0ZS5yZXNwb25zZSA9IGFycmF5QnVmZmVyQ29uY2F0KGJ0U3RhdGUucmVzcG9uc2UsIHZhbHVlLmJ1ZmZlcik7XHJcblx0XHRcdH1cclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdGJ0U3RhdGUucmVzcG9uc2UgPSB2YWx1ZS5idWZmZXIuc2xpY2UoKTtcclxuXHRcdH1cclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUaGlzIGZ1bmN0aW9uIHdpbGwgc3VjY2VlZCBvbmx5IGlmIGNhbGxlZCBhcyBhIGNvbnNlcXVlbmNlIG9mIGEgdXNlci1nZXN0dXJlXHJcbiAqIEUuZy4gYnV0dG9uIGNsaWNrLiBUaGlzIGlzIGR1ZSB0byBCbHVlVG9vdGggQVBJIHNlY3VyaXR5IG1vZGVsLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBidFBhaXJEZXZpY2UoKSB7XHJcblx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcblx0dmFyIGZvcmNlU2VsZWN0aW9uID0gYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl07XHJcblx0bG9nLmRlYnVnKFwiYnRQYWlyRGV2aWNlKFwiICsgZm9yY2VTZWxlY3Rpb24gKyBcIilcIik7XHJcblx0dHJ5IHtcclxuXHRcdGlmICh0eXBlb2YgKG5hdmlnYXRvci5ibHVldG9vdGg/LmdldEF2YWlsYWJpbGl0eSkgPT0gXCJmdW5jdGlvblwiKSB7XHJcblx0XHRcdGNvbnN0IGF2YWlsYWJpbGl0eSA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0QXZhaWxhYmlsaXR5KCk7XHJcblx0XHRcdGlmICghYXZhaWxhYmlsaXR5KSB7XHJcblx0XHRcdFx0bG9nLmVycm9yKFwiQmx1ZXRvb3RoIG5vdCBhdmFpbGFibGUgaW4gYnJvd3Nlci5cIik7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQnJvd3NlciBkb2VzIG5vdCBwcm92aWRlIGJsdWV0b290aFwiKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0dmFyIGRldmljZSA9IG51bGw7XHJcblxyXG5cdFx0Ly8gRG8gd2UgYWxyZWFkeSBoYXZlIHBlcm1pc3Npb24/XHJcblx0XHRpZiAodHlwZW9mIChuYXZpZ2F0b3IuYmx1ZXRvb3RoPy5nZXREZXZpY2VzKSA9PSBcImZ1bmN0aW9uXCJcclxuXHRcdFx0JiYgIWZvcmNlU2VsZWN0aW9uKSB7XHJcblx0XHRcdGNvbnN0IGF2YWlsYWJsZURldmljZXMgPSBhd2FpdCBuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKTtcclxuXHRcdFx0YXZhaWxhYmxlRGV2aWNlcy5mb3JFYWNoKGZ1bmN0aW9uIChkZXYsIGluZGV4KSB7XHJcblx0XHRcdFx0bG9nLmRlYnVnKFwiRm91bmQgYXV0aG9yaXplZCBkZXZpY2UgOlwiICsgZGV2Lm5hbWUpO1xyXG5cdFx0XHRcdGlmIChkZXYubmFtZS5zdGFydHNXaXRoKFwiTVNDXCIpKVxyXG5cdFx0XHRcdFx0ZGV2aWNlID0gZGV2O1xyXG5cdFx0XHR9KTtcclxuXHRcdFx0bG9nLmRlYnVnKFwibmF2aWdhdG9yLmJsdWV0b290aC5nZXREZXZpY2VzKCk9XCIgKyBkZXZpY2UpO1xyXG5cdFx0fVxyXG5cdFx0Ly8gSWYgbm90LCByZXF1ZXN0IGZyb20gdXNlclxyXG5cdFx0aWYgKGRldmljZSA9PSBudWxsKSB7XHJcblx0XHRcdGRldmljZSA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGhcclxuXHRcdFx0XHQucmVxdWVzdERldmljZSh7XHJcblx0XHRcdFx0XHRhY2NlcHRBbGxEZXZpY2VzOiBmYWxzZSxcclxuXHRcdFx0XHRcdGZpbHRlcnM6IFt7IG5hbWVQcmVmaXg6IFwiTVNDXCIgfV0sXHJcblx0XHRcdFx0XHRvcHRpb25hbFNlcnZpY2VzOiBbQmx1ZVRvb3RoTVNDLlNlcnZpY2VVdWlkXVxyXG5cdFx0XHRcdH0pO1xyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuXHRcdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG5cdFx0bG9nLmluZm8oXCJCbHVldG9vdGggZGV2aWNlIFwiICsgZGV2aWNlLm5hbWUgKyBcIiBjb25uZWN0ZWQuXCIpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoNTAwKTtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBjb25uZWN0aW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuXHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuXHRcdGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRidFN0YXRlLmNoYXJSZWFkLnN0b3BOb3RpZmljYXRpb25zKCk7XHJcblx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7IH1cclxuXHRcdH1cclxuXHRcdGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkVSUk9SO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZha2VQYWlyRGV2aWNlKCkge1xyXG5cdGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5DT05ORUNUSU5HO1xyXG5cdHZhciBmb3JjZVNlbGVjdGlvbiA9IGJ0U3RhdGUub3B0aW9uc1tcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCJdO1xyXG5cdGxvZy5kZWJ1ZyhcImZha2VQYWlyRGV2aWNlKFwiICsgZm9yY2VTZWxlY3Rpb24gKyBcIilcIik7XHJcblx0dHJ5IHtcclxuXHRcdHZhciBkZXZpY2UgPSB7IG5hbWU6IFwiRmFrZUJURGV2aWNlXCIsIGdhdHQ6IHsgY29ubmVjdGVkOiB0cnVlIH0gfTtcclxuXHRcdGJ0U3RhdGUuYnREZXZpY2UgPSBkZXZpY2U7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuXHRcdGxvZy5pbmZvKFwiQmx1ZXRvb3RoIGRldmljZSBcIiArIGRldmljZS5uYW1lICsgXCIgY29ubmVjdGVkLlwiKTtcclxuXHRcdGF3YWl0IHV0aWxzLnNsZWVwKDUwKTtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBjb25uZWN0aW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuXHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuXHRcdGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkVSUk9SO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBPbmNlIHRoZSBkZXZpY2UgaXMgYXZhaWxhYmxlLCBpbml0aWFsaXplIHRoZSBzZXJ2aWNlIGFuZCB0aGUgMiBjaGFyYWN0ZXJpc3RpY3MgbmVlZGVkLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBidFN1YnNjcmliZSgpIHtcclxuXHR0cnkge1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLlNVQlNDUklCSU5HO1xyXG5cdFx0YnRTdGF0ZS5zdGF0c1tcInN1YmNyaWJlc1wiXSsrO1xyXG5cdFx0bGV0IGRldmljZSA9IGJ0U3RhdGUuYnREZXZpY2U7XHJcblx0XHRsZXQgc2VydmVyID0gbnVsbDtcclxuXHJcblx0XHRpZiAoIWRldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcblx0XHRcdGxvZy5kZWJ1ZyhgQ29ubmVjdGluZyB0byBHQVRUIFNlcnZlciBvbiAke2RldmljZS5uYW1lfS4uLmApO1xyXG5cdFx0XHRkZXZpY2UuYWRkRXZlbnRMaXN0ZW5lcihcImdhdHRzZXJ2ZXJkaXNjb25uZWN0ZWRcIiwgb25EaXNjb25uZWN0ZWQpO1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGlmIChidFN0YXRlLmJ0U2VydmljZT8uY29ubmVjdGVkKSB7XHJcblx0XHRcdFx0XHRidFN0YXRlLmJ0U2VydmljZS5kaXNjb25uZWN0KCk7XHJcblx0XHRcdFx0XHRidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcblx0XHRcdFx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7IH1cclxuXHJcblx0XHRcdHNlcnZlciA9IGF3YWl0IGRldmljZS5nYXR0LmNvbm5lY3QoKTtcclxuXHRcdFx0bG9nLmRlYnVnKFwiPiBGb3VuZCBHQVRUIHNlcnZlclwiKTtcclxuXHRcdH1cclxuXHRcdGVsc2Uge1xyXG5cdFx0XHRsb2cuZGVidWcoXCJHQVRUIGFscmVhZHkgY29ubmVjdGVkXCIpO1xyXG5cdFx0XHRzZXJ2ZXIgPSBkZXZpY2UuZ2F0dDtcclxuXHRcdH1cclxuXHJcblx0XHRidFN0YXRlLmJ0U2VydmljZSA9IGF3YWl0IHNlcnZlci5nZXRQcmltYXJ5U2VydmljZShCbHVlVG9vdGhNU0MuU2VydmljZVV1aWQpO1xyXG5cdFx0aWYgKGJ0U3RhdGUuYnRTZXJ2aWNlID09IG51bGwpXHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkdBVFQgU2VydmljZSByZXF1ZXN0IGZhaWxlZFwiKTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgU2VyaWFsIHNlcnZpY2VcIik7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IGF3YWl0IGJ0U3RhdGUuYnRTZXJ2aWNlLmdldENoYXJhY3RlcmlzdGljKEJsdWVUb290aE1TQy5Nb2RidXNSZXF1ZXN0VXVpZCk7XHJcblx0XHRsb2cuZGVidWcoXCI+IEZvdW5kIHdyaXRlIGNoYXJhY3RlcmlzdGljXCIpO1xyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IGF3YWl0IGJ0U3RhdGUuYnRTZXJ2aWNlLmdldENoYXJhY3RlcmlzdGljKEJsdWVUb290aE1TQy5Nb2RidXNBbnN3ZXJVdWlkKTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgcmVhZCBjaGFyYWN0ZXJpc3RpY1wiKTtcclxuXHRcdGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZC5hZGRFdmVudExpc3RlbmVyKFwiY2hhcmFjdGVyaXN0aWN2YWx1ZWNoYW5nZWRcIiwgaGFuZGxlTm90aWZpY2F0aW9ucyk7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkLnN0YXJ0Tm90aWZpY2F0aW9ucygpO1xyXG5cdFx0bG9nLmluZm8oXCI+IEJsdWV0b290aCBpbnRlcmZhY2VzIHJlYWR5LlwiKTtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJsYXN0X2Nvbm5lY3RcIl0gPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCg1MCk7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcblx0XHRpZiAoYnRTdGF0ZS5jaGFyUmVhZCAhPSBudWxsKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0aWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG5cdFx0XHRcdFx0YnRTdGF0ZS5jaGFyUmVhZC5zdG9wTm90aWZpY2F0aW9ucygpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRidFN0YXRlLmJ0RGV2aWNlPy5nYXR0LmRpc2Nvbm5lY3QoKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHsgfVxyXG5cdFx0fVxyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcblx0fVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmYWtlU3Vic2NyaWJlKCkge1xyXG5cdHRyeSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuU1VCU0NSSUJJTkc7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wic3ViY3JpYmVzXCJdKys7XHJcblx0XHRsZXQgZGV2aWNlID0gYnRTdGF0ZS5idERldmljZTtcclxuXHRcdGxldCBzZXJ2ZXIgPSBudWxsO1xyXG5cclxuXHRcdGlmICghZGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuXHRcdFx0bG9nLmRlYnVnKGBDb25uZWN0aW5nIHRvIEdBVFQgU2VydmVyIG9uICR7ZGV2aWNlLm5hbWV9Li4uYCk7XHJcblx0XHRcdGRldmljZVtcImdhdHRcIl1bXCJjb25uZWN0ZWRcIl0gPSB0cnVlO1xyXG5cdFx0XHRsb2cuZGVidWcoXCI+IEZvdW5kIEdBVFQgc2VydmVyXCIpO1xyXG5cdFx0fVxyXG5cdFx0ZWxzZSB7XHJcblx0XHRcdGxvZy5kZWJ1ZyhcIkdBVFQgYWxyZWFkeSBjb25uZWN0ZWRcIik7XHJcblx0XHRcdHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG5cdFx0fVxyXG5cclxuXHRcdGJ0U3RhdGUuYnRTZXJ2aWNlID0ge307XHJcblx0XHRsb2cuZGVidWcoXCI+IEZvdW5kIFNlcmlhbCBzZXJ2aWNlXCIpO1xyXG5cdFx0YnRTdGF0ZS5jaGFyV3JpdGUgPSB7fTtcclxuXHRcdGxvZy5kZWJ1ZyhcIj4gRm91bmQgd3JpdGUgY2hhcmFjdGVyaXN0aWNcIik7XHJcblx0XHRidFN0YXRlLmNoYXJSZWFkID0ge307XHJcblx0XHRsb2cuZGVidWcoXCI+IEZvdW5kIHJlYWQgY2hhcmFjdGVyaXN0aWNcIik7XHJcblx0XHRidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuXHRcdGxvZy5pbmZvKFwiPiBCbHVldG9vdGggaW50ZXJmYWNlcyByZWFkeS5cIik7XHJcblx0XHRidFN0YXRlLnN0YXRzW1wibGFzdF9jb25uZWN0XCJdID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoMTApO1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVQ7XHJcblx0fVxyXG5cdGNhdGNoIChlcnIpIHtcclxuXHRcdGxvZy53YXJuKFwiKiogZXJyb3Igd2hpbGUgc3Vic2NyaWJpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG5cdFx0YnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHRidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcblx0fVxyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIFdoZW4gaWRsZSwgdGhpcyBmdW5jdGlvbiBpcyBjYWxsZWRcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaCgpIHtcclxuXHRidFN0YXRlLnN0YXRlID0gU3RhdGUuQlVTWTtcclxuXHR0cnkge1xyXG5cdFx0Ly8gQ2hlY2sgdGhlIG1vZGUgZmlyc3RcclxuXHRcdHZhciBtb2RlID0gYXdhaXQgc2VuZWNhTVNDLmdldEN1cnJlbnRNb2RlKCk7XHJcblxyXG5cdFx0aWYgKG1vZGUgIT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcblx0XHRcdGJ0U3RhdGUubWV0ZXIubW9kZSA9IG1vZGU7XHJcblxyXG5cdFx0XHRpZiAoYnRTdGF0ZS5tZXRlci5pc0dlbmVyYXRpb24oKSkge1xyXG5cdFx0XHRcdHZhciBzZXRwb2ludHMgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0U2V0cG9pbnRzKGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblx0XHRcdFx0YnRTdGF0ZS5sYXN0U2V0cG9pbnQgPSBzZXRwb2ludHM7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdGlmIChidFN0YXRlLm1ldGVyLmlzTWVhc3VyZW1lbnQoKSkge1xyXG5cdFx0XHRcdHZhciBtZWFzID0gYXdhaXQgc2VuZWNhTVNDLmdldE1lYXN1cmVzKGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblx0XHRcdFx0YnRTdGF0ZS5sYXN0TWVhc3VyZSA9IG1lYXM7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHJcblx0XHQvLyBSZWZyZXNoIGJhdHRlcnkgc3RhdHVzIHJlZ3VsYXJseSAoZXZlcnkgMTAgcmVmcmVzaCBjeWNsZXMgdG8gYXZvaWQgZXhjZXNzaXZlIGNvbW11bmljYXRpb24pXHJcblx0XHRpZiAoIWJ0U3RhdGUuYmF0dGVyeVJlZnJlc2hDb3VudGVyKSB7XHJcblx0XHRcdGJ0U3RhdGUuYmF0dGVyeVJlZnJlc2hDb3VudGVyID0gMDtcclxuXHRcdH1cclxuXHRcdGJ0U3RhdGUuYmF0dGVyeVJlZnJlc2hDb3VudGVyKys7XHJcblxyXG5cdFx0aWYgKGJ0U3RhdGUuYmF0dGVyeVJlZnJlc2hDb3VudGVyID49IDEwKSB7XHJcblx0XHRcdGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSA9IGF3YWl0IHNlbmVjYU1TQy5nZXRCYXR0ZXJ5Vm9sdGFnZSgpO1xyXG5cdFx0XHRsb2cuZGVidWcoXCJcXHRcXHRCYXR0ZXJ5IHJlZnJlc2hlZDogXCIgKyBidFN0YXRlLm1ldGVyLmJhdHRlcnkgKyBcIlZcIik7XHJcblx0XHRcdGJ0U3RhdGUuYmF0dGVyeVJlZnJlc2hDb3VudGVyID0gMDtcclxuXHRcdH1cclxuXHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRGaW5pc2hlZCByZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuSURMRTtcclxuXHR9XHJcblx0Y2F0Y2ggKGVycikge1xyXG5cdFx0bG9nLndhcm4oXCJFcnJvciB3aGlsZSByZWZyZXNoaW5nIG1lYXN1cmVcIiArIGVycik7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuXHRcdGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcblx0XHRpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG5cdFx0XHRidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG5cdH1cclxufVxyXG5cclxuZnVuY3Rpb24gU2V0U2ltdWxhdGlvbih2YWx1ZSkge1xyXG5cdHNpbXVsYXRpb24gPSB2YWx1ZTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IHN0YXRlTWFjaGluZSwgU2VuZEFuZFJlc3BvbnNlLCBTZXRTaW11bGF0aW9uIH07IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuLi9jb25zdGFudHNcIik7XHJcbnZhciBNZXRlclN0YXRlID0gcmVxdWlyZShcIi4vTWV0ZXJTdGF0ZVwiKTtcclxuXHJcbi8vIEN1cnJlbnQgc3RhdGUgb2YgdGhlIGJsdWV0b290aFxyXG5jbGFzcyBBUElTdGF0ZSB7XHJcblx0Y29uc3RydWN0b3IoKSB7XHJcblx0XHR0aGlzLnN0YXRlID0gY29uc3RhbnRzLlN0YXRlLk5PVF9DT05ORUNURUQ7XHJcblx0XHR0aGlzLnByZXZfc3RhdGUgPSBjb25zdGFudHMuU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuXHRcdHRoaXMuc3RhdGVfY3B0ID0gMDtcclxuXHJcblx0XHR0aGlzLnN0YXJ0ZWQgPSBmYWxzZTsgLy8gU3RhdGUgbWFjaGluZSBzdGF0dXNcclxuXHRcdHRoaXMuc3RvcFJlcXVlc3QgPSBmYWxzZTsgLy8gVG8gcmVxdWVzdCBkaXNjb25uZWN0XHJcblx0XHR0aGlzLmxhc3RNZWFzdXJlID0ge307IC8vIEFycmF5IHdpdGggXCJNZWFzdXJlTmFtZVwiIDogdmFsdWVcclxuXHRcdHRoaXMubGFzdFNldHBvaW50ID0ge307IC8vIEFycmF5IHdpdGggXCJTZXRwb2ludFR5cGVcIiA6IHZhbHVlXHJcblxyXG5cdFx0Ly8gc3RhdGUgb2YgY29ubmVjdGVkIG1ldGVyXHJcblx0XHR0aGlzLm1ldGVyID0gbmV3IE1ldGVyU3RhdGUoKTtcclxuXHJcblx0XHQvLyBsYXN0IG1vZGJ1cyBSVFUgY29tbWFuZFxyXG5cdFx0dGhpcy5jb21tYW5kID0gbnVsbDtcclxuXHJcblx0XHQvLyBsYXN0IG1vZGJ1cyBSVFUgYW5zd2VyXHJcblx0XHR0aGlzLnJlc3BvbnNlID0gbnVsbDtcclxuXHJcblx0XHQvLyBibHVldG9vdGggcHJvcGVydGllc1xyXG5cdFx0dGhpcy5jaGFyUmVhZCA9IG51bGw7XHJcblx0XHR0aGlzLmNoYXJXcml0ZSA9IG51bGw7XHJcblx0XHR0aGlzLmJ0U2VydmljZSA9IG51bGw7XHJcblx0XHR0aGlzLmJ0RGV2aWNlID0gbnVsbDtcclxuXHJcblx0XHQvLyBlbXVsYXRlZCBjb250aW51aXR5IGNoZWNrZXJcclxuXHRcdHRoaXMuY29udGludWl0eSA9IGZhbHNlO1xyXG5cclxuXHRcdC8vIGJhdHRlcnkgcmVmcmVzaCBjb3VudGVyIGZvciByZWd1bGFyIGJhdHRlcnkgc3RhdHVzIHVwZGF0ZXNcclxuXHRcdHRoaXMuYmF0dGVyeVJlZnJlc2hDb3VudGVyID0gMDtcclxuXHJcblx0XHQvLyBnZW5lcmFsIHN0YXRpc3RpY3MgZm9yIGRlYnVnZ2luZ1xyXG5cdFx0dGhpcy5zdGF0cyA9IHtcclxuXHRcdFx0XCJyZXF1ZXN0c1wiOiAwLFxyXG5cdFx0XHRcInJlc3BvbnNlc1wiOiAwLFxyXG5cdFx0XHRcIm1vZGJ1c19lcnJvcnNcIjogMCxcclxuXHRcdFx0XCJHQVRUIGRpc2Nvbm5lY3RzXCI6IDAsXHJcblx0XHRcdFwiZXhjZXB0aW9uc1wiOiAwLFxyXG5cdFx0XHRcInN1YmNyaWJlc1wiOiAwLFxyXG5cdFx0XHRcImNvbW1hbmRzXCI6IDAsXHJcblx0XHRcdFwicmVzcG9uc2VUaW1lXCI6IDAuMCxcclxuXHRcdFx0XCJsYXN0UmVzcG9uc2VUaW1lXCI6IFwiXCIsXHJcblx0XHRcdFwibGFzdF9jb25uZWN0XCI6IG5ldyBEYXRlKDIwMjAsIDEsIDEpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblxyXG5cdFx0dGhpcy5vcHRpb25zID0ge1xyXG5cdFx0XHRcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCI6IHRydWVcclxuXHRcdH07XHJcblx0fVxyXG59XHJcblxyXG5sZXQgYnRTdGF0ZSA9IG5ldyBBUElTdGF0ZSgpO1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IEFQSVN0YXRlLCBidFN0YXRlIH07IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuLi9jb25zdGFudHNcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuLi91dGlsc1wiKTtcclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5cclxuLyoqXHJcbiAqIENvbW1hbmQgdG8gdGhlIG1ldGVyLCBtYXkgaW5jbHVkZSBzZXRwb2ludFxyXG4gKiAqL1xyXG5jbGFzcyBDb21tYW5kIHtcclxuXHQvKipcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgY29tbWFuZFxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY3R5cGVcclxuICAgICAqL1xyXG5cdGNvbnN0cnVjdG9yKGN0eXBlID0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcblx0XHR0aGlzLnR5cGUgPSBwYXJzZUludChjdHlwZSk7XHJcblx0XHR0aGlzLnNldHBvaW50ID0gbnVsbDtcclxuXHRcdHRoaXMuc2V0cG9pbnQyID0gbnVsbDtcclxuXHRcdHRoaXMuZXJyb3IgPSBmYWxzZTtcclxuXHRcdHRoaXMucGVuZGluZyA9IHRydWU7XHJcblx0XHR0aGlzLnJlcXVlc3QgPSBudWxsO1xyXG5cdFx0dGhpcy5yZXNwb25zZSA9IG51bGw7XHJcblx0fVxyXG5cclxuXHRzdGF0aWMgQ3JlYXRlTm9TUChjdHlwZSkge1xyXG5cdFx0dmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuXHRcdHJldHVybiBjbWQ7XHJcblx0fVxyXG5cdHN0YXRpYyBDcmVhdGVPbmVTUChjdHlwZSwgc2V0cG9pbnQpIHtcclxuXHRcdHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcblx0XHRjbWQuc2V0cG9pbnQgPSBwYXJzZUZsb2F0KHNldHBvaW50KTtcclxuXHRcdHJldHVybiBjbWQ7XHJcblx0fVxyXG5cdHN0YXRpYyBDcmVhdGVUd29TUChjdHlwZSwgc2V0MSwgc2V0Mikge1xyXG5cdFx0dmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuXHRcdGNtZC5zZXRwb2ludCA9IHBhcnNlRmxvYXQoc2V0MSk7XHJcblx0XHRjbWQuc2V0cG9pbnQyID0gcGFyc2VGbG9hdChzZXQyKTtcclxuXHRcdHJldHVybiBjbWQ7XHJcblx0fVxyXG5cclxuXHR0b1N0cmluZygpIHtcclxuXHRcdHJldHVybiBcIlR5cGU6IFwiICsgdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIHRoaXMudHlwZSkgKyBcIiwgc2V0cG9pbnQ6XCIgKyB0aGlzLnNldHBvaW50ICsgXCIsIHNldHBvaW50MjogXCIgKyB0aGlzLnNldHBvaW50MiArIFwiLCBwZW5kaW5nOlwiICsgdGhpcy5wZW5kaW5nICsgXCIsIGVycm9yOlwiICsgdGhpcy5lcnJvcjtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogR2V0cyB0aGUgZGVmYXVsdCBzZXRwb2ludCBmb3IgdGhpcyBjb21tYW5kIHR5cGVcclxuICAgICAqIEByZXR1cm5zIHtBcnJheX0gc2V0cG9pbnQocykgZXhwZWN0ZWRcclxuICAgICAqL1xyXG5cdGRlZmF1bHRTZXRwb2ludCgpIHtcclxuXHRcdHN3aXRjaCAodGhpcy50eXBlKSB7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0XHRcdHJldHVybiB7IFwiVGVtcGVyYXR1cmUgKMKwQylcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG5cdFx0XHRyZXR1cm4geyBcIlZvbHRhZ2UgKFYpXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcblx0XHRcdHJldHVybiB7IFwiVm9sdGFnZSAobVYpXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuXHRcdFx0cmV0dXJuIHsgXCJDdXJyZW50IChtQSlcIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuXHRcdFx0cmV0dXJuIHsgXCJJbWJhbGFuY2UgKG1WL1YpXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG5cdFx0XHRyZXR1cm4geyBcIkZyZXF1ZW5jeSAoSHopXCI6IDAuMCB9O1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuXHRcdFx0cmV0dXJuIHsgXCJQdWxzZXMgY291bnRcIjogMCwgXCJGcmVxdWVuY3kgKEh6KVwiOiAwLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VUaHJlc2hvbGRfRjpcclxuXHRcdFx0cmV0dXJuIHsgXCJVdGhyZXNob2xkIChWKVwiOiAyLjAgfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NlbnNpdGl2aXR5X3VTOlxyXG5cdFx0XHRyZXR1cm4geyBcIlNlbnNpYmlsaXR5ICh1UylcIjogMi4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcblx0XHRcdHJldHVybiB7IFwiQ29sZCBqdW5jdGlvbiBjb21wZW5zYXRpb25cIjogMC4wIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VbG93OlxyXG5cdFx0XHRyZXR1cm4geyBcIlUgbG93IChWKVwiOiAwLjAgLyBjb25zdGFudHMuTUFYX1VfR0VOIH07XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VaGlnaDpcclxuXHRcdFx0cmV0dXJuIHsgXCJVIGhpZ2ggKFYpXCI6IDUuMCAvIGNvbnN0YW50cy5NQVhfVV9HRU4gfTtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcblx0XHRcdHJldHVybiB7IFwiRGVsYXkgKHMpXCI6IDYwICogNSB9O1xyXG5cdFx0ZGVmYXVsdDpcclxuXHRcdFx0cmV0dXJuIHt9O1xyXG5cdFx0fVxyXG5cdH1cclxuXHRpc0dlbmVyYXRpb24oKSB7XHJcblx0XHRyZXR1cm4gdXRpbHMuaXNHZW5lcmF0aW9uKHRoaXMudHlwZSk7XHJcblx0fVxyXG5cdGlzTWVhc3VyZW1lbnQoKSB7XHJcblx0XHRyZXR1cm4gdXRpbHMuaXNNZWFzdXJlbWVudCh0aGlzLnR5cGUpO1xyXG5cdH1cclxuXHRpc1NldHRpbmcoKSB7XHJcblx0XHRyZXR1cm4gdXRpbHMuaXNTZXR0aW5nKHRoaXMudHlwZSk7XHJcblx0fVxyXG5cdGlzVmFsaWQoKSB7XHJcblx0XHRyZXR1cm4gKHV0aWxzLmlzTWVhc3VyZW1lbnQodGhpcy50eXBlKSB8fCB1dGlscy5pc0dlbmVyYXRpb24odGhpcy50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcodGhpcy50eXBlKSk7XHJcblx0fVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IENvbW1hbmQ7IiwiY2xhc3MgQ29tbWFuZFJlc3VsdCB7XHJcblx0dmFsdWUgPSAwLjA7XHJcblx0c3VjY2VzcyA9IGZhbHNlO1xyXG5cdG1lc3NhZ2UgPSBcIlwiO1xyXG5cdHVuaXQgPSBcIlwiO1xyXG5cdHNlY29uZGFyeV92YWx1ZSA9IDAuMDtcclxuXHRzZWNvbmRhcnlfdW5pdCA9IFwiXCI7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ29tbWFuZFJlc3VsdDsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4uL2NvbnN0YW50c1wiKTtcclxuXHJcbi8qKlxyXG4gKiBDdXJyZW50IHN0YXRlIG9mIHRoZSBtZXRlclxyXG4gKiAqL1xyXG5jbGFzcyBNZXRlclN0YXRlIHtcclxuXHRjb25zdHJ1Y3RvcigpIHtcclxuXHRcdHRoaXMuZmlybXdhcmUgPSBcIlwiOyAvLyBGaXJtd2FyZSB2ZXJzaW9uXHJcblx0XHR0aGlzLnNlcmlhbCA9IFwiXCI7IC8vIFNlcmlhbCBudW1iZXJcclxuXHRcdHRoaXMubW9kZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV047XHJcblx0XHR0aGlzLmJhdHRlcnkgPSAwLjA7XHJcblx0fVxyXG5cclxuXHRpc01lYXN1cmVtZW50KCkge1xyXG5cdFx0cmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLk9GRjtcclxuXHR9XHJcblxyXG5cdGlzR2VuZXJhdGlvbigpIHtcclxuXHRcdHJldHVybiB0aGlzLm1vZGUgPiBjb25zdGFudHMuQ29tbWFuZFR5cGUuT0ZGICYmIHRoaXMubW9kZSA8IGNvbnN0YW50cy5Db21tYW5kVHlwZS5HRU5fUkVTRVJWRUQ7XHJcblx0fVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IE1ldGVyU3RhdGU7IiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG4vKipcclxuICogIFRoaXMgbW9kdWxlIGNvbnRhaW5zIHRoZSBTZW5lY2FNU0Mgb2JqZWN0LCB3aGljaCBwcm92aWRlcyB0aGUgbWFpbiBvcGVyYXRpb25zIGZvciBibHVldG9vdGggbW9kdWxlLlxyXG4gKiAgSXQgdXNlcyB0aGUgbW9kYnVzIGhlbHBlciBmdW5jdGlvbnMgZnJvbSBzZW5lY2FNb2RidXMgLyBtb2RidXNSdHUgdG8gaW50ZXJhY3Qgd2l0aCB0aGUgbWV0ZXIgd2l0aCBTZW5kQW5kUmVzcG9uc2UgZnVuY3Rpb25cclxuICovXHJcbnZhciBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoXCIuLi91dGlsc1wiKTtcclxudmFyIHNlbmVjYU1CID0gcmVxdWlyZShcIi4uL3NlbmVjYU1vZGJ1c1wiKTtcclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoXCIuLi9tb2RidXNSdHVcIik7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKFwiLi4vY29uc3RhbnRzXCIpO1xyXG5jb25zdCB7IGJ0U3RhdGUgfSA9IHJlcXVpcmUoXCIuL0FQSVN0YXRlXCIpO1xyXG5cclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG52YXIgUmVzdWx0Q29kZSA9IGNvbnN0YW50cy5SZXN1bHRDb2RlO1xyXG5cclxuY29uc3QgUkVTRVRfUE9XRVJfT0ZGID0gNjtcclxuY29uc3QgU0VUX1BPV0VSX09GRiA9IDc7XHJcbmNvbnN0IENMRUFSX0FWR19NSU5fTUFYID0gNTtcclxuY29uc3QgUFVMU0VfQ01EID0gOTtcclxuXHJcbmNsYXNzIFNlbmVjYU1TQyB7XHJcblx0Y29uc3RydWN0b3IoZm5TZW5kQW5kUmVzcG9uc2UpIHtcclxuXHRcdHRoaXMuU2VuZEFuZFJlc3BvbnNlID0gZm5TZW5kQW5kUmVzcG9uc2U7XHJcblx0fVxyXG5cdC8qKlxyXG4gICAgICogR2V0cyB0aGUgbWV0ZXIgc2VyaWFsIG51bWJlciAoMTIzNDVfMTIzNClcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge3N0cmluZ31cclxuICAgICAqL1xyXG5cdGFzeW5jIGdldFNlcmlhbE51bWJlcigpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2VyaWFsIG51bWJlclwiKTtcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VTZXJpYWxOdW1iZXIoKSk7XHJcblx0XHRyZXR1cm4gc2VuZWNhTUIucGFyc2VTZXJpYWxOdW1iZXIocmVzcG9uc2UpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBHZXRzIHRoZSBjdXJyZW50IG1vZGUgc2V0IG9uIHRoZSBNU0MgZGV2aWNlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtDb21tYW5kVHlwZX0gYWN0aXZlIG1vZGVcclxuICAgICAqL1xyXG5cdGFzeW5jIGdldEN1cnJlbnRNb2RlKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBjdXJyZW50IG1vZGVcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlQ3VycmVudE1vZGUoKSk7XHJcblx0XHRyZXR1cm4gc2VuZWNhTUIucGFyc2VDdXJyZW50TW9kZShyZXNwb25zZSwgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogR2V0cyB0aGUgYmF0dGVyeSB2b2x0YWdlIGZyb20gdGhlIG1ldGVyIGZvciBiYXR0ZXJ5IGxldmVsIGluZGljYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge251bWJlcn0gdm9sdGFnZSAoVilcclxuICAgICAqL1xyXG5cdGFzeW5jIGdldEJhdHRlcnlWb2x0YWdlKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBiYXR0ZXJ5IHZvbHRhZ2VcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlQmF0dGVyeUxldmVsKCkpO1xyXG5cdFx0cmV0dXJuIE1hdGgucm91bmQoc2VuZWNhTUIucGFyc2VCYXR0ZXJ5KHJlc3BvbnNlKSAqIDEwMCkgLyAxMDA7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIENoZWNrIG1lYXN1cmVtZW50IGVycm9yIGZsYWdzIGZyb20gbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XHJcbiAgICAgKi9cclxuXHRhc3luYyBnZXRRdWFsaXR5VmFsaWQoKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmUgcXVhbGl0eSBiaXRcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlUXVhbGl0eUJpdFJlcXVlc3QoKSk7XHJcblx0XHRyZXR1cm4gc2VuZWNhTUIuaXNRdWFsaXR5VmFsaWQocmVzcG9uc2UpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBDaGVjayBnZW5lcmF0aW9uIGVycm9yIGZsYWdzIGZyb20gbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XHJcbiAgICAgKi9cclxuXHRhc3luYyBnZXRHZW5RdWFsaXR5VmFsaWQoY3VycmVudF9tb2RlKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIGdlbmVyYXRpb24gcXVhbGl0eSBiaXRcIik7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlR2VuU3RhdHVzUmVhZCgpKTtcclxuXHRcdHJldHVybiBzZW5lY2FNQi5wYXJzZUdlblN0YXR1cyhyZXNwb25zZSwgY3VycmVudF9tb2RlKTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogUmVhZHMgdGhlIG1lYXN1cmVtZW50cyBmcm9tIHRoZSBtZXRlciwgaW5jbHVkaW5nIGVycm9yIGZsYWdzXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgY3VycmVudCBtZXRlciBtb2RlIFxyXG4gICAgICogQHJldHVybnMge2FycmF5fG51bGx9IG1lYXN1cmVtZW50IGFycmF5ICh1bml0cywgdmFsdWVzLCBlcnJvciBmbGFnKVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0TWVhc3VyZXMobW9kZSkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBtZWFzdXJlc1wiKTtcclxuXHRcdHZhciB2YWxpZCA9IGF3YWl0IHRoaXMuZ2V0UXVhbGl0eVZhbGlkKCk7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlTWVhc3VyZVJlcXVlc3QobW9kZSkpO1xyXG5cdFx0aWYgKHJlc3BvbnNlICE9IG51bGwpIHtcclxuXHRcdFx0dmFyIG1lYXMgPSBzZW5lY2FNQi5wYXJzZU1lYXN1cmUocmVzcG9uc2UsIG1vZGUpO1xyXG5cdFx0XHRtZWFzW1wiZXJyb3JcIl0gPSAhdmFsaWQ7XHJcblx0XHRcdHJldHVybiBtZWFzO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIFJlYWRzIHRoZSBhY3RpdmUgc2V0cG9pbnRzIGZyb20gdGhlIG1ldGVyLCBpbmNsdWRpbmcgZXJyb3IgZmxhZ3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1ldGVyIG1vZGUgXHJcbiAgICAgKiBAcmV0dXJucyB7YXJyYXl8bnVsbH0gc2V0cG9pbnRzIGFycmF5ICh1bml0cywgdmFsdWVzLCBlcnJvciBmbGFnKVxyXG4gICAgICovXHJcblx0YXN5bmMgZ2V0U2V0cG9pbnRzKG1vZGUpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2V0cG9pbnRzXCIpO1xyXG5cdFx0dmFyIHZhbGlkID0gYXdhaXQgdGhpcy5nZXRHZW5RdWFsaXR5VmFsaWQobW9kZSk7XHJcblx0XHR2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlU2V0cG9pbnRSZWFkKG1vZGUpKTtcclxuXHRcdGlmIChyZXNwb25zZSAhPSBudWxsKSB7XHJcblx0XHRcdHZhciByZXN1bHRzID0gc2VuZWNhTUIucGFyc2VTZXRwb2ludFJlYWQocmVzcG9uc2UsIG1vZGUpO1xyXG5cdFx0XHRyZXN1bHRzW1wiZXJyb3JcIl0gPSAhdmFsaWQ7XHJcblx0XHRcdHJldHVybiByZXN1bHRzO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIFB1dHMgdGhlIG1ldGVyIGluIE9GRiBtb2RlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgc3dpdGNoT2ZmKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciB0byBPRkZcIik7XHJcblx0XHR2YXIgcGFja2V0ID0gc2VuZWNhTUIubWFrZU1vZGVSZXF1ZXN0KENvbW1hbmRUeXBlLk9GRik7XHJcblx0XHRpZiAocGFja2V0ID09IG51bGwpXHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHJcblx0XHRhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG5cdFx0YXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcblx0XHRyZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBXcml0ZSB0aGUgc2V0cG9pbnRzIHRvIHRoZSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjb21tYW5kX3R5cGUgdHlwZSBvZiBnZW5lcmF0aW9uIGNvbW1hbmRcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludCBzZXRwb2ludCBvZiBnZW5lcmF0aW9uXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQyIGZhY3VsdGF0aXZlLCBzZWNvbmQgc2V0cG9pbnRcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgd3JpdGVTZXRwb2ludHMoY29tbWFuZF90eXBlLCBzZXRwb2ludCwgc2V0cG9pbnQyKSB7XHJcblx0XHR2YXIgc3RhcnRHZW47XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIGNvbW1hbmQ6XCIrIGNvbW1hbmRfdHlwZSArIFwiLCBzZXRwb2ludDogXCIgKyBzZXRwb2ludCArIFwiLCBzZXRwb2ludCAyOiBcIiArIHNldHBvaW50Mik7XHJcblx0XHR2YXIgcGFja2V0cyA9IHNlbmVjYU1CLm1ha2VTZXRwb2ludFJlcXVlc3QoY29tbWFuZF90eXBlLCBzZXRwb2ludCwgc2V0cG9pbnQyKTtcclxuXHJcblx0XHRmb3IoY29uc3QgcCBvZiBwYWNrZXRzKSB7XHJcblx0XHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHApO1xyXG5cdFx0XHRpZiAocmVzcG9uc2UgIT0gbnVsbCAmJiAhbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcblx0XHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX1NIT1VMRF9SRVRSWTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG4gICAgICAgIFxyXG5cdFx0Ly8gU3BlY2lhbCBoYW5kbGluZyBvZiB0aGUgU0VUIERlbGF5IGNvbW1hbmRcclxuXHRcdHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG5cdFx0XHRzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcblx0XHRcdHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cdFx0XHRpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAxKSkge1xyXG5cdFx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdFx0fVxyXG5cdFx0XHRicmVhaztcclxuXHRcdGRlZmF1bHQ6XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogQ2xlYXIgQXZnL01pbi9NYXggc3RhdGlzdGljc1xyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG5cdGFzeW5jIGNsZWFyU3RhdGlzdGljcygpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFJlc2V0dGluZyBzdGF0aXN0aWNzXCIpO1xyXG5cdFx0dmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtDTEVBUl9BVkdfTUlOX01BWF0pO1xyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cdFx0aWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMSkpIHtcclxuXHRcdFx0cmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHR9XHJcblxyXG5cdC8qKlxyXG4gICAgICogQmVnaW5zIHRoZSBwdWxzZSBnZW5lcmF0aW9uXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgc3RhcnRQdWxzZUdlbigpIHtcclxuXHRcdGxvZy5kZWJ1ZyhcIlxcdFxcdFN0YXJ0aW5nIHB1bHNlIGdlbmVyYXRpb25cIik7XHJcblx0XHR2YXIgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtQVUxTRV9DTUQsIDJdKTsgLy8gU3RhcnQgd2l0aCBsb3dcclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuXHRcdGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHRcdHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIEJlZ2lucyB0aGUgZnJlcXVlbmN5IGdlbmVyYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBzdGFydEZyZXFHZW4oKSB7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRTdGFydGluZyBmcmVxIGdlblwiKTtcclxuXHRcdHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuR0VOX0NNRCwgW1BVTFNFX0NNRCwgMV0pOyAvLyBzdGFydCBnZW5cclxuXHRcdHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuXHRcdGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHRcdHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblx0fVxyXG5cclxuXHQvKipcclxuICAgICAqIERpc2FibGUgYXV0byBwb3dlciBvZmYgdG8gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcblx0YXN5bmMgZGlzYWJsZVBvd2VyT2ZmKCkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0RGlzYWJsaW5nIHBvd2VyIG9mZlwiKTtcclxuXHRcdHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcblx0XHRhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcblx0XHRyZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcbiAgICAgKiBDaGFuZ2VzIHRoZSBjdXJyZW50IG1vZGUgb24gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGNvbW1hbmRfdHlwZSB0aGUgbmV3IG1vZGUgdG8gc2V0IHRoZSBtZXRlciBpblxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuXHRhc3luYyBjaGFuZ2VNb2RlKGNvbW1hbmRfdHlwZSkge1xyXG5cdFx0bG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciBtb2RlIHRvIDpcIiArIGNvbW1hbmRfdHlwZSk7XHJcblx0XHR2YXIgcGFja2V0ID0gc2VuZWNhTUIubWFrZU1vZGVSZXF1ZXN0KGNvbW1hbmRfdHlwZSk7XHJcblx0XHRpZiAocGFja2V0ID09IG51bGwpIHtcclxuXHRcdFx0bG9nLmVycm9yKFwiQ291bGQgbm90IGdlbmVyYXRlIG1vZGJ1cyBwYWNrZXQgZm9yIGNvbW1hbmQgdHlwZVwiLCBjb21tYW5kX3R5cGUpO1xyXG5cdFx0XHRyZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcblx0XHR9XHJcblxyXG5cdFx0dmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2UocGFja2V0KTtcclxuXHJcblx0XHRpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAwKSkge1xyXG5cdFx0XHRsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZCB0eXBlXCIsIGNvbW1hbmRfdHlwZSk7XHJcblx0XHRcdHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuXHRcdH1cclxuXHJcblx0XHR2YXIgcmVzdWx0ID0gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG5cclxuXHRcdC8vIFNvbWUgY29tbWFuZHMgcmVxdWlyZSBhZGRpdGlvbmFsIGNvbW1hbmQgdG8gYmUgZ2l2ZW4gdG8gd29yayBwcm9wZXJseSwgYWZ0ZXIgYSBzbGlnaHQgZGVsYXlcclxuXHRcdHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkNvbnRpbnVpdHk6XHJcblx0XHRcdGJ0U3RhdGUuY29udGludWl0eSA9IHRydWU7XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5WOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5tVjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG5cdFx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgdGhpcy5jbGVhclN0YXRpc3RpY3MoKTtcclxuXHRcdFx0YnJlYWs7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG5cdFx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgdGhpcy5zdGFydFB1bHNlR2VuKCk7XHJcblx0XHRcdGJyZWFrO1xyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG5cdFx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgdGhpcy5zdGFydEZyZXFHZW4oKTtcclxuXHRcdFx0YnJlYWs7XHJcblx0XHR9XHJcblxyXG5cdFx0aWYgKHJlc3VsdCA9PSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuXHRcdFx0cmVzdWx0ID0gYXdhaXQgdGhpcy5kaXNhYmxlUG93ZXJPZmYoKTtcclxuXHRcdH1cclxuXHJcblx0XHRyZXR1cm4gcmVzdWx0O1xyXG5cdH1cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IFNlbmVjYU1TQyB9OyIsIi8qKlxyXG4gKiBDb21tYW5kIHR5cGUsIGFrYSBtb2RlIHZhbHVlIHRvIGJlIHdyaXR0ZW4gaW50byBNU0MgY3VycmVudCBzdGF0ZSByZWdpc3RlclxyXG4gKiAqL1xyXG5jb25zdCBDb21tYW5kVHlwZSA9IHtcclxuXHROT05FX1VOS05PV046IDAsIC8qKiogTUVBU1VSSU5HIEZFQVRVUkVTIEFGVEVSIFRISVMgUE9JTlQgKioqKioqKi9cclxuXHRtQV9wYXNzaXZlOiAxLFxyXG5cdG1BX2FjdGl2ZTogMixcclxuXHRWOiAzLFxyXG5cdG1WOiA0LFxyXG5cdFRIRVJNT19KOiA1LCAvLyBUZXJtb2NvcHBpZVxyXG5cdFRIRVJNT19LOiA2LFxyXG5cdFRIRVJNT19UOiA3LFxyXG5cdFRIRVJNT19FOiA4LFxyXG5cdFRIRVJNT19MOiA5LFxyXG5cdFRIRVJNT19OOiAxMCxcclxuXHRUSEVSTU9fUjogMTEsXHJcblx0VEhFUk1PX1M6IDEyLFxyXG5cdFRIRVJNT19COiAxMyxcclxuXHRQVDEwMF8yVzogMTQsIC8vIFJURCAyIGZpbGlcclxuXHRQVDEwMF8zVzogMTUsXHJcblx0UFQxMDBfNFc6IDE2LFxyXG5cdFBUNTAwXzJXOiAxNyxcclxuXHRQVDUwMF8zVzogMTgsXHJcblx0UFQ1MDBfNFc6IDE5LFxyXG5cdFBUMTAwMF8yVzogMjAsXHJcblx0UFQxMDAwXzNXOiAyMSxcclxuXHRQVDEwMDBfNFc6IDIyLFxyXG5cdEN1NTBfMlc6IDIzLFxyXG5cdEN1NTBfM1c6IDI0LFxyXG5cdEN1NTBfNFc6IDI1LFxyXG5cdEN1MTAwXzJXOiAyNixcclxuXHRDdTEwMF8zVzogMjcsXHJcblx0Q3UxMDBfNFc6IDI4LFxyXG5cdE5pMTAwXzJXOiAyOSxcclxuXHROaTEwMF8zVzogMzAsXHJcblx0TmkxMDBfNFc6IDMxLFxyXG5cdE5pMTIwXzJXOiAzMixcclxuXHROaTEyMF8zVzogMzMsXHJcblx0TmkxMjBfNFc6IDM0LFxyXG5cdExvYWRDZWxsOiAzNSwgICAvLyBDZWxsZSBkaSBjYXJpY29cclxuXHRGcmVxdWVuY3k6IDM2LCAgLy8gRnJlcXVlbnphXHJcblx0UHVsc2VUcmFpbjogMzcsIC8vIENvbnRlZ2dpbyBpbXB1bHNpXHJcblx0UkVTRVJWRUQ6IDM4LFxyXG5cdFJFU0VSVkVEXzI6IDQwLFxyXG5cdENvbnRpbnVpdHk6IDQxLFxyXG5cdE9GRjogMTAwLCAvLyAqKioqKioqKiogR0VORVJBVElPTiBBRlRFUiBUSElTIFBPSU5UICoqKioqKioqKioqKioqKioqL1xyXG5cdEdFTl9tQV9wYXNzaXZlOiAxMDEsXHJcblx0R0VOX21BX2FjdGl2ZTogMTAyLFxyXG5cdEdFTl9WOiAxMDMsXHJcblx0R0VOX21WOiAxMDQsXHJcblx0R0VOX1RIRVJNT19KOiAxMDUsXHJcblx0R0VOX1RIRVJNT19LOiAxMDYsXHJcblx0R0VOX1RIRVJNT19UOiAxMDcsXHJcblx0R0VOX1RIRVJNT19FOiAxMDgsXHJcblx0R0VOX1RIRVJNT19MOiAxMDksXHJcblx0R0VOX1RIRVJNT19OOiAxMTAsXHJcblx0R0VOX1RIRVJNT19SOiAxMTEsXHJcblx0R0VOX1RIRVJNT19TOiAxMTIsXHJcblx0R0VOX1RIRVJNT19COiAxMTMsXHJcblx0R0VOX1BUMTAwXzJXOiAxMTQsXHJcblx0R0VOX1BUNTAwXzJXOiAxMTcsXHJcblx0R0VOX1BUMTAwMF8yVzogMTIwLFxyXG5cdEdFTl9DdTUwXzJXOiAxMjMsXHJcblx0R0VOX0N1MTAwXzJXOiAxMjYsXHJcblx0R0VOX05pMTAwXzJXOiAxMjksXHJcblx0R0VOX05pMTIwXzJXOiAxMzIsXHJcblx0R0VOX0xvYWRDZWxsOiAxMzUsXHJcblx0R0VOX0ZyZXF1ZW5jeTogMTM2LFxyXG5cdEdFTl9QdWxzZVRyYWluOiAxMzcsXHJcblx0R0VOX1JFU0VSVkVEOiAxMzgsXHJcblx0Ly8gU3BlY2lhbCBzZXR0aW5ncyBiZWxvdyB0aGlzIHBvaW50c1xyXG5cdFNFVFRJTkdfUkVTRVJWRUQ6IDEwMDAsXHJcblx0U0VUX1VUaHJlc2hvbGRfRjogMTAwMSxcclxuXHRTRVRfU2Vuc2l0aXZpdHlfdVM6IDEwMDIsXHJcblx0U0VUX0NvbGRKdW5jdGlvbjogMTAwMyxcclxuXHRTRVRfVWxvdzogMTAwNCxcclxuXHRTRVRfVWhpZ2g6IDEwMDUsXHJcblx0U0VUX1NodXRkb3duRGVsYXk6IDEwMDZcclxufTtcclxuXHJcbmNvbnN0IENvbnRpbnVpdHlJbXBsID0gQ29tbWFuZFR5cGUuQ3U1MF8yVztcclxuY29uc3QgQ29udGludWl0eVRocmVzaG9sZE9obXMgPSA3NTtcclxuXHJcbi8qXHJcbiAqIEludGVybmFsIHN0YXRlIG1hY2hpbmUgZGVzY3JpcHRpb25zXHJcbiAqL1xyXG5jb25zdCBTdGF0ZSA9IHtcclxuXHROT1RfQ09OTkVDVEVEOiBcIk5vdCBjb25uZWN0ZWRcIixcclxuXHRDT05ORUNUSU5HOiBcIkJsdWV0b290aCBkZXZpY2UgcGFpcmluZy4uLlwiLFxyXG5cdERFVklDRV9QQUlSRUQ6IFwiRGV2aWNlIHBhaXJlZFwiLFxyXG5cdFNVQlNDUklCSU5HOiBcIkJsdWV0b290aCBpbnRlcmZhY2VzIGNvbm5lY3RpbmcuLi5cIixcclxuXHRJRExFOiBcIklkbGVcIixcclxuXHRCVVNZOiBcIkJ1c3lcIixcclxuXHRFUlJPUjogXCJFcnJvclwiLFxyXG5cdFNUT1BQSU5HOiBcIkNsb3NpbmcgQlQgaW50ZXJmYWNlcy4uLlwiLFxyXG5cdFNUT1BQRUQ6IFwiU3RvcHBlZFwiLFxyXG5cdE1FVEVSX0lOSVQ6IFwiTWV0ZXIgY29ubmVjdGVkXCIsXHJcblx0TUVURVJfSU5JVElBTElaSU5HOiBcIlJlYWRpbmcgbWV0ZXIgc3RhdGUuLi5cIlxyXG59O1xyXG5cclxuY29uc3QgUmVzdWx0Q29kZSA9IHtcclxuXHRGQUlMRURfTk9fUkVUUlk6IDEsXHJcblx0RkFJTEVEX1NIT1VMRF9SRVRSWTogMixcclxuXHRTVUNDRVNTOiAwXHJcbn07XHJcblxyXG5cclxuY29uc3QgTUFYX1VfR0VOID0gMjcuMDsgLy8gbWF4aW11bSB2b2x0YWdlIFxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7U3RhdGUsIENvbW1hbmRUeXBlLCBSZXN1bHRDb2RlLCBNQVhfVV9HRU4sIENvbnRpbnVpdHlJbXBsLCBDb250aW51aXR5VGhyZXNob2xkT2htc307XHJcbiIsIlwidXNlIHN0cmljdFwiO1xyXG5cclxuY29uc3QgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG5jb25zdCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XHJcbmNvbnN0IEFQSVN0YXRlID0gcmVxdWlyZShcIi4vY2xhc3Nlcy9BUElTdGF0ZVwiKTtcclxuY29uc3QgQ29tbWFuZCA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvQ29tbWFuZFwiKTtcclxuY29uc3QgUHVibGljQVBJID0gcmVxdWlyZShcIi4vbWV0ZXJQdWJsaWNBUElcIik7XHJcbmNvbnN0IFRlc3REYXRhID0gcmVxdWlyZShcIi4vbW9kYnVzVGVzdERhdGFcIik7XHJcblxyXG5sb2cuc2V0TGV2ZWwobG9nLmxldmVscy5FUlJPUiwgdHJ1ZSk7XHJcblxyXG5leHBvcnRzLlN0b3AgPSBQdWJsaWNBUEkuU3RvcDtcclxuZXhwb3J0cy5QYWlyID0gUHVibGljQVBJLlBhaXI7XHJcbmV4cG9ydHMuRXhlY3V0ZSA9IFB1YmxpY0FQSS5FeGVjdXRlO1xyXG5leHBvcnRzLlNpbXBsZUV4ZWN1dGUgPSBQdWJsaWNBUEkuU2ltcGxlRXhlY3V0ZTtcclxuZXhwb3J0cy5HZXRTdGF0ZSA9IFB1YmxpY0FQSS5HZXRTdGF0ZTtcclxuZXhwb3J0cy5TdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZTtcclxuZXhwb3J0cy5Db21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuZXhwb3J0cy5Db21tYW5kID0gQ29tbWFuZDtcclxuZXhwb3J0cy5QYXJzZSA9IFB1YmxpY0FQSS5QYXJzZTtcclxuZXhwb3J0cy5sb2cgPSBsb2c7XHJcbmV4cG9ydHMuR2V0U3RhdGVKU09OID0gUHVibGljQVBJLkdldFN0YXRlSlNPTjtcclxuZXhwb3J0cy5FeGVjdXRlSlNPTiA9IFB1YmxpY0FQSS5FeGVjdXRlSlNPTjtcclxuZXhwb3J0cy5TaW1wbGVFeGVjdXRlSlNPTiA9IFB1YmxpY0FQSS5TaW1wbGVFeGVjdXRlSlNPTjtcclxuZXhwb3J0cy5HZXRKc29uVHJhY2VzID0gVGVzdERhdGEuR2V0SnNvblRyYWNlcztcclxuXHJcbiIsIi8qXHJcbiAqIFRoaXMgZmlsZSBjb250YWlucyB0aGUgcHVibGljIEFQSSBvZiB0aGUgbWV0ZXIsIGkuZS4gdGhlIGZ1bmN0aW9ucyBkZXNpZ25lZFxyXG4gKiB0byBiZSBjYWxsZWQgZnJvbSB0aGlyZCBwYXJ0eSBjb2RlLlxyXG4gKiAxLSBQYWlyKCkgOiBib29sXHJcbiAqIDItIEV4ZWN1dGUoQ29tbWFuZCkgOiBib29sICsgSlNPTiB2ZXJzaW9uXHJcbiAqIDMtIFN0b3AoKSA6IGJvb2xcclxuICogNC0gR2V0U3RhdGUoKSA6IGFycmF5ICsgSlNPTiB2ZXJzaW9uXHJcbiAqIDUtIFNpbXBsZUV4ZWN1dGUoQ29tbWFuZCkgOiByZXR1cm5zIHRoZSB1cGRhdGVkIG1lYXN1cmVtZW50IG9yIG51bGxcclxuICovXHJcblxyXG52YXIgQ29tbWFuZFJlc3VsdCA9IHJlcXVpcmUoXCIuL2NsYXNzZXMvQ29tbWFuZFJlc3VsdFwiKTtcclxudmFyIEFQSVN0YXRlID0gcmVxdWlyZShcIi4vY2xhc3Nlcy9BUElTdGF0ZVwiKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcclxudmFyIGJsdWV0b290aCA9IHJlcXVpcmUoXCIuL2JsdWV0b290aFwiKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZShcIi4vdXRpbHNcIik7XHJcbnZhciBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbnZhciBtZXRlckFwaSA9IHJlcXVpcmUoXCIuL21ldGVyQXBpXCIpO1xyXG5cclxudmFyIGJ0U3RhdGUgPSBBUElTdGF0ZS5idFN0YXRlO1xyXG52YXIgU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGNvcHkgb2YgdGhlIGN1cnJlbnQgc3RhdGVcclxuICogQHJldHVybnMge2FycmF5fSBzdGF0dXMgb2YgbWV0ZXJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEdldFN0YXRlKCkge1xyXG5cdGxldCByZWFkeSA9IGZhbHNlO1xyXG5cdGxldCBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuXHRzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuXHQvLyBTdGF0ZXMgcmVxdWlyaW5nIHVzZXIgaW5wdXRcclxuXHRjYXNlIFN0YXRlLkVSUk9SOlxyXG5cdGNhc2UgU3RhdGUuU1RPUFBFRDpcclxuXHRjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6XHJcblx0XHRyZWFkeSA9IGZhbHNlO1xyXG5cdFx0aW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLkJVU1k6XHJcblx0Y2FzZSBTdGF0ZS5JRExFOlxyXG5cdFx0cmVhZHkgPSB0cnVlO1xyXG5cdFx0aW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcblx0XHRicmVhaztcclxuXHRjYXNlIFN0YXRlLkNPTk5FQ1RJTkc6XHJcblx0Y2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOlxyXG5cdGNhc2UgU3RhdGUuTUVURVJfSU5JVDpcclxuXHRjYXNlIFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORzpcclxuXHRjYXNlIFN0YXRlLlNVQlNDUklCSU5HOlxyXG5cdFx0aW5pdGlhbGl6aW5nID0gdHJ1ZTtcclxuXHRcdHJlYWR5ID0gZmFsc2U7XHJcblx0XHRicmVhaztcclxuXHRkZWZhdWx0OlxyXG5cdFx0cmVhZHkgPSBmYWxzZTtcclxuXHRcdGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG5cdH1cclxuXHRyZXR1cm4ge1xyXG5cdFx0XCJsYXN0U2V0cG9pbnRcIjogYnRTdGF0ZS5sYXN0U2V0cG9pbnQsXHJcblx0XHRcImxhc3RNZWFzdXJlXCI6IGJ0U3RhdGUubGFzdE1lYXN1cmUsXHJcblx0XHRcImRldmljZU5hbWVcIjogYnRTdGF0ZS5idERldmljZSA/IGJ0U3RhdGUuYnREZXZpY2UubmFtZSA6IFwiXCIsXHJcblx0XHRcImRldmljZVNlcmlhbFwiOiBidFN0YXRlLm1ldGVyPy5zZXJpYWwsXHJcblx0XHRcInN0YXRzXCI6IGJ0U3RhdGUuc3RhdHMsXHJcblx0XHRcImRldmljZU1vZGVcIjogYnRTdGF0ZS5tZXRlcj8ubW9kZSxcclxuXHRcdFwic3RhdHVzXCI6IGJ0U3RhdGUuc3RhdGUsXHJcblx0XHRcImJhdHRlcnlMZXZlbFwiOiBidFN0YXRlLm1ldGVyPy5iYXR0ZXJ5LFxyXG5cdFx0XCJyZWFkeVwiOiByZWFkeSxcclxuXHRcdFwiaW5pdGlhbGl6aW5nXCI6IGluaXRpYWxpemluZ1xyXG5cdH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQcm92aWRlZCBmb3IgY29tcGF0aWJpbGl0eSB3aXRoIEJsYXpvclxyXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBKU09OIHN0YXRlIG9iamVjdFxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gR2V0U3RhdGVKU09OKCkge1xyXG5cdHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBHZXRTdGF0ZSgpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4ZWN1dGUgY29tbWFuZCB3aXRoIHNldHBvaW50cywgSlNPTiB2ZXJzaW9uXHJcbiAqIEBwYXJhbSB7c3RyaW5nfSBqc29uQ29tbWFuZCB0aGUgY29tbWFuZCB0byBleGVjdXRlXHJcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEpTT04gY29tbWFuZCBvYmplY3RcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEV4ZWN1dGVKU09OKGpzb25Db21tYW5kKSB7XHJcblx0bGV0IGNvbW1hbmQgPSBKU09OLnBhcnNlKGpzb25Db21tYW5kKTtcclxuXHQvLyBkZXNlcmlhbGl6ZWQgb2JqZWN0IGhhcyBsb3N0IGl0cyBtZXRob2RzLCBsZXQncyByZWNyZWF0ZSBhIGNvbXBsZXRlIG9uZS5cclxuXHRsZXQgY29tbWFuZDIgPSBtZXRlckFwaS5Db21tYW5kLkNyZWF0ZVR3b1NQKGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpO1xyXG5cdHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBFeGVjdXRlKGNvbW1hbmQyKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIFNpbXBsZUV4ZWN1dGVKU09OKGpzb25Db21tYW5kKSB7XHJcblx0bGV0IGNvbW1hbmQgPSBKU09OLnBhcnNlKGpzb25Db21tYW5kKTtcclxuXHQvLyBkZXNlcmlhbGl6ZWQgb2JqZWN0IGhhcyBsb3N0IGl0cyBtZXRob2RzLCBsZXQncyByZWNyZWF0ZSBhIGNvbXBsZXRlIG9uZS5cclxuXHRsZXQgY29tbWFuZDIgPSBtZXRlckFwaS5Db21tYW5kLkNyZWF0ZVR3b1NQKGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpO1xyXG5cdHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBTaW1wbGVFeGVjdXRlKGNvbW1hbmQyKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGEgY29tbWFuZCBhbmQgcmV0dXJucyB0aGUgbWVhc3VyZW1lbnQgb3Igc2V0cG9pbnQgd2l0aCBlcnJvciBmbGFnIGFuZCBtZXNzYWdlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZH0gY29tbWFuZFxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZShjb21tYW5kKSB7XHJcblx0Y29uc3QgU0lNUExFX0VYRUNVVEVfVElNRU9VVF9TID0gNTtcclxuXHR2YXIgY3IgPSBuZXcgQ29tbWFuZFJlc3VsdCgpO1xyXG5cclxuXHRsb2cuaW5mbyhcIlNpbXBsZUV4ZWN1dGUgY2FsbGVkLi4uXCIpO1xyXG5cclxuXHRpZiAoY29tbWFuZCA9PSBudWxsKSB7XHJcblx0XHRjci5zdWNjZXNzID0gZmFsc2U7XHJcblx0XHRjci5tZXNzYWdlID0gXCJJbnZhbGlkIGNvbW1hbmRcIjtcclxuXHRcdHJldHVybiBjcjtcclxuXHR9XHJcblxyXG5cdGNvbW1hbmQucGVuZGluZyA9IHRydWU7IC8vIEluIGNhc2UgY2FsbGVyIGRvZXMgbm90IHNldCBwZW5kaW5nIGZsYWdcclxuXHJcblx0Ly8gRmFpbCBpbW1lZGlhdGVseSBpZiBub3QgcGFpcmVkLlxyXG5cdGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcblx0XHRjci5zdWNjZXNzID0gZmFsc2U7XHJcblx0XHRjci5tZXNzYWdlID0gXCJEZXZpY2UgaXMgbm90IHBhaXJlZFwiO1xyXG5cdFx0bG9nLndhcm4oY3IubWVzc2FnZSk7XHJcblx0XHRyZXR1cm4gY3I7XHJcblx0fVxyXG5cclxuXHQvLyBBbm90aGVyIGNvbW1hbmQgbWF5IGJlIHBlbmRpbmcuXHJcblx0aWYgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsICYmIGJ0U3RhdGUuY29tbWFuZC5wZW5kaW5nKSB7XHJcblx0XHRjci5zdWNjZXNzID0gZmFsc2U7XHJcblx0XHRjci5tZXNzYWdlID0gXCJBbm90aGVyIGNvbW1hbmQgaXMgcGVuZGluZ1wiO1xyXG5cdFx0bG9nLndhcm4oY3IubWVzc2FnZSk7XHJcblx0XHRyZXR1cm4gY3I7XHJcblx0fVxyXG5cclxuXHQvLyBXYWl0IGZvciBjb21wbGV0aW9uIG9mIHRoZSBjb21tYW5kLCBvciBoYWx0IG9mIHRoZSBzdGF0ZSBtYWNoaW5lXHJcblx0YnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDtcclxuXHRpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcblx0XHRhd2FpdCB1dGlscy53YWl0Rm9yVGltZW91dCgoKSA9PiAhY29tbWFuZC5wZW5kaW5nIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCwgU0lNUExFX0VYRUNVVEVfVElNRU9VVF9TKTtcclxuXHR9XHJcblxyXG5cdC8vIENoZWNrIGlmIGVycm9yIG9yIHRpbWVvdXRzXHJcblx0aWYgKGNvbW1hbmQuZXJyb3IgfHwgY29tbWFuZC5wZW5kaW5nKSB7XHJcblx0XHRjci5zdWNjZXNzID0gZmFsc2U7XHJcblx0XHRjci5tZXNzYWdlID0gXCJFcnJvciB3aGlsZSBleGVjdXRpbmcgdGhlIGNvbW1hbmQuXCI7XHJcblx0XHRsb2cud2Fybihjci5tZXNzYWdlKTtcclxuXHJcblx0XHQvLyBSZXNldCB0aGUgYWN0aXZlIGNvbW1hbmRcclxuXHRcdGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcblx0XHRyZXR1cm4gY3I7XHJcblx0fVxyXG5cclxuXHQvLyBTdGF0ZSBpcyB1cGRhdGVkIGJ5IGV4ZWN1dGUgY29tbWFuZCwgc28gd2UgY2FuIHVzZSBidFN0YXRlIHJpZ2h0IGF3YXlcclxuXHRpZiAodXRpbHMuaXNHZW5lcmF0aW9uKGNvbW1hbmQudHlwZSkpIHtcclxuXHRcdGNyLnZhbHVlID0gYnRTdGF0ZS5sYXN0U2V0cG9pbnRbXCJWYWx1ZVwiXTtcclxuXHRcdGNyLnVuaXQgPSBidFN0YXRlLmxhc3RTZXRwb2ludFtcIlVuaXRcIl07XHJcblx0fVxyXG5cdGVsc2UgaWYgKHV0aWxzLmlzTWVhc3VyZW1lbnQoY29tbWFuZC50eXBlKSkge1xyXG5cdFx0Y3IudmFsdWUgPSBidFN0YXRlLmxhc3RNZWFzdXJlW1wiVmFsdWVcIl07XHJcblx0XHRjci51bml0ID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlVuaXRcIl07XHJcblx0XHRjci5zZWNvbmRhcnlfdmFsdWUgPSBidFN0YXRlLmxhc3RNZWFzdXJlW1wiU2Vjb25kYXJ5VmFsdWVcIl07XHJcblx0XHRjci5zZWNvbmRhcnlfdW5pdCA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJTZWNvbmRhcnlVbml0XCJdO1xyXG5cdH1cclxuXHRlbHNlIHtcclxuXHRcdGNyLnZhbHVlID0gMC4wOyAvLyBTZXR0aW5ncyBjb21tYW5kcztcclxuXHR9XHJcblxyXG5cdGNyLnN1Y2Nlc3MgPSB0cnVlO1xyXG5cdGNyLm1lc3NhZ2UgPSBcIkNvbW1hbmQgZXhlY3V0ZWQgc3VjY2Vzc2Z1bGx5XCI7XHJcblx0cmV0dXJuIGNyO1xyXG59XHJcblxyXG4vKipcclxuICogRXh0ZXJuYWwgaW50ZXJmYWNlIHRvIHJlcXVpcmUgYSBjb21tYW5kIHRvIGJlIGV4ZWN1dGVkLlxyXG4gKiBUaGUgYmx1ZXRvb3RoIGRldmljZSBwYWlyaW5nIHdpbmRvdyB3aWxsIG9wZW4gaWYgZGV2aWNlIGlzIG5vdCBjb25uZWN0ZWQuXHJcbiAqIFRoaXMgbWF5IGZhaWwgaWYgY2FsbGVkIG91dHNpZGUgYSB1c2VyIGdlc3R1cmUuXHJcbiAqIEBwYXJhbSB7Q29tbWFuZH0gY29tbWFuZFxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gRXhlY3V0ZShjb21tYW5kKSB7XHJcblx0bG9nLmluZm8oXCJFeGVjdXRlIGNhbGxlZC4uLlwiKTtcclxuXHJcblx0aWYgKGNvbW1hbmQgPT0gbnVsbClcclxuXHRcdHJldHVybiBudWxsO1xyXG5cclxuXHRjb21tYW5kLnBlbmRpbmcgPSB0cnVlO1xyXG5cclxuXHR2YXIgY3B0ID0gMDtcclxuXHR3aGlsZSAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcgJiYgY3B0IDwgMzAwKSB7XHJcblx0XHRsb2cuZGVidWcoXCJXYWl0aW5nIGZvciBjdXJyZW50IGNvbW1hbmQgdG8gY29tcGxldGUuLi5cIik7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cdFx0Y3B0Kys7XHJcblx0fVxyXG5cclxuXHRsb2cuaW5mbyhcIlNldHRpbmcgbmV3IGNvbW1hbmQgOlwiICsgY29tbWFuZCk7XHJcblx0YnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDtcclxuXHJcblx0Ly8gU3RhcnQgdGhlIHJlZ3VsYXIgc3RhdGUgbWFjaGluZVxyXG5cdGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKTtcclxuXHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHRsb2cuZXJyb3IoXCJGYWlsZWQgdG8gc3RhcnQgc3RhdGUgbWFjaGluZTpcIiwgZXJyKTtcclxuXHRcdFx0Y29tbWFuZC5lcnJvciA9IHRydWU7XHJcblx0XHRcdGNvbW1hbmQucGVuZGluZyA9IGZhbHNlO1xyXG5cdFx0XHRyZXR1cm4gY29tbWFuZDtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdC8vIFdhaXQgZm9yIGNvbXBsZXRpb24gb2YgdGhlIGNvbW1hbmQsIG9yIGhhbHQgb2YgdGhlIHN0YXRlIG1hY2hpbmVcclxuXHRpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcblx0XHRhd2FpdCB1dGlscy53YWl0Rm9yKCgpID0+ICFjb21tYW5kLnBlbmRpbmcgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVEKTtcclxuXHR9XHJcblxyXG5cdC8vIFJldHVybiB0aGUgY29tbWFuZCBvYmplY3QgcmVzdWx0XHJcblx0cmV0dXJuIGNvbW1hbmQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNVVNUIEJFIENBTExFRCBGUk9NIEEgVVNFUiBHRVNUVVJFIEVWRU5UIEhBTkRMRVJcclxuICAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIG1ldGVyIGlzIHJlYWR5IHRvIGV4ZWN1dGUgY29tbWFuZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBQYWlyKGZvcmNlU2VsZWN0aW9uID0gZmFsc2UpIHtcclxuXHRsb2cuaW5mbyhcIlBhaXIoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKSBjYWxsZWQuLi5cIik7XHJcblxyXG5cdGJ0U3RhdGUub3B0aW9uc1tcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCJdID0gZm9yY2VTZWxlY3Rpb247XHJcblxyXG5cdGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcblx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuXHRcdGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKS5jYXRjaCgoZXJyKSA9PiB7XHJcblx0XHRcdGxvZy5lcnJvcihcIlN0YXRlIG1hY2hpbmUgZmFpbGVkIGR1cmluZyBwYWlyaW5nOlwiLCBlcnIpO1xyXG5cdFx0XHRidFN0YXRlLnN0YXRlID0gU3RhdGUuRVJST1I7XHJcblx0XHR9KTsgLy8gU3RhcnQgaXRcclxuXHR9XHJcblx0ZWxzZSBpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5FUlJPUikge1xyXG5cdFx0YnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7IC8vIFRyeSB0byByZXN0YXJ0XHJcblx0fVxyXG5cdGF3YWl0IHV0aWxzLndhaXRGb3IoKCkgPT4gYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5JRExFIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcblx0bG9nLmluZm8oXCJQYWlyaW5nIGNvbXBsZXRlZCwgc3RhdGUgOlwiLCBidFN0YXRlLnN0YXRlKTtcclxuXHRyZXR1cm4gKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBTdG9wcyB0aGUgc3RhdGUgbWFjaGluZSBhbmQgZGlzY29ubmVjdHMgYmx1ZXRvb3RoLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBTdG9wKCkge1xyXG5cdGxvZy5pbmZvKFwiU3RvcCByZXF1ZXN0IHJlY2VpdmVkXCIpO1xyXG5cclxuXHRidFN0YXRlLnN0b3BSZXF1ZXN0ID0gdHJ1ZTtcclxuXHRhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cclxuXHR3aGlsZSAoYnRTdGF0ZS5zdGFydGVkIHx8IChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQgJiYgYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5OT1RfQ09OTkVDVEVEKSkge1xyXG5cdFx0YnRTdGF0ZS5zdG9wUmVxdWVzdCA9IHRydWU7XHJcblx0XHRhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cdH1cclxuXHRidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cdGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSBmYWxzZTtcclxuXHRsb2cud2FybihcIlN0b3BwZWQgb24gcmVxdWVzdC5cIik7XHJcblx0cmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBTdG9wLCBQYWlyLCBFeGVjdXRlLCBFeGVjdXRlSlNPTiwgU2ltcGxlRXhlY3V0ZSwgU2ltcGxlRXhlY3V0ZUpTT04sIEdldFN0YXRlLCBHZXRTdGF0ZUpTT04sIGxvZyB9OyIsIlwidXNlIHN0cmljdFwiO1xyXG5cclxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqIE1PREJVUyBSVFUgaGFuZGxpbmcgKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXHJcblxyXG52YXIgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG5cclxuY29uc3QgU0VORUNBX01CX1NMQVZFX0lEID0gMjU7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbmNsYXNzIE1vZGJ1c0Vycm9yIGV4dGVuZHMgRXJyb3Ige1xyXG5cdC8qKlxyXG4gICAgICogQ3JlYXRlcyBhIG5ldyBtb2RidXMgZXJyb3JcclxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBtZXNzYWdlIG1lc3NhZ2VcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBmYyBmdW5jdGlvbiBjb2RlXHJcbiAgICAgKi9cclxuXHRjb25zdHJ1Y3RvcihtZXNzYWdlLCBmYykge1xyXG5cdFx0c3VwZXIobWVzc2FnZSk7XHJcblx0XHR0aGlzLm1lc3NhZ2UgPSBtZXNzYWdlO1xyXG5cdFx0dGhpcy5mYyA9IGZjO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgdGhlIDQgYnl0ZXMgQ1JDIGNvZGUgZnJvbSB0aGUgYnVmZmVyIGNvbnRlbnRzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlclxyXG4gKi9cclxuZnVuY3Rpb24gY3JjMTYoYnVmZmVyKSB7XHJcblx0dmFyIGNyYyA9IDB4RkZGRjtcclxuXHR2YXIgb2RkO1xyXG5cclxuXHRmb3IgKHZhciBpID0gMDsgaSA8IGJ1ZmZlci5sZW5ndGg7IGkrKykge1xyXG5cdFx0Y3JjID0gY3JjIF4gYnVmZmVyW2ldO1xyXG5cclxuXHRcdGZvciAodmFyIGogPSAwOyBqIDwgODsgaisrKSB7XHJcblx0XHRcdG9kZCA9IGNyYyAmIDB4MDAwMTtcclxuXHRcdFx0Y3JjID0gY3JjID4+IDE7XHJcblx0XHRcdGlmIChvZGQpIHtcclxuXHRcdFx0XHRjcmMgPSBjcmMgXiAweEEwMDE7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdHJldHVybiBjcmM7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNYWtlIGEgTW9kYnVzIFJlYWQgSG9sZGluZyBSZWdpc3RlcnMgKEZDPTAzKSB0byBzZXJpYWwgcG9ydFxyXG4gKiBcclxuICogQHBhcmFtIHtudW1iZXJ9IElEIHNsYXZlIElEXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBjb3VudCBudW1iZXIgb2YgcmVnaXN0ZXJzIHRvIHJlYWRcclxuICogQHBhcmFtIHtudW1iZXJ9IHJlZ2lzdGVyIHN0YXJ0aW5nIHJlZ2lzdGVyXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlRkMzKElELCBjb3VudCwgcmVnaXN0ZXIpIHtcclxuXHRjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoOCk7XHJcblx0Y29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhidWZmZXIpO1xyXG5cdHZpZXcuc2V0VWludDgoMCwgSUQpO1xyXG5cdHZpZXcuc2V0VWludDgoMSwgMyk7XHJcblx0dmlldy5zZXRVaW50MTYoMiwgcmVnaXN0ZXIsIGZhbHNlKTtcclxuXHR2aWV3LnNldFVpbnQxNig0LCBjb3VudCwgZmFsc2UpO1xyXG5cdHZhciBjcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShidWZmZXIuc2xpY2UoMCwgLTIpKSk7XHJcblx0dmlldy5zZXRVaW50MTYoNiwgY3JjLCB0cnVlKTtcclxuXHRyZXR1cm4gYnVmZmVyO1xyXG59XHJcblxyXG4vKipcclxuICogV3JpdGUgYSBNb2RidXMgXCJQcmVzZXQgTXVsdGlwbGUgUmVnaXN0ZXJzXCIgKEZDPTE2KSB0byBzZXJpYWwgcG9ydC5cclxuICpcclxuICogQHBhcmFtIHtudW1iZXJ9IGFkZHJlc3MgdGhlIHNsYXZlIHVuaXQgYWRkcmVzcy5cclxuICogQHBhcmFtIHtudW1iZXJ9IGRhdGFBZGRyZXNzIHRoZSBEYXRhIEFkZHJlc3Mgb2YgdGhlIGZpcnN0IHJlZ2lzdGVyLlxyXG4gKiBAcGFyYW0ge0FycmF5fSBhcnJheSB0aGUgYXJyYXkgb2YgdmFsdWVzIHRvIHdyaXRlIHRvIHJlZ2lzdGVycy5cclxuICovXHJcbmZ1bmN0aW9uIG1ha2VGQzE2KGFkZHJlc3MsIGRhdGFBZGRyZXNzLCBhcnJheSkge1xyXG5cdGNvbnN0IGNvZGUgPSAxNjtcclxuXHJcblx0Ly8gc2FuaXR5IGNoZWNrXHJcblx0aWYgKHR5cGVvZiBhZGRyZXNzID09PSBcInVuZGVmaW5lZFwiIHx8IHR5cGVvZiBkYXRhQWRkcmVzcyA9PT0gXCJ1bmRlZmluZWRcIikge1xyXG5cdFx0cmV0dXJuO1xyXG5cdH1cclxuXHJcblx0bGV0IGRhdGFMZW5ndGggPSBhcnJheS5sZW5ndGg7XHJcblxyXG5cdGNvbnN0IGNvZGVMZW5ndGggPSA3ICsgMiAqIGRhdGFMZW5ndGg7XHJcblx0Y29uc3QgYnVmID0gbmV3IEFycmF5QnVmZmVyKGNvZGVMZW5ndGggKyAyKTsgLy8gYWRkIDIgY3JjIGJ5dGVzXHJcblx0Y29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmKTtcclxuXHJcblx0ZHYuc2V0VWludDgoMCwgYWRkcmVzcyk7XHJcblx0ZHYuc2V0VWludDgoMSwgY29kZSk7XHJcblx0ZHYuc2V0VWludDE2KDIsIGRhdGFBZGRyZXNzLCBmYWxzZSk7XHJcblx0ZHYuc2V0VWludDE2KDQsIGRhdGFMZW5ndGgsIGZhbHNlKTtcclxuXHRkdi5zZXRVaW50OCg2LCBkYXRhTGVuZ3RoICogMik7XHJcblxyXG5cdC8vIGNvcHkgY29udGVudCBvZiBhcnJheSB0byBidWZcclxuXHRmb3IgKGxldCBpID0gMDsgaSA8IGRhdGFMZW5ndGg7IGkrKykge1xyXG5cdFx0ZHYuc2V0VWludDE2KDcgKyAyICogaSwgYXJyYXlbaV0sIGZhbHNlKTtcclxuXHR9XHJcblx0Y29uc3QgY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkoYnVmLnNsaWNlKDAsIC0yKSkpO1xyXG5cdC8vIGFkZCBjcmMgYnl0ZXMgdG8gYnVmZmVyXHJcblx0ZHYuc2V0VWludDE2KGNvZGVMZW5ndGgsIGNyYywgdHJ1ZSk7XHJcblx0cmV0dXJuIGJ1ZjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgdGhlIHJlZ2lzdGVycyB2YWx1ZXMgZnJvbSBhIEZDMDMgYW5zd2VyIGJ5IFJUVSBzbGF2ZVxyXG4gKiBcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMzKHJlc3BvbnNlKSB7XHJcblx0aWYgKCEocmVzcG9uc2UgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikpIHtcclxuXHRcdHJldHVybiBudWxsO1xyXG5cdH1cclxuXHRjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHJlc3BvbnNlKTtcclxuXHJcblx0Ly8gSW52YWxpZCBtb2RidXMgcGFja2V0XHJcblx0aWYgKHJlc3BvbnNlLmxlbmd0aCA8IDUpXHJcblx0XHRyZXR1cm47XHJcblxyXG5cdHZhciBjb21wdXRlZF9jcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShyZXNwb25zZS5zbGljZSgwLCAtMikpKTtcclxuXHR2YXIgYWN0dWFsX2NyYyA9IHZpZXcuZ2V0VWludDE2KHZpZXcuYnl0ZUxlbmd0aCAtIDIsIHRydWUpO1xyXG5cclxuXHRpZiAoY29tcHV0ZWRfY3JjICE9IGFjdHVhbF9jcmMpIHtcclxuXHRcdHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIENSQyAoZXhwZWN0ZWQ6XCIgKyBjb21wdXRlZF9jcmMgKyBcIixnb3Q6XCIgKyBhY3R1YWxfY3JjICsgXCIpXCIsIDMpO1xyXG5cdH1cclxuXHJcblx0dmFyIGFkZHJlc3MgPSB2aWV3LmdldFVpbnQ4KDApO1xyXG5cdGlmIChhZGRyZXNzICE9IFNFTkVDQV9NQl9TTEFWRV9JRCkge1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3Jvbmcgc2xhdmUgSUQgOlwiICsgYWRkcmVzcywgMyk7XHJcblx0fVxyXG5cclxuXHR2YXIgZmMgPSB2aWV3LmdldFVpbnQ4KDEpO1xyXG5cdGlmIChmYyA+IDEyOCkge1xyXG5cdFx0dmFyIGV4cCA9IHZpZXcuZ2V0VWludDgoMik7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gYnkgc2xhdmU6XCIgKyBleHAsIDMpO1xyXG5cdH1cclxuXHRpZiAoZmMgIT0gMykge1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgRkMgOlwiICsgZmMsIGZjKTtcclxuXHR9XHJcblxyXG5cdC8vIExlbmd0aCBpbiBieXRlcyBmcm9tIHNsYXZlIGFuc3dlclxyXG5cdHZhciBsZW5ndGggPSB2aWV3LmdldFVpbnQ4KDIpO1xyXG5cclxuXHRjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIobGVuZ3RoKTtcclxuXHRjb25zdCByZWdpc3RlcnMgPSBuZXcgRGF0YVZpZXcoYnVmZmVyKTtcclxuXHJcblx0Zm9yICh2YXIgaSA9IDM7IGkgPCB2aWV3LmJ5dGVMZW5ndGggLSAyOyBpICs9IDIpIHtcclxuXHRcdHZhciByZWcgPSB2aWV3LmdldEludDE2KGksIGZhbHNlKTtcclxuXHRcdHJlZ2lzdGVycy5zZXRJbnQxNihpIC0gMywgcmVnLCBmYWxzZSk7XHJcblx0XHR2YXIgaWR4ID0gKChpIC0gMykgLyAyICsgMSk7XHJcblx0XHRsb2cuZGVidWcoXCJcXHRcXHRSZWdpc3RlciBcIiArIGlkeCArIFwiL1wiICsgKGxlbmd0aCAvIDIpICsgXCIgPSBcIiArIHJlZyk7XHJcblx0fVxyXG5cclxuXHRyZXR1cm4gcmVnaXN0ZXJzO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2sgaWYgdGhlIEZDMTYgcmVzcG9uc2UgaXMgY29ycmVjdCAoQ1JDLCByZXR1cm4gY29kZSkgQU5EIG9wdGlvbmFsbHkgbWF0Y2hpbmcgdGhlIHJlZ2lzdGVyIGxlbmd0aCBleHBlY3RlZFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZSBtb2RidXMgcnR1IHJhdyBvdXRwdXRcclxuICogQHBhcmFtIHtudW1iZXJ9IGV4cGVjdGVkIG51bWJlciBvZiBleHBlY3RlZCB3cml0dGVuIHJlZ2lzdGVycyBmcm9tIHNsYXZlLiBJZiA8PTAsIGl0IHdpbGwgbm90IGJlIGNoZWNrZWQuXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIGFsbCByZWdpc3RlcnMgaGF2ZSBiZWVuIHdyaXR0ZW5cclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIGV4cGVjdGVkKSB7XHJcblx0dHJ5IHtcclxuXHRcdGNvbnN0IHJlc3VsdCA9IHBhcnNlRkMxNihyZXNwb25zZSk7XHJcblx0XHRyZXR1cm4gKGV4cGVjdGVkIDw9IDAgfHwgcmVzdWx0WzFdID09PSBleHBlY3RlZCk7IC8vIGNoZWNrIGlmIGxlbmd0aCBpcyBtYXRjaGluZ1xyXG5cdH1cclxuXHRjYXRjaCAoZXJyKSB7XHJcblx0XHRsb2cuZXJyb3IoXCJGQzE2IGFuc3dlciBlcnJvclwiLCBlcnIpO1xyXG5cdFx0cmV0dXJuIGZhbHNlO1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBhbnN3ZXIgdG8gdGhlIHdyaXRlIG11bHRpcGxlIHJlZ2lzdGVycyBmcm9tIHRoZSBzbGF2ZVxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzE2KHJlc3BvbnNlKSB7XHJcblx0Y29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhyZXNwb25zZSk7XHJcblxyXG5cdGlmIChyZXNwb25zZS5sZW5ndGggPCAzKVxyXG5cdFx0cmV0dXJuO1xyXG5cclxuXHR2YXIgc2xhdmUgPSB2aWV3LmdldFVpbnQ4KDApO1xyXG5cclxuXHRpZiAoc2xhdmUgIT0gU0VORUNBX01CX1NMQVZFX0lEKSB7XHJcblx0XHRyZXR1cm47XHJcblx0fVxyXG5cclxuXHR2YXIgZmMgPSB2aWV3LmdldFVpbnQ4KDEpO1xyXG5cdGlmIChmYyA+IDEyOCkge1xyXG5cdFx0dmFyIGV4cCA9IHZpZXcuZ2V0VWludDgoMik7XHJcblx0XHR0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gOlwiICsgZXhwLCAxNik7XHJcblx0fVxyXG5cdGlmIChmYyAhPSAxNikge1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgRkMgOlwiICsgZmMsIGZjKTtcclxuXHR9XHJcblx0dmFyIGNvbXB1dGVkX2NyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KHJlc3BvbnNlLnNsaWNlKDAsIC0yKSkpO1xyXG5cdHZhciBhY3R1YWxfY3JjID0gdmlldy5nZXRVaW50MTYodmlldy5ieXRlTGVuZ3RoIC0gMiwgdHJ1ZSk7XHJcblxyXG5cdGlmIChjb21wdXRlZF9jcmMgIT0gYWN0dWFsX2NyYykge1xyXG5cdFx0dGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgQ1JDIChleHBlY3RlZDpcIiArIGNvbXB1dGVkX2NyYyArIFwiLGdvdDpcIiArIGFjdHVhbF9jcmMgKyBcIilcIiwgMTYpO1xyXG5cdH1cclxuXHJcblx0dmFyIGFkZHJlc3MgPSB2aWV3LmdldFVpbnQxNigyLCBmYWxzZSk7XHJcblx0dmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDE2KDQsIGZhbHNlKTtcclxuXHRyZXR1cm4gW2FkZHJlc3MsIGxlbmd0aF07XHJcbn1cclxuXHJcblxyXG5cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBmbG9hdFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGNvbnZlcnRlZCB2YWx1ZVxyXG4gKi9cclxuZnVuY3Rpb24gZ2V0RmxvYXQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCkge1xyXG5cdGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcblx0Y29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcblx0ZHYuc2V0SW50MTYoMCwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0ICsgMiwgZmFsc2UpLCBmYWxzZSk7XHJcblx0ZHYuc2V0SW50MTYoMiwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0LCBmYWxzZSksIGZhbHNlKTtcclxuXHRyZXR1cm4gZHYuZ2V0RmxvYXQzMigwLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBVaW50MzJcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBjb252ZXJ0ZWQgdmFsdWVcclxuICovXHJcbmZ1bmN0aW9uIGdldFVpbnQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCkge1xyXG5cdGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcblx0Y29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcblx0ZHYuc2V0SW50MTYoMCwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0ICsgMiwgZmFsc2UpLCBmYWxzZSk7XHJcblx0ZHYuc2V0SW50MTYoMiwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0LCBmYWxzZSksIGZhbHNlKTtcclxuXHRyZXR1cm4gZHYuZ2V0VWludDMyKDAsIGZhbHNlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IGZsb2F0XHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHBhcmFtIHt2YWx1ZX0gbnVtYmVyIHZhbHVlIHRvIHNldFxyXG4gKi9cclxuZnVuY3Rpb24gc2V0RmxvYXQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCwgdmFsdWUpIHtcclxuXHRjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG5cdGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG5cdGR2LnNldEZsb2F0MzIoMCwgdmFsdWUsIGZhbHNlKTtcclxuXHRkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQsIGR2LmdldEludDE2KDIsIGZhbHNlKSwgZmFsc2UpO1xyXG5cdGRhdGFWaWV3LnNldEludDE2KG9mZnNldCArIDIsIGR2LmdldEludDE2KDAsIGZhbHNlKSwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSB1aW50MzIgaW50byB0aGUgYnVmZmVyXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSB2YWx1ZSB2YWx1ZSB0byBzZXRcclxuICovXHJcbmZ1bmN0aW9uIHNldFVpbnQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCwgdmFsdWUpIHtcclxuXHRjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG5cdGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG5cdGR2LnNldFVpbnQzMigwLCB2YWx1ZSwgZmFsc2UpO1xyXG5cdGRhdGFWaWV3LnNldEludDE2KG9mZnNldCwgZHYuZ2V0SW50MTYoMiwgZmFsc2UpLCBmYWxzZSk7XHJcblx0ZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0ICsgMiwgZHYuZ2V0SW50MTYoMCwgZmFsc2UpLCBmYWxzZSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBtYWtlRkMzLCBnZXRGbG9hdDMyTEVCUywgbWFrZUZDMTYsIHNldEZsb2F0MzJMRUJTLCBzZXRVaW50MzJMRUJTLCBwYXJzZUZDMywgcGFyc2VGQzE2LCBwYXJzZUZDMTZjaGVja2VkLCBNb2RidXNFcnJvciwgU0VORUNBX01CX1NMQVZFX0lELCBnZXRVaW50MzJMRUJTLCBjcmMxNiB9OyIsIlwidXNlIHN0cmljdFwiO1xyXG5cclxuY29uc3QgdGVzdFRyYWNlcyA9IFtcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBkOSAzZSA0MCA4MCAwOCBjMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMiAxOSA4N1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4MCAwMCAzOSA3NiBjMCAwMCAzYSAyZiA2MCAwMCAzOSBlZCAwNyA2N1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4MCAwMCAzOSA3NiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBhNCAwNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4MCAwMCAzOSA3NiBjMCAwMCAzYSAyZiA4MCAwMCAzOSA3NiA3MSAwY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMyBkOCA0N1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyAyZCA1YyAzYyA4NiAyZCA1YyAzYyA4NiBiNiBkOCAzYyA0YSBiNiAwM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA0NyA3NCAzYyAxMSAyZCA1YyAzYyA4NiA0NyA3NCAzYyAxMSA5NiAyYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4OCA3YyAzYiBmOSAyZCA1YyAzYyA4NiA4OCA3YyAzYiBmOSAwOCA2OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNCA5OSA4NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmNCBlMyBjMCBlYSBmNCBlMyBjMCBlYSBmNCBlMyBjMCBlYSAxNSA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmNCBlMyBjMCBlYSBlYyBlNCBjMCBlYSBmNCBlMyBjMCBlYSA2MyBlNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmNCBlMyBjMCBlYSBlYyBlNCBjMCBlYSBlYyBlNCBjMCBlYSBkNCA4N1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmYyBlMyBjMCBlYSBlYyBlNCBjMCBlYSBmYyBlMyBjMCBlYSA4MCA1OVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmYyBlMyBjMCBlYSBlYyBlNCBjMCBlYSBmNCBlMyBjMCBlYSA4MiAzOVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNiAxOSA5Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNSA1OCA0NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3ZiBkMiBjMyAwZCA0YSBlYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNiAxOCA0NFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBkMSAwMCBjMyA3NSBjYSAxOVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAyMCAwMCA4MSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzMyBkMyBjMyA3NiA0ZCA5OVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNyBkOSA4NFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA5MCBjMyA4NyA3MiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBmZSBiNyBjMyA4NiAzMiBhZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwOCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwOCA5OSA4MFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBiZSAyNyBjMiBlYiBlNyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBiYiBhZCBjMiBlYiBjNiAxOFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwOSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwOSA1OCA0MFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAxZiBiNyBjMiBkMyBjNSAzZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0NyA2MyBjMiBkMyA5NiA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAxZCA1NSBjMiBkMyA2NCBiM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwYSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwYSAxOCA0MVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2YiA1ZSBjNiAzZSBjZCBiNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2MyA3ZCBjNiAzZSAzZSAxZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwYiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwYiBkOSA4MVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3NyAyOSBjZiA3YyBmYyA1ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2MCBlZiBjZiA3ZCBkOCAxNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwYyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwYyA5OCA0M1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzNCA1MSBjZCBjZSBlOCBkN1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBhNiBlYSBjZCBjZSBiNCA0YVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBmOSBlZSBjZCBjZCBhNyA5ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBhNSBiYyBjZCBjZSA1NCAxZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwZCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwZCA1OSA4M1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1NCA3NiBjYyBiMCBjNyA2Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3YyA2ZSBjYyBiMCA0ZSBjYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwZSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwZSAxOSA4MlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0ZiA0NCA0NCA1YiAzNiBiNiA0MyBjNyA1ZiA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwZiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwZiBkOCA0MlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBmMCA3NSBjMyBiMyAxYyA0ZSBjMyBjNyBhMiBmOFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMCA5OSA4YVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA1ZCA2ZiA0NCA1YiAzZSBlZCA0MyBjNyAzNyAyMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMSA1OCA0YVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBmYiBiMSA0NSAyZiA0ZiA5YSA0NSA3ZCAxYiA5MlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMiAxOCA0YlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBjNiBiMCA0NSAyYSA2ZCAwMCBjNSA3ZCA0ZSA0OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMyBkOSA4YlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBmYSBlZCA0NSAyZiA0ZSBmZSA0NSA3ZCAwNiA3OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxNCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxNCA5OCA0OVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0MiA3YyA0NCA2MSA0ZiA5YSA0NSA3ZCBhNSA5ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxNSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxNSA1OSA4OVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA3ZiBjMCBjMyBjMCA4NyA5OCBjNSA3MiAwNyAxM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAxMiA3NyBjMyBjZCA5YiBjMSBjNSA2YiAzYyAyMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA5ZCBlOCBjMyBiNyAxMyBhOSBjNSA3NyA2OSA3N1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA4MiBkMCBjMyBhZCBmNiBkNiBjNSA3YiBjZSBlYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA1NyA4OSBjMyBkNCA0YiAxNCBjNSA2NyBkMyAxZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxNyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxNyBkOCA0OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0MSAwNiA0NCAyZSAyOSA1MyA0MyA0NyAyNiA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxOCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxOCA5OCA0Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBhYyAyZiBjNCA0NSAyNSBhNSBjMyA0NyBlOSAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxOSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxOSA1OSA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0ZiA5MiA0NCAyZSAzNSBjNiA0MyA0NyA2NSA3ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxYSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxYSAxOSA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBhZiA4MiA0MyA2NyAyOSA1MyA0MyA0NyBiMSAzM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxYiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxYiBkOCA0ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0NiBhNyBjNCAxMyAyNSBhNSBjMyA0NyAyNyAwZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxYyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxYyA5OSA4ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBjYyA5OCA0MyA2NyAzNSBjNiA0MyA0NyA1YiA3M1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxZCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxZCA1OCA0ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA3MCBlNSA0MyA5YSAzNiBiNiA0MyBjNyA5MCBiZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxZSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxZSAxOCA0ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNCAzNCBjNyAwNiAxYyA0ZSBjMyBjNyA3MSAxNVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxZiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxZiBkOSA4ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA2ZSBkZiA0MyA5YSAzZSBlZCA0MyBjNyBmOSA4ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMCA5OSA5ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBkZiBlZiA0MyA4OSAzNiBiNiA0MyBjNyBmNSA0NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMSA1OCA1ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA2YSAxZSBjNSBkZCAxYyA0ZSBjMyBjNyAxOCA4MlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMiAxOCA1ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBlNSBlZCA0MyA4OSAzZSBlZCA0MyBjNyAyNiA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMyBkOSA5ZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwMCAwMCAwNCA0NyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA3ZiAwMCAwMSAwMCAwMCAyYyAwMCAwMSBhZCBjYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyNCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2YSA0OCAzZCBkNSAyZSBmM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyNSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNSA1OSA5ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA5NiAwMCAwNCBhNyBmZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwMCAwMCAwMCAwMCAwMCAwMCAwMCBlYiA3N1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiAwNCAwMCAwMCA0MCA4MCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiBlMiAyOVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NSA1OCA2ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkMiAwMCAwMiA2NyBlYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MCA4MCA1MiA1MlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyOCA5OCA1OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiAwNCAwMCAwMCA0MSAyMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiBlMiAyOVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NiAxOCA2Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkMiAwMCAwMiA2NyBlYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSAyMCA1MyBiYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiA4MCAwMCBmOSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwNCAwMCAwMCA0MCBhMCBiMCAxOFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwMiAyOFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NyBkOSBhY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkNCAwMCAwMiA4NyBlYlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSAyMCA1MyBiYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwNCA3MCBhNCAzZiA5ZCAwYSBkYVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwMiAyOFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2OCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2OCA5OSBhOFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkNCAwMCAwMiA4NyBlYlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2NiA2NiA0MCA4NiAyYyBjN1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkYyAwMCAwMiAwNCA2NiA2NiA0MCA4NiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkYyAwMCAwMiA4MyBlYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2OSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2OSA1OCA2OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkYyAwMCAwMiAwNiAyOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2NiA2NiA0MCA4NiAyYyBjN1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2YSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2YSAxOCA2OVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2YiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2YiBkOSBhOVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2YyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2YyA5OCA2YlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2ZSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2ZSAxOSBhYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2ZCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2ZCA1OSBhYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2ZiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2ZiBkOCA2YVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3MCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3MCA5OSBhMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3MSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3MSA1OCA2MlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwNCAwMCAwMCA0MSBjOCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwMiAyN1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3MiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3MiAxOCA2M1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBlNCAwMCAwMiA4NyBlNFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSBjOCA1MyBmNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNyBkOCA1Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYyBlNyA0MCA4MCBkZCAzNVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3NSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3NSA1OSBhMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjZCA3NiA0MCA4MCA4ZCAyNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3OCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3OCA5OCA2NFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3YiBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3YiBkOCA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNyA0YiA0MCA4MCAxZiAzMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYyA1OCA0MCA4MCBlYyBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3ZSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3ZSAxOCA2NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYiBjOCA0MCA4MCBlZCA4OFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4MSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4MSA1OCAyNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYSBhOSA0MCA4MCBiZCBhYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4NCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4NCA5OCAyNVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNSA5YyA0MCA4MCBhZSBiMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkOCAwMCAwMiAwNCAwMCAwMCA0MSBmMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkOCAwMCAwMiBjMiAyYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4NyBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4NyBkOCAyNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkOCAwMCAwMiA0NyBlOFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSBmMCA1MiAyNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwMSA0ZCAwMCAwMCAwMSA0ZSAwMCAwMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMSBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMSA0ZCAwMCAwMCAwMSA0ZSAwMCAwMCBkNiA1NFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBhYSBhZiA0MCA4MCA0MyBhYlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNSAwYyA0MCA4MCBhZSA5ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjOSA4OSA0MCA4MCBiYyAyNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYiAzOSA0MCA4MCBiYyA3YlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNyBkYiA0MCA4MCAxZiAxZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNiBiYyA0MCA4MCBhZiAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNCA3ZCA0MCA4MCBmZiA3YVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjMyA1ZSA0MCA4MCAwZiBjNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjOCA2YiA0MCA4MCAxZCBlZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNiAyYyA0MCA4MCBhZiAxM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwNCAwMCAwMCA0MSBmMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwMiAyN1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjMiBjZSA0MCA4MCAwZSAxNVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjMCAwMCAwMiAwNCAwMCAwMCA0MSAyMCBmZiBmZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjMCAwMCAwMiA0MiAyY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3ZCA0MSA0MCA3NyA1YiBhY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCBkMyA2N1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OCA5MCBiOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMSBkMCBkZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwNiAwMCAwMCAwMCAwNyAwMCAwMCAzYyBiNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmYyAwMCAwMiAwNCAwMCA2NCAwMCAwMCBjMyBjMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmYyAwMCAwMiA4MiAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCAyYyBhY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OSA1MSA3OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMiA5MCBkY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAyOCAwMCAwMCAwMCAyOCAwMCAwMCBjMyA3ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0MSBjOSA0MCA3NyBkNyBkNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0MSBjOSA0MCA3NyBkNyBkNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0MCBhOSA0MCA3NyBkNiAzNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0MSBjOSA0MCA3NyBkNyBkNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0MCBhOSA0MCA3NyBkNiAzNFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZiA4YiA0MCA3NyA2ZiBlYVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZSA2YiA0MCA3NyA2ZiBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZSA2YiA0MCA3NyA2ZiBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzZCA0YyA0MCA3NyBkZiBhZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYyAyZSA0MCA3NyA3ZiA4ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzYiAwZSA0MCA3NyA3ZiAzM1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMSA1YSA5NFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNSBjNCA4OFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMSAwOCAwMCAwMiAwNCAwMCAwMCAwMCAwMCA4MSAzOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMSAwOCAwMCAwMiBjMiAyZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMSAwNiAwMCAwMiAwNCBhMSAyZiAzZSBiZCBjMiA5MVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMSAwNiAwMCAwMiBhMyBlZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmYyAwMCAwMiAwNCAwMCAwYSAwMCAwMCBhMiAxY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmYyAwMCAwMiA4MiAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwMCA2NCAwMCAwMCAwMCA2NCAwMCAwMCA2MCBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OSA1MSA3OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMiA5MCBkY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCA2NCAwMCAwMCAwMCA2NCAwMCAwMCA4ZiA2ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCA2NCAwMCAwMCAwMCA2NCAwMCAwMCA4ZiA2ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCA2NCAwMCAwMCAwMCA2NCAwMCAwMCA4ZiA2ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCA2NCAwMCAwMCAwMCA2NCAwMCAwMCA4ZiA2ZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCBhYyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OCA5MCBiOVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMSBkMCBkZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCA0MyAxY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCA0MyAxY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCA0MyAxY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCA0MyAxY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCA0MyAxY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMyBlOCAwMCAwMCAwMyBlOCAwMCAwMCA0MyAxY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBlZiBlMSA0MCA3NiBiNiBmNlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMyBkYiA1NVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA5NCAwMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NyBkMSAzNVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMSBkMCBkZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA3YiBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA3YiBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA3YiBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA3YiBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA3YiBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNyBkMCAwMCAwMCAwNyBkMCAwMCAwMCA3YiBkMVwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmYyAwMCAwMiAwNCAwMCAwNSAwMCAwMCA5MiAxZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmYyAwMCAwMiA4MiAyMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCAzMCA1ZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OSA1MSA3OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMiA5MCBkY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OSA1OSBlMFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAyMCA4ZCAwMCAwMCAyMCA4ZSAwMCAwMCBkZiA4Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyNCA5YiA0ZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiA4NCA4OVwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA1YyAzZSAxMSA3MiA0Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA1YyAzZSAxMSA3MiA0Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA1YyAzZSAxMSA3MiA0Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA1YyAzZSAxMSA3MiA0Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA1YyAzZSAxMSA3MiA0Y1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCA5YSBiZlwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcblx0fSxcclxuXHR7XHJcblx0XHRcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG5cdFx0XCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcblx0fVxyXG5dO1xyXG5cclxuZnVuY3Rpb24gdW5pcUJ5KGEsIGtleSkge1xyXG5cdHZhciBzZWVuID0ge307XHJcblx0cmV0dXJuIGEuZmlsdGVyKGZ1bmN0aW9uIChpdGVtKSB7XHJcblx0XHR2YXIgayA9IGtleShpdGVtKTtcclxuXHRcdHJldHVybiBzZWVuLmhhc093blByb3BlcnR5KGspID8gZmFsc2UgOiAoc2VlbltrXSA9IHRydWUpO1xyXG5cdH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYW1lTWVzc2FnZSh0cmFjZSkge1xyXG5cdHJldHVybiB0cmFjZVtcInJlcXVlc3RcIl0gKyBcIiAtPiBcIiArIHRyYWNlW1wiYW5zd2VyXCJdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBHZXRKc29uVHJhY2VzKCkge1xyXG5cdHRlc3RUcmFjZXMgPSB1bmlxQnkodGVzdFRyYWNlcywgc2FtZU1lc3NhZ2UpO1xyXG5cdHJldHVybiBKU09OLnN0cmluZ2lmeSh0ZXN0VHJhY2VzKTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IHRlc3RUcmFjZXMsIEdldEpzb25UcmFjZXMgfTsiLCIvKlxuKiBsb2dsZXZlbCAtIGh0dHBzOi8vZ2l0aHViLmNvbS9waW10ZXJyeS9sb2dsZXZlbFxuKlxuKiBDb3B5cmlnaHQgKGMpIDIwMTMgVGltIFBlcnJ5XG4qIExpY2Vuc2VkIHVuZGVyIHRoZSBNSVQgbGljZW5zZS5cbiovXG4oZnVuY3Rpb24gKHJvb3QsIGRlZmluaXRpb24pIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICBpZiAodHlwZW9mIGRlZmluZSA9PT0gJ2Z1bmN0aW9uJyAmJiBkZWZpbmUuYW1kKSB7XG4gICAgICAgIGRlZmluZShkZWZpbml0aW9uKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gZGVmaW5pdGlvbigpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJvb3QubG9nID0gZGVmaW5pdGlvbigpO1xuICAgIH1cbn0odGhpcywgZnVuY3Rpb24gKCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuXG4gICAgLy8gU2xpZ2h0bHkgZHViaW91cyB0cmlja3MgdG8gY3V0IGRvd24gbWluaW1pemVkIGZpbGUgc2l6ZVxuICAgIHZhciBub29wID0gZnVuY3Rpb24oKSB7fTtcbiAgICB2YXIgdW5kZWZpbmVkVHlwZSA9IFwidW5kZWZpbmVkXCI7XG4gICAgdmFyIGlzSUUgPSAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSkgJiYgKHR5cGVvZiB3aW5kb3cubmF2aWdhdG9yICE9PSB1bmRlZmluZWRUeXBlKSAmJiAoXG4gICAgICAgIC9UcmlkZW50XFwvfE1TSUUgLy50ZXN0KHdpbmRvdy5uYXZpZ2F0b3IudXNlckFnZW50KVxuICAgICk7XG5cbiAgICB2YXIgbG9nTWV0aG9kcyA9IFtcbiAgICAgICAgXCJ0cmFjZVwiLFxuICAgICAgICBcImRlYnVnXCIsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgICBcIndhcm5cIixcbiAgICAgICAgXCJlcnJvclwiXG4gICAgXTtcblxuICAgIHZhciBfbG9nZ2Vyc0J5TmFtZSA9IHt9O1xuICAgIHZhciBkZWZhdWx0TG9nZ2VyID0gbnVsbDtcblxuICAgIC8vIENyb3NzLWJyb3dzZXIgYmluZCBlcXVpdmFsZW50IHRoYXQgd29ya3MgYXQgbGVhc3QgYmFjayB0byBJRTZcbiAgICBmdW5jdGlvbiBiaW5kTWV0aG9kKG9iaiwgbWV0aG9kTmFtZSkge1xuICAgICAgICB2YXIgbWV0aG9kID0gb2JqW21ldGhvZE5hbWVdO1xuICAgICAgICBpZiAodHlwZW9mIG1ldGhvZC5iaW5kID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gbWV0aG9kLmJpbmQob2JqKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIEZ1bmN0aW9uLnByb3RvdHlwZS5iaW5kLmNhbGwobWV0aG9kLCBvYmopO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIC8vIE1pc3NpbmcgYmluZCBzaGltIG9yIElFOCArIE1vZGVybml6ciwgZmFsbGJhY2sgdG8gd3JhcHBpbmdcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuYXBwbHkobWV0aG9kLCBbb2JqLCBhcmd1bWVudHNdKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVHJhY2UoKSBkb2Vzbid0IHByaW50IHRoZSBtZXNzYWdlIGluIElFLCBzbyBmb3IgdGhhdCBjYXNlIHdlIG5lZWQgdG8gd3JhcCBpdFxuICAgIGZ1bmN0aW9uIHRyYWNlRm9ySUUoKSB7XG4gICAgICAgIGlmIChjb25zb2xlLmxvZykge1xuICAgICAgICAgICAgaWYgKGNvbnNvbGUubG9nLmFwcGx5KSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2cuYXBwbHkoY29uc29sZSwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gSW4gb2xkIElFLCBuYXRpdmUgY29uc29sZSBtZXRob2RzIHRoZW1zZWx2ZXMgZG9uJ3QgaGF2ZSBhcHBseSgpLlxuICAgICAgICAgICAgICAgIEZ1bmN0aW9uLnByb3RvdHlwZS5hcHBseS5hcHBseShjb25zb2xlLmxvZywgW2NvbnNvbGUsIGFyZ3VtZW50c10pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChjb25zb2xlLnRyYWNlKSBjb25zb2xlLnRyYWNlKCk7XG4gICAgfVxuXG4gICAgLy8gQnVpbGQgdGhlIGJlc3QgbG9nZ2luZyBtZXRob2QgcG9zc2libGUgZm9yIHRoaXMgZW52XG4gICAgLy8gV2hlcmV2ZXIgcG9zc2libGUgd2Ugd2FudCB0byBiaW5kLCBub3Qgd3JhcCwgdG8gcHJlc2VydmUgc3RhY2sgdHJhY2VzXG4gICAgZnVuY3Rpb24gcmVhbE1ldGhvZChtZXRob2ROYW1lKSB7XG4gICAgICAgIGlmIChtZXRob2ROYW1lID09PSAnZGVidWcnKSB7XG4gICAgICAgICAgICBtZXRob2ROYW1lID0gJ2xvZyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgPT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTsgLy8gTm8gbWV0aG9kIHBvc3NpYmxlLCBmb3Igbm93IC0gZml4ZWQgbGF0ZXIgYnkgZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlc1xuICAgICAgICB9IGVsc2UgaWYgKG1ldGhvZE5hbWUgPT09ICd0cmFjZScgJiYgaXNJRSkge1xuICAgICAgICAgICAgcmV0dXJuIHRyYWNlRm9ySUU7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uc29sZVttZXRob2ROYW1lXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gYmluZE1ldGhvZChjb25zb2xlLCBtZXRob2ROYW1lKTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25zb2xlLmxvZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gYmluZE1ldGhvZChjb25zb2xlLCAnbG9nJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gbm9vcDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZXNlIHByaXZhdGUgZnVuY3Rpb25zIGFsd2F5cyBuZWVkIGB0aGlzYCB0byBiZSBzZXQgcHJvcGVybHlcblxuICAgIGZ1bmN0aW9uIHJlcGxhY2VMb2dnaW5nTWV0aG9kcygpIHtcbiAgICAgICAgLypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cbiAgICAgICAgdmFyIGxldmVsID0gdGhpcy5nZXRMZXZlbCgpO1xuXG4gICAgICAgIC8vIFJlcGxhY2UgdGhlIGFjdHVhbCBtZXRob2RzLlxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxvZ01ldGhvZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIHZhciBtZXRob2ROYW1lID0gbG9nTWV0aG9kc1tpXTtcbiAgICAgICAgICAgIHRoaXNbbWV0aG9kTmFtZV0gPSAoaSA8IGxldmVsKSA/XG4gICAgICAgICAgICAgICAgbm9vcCA6XG4gICAgICAgICAgICAgICAgdGhpcy5tZXRob2RGYWN0b3J5KG1ldGhvZE5hbWUsIGxldmVsLCB0aGlzLm5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRGVmaW5lIGxvZy5sb2cgYXMgYW4gYWxpYXMgZm9yIGxvZy5kZWJ1Z1xuICAgICAgICB0aGlzLmxvZyA9IHRoaXMuZGVidWc7XG5cbiAgICAgICAgLy8gUmV0dXJuIGFueSBpbXBvcnRhbnQgd2FybmluZ3MuXG4gICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gdW5kZWZpbmVkVHlwZSAmJiBsZXZlbCA8IHRoaXMubGV2ZWxzLlNJTEVOVCkge1xuICAgICAgICAgICAgcmV0dXJuIFwiTm8gY29uc29sZSBhdmFpbGFibGUgZm9yIGxvZ2dpbmdcIjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIEluIG9sZCBJRSB2ZXJzaW9ucywgdGhlIGNvbnNvbGUgaXNuJ3QgcHJlc2VudCB1bnRpbCB5b3UgZmlyc3Qgb3BlbiBpdC5cbiAgICAvLyBXZSBidWlsZCByZWFsTWV0aG9kKCkgcmVwbGFjZW1lbnRzIGhlcmUgdGhhdCByZWdlbmVyYXRlIGxvZ2dpbmcgbWV0aG9kc1xuICAgIGZ1bmN0aW9uIGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXMobWV0aG9kTmFtZSkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwodGhpcyk7XG4gICAgICAgICAgICAgICAgdGhpc1ttZXRob2ROYW1lXS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIEJ5IGRlZmF1bHQsIHdlIHVzZSBjbG9zZWx5IGJvdW5kIHJlYWwgbWV0aG9kcyB3aGVyZXZlciBwb3NzaWJsZSwgYW5kXG4gICAgLy8gb3RoZXJ3aXNlIHdlIHdhaXQgZm9yIGEgY29uc29sZSB0byBhcHBlYXIsIGFuZCB0aGVuIHRyeSBhZ2Fpbi5cbiAgICBmdW5jdGlvbiBkZWZhdWx0TWV0aG9kRmFjdG9yeShtZXRob2ROYW1lLCBfbGV2ZWwsIF9sb2dnZXJOYW1lKSB7XG4gICAgICAgIC8qanNoaW50IHZhbGlkdGhpczp0cnVlICovXG4gICAgICAgIHJldHVybiByZWFsTWV0aG9kKG1ldGhvZE5hbWUpIHx8XG4gICAgICAgICAgICAgICBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gTG9nZ2VyKG5hbWUsIGZhY3RvcnkpIHtcbiAgICAgIC8vIFByaXZhdGUgaW5zdGFuY2UgdmFyaWFibGVzLlxuICAgICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgICAgLyoqXG4gICAgICAgKiBUaGUgbGV2ZWwgaW5oZXJpdGVkIGZyb20gYSBwYXJlbnQgbG9nZ2VyIChvciBhIGdsb2JhbCBkZWZhdWx0KS4gV2VcbiAgICAgICAqIGNhY2hlIHRoaXMgaGVyZSByYXRoZXIgdGhhbiBkZWxlZ2F0aW5nIHRvIHRoZSBwYXJlbnQgc28gdGhhdCBpdCBzdGF5c1xuICAgICAgICogaW4gc3luYyB3aXRoIHRoZSBhY3R1YWwgbG9nZ2luZyBtZXRob2RzIHRoYXQgd2UgaGF2ZSBpbnN0YWxsZWQgKHRoZVxuICAgICAgICogcGFyZW50IGNvdWxkIGNoYW5nZSBsZXZlbHMgYnV0IHdlIG1pZ2h0IG5vdCBoYXZlIHJlYnVpbHQgdGhlIGxvZ2dlcnNcbiAgICAgICAqIGluIHRoaXMgY2hpbGQgeWV0KS5cbiAgICAgICAqIEB0eXBlIHtudW1iZXJ9XG4gICAgICAgKi9cbiAgICAgIHZhciBpbmhlcml0ZWRMZXZlbDtcbiAgICAgIC8qKlxuICAgICAgICogVGhlIGRlZmF1bHQgbGV2ZWwgZm9yIHRoaXMgbG9nZ2VyLCBpZiBhbnkuIElmIHNldCwgdGhpcyBvdmVycmlkZXNcbiAgICAgICAqIGBpbmhlcml0ZWRMZXZlbGAuXG4gICAgICAgKiBAdHlwZSB7bnVtYmVyfG51bGx9XG4gICAgICAgKi9cbiAgICAgIHZhciBkZWZhdWx0TGV2ZWw7XG4gICAgICAvKipcbiAgICAgICAqIEEgdXNlci1zcGVjaWZpYyBsZXZlbCBmb3IgdGhpcyBsb2dnZXIuIElmIHNldCwgdGhpcyBvdmVycmlkZXNcbiAgICAgICAqIGBkZWZhdWx0TGV2ZWxgLlxuICAgICAgICogQHR5cGUge251bWJlcnxudWxsfVxuICAgICAgICovXG4gICAgICB2YXIgdXNlckxldmVsO1xuXG4gICAgICB2YXIgc3RvcmFnZUtleSA9IFwibG9nbGV2ZWxcIjtcbiAgICAgIGlmICh0eXBlb2YgbmFtZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBzdG9yYWdlS2V5ICs9IFwiOlwiICsgbmFtZTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG5hbWUgPT09IFwic3ltYm9sXCIpIHtcbiAgICAgICAgc3RvcmFnZUtleSA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcGVyc2lzdExldmVsSWZQb3NzaWJsZShsZXZlbE51bSkge1xuICAgICAgICAgIHZhciBsZXZlbE5hbWUgPSAobG9nTWV0aG9kc1tsZXZlbE51bV0gfHwgJ3NpbGVudCcpLnRvVXBwZXJDYXNlKCk7XG5cbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gVXNlIGxvY2FsU3RvcmFnZSBpZiBhdmFpbGFibGVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cubG9jYWxTdG9yYWdlW3N0b3JhZ2VLZXldID0gbGV2ZWxOYW1lO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gVXNlIHNlc3Npb24gY29va2llIGFzIGZhbGxiYWNrXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmRvY3VtZW50LmNvb2tpZSA9XG4gICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9XCIgKyBsZXZlbE5hbWUgKyBcIjtcIjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGdldFBlcnNpc3RlZExldmVsKCkge1xuICAgICAgICAgIHZhciBzdG9yZWRMZXZlbDtcblxuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IHdpbmRvdy5sb2NhbFN0b3JhZ2Vbc3RvcmFnZUtleV07XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gRmFsbGJhY2sgdG8gY29va2llcyBpZiBsb2NhbCBzdG9yYWdlIGdpdmVzIHVzIG5vdGhpbmdcbiAgICAgICAgICBpZiAodHlwZW9mIHN0b3JlZExldmVsID09PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICB2YXIgY29va2llID0gd2luZG93LmRvY3VtZW50LmNvb2tpZTtcbiAgICAgICAgICAgICAgICAgIHZhciBjb29raWVOYW1lID0gZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpO1xuICAgICAgICAgICAgICAgICAgdmFyIGxvY2F0aW9uID0gY29va2llLmluZGV4T2YoY29va2llTmFtZSArIFwiPVwiKTtcbiAgICAgICAgICAgICAgICAgIGlmIChsb2NhdGlvbiAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IC9eKFteO10rKS8uZXhlYyhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgY29va2llLnNsaWNlKGxvY2F0aW9uICsgY29va2llTmFtZS5sZW5ndGggKyAxKVxuICAgICAgICAgICAgICAgICAgICAgIClbMV07XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBJZiB0aGUgc3RvcmVkIGxldmVsIGlzIG5vdCB2YWxpZCwgdHJlYXQgaXQgYXMgaWYgbm90aGluZyB3YXMgc3RvcmVkLlxuICAgICAgICAgIGlmIChzZWxmLmxldmVsc1tzdG9yZWRMZXZlbF0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gc3RvcmVkTGV2ZWw7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGNsZWFyUGVyc2lzdGVkTGV2ZWwoKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIC8vIFVzZSBsb2NhbFN0b3JhZ2UgaWYgYXZhaWxhYmxlXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKHN0b3JhZ2VLZXkpO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIFVzZSBzZXNzaW9uIGNvb2tpZSBhcyBmYWxsYmFja1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5kb2N1bWVudC5jb29raWUgPVxuICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPTsgZXhwaXJlcz1UaHUsIDAxIEphbiAxOTcwIDAwOjAwOjAwIFVUQ1wiO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gbm9ybWFsaXplTGV2ZWwoaW5wdXQpIHtcbiAgICAgICAgICB2YXIgbGV2ZWwgPSBpbnB1dDtcbiAgICAgICAgICBpZiAodHlwZW9mIGxldmVsID09PSBcInN0cmluZ1wiICYmIHNlbGYubGV2ZWxzW2xldmVsLnRvVXBwZXJDYXNlKCldICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgbGV2ZWwgPSBzZWxmLmxldmVsc1tsZXZlbC50b1VwcGVyQ2FzZSgpXTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiBsZXZlbCA9PT0gXCJudW1iZXJcIiAmJiBsZXZlbCA+PSAwICYmIGxldmVsIDw9IHNlbGYubGV2ZWxzLlNJTEVOVCkge1xuICAgICAgICAgICAgICByZXR1cm4gbGV2ZWw7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcImxvZy5zZXRMZXZlbCgpIGNhbGxlZCB3aXRoIGludmFsaWQgbGV2ZWw6IFwiICsgaW5wdXQpO1xuICAgICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLypcbiAgICAgICAqXG4gICAgICAgKiBQdWJsaWMgbG9nZ2VyIEFQSSAtIHNlZSBodHRwczovL2dpdGh1Yi5jb20vcGltdGVycnkvbG9nbGV2ZWwgZm9yIGRldGFpbHNcbiAgICAgICAqXG4gICAgICAgKi9cblxuICAgICAgc2VsZi5uYW1lID0gbmFtZTtcblxuICAgICAgc2VsZi5sZXZlbHMgPSB7IFwiVFJBQ0VcIjogMCwgXCJERUJVR1wiOiAxLCBcIklORk9cIjogMiwgXCJXQVJOXCI6IDMsXG4gICAgICAgICAgXCJFUlJPUlwiOiA0LCBcIlNJTEVOVFwiOiA1fTtcblxuICAgICAgc2VsZi5tZXRob2RGYWN0b3J5ID0gZmFjdG9yeSB8fCBkZWZhdWx0TWV0aG9kRmFjdG9yeTtcblxuICAgICAgc2VsZi5nZXRMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBpZiAodXNlckxldmVsICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJldHVybiB1c2VyTGV2ZWw7XG4gICAgICAgICAgfSBlbHNlIGlmIChkZWZhdWx0TGV2ZWwgIT0gbnVsbCkge1xuICAgICAgICAgICAgcmV0dXJuIGRlZmF1bHRMZXZlbDtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIGluaGVyaXRlZExldmVsO1xuICAgICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHNlbGYuc2V0TGV2ZWwgPSBmdW5jdGlvbiAobGV2ZWwsIHBlcnNpc3QpIHtcbiAgICAgICAgICB1c2VyTGV2ZWwgPSBub3JtYWxpemVMZXZlbChsZXZlbCk7XG4gICAgICAgICAgaWYgKHBlcnNpc3QgIT09IGZhbHNlKSB7ICAvLyBkZWZhdWx0cyB0byB0cnVlXG4gICAgICAgICAgICAgIHBlcnNpc3RMZXZlbElmUG9zc2libGUodXNlckxldmVsKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBOT1RFOiBpbiB2MiwgdGhpcyBzaG91bGQgY2FsbCByZWJ1aWxkKCksIHdoaWNoIHVwZGF0ZXMgY2hpbGRyZW4uXG4gICAgICAgICAgcmV0dXJuIHJlcGxhY2VMb2dnaW5nTWV0aG9kcy5jYWxsKHNlbGYpO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5zZXREZWZhdWx0TGV2ZWwgPSBmdW5jdGlvbiAobGV2ZWwpIHtcbiAgICAgICAgICBkZWZhdWx0TGV2ZWwgPSBub3JtYWxpemVMZXZlbChsZXZlbCk7XG4gICAgICAgICAgaWYgKCFnZXRQZXJzaXN0ZWRMZXZlbCgpKSB7XG4gICAgICAgICAgICAgIHNlbGYuc2V0TGV2ZWwobGV2ZWwsIGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnJlc2V0TGV2ZWwgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgdXNlckxldmVsID0gbnVsbDtcbiAgICAgICAgICBjbGVhclBlcnNpc3RlZExldmVsKCk7XG4gICAgICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwoc2VsZik7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLmVuYWJsZUFsbCA9IGZ1bmN0aW9uKHBlcnNpc3QpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKHNlbGYubGV2ZWxzLlRSQUNFLCBwZXJzaXN0KTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuZGlzYWJsZUFsbCA9IGZ1bmN0aW9uKHBlcnNpc3QpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKHNlbGYubGV2ZWxzLlNJTEVOVCwgcGVyc2lzdCk7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnJlYnVpbGQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgaWYgKGRlZmF1bHRMb2dnZXIgIT09IHNlbGYpIHtcbiAgICAgICAgICAgICAgaW5oZXJpdGVkTGV2ZWwgPSBub3JtYWxpemVMZXZlbChkZWZhdWx0TG9nZ2VyLmdldExldmVsKCkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbChzZWxmKTtcblxuICAgICAgICAgIGlmIChkZWZhdWx0TG9nZ2VyID09PSBzZWxmKSB7XG4gICAgICAgICAgICAgIGZvciAodmFyIGNoaWxkTmFtZSBpbiBfbG9nZ2Vyc0J5TmFtZSkge1xuICAgICAgICAgICAgICAgIF9sb2dnZXJzQnlOYW1lW2NoaWxkTmFtZV0ucmVidWlsZCgpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgLy8gSW5pdGlhbGl6ZSBhbGwgdGhlIGludGVybmFsIGxldmVscy5cbiAgICAgIGluaGVyaXRlZExldmVsID0gbm9ybWFsaXplTGV2ZWwoXG4gICAgICAgICAgZGVmYXVsdExvZ2dlciA/IGRlZmF1bHRMb2dnZXIuZ2V0TGV2ZWwoKSA6IFwiV0FSTlwiXG4gICAgICApO1xuICAgICAgdmFyIGluaXRpYWxMZXZlbCA9IGdldFBlcnNpc3RlZExldmVsKCk7XG4gICAgICBpZiAoaW5pdGlhbExldmVsICE9IG51bGwpIHtcbiAgICAgICAgICB1c2VyTGV2ZWwgPSBub3JtYWxpemVMZXZlbChpbml0aWFsTGV2ZWwpO1xuICAgICAgfVxuICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwoc2VsZik7XG4gICAgfVxuXG4gICAgLypcbiAgICAgKlxuICAgICAqIFRvcC1sZXZlbCBBUElcbiAgICAgKlxuICAgICAqL1xuXG4gICAgZGVmYXVsdExvZ2dlciA9IG5ldyBMb2dnZXIoKTtcblxuICAgIGRlZmF1bHRMb2dnZXIuZ2V0TG9nZ2VyID0gZnVuY3Rpb24gZ2V0TG9nZ2VyKG5hbWUpIHtcbiAgICAgICAgaWYgKCh0eXBlb2YgbmFtZSAhPT0gXCJzeW1ib2xcIiAmJiB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIikgfHwgbmFtZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIllvdSBtdXN0IHN1cHBseSBhIG5hbWUgd2hlbiBjcmVhdGluZyBhIGxvZ2dlci5cIik7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgbG9nZ2VyID0gX2xvZ2dlcnNCeU5hbWVbbmFtZV07XG4gICAgICAgIGlmICghbG9nZ2VyKSB7XG4gICAgICAgICAgICBsb2dnZXIgPSBfbG9nZ2Vyc0J5TmFtZVtuYW1lXSA9IG5ldyBMb2dnZXIoXG4gICAgICAgICAgICAgICAgbmFtZSxcbiAgICAgICAgICAgICAgICBkZWZhdWx0TG9nZ2VyLm1ldGhvZEZhY3RvcnlcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxvZ2dlcjtcbiAgICB9O1xuXG4gICAgLy8gR3JhYiB0aGUgY3VycmVudCBnbG9iYWwgbG9nIHZhcmlhYmxlIGluIGNhc2Ugb2Ygb3ZlcndyaXRlXG4gICAgdmFyIF9sb2cgPSAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSkgPyB3aW5kb3cubG9nIDogdW5kZWZpbmVkO1xuICAgIGRlZmF1bHRMb2dnZXIubm9Db25mbGljdCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSAmJlxuICAgICAgICAgICAgICAgd2luZG93LmxvZyA9PT0gZGVmYXVsdExvZ2dlcikge1xuICAgICAgICAgICAgd2luZG93LmxvZyA9IF9sb2c7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZGVmYXVsdExvZ2dlcjtcbiAgICB9O1xuXG4gICAgZGVmYXVsdExvZ2dlci5nZXRMb2dnZXJzID0gZnVuY3Rpb24gZ2V0TG9nZ2VycygpIHtcbiAgICAgICAgcmV0dXJuIF9sb2dnZXJzQnlOYW1lO1xuICAgIH07XG5cbiAgICAvLyBFUzYgZGVmYXVsdCBleHBvcnQsIGZvciBjb21wYXRpYmlsaXR5XG4gICAgZGVmYXVsdExvZ2dlclsnZGVmYXVsdCddID0gZGVmYXVsdExvZ2dlcjtcblxuICAgIHJldHVybiBkZWZhdWx0TG9nZ2VyO1xufSkpO1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XHJcblxyXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgUlRVIEZVTkNUSU9OUyBGT1IgU0VORUNBICoqKioqKioqKioqKioqKioqKioqKiovXHJcblxyXG52YXIgbW9kYnVzID0gcmVxdWlyZShcIi4vbW9kYnVzUnR1XCIpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKFwiLi91dGlsc1wiKTtcclxuY29uc3QgeyBDb21tYW5kIH0gPSByZXF1aXJlKFwiLi9tZXRlckFwaVwiKTtcclxuY29uc3QgeyBidFN0YXRlIH0gPSByZXF1aXJlKFwiLi9jbGFzc2VzL0FQSVN0YXRlXCIpO1xyXG5cclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5jb25zdCBTRU5FQ0FfTUJfU0xBVkVfSUQgPSBtb2RidXMuU0VORUNBX01CX1NMQVZFX0lEOyAvLyBNb2RidXMgUlRVIHNsYXZlIElEXHJcblxyXG4vKlxyXG4gKiBNb2RidXMgcmVnaXN0ZXJzIG1hcC4gRWFjaCByZWdpc3RlciBpcyAyIGJ5dGVzIHdpZGUuXHJcbiAqL1xyXG5jb25zdCBNU0NSZWdpc3RlcnMgPSB7XHJcblx0U2VyaWFsTnVtYmVyOiAxMCxcclxuXHRDdXJyZW50TW9kZTogMTAwLFxyXG5cdE1lYXN1cmVGbGFnczogMTAyLFxyXG5cdENNRDogMTA3LFxyXG5cdEFVWDE6IDEwOCxcclxuXHRMb2FkQ2VsbE1lYXN1cmU6IDExNCxcclxuXHRUZW1wTWVhc3VyZTogMTIwLFxyXG5cdFJ0ZFRlbXBlcmF0dXJlTWVhc3VyZTogMTI4LFxyXG5cdFJ0ZFJlc2lzdGFuY2VNZWFzdXJlOiAxMzAsXHJcblx0RnJlcXVlbmN5TWVhc3VyZTogMTY0LFxyXG5cdE1pbk1lYXN1cmU6IDEzMixcclxuXHRNYXhNZWFzdXJlOiAxMzQsXHJcblx0SW5zdGFudE1lYXN1cmU6IDEzNixcclxuXHRQb3dlck9mZkRlbGF5OiAxNDIsXHJcblx0UG93ZXJPZmZSZW1haW5pbmc6IDE0NixcclxuXHRQdWxzZU9GRk1lYXN1cmU6IDE1MCxcclxuXHRQdWxzZU9OTWVhc3VyZTogMTUyLFxyXG5cdFNlbnNpYmlsaXR5X3VTX09GRjogMTY2LFxyXG5cdFNlbnNpYmlsaXR5X3VTX09OOiAxNjgsXHJcblx0QmF0dGVyeU1lYXN1cmU6IDE3NCxcclxuXHRDb2xkSnVuY3Rpb246IDE5MCxcclxuXHRUaHJlc2hvbGRVX0ZyZXE6IDE5MixcclxuXHRHZW5lcmF0aW9uRmxhZ3M6IDIwMixcclxuXHRHRU5fQ01EOiAyMDcsXHJcblx0R0VOX0FVWDE6IDIwOCxcclxuXHRDdXJyZW50U2V0cG9pbnQ6IDIxMCxcclxuXHRWb2x0YWdlU2V0cG9pbnQ6IDIxMixcclxuXHRMb2FkQ2VsbFNldHBvaW50OiAyMTYsXHJcblx0VGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludDogMjIwLFxyXG5cdFJURFRlbXBlcmF0dXJlU2V0cG9pbnQ6IDIyOCxcclxuXHRQdWxzZXNDb3VudDogMjUyLFxyXG5cdEZyZXF1ZW5jeVRJQ0sxOiAyNTQsXHJcblx0RnJlcXVlbmN5VElDSzI6IDI1NixcclxuXHRHZW5VaGlnaFBlcmM6IDI2MixcclxuXHRHZW5VbG93UGVyYzogMjY0XHJcbn07XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIHNlcmlhbCBudW1iZXJcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZVNlcmlhbE51bWJlcigpIHtcclxuXHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuU2VyaWFsTnVtYmVyKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBjdXJyZW50IG1vZGVcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZUN1cnJlbnRNb2RlKCkge1xyXG5cdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDEsIE1TQ1JlZ2lzdGVycy5DdXJyZW50TW9kZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBHZW5lcmF0ZSB0aGUgbW9kYnVzIFJUVSBwYWNrZXQgdG8gcmVhZCB0aGUgY3VycmVudCBiYXR0ZXJ5IGxldmVsXHJcbiAqICovXHJcbmZ1bmN0aW9uIG1ha2VCYXR0ZXJ5TGV2ZWwoKSB7XHJcblx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkJhdHRlcnlNZWFzdXJlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgcmVnaXN0ZXIgd2l0aCBiYXR0ZXJ5IGxldmVsXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBGQzMgYW5zd2VyIFxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBiYXR0ZXJ5IGxldmVsIGluIFZcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQmF0dGVyeShidWZmZXIpIHtcclxuXHR2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0cmV0dXJuIG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZWdpc3RlcnMsIDApO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIFNlbmVjYSBNU0Mgc2VyaWFsIGFzIHBlciB0aGUgVUkgaW50ZXJmYWNlXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBtb2RidXMgYW5zd2VyIHBhY2tldCAoRkMzKVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VTZXJpYWxOdW1iZXIoYnVmZmVyKSB7XHJcblx0dmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG5cdGlmIChyZWdpc3RlcnMubGVuZ3RoIDwgNCkge1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBzZXJpYWwgbnVtYmVyIHJlc3BvbnNlXCIpO1xyXG5cdH1cclxuXHRjb25zdCB2YWwxID0gcmVnaXN0ZXJzLmdldFVpbnQxNigwLCBmYWxzZSk7XHJcblx0Y29uc3QgdmFsMiA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG5cdGNvbnN0IHNlcmlhbCA9ICgodmFsMiA8PCAxNikgKyB2YWwxKS50b1N0cmluZygpO1xyXG5cdGlmIChzZXJpYWwubGVuZ3RoID4gNSkge1xyXG5cdFx0cmV0dXJuIHNlcmlhbC5zdWJzdHIoMCwgNSkgKyBcIl9cIiArIHNlcmlhbC5zdWJzdHIoNSwgc2VyaWFsLmxlbmd0aCAtIDUpO1xyXG5cdH1cclxuXHRyZXR1cm4gc2VyaWFsO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSBzdGF0ZSBvZiB0aGUgbWV0ZXIuIE1heSB0aHJvdy5cclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBhbnN3ZXIgcGFja2V0IChGQzMpXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGN1cnJlbnRNb2RlIGlmIHRoZSByZWdpc3RlcnMgY29udGFpbnMgYW4gSUdOT1JFIHZhbHVlLCByZXR1cm5zIHRoZSBjdXJyZW50IG1vZGVcclxuICogQHJldHVybnMge0NvbW1hbmRUeXBlfSBtZXRlciBtb2RlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUN1cnJlbnRNb2RlKGJ1ZmZlciwgY3VycmVudE1vZGUpIHtcclxuXHR2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0aWYgKHJlZ2lzdGVycy5sZW5ndGggPCAyKSB7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1vZGUgcmVzcG9uc2VcIik7XHJcblx0fVxyXG5cdGNvbnN0IHZhbDEgPSByZWdpc3RlcnMuZ2V0VWludDE2KDAsIGZhbHNlKTtcclxuXHJcblx0aWYgKHZhbDEgPT0gQ29tbWFuZFR5cGUuUkVTRVJWRUQgfHwgdmFsMSA9PSBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQgfHwgdmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRF8yKSB7IC8vIE11c3QgYmUgaWdub3JlZCwgaW50ZXJuYWwgc3RhdGVzIG9mIHRoZSBtZXRlclxyXG5cdFx0cmV0dXJuIGN1cnJlbnRNb2RlO1xyXG5cdH1cclxuXHRjb25zdCB2YWx1ZSA9IHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCB2YWwxKTtcclxuXHRpZiAodmFsdWUgPT0gbnVsbClcclxuXHRcdHRocm93IG5ldyBFcnJvcihcIlVua25vd24gbWV0ZXIgbW9kZSA6IFwiICsgdmFsdWUpO1xyXG5cclxuXHRpZiAodmFsMSA9PSBjb25zdGFudHMuQ29udGludWl0eUltcGwgJiYgYnRTdGF0ZS5jb250aW51aXR5KVxyXG5cdHtcclxuXHRcdHJldHVybiBDb21tYW5kVHlwZS5Db250aW51aXR5O1xyXG5cdH1cclxuXHRyZXR1cm4gdmFsMTtcclxufVxyXG4vKipcclxuICogU2V0cyB0aGUgY3VycmVudCBtb2RlLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ8bnVsbH1cclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNb2RlUmVxdWVzdChtb2RlKSB7XHJcblx0Y29uc3QgdmFsdWUgPSB1dGlscy5QYXJzZShDb21tYW5kVHlwZSwgbW9kZSk7XHJcblx0Y29uc3QgQ0hBTkdFX1NUQVRVUyA9IDE7XHJcblxyXG5cdC8vIEZpbHRlciBpbnZhbGlkIGNvbW1hbmRzXHJcblx0aWYgKHZhbHVlID09IG51bGwgfHwgdmFsdWUgPT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHR9XHJcblxyXG5cdGJ0U3RhdGUuY29udGludWl0eSA9IGZhbHNlO1xyXG5cclxuXHRpZiAobW9kZSA+IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiBtb2RlIDw9IENvbW1hbmRUeXBlLk9GRikgeyAvLyBNZWFzdXJlbWVudHNcclxuXHRcdGlmIChtb2RlID09IENvbW1hbmRUeXBlLkNvbnRpbnVpdHkpXHJcblx0XHR7XHJcblx0XHRcdG1vZGUgPSBjb25zdGFudHMuQ29udGludWl0eUltcGw7XHJcblx0XHRcdGJ0U3RhdGUuY29udGludWl0eSA9IHRydWU7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuXHR9XHJcblx0ZWxzZSBpZiAobW9kZSA+IENvbW1hbmRUeXBlLk9GRiAmJiBtb2RlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEKSB7IC8vIEdlbmVyYXRpb25zXHJcblx0XHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuXHRcdFx0Ly8gQ29sZCBqdW5jdGlvbiBub3QgY29uZmlndXJlZFxyXG5cdFx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuXHRcdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdFx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0XHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcblx0XHRkZWZhdWx0OlxyXG5cdFx0XHQvLyBBbGwgdGhlIHNpbXBsZSBjYXNlcyBcclxuXHRcdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG5cdFx0fVxyXG5cclxuXHR9XHJcblx0cmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXaGVuIHRoZSBtZXRlciBpcyBtZWFzdXJpbmcsIG1ha2UgdGhlIG1vZGJ1cyByZXF1ZXN0IG9mIHRoZSB2YWx1ZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSBwYWNrZXRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNZWFzdXJlUmVxdWVzdChtb2RlKSB7XHJcblx0c3dpdGNoIChtb2RlKSB7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fVDpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UZW1wTWVhc3VyZSk7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5Db250aW51aXR5OlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1NTBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTUwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEyMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDUwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzRXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzRXOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLlJ0ZFRlbXBlcmF0dXJlTWVhc3VyZSk7IC8vIFRlbXAtT2htXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5GcmVxdWVuY3k6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5TWVhc3VyZSk7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLlB1bHNlT0ZGTWVhc3VyZSk7IC8vIE9OLU9GRlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTG9hZENlbGw6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuTG9hZENlbGwpO1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLm1BX2FjdGl2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlY6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5tVjpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDYsIE1TQ1JlZ2lzdGVycy5NaW5NZWFzdXJlKTsgLy8gTWluLU1heC1NZWFzXHJcblx0ZGVmYXVsdDpcclxuXHRcdHRocm93IG5ldyBFcnJvcihcIk1vZGUgbm90IG1hbmFnZWQgOlwiICsgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHR9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgbWVhc3VyZSByZWFkIGZyb20gdGhlIG1ldGVyXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBtb2RidXMgcnR1IGFuc3dlciAoRkMzKVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGN1cnJlbnQgbW9kZSBvZiB0aGUgbWV0ZXJcclxuICogQHJldHVybnMge2FycmF5fSBhbiBhcnJheSB3aXRoIGZpcnN0IGVsZW1lbnQgXCJNZWFzdXJlIG5hbWUgKHVuaXRzKVwiOlZhbHVlLCBzZWNvbmQgVGltZXN0YW1wOmFjcXVpc2l0aW9uXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZU1lYXN1cmUoYnVmZmVyLCBtb2RlKSB7XHJcblx0dmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0dmFyIG1lYXMsIG1lYXMyLCBtaW4sIG1heDtcclxuXHJcblx0Ly8gQWxsIG1lYXN1cmVzIGFyZSBmbG9hdFxyXG5cdGlmIChyZXNwb25zZUZDMyA9PSBudWxsKVxyXG5cdFx0cmV0dXJuIHt9O1xyXG5cclxuXHRzd2l0Y2ggKG1vZGUpIHtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcblx0XHRtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuXHRcdHZhciB2YWx1ZSA9IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDA7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiB2YWx1ZSxcclxuXHRcdFx0XCJVbml0XCI6IFwiwrBDXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1NTBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTUwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF80VzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5DdTEwMF80VzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEwMF80VzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OaTEyMF80VzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDEwMF80VzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfM1c6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5QVDUwMF80VzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8zVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF80VzpcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0bWVhczIgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlRlbXBlcmF0dXJlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTApIC8gMTAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG5cdFx0XHRcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUmVzaXN0YW5jZVwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeVZhbHVlXCI6IE1hdGgucm91bmQobWVhczIgKiAxMCkgLyAxMCxcclxuXHRcdFx0XCJTZWNvbmRhcnlVbml0XCI6IFwiT2htc1wiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5Db250aW51aXR5OlxyXG5cdFx0bWVhczIgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkNvbnRpbnVpdHlcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiAobWVhczIgPCBjb25zdGFudHMuQ29udGludWl0eVRocmVzaG9sZE9obXMpID8gMSA6IDAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIk5vbmVcIixcclxuXHRcdFx0XCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIlJlc2lzdGFuY2VcIixcclxuXHRcdFx0XCJTZWNvbmRhcnlWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMyICogMTApIC8gMTAsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VW5pdFwiOiBcIk9obXNcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuRnJlcXVlbmN5OlxyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHQvLyBTZW5zaWJpbGl0w6AgbWFuY2FudGlcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3lcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMCkgLyAxMCxcclxuXHRcdFx0XCJVbml0XCI6IFwiSHpcIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuXHRcdG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHRtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG5cdFx0bWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiQ3VycmVudFwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIm1BXCIsXHJcblx0XHRcdFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiTWF4aW11bVwiOiBNYXRoLnJvdW5kKG1heCAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLlY6XHJcblx0XHRtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG5cdFx0bWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJWXCIsXHJcblx0XHRcdFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiTWF4aW11bVwiOiBNYXRoLnJvdW5kKG1heCAqIDEwMCkgLyAxMDAsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG5cdFx0bWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuXHRcdG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcblx0XHRtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJVbml0XCI6IFwibVZcIixcclxuXHRcdFx0XCJNaW5pbXVtXCI6IE1hdGgucm91bmQobWluICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuUHVsc2VUcmFpbjpcclxuXHRcdG1lYXMgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcblx0XHRtZWFzMiA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuXHRcdC8vIFNvZ2xpYSBlIHNlbnNpYmlsaXTDoCBtYW5jYW50aVxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlB1bHNlIE9OXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogbWVhcyxcclxuXHRcdFx0XCJVbml0XCI6IFwiXCIsXHJcblx0XHRcdFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJQdWxzZSBPRkZcIixcclxuXHRcdFx0XCJTZWNvbmRhcnlWYWx1ZVwiOiBtZWFzMixcclxuXHRcdFx0XCJTZWNvbmRhcnlVbml0XCI6IFwiXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkxvYWRDZWxsOlxyXG5cdFx0bWVhcyA9IE1hdGgucm91bmQobW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKSAqIDEwMDApIC8gMTAwMDtcclxuXHRcdC8vIEtnIG1hbmNhbnRpXHJcblx0XHQvLyBTZW5zaWJpbGl0w6AsIHRhcmEsIHBvcnRhdGEgbWFuY2FudGlcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJJbWJhbGFuY2VcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBtZWFzLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJtVi9WXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRkZWZhdWx0OlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIlVua25vd25cIixcclxuXHRcdFx0XCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDAwKSAvIDEwMDAsXHJcblx0XHRcdFwiVW5pdFwiOiBcIj9cIixcclxuXHRcdFx0XCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHR9O1xyXG5cdH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlYWRzIHRoZSBzdGF0dXMgZmxhZ3MgZnJvbSBtZWFzdXJlbWVudCBtb2RlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3QgdG8gc2VuZFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVF1YWxpdHlCaXRSZXF1ZXN0KG1vZGUpIHtcclxuXHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuTWVhc3VyZUZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IHN0YXR1c1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgdGhlcmUgaXMgbm8gZXJyb3JcclxuICovXHJcbmZ1bmN0aW9uIGlzUXVhbGl0eVZhbGlkKGJ1ZmZlcikge1xyXG5cdHZhciByZXNwb25zZUZDMyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG5cdHJldHVybiAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxMykpID09IDApO1xyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIGdlbmVyYXRpb24gZmxhZ3Mgc3RhdHVzIGZyb20gdGhlIG1ldGVyXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3QgdG8gc2VuZFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUdlblN0YXR1c1JlYWQobW9kZSkge1xyXG5cdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDEsIE1TQ1JlZ2lzdGVycy5HZW5lcmF0aW9uRmxhZ3MpO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2tzIGlmIHRoZSBlcnJvciBiaXQgaXMgTk9UIHNldCBpbiB0aGUgZ2VuZXJhdGlvbiBmbGFnc1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZUZDM1xyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiB0aGVyZSBpcyBubyBlcnJvclxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VHZW5TdGF0dXMoYnVmZmVyLCBtb2RlKSB7XHJcblx0dmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcblx0c3dpdGNoIChtb2RlKSB7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcblx0XHRyZXR1cm4gKChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTUpKSA9PSAwKSAmJiAvLyBHZW4gZXJyb3JcclxuICAgICAgICAgICAgICAgICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE0KSkgPT0gMCk7IC8vIFNlbGYgZ2VuZXJhdGlvbiBJIGNoZWNrXHJcblx0ZGVmYXVsdDpcclxuXHRcdHJldHVybiAocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMDsgLy8gR2VuIGVycm9yXHJcblx0fVxyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgYSBidWZmZXIgd2l0aCB0aGUgbW9kYnVzLXJ0dSByZXF1ZXN0IHRvIGJlIHNlbnQgdG8gU2VuZWNhXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgZ2VuZXJhdGlvbiBtb2RlXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludCB0aGUgdmFsdWUgdG8gc2V0IChtVi9WL0EvSHovwrBDKSBleGNlcHQgZm9yIHB1bHNlcyBudW1fcHVsc2VzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludDIgZnJlcXVlbmN5IGluIEh6XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlU2V0cG9pbnRSZXF1ZXN0KG1vZGUsIHNldHBvaW50LCBzZXRwb2ludDIpIHtcclxuXHR2YXIgVEVNUCwgcmVnaXN0ZXJzO1xyXG5cdHZhciBkdCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuXHR2YXIgZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuXHRtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50KTtcclxuXHRjb25zdCBzcCA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHJcblx0dmFyIGR0SW50ID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG5cdHZhciBkdkludCA9IG5ldyBEYXRhVmlldyhkdEludCk7XHJcblx0bW9kYnVzLnNldFVpbnQzMkxFQlMoZHZJbnQsIDAsIHNldHBvaW50KTtcclxuXHRjb25zdCBzcEludCA9IFtkdkludC5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdkludC5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHJcblx0c3dpdGNoIChtb2RlKSB7XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlZvbHRhZ2VTZXRwb2ludCwgc3ApXTsgLy8gViAvIG1WIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5DdXJyZW50U2V0cG9pbnQsIHNwKV07IC8vIEkgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUlREVGVtcGVyYXR1cmVTZXRwb2ludCwgc3ApXTsgLy8gwrBDIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5UaGVybW9UZW1wZXJhdHVyZVNldHBvaW50LCBzcCldOyAvLyDCsEMgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkxvYWRDZWxsU2V0cG9pbnQsIHNwKV07IC8vIG1WL1Ygc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcblx0XHRkdCA9IG5ldyBBcnJheUJ1ZmZlcig4KTsgLy8gMiBVaW50MzJcclxuXHRcdGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcblx0XHQvLyBTZWUgU2VuZWNhbCBtYW51YWwgbWFudWFsXHJcblx0XHQvLyBNYXggMjBrSFogZ2VuXHJcblx0XHRURU1QID0gTWF0aC5yb3VuZCgyMDAwMCAvIHNldHBvaW50LCAwKTtcclxuXHRcdGR2LnNldFVpbnQzMigwLCBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMVxyXG5cdFx0ZHYuc2V0VWludDMyKDQsIFRFTVAgLSBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMlxyXG5cclxuXHRcdC8vIEJ5dGUtc3dhcHBlZCBsaXR0bGUgZW5kaWFuXHJcblx0XHRyZWdpc3RlcnMgPSBbZHYuZ2V0VWludDE2KDIsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDAsIGZhbHNlKSxcclxuXHRcdFx0ZHYuZ2V0VWludDE2KDYsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDQsIGZhbHNlKV07XHJcblxyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5VElDSzEsIHJlZ2lzdGVycyldO1xyXG5cclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG5cdFx0ZHQgPSBuZXcgQXJyYXlCdWZmZXIoMTIpOyAvLyAzIFVpbnQzMiBcclxuXHRcdGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcblx0XHQvLyBTZWUgU2VuZWNhbCBtYW51YWwgbWFudWFsXHJcblx0XHQvLyBNYXggMjBrSFogZ2VuXHJcblx0XHRURU1QID0gTWF0aC5yb3VuZCgyMDAwMCAvIHNldHBvaW50MiwgMCk7XHJcblxyXG5cdFx0ZHYuc2V0VWludDMyKDAsIHNldHBvaW50LCBmYWxzZSk7IC8vIE5VTV9QVUxTRVNcclxuXHRcdGR2LnNldFVpbnQzMig0LCBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMVxyXG5cdFx0ZHYuc2V0VWludDMyKDgsIFRFTVAgLSBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMlxyXG5cclxuXHRcdHJlZ2lzdGVycyA9IFtkdi5nZXRVaW50MTYoMiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMCwgZmFsc2UpXTtcclxuXHRcdHZhciBwMSA9IG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5QdWxzZXNDb3VudCwgcmVnaXN0ZXJzKTsgLy8gbXVzdCBzcGxpdCBpbiB0d28gdG8gc3RheSA8PSAyMCBieXRlcyBmb3IgdGhlIGZ1bGwgcnR1IHBhY2tldFxyXG4gICAgICAgICAgICBcclxuXHRcdHJlZ2lzdGVycyA9IFsgZHYuZ2V0VWludDE2KDYsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDQsIGZhbHNlKSxcclxuXHRcdFx0ZHYuZ2V0VWludDE2KDEwLCBmYWxzZSksIGR2LmdldFVpbnQxNig4LCBmYWxzZSldO1xyXG5cdFx0dmFyIHAyID0gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeVRJQ0sxLCByZWdpc3RlcnMpO1xyXG5cdFx0cmV0dXJuIFtwMSwgcDJdO1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VUaHJlc2hvbGRfRjpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlRocmVzaG9sZFVfRnJlcSwgc3ApXTsgLy8gVSBtaW4gZm9yIGZyZXEgbWVhc3VyZW1lbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLlNFVF9TZW5zaXRpdml0eV91UzpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlNlbnNpYmlsaXR5X3VTX09GRixcclxuXHRcdFx0W3NwSW50WzBdLCBzcEludFsxXSwgc3BJbnRbMF0sIHNwSW50WzFdXSldOyAvLyB1ViBmb3IgcHVsc2UgdHJhaW4gbWVhc3VyZW1lbnQgdG8gT04gLyBPRkZcclxuXHRjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcblx0XHRyZXR1cm4gW21vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Db2xkSnVuY3Rpb24sIHNwKV07IC8vIHVuY2xlYXIgdW5pdFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuU0VUX1Vsb3c6XHJcblx0XHRtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gY29uc3RhbnRzLk1BWF9VX0dFTik7IC8vIE11c3QgY29udmVydCBWIGludG8gYSAlIDAuLk1BWF9VX0dFTlxyXG5cdFx0dmFyIHNwMiA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdlblVsb3dQZXJjLCBzcDIpXTsgLy8gVSBsb3cgZm9yIGZyZXEgLyBwdWxzZSBnZW5cclxuXHRjYXNlIENvbW1hbmRUeXBlLlNFVF9VaGlnaDpcclxuXHRcdG1vZGJ1cy5zZXRGbG9hdDMyTEVCUyhkdiwgMCwgc2V0cG9pbnQgLyBjb25zdGFudHMuTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcblx0XHR2YXIgc3AzID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cdFx0cmV0dXJuIFttb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR2VuVWhpZ2hQZXJjLCBzcDMpXTsgLy8gVSBoaWdoIGZvciBmcmVxIC8gcHVsc2UgZ2VuICAgICAgICAgICAgXHJcblx0Y2FzZSBDb21tYW5kVHlwZS5TRVRfU2h1dGRvd25EZWxheTpcclxuXHRcdHJldHVybiBbbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlBvd2VyT2ZmRGVsYXksIHNldHBvaW50KV07IC8vIGRlbGF5IGluIHNlY1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG5cdFx0cmV0dXJuIFtdOyAvLyBObyBzZXRwb2ludFxyXG5cdGRlZmF1bHQ6XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJOb3QgaGFuZGxlZFwiKTtcclxuXHR9XHJcblx0cmV0dXJuIFtdO1xyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHNldHBvaW50XHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3RcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlYWQobW9kZSkge1xyXG5cdHN3aXRjaCAobW9kZSkge1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50KTsgLy8gbVYgb3IgViBzZXRwb2ludFxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRTZXRwb2ludCk7IC8vIEEgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlJURFRlbXBlcmF0dXJlU2V0cG9pbnQpOyAvLyDCsEMgc2V0cG9pbnRcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuXHRcdHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UaGVybW9UZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcblx0XHRyZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5VElDSzEpOyAvLyBGcmVxdWVuY3kgc2V0cG9pbnQgKFRJQ0tTKVxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG5cdFx0cmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkxvYWRDZWxsU2V0cG9pbnQpOyAvLyBtVi9WIHNldHBvaW50XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5OT05FX1VOS05PV046XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcblx0XHRyZXR1cm4gbnVsbDtcclxuXHR9XHJcblx0dGhyb3cgbmV3IEVycm9yKFwiTm90IGhhbmRsZWRcIik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZXMgdGhlIGFuc3dlciBhYm91dCBTZXRwb2ludFJlYWRcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVnaXN0ZXJzIEZDMyBwYXJzZWQgYW5zd2VyXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IHRoZSBsYXN0IHNldHBvaW50XHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZVNldHBvaW50UmVhZChidWZmZXIsIG1vZGUpIHtcclxuXHQvLyBSb3VuZCB0byB0d28gZGlnaXRzXHJcblx0dmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG5cdHZhciByb3VuZGVkID0gTWF0aC5yb3VuZChtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVnaXN0ZXJzLCAwKSAqIDEwMCkgLyAxMDA7XHJcblxyXG5cdHN3aXRjaCAobW9kZSkge1xyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0XCJEZXNjcmlwdGlvblwiOiBcIkN1cnJlbnRcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiByb3VuZGVkLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJtQVwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogcm91bmRlZCxcclxuXHRcdFx0XCJVbml0XCI6IFwiVlwiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHJvdW5kZWQsXHJcblx0XHRcdFwiVW5pdFwiOiBcIm1WXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJJbWJhbGFuY2VcIixcclxuXHRcdFx0XCJWYWx1ZVwiOiByb3VuZGVkLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJtVi9WXCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcblx0Y2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuXHRcdHZhciB0aWNrMSA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlZ2lzdGVycywgMCk7XHJcblx0XHR2YXIgdGljazIgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZWdpc3RlcnMsIDQpO1xyXG5cdFx0dmFyIGZPTiA9IDAuMDtcclxuXHRcdHZhciBmT0ZGID0gMC4wO1xyXG5cdFx0aWYgKHRpY2sxICE9IDApXHJcblx0XHRcdGZPTiA9IE1hdGgucm91bmQoMSAvICh0aWNrMSAqIDIgLyAyMDAwMC4wKSAqIDEwLjApIC8gMTA7IC8vIE5lZWQgb25lIGRlY2ltYWwgcGxhY2UgZm9yIEhaXHJcblx0XHRpZiAodGljazIgIT0gMClcclxuXHRcdFx0Zk9GRiA9IE1hdGgucm91bmQoMSAvICh0aWNrMiAqIDIgLyAyMDAwMC4wKSAqIDEwLjApIC8gMTA7IC8vIE5lZWQgb25lIGRlY2ltYWwgcGxhY2UgZm9yIEhaXHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcIkRlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5IE9OXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogZk9OLFxyXG5cdFx0XHRcIlVuaXRcIjogXCJIelwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5IE9GRlwiLFxyXG5cdFx0XHRcIlNlY29uZGFyeVZhbHVlXCI6IGZPRkYsXHJcblx0XHRcdFwiU2Vjb25kYXJ5VW5pdFwiOiBcIkh6XCIsXHJcblx0XHRcdFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0fTtcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG5cdGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuXHRjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG5cdFx0XHRcIlZhbHVlXCI6IHJvdW5kZWQsXHJcblx0XHRcdFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0ZGVmYXVsdDpcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcblx0XHRcdFwiVmFsdWVcIjogcm91bmRlZCxcclxuXHRcdFx0XCJVbml0XCI6IFwiP1wiLFxyXG5cdFx0XHRcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdH07XHJcblx0fVxyXG5cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7XHJcblx0TVNDUmVnaXN0ZXJzLCBtYWtlU2VyaWFsTnVtYmVyLCBtYWtlQ3VycmVudE1vZGUsIG1ha2VCYXR0ZXJ5TGV2ZWwsIHBhcnNlQmF0dGVyeSwgcGFyc2VTZXJpYWxOdW1iZXIsXHJcblx0cGFyc2VDdXJyZW50TW9kZSwgbWFrZU1vZGVSZXF1ZXN0LCBtYWtlTWVhc3VyZVJlcXVlc3QsIHBhcnNlTWVhc3VyZSwgbWFrZVF1YWxpdHlCaXRSZXF1ZXN0LCBpc1F1YWxpdHlWYWxpZCxcclxuXHRtYWtlR2VuU3RhdHVzUmVhZCwgcGFyc2VHZW5TdGF0dXMsIG1ha2VTZXRwb2ludFJlcXVlc3QsIG1ha2VTZXRwb2ludFJlYWQsIHBhcnNlU2V0cG9pbnRSZWFkXHJcbn07IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5cclxubGV0IHNsZWVwID0gbXMgPT4gbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcbmxldCB3YWl0Rm9yID0gYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihmKSB7XHJcblx0d2hpbGUgKCFmKCkpIGF3YWl0IHNsZWVwKDEwMCArIE1hdGgucmFuZG9tKCkgKiAyNSk7XHJcblx0cmV0dXJuIGYoKTtcclxufTtcclxuXHJcbmxldCB3YWl0Rm9yVGltZW91dCA9IGFzeW5jIGZ1bmN0aW9uIHdhaXRGb3IoZiwgdGltZW91dFNlYykge1xyXG5cdHZhciB0b3RhbFRpbWVNcyA9IDA7XHJcblx0d2hpbGUgKCFmKCkgJiYgdG90YWxUaW1lTXMgPCB0aW1lb3V0U2VjICogMTAwMCkge1xyXG5cdFx0dmFyIGRlbGF5TXMgPSAxMDAgKyBNYXRoLnJhbmRvbSgpICogMjU7XHJcblx0XHR0b3RhbFRpbWVNcyArPSBkZWxheU1zO1xyXG5cdFx0YXdhaXQgc2xlZXAoZGVsYXlNcyk7XHJcblx0fVxyXG5cdHJldHVybiBmKCk7XHJcbn07XHJcblxyXG4vLyBUaGVzZSBmdW5jdGlvbnMgbXVzdCBleGlzdCBzdGFuZC1hbG9uZSBvdXRzaWRlIENvbW1hbmQgb2JqZWN0IGFzIHRoaXMgb2JqZWN0IG1heSBjb21lIGZyb20gSlNPTiB3aXRob3V0IHRoZW0hXHJcbmZ1bmN0aW9uIGlzR2VuZXJhdGlvbihjdHlwZSkge1xyXG5cdHJldHVybiAoY3R5cGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgY3R5cGUgPCBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzTWVhc3VyZW1lbnQoY3R5cGUpIHtcclxuXHRyZXR1cm4gKGN0eXBlID4gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOICYmIGN0eXBlIDwgQ29tbWFuZFR5cGUuUkVTRVJWRUQgfHwgY3R5cGUgPT0gQ29tbWFuZFR5cGUuQ29udGludWl0eSk7XHJcbn1cclxuZnVuY3Rpb24gaXNTZXR0aW5nKGN0eXBlKSB7XHJcblx0cmV0dXJuIChjdHlwZSA9PSBDb21tYW5kVHlwZS5PRkYgfHwgY3R5cGUgPiBDb21tYW5kVHlwZS5TRVRUSU5HX1JFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc1ZhbGlkKGN0eXBlKSB7XHJcblx0cmV0dXJuIChpc01lYXN1cmVtZW50KGN0eXBlKSB8fCBpc0dlbmVyYXRpb24oY3R5cGUpIHx8IGlzU2V0dGluZyhjdHlwZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogSGVscGVyIGZ1bmN0aW9uIHRvIGNvbnZlcnQgYSB2YWx1ZSBpbnRvIGFuIGVudW0gdmFsdWVcclxuICogXHJcbiAqIEBwYXJhbSB7dHlwZX0gZW51bXR5cGVcclxuICogQHBhcmFtIHtudW1iZXJ9IGVudW12YWx1ZVxyXG4gKi9cclxuZnVuY3Rpb24gUGFyc2UoZW51bXR5cGUsIGVudW12YWx1ZSkge1xyXG5cdGZvciAodmFyIGVudW1OYW1lIGluIGVudW10eXBlKSB7XHJcblx0XHRpZiAoZW51bXR5cGVbZW51bU5hbWVdID09IGVudW12YWx1ZSkge1xyXG5cdFx0XHRyZXR1cm4gZW51bXR5cGVbZW51bU5hbWVdO1xyXG5cdFx0fVxyXG5cdH1cclxuXHRyZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEhlbHBlciBmdW5jdGlvbiB0byBkdW1wIGFycmF5YnVmZmVyIGFzIGhleCBzdHJpbmdcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBidWYyaGV4KGJ1ZmZlcikgeyAvLyBidWZmZXIgaXMgYW4gQXJyYXlCdWZmZXJcclxuXHRyZXR1cm4gWy4uLm5ldyBVaW50OEFycmF5KGJ1ZmZlcildXHJcblx0XHQubWFwKHggPT4geC50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxyXG5cdFx0LmpvaW4oXCIgXCIpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoZXgyYnVmKGlucHV0KSB7XHJcblx0aWYgKHR5cGVvZiBpbnB1dCAhPT0gXCJzdHJpbmdcIikge1xyXG5cdFx0dGhyb3cgbmV3IFR5cGVFcnJvcihcIkV4cGVjdGVkIGlucHV0IHRvIGJlIGEgc3RyaW5nXCIpO1xyXG5cdH1cclxuXHR2YXIgaGV4c3RyID0gaW5wdXQucmVwbGFjZSgvXFxzKy9nLCBcIlwiKTtcclxuXHRpZiAoKGhleHN0ci5sZW5ndGggJSAyKSAhPT0gMCkge1xyXG5cdFx0dGhyb3cgbmV3IFJhbmdlRXJyb3IoXCJFeHBlY3RlZCBzdHJpbmcgdG8gYmUgYW4gZXZlbiBudW1iZXIgb2YgY2hhcmFjdGVyc1wiKTtcclxuXHR9XHJcblxyXG5cdGNvbnN0IHZpZXcgPSBuZXcgVWludDhBcnJheShoZXhzdHIubGVuZ3RoIC8gMik7XHJcblxyXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgaGV4c3RyLmxlbmd0aDsgaSArPSAyKSB7XHJcblx0XHR2aWV3W2kgLyAyXSA9IHBhcnNlSW50KGhleHN0ci5zdWJzdHJpbmcoaSwgaSArIDIpLCAxNik7XHJcblx0fVxyXG5cclxuXHRyZXR1cm4gdmlldy5idWZmZXI7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBzbGVlcCwgd2FpdEZvciwgd2FpdEZvclRpbWVvdXQsIGlzR2VuZXJhdGlvbiwgaXNNZWFzdXJlbWVudCwgaXNTZXR0aW5nLCBpc1ZhbGlkLCBQYXJzZSwgYnVmMmhleCwgaGV4MmJ1ZiB9OyJdfQ==
