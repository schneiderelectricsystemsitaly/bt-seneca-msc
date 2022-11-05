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
        for(const trace of testData.testTraces) {
            if (trace["request"] === commandHex) {
                found.push(trace["answer"]);
            }
        }
        if (found.length > 0) {
            // Select a random answer from the registered trace
            responseHex = found[Math.floor((Math.random()*found.length))];
        }
        else
        {
            console.info(commandHex + " not found in test traces");
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

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY2xhc3Nlcy9TZW5lY2FNU0MuanMiLCJjb25zdGFudHMuanMiLCJtZXRlckFwaS5qcyIsIm1ldGVyUHVibGljQVBJLmpzIiwibW9kYnVzUnR1LmpzIiwibW9kYnVzVGVzdERhdGEuanMiLCJub2RlX21vZHVsZXMvbG9nbGV2ZWwvbGliL2xvZ2xldmVsLmpzIiwic2VuZWNhTW9kYnVzLmpzIiwidXRpbHMuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6UUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxNUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbnBCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCIndXNlIHN0cmljdCc7XHJcblxyXG4vKipcclxuICogIEJsdWV0b290aCBoYW5kbGluZyBtb2R1bGUsIGluY2x1ZGluZyBtYWluIHN0YXRlIG1hY2hpbmUgbG9vcC5cclxuICogIFRoaXMgbW9kdWxlIGludGVyYWN0cyB3aXRoIGJyb3dzZXIgZm9yIGJsdWV0b290aCBjb211bmljYXRpb25zIGFuZCBwYWlyaW5nLCBhbmQgd2l0aCBTZW5lY2FNU0Mgb2JqZWN0LlxyXG4gKi9cclxuXHJcbnZhciBBUElTdGF0ZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9BUElTdGF0ZScpO1xyXG52YXIgbG9nID0gcmVxdWlyZSgnbG9nbGV2ZWwnKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcclxudmFyIHNlbmVjYU1vZHVsZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9TZW5lY2FNU0MnKTtcclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoJy4vbW9kYnVzUnR1Jyk7XHJcbnZhciB0ZXN0RGF0YSA9IHJlcXVpcmUoJy4vbW9kYnVzVGVzdERhdGEnKTtcclxuXHJcbnZhciBidFN0YXRlID0gQVBJU3RhdGUuYnRTdGF0ZTtcclxudmFyIFN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbnZhciBSZXN1bHRDb2RlID0gY29uc3RhbnRzLlJlc3VsdENvZGU7XHJcbnZhciBzaW11bGF0aW9uID0gZmFsc2U7XHJcbnZhciBsb2dnaW5nID0gZmFsc2U7XHJcbi8qXHJcbiAqIEJsdWV0b290aCBjb25zdGFudHNcclxuICovXHJcbmNvbnN0IEJsdWVUb290aE1TQyA9IHtcclxuICAgIFNlcnZpY2VVdWlkOiAnMDAwM2NkZDAtMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxJywgLy8gYmx1ZXRvb3RoIG1vZGJ1cyBSVFUgc2VydmljZSBmb3IgU2VuZWNhIE1TQ1xyXG4gICAgTW9kYnVzQW5zd2VyVXVpZDogJzAwMDNjZGQxLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMScsICAgICAvLyBtb2RidXMgUlRVIGFuc3dlcnNcclxuICAgIE1vZGJ1c1JlcXVlc3RVdWlkOiAnMDAwM2NkZDItMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxJyAgICAvLyBtb2RidXMgUlRVIHJlcXVlc3RzXHJcbn07XHJcblxyXG5cclxuLyoqXHJcbiAqIFNlbmQgdGhlIG1lc3NhZ2UgdXNpbmcgQmx1ZXRvb3RoIGFuZCB3YWl0IGZvciBhbiBhbnN3ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gY29tbWFuZCBtb2RidXMgUlRVIHBhY2tldCB0byBzZW5kXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gdGhlIG1vZGJ1cyBSVFUgYW5zd2VyXHJcbiAqL1xyXG4gYXN5bmMgZnVuY3Rpb24gU2VuZEFuZFJlc3BvbnNlKGNvbW1hbmQpIHtcclxuXHJcbiAgICBpZiAoY29tbWFuZCA9PSBudWxsKVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG5cclxuICAgIGxvZy5kZWJ1ZyhcIj4+IFwiICsgdXRpbHMuYnVmMmhleChjb21tYW5kKSk7XHJcblxyXG4gICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICBidFN0YXRlLnN0YXRzW1wicmVxdWVzdHNcIl0rKztcclxuXHJcbiAgICB2YXIgc3RhcnRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICBpZiAoc2ltdWxhdGlvbikge1xyXG4gICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBmYWtlUmVzcG9uc2UoY29tbWFuZCk7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoNSk7XHJcbiAgICB9XHJcbiAgICBlbHNlIHtcclxuICAgICAgICBhd2FpdCBidFN0YXRlLmNoYXJXcml0ZS53cml0ZVZhbHVlV2l0aG91dFJlc3BvbnNlKGNvbW1hbmQpO1xyXG4gICAgICAgIHdoaWxlIChidFN0YXRlLnN0YXRlID09IFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORyB8fFxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRlID09IFN0YXRlLkJVU1kpIHtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUucmVzcG9uc2UgIT0gbnVsbCkgYnJlYWs7XHJcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAzNSkpO1xyXG4gICAgICAgIH0gICAgXHJcbiAgICB9XHJcbiAgICBcclxuICAgIHZhciBlbmRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblxyXG4gICAgdmFyIGFuc3dlciA9IGJ0U3RhdGUucmVzcG9uc2U/LnNsaWNlKCk7XHJcbiAgICBidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuICAgIFxyXG4gICAgLy8gTG9nIHRoZSBwYWNrZXRzXHJcbiAgICBpZiAobG9nZ2luZykge1xyXG4gICAgICAgIHZhciBwYWNrZXQgPSB7J3JlcXVlc3QnOiB1dGlscy5idWYyaGV4KGNvbW1hbmQpLCAnYW5zd2VyJzogdXRpbHMuYnVmMmhleChhbnN3ZXIpfTtcclxuICAgICAgICB2YXIgcGFja2V0cyA9IHdpbmRvdy5sb2NhbFN0b3JhZ2UuZ2V0SXRlbShcIk1vZGJ1c1JUVXRyYWNlXCIpO1xyXG4gICAgICAgIGlmIChwYWNrZXRzID09IG51bGwpXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICBwYWNrZXRzID0gW107IC8vIGluaXRpYWxpemUgYXJyYXlcclxuICAgICAgICB9XHJcbiAgICAgICAgZWxzZVxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgcGFja2V0cyA9IEpTT04ucGFyc2UocGFja2V0cyk7IC8vIFJlc3RvcmUgdGhlIGpzb24gcGVyc2lzdGVkIG9iamVjdFxyXG4gICAgICAgIH1cclxuICAgICAgICBwYWNrZXRzLnB1c2gocGFja2V0KTsgLy8gQWRkIHRoZSBuZXcgb2JqZWN0XHJcbiAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKFwiTW9kYnVzUlRVdHJhY2VcIiwgSlNPTi5zdHJpbmdpZnkocGFja2V0cykpO1xyXG4gICAgfVxyXG5cclxuICAgIGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKCgxLjAgKiBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdICogKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgKGVuZFRpbWUgLSBzdGFydFRpbWUpKSAvICgoYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSAlIDUwMCkgKyAxKSk7XHJcbiAgICBidFN0YXRlLnN0YXRzW1wibGFzdFJlc3BvbnNlVGltZVwiXSA9IE1hdGgucm91bmQoZW5kVGltZSAtIHN0YXJ0VGltZSkgKyBcIiBtc1wiO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSsrO1xyXG5cclxuICAgIHJldHVybiBhbnN3ZXI7XHJcbn1cclxuXHJcbmxldCBzZW5lY2FNU0MgPSBuZXcgc2VuZWNhTW9kdWxlLlNlbmVjYU1TQyhTZW5kQW5kUmVzcG9uc2UpO1xyXG5cclxuLyoqXHJcbiAqIE1haW4gbG9vcCBvZiB0aGUgbWV0ZXIgaGFuZGxlci5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gc3RhdGVNYWNoaW5lKCkge1xyXG4gICAgdmFyIG5leHRBY3Rpb247XHJcbiAgICB2YXIgREVMQVlfTVMgPSAoc2ltdWxhdGlvbj8yMDo3NTApOyAvLyBVcGRhdGUgdGhlIHN0YXR1cyBldmVyeSBYIG1zLlxyXG4gICAgdmFyIFRJTUVPVVRfTVMgPSAoc2ltdWxhdGlvbj8xMDAwOjMwMDAwKTsgLy8gR2l2ZSB1cCBzb21lIG9wZXJhdGlvbnMgYWZ0ZXIgWCBtcy5cclxuICAgIGJ0U3RhdGUuc3RhcnRlZCA9IHRydWU7XHJcblxyXG4gICAgbG9nLmRlYnVnKFwiQ3VycmVudCBzdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG5cclxuICAgIC8vIENvbnNlY3V0aXZlIHN0YXRlIGNvdW50ZWQuIENhbiBiZSB1c2VkIHRvIHRpbWVvdXQuXHJcbiAgICBpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBidFN0YXRlLnByZXZfc3RhdGUpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCsrO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3RvcCByZXF1ZXN0IGZyb20gQVBJXHJcbiAgICBpZiAoYnRTdGF0ZS5zdG9wUmVxdWVzdCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUElORztcclxuICAgIH1cclxuXHJcbiAgICBsb2cuZGVidWcoXCJcXFN0YXRlOlwiICsgYnRTdGF0ZS5zdGF0ZSk7XHJcbiAgICBzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuICAgICAgICBjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6IC8vIGluaXRpYWwgc3RhdGUgb24gU3RhcnQoKVxyXG4gICAgICAgICAgICBpZiAoc2ltdWxhdGlvbil7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gZmFrZVBhaXJEZXZpY2U7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRQYWlyRGV2aWNlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuQ09OTkVDVElORzogLy8gd2FpdGluZyBmb3IgY29ubmVjdGlvbiB0byBjb21wbGV0ZVxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkRFVklDRV9QQUlSRUQ6IC8vIGNvbm5lY3Rpb24gY29tcGxldGUsIGFjcXVpcmUgbWV0ZXIgc3RhdGVcclxuICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGZha2VTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVUJTQ1JJQklORzogLy8gd2FpdGluZyBmb3IgQmx1ZXRvb3RoIGludGVyZmFjZXNcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCJUaW1lb3V0IGluIFNVQlNDUklCSU5HXCIpO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5NRVRFUl9JTklUOiAvLyByZWFkeSB0byBjb21tdW5pY2F0ZSwgYWNxdWlyZSBtZXRlciBzdGF0dXNcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IG1ldGVySW5pdDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc6IC8vIHJlYWRpbmcgdGhlIG1ldGVyIHN0YXR1c1xyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5zdGF0ZV9jcHQgPiAoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCJUaW1lb3V0IGluIE1FVEVSX0lOSVRJQUxJWklOR1wiKTtcclxuICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBmYWtlU3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5JRExFOiAvLyByZWFkeSB0byBwcm9jZXNzIGNvbW1hbmRzIGZyb20gQVBJXHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbClcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBwcm9jZXNzQ29tbWFuZDtcclxuICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gcmVmcmVzaDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkVSUk9SOiAvLyBhbnl0aW1lIGFuIGVycm9yIGhhcHBlbnNcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuQlVTWTogLy8gd2hpbGUgYSBjb21tYW5kIGluIGdvaW5nIG9uXHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IChUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcbiAgICAgICAgICAgICAgICBsb2cud2FybihcIlRpbWVvdXQgaW4gQlVTWVwiKTtcclxuICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBmYWtlU3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVE9QUElORzpcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBFRDogLy8gYWZ0ZXIgYSBkaXNjb25uZWN0b3Igb3IgU3RvcCgpIHJlcXVlc3QsIHN0b3BzIHRoZSBzdGF0ZSBtYWNoaW5lLlxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgIH1cclxuXHJcbiAgICBidFN0YXRlLnByZXZfc3RhdGUgPSBidFN0YXRlLnN0YXRlO1xyXG5cclxuICAgIGlmIChuZXh0QWN0aW9uICE9IHVuZGVmaW5lZCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdEV4ZWN1dGluZzpcIiArIG5leHRBY3Rpb24ubmFtZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgbmV4dEFjdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCJFeGNlcHRpb24gaW4gc3RhdGUgbWFjaGluZVwiLCBlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEKSB7XHJcbiAgICAgICAgdXRpbHMuc2xlZXAoREVMQVlfTVMpLnRoZW4oKCkgPT4gc3RhdGVNYWNoaW5lKCkpOyAvLyBSZWNoZWNrIHN0YXR1cyBpbiBERUxBWV9NUyBtc1xyXG4gICAgfVxyXG4gICAgZWxzZSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0VGVybWluYXRpbmcgU3RhdGUgbWFjaGluZVwiKTtcclxuICAgICAgICBidFN0YXRlLnN0YXJ0ZWQgPSBmYWxzZTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIENhbGxlZCBmcm9tIHN0YXRlIG1hY2hpbmUgdG8gZXhlY3V0ZSBhIHNpbmdsZSBjb21tYW5kIGZyb20gYnRTdGF0ZS5jb21tYW5kIHByb3BlcnR5XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kKCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICB2YXIgY29tbWFuZCA9IGJ0U3RhdGUuY29tbWFuZDtcclxuICAgICAgICB2YXIgcmVzdWx0ID0gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG4gICAgICAgIHZhciBwYWNrZXQsIHJlc3BvbnNlLCBzdGFydEdlbjtcclxuXHJcbiAgICAgICAgaWYgKGNvbW1hbmQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJjb21tYW5kc1wiXSsrO1xyXG5cclxuICAgICAgICBsb2cuaW5mbygnXFx0XFx0RXhlY3V0aW5nIGNvbW1hbmQgOicgKyBjb21tYW5kKTtcclxuXHJcbiAgICAgICAgLy8gRmlyc3Qgc2V0IE5PTkUgYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIHdyaXRlIG5ldyBzZXRwb2ludHMgd2l0aCBhY3RpdmUgZ2VuZXJhdGlvblxyXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy5zd2l0Y2hPZmYoKTtcclxuICAgICAgICBpZiAocmVzdWx0ICE9IFJlc3VsdENvZGUuU1VDQ0VTUykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3Qgc3dpdGNoIG1ldGVyIG9mZiBiZWZvcmUgY29tbWFuZCB3cml0ZSFcIik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIFxyXG4gICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgc2V0cG9pbnQgb3Igc2V0dGluZ1xyXG4gICAgICAgIGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy53cml0ZVNldHBvaW50cyhjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuICAgICAgICAgICAgaWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gd3JpdGUgc2V0cG9pbnRzIVwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKCF1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBcclxuICAgICAgICAgICAgdXRpbHMuaXNWYWxpZChjb21tYW5kLnR5cGUpICYmIGNvbW1hbmQudHlwZSAhPSBDb21tYW5kVHlwZS5PRkYpICAvLyBJRiB0aGlzIGlzIGEgc2V0dGluZywgd2UncmUgZG9uZS5cclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgbW9kZSBzZXRcclxuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgc2VuZWNhTVNDLmNoYW5nZU1vZGUoY29tbWFuZC50eXBlKTtcclxuICAgICAgICAgICAgaWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gY2hhbmdlIG1ldGVyIG1vZGUhXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBDYWxsZXIgZXhwZWN0cyBhIHZhbGlkIHByb3BlcnR5IGluIEdldFN0YXRlKCkgb25jZSBjb21tYW5kIGlzIGV4ZWN1dGVkLlxyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlZnJlc2hpbmcgY3VycmVudCBzdGF0ZVwiKTtcclxuICAgICAgICBhd2FpdCByZWZyZXNoKCk7XHJcblxyXG4gICAgICAgIGNvbW1hbmQuZXJyb3IgPSBmYWxzZTtcclxuICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICBidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuSURMRTtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRDb21wbGV0ZWQgY29tbWFuZCBleGVjdXRlZFwiKTtcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cuZXJyb3IoXCIqKiBlcnJvciB3aGlsZSBleGVjdXRpbmcgY29tbWFuZDogXCIgKyBlcnIpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdldEV4cGVjdGVkU3RhdGVIZXgoKSB7XHJcbi8vIFNpbXVsYXRlIGN1cnJlbnQgbW9kZSBhbnN3ZXIgYWNjb3JkaW5nIHRvIGxhc3QgY29tbWFuZC5cclxuICAgIHZhciBzdGF0ZUhleCA9IChDb21tYW5kVHlwZS5PRkYpLnRvU3RyaW5nKDE2KTtcclxuICAgIGlmIChidFN0YXRlLmNvbW1hbmQ/LnR5cGUgIT0gbnVsbClcclxuICAgIHtcclxuICAgICAgICBzdGF0ZUhleCA9IChidFN0YXRlLmNvbW1hbmQudHlwZSkudG9TdHJpbmcoMTYpO1xyXG4gICAgfVxyXG4gICAgLy8gQWRkIHRyYWlsaW5nIDBcclxuICAgIHdoaWxlKHN0YXRlSGV4Lmxlbmd0aCA8IDIpXHJcbiAgICAgICAgc3RhdGVIZXggPSBcIjBcIiArIHN0YXRlSGV4O1xyXG4gICAgcmV0dXJuIHN0YXRlSGV4O1xyXG59XHJcbi8qKlxyXG4gKiBVc2VkIHRvIHNpbXVsYXRlIFJUVSBhbnN3ZXJzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGNvbW1hbmQgcmVhbCByZXF1ZXN0XHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gZmFrZSBhbnN3ZXJcclxuICovXHJcbmZ1bmN0aW9uIGZha2VSZXNwb25zZShjb21tYW5kKSB7XHJcbiAgICB2YXIgY29tbWFuZEhleCA9IHV0aWxzLmJ1ZjJoZXgoY29tbWFuZCk7XHJcbiAgICB2YXIgZm9yZ2VkQW5zd2VycyA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgJzE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkJyA6ICcxOSAwMyAwMiAwMCcgKyBnZXRFeHBlY3RlZFN0YXRlSGV4KCkgKycgJCQkJCcsIC8vIEN1cnJlbnQgc3RhdGVcclxuICAgICAgICAgICAgICAgICAgICAgJ2RlZmF1bHQgMDMnIDogJzE5IDAzIDA2IDAwMDEgMDAwMSAwMDAxICQkJCQnLCAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMzXHJcbiAgICAgICAgICAgICAgICAgICAgICdkZWZhdWx0IDEwJyA6ICcxOSAxMCAwMCBkNCAwMCAwMiAwMDAxIDAwMDEgJCQkJCd9OyAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMxMFxyXG5cclxuICAgIC8vIFN0YXJ0IHdpdGggdGhlIGRlZmF1bHQgYW5zd2VyXHJcbiAgICB2YXIgcmVzcG9uc2VIZXggPSBmb3JnZWRBbnN3ZXJzWydkZWZhdWx0ICcgKyBjb21tYW5kSGV4LnNwbGl0KCcgJylbMV1dO1xyXG5cclxuICAgIC8vIERvIHdlIGhhdmUgYSBmb3JnZWQgYW5zd2VyP1xyXG4gICAgaWYgKGZvcmdlZEFuc3dlcnNbY29tbWFuZEhleF0gIT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgcmVzcG9uc2VIZXggPSBmb3JnZWRBbnN3ZXJzW2NvbW1hbmRIZXhdO1xyXG4gICAgfVxyXG4gICAgZWxzZVxyXG4gICAge1xyXG4gICAgICAgIC8vIExvb2sgaW50byByZWdpc3RlcmVkIHRyYWNlc1xyXG4gICAgICAgIGZvdW5kID0gW107XHJcbiAgICAgICAgZm9yKGNvbnN0IHRyYWNlIG9mIHRlc3REYXRhLnRlc3RUcmFjZXMpIHtcclxuICAgICAgICAgICAgaWYgKHRyYWNlW1wicmVxdWVzdFwiXSA9PT0gY29tbWFuZEhleCkge1xyXG4gICAgICAgICAgICAgICAgZm91bmQucHVzaCh0cmFjZVtcImFuc3dlclwiXSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZvdW5kLmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgICAgLy8gU2VsZWN0IGEgcmFuZG9tIGFuc3dlciBmcm9tIHRoZSByZWdpc3RlcmVkIHRyYWNlXHJcbiAgICAgICAgICAgIHJlc3BvbnNlSGV4ID0gZm91bmRbTWF0aC5mbG9vcigoTWF0aC5yYW5kb20oKSpmb3VuZC5sZW5ndGgpKV07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2VcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIGNvbnNvbGUuaW5mbyhjb21tYW5kSGV4ICsgXCIgbm90IGZvdW5kIGluIHRlc3QgdHJhY2VzXCIpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIFxyXG4gICAgLy8gQ29tcHV0ZSBDUkMgaWYgbmVlZGVkXHJcbiAgICBpZiAocmVzcG9uc2VIZXguaW5jbHVkZXMoXCIkJCQkXCIpKSB7XHJcbiAgICAgICAgcmVzcG9uc2VIZXggPSByZXNwb25zZUhleC5yZXBsYWNlKCckJCQkJywnJyk7XHJcbiAgICAgICAgdmFyIGNyYyA9IG1vZGJ1cy5jcmMxNihuZXcgVWludDhBcnJheSh1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KSkpLnRvU3RyaW5nKDE2KTtcclxuICAgICAgICB3aGlsZShjcmMubGVuZ3RoIDwgNClcclxuICAgICAgICAgICAgY3JjID0gXCIwXCIgKyBjcmM7XHJcbiAgICAgICAgcmVzcG9uc2VIZXggPSByZXNwb25zZUhleCArIGNyYy5zdWJzdHJpbmcoMiw0KSArIGNyYy5zdWJzdHJpbmcoMCwyKTtcclxuICAgIH1cclxuXHJcbiAgICBsb2cuZGVidWcoXCI8PCBcIiArIHJlc3BvbnNlSGV4KTtcclxuICAgIHJldHVybiB1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFjcXVpcmUgdGhlIGN1cnJlbnQgbW9kZSBhbmQgc2VyaWFsIG51bWJlciBvZiB0aGUgZGV2aWNlLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBtZXRlckluaXQoKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc7XHJcbiAgICAgICAgYnRTdGF0ZS5tZXRlci5zZXJpYWwgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0U2VyaWFsTnVtYmVyKCk7XHJcbiAgICAgICAgbG9nLmluZm8oJ1xcdFxcdFNlcmlhbCBudW1iZXI6JyArIGJ0U3RhdGUubWV0ZXIuc2VyaWFsKTtcclxuXHJcbiAgICAgICAgYnRTdGF0ZS5tZXRlci5tb2RlID0gYXdhaXQgc2VuZWNhTVNDLmdldEN1cnJlbnRNb2RlKCk7XHJcbiAgICAgICAgbG9nLmRlYnVnKCdcXHRcXHRDdXJyZW50IG1vZGU6JyArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblxyXG4gICAgICAgIGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSA9IGF3YWl0IHNlbmVjYU1TQy5nZXRCYXR0ZXJ5Vm9sdGFnZSgpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnXFx0XFx0QmF0dGVyeSAoVik6JyArIGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSk7XHJcblxyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgaW5pdGlhbGl6aW5nIG1ldGVyIDpcIiArIGVycik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKlxyXG4gKiBDbG9zZSB0aGUgYmx1ZXRvb3RoIGludGVyZmFjZSAodW5wYWlyKVxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBkaXNjb25uZWN0KCkge1xyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgICAgICBsb2cud2FybihcIiogQ2FsbGluZyBkaXNjb25uZWN0IG9uIGJ0ZGV2aWNlXCIpO1xyXG4gICAgICAgICAgICAgICAgLy8gQXZvaWQgdGhlIGV2ZW50IGZpcmluZyB3aGljaCBtYXkgbGVhZCB0byBhdXRvLXJlY29ubmVjdFxyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5idERldmljZS5yZW1vdmVFdmVudExpc3RlbmVyKCdnYXR0c2VydmVyZGlzY29ubmVjdGVkJywgb25EaXNjb25uZWN0ZWQpO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5idERldmljZS5nYXR0LmRpc2Nvbm5lY3QoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjYXRjaCB7IH1cclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUEVEO1xyXG59XHJcblxyXG4vKipcclxuICogRXZlbnQgY2FsbGVkIGJ5IGJyb3dzZXIgQlQgYXBpIHdoZW4gdGhlIGRldmljZSBkaXNjb25uZWN0XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIG9uRGlzY29ubmVjdGVkKCkge1xyXG4gICAgbG9nLndhcm4oXCIqIEdBVFQgU2VydmVyIGRpc2Nvbm5lY3RlZCBldmVudCwgd2lsbCB0cnkgdG8gcmVjb25uZWN0ICpcIik7XHJcbiAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICBidFN0YXRlLnN0YXRzW1wiR0FUVCBkaXNjb25uZWN0c1wiXSsrO1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7IC8vIFRyeSB0byBhdXRvLXJlY29ubmVjdCB0aGUgaW50ZXJmYWNlcyB3aXRob3V0IHBhaXJpbmdcclxufVxyXG5cclxuLyoqXHJcbiAqIEpvaW5zIHRoZSBhcmd1bWVudHMgaW50byBhIHNpbmdsZSBidWZmZXJcclxuICogQHJldHVybnMge0J1ZmZlcn0gY29uY2F0ZW5hdGVkIGJ1ZmZlclxyXG4gKi9cclxuZnVuY3Rpb24gYXJyYXlCdWZmZXJDb25jYXQoKSB7XHJcbiAgICB2YXIgbGVuZ3RoID0gMDtcclxuICAgIHZhciBidWZmZXIgPSBudWxsO1xyXG5cclxuICAgIGZvciAodmFyIGkgaW4gYXJndW1lbnRzKSB7XHJcbiAgICAgICAgYnVmZmVyID0gYXJndW1lbnRzW2ldO1xyXG4gICAgICAgIGxlbmd0aCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgam9pbmVkID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcclxuICAgIHZhciBvZmZzZXQgPSAwO1xyXG5cclxuICAgIGZvciAoaSBpbiBhcmd1bWVudHMpIHtcclxuICAgICAgICBidWZmZXIgPSBhcmd1bWVudHNbaV07XHJcbiAgICAgICAgam9pbmVkLnNldChuZXcgVWludDhBcnJheShidWZmZXIpLCBvZmZzZXQpO1xyXG4gICAgICAgIG9mZnNldCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gam9pbmVkLmJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBibHVldG9vdGggY2hhcmFjdGVyaXN0aWNzIHdoZW4gcmVjZWl2aW5nIGRhdGFcclxuICogQHBhcmFtIHthbnl9IGV2ZW50XHJcbiAqL1xyXG5mdW5jdGlvbiBoYW5kbGVOb3RpZmljYXRpb25zKGV2ZW50KSB7XHJcbiAgICBsZXQgdmFsdWUgPSBldmVudC50YXJnZXQudmFsdWU7XHJcbiAgICBpZiAodmFsdWUgIT0gbnVsbCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPDwgJyArIHV0aWxzLmJ1ZjJoZXgodmFsdWUuYnVmZmVyKSk7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUucmVzcG9uc2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gYXJyYXlCdWZmZXJDb25jYXQoYnRTdGF0ZS5yZXNwb25zZSwgdmFsdWUuYnVmZmVyKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gdmFsdWUuYnVmZmVyLnNsaWNlKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogVGhpcyBmdW5jdGlvbiB3aWxsIHN1Y2NlZWQgb25seSBpZiBjYWxsZWQgYXMgYSBjb25zZXF1ZW5jZSBvZiBhIHVzZXItZ2VzdHVyZVxyXG4gKiBFLmcuIGJ1dHRvbiBjbGljay4gVGhpcyBpcyBkdWUgdG8gQmx1ZVRvb3RoIEFQSSBzZWN1cml0eSBtb2RlbC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gYnRQYWlyRGV2aWNlKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcbiAgICB2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuICAgIGxvZy5kZWJ1ZyhcImJ0UGFpckRldmljZShcIiArIGZvcmNlU2VsZWN0aW9uICsgXCIpXCIpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBpZiAodHlwZW9mIChuYXZpZ2F0b3IuYmx1ZXRvb3RoPy5nZXRBdmFpbGFiaWxpdHkpID09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmlsaXR5ID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aC5nZXRBdmFpbGFiaWxpdHkoKTtcclxuICAgICAgICAgICAgaWYgKCFhdmFpbGFiaWxpdHkpIHtcclxuICAgICAgICAgICAgICAgIGxvZy5lcnJvcihcIkJsdWV0b290aCBub3QgYXZhaWxhYmxlIGluIGJyb3dzZXIuXCIpO1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQnJvd3NlciBkb2VzIG5vdCBwcm92aWRlIGJsdWV0b290aFwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgZGV2aWNlID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gRG8gd2UgYWxyZWFkeSBoYXZlIHBlcm1pc3Npb24/XHJcbiAgICAgICAgaWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0RGV2aWNlcykgPT0gJ2Z1bmN0aW9uJ1xyXG4gICAgICAgICAgICAmJiAhZm9yY2VTZWxlY3Rpb24pIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlRGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0RGV2aWNlcygpO1xyXG4gICAgICAgICAgICBhdmFpbGFibGVEZXZpY2VzLmZvckVhY2goZnVuY3Rpb24gKGRldiwgaW5kZXgpIHtcclxuICAgICAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIkZvdW5kIGF1dGhvcml6ZWQgZGV2aWNlIDpcIiArIGRldi5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGlmIChkZXYubmFtZS5zdGFydHNXaXRoKFwiTVNDXCIpKVxyXG4gICAgICAgICAgICAgICAgICAgIGRldmljZSA9IGRldjtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIm5hdmlnYXRvci5ibHVldG9vdGguZ2V0RGV2aWNlcygpPVwiICsgZGV2aWNlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gSWYgbm90LCByZXF1ZXN0IGZyb20gdXNlclxyXG4gICAgICAgIGlmIChkZXZpY2UgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBkZXZpY2UgPSBhd2FpdCBuYXZpZ2F0b3IuYmx1ZXRvb3RoXHJcbiAgICAgICAgICAgICAgICAucmVxdWVzdERldmljZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgYWNjZXB0QWxsRGV2aWNlczogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgZmlsdGVyczogW3sgbmFtZVByZWZpeDogJ01TQycgfV0sXHJcbiAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWxTZXJ2aWNlczogW0JsdWVUb290aE1TQy5TZXJ2aWNlVXVpZF1cclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmJ0RGV2aWNlID0gZGV2aWNlO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGxvZy5pbmZvKFwiQmx1ZXRvb3RoIGRldmljZSBcIiArIGRldmljZS5uYW1lICsgXCIgY29ubmVjdGVkLlwiKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MDApO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiKiogZXJyb3Igd2hpbGUgY29ubmVjdGluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgIGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkVSUk9SO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZha2VQYWlyRGV2aWNlKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcbiAgICB2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuICAgIGxvZy5kZWJ1ZyhcImZha2VQYWlyRGV2aWNlKFwiICsgZm9yY2VTZWxlY3Rpb24gKyBcIilcIik7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIHZhciBkZXZpY2UgPSB7IG5hbWUgOiBcIkZha2VCVERldmljZVwiLCBnYXR0OiB7Y29ubmVjdGVkOnRydWV9fTtcclxuICAgICAgICBidFN0YXRlLmJ0RGV2aWNlID0gZGV2aWNlO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGxvZy5pbmZvKFwiQmx1ZXRvb3RoIGRldmljZSBcIiArIGRldmljZS5uYW1lICsgXCIgY29ubmVjdGVkLlwiKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MCk7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBjb25uZWN0aW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogT25jZSB0aGUgZGV2aWNlIGlzIGF2YWlsYWJsZSwgaW5pdGlhbGl6ZSB0aGUgc2VydmljZSBhbmQgdGhlIDIgY2hhcmFjdGVyaXN0aWNzIG5lZWRlZC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gYnRTdWJzY3JpYmUoKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVUJTQ1JJQklORztcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wic3ViY3JpYmVzXCJdKys7XHJcbiAgICAgICAgbGV0IGRldmljZSA9IGJ0U3RhdGUuYnREZXZpY2U7XHJcbiAgICAgICAgbGV0IHNlcnZlciA9IG51bGw7XHJcblxyXG4gICAgICAgIGlmICghZGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKGBDb25uZWN0aW5nIHRvIEdBVFQgU2VydmVyIG9uICR7ZGV2aWNlLm5hbWV9Li4uYCk7XHJcbiAgICAgICAgICAgIGRldmljZS5hZGRFdmVudExpc3RlbmVyKCdnYXR0c2VydmVyZGlzY29ubmVjdGVkJywgb25EaXNjb25uZWN0ZWQpO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnRTZXJ2aWNlPy5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBidFN0YXRlLmJ0U2VydmljZS5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikgeyB9XHJcblxyXG4gICAgICAgICAgICBzZXJ2ZXIgPSBhd2FpdCBkZXZpY2UuZ2F0dC5jb25uZWN0KCk7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBHQVRUIHNlcnZlcicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCdHQVRUIGFscmVhZHkgY29ubmVjdGVkJyk7XHJcbiAgICAgICAgICAgIHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBhd2FpdCBzZXJ2ZXIuZ2V0UHJpbWFyeVNlcnZpY2UoQmx1ZVRvb3RoTVNDLlNlcnZpY2VVdWlkKTtcclxuICAgICAgICBpZiAoYnRTdGF0ZS5idFNlcnZpY2UgPT0gbnVsbClcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR0FUVCBTZXJ2aWNlIHJlcXVlc3QgZmFpbGVkXCIpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBTZXJpYWwgc2VydmljZScpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c1JlcXVlc3RVdWlkKTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgd3JpdGUgY2hhcmFjdGVyaXN0aWMnKTtcclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c0Fuc3dlclV1aWQpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZC5hZGRFdmVudExpc3RlbmVyKCdjaGFyYWN0ZXJpc3RpY3ZhbHVlY2hhbmdlZCcsIGhhbmRsZU5vdGlmaWNhdGlvbnMpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RhcnROb3RpZmljYXRpb25zKCk7XHJcbiAgICAgICAgbG9nLmluZm8oJz4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MCk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVQ7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUuY2hhclJlYWQgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQuZGlzY29ubmVjdCgpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmYWtlU3Vic2NyaWJlKCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1VCU0NSSUJJTkc7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcInN1YmNyaWJlc1wiXSsrO1xyXG4gICAgICAgIGxldCBkZXZpY2UgPSBidFN0YXRlLmJ0RGV2aWNlO1xyXG4gICAgICAgIGxldCBzZXJ2ZXIgPSBudWxsO1xyXG5cclxuICAgICAgICBpZiAoIWRldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhgQ29ubmVjdGluZyB0byBHQVRUIFNlcnZlciBvbiAke2RldmljZS5uYW1lfS4uLmApO1xyXG4gICAgICAgICAgICBkZXZpY2VbJ2dhdHQnXVsnY29ubmVjdGVkJ109dHJ1ZTtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCc+IEZvdW5kIEdBVFQgc2VydmVyJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoJ0dBVFQgYWxyZWFkeSBjb25uZWN0ZWQnKTtcclxuICAgICAgICAgICAgc2VydmVyID0gZGV2aWNlLmdhdHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IHt9O1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBTZXJpYWwgc2VydmljZScpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0ge307XHJcbiAgICAgICAgbG9nLmRlYnVnKCc+IEZvdW5kIHdyaXRlIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IHt9O1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICAgICAgbG9nLmluZm8oJz4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMCk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVQ7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICB9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogV2hlbiBpZGxlLCB0aGlzIGZ1bmN0aW9uIGlzIGNhbGxlZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkJVU1k7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIC8vIENoZWNrIHRoZSBtb2RlIGZpcnN0XHJcbiAgICAgICAgdmFyIG1vZGUgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0Q3VycmVudE1vZGUoKTtcclxuXHJcbiAgICAgICAgaWYgKG1vZGUgIT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUubWV0ZXIubW9kZSA9IG1vZGU7XHJcblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc0dlbmVyYXRpb24oKSlcclxuICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgdmFyIHNldHBvaW50cyA9IGF3YWl0IHNlbmVjYU1TQy5nZXRTZXRwb2ludHMoYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUubGFzdFNldHBvaW50ID0gc2V0cG9pbnRzO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc01lYXN1cmVtZW50KCkpXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIHZhciBtZWFzID0gYXdhaXQgc2VuZWNhTVNDLmdldE1lYXN1cmVzKGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLmxhc3RNZWFzdXJlID0gbWVhcztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRGaW5pc2hlZCByZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCJFcnJvciB3aGlsZSByZWZyZXNoaW5nIG1lYXN1cmVcIiArIGVycik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBTZXRTaW11bGF0aW9uKHZhbHVlKSB7XHJcbiAgICBzaW11bGF0aW9uID0gdmFsdWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge3N0YXRlTWFjaGluZSwgU2VuZEFuZFJlc3BvbnNlLCBTZXRTaW11bGF0aW9ufTsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi4vY29uc3RhbnRzJyk7XHJcbnZhciBNZXRlclN0YXRlID0gcmVxdWlyZSgnLi9NZXRlclN0YXRlJyk7XHJcblxyXG4vLyBDdXJyZW50IHN0YXRlIG9mIHRoZSBibHVldG9vdGhcclxuY2xhc3MgQVBJU3RhdGUge1xyXG4gICAgY29uc3RydWN0b3IoKSB7XHJcbiAgICAgICAgdGhpcy5zdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIHRoaXMucHJldl9zdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIHRoaXMuc3RhdGVfY3B0ID0gMDtcclxuXHJcbiAgICAgICAgdGhpcy5zdGFydGVkID0gZmFsc2U7IC8vIFN0YXRlIG1hY2hpbmUgc3RhdHVzXHJcbiAgICAgICAgdGhpcy5zdG9wUmVxdWVzdCA9IGZhbHNlOyAvLyBUbyByZXF1ZXN0IGRpc2Nvbm5lY3RcclxuICAgICAgICB0aGlzLmxhc3RNZWFzdXJlID0ge307IC8vIEFycmF5IHdpdGggXCJNZWFzdXJlTmFtZVwiIDogdmFsdWVcclxuICAgICAgICB0aGlzLmxhc3RTZXRwb2ludCA9IHt9OyAvLyBBcnJheSB3aXRoIFwiU2V0cG9pbnRUeXBlXCIgOiB2YWx1ZVxyXG5cclxuICAgICAgICAvLyBzdGF0ZSBvZiBjb25uZWN0ZWQgbWV0ZXJcclxuICAgICAgICB0aGlzLm1ldGVyID0gbmV3IE1ldGVyU3RhdGUoKTtcclxuXHJcbiAgICAgICAgLy8gbGFzdCBtb2RidXMgUlRVIGNvbW1hbmRcclxuICAgICAgICB0aGlzLmNvbW1hbmQgPSBudWxsO1xyXG5cclxuICAgICAgICAvLyBsYXN0IG1vZGJ1cyBSVFUgYW5zd2VyXHJcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIGJsdWV0b290aCBwcm9wZXJ0aWVzXHJcbiAgICAgICAgdGhpcy5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICB0aGlzLmJ0RGV2aWNlID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gZ2VuZXJhbCBzdGF0aXN0aWNzIGZvciBkZWJ1Z2dpbmdcclxuICAgICAgICB0aGlzLnN0YXRzID0ge1xyXG4gICAgICAgICAgICBcInJlcXVlc3RzXCI6IDAsXHJcbiAgICAgICAgICAgIFwicmVzcG9uc2VzXCI6IDAsXHJcbiAgICAgICAgICAgIFwibW9kYnVzX2Vycm9yc1wiOiAwLFxyXG4gICAgICAgICAgICBcIkdBVFQgZGlzY29ubmVjdHNcIjogMCxcclxuICAgICAgICAgICAgXCJleGNlcHRpb25zXCI6IDAsXHJcbiAgICAgICAgICAgIFwic3ViY3JpYmVzXCI6IDAsXHJcbiAgICAgICAgICAgIFwiY29tbWFuZHNcIjogMCxcclxuICAgICAgICAgICAgXCJyZXNwb25zZVRpbWVcIjogMC4wLFxyXG4gICAgICAgICAgICBcImxhc3RSZXNwb25zZVRpbWVcIjogMC4wLFxyXG4gICAgICAgICAgICBcImxhc3RfY29ubmVjdFwiOiBuZXcgRGF0ZSgyMDIwLCAxLCAxKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdGhpcy5vcHRpb25zID0ge1xyXG4gICAgICAgICAgICBcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCIgOiB0cnVlXHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5sZXQgYnRTdGF0ZSA9IG5ldyBBUElTdGF0ZSgpO1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IEFQSVN0YXRlLCBidFN0YXRlIH0iLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi4vY29uc3RhbnRzJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJyk7XHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuXHJcbmNvbnN0IE1BWF9VX0dFTiA9IDI3LjA7IC8vIG1heGltdW0gdm9sdGFnZSBcclxuXHJcbi8qKlxyXG4gKiBDb21tYW5kIHRvIHRoZSBtZXRlciwgbWF5IGluY2x1ZGUgc2V0cG9pbnRcclxuICogKi9cclxuIGNsYXNzIENvbW1hbmQge1xyXG4gICAgLyoqXHJcbiAgICAgKiBDcmVhdGVzIGEgbmV3IGNvbW1hbmRcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGN0eXBlXHJcbiAgICAgKi9cclxuICAgIGNvbnN0cnVjdG9yKGN0eXBlID0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgdGhpcy50eXBlID0gcGFyc2VJbnQoY3R5cGUpO1xyXG4gICAgICAgIHRoaXMuc2V0cG9pbnQgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuc2V0cG9pbnQyID0gbnVsbDtcclxuICAgICAgICB0aGlzLmVycm9yID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5wZW5kaW5nID0gdHJ1ZTtcclxuICAgICAgICB0aGlzLnJlcXVlc3QgPSBudWxsO1xyXG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHN0YXRpYyBDcmVhdGVOb1NQKGN0eXBlKVxyXG4gICAge1xyXG4gICAgICAgIHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcbiAgICAgICAgcmV0dXJuIGNtZDtcclxuICAgIH1cclxuICAgIHN0YXRpYyBDcmVhdGVPbmVTUChjdHlwZSwgc2V0cG9pbnQpXHJcbiAgICB7XHJcbiAgICAgICAgdmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuICAgICAgICBjbWQuc2V0cG9pbnQgPSBwYXJzZUZsb2F0KHNldHBvaW50KTtcclxuICAgICAgICByZXR1cm4gY21kO1xyXG4gICAgfVxyXG4gICAgc3RhdGljIENyZWF0ZVR3b1NQKGN0eXBlLCBzZXQxLCBzZXQyKVxyXG4gICAge1xyXG4gICAgICAgIHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcbiAgICAgICAgY21kLnNldHBvaW50ID0gcGFyc2VGbG9hdChzZXQxKTtcclxuICAgICAgICBjbWQuc2V0cG9pbnQyID0gcGFyc2VGbG9hdChzZXQyKTs7XHJcbiAgICAgICAgcmV0dXJuIGNtZDtcclxuICAgIH1cclxuXHJcbiAgICB0b1N0cmluZygpIHtcclxuICAgICAgICByZXR1cm4gXCJUeXBlOiBcIiArIHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCB0aGlzLnR5cGUpICsgXCIsIHNldHBvaW50OlwiICsgdGhpcy5zZXRwb2ludCArIFwiLCBzZXRwb2ludDI6IFwiICsgdGhpcy5zZXRwb2ludDIgKyBcIiwgcGVuZGluZzpcIiArIHRoaXMucGVuZGluZyArIFwiLCBlcnJvcjpcIiArIHRoaXMuZXJyb3I7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBHZXRzIHRoZSBkZWZhdWx0IHNldHBvaW50IGZvciB0aGlzIGNvbW1hbmQgdHlwZVxyXG4gICAgICogQHJldHVybnMge0FycmF5fSBzZXRwb2ludChzKSBleHBlY3RlZFxyXG4gICAgICovXHJcbiAgICBkZWZhdWx0U2V0cG9pbnQoKSB7XHJcbiAgICAgICAgc3dpdGNoICh0aGlzLnR5cGUpIHtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVGVtcGVyYXR1cmUgKMKwQyknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdWb2x0YWdlIChWKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdWb2x0YWdlIChtViknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0N1cnJlbnQgKG1BKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdJbWJhbGFuY2UgKG1WL1YpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdGcmVxdWVuY3kgKEh6KSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1B1bHNlcyBjb3VudCc6IDAsICdGcmVxdWVuY3kgKEh6KSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VVGhyZXNob2xkX0Y6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVXRocmVzaG9sZCAoViknOiAyLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2Vuc2l0aXZpdHlfdVM6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnU2Vuc2liaWxpdHkgKHVTKSc6IDIuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnQ29sZCBqdW5jdGlvbiBjb21wZW5zYXRpb24nOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWxvdzpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdVIGxvdyAoViknOiAwLjAgLyBNQVhfVV9HRU4gfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWhpZ2g6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVSBoaWdoIChWKSc6IDUuMCAvIE1BWF9VX0dFTiB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0RlbGF5IChzKSc6IDYwICogNSB9O1xyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlzR2VuZXJhdGlvbigpIHtcclxuICAgICAgICByZXR1cm4gdXRpbHMuaXNHZW5lcmF0aW9uKHRoaXMudHlwZSk7XHJcbiAgICB9XHJcbiAgICBpc01lYXN1cmVtZW50KCkge1xyXG4gICAgICAgIHJldHVybiB1dGlscy5pc01lYXN1cmVtZW50KHRoaXMudHlwZSk7XHJcbiAgICB9XHJcbiAgICBpc1NldHRpbmcoKSB7XHJcbiAgICAgICAgcmV0dXJuIHV0aWxzLmlzU2V0dGluZyh0aGlzLnR5cGUpO1xyXG4gICAgfVxyXG4gICAgaXNWYWxpZCgpIHtcclxuICAgICAgICByZXR1cm4gKHV0aWxzLmlzTWVhc3VyZW1lbnQodGhpcy50eXBlKSB8fCB1dGlscy5pc0dlbmVyYXRpb24odGhpcy50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcodGhpcy50eXBlKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ29tbWFuZDsiLCJjbGFzcyBDb21tYW5kUmVzdWx0XHJcbntcclxuICAgIHZhbHVlID0gMC4wO1xyXG4gICAgc3VjY2VzcyA9IGZhbHNlO1xyXG4gICAgbWVzc2FnZSA9IFwiXCI7XHJcbiAgICB1bml0ID0gXCJcIjtcclxuICAgIHNlY29uZGFyeV92YWx1ZSA9IDAuMDtcclxuICAgIHNlY29uZGFyeV91bml0ID0gXCJcIjtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBDb21tYW5kUmVzdWx0OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuLi9jb25zdGFudHMnKTtcclxuXHJcbi8qKlxyXG4gKiBDdXJyZW50IHN0YXRlIG9mIHRoZSBtZXRlclxyXG4gKiAqL1xyXG4gY2xhc3MgTWV0ZXJTdGF0ZSB7XHJcbiAgICBjb25zdHJ1Y3RvcigpIHtcclxuICAgICAgICB0aGlzLmZpcm13YXJlID0gXCJcIjsgLy8gRmlybXdhcmUgdmVyc2lvblxyXG4gICAgICAgIHRoaXMuc2VyaWFsID0gXCJcIjsgLy8gU2VyaWFsIG51bWJlclxyXG4gICAgICAgIHRoaXMubW9kZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV047XHJcbiAgICAgICAgdGhpcy5iYXR0ZXJ5ID0gMC4wO1xyXG4gICAgfVxyXG5cclxuICAgIGlzTWVhc3VyZW1lbnQoKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLk9GRjtcclxuICAgIH1cclxuXHJcbiAgICBpc0dlbmVyYXRpb24oKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5PRkYgJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRDtcclxuICAgIH1cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBNZXRlclN0YXRlOyIsIid1c2Ugc3RyaWN0JztcclxuXHJcbi8qKlxyXG4gKiAgVGhpcyBtb2R1bGUgY29udGFpbnMgdGhlIFNlbmVjYU1TQyBvYmplY3QsIHdoaWNoIHByb3ZpZGVzIHRoZSBtYWluIG9wZXJhdGlvbnMgZm9yIGJsdWV0b290aCBtb2R1bGUuXHJcbiAqICBJdCB1c2VzIHRoZSBtb2RidXMgaGVscGVyIGZ1bmN0aW9ucyBmcm9tIHNlbmVjYU1vZGJ1cyAvIG1vZGJ1c1J0dSB0byBpbnRlcmFjdCB3aXRoIHRoZSBtZXRlciB3aXRoIFNlbmRBbmRSZXNwb25zZSBmdW5jdGlvblxyXG4gKi9cclxudmFyIGxvZyA9IHJlcXVpcmUoJ2xvZ2xldmVsJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJyk7XHJcbnZhciBzZW5lY2FNQiA9IHJlcXVpcmUoJy4uL3NlbmVjYU1vZGJ1cycpO1xyXG52YXIgbW9kYnVzID0gcmVxdWlyZSgnLi4vbW9kYnVzUnR1Jyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuLi9jb25zdGFudHMnKTtcclxuXHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxudmFyIFJlc3VsdENvZGUgPSBjb25zdGFudHMuUmVzdWx0Q29kZTtcclxuXHJcbmNvbnN0IFJFU0VUX1BPV0VSX09GRiA9IDY7XHJcbmNvbnN0IFNFVF9QT1dFUl9PRkYgPSA3O1xyXG5jb25zdCBDTEVBUl9BVkdfTUlOX01BWCA9IDU7XHJcbmNvbnN0IFBVTFNFX0NNRCA9IDk7XHJcblxyXG5jbGFzcyBTZW5lY2FNU0Ncclxue1xyXG4gICAgY29uc3RydWN0b3IoZm5TZW5kQW5kUmVzcG9uc2UpIHtcclxuICAgICAgICB0aGlzLlNlbmRBbmRSZXNwb25zZSA9IGZuU2VuZEFuZFJlc3BvbnNlO1xyXG4gICAgfVxyXG4gICAgLyoqXHJcbiAgICAgKiBHZXRzIHRoZSBtZXRlciBzZXJpYWwgbnVtYmVyICgxMjM0NV8xMjM0KVxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7c3RyaW5nfVxyXG4gICAgICovXHJcbiAgICAgYXN5bmMgZ2V0U2VyaWFsTnVtYmVyKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2VyaWFsIG51bWJlclwiKTtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlU2VyaWFsTnVtYmVyKCkpO1xyXG4gICAgICAgIHJldHVybiBzZW5lY2FNQi5wYXJzZVNlcmlhbE51bWJlcihyZXNwb25zZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBHZXRzIHRoZSBjdXJyZW50IG1vZGUgc2V0IG9uIHRoZSBNU0MgZGV2aWNlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtDb21tYW5kVHlwZX0gYWN0aXZlIG1vZGVcclxuICAgICAqL1xyXG4gICAgYXN5bmMgZ2V0Q3VycmVudE1vZGUoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBjdXJyZW50IG1vZGVcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZUN1cnJlbnRNb2RlKCkpO1xyXG4gICAgICAgIHJldHVybiBzZW5lY2FNQi5wYXJzZUN1cnJlbnRNb2RlKHJlc3BvbnNlLCBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogR2V0cyB0aGUgYmF0dGVyeSB2b2x0YWdlIGZyb20gdGhlIG1ldGVyIGZvciBiYXR0ZXJ5IGxldmVsIGluZGljYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge251bWJlcn0gdm9sdGFnZSAoVilcclxuICAgICAqL1xyXG4gICAgYXN5bmMgZ2V0QmF0dGVyeVZvbHRhZ2UoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBiYXR0ZXJ5IHZvbHRhZ2VcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZUJhdHRlcnlMZXZlbCgpKTtcclxuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZChzZW5lY2FNQi5wYXJzZUJhdHRlcnkocmVzcG9uc2UpICogMTAwKSAvIDEwMDtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENoZWNrIG1lYXN1cmVtZW50IGVycm9yIGZsYWdzIGZyb20gbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldFF1YWxpdHlWYWxpZCgpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmUgcXVhbGl0eSBiaXRcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVF1YWxpdHlCaXRSZXF1ZXN0KCkpO1xyXG4gICAgICAgIHJldHVybiBzZW5lY2FNQi5pc1F1YWxpdHlWYWxpZChyZXNwb25zZSk7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8qKlxyXG4gICAgICogQ2hlY2sgZ2VuZXJhdGlvbiBlcnJvciBmbGFncyBmcm9tIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtib29sZWFufVxyXG4gICAgICovXHJcbiAgICBhc3luYyBnZXRHZW5RdWFsaXR5VmFsaWQoY3VycmVudF9tb2RlKVxyXG4gICAge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgZ2VuZXJhdGlvbiBxdWFsaXR5IGJpdFwiKTtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlR2VuU3RhdHVzUmVhZCgpKTtcclxuICAgICAgICByZXR1cm4gc2VuZWNhTUIucGFyc2VHZW5TdGF0dXMocmVzcG9uc2UsIGN1cnJlbnRfbW9kZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBSZWFkcyB0aGUgbWVhc3VyZW1lbnRzIGZyb20gdGhlIG1ldGVyLCBpbmNsdWRpbmcgZXJyb3IgZmxhZ3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1ldGVyIG1vZGUgXHJcbiAgICAgKiBAcmV0dXJucyB7YXJyYXl8bnVsbH0gbWVhc3VyZW1lbnQgYXJyYXkgKHVuaXRzLCB2YWx1ZXMsIGVycm9yIGZsYWcpXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldE1lYXN1cmVzKG1vZGUpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmVzXCIpO1xyXG4gICAgICAgIHZhciB2YWxpZCA9IGF3YWl0IHRoaXMuZ2V0UXVhbGl0eVZhbGlkKCk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZU1lYXN1cmVSZXF1ZXN0KG1vZGUpKTtcclxuICAgICAgICBpZiAocmVzcG9uc2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICB2YXIgbWVhcyA9IHNlbmVjYU1CLnBhcnNlTWVhc3VyZShyZXNwb25zZSwgbW9kZSk7XHJcbiAgICAgICAgICAgIG1lYXNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuICAgICAgICAgICAgcmV0dXJuIG1lYXM7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUmVhZHMgdGhlIGFjdGl2ZSBzZXRwb2ludHMgZnJvbSB0aGUgbWV0ZXIsIGluY2x1ZGluZyBlcnJvciBmbGFnc1xyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGN1cnJlbnQgbWV0ZXIgbW9kZSBcclxuICAgICAqIEByZXR1cm5zIHthcnJheXxudWxsfSBzZXRwb2ludHMgYXJyYXkgKHVuaXRzLCB2YWx1ZXMsIGVycm9yIGZsYWcpXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldFNldHBvaW50cyhtb2RlKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBzZXRwb2ludHNcIik7XHJcbiAgICAgICAgdmFyIHZhbGlkID0gYXdhaXQgdGhpcy5nZXRHZW5RdWFsaXR5VmFsaWQobW9kZSk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVNldHBvaW50UmVhZChtb2RlKSk7XHJcbiAgICAgICAgaWYgKHJlc3BvbnNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdHMgPSBzZW5lY2FNQi5wYXJzZVNldHBvaW50UmVhZChyZXNwb25zZSwgbW9kZSk7XHJcbiAgICAgICAgICAgIHJlc3VsdHNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUHV0cyB0aGUgbWV0ZXIgaW4gT0ZGIG1vZGVcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIHN3aXRjaE9mZigpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIG1ldGVyIHRvIE9GRlwiKTtcclxuICAgICAgICB2YXIgcGFja2V0ID0gc2VuZWNhTUIubWFrZU1vZGVSZXF1ZXN0KENvbW1hbmRUeXBlLk9GRik7XHJcbiAgICAgICAgaWYgKHBhY2tldCA9PSBudWxsKVxyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcblxyXG4gICAgICAgIGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHBhY2tldCk7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFdyaXRlIHRoZSBzZXRwb2ludHMgdG8gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGNvbW1hbmRfdHlwZSB0eXBlIG9mIGdlbmVyYXRpb24gY29tbWFuZFxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHNldHBvaW50IG9mIGdlbmVyYXRpb25cclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludDIgZmFjdWx0YXRpdmUsIHNlY29uZCBzZXRwb2ludFxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIHdyaXRlU2V0cG9pbnRzKGNvbW1hbmRfdHlwZSwgc2V0cG9pbnQsIHNldHBvaW50Mikge1xyXG4gICAgICAgIHZhciBzdGFydEdlbjtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIGNvbW1hbmQ6XCIrIGNvbW1hbmRfdHlwZSArIFwiLCBzZXRwb2ludDogXCIgKyBzZXRwb2ludCArIFwiLCBzZXRwb2ludCAyOiBcIiArIHNldHBvaW50Mik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVNldHBvaW50UmVxdWVzdChjb21tYW5kX3R5cGUsIHNldHBvaW50LCBzZXRwb2ludDIpKTtcclxuICAgICAgICBpZiAocmVzcG9uc2UgIT0gbnVsbCAmJiAhbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9TSE9VTERfUkVUUlk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBTcGVjaWFsIGhhbmRsaW5nIG9mIHRoZSBTRVQgRGVsYXkgY29tbWFuZFxyXG4gICAgICAgIHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcbiAgICAgICAgICAgICAgICBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICAgICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENsZWFyIEF2Zy9NaW4vTWF4IHN0YXRpc3RpY3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGNsZWFyU3RhdGlzdGljcygpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZXNldHRpbmcgc3RhdGlzdGljc1wiKTtcclxuICAgICAgICB2YXIgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkNNRCwgW0NMRUFSX0FWR19NSU5fTUFYXSk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEJlZ2lucyB0aGUgcHVsc2UgZ2VuZXJhdGlvblxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgc3RhcnRQdWxzZUdlbigpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTdGFydGluZyBwdWxzZSBnZW5lcmF0aW9uXCIpO1xyXG4gICAgICAgIHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuR0VOX0NNRCwgW1BVTFNFX0NNRCwgMl0pOyAvLyBTdGFydCB3aXRoIGxvd1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAyKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBCZWdpbnMgdGhlIGZyZXF1ZW5jeSBnZW5lcmF0aW9uXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcbiAgICBhc3luYyBzdGFydEZyZXFHZW4oKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U3RhcnRpbmcgZnJlcSBnZW5cIik7XHJcbiAgICAgICAgdmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbUFVMU0VfQ01ELCAxXSk7IC8vIHN0YXJ0IGdlblxyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAyKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBEaXNhYmxlIGF1dG8gcG93ZXIgb2ZmIHRvIHRoZSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgZGlzYWJsZVBvd2VyT2ZmKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdERpc2FibGluZyBwb3dlciBvZmZcIik7XHJcbiAgICAgICAgdmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtSRVNFVF9QT1dFUl9PRkZdKTtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENoYW5nZXMgdGhlIGN1cnJlbnQgbW9kZSBvbiB0aGUgbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY29tbWFuZF90eXBlIHRoZSBuZXcgbW9kZSB0byBzZXQgdGhlIG1ldGVyIGluXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgY2hhbmdlTW9kZShjb21tYW5kX3R5cGUpXHJcbiAgICB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciBtb2RlIHRvIDpcIiArIGNvbW1hbmRfdHlwZSk7XHJcbiAgICAgICAgdmFyIHBhY2tldCA9IHNlbmVjYU1CLm1ha2VNb2RlUmVxdWVzdChjb21tYW5kX3R5cGUpO1xyXG4gICAgICAgIGlmIChwYWNrZXQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZCB0eXBlXCIsIGNvbW1hbmRfdHlwZSk7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHBhY2tldCk7XHJcblxyXG4gICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcbiAgICAgICAgICAgIGxvZy5lcnJvcihcIkNvdWxkIG5vdCBnZW5lcmF0ZSBtb2RidXMgcGFja2V0IGZvciBjb21tYW5kIHR5cGVcIiwgY29tbWFuZF90eXBlKTtcclxuICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHJcbiAgICAgICAgLy8gU29tZSBjb21tYW5kcyByZXF1aXJlIGFkZGl0aW9uYWwgY29tbWFuZCB0byBiZSBnaXZlbiB0byB3b3JrIHByb3Blcmx5LCBhZnRlciBhIHNsaWdodCBkZWxheVxyXG4gICAgICAgIHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tVjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmNsZWFyU3RhdGlzdGljcygpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuc3RhcnRQdWxzZUdlbigpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5zdGFydEZyZXFHZW4oKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKHJlc3VsdCA9PSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5kaXNhYmxlUG93ZXJPZmYoKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1NlbmVjYU1TQ307IiwiLyoqXHJcbiAqIENvbW1hbmQgdHlwZSwgYWthIG1vZGUgdmFsdWUgdG8gYmUgd3JpdHRlbiBpbnRvIE1TQyBjdXJyZW50IHN0YXRlIHJlZ2lzdGVyXHJcbiAqICovXHJcbiBjb25zdCBDb21tYW5kVHlwZSA9IHtcclxuICAgIE5PTkVfVU5LTk9XTjogMCwgLyoqKiBNRUFTVVJJTkcgRkVBVFVSRVMgQUZURVIgVEhJUyBQT0lOVCAqKioqKioqL1xyXG4gICAgbUFfcGFzc2l2ZTogMSxcclxuICAgIG1BX2FjdGl2ZTogMixcclxuICAgIFY6IDMsXHJcbiAgICBtVjogNCxcclxuICAgIFRIRVJNT19KOiA1LCAvLyBUZXJtb2NvcHBpZVxyXG4gICAgVEhFUk1PX0s6IDYsXHJcbiAgICBUSEVSTU9fVDogNyxcclxuICAgIFRIRVJNT19FOiA4LFxyXG4gICAgVEhFUk1PX0w6IDksXHJcbiAgICBUSEVSTU9fTjogMTAsXHJcbiAgICBUSEVSTU9fUjogMTEsXHJcbiAgICBUSEVSTU9fUzogMTIsXHJcbiAgICBUSEVSTU9fQjogMTMsXHJcbiAgICBQVDEwMF8yVzogMTQsIC8vIFJURCAyIGZpbGlcclxuICAgIFBUMTAwXzNXOiAxNSxcclxuICAgIFBUMTAwXzRXOiAxNixcclxuICAgIFBUNTAwXzJXOiAxNyxcclxuICAgIFBUNTAwXzNXOiAxOCxcclxuICAgIFBUNTAwXzRXOiAxOSxcclxuICAgIFBUMTAwMF8yVzogMjAsXHJcbiAgICBQVDEwMDBfM1c6IDIxLFxyXG4gICAgUFQxMDAwXzRXOiAyMixcclxuICAgIEN1NTBfMlc6IDIzLFxyXG4gICAgQ3U1MF8zVzogMjQsXHJcbiAgICBDdTUwXzRXOiAyNSxcclxuICAgIEN1MTAwXzJXOiAyNixcclxuICAgIEN1MTAwXzNXOiAyNyxcclxuICAgIEN1MTAwXzRXOiAyOCxcclxuICAgIE5pMTAwXzJXOiAyOSxcclxuICAgIE5pMTAwXzNXOiAzMCxcclxuICAgIE5pMTAwXzRXOiAzMSxcclxuICAgIE5pMTIwXzJXOiAzMixcclxuICAgIE5pMTIwXzNXOiAzMyxcclxuICAgIE5pMTIwXzRXOiAzNCxcclxuICAgIExvYWRDZWxsOiAzNSwgICAvLyBDZWxsZSBkaSBjYXJpY29cclxuICAgIEZyZXF1ZW5jeTogMzYsICAvLyBGcmVxdWVuemFcclxuICAgIFB1bHNlVHJhaW46IDM3LCAvLyBDb250ZWdnaW8gaW1wdWxzaVxyXG4gICAgUkVTRVJWRUQ6IDM4LFxyXG4gICAgUkVTRVJWRURfMjogNDAsXHJcbiAgICBPRkY6IDEwMCwgLy8gKioqKioqKioqIEdFTkVSQVRJT04gQUZURVIgVEhJUyBQT0lOVCAqKioqKioqKioqKioqKioqKi9cclxuICAgIEdFTl9tQV9wYXNzaXZlOiAxMDEsXHJcbiAgICBHRU5fbUFfYWN0aXZlOiAxMDIsXHJcbiAgICBHRU5fVjogMTAzLFxyXG4gICAgR0VOX21WOiAxMDQsXHJcbiAgICBHRU5fVEhFUk1PX0o6IDEwNSxcclxuICAgIEdFTl9USEVSTU9fSzogMTA2LFxyXG4gICAgR0VOX1RIRVJNT19UOiAxMDcsXHJcbiAgICBHRU5fVEhFUk1PX0U6IDEwOCxcclxuICAgIEdFTl9USEVSTU9fTDogMTA5LFxyXG4gICAgR0VOX1RIRVJNT19OOiAxMTAsXHJcbiAgICBHRU5fVEhFUk1PX1I6IDExMSxcclxuICAgIEdFTl9USEVSTU9fUzogMTEyLFxyXG4gICAgR0VOX1RIRVJNT19COiAxMTMsXHJcbiAgICBHRU5fUFQxMDBfMlc6IDExNCxcclxuICAgIEdFTl9QVDUwMF8yVzogMTE3LFxyXG4gICAgR0VOX1BUMTAwMF8yVzogMTIwLFxyXG4gICAgR0VOX0N1NTBfMlc6IDEyMyxcclxuICAgIEdFTl9DdTEwMF8yVzogMTI2LFxyXG4gICAgR0VOX05pMTAwXzJXOiAxMjksXHJcbiAgICBHRU5fTmkxMjBfMlc6IDEzMixcclxuICAgIEdFTl9Mb2FkQ2VsbDogMTM1LFxyXG4gICAgR0VOX0ZyZXF1ZW5jeTogMTM2LFxyXG4gICAgR0VOX1B1bHNlVHJhaW46IDEzNyxcclxuICAgIEdFTl9SRVNFUlZFRDogMTM4LFxyXG4gICAgLy8gU3BlY2lhbCBzZXR0aW5ncyBiZWxvdyB0aGlzIHBvaW50c1xyXG4gICAgU0VUVElOR19SRVNFUlZFRDogMTAwMCxcclxuICAgIFNFVF9VVGhyZXNob2xkX0Y6IDEwMDEsXHJcbiAgICBTRVRfU2Vuc2l0aXZpdHlfdVM6IDEwMDIsXHJcbiAgICBTRVRfQ29sZEp1bmN0aW9uOiAxMDAzLFxyXG4gICAgU0VUX1Vsb3c6IDEwMDQsXHJcbiAgICBTRVRfVWhpZ2g6IDEwMDUsXHJcbiAgICBTRVRfU2h1dGRvd25EZWxheTogMTAwNlxyXG59O1xyXG5cclxuXHJcblxyXG5cclxuLypcclxuICogSW50ZXJuYWwgc3RhdGUgbWFjaGluZSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmNvbnN0IFN0YXRlID0ge1xyXG4gICAgTk9UX0NPTk5FQ1RFRDogJ05vdCBjb25uZWN0ZWQnLFxyXG4gICAgQ09OTkVDVElORzogJ0JsdWV0b290aCBkZXZpY2UgcGFpcmluZy4uLicsXHJcbiAgICBERVZJQ0VfUEFJUkVEOiAnRGV2aWNlIHBhaXJlZCcsXHJcbiAgICBTVUJTQ1JJQklORzogJ0JsdWV0b290aCBpbnRlcmZhY2VzIGNvbm5lY3RpbmcuLi4nLFxyXG4gICAgSURMRTogJ0lkbGUnLFxyXG4gICAgQlVTWTogJ0J1c3knLFxyXG4gICAgRVJST1I6ICdFcnJvcicsXHJcbiAgICBTVE9QUElORzogJ0Nsb3NpbmcgQlQgaW50ZXJmYWNlcy4uLicsXHJcbiAgICBTVE9QUEVEOiAnU3RvcHBlZCcsXHJcbiAgICBNRVRFUl9JTklUOiAnTWV0ZXIgY29ubmVjdGVkJyxcclxuICAgIE1FVEVSX0lOSVRJQUxJWklORzogJ1JlYWRpbmcgbWV0ZXIgc3RhdGUuLi4nXHJcbn07XHJcblxyXG5jb25zdCBSZXN1bHRDb2RlID0ge1xyXG4gICAgRkFJTEVEX05PX1JFVFJZOiAxLFxyXG4gICAgRkFJTEVEX1NIT1VMRF9SRVRSWTogMixcclxuICAgIFNVQ0NFU1M6IDBcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7U3RhdGUsIENvbW1hbmRUeXBlLCBSZXN1bHRDb2RlIH0iLCIndXNlIHN0cmljdCc7XHJcblxyXG5jb25zdCBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbmNvbnN0IGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbmNvbnN0IEFQSVN0YXRlID0gcmVxdWlyZSgnLi9jbGFzc2VzL0FQSVN0YXRlJyk7XHJcbmNvbnN0IENvbW1hbmQgPSByZXF1aXJlKCcuL2NsYXNzZXMvQ29tbWFuZCcpO1xyXG5jb25zdCBQdWJsaWNBUEkgPXJlcXVpcmUoJy4vbWV0ZXJQdWJsaWNBUEknKTtcclxuY29uc3QgVGVzdERhdGEgPXJlcXVpcmUoJy4vbW9kYnVzVGVzdERhdGEnKTtcclxuXHJcbmxvZy5zZXRMZXZlbChsb2cubGV2ZWxzLkVSUk9SLCB0cnVlKTtcclxuXHJcbmV4cG9ydHMuU3RvcCA9IFB1YmxpY0FQSS5TdG9wO1xyXG5leHBvcnRzLlBhaXIgPSBQdWJsaWNBUEkuUGFpcjtcclxuZXhwb3J0cy5FeGVjdXRlID0gUHVibGljQVBJLkV4ZWN1dGU7XHJcbmV4cG9ydHMuU2ltcGxlRXhlY3V0ZSA9IFB1YmxpY0FQSS5TaW1wbGVFeGVjdXRlO1xyXG5leHBvcnRzLkdldFN0YXRlID0gUHVibGljQVBJLkdldFN0YXRlO1xyXG5leHBvcnRzLlN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG5leHBvcnRzLkNvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5leHBvcnRzLkNvbW1hbmQgPSBDb21tYW5kO1xyXG5leHBvcnRzLlBhcnNlID0gUHVibGljQVBJLlBhcnNlO1xyXG5leHBvcnRzLmxvZyA9IGxvZztcclxuZXhwb3J0cy5HZXRTdGF0ZUpTT04gPSBQdWJsaWNBUEkuR2V0U3RhdGVKU09OO1xyXG5leHBvcnRzLkV4ZWN1dGVKU09OID0gUHVibGljQVBJLkV4ZWN1dGVKU09OO1xyXG5leHBvcnRzLlNpbXBsZUV4ZWN1dGVKU09OID0gUHVibGljQVBJLlNpbXBsZUV4ZWN1dGVKU09OO1xyXG5leHBvcnRzLkdldEpzb25UcmFjZXMgPSBUZXN0RGF0YS5HZXRKc29uVHJhY2VzO1xyXG5cclxuIiwiLypcclxuICogVGhpcyBmaWxlIGNvbnRhaW5zIHRoZSBwdWJsaWMgQVBJIG9mIHRoZSBtZXRlciwgaS5lLiB0aGUgZnVuY3Rpb25zIGRlc2lnbmVkXHJcbiAqIHRvIGJlIGNhbGxlZCBmcm9tIHRoaXJkIHBhcnR5IGNvZGUuXHJcbiAqIDEtIFBhaXIoKSA6IGJvb2xcclxuICogMi0gRXhlY3V0ZShDb21tYW5kKSA6IGJvb2wgKyBKU09OIHZlcnNpb25cclxuICogMy0gU3RvcCgpIDogYm9vbFxyXG4gKiA0LSBHZXRTdGF0ZSgpIDogYXJyYXkgKyBKU09OIHZlcnNpb25cclxuICogNS0gU2ltcGxlRXhlY3V0ZShDb21tYW5kKSA6IHJldHVybnMgdGhlIHVwZGF0ZWQgbWVhc3VyZW1lbnQgb3IgbnVsbFxyXG4gKi9cclxuXHJcbnZhciBDb21tYW5kUmVzdWx0ID0gcmVxdWlyZSgnLi9jbGFzc2VzL0NvbW1hbmRSZXN1bHQnKTtcclxudmFyIEFQSVN0YXRlID0gcmVxdWlyZSgnLi9jbGFzc2VzL0FQSVN0YXRlJyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgYmx1ZXRvb3RoID0gcmVxdWlyZSgnLi9ibHVldG9vdGgnKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xyXG52YXIgbG9nID0gcmVxdWlyZSgnbG9nbGV2ZWwnKTtcclxudmFyIG1ldGVyQXBpID0gcmVxdWlyZSgnLi9tZXRlckFwaScpO1xyXG5cclxudmFyIGJ0U3RhdGUgPSBBUElTdGF0ZS5idFN0YXRlO1xyXG52YXIgU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGNvcHkgb2YgdGhlIGN1cnJlbnQgc3RhdGVcclxuICogQHJldHVybnMge2FycmF5fSBzdGF0dXMgb2YgbWV0ZXJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEdldFN0YXRlKCkge1xyXG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XHJcbiAgICBsZXQgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcbiAgICBzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuICAgICAgICAvLyBTdGF0ZXMgcmVxdWlyaW5nIHVzZXIgaW5wdXRcclxuICAgICAgICBjYXNlIFN0YXRlLkVSUk9SOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBFRDpcclxuICAgICAgICBjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6XHJcbiAgICAgICAgICAgIHJlYWR5ID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkJVU1k6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5JRExFOlxyXG4gICAgICAgICAgICByZWFkeSA9IHRydWU7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkNPTk5FQ1RJTkc6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVDpcclxuICAgICAgICBjYXNlIFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORzpcclxuICAgICAgICBjYXNlIFN0YXRlLlNVQlNDUklCSU5HOlxyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSB0cnVlO1xyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgXCJsYXN0U2V0cG9pbnRcIjogYnRTdGF0ZS5sYXN0U2V0cG9pbnQsXHJcbiAgICAgICAgXCJsYXN0TWVhc3VyZVwiOiBidFN0YXRlLmxhc3RNZWFzdXJlLFxyXG4gICAgICAgIFwiZGV2aWNlTmFtZVwiOiBidFN0YXRlLmJ0RGV2aWNlID8gYnRTdGF0ZS5idERldmljZS5uYW1lIDogXCJcIixcclxuICAgICAgICBcImRldmljZVNlcmlhbFwiOiBidFN0YXRlLm1ldGVyPy5zZXJpYWwsXHJcbiAgICAgICAgXCJzdGF0c1wiOiBidFN0YXRlLnN0YXRzLFxyXG4gICAgICAgIFwiZGV2aWNlTW9kZVwiOiBidFN0YXRlLm1ldGVyPy5tb2RlLFxyXG4gICAgICAgIFwic3RhdHVzXCI6IGJ0U3RhdGUuc3RhdGUsXHJcbiAgICAgICAgXCJiYXR0ZXJ5TGV2ZWxcIjogYnRTdGF0ZS5tZXRlcj8uYmF0dGVyeSxcclxuICAgICAgICBcInJlYWR5XCI6IHJlYWR5LFxyXG4gICAgICAgIFwiaW5pdGlhbGl6aW5nXCI6IGluaXRpYWxpemluZ1xyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFByb3ZpZGVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggQmxhem9yXHJcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEpTT04gc3RhdGUgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBHZXRTdGF0ZUpTT04oKSB7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgR2V0U3RhdGUoKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGNvbW1hbmQgd2l0aCBzZXRwb2ludHMsIEpTT04gdmVyc2lvblxyXG4gKiBAcGFyYW0ge3N0cmluZ30ganNvbkNvbW1hbmQgdGhlIGNvbW1hbmQgdG8gZXhlY3V0ZVxyXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBKU09OIGNvbW1hbmQgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlSlNPTihqc29uQ29tbWFuZCkge1xyXG4gICAgbGV0IGNvbW1hbmQgPSBKU09OLnBhcnNlKGpzb25Db21tYW5kKTtcclxuICAgIC8vIGRlc2VyaWFsaXplZCBvYmplY3QgaGFzIGxvc3QgaXRzIG1ldGhvZHMsIGxldCdzIHJlY3JlYXRlIGEgY29tcGxldGUgb25lLlxyXG4gICAgbGV0IGNvbW1hbmQyID1tZXRlckFwaS5Db21tYW5kLkNyZWF0ZVR3b1NQKGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpO1xyXG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IEV4ZWN1dGUoY29tbWFuZDIpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZUpTT04oanNvbkNvbW1hbmQpIHtcclxuICAgIGxldCBjb21tYW5kID0gSlNPTi5wYXJzZShqc29uQ29tbWFuZCk7XHJcbiAgICAvLyBkZXNlcmlhbGl6ZWQgb2JqZWN0IGhhcyBsb3N0IGl0cyBtZXRob2RzLCBsZXQncyByZWNyZWF0ZSBhIGNvbXBsZXRlIG9uZS5cclxuICAgIGxldCBjb21tYW5kMiA9IG1ldGVyQXBpLkNvbW1hbmQuQ3JlYXRlVHdvU1AoY29tbWFuZC50eXBlLCBjb21tYW5kLnNldHBvaW50LCBjb21tYW5kLnNldHBvaW50Mik7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgU2ltcGxlRXhlY3V0ZShjb21tYW5kMikpO1xyXG59XHJcblxyXG4vKipcclxuICogRXhlY3V0ZSBhIGNvbW1hbmQgYW5kIHJldHVybnMgdGhlIG1lYXN1cmVtZW50IG9yIHNldHBvaW50IHdpdGggZXJyb3IgZmxhZyBhbmQgbWVzc2FnZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbiBhc3luYyBmdW5jdGlvbiBTaW1wbGVFeGVjdXRlKGNvbW1hbmQpIHtcclxuICAgIGNvbnN0IFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyA9IDU7XHJcbiAgICB2YXIgY3IgPSBuZXcgQ29tbWFuZFJlc3VsdCgpO1xyXG5cclxuICAgIGxvZy5pbmZvKFwiU2ltcGxlRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgPT0gbnVsbClcclxuICAgIHtcclxuICAgICAgICBjci5zdWNjZXNzID0gZmFsc2U7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiSW52YWxpZCBjb21tYW5kXCI7XHJcbiAgICAgICAgcmV0dXJuIGNyO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbW1hbmQucGVuZGluZyA9IHRydWU7IC8vIEluIGNhc2UgY2FsbGVyIGRvZXMgbm90IHNldCBwZW5kaW5nIGZsYWdcclxuXHJcbiAgICAvLyBGYWlsIGltbWVkaWF0ZWx5IGlmIG5vdCBwYWlyZWQuXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuICAgICAgICBjci5tZXNzYWdlID0gXCJEZXZpY2UgaXMgbm90IHBhaXJlZFwiO1xyXG4gICAgICAgIGxvZy53YXJuKGNyLm1lc3NhZ2UpO1xyXG4gICAgICAgIHJldHVybiBjcjtcclxuICAgIH1cclxuXHJcbiAgICAvLyBBbm90aGVyIGNvbW1hbmQgbWF5IGJlIHBlbmRpbmcuXHJcbiAgICBpZiAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcpIHtcclxuICAgICAgICBjci5zdWNjZXNzID0gZmFsc2U7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiQW5vdGhlciBjb21tYW5kIGlzIHBlbmRpbmdcIjtcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDsgXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMud2FpdEZvclRpbWVvdXQoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQsIFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2hlY2sgaWYgZXJyb3Igb3IgdGltZW91dHNcclxuICAgIGlmIChjb21tYW5kLmVycm9yIHx8IGNvbW1hbmQucGVuZGluZykgIFxyXG4gICAge1xyXG4gICAgICAgIGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuICAgICAgICBjci5tZXNzYWdlID0gXCJFcnJvciB3aGlsZSBleGVjdXRpbmcgdGhlIGNvbW1hbmQuXCJcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICBcclxuICAgICAgICAvLyBSZXNldCB0aGUgYWN0aXZlIGNvbW1hbmRcclxuICAgICAgICBidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG4gICAgICAgIHJldHVybiBjcjtcclxuICAgIH1cclxuXHJcbiAgICAvLyBTdGF0ZSBpcyB1cGRhdGVkIGJ5IGV4ZWN1dGUgY29tbWFuZCwgc28gd2UgY2FuIHVzZSBidFN0YXRlIHJpZ2h0IGF3YXlcclxuICAgIGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSlcclxuICAgIHtcclxuICAgICAgICBjci52YWx1ZSA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVmFsdWVcIl07XHJcbiAgICAgICAgY3IudW5pdCA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVW5pdFwiXTtcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKHV0aWxzLmlzTWVhc3VyZW1lbnQoY29tbWFuZC50eXBlKSlcclxuICAgIHtcclxuICAgICAgICBjci52YWx1ZSA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJWYWx1ZVwiXTtcclxuICAgICAgICBjci51bml0ID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlVuaXRcIl07XHJcbiAgICAgICAgY3Iuc2Vjb25kYXJ5X3ZhbHVlID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlNlY29uZGFyeVZhbHVlXCJdO1xyXG4gICAgICAgIGNyLnNlY29uZGFyeV91bml0ID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlNlY29uZGFyeVVuaXRcIl07XHJcbiAgICB9XHJcbiAgICBlbHNlXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSAwLjA7IC8vIFNldHRpbmdzIGNvbW1hbmRzO1xyXG4gICAgfVxyXG5cclxuICAgIGNyLnN1Y2Nlc3MgPSB0cnVlO1xyXG4gICAgY3IubWVzc2FnZSA9IFwiQ29tbWFuZCBleGVjdXRlZCBzdWNjZXNzZnVsbHlcIjtcclxuICAgIHJldHVybiBjcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4dGVybmFsIGludGVyZmFjZSB0byByZXF1aXJlIGEgY29tbWFuZCB0byBiZSBleGVjdXRlZC5cclxuICogVGhlIGJsdWV0b290aCBkZXZpY2UgcGFpcmluZyB3aW5kb3cgd2lsbCBvcGVuIGlmIGRldmljZSBpcyBub3QgY29ubmVjdGVkLlxyXG4gKiBUaGlzIG1heSBmYWlsIGlmIGNhbGxlZCBvdXRzaWRlIGEgdXNlciBnZXN0dXJlLlxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEV4ZWN1dGUoY29tbWFuZCkge1xyXG4gICAgbG9nLmluZm8oXCJFeGVjdXRlIGNhbGxlZC4uLlwiKTtcclxuXHJcbiAgICBpZiAoY29tbWFuZCA9PSBudWxsKVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIFxyXG4gICAgY29tbWFuZC5wZW5kaW5nID0gdHJ1ZTtcclxuXHJcbiAgICB2YXIgY3B0ID0gMDtcclxuICAgIHdoaWxlIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbCAmJiBidFN0YXRlLmNvbW1hbmQucGVuZGluZyAmJiBjcHQgPCAzMDApIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJXYWl0aW5nIGZvciBjdXJyZW50IGNvbW1hbmQgdG8gY29tcGxldGUuLi5cIik7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuICAgICAgICBjcHQrKztcclxuICAgIH1cclxuICAgIFxyXG4gICAgbG9nLmluZm8oXCJTZXR0aW5nIG5ldyBjb21tYW5kIDpcIiArIGNvbW1hbmQpO1xyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDtcclxuXHJcbiAgICAvLyBTdGFydCB0aGUgcmVndWxhciBzdGF0ZSBtYWNoaW5lXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIGF3YWl0IGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBXYWl0IGZvciBjb21wbGV0aW9uIG9mIHRoZSBjb21tYW5kLCBvciBoYWx0IG9mIHRoZSBzdGF0ZSBtYWNoaW5lXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiAhY29tbWFuZC5wZW5kaW5nIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8vIFJldHVybiB0aGUgY29tbWFuZCBvYmplY3QgcmVzdWx0XHJcbiAgICByZXR1cm4gY29tbWFuZDtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1VU1QgQkUgQ0FMTEVEIEZST00gQSBVU0VSIEdFU1RVUkUgRVZFTlQgSEFORExFUlxyXG4gICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgbWV0ZXIgaXMgcmVhZHkgdG8gZXhlY3V0ZSBjb21tYW5kXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIFBhaXIoZm9yY2VTZWxlY3Rpb249ZmFsc2UpIHtcclxuICAgIGxvZy5pbmZvKFwiUGFpcihcIitmb3JjZVNlbGVjdGlvbitcIikgY2FsbGVkLi4uXCIpO1xyXG4gICAgXHJcbiAgICBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXSA9IGZvcmNlU2VsZWN0aW9uO1xyXG5cclxuICAgIGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7XHJcbiAgICAgICAgYmx1ZXRvb3RoLnN0YXRlTWFjaGluZSgpOyAvLyBTdGFydCBpdFxyXG4gICAgfVxyXG4gICAgZWxzZSBpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5FUlJPUikge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEOyAvLyBUcnkgdG8gcmVzdGFydFxyXG4gICAgfVxyXG4gICAgYXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiBidFN0YXRlLnN0YXRlID09IFN0YXRlLklETEUgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVEKTtcclxuICAgIGxvZy5pbmZvKFwiUGFpcmluZyBjb21wbGV0ZWQsIHN0YXRlIDpcIiwgYnRTdGF0ZS5zdGF0ZSk7XHJcbiAgICByZXR1cm4gKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBTdG9wcyB0aGUgc3RhdGUgbWFjaGluZSBhbmQgZGlzY29ubmVjdHMgYmx1ZXRvb3RoLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBTdG9wKCkge1xyXG4gICAgbG9nLmluZm8oXCJTdG9wIHJlcXVlc3QgcmVjZWl2ZWRcIik7XHJcblxyXG4gICAgYnRTdGF0ZS5zdG9wUmVxdWVzdCA9IHRydWU7XHJcbiAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cclxuICAgIHdoaWxlKGJ0U3RhdGUuc3RhcnRlZCB8fCAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEICYmIGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuTk9UX0NPTk5FQ1RFRCkpXHJcbiAgICB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdG9wUmVxdWVzdCA9IHRydWU7ICAgIFxyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcbiAgICB9XHJcbiAgICBidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG4gICAgYnRTdGF0ZS5zdG9wUmVxdWVzdCA9IGZhbHNlO1xyXG4gICAgbG9nLndhcm4oXCJTdG9wcGVkIG9uIHJlcXVlc3QuXCIpO1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1N0b3AsUGFpcixFeGVjdXRlLEV4ZWN1dGVKU09OLFNpbXBsZUV4ZWN1dGUsU2ltcGxlRXhlY3V0ZUpTT04sR2V0U3RhdGUsR2V0U3RhdGVKU09OfSIsIid1c2Ugc3RyaWN0JztcclxuXHJcbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgUlRVIGhhbmRsaW5nICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqL1xyXG5cclxudmFyIGxvZyA9IHJlcXVpcmUoJ2xvZ2xldmVsJyk7XHJcblxyXG5jb25zdCBTRU5FQ0FfTUJfU0xBVkVfSUQgPSAyNTsgLy8gTW9kYnVzIFJUVSBzbGF2ZSBJRFxyXG5cclxuY2xhc3MgTW9kYnVzRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgICAvKipcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgbW9kYnVzIGVycm9yXHJcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gbWVzc2FnZSBtZXNzYWdlXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gZmMgZnVuY3Rpb24gY29kZVxyXG4gICAgICovXHJcbiAgICBjb250cnVjdG9yKG1lc3NhZ2UsIGZjKSB7XHJcbiAgICAgICAgdGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcclxuICAgICAgICB0aGlzLmZjID0gZmM7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIHRoZSA0IGJ5dGVzIENSQyBjb2RlIGZyb20gdGhlIGJ1ZmZlciBjb250ZW50c1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGNyYzE2KGJ1ZmZlcikge1xyXG4gICAgdmFyIGNyYyA9IDB4RkZGRjtcclxuICAgIHZhciBvZGQ7XHJcblxyXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBidWZmZXIubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBjcmMgPSBjcmMgXiBidWZmZXJbaV07XHJcblxyXG4gICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgODsgaisrKSB7XHJcbiAgICAgICAgICAgIG9kZCA9IGNyYyAmIDB4MDAwMTtcclxuICAgICAgICAgICAgY3JjID0gY3JjID4+IDE7XHJcbiAgICAgICAgICAgIGlmIChvZGQpIHtcclxuICAgICAgICAgICAgICAgIGNyYyA9IGNyYyBeIDB4QTAwMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gY3JjO1xyXG59XHJcblxyXG4vKipcclxuICogTWFrZSBhIE1vZGJ1cyBSZWFkIEhvbGRpbmcgUmVnaXN0ZXJzIChGQz0wMykgdG8gc2VyaWFsIHBvcnRcclxuICogXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBJRCBzbGF2ZSBJRFxyXG4gKiBAcGFyYW0ge251bWJlcn0gY291bnQgbnVtYmVyIG9mIHJlZ2lzdGVycyB0byByZWFkXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSByZWdpc3RlciBzdGFydGluZyByZWdpc3RlclxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMyhJRCwgY291bnQsIHJlZ2lzdGVyKSB7XHJcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoOCk7XHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KGJ1ZmZlcik7XHJcbiAgICB2aWV3LnNldFVpbnQ4KDAsIElEKTtcclxuICAgIHZpZXcuc2V0VWludDgoMSwgMyk7XHJcbiAgICB2aWV3LnNldFVpbnQxNigyLCByZWdpc3RlciwgZmFsc2UpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoNCwgY291bnQsIGZhbHNlKTtcclxuICAgIHZhciBjcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShidWZmZXIuc2xpY2UoMCwgLTIpKSk7XHJcbiAgICB2aWV3LnNldFVpbnQxNig2LCBjcmMsIHRydWUpO1xyXG4gICAgcmV0dXJuIGJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdyaXRlIGEgTW9kYnVzIFwiUHJlc2V0IE11bHRpcGxlIFJlZ2lzdGVyc1wiIChGQz0xNikgdG8gc2VyaWFsIHBvcnQuXHJcbiAqXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBhZGRyZXNzIHRoZSBzbGF2ZSB1bml0IGFkZHJlc3MuXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBkYXRhQWRkcmVzcyB0aGUgRGF0YSBBZGRyZXNzIG9mIHRoZSBmaXJzdCByZWdpc3Rlci5cclxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgdGhlIGFycmF5IG9mIHZhbHVlcyB0byB3cml0ZSB0byByZWdpc3RlcnMuXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlRkMxNihhZGRyZXNzLCBkYXRhQWRkcmVzcywgYXJyYXkpIHtcclxuICAgIGNvbnN0IGNvZGUgPSAxNjtcclxuXHJcbiAgICAvLyBzYW5pdHkgY2hlY2tcclxuICAgIGlmICh0eXBlb2YgYWRkcmVzcyA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0eXBlb2YgZGF0YUFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGRhdGFMZW5ndGggPSBhcnJheS5sZW5ndGg7XHJcblxyXG4gICAgY29uc3QgY29kZUxlbmd0aCA9IDcgKyAyICogZGF0YUxlbmd0aDtcclxuICAgIGNvbnN0IGJ1ZiA9IG5ldyBBcnJheUJ1ZmZlcihjb2RlTGVuZ3RoICsgMik7IC8vIGFkZCAyIGNyYyBieXRlc1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmKTtcclxuXHJcbiAgICBkdi5zZXRVaW50OCgwLCBhZGRyZXNzKTtcclxuICAgIGR2LnNldFVpbnQ4KDEsIGNvZGUpO1xyXG4gICAgZHYuc2V0VWludDE2KDIsIGRhdGFBZGRyZXNzLCBmYWxzZSk7XHJcbiAgICBkdi5zZXRVaW50MTYoNCwgZGF0YUxlbmd0aCwgZmFsc2UpO1xyXG4gICAgZHYuc2V0VWludDgoNiwgZGF0YUxlbmd0aCAqIDIpO1xyXG5cclxuICAgIC8vIGNvcHkgY29udGVudCBvZiBhcnJheSB0byBidWZcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YUxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgZHYuc2V0VWludDE2KDcgKyAyICogaSwgYXJyYXlbaV0sIGZhbHNlKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBhZGQgY3JjIGJ5dGVzIHRvIGJ1ZmZlclxyXG4gICAgZHYuc2V0VWludDE2KGNvZGVMZW5ndGgsIGNyYzE2KGJ1Zi5zbGljZSgwLCAtMikpLCB0cnVlKTtcclxuICAgIHJldHVybiBidWY7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIHRoZSByZWdpc3RlcnMgdmFsdWVzIGZyb20gYSBGQzAzIGFuc3dlciBieSBSVFUgc2xhdmVcclxuICogXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMyhyZXNwb25zZSkge1xyXG4gICAgaWYgKCEocmVzcG9uc2UgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocmVzcG9uc2UpO1xyXG4gICAgdmFyIGNvbnRlbnRzID0gW107XHJcblxyXG4gICAgLy8gSW52YWxpZCBtb2RidXMgcGFja2V0XHJcbiAgICBpZiAocmVzcG9uc2UubGVuZ3RoIDwgNSlcclxuICAgICAgICByZXR1cm47XHJcblxyXG4gICAgdmFyIGNvbXB1dGVkX2NyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KHJlc3BvbnNlLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmFyIGFjdHVhbF9jcmMgPSB2aWV3LmdldFVpbnQxNih2aWV3LmJ5dGVMZW5ndGggLSAyLCB0cnVlKTtcclxuXHJcbiAgICBpZiAoY29tcHV0ZWRfY3JjICE9IGFjdHVhbF9jcmMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBDUkMgKGV4cGVjdGVkOlwiICsgY29tcHV0ZWRfY3JjICsgXCIsZ290OlwiICsgYWN0dWFsX2NyYyArIFwiKVwiLCAzKTtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgYWRkcmVzcyA9IHZpZXcuZ2V0VWludDgoMCk7XHJcbiAgICBpZiAoYWRkcmVzcyAhPSBTRU5FQ0FfTUJfU0xBVkVfSUQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBzbGF2ZSBJRCA6XCIgKyBhZGRyZXNzLCAzKTtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgZmMgPSB2aWV3LmdldFVpbnQ4KDEpO1xyXG4gICAgaWYgKGZjID4gMTI4KSB7XHJcbiAgICAgICAgdmFyIGV4cCA9IHZpZXcuZ2V0VWludDgoMik7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiRXhjZXB0aW9uIGJ5IHNsYXZlOlwiICsgZXhwLCAzKTtcclxuICAgIH1cclxuICAgIGlmIChmYyAhPSAzKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgRkMgOlwiICsgZmMsIGZjKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBMZW5ndGggaW4gYnl0ZXMgZnJvbSBzbGF2ZSBhbnN3ZXJcclxuICAgIHZhciBsZW5ndGggPSB2aWV3LmdldFVpbnQ4KDIpO1xyXG5cclxuICAgIGNvbnN0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcihsZW5ndGgpO1xyXG4gICAgY29uc3QgcmVnaXN0ZXJzID0gbmV3IERhdGFWaWV3KGJ1ZmZlcik7XHJcblxyXG4gICAgZm9yICh2YXIgaSA9IDM7IGkgPCB2aWV3LmJ5dGVMZW5ndGggLSAyOyBpICs9IDIpIHtcclxuICAgICAgICB2YXIgcmVnID0gdmlldy5nZXRJbnQxNihpLCBmYWxzZSk7XHJcbiAgICAgICAgcmVnaXN0ZXJzLnNldEludDE2KGkgLSAzLCByZWcsIGZhbHNlKTtcclxuICAgICAgICB2YXIgaWR4ID0gKChpIC0gMykgLyAyICsgMSk7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVnaXN0ZXIgXCIgKyBpZHggKyBcIi9cIiArIChsZW5ndGggLyAyKSArIFwiID0gXCIgKyByZWcpO1xyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiByZWdpc3RlcnM7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVjayBpZiB0aGUgRkMxNiByZXNwb25zZSBpcyBjb3JyZWN0IChDUkMsIHJldHVybiBjb2RlKSBBTkQgb3B0aW9uYWxseSBtYXRjaGluZyB0aGUgcmVnaXN0ZXIgbGVuZ3RoIGV4cGVjdGVkXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlIG1vZGJ1cyBydHUgcmF3IG91dHB1dFxyXG4gKiBAcGFyYW0ge251bWJlcn0gZXhwZWN0ZWQgbnVtYmVyIG9mIGV4cGVjdGVkIHdyaXR0ZW4gcmVnaXN0ZXJzIGZyb20gc2xhdmUuIElmIDw9MCwgaXQgd2lsbCBub3QgYmUgY2hlY2tlZC5cclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgYWxsIHJlZ2lzdGVycyBoYXZlIGJlZW4gd3JpdHRlblxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgZXhwZWN0ZWQpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcGFyc2VGQzE2KHJlc3BvbnNlKTtcclxuICAgICAgICByZXR1cm4gKGV4cGVjdGVkIDw9IDAgfHwgcmVzdWx0WzFdID09PSBleHBlY3RlZCk7IC8vIGNoZWNrIGlmIGxlbmd0aCBpcyBtYXRjaGluZ1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy5lcnJvcihcIkZDMTYgYW5zd2VyIGVycm9yXCIsIGVycik7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIGFuc3dlciB0byB0aGUgd3JpdGUgbXVsdGlwbGUgcmVnaXN0ZXJzIGZyb20gdGhlIHNsYXZlXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlc3BvbnNlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMTYocmVzcG9uc2UpIHtcclxuICAgIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocmVzcG9uc2UpO1xyXG4gICAgdmFyIGNvbnRlbnRzID0gW107XHJcblxyXG4gICAgaWYgKHJlc3BvbnNlLmxlbmd0aCA8IDMpXHJcbiAgICAgICAgcmV0dXJuO1xyXG5cclxuICAgIHZhciBzbGF2ZSA9IHZpZXcuZ2V0VWludDgoMCk7XHJcblxyXG4gICAgaWYgKHNsYXZlICE9IFNFTkVDQV9NQl9TTEFWRV9JRCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgZmMgPSB2aWV3LmdldFVpbnQ4KDEpO1xyXG4gICAgaWYgKGZjID4gMTI4KSB7XHJcbiAgICAgICAgdmFyIGV4cCA9IHZpZXcuZ2V0VWludDgoMik7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiRXhjZXB0aW9uIDpcIiArIGV4cCwgMTYpO1xyXG4gICAgfVxyXG4gICAgaWYgKGZjICE9IDE2KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgRkMgOlwiICsgZmMsIGZjKTtcclxuICAgIH1cclxuICAgIHZhciBjb21wdXRlZF9jcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShyZXNwb25zZS5zbGljZSgwLCAtMikpKTtcclxuICAgIHZhciBhY3R1YWxfY3JjID0gdmlldy5nZXRVaW50MTYodmlldy5ieXRlTGVuZ3RoIC0gMiwgdHJ1ZSk7XHJcblxyXG4gICAgaWYgKGNvbXB1dGVkX2NyYyAhPSBhY3R1YWxfY3JjKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgQ1JDIChleHBlY3RlZDpcIiArIGNvbXB1dGVkX2NyYyArIFwiLGdvdDpcIiArIGFjdHVhbF9jcmMgKyBcIilcIiwgMTYpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG4gICAgdmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDE2KDQsIGZhbHNlKTtcclxuICAgIHJldHVybiBbYWRkcmVzcywgbGVuZ3RoXTtcclxufVxyXG5cclxuXHJcblxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IGZsb2F0XHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRGbG9hdDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0KSB7XHJcbiAgICBjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcbiAgICBkdi5zZXRJbnQxNigwLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQgKyAyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGR2LnNldEludDE2KDIsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICByZXR1cm4gZHYuZ2V0RmxvYXQzMigwLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBVaW50MzJcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBjb252ZXJ0ZWQgdmFsdWVcclxuICovXHJcbmZ1bmN0aW9uIGdldFVpbnQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0SW50MTYoMCwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0ICsgMiwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICBkdi5zZXRJbnQxNigyLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgcmV0dXJuIGR2LmdldFVpbnQzMigwLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBmbG9hdFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEBwYXJhbSB7dmFsdWV9IG51bWJlciB2YWx1ZSB0byBzZXRcclxuICovXHJcbmZ1bmN0aW9uIHNldEZsb2F0MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQsIHZhbHVlKSB7XHJcbiAgICBjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcbiAgICBkdi5zZXRGbG9hdDMyKDAsIHZhbHVlLCBmYWxzZSk7XHJcbiAgICBkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQsIGR2LmdldEludDE2KDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0ICsgMiwgZHYuZ2V0SW50MTYoMCwgZmFsc2UpLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiBcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIHVpbnQzMiBpbnRvIHRoZSBidWZmZXJcclxuICogQHBhcmFtIHtudW1iZXJ9IHZhbHVlIHZhbHVlIHRvIHNldFxyXG4gKi9cclxuZnVuY3Rpb24gc2V0VWludDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0LCB2YWx1ZSkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0VWludDMyKDAsIHZhbHVlLCBmYWxzZSk7XHJcbiAgICBkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQsIGR2LmdldEludDE2KDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0ICsgMiwgZHYuZ2V0SW50MTYoMCwgZmFsc2UpLCBmYWxzZSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBtYWtlRkMzLCBnZXRGbG9hdDMyTEVCUywgbWFrZUZDMTYsIHNldEZsb2F0MzJMRUJTLCBzZXRVaW50MzJMRUJTLCBwYXJzZUZDMywgcGFyc2VGQzE2LCBwYXJzZUZDMTZjaGVja2VkLCBNb2RidXNFcnJvciwgU0VORUNBX01CX1NMQVZFX0lELCBnZXRVaW50MzJMRUJTLCBjcmMxNn0iLCIndXNlIHN0cmljdCc7XHJcblxyXG5jb25zdCB0ZXN0VHJhY2VzID0gW1xyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCAwYSAwMCAwMiBlNyBkMVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDVmIDQzIDNhIDkwIDkzIDNlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjQgOTkgYWRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBkOSAzZSA0MCA4MCAwOCBjMlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCA2NCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAxIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgMDIgMDAgMDUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSA3MyBjZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDEgNTkgODZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMwIDAwIDNhIDJmIGMzIDY1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAyIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMiAxOSA4N1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIDgwIDAwIDM5IDc2IGMwIDAwIDNhIDJmIDYwIDAwIDM5IGVkIDA3IDY3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODAgMDAgMzkgNzYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYTQgMDZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4MCAwMCAzOSA3NiBjMCAwMCAzYSAyZiA4MCAwMCAzOSA3NiA3MSAwY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwMyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDMgZDggNDdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyAyZCA1YyAzYyA4NiAyZCA1YyAzYyA4NiBiNiBkOCAzYyA0YSBiNiAwM1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIDQ3IDc0IDNjIDExIDJkIDVjIDNjIDg2IDQ3IDc0IDNjIDExIDk2IDJiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODggN2MgM2IgZjkgMmQgNWMgM2MgODYgODggN2MgM2IgZjkgMDggNjhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA0IDk5IDg1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZjQgZTMgYzAgZWEgZjQgZTMgYzAgZWEgZjQgZTMgYzAgZWEgMTUgOGNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmNCBlMyBjMCBlYSBlYyBlNCBjMCBlYSBmNCBlMyBjMCBlYSA2MyBlNlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIGY0IGUzIGMwIGVhIGVjIGU0IGMwIGVhIGVjIGU0IGMwIGVhIGQ0IDg3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZmMgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZmMgZTMgYzAgZWEgODAgNTlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmYyBlMyBjMCBlYSBlYyBlNCBjMCBlYSBmNCBlMyBjMCBlYSA4MiAzOVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjYgMTkgOWNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNSA1OCA0NVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDdmIGQyIGMzIDBkIDRhIGVhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA2IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNiAxOCA0NFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGQxIDAwIGMzIDc1IGNhIDE5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY2IDAwIDAxIDY3IGNkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMjAgMDAgODEgODZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzMyBkMyBjMyA3NiA0ZCA5OVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDcgZDkgODRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCA5MCBjMyA4NyA3MiA4ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGZlIGI3IGMzIDg2IDMyIGFlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA4IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwOCA5OSA4MFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGJlIDI3IGMyIGViIGU3IDNlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYmIgYWQgYzIgZWIgYzYgMThcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDkgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA5IDU4IDQwXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMWYgYjcgYzIgZDMgYzUgM2RcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA0NyA2MyBjMiBkMyA5NiA2NVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDFkIDU1IGMyIGQzIDY0IGIzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBhIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwYSAxOCA0MVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDZiIDVlIGM2IDNlIGNkIGI0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjMgN2QgYzYgM2UgM2UgMWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBiIGQ5IDgxXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNzcgMjkgY2YgN2MgZmMgNWZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2MCBlZiBjZiA3ZCBkOCAxNlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwYyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGMgOTggNDNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAzNCA1MSBjZCBjZSBlOCBkN1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGE2IGVhIGNkIGNlIGI0IDRhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZjkgZWUgY2QgY2QgYTcgOWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBhNSBiYyBjZCBjZSA1NCAxZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwZCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGQgNTkgODNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA1NCA3NiBjYyBiMCBjNyA2Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDdjIDZlIGNjIGIwIDRlIGNiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBlIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwZSAxOSA4MlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDRmIDQ0IDQ0IDViIDM2IGI2IDQzIGM3IDVmIDQ2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBmIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwZiBkOCA0MlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGYwIDc1IGMzIGIzIDFjIDRlIGMzIGM3IGEyIGY4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDEwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMCA5OSA4YVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDVkIDZmIDQ0IDViIDNlIGVkIDQzIGM3IDM3IDIyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDExIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMSA1OCA0YVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGZiIGIxIDQ1IDJmIDRmIDlhIDQ1IDdkIDFiIDkyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDEyIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMiAxOCA0YlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGM2IGIwIDQ1IDJhIDZkIDAwIGM1IDdkIDRlIDQ4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDEzIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxMyBkOSA4YlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IGZhIGVkIDQ1IDJmIDRlIGZlIDQ1IDdkIDA2IDc4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE0IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxNCA5OCA0OVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDQyIDdjIDQ0IDYxIDRmIDlhIDQ1IDdkIGE1IDlmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDE1IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAxNSA1OSA4OVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDdmIGMwIGMzIGMwIDg3IDk4IGM1IDcyIDA3IDEzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMTIgNzcgYzMgY2QgOWIgYzEgYzUgNmIgM2MgMjFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA5ZCBlOCBjMyBiNyAxMyBhOSBjNSA3NyA2OSA3N1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDgyIGQwIGMzIGFkIGY2IGQ2IGM1IDdiIGNlIGViXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNTcgODkgYzMgZDQgNGIgMTQgYzUgNjcgZDMgMWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTcgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE3IGQ4IDQ4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNDEgMDYgNDQgMmUgMjkgNTMgNDMgNDcgMjYgODZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTggZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE4IDk4IDRjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggYWMgMmYgYzQgNDUgMjUgYTUgYzMgNDcgZTkgM2VcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTkgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE5IDU5IDhjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNGYgOTIgNDQgMmUgMzUgYzYgNDMgNDcgNjUgN2ZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFhIDE5IDhkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggYWYgODIgNDMgNjcgMjkgNTMgNDMgNDcgYjEgMzNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFiIGQ4IDRkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNDYgYTcgYzQgMTMgMjUgYTUgYzMgNDcgMjcgMGRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWMgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFjIDk5IDhmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggY2MgOTggNDMgNjcgMzUgYzYgNDMgNDcgNWIgNzNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFkIDU4IDRmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNzAgZTUgNDMgOWEgMzYgYjYgNDMgYzcgOTAgYmVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFlIDE4IDRlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDQgMzQgYzcgMDYgMWMgNGUgYzMgYzcgNzEgMTVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMWYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDFmIGQ5IDhlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNmUgZGYgNDMgOWEgM2UgZWQgNDMgYzcgZjkgOGVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIwIDk5IDllXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZGYgZWYgNDMgODkgMzYgYjYgNDMgYzcgZjUgNDVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIxIDU4IDVlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNmEgMWUgYzUgZGQgMWMgNGUgYzMgYzcgMTggODJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIyIDE4IDVmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZTUgZWQgNDMgODkgM2UgZWQgNDMgYzcgMjYgNWRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjMgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDIzIGQ5IDlmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDAwIDAwIDA0IDQ3IGQxXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggN2YgMDAgMDEgMDAgMDAgMmMgMDAgMDEgYWQgY2JcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI0IDk4IDVkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGE0IDAwIDAyIDg2IDMwXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNmEgNDggM2QgZDUgMmUgZjNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMjUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI1IDU5IDlkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDk2IDAwIDA0IGE3IGZkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDAgMDAgMDAgMDAgMDAgMDAgMDAgMDAgZWIgNzdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgMDQgMDAgMDAgNDAgODAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiBlMiAyOVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjUgNTggNmRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgY2EgMDAgMDEgYTcgZWNcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMCA5OCA0NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkMiAwMCAwMiA2NyBlYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQwIDgwIDUyIDUyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjggOTggNThcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDIgMDAgMDIgMDQgMDAgMDAgNDEgMjAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiBlMiAyOVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjYgMTggNmNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDIgMDAgMDIgNjcgZWFcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSAyMCA1MyBiYVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDgwIDAwIGY5IDg2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDA0IDAwIDAwIDQxIDIwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDIgMjhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjcgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY3IGQ5IGFjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQ0IDAwIDAyIDg3IGViXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDEgMjAgNTMgYmFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDQgNjYgNjYgNDAgODYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwMiAyOFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2OCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjggOTkgYThcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDQgMDAgMDIgODcgZWJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2NiA2NiA0MCA4NiAyYyBjN1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkYyAwMCAwMiAwNCA2NiA2NiA0MCA4NiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGRjIDAwIDAyIDgzIGVhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY5IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2OSA1OCA2OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkYyAwMCAwMiAwNiAyOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDY2IDY2IDQwIDg2IDJjIGM3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZhIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2YSAxOCA2OVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2YiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmIgZDkgYTlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmMgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZjIDk4IDZiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZlIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2ZSAxOSBhYVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2ZCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmQgNTkgYWJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZmIGQ4IDZhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDcwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3MCA5OSBhMlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3MSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzEgNTggNjJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDQgMDAgMDAgNDEgYzggZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwMiAyN1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3MiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzIgMTggNjNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZTQgMDAgMDIgODcgZTRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSBjOCA1MyBmNFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDI3IGQ4IDVjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2MgZTcgNDAgODAgZGQgMzVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDc1IDU5IGExXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2QgNzYgNDAgODAgOGQgMjRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzggZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDc4IDk4IDY0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDdiIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3YiBkOCA2NVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM3IDRiIDQwIDgwIDFmIDMwXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2MgNTggNDAgODAgZWMgZDFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgN2UgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDdlIDE4IDY2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2IgYzggNDAgODAgZWQgODhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDgxIDU4IDI2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgY2EgYTkgNDAgODAgYmQgYWFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg0IDk4IDI1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzUgOWMgNDAgODAgYWUgYjBcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDggMDAgMDIgMDQgMDAgMDAgNDEgZjAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkOCAwMCAwMiBjMiAyYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4NyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODcgZDggMjRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDggMDAgMDIgNDcgZThcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSBmMCA1MiAyNlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBmZSAwMCAwNCAwOCAwMSA0ZCAwMCAwMCAwMSA0ZSAwMCAwMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IGEzIGUyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg4IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDkgMDAgMDEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDg4IDk4IDIwXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGZlIDAwIDA0IDI2IDIxXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggMDEgNGQgMDAgMDAgMDEgNGUgMDAgMDAgZDYgNTRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBhYSBhZiA0MCA4MCA0MyBhYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM1IDBjIDQwIDgwIGFlIDlkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzkgODkgNDAgODAgYmMgMjRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYiAzOSA0MCA4MCBiYyA3YlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM3IGRiIDQwIDgwIDFmIDFkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzYgYmMgNDAgODAgYWYgM2VcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNCA3ZCA0MCA4MCBmZiA3YVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGMzIDVlIDQwIDgwIDBmIGM0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzggNmIgNDAgODAgMWQgZWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNiAyYyA0MCA4MCBhZiAxM1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwNCAwMCAwMCA0MSBmMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDAyIDI3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzIgY2UgNDAgODAgMGUgMTVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgYzAgMDAgMDIgMDQgMDAgMDAgNDEgMjAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjMCAwMCAwMiA0MiAyY1wiXHJcbiAgICB9XHJcbiAgXVxyXG5cclxuZnVuY3Rpb24gdW5pcUJ5KGEsIGtleSkge1xyXG4gICAgdmFyIHNlZW4gPSB7fTtcclxuICAgIHJldHVybiBhLmZpbHRlcihmdW5jdGlvbiAoaXRlbSkge1xyXG4gICAgICAgIHZhciBrID0ga2V5KGl0ZW0pO1xyXG4gICAgICAgIHJldHVybiBzZWVuLmhhc093blByb3BlcnR5KGspID8gZmFsc2UgOiAoc2VlbltrXSA9IHRydWUpO1xyXG4gICAgfSlcclxufVxyXG5cclxuZnVuY3Rpb24gc2FtZU1lc3NhZ2UodHJhY2UpIHtcclxuICAgIHJldHVybiB0cmFjZVtcInJlcXVlc3RcIl0gKyBcIiAtPiBcIiArIHRyYWNlW1wiYW5zd2VyXCJdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBHZXRKc29uVHJhY2VzKCkge1xyXG4gICAgdGVzdFRyYWNlcyA9IHVuaXFCeSh0ZXN0VHJhY2VzLCBzYW1lTWVzc2FnZSk7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodGVzdFRyYWNlcyk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyB0ZXN0VHJhY2VzLCBHZXRKc29uVHJhY2VzIH0iLCIvKlxuKiBsb2dsZXZlbCAtIGh0dHBzOi8vZ2l0aHViLmNvbS9waW10ZXJyeS9sb2dsZXZlbFxuKlxuKiBDb3B5cmlnaHQgKGMpIDIwMTMgVGltIFBlcnJ5XG4qIExpY2Vuc2VkIHVuZGVyIHRoZSBNSVQgbGljZW5zZS5cbiovXG4oZnVuY3Rpb24gKHJvb3QsIGRlZmluaXRpb24pIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICBpZiAodHlwZW9mIGRlZmluZSA9PT0gJ2Z1bmN0aW9uJyAmJiBkZWZpbmUuYW1kKSB7XG4gICAgICAgIGRlZmluZShkZWZpbml0aW9uKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gZGVmaW5pdGlvbigpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJvb3QubG9nID0gZGVmaW5pdGlvbigpO1xuICAgIH1cbn0odGhpcywgZnVuY3Rpb24gKCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuXG4gICAgLy8gU2xpZ2h0bHkgZHViaW91cyB0cmlja3MgdG8gY3V0IGRvd24gbWluaW1pemVkIGZpbGUgc2l6ZVxuICAgIHZhciBub29wID0gZnVuY3Rpb24oKSB7fTtcbiAgICB2YXIgdW5kZWZpbmVkVHlwZSA9IFwidW5kZWZpbmVkXCI7XG4gICAgdmFyIGlzSUUgPSAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSkgJiYgKHR5cGVvZiB3aW5kb3cubmF2aWdhdG9yICE9PSB1bmRlZmluZWRUeXBlKSAmJiAoXG4gICAgICAgIC9UcmlkZW50XFwvfE1TSUUgLy50ZXN0KHdpbmRvdy5uYXZpZ2F0b3IudXNlckFnZW50KVxuICAgICk7XG5cbiAgICB2YXIgbG9nTWV0aG9kcyA9IFtcbiAgICAgICAgXCJ0cmFjZVwiLFxuICAgICAgICBcImRlYnVnXCIsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgICBcIndhcm5cIixcbiAgICAgICAgXCJlcnJvclwiXG4gICAgXTtcblxuICAgIC8vIENyb3NzLWJyb3dzZXIgYmluZCBlcXVpdmFsZW50IHRoYXQgd29ya3MgYXQgbGVhc3QgYmFjayB0byBJRTZcbiAgICBmdW5jdGlvbiBiaW5kTWV0aG9kKG9iaiwgbWV0aG9kTmFtZSkge1xuICAgICAgICB2YXIgbWV0aG9kID0gb2JqW21ldGhvZE5hbWVdO1xuICAgICAgICBpZiAodHlwZW9mIG1ldGhvZC5iaW5kID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gbWV0aG9kLmJpbmQob2JqKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIEZ1bmN0aW9uLnByb3RvdHlwZS5iaW5kLmNhbGwobWV0aG9kLCBvYmopO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIC8vIE1pc3NpbmcgYmluZCBzaGltIG9yIElFOCArIE1vZGVybml6ciwgZmFsbGJhY2sgdG8gd3JhcHBpbmdcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuYXBwbHkobWV0aG9kLCBbb2JqLCBhcmd1bWVudHNdKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVHJhY2UoKSBkb2Vzbid0IHByaW50IHRoZSBtZXNzYWdlIGluIElFLCBzbyBmb3IgdGhhdCBjYXNlIHdlIG5lZWQgdG8gd3JhcCBpdFxuICAgIGZ1bmN0aW9uIHRyYWNlRm9ySUUoKSB7XG4gICAgICAgIGlmIChjb25zb2xlLmxvZykge1xuICAgICAgICAgICAgaWYgKGNvbnNvbGUubG9nLmFwcGx5KSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2cuYXBwbHkoY29uc29sZSwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gSW4gb2xkIElFLCBuYXRpdmUgY29uc29sZSBtZXRob2RzIHRoZW1zZWx2ZXMgZG9uJ3QgaGF2ZSBhcHBseSgpLlxuICAgICAgICAgICAgICAgIEZ1bmN0aW9uLnByb3RvdHlwZS5hcHBseS5hcHBseShjb25zb2xlLmxvZywgW2NvbnNvbGUsIGFyZ3VtZW50c10pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChjb25zb2xlLnRyYWNlKSBjb25zb2xlLnRyYWNlKCk7XG4gICAgfVxuXG4gICAgLy8gQnVpbGQgdGhlIGJlc3QgbG9nZ2luZyBtZXRob2QgcG9zc2libGUgZm9yIHRoaXMgZW52XG4gICAgLy8gV2hlcmV2ZXIgcG9zc2libGUgd2Ugd2FudCB0byBiaW5kLCBub3Qgd3JhcCwgdG8gcHJlc2VydmUgc3RhY2sgdHJhY2VzXG4gICAgZnVuY3Rpb24gcmVhbE1ldGhvZChtZXRob2ROYW1lKSB7XG4gICAgICAgIGlmIChtZXRob2ROYW1lID09PSAnZGVidWcnKSB7XG4gICAgICAgICAgICBtZXRob2ROYW1lID0gJ2xvZyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgPT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTsgLy8gTm8gbWV0aG9kIHBvc3NpYmxlLCBmb3Igbm93IC0gZml4ZWQgbGF0ZXIgYnkgZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlc1xuICAgICAgICB9IGVsc2UgaWYgKG1ldGhvZE5hbWUgPT09ICd0cmFjZScgJiYgaXNJRSkge1xuICAgICAgICAgICAgcmV0dXJuIHRyYWNlRm9ySUU7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uc29sZVttZXRob2ROYW1lXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gYmluZE1ldGhvZChjb25zb2xlLCBtZXRob2ROYW1lKTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25zb2xlLmxvZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gYmluZE1ldGhvZChjb25zb2xlLCAnbG9nJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gbm9vcDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZXNlIHByaXZhdGUgZnVuY3Rpb25zIGFsd2F5cyBuZWVkIGB0aGlzYCB0byBiZSBzZXQgcHJvcGVybHlcblxuICAgIGZ1bmN0aW9uIHJlcGxhY2VMb2dnaW5nTWV0aG9kcyhsZXZlbCwgbG9nZ2VyTmFtZSkge1xuICAgICAgICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxvZ01ldGhvZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIHZhciBtZXRob2ROYW1lID0gbG9nTWV0aG9kc1tpXTtcbiAgICAgICAgICAgIHRoaXNbbWV0aG9kTmFtZV0gPSAoaSA8IGxldmVsKSA/XG4gICAgICAgICAgICAgICAgbm9vcCA6XG4gICAgICAgICAgICAgICAgdGhpcy5tZXRob2RGYWN0b3J5KG1ldGhvZE5hbWUsIGxldmVsLCBsb2dnZXJOYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIERlZmluZSBsb2cubG9nIGFzIGFuIGFsaWFzIGZvciBsb2cuZGVidWdcbiAgICAgICAgdGhpcy5sb2cgPSB0aGlzLmRlYnVnO1xuICAgIH1cblxuICAgIC8vIEluIG9sZCBJRSB2ZXJzaW9ucywgdGhlIGNvbnNvbGUgaXNuJ3QgcHJlc2VudCB1bnRpbCB5b3UgZmlyc3Qgb3BlbiBpdC5cbiAgICAvLyBXZSBidWlsZCByZWFsTWV0aG9kKCkgcmVwbGFjZW1lbnRzIGhlcmUgdGhhdCByZWdlbmVyYXRlIGxvZ2dpbmcgbWV0aG9kc1xuICAgIGZ1bmN0aW9uIGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXMobWV0aG9kTmFtZSwgbGV2ZWwsIGxvZ2dlck5hbWUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgICAgIHJlcGxhY2VMb2dnaW5nTWV0aG9kcy5jYWxsKHRoaXMsIGxldmVsLCBsb2dnZXJOYW1lKTtcbiAgICAgICAgICAgICAgICB0aGlzW21ldGhvZE5hbWVdLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gQnkgZGVmYXVsdCwgd2UgdXNlIGNsb3NlbHkgYm91bmQgcmVhbCBtZXRob2RzIHdoZXJldmVyIHBvc3NpYmxlLCBhbmRcbiAgICAvLyBvdGhlcndpc2Ugd2Ugd2FpdCBmb3IgYSBjb25zb2xlIHRvIGFwcGVhciwgYW5kIHRoZW4gdHJ5IGFnYWluLlxuICAgIGZ1bmN0aW9uIGRlZmF1bHRNZXRob2RGYWN0b3J5KG1ldGhvZE5hbWUsIGxldmVsLCBsb2dnZXJOYW1lKSB7XG4gICAgICAgIC8qanNoaW50IHZhbGlkdGhpczp0cnVlICovXG4gICAgICAgIHJldHVybiByZWFsTWV0aG9kKG1ldGhvZE5hbWUpIHx8XG4gICAgICAgICAgICAgICBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gTG9nZ2VyKG5hbWUsIGRlZmF1bHRMZXZlbCwgZmFjdG9yeSkge1xuICAgICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgICAgdmFyIGN1cnJlbnRMZXZlbDtcbiAgICAgIGRlZmF1bHRMZXZlbCA9IGRlZmF1bHRMZXZlbCA9PSBudWxsID8gXCJXQVJOXCIgOiBkZWZhdWx0TGV2ZWw7XG5cbiAgICAgIHZhciBzdG9yYWdlS2V5ID0gXCJsb2dsZXZlbFwiO1xuICAgICAgaWYgKHR5cGVvZiBuYW1lID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHN0b3JhZ2VLZXkgKz0gXCI6XCIgKyBuYW1lO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgbmFtZSA9PT0gXCJzeW1ib2xcIikge1xuICAgICAgICBzdG9yYWdlS2V5ID0gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBwZXJzaXN0TGV2ZWxJZlBvc3NpYmxlKGxldmVsTnVtKSB7XG4gICAgICAgICAgdmFyIGxldmVsTmFtZSA9IChsb2dNZXRob2RzW2xldmVsTnVtXSB8fCAnc2lsZW50JykudG9VcHBlckNhc2UoKTtcblxuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICAvLyBVc2UgbG9jYWxTdG9yYWdlIGlmIGF2YWlsYWJsZVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Vbc3RvcmFnZUtleV0gPSBsZXZlbE5hbWU7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBVc2Ugc2Vzc2lvbiBjb29raWUgYXMgZmFsbGJhY2tcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cuZG9jdW1lbnQuY29va2llID1cbiAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj1cIiArIGxldmVsTmFtZSArIFwiO1wiO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gZ2V0UGVyc2lzdGVkTGV2ZWwoKSB7XG4gICAgICAgICAgdmFyIHN0b3JlZExldmVsO1xuXG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHN0b3JlZExldmVsID0gd2luZG93LmxvY2FsU3RvcmFnZVtzdG9yYWdlS2V5XTtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBGYWxsYmFjayB0byBjb29raWVzIGlmIGxvY2FsIHN0b3JhZ2UgZ2l2ZXMgdXMgbm90aGluZ1xuICAgICAgICAgIGlmICh0eXBlb2Ygc3RvcmVkTGV2ZWwgPT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgIHZhciBjb29raWUgPSB3aW5kb3cuZG9jdW1lbnQuY29va2llO1xuICAgICAgICAgICAgICAgICAgdmFyIGxvY2F0aW9uID0gY29va2llLmluZGV4T2YoXG4gICAgICAgICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9XCIpO1xuICAgICAgICAgICAgICAgICAgaWYgKGxvY2F0aW9uICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgIHN0b3JlZExldmVsID0gL14oW147XSspLy5leGVjKGNvb2tpZS5zbGljZShsb2NhdGlvbikpWzFdO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSWYgdGhlIHN0b3JlZCBsZXZlbCBpcyBub3QgdmFsaWQsIHRyZWF0IGl0IGFzIGlmIG5vdGhpbmcgd2FzIHN0b3JlZC5cbiAgICAgICAgICBpZiAoc2VsZi5sZXZlbHNbc3RvcmVkTGV2ZWxdID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgc3RvcmVkTGV2ZWwgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHN0b3JlZExldmVsO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBjbGVhclBlcnNpc3RlZExldmVsKCkge1xuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICAvLyBVc2UgbG9jYWxTdG9yYWdlIGlmIGF2YWlsYWJsZVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShzdG9yYWdlS2V5KTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIFVzZSBzZXNzaW9uIGNvb2tpZSBhcyBmYWxsYmFja1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5kb2N1bWVudC5jb29raWUgPVxuICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPTsgZXhwaXJlcz1UaHUsIDAxIEphbiAxOTcwIDAwOjAwOjAwIFVUQ1wiO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgIH1cblxuICAgICAgLypcbiAgICAgICAqXG4gICAgICAgKiBQdWJsaWMgbG9nZ2VyIEFQSSAtIHNlZSBodHRwczovL2dpdGh1Yi5jb20vcGltdGVycnkvbG9nbGV2ZWwgZm9yIGRldGFpbHNcbiAgICAgICAqXG4gICAgICAgKi9cblxuICAgICAgc2VsZi5uYW1lID0gbmFtZTtcblxuICAgICAgc2VsZi5sZXZlbHMgPSB7IFwiVFJBQ0VcIjogMCwgXCJERUJVR1wiOiAxLCBcIklORk9cIjogMiwgXCJXQVJOXCI6IDMsXG4gICAgICAgICAgXCJFUlJPUlwiOiA0LCBcIlNJTEVOVFwiOiA1fTtcblxuICAgICAgc2VsZi5tZXRob2RGYWN0b3J5ID0gZmFjdG9yeSB8fCBkZWZhdWx0TWV0aG9kRmFjdG9yeTtcblxuICAgICAgc2VsZi5nZXRMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICByZXR1cm4gY3VycmVudExldmVsO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5zZXRMZXZlbCA9IGZ1bmN0aW9uIChsZXZlbCwgcGVyc2lzdCkge1xuICAgICAgICAgIGlmICh0eXBlb2YgbGV2ZWwgPT09IFwic3RyaW5nXCIgJiYgc2VsZi5sZXZlbHNbbGV2ZWwudG9VcHBlckNhc2UoKV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBsZXZlbCA9IHNlbGYubGV2ZWxzW2xldmVsLnRvVXBwZXJDYXNlKCldO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHlwZW9mIGxldmVsID09PSBcIm51bWJlclwiICYmIGxldmVsID49IDAgJiYgbGV2ZWwgPD0gc2VsZi5sZXZlbHMuU0lMRU5UKSB7XG4gICAgICAgICAgICAgIGN1cnJlbnRMZXZlbCA9IGxldmVsO1xuICAgICAgICAgICAgICBpZiAocGVyc2lzdCAhPT0gZmFsc2UpIHsgIC8vIGRlZmF1bHRzIHRvIHRydWVcbiAgICAgICAgICAgICAgICAgIHBlcnNpc3RMZXZlbElmUG9zc2libGUobGV2ZWwpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJlcGxhY2VMb2dnaW5nTWV0aG9kcy5jYWxsKHNlbGYsIGxldmVsLCBuYW1lKTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlID09PSB1bmRlZmluZWRUeXBlICYmIGxldmVsIDwgc2VsZi5sZXZlbHMuU0lMRU5UKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gXCJObyBjb25zb2xlIGF2YWlsYWJsZSBmb3IgbG9nZ2luZ1wiO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgXCJsb2cuc2V0TGV2ZWwoKSBjYWxsZWQgd2l0aCBpbnZhbGlkIGxldmVsOiBcIiArIGxldmVsO1xuICAgICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHNlbGYuc2V0RGVmYXVsdExldmVsID0gZnVuY3Rpb24gKGxldmVsKSB7XG4gICAgICAgICAgZGVmYXVsdExldmVsID0gbGV2ZWw7XG4gICAgICAgICAgaWYgKCFnZXRQZXJzaXN0ZWRMZXZlbCgpKSB7XG4gICAgICAgICAgICAgIHNlbGYuc2V0TGV2ZWwobGV2ZWwsIGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnJlc2V0TGV2ZWwgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgc2VsZi5zZXRMZXZlbChkZWZhdWx0TGV2ZWwsIGZhbHNlKTtcbiAgICAgICAgICBjbGVhclBlcnNpc3RlZExldmVsKCk7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLmVuYWJsZUFsbCA9IGZ1bmN0aW9uKHBlcnNpc3QpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKHNlbGYubGV2ZWxzLlRSQUNFLCBwZXJzaXN0KTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuZGlzYWJsZUFsbCA9IGZ1bmN0aW9uKHBlcnNpc3QpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKHNlbGYubGV2ZWxzLlNJTEVOVCwgcGVyc2lzdCk7XG4gICAgICB9O1xuXG4gICAgICAvLyBJbml0aWFsaXplIHdpdGggdGhlIHJpZ2h0IGxldmVsXG4gICAgICB2YXIgaW5pdGlhbExldmVsID0gZ2V0UGVyc2lzdGVkTGV2ZWwoKTtcbiAgICAgIGlmIChpbml0aWFsTGV2ZWwgPT0gbnVsbCkge1xuICAgICAgICAgIGluaXRpYWxMZXZlbCA9IGRlZmF1bHRMZXZlbDtcbiAgICAgIH1cbiAgICAgIHNlbGYuc2V0TGV2ZWwoaW5pdGlhbExldmVsLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLypcbiAgICAgKlxuICAgICAqIFRvcC1sZXZlbCBBUElcbiAgICAgKlxuICAgICAqL1xuXG4gICAgdmFyIGRlZmF1bHRMb2dnZXIgPSBuZXcgTG9nZ2VyKCk7XG5cbiAgICB2YXIgX2xvZ2dlcnNCeU5hbWUgPSB7fTtcbiAgICBkZWZhdWx0TG9nZ2VyLmdldExvZ2dlciA9IGZ1bmN0aW9uIGdldExvZ2dlcihuYW1lKSB7XG4gICAgICAgIGlmICgodHlwZW9mIG5hbWUgIT09IFwic3ltYm9sXCIgJiYgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIpIHx8IG5hbWUgPT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiWW91IG11c3Qgc3VwcGx5IGEgbmFtZSB3aGVuIGNyZWF0aW5nIGEgbG9nZ2VyLlwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBsb2dnZXIgPSBfbG9nZ2Vyc0J5TmFtZVtuYW1lXTtcbiAgICAgICAgaWYgKCFsb2dnZXIpIHtcbiAgICAgICAgICBsb2dnZXIgPSBfbG9nZ2Vyc0J5TmFtZVtuYW1lXSA9IG5ldyBMb2dnZXIoXG4gICAgICAgICAgICBuYW1lLCBkZWZhdWx0TG9nZ2VyLmdldExldmVsKCksIGRlZmF1bHRMb2dnZXIubWV0aG9kRmFjdG9yeSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxvZ2dlcjtcbiAgICB9O1xuXG4gICAgLy8gR3JhYiB0aGUgY3VycmVudCBnbG9iYWwgbG9nIHZhcmlhYmxlIGluIGNhc2Ugb2Ygb3ZlcndyaXRlXG4gICAgdmFyIF9sb2cgPSAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSkgPyB3aW5kb3cubG9nIDogdW5kZWZpbmVkO1xuICAgIGRlZmF1bHRMb2dnZXIubm9Db25mbGljdCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSAmJlxuICAgICAgICAgICAgICAgd2luZG93LmxvZyA9PT0gZGVmYXVsdExvZ2dlcikge1xuICAgICAgICAgICAgd2luZG93LmxvZyA9IF9sb2c7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZGVmYXVsdExvZ2dlcjtcbiAgICB9O1xuXG4gICAgZGVmYXVsdExvZ2dlci5nZXRMb2dnZXJzID0gZnVuY3Rpb24gZ2V0TG9nZ2VycygpIHtcbiAgICAgICAgcmV0dXJuIF9sb2dnZXJzQnlOYW1lO1xuICAgIH07XG5cbiAgICAvLyBFUzYgZGVmYXVsdCBleHBvcnQsIGZvciBjb21wYXRpYmlsaXR5XG4gICAgZGVmYXVsdExvZ2dlclsnZGVmYXVsdCddID0gZGVmYXVsdExvZ2dlcjtcblxuICAgIHJldHVybiBkZWZhdWx0TG9nZ2VyO1xufSkpO1xuIiwiJ3VzZSBzdHJpY3QnO1xyXG5cclxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiogTU9EQlVTIFJUVSBGVU5DVElPTlMgRk9SIFNFTkVDQSAqKioqKioqKioqKioqKioqKioqKioqL1xyXG5cclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoJy4vbW9kYnVzUnR1Jyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XHJcblxyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbmNvbnN0IFNFTkVDQV9NQl9TTEFWRV9JRCA9IG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQ7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbi8qXHJcbiAqIE1vZGJ1cyByZWdpc3RlcnMgbWFwLiBFYWNoIHJlZ2lzdGVyIGlzIDIgYnl0ZXMgd2lkZS5cclxuICovXHJcbmNvbnN0IE1TQ1JlZ2lzdGVycyA9IHtcclxuICAgIFNlcmlhbE51bWJlcjogMTAsXHJcbiAgICBDdXJyZW50TW9kZTogMTAwLFxyXG4gICAgTWVhc3VyZUZsYWdzOiAxMDIsXHJcbiAgICBDTUQ6IDEwNyxcclxuICAgIEFVWDE6IDEwOCxcclxuICAgIExvYWRDZWxsTWVhc3VyZTogMTE0LFxyXG4gICAgVGVtcE1lYXN1cmU6IDEyMCxcclxuICAgIFJ0ZFRlbXBlcmF0dXJlTWVhc3VyZTogMTI4LFxyXG4gICAgUnRkUmVzaXN0YW5jZU1lYXN1cmU6IDEzMCxcclxuICAgIEZyZXF1ZW5jeU1lYXN1cmU6IDE2NCxcclxuICAgIE1pbk1lYXN1cmU6IDEzMixcclxuICAgIE1heE1lYXN1cmU6IDEzNCxcclxuICAgIEluc3RhbnRNZWFzdXJlOiAxMzYsXHJcbiAgICBQb3dlck9mZkRlbGF5OiAxNDIsXHJcbiAgICBQb3dlck9mZlJlbWFpbmluZzogMTQ2LFxyXG4gICAgUHVsc2VPRkZNZWFzdXJlOiAxNTAsXHJcbiAgICBQdWxzZU9OTWVhc3VyZTogMTUyLFxyXG4gICAgU2Vuc2liaWxpdHlfdVNfT0ZGOiAxNjYsXHJcbiAgICBTZW5zaWJpbGl0eV91U19PTjogMTY4LFxyXG4gICAgQmF0dGVyeU1lYXN1cmU6IDE3NCxcclxuICAgIENvbGRKdW5jdGlvbjogMTkwLFxyXG4gICAgVGhyZXNob2xkVV9GcmVxOiAxOTIsXHJcbiAgICBHZW5lcmF0aW9uRmxhZ3M6IDIwMixcclxuICAgIEdFTl9DTUQ6IDIwNyxcclxuICAgIEdFTl9BVVgxOiAyMDgsXHJcbiAgICBDdXJyZW50U2V0cG9pbnQ6IDIxMCxcclxuICAgIFZvbHRhZ2VTZXRwb2ludDogMjEyLFxyXG4gICAgTG9hZENlbGxTZXRwb2ludDogMjE2LFxyXG4gICAgVGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludDogMjIwLFxyXG4gICAgUlREVGVtcGVyYXR1cmVTZXRwb2ludDogMjI4LFxyXG4gICAgUHVsc2VzQ291bnQ6IDI1MixcclxuICAgIEZyZXF1ZW5jeVRJQ0sxOiAyNTQsXHJcbiAgICBGcmVxdWVuY3lUSUNLMjogMjU2LFxyXG4gICAgR2VuVWhpZ2hQZXJjOiAyNjIsXHJcbiAgICBHZW5VbG93UGVyYzogMjY0XHJcbn07XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIHNlcmlhbCBudW1iZXJcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZVNlcmlhbE51bWJlcigpIHtcclxuICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5TZXJpYWxOdW1iZXIpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQ3VycmVudE1vZGUoKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuQ3VycmVudE1vZGUpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgYmF0dGVyeSBsZXZlbFxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQmF0dGVyeUxldmVsKCkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkJhdHRlcnlNZWFzdXJlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgcmVnaXN0ZXIgd2l0aCBiYXR0ZXJ5IGxldmVsXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBGQzMgYW5zd2VyIFxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBiYXR0ZXJ5IGxldmVsIGluIFZcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQmF0dGVyeShidWZmZXIpIHtcclxuICAgIHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHJldHVybiBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVnaXN0ZXJzLCAwKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBTZW5lY2EgTVNDIHNlcmlhbCBhcyBwZXIgdGhlIFVJIGludGVyZmFjZVxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgbW9kYnVzIGFuc3dlciBwYWNrZXQgKEZDMylcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlU2VyaWFsTnVtYmVyKGJ1ZmZlcikge1xyXG4gICAgdmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgaWYgKHJlZ2lzdGVycy5sZW5ndGggPCA0KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBzZXJpYWwgbnVtYmVyIHJlc3BvbnNlXCIpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsMSA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMCwgZmFsc2UpO1xyXG4gICAgY29uc3QgdmFsMiA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG4gICAgY29uc3Qgc2VyaWFsID0gKCh2YWwyIDw8IDE2KSArIHZhbDEpLnRvU3RyaW5nKCk7XHJcbiAgICBpZiAoc2VyaWFsLmxlbmd0aCA+IDUpIHtcclxuICAgICAgICByZXR1cm4gc2VyaWFsLnN1YnN0cigwLCA1KSArIFwiX1wiICsgc2VyaWFsLnN1YnN0cig1LCBzZXJpYWwubGVuZ3RoIC0gNSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VyaWFsO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSBzdGF0ZSBvZiB0aGUgbWV0ZXIuIE1heSB0aHJvdy5cclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBhbnN3ZXIgcGFja2V0IChGQzMpXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGN1cnJlbnRNb2RlIGlmIHRoZSByZWdpc3RlcnMgY29udGFpbnMgYW4gSUdOT1JFIHZhbHVlLCByZXR1cm5zIHRoZSBjdXJyZW50IG1vZGVcclxuICogQHJldHVybnMge0NvbW1hbmRUeXBlfSBtZXRlciBtb2RlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUN1cnJlbnRNb2RlKGJ1ZmZlciwgY3VycmVudE1vZGUpIHtcclxuICAgIHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIGlmIChyZWdpc3RlcnMubGVuZ3RoIDwgMikge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbW9kZSByZXNwb25zZVwiKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbDEgPSByZWdpc3RlcnMuZ2V0VWludDE2KDAsIGZhbHNlKTtcclxuXHJcbiAgICBpZiAodmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLlJFU0VSVkVEXzIpIHsgLy8gTXVzdCBiZSBpZ25vcmVkLCBpbnRlcm5hbCBzdGF0ZXMgb2YgdGhlIG1ldGVyXHJcbiAgICAgICAgcmV0dXJuIGN1cnJlbnRNb2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSB1dGlscy5QYXJzZShDb21tYW5kVHlwZSwgdmFsMSk7XHJcbiAgICBpZiAodmFsdWUgPT0gbnVsbClcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIG1ldGVyIG1vZGUgOiBcIiArIHZhbHVlKTtcclxuXHJcbiAgICByZXR1cm4gdmFsMTtcclxufVxyXG4vKipcclxuICogU2V0cyB0aGUgY3VycmVudCBtb2RlLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ8bnVsbH1cclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNb2RlUmVxdWVzdChtb2RlKSB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCBtb2RlKTtcclxuICAgIGNvbnN0IENIQU5HRV9TVEFUVVMgPSAxO1xyXG5cclxuICAgIC8vIEZpbHRlciBpbnZhbGlkIGNvbW1hbmRzXHJcbiAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBpZiAobW9kZSA+IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiBtb2RlIDw9IENvbW1hbmRUeXBlLk9GRikgeyAvLyBNZWFzdXJlbWVudHNcclxuICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKG1vZGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgbW9kZSA8IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCkgeyAvLyBHZW5lcmF0aW9uc1xyXG4gICAgICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICAgICAgLy8gQ29sZCBqdW5jdGlvbiBub3QgY29uZmlndXJlZFxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgIC8vIEFsbCB0aGUgc2ltcGxlIGNhc2VzIFxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdoZW4gdGhlIG1ldGVyIGlzIG1lYXN1cmluZywgbWFrZSB0aGUgbW9kYnVzIHJlcXVlc3Qgb2YgdGhlIHZhbHVlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHBhY2tldFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZU1lYXN1cmVSZXF1ZXN0KG1vZGUpIHtcclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlRlbXBNZWFzdXJlKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF80VzpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLlJ0ZFRlbXBlcmF0dXJlTWVhc3VyZSk7IC8vIFRlbXAtT2htXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lNZWFzdXJlKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5QdWxzZU9GRk1lYXN1cmUpOyAvLyBPTi1PRkZcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkxvYWRDZWxsOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuTG9hZENlbGwpO1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlY6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tVjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNiwgTVNDUmVnaXN0ZXJzLk1pbk1lYXN1cmUpOyAvLyBNaW4tTWF4LU1lYXNcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNb2RlIG5vdCBtYW5hZ2VkIDpcIiArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgbWVhc3VyZSByZWFkIGZyb20gdGhlIG1ldGVyXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBtb2RidXMgcnR1IGFuc3dlciAoRkMzKVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGN1cnJlbnQgbW9kZSBvZiB0aGUgbWV0ZXJcclxuICogQHJldHVybnMge2FycmF5fSBhbiBhcnJheSB3aXRoIGZpcnN0IGVsZW1lbnQgXCJNZWFzdXJlIG5hbWUgKHVuaXRzKVwiOlZhbHVlLCBzZWNvbmQgVGltZXN0YW1wOmFjcXVpc2l0aW9uXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZU1lYXN1cmUoYnVmZmVyLCBtb2RlKSB7XHJcbiAgICB2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHZhciBtZWFzLCBtZWFzMiwgbWluLCBtYXg7XHJcblxyXG4gICAgLy8gQWxsIG1lYXN1cmVzIGFyZSBmbG9hdFxyXG4gICAgaWYgKHJlc3BvbnNlRkMzID09IG51bGwpXHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUzpcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIHZhciB2YWx1ZSA9IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDBcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiB2YWx1ZSxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfNFc6XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtZWFzMiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTApIC8gMTAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCLCsENcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJSZXNpc3RhbmNlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVZhbHVlXCI6IE1hdGgucm91bmQobWVhczIgKiAxMCkgLyAxMCxcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VW5pdFwiOiBcIk9obXNcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuRnJlcXVlbmN5OlxyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgLy8gU2Vuc2liaWxpdMOgIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5XCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwKSAvIDEwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiSHpcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgbWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiQ3VycmVudFwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibUFcIixcclxuICAgICAgICAgICAgICAgIFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5WOlxyXG4gICAgICAgICAgICBtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJWXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubVY6XHJcbiAgICAgICAgICAgIG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWVhczIgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIC8vIFNvZ2xpYSBlIHNlbnNpYmlsaXTDoCBtYW5jYW50aVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlB1bHNlIE9OXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IG1lYXMsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJQdWxzZSBPRkZcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VmFsdWVcIjogbWVhczIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVVuaXRcIjogXCJcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTG9hZENlbGw6XHJcbiAgICAgICAgICAgIG1lYXMgPSBNYXRoLnJvdW5kKG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCkgKiAxMDAwKSAvIDEwMDA7XHJcbiAgICAgICAgICAgIC8vIEtnIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIC8vIFNlbnNpYmlsaXTDoCwgdGFyYSwgcG9ydGF0YSBtYW5jYW50aVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkltYmFsYW5jZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBtZWFzLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibVYvVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMDApIC8gMTAwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIj9cIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHN0YXR1cyBmbGFncyBmcm9tIG1lYXN1cmVtZW50IG1vZGVcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlUXVhbGl0eUJpdFJlcXVlc3QobW9kZSkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLk1lYXN1cmVGbGFncyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVja3MgaWYgdGhlIGVycm9yIGJpdCBzdGF0dXNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIHRoZXJlIGlzIG5vIGVycm9yXHJcbiAqL1xyXG5mdW5jdGlvbiBpc1F1YWxpdHlWYWxpZChidWZmZXIpIHtcclxuICAgIHZhciByZXNwb25zZUZDMyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgcmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDEzKSkgPT0gMCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgZ2VuZXJhdGlvbiBmbGFncyBzdGF0dXMgZnJvbSB0aGUgbWV0ZXJcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlR2VuU3RhdHVzUmVhZChtb2RlKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuR2VuZXJhdGlvbkZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IGlzIE5PVCBzZXQgaW4gdGhlIGdlbmVyYXRpb24gZmxhZ3NcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VGQzNcclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgdGhlcmUgaXMgbm8gZXJyb3JcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlR2VuU3RhdHVzKGJ1ZmZlciwgbW9kZSkge1xyXG4gICAgdmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgcmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMCkgJiYgLy8gR2VuIGVycm9yXHJcbiAgICAgICAgICAgICAgICAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNCkpID09IDApOyAvLyBTZWxmIGdlbmVyYXRpb24gSSBjaGVja1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJldHVybiAocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMDsgLy8gR2VuIGVycm9yXHJcbiAgICB9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGJ1ZmZlciB3aXRoIHRoZSBtb2RidXMtcnR1IHJlcXVlc3QgdG8gYmUgc2VudCB0byBTZW5lY2FcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBnZW5lcmF0aW9uIG1vZGVcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHRoZSB2YWx1ZSB0byBzZXQgKG1WL1YvQS9Iei/CsEMpIGV4Y2VwdCBmb3IgcHVsc2VzIG51bV9wdWxzZXNcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50MiBmcmVxdWVuY3kgaW4gSHpcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlcXVlc3QobW9kZSwgc2V0cG9pbnQsIHNldHBvaW50Mikge1xyXG4gICAgdmFyIFRFTVAsIHJlZ2lzdGVycztcclxuICAgIHZhciBkdCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIHZhciBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG4gICAgbW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCk7XHJcbiAgICBjb25zdCBzcCA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHJcbiAgICB2YXIgZHRJbnQgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICB2YXIgZHZJbnQgPSBuZXcgRGF0YVZpZXcoZHRJbnQpO1xyXG4gICAgbW9kYnVzLnNldFVpbnQzMkxFQlMoZHZJbnQsIDAsIHNldHBvaW50KTtcclxuICAgIGNvbnN0IHNwSW50ID0gW2R2SW50LmdldFVpbnQxNigwLCBmYWxzZSksIGR2SW50LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50LCBzcCk7IC8vIFYgLyBtViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRTZXRwb2ludCwgc3ApOyAvLyBJIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5SVERUZW1wZXJhdHVyZVNldHBvaW50LCBzcCk7IC8vIMKwQyBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQsIHNwKTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuTG9hZENlbGxTZXRwb2ludCwgc3ApOyAvLyBtVi9WIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgICAgICBkdCA9IG5ldyBBcnJheUJ1ZmZlcig4KTsgLy8gMiBVaW50MzJcclxuICAgICAgICAgICAgZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuICAgICAgICAgICAgLy8gU2VlIFNlbmVjYWwgbWFudWFsIG1hbnVhbFxyXG4gICAgICAgICAgICAvLyBNYXggMjBrSFogZ2VuXHJcbiAgICAgICAgICAgIFRFTVAgPSBNYXRoLnJvdW5kKDIwMDAwIC8gc2V0cG9pbnQsIDApO1xyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoMCwgTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzFcclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDQsIFRFTVAgLSBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMlxyXG5cclxuICAgICAgICAgICAgLy8gQnl0ZS1zd2FwcGVkIGxpdHRsZSBlbmRpYW5cclxuICAgICAgICAgICAgcmVnaXN0ZXJzID0gW2R2LmdldFVpbnQxNigyLCBmYWxzZSksIGR2LmdldFVpbnQxNigwLCBmYWxzZSksXHJcbiAgICAgICAgICAgIGR2LmdldFVpbnQxNig2LCBmYWxzZSksIGR2LmdldFVpbnQxNig0LCBmYWxzZSldO1xyXG5cclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSwgcmVnaXN0ZXJzKTtcclxuXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgZHQgPSBuZXcgQXJyYXlCdWZmZXIoMTIpOyAvLyAzIFVpbnQzMiBcclxuICAgICAgICAgICAgZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuICAgICAgICAgICAgLy8gU2VlIFNlbmVjYWwgbWFudWFsIG1hbnVhbFxyXG4gICAgICAgICAgICAvLyBNYXggMjBrSFogZ2VuXHJcbiAgICAgICAgICAgIFRFTVAgPSBNYXRoLnJvdW5kKDIwMDAwIC8gc2V0cG9pbnQyLCAwKTtcclxuXHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMigwLCBzZXRwb2ludCwgZmFsc2UpOyAvLyBOVU1fUFVMU0VTXHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMig0LCBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMVxyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoOCwgVEVNUCAtIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0syXHJcblxyXG4gICAgICAgICAgICByZWdpc3RlcnMgPSBbZHYuZ2V0VWludDE2KDIsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDAsIGZhbHNlKSxcclxuICAgICAgICAgICAgZHYuZ2V0VWludDE2KDYsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDQsIGZhbHNlKSxcclxuICAgICAgICAgICAgZHYuZ2V0VWludDE2KDEwLCBmYWxzZSksIGR2LmdldFVpbnQxNig4LCBmYWxzZSldO1xyXG5cclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5QdWxzZXNDb3VudCwgcmVnaXN0ZXJzKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VVGhyZXNob2xkX0Y6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVGhyZXNob2xkVV9GcmVxLCBzcCk7IC8vIFUgbWluIGZvciBmcmVxIG1lYXN1cmVtZW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2Vuc2l0aXZpdHlfdVM6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuU2Vuc2liaWxpdHlfdVNfT0ZGLFxyXG4gICAgICAgICAgICAgICAgW3NwSW50WzBdLCBzcEludFsxXSwgc3BJbnRbMF0sIHNwSW50WzFdXSk7IC8vIHVWIGZvciBwdWxzZSB0cmFpbiBtZWFzdXJlbWVudCB0byBPTiAvIE9GRlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX0NvbGRKdW5jdGlvbjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Db2xkSnVuY3Rpb24sIHNwKTsgLy8gdW5jbGVhciB1bml0XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWxvdzpcclxuICAgICAgICAgICAgbW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCAvIE1BWF9VX0dFTik7IC8vIE11c3QgY29udmVydCBWIGludG8gYSAlIDAuLk1BWF9VX0dFTlxyXG4gICAgICAgICAgICB2YXIgc3AyID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdlblVsb3dQZXJjLCBzcDIpOyAvLyBVIGxvdyBmb3IgZnJlcSAvIHB1bHNlIGdlblxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VoaWdoOlxyXG4gICAgICAgICAgICBtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcbiAgICAgICAgICAgIHZhciBzcDIgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR2VuVWhpZ2hQZXJjLCBzcDIpOyAvLyBVIGhpZ2ggZm9yIGZyZXEgLyBwdWxzZSBnZW4gICAgICAgICAgICBcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlBvd2VyT2ZmRGVsYXksIHNldHBvaW50KTsgLy8gZGVsYXkgaW4gc2VjXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsOyAvLyBObyBzZXRwb2ludFxyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBoYW5kbGVkXCIpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgc2V0cG9pbnRcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVNldHBvaW50UmVhZChtb2RlKSB7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50KTsgLy8gbVYgb3IgViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQ3VycmVudFNldHBvaW50KTsgLy8gQSBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5SVERUZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UaGVybW9UZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSk7IC8vIEZyZXF1ZW5jeSBzZXRwb2ludCAoVElDS1MpXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbFNldHBvaW50KTsgLy8gbVYvViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBoYW5kbGVkXCIpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSBhbnN3ZXIgYWJvdXQgU2V0cG9pbnRSZWFkXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlZ2lzdGVycyBGQzMgcGFyc2VkIGFuc3dlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSB0aGUgbGFzdCBzZXRwb2ludFxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VTZXRwb2ludFJlYWQoYnVmZmVyLCBtb2RlKSB7XHJcbiAgICAvLyBSb3VuZCB0byB0d28gZGlnaXRzXHJcbiAgICB2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICB2YXIgcm91bmRlZCA9IE1hdGgucm91bmQobW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCkgKiAxMDApIC8gMTAwO1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkN1cnJlbnRcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1BXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIlZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJJbWJhbGFuY2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WL1ZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICB2YXIgdGljazEgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZWdpc3RlcnMsIDApO1xyXG4gICAgICAgICAgICB2YXIgdGljazIgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZWdpc3RlcnMsIDQpO1xyXG4gICAgICAgICAgICB2YXIgZk9OID0gMC4wO1xyXG4gICAgICAgICAgICB2YXIgZk9GRiA9IDAuMDtcclxuICAgICAgICAgICAgaWYgKHRpY2sxICE9IDApXHJcbiAgICAgICAgICAgICAgICBmT04gPSBNYXRoLnJvdW5kKDEgLyAodGljazEgKiAyIC8gMjAwMDAuMCkgKiAxMC4wKSAvIDEwOyAvLyBOZWVkIG9uZSBkZWNpbWFsIHBsYWNlIGZvciBIWlxyXG4gICAgICAgICAgICBpZiAodGljazIgIT0gMClcclxuICAgICAgICAgICAgICAgIGZPRkYgPSBNYXRoLnJvdW5kKDEgLyAodGljazIgKiAyIC8gMjAwMDAuMCkgKiAxMC4wKSAvIDEwOyAvLyBOZWVkIG9uZSBkZWNpbWFsIHBsYWNlIGZvciBIWlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeSBPTlwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBmT04sXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJIelwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeSBPRkZcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VmFsdWVcIjogZk9GRixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VW5pdFwiOiBcIkh6XCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiwrBDXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlVua25vd25cIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIj9cIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgfVxyXG5cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7XHJcbiAgICBNU0NSZWdpc3RlcnMsIG1ha2VTZXJpYWxOdW1iZXIsIG1ha2VDdXJyZW50TW9kZSwgbWFrZUJhdHRlcnlMZXZlbCwgcGFyc2VCYXR0ZXJ5LCBwYXJzZVNlcmlhbE51bWJlcixcclxuICAgIHBhcnNlQ3VycmVudE1vZGUsIG1ha2VNb2RlUmVxdWVzdCwgbWFrZU1lYXN1cmVSZXF1ZXN0LCBwYXJzZU1lYXN1cmUsIG1ha2VRdWFsaXR5Qml0UmVxdWVzdCwgaXNRdWFsaXR5VmFsaWQsXHJcbiAgICBtYWtlR2VuU3RhdHVzUmVhZCwgcGFyc2VHZW5TdGF0dXMsIG1ha2VTZXRwb2ludFJlcXVlc3QsIG1ha2VTZXRwb2ludFJlYWQsIHBhcnNlU2V0cG9pbnRSZWFkfSIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcblxyXG5sZXQgc2xlZXAgPSBtcyA9PiBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxubGV0IHdhaXRGb3IgPSBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yKGYpIHtcclxuICAgIHdoaWxlICghZigpKSBhd2FpdCBzbGVlcCgxMDAgKyBNYXRoLnJhbmRvbSgpICogMjUpO1xyXG4gICAgcmV0dXJuIGYoKTtcclxufTtcclxuXHJcbmxldCB3YWl0Rm9yVGltZW91dCA9IGFzeW5jIGZ1bmN0aW9uIHdhaXRGb3IoZiwgdGltZW91dFNlYykge1xyXG4gICAgdmFyIHRvdGFsVGltZU1zID0gMDtcclxuICAgIHdoaWxlICghZigpICYmIHRvdGFsVGltZU1zIDwgdGltZW91dFNlYyAqIDEwMDApIHtcclxuICAgICAgICB2YXIgZGVsYXlNcyA9IDEwMCArIE1hdGgucmFuZG9tKCkgKiAyNTtcclxuICAgICAgICB0b3RhbFRpbWVNcyArPSBkZWxheU1zO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5TXMpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGYoKTtcclxufTtcclxuXHJcbi8vIFRoZXNlIGZ1bmN0aW9ucyBtdXN0IGV4aXN0IHN0YW5kLWFsb25lIG91dHNpZGUgQ29tbWFuZCBvYmplY3QgYXMgdGhpcyBvYmplY3QgbWF5IGNvbWUgZnJvbSBKU09OIHdpdGhvdXQgdGhlbSFcclxuZnVuY3Rpb24gaXNHZW5lcmF0aW9uKGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGN0eXBlID4gQ29tbWFuZFR5cGUuT0ZGICYmIGN0eXBlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc01lYXN1cmVtZW50KGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGN0eXBlID4gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOICYmIGN0eXBlIDwgQ29tbWFuZFR5cGUuUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzU2V0dGluZyhjdHlwZSkge1xyXG4gICAgcmV0dXJuIChjdHlwZSA9PSBDb21tYW5kVHlwZS5PRkYgfHwgY3R5cGUgPiBDb21tYW5kVHlwZS5TRVRUSU5HX1JFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc1ZhbGlkKGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGlzTWVhc3VyZW1lbnQoY3R5cGUpIHx8IGlzR2VuZXJhdGlvbihjdHlwZSkgfHwgaXNTZXR0aW5nKGN0eXBlKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gY29udmVydCBhIHZhbHVlIGludG8gYW4gZW51bSB2YWx1ZVxyXG4gKiBcclxuICogQHBhcmFtIHt0eXBlfSBlbnVtdHlwZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gZW51bXZhbHVlXHJcbiAqL1xyXG4gZnVuY3Rpb24gUGFyc2UoZW51bXR5cGUsIGVudW12YWx1ZSkge1xyXG4gICAgZm9yICh2YXIgZW51bU5hbWUgaW4gZW51bXR5cGUpIHtcclxuICAgICAgICBpZiAoZW51bXR5cGVbZW51bU5hbWVdID09IGVudW12YWx1ZSkge1xyXG4gICAgICAgICAgICAvKmpzaGludCAtVzA2MSAqL1xyXG4gICAgICAgICAgICByZXR1cm4gZXZhbChbZW51bXR5cGUgKyBcIi5cIiArIGVudW1OYW1lXSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gZHVtcCBhcnJheWJ1ZmZlciBhcyBoZXggc3RyaW5nXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlclxyXG4gKi9cclxuIGZ1bmN0aW9uIGJ1ZjJoZXgoYnVmZmVyKSB7IC8vIGJ1ZmZlciBpcyBhbiBBcnJheUJ1ZmZlclxyXG4gICAgcmV0dXJuIFsuLi5uZXcgVWludDhBcnJheShidWZmZXIpXVxyXG4gICAgICAgIC5tYXAoeCA9PiB4LnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKVxyXG4gICAgICAgIC5qb2luKCcgJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhleDJidWYgKGlucHV0KSB7XHJcbiAgICBpZiAodHlwZW9mIGlucHV0ICE9PSAnc3RyaW5nJykge1xyXG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0V4cGVjdGVkIGlucHV0IHRvIGJlIGEgc3RyaW5nJylcclxuICAgIH1cclxuICAgIHZhciBoZXhzdHIgPSBpbnB1dC5yZXBsYWNlKC9cXHMrL2csICcnKTtcclxuICAgIGlmICgoaGV4c3RyLmxlbmd0aCAlIDIpICE9PSAwKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoJ0V4cGVjdGVkIHN0cmluZyB0byBiZSBhbiBldmVuIG51bWJlciBvZiBjaGFyYWN0ZXJzJylcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IFVpbnQ4QXJyYXkoaGV4c3RyLmxlbmd0aCAvIDIpXHJcblxyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBoZXhzdHIubGVuZ3RoOyBpICs9IDIpIHtcclxuICAgICAgICB2aWV3W2kgLyAyXSA9IHBhcnNlSW50KGhleHN0ci5zdWJzdHJpbmcoaSwgaSArIDIpLCAxNilcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gdmlldy5idWZmZXJcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IHNsZWVwLCB3YWl0Rm9yLCB3YWl0Rm9yVGltZW91dCwgaXNHZW5lcmF0aW9uLCBpc01lYXN1cmVtZW50LCBpc1NldHRpbmcsIGlzVmFsaWQsIFBhcnNlLCBidWYyaGV4LCBoZXgyYnVmIH07Il19
