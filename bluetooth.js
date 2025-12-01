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