(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.MSC = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
'use strict';

/**
 *  Bluetooth handling module, including main state machine loop.
 *  This module interacts with browser for bluetooth comunications and pairing, and with SenecaMSC object.
 */

var APIState = require('./classes/APIState');
var log = require('loglevel');
var constants = require('./constants');
var utils = require('./utils');
var senecaModule = require('./classes/SenecaMSC');
var modbus = require('./modbusRtu');
var testData = require('./modbusTestData');

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
    ServiceUuid: '0003cdd0-0000-1000-8000-00805f9b0131', // bluetooth modbus RTU service for Seneca MSC
    ModbusAnswerUuid: '0003cdd1-0000-1000-8000-00805f9b0131',     // modbus RTU answers
    ModbusRequestUuid: '0003cdd2-0000-1000-8000-00805f9b0131'    // modbus RTU requests
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
        var packet = {'request': utils.buf2hex(command), 'answer': utils.buf2hex(answer)};
        var packets = window.localStorage.getItem("ModbusRTUtrace");
        if (packets == null)
        {
            packets = []; // initialize array
        }
        else
        {
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
    var DELAY_MS = (simulation?20:750); // Update the status every X ms.
    var TIMEOUT_MS = (simulation?1000:30000); // Give up some operations after X ms.
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

    log.debug("\State:" + btState.state);
    switch (btState.state) {
        case State.NOT_CONNECTED: // initial state on Start()
            if (simulation){
                nextAction = fakePairDevice;
            } else {
                nextAction = btPairDevice;
            }
            break;
        case State.CONNECTING: // waiting for connection to complete
            nextAction = undefined;
            break;
        case State.DEVICE_PAIRED: // connection complete, acquire meter state
            if (simulation){
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
                if (simulation){
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
                if (simulation){
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
        var packet, response, startGen;

        if (command == null) {
            return;
        }
        btState.state = State.BUSY;
        btState.stats["commands"]++;

        log.info('\t\tExecuting command :' + command);

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
    if (btState.command?.type != null)
    {
        stateHex = (btState.command.type).toString(16);
    }
    // Add trailing 0
    while(stateHex.length < 2)
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
                     '19 03 00 64 00 01 c6 0d' : '19 03 02 00' + getExpectedStateHex() +' $$$$', // Current state
                     'default 03' : '19 03 06 0001 0001 0001 $$$$', // default answer for FC3
                     'default 10' : '19 10 00 d4 00 02 0001 0001 $$$$'}; // default answer for FC10

    // Start with the default answer
    var responseHex = forgedAnswers['default ' + commandHex.split(' ')[1]];

    // Do we have a forged answer?
    if (forgedAnswers[commandHex] != undefined) {
        responseHex = forgedAnswers[commandHex];
    }
    else
    {
        // Look into registered traces
        found = [];
        for(var trace in testData.testTraces) {
            if (trace["request"] === commandHex) {
                found.push(trace["answer"]);
            }
        }
        if (found.length > 0) {
            // Select a random answer from the registered trace
            responseHex = found[Math.floor((Math.random()*found.length))];
        }
    }
    
    // Compute CRC if needed
    if (responseHex.includes("$$$$")) {
        responseHex = responseHex.replace('$$$$','');
        var crc = modbus.crc16(new Uint8Array(utils.hex2buf(responseHex))).toString(16);
        while(crc.length < 4)
            crc = "0" + crc;
        responseHex = responseHex + crc.substring(2,4) + crc.substring(0,2);
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
        log.info('\t\tSerial number:' + btState.meter.serial);

        btState.meter.mode = await senecaMSC.getCurrentMode();
        log.debug('\t\tCurrent mode:' + btState.meter.mode);

        btState.meter.battery = await senecaMSC.getBatteryVoltage();
        log.debug('\t\tBattery (V):' + btState.meter.battery);

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
                btState.btDevice.removeEventListener('gattserverdisconnected', onDisconnected);
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
        log.debug('<< ' + utils.buf2hex(value.buffer));
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
        if (typeof (navigator.bluetooth?.getAvailability) == 'function') {
            const availability = await navigator.bluetooth.getAvailability();
            if (!availability) {
                log.error("Bluetooth not available in browser.");
                throw new Error("Browser does not provide bluetooth");
            }
        }
        var device = null;

        // Do we already have permission?
        if (typeof (navigator.bluetooth?.getDevices) == 'function'
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
                    filters: [{ namePrefix: 'MSC' }],
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
        var device = { name : "FakeBTDevice", gatt: {connected:true}};
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
            device.addEventListener('gattserverdisconnected', onDisconnected);
            try {
                if (btState.btService?.connected) {
                    btState.btService.disconnect();
                    btState.btService = null;
                    await utils.sleep(100);
                }
            } catch (err) { }

            server = await device.gatt.connect();
            log.debug('> Found GATT server');
        }
        else {
            log.debug('GATT already connected');
            server = device.gatt;
        }

        btState.btService = await server.getPrimaryService(BlueToothMSC.ServiceUuid);
        if (btState.btService == null)
            throw new Error("GATT Service request failed");
        log.debug('> Found Serial service');
        btState.charWrite = await btState.btService.getCharacteristic(BlueToothMSC.ModbusRequestUuid);
        log.debug('> Found write characteristic');
        btState.charRead = await btState.btService.getCharacteristic(BlueToothMSC.ModbusAnswerUuid);
        log.debug('> Found read characteristic');
        btState.response = null;
        btState.charRead.addEventListener('characteristicvaluechanged', handleNotifications);
        btState.charRead.startNotifications();
        log.info('> Bluetooth interfaces ready.');
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
            device['gatt']['connected']=true;
            log.debug('> Found GATT server');
        }
        else {
            log.debug('GATT already connected');
            server = device.gatt;
        }

        btState.btService = {};
        log.debug('> Found Serial service');
        btState.charWrite = {};
        log.debug('> Found write characteristic');
        btState.charRead = {};
        log.debug('> Found read characteristic');
        btState.response = null;
        log.info('> Bluetooth interfaces ready.');
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

            if (btState.meter.isGeneration())
            {
                var setpoints = await senecaMSC.getSetpoints(btState.meter.mode);
                btState.lastSetpoint = setpoints;
            }

            if (btState.meter.isMeasurement())
            {
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

module.exports = {stateMachine, SendAndResponse, SetSimulation};
},{"./classes/APIState":2,"./classes/SenecaMSC":6,"./constants":7,"./modbusRtu":10,"./modbusTestData":11,"./utils":14,"loglevel":12}],2:[function(require,module,exports){
var constants = require('../constants');
var MeterState = require('./MeterState');

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
            "forceDeviceSelection" : true
        }
    }
}

let btState = new APIState();

module.exports = { APIState, btState }
},{"../constants":7,"./MeterState":5}],3:[function(require,module,exports){
var constants = require('../constants');
var utils = require('../utils');
var CommandType = constants.CommandType;

const MAX_U_GEN = 27.0; // maximum voltage 

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

    static CreateNoSP(ctype)
    {
        var cmd = new Command(ctype);
        return cmd;
    }
    static CreateOneSP(ctype, setpoint)
    {
        var cmd = new Command(ctype);
        cmd.setpoint = parseFloat(setpoint);
        return cmd;
    }
    static CreateTwoSP(ctype, set1, set2)
    {
        var cmd = new Command(ctype);
        cmd.setpoint = parseFloat(set1);
        cmd.setpoint2 = parseFloat(set2);;
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
                return { 'Temperature (°C)': 0.0 };
            case CommandType.GEN_V:
                return { 'Voltage (V)': 0.0 };
            case CommandType.GEN_mV:
                return { 'Voltage (mV)': 0.0 };
            case CommandType.GEN_mA_active:
            case CommandType.GEN_mA_passive:
                return { 'Current (mA)': 0.0 };
            case CommandType.GEN_LoadCell:
                return { 'Imbalance (mV/V)': 0.0 };
            case CommandType.GEN_Frequency:
                return { 'Frequency (Hz)': 0.0 };
            case CommandType.GEN_PulseTrain:
                return { 'Pulses count': 0, 'Frequency (Hz)': 0.0 };
            case CommandType.SET_UThreshold_F:
                return { 'Uthreshold (V)': 2.0 };
            case CommandType.SET_Sensitivity_uS:
                return { 'Sensibility (uS)': 2.0 };
            case CommandType.SET_ColdJunction:
                return { 'Cold junction compensation': 0.0 };
            case CommandType.SET_Ulow:
                return { 'U low (V)': 0.0 / MAX_U_GEN };
            case CommandType.SET_Uhigh:
                return { 'U high (V)': 5.0 / MAX_U_GEN };
            case CommandType.SET_ShutdownDelay:
                return { 'Delay (s)': 60 * 5 };
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
class CommandResult
{
    value = 0.0;
    success = false;
    message = "";
    unit = "";
    secondary_value = 0.0;
    secondary_unit = "";
}

module.exports = CommandResult;
},{}],5:[function(require,module,exports){
var constants = require('../constants');

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
'use strict';

/**
 *  This module contains the SenecaMSC object, which provides the main operations for bluetooth module.
 *  It uses the modbus helper functions from senecaModbus / modbusRtu to interact with the meter with SendAndResponse function
 */
var log = require('loglevel');
var utils = require('../utils');
var senecaMB = require('../senecaModbus');
var modbus = require('../modbusRtu');
var constants = require('../constants');

var CommandType = constants.CommandType;
var ResultCode = constants.ResultCode;

const RESET_POWER_OFF = 6;
const SET_POWER_OFF = 7;
const CLEAR_AVG_MIN_MAX = 5;
const PULSE_CMD = 9;

class SenecaMSC
{
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
    async getGenQualityValid(current_mode)
    {
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
        var response = await this.SendAndResponse(senecaMB.makeSetpointRequest(command_type, setpoint, setpoint2));
        if (response != null && !modbus.parseFC16checked(response, 0)) {
            return ResultCode.FAILED_SHOULD_RETRY;
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
        var response = await this.SendAndResponse(startGen);
        return ResultCode.SUCCESS;
    }

    /**
     * Changes the current mode on the meter
     * May throw ModbusError
     * @param {CommandType} command_type the new mode to set the meter in
     * @returns {ResultCode} result of the operation
     */
    async changeMode(command_type)
    {
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

module.exports = {SenecaMSC};
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
    NOT_CONNECTED: 'Not connected',
    CONNECTING: 'Bluetooth device pairing...',
    DEVICE_PAIRED: 'Device paired',
    SUBSCRIBING: 'Bluetooth interfaces connecting...',
    IDLE: 'Idle',
    BUSY: 'Busy',
    ERROR: 'Error',
    STOPPING: 'Closing BT interfaces...',
    STOPPED: 'Stopped',
    METER_INIT: 'Meter connected',
    METER_INITIALIZING: 'Reading meter state...'
};

const ResultCode = {
    FAILED_NO_RETRY: 1,
    FAILED_SHOULD_RETRY: 2,
    SUCCESS: 0
}

module.exports = {State, CommandType, ResultCode }
},{}],8:[function(require,module,exports){
'use strict';

const log = require("loglevel");
const constants = require('./constants');
const APIState = require('./classes/APIState');
const Command = require('./classes/Command');
const PublicAPI =require('./meterPublicAPI');
const TestData =require('./modbusTestData');

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

var CommandResult = require('./classes/CommandResult');
var APIState = require('./classes/APIState');
var constants = require('./constants');
var bluetooth = require('./bluetooth');
var utils = require('./utils');
var log = require('loglevel');
var meterApi = require('./meterApi');

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
    let command2 =meterApi.Command.CreateTwoSP(command.type, command.setpoint, command.setpoint2);
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

    if (command == null)
    {
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
    if (command.error || command.pending)  
    {
        cr.success = false;
        cr.message = "Error while executing the command."
        log.warn(cr.message);
        
        // Reset the active command
        btState.command = null;
        return cr;
    }

    // State is updated by execute command, so we can use btState right away
    if (utils.isGeneration(command.type))
    {
        cr.value = btState.lastSetpoint["Value"];
        cr.unit = btState.lastSetpoint["Unit"];
    }
    else if (utils.isMeasurement(command.type))
    {
        cr.value = btState.lastMeasure["Value"];
        cr.unit = btState.lastMeasure["Unit"];
        cr.secondary_value = btState.lastMeasure["SecondaryValue"];
        cr.secondary_unit = btState.lastMeasure["SecondaryUnit"];
    }
    else
    {
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
async function Pair(forceSelection=false) {
    log.info("Pair("+forceSelection+") called...");
    
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

    while(btState.started || (btState.state != State.STOPPED && btState.state != State.NOT_CONNECTED))
    {
        btState.stopRequest = true;    
        await utils.sleep(100);
    }
    btState.command = null;
    btState.stopRequest = false;
    log.warn("Stopped on request.");
    return true;
}

module.exports = {Stop,Pair,Execute,ExecuteJSON,SimpleExecute,SimpleExecuteJSON,GetState,GetStateJSON}
},{"./bluetooth":1,"./classes/APIState":2,"./classes/CommandResult":4,"./constants":7,"./meterApi":8,"./utils":14,"loglevel":12}],10:[function(require,module,exports){
'use strict';

/******************************** MODBUS RTU handling ***********************************************/

var log = require('loglevel');

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

    // add crc bytes to buffer
    dv.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
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
    var contents = [];

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
    var contents = [];

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

module.exports = { makeFC3, getFloat32LEBS, makeFC16, setFloat32LEBS, setUint32LEBS, parseFC3, parseFC16, parseFC16checked, ModbusError, SENECA_MB_SLAVE_ID, getUint32LEBS, crc16}
},{"loglevel":12}],11:[function(require,module,exports){
'use strict';

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
      "request": "19 10 00 d4 00 02 04 00 00 41 20 ff ff",
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
      "request": "19 10 00 d4 00 02 04 66 66 40 86 ff ff",
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
    }
  ]

function uniqBy(a, key) {
    var seen = {};
    return a.filter(function (item) {
        var k = key(item);
        return seen.hasOwnProperty(k) ? false : (seen[k] = true);
    })
}

function sameMessage(trace) {
    return trace["request"] + " -> " + trace["answer"];
}

function GetJsonTraces() {
    testTraces = uniqBy(testTraces, sameMessage);
    return JSON.stringify(testTraces);
}

module.exports = { testTraces, GetJsonTraces }
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
'use strict';

/******************************* MODBUS RTU FUNCTIONS FOR SENECA **********************/

var modbus = require('./modbusRtu');
var constants = require('./constants');
var utils = require('./utils');

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
            var value = Math.round(meas * 100) / 100
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
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.VoltageSetpoint, sp); // V / mV setpoint
        case CommandType.GEN_mA_active:
        case CommandType.GEN_mA_passive:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CurrentSetpoint, sp); // I setpoint
        case CommandType.GEN_Cu50_3W:
        case CommandType.GEN_Cu50_2W:
        case CommandType.GEN_Cu100_2W:
        case CommandType.GEN_Ni100_2W:
        case CommandType.GEN_Ni120_2W:
        case CommandType.GEN_PT100_2W:
        case CommandType.GEN_PT500_2W:
        case CommandType.GEN_PT1000_2W:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.RTDTemperatureSetpoint, sp); // °C setpoint
        case CommandType.GEN_THERMO_B:
        case CommandType.GEN_THERMO_E:
        case CommandType.GEN_THERMO_J:
        case CommandType.GEN_THERMO_K:
        case CommandType.GEN_THERMO_L:
        case CommandType.GEN_THERMO_N:
        case CommandType.GEN_THERMO_R:
        case CommandType.GEN_THERMO_S:
        case CommandType.GEN_THERMO_T:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ThermoTemperatureSetpoint, sp); // °C setpoint
        case CommandType.GEN_LoadCell:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.LoadCellSetpoint, sp); // mV/V setpoint
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

            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.FrequencyTICK1, registers);

        case CommandType.GEN_PulseTrain:
            dt = new ArrayBuffer(12); // 3 Uint32 
            dv = new DataView(dt);

            // See Senecal manual manual
            // Max 20kHZ gen
            TEMP = Math.round(20000 / setpoint2, 0);

            dv.setUint32(0, setpoint, false); // NUM_PULSES
            dv.setUint32(4, Math.floor(TEMP / 2), false); // TICK1
            dv.setUint32(8, TEMP - Math.floor(TEMP / 2), false); // TICK2

            registers = [dv.getUint16(2, false), dv.getUint16(0, false),
            dv.getUint16(6, false), dv.getUint16(4, false),
            dv.getUint16(10, false), dv.getUint16(8, false)];

            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.PulsesCount, registers);
        case CommandType.SET_UThreshold_F:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ThresholdU_Freq, sp); // U min for freq measurement
        case CommandType.SET_Sensitivity_uS:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.Sensibility_uS_OFF,
                [spInt[0], spInt[1], spInt[0], spInt[1]]); // uV for pulse train measurement to ON / OFF
        case CommandType.SET_ColdJunction:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ColdJunction, sp); // unclear unit
        case CommandType.SET_Ulow:
            modbus.setFloat32LEBS(dv, 0, setpoint / MAX_U_GEN); // Must convert V into a % 0..MAX_U_GEN
            var sp2 = [dv.getUint16(0, false), dv.getUint16(2, false)];
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GenUlowPerc, sp2); // U low for freq / pulse gen
        case CommandType.SET_Uhigh:
            modbus.setFloat32LEBS(dv, 0, setpoint / MAX_U_GEN); // Must convert V into a % 0..MAX_U_GEN
            var sp2 = [dv.getUint16(0, false), dv.getUint16(2, false)];
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GenUhighPerc, sp2); // U high for freq / pulse gen            
        case CommandType.SET_ShutdownDelay:
            return modbus.makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.PowerOffDelay, setpoint); // delay in sec
        case CommandType.OFF:
            return null; // No setpoint
        default:
            throw new Error("Not handled");
    }
    return null;
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
    makeGenStatusRead, parseGenStatus, makeSetpointRequest, makeSetpointRead, parseSetpointRead}
},{"./constants":7,"./modbusRtu":10,"./utils":14}],14:[function(require,module,exports){
var constants = require('./constants');
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
        .map(x => x.toString(16).padStart(2, '0'))
        .join(' ');
}

function hex2buf (input) {
    if (typeof input !== 'string') {
        throw new TypeError('Expected input to be a string')
    }
    var hexstr = input.replace(/\s+/g, '');
    if ((hexstr.length % 2) !== 0) {
        throw new RangeError('Expected string to be an even number of characters')
    }

    const view = new Uint8Array(hexstr.length / 2)

    for (let i = 0; i < hexstr.length; i += 2) {
        view[i / 2] = parseInt(hexstr.substring(i, i + 2), 16)
    }

    return view.buffer
}

module.exports = { sleep, waitFor, waitForTimeout, isGeneration, isMeasurement, isSetting, isValid, Parse, buf2hex, hex2buf };
},{"./constants":7}]},{},[8])(8)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY2xhc3Nlcy9TZW5lY2FNU0MuanMiLCJjb25zdGFudHMuanMiLCJtZXRlckFwaS5qcyIsIm1ldGVyUHVibGljQVBJLmpzIiwibW9kYnVzUnR1LmpzIiwibW9kYnVzVGVzdERhdGEuanMiLCJub2RlX21vZHVsZXMvbG9nbGV2ZWwvbGliL2xvZ2xldmVsLmpzIiwic2VuZWNhTW9kYnVzLmpzIiwidXRpbHMuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4b0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbFJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMVBBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDelFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMTVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6U0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25wQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKXtmdW5jdGlvbiByKGUsbix0KXtmdW5jdGlvbiBvKGksZil7aWYoIW5baV0pe2lmKCFlW2ldKXt2YXIgYz1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlO2lmKCFmJiZjKXJldHVybiBjKGksITApO2lmKHUpcmV0dXJuIHUoaSwhMCk7dmFyIGE9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitpK1wiJ1wiKTt0aHJvdyBhLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsYX12YXIgcD1uW2ldPXtleHBvcnRzOnt9fTtlW2ldWzBdLmNhbGwocC5leHBvcnRzLGZ1bmN0aW9uKHIpe3ZhciBuPWVbaV1bMV1bcl07cmV0dXJuIG8obnx8cil9LHAscC5leHBvcnRzLHIsZSxuLHQpfXJldHVybiBuW2ldLmV4cG9ydHN9Zm9yKHZhciB1PVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmUsaT0wO2k8dC5sZW5ndGg7aSsrKW8odFtpXSk7cmV0dXJuIG99cmV0dXJuIHJ9KSgpIiwiJ3VzZSBzdHJpY3QnO1xyXG5cclxuLyoqXHJcbiAqICBCbHVldG9vdGggaGFuZGxpbmcgbW9kdWxlLCBpbmNsdWRpbmcgbWFpbiBzdGF0ZSBtYWNoaW5lIGxvb3AuXHJcbiAqICBUaGlzIG1vZHVsZSBpbnRlcmFjdHMgd2l0aCBicm93c2VyIGZvciBibHVldG9vdGggY29tdW5pY2F0aW9ucyBhbmQgcGFpcmluZywgYW5kIHdpdGggU2VuZWNhTVNDIG9iamVjdC5cclxuICovXHJcblxyXG52YXIgQVBJU3RhdGUgPSByZXF1aXJlKCcuL2NsYXNzZXMvQVBJU3RhdGUnKTtcclxudmFyIGxvZyA9IHJlcXVpcmUoJ2xvZ2xldmVsJyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XHJcbnZhciBzZW5lY2FNb2R1bGUgPSByZXF1aXJlKCcuL2NsYXNzZXMvU2VuZWNhTVNDJyk7XHJcbnZhciBtb2RidXMgPSByZXF1aXJlKCcuL21vZGJ1c1J0dScpO1xyXG52YXIgdGVzdERhdGEgPSByZXF1aXJlKCcuL21vZGJ1c1Rlc3REYXRhJyk7XHJcblxyXG52YXIgYnRTdGF0ZSA9IEFQSVN0YXRlLmJ0U3RhdGU7XHJcbnZhciBTdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZTtcclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG52YXIgUmVzdWx0Q29kZSA9IGNvbnN0YW50cy5SZXN1bHRDb2RlO1xyXG52YXIgc2ltdWxhdGlvbiA9IGZhbHNlO1xyXG52YXIgbG9nZ2luZyA9IGZhbHNlO1xyXG4vKlxyXG4gKiBCbHVldG9vdGggY29uc3RhbnRzXHJcbiAqL1xyXG5jb25zdCBCbHVlVG9vdGhNU0MgPSB7XHJcbiAgICBTZXJ2aWNlVXVpZDogJzAwMDNjZGQwLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMScsIC8vIGJsdWV0b290aCBtb2RidXMgUlRVIHNlcnZpY2UgZm9yIFNlbmVjYSBNU0NcclxuICAgIE1vZGJ1c0Fuc3dlclV1aWQ6ICcwMDAzY2RkMS0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzEnLCAgICAgLy8gbW9kYnVzIFJUVSBhbnN3ZXJzXHJcbiAgICBNb2RidXNSZXF1ZXN0VXVpZDogJzAwMDNjZGQyLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMScgICAgLy8gbW9kYnVzIFJUVSByZXF1ZXN0c1xyXG59O1xyXG5cclxuXHJcbi8qKlxyXG4gKiBTZW5kIHRoZSBtZXNzYWdlIHVzaW5nIEJsdWV0b290aCBhbmQgd2FpdCBmb3IgYW4gYW5zd2VyXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGNvbW1hbmQgbW9kYnVzIFJUVSBwYWNrZXQgdG8gc2VuZFxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IHRoZSBtb2RidXMgUlRVIGFuc3dlclxyXG4gKi9cclxuIGFzeW5jIGZ1bmN0aW9uIFNlbmRBbmRSZXNwb25zZShjb21tYW5kKSB7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgPT0gbnVsbClcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuXHJcbiAgICBsb2cuZGVidWcoXCI+PiBcIiArIHV0aWxzLmJ1ZjJoZXgoY29tbWFuZCkpO1xyXG5cclxuICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcInJlcXVlc3RzXCJdKys7XHJcblxyXG4gICAgdmFyIHN0YXJ0VGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG4gICAgaWYgKHNpbXVsYXRpb24pIHtcclxuICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gZmFrZVJlc3BvbnNlKGNvbW1hbmQpO1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDUpO1xyXG4gICAgfVxyXG4gICAgZWxzZSB7XHJcbiAgICAgICAgYXdhaXQgYnRTdGF0ZS5jaGFyV3JpdGUud3JpdGVWYWx1ZVdpdGhvdXRSZXNwb25zZShjb21tYW5kKTtcclxuICAgICAgICB3aGlsZSAoYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkcgfHxcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5CVVNZKSB7XHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIGJyZWFrO1xyXG4gICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzUpKTtcclxuICAgICAgICB9ICAgIFxyXG4gICAgfVxyXG4gICAgXHJcbiAgICB2YXIgZW5kVGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG5cclxuICAgIHZhciBhbnN3ZXIgPSBidFN0YXRlLnJlc3BvbnNlPy5zbGljZSgpO1xyXG4gICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICBcclxuICAgIC8vIExvZyB0aGUgcGFja2V0c1xyXG4gICAgaWYgKGxvZ2dpbmcpIHtcclxuICAgICAgICB2YXIgcGFja2V0ID0geydyZXF1ZXN0JzogdXRpbHMuYnVmMmhleChjb21tYW5kKSwgJ2Fuc3dlcic6IHV0aWxzLmJ1ZjJoZXgoYW5zd2VyKX07XHJcbiAgICAgICAgdmFyIHBhY2tldHMgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oXCJNb2RidXNSVFV0cmFjZVwiKTtcclxuICAgICAgICBpZiAocGFja2V0cyA9PSBudWxsKVxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgcGFja2V0cyA9IFtdOyAvLyBpbml0aWFsaXplIGFycmF5XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2VcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIHBhY2tldHMgPSBKU09OLnBhcnNlKHBhY2tldHMpOyAvLyBSZXN0b3JlIHRoZSBqc29uIHBlcnNpc3RlZCBvYmplY3RcclxuICAgICAgICB9XHJcbiAgICAgICAgcGFja2V0cy5wdXNoKHBhY2tldCk7IC8vIEFkZCB0aGUgbmV3IG9iamVjdFxyXG4gICAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Uuc2V0SXRlbShcIk1vZGJ1c1JUVXRyYWNlXCIsIEpTT04uc3RyaW5naWZ5KHBhY2tldHMpKTtcclxuICAgIH1cclxuXHJcbiAgICBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdID0gTWF0aC5yb3VuZCgoMS4wICogYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlVGltZVwiXSAqIChidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VzXCJdICUgNTAwKSArIChlbmRUaW1lIC0gc3RhcnRUaW1lKSkgLyAoKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgMSkpO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RSZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKGVuZFRpbWUgLSBzdGFydFRpbWUpICsgXCIgbXNcIjtcclxuICAgIGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0rKztcclxuXHJcbiAgICByZXR1cm4gYW5zd2VyO1xyXG59XHJcblxyXG5sZXQgc2VuZWNhTVNDID0gbmV3IHNlbmVjYU1vZHVsZS5TZW5lY2FNU0MoU2VuZEFuZFJlc3BvbnNlKTtcclxuXHJcbi8qKlxyXG4gKiBNYWluIGxvb3Agb2YgdGhlIG1ldGVyIGhhbmRsZXIuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIHN0YXRlTWFjaGluZSgpIHtcclxuICAgIHZhciBuZXh0QWN0aW9uO1xyXG4gICAgdmFyIERFTEFZX01TID0gKHNpbXVsYXRpb24/MjA6NzUwKTsgLy8gVXBkYXRlIHRoZSBzdGF0dXMgZXZlcnkgWCBtcy5cclxuICAgIHZhciBUSU1FT1VUX01TID0gKHNpbXVsYXRpb24/MTAwMDozMDAwMCk7IC8vIEdpdmUgdXAgc29tZSBvcGVyYXRpb25zIGFmdGVyIFggbXMuXHJcbiAgICBidFN0YXRlLnN0YXJ0ZWQgPSB0cnVlO1xyXG5cclxuICAgIGxvZy5kZWJ1ZyhcIkN1cnJlbnQgc3RhdGU6XCIgKyBidFN0YXRlLnN0YXRlKTtcclxuXHJcbiAgICAvLyBDb25zZWN1dGl2ZSBzdGF0ZSBjb3VudGVkLiBDYW4gYmUgdXNlZCB0byB0aW1lb3V0LlxyXG4gICAgaWYgKGJ0U3RhdGUuc3RhdGUgPT0gYnRTdGF0ZS5wcmV2X3N0YXRlKSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQrKztcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFN0b3AgcmVxdWVzdCBmcm9tIEFQSVxyXG4gICAgaWYgKGJ0U3RhdGUuc3RvcFJlcXVlc3QpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBJTkc7XHJcbiAgICB9XHJcblxyXG4gICAgbG9nLmRlYnVnKFwiXFxTdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG4gICAgc3dpdGNoIChidFN0YXRlLnN0YXRlKSB7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5OT1RfQ09OTkVDVEVEOiAvLyBpbml0aWFsIHN0YXRlIG9uIFN0YXJ0KClcclxuICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGZha2VQYWlyRGV2aWNlO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGJ0UGFpckRldmljZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkNPTk5FQ1RJTkc6IC8vIHdhaXRpbmcgZm9yIGNvbm5lY3Rpb24gdG8gY29tcGxldGVcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOiAvLyBjb25uZWN0aW9uIGNvbXBsZXRlLCBhY3F1aXJlIG1ldGVyIHN0YXRlXHJcbiAgICAgICAgICAgIGlmIChzaW11bGF0aW9uKXtcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBmYWtlU3Vic2NyaWJlO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6IC8vIHdhaXRpbmcgZm9yIEJsdWV0b290aCBpbnRlcmZhY2VzXHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IChUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiVGltZW91dCBpbiBTVUJTQ1JJQklOR1wiKTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVDogLy8gcmVhZHkgdG8gY29tbXVuaWNhdGUsIGFjcXVpcmUgbWV0ZXIgc3RhdHVzXHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSBtZXRlckluaXQ7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVElBTElaSU5HOiAvLyByZWFkaW5nIHRoZSBtZXRlciBzdGF0dXNcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiVGltZW91dCBpbiBNRVRFUl9JTklUSUFMSVpJTkdcIik7XHJcbiAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgIGlmIChzaW11bGF0aW9uKXtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gZmFrZVN1YnNjcmliZTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuSURMRTogLy8gcmVhZHkgdG8gcHJvY2VzcyBjb21tYW5kcyBmcm9tIEFQSVxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwpXHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gcHJvY2Vzc0NvbW1hbmQ7XHJcbiAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHJlZnJlc2g7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5FUlJPUjogLy8gYW55dGltZSBhbiBlcnJvciBoYXBwZW5zXHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSBkaXNjb25uZWN0O1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkJVU1k6IC8vIHdoaWxlIGEgY29tbWFuZCBpbiBnb2luZyBvblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5zdGF0ZV9jcHQgPiAoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCJUaW1lb3V0IGluIEJVU1lcIik7XHJcbiAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgIGlmIChzaW11bGF0aW9uKXtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gZmFrZVN1YnNjcmliZTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBJTkc6XHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSBkaXNjb25uZWN0O1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLlNUT1BQRUQ6IC8vIGFmdGVyIGEgZGlzY29ubmVjdG9yIG9yIFN0b3AoKSByZXF1ZXN0LCBzdG9wcyB0aGUgc3RhdGUgbWFjaGluZS5cclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICB9XHJcblxyXG4gICAgYnRTdGF0ZS5wcmV2X3N0YXRlID0gYnRTdGF0ZS5zdGF0ZTtcclxuXHJcbiAgICBpZiAobmV4dEFjdGlvbiAhPSB1bmRlZmluZWQpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRFeGVjdXRpbmc6XCIgKyBuZXh0QWN0aW9uLm5hbWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IG5leHRBY3Rpb24oKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgbG9nLmVycm9yKFwiRXhjZXB0aW9uIGluIHN0YXRlIG1hY2hpbmVcIiwgZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCkge1xyXG4gICAgICAgIHV0aWxzLnNsZWVwKERFTEFZX01TKS50aGVuKCgpID0+IHN0YXRlTWFjaGluZSgpKTsgLy8gUmVjaGVjayBzdGF0dXMgaW4gREVMQVlfTVMgbXNcclxuICAgIH1cclxuICAgIGVsc2Uge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFRlcm1pbmF0aW5nIFN0YXRlIG1hY2hpbmVcIik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGFydGVkID0gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDYWxsZWQgZnJvbSBzdGF0ZSBtYWNoaW5lIHRvIGV4ZWN1dGUgYSBzaW5nbGUgY29tbWFuZCBmcm9tIGJ0U3RhdGUuY29tbWFuZCBwcm9wZXJ0eVxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZCgpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgdmFyIGNvbW1hbmQgPSBidFN0YXRlLmNvbW1hbmQ7XHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgICAgICB2YXIgcGFja2V0LCByZXNwb25zZSwgc3RhcnRHZW47XHJcblxyXG4gICAgICAgIGlmIChjb21tYW5kID09IG51bGwpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuQlVTWTtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiY29tbWFuZHNcIl0rKztcclxuXHJcbiAgICAgICAgbG9nLmluZm8oJ1xcdFxcdEV4ZWN1dGluZyBjb21tYW5kIDonICsgY29tbWFuZCk7XHJcblxyXG4gICAgICAgIC8vIEZpcnN0IHNldCBOT05FIGJlY2F1c2Ugd2UgZG9uJ3Qgd2FudCB0byB3cml0ZSBuZXcgc2V0cG9pbnRzIHdpdGggYWN0aXZlIGdlbmVyYXRpb25cclxuICAgICAgICByZXN1bHQgPSBhd2FpdCBzZW5lY2FNU0Muc3dpdGNoT2ZmKCk7XHJcbiAgICAgICAgaWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IHN3aXRjaCBtZXRlciBvZmYgYmVmb3JlIGNvbW1hbmQgd3JpdGUhXCIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBcclxuICAgICAgICAvLyBOb3cgd3JpdGUgdGhlIHNldHBvaW50IG9yIHNldHRpbmdcclxuICAgICAgICBpZiAodXRpbHMuaXNHZW5lcmF0aW9uKGNvbW1hbmQudHlwZSkgfHwgdXRpbHMuaXNTZXR0aW5nKGNvbW1hbmQudHlwZSkgJiYgY29tbWFuZC50eXBlICE9IENvbW1hbmRUeXBlLk9GRikge1xyXG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCBzZW5lY2FNU0Mud3JpdGVTZXRwb2ludHMoY29tbWFuZC50eXBlLCBjb21tYW5kLnNldHBvaW50LCBjb21tYW5kLnNldHBvaW50Mik7XHJcbiAgICAgICAgICAgIGlmIChyZXN1bHQgIT0gUmVzdWx0Q29kZS5TVUNDRVNTKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJGYWlsdXJlIHRvIHdyaXRlIHNldHBvaW50cyFcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmICghdXRpbHMuaXNTZXR0aW5nKGNvbW1hbmQudHlwZSkgJiYgXHJcbiAgICAgICAgICAgIHV0aWxzLmlzVmFsaWQoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSAgLy8gSUYgdGhpcyBpcyBhIHNldHRpbmcsIHdlJ3JlIGRvbmUuXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICAvLyBOb3cgd3JpdGUgdGhlIG1vZGUgc2V0XHJcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy5jaGFuZ2VNb2RlKGNvbW1hbmQudHlwZSk7XHJcbiAgICAgICAgICAgIGlmIChyZXN1bHQgIT0gUmVzdWx0Q29kZS5TVUNDRVNTKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJGYWlsdXJlIHRvIGNoYW5nZSBtZXRlciBtb2RlIVwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gQ2FsbGVyIGV4cGVjdHMgYSB2YWxpZCBwcm9wZXJ0eSBpbiBHZXRTdGF0ZSgpIG9uY2UgY29tbWFuZCBpcyBleGVjdXRlZC5cclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcbiAgICAgICAgYXdhaXQgcmVmcmVzaCgpO1xyXG5cclxuICAgICAgICBjb21tYW5kLmVycm9yID0gZmFsc2U7XHJcbiAgICAgICAgY29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcbiAgICAgICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuXHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0Q29tcGxldGVkIGNvbW1hbmQgZXhlY3V0ZWRcIik7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLmVycm9yKFwiKiogZXJyb3Igd2hpbGUgZXhlY3V0aW5nIGNvbW1hbmQ6IFwiICsgZXJyKTtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBtb2RidXMuTW9kYnVzRXJyb3IpXHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJtb2RidXNfZXJyb3JzXCJdKys7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRFeHBlY3RlZFN0YXRlSGV4KCkge1xyXG4vLyBTaW11bGF0ZSBjdXJyZW50IG1vZGUgYW5zd2VyIGFjY29yZGluZyB0byBsYXN0IGNvbW1hbmQuXHJcbiAgICB2YXIgc3RhdGVIZXggPSAoQ29tbWFuZFR5cGUuT0ZGKS50b1N0cmluZygxNik7XHJcbiAgICBpZiAoYnRTdGF0ZS5jb21tYW5kPy50eXBlICE9IG51bGwpXHJcbiAgICB7XHJcbiAgICAgICAgc3RhdGVIZXggPSAoYnRTdGF0ZS5jb21tYW5kLnR5cGUpLnRvU3RyaW5nKDE2KTtcclxuICAgIH1cclxuICAgIC8vIEFkZCB0cmFpbGluZyAwXHJcbiAgICB3aGlsZShzdGF0ZUhleC5sZW5ndGggPCAyKVxyXG4gICAgICAgIHN0YXRlSGV4ID0gXCIwXCIgKyBzdGF0ZUhleDtcclxuICAgIHJldHVybiBzdGF0ZUhleDtcclxufVxyXG4vKipcclxuICogVXNlZCB0byBzaW11bGF0ZSBSVFUgYW5zd2Vyc1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBjb21tYW5kIHJlYWwgcmVxdWVzdFxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IGZha2UgYW5zd2VyXHJcbiAqL1xyXG5mdW5jdGlvbiBmYWtlUmVzcG9uc2UoY29tbWFuZCkge1xyXG4gICAgdmFyIGNvbW1hbmRIZXggPSB1dGlscy5idWYyaGV4KGNvbW1hbmQpO1xyXG4gICAgdmFyIGZvcmdlZEFuc3dlcnMgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICcxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZCcgOiAnMTkgMDMgMDIgMDAnICsgZ2V0RXhwZWN0ZWRTdGF0ZUhleCgpICsnICQkJCQnLCAvLyBDdXJyZW50IHN0YXRlXHJcbiAgICAgICAgICAgICAgICAgICAgICdkZWZhdWx0IDAzJyA6ICcxOSAwMyAwNiAwMDAxIDAwMDEgMDAwMSAkJCQkJywgLy8gZGVmYXVsdCBhbnN3ZXIgZm9yIEZDM1xyXG4gICAgICAgICAgICAgICAgICAgICAnZGVmYXVsdCAxMCcgOiAnMTkgMTAgMDAgZDQgMDAgMDIgMDAwMSAwMDAxICQkJCQnfTsgLy8gZGVmYXVsdCBhbnN3ZXIgZm9yIEZDMTBcclxuXHJcbiAgICAvLyBTdGFydCB3aXRoIHRoZSBkZWZhdWx0IGFuc3dlclxyXG4gICAgdmFyIHJlc3BvbnNlSGV4ID0gZm9yZ2VkQW5zd2Vyc1snZGVmYXVsdCAnICsgY29tbWFuZEhleC5zcGxpdCgnICcpWzFdXTtcclxuXHJcbiAgICAvLyBEbyB3ZSBoYXZlIGEgZm9yZ2VkIGFuc3dlcj9cclxuICAgIGlmIChmb3JnZWRBbnN3ZXJzW2NvbW1hbmRIZXhdICE9IHVuZGVmaW5lZCkge1xyXG4gICAgICAgIHJlc3BvbnNlSGV4ID0gZm9yZ2VkQW5zd2Vyc1tjb21tYW5kSGV4XTtcclxuICAgIH1cclxuICAgIGVsc2VcclxuICAgIHtcclxuICAgICAgICAvLyBMb29rIGludG8gcmVnaXN0ZXJlZCB0cmFjZXNcclxuICAgICAgICBmb3VuZCA9IFtdO1xyXG4gICAgICAgIGZvcih2YXIgdHJhY2UgaW4gdGVzdERhdGEudGVzdFRyYWNlcykge1xyXG4gICAgICAgICAgICBpZiAodHJhY2VbXCJyZXF1ZXN0XCJdID09PSBjb21tYW5kSGV4KSB7XHJcbiAgICAgICAgICAgICAgICBmb3VuZC5wdXNoKHRyYWNlW1wiYW5zd2VyXCJdKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZm91bmQubGVuZ3RoID4gMCkge1xyXG4gICAgICAgICAgICAvLyBTZWxlY3QgYSByYW5kb20gYW5zd2VyIGZyb20gdGhlIHJlZ2lzdGVyZWQgdHJhY2VcclxuICAgICAgICAgICAgcmVzcG9uc2VIZXggPSBmb3VuZFtNYXRoLmZsb29yKChNYXRoLnJhbmRvbSgpKmZvdW5kLmxlbmd0aCkpXTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8vIENvbXB1dGUgQ1JDIGlmIG5lZWRlZFxyXG4gICAgaWYgKHJlc3BvbnNlSGV4LmluY2x1ZGVzKFwiJCQkJFwiKSkge1xyXG4gICAgICAgIHJlc3BvbnNlSGV4ID0gcmVzcG9uc2VIZXgucmVwbGFjZSgnJCQkJCcsJycpO1xyXG4gICAgICAgIHZhciBjcmMgPSBtb2RidXMuY3JjMTYobmV3IFVpbnQ4QXJyYXkodXRpbHMuaGV4MmJ1ZihyZXNwb25zZUhleCkpKS50b1N0cmluZygxNik7XHJcbiAgICAgICAgd2hpbGUoY3JjLmxlbmd0aCA8IDQpXHJcbiAgICAgICAgICAgIGNyYyA9IFwiMFwiICsgY3JjO1xyXG4gICAgICAgIHJlc3BvbnNlSGV4ID0gcmVzcG9uc2VIZXggKyBjcmMuc3Vic3RyaW5nKDIsNCkgKyBjcmMuc3Vic3RyaW5nKDAsMik7XHJcbiAgICB9XHJcblxyXG4gICAgbG9nLmRlYnVnKFwiPDwgXCIgKyByZXNwb25zZUhleCk7XHJcbiAgICByZXR1cm4gdXRpbHMuaGV4MmJ1ZihyZXNwb25zZUhleCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBY3F1aXJlIHRoZSBjdXJyZW50IG1vZGUgYW5kIHNlcmlhbCBudW1iZXIgb2YgdGhlIGRldmljZS5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gbWV0ZXJJbml0KCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVElBTElaSU5HO1xyXG4gICAgICAgIGJ0U3RhdGUubWV0ZXIuc2VyaWFsID0gYXdhaXQgc2VuZWNhTVNDLmdldFNlcmlhbE51bWJlcigpO1xyXG4gICAgICAgIGxvZy5pbmZvKCdcXHRcXHRTZXJpYWwgbnVtYmVyOicgKyBidFN0YXRlLm1ldGVyLnNlcmlhbCk7XHJcblxyXG4gICAgICAgIGJ0U3RhdGUubWV0ZXIubW9kZSA9IGF3YWl0IHNlbmVjYU1TQy5nZXRDdXJyZW50TW9kZSgpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnXFx0XFx0Q3VycmVudCBtb2RlOicgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cclxuICAgICAgICBidFN0YXRlLm1ldGVyLmJhdHRlcnkgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0QmF0dGVyeVZvbHRhZ2UoKTtcclxuICAgICAgICBsb2cuZGVidWcoJ1xcdFxcdEJhdHRlcnkgKFYpOicgKyBidFN0YXRlLm1ldGVyLmJhdHRlcnkpO1xyXG5cclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuSURMRTtcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cud2FybihcIkVycm9yIHdoaWxlIGluaXRpYWxpemluZyBtZXRlciA6XCIgKyBlcnIpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuICAgIH1cclxufVxyXG5cclxuLypcclxuICogQ2xvc2UgdGhlIGJsdWV0b290aCBpbnRlcmZhY2UgKHVucGFpcilcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gZGlzY29ubmVjdCgpIHtcclxuICAgIGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGlmIChidFN0YXRlLmJ0RGV2aWNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCIqIENhbGxpbmcgZGlzY29ubmVjdCBvbiBidGRldmljZVwiKTtcclxuICAgICAgICAgICAgICAgIC8vIEF2b2lkIHRoZSBldmVudCBmaXJpbmcgd2hpY2ggbWF5IGxlYWQgdG8gYXV0by1yZWNvbm5lY3RcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2UucmVtb3ZlRXZlbnRMaXN0ZW5lcignZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZCcsIG9uRGlzY29ubmVjdGVkKTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2UuZ2F0dC5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggeyB9XHJcbiAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBFRDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBicm93c2VyIEJUIGFwaSB3aGVuIHRoZSBkZXZpY2UgZGlzY29ubmVjdFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBvbkRpc2Nvbm5lY3RlZCgpIHtcclxuICAgIGxvZy53YXJuKFwiKiBHQVRUIFNlcnZlciBkaXNjb25uZWN0ZWQgZXZlbnQsIHdpbGwgdHJ5IHRvIHJlY29ubmVjdCAqXCIpO1xyXG4gICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcIkdBVFQgZGlzY29ubmVjdHNcIl0rKztcclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOyAvLyBUcnkgdG8gYXV0by1yZWNvbm5lY3QgdGhlIGludGVyZmFjZXMgd2l0aG91dCBwYWlyaW5nXHJcbn1cclxuXHJcbi8qKlxyXG4gKiBKb2lucyB0aGUgYXJndW1lbnRzIGludG8gYSBzaW5nbGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtCdWZmZXJ9IGNvbmNhdGVuYXRlZCBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGFycmF5QnVmZmVyQ29uY2F0KCkge1xyXG4gICAgdmFyIGxlbmd0aCA9IDA7XHJcbiAgICB2YXIgYnVmZmVyID0gbnVsbDtcclxuXHJcbiAgICBmb3IgKHZhciBpIGluIGFyZ3VtZW50cykge1xyXG4gICAgICAgIGJ1ZmZlciA9IGFyZ3VtZW50c1tpXTtcclxuICAgICAgICBsZW5ndGggKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIGpvaW5lZCA9IG5ldyBVaW50OEFycmF5KGxlbmd0aCk7XHJcbiAgICB2YXIgb2Zmc2V0ID0gMDtcclxuXHJcbiAgICBmb3IgKGkgaW4gYXJndW1lbnRzKSB7XHJcbiAgICAgICAgYnVmZmVyID0gYXJndW1lbnRzW2ldO1xyXG4gICAgICAgIGpvaW5lZC5zZXQobmV3IFVpbnQ4QXJyYXkoYnVmZmVyKSwgb2Zmc2V0KTtcclxuICAgICAgICBvZmZzZXQgKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGpvaW5lZC5idWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFdmVudCBjYWxsZWQgYnkgYmx1ZXRvb3RoIGNoYXJhY3RlcmlzdGljcyB3aGVuIHJlY2VpdmluZyBkYXRhXHJcbiAqIEBwYXJhbSB7YW55fSBldmVudFxyXG4gKi9cclxuZnVuY3Rpb24gaGFuZGxlTm90aWZpY2F0aW9ucyhldmVudCkge1xyXG4gICAgbGV0IHZhbHVlID0gZXZlbnQudGFyZ2V0LnZhbHVlO1xyXG4gICAgaWYgKHZhbHVlICE9IG51bGwpIHtcclxuICAgICAgICBsb2cuZGVidWcoJzw8ICcgKyB1dGlscy5idWYyaGV4KHZhbHVlLmJ1ZmZlcikpO1xyXG4gICAgICAgIGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IGFycmF5QnVmZmVyQ29uY2F0KGJ0U3RhdGUucmVzcG9uc2UsIHZhbHVlLmJ1ZmZlcik7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IHZhbHVlLmJ1ZmZlci5zbGljZSgpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFRoaXMgZnVuY3Rpb24gd2lsbCBzdWNjZWVkIG9ubHkgaWYgY2FsbGVkIGFzIGEgY29uc2VxdWVuY2Ugb2YgYSB1c2VyLWdlc3R1cmVcclxuICogRS5nLiBidXR0b24gY2xpY2suIFRoaXMgaXMgZHVlIHRvIEJsdWVUb290aCBBUEkgc2VjdXJpdHkgbW9kZWwuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0UGFpckRldmljZSgpIHtcclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5DT05ORUNUSU5HO1xyXG4gICAgdmFyIGZvcmNlU2VsZWN0aW9uID0gYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl07XHJcbiAgICBsb2cuZGVidWcoXCJidFBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0QXZhaWxhYmlsaXR5KSA9PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJpbGl0eSA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0QXZhaWxhYmlsaXR5KCk7XHJcbiAgICAgICAgICAgIGlmICghYXZhaWxhYmlsaXR5KSB7XHJcbiAgICAgICAgICAgICAgICBsb2cuZXJyb3IoXCJCbHVldG9vdGggbm90IGF2YWlsYWJsZSBpbiBicm93c2VyLlwiKTtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkJyb3dzZXIgZG9lcyBub3QgcHJvdmlkZSBibHVldG9vdGhcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIGRldmljZSA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIERvIHdlIGFscmVhZHkgaGF2ZSBwZXJtaXNzaW9uP1xyXG4gICAgICAgIGlmICh0eXBlb2YgKG5hdmlnYXRvci5ibHVldG9vdGg/LmdldERldmljZXMpID09ICdmdW5jdGlvbidcclxuICAgICAgICAgICAgJiYgIWZvcmNlU2VsZWN0aW9uKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZURldmljZXMgPSBhd2FpdCBuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKTtcclxuICAgICAgICAgICAgYXZhaWxhYmxlRGV2aWNlcy5mb3JFYWNoKGZ1bmN0aW9uIChkZXYsIGluZGV4KSB7XHJcbiAgICAgICAgICAgICAgICBsb2cuZGVidWcoXCJGb3VuZCBhdXRob3JpemVkIGRldmljZSA6XCIgKyBkZXYubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZGV2Lm5hbWUuc3RhcnRzV2l0aChcIk1TQ1wiKSlcclxuICAgICAgICAgICAgICAgICAgICBkZXZpY2UgPSBkZXY7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoXCJuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKT1cIiArIGRldmljZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIElmIG5vdCwgcmVxdWVzdCBmcm9tIHVzZXJcclxuICAgICAgICBpZiAoZGV2aWNlID09IG51bGwpIHtcclxuICAgICAgICAgICAgZGV2aWNlID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aFxyXG4gICAgICAgICAgICAgICAgLnJlcXVlc3REZXZpY2Uoe1xyXG4gICAgICAgICAgICAgICAgICAgIGFjY2VwdEFsbERldmljZXM6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWVQcmVmaXg6ICdNU0MnIH1dLFxyXG4gICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsU2VydmljZXM6IFtCbHVlVG9vdGhNU0MuU2VydmljZVV1aWRdXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBsb2cuaW5mbyhcIkJsdWV0b290aCBkZXZpY2UgXCIgKyBkZXZpY2UubmFtZSArIFwiIGNvbm5lY3RlZC5cIik7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoNTAwKTtcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG4gICAgICAgIGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICBpZiAoYnRTdGF0ZS5jaGFyUmVhZCAhPSBudWxsKSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLmNoYXJSZWFkLnN0b3BOb3RpZmljYXRpb25zKCk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7IH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmYWtlUGFpckRldmljZSgpIHtcclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5DT05ORUNUSU5HO1xyXG4gICAgdmFyIGZvcmNlU2VsZWN0aW9uID0gYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl07XHJcbiAgICBsb2cuZGVidWcoXCJmYWtlUGFpckRldmljZShcIiArIGZvcmNlU2VsZWN0aW9uICsgXCIpXCIpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICB2YXIgZGV2aWNlID0geyBuYW1lIDogXCJGYWtlQlREZXZpY2VcIiwgZ2F0dDoge2Nvbm5lY3RlZDp0cnVlfX07XHJcbiAgICAgICAgYnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBsb2cuaW5mbyhcIkJsdWV0b290aCBkZXZpY2UgXCIgKyBkZXZpY2UubmFtZSArIFwiIGNvbm5lY3RlZC5cIik7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoNTApO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiKiogZXJyb3Igd2hpbGUgY29ubmVjdGluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuRVJST1I7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIE9uY2UgdGhlIGRldmljZSBpcyBhdmFpbGFibGUsIGluaXRpYWxpemUgdGhlIHNlcnZpY2UgYW5kIHRoZSAyIGNoYXJhY3RlcmlzdGljcyBuZWVkZWQuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0U3Vic2NyaWJlKCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1VCU0NSSUJJTkc7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcInN1YmNyaWJlc1wiXSsrO1xyXG4gICAgICAgIGxldCBkZXZpY2UgPSBidFN0YXRlLmJ0RGV2aWNlO1xyXG4gICAgICAgIGxldCBzZXJ2ZXIgPSBudWxsO1xyXG5cclxuICAgICAgICBpZiAoIWRldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhgQ29ubmVjdGluZyB0byBHQVRUIFNlcnZlciBvbiAke2RldmljZS5uYW1lfS4uLmApO1xyXG4gICAgICAgICAgICBkZXZpY2UuYWRkRXZlbnRMaXN0ZW5lcignZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZCcsIG9uRGlzY29ubmVjdGVkKTtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGlmIChidFN0YXRlLmJ0U2VydmljZT8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UuZGlzY29ubmVjdCgpO1xyXG4gICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHsgfVxyXG5cclxuICAgICAgICAgICAgc2VydmVyID0gYXdhaXQgZGV2aWNlLmdhdHQuY29ubmVjdCgpO1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgR0FUVCBzZXJ2ZXInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnR0FUVCBhbHJlYWR5IGNvbm5lY3RlZCcpO1xyXG4gICAgICAgICAgICBzZXJ2ZXIgPSBkZXZpY2UuZ2F0dDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGJ0U3RhdGUuYnRTZXJ2aWNlID0gYXdhaXQgc2VydmVyLmdldFByaW1hcnlTZXJ2aWNlKEJsdWVUb290aE1TQy5TZXJ2aWNlVXVpZCk7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUuYnRTZXJ2aWNlID09IG51bGwpXHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkdBVFQgU2VydmljZSByZXF1ZXN0IGZhaWxlZFwiKTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgU2VyaWFsIHNlcnZpY2UnKTtcclxuICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IGF3YWl0IGJ0U3RhdGUuYnRTZXJ2aWNlLmdldENoYXJhY3RlcmlzdGljKEJsdWVUb290aE1TQy5Nb2RidXNSZXF1ZXN0VXVpZCk7XHJcbiAgICAgICAgbG9nLmRlYnVnKCc+IEZvdW5kIHdyaXRlIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IGF3YWl0IGJ0U3RhdGUuYnRTZXJ2aWNlLmdldENoYXJhY3RlcmlzdGljKEJsdWVUb290aE1TQy5Nb2RidXNBbnN3ZXJVdWlkKTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgcmVhZCBjaGFyYWN0ZXJpc3RpYycpO1xyXG4gICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuYWRkRXZlbnRMaXN0ZW5lcignY2hhcmFjdGVyaXN0aWN2YWx1ZWNoYW5nZWQnLCBoYW5kbGVOb3RpZmljYXRpb25zKTtcclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkLnN0YXJ0Tm90aWZpY2F0aW9ucygpO1xyXG4gICAgICAgIGxvZy5pbmZvKCc+IEJsdWV0b290aCBpbnRlcmZhY2VzIHJlYWR5LicpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJsYXN0X2Nvbm5lY3RcIl0gPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoNTApO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiKiogZXJyb3Igd2hpbGUgc3Vic2NyaWJpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG4gICAgICAgIGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGlmIChidFN0YXRlLmJ0RGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBidFN0YXRlLmNoYXJSZWFkLnN0b3BOb3RpZmljYXRpb25zKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLmJ0RGV2aWNlPy5nYXR0LmRpc2Nvbm5lY3QoKTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZmFrZVN1YnNjcmliZSgpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLlNVQlNDUklCSU5HO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJzdWJjcmliZXNcIl0rKztcclxuICAgICAgICBsZXQgZGV2aWNlID0gYnRTdGF0ZS5idERldmljZTtcclxuICAgICAgICBsZXQgc2VydmVyID0gbnVsbDtcclxuXHJcbiAgICAgICAgaWYgKCFkZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoYENvbm5lY3RpbmcgdG8gR0FUVCBTZXJ2ZXIgb24gJHtkZXZpY2UubmFtZX0uLi5gKTtcclxuICAgICAgICAgICAgZGV2aWNlWydnYXR0J11bJ2Nvbm5lY3RlZCddPXRydWU7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBHQVRUIHNlcnZlcicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCdHQVRUIGFscmVhZHkgY29ubmVjdGVkJyk7XHJcbiAgICAgICAgICAgIHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSB7fTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgU2VyaWFsIHNlcnZpY2UnKTtcclxuICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IHt9O1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCB3cml0ZSBjaGFyYWN0ZXJpc3RpYycpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSB7fTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgcmVhZCBjaGFyYWN0ZXJpc3RpYycpO1xyXG4gICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgICAgIGxvZy5pbmZvKCc+IEJsdWV0b290aCBpbnRlcmZhY2VzIHJlYWR5LicpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJsYXN0X2Nvbm5lY3RcIl0gPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTApO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiKiogZXJyb3Igd2hpbGUgc3Vic2NyaWJpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIFdoZW4gaWRsZSwgdGhpcyBmdW5jdGlvbiBpcyBjYWxsZWRcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaCgpIHtcclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICAvLyBDaGVjayB0aGUgbW9kZSBmaXJzdFxyXG4gICAgICAgIHZhciBtb2RlID0gYXdhaXQgc2VuZWNhTVNDLmdldEN1cnJlbnRNb2RlKCk7XHJcblxyXG4gICAgICAgIGlmIChtb2RlICE9IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTikge1xyXG4gICAgICAgICAgICBidFN0YXRlLm1ldGVyLm1vZGUgPSBtb2RlO1xyXG5cclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUubWV0ZXIuaXNHZW5lcmF0aW9uKCkpXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIHZhciBzZXRwb2ludHMgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0U2V0cG9pbnRzKGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLmxhc3RTZXRwb2ludCA9IHNldHBvaW50cztcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUubWV0ZXIuaXNNZWFzdXJlbWVudCgpKVxyXG4gICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICB2YXIgbWVhcyA9IGF3YWl0IHNlbmVjYU1TQy5nZXRNZWFzdXJlcyhidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5sYXN0TWVhc3VyZSA9IG1lYXM7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0RmluaXNoZWQgcmVmcmVzaGluZyBjdXJyZW50IHN0YXRlXCIpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgcmVmcmVzaGluZyBtZWFzdXJlXCIgKyBlcnIpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gU2V0U2ltdWxhdGlvbih2YWx1ZSkge1xyXG4gICAgc2ltdWxhdGlvbiA9IHZhbHVlO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtzdGF0ZU1hY2hpbmUsIFNlbmRBbmRSZXNwb25zZSwgU2V0U2ltdWxhdGlvbn07IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4uL2NvbnN0YW50cycpO1xyXG52YXIgTWV0ZXJTdGF0ZSA9IHJlcXVpcmUoJy4vTWV0ZXJTdGF0ZScpO1xyXG5cclxuLy8gQ3VycmVudCBzdGF0ZSBvZiB0aGUgYmx1ZXRvb3RoXHJcbmNsYXNzIEFQSVN0YXRlIHtcclxuICAgIGNvbnN0cnVjdG9yKCkge1xyXG4gICAgICAgIHRoaXMuc3RhdGUgPSBjb25zdGFudHMuU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuICAgICAgICB0aGlzLnByZXZfc3RhdGUgPSBjb25zdGFudHMuU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuICAgICAgICB0aGlzLnN0YXRlX2NwdCA9IDA7XHJcblxyXG4gICAgICAgIHRoaXMuc3RhcnRlZCA9IGZhbHNlOyAvLyBTdGF0ZSBtYWNoaW5lIHN0YXR1c1xyXG4gICAgICAgIHRoaXMuc3RvcFJlcXVlc3QgPSBmYWxzZTsgLy8gVG8gcmVxdWVzdCBkaXNjb25uZWN0XHJcbiAgICAgICAgdGhpcy5sYXN0TWVhc3VyZSA9IHt9OyAvLyBBcnJheSB3aXRoIFwiTWVhc3VyZU5hbWVcIiA6IHZhbHVlXHJcbiAgICAgICAgdGhpcy5sYXN0U2V0cG9pbnQgPSB7fTsgLy8gQXJyYXkgd2l0aCBcIlNldHBvaW50VHlwZVwiIDogdmFsdWVcclxuXHJcbiAgICAgICAgLy8gc3RhdGUgb2YgY29ubmVjdGVkIG1ldGVyXHJcbiAgICAgICAgdGhpcy5tZXRlciA9IG5ldyBNZXRlclN0YXRlKCk7XHJcblxyXG4gICAgICAgIC8vIGxhc3QgbW9kYnVzIFJUVSBjb21tYW5kXHJcbiAgICAgICAgdGhpcy5jb21tYW5kID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gbGFzdCBtb2RidXMgUlRVIGFuc3dlclxyXG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSBudWxsO1xyXG5cclxuICAgICAgICAvLyBibHVldG9vdGggcHJvcGVydGllc1xyXG4gICAgICAgIHRoaXMuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICB0aGlzLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5idERldmljZSA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIGdlbmVyYWwgc3RhdGlzdGljcyBmb3IgZGVidWdnaW5nXHJcbiAgICAgICAgdGhpcy5zdGF0cyA9IHtcclxuICAgICAgICAgICAgXCJyZXF1ZXN0c1wiOiAwLFxyXG4gICAgICAgICAgICBcInJlc3BvbnNlc1wiOiAwLFxyXG4gICAgICAgICAgICBcIm1vZGJ1c19lcnJvcnNcIjogMCxcclxuICAgICAgICAgICAgXCJHQVRUIGRpc2Nvbm5lY3RzXCI6IDAsXHJcbiAgICAgICAgICAgIFwiZXhjZXB0aW9uc1wiOiAwLFxyXG4gICAgICAgICAgICBcInN1YmNyaWJlc1wiOiAwLFxyXG4gICAgICAgICAgICBcImNvbW1hbmRzXCI6IDAsXHJcbiAgICAgICAgICAgIFwicmVzcG9uc2VUaW1lXCI6IDAuMCxcclxuICAgICAgICAgICAgXCJsYXN0UmVzcG9uc2VUaW1lXCI6IDAuMCxcclxuICAgICAgICAgICAgXCJsYXN0X2Nvbm5lY3RcIjogbmV3IERhdGUoMjAyMCwgMSwgMSkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIHRoaXMub3B0aW9ucyA9IHtcclxuICAgICAgICAgICAgXCJmb3JjZURldmljZVNlbGVjdGlvblwiIDogdHJ1ZVxyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxubGV0IGJ0U3RhdGUgPSBuZXcgQVBJU3RhdGUoKTtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBBUElTdGF0ZSwgYnRTdGF0ZSB9IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4uL2NvbnN0YW50cycpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKCcuLi91dGlscycpO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcblxyXG5jb25zdCBNQVhfVV9HRU4gPSAyNy4wOyAvLyBtYXhpbXVtIHZvbHRhZ2UgXHJcblxyXG4vKipcclxuICogQ29tbWFuZCB0byB0aGUgbWV0ZXIsIG1heSBpbmNsdWRlIHNldHBvaW50XHJcbiAqICovXHJcbiBjbGFzcyBDb21tYW5kIHtcclxuICAgIC8qKlxyXG4gICAgICogQ3JlYXRlcyBhIG5ldyBjb21tYW5kXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjdHlwZVxyXG4gICAgICovXHJcbiAgICBjb25zdHJ1Y3RvcihjdHlwZSA9IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTikge1xyXG4gICAgICAgIHRoaXMudHlwZSA9IHBhcnNlSW50KGN0eXBlKTtcclxuICAgICAgICB0aGlzLnNldHBvaW50ID0gbnVsbDtcclxuICAgICAgICB0aGlzLnNldHBvaW50MiA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5lcnJvciA9IGZhbHNlO1xyXG4gICAgICAgIHRoaXMucGVuZGluZyA9IHRydWU7XHJcbiAgICAgICAgdGhpcy5yZXF1ZXN0ID0gbnVsbDtcclxuICAgICAgICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBzdGF0aWMgQ3JlYXRlTm9TUChjdHlwZSlcclxuICAgIHtcclxuICAgICAgICB2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG4gICAgICAgIHJldHVybiBjbWQ7XHJcbiAgICB9XHJcbiAgICBzdGF0aWMgQ3JlYXRlT25lU1AoY3R5cGUsIHNldHBvaW50KVxyXG4gICAge1xyXG4gICAgICAgIHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcbiAgICAgICAgY21kLnNldHBvaW50ID0gcGFyc2VGbG9hdChzZXRwb2ludCk7XHJcbiAgICAgICAgcmV0dXJuIGNtZDtcclxuICAgIH1cclxuICAgIHN0YXRpYyBDcmVhdGVUd29TUChjdHlwZSwgc2V0MSwgc2V0MilcclxuICAgIHtcclxuICAgICAgICB2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG4gICAgICAgIGNtZC5zZXRwb2ludCA9IHBhcnNlRmxvYXQoc2V0MSk7XHJcbiAgICAgICAgY21kLnNldHBvaW50MiA9IHBhcnNlRmxvYXQoc2V0Mik7O1xyXG4gICAgICAgIHJldHVybiBjbWQ7XHJcbiAgICB9XHJcblxyXG4gICAgdG9TdHJpbmcoKSB7XHJcbiAgICAgICAgcmV0dXJuIFwiVHlwZTogXCIgKyB1dGlscy5QYXJzZShDb21tYW5kVHlwZSwgdGhpcy50eXBlKSArIFwiLCBzZXRwb2ludDpcIiArIHRoaXMuc2V0cG9pbnQgKyBcIiwgc2V0cG9pbnQyOiBcIiArIHRoaXMuc2V0cG9pbnQyICsgXCIsIHBlbmRpbmc6XCIgKyB0aGlzLnBlbmRpbmcgKyBcIiwgZXJyb3I6XCIgKyB0aGlzLmVycm9yO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogR2V0cyB0aGUgZGVmYXVsdCBzZXRwb2ludCBmb3IgdGhpcyBjb21tYW5kIHR5cGVcclxuICAgICAqIEByZXR1cm5zIHtBcnJheX0gc2V0cG9pbnQocykgZXhwZWN0ZWRcclxuICAgICAqL1xyXG4gICAgZGVmYXVsdFNldHBvaW50KCkge1xyXG4gICAgICAgIHN3aXRjaCAodGhpcy50eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1RlbXBlcmF0dXJlICjCsEMpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVm9sdGFnZSAoViknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVm9sdGFnZSAobVYpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdDdXJyZW50IChtQSknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnSW1iYWxhbmNlIChtVi9WKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnRnJlcXVlbmN5IChIeiknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdQdWxzZXMgY291bnQnOiAwLCAnRnJlcXVlbmN5IChIeiknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVVRocmVzaG9sZF9GOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1V0aHJlc2hvbGQgKFYpJzogMi4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NlbnNpdGl2aXR5X3VTOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1NlbnNpYmlsaXR5ICh1UyknOiAyLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfQ29sZEp1bmN0aW9uOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0NvbGQganVuY3Rpb24gY29tcGVuc2F0aW9uJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1Vsb3c6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVSBsb3cgKFYpJzogMC4wIC8gTUFYX1VfR0VOIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VoaWdoOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1UgaGlnaCAoViknOiA1LjAgLyBNQVhfVV9HRU4gfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2h1dGRvd25EZWxheTpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdEZWxheSAocyknOiA2MCAqIDUgfTtcclxuICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7fTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpc0dlbmVyYXRpb24oKSB7XHJcbiAgICAgICAgcmV0dXJuIHV0aWxzLmlzR2VuZXJhdGlvbih0aGlzLnR5cGUpO1xyXG4gICAgfVxyXG4gICAgaXNNZWFzdXJlbWVudCgpIHtcclxuICAgICAgICByZXR1cm4gdXRpbHMuaXNNZWFzdXJlbWVudCh0aGlzLnR5cGUpO1xyXG4gICAgfVxyXG4gICAgaXNTZXR0aW5nKCkge1xyXG4gICAgICAgIHJldHVybiB1dGlscy5pc1NldHRpbmcodGhpcy50eXBlKTtcclxuICAgIH1cclxuICAgIGlzVmFsaWQoKSB7XHJcbiAgICAgICAgcmV0dXJuICh1dGlscy5pc01lYXN1cmVtZW50KHRoaXMudHlwZSkgfHwgdXRpbHMuaXNHZW5lcmF0aW9uKHRoaXMudHlwZSkgfHwgdXRpbHMuaXNTZXR0aW5nKHRoaXMudHlwZSkpO1xyXG4gICAgfVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IENvbW1hbmQ7IiwiY2xhc3MgQ29tbWFuZFJlc3VsdFxyXG57XHJcbiAgICB2YWx1ZSA9IDAuMDtcclxuICAgIHN1Y2Nlc3MgPSBmYWxzZTtcclxuICAgIG1lc3NhZ2UgPSBcIlwiO1xyXG4gICAgdW5pdCA9IFwiXCI7XHJcbiAgICBzZWNvbmRhcnlfdmFsdWUgPSAwLjA7XHJcbiAgICBzZWNvbmRhcnlfdW5pdCA9IFwiXCI7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ29tbWFuZFJlc3VsdDsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi4vY29uc3RhbnRzJyk7XHJcblxyXG4vKipcclxuICogQ3VycmVudCBzdGF0ZSBvZiB0aGUgbWV0ZXJcclxuICogKi9cclxuIGNsYXNzIE1ldGVyU3RhdGUge1xyXG4gICAgY29uc3RydWN0b3IoKSB7XHJcbiAgICAgICAgdGhpcy5maXJtd2FyZSA9IFwiXCI7IC8vIEZpcm13YXJlIHZlcnNpb25cclxuICAgICAgICB0aGlzLnNlcmlhbCA9IFwiXCI7IC8vIFNlcmlhbCBudW1iZXJcclxuICAgICAgICB0aGlzLm1vZGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOO1xyXG4gICAgICAgIHRoaXMuYmF0dGVyeSA9IDAuMDtcclxuICAgIH1cclxuXHJcbiAgICBpc01lYXN1cmVtZW50KCkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLm1vZGUgPiBjb25zdGFudHMuQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOICYmIHRoaXMubW9kZSA8IGNvbnN0YW50cy5Db21tYW5kVHlwZS5PRkY7XHJcbiAgICB9XHJcblxyXG4gICAgaXNHZW5lcmF0aW9uKCkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLm1vZGUgPiBjb25zdGFudHMuQ29tbWFuZFR5cGUuT0ZGICYmIHRoaXMubW9kZSA8IGNvbnN0YW50cy5Db21tYW5kVHlwZS5HRU5fUkVTRVJWRUQ7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gTWV0ZXJTdGF0ZTsiLCIndXNlIHN0cmljdCc7XHJcblxyXG4vKipcclxuICogIFRoaXMgbW9kdWxlIGNvbnRhaW5zIHRoZSBTZW5lY2FNU0Mgb2JqZWN0LCB3aGljaCBwcm92aWRlcyB0aGUgbWFpbiBvcGVyYXRpb25zIGZvciBibHVldG9vdGggbW9kdWxlLlxyXG4gKiAgSXQgdXNlcyB0aGUgbW9kYnVzIGhlbHBlciBmdW5jdGlvbnMgZnJvbSBzZW5lY2FNb2RidXMgLyBtb2RidXNSdHUgdG8gaW50ZXJhY3Qgd2l0aCB0aGUgbWV0ZXIgd2l0aCBTZW5kQW5kUmVzcG9uc2UgZnVuY3Rpb25cclxuICovXHJcbnZhciBsb2cgPSByZXF1aXJlKCdsb2dsZXZlbCcpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKCcuLi91dGlscycpO1xyXG52YXIgc2VuZWNhTUIgPSByZXF1aXJlKCcuLi9zZW5lY2FNb2RidXMnKTtcclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoJy4uL21vZGJ1c1J0dScpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi4vY29uc3RhbnRzJyk7XHJcblxyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbnZhciBSZXN1bHRDb2RlID0gY29uc3RhbnRzLlJlc3VsdENvZGU7XHJcblxyXG5jb25zdCBSRVNFVF9QT1dFUl9PRkYgPSA2O1xyXG5jb25zdCBTRVRfUE9XRVJfT0ZGID0gNztcclxuY29uc3QgQ0xFQVJfQVZHX01JTl9NQVggPSA1O1xyXG5jb25zdCBQVUxTRV9DTUQgPSA5O1xyXG5cclxuY2xhc3MgU2VuZWNhTVNDXHJcbntcclxuICAgIGNvbnN0cnVjdG9yKGZuU2VuZEFuZFJlc3BvbnNlKSB7XHJcbiAgICAgICAgdGhpcy5TZW5kQW5kUmVzcG9uc2UgPSBmblNlbmRBbmRSZXNwb25zZTtcclxuICAgIH1cclxuICAgIC8qKlxyXG4gICAgICogR2V0cyB0aGUgbWV0ZXIgc2VyaWFsIG51bWJlciAoMTIzNDVfMTIzNClcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge3N0cmluZ31cclxuICAgICAqL1xyXG4gICAgIGFzeW5jIGdldFNlcmlhbE51bWJlcigpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIHNlcmlhbCBudW1iZXJcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVNlcmlhbE51bWJlcigpKTtcclxuICAgICAgICByZXR1cm4gc2VuZWNhTUIucGFyc2VTZXJpYWxOdW1iZXIocmVzcG9uc2UpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogR2V0cyB0aGUgY3VycmVudCBtb2RlIHNldCBvbiB0aGUgTVNDIGRldmljZVxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7Q29tbWFuZFR5cGV9IGFjdGl2ZSBtb2RlXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldEN1cnJlbnRNb2RlKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgY3VycmVudCBtb2RlXCIpO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VDdXJyZW50TW9kZSgpKTtcclxuICAgICAgICByZXR1cm4gc2VuZWNhTUIucGFyc2VDdXJyZW50TW9kZShyZXNwb25zZSwgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEdldHMgdGhlIGJhdHRlcnkgdm9sdGFnZSBmcm9tIHRoZSBtZXRlciBmb3IgYmF0dGVyeSBsZXZlbCBpbmRpY2F0aW9uXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtudW1iZXJ9IHZvbHRhZ2UgKFYpXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldEJhdHRlcnlWb2x0YWdlKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgYmF0dGVyeSB2b2x0YWdlXCIpO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VCYXR0ZXJ5TGV2ZWwoKSk7XHJcbiAgICAgICAgcmV0dXJuIE1hdGgucm91bmQoc2VuZWNhTUIucGFyc2VCYXR0ZXJ5KHJlc3BvbnNlKSAqIDEwMCkgLyAxMDA7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBDaGVjayBtZWFzdXJlbWVudCBlcnJvciBmbGFncyBmcm9tIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtib29sZWFufVxyXG4gICAgICovXHJcbiAgICBhc3luYyBnZXRRdWFsaXR5VmFsaWQoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBtZWFzdXJlIHF1YWxpdHkgYml0XCIpO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VRdWFsaXR5Qml0UmVxdWVzdCgpKTtcclxuICAgICAgICByZXR1cm4gc2VuZWNhTUIuaXNRdWFsaXR5VmFsaWQocmVzcG9uc2UpO1xyXG4gICAgfVxyXG4gICAgXHJcbiAgICAvKipcclxuICAgICAqIENoZWNrIGdlbmVyYXRpb24gZXJyb3IgZmxhZ3MgZnJvbSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7Ym9vbGVhbn1cclxuICAgICAqL1xyXG4gICAgYXN5bmMgZ2V0R2VuUXVhbGl0eVZhbGlkKGN1cnJlbnRfbW9kZSlcclxuICAgIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIGdlbmVyYXRpb24gcXVhbGl0eSBiaXRcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZUdlblN0YXR1c1JlYWQoKSk7XHJcbiAgICAgICAgcmV0dXJuIHNlbmVjYU1CLnBhcnNlR2VuU3RhdHVzKHJlc3BvbnNlLCBjdXJyZW50X21vZGUpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUmVhZHMgdGhlIG1lYXN1cmVtZW50cyBmcm9tIHRoZSBtZXRlciwgaW5jbHVkaW5nIGVycm9yIGZsYWdzXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgY3VycmVudCBtZXRlciBtb2RlIFxyXG4gICAgICogQHJldHVybnMge2FycmF5fG51bGx9IG1lYXN1cmVtZW50IGFycmF5ICh1bml0cywgdmFsdWVzLCBlcnJvciBmbGFnKVxyXG4gICAgICovXHJcbiAgICBhc3luYyBnZXRNZWFzdXJlcyhtb2RlKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBtZWFzdXJlc1wiKTtcclxuICAgICAgICB2YXIgdmFsaWQgPSBhd2FpdCB0aGlzLmdldFF1YWxpdHlWYWxpZCgpO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VNZWFzdXJlUmVxdWVzdChtb2RlKSk7XHJcbiAgICAgICAgaWYgKHJlc3BvbnNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgdmFyIG1lYXMgPSBzZW5lY2FNQi5wYXJzZU1lYXN1cmUocmVzcG9uc2UsIG1vZGUpO1xyXG4gICAgICAgICAgICBtZWFzW1wiZXJyb3JcIl0gPSAhdmFsaWQ7XHJcbiAgICAgICAgICAgIHJldHVybiBtZWFzO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFJlYWRzIHRoZSBhY3RpdmUgc2V0cG9pbnRzIGZyb20gdGhlIG1ldGVyLCBpbmNsdWRpbmcgZXJyb3IgZmxhZ3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1ldGVyIG1vZGUgXHJcbiAgICAgKiBAcmV0dXJucyB7YXJyYXl8bnVsbH0gc2V0cG9pbnRzIGFycmF5ICh1bml0cywgdmFsdWVzLCBlcnJvciBmbGFnKVxyXG4gICAgICovXHJcbiAgICBhc3luYyBnZXRTZXRwb2ludHMobW9kZSkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2V0cG9pbnRzXCIpO1xyXG4gICAgICAgIHZhciB2YWxpZCA9IGF3YWl0IHRoaXMuZ2V0R2VuUXVhbGl0eVZhbGlkKG1vZGUpO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VTZXRwb2ludFJlYWQobW9kZSkpO1xyXG4gICAgICAgIGlmIChyZXNwb25zZSAhPSBudWxsKSB7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHRzID0gc2VuZWNhTUIucGFyc2VTZXRwb2ludFJlYWQocmVzcG9uc2UsIG1vZGUpO1xyXG4gICAgICAgICAgICByZXN1bHRzW1wiZXJyb3JcIl0gPSAhdmFsaWQ7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFB1dHMgdGhlIG1ldGVyIGluIE9GRiBtb2RlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcbiAgICBhc3luYyBzd2l0Y2hPZmYoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciB0byBPRkZcIik7XHJcbiAgICAgICAgdmFyIHBhY2tldCA9IHNlbmVjYU1CLm1ha2VNb2RlUmVxdWVzdChDb21tYW5kVHlwZS5PRkYpO1xyXG4gICAgICAgIGlmIChwYWNrZXQgPT0gbnVsbClcclxuICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG5cclxuICAgICAgICBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBXcml0ZSB0aGUgc2V0cG9pbnRzIHRvIHRoZSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjb21tYW5kX3R5cGUgdHlwZSBvZiBnZW5lcmF0aW9uIGNvbW1hbmRcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludCBzZXRwb2ludCBvZiBnZW5lcmF0aW9uXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQyIGZhY3VsdGF0aXZlLCBzZWNvbmQgc2V0cG9pbnRcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcbiAgICBhc3luYyB3cml0ZVNldHBvaW50cyhjb21tYW5kX3R5cGUsIHNldHBvaW50LCBzZXRwb2ludDIpIHtcclxuICAgICAgICB2YXIgc3RhcnRHZW47XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBjb21tYW5kOlwiKyBjb21tYW5kX3R5cGUgKyBcIiwgc2V0cG9pbnQ6IFwiICsgc2V0cG9pbnQgKyBcIiwgc2V0cG9pbnQgMjogXCIgKyBzZXRwb2ludDIpO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHNlbmVjYU1CLm1ha2VTZXRwb2ludFJlcXVlc3QoY29tbWFuZF90eXBlLCBzZXRwb2ludCwgc2V0cG9pbnQyKSk7XHJcbiAgICAgICAgaWYgKHJlc3BvbnNlICE9IG51bGwgJiYgIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAwKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfU0hPVUxEX1JFVFJZO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gU3BlY2lhbCBoYW5kbGluZyBvZiB0aGUgU0VUIERlbGF5IGNvbW1hbmRcclxuICAgICAgICBzd2l0Y2ggKGNvbW1hbmRfdHlwZSkge1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG4gICAgICAgICAgICAgICAgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkNNRCwgW1JFU0VUX1BPV0VSX09GRl0pO1xyXG4gICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAxKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBDbGVhciBBdmcvTWluL01heCBzdGF0aXN0aWNzXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcbiAgICBhc3luYyBjbGVhclN0YXRpc3RpY3MoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVzZXR0aW5nIHN0YXRpc3RpY3NcIik7XHJcbiAgICAgICAgdmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtDTEVBUl9BVkdfTUlOX01BWF0pO1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAxKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBCZWdpbnMgdGhlIHB1bHNlIGdlbmVyYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIHN0YXJ0UHVsc2VHZW4oKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U3RhcnRpbmcgcHVsc2UgZ2VuZXJhdGlvblwiKTtcclxuICAgICAgICB2YXIgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtQVUxTRV9DTUQsIDJdKTsgLy8gU3RhcnQgd2l0aCBsb3dcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcbiAgICAgICAgaWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMikpIHtcclxuICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQmVnaW5zIHRoZSBmcmVxdWVuY3kgZ2VuZXJhdGlvblxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgc3RhcnRGcmVxR2VuKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFN0YXJ0aW5nIGZyZXEgZ2VuXCIpO1xyXG4gICAgICAgIHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuR0VOX0NNRCwgW1BVTFNFX0NNRCwgMV0pOyAvLyBzdGFydCBnZW5cclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcbiAgICAgICAgaWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMikpIHtcclxuICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogRGlzYWJsZSBhdXRvIHBvd2VyIG9mZiB0byB0aGUgbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGRpc2FibGVQb3dlck9mZigpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHREaXNhYmxpbmcgcG93ZXIgb2ZmXCIpO1xyXG4gICAgICAgIHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBDaGFuZ2VzIHRoZSBjdXJyZW50IG1vZGUgb24gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGNvbW1hbmRfdHlwZSB0aGUgbmV3IG1vZGUgdG8gc2V0IHRoZSBtZXRlciBpblxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGNoYW5nZU1vZGUoY29tbWFuZF90eXBlKVxyXG4gICAge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFNldHRpbmcgbWV0ZXIgbW9kZSB0byA6XCIgKyBjb21tYW5kX3R5cGUpO1xyXG4gICAgICAgIHZhciBwYWNrZXQgPSBzZW5lY2FNQi5tYWtlTW9kZVJlcXVlc3QoY29tbWFuZF90eXBlKTtcclxuICAgICAgICBpZiAocGFja2V0ID09IG51bGwpIHtcclxuICAgICAgICAgICAgbG9nLmVycm9yKFwiQ291bGQgbm90IGdlbmVyYXRlIG1vZGJ1cyBwYWNrZXQgZm9yIGNvbW1hbmQgdHlwZVwiLCBjb21tYW5kX3R5cGUpO1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG5cclxuICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAwKSkge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZCB0eXBlXCIsIGNvbW1hbmRfdHlwZSk7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHZhciByZXN1bHQgPSBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcblxyXG4gICAgICAgIC8vIFNvbWUgY29tbWFuZHMgcmVxdWlyZSBhZGRpdGlvbmFsIGNvbW1hbmQgdG8gYmUgZ2l2ZW4gdG8gd29yayBwcm9wZXJseSwgYWZ0ZXIgYSBzbGlnaHQgZGVsYXlcclxuICAgICAgICBzd2l0Y2ggKGNvbW1hbmRfdHlwZSkge1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlY6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubVY6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5jbGVhclN0YXRpc3RpY3MoKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLnN0YXJ0UHVsc2VHZW4oKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuc3RhcnRGcmVxR2VuKCk7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChyZXN1bHQgPT0gUmVzdWx0Q29kZS5TVUNDRVNTKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZGlzYWJsZVBvd2VyT2ZmKCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtTZW5lY2FNU0N9OyIsIi8qKlxyXG4gKiBDb21tYW5kIHR5cGUsIGFrYSBtb2RlIHZhbHVlIHRvIGJlIHdyaXR0ZW4gaW50byBNU0MgY3VycmVudCBzdGF0ZSByZWdpc3RlclxyXG4gKiAqL1xyXG4gY29uc3QgQ29tbWFuZFR5cGUgPSB7XHJcbiAgICBOT05FX1VOS05PV046IDAsIC8qKiogTUVBU1VSSU5HIEZFQVRVUkVTIEFGVEVSIFRISVMgUE9JTlQgKioqKioqKi9cclxuICAgIG1BX3Bhc3NpdmU6IDEsXHJcbiAgICBtQV9hY3RpdmU6IDIsXHJcbiAgICBWOiAzLFxyXG4gICAgbVY6IDQsXHJcbiAgICBUSEVSTU9fSjogNSwgLy8gVGVybW9jb3BwaWVcclxuICAgIFRIRVJNT19LOiA2LFxyXG4gICAgVEhFUk1PX1Q6IDcsXHJcbiAgICBUSEVSTU9fRTogOCxcclxuICAgIFRIRVJNT19MOiA5LFxyXG4gICAgVEhFUk1PX046IDEwLFxyXG4gICAgVEhFUk1PX1I6IDExLFxyXG4gICAgVEhFUk1PX1M6IDEyLFxyXG4gICAgVEhFUk1PX0I6IDEzLFxyXG4gICAgUFQxMDBfMlc6IDE0LCAvLyBSVEQgMiBmaWxpXHJcbiAgICBQVDEwMF8zVzogMTUsXHJcbiAgICBQVDEwMF80VzogMTYsXHJcbiAgICBQVDUwMF8yVzogMTcsXHJcbiAgICBQVDUwMF8zVzogMTgsXHJcbiAgICBQVDUwMF80VzogMTksXHJcbiAgICBQVDEwMDBfMlc6IDIwLFxyXG4gICAgUFQxMDAwXzNXOiAyMSxcclxuICAgIFBUMTAwMF80VzogMjIsXHJcbiAgICBDdTUwXzJXOiAyMyxcclxuICAgIEN1NTBfM1c6IDI0LFxyXG4gICAgQ3U1MF80VzogMjUsXHJcbiAgICBDdTEwMF8yVzogMjYsXHJcbiAgICBDdTEwMF8zVzogMjcsXHJcbiAgICBDdTEwMF80VzogMjgsXHJcbiAgICBOaTEwMF8yVzogMjksXHJcbiAgICBOaTEwMF8zVzogMzAsXHJcbiAgICBOaTEwMF80VzogMzEsXHJcbiAgICBOaTEyMF8yVzogMzIsXHJcbiAgICBOaTEyMF8zVzogMzMsXHJcbiAgICBOaTEyMF80VzogMzQsXHJcbiAgICBMb2FkQ2VsbDogMzUsICAgLy8gQ2VsbGUgZGkgY2FyaWNvXHJcbiAgICBGcmVxdWVuY3k6IDM2LCAgLy8gRnJlcXVlbnphXHJcbiAgICBQdWxzZVRyYWluOiAzNywgLy8gQ29udGVnZ2lvIGltcHVsc2lcclxuICAgIFJFU0VSVkVEOiAzOCxcclxuICAgIFJFU0VSVkVEXzI6IDQwLFxyXG4gICAgT0ZGOiAxMDAsIC8vICoqKioqKioqKiBHRU5FUkFUSU9OIEFGVEVSIFRISVMgUE9JTlQgKioqKioqKioqKioqKioqKiovXHJcbiAgICBHRU5fbUFfcGFzc2l2ZTogMTAxLFxyXG4gICAgR0VOX21BX2FjdGl2ZTogMTAyLFxyXG4gICAgR0VOX1Y6IDEwMyxcclxuICAgIEdFTl9tVjogMTA0LFxyXG4gICAgR0VOX1RIRVJNT19KOiAxMDUsXHJcbiAgICBHRU5fVEhFUk1PX0s6IDEwNixcclxuICAgIEdFTl9USEVSTU9fVDogMTA3LFxyXG4gICAgR0VOX1RIRVJNT19FOiAxMDgsXHJcbiAgICBHRU5fVEhFUk1PX0w6IDEwOSxcclxuICAgIEdFTl9USEVSTU9fTjogMTEwLFxyXG4gICAgR0VOX1RIRVJNT19SOiAxMTEsXHJcbiAgICBHRU5fVEhFUk1PX1M6IDExMixcclxuICAgIEdFTl9USEVSTU9fQjogMTEzLFxyXG4gICAgR0VOX1BUMTAwXzJXOiAxMTQsXHJcbiAgICBHRU5fUFQ1MDBfMlc6IDExNyxcclxuICAgIEdFTl9QVDEwMDBfMlc6IDEyMCxcclxuICAgIEdFTl9DdTUwXzJXOiAxMjMsXHJcbiAgICBHRU5fQ3UxMDBfMlc6IDEyNixcclxuICAgIEdFTl9OaTEwMF8yVzogMTI5LFxyXG4gICAgR0VOX05pMTIwXzJXOiAxMzIsXHJcbiAgICBHRU5fTG9hZENlbGw6IDEzNSxcclxuICAgIEdFTl9GcmVxdWVuY3k6IDEzNixcclxuICAgIEdFTl9QdWxzZVRyYWluOiAxMzcsXHJcbiAgICBHRU5fUkVTRVJWRUQ6IDEzOCxcclxuICAgIC8vIFNwZWNpYWwgc2V0dGluZ3MgYmVsb3cgdGhpcyBwb2ludHNcclxuICAgIFNFVFRJTkdfUkVTRVJWRUQ6IDEwMDAsXHJcbiAgICBTRVRfVVRocmVzaG9sZF9GOiAxMDAxLFxyXG4gICAgU0VUX1NlbnNpdGl2aXR5X3VTOiAxMDAyLFxyXG4gICAgU0VUX0NvbGRKdW5jdGlvbjogMTAwMyxcclxuICAgIFNFVF9VbG93OiAxMDA0LFxyXG4gICAgU0VUX1VoaWdoOiAxMDA1LFxyXG4gICAgU0VUX1NodXRkb3duRGVsYXk6IDEwMDZcclxufTtcclxuXHJcblxyXG5cclxuXHJcbi8qXHJcbiAqIEludGVybmFsIHN0YXRlIG1hY2hpbmUgZGVzY3JpcHRpb25zXHJcbiAqL1xyXG5jb25zdCBTdGF0ZSA9IHtcclxuICAgIE5PVF9DT05ORUNURUQ6ICdOb3QgY29ubmVjdGVkJyxcclxuICAgIENPTk5FQ1RJTkc6ICdCbHVldG9vdGggZGV2aWNlIHBhaXJpbmcuLi4nLFxyXG4gICAgREVWSUNFX1BBSVJFRDogJ0RldmljZSBwYWlyZWQnLFxyXG4gICAgU1VCU0NSSUJJTkc6ICdCbHVldG9vdGggaW50ZXJmYWNlcyBjb25uZWN0aW5nLi4uJyxcclxuICAgIElETEU6ICdJZGxlJyxcclxuICAgIEJVU1k6ICdCdXN5JyxcclxuICAgIEVSUk9SOiAnRXJyb3InLFxyXG4gICAgU1RPUFBJTkc6ICdDbG9zaW5nIEJUIGludGVyZmFjZXMuLi4nLFxyXG4gICAgU1RPUFBFRDogJ1N0b3BwZWQnLFxyXG4gICAgTUVURVJfSU5JVDogJ01ldGVyIGNvbm5lY3RlZCcsXHJcbiAgICBNRVRFUl9JTklUSUFMSVpJTkc6ICdSZWFkaW5nIG1ldGVyIHN0YXRlLi4uJ1xyXG59O1xyXG5cclxuY29uc3QgUmVzdWx0Q29kZSA9IHtcclxuICAgIEZBSUxFRF9OT19SRVRSWTogMSxcclxuICAgIEZBSUxFRF9TSE9VTERfUkVUUlk6IDIsXHJcbiAgICBTVUNDRVNTOiAwXHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1N0YXRlLCBDb21tYW5kVHlwZSwgUmVzdWx0Q29kZSB9IiwiJ3VzZSBzdHJpY3QnO1xyXG5cclxuY29uc3QgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG5jb25zdCBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG5jb25zdCBBUElTdGF0ZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9BUElTdGF0ZScpO1xyXG5jb25zdCBDb21tYW5kID0gcmVxdWlyZSgnLi9jbGFzc2VzL0NvbW1hbmQnKTtcclxuY29uc3QgUHVibGljQVBJID1yZXF1aXJlKCcuL21ldGVyUHVibGljQVBJJyk7XHJcbmNvbnN0IFRlc3REYXRhID1yZXF1aXJlKCcuL21vZGJ1c1Rlc3REYXRhJyk7XHJcblxyXG5sb2cuc2V0TGV2ZWwobG9nLmxldmVscy5FUlJPUiwgdHJ1ZSk7XHJcblxyXG5leHBvcnRzLlN0b3AgPSBQdWJsaWNBUEkuU3RvcDtcclxuZXhwb3J0cy5QYWlyID0gUHVibGljQVBJLlBhaXI7XHJcbmV4cG9ydHMuRXhlY3V0ZSA9IFB1YmxpY0FQSS5FeGVjdXRlO1xyXG5leHBvcnRzLlNpbXBsZUV4ZWN1dGUgPSBQdWJsaWNBUEkuU2ltcGxlRXhlY3V0ZTtcclxuZXhwb3J0cy5HZXRTdGF0ZSA9IFB1YmxpY0FQSS5HZXRTdGF0ZTtcclxuZXhwb3J0cy5TdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZTtcclxuZXhwb3J0cy5Db21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuZXhwb3J0cy5Db21tYW5kID0gQ29tbWFuZDtcclxuZXhwb3J0cy5QYXJzZSA9IFB1YmxpY0FQSS5QYXJzZTtcclxuZXhwb3J0cy5sb2cgPSBsb2c7XHJcbmV4cG9ydHMuR2V0U3RhdGVKU09OID0gUHVibGljQVBJLkdldFN0YXRlSlNPTjtcclxuZXhwb3J0cy5FeGVjdXRlSlNPTiA9IFB1YmxpY0FQSS5FeGVjdXRlSlNPTjtcclxuZXhwb3J0cy5TaW1wbGVFeGVjdXRlSlNPTiA9IFB1YmxpY0FQSS5TaW1wbGVFeGVjdXRlSlNPTjtcclxuZXhwb3J0cy5HZXRKc29uVHJhY2VzID0gVGVzdERhdGEuR2V0SnNvblRyYWNlcztcclxuXHJcbiIsIi8qXHJcbiAqIFRoaXMgZmlsZSBjb250YWlucyB0aGUgcHVibGljIEFQSSBvZiB0aGUgbWV0ZXIsIGkuZS4gdGhlIGZ1bmN0aW9ucyBkZXNpZ25lZFxyXG4gKiB0byBiZSBjYWxsZWQgZnJvbSB0aGlyZCBwYXJ0eSBjb2RlLlxyXG4gKiAxLSBQYWlyKCkgOiBib29sXHJcbiAqIDItIEV4ZWN1dGUoQ29tbWFuZCkgOiBib29sICsgSlNPTiB2ZXJzaW9uXHJcbiAqIDMtIFN0b3AoKSA6IGJvb2xcclxuICogNC0gR2V0U3RhdGUoKSA6IGFycmF5ICsgSlNPTiB2ZXJzaW9uXHJcbiAqIDUtIFNpbXBsZUV4ZWN1dGUoQ29tbWFuZCkgOiByZXR1cm5zIHRoZSB1cGRhdGVkIG1lYXN1cmVtZW50IG9yIG51bGxcclxuICovXHJcblxyXG52YXIgQ29tbWFuZFJlc3VsdCA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9Db21tYW5kUmVzdWx0Jyk7XHJcbnZhciBBUElTdGF0ZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9BUElTdGF0ZScpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi9jb25zdGFudHMnKTtcclxudmFyIGJsdWV0b290aCA9IHJlcXVpcmUoJy4vYmx1ZXRvb3RoJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcclxudmFyIGxvZyA9IHJlcXVpcmUoJ2xvZ2xldmVsJyk7XHJcbnZhciBtZXRlckFwaSA9IHJlcXVpcmUoJy4vbWV0ZXJBcGknKTtcclxuXHJcbnZhciBidFN0YXRlID0gQVBJU3RhdGUuYnRTdGF0ZTtcclxudmFyIFN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgYSBjb3B5IG9mIHRoZSBjdXJyZW50IHN0YXRlXHJcbiAqIEByZXR1cm5zIHthcnJheX0gc3RhdHVzIG9mIG1ldGVyXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBHZXRTdGF0ZSgpIHtcclxuICAgIGxldCByZWFkeSA9IGZhbHNlO1xyXG4gICAgbGV0IGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgc3dpdGNoIChidFN0YXRlLnN0YXRlKSB7XHJcbiAgICAgICAgLy8gU3RhdGVzIHJlcXVpcmluZyB1c2VyIGlucHV0XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5FUlJPUjpcclxuICAgICAgICBjYXNlIFN0YXRlLlNUT1BQRUQ6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5OT1RfQ09OTkVDVEVEOlxyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5CVVNZOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuSURMRTpcclxuICAgICAgICAgICAgcmVhZHkgPSB0cnVlO1xyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5DT05ORUNUSU5HOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuREVWSUNFX1BBSVJFRDpcclxuICAgICAgICBjYXNlIFN0YXRlLk1FVEVSX0lOSVQ6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVUJTQ1JJQklORzpcclxuICAgICAgICAgICAgaW5pdGlhbGl6aW5nID0gdHJ1ZTtcclxuICAgICAgICAgICAgcmVhZHkgPSBmYWxzZTtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmVhZHkgPSBmYWxzZTtcclxuICAgICAgICAgICAgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIFwibGFzdFNldHBvaW50XCI6IGJ0U3RhdGUubGFzdFNldHBvaW50LFxyXG4gICAgICAgIFwibGFzdE1lYXN1cmVcIjogYnRTdGF0ZS5sYXN0TWVhc3VyZSxcclxuICAgICAgICBcImRldmljZU5hbWVcIjogYnRTdGF0ZS5idERldmljZSA/IGJ0U3RhdGUuYnREZXZpY2UubmFtZSA6IFwiXCIsXHJcbiAgICAgICAgXCJkZXZpY2VTZXJpYWxcIjogYnRTdGF0ZS5tZXRlcj8uc2VyaWFsLFxyXG4gICAgICAgIFwic3RhdHNcIjogYnRTdGF0ZS5zdGF0cyxcclxuICAgICAgICBcImRldmljZU1vZGVcIjogYnRTdGF0ZS5tZXRlcj8ubW9kZSxcclxuICAgICAgICBcInN0YXR1c1wiOiBidFN0YXRlLnN0YXRlLFxyXG4gICAgICAgIFwiYmF0dGVyeUxldmVsXCI6IGJ0U3RhdGUubWV0ZXI/LmJhdHRlcnksXHJcbiAgICAgICAgXCJyZWFkeVwiOiByZWFkeSxcclxuICAgICAgICBcImluaXRpYWxpemluZ1wiOiBpbml0aWFsaXppbmdcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQcm92aWRlZCBmb3IgY29tcGF0aWJpbGl0eSB3aXRoIEJsYXpvclxyXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBKU09OIHN0YXRlIG9iamVjdFxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gR2V0U3RhdGVKU09OKCkge1xyXG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IEdldFN0YXRlKCkpO1xyXG59XHJcblxyXG4vKipcclxuICogRXhlY3V0ZSBjb21tYW5kIHdpdGggc2V0cG9pbnRzLCBKU09OIHZlcnNpb25cclxuICogQHBhcmFtIHtzdHJpbmd9IGpzb25Db21tYW5kIHRoZSBjb21tYW5kIHRvIGV4ZWN1dGVcclxuICogQHJldHVybnMge3N0cmluZ30gSlNPTiBjb21tYW5kIG9iamVjdFxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gRXhlY3V0ZUpTT04oanNvbkNvbW1hbmQpIHtcclxuICAgIGxldCBjb21tYW5kID0gSlNPTi5wYXJzZShqc29uQ29tbWFuZCk7XHJcbiAgICAvLyBkZXNlcmlhbGl6ZWQgb2JqZWN0IGhhcyBsb3N0IGl0cyBtZXRob2RzLCBsZXQncyByZWNyZWF0ZSBhIGNvbXBsZXRlIG9uZS5cclxuICAgIGxldCBjb21tYW5kMiA9bWV0ZXJBcGkuQ29tbWFuZC5DcmVhdGVUd29TUChjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBFeGVjdXRlKGNvbW1hbmQyKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIFNpbXBsZUV4ZWN1dGVKU09OKGpzb25Db21tYW5kKSB7XHJcbiAgICBsZXQgY29tbWFuZCA9IEpTT04ucGFyc2UoanNvbkNvbW1hbmQpO1xyXG4gICAgLy8gZGVzZXJpYWxpemVkIG9iamVjdCBoYXMgbG9zdCBpdHMgbWV0aG9kcywgbGV0J3MgcmVjcmVhdGUgYSBjb21wbGV0ZSBvbmUuXHJcbiAgICBsZXQgY29tbWFuZDIgPSBtZXRlckFwaS5Db21tYW5kLkNyZWF0ZVR3b1NQKGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpO1xyXG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IFNpbXBsZUV4ZWN1dGUoY29tbWFuZDIpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4ZWN1dGUgYSBjb21tYW5kIGFuZCByZXR1cm5zIHRoZSBtZWFzdXJlbWVudCBvciBzZXRwb2ludCB3aXRoIGVycm9yIGZsYWcgYW5kIG1lc3NhZ2VcclxuICogQHBhcmFtIHtDb21tYW5kfSBjb21tYW5kXHJcbiAqL1xyXG4gYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZShjb21tYW5kKSB7XHJcbiAgICBjb25zdCBTSU1QTEVfRVhFQ1VURV9USU1FT1VUX1MgPSA1O1xyXG4gICAgdmFyIGNyID0gbmV3IENvbW1hbmRSZXN1bHQoKTtcclxuXHJcbiAgICBsb2cuaW5mbyhcIlNpbXBsZUV4ZWN1dGUgY2FsbGVkLi4uXCIpO1xyXG5cclxuICAgIGlmIChjb21tYW5kID09IG51bGwpXHJcbiAgICB7XHJcbiAgICAgICAgY3Iuc3VjY2VzcyA9IGZhbHNlO1xyXG4gICAgICAgIGNyLm1lc3NhZ2UgPSBcIkludmFsaWQgY29tbWFuZFwiO1xyXG4gICAgICAgIHJldHVybiBjcjtcclxuICAgIH1cclxuXHJcbiAgICBjb21tYW5kLnBlbmRpbmcgPSB0cnVlOyAvLyBJbiBjYXNlIGNhbGxlciBkb2VzIG5vdCBzZXQgcGVuZGluZyBmbGFnXHJcblxyXG4gICAgLy8gRmFpbCBpbW1lZGlhdGVseSBpZiBub3QgcGFpcmVkLlxyXG4gICAgaWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuICAgICAgICBjci5zdWNjZXNzID0gZmFsc2U7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiRGV2aWNlIGlzIG5vdCBwYWlyZWRcIjtcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQW5vdGhlciBjb21tYW5kIG1heSBiZSBwZW5kaW5nLlxyXG4gICAgaWYgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsICYmIGJ0U3RhdGUuY29tbWFuZC5wZW5kaW5nKSB7XHJcbiAgICAgICAgY3Iuc3VjY2VzcyA9IGZhbHNlO1xyXG4gICAgICAgIGNyLm1lc3NhZ2UgPSBcIkFub3RoZXIgY29tbWFuZCBpcyBwZW5kaW5nXCI7XHJcbiAgICAgICAgbG9nLndhcm4oY3IubWVzc2FnZSk7XHJcbiAgICAgICAgcmV0dXJuIGNyO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFdhaXQgZm9yIGNvbXBsZXRpb24gb2YgdGhlIGNvbW1hbmQsIG9yIGhhbHQgb2YgdGhlIHN0YXRlIG1hY2hpbmVcclxuICAgIGJ0U3RhdGUuY29tbWFuZCA9IGNvbW1hbmQ7IFxyXG4gICAgaWYgKGNvbW1hbmQgIT0gbnVsbCkge1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLndhaXRGb3JUaW1lb3V0KCgpID0+ICFjb21tYW5kLnBlbmRpbmcgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVELCBTSU1QTEVfRVhFQ1VURV9USU1FT1VUX1MpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIENoZWNrIGlmIGVycm9yIG9yIHRpbWVvdXRzXHJcbiAgICBpZiAoY29tbWFuZC5lcnJvciB8fCBjb21tYW5kLnBlbmRpbmcpICBcclxuICAgIHtcclxuICAgICAgICBjci5zdWNjZXNzID0gZmFsc2U7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiRXJyb3Igd2hpbGUgZXhlY3V0aW5nIHRoZSBjb21tYW5kLlwiXHJcbiAgICAgICAgbG9nLndhcm4oY3IubWVzc2FnZSk7XHJcbiAgICAgICAgXHJcbiAgICAgICAgLy8gUmVzZXQgdGhlIGFjdGl2ZSBjb21tYW5kXHJcbiAgICAgICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3RhdGUgaXMgdXBkYXRlZCBieSBleGVjdXRlIGNvbW1hbmQsIHNvIHdlIGNhbiB1c2UgYnRTdGF0ZSByaWdodCBhd2F5XHJcbiAgICBpZiAodXRpbHMuaXNHZW5lcmF0aW9uKGNvbW1hbmQudHlwZSkpXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSBidFN0YXRlLmxhc3RTZXRwb2ludFtcIlZhbHVlXCJdO1xyXG4gICAgICAgIGNyLnVuaXQgPSBidFN0YXRlLmxhc3RTZXRwb2ludFtcIlVuaXRcIl07XHJcbiAgICB9XHJcbiAgICBlbHNlIGlmICh1dGlscy5pc01lYXN1cmVtZW50KGNvbW1hbmQudHlwZSkpXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSBidFN0YXRlLmxhc3RNZWFzdXJlW1wiVmFsdWVcIl07XHJcbiAgICAgICAgY3IudW5pdCA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJVbml0XCJdO1xyXG4gICAgICAgIGNyLnNlY29uZGFyeV92YWx1ZSA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJTZWNvbmRhcnlWYWx1ZVwiXTtcclxuICAgICAgICBjci5zZWNvbmRhcnlfdW5pdCA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJTZWNvbmRhcnlVbml0XCJdO1xyXG4gICAgfVxyXG4gICAgZWxzZVxyXG4gICAge1xyXG4gICAgICAgIGNyLnZhbHVlID0gMC4wOyAvLyBTZXR0aW5ncyBjb21tYW5kcztcclxuICAgIH1cclxuXHJcbiAgICBjci5zdWNjZXNzID0gdHJ1ZTtcclxuICAgIGNyLm1lc3NhZ2UgPSBcIkNvbW1hbmQgZXhlY3V0ZWQgc3VjY2Vzc2Z1bGx5XCI7XHJcbiAgICByZXR1cm4gY3I7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRlcm5hbCBpbnRlcmZhY2UgdG8gcmVxdWlyZSBhIGNvbW1hbmQgdG8gYmUgZXhlY3V0ZWQuXHJcbiAqIFRoZSBibHVldG9vdGggZGV2aWNlIHBhaXJpbmcgd2luZG93IHdpbGwgb3BlbiBpZiBkZXZpY2UgaXMgbm90IGNvbm5lY3RlZC5cclxuICogVGhpcyBtYXkgZmFpbCBpZiBjYWxsZWQgb3V0c2lkZSBhIHVzZXIgZ2VzdHVyZS5cclxuICogQHBhcmFtIHtDb21tYW5kfSBjb21tYW5kXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlKGNvbW1hbmQpIHtcclxuICAgIGxvZy5pbmZvKFwiRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgPT0gbnVsbClcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICBcclxuICAgIGNvbW1hbmQucGVuZGluZyA9IHRydWU7XHJcblxyXG4gICAgdmFyIGNwdCA9IDA7XHJcbiAgICB3aGlsZSAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcgJiYgY3B0IDwgMzAwKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiV2FpdGluZyBmb3IgY3VycmVudCBjb21tYW5kIHRvIGNvbXBsZXRlLi4uXCIpO1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcbiAgICAgICAgY3B0Kys7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIGxvZy5pbmZvKFwiU2V0dGluZyBuZXcgY29tbWFuZCA6XCIgKyBjb21tYW5kKTtcclxuICAgIGJ0U3RhdGUuY29tbWFuZCA9IGNvbW1hbmQ7XHJcblxyXG4gICAgLy8gU3RhcnQgdGhlIHJlZ3VsYXIgc3RhdGUgbWFjaGluZVxyXG4gICAgaWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuICAgICAgICBhd2FpdCBibHVldG9vdGguc3RhdGVNYWNoaW5lKCk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG4gICAgaWYgKGNvbW1hbmQgIT0gbnVsbCkge1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLndhaXRGb3IoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQpO1xyXG4gICAgfVxyXG4gICAgXHJcbiAgICAvLyBSZXR1cm4gdGhlIGNvbW1hbmQgb2JqZWN0IHJlc3VsdFxyXG4gICAgcmV0dXJuIGNvbW1hbmQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNVVNUIEJFIENBTExFRCBGUk9NIEEgVVNFUiBHRVNUVVJFIEVWRU5UIEhBTkRMRVJcclxuICAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIG1ldGVyIGlzIHJlYWR5IHRvIGV4ZWN1dGUgY29tbWFuZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBQYWlyKGZvcmNlU2VsZWN0aW9uPWZhbHNlKSB7XHJcbiAgICBsb2cuaW5mbyhcIlBhaXIoXCIrZm9yY2VTZWxlY3Rpb24rXCIpIGNhbGxlZC4uLlwiKTtcclxuICAgIFxyXG4gICAgYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl0gPSBmb3JjZVNlbGVjdGlvbjtcclxuXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKTsgLy8gU3RhcnQgaXRcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuRVJST1IpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDsgLy8gVHJ5IHRvIHJlc3RhcnRcclxuICAgIH1cclxuICAgIGF3YWl0IHV0aWxzLndhaXRGb3IoKCkgPT4gYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5JRExFIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcbiAgICBsb2cuaW5mbyhcIlBhaXJpbmcgY29tcGxldGVkLCBzdGF0ZSA6XCIsIGJ0U3RhdGUuc3RhdGUpO1xyXG4gICAgcmV0dXJuIChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQpO1xyXG59XHJcblxyXG4vKipcclxuICogU3RvcHMgdGhlIHN0YXRlIG1hY2hpbmUgYW5kIGRpc2Nvbm5lY3RzIGJsdWV0b290aC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gU3RvcCgpIHtcclxuICAgIGxvZy5pbmZvKFwiU3RvcCByZXF1ZXN0IHJlY2VpdmVkXCIpO1xyXG5cclxuICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlO1xyXG4gICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcbiAgICB3aGlsZShidFN0YXRlLnN0YXJ0ZWQgfHwgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCAmJiBidFN0YXRlLnN0YXRlICE9IFN0YXRlLk5PVF9DT05ORUNURUQpKVxyXG4gICAge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlOyAgICBcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG4gICAgfVxyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSBmYWxzZTtcclxuICAgIGxvZy53YXJuKFwiU3RvcHBlZCBvbiByZXF1ZXN0LlwiKTtcclxuICAgIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtTdG9wLFBhaXIsRXhlY3V0ZSxFeGVjdXRlSlNPTixTaW1wbGVFeGVjdXRlLFNpbXBsZUV4ZWN1dGVKU09OLEdldFN0YXRlLEdldFN0YXRlSlNPTn0iLCIndXNlIHN0cmljdCc7XHJcblxyXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiogTU9EQlVTIFJUVSBoYW5kbGluZyAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKi9cclxuXHJcbnZhciBsb2cgPSByZXF1aXJlKCdsb2dsZXZlbCcpO1xyXG5cclxuY29uc3QgU0VORUNBX01CX1NMQVZFX0lEID0gMjU7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbmNsYXNzIE1vZGJ1c0Vycm9yIGV4dGVuZHMgRXJyb3Ige1xyXG4gICAgLyoqXHJcbiAgICAgKiBDcmVhdGVzIGEgbmV3IG1vZGJ1cyBlcnJvclxyXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IG1lc3NhZ2UgbWVzc2FnZVxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IGZjIGZ1bmN0aW9uIGNvZGVcclxuICAgICAqL1xyXG4gICAgY29udHJ1Y3RvcihtZXNzYWdlLCBmYykge1xyXG4gICAgICAgIHRoaXMubWVzc2FnZSA9IG1lc3NhZ2U7XHJcbiAgICAgICAgdGhpcy5mYyA9IGZjO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgNCBieXRlcyBDUkMgY29kZSBmcm9tIHRoZSBidWZmZXIgY29udGVudHNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBjcmMxNihidWZmZXIpIHtcclxuICAgIHZhciBjcmMgPSAweEZGRkY7XHJcbiAgICB2YXIgb2RkO1xyXG5cclxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgY3JjID0gY3JjIF4gYnVmZmVyW2ldO1xyXG5cclxuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IDg7IGorKykge1xyXG4gICAgICAgICAgICBvZGQgPSBjcmMgJiAweDAwMDE7XHJcbiAgICAgICAgICAgIGNyYyA9IGNyYyA+PiAxO1xyXG4gICAgICAgICAgICBpZiAob2RkKSB7XHJcbiAgICAgICAgICAgICAgICBjcmMgPSBjcmMgXiAweEEwMDE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGNyYztcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ha2UgYSBNb2RidXMgUmVhZCBIb2xkaW5nIFJlZ2lzdGVycyAoRkM9MDMpIHRvIHNlcmlhbCBwb3J0XHJcbiAqIFxyXG4gKiBAcGFyYW0ge251bWJlcn0gSUQgc2xhdmUgSURcclxuICogQHBhcmFtIHtudW1iZXJ9IGNvdW50IG51bWJlciBvZiByZWdpc3RlcnMgdG8gcmVhZFxyXG4gKiBAcGFyYW0ge251bWJlcn0gcmVnaXN0ZXIgc3RhcnRpbmcgcmVnaXN0ZXJcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VGQzMoSUQsIGNvdW50LCByZWdpc3Rlcikge1xyXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKDgpO1xyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhidWZmZXIpO1xyXG4gICAgdmlldy5zZXRVaW50OCgwLCBJRCk7XHJcbiAgICB2aWV3LnNldFVpbnQ4KDEsIDMpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoMiwgcmVnaXN0ZXIsIGZhbHNlKTtcclxuICAgIHZpZXcuc2V0VWludDE2KDQsIGNvdW50LCBmYWxzZSk7XHJcbiAgICB2YXIgY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkoYnVmZmVyLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoNiwgY3JjLCB0cnVlKTtcclxuICAgIHJldHVybiBidWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXcml0ZSBhIE1vZGJ1cyBcIlByZXNldCBNdWx0aXBsZSBSZWdpc3RlcnNcIiAoRkM9MTYpIHRvIHNlcmlhbCBwb3J0LlxyXG4gKlxyXG4gKiBAcGFyYW0ge251bWJlcn0gYWRkcmVzcyB0aGUgc2xhdmUgdW5pdCBhZGRyZXNzLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gZGF0YUFkZHJlc3MgdGhlIERhdGEgQWRkcmVzcyBvZiB0aGUgZmlyc3QgcmVnaXN0ZXIuXHJcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IHRoZSBhcnJheSBvZiB2YWx1ZXMgdG8gd3JpdGUgdG8gcmVnaXN0ZXJzLlxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMTYoYWRkcmVzcywgZGF0YUFkZHJlc3MsIGFycmF5KSB7XHJcbiAgICBjb25zdCBjb2RlID0gMTY7XHJcblxyXG4gICAgLy8gc2FuaXR5IGNoZWNrXHJcbiAgICBpZiAodHlwZW9mIGFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIgfHwgdHlwZW9mIGRhdGFBZGRyZXNzID09PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGxldCBkYXRhTGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xyXG5cclxuICAgIGNvbnN0IGNvZGVMZW5ndGggPSA3ICsgMiAqIGRhdGFMZW5ndGg7XHJcbiAgICBjb25zdCBidWYgPSBuZXcgQXJyYXlCdWZmZXIoY29kZUxlbmd0aCArIDIpOyAvLyBhZGQgMiBjcmMgYnl0ZXNcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1Zik7XHJcblxyXG4gICAgZHYuc2V0VWludDgoMCwgYWRkcmVzcyk7XHJcbiAgICBkdi5zZXRVaW50OCgxLCBjb2RlKTtcclxuICAgIGR2LnNldFVpbnQxNigyLCBkYXRhQWRkcmVzcywgZmFsc2UpO1xyXG4gICAgZHYuc2V0VWludDE2KDQsIGRhdGFMZW5ndGgsIGZhbHNlKTtcclxuICAgIGR2LnNldFVpbnQ4KDYsIGRhdGFMZW5ndGggKiAyKTtcclxuXHJcbiAgICAvLyBjb3B5IGNvbnRlbnQgb2YgYXJyYXkgdG8gYnVmXHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGFMZW5ndGg7IGkrKykge1xyXG4gICAgICAgIGR2LnNldFVpbnQxNig3ICsgMiAqIGksIGFycmF5W2ldLCBmYWxzZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gYWRkIGNyYyBieXRlcyB0byBidWZmZXJcclxuICAgIGR2LnNldFVpbnQxNihjb2RlTGVuZ3RoLCBjcmMxNihidWYuc2xpY2UoMCwgLTIpKSwgdHJ1ZSk7XHJcbiAgICByZXR1cm4gYnVmO1xyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgcmVnaXN0ZXJzIHZhbHVlcyBmcm9tIGEgRkMwMyBhbnN3ZXIgYnkgUlRVIHNsYXZlXHJcbiAqIFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzMocmVzcG9uc2UpIHtcclxuICAgIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHJlc3BvbnNlKTtcclxuICAgIHZhciBjb250ZW50cyA9IFtdO1xyXG5cclxuICAgIC8vIEludmFsaWQgbW9kYnVzIHBhY2tldFxyXG4gICAgaWYgKHJlc3BvbnNlLmxlbmd0aCA8IDUpXHJcbiAgICAgICAgcmV0dXJuO1xyXG5cclxuICAgIHZhciBjb21wdXRlZF9jcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShyZXNwb25zZS5zbGljZSgwLCAtMikpKTtcclxuICAgIHZhciBhY3R1YWxfY3JjID0gdmlldy5nZXRVaW50MTYodmlldy5ieXRlTGVuZ3RoIC0gMiwgdHJ1ZSk7XHJcblxyXG4gICAgaWYgKGNvbXB1dGVkX2NyYyAhPSBhY3R1YWxfY3JjKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgQ1JDIChleHBlY3RlZDpcIiArIGNvbXB1dGVkX2NyYyArIFwiLGdvdDpcIiArIGFjdHVhbF9jcmMgKyBcIilcIiwgMyk7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIGFkZHJlc3MgPSB2aWV3LmdldFVpbnQ4KDApO1xyXG4gICAgaWYgKGFkZHJlc3MgIT0gU0VORUNBX01CX1NMQVZFX0lEKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3Jvbmcgc2xhdmUgSUQgOlwiICsgYWRkcmVzcywgMyk7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIGZjID0gdmlldy5nZXRVaW50OCgxKTtcclxuICAgIGlmIChmYyA+IDEyOCkge1xyXG4gICAgICAgIHZhciBleHAgPSB2aWV3LmdldFVpbnQ4KDIpO1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIkV4Y2VwdGlvbiBieSBzbGF2ZTpcIiArIGV4cCwgMyk7XHJcbiAgICB9XHJcbiAgICBpZiAoZmMgIT0gMykge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIEZDIDpcIiArIGZjLCBmYyk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gTGVuZ3RoIGluIGJ5dGVzIGZyb20gc2xhdmUgYW5zd2VyXHJcbiAgICB2YXIgbGVuZ3RoID0gdmlldy5nZXRVaW50OCgyKTtcclxuXHJcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIobGVuZ3RoKTtcclxuICAgIGNvbnN0IHJlZ2lzdGVycyA9IG5ldyBEYXRhVmlldyhidWZmZXIpO1xyXG5cclxuICAgIGZvciAodmFyIGkgPSAzOyBpIDwgdmlldy5ieXRlTGVuZ3RoIC0gMjsgaSArPSAyKSB7XHJcbiAgICAgICAgdmFyIHJlZyA9IHZpZXcuZ2V0SW50MTYoaSwgZmFsc2UpO1xyXG4gICAgICAgIHJlZ2lzdGVycy5zZXRJbnQxNihpIC0gMywgcmVnLCBmYWxzZSk7XHJcbiAgICAgICAgdmFyIGlkeCA9ICgoaSAtIDMpIC8gMiArIDEpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlZ2lzdGVyIFwiICsgaWR4ICsgXCIvXCIgKyAobGVuZ3RoIC8gMikgKyBcIiA9IFwiICsgcmVnKTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gcmVnaXN0ZXJzO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2sgaWYgdGhlIEZDMTYgcmVzcG9uc2UgaXMgY29ycmVjdCAoQ1JDLCByZXR1cm4gY29kZSkgQU5EIG9wdGlvbmFsbHkgbWF0Y2hpbmcgdGhlIHJlZ2lzdGVyIGxlbmd0aCBleHBlY3RlZFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZSBtb2RidXMgcnR1IHJhdyBvdXRwdXRcclxuICogQHBhcmFtIHtudW1iZXJ9IGV4cGVjdGVkIG51bWJlciBvZiBleHBlY3RlZCB3cml0dGVuIHJlZ2lzdGVycyBmcm9tIHNsYXZlLiBJZiA8PTAsIGl0IHdpbGwgbm90IGJlIGNoZWNrZWQuXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIGFsbCByZWdpc3RlcnMgaGF2ZSBiZWVuIHdyaXR0ZW5cclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIGV4cGVjdGVkKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlRkMxNihyZXNwb25zZSk7XHJcbiAgICAgICAgcmV0dXJuIChleHBlY3RlZCA8PSAwIHx8IHJlc3VsdFsxXSA9PT0gZXhwZWN0ZWQpOyAvLyBjaGVjayBpZiBsZW5ndGggaXMgbWF0Y2hpbmdcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cuZXJyb3IoXCJGQzE2IGFuc3dlciBlcnJvclwiLCBlcnIpO1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBhbnN3ZXIgdG8gdGhlIHdyaXRlIG11bHRpcGxlIHJlZ2lzdGVycyBmcm9tIHRoZSBzbGF2ZVxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzE2KHJlc3BvbnNlKSB7XHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHJlc3BvbnNlKTtcclxuICAgIHZhciBjb250ZW50cyA9IFtdO1xyXG5cclxuICAgIGlmIChyZXNwb25zZS5sZW5ndGggPCAzKVxyXG4gICAgICAgIHJldHVybjtcclxuXHJcbiAgICB2YXIgc2xhdmUgPSB2aWV3LmdldFVpbnQ4KDApO1xyXG5cclxuICAgIGlmIChzbGF2ZSAhPSBTRU5FQ0FfTUJfU0xBVkVfSUQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIGZjID0gdmlldy5nZXRVaW50OCgxKTtcclxuICAgIGlmIChmYyA+IDEyOCkge1xyXG4gICAgICAgIHZhciBleHAgPSB2aWV3LmdldFVpbnQ4KDIpO1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIkV4Y2VwdGlvbiA6XCIgKyBleHAsIDE2KTtcclxuICAgIH1cclxuICAgIGlmIChmYyAhPSAxNikge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIEZDIDpcIiArIGZjLCBmYyk7XHJcbiAgICB9XHJcbiAgICB2YXIgY29tcHV0ZWRfY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkocmVzcG9uc2Uuc2xpY2UoMCwgLTIpKSk7XHJcbiAgICB2YXIgYWN0dWFsX2NyYyA9IHZpZXcuZ2V0VWludDE2KHZpZXcuYnl0ZUxlbmd0aCAtIDIsIHRydWUpO1xyXG5cclxuICAgIGlmIChjb21wdXRlZF9jcmMgIT0gYWN0dWFsX2NyYykge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIENSQyAoZXhwZWN0ZWQ6XCIgKyBjb21wdXRlZF9jcmMgKyBcIixnb3Q6XCIgKyBhY3R1YWxfY3JjICsgXCIpXCIsIDE2KTtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgYWRkcmVzcyA9IHZpZXcuZ2V0VWludDE2KDIsIGZhbHNlKTtcclxuICAgIHZhciBsZW5ndGggPSB2aWV3LmdldFVpbnQxNig0LCBmYWxzZSk7XHJcbiAgICByZXR1cm4gW2FkZHJlc3MsIGxlbmd0aF07XHJcbn1cclxuXHJcblxyXG5cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBmbG9hdFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGNvbnZlcnRlZCB2YWx1ZVxyXG4gKi9cclxuZnVuY3Rpb24gZ2V0RmxvYXQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0SW50MTYoMCwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0ICsgMiwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICBkdi5zZXRJbnQxNigyLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgcmV0dXJuIGR2LmdldEZsb2F0MzIoMCwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gVWludDMyXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRVaW50MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQpIHtcclxuICAgIGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICBjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuICAgIGR2LnNldEludDE2KDAsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCArIDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZHYuc2V0SW50MTYoMiwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0LCBmYWxzZSksIGZhbHNlKTtcclxuICAgIHJldHVybiBkdi5nZXRVaW50MzIoMCwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gZmxvYXRcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcGFyYW0ge3ZhbHVlfSBudW1iZXIgdmFsdWUgdG8gc2V0XHJcbiAqL1xyXG5mdW5jdGlvbiBzZXRGbG9hdDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0LCB2YWx1ZSkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0RmxvYXQzMigwLCB2YWx1ZSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0LCBkdi5nZXRJbnQxNigyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGRhdGFWaWV3LnNldEludDE2KG9mZnNldCArIDIsIGR2LmdldEludDE2KDAsIGZhbHNlKSwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSB1aW50MzIgaW50byB0aGUgYnVmZmVyXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSB2YWx1ZSB2YWx1ZSB0byBzZXRcclxuICovXHJcbmZ1bmN0aW9uIHNldFVpbnQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCwgdmFsdWUpIHtcclxuICAgIGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICBjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuICAgIGR2LnNldFVpbnQzMigwLCB2YWx1ZSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0LCBkdi5nZXRJbnQxNigyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGRhdGFWaWV3LnNldEludDE2KG9mZnNldCArIDIsIGR2LmdldEludDE2KDAsIGZhbHNlKSwgZmFsc2UpO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgbWFrZUZDMywgZ2V0RmxvYXQzMkxFQlMsIG1ha2VGQzE2LCBzZXRGbG9hdDMyTEVCUywgc2V0VWludDMyTEVCUywgcGFyc2VGQzMsIHBhcnNlRkMxNiwgcGFyc2VGQzE2Y2hlY2tlZCwgTW9kYnVzRXJyb3IsIFNFTkVDQV9NQl9TTEFWRV9JRCwgZ2V0VWludDMyTEVCUywgY3JjMTZ9IiwiJ3VzZSBzdHJpY3QnO1xyXG5cclxuY29uc3QgdGVzdFRyYWNlcyA9IFtcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMGEgMDAgMDIgZTcgZDFcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1ZiA0MyAzYSA5MCA5MyAzZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY0IDk5IGFkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZDkgM2UgNDAgODAgMDggYzJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgNjQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA1IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAxIDU5IDg2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBjMyA2NVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDIgMTkgODdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4MCAwMCAzOSA3NiBjMCAwMCAzYSAyZiA2MCAwMCAzOSBlZCAwNyA2N1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIDgwIDAwIDM5IDc2IGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGE0IDA2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODAgMDAgMzkgNzYgYzAgMDAgM2EgMmYgODAgMDAgMzkgNzYgNzEgMGNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDMgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAzIGQ4IDQ3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgMmQgNWMgM2MgODYgMmQgNWMgM2MgODYgYjYgZDggM2MgNGEgYjYgMDNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA0NyA3NCAzYyAxMSAyZCA1YyAzYyA4NiA0NyA3NCAzYyAxMSA5NiAyYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIDg4IDdjIDNiIGY5IDJkIDVjIDNjIDg2IDg4IDdjIDNiIGY5IDA4IDY4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA0IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNCA5OSA4NVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIGY0IGUzIGMwIGVhIGY0IGUzIGMwIGVhIGY0IGUzIGMwIGVhIDE1IDhjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZjQgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZjQgZTMgYzAgZWEgNjMgZTZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmNCBlMyBjMCBlYSBlYyBlNCBjMCBlYSBlYyBlNCBjMCBlYSBkNCA4N1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIGZjIGUzIGMwIGVhIGVjIGU0IGMwIGVhIGZjIGUzIGMwIGVhIDgwIDU5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZmMgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZjQgZTMgYzAgZWEgODIgMzlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI2IDE5IDljXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDUgNTggNDVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3ZiBkMiBjMyAwZCA0YSBlYVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDYgMTggNDRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBkMSAwMCBjMyA3NSBjYSAxOVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDIwIDAwIDgxIDg2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMzMgZDMgYzMgNzYgNGQgOTlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDcgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA3IGQ5IDg0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgOTAgYzMgODcgNzIgOGRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBmZSBiNyBjMyA4NiAzMiBhZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwOCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDggOTkgODBcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBiZSAyNyBjMiBlYiBlNyAzZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGJiIGFkIGMyIGViIGM2IDE4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA5IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwOSA1OCA0MFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDFmIGI3IGMyIGQzIGM1IDNkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNDcgNjMgYzIgZDMgOTYgNjVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAxZCA1NSBjMiBkMyA2NCBiM1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwYSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGEgMTggNDFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2YiA1ZSBjNiAzZSBjZCBiNFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDYzIDdkIGM2IDNlIDNlIDFlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBiIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwYiBkOSA4MVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDc3IDI5IGNmIDdjIGZjIDVmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjAgZWYgY2YgN2QgZDggMTZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGMgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBjIDk4IDQzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMzQgNTEgY2QgY2UgZTggZDdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBhNiBlYSBjZCBjZSBiNCA0YVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGY5IGVlIGNkIGNkIGE3IDllXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYTUgYmMgY2QgY2UgNTQgMWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBkIDU5IDgzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNTQgNzYgY2MgYjAgYzcgNmNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3YyA2ZSBjYyBiMCA0ZSBjYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwZSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGUgMTkgODJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0ZiA0NCA0NCA1YiAzNiBiNiA0MyBjNyA1ZiA0NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwZiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGYgZDggNDJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBmMCA3NSBjMyBiMyAxYyA0ZSBjMyBjNyBhMiBmOFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTAgOTkgOGFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA1ZCA2ZiA0NCA1YiAzZSBlZCA0MyBjNyAzNyAyMlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTEgNTggNGFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBmYiBiMSA0NSAyZiA0ZiA5YSA0NSA3ZCAxYiA5MlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTIgMTggNGJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBjNiBiMCA0NSAyYSA2ZCAwMCBjNSA3ZCA0ZSA0OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxMyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTMgZDkgOGJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBmYSBlZCA0NSAyZiA0ZSBmZSA0NSA3ZCAwNiA3OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxNCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTQgOTggNDlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0MiA3YyA0NCA2MSA0ZiA5YSA0NSA3ZCBhNSA5ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxNSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTUgNTkgODlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA3ZiBjMCBjMyBjMCA4NyA5OCBjNSA3MiAwNyAxM1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDEyIDc3IGMzIGNkIDliIGMxIGM1IDZiIDNjIDIxXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggOWQgZTggYzMgYjcgMTMgYTkgYzUgNzcgNjkgNzdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA4MiBkMCBjMyBhZCBmNiBkNiBjNSA3YiBjZSBlYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDU3IDg5IGMzIGQ0IDRiIDE0IGM1IDY3IGQzIDFlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE3IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxNyBkOCA0OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDQxIDA2IDQ0IDJlIDI5IDUzIDQzIDQ3IDI2IDg2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE4IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxOCA5OCA0Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGFjIDJmIGM0IDQ1IDI1IGE1IGMzIDQ3IGU5IDNlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE5IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxOSA1OSA4Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDRmIDkyIDQ0IDJlIDM1IGM2IDQzIDQ3IDY1IDdmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFhIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxYSAxOSA4ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGFmIDgyIDQzIDY3IDI5IDUzIDQzIDQ3IGIxIDMzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFiIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxYiBkOCA0ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDQ2IGE3IGM0IDEzIDI1IGE1IGMzIDQ3IDI3IDBkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFjIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxYyA5OSA4ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGNjIDk4IDQzIDY3IDM1IGM2IDQzIDQ3IDViIDczXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFkIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxZCA1OCA0ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDcwIGU1IDQzIDlhIDM2IGI2IDQzIGM3IDkwIGJlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFlIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxZSAxOCA0ZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDA0IDM0IGM3IDA2IDFjIDRlIGMzIGM3IDcxIDE1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDFmIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxZiBkOSA4ZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDZlIGRmIDQzIDlhIDNlIGVkIDQzIGM3IGY5IDhlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMCA5OSA5ZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGRmIGVmIDQzIDg5IDM2IGI2IDQzIGM3IGY1IDQ1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIxIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMSA1OCA1ZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDZhIDFlIGM1IGRkIDFjIDRlIGMzIGM3IDE4IDgyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIyIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMiAxOCA1ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGU1IGVkIDQzIDg5IDNlIGVkIDQzIGM3IDI2IDVkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDIzIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyMyBkOSA5ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwMCAwMCAwNCA0NyBkMVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDdmIDAwIDAxIDAwIDAwIDJjIDAwIDAxIGFkIGNiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDI0IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNCA5OCA1ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhNCAwMCAwMiA4NiAzMFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDZhIDQ4IDNkIGQ1IDJlIGYzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDI1IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNSA1OSA5ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA5NiAwMCAwNCBhNyBmZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAwIDAwIDAwIDAwIDAwIDAwIDAwIDAwIGViIDc3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIDA0IDAwIDAwIDQwIDgwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgZTIgMjlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY1IDU4IDZkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDAgOTggNDZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDIgMDAgMDIgNjcgZWFcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MCA4MCA1MiA1MlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI4IDk4IDU4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIDA0IDAwIDAwIDQxIDIwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgZTIgMjlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY2IDE4IDZjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQyIDAwIDAyIDY3IGVhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgMjAgNTMgYmFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiA4MCAwMCBmOSA4NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwNCAwMCAwMCA0MSAyMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDAyIDI4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY3IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NyBkOSBhY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkNCAwMCAwMiA4NyBlYlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIDIwIDUzIGJhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDA0IDY2IDY2IDQwIDg2IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDIgMjhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjggZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY4IDk5IGE4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQ0IDAwIDAyIDg3IGViXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjYgNjYgNDAgODYgMmMgYzdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZGMgMDAgMDIgMDQgNjYgNjYgNDAgODYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkYyAwMCAwMiA4MyBlYVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2OSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjkgNTggNjhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZGMgMDAgMDIgMDYgMjlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2NiA2NiA0MCA4NiAyYyBjN1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2YSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmEgMTggNjlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZiIGQ5IGE5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZjIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2YyA5OCA2YlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2ZSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmUgMTkgYWFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZkIDU5IGFiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZmIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2ZiBkOCA2YVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3MCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzAgOTkgYTJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDcxIDU4IDYyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDA0IDAwIDAwIDQxIGM4IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDIgMjdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDcyIDE4IDYzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGU0IDAwIDAyIDg3IGU0XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgYzggNTMgZjRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNyBkOCA1Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNjIGU3IDQwIDgwIGRkIDM1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDc1IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3NSA1OSBhMVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNkIDc2IDQwIDgwIDhkIDI0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDc4IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3OCA5OCA2NFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3YiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgN2IgZDggNjVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNyA0YiA0MCA4MCAxZiAzMFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNjIDU4IDQwIDgwIGVjIGQxXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDdlIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3ZSAxOCA2NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNiIGM4IDQwIDgwIGVkIDg4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDgxIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4MSA1OCAyNlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNhIGE5IDQwIDgwIGJkIGFhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg0IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4NCA5OCAyNVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM1IDljIDQwIDgwIGFlIGIwXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQ4IDAwIDAyIDA0IDAwIDAwIDQxIGYwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDggMDAgMDIgYzIgMmJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODcgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg3IGQ4IDI0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQ4IDAwIDAyIDQ3IGU4XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgZjAgNTIgMjZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgMDggMDEgNGQgMDAgMDAgMDEgNGUgMDAgMDAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCBhMyBlMlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4OCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDA5IDAwIDAxIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4OCA5OCAyMFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBmZSAwMCAwNCAyNiAyMVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDAxIDRkIDAwIDAwIDAxIDRlIDAwIDAwIGQ2IDU0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYWEgYWYgNDAgODAgNDMgYWJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNSAwYyA0MCA4MCBhZSA5ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM5IDg5IDQwIDgwIGJjIDI0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2IgMzkgNDAgODAgYmMgN2JcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNyBkYiA0MCA4MCAxZiAxZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM2IGJjIDQwIDgwIGFmIDNlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzQgN2QgNDAgODAgZmYgN2FcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjMyA1ZSA0MCA4MCAwZiBjNFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM4IDZiIDQwIDgwIDFkIGVlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzYgMmMgNDAgODAgYWYgMTNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDQgMDAgMDAgNDEgZjAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwMiAyN1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGMyIGNlIDQwIDgwIDBlIDE1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGMwIDAwIDAyIDA0IDAwIDAwIDQxIDIwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgYzAgMDAgMDIgNDIgMmNcIlxyXG4gICAgfVxyXG4gIF1cclxuXHJcbmZ1bmN0aW9uIHVuaXFCeShhLCBrZXkpIHtcclxuICAgIHZhciBzZWVuID0ge307XHJcbiAgICByZXR1cm4gYS5maWx0ZXIoZnVuY3Rpb24gKGl0ZW0pIHtcclxuICAgICAgICB2YXIgayA9IGtleShpdGVtKTtcclxuICAgICAgICByZXR1cm4gc2Vlbi5oYXNPd25Qcm9wZXJ0eShrKSA/IGZhbHNlIDogKHNlZW5ba10gPSB0cnVlKTtcclxuICAgIH0pXHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbWVNZXNzYWdlKHRyYWNlKSB7XHJcbiAgICByZXR1cm4gdHJhY2VbXCJyZXF1ZXN0XCJdICsgXCIgLT4gXCIgKyB0cmFjZVtcImFuc3dlclwiXTtcclxufVxyXG5cclxuZnVuY3Rpb24gR2V0SnNvblRyYWNlcygpIHtcclxuICAgIHRlc3RUcmFjZXMgPSB1bmlxQnkodGVzdFRyYWNlcywgc2FtZU1lc3NhZ2UpO1xyXG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHRlc3RUcmFjZXMpO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgdGVzdFRyYWNlcywgR2V0SnNvblRyYWNlcyB9IiwiLypcbiogbG9nbGV2ZWwgLSBodHRwczovL2dpdGh1Yi5jb20vcGltdGVycnkvbG9nbGV2ZWxcbipcbiogQ29weXJpZ2h0IChjKSAyMDEzIFRpbSBQZXJyeVxuKiBMaWNlbnNlZCB1bmRlciB0aGUgTUlUIGxpY2Vuc2UuXG4qL1xuKGZ1bmN0aW9uIChyb290LCBkZWZpbml0aW9uKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgaWYgKHR5cGVvZiBkZWZpbmUgPT09ICdmdW5jdGlvbicgJiYgZGVmaW5lLmFtZCkge1xuICAgICAgICBkZWZpbmUoZGVmaW5pdGlvbik7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgbW9kdWxlID09PSAnb2JqZWN0JyAmJiBtb2R1bGUuZXhwb3J0cykge1xuICAgICAgICBtb2R1bGUuZXhwb3J0cyA9IGRlZmluaXRpb24oKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByb290LmxvZyA9IGRlZmluaXRpb24oKTtcbiAgICB9XG59KHRoaXMsIGZ1bmN0aW9uICgpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIC8vIFNsaWdodGx5IGR1YmlvdXMgdHJpY2tzIHRvIGN1dCBkb3duIG1pbmltaXplZCBmaWxlIHNpemVcbiAgICB2YXIgbm9vcCA9IGZ1bmN0aW9uKCkge307XG4gICAgdmFyIHVuZGVmaW5lZFR5cGUgPSBcInVuZGVmaW5lZFwiO1xuICAgIHZhciBpc0lFID0gKHR5cGVvZiB3aW5kb3cgIT09IHVuZGVmaW5lZFR5cGUpICYmICh0eXBlb2Ygd2luZG93Lm5hdmlnYXRvciAhPT0gdW5kZWZpbmVkVHlwZSkgJiYgKFxuICAgICAgICAvVHJpZGVudFxcL3xNU0lFIC8udGVzdCh3aW5kb3cubmF2aWdhdG9yLnVzZXJBZ2VudClcbiAgICApO1xuXG4gICAgdmFyIGxvZ01ldGhvZHMgPSBbXG4gICAgICAgIFwidHJhY2VcIixcbiAgICAgICAgXCJkZWJ1Z1wiLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICAgXCJ3YXJuXCIsXG4gICAgICAgIFwiZXJyb3JcIlxuICAgIF07XG5cbiAgICAvLyBDcm9zcy1icm93c2VyIGJpbmQgZXF1aXZhbGVudCB0aGF0IHdvcmtzIGF0IGxlYXN0IGJhY2sgdG8gSUU2XG4gICAgZnVuY3Rpb24gYmluZE1ldGhvZChvYmosIG1ldGhvZE5hbWUpIHtcbiAgICAgICAgdmFyIG1ldGhvZCA9IG9ialttZXRob2ROYW1lXTtcbiAgICAgICAgaWYgKHR5cGVvZiBtZXRob2QuYmluZCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIG1ldGhvZC5iaW5kKG9iaik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBGdW5jdGlvbi5wcm90b3R5cGUuYmluZC5jYWxsKG1ldGhvZCwgb2JqKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAvLyBNaXNzaW5nIGJpbmQgc2hpbSBvciBJRTggKyBNb2Rlcm5penIsIGZhbGxiYWNrIHRvIHdyYXBwaW5nXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gRnVuY3Rpb24ucHJvdG90eXBlLmFwcGx5LmFwcGx5KG1ldGhvZCwgW29iaiwgYXJndW1lbnRzXSk7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRyYWNlKCkgZG9lc24ndCBwcmludCB0aGUgbWVzc2FnZSBpbiBJRSwgc28gZm9yIHRoYXQgY2FzZSB3ZSBuZWVkIHRvIHdyYXAgaXRcbiAgICBmdW5jdGlvbiB0cmFjZUZvcklFKCkge1xuICAgICAgICBpZiAoY29uc29sZS5sb2cpIHtcbiAgICAgICAgICAgIGlmIChjb25zb2xlLmxvZy5hcHBseSkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nLmFwcGx5KGNvbnNvbGUsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEluIG9sZCBJRSwgbmF0aXZlIGNvbnNvbGUgbWV0aG9kcyB0aGVtc2VsdmVzIGRvbid0IGhhdmUgYXBwbHkoKS5cbiAgICAgICAgICAgICAgICBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuYXBwbHkoY29uc29sZS5sb2csIFtjb25zb2xlLCBhcmd1bWVudHNdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY29uc29sZS50cmFjZSkgY29uc29sZS50cmFjZSgpO1xuICAgIH1cblxuICAgIC8vIEJ1aWxkIHRoZSBiZXN0IGxvZ2dpbmcgbWV0aG9kIHBvc3NpYmxlIGZvciB0aGlzIGVudlxuICAgIC8vIFdoZXJldmVyIHBvc3NpYmxlIHdlIHdhbnQgdG8gYmluZCwgbm90IHdyYXAsIHRvIHByZXNlcnZlIHN0YWNrIHRyYWNlc1xuICAgIGZ1bmN0aW9uIHJlYWxNZXRob2QobWV0aG9kTmFtZSkge1xuICAgICAgICBpZiAobWV0aG9kTmFtZSA9PT0gJ2RlYnVnJykge1xuICAgICAgICAgICAgbWV0aG9kTmFtZSA9ICdsb2cnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlID09PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7IC8vIE5vIG1ldGhvZCBwb3NzaWJsZSwgZm9yIG5vdyAtIGZpeGVkIGxhdGVyIGJ5IGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXNcbiAgICAgICAgfSBlbHNlIGlmIChtZXRob2ROYW1lID09PSAndHJhY2UnICYmIGlzSUUpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFjZUZvcklFO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbnNvbGVbbWV0aG9kTmFtZV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIGJpbmRNZXRob2QoY29uc29sZSwgbWV0aG9kTmFtZSk7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uc29sZS5sb2cgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIGJpbmRNZXRob2QoY29uc29sZSwgJ2xvZycpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIG5vb3A7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUaGVzZSBwcml2YXRlIGZ1bmN0aW9ucyBhbHdheXMgbmVlZCBgdGhpc2AgdG8gYmUgc2V0IHByb3Blcmx5XG5cbiAgICBmdW5jdGlvbiByZXBsYWNlTG9nZ2luZ01ldGhvZHMobGV2ZWwsIGxvZ2dlck5hbWUpIHtcbiAgICAgICAgLypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsb2dNZXRob2RzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICB2YXIgbWV0aG9kTmFtZSA9IGxvZ01ldGhvZHNbaV07XG4gICAgICAgICAgICB0aGlzW21ldGhvZE5hbWVdID0gKGkgPCBsZXZlbCkgP1xuICAgICAgICAgICAgICAgIG5vb3AgOlxuICAgICAgICAgICAgICAgIHRoaXMubWV0aG9kRmFjdG9yeShtZXRob2ROYW1lLCBsZXZlbCwgbG9nZ2VyTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBEZWZpbmUgbG9nLmxvZyBhcyBhbiBhbGlhcyBmb3IgbG9nLmRlYnVnXG4gICAgICAgIHRoaXMubG9nID0gdGhpcy5kZWJ1ZztcbiAgICB9XG5cbiAgICAvLyBJbiBvbGQgSUUgdmVyc2lvbnMsIHRoZSBjb25zb2xlIGlzbid0IHByZXNlbnQgdW50aWwgeW91IGZpcnN0IG9wZW4gaXQuXG4gICAgLy8gV2UgYnVpbGQgcmVhbE1ldGhvZCgpIHJlcGxhY2VtZW50cyBoZXJlIHRoYXQgcmVnZW5lcmF0ZSBsb2dnaW5nIG1ldGhvZHNcbiAgICBmdW5jdGlvbiBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzKG1ldGhvZE5hbWUsIGxldmVsLCBsb2dnZXJOYW1lKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgIT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbCh0aGlzLCBsZXZlbCwgbG9nZ2VyTmFtZSk7XG4gICAgICAgICAgICAgICAgdGhpc1ttZXRob2ROYW1lXS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIEJ5IGRlZmF1bHQsIHdlIHVzZSBjbG9zZWx5IGJvdW5kIHJlYWwgbWV0aG9kcyB3aGVyZXZlciBwb3NzaWJsZSwgYW5kXG4gICAgLy8gb3RoZXJ3aXNlIHdlIHdhaXQgZm9yIGEgY29uc29sZSB0byBhcHBlYXIsIGFuZCB0aGVuIHRyeSBhZ2Fpbi5cbiAgICBmdW5jdGlvbiBkZWZhdWx0TWV0aG9kRmFjdG9yeShtZXRob2ROYW1lLCBsZXZlbCwgbG9nZ2VyTmFtZSkge1xuICAgICAgICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICAgICAgICByZXR1cm4gcmVhbE1ldGhvZChtZXRob2ROYW1lKSB8fFxuICAgICAgICAgICAgICAgZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlcy5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIExvZ2dlcihuYW1lLCBkZWZhdWx0TGV2ZWwsIGZhY3RvcnkpIHtcbiAgICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAgIHZhciBjdXJyZW50TGV2ZWw7XG4gICAgICBkZWZhdWx0TGV2ZWwgPSBkZWZhdWx0TGV2ZWwgPT0gbnVsbCA/IFwiV0FSTlwiIDogZGVmYXVsdExldmVsO1xuXG4gICAgICB2YXIgc3RvcmFnZUtleSA9IFwibG9nbGV2ZWxcIjtcbiAgICAgIGlmICh0eXBlb2YgbmFtZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBzdG9yYWdlS2V5ICs9IFwiOlwiICsgbmFtZTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG5hbWUgPT09IFwic3ltYm9sXCIpIHtcbiAgICAgICAgc3RvcmFnZUtleSA9IHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gcGVyc2lzdExldmVsSWZQb3NzaWJsZShsZXZlbE51bSkge1xuICAgICAgICAgIHZhciBsZXZlbE5hbWUgPSAobG9nTWV0aG9kc1tsZXZlbE51bV0gfHwgJ3NpbGVudCcpLnRvVXBwZXJDYXNlKCk7XG5cbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gVXNlIGxvY2FsU3RvcmFnZSBpZiBhdmFpbGFibGVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cubG9jYWxTdG9yYWdlW3N0b3JhZ2VLZXldID0gbGV2ZWxOYW1lO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gVXNlIHNlc3Npb24gY29va2llIGFzIGZhbGxiYWNrXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmRvY3VtZW50LmNvb2tpZSA9XG4gICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9XCIgKyBsZXZlbE5hbWUgKyBcIjtcIjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGdldFBlcnNpc3RlZExldmVsKCkge1xuICAgICAgICAgIHZhciBzdG9yZWRMZXZlbDtcblxuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IHdpbmRvdy5sb2NhbFN0b3JhZ2Vbc3RvcmFnZUtleV07XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gRmFsbGJhY2sgdG8gY29va2llcyBpZiBsb2NhbCBzdG9yYWdlIGdpdmVzIHVzIG5vdGhpbmdcbiAgICAgICAgICBpZiAodHlwZW9mIHN0b3JlZExldmVsID09PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICB2YXIgY29va2llID0gd2luZG93LmRvY3VtZW50LmNvb2tpZTtcbiAgICAgICAgICAgICAgICAgIHZhciBsb2NhdGlvbiA9IGNvb2tpZS5pbmRleE9mKFxuICAgICAgICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPVwiKTtcbiAgICAgICAgICAgICAgICAgIGlmIChsb2NhdGlvbiAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IC9eKFteO10rKS8uZXhlYyhjb29raWUuc2xpY2UobG9jYXRpb24pKVsxXTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIElmIHRoZSBzdG9yZWQgbGV2ZWwgaXMgbm90IHZhbGlkLCB0cmVhdCBpdCBhcyBpZiBub3RoaW5nIHdhcyBzdG9yZWQuXG4gICAgICAgICAgaWYgKHNlbGYubGV2ZWxzW3N0b3JlZExldmVsXSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHN0b3JlZExldmVsID0gdW5kZWZpbmVkO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBzdG9yZWRMZXZlbDtcbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gY2xlYXJQZXJzaXN0ZWRMZXZlbCgpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gVXNlIGxvY2FsU3RvcmFnZSBpZiBhdmFpbGFibGVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cubG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oc3RvcmFnZUtleSk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBVc2Ugc2Vzc2lvbiBjb29raWUgYXMgZmFsbGJhY2tcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cuZG9jdW1lbnQuY29va2llID1cbiAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj07IGV4cGlyZXM9VGh1LCAwMSBKYW4gMTk3MCAwMDowMDowMCBVVENcIjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICB9XG5cbiAgICAgIC8qXG4gICAgICAgKlxuICAgICAgICogUHVibGljIGxvZ2dlciBBUEkgLSBzZWUgaHR0cHM6Ly9naXRodWIuY29tL3BpbXRlcnJ5L2xvZ2xldmVsIGZvciBkZXRhaWxzXG4gICAgICAgKlxuICAgICAgICovXG5cbiAgICAgIHNlbGYubmFtZSA9IG5hbWU7XG5cbiAgICAgIHNlbGYubGV2ZWxzID0geyBcIlRSQUNFXCI6IDAsIFwiREVCVUdcIjogMSwgXCJJTkZPXCI6IDIsIFwiV0FSTlwiOiAzLFxuICAgICAgICAgIFwiRVJST1JcIjogNCwgXCJTSUxFTlRcIjogNX07XG5cbiAgICAgIHNlbGYubWV0aG9kRmFjdG9yeSA9IGZhY3RvcnkgfHwgZGVmYXVsdE1ldGhvZEZhY3Rvcnk7XG5cbiAgICAgIHNlbGYuZ2V0TGV2ZWwgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgcmV0dXJuIGN1cnJlbnRMZXZlbDtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuc2V0TGV2ZWwgPSBmdW5jdGlvbiAobGV2ZWwsIHBlcnNpc3QpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIGxldmVsID09PSBcInN0cmluZ1wiICYmIHNlbGYubGV2ZWxzW2xldmVsLnRvVXBwZXJDYXNlKCldICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgbGV2ZWwgPSBzZWxmLmxldmVsc1tsZXZlbC50b1VwcGVyQ2FzZSgpXTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiBsZXZlbCA9PT0gXCJudW1iZXJcIiAmJiBsZXZlbCA+PSAwICYmIGxldmVsIDw9IHNlbGYubGV2ZWxzLlNJTEVOVCkge1xuICAgICAgICAgICAgICBjdXJyZW50TGV2ZWwgPSBsZXZlbDtcbiAgICAgICAgICAgICAgaWYgKHBlcnNpc3QgIT09IGZhbHNlKSB7ICAvLyBkZWZhdWx0cyB0byB0cnVlXG4gICAgICAgICAgICAgICAgICBwZXJzaXN0TGV2ZWxJZlBvc3NpYmxlKGxldmVsKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXBsYWNlTG9nZ2luZ01ldGhvZHMuY2FsbChzZWxmLCBsZXZlbCwgbmFtZSk7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gdW5kZWZpbmVkVHlwZSAmJiBsZXZlbCA8IHNlbGYubGV2ZWxzLlNJTEVOVCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFwiTm8gY29uc29sZSBhdmFpbGFibGUgZm9yIGxvZ2dpbmdcIjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IFwibG9nLnNldExldmVsKCkgY2FsbGVkIHdpdGggaW52YWxpZCBsZXZlbDogXCIgKyBsZXZlbDtcbiAgICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnNldERlZmF1bHRMZXZlbCA9IGZ1bmN0aW9uIChsZXZlbCkge1xuICAgICAgICAgIGRlZmF1bHRMZXZlbCA9IGxldmVsO1xuICAgICAgICAgIGlmICghZ2V0UGVyc2lzdGVkTGV2ZWwoKSkge1xuICAgICAgICAgICAgICBzZWxmLnNldExldmVsKGxldmVsLCBmYWxzZSk7XG4gICAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgc2VsZi5yZXNldExldmVsID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoZGVmYXVsdExldmVsLCBmYWxzZSk7XG4gICAgICAgICAgY2xlYXJQZXJzaXN0ZWRMZXZlbCgpO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5lbmFibGVBbGwgPSBmdW5jdGlvbihwZXJzaXN0KSB7XG4gICAgICAgICAgc2VsZi5zZXRMZXZlbChzZWxmLmxldmVscy5UUkFDRSwgcGVyc2lzdCk7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLmRpc2FibGVBbGwgPSBmdW5jdGlvbihwZXJzaXN0KSB7XG4gICAgICAgICAgc2VsZi5zZXRMZXZlbChzZWxmLmxldmVscy5TSUxFTlQsIHBlcnNpc3QpO1xuICAgICAgfTtcblxuICAgICAgLy8gSW5pdGlhbGl6ZSB3aXRoIHRoZSByaWdodCBsZXZlbFxuICAgICAgdmFyIGluaXRpYWxMZXZlbCA9IGdldFBlcnNpc3RlZExldmVsKCk7XG4gICAgICBpZiAoaW5pdGlhbExldmVsID09IG51bGwpIHtcbiAgICAgICAgICBpbml0aWFsTGV2ZWwgPSBkZWZhdWx0TGV2ZWw7XG4gICAgICB9XG4gICAgICBzZWxmLnNldExldmVsKGluaXRpYWxMZXZlbCwgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qXG4gICAgICpcbiAgICAgKiBUb3AtbGV2ZWwgQVBJXG4gICAgICpcbiAgICAgKi9cblxuICAgIHZhciBkZWZhdWx0TG9nZ2VyID0gbmV3IExvZ2dlcigpO1xuXG4gICAgdmFyIF9sb2dnZXJzQnlOYW1lID0ge307XG4gICAgZGVmYXVsdExvZ2dlci5nZXRMb2dnZXIgPSBmdW5jdGlvbiBnZXRMb2dnZXIobmFtZSkge1xuICAgICAgICBpZiAoKHR5cGVvZiBuYW1lICE9PSBcInN5bWJvbFwiICYmIHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiKSB8fCBuYW1lID09PSBcIlwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIllvdSBtdXN0IHN1cHBseSBhIG5hbWUgd2hlbiBjcmVhdGluZyBhIGxvZ2dlci5cIik7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgbG9nZ2VyID0gX2xvZ2dlcnNCeU5hbWVbbmFtZV07XG4gICAgICAgIGlmICghbG9nZ2VyKSB7XG4gICAgICAgICAgbG9nZ2VyID0gX2xvZ2dlcnNCeU5hbWVbbmFtZV0gPSBuZXcgTG9nZ2VyKFxuICAgICAgICAgICAgbmFtZSwgZGVmYXVsdExvZ2dlci5nZXRMZXZlbCgpLCBkZWZhdWx0TG9nZ2VyLm1ldGhvZEZhY3RvcnkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsb2dnZXI7XG4gICAgfTtcblxuICAgIC8vIEdyYWIgdGhlIGN1cnJlbnQgZ2xvYmFsIGxvZyB2YXJpYWJsZSBpbiBjYXNlIG9mIG92ZXJ3cml0ZVxuICAgIHZhciBfbG9nID0gKHR5cGVvZiB3aW5kb3cgIT09IHVuZGVmaW5lZFR5cGUpID8gd2luZG93LmxvZyA6IHVuZGVmaW5lZDtcbiAgICBkZWZhdWx0TG9nZ2VyLm5vQ29uZmxpY3QgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgIT09IHVuZGVmaW5lZFR5cGUgJiZcbiAgICAgICAgICAgICAgIHdpbmRvdy5sb2cgPT09IGRlZmF1bHRMb2dnZXIpIHtcbiAgICAgICAgICAgIHdpbmRvdy5sb2cgPSBfbG9nO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGRlZmF1bHRMb2dnZXI7XG4gICAgfTtcblxuICAgIGRlZmF1bHRMb2dnZXIuZ2V0TG9nZ2VycyA9IGZ1bmN0aW9uIGdldExvZ2dlcnMoKSB7XG4gICAgICAgIHJldHVybiBfbG9nZ2Vyc0J5TmFtZTtcbiAgICB9O1xuXG4gICAgLy8gRVM2IGRlZmF1bHQgZXhwb3J0LCBmb3IgY29tcGF0aWJpbGl0eVxuICAgIGRlZmF1bHRMb2dnZXJbJ2RlZmF1bHQnXSA9IGRlZmF1bHRMb2dnZXI7XG5cbiAgICByZXR1cm4gZGVmYXVsdExvZ2dlcjtcbn0pKTtcbiIsIid1c2Ugc3RyaWN0JztcclxuXHJcbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqIE1PREJVUyBSVFUgRlVOQ1RJT05TIEZPUiBTRU5FQ0EgKioqKioqKioqKioqKioqKioqKioqKi9cclxuXHJcbnZhciBtb2RidXMgPSByZXF1aXJlKCcuL21vZGJ1c1J0dScpO1xyXG52YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi9jb25zdGFudHMnKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xyXG5cclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5jb25zdCBTRU5FQ0FfTUJfU0xBVkVfSUQgPSBtb2RidXMuU0VORUNBX01CX1NMQVZFX0lEOyAvLyBNb2RidXMgUlRVIHNsYXZlIElEXHJcblxyXG4vKlxyXG4gKiBNb2RidXMgcmVnaXN0ZXJzIG1hcC4gRWFjaCByZWdpc3RlciBpcyAyIGJ5dGVzIHdpZGUuXHJcbiAqL1xyXG5jb25zdCBNU0NSZWdpc3RlcnMgPSB7XHJcbiAgICBTZXJpYWxOdW1iZXI6IDEwLFxyXG4gICAgQ3VycmVudE1vZGU6IDEwMCxcclxuICAgIE1lYXN1cmVGbGFnczogMTAyLFxyXG4gICAgQ01EOiAxMDcsXHJcbiAgICBBVVgxOiAxMDgsXHJcbiAgICBMb2FkQ2VsbE1lYXN1cmU6IDExNCxcclxuICAgIFRlbXBNZWFzdXJlOiAxMjAsXHJcbiAgICBSdGRUZW1wZXJhdHVyZU1lYXN1cmU6IDEyOCxcclxuICAgIFJ0ZFJlc2lzdGFuY2VNZWFzdXJlOiAxMzAsXHJcbiAgICBGcmVxdWVuY3lNZWFzdXJlOiAxNjQsXHJcbiAgICBNaW5NZWFzdXJlOiAxMzIsXHJcbiAgICBNYXhNZWFzdXJlOiAxMzQsXHJcbiAgICBJbnN0YW50TWVhc3VyZTogMTM2LFxyXG4gICAgUG93ZXJPZmZEZWxheTogMTQyLFxyXG4gICAgUG93ZXJPZmZSZW1haW5pbmc6IDE0NixcclxuICAgIFB1bHNlT0ZGTWVhc3VyZTogMTUwLFxyXG4gICAgUHVsc2VPTk1lYXN1cmU6IDE1MixcclxuICAgIFNlbnNpYmlsaXR5X3VTX09GRjogMTY2LFxyXG4gICAgU2Vuc2liaWxpdHlfdVNfT046IDE2OCxcclxuICAgIEJhdHRlcnlNZWFzdXJlOiAxNzQsXHJcbiAgICBDb2xkSnVuY3Rpb246IDE5MCxcclxuICAgIFRocmVzaG9sZFVfRnJlcTogMTkyLFxyXG4gICAgR2VuZXJhdGlvbkZsYWdzOiAyMDIsXHJcbiAgICBHRU5fQ01EOiAyMDcsXHJcbiAgICBHRU5fQVVYMTogMjA4LFxyXG4gICAgQ3VycmVudFNldHBvaW50OiAyMTAsXHJcbiAgICBWb2x0YWdlU2V0cG9pbnQ6IDIxMixcclxuICAgIExvYWRDZWxsU2V0cG9pbnQ6IDIxNixcclxuICAgIFRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQ6IDIyMCxcclxuICAgIFJURFRlbXBlcmF0dXJlU2V0cG9pbnQ6IDIyOCxcclxuICAgIFB1bHNlc0NvdW50OiAyNTIsXHJcbiAgICBGcmVxdWVuY3lUSUNLMTogMjU0LFxyXG4gICAgRnJlcXVlbmN5VElDSzI6IDI1NixcclxuICAgIEdlblVoaWdoUGVyYzogMjYyLFxyXG4gICAgR2VuVWxvd1BlcmM6IDI2NFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBzZXJpYWwgbnVtYmVyXHJcbiAqICovXHJcbmZ1bmN0aW9uIG1ha2VTZXJpYWxOdW1iZXIoKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuU2VyaWFsTnVtYmVyKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBjdXJyZW50IG1vZGVcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZUN1cnJlbnRNb2RlKCkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRNb2RlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBjdXJyZW50IGJhdHRlcnkgbGV2ZWxcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZUJhdHRlcnlMZXZlbCgpIHtcclxuICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5CYXR0ZXJ5TWVhc3VyZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZXMgdGhlIHJlZ2lzdGVyIHdpdGggYmF0dGVyeSBsZXZlbFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgRkMzIGFuc3dlciBcclxuICogQHJldHVybnMge251bWJlcn0gYmF0dGVyeSBsZXZlbCBpbiBWXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUJhdHRlcnkoYnVmZmVyKSB7XHJcbiAgICB2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICByZXR1cm4gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgU2VuZWNhIE1TQyBzZXJpYWwgYXMgcGVyIHRoZSBVSSBpbnRlcmZhY2VcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBhbnN3ZXIgcGFja2V0IChGQzMpXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZVNlcmlhbE51bWJlcihidWZmZXIpIHtcclxuICAgIHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIGlmIChyZWdpc3RlcnMubGVuZ3RoIDwgNCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgc2VyaWFsIG51bWJlciByZXNwb25zZVwiKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbDEgPSByZWdpc3RlcnMuZ2V0VWludDE2KDAsIGZhbHNlKTtcclxuICAgIGNvbnN0IHZhbDIgPSByZWdpc3RlcnMuZ2V0VWludDE2KDIsIGZhbHNlKTtcclxuICAgIGNvbnN0IHNlcmlhbCA9ICgodmFsMiA8PCAxNikgKyB2YWwxKS50b1N0cmluZygpO1xyXG4gICAgaWYgKHNlcmlhbC5sZW5ndGggPiA1KSB7XHJcbiAgICAgICAgcmV0dXJuIHNlcmlhbC5zdWJzdHIoMCwgNSkgKyBcIl9cIiArIHNlcmlhbC5zdWJzdHIoNSwgc2VyaWFsLmxlbmd0aCAtIDUpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNlcmlhbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgc3RhdGUgb2YgdGhlIG1ldGVyLiBNYXkgdGhyb3cuXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBtb2RidXMgYW5zd2VyIHBhY2tldCAoRkMzKVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjdXJyZW50TW9kZSBpZiB0aGUgcmVnaXN0ZXJzIGNvbnRhaW5zIGFuIElHTk9SRSB2YWx1ZSwgcmV0dXJucyB0aGUgY3VycmVudCBtb2RlXHJcbiAqIEByZXR1cm5zIHtDb21tYW5kVHlwZX0gbWV0ZXIgbW9kZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VDdXJyZW50TW9kZShidWZmZXIsIGN1cnJlbnRNb2RlKSB7XHJcbiAgICB2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICBpZiAocmVnaXN0ZXJzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1vZGUgcmVzcG9uc2VcIik7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWwxID0gcmVnaXN0ZXJzLmdldFVpbnQxNigwLCBmYWxzZSk7XHJcblxyXG4gICAgaWYgKHZhbDEgPT0gQ29tbWFuZFR5cGUuUkVTRVJWRUQgfHwgdmFsMSA9PSBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQgfHwgdmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRF8yKSB7IC8vIE11c3QgYmUgaWdub3JlZCwgaW50ZXJuYWwgc3RhdGVzIG9mIHRoZSBtZXRlclxyXG4gICAgICAgIHJldHVybiBjdXJyZW50TW9kZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbHVlID0gdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIHZhbDEpO1xyXG4gICAgaWYgKHZhbHVlID09IG51bGwpXHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtZXRlciBtb2RlIDogXCIgKyB2YWx1ZSk7XHJcblxyXG4gICAgcmV0dXJuIHZhbDE7XHJcbn1cclxuLyoqXHJcbiAqIFNldHMgdGhlIGN1cnJlbnQgbW9kZS5cclxuICogQHBhcmFtIHtudW1iZXJ9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfG51bGx9XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlTW9kZVJlcXVlc3QobW9kZSkge1xyXG4gICAgY29uc3QgdmFsdWUgPSB1dGlscy5QYXJzZShDb21tYW5kVHlwZSwgbW9kZSk7XHJcbiAgICBjb25zdCBDSEFOR0VfU1RBVFVTID0gMTtcclxuXHJcbiAgICAvLyBGaWx0ZXIgaW52YWxpZCBjb21tYW5kc1xyXG4gICAgaWYgKHZhbHVlID09IG51bGwgfHwgdmFsdWUgPT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKG1vZGUgPiBDb21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgbW9kZSA8PSBDb21tYW5kVHlwZS5PRkYpIHsgLy8gTWVhc3VyZW1lbnRzXHJcbiAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcbiAgICB9XHJcbiAgICBlbHNlIGlmIChtb2RlID4gQ29tbWFuZFR5cGUuT0ZGICYmIG1vZGUgPCBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQpIHsgLy8gR2VuZXJhdGlvbnNcclxuICAgICAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgICAgIC8vIENvbGQganVuY3Rpb24gbm90IGNvbmZpZ3VyZWRcclxuICAgICAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR0VOX0NNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICAvLyBBbGwgdGhlIHNpbXBsZSBjYXNlcyBcclxuICAgICAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR0VOX0NNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXaGVuIHRoZSBtZXRlciBpcyBtZWFzdXJpbmcsIG1ha2UgdGhlIG1vZGJ1cyByZXF1ZXN0IG9mIHRoZSB2YWx1ZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSBwYWNrZXRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNZWFzdXJlUmVxdWVzdChtb2RlKSB7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UZW1wTWVhc3VyZSk7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfNFc6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5SdGRUZW1wZXJhdHVyZU1lYXN1cmUpOyAvLyBUZW1wLU9obVxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuRnJlcXVlbmN5OlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5TWVhc3VyZSk7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUHVsc2VPRkZNZWFzdXJlKTsgLy8gT04tT0ZGXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLkxvYWRDZWxsKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5WOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubVY6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDYsIE1TQ1JlZ2lzdGVycy5NaW5NZWFzdXJlKTsgLy8gTWluLU1heC1NZWFzXHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTW9kZSBub3QgbWFuYWdlZCA6XCIgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIG1lYXN1cmUgcmVhZCBmcm9tIHRoZSBtZXRlclxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgbW9kYnVzIHJ0dSBhbnN3ZXIgKEZDMylcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1vZGUgb2YgdGhlIG1ldGVyXHJcbiAqIEByZXR1cm5zIHthcnJheX0gYW4gYXJyYXkgd2l0aCBmaXJzdCBlbGVtZW50IFwiTWVhc3VyZSBuYW1lICh1bml0cylcIjpWYWx1ZSwgc2Vjb25kIFRpbWVzdGFtcDphY3F1aXNpdGlvblxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VNZWFzdXJlKGJ1ZmZlciwgbW9kZSkge1xyXG4gICAgdmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICB2YXIgbWVhcywgbWVhczIsIG1pbiwgbWF4O1xyXG5cclxuICAgIC8vIEFsbCBtZWFzdXJlcyBhcmUgZmxvYXRcclxuICAgIGlmIChyZXNwb25zZUZDMyA9PSBudWxsKVxyXG4gICAgICAgIHJldHVybiB7fTtcclxuXHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICB2YXIgdmFsdWUgPSBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogdmFsdWUsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCLCsENcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzRXOlxyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWVhczIgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlRlbXBlcmF0dXJlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwKSAvIDEwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiwrBDXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUmVzaXN0YW5jZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMyICogMTApIC8gMTAsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVVuaXRcIjogXCJPaG1zXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIC8vIFNlbnNpYmlsaXTDoCBtYW5jYW50aVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMCkgLyAxMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIkh6XCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgIG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkN1cnJlbnRcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1BXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuICAgICAgICAgICAgbWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJNaW5pbXVtXCI6IE1hdGgucm91bmQobWluICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiTWF4aW11bVwiOiBNYXRoLnJvdW5kKG1heCAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG4gICAgICAgICAgICBtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJtVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJNaW5pbXVtXCI6IE1hdGgucm91bmQobWluICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiTWF4aW11bVwiOiBNYXRoLnJvdW5kKG1heCAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1lYXMyID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICAvLyBTb2dsaWEgZSBzZW5zaWJpbGl0w6AgbWFuY2FudGlcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJQdWxzZSBPTlwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBtZWFzLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUHVsc2UgT0ZGXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVZhbHVlXCI6IG1lYXMyLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlVbml0XCI6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkxvYWRDZWxsOlxyXG4gICAgICAgICAgICBtZWFzID0gTWF0aC5yb3VuZChtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApICogMTAwMCkgLyAxMDAwO1xyXG4gICAgICAgICAgICAvLyBLZyBtYW5jYW50aVxyXG4gICAgICAgICAgICAvLyBTZW5zaWJpbGl0w6AsIHRhcmEsIHBvcnRhdGEgbWFuY2FudGlcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJJbWJhbGFuY2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogbWVhcyxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WL1ZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVW5rbm93blwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDAwKSAvIDEwMDAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCI/XCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFJlYWRzIHRoZSBzdGF0dXMgZmxhZ3MgZnJvbSBtZWFzdXJlbWVudCBtb2RlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3QgdG8gc2VuZFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVF1YWxpdHlCaXRSZXF1ZXN0KG1vZGUpIHtcclxuICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDEsIE1TQ1JlZ2lzdGVycy5NZWFzdXJlRmxhZ3MpO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2tzIGlmIHRoZSBlcnJvciBiaXQgc3RhdHVzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiB0aGVyZSBpcyBubyBlcnJvclxyXG4gKi9cclxuZnVuY3Rpb24gaXNRdWFsaXR5VmFsaWQoYnVmZmVyKSB7XHJcbiAgICB2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHJldHVybiAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxMykpID09IDApO1xyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIGdlbmVyYXRpb24gZmxhZ3Mgc3RhdHVzIGZyb20gdGhlIG1ldGVyXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3QgdG8gc2VuZFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUdlblN0YXR1c1JlYWQobW9kZSkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLkdlbmVyYXRpb25GbGFncyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVja3MgaWYgdGhlIGVycm9yIGJpdCBpcyBOT1Qgc2V0IGluIHRoZSBnZW5lcmF0aW9uIGZsYWdzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlRkMzXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIHRoZXJlIGlzIG5vIGVycm9yXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUdlblN0YXR1cyhidWZmZXIsIG1vZGUpIHtcclxuICAgIHZhciByZXNwb25zZUZDMyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgIHJldHVybiAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNSkpID09IDApICYmIC8vIEdlbiBlcnJvclxyXG4gICAgICAgICAgICAgICAgKChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTQpKSA9PSAwKTsgLy8gU2VsZiBnZW5lcmF0aW9uIEkgY2hlY2tcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZXR1cm4gKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNSkpID09IDA7IC8vIEdlbiBlcnJvclxyXG4gICAgfVxyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgYSBidWZmZXIgd2l0aCB0aGUgbW9kYnVzLXJ0dSByZXF1ZXN0IHRvIGJlIHNlbnQgdG8gU2VuZWNhXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgZ2VuZXJhdGlvbiBtb2RlXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludCB0aGUgdmFsdWUgdG8gc2V0IChtVi9WL0EvSHovwrBDKSBleGNlcHQgZm9yIHB1bHNlcyBudW1fcHVsc2VzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludDIgZnJlcXVlbmN5IGluIEh6XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlU2V0cG9pbnRSZXF1ZXN0KG1vZGUsIHNldHBvaW50LCBzZXRwb2ludDIpIHtcclxuICAgIHZhciBURU1QLCByZWdpc3RlcnM7XHJcbiAgICB2YXIgZHQgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICB2YXIgZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuICAgIG1vZGJ1cy5zZXRGbG9hdDMyTEVCUyhkdiwgMCwgc2V0cG9pbnQpO1xyXG4gICAgY29uc3Qgc3AgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcblxyXG4gICAgdmFyIGR0SW50ID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgdmFyIGR2SW50ID0gbmV3IERhdGFWaWV3KGR0SW50KTtcclxuICAgIG1vZGJ1cy5zZXRVaW50MzJMRUJTKGR2SW50LCAwLCBzZXRwb2ludCk7XHJcbiAgICBjb25zdCBzcEludCA9IFtkdkludC5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdkludC5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlZvbHRhZ2VTZXRwb2ludCwgc3ApOyAvLyBWIC8gbVYgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5DdXJyZW50U2V0cG9pbnQsIHNwKTsgLy8gSSBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUlREVGVtcGVyYXR1cmVTZXRwb2ludCwgc3ApOyAvLyDCsEMgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5UaGVybW9UZW1wZXJhdHVyZVNldHBvaW50LCBzcCk7IC8vIMKwQyBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkxvYWRDZWxsU2V0cG9pbnQsIHNwKTsgLy8gbVYvViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgZHQgPSBuZXcgQXJyYXlCdWZmZXIoOCk7IC8vIDIgVWludDMyXHJcbiAgICAgICAgICAgIGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcbiAgICAgICAgICAgIC8vIFNlZSBTZW5lY2FsIG1hbnVhbCBtYW51YWxcclxuICAgICAgICAgICAgLy8gTWF4IDIwa0haIGdlblxyXG4gICAgICAgICAgICBURU1QID0gTWF0aC5yb3VuZCgyMDAwMCAvIHNldHBvaW50LCAwKTtcclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDAsIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0sxXHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMig0LCBURU1QIC0gTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzJcclxuXHJcbiAgICAgICAgICAgIC8vIEJ5dGUtc3dhcHBlZCBsaXR0bGUgZW5kaWFuXHJcbiAgICAgICAgICAgIHJlZ2lzdGVycyA9IFtkdi5nZXRVaW50MTYoMiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMCwgZmFsc2UpLFxyXG4gICAgICAgICAgICBkdi5nZXRVaW50MTYoNiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoNCwgZmFsc2UpXTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5VElDSzEsIHJlZ2lzdGVycyk7XHJcblxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIGR0ID0gbmV3IEFycmF5QnVmZmVyKDEyKTsgLy8gMyBVaW50MzIgXHJcbiAgICAgICAgICAgIGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcbiAgICAgICAgICAgIC8vIFNlZSBTZW5lY2FsIG1hbnVhbCBtYW51YWxcclxuICAgICAgICAgICAgLy8gTWF4IDIwa0haIGdlblxyXG4gICAgICAgICAgICBURU1QID0gTWF0aC5yb3VuZCgyMDAwMCAvIHNldHBvaW50MiwgMCk7XHJcblxyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoMCwgc2V0cG9pbnQsIGZhbHNlKTsgLy8gTlVNX1BVTFNFU1xyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoNCwgTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzFcclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDgsIFRFTVAgLSBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMlxyXG5cclxuICAgICAgICAgICAgcmVnaXN0ZXJzID0gW2R2LmdldFVpbnQxNigyLCBmYWxzZSksIGR2LmdldFVpbnQxNigwLCBmYWxzZSksXHJcbiAgICAgICAgICAgIGR2LmdldFVpbnQxNig2LCBmYWxzZSksIGR2LmdldFVpbnQxNig0LCBmYWxzZSksXHJcbiAgICAgICAgICAgIGR2LmdldFVpbnQxNigxMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoOCwgZmFsc2UpXTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUHVsc2VzQ291bnQsIHJlZ2lzdGVycyk7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVVRocmVzaG9sZF9GOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlRocmVzaG9sZFVfRnJlcSwgc3ApOyAvLyBVIG1pbiBmb3IgZnJlcSBtZWFzdXJlbWVudFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NlbnNpdGl2aXR5X3VTOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlNlbnNpYmlsaXR5X3VTX09GRixcclxuICAgICAgICAgICAgICAgIFtzcEludFswXSwgc3BJbnRbMV0sIHNwSW50WzBdLCBzcEludFsxXV0pOyAvLyB1ViBmb3IgcHVsc2UgdHJhaW4gbWVhc3VyZW1lbnQgdG8gT04gLyBPRkZcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ29sZEp1bmN0aW9uLCBzcCk7IC8vIHVuY2xlYXIgdW5pdFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1Vsb3c6XHJcbiAgICAgICAgICAgIG1vZGJ1cy5zZXRGbG9hdDMyTEVCUyhkdiwgMCwgc2V0cG9pbnQgLyBNQVhfVV9HRU4pOyAvLyBNdXN0IGNvbnZlcnQgViBpbnRvIGEgJSAwLi5NQVhfVV9HRU5cclxuICAgICAgICAgICAgdmFyIHNwMiA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HZW5VbG93UGVyYywgc3AyKTsgLy8gVSBsb3cgZm9yIGZyZXEgLyBwdWxzZSBnZW5cclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VaGlnaDpcclxuICAgICAgICAgICAgbW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCAvIE1BWF9VX0dFTik7IC8vIE11c3QgY29udmVydCBWIGludG8gYSAlIDAuLk1BWF9VX0dFTlxyXG4gICAgICAgICAgICB2YXIgc3AyID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdlblVoaWdoUGVyYywgc3AyKTsgLy8gVSBoaWdoIGZvciBmcmVxIC8gcHVsc2UgZ2VuICAgICAgICAgICAgXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2h1dGRvd25EZWxheTpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Qb3dlck9mZkRlbGF5LCBzZXRwb2ludCk7IC8vIGRlbGF5IGluIHNlY1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDsgLy8gTm8gc2V0cG9pbnRcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgaGFuZGxlZFwiKTtcclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHNldHBvaW50XHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3RcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlYWQobW9kZSkge1xyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlZvbHRhZ2VTZXRwb2ludCk7IC8vIG1WIG9yIFYgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRTZXRwb2ludCk7IC8vIEEgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuUlREVGVtcGVyYXR1cmVTZXRwb2ludCk7IC8vIMKwQyBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludCk7IC8vIMKwQyBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5VElDSzEpOyAvLyBGcmVxdWVuY3kgc2V0cG9pbnQgKFRJQ0tTKVxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuTG9hZENlbGxTZXRwb2ludCk7IC8vIG1WL1Ygc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgaGFuZGxlZFwiKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgYW5zd2VyIGFib3V0IFNldHBvaW50UmVhZFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZWdpc3RlcnMgRkMzIHBhcnNlZCBhbnN3ZXJcclxuICogQHJldHVybnMge251bWJlcn0gdGhlIGxhc3Qgc2V0cG9pbnRcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlU2V0cG9pbnRSZWFkKGJ1ZmZlciwgbW9kZSkge1xyXG4gICAgLy8gUm91bmQgdG8gdHdvIGRpZ2l0c1xyXG4gICAgdmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgdmFyIHJvdW5kZWQgPSBNYXRoLnJvdW5kKG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZWdpc3RlcnMsIDApICogMTAwKSAvIDEwMDtcclxuXHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJDdXJyZW50XCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJtQVwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJWXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJtVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiSW1iYWxhbmNlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJtVi9WXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgdmFyIHRpY2sxID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVnaXN0ZXJzLCAwKTtcclxuICAgICAgICAgICAgdmFyIHRpY2syID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVnaXN0ZXJzLCA0KTtcclxuICAgICAgICAgICAgdmFyIGZPTiA9IDAuMDtcclxuICAgICAgICAgICAgdmFyIGZPRkYgPSAwLjA7XHJcbiAgICAgICAgICAgIGlmICh0aWNrMSAhPSAwKVxyXG4gICAgICAgICAgICAgICAgZk9OID0gTWF0aC5yb3VuZCgxIC8gKHRpY2sxICogMiAvIDIwMDAwLjApICogMTAuMCkgLyAxMDsgLy8gTmVlZCBvbmUgZGVjaW1hbCBwbGFjZSBmb3IgSFpcclxuICAgICAgICAgICAgaWYgKHRpY2syICE9IDApXHJcbiAgICAgICAgICAgICAgICBmT0ZGID0gTWF0aC5yb3VuZCgxIC8gKHRpY2syICogMiAvIDIwMDAwLjApICogMTAuMCkgLyAxMDsgLy8gTmVlZCBvbmUgZGVjaW1hbCBwbGFjZSBmb3IgSFpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3kgT05cIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogZk9OLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiSHpcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3kgT0ZGXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVZhbHVlXCI6IGZPRkYsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVVuaXRcIjogXCJIelwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCI/XCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1xyXG4gICAgTVNDUmVnaXN0ZXJzLCBtYWtlU2VyaWFsTnVtYmVyLCBtYWtlQ3VycmVudE1vZGUsIG1ha2VCYXR0ZXJ5TGV2ZWwsIHBhcnNlQmF0dGVyeSwgcGFyc2VTZXJpYWxOdW1iZXIsXHJcbiAgICBwYXJzZUN1cnJlbnRNb2RlLCBtYWtlTW9kZVJlcXVlc3QsIG1ha2VNZWFzdXJlUmVxdWVzdCwgcGFyc2VNZWFzdXJlLCBtYWtlUXVhbGl0eUJpdFJlcXVlc3QsIGlzUXVhbGl0eVZhbGlkLFxyXG4gICAgbWFrZUdlblN0YXR1c1JlYWQsIHBhcnNlR2VuU3RhdHVzLCBtYWtlU2V0cG9pbnRSZXF1ZXN0LCBtYWtlU2V0cG9pbnRSZWFkLCBwYXJzZVNldHBvaW50UmVhZH0iLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi9jb25zdGFudHMnKTtcclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5cclxubGV0IHNsZWVwID0gbXMgPT4gbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcbmxldCB3YWl0Rm9yID0gYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihmKSB7XHJcbiAgICB3aGlsZSAoIWYoKSkgYXdhaXQgc2xlZXAoMTAwICsgTWF0aC5yYW5kb20oKSAqIDI1KTtcclxuICAgIHJldHVybiBmKCk7XHJcbn07XHJcblxyXG5sZXQgd2FpdEZvclRpbWVvdXQgPSBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yKGYsIHRpbWVvdXRTZWMpIHtcclxuICAgIHZhciB0b3RhbFRpbWVNcyA9IDA7XHJcbiAgICB3aGlsZSAoIWYoKSAmJiB0b3RhbFRpbWVNcyA8IHRpbWVvdXRTZWMgKiAxMDAwKSB7XHJcbiAgICAgICAgdmFyIGRlbGF5TXMgPSAxMDAgKyBNYXRoLnJhbmRvbSgpICogMjU7XHJcbiAgICAgICAgdG90YWxUaW1lTXMgKz0gZGVsYXlNcztcclxuICAgICAgICBhd2FpdCBzbGVlcChkZWxheU1zKTtcclxuICAgIH1cclxuICAgIHJldHVybiBmKCk7XHJcbn07XHJcblxyXG4vLyBUaGVzZSBmdW5jdGlvbnMgbXVzdCBleGlzdCBzdGFuZC1hbG9uZSBvdXRzaWRlIENvbW1hbmQgb2JqZWN0IGFzIHRoaXMgb2JqZWN0IG1heSBjb21lIGZyb20gSlNPTiB3aXRob3V0IHRoZW0hXHJcbmZ1bmN0aW9uIGlzR2VuZXJhdGlvbihjdHlwZSkge1xyXG4gICAgcmV0dXJuIChjdHlwZSA+IENvbW1hbmRUeXBlLk9GRiAmJiBjdHlwZSA8IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCk7XHJcbn1cclxuZnVuY3Rpb24gaXNNZWFzdXJlbWVudChjdHlwZSkge1xyXG4gICAgcmV0dXJuIChjdHlwZSA+IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiBjdHlwZSA8IENvbW1hbmRUeXBlLlJFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc1NldHRpbmcoY3R5cGUpIHtcclxuICAgIHJldHVybiAoY3R5cGUgPT0gQ29tbWFuZFR5cGUuT0ZGIHx8IGN0eXBlID4gQ29tbWFuZFR5cGUuU0VUVElOR19SRVNFUlZFRCk7XHJcbn1cclxuZnVuY3Rpb24gaXNWYWxpZChjdHlwZSkge1xyXG4gICAgcmV0dXJuIChpc01lYXN1cmVtZW50KGN0eXBlKSB8fCBpc0dlbmVyYXRpb24oY3R5cGUpIHx8IGlzU2V0dGluZyhjdHlwZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogSGVscGVyIGZ1bmN0aW9uIHRvIGNvbnZlcnQgYSB2YWx1ZSBpbnRvIGFuIGVudW0gdmFsdWVcclxuICogXHJcbiAqIEBwYXJhbSB7dHlwZX0gZW51bXR5cGVcclxuICogQHBhcmFtIHtudW1iZXJ9IGVudW12YWx1ZVxyXG4gKi9cclxuIGZ1bmN0aW9uIFBhcnNlKGVudW10eXBlLCBlbnVtdmFsdWUpIHtcclxuICAgIGZvciAodmFyIGVudW1OYW1lIGluIGVudW10eXBlKSB7XHJcbiAgICAgICAgaWYgKGVudW10eXBlW2VudW1OYW1lXSA9PSBlbnVtdmFsdWUpIHtcclxuICAgICAgICAgICAgLypqc2hpbnQgLVcwNjEgKi9cclxuICAgICAgICAgICAgcmV0dXJuIGV2YWwoW2VudW10eXBlICsgXCIuXCIgKyBlbnVtTmFtZV0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogSGVscGVyIGZ1bmN0aW9uIHRvIGR1bXAgYXJyYXlidWZmZXIgYXMgaGV4IHN0cmluZ1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICovXHJcbiBmdW5jdGlvbiBidWYyaGV4KGJ1ZmZlcikgeyAvLyBidWZmZXIgaXMgYW4gQXJyYXlCdWZmZXJcclxuICAgIHJldHVybiBbLi4ubmV3IFVpbnQ4QXJyYXkoYnVmZmVyKV1cclxuICAgICAgICAubWFwKHggPT4geC50b1N0cmluZygxNikucGFkU3RhcnQoMiwgJzAnKSlcclxuICAgICAgICAuam9pbignICcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoZXgyYnVmIChpbnB1dCkge1xyXG4gICAgaWYgKHR5cGVvZiBpbnB1dCAhPT0gJ3N0cmluZycpIHtcclxuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdFeHBlY3RlZCBpbnB1dCB0byBiZSBhIHN0cmluZycpXHJcbiAgICB9XHJcbiAgICB2YXIgaGV4c3RyID0gaW5wdXQucmVwbGFjZSgvXFxzKy9nLCAnJyk7XHJcbiAgICBpZiAoKGhleHN0ci5sZW5ndGggJSAyKSAhPT0gMCkge1xyXG4gICAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKCdFeHBlY3RlZCBzdHJpbmcgdG8gYmUgYW4gZXZlbiBudW1iZXIgb2YgY2hhcmFjdGVycycpXHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgdmlldyA9IG5ldyBVaW50OEFycmF5KGhleHN0ci5sZW5ndGggLyAyKVxyXG5cclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaGV4c3RyLmxlbmd0aDsgaSArPSAyKSB7XHJcbiAgICAgICAgdmlld1tpIC8gMl0gPSBwYXJzZUludChoZXhzdHIuc3Vic3RyaW5nKGksIGkgKyAyKSwgMTYpXHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHZpZXcuYnVmZmVyXHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBzbGVlcCwgd2FpdEZvciwgd2FpdEZvclRpbWVvdXQsIGlzR2VuZXJhdGlvbiwgaXNNZWFzdXJlbWVudCwgaXNTZXR0aW5nLCBpc1ZhbGlkLCBQYXJzZSwgYnVmMmhleCwgaGV4MmJ1ZiB9OyJdfQ==
