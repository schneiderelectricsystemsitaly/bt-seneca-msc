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
    const crc = crc16(new Uint8Array(buf.slice(0, -2)))
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

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY2xhc3Nlcy9TZW5lY2FNU0MuanMiLCJjb25zdGFudHMuanMiLCJtZXRlckFwaS5qcyIsIm1ldGVyUHVibGljQVBJLmpzIiwibW9kYnVzUnR1LmpzIiwibW9kYnVzVGVzdERhdGEuanMiLCJub2RlX21vZHVsZXMvbG9nbGV2ZWwvbGliL2xvZ2xldmVsLmpzIiwic2VuZWNhTW9kYnVzLmpzIiwidXRpbHMuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6UUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxNUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbnBCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCIndXNlIHN0cmljdCc7XHJcblxyXG4vKipcclxuICogIEJsdWV0b290aCBoYW5kbGluZyBtb2R1bGUsIGluY2x1ZGluZyBtYWluIHN0YXRlIG1hY2hpbmUgbG9vcC5cclxuICogIFRoaXMgbW9kdWxlIGludGVyYWN0cyB3aXRoIGJyb3dzZXIgZm9yIGJsdWV0b290aCBjb211bmljYXRpb25zIGFuZCBwYWlyaW5nLCBhbmQgd2l0aCBTZW5lY2FNU0Mgb2JqZWN0LlxyXG4gKi9cclxuXHJcbnZhciBBUElTdGF0ZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9BUElTdGF0ZScpO1xyXG52YXIgbG9nID0gcmVxdWlyZSgnbG9nbGV2ZWwnKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcclxudmFyIHNlbmVjYU1vZHVsZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9TZW5lY2FNU0MnKTtcclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoJy4vbW9kYnVzUnR1Jyk7XHJcbnZhciB0ZXN0RGF0YSA9IHJlcXVpcmUoJy4vbW9kYnVzVGVzdERhdGEnKTtcclxuXHJcbnZhciBidFN0YXRlID0gQVBJU3RhdGUuYnRTdGF0ZTtcclxudmFyIFN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbnZhciBSZXN1bHRDb2RlID0gY29uc3RhbnRzLlJlc3VsdENvZGU7XHJcbnZhciBzaW11bGF0aW9uID0gZmFsc2U7XHJcbnZhciBsb2dnaW5nID0gZmFsc2U7XHJcbi8qXHJcbiAqIEJsdWV0b290aCBjb25zdGFudHNcclxuICovXHJcbmNvbnN0IEJsdWVUb290aE1TQyA9IHtcclxuICAgIFNlcnZpY2VVdWlkOiAnMDAwM2NkZDAtMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxJywgLy8gYmx1ZXRvb3RoIG1vZGJ1cyBSVFUgc2VydmljZSBmb3IgU2VuZWNhIE1TQ1xyXG4gICAgTW9kYnVzQW5zd2VyVXVpZDogJzAwMDNjZGQxLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMScsICAgICAvLyBtb2RidXMgUlRVIGFuc3dlcnNcclxuICAgIE1vZGJ1c1JlcXVlc3RVdWlkOiAnMDAwM2NkZDItMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxJyAgICAvLyBtb2RidXMgUlRVIHJlcXVlc3RzXHJcbn07XHJcblxyXG5cclxuLyoqXHJcbiAqIFNlbmQgdGhlIG1lc3NhZ2UgdXNpbmcgQmx1ZXRvb3RoIGFuZCB3YWl0IGZvciBhbiBhbnN3ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gY29tbWFuZCBtb2RidXMgUlRVIHBhY2tldCB0byBzZW5kXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gdGhlIG1vZGJ1cyBSVFUgYW5zd2VyXHJcbiAqL1xyXG4gYXN5bmMgZnVuY3Rpb24gU2VuZEFuZFJlc3BvbnNlKGNvbW1hbmQpIHtcclxuXHJcbiAgICBpZiAoY29tbWFuZCA9PSBudWxsKVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG5cclxuICAgIGxvZy5kZWJ1ZyhcIj4+IFwiICsgdXRpbHMuYnVmMmhleChjb21tYW5kKSk7XHJcblxyXG4gICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICBidFN0YXRlLnN0YXRzW1wicmVxdWVzdHNcIl0rKztcclxuXHJcbiAgICB2YXIgc3RhcnRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICBpZiAoc2ltdWxhdGlvbikge1xyXG4gICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBmYWtlUmVzcG9uc2UoY29tbWFuZCk7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoNSk7XHJcbiAgICB9XHJcbiAgICBlbHNlIHtcclxuICAgICAgICBhd2FpdCBidFN0YXRlLmNoYXJXcml0ZS53cml0ZVZhbHVlV2l0aG91dFJlc3BvbnNlKGNvbW1hbmQpO1xyXG4gICAgICAgIHdoaWxlIChidFN0YXRlLnN0YXRlID09IFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORyB8fFxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRlID09IFN0YXRlLkJVU1kpIHtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUucmVzcG9uc2UgIT0gbnVsbCkgYnJlYWs7XHJcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAzNSkpO1xyXG4gICAgICAgIH0gICAgXHJcbiAgICB9XHJcbiAgICBcclxuICAgIHZhciBlbmRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblxyXG4gICAgdmFyIGFuc3dlciA9IGJ0U3RhdGUucmVzcG9uc2U/LnNsaWNlKCk7XHJcbiAgICBidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuICAgIFxyXG4gICAgLy8gTG9nIHRoZSBwYWNrZXRzXHJcbiAgICBpZiAobG9nZ2luZykge1xyXG4gICAgICAgIHZhciBwYWNrZXQgPSB7J3JlcXVlc3QnOiB1dGlscy5idWYyaGV4KGNvbW1hbmQpLCAnYW5zd2VyJzogdXRpbHMuYnVmMmhleChhbnN3ZXIpfTtcclxuICAgICAgICB2YXIgcGFja2V0cyA9IHdpbmRvdy5sb2NhbFN0b3JhZ2UuZ2V0SXRlbShcIk1vZGJ1c1JUVXRyYWNlXCIpO1xyXG4gICAgICAgIGlmIChwYWNrZXRzID09IG51bGwpXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICBwYWNrZXRzID0gW107IC8vIGluaXRpYWxpemUgYXJyYXlcclxuICAgICAgICB9XHJcbiAgICAgICAgZWxzZVxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgcGFja2V0cyA9IEpTT04ucGFyc2UocGFja2V0cyk7IC8vIFJlc3RvcmUgdGhlIGpzb24gcGVyc2lzdGVkIG9iamVjdFxyXG4gICAgICAgIH1cclxuICAgICAgICBwYWNrZXRzLnB1c2gocGFja2V0KTsgLy8gQWRkIHRoZSBuZXcgb2JqZWN0XHJcbiAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5zZXRJdGVtKFwiTW9kYnVzUlRVdHJhY2VcIiwgSlNPTi5zdHJpbmdpZnkocGFja2V0cykpO1xyXG4gICAgfVxyXG5cclxuICAgIGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKCgxLjAgKiBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdICogKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgKGVuZFRpbWUgLSBzdGFydFRpbWUpKSAvICgoYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSAlIDUwMCkgKyAxKSk7XHJcbiAgICBidFN0YXRlLnN0YXRzW1wibGFzdFJlc3BvbnNlVGltZVwiXSA9IE1hdGgucm91bmQoZW5kVGltZSAtIHN0YXJ0VGltZSkgKyBcIiBtc1wiO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSsrO1xyXG5cclxuICAgIHJldHVybiBhbnN3ZXI7XHJcbn1cclxuXHJcbmxldCBzZW5lY2FNU0MgPSBuZXcgc2VuZWNhTW9kdWxlLlNlbmVjYU1TQyhTZW5kQW5kUmVzcG9uc2UpO1xyXG5cclxuLyoqXHJcbiAqIE1haW4gbG9vcCBvZiB0aGUgbWV0ZXIgaGFuZGxlci5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gc3RhdGVNYWNoaW5lKCkge1xyXG4gICAgdmFyIG5leHRBY3Rpb247XHJcbiAgICB2YXIgREVMQVlfTVMgPSAoc2ltdWxhdGlvbj8yMDo3NTApOyAvLyBVcGRhdGUgdGhlIHN0YXR1cyBldmVyeSBYIG1zLlxyXG4gICAgdmFyIFRJTUVPVVRfTVMgPSAoc2ltdWxhdGlvbj8xMDAwOjMwMDAwKTsgLy8gR2l2ZSB1cCBzb21lIG9wZXJhdGlvbnMgYWZ0ZXIgWCBtcy5cclxuICAgIGJ0U3RhdGUuc3RhcnRlZCA9IHRydWU7XHJcblxyXG4gICAgbG9nLmRlYnVnKFwiQ3VycmVudCBzdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG5cclxuICAgIC8vIENvbnNlY3V0aXZlIHN0YXRlIGNvdW50ZWQuIENhbiBiZSB1c2VkIHRvIHRpbWVvdXQuXHJcbiAgICBpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBidFN0YXRlLnByZXZfc3RhdGUpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCsrO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3RvcCByZXF1ZXN0IGZyb20gQVBJXHJcbiAgICBpZiAoYnRTdGF0ZS5zdG9wUmVxdWVzdCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUElORztcclxuICAgIH1cclxuXHJcbiAgICBsb2cuZGVidWcoXCJcXFN0YXRlOlwiICsgYnRTdGF0ZS5zdGF0ZSk7XHJcbiAgICBzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuICAgICAgICBjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6IC8vIGluaXRpYWwgc3RhdGUgb24gU3RhcnQoKVxyXG4gICAgICAgICAgICBpZiAoc2ltdWxhdGlvbil7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gZmFrZVBhaXJEZXZpY2U7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRQYWlyRGV2aWNlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuQ09OTkVDVElORzogLy8gd2FpdGluZyBmb3IgY29ubmVjdGlvbiB0byBjb21wbGV0ZVxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkRFVklDRV9QQUlSRUQ6IC8vIGNvbm5lY3Rpb24gY29tcGxldGUsIGFjcXVpcmUgbWV0ZXIgc3RhdGVcclxuICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGZha2VTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVUJTQ1JJQklORzogLy8gd2FpdGluZyBmb3IgQmx1ZXRvb3RoIGludGVyZmFjZXNcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCJUaW1lb3V0IGluIFNVQlNDUklCSU5HXCIpO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5NRVRFUl9JTklUOiAvLyByZWFkeSB0byBjb21tdW5pY2F0ZSwgYWNxdWlyZSBtZXRlciBzdGF0dXNcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IG1ldGVySW5pdDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc6IC8vIHJlYWRpbmcgdGhlIG1ldGVyIHN0YXR1c1xyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5zdGF0ZV9jcHQgPiAoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCJUaW1lb3V0IGluIE1FVEVSX0lOSVRJQUxJWklOR1wiKTtcclxuICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBmYWtlU3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5JRExFOiAvLyByZWFkeSB0byBwcm9jZXNzIGNvbW1hbmRzIGZyb20gQVBJXHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbClcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBwcm9jZXNzQ29tbWFuZDtcclxuICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gcmVmcmVzaDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkVSUk9SOiAvLyBhbnl0aW1lIGFuIGVycm9yIGhhcHBlbnNcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuQlVTWTogLy8gd2hpbGUgYSBjb21tYW5kIGluIGdvaW5nIG9uXHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IChUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcbiAgICAgICAgICAgICAgICBsb2cud2FybihcIlRpbWVvdXQgaW4gQlVTWVwiKTtcclxuICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgaWYgKHNpbXVsYXRpb24pe1xyXG4gICAgICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBmYWtlU3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVE9QUElORzpcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBFRDogLy8gYWZ0ZXIgYSBkaXNjb25uZWN0b3Igb3IgU3RvcCgpIHJlcXVlc3QsIHN0b3BzIHRoZSBzdGF0ZSBtYWNoaW5lLlxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgIH1cclxuXHJcbiAgICBidFN0YXRlLnByZXZfc3RhdGUgPSBidFN0YXRlLnN0YXRlO1xyXG5cclxuICAgIGlmIChuZXh0QWN0aW9uICE9IHVuZGVmaW5lZCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdEV4ZWN1dGluZzpcIiArIG5leHRBY3Rpb24ubmFtZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgbmV4dEFjdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCJFeGNlcHRpb24gaW4gc3RhdGUgbWFjaGluZVwiLCBlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEKSB7XHJcbiAgICAgICAgdXRpbHMuc2xlZXAoREVMQVlfTVMpLnRoZW4oKCkgPT4gc3RhdGVNYWNoaW5lKCkpOyAvLyBSZWNoZWNrIHN0YXR1cyBpbiBERUxBWV9NUyBtc1xyXG4gICAgfVxyXG4gICAgZWxzZSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0VGVybWluYXRpbmcgU3RhdGUgbWFjaGluZVwiKTtcclxuICAgICAgICBidFN0YXRlLnN0YXJ0ZWQgPSBmYWxzZTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIENhbGxlZCBmcm9tIHN0YXRlIG1hY2hpbmUgdG8gZXhlY3V0ZSBhIHNpbmdsZSBjb21tYW5kIGZyb20gYnRTdGF0ZS5jb21tYW5kIHByb3BlcnR5XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kKCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICB2YXIgY29tbWFuZCA9IGJ0U3RhdGUuY29tbWFuZDtcclxuICAgICAgICB2YXIgcmVzdWx0ID0gUmVzdWx0Q29kZS5TVUNDRVNTO1xyXG4gICAgICAgIHZhciBwYWNrZXQsIHJlc3BvbnNlLCBzdGFydEdlbjtcclxuXHJcbiAgICAgICAgaWYgKGNvbW1hbmQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJjb21tYW5kc1wiXSsrO1xyXG5cclxuICAgICAgICBsb2cuaW5mbygnXFx0XFx0RXhlY3V0aW5nIGNvbW1hbmQgOicgKyBjb21tYW5kKTtcclxuXHJcbiAgICAgICAgLy8gRmlyc3Qgc2V0IE5PTkUgYmVjYXVzZSB3ZSBkb24ndCB3YW50IHRvIHdyaXRlIG5ldyBzZXRwb2ludHMgd2l0aCBhY3RpdmUgZ2VuZXJhdGlvblxyXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy5zd2l0Y2hPZmYoKTtcclxuICAgICAgICBpZiAocmVzdWx0ICE9IFJlc3VsdENvZGUuU1VDQ0VTUykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3Qgc3dpdGNoIG1ldGVyIG9mZiBiZWZvcmUgY29tbWFuZCB3cml0ZSFcIik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIFxyXG4gICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgc2V0cG9pbnQgb3Igc2V0dGluZ1xyXG4gICAgICAgIGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHNlbmVjYU1TQy53cml0ZVNldHBvaW50cyhjb21tYW5kLnR5cGUsIGNvbW1hbmQuc2V0cG9pbnQsIGNvbW1hbmQuc2V0cG9pbnQyKTtcclxuICAgICAgICAgICAgaWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gd3JpdGUgc2V0cG9pbnRzIVwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKCF1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBcclxuICAgICAgICAgICAgdXRpbHMuaXNWYWxpZChjb21tYW5kLnR5cGUpICYmIGNvbW1hbmQudHlwZSAhPSBDb21tYW5kVHlwZS5PRkYpICAvLyBJRiB0aGlzIGlzIGEgc2V0dGluZywgd2UncmUgZG9uZS5cclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgbW9kZSBzZXRcclxuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgc2VuZWNhTVNDLmNoYW5nZU1vZGUoY29tbWFuZC50eXBlKTtcclxuICAgICAgICAgICAgaWYgKHJlc3VsdCAhPSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gY2hhbmdlIG1ldGVyIG1vZGUhXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBDYWxsZXIgZXhwZWN0cyBhIHZhbGlkIHByb3BlcnR5IGluIEdldFN0YXRlKCkgb25jZSBjb21tYW5kIGlzIGV4ZWN1dGVkLlxyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlZnJlc2hpbmcgY3VycmVudCBzdGF0ZVwiKTtcclxuICAgICAgICBhd2FpdCByZWZyZXNoKCk7XHJcblxyXG4gICAgICAgIGNvbW1hbmQuZXJyb3IgPSBmYWxzZTtcclxuICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICBidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG5cclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuSURMRTtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRDb21wbGV0ZWQgY29tbWFuZCBleGVjdXRlZFwiKTtcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cuZXJyb3IoXCIqKiBlcnJvciB3aGlsZSBleGVjdXRpbmcgY29tbWFuZDogXCIgKyBlcnIpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdldEV4cGVjdGVkU3RhdGVIZXgoKSB7XHJcbi8vIFNpbXVsYXRlIGN1cnJlbnQgbW9kZSBhbnN3ZXIgYWNjb3JkaW5nIHRvIGxhc3QgY29tbWFuZC5cclxuICAgIHZhciBzdGF0ZUhleCA9IChDb21tYW5kVHlwZS5PRkYpLnRvU3RyaW5nKDE2KTtcclxuICAgIGlmIChidFN0YXRlLmNvbW1hbmQ/LnR5cGUgIT0gbnVsbClcclxuICAgIHtcclxuICAgICAgICBzdGF0ZUhleCA9IChidFN0YXRlLmNvbW1hbmQudHlwZSkudG9TdHJpbmcoMTYpO1xyXG4gICAgfVxyXG4gICAgLy8gQWRkIHRyYWlsaW5nIDBcclxuICAgIHdoaWxlKHN0YXRlSGV4Lmxlbmd0aCA8IDIpXHJcbiAgICAgICAgc3RhdGVIZXggPSBcIjBcIiArIHN0YXRlSGV4O1xyXG4gICAgcmV0dXJuIHN0YXRlSGV4O1xyXG59XHJcbi8qKlxyXG4gKiBVc2VkIHRvIHNpbXVsYXRlIFJUVSBhbnN3ZXJzXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGNvbW1hbmQgcmVhbCByZXF1ZXN0XHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gZmFrZSBhbnN3ZXJcclxuICovXHJcbmZ1bmN0aW9uIGZha2VSZXNwb25zZShjb21tYW5kKSB7XHJcbiAgICB2YXIgY29tbWFuZEhleCA9IHV0aWxzLmJ1ZjJoZXgoY29tbWFuZCk7XHJcbiAgICB2YXIgZm9yZ2VkQW5zd2VycyA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgJzE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkJyA6ICcxOSAwMyAwMiAwMCcgKyBnZXRFeHBlY3RlZFN0YXRlSGV4KCkgKycgJCQkJCcsIC8vIEN1cnJlbnQgc3RhdGVcclxuICAgICAgICAgICAgICAgICAgICAgJ2RlZmF1bHQgMDMnIDogJzE5IDAzIDA2IDAwMDEgMDAwMSAwMDAxICQkJCQnLCAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMzXHJcbiAgICAgICAgICAgICAgICAgICAgICdkZWZhdWx0IDEwJyA6ICcxOSAxMCAwMCBkNCAwMCAwMiAwMDAxIDAwMDEgJCQkJCd9OyAvLyBkZWZhdWx0IGFuc3dlciBmb3IgRkMxMFxyXG5cclxuICAgIC8vIFN0YXJ0IHdpdGggdGhlIGRlZmF1bHQgYW5zd2VyXHJcbiAgICB2YXIgcmVzcG9uc2VIZXggPSBmb3JnZWRBbnN3ZXJzWydkZWZhdWx0ICcgKyBjb21tYW5kSGV4LnNwbGl0KCcgJylbMV1dO1xyXG5cclxuICAgIC8vIERvIHdlIGhhdmUgYSBmb3JnZWQgYW5zd2VyP1xyXG4gICAgaWYgKGZvcmdlZEFuc3dlcnNbY29tbWFuZEhleF0gIT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgcmVzcG9uc2VIZXggPSBmb3JnZWRBbnN3ZXJzW2NvbW1hbmRIZXhdO1xyXG4gICAgfVxyXG4gICAgZWxzZVxyXG4gICAge1xyXG4gICAgICAgIC8vIExvb2sgaW50byByZWdpc3RlcmVkIHRyYWNlc1xyXG4gICAgICAgIGZvdW5kID0gW107XHJcbiAgICAgICAgZm9yKGNvbnN0IHRyYWNlIG9mIHRlc3REYXRhLnRlc3RUcmFjZXMpIHtcclxuICAgICAgICAgICAgaWYgKHRyYWNlW1wicmVxdWVzdFwiXSA9PT0gY29tbWFuZEhleCkge1xyXG4gICAgICAgICAgICAgICAgZm91bmQucHVzaCh0cmFjZVtcImFuc3dlclwiXSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZvdW5kLmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgICAgLy8gU2VsZWN0IGEgcmFuZG9tIGFuc3dlciBmcm9tIHRoZSByZWdpc3RlcmVkIHRyYWNlXHJcbiAgICAgICAgICAgIHJlc3BvbnNlSGV4ID0gZm91bmRbTWF0aC5mbG9vcigoTWF0aC5yYW5kb20oKSpmb3VuZC5sZW5ndGgpKV07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2VcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIGNvbnNvbGUuaW5mbyhjb21tYW5kSGV4ICsgXCIgbm90IGZvdW5kIGluIHRlc3QgdHJhY2VzXCIpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIFxyXG4gICAgLy8gQ29tcHV0ZSBDUkMgaWYgbmVlZGVkXHJcbiAgICBpZiAocmVzcG9uc2VIZXguaW5jbHVkZXMoXCIkJCQkXCIpKSB7XHJcbiAgICAgICAgcmVzcG9uc2VIZXggPSByZXNwb25zZUhleC5yZXBsYWNlKCckJCQkJywnJyk7XHJcbiAgICAgICAgdmFyIGNyYyA9IG1vZGJ1cy5jcmMxNihuZXcgVWludDhBcnJheSh1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KSkpLnRvU3RyaW5nKDE2KTtcclxuICAgICAgICB3aGlsZShjcmMubGVuZ3RoIDwgNClcclxuICAgICAgICAgICAgY3JjID0gXCIwXCIgKyBjcmM7XHJcbiAgICAgICAgcmVzcG9uc2VIZXggPSByZXNwb25zZUhleCArIGNyYy5zdWJzdHJpbmcoMiw0KSArIGNyYy5zdWJzdHJpbmcoMCwyKTtcclxuICAgIH1cclxuXHJcbiAgICBsb2cuZGVidWcoXCI8PCBcIiArIHJlc3BvbnNlSGV4KTtcclxuICAgIHJldHVybiB1dGlscy5oZXgyYnVmKHJlc3BvbnNlSGV4KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFjcXVpcmUgdGhlIGN1cnJlbnQgbW9kZSBhbmQgc2VyaWFsIG51bWJlciBvZiB0aGUgZGV2aWNlLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBtZXRlckluaXQoKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc7XHJcbiAgICAgICAgYnRTdGF0ZS5tZXRlci5zZXJpYWwgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0U2VyaWFsTnVtYmVyKCk7XHJcbiAgICAgICAgbG9nLmluZm8oJ1xcdFxcdFNlcmlhbCBudW1iZXI6JyArIGJ0U3RhdGUubWV0ZXIuc2VyaWFsKTtcclxuXHJcbiAgICAgICAgYnRTdGF0ZS5tZXRlci5tb2RlID0gYXdhaXQgc2VuZWNhTVNDLmdldEN1cnJlbnRNb2RlKCk7XHJcbiAgICAgICAgbG9nLmRlYnVnKCdcXHRcXHRDdXJyZW50IG1vZGU6JyArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblxyXG4gICAgICAgIGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSA9IGF3YWl0IHNlbmVjYU1TQy5nZXRCYXR0ZXJ5Vm9sdGFnZSgpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnXFx0XFx0QmF0dGVyeSAoVik6JyArIGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSk7XHJcblxyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgaW5pdGlhbGl6aW5nIG1ldGVyIDpcIiArIGVycik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKlxyXG4gKiBDbG9zZSB0aGUgYmx1ZXRvb3RoIGludGVyZmFjZSAodW5wYWlyKVxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBkaXNjb25uZWN0KCkge1xyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgICAgICBsb2cud2FybihcIiogQ2FsbGluZyBkaXNjb25uZWN0IG9uIGJ0ZGV2aWNlXCIpO1xyXG4gICAgICAgICAgICAgICAgLy8gQXZvaWQgdGhlIGV2ZW50IGZpcmluZyB3aGljaCBtYXkgbGVhZCB0byBhdXRvLXJlY29ubmVjdFxyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5idERldmljZS5yZW1vdmVFdmVudExpc3RlbmVyKCdnYXR0c2VydmVyZGlzY29ubmVjdGVkJywgb25EaXNjb25uZWN0ZWQpO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5idERldmljZS5nYXR0LmRpc2Nvbm5lY3QoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjYXRjaCB7IH1cclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUEVEO1xyXG59XHJcblxyXG4vKipcclxuICogRXZlbnQgY2FsbGVkIGJ5IGJyb3dzZXIgQlQgYXBpIHdoZW4gdGhlIGRldmljZSBkaXNjb25uZWN0XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIG9uRGlzY29ubmVjdGVkKCkge1xyXG4gICAgbG9nLndhcm4oXCIqIEdBVFQgU2VydmVyIGRpc2Nvbm5lY3RlZCBldmVudCwgd2lsbCB0cnkgdG8gcmVjb25uZWN0ICpcIik7XHJcbiAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICBidFN0YXRlLnN0YXRzW1wiR0FUVCBkaXNjb25uZWN0c1wiXSsrO1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7IC8vIFRyeSB0byBhdXRvLXJlY29ubmVjdCB0aGUgaW50ZXJmYWNlcyB3aXRob3V0IHBhaXJpbmdcclxufVxyXG5cclxuLyoqXHJcbiAqIEpvaW5zIHRoZSBhcmd1bWVudHMgaW50byBhIHNpbmdsZSBidWZmZXJcclxuICogQHJldHVybnMge0J1ZmZlcn0gY29uY2F0ZW5hdGVkIGJ1ZmZlclxyXG4gKi9cclxuZnVuY3Rpb24gYXJyYXlCdWZmZXJDb25jYXQoKSB7XHJcbiAgICB2YXIgbGVuZ3RoID0gMDtcclxuICAgIHZhciBidWZmZXIgPSBudWxsO1xyXG5cclxuICAgIGZvciAodmFyIGkgaW4gYXJndW1lbnRzKSB7XHJcbiAgICAgICAgYnVmZmVyID0gYXJndW1lbnRzW2ldO1xyXG4gICAgICAgIGxlbmd0aCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgam9pbmVkID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcclxuICAgIHZhciBvZmZzZXQgPSAwO1xyXG5cclxuICAgIGZvciAoaSBpbiBhcmd1bWVudHMpIHtcclxuICAgICAgICBidWZmZXIgPSBhcmd1bWVudHNbaV07XHJcbiAgICAgICAgam9pbmVkLnNldChuZXcgVWludDhBcnJheShidWZmZXIpLCBvZmZzZXQpO1xyXG4gICAgICAgIG9mZnNldCArPSBidWZmZXIuYnl0ZUxlbmd0aDtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gam9pbmVkLmJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBibHVldG9vdGggY2hhcmFjdGVyaXN0aWNzIHdoZW4gcmVjZWl2aW5nIGRhdGFcclxuICogQHBhcmFtIHthbnl9IGV2ZW50XHJcbiAqL1xyXG5mdW5jdGlvbiBoYW5kbGVOb3RpZmljYXRpb25zKGV2ZW50KSB7XHJcbiAgICBsZXQgdmFsdWUgPSBldmVudC50YXJnZXQudmFsdWU7XHJcbiAgICBpZiAodmFsdWUgIT0gbnVsbCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPDwgJyArIHV0aWxzLmJ1ZjJoZXgodmFsdWUuYnVmZmVyKSk7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUucmVzcG9uc2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gYXJyYXlCdWZmZXJDb25jYXQoYnRTdGF0ZS5yZXNwb25zZSwgdmFsdWUuYnVmZmVyKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gdmFsdWUuYnVmZmVyLnNsaWNlKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogVGhpcyBmdW5jdGlvbiB3aWxsIHN1Y2NlZWQgb25seSBpZiBjYWxsZWQgYXMgYSBjb25zZXF1ZW5jZSBvZiBhIHVzZXItZ2VzdHVyZVxyXG4gKiBFLmcuIGJ1dHRvbiBjbGljay4gVGhpcyBpcyBkdWUgdG8gQmx1ZVRvb3RoIEFQSSBzZWN1cml0eSBtb2RlbC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gYnRQYWlyRGV2aWNlKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcbiAgICB2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuICAgIGxvZy5kZWJ1ZyhcImJ0UGFpckRldmljZShcIiArIGZvcmNlU2VsZWN0aW9uICsgXCIpXCIpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBpZiAodHlwZW9mIChuYXZpZ2F0b3IuYmx1ZXRvb3RoPy5nZXRBdmFpbGFiaWxpdHkpID09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmlsaXR5ID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aC5nZXRBdmFpbGFiaWxpdHkoKTtcclxuICAgICAgICAgICAgaWYgKCFhdmFpbGFiaWxpdHkpIHtcclxuICAgICAgICAgICAgICAgIGxvZy5lcnJvcihcIkJsdWV0b290aCBub3QgYXZhaWxhYmxlIGluIGJyb3dzZXIuXCIpO1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQnJvd3NlciBkb2VzIG5vdCBwcm92aWRlIGJsdWV0b290aFwiKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgZGV2aWNlID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gRG8gd2UgYWxyZWFkeSBoYXZlIHBlcm1pc3Npb24/XHJcbiAgICAgICAgaWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0RGV2aWNlcykgPT0gJ2Z1bmN0aW9uJ1xyXG4gICAgICAgICAgICAmJiAhZm9yY2VTZWxlY3Rpb24pIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlRGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0RGV2aWNlcygpO1xyXG4gICAgICAgICAgICBhdmFpbGFibGVEZXZpY2VzLmZvckVhY2goZnVuY3Rpb24gKGRldiwgaW5kZXgpIHtcclxuICAgICAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIkZvdW5kIGF1dGhvcml6ZWQgZGV2aWNlIDpcIiArIGRldi5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGlmIChkZXYubmFtZS5zdGFydHNXaXRoKFwiTVNDXCIpKVxyXG4gICAgICAgICAgICAgICAgICAgIGRldmljZSA9IGRldjtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIm5hdmlnYXRvci5ibHVldG9vdGguZ2V0RGV2aWNlcygpPVwiICsgZGV2aWNlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gSWYgbm90LCByZXF1ZXN0IGZyb20gdXNlclxyXG4gICAgICAgIGlmIChkZXZpY2UgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBkZXZpY2UgPSBhd2FpdCBuYXZpZ2F0b3IuYmx1ZXRvb3RoXHJcbiAgICAgICAgICAgICAgICAucmVxdWVzdERldmljZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgYWNjZXB0QWxsRGV2aWNlczogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgZmlsdGVyczogW3sgbmFtZVByZWZpeDogJ01TQycgfV0sXHJcbiAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWxTZXJ2aWNlczogW0JsdWVUb290aE1TQy5TZXJ2aWNlVXVpZF1cclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmJ0RGV2aWNlID0gZGV2aWNlO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGxvZy5pbmZvKFwiQmx1ZXRvb3RoIGRldmljZSBcIiArIGRldmljZS5uYW1lICsgXCIgY29ubmVjdGVkLlwiKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MDApO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxvZy53YXJuKFwiKiogZXJyb3Igd2hpbGUgY29ubmVjdGluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgIGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkVSUk9SO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZha2VQYWlyRGV2aWNlKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkNPTk5FQ1RJTkc7XHJcbiAgICB2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuICAgIGxvZy5kZWJ1ZyhcImZha2VQYWlyRGV2aWNlKFwiICsgZm9yY2VTZWxlY3Rpb24gKyBcIilcIik7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIHZhciBkZXZpY2UgPSB7IG5hbWUgOiBcIkZha2VCVERldmljZVwiLCBnYXR0OiB7Y29ubmVjdGVkOnRydWV9fTtcclxuICAgICAgICBidFN0YXRlLmJ0RGV2aWNlID0gZGV2aWNlO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGxvZy5pbmZvKFwiQmx1ZXRvb3RoIGRldmljZSBcIiArIGRldmljZS5uYW1lICsgXCIgY29ubmVjdGVkLlwiKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MCk7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBjb25uZWN0aW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogT25jZSB0aGUgZGV2aWNlIGlzIGF2YWlsYWJsZSwgaW5pdGlhbGl6ZSB0aGUgc2VydmljZSBhbmQgdGhlIDIgY2hhcmFjdGVyaXN0aWNzIG5lZWRlZC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gYnRTdWJzY3JpYmUoKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVUJTQ1JJQklORztcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wic3ViY3JpYmVzXCJdKys7XHJcbiAgICAgICAgbGV0IGRldmljZSA9IGJ0U3RhdGUuYnREZXZpY2U7XHJcbiAgICAgICAgbGV0IHNlcnZlciA9IG51bGw7XHJcblxyXG4gICAgICAgIGlmICghZGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKGBDb25uZWN0aW5nIHRvIEdBVFQgU2VydmVyIG9uICR7ZGV2aWNlLm5hbWV9Li4uYCk7XHJcbiAgICAgICAgICAgIGRldmljZS5hZGRFdmVudExpc3RlbmVyKCdnYXR0c2VydmVyZGlzY29ubmVjdGVkJywgb25EaXNjb25uZWN0ZWQpO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnRTZXJ2aWNlPy5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBidFN0YXRlLmJ0U2VydmljZS5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikgeyB9XHJcblxyXG4gICAgICAgICAgICBzZXJ2ZXIgPSBhd2FpdCBkZXZpY2UuZ2F0dC5jb25uZWN0KCk7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBHQVRUIHNlcnZlcicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCdHQVRUIGFscmVhZHkgY29ubmVjdGVkJyk7XHJcbiAgICAgICAgICAgIHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBhd2FpdCBzZXJ2ZXIuZ2V0UHJpbWFyeVNlcnZpY2UoQmx1ZVRvb3RoTVNDLlNlcnZpY2VVdWlkKTtcclxuICAgICAgICBpZiAoYnRTdGF0ZS5idFNlcnZpY2UgPT0gbnVsbClcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR0FUVCBTZXJ2aWNlIHJlcXVlc3QgZmFpbGVkXCIpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBTZXJpYWwgc2VydmljZScpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c1JlcXVlc3RVdWlkKTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgd3JpdGUgY2hhcmFjdGVyaXN0aWMnKTtcclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c0Fuc3dlclV1aWQpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZC5hZGRFdmVudExpc3RlbmVyKCdjaGFyYWN0ZXJpc3RpY3ZhbHVlY2hhbmdlZCcsIGhhbmRsZU5vdGlmaWNhdGlvbnMpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RhcnROb3RpZmljYXRpb25zKCk7XHJcbiAgICAgICAgbG9nLmluZm8oJz4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MCk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVQ7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUuY2hhclJlYWQgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQuZGlzY29ubmVjdCgpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmYWtlU3Vic2NyaWJlKCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1VCU0NSSUJJTkc7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcInN1YmNyaWJlc1wiXSsrO1xyXG4gICAgICAgIGxldCBkZXZpY2UgPSBidFN0YXRlLmJ0RGV2aWNlO1xyXG4gICAgICAgIGxldCBzZXJ2ZXIgPSBudWxsO1xyXG5cclxuICAgICAgICBpZiAoIWRldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhgQ29ubmVjdGluZyB0byBHQVRUIFNlcnZlciBvbiAke2RldmljZS5uYW1lfS4uLmApO1xyXG4gICAgICAgICAgICBkZXZpY2VbJ2dhdHQnXVsnY29ubmVjdGVkJ109dHJ1ZTtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCc+IEZvdW5kIEdBVFQgc2VydmVyJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoJ0dBVFQgYWxyZWFkeSBjb25uZWN0ZWQnKTtcclxuICAgICAgICAgICAgc2VydmVyID0gZGV2aWNlLmdhdHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IHt9O1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBTZXJpYWwgc2VydmljZScpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0ge307XHJcbiAgICAgICAgbG9nLmRlYnVnKCc+IEZvdW5kIHdyaXRlIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IHt9O1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICAgICAgbG9nLmluZm8oJz4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMCk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVQ7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICB9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogV2hlbiBpZGxlLCB0aGlzIGZ1bmN0aW9uIGlzIGNhbGxlZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkJVU1k7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIC8vIENoZWNrIHRoZSBtb2RlIGZpcnN0XHJcbiAgICAgICAgdmFyIG1vZGUgPSBhd2FpdCBzZW5lY2FNU0MuZ2V0Q3VycmVudE1vZGUoKTtcclxuXHJcbiAgICAgICAgaWYgKG1vZGUgIT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUubWV0ZXIubW9kZSA9IG1vZGU7XHJcblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc0dlbmVyYXRpb24oKSlcclxuICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgdmFyIHNldHBvaW50cyA9IGF3YWl0IHNlbmVjYU1TQy5nZXRTZXRwb2ludHMoYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUubGFzdFNldHBvaW50ID0gc2V0cG9pbnRzO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc01lYXN1cmVtZW50KCkpXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIHZhciBtZWFzID0gYXdhaXQgc2VuZWNhTVNDLmdldE1lYXN1cmVzKGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLmxhc3RNZWFzdXJlID0gbWVhcztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRGaW5pc2hlZCByZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCJFcnJvciB3aGlsZSByZWZyZXNoaW5nIG1lYXN1cmVcIiArIGVycik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBTZXRTaW11bGF0aW9uKHZhbHVlKSB7XHJcbiAgICBzaW11bGF0aW9uID0gdmFsdWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge3N0YXRlTWFjaGluZSwgU2VuZEFuZFJlc3BvbnNlLCBTZXRTaW11bGF0aW9ufTsiLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi4vY29uc3RhbnRzJyk7XHJcbnZhciBNZXRlclN0YXRlID0gcmVxdWlyZSgnLi9NZXRlclN0YXRlJyk7XHJcblxyXG4vLyBDdXJyZW50IHN0YXRlIG9mIHRoZSBibHVldG9vdGhcclxuY2xhc3MgQVBJU3RhdGUge1xyXG4gICAgY29uc3RydWN0b3IoKSB7XHJcbiAgICAgICAgdGhpcy5zdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIHRoaXMucHJldl9zdGF0ZSA9IGNvbnN0YW50cy5TdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIHRoaXMuc3RhdGVfY3B0ID0gMDtcclxuXHJcbiAgICAgICAgdGhpcy5zdGFydGVkID0gZmFsc2U7IC8vIFN0YXRlIG1hY2hpbmUgc3RhdHVzXHJcbiAgICAgICAgdGhpcy5zdG9wUmVxdWVzdCA9IGZhbHNlOyAvLyBUbyByZXF1ZXN0IGRpc2Nvbm5lY3RcclxuICAgICAgICB0aGlzLmxhc3RNZWFzdXJlID0ge307IC8vIEFycmF5IHdpdGggXCJNZWFzdXJlTmFtZVwiIDogdmFsdWVcclxuICAgICAgICB0aGlzLmxhc3RTZXRwb2ludCA9IHt9OyAvLyBBcnJheSB3aXRoIFwiU2V0cG9pbnRUeXBlXCIgOiB2YWx1ZVxyXG5cclxuICAgICAgICAvLyBzdGF0ZSBvZiBjb25uZWN0ZWQgbWV0ZXJcclxuICAgICAgICB0aGlzLm1ldGVyID0gbmV3IE1ldGVyU3RhdGUoKTtcclxuXHJcbiAgICAgICAgLy8gbGFzdCBtb2RidXMgUlRVIGNvbW1hbmRcclxuICAgICAgICB0aGlzLmNvbW1hbmQgPSBudWxsO1xyXG5cclxuICAgICAgICAvLyBsYXN0IG1vZGJ1cyBSVFUgYW5zd2VyXHJcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIGJsdWV0b290aCBwcm9wZXJ0aWVzXHJcbiAgICAgICAgdGhpcy5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICB0aGlzLmJ0RGV2aWNlID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gZ2VuZXJhbCBzdGF0aXN0aWNzIGZvciBkZWJ1Z2dpbmdcclxuICAgICAgICB0aGlzLnN0YXRzID0ge1xyXG4gICAgICAgICAgICBcInJlcXVlc3RzXCI6IDAsXHJcbiAgICAgICAgICAgIFwicmVzcG9uc2VzXCI6IDAsXHJcbiAgICAgICAgICAgIFwibW9kYnVzX2Vycm9yc1wiOiAwLFxyXG4gICAgICAgICAgICBcIkdBVFQgZGlzY29ubmVjdHNcIjogMCxcclxuICAgICAgICAgICAgXCJleGNlcHRpb25zXCI6IDAsXHJcbiAgICAgICAgICAgIFwic3ViY3JpYmVzXCI6IDAsXHJcbiAgICAgICAgICAgIFwiY29tbWFuZHNcIjogMCxcclxuICAgICAgICAgICAgXCJyZXNwb25zZVRpbWVcIjogMC4wLFxyXG4gICAgICAgICAgICBcImxhc3RSZXNwb25zZVRpbWVcIjogMC4wLFxyXG4gICAgICAgICAgICBcImxhc3RfY29ubmVjdFwiOiBuZXcgRGF0ZSgyMDIwLCAxLCAxKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdGhpcy5vcHRpb25zID0ge1xyXG4gICAgICAgICAgICBcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCIgOiB0cnVlXHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5sZXQgYnRTdGF0ZSA9IG5ldyBBUElTdGF0ZSgpO1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IEFQSVN0YXRlLCBidFN0YXRlIH0iLCJ2YXIgY29uc3RhbnRzID0gcmVxdWlyZSgnLi4vY29uc3RhbnRzJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJyk7XHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuXHJcbmNvbnN0IE1BWF9VX0dFTiA9IDI3LjA7IC8vIG1heGltdW0gdm9sdGFnZSBcclxuXHJcbi8qKlxyXG4gKiBDb21tYW5kIHRvIHRoZSBtZXRlciwgbWF5IGluY2x1ZGUgc2V0cG9pbnRcclxuICogKi9cclxuIGNsYXNzIENvbW1hbmQge1xyXG4gICAgLyoqXHJcbiAgICAgKiBDcmVhdGVzIGEgbmV3IGNvbW1hbmRcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGN0eXBlXHJcbiAgICAgKi9cclxuICAgIGNvbnN0cnVjdG9yKGN0eXBlID0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgdGhpcy50eXBlID0gcGFyc2VJbnQoY3R5cGUpO1xyXG4gICAgICAgIHRoaXMuc2V0cG9pbnQgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuc2V0cG9pbnQyID0gbnVsbDtcclxuICAgICAgICB0aGlzLmVycm9yID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5wZW5kaW5nID0gdHJ1ZTtcclxuICAgICAgICB0aGlzLnJlcXVlc3QgPSBudWxsO1xyXG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHN0YXRpYyBDcmVhdGVOb1NQKGN0eXBlKVxyXG4gICAge1xyXG4gICAgICAgIHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcbiAgICAgICAgcmV0dXJuIGNtZDtcclxuICAgIH1cclxuICAgIHN0YXRpYyBDcmVhdGVPbmVTUChjdHlwZSwgc2V0cG9pbnQpXHJcbiAgICB7XHJcbiAgICAgICAgdmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuICAgICAgICBjbWQuc2V0cG9pbnQgPSBwYXJzZUZsb2F0KHNldHBvaW50KTtcclxuICAgICAgICByZXR1cm4gY21kO1xyXG4gICAgfVxyXG4gICAgc3RhdGljIENyZWF0ZVR3b1NQKGN0eXBlLCBzZXQxLCBzZXQyKVxyXG4gICAge1xyXG4gICAgICAgIHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcbiAgICAgICAgY21kLnNldHBvaW50ID0gcGFyc2VGbG9hdChzZXQxKTtcclxuICAgICAgICBjbWQuc2V0cG9pbnQyID0gcGFyc2VGbG9hdChzZXQyKTs7XHJcbiAgICAgICAgcmV0dXJuIGNtZDtcclxuICAgIH1cclxuXHJcbiAgICB0b1N0cmluZygpIHtcclxuICAgICAgICByZXR1cm4gXCJUeXBlOiBcIiArIHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCB0aGlzLnR5cGUpICsgXCIsIHNldHBvaW50OlwiICsgdGhpcy5zZXRwb2ludCArIFwiLCBzZXRwb2ludDI6IFwiICsgdGhpcy5zZXRwb2ludDIgKyBcIiwgcGVuZGluZzpcIiArIHRoaXMucGVuZGluZyArIFwiLCBlcnJvcjpcIiArIHRoaXMuZXJyb3I7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBHZXRzIHRoZSBkZWZhdWx0IHNldHBvaW50IGZvciB0aGlzIGNvbW1hbmQgdHlwZVxyXG4gICAgICogQHJldHVybnMge0FycmF5fSBzZXRwb2ludChzKSBleHBlY3RlZFxyXG4gICAgICovXHJcbiAgICBkZWZhdWx0U2V0cG9pbnQoKSB7XHJcbiAgICAgICAgc3dpdGNoICh0aGlzLnR5cGUpIHtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVGVtcGVyYXR1cmUgKMKwQyknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdWb2x0YWdlIChWKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdWb2x0YWdlIChtViknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0N1cnJlbnQgKG1BKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdJbWJhbGFuY2UgKG1WL1YpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdGcmVxdWVuY3kgKEh6KSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1B1bHNlcyBjb3VudCc6IDAsICdGcmVxdWVuY3kgKEh6KSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VVGhyZXNob2xkX0Y6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVXRocmVzaG9sZCAoViknOiAyLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2Vuc2l0aXZpdHlfdVM6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnU2Vuc2liaWxpdHkgKHVTKSc6IDIuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnQ29sZCBqdW5jdGlvbiBjb21wZW5zYXRpb24nOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWxvdzpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdVIGxvdyAoViknOiAwLjAgLyBNQVhfVV9HRU4gfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWhpZ2g6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVSBoaWdoIChWKSc6IDUuMCAvIE1BWF9VX0dFTiB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0RlbGF5IChzKSc6IDYwICogNSB9O1xyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlzR2VuZXJhdGlvbigpIHtcclxuICAgICAgICByZXR1cm4gdXRpbHMuaXNHZW5lcmF0aW9uKHRoaXMudHlwZSk7XHJcbiAgICB9XHJcbiAgICBpc01lYXN1cmVtZW50KCkge1xyXG4gICAgICAgIHJldHVybiB1dGlscy5pc01lYXN1cmVtZW50KHRoaXMudHlwZSk7XHJcbiAgICB9XHJcbiAgICBpc1NldHRpbmcoKSB7XHJcbiAgICAgICAgcmV0dXJuIHV0aWxzLmlzU2V0dGluZyh0aGlzLnR5cGUpO1xyXG4gICAgfVxyXG4gICAgaXNWYWxpZCgpIHtcclxuICAgICAgICByZXR1cm4gKHV0aWxzLmlzTWVhc3VyZW1lbnQodGhpcy50eXBlKSB8fCB1dGlscy5pc0dlbmVyYXRpb24odGhpcy50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcodGhpcy50eXBlKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ29tbWFuZDsiLCJjbGFzcyBDb21tYW5kUmVzdWx0XHJcbntcclxuICAgIHZhbHVlID0gMC4wO1xyXG4gICAgc3VjY2VzcyA9IGZhbHNlO1xyXG4gICAgbWVzc2FnZSA9IFwiXCI7XHJcbiAgICB1bml0ID0gXCJcIjtcclxuICAgIHNlY29uZGFyeV92YWx1ZSA9IDAuMDtcclxuICAgIHNlY29uZGFyeV91bml0ID0gXCJcIjtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBDb21tYW5kUmVzdWx0OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuLi9jb25zdGFudHMnKTtcclxuXHJcbi8qKlxyXG4gKiBDdXJyZW50IHN0YXRlIG9mIHRoZSBtZXRlclxyXG4gKiAqL1xyXG4gY2xhc3MgTWV0ZXJTdGF0ZSB7XHJcbiAgICBjb25zdHJ1Y3RvcigpIHtcclxuICAgICAgICB0aGlzLmZpcm13YXJlID0gXCJcIjsgLy8gRmlybXdhcmUgdmVyc2lvblxyXG4gICAgICAgIHRoaXMuc2VyaWFsID0gXCJcIjsgLy8gU2VyaWFsIG51bWJlclxyXG4gICAgICAgIHRoaXMubW9kZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV047XHJcbiAgICAgICAgdGhpcy5iYXR0ZXJ5ID0gMC4wO1xyXG4gICAgfVxyXG5cclxuICAgIGlzTWVhc3VyZW1lbnQoKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLk9GRjtcclxuICAgIH1cclxuXHJcbiAgICBpc0dlbmVyYXRpb24oKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubW9kZSA+IGNvbnN0YW50cy5Db21tYW5kVHlwZS5PRkYgJiYgdGhpcy5tb2RlIDwgY29uc3RhbnRzLkNvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRDtcclxuICAgIH1cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBNZXRlclN0YXRlOyIsIid1c2Ugc3RyaWN0JztcclxuXHJcbi8qKlxyXG4gKiAgVGhpcyBtb2R1bGUgY29udGFpbnMgdGhlIFNlbmVjYU1TQyBvYmplY3QsIHdoaWNoIHByb3ZpZGVzIHRoZSBtYWluIG9wZXJhdGlvbnMgZm9yIGJsdWV0b290aCBtb2R1bGUuXHJcbiAqICBJdCB1c2VzIHRoZSBtb2RidXMgaGVscGVyIGZ1bmN0aW9ucyBmcm9tIHNlbmVjYU1vZGJ1cyAvIG1vZGJ1c1J0dSB0byBpbnRlcmFjdCB3aXRoIHRoZSBtZXRlciB3aXRoIFNlbmRBbmRSZXNwb25zZSBmdW5jdGlvblxyXG4gKi9cclxudmFyIGxvZyA9IHJlcXVpcmUoJ2xvZ2xldmVsJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJyk7XHJcbnZhciBzZW5lY2FNQiA9IHJlcXVpcmUoJy4uL3NlbmVjYU1vZGJ1cycpO1xyXG52YXIgbW9kYnVzID0gcmVxdWlyZSgnLi4vbW9kYnVzUnR1Jyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuLi9jb25zdGFudHMnKTtcclxuXHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxudmFyIFJlc3VsdENvZGUgPSBjb25zdGFudHMuUmVzdWx0Q29kZTtcclxuXHJcbmNvbnN0IFJFU0VUX1BPV0VSX09GRiA9IDY7XHJcbmNvbnN0IFNFVF9QT1dFUl9PRkYgPSA3O1xyXG5jb25zdCBDTEVBUl9BVkdfTUlOX01BWCA9IDU7XHJcbmNvbnN0IFBVTFNFX0NNRCA9IDk7XHJcblxyXG5jbGFzcyBTZW5lY2FNU0Ncclxue1xyXG4gICAgY29uc3RydWN0b3IoZm5TZW5kQW5kUmVzcG9uc2UpIHtcclxuICAgICAgICB0aGlzLlNlbmRBbmRSZXNwb25zZSA9IGZuU2VuZEFuZFJlc3BvbnNlO1xyXG4gICAgfVxyXG4gICAgLyoqXHJcbiAgICAgKiBHZXRzIHRoZSBtZXRlciBzZXJpYWwgbnVtYmVyICgxMjM0NV8xMjM0KVxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7c3RyaW5nfVxyXG4gICAgICovXHJcbiAgICAgYXN5bmMgZ2V0U2VyaWFsTnVtYmVyKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgc2VyaWFsIG51bWJlclwiKTtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlU2VyaWFsTnVtYmVyKCkpO1xyXG4gICAgICAgIHJldHVybiBzZW5lY2FNQi5wYXJzZVNlcmlhbE51bWJlcihyZXNwb25zZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBHZXRzIHRoZSBjdXJyZW50IG1vZGUgc2V0IG9uIHRoZSBNU0MgZGV2aWNlXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtDb21tYW5kVHlwZX0gYWN0aXZlIG1vZGVcclxuICAgICAqL1xyXG4gICAgYXN5bmMgZ2V0Q3VycmVudE1vZGUoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBjdXJyZW50IG1vZGVcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZUN1cnJlbnRNb2RlKCkpO1xyXG4gICAgICAgIHJldHVybiBzZW5lY2FNQi5wYXJzZUN1cnJlbnRNb2RlKHJlc3BvbnNlLCBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogR2V0cyB0aGUgYmF0dGVyeSB2b2x0YWdlIGZyb20gdGhlIG1ldGVyIGZvciBiYXR0ZXJ5IGxldmVsIGluZGljYXRpb25cclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge251bWJlcn0gdm9sdGFnZSAoVilcclxuICAgICAqL1xyXG4gICAgYXN5bmMgZ2V0QmF0dGVyeVZvbHRhZ2UoKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBiYXR0ZXJ5IHZvbHRhZ2VcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZUJhdHRlcnlMZXZlbCgpKTtcclxuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZChzZW5lY2FNQi5wYXJzZUJhdHRlcnkocmVzcG9uc2UpICogMTAwKSAvIDEwMDtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENoZWNrIG1lYXN1cmVtZW50IGVycm9yIGZsYWdzIGZyb20gbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldFF1YWxpdHlWYWxpZCgpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmUgcXVhbGl0eSBiaXRcIik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVF1YWxpdHlCaXRSZXF1ZXN0KCkpO1xyXG4gICAgICAgIHJldHVybiBzZW5lY2FNQi5pc1F1YWxpdHlWYWxpZChyZXNwb25zZSk7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8qKlxyXG4gICAgICogQ2hlY2sgZ2VuZXJhdGlvbiBlcnJvciBmbGFncyBmcm9tIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtib29sZWFufVxyXG4gICAgICovXHJcbiAgICBhc3luYyBnZXRHZW5RdWFsaXR5VmFsaWQoY3VycmVudF9tb2RlKVxyXG4gICAge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlYWRpbmcgZ2VuZXJhdGlvbiBxdWFsaXR5IGJpdFwiKTtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzZW5lY2FNQi5tYWtlR2VuU3RhdHVzUmVhZCgpKTtcclxuICAgICAgICByZXR1cm4gc2VuZWNhTUIucGFyc2VHZW5TdGF0dXMocmVzcG9uc2UsIGN1cnJlbnRfbW9kZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBSZWFkcyB0aGUgbWVhc3VyZW1lbnRzIGZyb20gdGhlIG1ldGVyLCBpbmNsdWRpbmcgZXJyb3IgZmxhZ3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1ldGVyIG1vZGUgXHJcbiAgICAgKiBAcmV0dXJucyB7YXJyYXl8bnVsbH0gbWVhc3VyZW1lbnQgYXJyYXkgKHVuaXRzLCB2YWx1ZXMsIGVycm9yIGZsYWcpXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldE1lYXN1cmVzKG1vZGUpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWFkaW5nIG1lYXN1cmVzXCIpO1xyXG4gICAgICAgIHZhciB2YWxpZCA9IGF3YWl0IHRoaXMuZ2V0UXVhbGl0eVZhbGlkKCk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZU1lYXN1cmVSZXF1ZXN0KG1vZGUpKTtcclxuICAgICAgICBpZiAocmVzcG9uc2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICB2YXIgbWVhcyA9IHNlbmVjYU1CLnBhcnNlTWVhc3VyZShyZXNwb25zZSwgbW9kZSk7XHJcbiAgICAgICAgICAgIG1lYXNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuICAgICAgICAgICAgcmV0dXJuIG1lYXM7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUmVhZHMgdGhlIGFjdGl2ZSBzZXRwb2ludHMgZnJvbSB0aGUgbWV0ZXIsIGluY2x1ZGluZyBlcnJvciBmbGFnc1xyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGN1cnJlbnQgbWV0ZXIgbW9kZSBcclxuICAgICAqIEByZXR1cm5zIHthcnJheXxudWxsfSBzZXRwb2ludHMgYXJyYXkgKHVuaXRzLCB2YWx1ZXMsIGVycm9yIGZsYWcpXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGdldFNldHBvaW50cyhtb2RlKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVhZGluZyBzZXRwb2ludHNcIik7XHJcbiAgICAgICAgdmFyIHZhbGlkID0gYXdhaXQgdGhpcy5nZXRHZW5RdWFsaXR5VmFsaWQobW9kZSk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVNldHBvaW50UmVhZChtb2RlKSk7XHJcbiAgICAgICAgaWYgKHJlc3BvbnNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdHMgPSBzZW5lY2FNQi5wYXJzZVNldHBvaW50UmVhZChyZXNwb25zZSwgbW9kZSk7XHJcbiAgICAgICAgICAgIHJlc3VsdHNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUHV0cyB0aGUgbWV0ZXIgaW4gT0ZGIG1vZGVcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIHN3aXRjaE9mZigpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIG1ldGVyIHRvIE9GRlwiKTtcclxuICAgICAgICB2YXIgcGFja2V0ID0gc2VuZWNhTUIubWFrZU1vZGVSZXF1ZXN0KENvbW1hbmRUeXBlLk9GRik7XHJcbiAgICAgICAgaWYgKHBhY2tldCA9PSBudWxsKVxyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcblxyXG4gICAgICAgIGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHBhY2tldCk7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFdyaXRlIHRoZSBzZXRwb2ludHMgdG8gdGhlIG1ldGVyXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGNvbW1hbmRfdHlwZSB0eXBlIG9mIGdlbmVyYXRpb24gY29tbWFuZFxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHNldHBvaW50IG9mIGdlbmVyYXRpb25cclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBzZXRwb2ludDIgZmFjdWx0YXRpdmUsIHNlY29uZCBzZXRwb2ludFxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIHdyaXRlU2V0cG9pbnRzKGNvbW1hbmRfdHlwZSwgc2V0cG9pbnQsIHNldHBvaW50Mikge1xyXG4gICAgICAgIHZhciBzdGFydEdlbjtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIGNvbW1hbmQ6XCIrIGNvbW1hbmRfdHlwZSArIFwiLCBzZXRwb2ludDogXCIgKyBzZXRwb2ludCArIFwiLCBzZXRwb2ludCAyOiBcIiArIHNldHBvaW50Mik7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc2VuZWNhTUIubWFrZVNldHBvaW50UmVxdWVzdChjb21tYW5kX3R5cGUsIHNldHBvaW50LCBzZXRwb2ludDIpKTtcclxuICAgICAgICBpZiAocmVzcG9uc2UgIT0gbnVsbCAmJiAhbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9TSE9VTERfUkVUUlk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBTcGVjaWFsIGhhbmRsaW5nIG9mIHRoZSBTRVQgRGVsYXkgY29tbWFuZFxyXG4gICAgICAgIHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcbiAgICAgICAgICAgICAgICBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICAgICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENsZWFyIEF2Zy9NaW4vTWF4IHN0YXRpc3RpY3NcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHJldHVybnMge1Jlc3VsdENvZGV9IHJlc3VsdCBvZiB0aGUgb3BlcmF0aW9uXHJcbiAgICAgKi9cclxuICAgIGFzeW5jIGNsZWFyU3RhdGlzdGljcygpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZXNldHRpbmcgc3RhdGlzdGljc1wiKTtcclxuICAgICAgICB2YXIgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhTUIuTVNDUmVnaXN0ZXJzLkNNRCwgW0NMRUFSX0FWR19NSU5fTUFYXSk7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgdGhpcy5TZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEJlZ2lucyB0aGUgcHVsc2UgZ2VuZXJhdGlvblxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgc3RhcnRQdWxzZUdlbigpIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTdGFydGluZyBwdWxzZSBnZW5lcmF0aW9uXCIpO1xyXG4gICAgICAgIHZhciBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2FNQi5NU0NSZWdpc3RlcnMuR0VOX0NNRCwgW1BVTFNFX0NNRCwgMl0pOyAvLyBTdGFydCB3aXRoIGxvd1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAyKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBCZWdpbnMgdGhlIGZyZXF1ZW5jeSBnZW5lcmF0aW9uXHJcbiAgICAgKiBNYXkgdGhyb3cgTW9kYnVzRXJyb3JcclxuICAgICAqIEByZXR1cm5zIHtSZXN1bHRDb2RlfSByZXN1bHQgb2YgdGhlIG9wZXJhdGlvblxyXG4gICAgICovXHJcbiAgICBhc3luYyBzdGFydEZyZXFHZW4oKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U3RhcnRpbmcgZnJlcSBnZW5cIik7XHJcbiAgICAgICAgdmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbUFVMU0VfQ01ELCAxXSk7IC8vIHN0YXJ0IGdlblxyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAyKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gUmVzdWx0Q29kZS5GQUlMRURfTk9fUkVUUlk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBSZXN1bHRDb2RlLlNVQ0NFU1M7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBEaXNhYmxlIGF1dG8gcG93ZXIgb2ZmIHRvIHRoZSBtZXRlclxyXG4gICAgICogTWF5IHRocm93IE1vZGJ1c0Vycm9yXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgZGlzYWJsZVBvd2VyT2ZmKCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdERpc2FibGluZyBwb3dlciBvZmZcIik7XHJcbiAgICAgICAgdmFyIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYU1CLk1TQ1JlZ2lzdGVycy5DTUQsIFtSRVNFVF9QT1dFUl9PRkZdKTtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLlNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcbiAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuU1VDQ0VTUztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIENoYW5nZXMgdGhlIGN1cnJlbnQgbW9kZSBvbiB0aGUgbWV0ZXJcclxuICAgICAqIE1heSB0aHJvdyBNb2RidXNFcnJvclxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY29tbWFuZF90eXBlIHRoZSBuZXcgbW9kZSB0byBzZXQgdGhlIG1ldGVyIGluXHJcbiAgICAgKiBAcmV0dXJucyB7UmVzdWx0Q29kZX0gcmVzdWx0IG9mIHRoZSBvcGVyYXRpb25cclxuICAgICAqL1xyXG4gICAgYXN5bmMgY2hhbmdlTW9kZShjb21tYW5kX3R5cGUpXHJcbiAgICB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciBtb2RlIHRvIDpcIiArIGNvbW1hbmRfdHlwZSk7XHJcbiAgICAgICAgdmFyIHBhY2tldCA9IHNlbmVjYU1CLm1ha2VNb2RlUmVxdWVzdChjb21tYW5kX3R5cGUpO1xyXG4gICAgICAgIGlmIChwYWNrZXQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZCB0eXBlXCIsIGNvbW1hbmRfdHlwZSk7XHJcbiAgICAgICAgICAgIHJldHVybiBSZXN1bHRDb2RlLkZBSUxFRF9OT19SRVRSWTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHZhciByZXNwb25zZSA9IGF3YWl0IHRoaXMuU2VuZEFuZFJlc3BvbnNlKHBhY2tldCk7XHJcblxyXG4gICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcbiAgICAgICAgICAgIGxvZy5lcnJvcihcIkNvdWxkIG5vdCBnZW5lcmF0ZSBtb2RidXMgcGFja2V0IGZvciBjb21tYW5kIHR5cGVcIiwgY29tbWFuZF90eXBlKTtcclxuICAgICAgICAgICAgcmV0dXJuIFJlc3VsdENvZGUuRkFJTEVEX05PX1JFVFJZO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IFJlc3VsdENvZGUuU1VDQ0VTUztcclxuXHJcbiAgICAgICAgLy8gU29tZSBjb21tYW5kcyByZXF1aXJlIGFkZGl0aW9uYWwgY29tbWFuZCB0byBiZSBnaXZlbiB0byB3b3JrIHByb3Blcmx5LCBhZnRlciBhIHNsaWdodCBkZWxheVxyXG4gICAgICAgIHN3aXRjaCAoY29tbWFuZF90eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tVjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmNsZWFyU3RhdGlzdGljcygpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuICAgICAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuc3RhcnRQdWxzZUdlbigpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5zdGFydEZyZXFHZW4oKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKHJlc3VsdCA9PSBSZXN1bHRDb2RlLlNVQ0NFU1MpIHtcclxuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5kaXNhYmxlUG93ZXJPZmYoKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1NlbmVjYU1TQ307IiwiLyoqXHJcbiAqIENvbW1hbmQgdHlwZSwgYWthIG1vZGUgdmFsdWUgdG8gYmUgd3JpdHRlbiBpbnRvIE1TQyBjdXJyZW50IHN0YXRlIHJlZ2lzdGVyXHJcbiAqICovXHJcbiBjb25zdCBDb21tYW5kVHlwZSA9IHtcclxuICAgIE5PTkVfVU5LTk9XTjogMCwgLyoqKiBNRUFTVVJJTkcgRkVBVFVSRVMgQUZURVIgVEhJUyBQT0lOVCAqKioqKioqL1xyXG4gICAgbUFfcGFzc2l2ZTogMSxcclxuICAgIG1BX2FjdGl2ZTogMixcclxuICAgIFY6IDMsXHJcbiAgICBtVjogNCxcclxuICAgIFRIRVJNT19KOiA1LCAvLyBUZXJtb2NvcHBpZVxyXG4gICAgVEhFUk1PX0s6IDYsXHJcbiAgICBUSEVSTU9fVDogNyxcclxuICAgIFRIRVJNT19FOiA4LFxyXG4gICAgVEhFUk1PX0w6IDksXHJcbiAgICBUSEVSTU9fTjogMTAsXHJcbiAgICBUSEVSTU9fUjogMTEsXHJcbiAgICBUSEVSTU9fUzogMTIsXHJcbiAgICBUSEVSTU9fQjogMTMsXHJcbiAgICBQVDEwMF8yVzogMTQsIC8vIFJURCAyIGZpbGlcclxuICAgIFBUMTAwXzNXOiAxNSxcclxuICAgIFBUMTAwXzRXOiAxNixcclxuICAgIFBUNTAwXzJXOiAxNyxcclxuICAgIFBUNTAwXzNXOiAxOCxcclxuICAgIFBUNTAwXzRXOiAxOSxcclxuICAgIFBUMTAwMF8yVzogMjAsXHJcbiAgICBQVDEwMDBfM1c6IDIxLFxyXG4gICAgUFQxMDAwXzRXOiAyMixcclxuICAgIEN1NTBfMlc6IDIzLFxyXG4gICAgQ3U1MF8zVzogMjQsXHJcbiAgICBDdTUwXzRXOiAyNSxcclxuICAgIEN1MTAwXzJXOiAyNixcclxuICAgIEN1MTAwXzNXOiAyNyxcclxuICAgIEN1MTAwXzRXOiAyOCxcclxuICAgIE5pMTAwXzJXOiAyOSxcclxuICAgIE5pMTAwXzNXOiAzMCxcclxuICAgIE5pMTAwXzRXOiAzMSxcclxuICAgIE5pMTIwXzJXOiAzMixcclxuICAgIE5pMTIwXzNXOiAzMyxcclxuICAgIE5pMTIwXzRXOiAzNCxcclxuICAgIExvYWRDZWxsOiAzNSwgICAvLyBDZWxsZSBkaSBjYXJpY29cclxuICAgIEZyZXF1ZW5jeTogMzYsICAvLyBGcmVxdWVuemFcclxuICAgIFB1bHNlVHJhaW46IDM3LCAvLyBDb250ZWdnaW8gaW1wdWxzaVxyXG4gICAgUkVTRVJWRUQ6IDM4LFxyXG4gICAgUkVTRVJWRURfMjogNDAsXHJcbiAgICBPRkY6IDEwMCwgLy8gKioqKioqKioqIEdFTkVSQVRJT04gQUZURVIgVEhJUyBQT0lOVCAqKioqKioqKioqKioqKioqKi9cclxuICAgIEdFTl9tQV9wYXNzaXZlOiAxMDEsXHJcbiAgICBHRU5fbUFfYWN0aXZlOiAxMDIsXHJcbiAgICBHRU5fVjogMTAzLFxyXG4gICAgR0VOX21WOiAxMDQsXHJcbiAgICBHRU5fVEhFUk1PX0o6IDEwNSxcclxuICAgIEdFTl9USEVSTU9fSzogMTA2LFxyXG4gICAgR0VOX1RIRVJNT19UOiAxMDcsXHJcbiAgICBHRU5fVEhFUk1PX0U6IDEwOCxcclxuICAgIEdFTl9USEVSTU9fTDogMTA5LFxyXG4gICAgR0VOX1RIRVJNT19OOiAxMTAsXHJcbiAgICBHRU5fVEhFUk1PX1I6IDExMSxcclxuICAgIEdFTl9USEVSTU9fUzogMTEyLFxyXG4gICAgR0VOX1RIRVJNT19COiAxMTMsXHJcbiAgICBHRU5fUFQxMDBfMlc6IDExNCxcclxuICAgIEdFTl9QVDUwMF8yVzogMTE3LFxyXG4gICAgR0VOX1BUMTAwMF8yVzogMTIwLFxyXG4gICAgR0VOX0N1NTBfMlc6IDEyMyxcclxuICAgIEdFTl9DdTEwMF8yVzogMTI2LFxyXG4gICAgR0VOX05pMTAwXzJXOiAxMjksXHJcbiAgICBHRU5fTmkxMjBfMlc6IDEzMixcclxuICAgIEdFTl9Mb2FkQ2VsbDogMTM1LFxyXG4gICAgR0VOX0ZyZXF1ZW5jeTogMTM2LFxyXG4gICAgR0VOX1B1bHNlVHJhaW46IDEzNyxcclxuICAgIEdFTl9SRVNFUlZFRDogMTM4LFxyXG4gICAgLy8gU3BlY2lhbCBzZXR0aW5ncyBiZWxvdyB0aGlzIHBvaW50c1xyXG4gICAgU0VUVElOR19SRVNFUlZFRDogMTAwMCxcclxuICAgIFNFVF9VVGhyZXNob2xkX0Y6IDEwMDEsXHJcbiAgICBTRVRfU2Vuc2l0aXZpdHlfdVM6IDEwMDIsXHJcbiAgICBTRVRfQ29sZEp1bmN0aW9uOiAxMDAzLFxyXG4gICAgU0VUX1Vsb3c6IDEwMDQsXHJcbiAgICBTRVRfVWhpZ2g6IDEwMDUsXHJcbiAgICBTRVRfU2h1dGRvd25EZWxheTogMTAwNlxyXG59O1xyXG5cclxuXHJcblxyXG5cclxuLypcclxuICogSW50ZXJuYWwgc3RhdGUgbWFjaGluZSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmNvbnN0IFN0YXRlID0ge1xyXG4gICAgTk9UX0NPTk5FQ1RFRDogJ05vdCBjb25uZWN0ZWQnLFxyXG4gICAgQ09OTkVDVElORzogJ0JsdWV0b290aCBkZXZpY2UgcGFpcmluZy4uLicsXHJcbiAgICBERVZJQ0VfUEFJUkVEOiAnRGV2aWNlIHBhaXJlZCcsXHJcbiAgICBTVUJTQ1JJQklORzogJ0JsdWV0b290aCBpbnRlcmZhY2VzIGNvbm5lY3RpbmcuLi4nLFxyXG4gICAgSURMRTogJ0lkbGUnLFxyXG4gICAgQlVTWTogJ0J1c3knLFxyXG4gICAgRVJST1I6ICdFcnJvcicsXHJcbiAgICBTVE9QUElORzogJ0Nsb3NpbmcgQlQgaW50ZXJmYWNlcy4uLicsXHJcbiAgICBTVE9QUEVEOiAnU3RvcHBlZCcsXHJcbiAgICBNRVRFUl9JTklUOiAnTWV0ZXIgY29ubmVjdGVkJyxcclxuICAgIE1FVEVSX0lOSVRJQUxJWklORzogJ1JlYWRpbmcgbWV0ZXIgc3RhdGUuLi4nXHJcbn07XHJcblxyXG5jb25zdCBSZXN1bHRDb2RlID0ge1xyXG4gICAgRkFJTEVEX05PX1JFVFJZOiAxLFxyXG4gICAgRkFJTEVEX1NIT1VMRF9SRVRSWTogMixcclxuICAgIFNVQ0NFU1M6IDBcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7U3RhdGUsIENvbW1hbmRUeXBlLCBSZXN1bHRDb2RlIH0iLCIndXNlIHN0cmljdCc7XHJcblxyXG5jb25zdCBsb2cgPSByZXF1aXJlKFwibG9nbGV2ZWxcIik7XHJcbmNvbnN0IGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbmNvbnN0IEFQSVN0YXRlID0gcmVxdWlyZSgnLi9jbGFzc2VzL0FQSVN0YXRlJyk7XHJcbmNvbnN0IENvbW1hbmQgPSByZXF1aXJlKCcuL2NsYXNzZXMvQ29tbWFuZCcpO1xyXG5jb25zdCBQdWJsaWNBUEkgPXJlcXVpcmUoJy4vbWV0ZXJQdWJsaWNBUEknKTtcclxuY29uc3QgVGVzdERhdGEgPXJlcXVpcmUoJy4vbW9kYnVzVGVzdERhdGEnKTtcclxuXHJcbmxvZy5zZXRMZXZlbChsb2cubGV2ZWxzLkVSUk9SLCB0cnVlKTtcclxuXHJcbmV4cG9ydHMuU3RvcCA9IFB1YmxpY0FQSS5TdG9wO1xyXG5leHBvcnRzLlBhaXIgPSBQdWJsaWNBUEkuUGFpcjtcclxuZXhwb3J0cy5FeGVjdXRlID0gUHVibGljQVBJLkV4ZWN1dGU7XHJcbmV4cG9ydHMuU2ltcGxlRXhlY3V0ZSA9IFB1YmxpY0FQSS5TaW1wbGVFeGVjdXRlO1xyXG5leHBvcnRzLkdldFN0YXRlID0gUHVibGljQVBJLkdldFN0YXRlO1xyXG5leHBvcnRzLlN0YXRlID0gY29uc3RhbnRzLlN0YXRlO1xyXG5leHBvcnRzLkNvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5leHBvcnRzLkNvbW1hbmQgPSBDb21tYW5kO1xyXG5leHBvcnRzLlBhcnNlID0gUHVibGljQVBJLlBhcnNlO1xyXG5leHBvcnRzLmxvZyA9IGxvZztcclxuZXhwb3J0cy5HZXRTdGF0ZUpTT04gPSBQdWJsaWNBUEkuR2V0U3RhdGVKU09OO1xyXG5leHBvcnRzLkV4ZWN1dGVKU09OID0gUHVibGljQVBJLkV4ZWN1dGVKU09OO1xyXG5leHBvcnRzLlNpbXBsZUV4ZWN1dGVKU09OID0gUHVibGljQVBJLlNpbXBsZUV4ZWN1dGVKU09OO1xyXG5leHBvcnRzLkdldEpzb25UcmFjZXMgPSBUZXN0RGF0YS5HZXRKc29uVHJhY2VzO1xyXG5cclxuIiwiLypcclxuICogVGhpcyBmaWxlIGNvbnRhaW5zIHRoZSBwdWJsaWMgQVBJIG9mIHRoZSBtZXRlciwgaS5lLiB0aGUgZnVuY3Rpb25zIGRlc2lnbmVkXHJcbiAqIHRvIGJlIGNhbGxlZCBmcm9tIHRoaXJkIHBhcnR5IGNvZGUuXHJcbiAqIDEtIFBhaXIoKSA6IGJvb2xcclxuICogMi0gRXhlY3V0ZShDb21tYW5kKSA6IGJvb2wgKyBKU09OIHZlcnNpb25cclxuICogMy0gU3RvcCgpIDogYm9vbFxyXG4gKiA0LSBHZXRTdGF0ZSgpIDogYXJyYXkgKyBKU09OIHZlcnNpb25cclxuICogNS0gU2ltcGxlRXhlY3V0ZShDb21tYW5kKSA6IHJldHVybnMgdGhlIHVwZGF0ZWQgbWVhc3VyZW1lbnQgb3IgbnVsbFxyXG4gKi9cclxuXHJcbnZhciBDb21tYW5kUmVzdWx0ID0gcmVxdWlyZSgnLi9jbGFzc2VzL0NvbW1hbmRSZXN1bHQnKTtcclxudmFyIEFQSVN0YXRlID0gcmVxdWlyZSgnLi9jbGFzc2VzL0FQSVN0YXRlJyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgYmx1ZXRvb3RoID0gcmVxdWlyZSgnLi9ibHVldG9vdGgnKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xyXG52YXIgbG9nID0gcmVxdWlyZSgnbG9nbGV2ZWwnKTtcclxudmFyIG1ldGVyQXBpID0gcmVxdWlyZSgnLi9tZXRlckFwaScpO1xyXG5cclxudmFyIGJ0U3RhdGUgPSBBUElTdGF0ZS5idFN0YXRlO1xyXG52YXIgU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGNvcHkgb2YgdGhlIGN1cnJlbnQgc3RhdGVcclxuICogQHJldHVybnMge2FycmF5fSBzdGF0dXMgb2YgbWV0ZXJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEdldFN0YXRlKCkge1xyXG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XHJcbiAgICBsZXQgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcbiAgICBzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuICAgICAgICAvLyBTdGF0ZXMgcmVxdWlyaW5nIHVzZXIgaW5wdXRcclxuICAgICAgICBjYXNlIFN0YXRlLkVSUk9SOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBFRDpcclxuICAgICAgICBjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6XHJcbiAgICAgICAgICAgIHJlYWR5ID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkJVU1k6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5JRExFOlxyXG4gICAgICAgICAgICByZWFkeSA9IHRydWU7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkNPTk5FQ1RJTkc6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVDpcclxuICAgICAgICBjYXNlIFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORzpcclxuICAgICAgICBjYXNlIFN0YXRlLlNVQlNDUklCSU5HOlxyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSB0cnVlO1xyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgXCJsYXN0U2V0cG9pbnRcIjogYnRTdGF0ZS5sYXN0U2V0cG9pbnQsXHJcbiAgICAgICAgXCJsYXN0TWVhc3VyZVwiOiBidFN0YXRlLmxhc3RNZWFzdXJlLFxyXG4gICAgICAgIFwiZGV2aWNlTmFtZVwiOiBidFN0YXRlLmJ0RGV2aWNlID8gYnRTdGF0ZS5idERldmljZS5uYW1lIDogXCJcIixcclxuICAgICAgICBcImRldmljZVNlcmlhbFwiOiBidFN0YXRlLm1ldGVyPy5zZXJpYWwsXHJcbiAgICAgICAgXCJzdGF0c1wiOiBidFN0YXRlLnN0YXRzLFxyXG4gICAgICAgIFwiZGV2aWNlTW9kZVwiOiBidFN0YXRlLm1ldGVyPy5tb2RlLFxyXG4gICAgICAgIFwic3RhdHVzXCI6IGJ0U3RhdGUuc3RhdGUsXHJcbiAgICAgICAgXCJiYXR0ZXJ5TGV2ZWxcIjogYnRTdGF0ZS5tZXRlcj8uYmF0dGVyeSxcclxuICAgICAgICBcInJlYWR5XCI6IHJlYWR5LFxyXG4gICAgICAgIFwiaW5pdGlhbGl6aW5nXCI6IGluaXRpYWxpemluZ1xyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFByb3ZpZGVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggQmxhem9yXHJcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEpTT04gc3RhdGUgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBHZXRTdGF0ZUpTT04oKSB7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgR2V0U3RhdGUoKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGNvbW1hbmQgd2l0aCBzZXRwb2ludHMsIEpTT04gdmVyc2lvblxyXG4gKiBAcGFyYW0ge3N0cmluZ30ganNvbkNvbW1hbmQgdGhlIGNvbW1hbmQgdG8gZXhlY3V0ZVxyXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBKU09OIGNvbW1hbmQgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlSlNPTihqc29uQ29tbWFuZCkge1xyXG4gICAgbGV0IGNvbW1hbmQgPSBKU09OLnBhcnNlKGpzb25Db21tYW5kKTtcclxuICAgIC8vIGRlc2VyaWFsaXplZCBvYmplY3QgaGFzIGxvc3QgaXRzIG1ldGhvZHMsIGxldCdzIHJlY3JlYXRlIGEgY29tcGxldGUgb25lLlxyXG4gICAgbGV0IGNvbW1hbmQyID1tZXRlckFwaS5Db21tYW5kLkNyZWF0ZVR3b1NQKGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpO1xyXG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IEV4ZWN1dGUoY29tbWFuZDIpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZUpTT04oanNvbkNvbW1hbmQpIHtcclxuICAgIGxldCBjb21tYW5kID0gSlNPTi5wYXJzZShqc29uQ29tbWFuZCk7XHJcbiAgICAvLyBkZXNlcmlhbGl6ZWQgb2JqZWN0IGhhcyBsb3N0IGl0cyBtZXRob2RzLCBsZXQncyByZWNyZWF0ZSBhIGNvbXBsZXRlIG9uZS5cclxuICAgIGxldCBjb21tYW5kMiA9IG1ldGVyQXBpLkNvbW1hbmQuQ3JlYXRlVHdvU1AoY29tbWFuZC50eXBlLCBjb21tYW5kLnNldHBvaW50LCBjb21tYW5kLnNldHBvaW50Mik7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgU2ltcGxlRXhlY3V0ZShjb21tYW5kMikpO1xyXG59XHJcblxyXG4vKipcclxuICogRXhlY3V0ZSBhIGNvbW1hbmQgYW5kIHJldHVybnMgdGhlIG1lYXN1cmVtZW50IG9yIHNldHBvaW50IHdpdGggZXJyb3IgZmxhZyBhbmQgbWVzc2FnZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbiBhc3luYyBmdW5jdGlvbiBTaW1wbGVFeGVjdXRlKGNvbW1hbmQpIHtcclxuICAgIGNvbnN0IFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyA9IDU7XHJcbiAgICB2YXIgY3IgPSBuZXcgQ29tbWFuZFJlc3VsdCgpO1xyXG5cclxuICAgIGxvZy5pbmZvKFwiU2ltcGxlRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgPT0gbnVsbClcclxuICAgIHtcclxuICAgICAgICBjci5zdWNjZXNzID0gZmFsc2U7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiSW52YWxpZCBjb21tYW5kXCI7XHJcbiAgICAgICAgcmV0dXJuIGNyO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbW1hbmQucGVuZGluZyA9IHRydWU7IC8vIEluIGNhc2UgY2FsbGVyIGRvZXMgbm90IHNldCBwZW5kaW5nIGZsYWdcclxuXHJcbiAgICAvLyBGYWlsIGltbWVkaWF0ZWx5IGlmIG5vdCBwYWlyZWQuXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuICAgICAgICBjci5tZXNzYWdlID0gXCJEZXZpY2UgaXMgbm90IHBhaXJlZFwiO1xyXG4gICAgICAgIGxvZy53YXJuKGNyLm1lc3NhZ2UpO1xyXG4gICAgICAgIHJldHVybiBjcjtcclxuICAgIH1cclxuXHJcbiAgICAvLyBBbm90aGVyIGNvbW1hbmQgbWF5IGJlIHBlbmRpbmcuXHJcbiAgICBpZiAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcpIHtcclxuICAgICAgICBjci5zdWNjZXNzID0gZmFsc2U7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiQW5vdGhlciBjb21tYW5kIGlzIHBlbmRpbmdcIjtcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDsgXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMud2FpdEZvclRpbWVvdXQoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQsIFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQ2hlY2sgaWYgZXJyb3Igb3IgdGltZW91dHNcclxuICAgIGlmIChjb21tYW5kLmVycm9yIHx8IGNvbW1hbmQucGVuZGluZykgIFxyXG4gICAge1xyXG4gICAgICAgIGNyLnN1Y2Nlc3MgPSBmYWxzZTtcclxuICAgICAgICBjci5tZXNzYWdlID0gXCJFcnJvciB3aGlsZSBleGVjdXRpbmcgdGhlIGNvbW1hbmQuXCJcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICBcclxuICAgICAgICAvLyBSZXNldCB0aGUgYWN0aXZlIGNvbW1hbmRcclxuICAgICAgICBidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG4gICAgICAgIHJldHVybiBjcjtcclxuICAgIH1cclxuXHJcbiAgICAvLyBTdGF0ZSBpcyB1cGRhdGVkIGJ5IGV4ZWN1dGUgY29tbWFuZCwgc28gd2UgY2FuIHVzZSBidFN0YXRlIHJpZ2h0IGF3YXlcclxuICAgIGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSlcclxuICAgIHtcclxuICAgICAgICBjci52YWx1ZSA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVmFsdWVcIl07XHJcbiAgICAgICAgY3IudW5pdCA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVW5pdFwiXTtcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKHV0aWxzLmlzTWVhc3VyZW1lbnQoY29tbWFuZC50eXBlKSlcclxuICAgIHtcclxuICAgICAgICBjci52YWx1ZSA9IGJ0U3RhdGUubGFzdE1lYXN1cmVbXCJWYWx1ZVwiXTtcclxuICAgICAgICBjci51bml0ID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlVuaXRcIl07XHJcbiAgICAgICAgY3Iuc2Vjb25kYXJ5X3ZhbHVlID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlNlY29uZGFyeVZhbHVlXCJdO1xyXG4gICAgICAgIGNyLnNlY29uZGFyeV91bml0ID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlNlY29uZGFyeVVuaXRcIl07XHJcbiAgICB9XHJcbiAgICBlbHNlXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSAwLjA7IC8vIFNldHRpbmdzIGNvbW1hbmRzO1xyXG4gICAgfVxyXG5cclxuICAgIGNyLnN1Y2Nlc3MgPSB0cnVlO1xyXG4gICAgY3IubWVzc2FnZSA9IFwiQ29tbWFuZCBleGVjdXRlZCBzdWNjZXNzZnVsbHlcIjtcclxuICAgIHJldHVybiBjcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4dGVybmFsIGludGVyZmFjZSB0byByZXF1aXJlIGEgY29tbWFuZCB0byBiZSBleGVjdXRlZC5cclxuICogVGhlIGJsdWV0b290aCBkZXZpY2UgcGFpcmluZyB3aW5kb3cgd2lsbCBvcGVuIGlmIGRldmljZSBpcyBub3QgY29ubmVjdGVkLlxyXG4gKiBUaGlzIG1heSBmYWlsIGlmIGNhbGxlZCBvdXRzaWRlIGEgdXNlciBnZXN0dXJlLlxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEV4ZWN1dGUoY29tbWFuZCkge1xyXG4gICAgbG9nLmluZm8oXCJFeGVjdXRlIGNhbGxlZC4uLlwiKTtcclxuXHJcbiAgICBpZiAoY29tbWFuZCA9PSBudWxsKVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIFxyXG4gICAgY29tbWFuZC5wZW5kaW5nID0gdHJ1ZTtcclxuXHJcbiAgICB2YXIgY3B0ID0gMDtcclxuICAgIHdoaWxlIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbCAmJiBidFN0YXRlLmNvbW1hbmQucGVuZGluZyAmJiBjcHQgPCAzMDApIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJXYWl0aW5nIGZvciBjdXJyZW50IGNvbW1hbmQgdG8gY29tcGxldGUuLi5cIik7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuICAgICAgICBjcHQrKztcclxuICAgIH1cclxuICAgIFxyXG4gICAgbG9nLmluZm8oXCJTZXR0aW5nIG5ldyBjb21tYW5kIDpcIiArIGNvbW1hbmQpO1xyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDtcclxuXHJcbiAgICAvLyBTdGFydCB0aGUgcmVndWxhciBzdGF0ZSBtYWNoaW5lXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIGF3YWl0IGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBXYWl0IGZvciBjb21wbGV0aW9uIG9mIHRoZSBjb21tYW5kLCBvciBoYWx0IG9mIHRoZSBzdGF0ZSBtYWNoaW5lXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiAhY29tbWFuZC5wZW5kaW5nIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcbiAgICB9XHJcbiAgICBcclxuICAgIC8vIFJldHVybiB0aGUgY29tbWFuZCBvYmplY3QgcmVzdWx0XHJcbiAgICByZXR1cm4gY29tbWFuZDtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1VU1QgQkUgQ0FMTEVEIEZST00gQSBVU0VSIEdFU1RVUkUgRVZFTlQgSEFORExFUlxyXG4gICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgbWV0ZXIgaXMgcmVhZHkgdG8gZXhlY3V0ZSBjb21tYW5kXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIFBhaXIoZm9yY2VTZWxlY3Rpb249ZmFsc2UpIHtcclxuICAgIGxvZy5pbmZvKFwiUGFpcihcIitmb3JjZVNlbGVjdGlvbitcIikgY2FsbGVkLi4uXCIpO1xyXG4gICAgXHJcbiAgICBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXSA9IGZvcmNlU2VsZWN0aW9uO1xyXG5cclxuICAgIGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7XHJcbiAgICAgICAgYmx1ZXRvb3RoLnN0YXRlTWFjaGluZSgpOyAvLyBTdGFydCBpdFxyXG4gICAgfVxyXG4gICAgZWxzZSBpZiAoYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5FUlJPUikge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEOyAvLyBUcnkgdG8gcmVzdGFydFxyXG4gICAgfVxyXG4gICAgYXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiBidFN0YXRlLnN0YXRlID09IFN0YXRlLklETEUgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVEKTtcclxuICAgIGxvZy5pbmZvKFwiUGFpcmluZyBjb21wbGV0ZWQsIHN0YXRlIDpcIiwgYnRTdGF0ZS5zdGF0ZSk7XHJcbiAgICByZXR1cm4gKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBTdG9wcyB0aGUgc3RhdGUgbWFjaGluZSBhbmQgZGlzY29ubmVjdHMgYmx1ZXRvb3RoLlxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBTdG9wKCkge1xyXG4gICAgbG9nLmluZm8oXCJTdG9wIHJlcXVlc3QgcmVjZWl2ZWRcIik7XHJcblxyXG4gICAgYnRTdGF0ZS5zdG9wUmVxdWVzdCA9IHRydWU7XHJcbiAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG5cclxuICAgIHdoaWxlKGJ0U3RhdGUuc3RhcnRlZCB8fCAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEICYmIGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuTk9UX0NPTk5FQ1RFRCkpXHJcbiAgICB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdG9wUmVxdWVzdCA9IHRydWU7ICAgIFxyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcbiAgICB9XHJcbiAgICBidFN0YXRlLmNvbW1hbmQgPSBudWxsO1xyXG4gICAgYnRTdGF0ZS5zdG9wUmVxdWVzdCA9IGZhbHNlO1xyXG4gICAgbG9nLndhcm4oXCJTdG9wcGVkIG9uIHJlcXVlc3QuXCIpO1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0ge1N0b3AsUGFpcixFeGVjdXRlLEV4ZWN1dGVKU09OLFNpbXBsZUV4ZWN1dGUsU2ltcGxlRXhlY3V0ZUpTT04sR2V0U3RhdGUsR2V0U3RhdGVKU09OfSIsIid1c2Ugc3RyaWN0JztcclxuXHJcbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgUlRVIGhhbmRsaW5nICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqL1xyXG5cclxudmFyIGxvZyA9IHJlcXVpcmUoJ2xvZ2xldmVsJyk7XHJcblxyXG5jb25zdCBTRU5FQ0FfTUJfU0xBVkVfSUQgPSAyNTsgLy8gTW9kYnVzIFJUVSBzbGF2ZSBJRFxyXG5cclxuY2xhc3MgTW9kYnVzRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgICAvKipcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgbW9kYnVzIGVycm9yXHJcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gbWVzc2FnZSBtZXNzYWdlXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gZmMgZnVuY3Rpb24gY29kZVxyXG4gICAgICovXHJcbiAgICBjb250cnVjdG9yKG1lc3NhZ2UsIGZjKSB7XHJcbiAgICAgICAgdGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcclxuICAgICAgICB0aGlzLmZjID0gZmM7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIHRoZSA0IGJ5dGVzIENSQyBjb2RlIGZyb20gdGhlIGJ1ZmZlciBjb250ZW50c1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGNyYzE2KGJ1ZmZlcikge1xyXG4gICAgdmFyIGNyYyA9IDB4RkZGRjtcclxuICAgIHZhciBvZGQ7XHJcblxyXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBidWZmZXIubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBjcmMgPSBjcmMgXiBidWZmZXJbaV07XHJcblxyXG4gICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgODsgaisrKSB7XHJcbiAgICAgICAgICAgIG9kZCA9IGNyYyAmIDB4MDAwMTtcclxuICAgICAgICAgICAgY3JjID0gY3JjID4+IDE7XHJcbiAgICAgICAgICAgIGlmIChvZGQpIHtcclxuICAgICAgICAgICAgICAgIGNyYyA9IGNyYyBeIDB4QTAwMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gY3JjO1xyXG59XHJcblxyXG4vKipcclxuICogTWFrZSBhIE1vZGJ1cyBSZWFkIEhvbGRpbmcgUmVnaXN0ZXJzIChGQz0wMykgdG8gc2VyaWFsIHBvcnRcclxuICogXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBJRCBzbGF2ZSBJRFxyXG4gKiBAcGFyYW0ge251bWJlcn0gY291bnQgbnVtYmVyIG9mIHJlZ2lzdGVycyB0byByZWFkXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSByZWdpc3RlciBzdGFydGluZyByZWdpc3RlclxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMyhJRCwgY291bnQsIHJlZ2lzdGVyKSB7XHJcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoOCk7XHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KGJ1ZmZlcik7XHJcbiAgICB2aWV3LnNldFVpbnQ4KDAsIElEKTtcclxuICAgIHZpZXcuc2V0VWludDgoMSwgMyk7XHJcbiAgICB2aWV3LnNldFVpbnQxNigyLCByZWdpc3RlciwgZmFsc2UpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoNCwgY291bnQsIGZhbHNlKTtcclxuICAgIHZhciBjcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShidWZmZXIuc2xpY2UoMCwgLTIpKSk7XHJcbiAgICB2aWV3LnNldFVpbnQxNig2LCBjcmMsIHRydWUpO1xyXG4gICAgcmV0dXJuIGJ1ZmZlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdyaXRlIGEgTW9kYnVzIFwiUHJlc2V0IE11bHRpcGxlIFJlZ2lzdGVyc1wiIChGQz0xNikgdG8gc2VyaWFsIHBvcnQuXHJcbiAqXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBhZGRyZXNzIHRoZSBzbGF2ZSB1bml0IGFkZHJlc3MuXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBkYXRhQWRkcmVzcyB0aGUgRGF0YSBBZGRyZXNzIG9mIHRoZSBmaXJzdCByZWdpc3Rlci5cclxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgdGhlIGFycmF5IG9mIHZhbHVlcyB0byB3cml0ZSB0byByZWdpc3RlcnMuXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlRkMxNihhZGRyZXNzLCBkYXRhQWRkcmVzcywgYXJyYXkpIHtcclxuICAgIGNvbnN0IGNvZGUgPSAxNjtcclxuXHJcbiAgICAvLyBzYW5pdHkgY2hlY2tcclxuICAgIGlmICh0eXBlb2YgYWRkcmVzcyA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0eXBlb2YgZGF0YUFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGRhdGFMZW5ndGggPSBhcnJheS5sZW5ndGg7XHJcblxyXG4gICAgY29uc3QgY29kZUxlbmd0aCA9IDcgKyAyICogZGF0YUxlbmd0aDtcclxuICAgIGNvbnN0IGJ1ZiA9IG5ldyBBcnJheUJ1ZmZlcihjb2RlTGVuZ3RoICsgMik7IC8vIGFkZCAyIGNyYyBieXRlc1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmKTtcclxuXHJcbiAgICBkdi5zZXRVaW50OCgwLCBhZGRyZXNzKTtcclxuICAgIGR2LnNldFVpbnQ4KDEsIGNvZGUpO1xyXG4gICAgZHYuc2V0VWludDE2KDIsIGRhdGFBZGRyZXNzLCBmYWxzZSk7XHJcbiAgICBkdi5zZXRVaW50MTYoNCwgZGF0YUxlbmd0aCwgZmFsc2UpO1xyXG4gICAgZHYuc2V0VWludDgoNiwgZGF0YUxlbmd0aCAqIDIpO1xyXG5cclxuICAgIC8vIGNvcHkgY29udGVudCBvZiBhcnJheSB0byBidWZcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YUxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgZHYuc2V0VWludDE2KDcgKyAyICogaSwgYXJyYXlbaV0sIGZhbHNlKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KGJ1Zi5zbGljZSgwLCAtMikpKVxyXG4gICAgLy8gYWRkIGNyYyBieXRlcyB0byBidWZmZXJcclxuICAgIGR2LnNldFVpbnQxNihjb2RlTGVuZ3RoLCBjcmMsIHRydWUpO1xyXG4gICAgcmV0dXJuIGJ1ZjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgdGhlIHJlZ2lzdGVycyB2YWx1ZXMgZnJvbSBhIEZDMDMgYW5zd2VyIGJ5IFJUVSBzbGF2ZVxyXG4gKiBcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMzKHJlc3BvbnNlKSB7XHJcbiAgICBpZiAoIShyZXNwb25zZSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhyZXNwb25zZSk7XHJcbiAgICB2YXIgY29udGVudHMgPSBbXTtcclxuXHJcbiAgICAvLyBJbnZhbGlkIG1vZGJ1cyBwYWNrZXRcclxuICAgIGlmIChyZXNwb25zZS5sZW5ndGggPCA1KVxyXG4gICAgICAgIHJldHVybjtcclxuXHJcbiAgICB2YXIgY29tcHV0ZWRfY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkocmVzcG9uc2Uuc2xpY2UoMCwgLTIpKSk7XHJcbiAgICB2YXIgYWN0dWFsX2NyYyA9IHZpZXcuZ2V0VWludDE2KHZpZXcuYnl0ZUxlbmd0aCAtIDIsIHRydWUpO1xyXG5cclxuICAgIGlmIChjb21wdXRlZF9jcmMgIT0gYWN0dWFsX2NyYykge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIENSQyAoZXhwZWN0ZWQ6XCIgKyBjb21wdXRlZF9jcmMgKyBcIixnb3Q6XCIgKyBhY3R1YWxfY3JjICsgXCIpXCIsIDMpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50OCgwKTtcclxuICAgIGlmIChhZGRyZXNzICE9IFNFTkVDQV9NQl9TTEFWRV9JRCkge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIHNsYXZlIElEIDpcIiArIGFkZHJlc3MsIDMpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcbiAgICBpZiAoZmMgPiAxMjgpIHtcclxuICAgICAgICB2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gYnkgc2xhdmU6XCIgKyBleHAsIDMpO1xyXG4gICAgfVxyXG4gICAgaWYgKGZjICE9IDMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIExlbmd0aCBpbiBieXRlcyBmcm9tIHNsYXZlIGFuc3dlclxyXG4gICAgdmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDgoMik7XHJcblxyXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKGxlbmd0aCk7XHJcbiAgICBjb25zdCByZWdpc3RlcnMgPSBuZXcgRGF0YVZpZXcoYnVmZmVyKTtcclxuXHJcbiAgICBmb3IgKHZhciBpID0gMzsgaSA8IHZpZXcuYnl0ZUxlbmd0aCAtIDI7IGkgKz0gMikge1xyXG4gICAgICAgIHZhciByZWcgPSB2aWV3LmdldEludDE2KGksIGZhbHNlKTtcclxuICAgICAgICByZWdpc3RlcnMuc2V0SW50MTYoaSAtIDMsIHJlZywgZmFsc2UpO1xyXG4gICAgICAgIHZhciBpZHggPSAoKGkgLSAzKSAvIDIgKyAxKTtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWdpc3RlciBcIiArIGlkeCArIFwiL1wiICsgKGxlbmd0aCAvIDIpICsgXCIgPSBcIiArIHJlZyk7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHJlZ2lzdGVycztcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIGlmIHRoZSBGQzE2IHJlc3BvbnNlIGlzIGNvcnJlY3QgKENSQywgcmV0dXJuIGNvZGUpIEFORCBvcHRpb25hbGx5IG1hdGNoaW5nIHRoZSByZWdpc3RlciBsZW5ndGggZXhwZWN0ZWRcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2UgbW9kYnVzIHJ0dSByYXcgb3V0cHV0XHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBleHBlY3RlZCBudW1iZXIgb2YgZXhwZWN0ZWQgd3JpdHRlbiByZWdpc3RlcnMgZnJvbSBzbGF2ZS4gSWYgPD0wLCBpdCB3aWxsIG5vdCBiZSBjaGVja2VkLlxyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiBhbGwgcmVnaXN0ZXJzIGhhdmUgYmVlbiB3cml0dGVuXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCBleHBlY3RlZCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBwYXJzZUZDMTYocmVzcG9uc2UpO1xyXG4gICAgICAgIHJldHVybiAoZXhwZWN0ZWQgPD0gMCB8fCByZXN1bHRbMV0gPT09IGV4cGVjdGVkKTsgLy8gY2hlY2sgaWYgbGVuZ3RoIGlzIG1hdGNoaW5nXHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLmVycm9yKFwiRkMxNiBhbnN3ZXIgZXJyb3JcIiwgZXJyKTtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgYW5zd2VyIHRvIHRoZSB3cml0ZSBtdWx0aXBsZSByZWdpc3RlcnMgZnJvbSB0aGUgc2xhdmVcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMxNihyZXNwb25zZSkge1xyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhyZXNwb25zZSk7XHJcbiAgICB2YXIgY29udGVudHMgPSBbXTtcclxuXHJcbiAgICBpZiAocmVzcG9uc2UubGVuZ3RoIDwgMylcclxuICAgICAgICByZXR1cm47XHJcblxyXG4gICAgdmFyIHNsYXZlID0gdmlldy5nZXRVaW50OCgwKTtcclxuXHJcbiAgICBpZiAoc2xhdmUgIT0gU0VORUNBX01CX1NMQVZFX0lEKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcbiAgICBpZiAoZmMgPiAxMjgpIHtcclxuICAgICAgICB2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gOlwiICsgZXhwLCAxNik7XHJcbiAgICB9XHJcbiAgICBpZiAoZmMgIT0gMTYpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG4gICAgfVxyXG4gICAgdmFyIGNvbXB1dGVkX2NyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KHJlc3BvbnNlLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmFyIGFjdHVhbF9jcmMgPSB2aWV3LmdldFVpbnQxNih2aWV3LmJ5dGVMZW5ndGggLSAyLCB0cnVlKTtcclxuXHJcbiAgICBpZiAoY29tcHV0ZWRfY3JjICE9IGFjdHVhbF9jcmMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBDUkMgKGV4cGVjdGVkOlwiICsgY29tcHV0ZWRfY3JjICsgXCIsZ290OlwiICsgYWN0dWFsX2NyYyArIFwiKVwiLCAxNik7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIGFkZHJlc3MgPSB2aWV3LmdldFVpbnQxNigyLCBmYWxzZSk7XHJcbiAgICB2YXIgbGVuZ3RoID0gdmlldy5nZXRVaW50MTYoNCwgZmFsc2UpO1xyXG4gICAgcmV0dXJuIFthZGRyZXNzLCBsZW5ndGhdO1xyXG59XHJcblxyXG5cclxuXHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gZmxvYXRcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBjb252ZXJ0ZWQgdmFsdWVcclxuICovXHJcbmZ1bmN0aW9uIGdldEZsb2F0MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQpIHtcclxuICAgIGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICBjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuICAgIGR2LnNldEludDE2KDAsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCArIDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZHYuc2V0SW50MTYoMiwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0LCBmYWxzZSksIGZhbHNlKTtcclxuICAgIHJldHVybiBkdi5nZXRGbG9hdDMyKDAsIGZhbHNlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IFVpbnQzMlxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGNvbnZlcnRlZCB2YWx1ZVxyXG4gKi9cclxuZnVuY3Rpb24gZ2V0VWludDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0KSB7XHJcbiAgICBjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcbiAgICBkdi5zZXRJbnQxNigwLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQgKyAyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGR2LnNldEludDE2KDIsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICByZXR1cm4gZHYuZ2V0VWludDMyKDAsIGZhbHNlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IGZsb2F0XHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHBhcmFtIHt2YWx1ZX0gbnVtYmVyIHZhbHVlIHRvIHNldFxyXG4gKi9cclxuZnVuY3Rpb24gc2V0RmxvYXQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCwgdmFsdWUpIHtcclxuICAgIGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICBjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuICAgIGR2LnNldEZsb2F0MzIoMCwgdmFsdWUsIGZhbHNlKTtcclxuICAgIGRhdGFWaWV3LnNldEludDE2KG9mZnNldCwgZHYuZ2V0SW50MTYoMiwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICBkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQgKyAyLCBkdi5nZXRJbnQxNigwLCBmYWxzZSksIGZhbHNlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgdWludDMyIGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcGFyYW0ge251bWJlcn0gdmFsdWUgdmFsdWUgdG8gc2V0XHJcbiAqL1xyXG5mdW5jdGlvbiBzZXRVaW50MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQsIHZhbHVlKSB7XHJcbiAgICBjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcbiAgICBkdi5zZXRVaW50MzIoMCwgdmFsdWUsIGZhbHNlKTtcclxuICAgIGRhdGFWaWV3LnNldEludDE2KG9mZnNldCwgZHYuZ2V0SW50MTYoMiwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICBkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQgKyAyLCBkdi5nZXRJbnQxNigwLCBmYWxzZSksIGZhbHNlKTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IG1ha2VGQzMsIGdldEZsb2F0MzJMRUJTLCBtYWtlRkMxNiwgc2V0RmxvYXQzMkxFQlMsIHNldFVpbnQzMkxFQlMsIHBhcnNlRkMzLCBwYXJzZUZDMTYsIHBhcnNlRkMxNmNoZWNrZWQsIE1vZGJ1c0Vycm9yLCBTRU5FQ0FfTUJfU0xBVkVfSUQsIGdldFVpbnQzMkxFQlMsIGNyYzE2fSIsIid1c2Ugc3RyaWN0JztcclxuXHJcbmNvbnN0IHRlc3RUcmFjZXMgPSBbXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDBhIDAwIDAyIGU3IGQxXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNWYgNDMgM2EgOTAgOTMgM2VcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NCA5OSBhZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGQ5IDNlIDQwIDgwIDA4IGMyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDY0IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMSAwMiAwMCAwNSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDczIGNkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAxIDAyIDAwIDA2IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDEgNzMgY2RcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMSA1OSA4NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NiAwMCAwMSA2NyBjZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzAgMDAgM2EgMmYgYzMgNjVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAyIDE5IDg3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgODAgMDAgMzkgNzYgYzAgMDAgM2EgMmYgNjAgMDAgMzkgZWQgMDcgNjdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4MCAwMCAzOSA3NiBjMCAwMCAzYSAyZiBjMCAwMCAzYSAyZiBhNCAwNlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIDgwIDAwIDM5IDc2IGMwIDAwIDNhIDJmIDgwIDAwIDM5IDc2IDcxIDBjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDAzIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwMyBkOCA0N1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIDJkIDVjIDNjIDg2IDJkIDVjIDNjIDg2IGI2IGQ4IDNjIDRhIGI2IDAzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgNDcgNzQgM2MgMTEgMmQgNWMgM2MgODYgNDcgNzQgM2MgMTEgOTYgMmJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyA4OCA3YyAzYiBmOSAyZCA1YyAzYyA4NiA4OCA3YyAzYiBmOSAwOCA2OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwNCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDQgOTkgODVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmNCBlMyBjMCBlYSBmNCBlMyBjMCBlYSBmNCBlMyBjMCBlYSAxNSA4Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIGY0IGUzIGMwIGVhIGVjIGU0IGMwIGVhIGY0IGUzIGMwIGVhIDYzIGU2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDg0IDAwIDA2IDg2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMGMgZjQgZTMgYzAgZWEgZWMgZTQgYzAgZWEgZWMgZTQgYzAgZWEgZDQgODdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODQgMDAgMDYgODYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwYyBmYyBlMyBjMCBlYSBlYyBlNCBjMCBlYSBmYyBlMyBjMCBlYSA4MCA1OVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4NCAwMCAwNiA4NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDBjIGZjIGUzIGMwIGVhIGVjIGU0IGMwIGVhIGY0IGUzIGMwIGVhIDgyIDM5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA1IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyNiAxOSA5Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA1IDU4IDQ1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgN2YgZDIgYzMgMGQgNGEgZWFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA2IDE4IDQ0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZDEgMDAgYzMgNzUgY2EgMTlcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjYgMDAgMDEgNjcgY2RcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAyMCAwMCA4MSA4NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDMzIGQzIGMzIDc2IDRkIDk5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDA3IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwNyBkOSA4NFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDkwIGMzIDg3IDcyIDhkXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgZmUgYjcgYzMgODYgMzIgYWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMDggZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDA4IDk5IDgwXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYmUgMjcgYzIgZWIgZTcgM2VcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBiYiBhZCBjMiBlYiBjNiAxOFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwOSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMDkgNTggNDBcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAxZiBiNyBjMiBkMyBjNSAzZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDQ3IDYzIGMyIGQzIDk2IDY1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMWQgNTUgYzIgZDMgNjQgYjNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBhIDE4IDQxXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNmIgNWUgYzYgM2UgY2QgYjRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2MyA3ZCBjNiAzZSAzZSAxZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAwYiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMGIgZDkgODFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA3NyAyOSBjZiA3YyBmYyA1ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDYwIGVmIGNmIDdkIGQ4IDE2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBjIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwYyA5OCA0M1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDM0IDUxIGNkIGNlIGU4IGQ3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYTYgZWEgY2QgY2UgYjQgNGFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNzggMDAgMDIgNDcgY2FcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBmOSBlZSBjZCBjZCBhNyA5ZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGE1IGJjIGNkIGNlIDU0IDFlXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDA0IDAwIDAxIDAwIDBkIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMzMgY2NcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAwZCA1OSA4M1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA3OCAwMCAwMiA0NyBjYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDU0IDc2IGNjIGIwIGM3IDZjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDc4IDAwIDAyIDQ3IGNhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgN2MgNmUgY2MgYjAgNGUgY2JcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBlIDE5IDgyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNGYgNDQgNDQgNWIgMzYgYjYgNDMgYzcgNWYgNDZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMGYgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDBmIGQ4IDQyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZjAgNzUgYzMgYjMgMWMgNGUgYzMgYzcgYTIgZjhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDEwIDk5IDhhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNWQgNmYgNDQgNWIgM2UgZWQgNDMgYzcgMzcgMjJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDExIDU4IDRhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZmIgYjEgNDUgMmYgNGYgOWEgNDUgN2QgMWIgOTJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTIgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDEyIDE4IDRiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggYzYgYjAgNDUgMmEgNmQgMDAgYzUgN2QgNGUgNDhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTMgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDEzIGQ5IDhiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggZmEgZWQgNDUgMmYgNGUgZmUgNDUgN2QgMDYgNzhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTQgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE0IDk4IDQ5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggNDIgN2MgNDQgNjEgNGYgOWEgNDUgN2QgYTUgOWZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgNmIgMDAgMDIgMDQgMDAgMDEgMDAgMTUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAzMyBjY1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDE1IDU5IDg5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggN2YgYzAgYzMgYzAgODcgOTggYzUgNzIgMDcgMTNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAxMiA3NyBjMyBjZCA5YiBjMSBjNSA2YiAzYyAyMVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA4MCAwMCAwNCA0NiAzOVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA4IDlkIGU4IGMzIGI3IDEzIGE5IGM1IDc3IDY5IDc3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDgwIDAwIDA0IDQ2IDM5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDggODIgZDAgYzMgYWQgZjYgZDYgYzUgN2IgY2UgZWJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA1NyA4OSBjMyBkNCA0YiAxNCBjNSA2NyBkMyAxZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxNyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTcgZDggNDhcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0MSAwNiA0NCAyZSAyOSA1MyA0MyA0NyAyNiA4NlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxOCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTggOTggNGNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBhYyAyZiBjNCA0NSAyNSBhNSBjMyA0NyBlOSAzZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxOSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMTkgNTkgOGNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0ZiA5MiA0NCAyZSAzNSBjNiA0MyA0NyA2NSA3ZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxYSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWEgMTkgOGRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBhZiA4MiA0MyA2NyAyOSA1MyA0MyA0NyBiMSAzM1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxYiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWIgZDggNGRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA0NiBhNyBjNCAxMyAyNSBhNSBjMyA0NyAyNyAwZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxYyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWMgOTkgOGZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBjYyA5OCA0MyA2NyAzNSBjNiA0MyA0NyA1YiA3M1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxZCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWQgNTggNGZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA3MCBlNSA0MyA5YSAzNiBiNiA0MyBjNyA5MCBiZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxZSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWUgMTggNGVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwNCAzNCBjNyAwNiAxYyA0ZSBjMyBjNyA3MSAxNVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAxZiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMWYgZDkgOGVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA2ZSBkZiA0MyA5YSAzZSBlZCA0MyBjNyBmOSA4ZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjAgOTkgOWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBkZiBlZiA0MyA4OSAzNiBiNiA0MyBjNyBmNSA0NVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjEgNTggNWVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA2YSAxZSBjNSBkZCAxYyA0ZSBjMyBjNyAxOCA4MlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjIgMTggNWZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgODAgMDAgMDQgNDYgMzlcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCBlNSBlZCA0MyA4OSAzZSBlZCA0MyBjNyAyNiA1ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyMyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjMgZDkgOWZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgMDAgMDAgMDQgNDcgZDFcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCA3ZiAwMCAwMSAwMCAwMCAyYyAwMCAwMSBhZCBjYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyNCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjQgOTggNWRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYTQgMDAgMDIgODYgMzBcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCA2YSA0OCAzZCBkNSAyZSBmM1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCA2YiAwMCAwMiAwNCAwMCAwMSAwMCAyNSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIDZiIDAwIDAyIDMzIGNjXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjUgNTkgOWRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgOTYgMDAgMDQgYTcgZmRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMCAwMCAwMCAwMCAwMCAwMCAwMCAwMCBlYiA3N1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiAwNCAwMCAwMCA0MCA4MCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIGUyIDI5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY1IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NSA1OCA2ZFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBjYSAwMCAwMSBhNyBlY1wiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDAwIDk4IDQ2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGQyIDAwIDAyIDY3IGVhXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgMDAgMDAgNDAgODAgNTIgNTJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCAyOCA5OCA1OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkMiAwMCAwMiAwNCAwMCAwMCA0MSAyMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQyIDAwIDAyIGUyIDI5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY2IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2NiAxOCA2Y1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkMiAwMCAwMiA2NyBlYVwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIDIwIDUzIGJhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGNhIDAwIDAxIGE3IGVjXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgODAgMDAgZjkgODZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgZDQgMDAgMDIgMDQgMDAgMDAgNDEgMjAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwMiAyOFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2NyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNjcgZDkgYWNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZDQgMDAgMDIgODcgZWJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCAwMCAwMCA0MSAyMCA1MyBiYVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkNCAwMCAwMiAwNCA2NiA2NiA0MCA4NiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQ0IDAwIDAyIDAyIDI4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDY4IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2OCA5OSBhOFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkNCAwMCAwMiA4NyBlYlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDY2IDY2IDQwIDg2IDJjIGM3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGRjIDAwIDAyIDA0IDY2IDY2IDQwIDg2IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZGMgMDAgMDIgODMgZWFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNjkgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDY5IDU4IDY4XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGRjIDAwIDAyIDA2IDI5XCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgNjYgNjYgNDAgODYgMmMgYzdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmEgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZhIDE4IDY5XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZiIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2YiBkOSBhOVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2YyBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmMgOTggNmJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNmUgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDZlIDE5IGFhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDZkIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA2ZCA1OSBhYlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA2ZiBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNmYgZDggNmFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgNzAgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDcwIDk5IGEyXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDcxIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3MSA1OCA2MlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBlNCAwMCAwMiAwNCAwMCAwMCA0MSBjOCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDAyIDI3XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDcyIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA3MiAxOCA2M1wiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBlNCAwMCAwMiA4NyBlNFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIGM4IDUzIGY0XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgMjcgZDggNWNcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYyBlNyA0MCA4MCBkZCAzNVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3NSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzUgNTkgYTFcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjZCA3NiA0MCA4MCA4ZCAyNFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3OCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgNzggOTggNjRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgN2IgZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCA2NCAwMCAwMSBjNiAwZFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDAyIDAwIDdiIGQ4IDY1XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzcgNGIgNDAgODAgMWYgMzBcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYyA1OCA0MCA4MCBlYyBkMVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA3ZSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgN2UgMTggNjZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYiBjOCA0MCA4MCBlZCA4OFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4MSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODEgNTggMjZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjYSBhOSA0MCA4MCBiZCBhYVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwMSAwMCA4NCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODQgOTggMjVcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNSA5YyA0MCA4MCBhZSBiMFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBkOCAwMCAwMiAwNCAwMCAwMCA0MSBmMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGQ4IDAwIDAyIGMyIDJiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDA0IDAwIDAxIDAwIDg3IGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgNzIgMmZcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgNjQgMDAgMDEgYzYgMGRcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwMiAwMCA4NyBkOCAyNFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBkOCAwMCAwMiA0NyBlOFwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IDAwIDAwIDQxIGYwIDUyIDI2XCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGZlIDAwIDA0IDA4IDAxIDRkIDAwIDAwIDAxIDRlIDAwIDAwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZmUgMDAgMDQgYTMgZTJcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMTAgMDAgY2YgMDAgMDIgMDQgMDAgMDEgMDAgODggZmYgZmZcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiA3MiAyZlwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjZiAwMCAwMiAwNCAwMCAwOSAwMCAwMSBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGNmIDAwIDAyIDcyIDJmXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIDY0IDAwIDAxIGM2IDBkXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDIgMDAgODggOTggMjBcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgZmUgMDAgMDQgMjYgMjFcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwOCAwMSA0ZCAwMCAwMCAwMSA0ZSAwMCAwMCBkNiA1NFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGFhIGFmIDQwIDgwIDQzIGFiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzUgMGMgNDAgODAgYWUgOWRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjOSA4OSA0MCA4MCBiYyAyNFwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGNiIDM5IDQwIDgwIGJjIDdiXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzcgZGIgNDAgODAgMWYgMWRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjNiBiYyA0MCA4MCBhZiAzZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM0IDdkIDQwIDgwIGZmIDdhXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDAzIDAwIGFlIDAwIDAyIGE2IDMyXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMDMgMDQgYzMgNWUgNDAgODAgMGYgYzRcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjOCA2YiA0MCA4MCAxZCBlZVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAwMyAwMCBhZSAwMCAwMiBhNiAzMlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDAzIDA0IGM2IDJjIDQwIDgwIGFmIDEzXCJcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIFwicmVxdWVzdFwiOiBcIjE5IDEwIDAwIGU0IDAwIDAyIDA0IDAwIDAwIDQxIGYwIGZmIGZmXCIsXHJcbiAgICAgIFwiYW5zd2VyXCI6IFwiMTkgMTAgMDAgZTQgMDAgMDIgMDIgMjdcIlxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgXCJyZXF1ZXN0XCI6IFwiMTkgMDMgMDAgYWUgMDAgMDIgYTYgMzJcIixcclxuICAgICAgXCJhbnN3ZXJcIjogXCIxOSAwMyAwNCBjMiBjZSA0MCA4MCAwZSAxNVwiXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBcInJlcXVlc3RcIjogXCIxOSAxMCAwMCBjMCAwMCAwMiAwNCAwMCAwMCA0MSAyMCBmZiBmZlwiLFxyXG4gICAgICBcImFuc3dlclwiOiBcIjE5IDEwIDAwIGMwIDAwIDAyIDQyIDJjXCJcclxuICAgIH1cclxuICBdXHJcblxyXG5mdW5jdGlvbiB1bmlxQnkoYSwga2V5KSB7XHJcbiAgICB2YXIgc2VlbiA9IHt9O1xyXG4gICAgcmV0dXJuIGEuZmlsdGVyKGZ1bmN0aW9uIChpdGVtKSB7XHJcbiAgICAgICAgdmFyIGsgPSBrZXkoaXRlbSk7XHJcbiAgICAgICAgcmV0dXJuIHNlZW4uaGFzT3duUHJvcGVydHkoaykgPyBmYWxzZSA6IChzZWVuW2tdID0gdHJ1ZSk7XHJcbiAgICB9KVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYW1lTWVzc2FnZSh0cmFjZSkge1xyXG4gICAgcmV0dXJuIHRyYWNlW1wicmVxdWVzdFwiXSArIFwiIC0+IFwiICsgdHJhY2VbXCJhbnN3ZXJcIl07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIEdldEpzb25UcmFjZXMoKSB7XHJcbiAgICB0ZXN0VHJhY2VzID0gdW5pcUJ5KHRlc3RUcmFjZXMsIHNhbWVNZXNzYWdlKTtcclxuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh0ZXN0VHJhY2VzKTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7IHRlc3RUcmFjZXMsIEdldEpzb25UcmFjZXMgfSIsIi8qXG4qIGxvZ2xldmVsIC0gaHR0cHM6Ly9naXRodWIuY29tL3BpbXRlcnJ5L2xvZ2xldmVsXG4qXG4qIENvcHlyaWdodCAoYykgMjAxMyBUaW0gUGVycnlcbiogTGljZW5zZWQgdW5kZXIgdGhlIE1JVCBsaWNlbnNlLlxuKi9cbihmdW5jdGlvbiAocm9vdCwgZGVmaW5pdGlvbikge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGlmICh0eXBlb2YgZGVmaW5lID09PSAnZnVuY3Rpb24nICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKGRlZmluaXRpb24pO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBkZWZpbml0aW9uKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcm9vdC5sb2cgPSBkZWZpbml0aW9uKCk7XG4gICAgfVxufSh0aGlzLCBmdW5jdGlvbiAoKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICAvLyBTbGlnaHRseSBkdWJpb3VzIHRyaWNrcyB0byBjdXQgZG93biBtaW5pbWl6ZWQgZmlsZSBzaXplXG4gICAgdmFyIG5vb3AgPSBmdW5jdGlvbigpIHt9O1xuICAgIHZhciB1bmRlZmluZWRUeXBlID0gXCJ1bmRlZmluZWRcIjtcbiAgICB2YXIgaXNJRSA9ICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlKSAmJiAodHlwZW9mIHdpbmRvdy5uYXZpZ2F0b3IgIT09IHVuZGVmaW5lZFR5cGUpICYmIChcbiAgICAgICAgL1RyaWRlbnRcXC98TVNJRSAvLnRlc3Qod2luZG93Lm5hdmlnYXRvci51c2VyQWdlbnQpXG4gICAgKTtcblxuICAgIHZhciBsb2dNZXRob2RzID0gW1xuICAgICAgICBcInRyYWNlXCIsXG4gICAgICAgIFwiZGVidWdcIixcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgIFwid2FyblwiLFxuICAgICAgICBcImVycm9yXCJcbiAgICBdO1xuXG4gICAgLy8gQ3Jvc3MtYnJvd3NlciBiaW5kIGVxdWl2YWxlbnQgdGhhdCB3b3JrcyBhdCBsZWFzdCBiYWNrIHRvIElFNlxuICAgIGZ1bmN0aW9uIGJpbmRNZXRob2Qob2JqLCBtZXRob2ROYW1lKSB7XG4gICAgICAgIHZhciBtZXRob2QgPSBvYmpbbWV0aG9kTmFtZV07XG4gICAgICAgIGlmICh0eXBlb2YgbWV0aG9kLmJpbmQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiBtZXRob2QuYmluZChvYmopO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gRnVuY3Rpb24ucHJvdG90eXBlLmJpbmQuY2FsbChtZXRob2QsIG9iaik7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgLy8gTWlzc2luZyBiaW5kIHNoaW0gb3IgSUU4ICsgTW9kZXJuaXpyLCBmYWxsYmFjayB0byB3cmFwcGluZ1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEZ1bmN0aW9uLnByb3RvdHlwZS5hcHBseS5hcHBseShtZXRob2QsIFtvYmosIGFyZ3VtZW50c10pO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUcmFjZSgpIGRvZXNuJ3QgcHJpbnQgdGhlIG1lc3NhZ2UgaW4gSUUsIHNvIGZvciB0aGF0IGNhc2Ugd2UgbmVlZCB0byB3cmFwIGl0XG4gICAgZnVuY3Rpb24gdHJhY2VGb3JJRSgpIHtcbiAgICAgICAgaWYgKGNvbnNvbGUubG9nKSB7XG4gICAgICAgICAgICBpZiAoY29uc29sZS5sb2cuYXBwbHkpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZy5hcHBseShjb25zb2xlLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBJbiBvbGQgSUUsIG5hdGl2ZSBjb25zb2xlIG1ldGhvZHMgdGhlbXNlbHZlcyBkb24ndCBoYXZlIGFwcGx5KCkuXG4gICAgICAgICAgICAgICAgRnVuY3Rpb24ucHJvdG90eXBlLmFwcGx5LmFwcGx5KGNvbnNvbGUubG9nLCBbY29uc29sZSwgYXJndW1lbnRzXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbnNvbGUudHJhY2UpIGNvbnNvbGUudHJhY2UoKTtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCB0aGUgYmVzdCBsb2dnaW5nIG1ldGhvZCBwb3NzaWJsZSBmb3IgdGhpcyBlbnZcbiAgICAvLyBXaGVyZXZlciBwb3NzaWJsZSB3ZSB3YW50IHRvIGJpbmQsIG5vdCB3cmFwLCB0byBwcmVzZXJ2ZSBzdGFjayB0cmFjZXNcbiAgICBmdW5jdGlvbiByZWFsTWV0aG9kKG1ldGhvZE5hbWUpIHtcbiAgICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdkZWJ1ZycpIHtcbiAgICAgICAgICAgIG1ldGhvZE5hbWUgPSAnbG9nJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyBObyBtZXRob2QgcG9zc2libGUsIGZvciBub3cgLSBmaXhlZCBsYXRlciBieSBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzXG4gICAgICAgIH0gZWxzZSBpZiAobWV0aG9kTmFtZSA9PT0gJ3RyYWNlJyAmJiBpc0lFKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhY2VGb3JJRTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25zb2xlW21ldGhvZE5hbWVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBiaW5kTWV0aG9kKGNvbnNvbGUsIG1ldGhvZE5hbWUpO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbnNvbGUubG9nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBiaW5kTWV0aG9kKGNvbnNvbGUsICdsb2cnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBub29wO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVGhlc2UgcHJpdmF0ZSBmdW5jdGlvbnMgYWx3YXlzIG5lZWQgYHRoaXNgIHRvIGJlIHNldCBwcm9wZXJseVxuXG4gICAgZnVuY3Rpb24gcmVwbGFjZUxvZ2dpbmdNZXRob2RzKGxldmVsLCBsb2dnZXJOYW1lKSB7XG4gICAgICAgIC8qanNoaW50IHZhbGlkdGhpczp0cnVlICovXG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbG9nTWV0aG9kcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdmFyIG1ldGhvZE5hbWUgPSBsb2dNZXRob2RzW2ldO1xuICAgICAgICAgICAgdGhpc1ttZXRob2ROYW1lXSA9IChpIDwgbGV2ZWwpID9cbiAgICAgICAgICAgICAgICBub29wIDpcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGhvZEZhY3RvcnkobWV0aG9kTmFtZSwgbGV2ZWwsIGxvZ2dlck5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRGVmaW5lIGxvZy5sb2cgYXMgYW4gYWxpYXMgZm9yIGxvZy5kZWJ1Z1xuICAgICAgICB0aGlzLmxvZyA9IHRoaXMuZGVidWc7XG4gICAgfVxuXG4gICAgLy8gSW4gb2xkIElFIHZlcnNpb25zLCB0aGUgY29uc29sZSBpc24ndCBwcmVzZW50IHVudGlsIHlvdSBmaXJzdCBvcGVuIGl0LlxuICAgIC8vIFdlIGJ1aWxkIHJlYWxNZXRob2QoKSByZXBsYWNlbWVudHMgaGVyZSB0aGF0IHJlZ2VuZXJhdGUgbG9nZ2luZyBtZXRob2RzXG4gICAgZnVuY3Rpb24gZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlcyhtZXRob2ROYW1lLCBsZXZlbCwgbG9nZ2VyTmFtZSkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwodGhpcywgbGV2ZWwsIGxvZ2dlck5hbWUpO1xuICAgICAgICAgICAgICAgIHRoaXNbbWV0aG9kTmFtZV0uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBCeSBkZWZhdWx0LCB3ZSB1c2UgY2xvc2VseSBib3VuZCByZWFsIG1ldGhvZHMgd2hlcmV2ZXIgcG9zc2libGUsIGFuZFxuICAgIC8vIG90aGVyd2lzZSB3ZSB3YWl0IGZvciBhIGNvbnNvbGUgdG8gYXBwZWFyLCBhbmQgdGhlbiB0cnkgYWdhaW4uXG4gICAgZnVuY3Rpb24gZGVmYXVsdE1ldGhvZEZhY3RvcnkobWV0aG9kTmFtZSwgbGV2ZWwsIGxvZ2dlck5hbWUpIHtcbiAgICAgICAgLypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cbiAgICAgICAgcmV0dXJuIHJlYWxNZXRob2QobWV0aG9kTmFtZSkgfHxcbiAgICAgICAgICAgICAgIGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXMuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBMb2dnZXIobmFtZSwgZGVmYXVsdExldmVsLCBmYWN0b3J5KSB7XG4gICAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgICB2YXIgY3VycmVudExldmVsO1xuICAgICAgZGVmYXVsdExldmVsID0gZGVmYXVsdExldmVsID09IG51bGwgPyBcIldBUk5cIiA6IGRlZmF1bHRMZXZlbDtcblxuICAgICAgdmFyIHN0b3JhZ2VLZXkgPSBcImxvZ2xldmVsXCI7XG4gICAgICBpZiAodHlwZW9mIG5hbWUgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgc3RvcmFnZUtleSArPSBcIjpcIiArIG5hbWU7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBuYW1lID09PSBcInN5bWJvbFwiKSB7XG4gICAgICAgIHN0b3JhZ2VLZXkgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHBlcnNpc3RMZXZlbElmUG9zc2libGUobGV2ZWxOdW0pIHtcbiAgICAgICAgICB2YXIgbGV2ZWxOYW1lID0gKGxvZ01ldGhvZHNbbGV2ZWxOdW1dIHx8ICdzaWxlbnQnKS50b1VwcGVyQ2FzZSgpO1xuXG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIC8vIFVzZSBsb2NhbFN0b3JhZ2UgaWYgYXZhaWxhYmxlXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZVtzdG9yYWdlS2V5XSA9IGxldmVsTmFtZTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIFVzZSBzZXNzaW9uIGNvb2tpZSBhcyBmYWxsYmFja1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5kb2N1bWVudC5jb29raWUgPVxuICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPVwiICsgbGV2ZWxOYW1lICsgXCI7XCI7XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBnZXRQZXJzaXN0ZWRMZXZlbCgpIHtcbiAgICAgICAgICB2YXIgc3RvcmVkTGV2ZWw7XG5cbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgc3RvcmVkTGV2ZWwgPSB3aW5kb3cubG9jYWxTdG9yYWdlW3N0b3JhZ2VLZXldO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIEZhbGxiYWNrIHRvIGNvb2tpZXMgaWYgbG9jYWwgc3RvcmFnZSBnaXZlcyB1cyBub3RoaW5nXG4gICAgICAgICAgaWYgKHR5cGVvZiBzdG9yZWRMZXZlbCA9PT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgdmFyIGNvb2tpZSA9IHdpbmRvdy5kb2N1bWVudC5jb29raWU7XG4gICAgICAgICAgICAgICAgICB2YXIgbG9jYXRpb24gPSBjb29raWUuaW5kZXhPZihcbiAgICAgICAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj1cIik7XG4gICAgICAgICAgICAgICAgICBpZiAobG9jYXRpb24gIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgc3RvcmVkTGV2ZWwgPSAvXihbXjtdKykvLmV4ZWMoY29va2llLnNsaWNlKGxvY2F0aW9uKSlbMV07XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBJZiB0aGUgc3RvcmVkIGxldmVsIGlzIG5vdCB2YWxpZCwgdHJlYXQgaXQgYXMgaWYgbm90aGluZyB3YXMgc3RvcmVkLlxuICAgICAgICAgIGlmIChzZWxmLmxldmVsc1tzdG9yZWRMZXZlbF0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gc3RvcmVkTGV2ZWw7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGNsZWFyUGVyc2lzdGVkTGV2ZWwoKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIC8vIFVzZSBsb2NhbFN0b3JhZ2UgaWYgYXZhaWxhYmxlXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKHN0b3JhZ2VLZXkpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gVXNlIHNlc3Npb24gY29va2llIGFzIGZhbGxiYWNrXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmRvY3VtZW50LmNvb2tpZSA9XG4gICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9OyBleHBpcmVzPVRodSwgMDEgSmFuIDE5NzAgMDA6MDA6MDAgVVRDXCI7XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgfVxuXG4gICAgICAvKlxuICAgICAgICpcbiAgICAgICAqIFB1YmxpYyBsb2dnZXIgQVBJIC0gc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9waW10ZXJyeS9sb2dsZXZlbCBmb3IgZGV0YWlsc1xuICAgICAgICpcbiAgICAgICAqL1xuXG4gICAgICBzZWxmLm5hbWUgPSBuYW1lO1xuXG4gICAgICBzZWxmLmxldmVscyA9IHsgXCJUUkFDRVwiOiAwLCBcIkRFQlVHXCI6IDEsIFwiSU5GT1wiOiAyLCBcIldBUk5cIjogMyxcbiAgICAgICAgICBcIkVSUk9SXCI6IDQsIFwiU0lMRU5UXCI6IDV9O1xuXG4gICAgICBzZWxmLm1ldGhvZEZhY3RvcnkgPSBmYWN0b3J5IHx8IGRlZmF1bHRNZXRob2RGYWN0b3J5O1xuXG4gICAgICBzZWxmLmdldExldmVsID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHJldHVybiBjdXJyZW50TGV2ZWw7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnNldExldmVsID0gZnVuY3Rpb24gKGxldmVsLCBwZXJzaXN0KSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBsZXZlbCA9PT0gXCJzdHJpbmdcIiAmJiBzZWxmLmxldmVsc1tsZXZlbC50b1VwcGVyQ2FzZSgpXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIGxldmVsID0gc2VsZi5sZXZlbHNbbGV2ZWwudG9VcHBlckNhc2UoKV07XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0eXBlb2YgbGV2ZWwgPT09IFwibnVtYmVyXCIgJiYgbGV2ZWwgPj0gMCAmJiBsZXZlbCA8PSBzZWxmLmxldmVscy5TSUxFTlQpIHtcbiAgICAgICAgICAgICAgY3VycmVudExldmVsID0gbGV2ZWw7XG4gICAgICAgICAgICAgIGlmIChwZXJzaXN0ICE9PSBmYWxzZSkgeyAgLy8gZGVmYXVsdHMgdG8gdHJ1ZVxuICAgICAgICAgICAgICAgICAgcGVyc2lzdExldmVsSWZQb3NzaWJsZShsZXZlbCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwoc2VsZiwgbGV2ZWwsIG5hbWUpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgPT09IHVuZGVmaW5lZFR5cGUgJiYgbGV2ZWwgPCBzZWxmLmxldmVscy5TSUxFTlQpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBcIk5vIGNvbnNvbGUgYXZhaWxhYmxlIGZvciBsb2dnaW5nXCI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBcImxvZy5zZXRMZXZlbCgpIGNhbGxlZCB3aXRoIGludmFsaWQgbGV2ZWw6IFwiICsgbGV2ZWw7XG4gICAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgc2VsZi5zZXREZWZhdWx0TGV2ZWwgPSBmdW5jdGlvbiAobGV2ZWwpIHtcbiAgICAgICAgICBkZWZhdWx0TGV2ZWwgPSBsZXZlbDtcbiAgICAgICAgICBpZiAoIWdldFBlcnNpc3RlZExldmVsKCkpIHtcbiAgICAgICAgICAgICAgc2VsZi5zZXRMZXZlbChsZXZlbCwgZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHNlbGYucmVzZXRMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKGRlZmF1bHRMZXZlbCwgZmFsc2UpO1xuICAgICAgICAgIGNsZWFyUGVyc2lzdGVkTGV2ZWwoKTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuZW5hYmxlQWxsID0gZnVuY3Rpb24ocGVyc2lzdCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoc2VsZi5sZXZlbHMuVFJBQ0UsIHBlcnNpc3QpO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5kaXNhYmxlQWxsID0gZnVuY3Rpb24ocGVyc2lzdCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoc2VsZi5sZXZlbHMuU0lMRU5ULCBwZXJzaXN0KTtcbiAgICAgIH07XG5cbiAgICAgIC8vIEluaXRpYWxpemUgd2l0aCB0aGUgcmlnaHQgbGV2ZWxcbiAgICAgIHZhciBpbml0aWFsTGV2ZWwgPSBnZXRQZXJzaXN0ZWRMZXZlbCgpO1xuICAgICAgaWYgKGluaXRpYWxMZXZlbCA9PSBudWxsKSB7XG4gICAgICAgICAgaW5pdGlhbExldmVsID0gZGVmYXVsdExldmVsO1xuICAgICAgfVxuICAgICAgc2VsZi5zZXRMZXZlbChpbml0aWFsTGV2ZWwsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKlxuICAgICAqXG4gICAgICogVG9wLWxldmVsIEFQSVxuICAgICAqXG4gICAgICovXG5cbiAgICB2YXIgZGVmYXVsdExvZ2dlciA9IG5ldyBMb2dnZXIoKTtcblxuICAgIHZhciBfbG9nZ2Vyc0J5TmFtZSA9IHt9O1xuICAgIGRlZmF1bHRMb2dnZXIuZ2V0TG9nZ2VyID0gZnVuY3Rpb24gZ2V0TG9nZ2VyKG5hbWUpIHtcbiAgICAgICAgaWYgKCh0eXBlb2YgbmFtZSAhPT0gXCJzeW1ib2xcIiAmJiB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIikgfHwgbmFtZSA9PT0gXCJcIikge1xuICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJZb3UgbXVzdCBzdXBwbHkgYSBuYW1lIHdoZW4gY3JlYXRpbmcgYSBsb2dnZXIuXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGxvZ2dlciA9IF9sb2dnZXJzQnlOYW1lW25hbWVdO1xuICAgICAgICBpZiAoIWxvZ2dlcikge1xuICAgICAgICAgIGxvZ2dlciA9IF9sb2dnZXJzQnlOYW1lW25hbWVdID0gbmV3IExvZ2dlcihcbiAgICAgICAgICAgIG5hbWUsIGRlZmF1bHRMb2dnZXIuZ2V0TGV2ZWwoKSwgZGVmYXVsdExvZ2dlci5tZXRob2RGYWN0b3J5KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbG9nZ2VyO1xuICAgIH07XG5cbiAgICAvLyBHcmFiIHRoZSBjdXJyZW50IGdsb2JhbCBsb2cgdmFyaWFibGUgaW4gY2FzZSBvZiBvdmVyd3JpdGVcbiAgICB2YXIgX2xvZyA9ICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlKSA/IHdpbmRvdy5sb2cgOiB1bmRlZmluZWQ7XG4gICAgZGVmYXVsdExvZ2dlci5ub0NvbmZsaWN0ID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlICYmXG4gICAgICAgICAgICAgICB3aW5kb3cubG9nID09PSBkZWZhdWx0TG9nZ2VyKSB7XG4gICAgICAgICAgICB3aW5kb3cubG9nID0gX2xvZztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBkZWZhdWx0TG9nZ2VyO1xuICAgIH07XG5cbiAgICBkZWZhdWx0TG9nZ2VyLmdldExvZ2dlcnMgPSBmdW5jdGlvbiBnZXRMb2dnZXJzKCkge1xuICAgICAgICByZXR1cm4gX2xvZ2dlcnNCeU5hbWU7XG4gICAgfTtcblxuICAgIC8vIEVTNiBkZWZhdWx0IGV4cG9ydCwgZm9yIGNvbXBhdGliaWxpdHlcbiAgICBkZWZhdWx0TG9nZ2VyWydkZWZhdWx0J10gPSBkZWZhdWx0TG9nZ2VyO1xuXG4gICAgcmV0dXJuIGRlZmF1bHRMb2dnZXI7XG59KSk7XG4iLCIndXNlIHN0cmljdCc7XHJcblxyXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgUlRVIEZVTkNUSU9OUyBGT1IgU0VORUNBICoqKioqKioqKioqKioqKioqKioqKiovXHJcblxyXG52YXIgbW9kYnVzID0gcmVxdWlyZSgnLi9tb2RidXNSdHUnKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcclxuXHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuY29uc3QgU0VORUNBX01CX1NMQVZFX0lEID0gbW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRDsgLy8gTW9kYnVzIFJUVSBzbGF2ZSBJRFxyXG5cclxuLypcclxuICogTW9kYnVzIHJlZ2lzdGVycyBtYXAuIEVhY2ggcmVnaXN0ZXIgaXMgMiBieXRlcyB3aWRlLlxyXG4gKi9cclxuY29uc3QgTVNDUmVnaXN0ZXJzID0ge1xyXG4gICAgU2VyaWFsTnVtYmVyOiAxMCxcclxuICAgIEN1cnJlbnRNb2RlOiAxMDAsXHJcbiAgICBNZWFzdXJlRmxhZ3M6IDEwMixcclxuICAgIENNRDogMTA3LFxyXG4gICAgQVVYMTogMTA4LFxyXG4gICAgTG9hZENlbGxNZWFzdXJlOiAxMTQsXHJcbiAgICBUZW1wTWVhc3VyZTogMTIwLFxyXG4gICAgUnRkVGVtcGVyYXR1cmVNZWFzdXJlOiAxMjgsXHJcbiAgICBSdGRSZXNpc3RhbmNlTWVhc3VyZTogMTMwLFxyXG4gICAgRnJlcXVlbmN5TWVhc3VyZTogMTY0LFxyXG4gICAgTWluTWVhc3VyZTogMTMyLFxyXG4gICAgTWF4TWVhc3VyZTogMTM0LFxyXG4gICAgSW5zdGFudE1lYXN1cmU6IDEzNixcclxuICAgIFBvd2VyT2ZmRGVsYXk6IDE0MixcclxuICAgIFBvd2VyT2ZmUmVtYWluaW5nOiAxNDYsXHJcbiAgICBQdWxzZU9GRk1lYXN1cmU6IDE1MCxcclxuICAgIFB1bHNlT05NZWFzdXJlOiAxNTIsXHJcbiAgICBTZW5zaWJpbGl0eV91U19PRkY6IDE2NixcclxuICAgIFNlbnNpYmlsaXR5X3VTX09OOiAxNjgsXHJcbiAgICBCYXR0ZXJ5TWVhc3VyZTogMTc0LFxyXG4gICAgQ29sZEp1bmN0aW9uOiAxOTAsXHJcbiAgICBUaHJlc2hvbGRVX0ZyZXE6IDE5MixcclxuICAgIEdlbmVyYXRpb25GbGFnczogMjAyLFxyXG4gICAgR0VOX0NNRDogMjA3LFxyXG4gICAgR0VOX0FVWDE6IDIwOCxcclxuICAgIEN1cnJlbnRTZXRwb2ludDogMjEwLFxyXG4gICAgVm9sdGFnZVNldHBvaW50OiAyMTIsXHJcbiAgICBMb2FkQ2VsbFNldHBvaW50OiAyMTYsXHJcbiAgICBUaGVybW9UZW1wZXJhdHVyZVNldHBvaW50OiAyMjAsXHJcbiAgICBSVERUZW1wZXJhdHVyZVNldHBvaW50OiAyMjgsXHJcbiAgICBQdWxzZXNDb3VudDogMjUyLFxyXG4gICAgRnJlcXVlbmN5VElDSzE6IDI1NCxcclxuICAgIEZyZXF1ZW5jeVRJQ0syOiAyNTYsXHJcbiAgICBHZW5VaGlnaFBlcmM6IDI2MixcclxuICAgIEdlblVsb3dQZXJjOiAyNjRcclxufTtcclxuXHJcbi8qKlxyXG4gKiBHZW5lcmF0ZSB0aGUgbW9kYnVzIFJUVSBwYWNrZXQgdG8gcmVhZCB0aGUgc2VyaWFsIG51bWJlclxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlU2VyaWFsTnVtYmVyKCkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlNlcmlhbE51bWJlcik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBHZW5lcmF0ZSB0aGUgbW9kYnVzIFJUVSBwYWNrZXQgdG8gcmVhZCB0aGUgY3VycmVudCBtb2RlXHJcbiAqICovXHJcbmZ1bmN0aW9uIG1ha2VDdXJyZW50TW9kZSgpIHtcclxuICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDEsIE1TQ1JlZ2lzdGVycy5DdXJyZW50TW9kZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBHZW5lcmF0ZSB0aGUgbW9kYnVzIFJUVSBwYWNrZXQgdG8gcmVhZCB0aGUgY3VycmVudCBiYXR0ZXJ5IGxldmVsXHJcbiAqICovXHJcbmZ1bmN0aW9uIG1ha2VCYXR0ZXJ5TGV2ZWwoKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQmF0dGVyeU1lYXN1cmUpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSByZWdpc3RlciB3aXRoIGJhdHRlcnkgbGV2ZWxcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIEZDMyBhbnN3ZXIgXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGJhdHRlcnkgbGV2ZWwgaW4gVlxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VCYXR0ZXJ5KGJ1ZmZlcikge1xyXG4gICAgdmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZWdpc3RlcnMsIDApO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIFNlbmVjYSBNU0Mgc2VyaWFsIGFzIHBlciB0aGUgVUkgaW50ZXJmYWNlXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBtb2RidXMgYW5zd2VyIHBhY2tldCAoRkMzKVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VTZXJpYWxOdW1iZXIoYnVmZmVyKSB7XHJcbiAgICB2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICBpZiAocmVnaXN0ZXJzLmxlbmd0aCA8IDQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHNlcmlhbCBudW1iZXIgcmVzcG9uc2VcIik7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWwxID0gcmVnaXN0ZXJzLmdldFVpbnQxNigwLCBmYWxzZSk7XHJcbiAgICBjb25zdCB2YWwyID0gcmVnaXN0ZXJzLmdldFVpbnQxNigyLCBmYWxzZSk7XHJcbiAgICBjb25zdCBzZXJpYWwgPSAoKHZhbDIgPDwgMTYpICsgdmFsMSkudG9TdHJpbmcoKTtcclxuICAgIGlmIChzZXJpYWwubGVuZ3RoID4gNSkge1xyXG4gICAgICAgIHJldHVybiBzZXJpYWwuc3Vic3RyKDAsIDUpICsgXCJfXCIgKyBzZXJpYWwuc3Vic3RyKDUsIHNlcmlhbC5sZW5ndGggLSA1KTtcclxuICAgIH1cclxuICAgIHJldHVybiBzZXJpYWw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZXMgdGhlIHN0YXRlIG9mIHRoZSBtZXRlci4gTWF5IHRocm93LlxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgbW9kYnVzIGFuc3dlciBwYWNrZXQgKEZDMylcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY3VycmVudE1vZGUgaWYgdGhlIHJlZ2lzdGVycyBjb250YWlucyBhbiBJR05PUkUgdmFsdWUsIHJldHVybnMgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiBAcmV0dXJucyB7Q29tbWFuZFR5cGV9IG1ldGVyIG1vZGVcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQ3VycmVudE1vZGUoYnVmZmVyLCBjdXJyZW50TW9kZSkge1xyXG4gICAgdmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgaWYgKHJlZ2lzdGVycy5sZW5ndGggPCAyKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBtb2RlIHJlc3BvbnNlXCIpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsMSA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMCwgZmFsc2UpO1xyXG5cclxuICAgIGlmICh2YWwxID09IENvbW1hbmRUeXBlLlJFU0VSVkVEIHx8IHZhbDEgPT0gQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEIHx8IHZhbDEgPT0gQ29tbWFuZFR5cGUuUkVTRVJWRURfMikgeyAvLyBNdXN0IGJlIGlnbm9yZWQsIGludGVybmFsIHN0YXRlcyBvZiB0aGUgbWV0ZXJcclxuICAgICAgICByZXR1cm4gY3VycmVudE1vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWx1ZSA9IHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCB2YWwxKTtcclxuICAgIGlmICh2YWx1ZSA9PSBudWxsKVxyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gbWV0ZXIgbW9kZSA6IFwiICsgdmFsdWUpO1xyXG5cclxuICAgIHJldHVybiB2YWwxO1xyXG59XHJcbi8qKlxyXG4gKiBTZXRzIHRoZSBjdXJyZW50IG1vZGUuXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcnxudWxsfVxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZU1vZGVSZXF1ZXN0KG1vZGUpIHtcclxuICAgIGNvbnN0IHZhbHVlID0gdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIG1vZGUpO1xyXG4gICAgY29uc3QgQ0hBTkdFX1NUQVRVUyA9IDE7XHJcblxyXG4gICAgLy8gRmlsdGVyIGludmFsaWQgY29tbWFuZHNcclxuICAgIGlmICh2YWx1ZSA9PSBudWxsIHx8IHZhbHVlID09IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTikge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChtb2RlID4gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOICYmIG1vZGUgPD0gQ29tbWFuZFR5cGUuT0ZGKSB7IC8vIE1lYXN1cmVtZW50c1xyXG4gICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG4gICAgfVxyXG4gICAgZWxzZSBpZiAobW9kZSA+IENvbW1hbmRUeXBlLk9GRiAmJiBtb2RlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEKSB7IC8vIEdlbmVyYXRpb25zXHJcbiAgICAgICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgICAgICAvLyBDb2xkIGp1bmN0aW9uIG5vdCBjb25maWd1cmVkXHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgLy8gQWxsIHRoZSBzaW1wbGUgY2FzZXMgXHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogV2hlbiB0aGUgbWV0ZXIgaXMgbWVhc3VyaW5nLCBtYWtlIHRoZSBtb2RidXMgcmVxdWVzdCBvZiB0aGUgdmFsdWVcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcGFja2V0XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlTWVhc3VyZVJlcXVlc3QobW9kZSkge1xyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19UOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVGVtcE1lYXN1cmUpO1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzRXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDAwXzRXOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUnRkVGVtcGVyYXR1cmVNZWFzdXJlKTsgLy8gVGVtcC1PaG1cclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeU1lYXN1cmUpO1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLlB1bHNlT0ZGTWVhc3VyZSk7IC8vIE9OLU9GRlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbCk7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA2LCBNU0NSZWdpc3RlcnMuTWluTWVhc3VyZSk7IC8vIE1pbi1NYXgtTWVhc1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIk1vZGUgbm90IG1hbmFnZWQgOlwiICsgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBtZWFzdXJlIHJlYWQgZnJvbSB0aGUgbWV0ZXJcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBydHUgYW5zd2VyIChGQzMpXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGUgY3VycmVudCBtb2RlIG9mIHRoZSBtZXRlclxyXG4gKiBAcmV0dXJucyB7YXJyYXl9IGFuIGFycmF5IHdpdGggZmlyc3QgZWxlbWVudCBcIk1lYXN1cmUgbmFtZSAodW5pdHMpXCI6VmFsdWUsIHNlY29uZCBUaW1lc3RhbXA6YWNxdWlzaXRpb25cclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlTWVhc3VyZShidWZmZXIsIG1vZGUpIHtcclxuICAgIHZhciByZXNwb25zZUZDMyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgdmFyIG1lYXMsIG1lYXMyLCBtaW4sIG1heDtcclxuXHJcbiAgICAvLyBBbGwgbWVhc3VyZXMgYXJlIGZsb2F0XHJcbiAgICBpZiAocmVzcG9uc2VGQzMgPT0gbnVsbClcclxuICAgICAgICByZXR1cm4ge307XHJcblxyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19TOlxyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgdmFyIHZhbHVlID0gTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMFxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlRlbXBlcmF0dXJlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHZhbHVlLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiwrBDXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF80VzpcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1lYXMyID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMCkgLyAxMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIlJlc2lzdGFuY2VcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VmFsdWVcIjogTWF0aC5yb3VuZChtZWFzMiAqIDEwKSAvIDEwLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlVbml0XCI6IFwiT2htc1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICAvLyBTZW5zaWJpbGl0w6AgbWFuY2FudGlcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3lcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTApIC8gMTAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJIelwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICBtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJDdXJyZW50XCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJtQVwiLFxyXG4gICAgICAgICAgICAgICAgXCJNaW5pbXVtXCI6IE1hdGgucm91bmQobWluICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiTWF4aW11bVwiOiBNYXRoLnJvdW5kKG1heCAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlY6XHJcbiAgICAgICAgICAgIG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIlZcIixcclxuICAgICAgICAgICAgICAgIFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tVjpcclxuICAgICAgICAgICAgbWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibVZcIixcclxuICAgICAgICAgICAgICAgIFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldFVpbnQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtZWFzMiA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgLy8gU29nbGlhIGUgc2Vuc2liaWxpdMOgIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiUHVsc2UgT05cIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogbWVhcyxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIlB1bHNlIE9GRlwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlWYWx1ZVwiOiBtZWFzMixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VW5pdFwiOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgbWVhcyA9IE1hdGgucm91bmQobW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKSAqIDEwMDApIC8gMTAwMDtcclxuICAgICAgICAgICAgLy8gS2cgbWFuY2FudGlcclxuICAgICAgICAgICAgLy8gU2Vuc2liaWxpdMOgLCB0YXJhLCBwb3J0YXRhIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiSW1iYWxhbmNlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IG1lYXMsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJtVi9WXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlVua25vd25cIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwMCkgLyAxMDAwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiP1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgc3RhdHVzIGZsYWdzIGZyb20gbWVhc3VyZW1lbnQgbW9kZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSByZXF1ZXN0IHRvIHNlbmRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VRdWFsaXR5Qml0UmVxdWVzdChtb2RlKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuTWVhc3VyZUZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IHN0YXR1c1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXJcclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgdGhlcmUgaXMgbm8gZXJyb3JcclxuICovXHJcbmZ1bmN0aW9uIGlzUXVhbGl0eVZhbGlkKGJ1ZmZlcikge1xyXG4gICAgdmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICByZXR1cm4gKChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTMpKSA9PSAwKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlYWRzIHRoZSBnZW5lcmF0aW9uIGZsYWdzIHN0YXR1cyBmcm9tIHRoZSBtZXRlclxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSByZXF1ZXN0IHRvIHNlbmRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VHZW5TdGF0dXNSZWFkKG1vZGUpIHtcclxuICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDEsIE1TQ1JlZ2lzdGVycy5HZW5lcmF0aW9uRmxhZ3MpO1xyXG59XHJcblxyXG4vKipcclxuICogQ2hlY2tzIGlmIHRoZSBlcnJvciBiaXQgaXMgTk9UIHNldCBpbiB0aGUgZ2VuZXJhdGlvbiBmbGFnc1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZUZDM1xyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiB0aGVyZSBpcyBubyBlcnJvclxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VHZW5TdGF0dXMoYnVmZmVyLCBtb2RlKSB7XHJcbiAgICB2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gKChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTUpKSA9PSAwKSAmJiAvLyBHZW4gZXJyb3JcclxuICAgICAgICAgICAgICAgICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE0KSkgPT0gMCk7IC8vIFNlbGYgZ2VuZXJhdGlvbiBJIGNoZWNrXHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmV0dXJuIChyZXNwb25zZUZDMy5nZXRVaW50MTYoMCwgZmFsc2UpICYgKDEgPDwgMTUpKSA9PSAwOyAvLyBHZW4gZXJyb3JcclxuICAgIH1cclxufVxyXG5cclxuXHJcbi8qKlxyXG4gKiBSZXR1cm5zIGEgYnVmZmVyIHdpdGggdGhlIG1vZGJ1cy1ydHUgcmVxdWVzdCB0byBiZSBzZW50IHRvIFNlbmVjYVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGdlbmVyYXRpb24gbW9kZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQgdGhlIHZhbHVlIHRvIHNldCAobVYvVi9BL0h6L8KwQykgZXhjZXB0IGZvciBwdWxzZXMgbnVtX3B1bHNlc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gc2V0cG9pbnQyIGZyZXF1ZW5jeSBpbiBIelxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVNldHBvaW50UmVxdWVzdChtb2RlLCBzZXRwb2ludCwgc2V0cG9pbnQyKSB7XHJcbiAgICB2YXIgVEVNUCwgcmVnaXN0ZXJzO1xyXG4gICAgdmFyIGR0ID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgdmFyIGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcbiAgICBtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50KTtcclxuICAgIGNvbnN0IHNwID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cclxuICAgIHZhciBkdEludCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIHZhciBkdkludCA9IG5ldyBEYXRhVmlldyhkdEludCk7XHJcbiAgICBtb2RidXMuc2V0VWludDMyTEVCUyhkdkludCwgMCwgc2V0cG9pbnQpO1xyXG4gICAgY29uc3Qgc3BJbnQgPSBbZHZJbnQuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHZJbnQuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcblxyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Wb2x0YWdlU2V0cG9pbnQsIHNwKTsgLy8gViAvIG1WIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ3VycmVudFNldHBvaW50LCBzcCk7IC8vIEkgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlJURFRlbXBlcmF0dXJlU2V0cG9pbnQsIHNwKTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludCwgc3ApOyAvLyDCsEMgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbFNldHBvaW50LCBzcCk7IC8vIG1WL1Ygc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgIGR0ID0gbmV3IEFycmF5QnVmZmVyKDgpOyAvLyAyIFVpbnQzMlxyXG4gICAgICAgICAgICBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG4gICAgICAgICAgICAvLyBTZWUgU2VuZWNhbCBtYW51YWwgbWFudWFsXHJcbiAgICAgICAgICAgIC8vIE1heCAyMGtIWiBnZW5cclxuICAgICAgICAgICAgVEVNUCA9IE1hdGgucm91bmQoMjAwMDAgLyBzZXRwb2ludCwgMCk7XHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMigwLCBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMVxyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoNCwgVEVNUCAtIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0syXHJcblxyXG4gICAgICAgICAgICAvLyBCeXRlLXN3YXBwZWQgbGl0dGxlIGVuZGlhblxyXG4gICAgICAgICAgICByZWdpc3RlcnMgPSBbZHYuZ2V0VWludDE2KDIsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDAsIGZhbHNlKSxcclxuICAgICAgICAgICAgZHYuZ2V0VWludDE2KDYsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDQsIGZhbHNlKV07XHJcblxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeVRJQ0sxLCByZWdpc3RlcnMpO1xyXG5cclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICBkdCA9IG5ldyBBcnJheUJ1ZmZlcigxMik7IC8vIDMgVWludDMyIFxyXG4gICAgICAgICAgICBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG4gICAgICAgICAgICAvLyBTZWUgU2VuZWNhbCBtYW51YWwgbWFudWFsXHJcbiAgICAgICAgICAgIC8vIE1heCAyMGtIWiBnZW5cclxuICAgICAgICAgICAgVEVNUCA9IE1hdGgucm91bmQoMjAwMDAgLyBzZXRwb2ludDIsIDApO1xyXG5cclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDAsIHNldHBvaW50LCBmYWxzZSk7IC8vIE5VTV9QVUxTRVNcclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDQsIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0sxXHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMig4LCBURU1QIC0gTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzJcclxuXHJcbiAgICAgICAgICAgIHJlZ2lzdGVycyA9IFtkdi5nZXRVaW50MTYoMiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMCwgZmFsc2UpLFxyXG4gICAgICAgICAgICBkdi5nZXRVaW50MTYoNiwgZmFsc2UpLCBkdi5nZXRVaW50MTYoNCwgZmFsc2UpLFxyXG4gICAgICAgICAgICBkdi5nZXRVaW50MTYoMTAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDgsIGZhbHNlKV07XHJcblxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlB1bHNlc0NvdW50LCByZWdpc3RlcnMpO1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VUaHJlc2hvbGRfRjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5UaHJlc2hvbGRVX0ZyZXEsIHNwKTsgLy8gVSBtaW4gZm9yIGZyZXEgbWVhc3VyZW1lbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TZW5zaXRpdml0eV91UzpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5TZW5zaWJpbGl0eV91U19PRkYsXHJcbiAgICAgICAgICAgICAgICBbc3BJbnRbMF0sIHNwSW50WzFdLCBzcEludFswXSwgc3BJbnRbMV1dKTsgLy8gdVYgZm9yIHB1bHNlIHRyYWluIG1lYXN1cmVtZW50IHRvIE9OIC8gT0ZGXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfQ29sZEp1bmN0aW9uOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNvbGRKdW5jdGlvbiwgc3ApOyAvLyB1bmNsZWFyIHVuaXRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VbG93OlxyXG4gICAgICAgICAgICBtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcbiAgICAgICAgICAgIHZhciBzcDIgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR2VuVWxvd1BlcmMsIHNwMik7IC8vIFUgbG93IGZvciBmcmVxIC8gcHVsc2UgZ2VuXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWhpZ2g6XHJcbiAgICAgICAgICAgIG1vZGJ1cy5zZXRGbG9hdDMyTEVCUyhkdiwgMCwgc2V0cG9pbnQgLyBNQVhfVV9HRU4pOyAvLyBNdXN0IGNvbnZlcnQgViBpbnRvIGEgJSAwLi5NQVhfVV9HRU5cclxuICAgICAgICAgICAgdmFyIHNwMiA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HZW5VaGlnaFBlcmMsIHNwMik7IC8vIFUgaGlnaCBmb3IgZnJlcSAvIHB1bHNlIGdlbiAgICAgICAgICAgIFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUG93ZXJPZmZEZWxheSwgc2V0cG9pbnQpOyAvLyBkZWxheSBpbiBzZWNcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7IC8vIE5vIHNldHBvaW50XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGhhbmRsZWRcIik7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJlYWRzIHRoZSBzZXRwb2ludFxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSByZXF1ZXN0XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlU2V0cG9pbnRSZWFkKG1vZGUpIHtcclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5Wb2x0YWdlU2V0cG9pbnQpOyAvLyBtViBvciBWIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5DdXJyZW50U2V0cG9pbnQpOyAvLyBBIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlJURFRlbXBlcmF0dXJlU2V0cG9pbnQpOyAvLyDCsEMgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQpOyAvLyDCsEMgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeVRJQ0sxKTsgLy8gRnJlcXVlbmN5IHNldHBvaW50IChUSUNLUylcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkxvYWRDZWxsU2V0cG9pbnQpOyAvLyBtVi9WIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OT05FX1VOS05PV046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGhhbmRsZWRcIik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZXMgdGhlIGFuc3dlciBhYm91dCBTZXRwb2ludFJlYWRcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVnaXN0ZXJzIEZDMyBwYXJzZWQgYW5zd2VyXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IHRoZSBsYXN0IHNldHBvaW50XHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZVNldHBvaW50UmVhZChidWZmZXIsIG1vZGUpIHtcclxuICAgIC8vIFJvdW5kIHRvIHR3byBkaWdpdHNcclxuICAgIHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHZhciByb3VuZGVkID0gTWF0aC5yb3VuZChtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVnaXN0ZXJzLCAwKSAqIDEwMCkgLyAxMDA7XHJcblxyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiQ3VycmVudFwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibUFcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVm9sdGFnZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibVZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkltYmFsYW5jZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibVYvVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIHZhciB0aWNrMSA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlZ2lzdGVycywgMCk7XHJcbiAgICAgICAgICAgIHZhciB0aWNrMiA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlZ2lzdGVycywgNCk7XHJcbiAgICAgICAgICAgIHZhciBmT04gPSAwLjA7XHJcbiAgICAgICAgICAgIHZhciBmT0ZGID0gMC4wO1xyXG4gICAgICAgICAgICBpZiAodGljazEgIT0gMClcclxuICAgICAgICAgICAgICAgIGZPTiA9IE1hdGgucm91bmQoMSAvICh0aWNrMSAqIDIgLyAyMDAwMC4wKSAqIDEwLjApIC8gMTA7IC8vIE5lZWQgb25lIGRlY2ltYWwgcGxhY2UgZm9yIEhaXHJcbiAgICAgICAgICAgIGlmICh0aWNrMiAhPSAwKVxyXG4gICAgICAgICAgICAgICAgZk9GRiA9IE1hdGgucm91bmQoMSAvICh0aWNrMiAqIDIgLyAyMDAwMC4wKSAqIDEwLjApIC8gMTA7IC8vIE5lZWQgb25lIGRlY2ltYWwgcGxhY2UgZm9yIEhaXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5IE9OXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IGZPTixcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIkh6XCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5IE9GRlwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlWYWx1ZVwiOiBmT0ZGLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlVbml0XCI6IFwiSHpcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlRlbXBlcmF0dXJlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCLCsENcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVW5rbm93blwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiP1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICB9XHJcblxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtcclxuICAgIE1TQ1JlZ2lzdGVycywgbWFrZVNlcmlhbE51bWJlciwgbWFrZUN1cnJlbnRNb2RlLCBtYWtlQmF0dGVyeUxldmVsLCBwYXJzZUJhdHRlcnksIHBhcnNlU2VyaWFsTnVtYmVyLFxyXG4gICAgcGFyc2VDdXJyZW50TW9kZSwgbWFrZU1vZGVSZXF1ZXN0LCBtYWtlTWVhc3VyZVJlcXVlc3QsIHBhcnNlTWVhc3VyZSwgbWFrZVF1YWxpdHlCaXRSZXF1ZXN0LCBpc1F1YWxpdHlWYWxpZCxcclxuICAgIG1ha2VHZW5TdGF0dXNSZWFkLCBwYXJzZUdlblN0YXR1cywgbWFrZVNldHBvaW50UmVxdWVzdCwgbWFrZVNldHBvaW50UmVhZCwgcGFyc2VTZXRwb2ludFJlYWR9IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxuXHJcbmxldCBzbGVlcCA9IG1zID0+IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5sZXQgd2FpdEZvciA9IGFzeW5jIGZ1bmN0aW9uIHdhaXRGb3IoZikge1xyXG4gICAgd2hpbGUgKCFmKCkpIGF3YWl0IHNsZWVwKDEwMCArIE1hdGgucmFuZG9tKCkgKiAyNSk7XHJcbiAgICByZXR1cm4gZigpO1xyXG59O1xyXG5cclxubGV0IHdhaXRGb3JUaW1lb3V0ID0gYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihmLCB0aW1lb3V0U2VjKSB7XHJcbiAgICB2YXIgdG90YWxUaW1lTXMgPSAwO1xyXG4gICAgd2hpbGUgKCFmKCkgJiYgdG90YWxUaW1lTXMgPCB0aW1lb3V0U2VjICogMTAwMCkge1xyXG4gICAgICAgIHZhciBkZWxheU1zID0gMTAwICsgTWF0aC5yYW5kb20oKSAqIDI1O1xyXG4gICAgICAgIHRvdGFsVGltZU1zICs9IGRlbGF5TXM7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXlNcyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZigpO1xyXG59O1xyXG5cclxuLy8gVGhlc2UgZnVuY3Rpb25zIG11c3QgZXhpc3Qgc3RhbmQtYWxvbmUgb3V0c2lkZSBDb21tYW5kIG9iamVjdCBhcyB0aGlzIG9iamVjdCBtYXkgY29tZSBmcm9tIEpTT04gd2l0aG91dCB0aGVtIVxyXG5mdW5jdGlvbiBpc0dlbmVyYXRpb24oY3R5cGUpIHtcclxuICAgIHJldHVybiAoY3R5cGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgY3R5cGUgPCBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzTWVhc3VyZW1lbnQoY3R5cGUpIHtcclxuICAgIHJldHVybiAoY3R5cGUgPiBDb21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgY3R5cGUgPCBDb21tYW5kVHlwZS5SRVNFUlZFRCk7XHJcbn1cclxuZnVuY3Rpb24gaXNTZXR0aW5nKGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGN0eXBlID09IENvbW1hbmRUeXBlLk9GRiB8fCBjdHlwZSA+IENvbW1hbmRUeXBlLlNFVFRJTkdfUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzVmFsaWQoY3R5cGUpIHtcclxuICAgIHJldHVybiAoaXNNZWFzdXJlbWVudChjdHlwZSkgfHwgaXNHZW5lcmF0aW9uKGN0eXBlKSB8fCBpc1NldHRpbmcoY3R5cGUpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEhlbHBlciBmdW5jdGlvbiB0byBjb252ZXJ0IGEgdmFsdWUgaW50byBhbiBlbnVtIHZhbHVlXHJcbiAqIFxyXG4gKiBAcGFyYW0ge3R5cGV9IGVudW10eXBlXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBlbnVtdmFsdWVcclxuICovXHJcbiBmdW5jdGlvbiBQYXJzZShlbnVtdHlwZSwgZW51bXZhbHVlKSB7XHJcbiAgICBmb3IgKHZhciBlbnVtTmFtZSBpbiBlbnVtdHlwZSkge1xyXG4gICAgICAgIGlmIChlbnVtdHlwZVtlbnVtTmFtZV0gPT0gZW51bXZhbHVlKSB7XHJcbiAgICAgICAgICAgIC8qanNoaW50IC1XMDYxICovXHJcbiAgICAgICAgICAgIHJldHVybiBldmFsKFtlbnVtdHlwZSArIFwiLlwiICsgZW51bU5hbWVdKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEhlbHBlciBmdW5jdGlvbiB0byBkdW1wIGFycmF5YnVmZmVyIGFzIGhleCBzdHJpbmdcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG4gZnVuY3Rpb24gYnVmMmhleChidWZmZXIpIHsgLy8gYnVmZmVyIGlzIGFuIEFycmF5QnVmZmVyXHJcbiAgICByZXR1cm4gWy4uLm5ldyBVaW50OEFycmF5KGJ1ZmZlcildXHJcbiAgICAgICAgLm1hcCh4ID0+IHgudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsICcwJykpXHJcbiAgICAgICAgLmpvaW4oJyAnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGV4MmJ1ZiAoaW5wdXQpIHtcclxuICAgIGlmICh0eXBlb2YgaW5wdXQgIT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRXhwZWN0ZWQgaW5wdXQgdG8gYmUgYSBzdHJpbmcnKVxyXG4gICAgfVxyXG4gICAgdmFyIGhleHN0ciA9IGlucHV0LnJlcGxhY2UoL1xccysvZywgJycpO1xyXG4gICAgaWYgKChoZXhzdHIubGVuZ3RoICUgMikgIT09IDApIHtcclxuICAgICAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcignRXhwZWN0ZWQgc3RyaW5nIHRvIGJlIGFuIGV2ZW4gbnVtYmVyIG9mIGNoYXJhY3RlcnMnKVxyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHZpZXcgPSBuZXcgVWludDhBcnJheShoZXhzdHIubGVuZ3RoIC8gMilcclxuXHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGhleHN0ci5sZW5ndGg7IGkgKz0gMikge1xyXG4gICAgICAgIHZpZXdbaSAvIDJdID0gcGFyc2VJbnQoaGV4c3RyLnN1YnN0cmluZyhpLCBpICsgMiksIDE2KVxyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiB2aWV3LmJ1ZmZlclxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgc2xlZXAsIHdhaXRGb3IsIHdhaXRGb3JUaW1lb3V0LCBpc0dlbmVyYXRpb24sIGlzTWVhc3VyZW1lbnQsIGlzU2V0dGluZywgaXNWYWxpZCwgUGFyc2UsIGJ1ZjJoZXgsIGhleDJidWYgfTsiXX0=
