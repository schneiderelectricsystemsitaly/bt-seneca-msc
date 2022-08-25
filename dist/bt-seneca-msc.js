(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.MSC = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){

/************************************************** BLUETOOTH HANDLING FUNCTIONS *****************************************************/
var APIState = require('./classes/APIState');
var log = require('loglevel');
var constants = require('./constants');
var utils = require('./utils');
var seneca = require('./senecaModbus');
var modbus = require('./modbusRtu');

var btState = APIState.btState;
var State = constants.State;
var CommandType = constants.CommandType;
var buf2hex = utils.buf2hex;

/*
 * Bluetooth constants
 */
const BlueToothMSC = {
    ServiceUuid: '0003cdd0-0000-1000-8000-00805f9b0131', // bluetooth modbus RTU service for Seneca MSC
    ModbusAnswerUuid: '0003cdd1-0000-1000-8000-00805f9b0131',     // modbus RTU answers
    ModbusRequestUuid: '0003cdd2-0000-1000-8000-00805f9b0131'    // modbus RTU requests
};

/**
 * Main loop of the meter handler.
 * */
async function stateMachine() {
    var nextAction;
    const DELAY_MS = 750;
    const TIMEOUT_MS = 30000;
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
            nextAction = btPairDevice;
            break;
        case State.CONNECTING: // waiting for connection to complete
            nextAction = undefined;
            break;
        case State.DEVICE_PAIRED: // connection complete, acquire meter state
            nextAction = btSubscribe;
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
                nextAction = btSubscribe;
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
                nextAction = btSubscribe;
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
        var packet, response, startGen;
        const RESET_POWER_OFF = 6;
        const SET_POWER_OFF = 7;
        const CLEAR_AVG_MIN_MAX = 5;
        const PULSE_CMD = 9;

        if (command == null) {
            return;
        }
        btState.state = State.BUSY;
        btState.stats["commands"]++;

        log.info('\t\tExecuting command ' + command);

        // First set NONE because we don't want to write new setpoints with active generation
        log.debug("\t\tSetting meter to OFF");
        packet = seneca.makeModeRequest(CommandType.OFF);
        await SendAndResponse(packet);
        await utils.sleep(100);

        // Now write the setpoint or setting
        if (utils.isGeneration(command.type) || utils.isSetting(command.type) && command.type != CommandType.OFF) {
            log.debug("\t\tWriting setpoint :" + command.setpoint);
            response = await SendAndResponse(seneca.makeSetpointRequest(command.type, command.setpoint, command.setpoint2));
            if (response != null && !modbus.parseFC16checked(response, 0)) {
                throw new Error("Setpoint not correctly written");
            }
            switch (command.type) {
                case CommandType.SET_ShutdownDelay:
                    startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, seneca.MSCRegisters.CMD, [RESET_POWER_OFF]);
                    response = await SendAndResponse(startGen);
                    if (!modbus.parseFC16checked(response, 1)) {
                        command.error = true;
                        command.pending = false;
                        throw new Error("Failure to set poweroff timer.");
                    }
                    break;
                default:
                    break;
            }
        }

        if (!utils.isSetting(command.type) && utils.isValid(command.type) && command.type != CommandType.OFF)  // IF this is a setting, we're done.
        {
            // Now write the mode set 
            log.debug("\t\tSetting new mode :" + command.type);
            packet = seneca.makeModeRequest(command.type);
            if (packet == null) {
                command.error = true;
                command.pending = false;
                log.error("Could not generate modbus packet for command", command);
                return;
            }

            response = await SendAndResponse(packet);
            command.request = packet;
            command.answer = response;

            if (!modbus.parseFC16checked(response, 0)) {
                command.error = true;
                command.pending = false;
                throw new Error("Not all registers were written");
            }

            // Some commands require START command to be given
            switch (command.type) {
                case CommandType.V:
                case CommandType.mV:
                case CommandType.mA_active:
                case CommandType.mA_passive:
                case CommandType.PulseTrain:
                    await utils.sleep(1000);
                    // Reset the min/max/avg value
                    log.debug("\t\tResetting statistics");
                    startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, seneca.MSCRegisters.CMD, [CLEAR_AVG_MIN_MAX]);
                    response = await SendAndResponse(startGen);
                    if (!modbus.parseFC16checked(response, 1)) {
                        command.error = true;
                        command.pending = false;
                        throw new Error("Failure to reset stats.");
                    }
                    break;
                case CommandType.GEN_PulseTrain:
                    await utils.sleep(1000);
                    log.debug("\t\tResetting statistics");
                    startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, seneca.MSCRegisters.GEN_CMD, [PULSE_CMD, 2]); // Start with low
                    response = await SendAndResponse(startGen);
                    if (!modbus.parseFC16checked(response, 2)) {
                        command.error = true;
                        command.pending = false;
                        throw new Error("Not all registers were written");
                    }
                    break;
                case CommandType.GEN_Frequency:
                    await utils.sleep(1000);
                    log.debug("\t\tResetting statistics");
                    startGen = modbus.makeFC16(modbus.SENECA_MB_SLAVE_ID, seneca.MSCRegisters.GEN_CMD, [PULSE_CMD, 1]); // start gen
                    response = await SendAndResponse(startGen);
                    if (!modbus.parseFC16checked(response, 2)) {
                        command.error = true;
                        command.pending = false;
                        throw new Error("Not all registers were written");
                    }
                    break;
            } // switch

            // Disable auto power off
            log.debug("\t\tDisabling power off");
            startGen = modbus.makeFC16(seneca.SENECA_MB_SLAVE_ID, seneca.MSCRegisters.CMD, [RESET_POWER_OFF]);
            response = await SendAndResponse(startGen);

        } // if (!isSetting(command.type) && isValid(command.type)))

        command.error = false;
        command.pending = false;
        btState.command = null;

        // Caller expects a valid property in GetState() once command is executed.
        log.debug("\t\tRefreshing current state");
        await refresh();

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

/**
 * Send the message using Bluetooth and wait for an answer
 * @param {ArrayBuffer} command modbus RTU packet to send
 * @returns {ArrayBuffer} the modbus RTU answer
 */
async function SendAndResponse(command) {

    if (command == null)
        return null;

    log.debug(">> " + buf2hex(command));

    btState.response = null;
    btState.stats["requests"]++;

    var startTime = new Date().getTime();
    await btState.charWrite.writeValueWithoutResponse(command);
    while (btState.state == State.METER_INITIALIZING ||
        btState.state == State.BUSY) {
        if (btState.response != null) break;
        await new Promise(resolve => setTimeout(resolve, 35));
    }

    var endTime = new Date().getTime();

    var answer = btState.response?.slice();
    btState.response = null;

    btState.stats["responseTime"] = Math.round((1.0 * btState.stats["responseTime"] * (btState.stats["responses"] % 500) + (endTime - startTime)) / ((btState.stats["responses"] % 500) + 1));
    btState.stats["lastResponseTime"] = Math.round(endTime - startTime) + " ms";
    btState.stats["responses"]++;

    return answer;
}

/**
 * Acquire the current mode and serial number of the device.
 * */
async function meterInit() {
    var response;

    try {
        btState.state = State.METER_INITIALIZING;
        response = await SendAndResponse(seneca.makeSerialNumber());
        btState.meter.serial = seneca.parseSerialNumber(response);
        log.info('\t\tSerial number:' + btState.meter.serial);

        response = await SendAndResponse(seneca.makeCurrentMode());
        btState.meter.mode = seneca.parseCurrentMode(response, CommandType.NONE_UNKNOWN);
        log.debug('\t\tCurrent mode:' + btState.meter.mode);

        response = await SendAndResponse(seneca.makeBatteryLevel());
        btState.meter.battery = Math.round(seneca.parseBattery(response) * 100) / 100;

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
        log.debug('<< ' + buf2hex(value.buffer));
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

/**
 * When idle, this function is called
 * */
async function refresh() {
    btState.state = State.BUSY;
    try {
        // Check the mode first
        var response = await SendAndResponse(seneca.makeCurrentMode());
        var mode = seneca.parseCurrentMode(response, btState.meter.mode);

        if (mode != CommandType.NONE_UNKNOWN) {
            btState.meter.mode = mode;

            if (btState.meter.isGeneration())
                await refreshGeneration();

            if (btState.meter.isMeasurement())
                await refreshMeasure();
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

/**
 * Read the last measure and update btState.lastMeasure property
 * */
async function refreshMeasure() {
    // Read quality
    var response = await SendAndResponse(seneca.makeQualityBitRequest());
    var valid = seneca.isQualityValid(response);

    // Read measure
    response = await SendAndResponse(seneca.makeMeasureRequest(btState.meter.mode));
    var meas = seneca.parseMeasure(response, btState.meter.mode);
    meas["error"] = !valid;

    btState.lastMeasure = meas;
}

/**
 * Gets the current values for the generated U,I from the device
 * */
async function refreshGeneration() {
    var response = await SendAndResponse(seneca.makeSetpointRead(btState.meter.mode));
    if (response != null) {
        var results = seneca.parseSetpointRead(response, btState.meter.mode);

        response = await SendAndResponse(seneca.makeGenStatusRead());
        results["error"] = !seneca.parseGenStatus(response, btState.meter.mode);

        btState.lastSetpoint = results;
    }
}

module.exports = {stateMachine};
},{"./classes/APIState":2,"./constants":6,"./modbusRtu":9,"./senecaModbus":11,"./utils":12,"loglevel":10}],2:[function(require,module,exports){
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
},{"../constants":6,"./MeterState":5}],3:[function(require,module,exports){
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
},{"../constants":6,"../utils":12}],4:[function(require,module,exports){
class CommandResult
{
    value = 0.0;
    result = false;
    message = "";
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
},{"../constants":6}],6:[function(require,module,exports){
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

module.exports = {State, CommandType }
},{}],7:[function(require,module,exports){
'use strict';

const log = require("loglevel");

const constants = require('./constants');
const APIState = require('./classes/APIState');
const Command = require('./classes/Command');
require('./classes/MeterState');
require('./modbusRtu');
require('./senecaModbus');
const PublicAPI =require('./meterPublicAPI');
require('./bluetooth');
require('./utils');

/**
 * The main object with the state of meter, bluetooth, command...
 * */


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


},{"./bluetooth":1,"./classes/APIState":2,"./classes/Command":3,"./classes/MeterState":5,"./constants":6,"./meterPublicAPI":8,"./modbusRtu":9,"./senecaModbus":11,"./utils":12,"loglevel":10}],8:[function(require,module,exports){
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
    return JSON.stringify(await Execute(command));
}

async function SimpleExecuteJSON(jsonCommand) {
    let command = JSON.parse(jsonCommand);
    return JSON.stringify(await SimpleExecute(command));
}

/**
 * Execute a command and returns the measurement or setpoint with error flag and message
 * @param {Command} command
 */
 async function SimpleExecute(command) {
    const SIMPLE_EXECUTE_TIMEOUT_S = 40;
    var cr = new CommandResult();

    log.info("SimpleExecute called...");

    if (command != null)
        command.pending = true; // In case caller does not set pending flag

    // Fails if not paired.
    if (!btState.started) {
        cr.error = true;
        cr.message = "Device is not paired";
        log.warn(cr.message);
        return cr;
    }

    // Another command may be pending.
    var delayS = 0;
    if (btState.command != null && btState.command.pending) {
        cr.error = true;
        cr.message = "Another command is pending";
        log.warn(cr.message);
        return cr;
    }

    // Wait for completion of the command, or halt of the state machine
    btState.command = command; 
    if (command != null) {
        await utils.waitForTimeout(() => !command.pending || btState.state == State.STOPPED, SIMPLE_EXECUTE_TIMEOUT_S);
    }

    if (command.error || command.pending)  // Check if error or timeouts
    {
        cr.error = true;
        cr.message = "Error while executing the command."
        log.warn(cr.message);
        
        // Reset the active command
        btState.command = null;
        
        return cr;
    }

    // State is updated by execute command
    if (isGeneration(command.type))
    {
        cr.value = btState.lastSetpoint["Value"];
    }
    else if (isMeasurement(command.type))
    {
        cr.value = btState.lastMeasure["Value"];
    }
    else
    {
        cr.value = 0.0; // Settings.
    }
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

    if (command != null)
        command.pending = true;

    var cpt = 0;
    while (btState.command != null && btState.command.pending && cpt < 30) {
        log.debug("Waiting for current command to complete...");
        await utils.sleep(1000);
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
},{"./bluetooth":1,"./classes/APIState":2,"./classes/CommandResult":4,"./constants":6,"./utils":12,"loglevel":10}],9:[function(require,module,exports){
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
        throw new ModbusError("Wrong CRC", 3);
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
        throw new ModbusError("Wrong CRC", 16);
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

module.exports = { makeFC3, getFloat32LEBS, makeFC16, setFloat32LEBS, setUint32LEBS, parseFC3, parseFC16, parseFC16checked, ModbusError, SENECA_MB_SLAVE_ID, getUint32LEBS }
},{"loglevel":10}],10:[function(require,module,exports){
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

},{}],11:[function(require,module,exports){
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

    if (val1 == CommandType.RESERVED || val1 == CommandType.GEN_RESERVED || val1 == CommandType.RESERVED_2) { // Must be ignored
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
},{"./constants":6,"./modbusRtu":9,"./utils":12}],12:[function(require,module,exports){
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

module.exports = { sleep, waitFor, waitForTimeout, isGeneration, isMeasurement, isSetting, isValid, Parse, buf2hex };
},{"./constants":6}]},{},[7])(7)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9Db21tYW5kUmVzdWx0LmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY29uc3RhbnRzLmpzIiwibWV0ZXJBcGkuanMiLCJtZXRlclB1YmxpY0FQSS5qcyIsIm1vZGJ1c1J0dS5qcyIsIm5vZGVfbW9kdWxlcy9sb2dsZXZlbC9saWIvbG9nbGV2ZWwuanMiLCJzZW5lY2FNb2RidXMuanMiLCJ1dGlscy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3prQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDelFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbnBCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCJcclxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqIEJMVUVUT09USCBIQU5ETElORyBGVU5DVElPTlMgKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXHJcbnZhciBBUElTdGF0ZSA9IHJlcXVpcmUoJy4vY2xhc3Nlcy9BUElTdGF0ZScpO1xyXG52YXIgbG9nID0gcmVxdWlyZSgnbG9nbGV2ZWwnKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcclxudmFyIHNlbmVjYSA9IHJlcXVpcmUoJy4vc2VuZWNhTW9kYnVzJyk7XHJcbnZhciBtb2RidXMgPSByZXF1aXJlKCcuL21vZGJ1c1J0dScpO1xyXG5cclxudmFyIGJ0U3RhdGUgPSBBUElTdGF0ZS5idFN0YXRlO1xyXG52YXIgU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcbnZhciBDb21tYW5kVHlwZSA9IGNvbnN0YW50cy5Db21tYW5kVHlwZTtcclxudmFyIGJ1ZjJoZXggPSB1dGlscy5idWYyaGV4O1xyXG5cclxuLypcclxuICogQmx1ZXRvb3RoIGNvbnN0YW50c1xyXG4gKi9cclxuY29uc3QgQmx1ZVRvb3RoTVNDID0ge1xyXG4gICAgU2VydmljZVV1aWQ6ICcwMDAzY2RkMC0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzEnLCAvLyBibHVldG9vdGggbW9kYnVzIFJUVSBzZXJ2aWNlIGZvciBTZW5lY2EgTVNDXHJcbiAgICBNb2RidXNBbnN3ZXJVdWlkOiAnMDAwM2NkZDEtMDAwMC0xMDAwLTgwMDAtMDA4MDVmOWIwMTMxJywgICAgIC8vIG1vZGJ1cyBSVFUgYW5zd2Vyc1xyXG4gICAgTW9kYnVzUmVxdWVzdFV1aWQ6ICcwMDAzY2RkMi0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzEnICAgIC8vIG1vZGJ1cyBSVFUgcmVxdWVzdHNcclxufTtcclxuXHJcbi8qKlxyXG4gKiBNYWluIGxvb3Agb2YgdGhlIG1ldGVyIGhhbmRsZXIuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIHN0YXRlTWFjaGluZSgpIHtcclxuICAgIHZhciBuZXh0QWN0aW9uO1xyXG4gICAgY29uc3QgREVMQVlfTVMgPSA3NTA7XHJcbiAgICBjb25zdCBUSU1FT1VUX01TID0gMzAwMDA7XHJcbiAgICBidFN0YXRlLnN0YXJ0ZWQgPSB0cnVlO1xyXG5cclxuICAgIGxvZy5kZWJ1ZyhcIkN1cnJlbnQgc3RhdGU6XCIgKyBidFN0YXRlLnN0YXRlKTtcclxuXHJcbiAgICAvLyBDb25zZWN1dGl2ZSBzdGF0ZSBjb3VudGVkLiBDYW4gYmUgdXNlZCB0byB0aW1lb3V0LlxyXG4gICAgaWYgKGJ0U3RhdGUuc3RhdGUgPT0gYnRTdGF0ZS5wcmV2X3N0YXRlKSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQrKztcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFN0b3AgcmVxdWVzdCBmcm9tIEFQSVxyXG4gICAgaWYgKGJ0U3RhdGUuc3RvcFJlcXVlc3QpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBJTkc7XHJcbiAgICB9XHJcblxyXG4gICAgbG9nLmRlYnVnKFwiXFxTdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG4gICAgc3dpdGNoIChidFN0YXRlLnN0YXRlKSB7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5OT1RfQ09OTkVDVEVEOiAvLyBpbml0aWFsIHN0YXRlIG9uIFN0YXJ0KClcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGJ0UGFpckRldmljZTtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5DT05ORUNUSU5HOiAvLyB3YWl0aW5nIGZvciBjb25uZWN0aW9uIHRvIGNvbXBsZXRlXHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuREVWSUNFX1BBSVJFRDogLy8gY29ubmVjdGlvbiBjb21wbGV0ZSwgYWNxdWlyZSBtZXRlciBzdGF0ZVxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6IC8vIHdhaXRpbmcgZm9yIEJsdWV0b290aCBpbnRlcmZhY2VzXHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IChUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiVGltZW91dCBpbiBTVUJTQ1JJQklOR1wiKTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVDogLy8gcmVhZHkgdG8gY29tbXVuaWNhdGUsIGFjcXVpcmUgbWV0ZXIgc3RhdHVzXHJcbiAgICAgICAgICAgIG5leHRBY3Rpb24gPSBtZXRlckluaXQ7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVElBTElaSU5HOiAvLyByZWFkaW5nIHRoZSBtZXRlciBzdGF0dXNcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiVGltZW91dCBpbiBNRVRFUl9JTklUSUFMSVpJTkdcIik7XHJcbiAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBidFN1YnNjcmliZTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLklETEU6IC8vIHJlYWR5IHRvIHByb2Nlc3MgY29tbWFuZHMgZnJvbSBBUElcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsKVxyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHByb2Nlc3NDb21tYW5kO1xyXG4gICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSByZWZyZXNoO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuRVJST1I6IC8vIGFueXRpbWUgYW4gZXJyb3IgaGFwcGVuc1xyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gZGlzY29ubmVjdDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5CVVNZOiAvLyB3aGlsZSBhIGNvbW1hbmQgaW4gZ29pbmcgb25cclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiVGltZW91dCBpbiBCVVNZXCIpO1xyXG4gICAgICAgICAgICAgICAgLy8gVGltZW91dCwgdHJ5IHRvIHJlc3Vic2NyaWJlXHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVE9QUElORzpcclxuICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGRpc2Nvbm5lY3Q7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBFRDogLy8gYWZ0ZXIgYSBkaXNjb25uZWN0b3Igb3IgU3RvcCgpIHJlcXVlc3QsIHN0b3BzIHRoZSBzdGF0ZSBtYWNoaW5lLlxyXG4gICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICBicmVhaztcclxuICAgIH1cclxuXHJcbiAgICBidFN0YXRlLnByZXZfc3RhdGUgPSBidFN0YXRlLnN0YXRlO1xyXG5cclxuICAgIGlmIChuZXh0QWN0aW9uICE9IHVuZGVmaW5lZCkge1xyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcdEV4ZWN1dGluZzpcIiArIG5leHRBY3Rpb24ubmFtZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgbmV4dEFjdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCJFeGNlcHRpb24gaW4gc3RhdGUgbWFjaGluZVwiLCBlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoYnRTdGF0ZS5zdGF0ZSAhPSBTdGF0ZS5TVE9QUEVEKSB7XHJcbiAgICAgICAgdXRpbHMuc2xlZXAoREVMQVlfTVMpLnRoZW4oKCkgPT4gc3RhdGVNYWNoaW5lKCkpOyAvLyBSZWNoZWNrIHN0YXR1cyBpbiBERUxBWV9NUyBtc1xyXG4gICAgfVxyXG4gICAgZWxzZSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0VGVybWluYXRpbmcgU3RhdGUgbWFjaGluZVwiKTtcclxuICAgICAgICBidFN0YXRlLnN0YXJ0ZWQgPSBmYWxzZTtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIENhbGxlZCBmcm9tIHN0YXRlIG1hY2hpbmUgdG8gZXhlY3V0ZSBhIHNpbmdsZSBjb21tYW5kIGZyb20gYnRTdGF0ZS5jb21tYW5kIHByb3BlcnR5XHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NDb21tYW5kKCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICB2YXIgY29tbWFuZCA9IGJ0U3RhdGUuY29tbWFuZDtcclxuICAgICAgICB2YXIgcGFja2V0LCByZXNwb25zZSwgc3RhcnRHZW47XHJcbiAgICAgICAgY29uc3QgUkVTRVRfUE9XRVJfT0ZGID0gNjtcclxuICAgICAgICBjb25zdCBTRVRfUE9XRVJfT0ZGID0gNztcclxuICAgICAgICBjb25zdCBDTEVBUl9BVkdfTUlOX01BWCA9IDU7XHJcbiAgICAgICAgY29uc3QgUFVMU0VfQ01EID0gOTtcclxuXHJcbiAgICAgICAgaWYgKGNvbW1hbmQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJjb21tYW5kc1wiXSsrO1xyXG5cclxuICAgICAgICBsb2cuaW5mbygnXFx0XFx0RXhlY3V0aW5nIGNvbW1hbmQgJyArIGNvbW1hbmQpO1xyXG5cclxuICAgICAgICAvLyBGaXJzdCBzZXQgTk9ORSBiZWNhdXNlIHdlIGRvbid0IHdhbnQgdG8gd3JpdGUgbmV3IHNldHBvaW50cyB3aXRoIGFjdGl2ZSBnZW5lcmF0aW9uXHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0U2V0dGluZyBtZXRlciB0byBPRkZcIik7XHJcbiAgICAgICAgcGFja2V0ID0gc2VuZWNhLm1ha2VNb2RlUmVxdWVzdChDb21tYW5kVHlwZS5PRkYpO1xyXG4gICAgICAgIGF3YWl0IFNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcblxyXG4gICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgc2V0cG9pbnQgb3Igc2V0dGluZ1xyXG4gICAgICAgIGlmICh1dGlscy5pc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSB8fCB1dGlscy5pc1NldHRpbmcoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSB7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFdyaXRpbmcgc2V0cG9pbnQgOlwiICsgY29tbWFuZC5zZXRwb2ludCk7XHJcbiAgICAgICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHNlbmVjYS5tYWtlU2V0cG9pbnRSZXF1ZXN0KGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpKTtcclxuICAgICAgICAgICAgaWYgKHJlc3BvbnNlICE9IG51bGwgJiYgIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAwKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0cG9pbnQgbm90IGNvcnJlY3RseSB3cml0dGVuXCIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN3aXRjaCAoY29tbWFuZC50eXBlKSB7XHJcbiAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0R2VuID0gbW9kYnVzLm1ha2VGQzE2KG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQsIHNlbmVjYS5NU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbHVyZSB0byBzZXQgcG93ZXJvZmYgdGltZXIuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmICghdXRpbHMuaXNTZXR0aW5nKGNvbW1hbmQudHlwZSkgJiYgdXRpbHMuaXNWYWxpZChjb21tYW5kLnR5cGUpICYmIGNvbW1hbmQudHlwZSAhPSBDb21tYW5kVHlwZS5PRkYpICAvLyBJRiB0aGlzIGlzIGEgc2V0dGluZywgd2UncmUgZG9uZS5cclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgbW9kZSBzZXQgXHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFNldHRpbmcgbmV3IG1vZGUgOlwiICsgY29tbWFuZC50eXBlKTtcclxuICAgICAgICAgICAgcGFja2V0ID0gc2VuZWNhLm1ha2VNb2RlUmVxdWVzdChjb21tYW5kLnR5cGUpO1xyXG4gICAgICAgICAgICBpZiAocGFja2V0ID09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgY29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICBsb2cuZXJyb3IoXCJDb3VsZCBub3QgZ2VuZXJhdGUgbW9kYnVzIHBhY2tldCBmb3IgY29tbWFuZFwiLCBjb21tYW5kKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2UocGFja2V0KTtcclxuICAgICAgICAgICAgY29tbWFuZC5yZXF1ZXN0ID0gcGFja2V0O1xyXG4gICAgICAgICAgICBjb21tYW5kLmFuc3dlciA9IHJlc3BvbnNlO1xyXG5cclxuICAgICAgICAgICAgaWYgKCFtb2RidXMucGFyc2VGQzE2Y2hlY2tlZChyZXNwb25zZSwgMCkpIHtcclxuICAgICAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgY29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgYWxsIHJlZ2lzdGVycyB3ZXJlIHdyaXR0ZW5cIik7XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIC8vIFNvbWUgY29tbWFuZHMgcmVxdWlyZSBTVEFSVCBjb21tYW5kIHRvIGJlIGdpdmVuXHJcbiAgICAgICAgICAgIHN3aXRjaCAoY29tbWFuZC50eXBlKSB7XHJcbiAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlY6XHJcbiAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG4gICAgICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9hY3RpdmU6XHJcbiAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gUmVzZXQgdGhlIG1pbi9tYXgvYXZnIHZhbHVlXHJcbiAgICAgICAgICAgICAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVzZXR0aW5nIHN0YXRpc3RpY3NcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhLk1TQ1JlZ2lzdGVycy5DTUQsIFtDTEVBUl9BVkdfTUlOX01BWF0pO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIW1vZGJ1cy5wYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAxKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLmVycm9yID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkZhaWx1cmUgdG8gcmVzZXQgc3RhdHMuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVzZXR0aW5nIHN0YXRpc3RpY3NcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYobW9kYnVzLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhLk1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbUFVMU0VfQ01ELCAyXSk7IC8vIFN0YXJ0IHdpdGggbG93XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGFsbCByZWdpc3RlcnMgd2VyZSB3cml0dGVuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDAwKTtcclxuICAgICAgICAgICAgICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZXNldHRpbmcgc3RhdGlzdGljc1wiKTtcclxuICAgICAgICAgICAgICAgICAgICBzdGFydEdlbiA9IG1vZGJ1cy5tYWtlRkMxNihtb2RidXMuU0VORUNBX01CX1NMQVZFX0lELCBzZW5lY2EuTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtQVUxTRV9DTUQsIDFdKTsgLy8gc3RhcnQgZ2VuXHJcbiAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW9kYnVzLnBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGFsbCByZWdpc3RlcnMgd2VyZSB3cml0dGVuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfSAvLyBzd2l0Y2hcclxuXHJcbiAgICAgICAgICAgIC8vIERpc2FibGUgYXV0byBwb3dlciBvZmZcclxuICAgICAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0RGlzYWJsaW5nIHBvd2VyIG9mZlwiKTtcclxuICAgICAgICAgICAgc3RhcnRHZW4gPSBtb2RidXMubWFrZUZDMTYoc2VuZWNhLlNFTkVDQV9NQl9TTEFWRV9JRCwgc2VuZWNhLk1TQ1JlZ2lzdGVycy5DTUQsIFtSRVNFVF9QT1dFUl9PRkZdKTtcclxuICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG5cclxuICAgICAgICB9IC8vIGlmICghaXNTZXR0aW5nKGNvbW1hbmQudHlwZSkgJiYgaXNWYWxpZChjb21tYW5kLnR5cGUpKSlcclxuXHJcbiAgICAgICAgY29tbWFuZC5lcnJvciA9IGZhbHNlO1xyXG4gICAgICAgIGNvbW1hbmQucGVuZGluZyA9IGZhbHNlO1xyXG4gICAgICAgIGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIENhbGxlciBleHBlY3RzIGEgdmFsaWQgcHJvcGVydHkgaW4gR2V0U3RhdGUoKSBvbmNlIGNvbW1hbmQgaXMgZXhlY3V0ZWQuXHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVmcmVzaGluZyBjdXJyZW50IHN0YXRlXCIpO1xyXG4gICAgICAgIGF3YWl0IHJlZnJlc2goKTtcclxuXHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0Q29tcGxldGVkIGNvbW1hbmQgZXhlY3V0ZWRcIik7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLmVycm9yKFwiKiogZXJyb3Igd2hpbGUgZXhlY3V0aW5nIGNvbW1hbmQ6IFwiICsgZXJyKTtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBtb2RidXMuTW9kYnVzRXJyb3IpXHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJtb2RidXNfZXJyb3JzXCJdKys7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogU2VuZCB0aGUgbWVzc2FnZSB1c2luZyBCbHVldG9vdGggYW5kIHdhaXQgZm9yIGFuIGFuc3dlclxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBjb21tYW5kIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHNlbmRcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSB0aGUgbW9kYnVzIFJUVSBhbnN3ZXJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIFNlbmRBbmRSZXNwb25zZShjb21tYW5kKSB7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgPT0gbnVsbClcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuXHJcbiAgICBsb2cuZGVidWcoXCI+PiBcIiArIGJ1ZjJoZXgoY29tbWFuZCkpO1xyXG5cclxuICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcInJlcXVlc3RzXCJdKys7XHJcblxyXG4gICAgdmFyIHN0YXJ0VGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG4gICAgYXdhaXQgYnRTdGF0ZS5jaGFyV3JpdGUud3JpdGVWYWx1ZVdpdGhvdXRSZXNwb25zZShjb21tYW5kKTtcclxuICAgIHdoaWxlIChidFN0YXRlLnN0YXRlID09IFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORyB8fFxyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuQlVTWSkge1xyXG4gICAgICAgIGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIGJyZWFrO1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCAzNSkpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBlbmRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblxyXG4gICAgdmFyIGFuc3dlciA9IGJ0U3RhdGUucmVzcG9uc2U/LnNsaWNlKCk7XHJcbiAgICBidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuXHJcbiAgICBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdID0gTWF0aC5yb3VuZCgoMS4wICogYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlVGltZVwiXSAqIChidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VzXCJdICUgNTAwKSArIChlbmRUaW1lIC0gc3RhcnRUaW1lKSkgLyAoKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgMSkpO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RSZXNwb25zZVRpbWVcIl0gPSBNYXRoLnJvdW5kKGVuZFRpbWUgLSBzdGFydFRpbWUpICsgXCIgbXNcIjtcclxuICAgIGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0rKztcclxuXHJcbiAgICByZXR1cm4gYW5zd2VyO1xyXG59XHJcblxyXG4vKipcclxuICogQWNxdWlyZSB0aGUgY3VycmVudCBtb2RlIGFuZCBzZXJpYWwgbnVtYmVyIG9mIHRoZSBkZXZpY2UuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIG1ldGVySW5pdCgpIHtcclxuICAgIHZhciByZXNwb25zZTtcclxuXHJcbiAgICB0cnkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkc7XHJcbiAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc2VuZWNhLm1ha2VTZXJpYWxOdW1iZXIoKSk7XHJcbiAgICAgICAgYnRTdGF0ZS5tZXRlci5zZXJpYWwgPSBzZW5lY2EucGFyc2VTZXJpYWxOdW1iZXIocmVzcG9uc2UpO1xyXG4gICAgICAgIGxvZy5pbmZvKCdcXHRcXHRTZXJpYWwgbnVtYmVyOicgKyBidFN0YXRlLm1ldGVyLnNlcmlhbCk7XHJcblxyXG4gICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHNlbmVjYS5tYWtlQ3VycmVudE1vZGUoKSk7XHJcbiAgICAgICAgYnRTdGF0ZS5tZXRlci5tb2RlID0gc2VuZWNhLnBhcnNlQ3VycmVudE1vZGUocmVzcG9uc2UsIENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTik7XHJcbiAgICAgICAgbG9nLmRlYnVnKCdcXHRcXHRDdXJyZW50IG1vZGU6JyArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblxyXG4gICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHNlbmVjYS5tYWtlQmF0dGVyeUxldmVsKCkpO1xyXG4gICAgICAgIGJ0U3RhdGUubWV0ZXIuYmF0dGVyeSA9IE1hdGgucm91bmQoc2VuZWNhLnBhcnNlQmF0dGVyeShyZXNwb25zZSkgKiAxMDApIC8gMTAwO1xyXG5cclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuSURMRTtcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cud2FybihcIkVycm9yIHdoaWxlIGluaXRpYWxpemluZyBtZXRlciA6XCIgKyBlcnIpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIG1vZGJ1cy5Nb2RidXNFcnJvcilcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuICAgIH1cclxufVxyXG5cclxuLypcclxuICogQ2xvc2UgdGhlIGJsdWV0b290aCBpbnRlcmZhY2UgKHVucGFpcilcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gZGlzY29ubmVjdCgpIHtcclxuICAgIGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGlmIChidFN0YXRlLmJ0RGV2aWNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgbG9nLndhcm4oXCIqIENhbGxpbmcgZGlzY29ubmVjdCBvbiBidGRldmljZVwiKTtcclxuICAgICAgICAgICAgICAgIC8vIEF2b2lkIHRoZSBldmVudCBmaXJpbmcgd2hpY2ggbWF5IGxlYWQgdG8gYXV0by1yZWNvbm5lY3RcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2UucmVtb3ZlRXZlbnRMaXN0ZW5lcignZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZCcsIG9uRGlzY29ubmVjdGVkKTtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2UuZ2F0dC5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgY2F0Y2ggeyB9XHJcbiAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuU1RPUFBFRDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV2ZW50IGNhbGxlZCBieSBicm93c2VyIEJUIGFwaSB3aGVuIHRoZSBkZXZpY2UgZGlzY29ubmVjdFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBvbkRpc2Nvbm5lY3RlZCgpIHtcclxuICAgIGxvZy53YXJuKFwiKiBHQVRUIFNlcnZlciBkaXNjb25uZWN0ZWQgZXZlbnQsIHdpbGwgdHJ5IHRvIHJlY29ubmVjdCAqXCIpO1xyXG4gICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgYnRTdGF0ZS5zdGF0c1tcIkdBVFQgZGlzY29ubmVjdHNcIl0rKztcclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOyAvLyBUcnkgdG8gYXV0by1yZWNvbm5lY3QgdGhlIGludGVyZmFjZXMgd2l0aG91dCBwYWlyaW5nXHJcbn1cclxuXHJcbi8qKlxyXG4gKiBKb2lucyB0aGUgYXJndW1lbnRzIGludG8gYSBzaW5nbGUgYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtCdWZmZXJ9IGNvbmNhdGVuYXRlZCBidWZmZXJcclxuICovXHJcbmZ1bmN0aW9uIGFycmF5QnVmZmVyQ29uY2F0KCkge1xyXG4gICAgdmFyIGxlbmd0aCA9IDA7XHJcbiAgICB2YXIgYnVmZmVyID0gbnVsbDtcclxuXHJcbiAgICBmb3IgKHZhciBpIGluIGFyZ3VtZW50cykge1xyXG4gICAgICAgIGJ1ZmZlciA9IGFyZ3VtZW50c1tpXTtcclxuICAgICAgICBsZW5ndGggKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIGpvaW5lZCA9IG5ldyBVaW50OEFycmF5KGxlbmd0aCk7XHJcbiAgICB2YXIgb2Zmc2V0ID0gMDtcclxuXHJcbiAgICBmb3IgKGkgaW4gYXJndW1lbnRzKSB7XHJcbiAgICAgICAgYnVmZmVyID0gYXJndW1lbnRzW2ldO1xyXG4gICAgICAgIGpvaW5lZC5zZXQobmV3IFVpbnQ4QXJyYXkoYnVmZmVyKSwgb2Zmc2V0KTtcclxuICAgICAgICBvZmZzZXQgKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGpvaW5lZC5idWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFdmVudCBjYWxsZWQgYnkgYmx1ZXRvb3RoIGNoYXJhY3RlcmlzdGljcyB3aGVuIHJlY2VpdmluZyBkYXRhXHJcbiAqIEBwYXJhbSB7YW55fSBldmVudFxyXG4gKi9cclxuZnVuY3Rpb24gaGFuZGxlTm90aWZpY2F0aW9ucyhldmVudCkge1xyXG4gICAgbGV0IHZhbHVlID0gZXZlbnQudGFyZ2V0LnZhbHVlO1xyXG4gICAgaWYgKHZhbHVlICE9IG51bGwpIHtcclxuICAgICAgICBsb2cuZGVidWcoJzw8ICcgKyBidWYyaGV4KHZhbHVlLmJ1ZmZlcikpO1xyXG4gICAgICAgIGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIHtcclxuICAgICAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IGFycmF5QnVmZmVyQ29uY2F0KGJ0U3RhdGUucmVzcG9uc2UsIHZhbHVlLmJ1ZmZlcik7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IHZhbHVlLmJ1ZmZlci5zbGljZSgpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFRoaXMgZnVuY3Rpb24gd2lsbCBzdWNjZWVkIG9ubHkgaWYgY2FsbGVkIGFzIGEgY29uc2VxdWVuY2Ugb2YgYSB1c2VyLWdlc3R1cmVcclxuICogRS5nLiBidXR0b24gY2xpY2suIFRoaXMgaXMgZHVlIHRvIEJsdWVUb290aCBBUEkgc2VjdXJpdHkgbW9kZWwuXHJcbiAqICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ0UGFpckRldmljZSgpIHtcclxuICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5DT05ORUNUSU5HO1xyXG4gICAgdmFyIGZvcmNlU2VsZWN0aW9uID0gYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl07XHJcbiAgICBsb2cuZGVidWcoXCJidFBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0QXZhaWxhYmlsaXR5KSA9PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJpbGl0eSA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0QXZhaWxhYmlsaXR5KCk7XHJcbiAgICAgICAgICAgIGlmICghYXZhaWxhYmlsaXR5KSB7XHJcbiAgICAgICAgICAgICAgICBsb2cuZXJyb3IoXCJCbHVldG9vdGggbm90IGF2YWlsYWJsZSBpbiBicm93c2VyLlwiKTtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkJyb3dzZXIgZG9lcyBub3QgcHJvdmlkZSBibHVldG9vdGhcIik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIGRldmljZSA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIERvIHdlIGFscmVhZHkgaGF2ZSBwZXJtaXNzaW9uP1xyXG4gICAgICAgIGlmICh0eXBlb2YgKG5hdmlnYXRvci5ibHVldG9vdGg/LmdldERldmljZXMpID09ICdmdW5jdGlvbidcclxuICAgICAgICAgICAgJiYgIWZvcmNlU2VsZWN0aW9uKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZURldmljZXMgPSBhd2FpdCBuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKTtcclxuICAgICAgICAgICAgYXZhaWxhYmxlRGV2aWNlcy5mb3JFYWNoKGZ1bmN0aW9uIChkZXYsIGluZGV4KSB7XHJcbiAgICAgICAgICAgICAgICBsb2cuZGVidWcoXCJGb3VuZCBhdXRob3JpemVkIGRldmljZSA6XCIgKyBkZXYubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZGV2Lm5hbWUuc3RhcnRzV2l0aChcIk1TQ1wiKSlcclxuICAgICAgICAgICAgICAgICAgICBkZXZpY2UgPSBkZXY7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoXCJuYXZpZ2F0b3IuYmx1ZXRvb3RoLmdldERldmljZXMoKT1cIiArIGRldmljZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIElmIG5vdCwgcmVxdWVzdCBmcm9tIHVzZXJcclxuICAgICAgICBpZiAoZGV2aWNlID09IG51bGwpIHtcclxuICAgICAgICAgICAgZGV2aWNlID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aFxyXG4gICAgICAgICAgICAgICAgLnJlcXVlc3REZXZpY2Uoe1xyXG4gICAgICAgICAgICAgICAgICAgIGFjY2VwdEFsbERldmljZXM6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWVQcmVmaXg6ICdNU0MnIH1dLFxyXG4gICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsU2VydmljZXM6IFtCbHVlVG9vdGhNU0MuU2VydmljZVV1aWRdXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBsb2cuaW5mbyhcIkJsdWV0b290aCBkZXZpY2UgXCIgKyBkZXZpY2UubmFtZSArIFwiIGNvbm5lY3RlZC5cIik7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMuc2xlZXAoNTAwKTtcclxuICAgIH1cclxuICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG4gICAgICAgIGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICBpZiAoYnRTdGF0ZS5jaGFyUmVhZCAhPSBudWxsKSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLmNoYXJSZWFkLnN0b3BOb3RpZmljYXRpb25zKCk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7IH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyV3JpdGUgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogT25jZSB0aGUgZGV2aWNlIGlzIGF2YWlsYWJsZSwgaW5pdGlhbGl6ZSB0aGUgc2VydmljZSBhbmQgdGhlIDIgY2hhcmFjdGVyaXN0aWNzIG5lZWRlZC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gYnRTdWJzY3JpYmUoKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVUJTQ1JJQklORztcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wic3ViY3JpYmVzXCJdKys7XHJcbiAgICAgICAgbGV0IGRldmljZSA9IGJ0U3RhdGUuYnREZXZpY2U7XHJcbiAgICAgICAgbGV0IHNlcnZlciA9IG51bGw7XHJcblxyXG4gICAgICAgIGlmICghZGV2aWNlPy5nYXR0Py5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKGBDb25uZWN0aW5nIHRvIEdBVFQgU2VydmVyIG9uICR7ZGV2aWNlLm5hbWV9Li4uYCk7XHJcbiAgICAgICAgICAgIGRldmljZS5hZGRFdmVudExpc3RlbmVyKCdnYXR0c2VydmVyZGlzY29ubmVjdGVkJywgb25EaXNjb25uZWN0ZWQpO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnRTZXJ2aWNlPy5jb25uZWN0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBidFN0YXRlLmJ0U2VydmljZS5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycikgeyB9XHJcblxyXG4gICAgICAgICAgICBzZXJ2ZXIgPSBhd2FpdCBkZXZpY2UuZ2F0dC5jb25uZWN0KCk7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBHQVRUIHNlcnZlcicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCdHQVRUIGFscmVhZHkgY29ubmVjdGVkJyk7XHJcbiAgICAgICAgICAgIHNlcnZlciA9IGRldmljZS5nYXR0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBhd2FpdCBzZXJ2ZXIuZ2V0UHJpbWFyeVNlcnZpY2UoQmx1ZVRvb3RoTVNDLlNlcnZpY2VVdWlkKTtcclxuICAgICAgICBpZiAoYnRTdGF0ZS5idFNlcnZpY2UgPT0gbnVsbClcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR0FUVCBTZXJ2aWNlIHJlcXVlc3QgZmFpbGVkXCIpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBTZXJpYWwgc2VydmljZScpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c1JlcXVlc3RVdWlkKTtcclxuICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgd3JpdGUgY2hhcmFjdGVyaXN0aWMnKTtcclxuICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c0Fuc3dlclV1aWQpO1xyXG4gICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCByZWFkIGNoYXJhY3RlcmlzdGljJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5yZXNwb25zZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZC5hZGRFdmVudExpc3RlbmVyKCdjaGFyYWN0ZXJpc3RpY3ZhbHVlY2hhbmdlZCcsIGhhbmRsZU5vdGlmaWNhdGlvbnMpO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RhcnROb3RpZmljYXRpb25zKCk7XHJcbiAgICAgICAgbG9nLmluZm8oJz4gQmx1ZXRvb3RoIGludGVyZmFjZXMgcmVhZHkuJyk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCg1MCk7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVQ7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCIqKiBlcnJvciB3aGlsZSBzdWJzY3JpYmluZzogXCIgKyBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgaWYgKGJ0U3RhdGUuY2hhclJlYWQgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQuZGlzY29ubmVjdCgpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDtcclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogV2hlbiBpZGxlLCB0aGlzIGZ1bmN0aW9uIGlzIGNhbGxlZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKCkge1xyXG4gICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkJVU1k7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIC8vIENoZWNrIHRoZSBtb2RlIGZpcnN0XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHNlbmVjYS5tYWtlQ3VycmVudE1vZGUoKSk7XHJcbiAgICAgICAgdmFyIG1vZGUgPSBzZW5lY2EucGFyc2VDdXJyZW50TW9kZShyZXNwb25zZSwgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHJcbiAgICAgICAgaWYgKG1vZGUgIT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUubWV0ZXIubW9kZSA9IG1vZGU7XHJcblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc0dlbmVyYXRpb24oKSlcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlZnJlc2hHZW5lcmF0aW9uKCk7XHJcblxyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc01lYXN1cmVtZW50KCkpXHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZWZyZXNoTWVhc3VyZSgpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRGaW5pc2hlZCByZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLndhcm4oXCJFcnJvciB3aGlsZSByZWZyZXNoaW5nIG1lYXN1cmVcIiArIGVycik7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgbW9kYnVzLk1vZGJ1c0Vycm9yKVxyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmVhZCB0aGUgbGFzdCBtZWFzdXJlIGFuZCB1cGRhdGUgYnRTdGF0ZS5sYXN0TWVhc3VyZSBwcm9wZXJ0eVxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoTWVhc3VyZSgpIHtcclxuICAgIC8vIFJlYWQgcXVhbGl0eVxyXG4gICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHNlbmVjYS5tYWtlUXVhbGl0eUJpdFJlcXVlc3QoKSk7XHJcbiAgICB2YXIgdmFsaWQgPSBzZW5lY2EuaXNRdWFsaXR5VmFsaWQocmVzcG9uc2UpO1xyXG5cclxuICAgIC8vIFJlYWQgbWVhc3VyZVxyXG4gICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc2VuZWNhLm1ha2VNZWFzdXJlUmVxdWVzdChidFN0YXRlLm1ldGVyLm1vZGUpKTtcclxuICAgIHZhciBtZWFzID0gc2VuZWNhLnBhcnNlTWVhc3VyZShyZXNwb25zZSwgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuICAgIG1lYXNbXCJlcnJvclwiXSA9ICF2YWxpZDtcclxuXHJcbiAgICBidFN0YXRlLmxhc3RNZWFzdXJlID0gbWVhcztcclxufVxyXG5cclxuLyoqXHJcbiAqIEdldHMgdGhlIGN1cnJlbnQgdmFsdWVzIGZvciB0aGUgZ2VuZXJhdGVkIFUsSSBmcm9tIHRoZSBkZXZpY2VcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEdlbmVyYXRpb24oKSB7XHJcbiAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc2VuZWNhLm1ha2VTZXRwb2ludFJlYWQoYnRTdGF0ZS5tZXRlci5tb2RlKSk7XHJcbiAgICBpZiAocmVzcG9uc2UgIT0gbnVsbCkge1xyXG4gICAgICAgIHZhciByZXN1bHRzID0gc2VuZWNhLnBhcnNlU2V0cG9pbnRSZWFkKHJlc3BvbnNlLCBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cclxuICAgICAgICByZXNwb25zZSA9IGF3YWl0IFNlbmRBbmRSZXNwb25zZShzZW5lY2EubWFrZUdlblN0YXR1c1JlYWQoKSk7XHJcbiAgICAgICAgcmVzdWx0c1tcImVycm9yXCJdID0gIXNlbmVjYS5wYXJzZUdlblN0YXR1cyhyZXNwb25zZSwgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHJcbiAgICAgICAgYnRTdGF0ZS5sYXN0U2V0cG9pbnQgPSByZXN1bHRzO1xyXG4gICAgfVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtzdGF0ZU1hY2hpbmV9OyIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuLi9jb25zdGFudHMnKTtcclxudmFyIE1ldGVyU3RhdGUgPSByZXF1aXJlKCcuL01ldGVyU3RhdGUnKTtcclxuXHJcbi8vIEN1cnJlbnQgc3RhdGUgb2YgdGhlIGJsdWV0b290aFxyXG5jbGFzcyBBUElTdGF0ZSB7XHJcbiAgICBjb25zdHJ1Y3RvcigpIHtcclxuICAgICAgICB0aGlzLnN0YXRlID0gY29uc3RhbnRzLlN0YXRlLk5PVF9DT05ORUNURUQ7XHJcbiAgICAgICAgdGhpcy5wcmV2X3N0YXRlID0gY29uc3RhbnRzLlN0YXRlLk5PVF9DT05ORUNURUQ7XHJcbiAgICAgICAgdGhpcy5zdGF0ZV9jcHQgPSAwO1xyXG5cclxuICAgICAgICB0aGlzLnN0YXJ0ZWQgPSBmYWxzZTsgLy8gU3RhdGUgbWFjaGluZSBzdGF0dXNcclxuICAgICAgICB0aGlzLnN0b3BSZXF1ZXN0ID0gZmFsc2U7IC8vIFRvIHJlcXVlc3QgZGlzY29ubmVjdFxyXG4gICAgICAgIHRoaXMubGFzdE1lYXN1cmUgPSB7fTsgLy8gQXJyYXkgd2l0aCBcIk1lYXN1cmVOYW1lXCIgOiB2YWx1ZVxyXG4gICAgICAgIHRoaXMubGFzdFNldHBvaW50ID0ge307IC8vIEFycmF5IHdpdGggXCJTZXRwb2ludFR5cGVcIiA6IHZhbHVlXHJcblxyXG4gICAgICAgIC8vIHN0YXRlIG9mIGNvbm5lY3RlZCBtZXRlclxyXG4gICAgICAgIHRoaXMubWV0ZXIgPSBuZXcgTWV0ZXJTdGF0ZSgpO1xyXG5cclxuICAgICAgICAvLyBsYXN0IG1vZGJ1cyBSVFUgY29tbWFuZFxyXG4gICAgICAgIHRoaXMuY29tbWFuZCA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIGxhc3QgbW9kYnVzIFJUVSBhbnN3ZXJcclxuICAgICAgICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gYmx1ZXRvb3RoIHByb3BlcnRpZXNcclxuICAgICAgICB0aGlzLmNoYXJSZWFkID0gbnVsbDtcclxuICAgICAgICB0aGlzLmNoYXJXcml0ZSA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuYnREZXZpY2UgPSBudWxsO1xyXG5cclxuICAgICAgICAvLyBnZW5lcmFsIHN0YXRpc3RpY3MgZm9yIGRlYnVnZ2luZ1xyXG4gICAgICAgIHRoaXMuc3RhdHMgPSB7XHJcbiAgICAgICAgICAgIFwicmVxdWVzdHNcIjogMCxcclxuICAgICAgICAgICAgXCJyZXNwb25zZXNcIjogMCxcclxuICAgICAgICAgICAgXCJtb2RidXNfZXJyb3JzXCI6IDAsXHJcbiAgICAgICAgICAgIFwiR0FUVCBkaXNjb25uZWN0c1wiOiAwLFxyXG4gICAgICAgICAgICBcImV4Y2VwdGlvbnNcIjogMCxcclxuICAgICAgICAgICAgXCJzdWJjcmliZXNcIjogMCxcclxuICAgICAgICAgICAgXCJjb21tYW5kc1wiOiAwLFxyXG4gICAgICAgICAgICBcInJlc3BvbnNlVGltZVwiOiAwLjAsXHJcbiAgICAgICAgICAgIFwibGFzdFJlc3BvbnNlVGltZVwiOiAwLjAsXHJcbiAgICAgICAgICAgIFwibGFzdF9jb25uZWN0XCI6IG5ldyBEYXRlKDIwMjAsIDEsIDEpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0aGlzLm9wdGlvbnMgPSB7XHJcbiAgICAgICAgICAgIFwiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIiA6IHRydWVcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmxldCBidFN0YXRlID0gbmV3IEFQSVN0YXRlKCk7XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgQVBJU3RhdGUsIGJ0U3RhdGUgfSIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuLi9jb25zdGFudHMnKTtcclxudmFyIHV0aWxzID0gcmVxdWlyZSgnLi4vdXRpbHMnKTtcclxudmFyIENvbW1hbmRUeXBlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlO1xyXG5cclxuY29uc3QgTUFYX1VfR0VOID0gMjcuMDsgLy8gbWF4aW11bSB2b2x0YWdlIFxyXG5cclxuLyoqXHJcbiAqIENvbW1hbmQgdG8gdGhlIG1ldGVyLCBtYXkgaW5jbHVkZSBzZXRwb2ludFxyXG4gKiAqL1xyXG4gY2xhc3MgQ29tbWFuZCB7XHJcbiAgICAvKipcclxuICAgICAqIENyZWF0ZXMgYSBuZXcgY29tbWFuZFxyXG4gICAgICogQHBhcmFtIHtDb21tYW5kVHlwZX0gY3R5cGVcclxuICAgICAqL1xyXG4gICAgY29uc3RydWN0b3IoY3R5cGUgPSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuICAgICAgICB0aGlzLnR5cGUgPSBwYXJzZUludChjdHlwZSk7XHJcbiAgICAgICAgdGhpcy5zZXRwb2ludCA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5zZXRwb2ludDIgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuZXJyb3IgPSBmYWxzZTtcclxuICAgICAgICB0aGlzLnBlbmRpbmcgPSB0cnVlO1xyXG4gICAgICAgIHRoaXMucmVxdWVzdCA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgc3RhdGljIENyZWF0ZU5vU1AoY3R5cGUpXHJcbiAgICB7XHJcbiAgICAgICAgdmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuICAgICAgICByZXR1cm4gY21kO1xyXG4gICAgfVxyXG4gICAgc3RhdGljIENyZWF0ZU9uZVNQKGN0eXBlLCBzZXRwb2ludClcclxuICAgIHtcclxuICAgICAgICB2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG4gICAgICAgIGNtZC5zZXRwb2ludCA9IHBhcnNlRmxvYXQoc2V0cG9pbnQpO1xyXG4gICAgICAgIHJldHVybiBjbWQ7XHJcbiAgICB9XHJcbiAgICBzdGF0aWMgQ3JlYXRlVHdvU1AoY3R5cGUsIHNldDEsIHNldDIpXHJcbiAgICB7XHJcbiAgICAgICAgdmFyIGNtZCA9IG5ldyBDb21tYW5kKGN0eXBlKTtcclxuICAgICAgICBjbWQuc2V0cG9pbnQgPSBwYXJzZUZsb2F0KHNldDEpO1xyXG4gICAgICAgIGNtZC5zZXRwb2ludDIgPSBwYXJzZUZsb2F0KHNldDIpOztcclxuICAgICAgICByZXR1cm4gY21kO1xyXG4gICAgfVxyXG5cclxuICAgIHRvU3RyaW5nKCkge1xyXG4gICAgICAgIHJldHVybiBcIlR5cGU6IFwiICsgdXRpbHMuUGFyc2UoQ29tbWFuZFR5cGUsIHRoaXMudHlwZSkgKyBcIiwgc2V0cG9pbnQ6XCIgKyB0aGlzLnNldHBvaW50ICsgXCIsIHNldHBvaW50MjogXCIgKyB0aGlzLnNldHBvaW50MiArIFwiLCBwZW5kaW5nOlwiICsgdGhpcy5wZW5kaW5nICsgXCIsIGVycm9yOlwiICsgdGhpcy5lcnJvcjtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEdldHMgdGhlIGRlZmF1bHQgc2V0cG9pbnQgZm9yIHRoaXMgY29tbWFuZCB0eXBlXHJcbiAgICAgKiBAcmV0dXJucyB7QXJyYXl9IHNldHBvaW50KHMpIGV4cGVjdGVkXHJcbiAgICAgKi9cclxuICAgIGRlZmF1bHRTZXRwb2ludCgpIHtcclxuICAgICAgICBzd2l0Y2ggKHRoaXMudHlwZSkge1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdUZW1wZXJhdHVyZSAowrBDKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1ZvbHRhZ2UgKFYpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1ZvbHRhZ2UgKG1WKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX3Bhc3NpdmU6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnQ3VycmVudCAobUEpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0xvYWRDZWxsOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0ltYmFsYW5jZSAobVYvViknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0ZyZXF1ZW5jeSAoSHopJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnUHVsc2VzIGNvdW50JzogMCwgJ0ZyZXF1ZW5jeSAoSHopJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VUaHJlc2hvbGRfRjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdVdGhyZXNob2xkIChWKSc6IDIuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TZW5zaXRpdml0eV91UzpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdTZW5zaWJpbGl0eSAodVMpJzogMi4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX0NvbGRKdW5jdGlvbjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdDb2xkIGp1bmN0aW9uIGNvbXBlbnNhdGlvbic6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VbG93OlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1UgbG93IChWKSc6IDAuMCAvIE1BWF9VX0dFTiB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VaGlnaDpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdVIGhpZ2ggKFYpJzogNS4wIC8gTUFYX1VfR0VOIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnRGVsYXkgKHMpJzogNjAgKiA1IH07XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4ge307XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaXNHZW5lcmF0aW9uKCkge1xyXG4gICAgICAgIHJldHVybiB1dGlscy5pc0dlbmVyYXRpb24odGhpcy50eXBlKTtcclxuICAgIH1cclxuICAgIGlzTWVhc3VyZW1lbnQoKSB7XHJcbiAgICAgICAgcmV0dXJuIHV0aWxzLmlzTWVhc3VyZW1lbnQodGhpcy50eXBlKTtcclxuICAgIH1cclxuICAgIGlzU2V0dGluZygpIHtcclxuICAgICAgICByZXR1cm4gdXRpbHMuaXNTZXR0aW5nKHRoaXMudHlwZSk7XHJcbiAgICB9XHJcbiAgICBpc1ZhbGlkKCkge1xyXG4gICAgICAgIHJldHVybiAodXRpbHMuaXNNZWFzdXJlbWVudCh0aGlzLnR5cGUpIHx8IHV0aWxzLmlzR2VuZXJhdGlvbih0aGlzLnR5cGUpIHx8IHV0aWxzLmlzU2V0dGluZyh0aGlzLnR5cGUpKTtcclxuICAgIH1cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBDb21tYW5kOyIsImNsYXNzIENvbW1hbmRSZXN1bHRcclxue1xyXG4gICAgdmFsdWUgPSAwLjA7XHJcbiAgICByZXN1bHQgPSBmYWxzZTtcclxuICAgIG1lc3NhZ2UgPSBcIlwiO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IENvbW1hbmRSZXN1bHQ7IiwidmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4uL2NvbnN0YW50cycpO1xyXG5cclxuLyoqXHJcbiAqIEN1cnJlbnQgc3RhdGUgb2YgdGhlIG1ldGVyXHJcbiAqICovXHJcbiBjbGFzcyBNZXRlclN0YXRlIHtcclxuICAgIGNvbnN0cnVjdG9yKCkge1xyXG4gICAgICAgIHRoaXMuZmlybXdhcmUgPSBcIlwiOyAvLyBGaXJtd2FyZSB2ZXJzaW9uXHJcbiAgICAgICAgdGhpcy5zZXJpYWwgPSBcIlwiOyAvLyBTZXJpYWwgbnVtYmVyXHJcbiAgICAgICAgdGhpcy5tb2RlID0gY29uc3RhbnRzLkNvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTjtcclxuICAgICAgICB0aGlzLmJhdHRlcnkgPSAwLjA7XHJcbiAgICB9XHJcblxyXG4gICAgaXNNZWFzdXJlbWVudCgpIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5tb2RlID4gY29uc3RhbnRzLkNvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiB0aGlzLm1vZGUgPCBjb25zdGFudHMuQ29tbWFuZFR5cGUuT0ZGO1xyXG4gICAgfVxyXG5cclxuICAgIGlzR2VuZXJhdGlvbigpIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5tb2RlID4gY29uc3RhbnRzLkNvbW1hbmRUeXBlLk9GRiAmJiB0aGlzLm1vZGUgPCBjb25zdGFudHMuQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEO1xyXG4gICAgfVxyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IE1ldGVyU3RhdGU7IiwiLyoqXHJcbiAqIENvbW1hbmQgdHlwZSwgYWthIG1vZGUgdmFsdWUgdG8gYmUgd3JpdHRlbiBpbnRvIE1TQyBjdXJyZW50IHN0YXRlIHJlZ2lzdGVyXHJcbiAqICovXHJcbiBjb25zdCBDb21tYW5kVHlwZSA9IHtcclxuICAgIE5PTkVfVU5LTk9XTjogMCwgLyoqKiBNRUFTVVJJTkcgRkVBVFVSRVMgQUZURVIgVEhJUyBQT0lOVCAqKioqKioqL1xyXG4gICAgbUFfcGFzc2l2ZTogMSxcclxuICAgIG1BX2FjdGl2ZTogMixcclxuICAgIFY6IDMsXHJcbiAgICBtVjogNCxcclxuICAgIFRIRVJNT19KOiA1LCAvLyBUZXJtb2NvcHBpZVxyXG4gICAgVEhFUk1PX0s6IDYsXHJcbiAgICBUSEVSTU9fVDogNyxcclxuICAgIFRIRVJNT19FOiA4LFxyXG4gICAgVEhFUk1PX0w6IDksXHJcbiAgICBUSEVSTU9fTjogMTAsXHJcbiAgICBUSEVSTU9fUjogMTEsXHJcbiAgICBUSEVSTU9fUzogMTIsXHJcbiAgICBUSEVSTU9fQjogMTMsXHJcbiAgICBQVDEwMF8yVzogMTQsIC8vIFJURCAyIGZpbGlcclxuICAgIFBUMTAwXzNXOiAxNSxcclxuICAgIFBUMTAwXzRXOiAxNixcclxuICAgIFBUNTAwXzJXOiAxNyxcclxuICAgIFBUNTAwXzNXOiAxOCxcclxuICAgIFBUNTAwXzRXOiAxOSxcclxuICAgIFBUMTAwMF8yVzogMjAsXHJcbiAgICBQVDEwMDBfM1c6IDIxLFxyXG4gICAgUFQxMDAwXzRXOiAyMixcclxuICAgIEN1NTBfMlc6IDIzLFxyXG4gICAgQ3U1MF8zVzogMjQsXHJcbiAgICBDdTUwXzRXOiAyNSxcclxuICAgIEN1MTAwXzJXOiAyNixcclxuICAgIEN1MTAwXzNXOiAyNyxcclxuICAgIEN1MTAwXzRXOiAyOCxcclxuICAgIE5pMTAwXzJXOiAyOSxcclxuICAgIE5pMTAwXzNXOiAzMCxcclxuICAgIE5pMTAwXzRXOiAzMSxcclxuICAgIE5pMTIwXzJXOiAzMixcclxuICAgIE5pMTIwXzNXOiAzMyxcclxuICAgIE5pMTIwXzRXOiAzNCxcclxuICAgIExvYWRDZWxsOiAzNSwgICAvLyBDZWxsZSBkaSBjYXJpY29cclxuICAgIEZyZXF1ZW5jeTogMzYsICAvLyBGcmVxdWVuemFcclxuICAgIFB1bHNlVHJhaW46IDM3LCAvLyBDb250ZWdnaW8gaW1wdWxzaVxyXG4gICAgUkVTRVJWRUQ6IDM4LFxyXG4gICAgUkVTRVJWRURfMjogNDAsXHJcbiAgICBPRkY6IDEwMCwgLy8gKioqKioqKioqIEdFTkVSQVRJT04gQUZURVIgVEhJUyBQT0lOVCAqKioqKioqKioqKioqKioqKi9cclxuICAgIEdFTl9tQV9wYXNzaXZlOiAxMDEsXHJcbiAgICBHRU5fbUFfYWN0aXZlOiAxMDIsXHJcbiAgICBHRU5fVjogMTAzLFxyXG4gICAgR0VOX21WOiAxMDQsXHJcbiAgICBHRU5fVEhFUk1PX0o6IDEwNSxcclxuICAgIEdFTl9USEVSTU9fSzogMTA2LFxyXG4gICAgR0VOX1RIRVJNT19UOiAxMDcsXHJcbiAgICBHRU5fVEhFUk1PX0U6IDEwOCxcclxuICAgIEdFTl9USEVSTU9fTDogMTA5LFxyXG4gICAgR0VOX1RIRVJNT19OOiAxMTAsXHJcbiAgICBHRU5fVEhFUk1PX1I6IDExMSxcclxuICAgIEdFTl9USEVSTU9fUzogMTEyLFxyXG4gICAgR0VOX1RIRVJNT19COiAxMTMsXHJcbiAgICBHRU5fUFQxMDBfMlc6IDExNCxcclxuICAgIEdFTl9QVDUwMF8yVzogMTE3LFxyXG4gICAgR0VOX1BUMTAwMF8yVzogMTIwLFxyXG4gICAgR0VOX0N1NTBfMlc6IDEyMyxcclxuICAgIEdFTl9DdTEwMF8yVzogMTI2LFxyXG4gICAgR0VOX05pMTAwXzJXOiAxMjksXHJcbiAgICBHRU5fTmkxMjBfMlc6IDEzMixcclxuICAgIEdFTl9Mb2FkQ2VsbDogMTM1LFxyXG4gICAgR0VOX0ZyZXF1ZW5jeTogMTM2LFxyXG4gICAgR0VOX1B1bHNlVHJhaW46IDEzNyxcclxuICAgIEdFTl9SRVNFUlZFRDogMTM4LFxyXG4gICAgLy8gU3BlY2lhbCBzZXR0aW5ncyBiZWxvdyB0aGlzIHBvaW50c1xyXG4gICAgU0VUVElOR19SRVNFUlZFRDogMTAwMCxcclxuICAgIFNFVF9VVGhyZXNob2xkX0Y6IDEwMDEsXHJcbiAgICBTRVRfU2Vuc2l0aXZpdHlfdVM6IDEwMDIsXHJcbiAgICBTRVRfQ29sZEp1bmN0aW9uOiAxMDAzLFxyXG4gICAgU0VUX1Vsb3c6IDEwMDQsXHJcbiAgICBTRVRfVWhpZ2g6IDEwMDUsXHJcbiAgICBTRVRfU2h1dGRvd25EZWxheTogMTAwNlxyXG59O1xyXG5cclxuXHJcblxyXG5cclxuLypcclxuICogSW50ZXJuYWwgc3RhdGUgbWFjaGluZSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmNvbnN0IFN0YXRlID0ge1xyXG4gICAgTk9UX0NPTk5FQ1RFRDogJ05vdCBjb25uZWN0ZWQnLFxyXG4gICAgQ09OTkVDVElORzogJ0JsdWV0b290aCBkZXZpY2UgcGFpcmluZy4uLicsXHJcbiAgICBERVZJQ0VfUEFJUkVEOiAnRGV2aWNlIHBhaXJlZCcsXHJcbiAgICBTVUJTQ1JJQklORzogJ0JsdWV0b290aCBpbnRlcmZhY2VzIGNvbm5lY3RpbmcuLi4nLFxyXG4gICAgSURMRTogJ0lkbGUnLFxyXG4gICAgQlVTWTogJ0J1c3knLFxyXG4gICAgRVJST1I6ICdFcnJvcicsXHJcbiAgICBTVE9QUElORzogJ0Nsb3NpbmcgQlQgaW50ZXJmYWNlcy4uLicsXHJcbiAgICBTVE9QUEVEOiAnU3RvcHBlZCcsXHJcbiAgICBNRVRFUl9JTklUOiAnTWV0ZXIgY29ubmVjdGVkJyxcclxuICAgIE1FVEVSX0lOSVRJQUxJWklORzogJ1JlYWRpbmcgbWV0ZXIgc3RhdGUuLi4nXHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtTdGF0ZSwgQ29tbWFuZFR5cGUgfSIsIid1c2Ugc3RyaWN0JztcclxuXHJcbmNvbnN0IGxvZyA9IHJlcXVpcmUoXCJsb2dsZXZlbFwiKTtcclxuXHJcbmNvbnN0IGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbmNvbnN0IEFQSVN0YXRlID0gcmVxdWlyZSgnLi9jbGFzc2VzL0FQSVN0YXRlJyk7XHJcbmNvbnN0IENvbW1hbmQgPSByZXF1aXJlKCcuL2NsYXNzZXMvQ29tbWFuZCcpO1xyXG5yZXF1aXJlKCcuL2NsYXNzZXMvTWV0ZXJTdGF0ZScpO1xyXG5yZXF1aXJlKCcuL21vZGJ1c1J0dScpO1xyXG5yZXF1aXJlKCcuL3NlbmVjYU1vZGJ1cycpO1xyXG5jb25zdCBQdWJsaWNBUEkgPXJlcXVpcmUoJy4vbWV0ZXJQdWJsaWNBUEknKTtcclxucmVxdWlyZSgnLi9ibHVldG9vdGgnKTtcclxucmVxdWlyZSgnLi91dGlscycpO1xyXG5cclxuLyoqXHJcbiAqIFRoZSBtYWluIG9iamVjdCB3aXRoIHRoZSBzdGF0ZSBvZiBtZXRlciwgYmx1ZXRvb3RoLCBjb21tYW5kLi4uXHJcbiAqICovXHJcblxyXG5cclxuZXhwb3J0cy5TdG9wID0gUHVibGljQVBJLlN0b3A7XHJcbmV4cG9ydHMuUGFpciA9IFB1YmxpY0FQSS5QYWlyO1xyXG5leHBvcnRzLkV4ZWN1dGUgPSBQdWJsaWNBUEkuRXhlY3V0ZTtcclxuZXhwb3J0cy5TaW1wbGVFeGVjdXRlID0gUHVibGljQVBJLlNpbXBsZUV4ZWN1dGU7XHJcbmV4cG9ydHMuR2V0U3RhdGUgPSBQdWJsaWNBUEkuR2V0U3RhdGU7XHJcbmV4cG9ydHMuU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcbmV4cG9ydHMuQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbmV4cG9ydHMuQ29tbWFuZCA9IENvbW1hbmQ7XHJcbmV4cG9ydHMuUGFyc2UgPSBQdWJsaWNBUEkuUGFyc2U7XHJcbmV4cG9ydHMubG9nID0gbG9nO1xyXG5leHBvcnRzLkdldFN0YXRlSlNPTiA9IFB1YmxpY0FQSS5HZXRTdGF0ZUpTT047XHJcbmV4cG9ydHMuRXhlY3V0ZUpTT04gPSBQdWJsaWNBUEkuRXhlY3V0ZUpTT047XHJcbmV4cG9ydHMuU2ltcGxlRXhlY3V0ZUpTT04gPSBQdWJsaWNBUEkuU2ltcGxlRXhlY3V0ZUpTT047XHJcblxyXG4iLCIvKlxyXG4gKiBUaGlzIGZpbGUgY29udGFpbnMgdGhlIHB1YmxpYyBBUEkgb2YgdGhlIG1ldGVyLCBpLmUuIHRoZSBmdW5jdGlvbnMgZGVzaWduZWRcclxuICogdG8gYmUgY2FsbGVkIGZyb20gdGhpcmQgcGFydHkgY29kZS5cclxuICogMS0gUGFpcigpIDogYm9vbFxyXG4gKiAyLSBFeGVjdXRlKENvbW1hbmQpIDogYm9vbCArIEpTT04gdmVyc2lvblxyXG4gKiAzLSBTdG9wKCkgOiBib29sXHJcbiAqIDQtIEdldFN0YXRlKCkgOiBhcnJheSArIEpTT04gdmVyc2lvblxyXG4gKiA1LSBTaW1wbGVFeGVjdXRlKENvbW1hbmQpIDogcmV0dXJucyB0aGUgdXBkYXRlZCBtZWFzdXJlbWVudCBvciBudWxsXHJcbiAqL1xyXG5cclxudmFyIENvbW1hbmRSZXN1bHQgPSByZXF1aXJlKCcuL2NsYXNzZXMvQ29tbWFuZFJlc3VsdCcpO1xyXG52YXIgQVBJU3RhdGUgPSByZXF1aXJlKCcuL2NsYXNzZXMvQVBJU3RhdGUnKTtcclxudmFyIGNvbnN0YW50cyA9IHJlcXVpcmUoJy4vY29uc3RhbnRzJyk7XHJcbnZhciBibHVldG9vdGggPSByZXF1aXJlKCcuL2JsdWV0b290aCcpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XHJcbnZhciBsb2cgPSByZXF1aXJlKCdsb2dsZXZlbCcpO1xyXG5cclxudmFyIGJ0U3RhdGUgPSBBUElTdGF0ZS5idFN0YXRlO1xyXG52YXIgU3RhdGUgPSBjb25zdGFudHMuU3RhdGU7XHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGNvcHkgb2YgdGhlIGN1cnJlbnQgc3RhdGVcclxuICogQHJldHVybnMge2FycmF5fSBzdGF0dXMgb2YgbWV0ZXJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEdldFN0YXRlKCkge1xyXG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XHJcbiAgICBsZXQgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcbiAgICBzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuICAgICAgICAvLyBTdGF0ZXMgcmVxdWlyaW5nIHVzZXIgaW5wdXRcclxuICAgICAgICBjYXNlIFN0YXRlLkVSUk9SOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuU1RPUFBFRDpcclxuICAgICAgICBjYXNlIFN0YXRlLk5PVF9DT05ORUNURUQ6XHJcbiAgICAgICAgICAgIHJlYWR5ID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkJVU1k6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5JRExFOlxyXG4gICAgICAgICAgICByZWFkeSA9IHRydWU7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBjYXNlIFN0YXRlLkNPTk5FQ1RJTkc6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5ERVZJQ0VfUEFJUkVEOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVDpcclxuICAgICAgICBjYXNlIFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORzpcclxuICAgICAgICBjYXNlIFN0YXRlLlNVQlNDUklCSU5HOlxyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSB0cnVlO1xyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBicmVhaztcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgICAgICBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgXCJsYXN0U2V0cG9pbnRcIjogYnRTdGF0ZS5sYXN0U2V0cG9pbnQsXHJcbiAgICAgICAgXCJsYXN0TWVhc3VyZVwiOiBidFN0YXRlLmxhc3RNZWFzdXJlLFxyXG4gICAgICAgIFwiZGV2aWNlTmFtZVwiOiBidFN0YXRlLmJ0RGV2aWNlID8gYnRTdGF0ZS5idERldmljZS5uYW1lIDogXCJcIixcclxuICAgICAgICBcImRldmljZVNlcmlhbFwiOiBidFN0YXRlLm1ldGVyPy5zZXJpYWwsXHJcbiAgICAgICAgXCJzdGF0c1wiOiBidFN0YXRlLnN0YXRzLFxyXG4gICAgICAgIFwiZGV2aWNlTW9kZVwiOiBidFN0YXRlLm1ldGVyPy5tb2RlLFxyXG4gICAgICAgIFwic3RhdHVzXCI6IGJ0U3RhdGUuc3RhdGUsXHJcbiAgICAgICAgXCJiYXR0ZXJ5TGV2ZWxcIjogYnRTdGF0ZS5tZXRlcj8uYmF0dGVyeSxcclxuICAgICAgICBcInJlYWR5XCI6IHJlYWR5LFxyXG4gICAgICAgIFwiaW5pdGlhbGl6aW5nXCI6IGluaXRpYWxpemluZ1xyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFByb3ZpZGVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggQmxhem9yXHJcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEpTT04gc3RhdGUgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBHZXRTdGF0ZUpTT04oKSB7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgR2V0U3RhdGUoKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGNvbW1hbmQgd2l0aCBzZXRwb2ludHMsIEpTT04gdmVyc2lvblxyXG4gKiBAcGFyYW0ge3N0cmluZ30ganNvbkNvbW1hbmQgdGhlIGNvbW1hbmQgdG8gZXhlY3V0ZVxyXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBKU09OIGNvbW1hbmQgb2JqZWN0XHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlSlNPTihqc29uQ29tbWFuZCkge1xyXG4gICAgbGV0IGNvbW1hbmQgPSBKU09OLnBhcnNlKGpzb25Db21tYW5kKTtcclxuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBFeGVjdXRlKGNvbW1hbmQpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZUpTT04oanNvbkNvbW1hbmQpIHtcclxuICAgIGxldCBjb21tYW5kID0gSlNPTi5wYXJzZShqc29uQ29tbWFuZCk7XHJcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoYXdhaXQgU2ltcGxlRXhlY3V0ZShjb21tYW5kKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeGVjdXRlIGEgY29tbWFuZCBhbmQgcmV0dXJucyB0aGUgbWVhc3VyZW1lbnQgb3Igc2V0cG9pbnQgd2l0aCBlcnJvciBmbGFnIGFuZCBtZXNzYWdlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZH0gY29tbWFuZFxyXG4gKi9cclxuIGFzeW5jIGZ1bmN0aW9uIFNpbXBsZUV4ZWN1dGUoY29tbWFuZCkge1xyXG4gICAgY29uc3QgU0lNUExFX0VYRUNVVEVfVElNRU9VVF9TID0gNDA7XHJcbiAgICB2YXIgY3IgPSBuZXcgQ29tbWFuZFJlc3VsdCgpO1xyXG5cclxuICAgIGxvZy5pbmZvKFwiU2ltcGxlRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgIT0gbnVsbClcclxuICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSB0cnVlOyAvLyBJbiBjYXNlIGNhbGxlciBkb2VzIG5vdCBzZXQgcGVuZGluZyBmbGFnXHJcblxyXG4gICAgLy8gRmFpbHMgaWYgbm90IHBhaXJlZC5cclxuICAgIGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcbiAgICAgICAgY3IuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgIGNyLm1lc3NhZ2UgPSBcIkRldmljZSBpcyBub3QgcGFpcmVkXCI7XHJcbiAgICAgICAgbG9nLndhcm4oY3IubWVzc2FnZSk7XHJcbiAgICAgICAgcmV0dXJuIGNyO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEFub3RoZXIgY29tbWFuZCBtYXkgYmUgcGVuZGluZy5cclxuICAgIHZhciBkZWxheVMgPSAwO1xyXG4gICAgaWYgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsICYmIGJ0U3RhdGUuY29tbWFuZC5wZW5kaW5nKSB7XHJcbiAgICAgICAgY3IuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgIGNyLm1lc3NhZ2UgPSBcIkFub3RoZXIgY29tbWFuZCBpcyBwZW5kaW5nXCI7XHJcbiAgICAgICAgbG9nLndhcm4oY3IubWVzc2FnZSk7XHJcbiAgICAgICAgcmV0dXJuIGNyO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFdhaXQgZm9yIGNvbXBsZXRpb24gb2YgdGhlIGNvbW1hbmQsIG9yIGhhbHQgb2YgdGhlIHN0YXRlIG1hY2hpbmVcclxuICAgIGJ0U3RhdGUuY29tbWFuZCA9IGNvbW1hbmQ7IFxyXG4gICAgaWYgKGNvbW1hbmQgIT0gbnVsbCkge1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLndhaXRGb3JUaW1lb3V0KCgpID0+ICFjb21tYW5kLnBlbmRpbmcgfHwgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5TVE9QUEVELCBTSU1QTEVfRVhFQ1VURV9USU1FT1VUX1MpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChjb21tYW5kLmVycm9yIHx8IGNvbW1hbmQucGVuZGluZykgIC8vIENoZWNrIGlmIGVycm9yIG9yIHRpbWVvdXRzXHJcbiAgICB7XHJcbiAgICAgICAgY3IuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgIGNyLm1lc3NhZ2UgPSBcIkVycm9yIHdoaWxlIGV4ZWN1dGluZyB0aGUgY29tbWFuZC5cIlxyXG4gICAgICAgIGxvZy53YXJuKGNyLm1lc3NhZ2UpO1xyXG4gICAgICAgIFxyXG4gICAgICAgIC8vIFJlc2V0IHRoZSBhY3RpdmUgY29tbWFuZFxyXG4gICAgICAgIGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcbiAgICAgICAgXHJcbiAgICAgICAgcmV0dXJuIGNyO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFN0YXRlIGlzIHVwZGF0ZWQgYnkgZXhlY3V0ZSBjb21tYW5kXHJcbiAgICBpZiAoaXNHZW5lcmF0aW9uKGNvbW1hbmQudHlwZSkpXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSBidFN0YXRlLmxhc3RTZXRwb2ludFtcIlZhbHVlXCJdO1xyXG4gICAgfVxyXG4gICAgZWxzZSBpZiAoaXNNZWFzdXJlbWVudChjb21tYW5kLnR5cGUpKVxyXG4gICAge1xyXG4gICAgICAgIGNyLnZhbHVlID0gYnRTdGF0ZS5sYXN0TWVhc3VyZVtcIlZhbHVlXCJdO1xyXG4gICAgfVxyXG4gICAgZWxzZVxyXG4gICAge1xyXG4gICAgICAgIGNyLnZhbHVlID0gMC4wOyAvLyBTZXR0aW5ncy5cclxuICAgIH1cclxuICAgIGNyLm1lc3NhZ2UgPSBcIkNvbW1hbmQgZXhlY3V0ZWQgc3VjY2Vzc2Z1bGx5XCI7XHJcbiAgICByZXR1cm4gY3I7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBFeHRlcm5hbCBpbnRlcmZhY2UgdG8gcmVxdWlyZSBhIGNvbW1hbmQgdG8gYmUgZXhlY3V0ZWQuXHJcbiAqIFRoZSBibHVldG9vdGggZGV2aWNlIHBhaXJpbmcgd2luZG93IHdpbGwgb3BlbiBpZiBkZXZpY2UgaXMgbm90IGNvbm5lY3RlZC5cclxuICogVGhpcyBtYXkgZmFpbCBpZiBjYWxsZWQgb3V0c2lkZSBhIHVzZXIgZ2VzdHVyZS5cclxuICogQHBhcmFtIHtDb21tYW5kfSBjb21tYW5kXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBFeGVjdXRlKGNvbW1hbmQpIHtcclxuICAgIGxvZy5pbmZvKFwiRXhlY3V0ZSBjYWxsZWQuLi5cIik7XHJcblxyXG4gICAgaWYgKGNvbW1hbmQgIT0gbnVsbClcclxuICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSB0cnVlO1xyXG5cclxuICAgIHZhciBjcHQgPSAwO1xyXG4gICAgd2hpbGUgKGJ0U3RhdGUuY29tbWFuZCAhPSBudWxsICYmIGJ0U3RhdGUuY29tbWFuZC5wZW5kaW5nICYmIGNwdCA8IDMwKSB7XHJcbiAgICAgICAgbG9nLmRlYnVnKFwiV2FpdGluZyBmb3IgY3VycmVudCBjb21tYW5kIHRvIGNvbXBsZXRlLi4uXCIpO1xyXG4gICAgICAgIGF3YWl0IHV0aWxzLnNsZWVwKDEwMDApO1xyXG4gICAgICAgIGNwdCsrO1xyXG4gICAgfVxyXG4gICAgbG9nLmluZm8oXCJTZXR0aW5nIG5ldyBjb21tYW5kIDpcIiArIGNvbW1hbmQpO1xyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDtcclxuXHJcbiAgICAvLyBTdGFydCB0aGUgcmVndWxhciBzdGF0ZSBtYWNoaW5lXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIGF3YWl0IGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBXYWl0IGZvciBjb21wbGV0aW9uIG9mIHRoZSBjb21tYW5kLCBvciBoYWx0IG9mIHRoZSBzdGF0ZSBtYWNoaW5lXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcbiAgICAgICAgYXdhaXQgdXRpbHMud2FpdEZvcigoKSA9PiAhY29tbWFuZC5wZW5kaW5nIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcbiAgICB9XHJcbiAgICAvLyBSZXR1cm4gdGhlIGNvbW1hbmQgb2JqZWN0IHJlc3VsdFxyXG4gICAgcmV0dXJuIGNvbW1hbmQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNVVNUIEJFIENBTExFRCBGUk9NIEEgVVNFUiBHRVNUVVJFIEVWRU5UIEhBTkRMRVJcclxuICAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIG1ldGVyIGlzIHJlYWR5IHRvIGV4ZWN1dGUgY29tbWFuZFxyXG4gKiAqL1xyXG5hc3luYyBmdW5jdGlvbiBQYWlyKGZvcmNlU2VsZWN0aW9uPWZhbHNlKSB7XHJcbiAgICBsb2cuaW5mbyhcIlBhaXIoXCIrZm9yY2VTZWxlY3Rpb24rXCIpIGNhbGxlZC4uLlwiKTtcclxuICAgIFxyXG4gICAgYnRTdGF0ZS5vcHRpb25zW1wiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIl0gPSBmb3JjZVNlbGVjdGlvbjtcclxuXHJcbiAgICBpZiAoIWJ0U3RhdGUuc3RhcnRlZCkge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIGJsdWV0b290aC5zdGF0ZU1hY2hpbmUoKTsgLy8gU3RhcnQgaXRcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuRVJST1IpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDsgLy8gVHJ5IHRvIHJlc3RhcnRcclxuICAgIH1cclxuICAgIGF3YWl0IHV0aWxzLndhaXRGb3IoKCkgPT4gYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5JRExFIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcbiAgICBsb2cuaW5mbyhcIlBhaXJpbmcgY29tcGxldGVkLCBzdGF0ZSA6XCIsIGJ0U3RhdGUuc3RhdGUpO1xyXG4gICAgcmV0dXJuIChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQpO1xyXG59XHJcblxyXG4vKipcclxuICogU3RvcHMgdGhlIHN0YXRlIG1hY2hpbmUgYW5kIGRpc2Nvbm5lY3RzIGJsdWV0b290aC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gU3RvcCgpIHtcclxuICAgIGxvZy5pbmZvKFwiU3RvcCByZXF1ZXN0IHJlY2VpdmVkXCIpO1xyXG5cclxuICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlO1xyXG4gICAgYXdhaXQgdXRpbHMuc2xlZXAoMTAwKTtcclxuXHJcbiAgICB3aGlsZShidFN0YXRlLnN0YXJ0ZWQgfHwgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCAmJiBidFN0YXRlLnN0YXRlICE9IFN0YXRlLk5PVF9DT05ORUNURUQpKVxyXG4gICAge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlOyAgICBcclxuICAgICAgICBhd2FpdCB1dGlscy5zbGVlcCgxMDApO1xyXG4gICAgfVxyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSBmYWxzZTtcclxuICAgIGxvZy53YXJuKFwiU3RvcHBlZCBvbiByZXF1ZXN0LlwiKTtcclxuICAgIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHtTdG9wLFBhaXIsRXhlY3V0ZSxFeGVjdXRlSlNPTixTaW1wbGVFeGVjdXRlLFNpbXBsZUV4ZWN1dGVKU09OLEdldFN0YXRlLEdldFN0YXRlSlNPTn0iLCIndXNlIHN0cmljdCc7XHJcblxyXG4vKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiogTU9EQlVTIFJUVSBoYW5kbGluZyAqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKi9cclxuXHJcbnZhciBsb2cgPSByZXF1aXJlKCdsb2dsZXZlbCcpO1xyXG5cclxuY29uc3QgU0VORUNBX01CX1NMQVZFX0lEID0gMjU7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbmNsYXNzIE1vZGJ1c0Vycm9yIGV4dGVuZHMgRXJyb3Ige1xyXG4gICAgLyoqXHJcbiAgICAgKiBDcmVhdGVzIGEgbmV3IG1vZGJ1cyBlcnJvclxyXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IG1lc3NhZ2UgbWVzc2FnZVxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IGZjIGZ1bmN0aW9uIGNvZGVcclxuICAgICAqL1xyXG4gICAgY29udHJ1Y3RvcihtZXNzYWdlLCBmYykge1xyXG4gICAgICAgIHRoaXMubWVzc2FnZSA9IG1lc3NhZ2U7XHJcbiAgICAgICAgdGhpcy5mYyA9IGZjO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgNCBieXRlcyBDUkMgY29kZSBmcm9tIHRoZSBidWZmZXIgY29udGVudHNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBjcmMxNihidWZmZXIpIHtcclxuICAgIHZhciBjcmMgPSAweEZGRkY7XHJcbiAgICB2YXIgb2RkO1xyXG5cclxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgY3JjID0gY3JjIF4gYnVmZmVyW2ldO1xyXG5cclxuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IDg7IGorKykge1xyXG4gICAgICAgICAgICBvZGQgPSBjcmMgJiAweDAwMDE7XHJcbiAgICAgICAgICAgIGNyYyA9IGNyYyA+PiAxO1xyXG4gICAgICAgICAgICBpZiAob2RkKSB7XHJcbiAgICAgICAgICAgICAgICBjcmMgPSBjcmMgXiAweEEwMDE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGNyYztcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ha2UgYSBNb2RidXMgUmVhZCBIb2xkaW5nIFJlZ2lzdGVycyAoRkM9MDMpIHRvIHNlcmlhbCBwb3J0XHJcbiAqIFxyXG4gKiBAcGFyYW0ge251bWJlcn0gSUQgc2xhdmUgSURcclxuICogQHBhcmFtIHtudW1iZXJ9IGNvdW50IG51bWJlciBvZiByZWdpc3RlcnMgdG8gcmVhZFxyXG4gKiBAcGFyYW0ge251bWJlcn0gcmVnaXN0ZXIgc3RhcnRpbmcgcmVnaXN0ZXJcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VGQzMoSUQsIGNvdW50LCByZWdpc3Rlcikge1xyXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKDgpO1xyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhidWZmZXIpO1xyXG4gICAgdmlldy5zZXRVaW50OCgwLCBJRCk7XHJcbiAgICB2aWV3LnNldFVpbnQ4KDEsIDMpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoMiwgcmVnaXN0ZXIsIGZhbHNlKTtcclxuICAgIHZpZXcuc2V0VWludDE2KDQsIGNvdW50LCBmYWxzZSk7XHJcbiAgICB2YXIgY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkoYnVmZmVyLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoNiwgY3JjLCB0cnVlKTtcclxuICAgIHJldHVybiBidWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXcml0ZSBhIE1vZGJ1cyBcIlByZXNldCBNdWx0aXBsZSBSZWdpc3RlcnNcIiAoRkM9MTYpIHRvIHNlcmlhbCBwb3J0LlxyXG4gKlxyXG4gKiBAcGFyYW0ge251bWJlcn0gYWRkcmVzcyB0aGUgc2xhdmUgdW5pdCBhZGRyZXNzLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gZGF0YUFkZHJlc3MgdGhlIERhdGEgQWRkcmVzcyBvZiB0aGUgZmlyc3QgcmVnaXN0ZXIuXHJcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IHRoZSBhcnJheSBvZiB2YWx1ZXMgdG8gd3JpdGUgdG8gcmVnaXN0ZXJzLlxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMTYoYWRkcmVzcywgZGF0YUFkZHJlc3MsIGFycmF5KSB7XHJcbiAgICBjb25zdCBjb2RlID0gMTY7XHJcblxyXG4gICAgLy8gc2FuaXR5IGNoZWNrXHJcbiAgICBpZiAodHlwZW9mIGFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIgfHwgdHlwZW9mIGRhdGFBZGRyZXNzID09PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGxldCBkYXRhTGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xyXG5cclxuICAgIGNvbnN0IGNvZGVMZW5ndGggPSA3ICsgMiAqIGRhdGFMZW5ndGg7XHJcbiAgICBjb25zdCBidWYgPSBuZXcgQXJyYXlCdWZmZXIoY29kZUxlbmd0aCArIDIpOyAvLyBhZGQgMiBjcmMgYnl0ZXNcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1Zik7XHJcblxyXG4gICAgZHYuc2V0VWludDgoMCwgYWRkcmVzcyk7XHJcbiAgICBkdi5zZXRVaW50OCgxLCBjb2RlKTtcclxuICAgIGR2LnNldFVpbnQxNigyLCBkYXRhQWRkcmVzcywgZmFsc2UpO1xyXG4gICAgZHYuc2V0VWludDE2KDQsIGRhdGFMZW5ndGgsIGZhbHNlKTtcclxuICAgIGR2LnNldFVpbnQ4KDYsIGRhdGFMZW5ndGggKiAyKTtcclxuXHJcbiAgICAvLyBjb3B5IGNvbnRlbnQgb2YgYXJyYXkgdG8gYnVmXHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGFMZW5ndGg7IGkrKykge1xyXG4gICAgICAgIGR2LnNldFVpbnQxNig3ICsgMiAqIGksIGFycmF5W2ldLCBmYWxzZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gYWRkIGNyYyBieXRlcyB0byBidWZmZXJcclxuICAgIGR2LnNldFVpbnQxNihjb2RlTGVuZ3RoLCBjcmMxNihidWYuc2xpY2UoMCwgLTIpKSwgdHJ1ZSk7XHJcbiAgICByZXR1cm4gYnVmO1xyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgcmVnaXN0ZXJzIHZhbHVlcyBmcm9tIGEgRkMwMyBhbnN3ZXIgYnkgUlRVIHNsYXZlXHJcbiAqIFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzMocmVzcG9uc2UpIHtcclxuICAgIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHJlc3BvbnNlKTtcclxuICAgIHZhciBjb250ZW50cyA9IFtdO1xyXG5cclxuICAgIC8vIEludmFsaWQgbW9kYnVzIHBhY2tldFxyXG4gICAgaWYgKHJlc3BvbnNlLmxlbmd0aCA8IDUpXHJcbiAgICAgICAgcmV0dXJuO1xyXG5cclxuICAgIHZhciBjb21wdXRlZF9jcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShyZXNwb25zZS5zbGljZSgwLCAtMikpKTtcclxuICAgIHZhciBhY3R1YWxfY3JjID0gdmlldy5nZXRVaW50MTYodmlldy5ieXRlTGVuZ3RoIC0gMiwgdHJ1ZSk7XHJcblxyXG4gICAgaWYgKGNvbXB1dGVkX2NyYyAhPSBhY3R1YWxfY3JjKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgQ1JDXCIsIDMpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50OCgwKTtcclxuICAgIGlmIChhZGRyZXNzICE9IFNFTkVDQV9NQl9TTEFWRV9JRCkge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIHNsYXZlIElEIDpcIiArIGFkZHJlc3MsIDMpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcbiAgICBpZiAoZmMgPiAxMjgpIHtcclxuICAgICAgICB2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gYnkgc2xhdmU6XCIgKyBleHAsIDMpO1xyXG4gICAgfVxyXG4gICAgaWYgKGZjICE9IDMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIExlbmd0aCBpbiBieXRlcyBmcm9tIHNsYXZlIGFuc3dlclxyXG4gICAgdmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDgoMik7XHJcblxyXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKGxlbmd0aCk7XHJcbiAgICBjb25zdCByZWdpc3RlcnMgPSBuZXcgRGF0YVZpZXcoYnVmZmVyKTtcclxuXHJcbiAgICBmb3IgKHZhciBpID0gMzsgaSA8IHZpZXcuYnl0ZUxlbmd0aCAtIDI7IGkgKz0gMikge1xyXG4gICAgICAgIHZhciByZWcgPSB2aWV3LmdldEludDE2KGksIGZhbHNlKTtcclxuICAgICAgICByZWdpc3RlcnMuc2V0SW50MTYoaSAtIDMsIHJlZywgZmFsc2UpO1xyXG4gICAgICAgIHZhciBpZHggPSAoKGkgLSAzKSAvIDIgKyAxKTtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWdpc3RlciBcIiArIGlkeCArIFwiL1wiICsgKGxlbmd0aCAvIDIpICsgXCIgPSBcIiArIHJlZyk7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHJlZ2lzdGVycztcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIGlmIHRoZSBGQzE2IHJlc3BvbnNlIGlzIGNvcnJlY3QgKENSQywgcmV0dXJuIGNvZGUpIEFORCBvcHRpb25hbGx5IG1hdGNoaW5nIHRoZSByZWdpc3RlciBsZW5ndGggZXhwZWN0ZWRcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2UgbW9kYnVzIHJ0dSByYXcgb3V0cHV0XHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBleHBlY3RlZCBudW1iZXIgb2YgZXhwZWN0ZWQgd3JpdHRlbiByZWdpc3RlcnMgZnJvbSBzbGF2ZS4gSWYgPD0wLCBpdCB3aWxsIG5vdCBiZSBjaGVja2VkLlxyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiBhbGwgcmVnaXN0ZXJzIGhhdmUgYmVlbiB3cml0dGVuXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCBleHBlY3RlZCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBwYXJzZUZDMTYocmVzcG9uc2UpO1xyXG4gICAgICAgIHJldHVybiAoZXhwZWN0ZWQgPD0gMCB8fCByZXN1bHRbMV0gPT09IGV4cGVjdGVkKTsgLy8gY2hlY2sgaWYgbGVuZ3RoIGlzIG1hdGNoaW5nXHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLmVycm9yKFwiRkMxNiBhbnN3ZXIgZXJyb3JcIiwgZXJyKTtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgYW5zd2VyIHRvIHRoZSB3cml0ZSBtdWx0aXBsZSByZWdpc3RlcnMgZnJvbSB0aGUgc2xhdmVcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMxNihyZXNwb25zZSkge1xyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhyZXNwb25zZSk7XHJcbiAgICB2YXIgY29udGVudHMgPSBbXTtcclxuXHJcbiAgICBpZiAocmVzcG9uc2UubGVuZ3RoIDwgMylcclxuICAgICAgICByZXR1cm47XHJcblxyXG4gICAgdmFyIHNsYXZlID0gdmlldy5nZXRVaW50OCgwKTtcclxuXHJcbiAgICBpZiAoc2xhdmUgIT0gU0VORUNBX01CX1NMQVZFX0lEKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcbiAgICBpZiAoZmMgPiAxMjgpIHtcclxuICAgICAgICB2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gOlwiICsgZXhwLCAxNik7XHJcbiAgICB9XHJcbiAgICBpZiAoZmMgIT0gMTYpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG4gICAgfVxyXG4gICAgdmFyIGNvbXB1dGVkX2NyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KHJlc3BvbnNlLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmFyIGFjdHVhbF9jcmMgPSB2aWV3LmdldFVpbnQxNih2aWV3LmJ5dGVMZW5ndGggLSAyLCB0cnVlKTtcclxuXHJcbiAgICBpZiAoY29tcHV0ZWRfY3JjICE9IGFjdHVhbF9jcmMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBDUkNcIiwgMTYpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG4gICAgdmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDE2KDQsIGZhbHNlKTtcclxuICAgIHJldHVybiBbYWRkcmVzcywgbGVuZ3RoXTtcclxufVxyXG5cclxuXHJcblxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IGZsb2F0XHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRGbG9hdDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0KSB7XHJcbiAgICBjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcbiAgICBkdi5zZXRJbnQxNigwLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQgKyAyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGR2LnNldEludDE2KDIsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICByZXR1cm4gZHYuZ2V0RmxvYXQzMigwLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBVaW50MzJcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBjb252ZXJ0ZWQgdmFsdWVcclxuICovXHJcbmZ1bmN0aW9uIGdldFVpbnQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0SW50MTYoMCwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0ICsgMiwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICBkdi5zZXRJbnQxNigyLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgcmV0dXJuIGR2LmdldFVpbnQzMigwLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiAtPiBmbG9hdFxyXG4gKiBAcGFyYW0ge0RhdGFWaWV3fSBkYXRhVmlldyBidWZmZXIgdmlldyB0byBwcm9jZXNzXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBvZmZzZXQgYnl0ZSBudW1iZXIgd2hlcmUgZmxvYXQgaW50byB0aGUgYnVmZmVyXHJcbiAqIEBwYXJhbSB7dmFsdWV9IG51bWJlciB2YWx1ZSB0byBzZXRcclxuICovXHJcbmZ1bmN0aW9uIHNldEZsb2F0MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQsIHZhbHVlKSB7XHJcbiAgICBjb25zdCBidWZmID0gbmV3IEFycmF5QnVmZmVyKDQpO1xyXG4gICAgY29uc3QgZHYgPSBuZXcgRGF0YVZpZXcoYnVmZik7XHJcbiAgICBkdi5zZXRGbG9hdDMyKDAsIHZhbHVlLCBmYWxzZSk7XHJcbiAgICBkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQsIGR2LmdldEludDE2KDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0ICsgMiwgZHYuZ2V0SW50MTYoMCwgZmFsc2UpLCBmYWxzZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDb252ZXJ0cyB3aXRoIGJ5dGUgc3dhcCBBQiBDRCAtPiBDRCBBQiBcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIHVpbnQzMiBpbnRvIHRoZSBidWZmZXJcclxuICogQHBhcmFtIHtudW1iZXJ9IHZhbHVlIHZhbHVlIHRvIHNldFxyXG4gKi9cclxuZnVuY3Rpb24gc2V0VWludDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0LCB2YWx1ZSkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0VWludDMyKDAsIHZhbHVlLCBmYWxzZSk7XHJcbiAgICBkYXRhVmlldy5zZXRJbnQxNihvZmZzZXQsIGR2LmdldEludDE2KDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0ICsgMiwgZHYuZ2V0SW50MTYoMCwgZmFsc2UpLCBmYWxzZSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBtYWtlRkMzLCBnZXRGbG9hdDMyTEVCUywgbWFrZUZDMTYsIHNldEZsb2F0MzJMRUJTLCBzZXRVaW50MzJMRUJTLCBwYXJzZUZDMywgcGFyc2VGQzE2LCBwYXJzZUZDMTZjaGVja2VkLCBNb2RidXNFcnJvciwgU0VORUNBX01CX1NMQVZFX0lELCBnZXRVaW50MzJMRUJTIH0iLCIvKlxuKiBsb2dsZXZlbCAtIGh0dHBzOi8vZ2l0aHViLmNvbS9waW10ZXJyeS9sb2dsZXZlbFxuKlxuKiBDb3B5cmlnaHQgKGMpIDIwMTMgVGltIFBlcnJ5XG4qIExpY2Vuc2VkIHVuZGVyIHRoZSBNSVQgbGljZW5zZS5cbiovXG4oZnVuY3Rpb24gKHJvb3QsIGRlZmluaXRpb24pIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICBpZiAodHlwZW9mIGRlZmluZSA9PT0gJ2Z1bmN0aW9uJyAmJiBkZWZpbmUuYW1kKSB7XG4gICAgICAgIGRlZmluZShkZWZpbml0aW9uKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnICYmIG1vZHVsZS5leHBvcnRzKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gZGVmaW5pdGlvbigpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJvb3QubG9nID0gZGVmaW5pdGlvbigpO1xuICAgIH1cbn0odGhpcywgZnVuY3Rpb24gKCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuXG4gICAgLy8gU2xpZ2h0bHkgZHViaW91cyB0cmlja3MgdG8gY3V0IGRvd24gbWluaW1pemVkIGZpbGUgc2l6ZVxuICAgIHZhciBub29wID0gZnVuY3Rpb24oKSB7fTtcbiAgICB2YXIgdW5kZWZpbmVkVHlwZSA9IFwidW5kZWZpbmVkXCI7XG4gICAgdmFyIGlzSUUgPSAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSkgJiYgKHR5cGVvZiB3aW5kb3cubmF2aWdhdG9yICE9PSB1bmRlZmluZWRUeXBlKSAmJiAoXG4gICAgICAgIC9UcmlkZW50XFwvfE1TSUUgLy50ZXN0KHdpbmRvdy5uYXZpZ2F0b3IudXNlckFnZW50KVxuICAgICk7XG5cbiAgICB2YXIgbG9nTWV0aG9kcyA9IFtcbiAgICAgICAgXCJ0cmFjZVwiLFxuICAgICAgICBcImRlYnVnXCIsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgICBcIndhcm5cIixcbiAgICAgICAgXCJlcnJvclwiXG4gICAgXTtcblxuICAgIC8vIENyb3NzLWJyb3dzZXIgYmluZCBlcXVpdmFsZW50IHRoYXQgd29ya3MgYXQgbGVhc3QgYmFjayB0byBJRTZcbiAgICBmdW5jdGlvbiBiaW5kTWV0aG9kKG9iaiwgbWV0aG9kTmFtZSkge1xuICAgICAgICB2YXIgbWV0aG9kID0gb2JqW21ldGhvZE5hbWVdO1xuICAgICAgICBpZiAodHlwZW9mIG1ldGhvZC5iaW5kID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gbWV0aG9kLmJpbmQob2JqKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIEZ1bmN0aW9uLnByb3RvdHlwZS5iaW5kLmNhbGwobWV0aG9kLCBvYmopO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgIC8vIE1pc3NpbmcgYmluZCBzaGltIG9yIElFOCArIE1vZGVybml6ciwgZmFsbGJhY2sgdG8gd3JhcHBpbmdcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBGdW5jdGlvbi5wcm90b3R5cGUuYXBwbHkuYXBwbHkobWV0aG9kLCBbb2JqLCBhcmd1bWVudHNdKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVHJhY2UoKSBkb2Vzbid0IHByaW50IHRoZSBtZXNzYWdlIGluIElFLCBzbyBmb3IgdGhhdCBjYXNlIHdlIG5lZWQgdG8gd3JhcCBpdFxuICAgIGZ1bmN0aW9uIHRyYWNlRm9ySUUoKSB7XG4gICAgICAgIGlmIChjb25zb2xlLmxvZykge1xuICAgICAgICAgICAgaWYgKGNvbnNvbGUubG9nLmFwcGx5KSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2cuYXBwbHkoY29uc29sZSwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gSW4gb2xkIElFLCBuYXRpdmUgY29uc29sZSBtZXRob2RzIHRoZW1zZWx2ZXMgZG9uJ3QgaGF2ZSBhcHBseSgpLlxuICAgICAgICAgICAgICAgIEZ1bmN0aW9uLnByb3RvdHlwZS5hcHBseS5hcHBseShjb25zb2xlLmxvZywgW2NvbnNvbGUsIGFyZ3VtZW50c10pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChjb25zb2xlLnRyYWNlKSBjb25zb2xlLnRyYWNlKCk7XG4gICAgfVxuXG4gICAgLy8gQnVpbGQgdGhlIGJlc3QgbG9nZ2luZyBtZXRob2QgcG9zc2libGUgZm9yIHRoaXMgZW52XG4gICAgLy8gV2hlcmV2ZXIgcG9zc2libGUgd2Ugd2FudCB0byBiaW5kLCBub3Qgd3JhcCwgdG8gcHJlc2VydmUgc3RhY2sgdHJhY2VzXG4gICAgZnVuY3Rpb24gcmVhbE1ldGhvZChtZXRob2ROYW1lKSB7XG4gICAgICAgIGlmIChtZXRob2ROYW1lID09PSAnZGVidWcnKSB7XG4gICAgICAgICAgICBtZXRob2ROYW1lID0gJ2xvZyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgPT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTsgLy8gTm8gbWV0aG9kIHBvc3NpYmxlLCBmb3Igbm93IC0gZml4ZWQgbGF0ZXIgYnkgZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlc1xuICAgICAgICB9IGVsc2UgaWYgKG1ldGhvZE5hbWUgPT09ICd0cmFjZScgJiYgaXNJRSkge1xuICAgICAgICAgICAgcmV0dXJuIHRyYWNlRm9ySUU7XG4gICAgICAgIH0gZWxzZSBpZiAoY29uc29sZVttZXRob2ROYW1lXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gYmluZE1ldGhvZChjb25zb2xlLCBtZXRob2ROYW1lKTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25zb2xlLmxvZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gYmluZE1ldGhvZChjb25zb2xlLCAnbG9nJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gbm9vcDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRoZXNlIHByaXZhdGUgZnVuY3Rpb25zIGFsd2F5cyBuZWVkIGB0aGlzYCB0byBiZSBzZXQgcHJvcGVybHlcblxuICAgIGZ1bmN0aW9uIHJlcGxhY2VMb2dnaW5nTWV0aG9kcyhsZXZlbCwgbG9nZ2VyTmFtZSkge1xuICAgICAgICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxvZ01ldGhvZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIHZhciBtZXRob2ROYW1lID0gbG9nTWV0aG9kc1tpXTtcbiAgICAgICAgICAgIHRoaXNbbWV0aG9kTmFtZV0gPSAoaSA8IGxldmVsKSA/XG4gICAgICAgICAgICAgICAgbm9vcCA6XG4gICAgICAgICAgICAgICAgdGhpcy5tZXRob2RGYWN0b3J5KG1ldGhvZE5hbWUsIGxldmVsLCBsb2dnZXJOYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIERlZmluZSBsb2cubG9nIGFzIGFuIGFsaWFzIGZvciBsb2cuZGVidWdcbiAgICAgICAgdGhpcy5sb2cgPSB0aGlzLmRlYnVnO1xuICAgIH1cblxuICAgIC8vIEluIG9sZCBJRSB2ZXJzaW9ucywgdGhlIGNvbnNvbGUgaXNuJ3QgcHJlc2VudCB1bnRpbCB5b3UgZmlyc3Qgb3BlbiBpdC5cbiAgICAvLyBXZSBidWlsZCByZWFsTWV0aG9kKCkgcmVwbGFjZW1lbnRzIGhlcmUgdGhhdCByZWdlbmVyYXRlIGxvZ2dpbmcgbWV0aG9kc1xuICAgIGZ1bmN0aW9uIGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXMobWV0aG9kTmFtZSwgbGV2ZWwsIGxvZ2dlck5hbWUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgICAgIHJlcGxhY2VMb2dnaW5nTWV0aG9kcy5jYWxsKHRoaXMsIGxldmVsLCBsb2dnZXJOYW1lKTtcbiAgICAgICAgICAgICAgICB0aGlzW21ldGhvZE5hbWVdLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gQnkgZGVmYXVsdCwgd2UgdXNlIGNsb3NlbHkgYm91bmQgcmVhbCBtZXRob2RzIHdoZXJldmVyIHBvc3NpYmxlLCBhbmRcbiAgICAvLyBvdGhlcndpc2Ugd2Ugd2FpdCBmb3IgYSBjb25zb2xlIHRvIGFwcGVhciwgYW5kIHRoZW4gdHJ5IGFnYWluLlxuICAgIGZ1bmN0aW9uIGRlZmF1bHRNZXRob2RGYWN0b3J5KG1ldGhvZE5hbWUsIGxldmVsLCBsb2dnZXJOYW1lKSB7XG4gICAgICAgIC8qanNoaW50IHZhbGlkdGhpczp0cnVlICovXG4gICAgICAgIHJldHVybiByZWFsTWV0aG9kKG1ldGhvZE5hbWUpIHx8XG4gICAgICAgICAgICAgICBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gTG9nZ2VyKG5hbWUsIGRlZmF1bHRMZXZlbCwgZmFjdG9yeSkge1xuICAgICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgICAgdmFyIGN1cnJlbnRMZXZlbDtcbiAgICAgIGRlZmF1bHRMZXZlbCA9IGRlZmF1bHRMZXZlbCA9PSBudWxsID8gXCJXQVJOXCIgOiBkZWZhdWx0TGV2ZWw7XG5cbiAgICAgIHZhciBzdG9yYWdlS2V5ID0gXCJsb2dsZXZlbFwiO1xuICAgICAgaWYgKHR5cGVvZiBuYW1lID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHN0b3JhZ2VLZXkgKz0gXCI6XCIgKyBuYW1lO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgbmFtZSA9PT0gXCJzeW1ib2xcIikge1xuICAgICAgICBzdG9yYWdlS2V5ID0gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBwZXJzaXN0TGV2ZWxJZlBvc3NpYmxlKGxldmVsTnVtKSB7XG4gICAgICAgICAgdmFyIGxldmVsTmFtZSA9IChsb2dNZXRob2RzW2xldmVsTnVtXSB8fCAnc2lsZW50JykudG9VcHBlckNhc2UoKTtcblxuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICAvLyBVc2UgbG9jYWxTdG9yYWdlIGlmIGF2YWlsYWJsZVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2Vbc3RvcmFnZUtleV0gPSBsZXZlbE5hbWU7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBVc2Ugc2Vzc2lvbiBjb29raWUgYXMgZmFsbGJhY2tcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICB3aW5kb3cuZG9jdW1lbnQuY29va2llID1cbiAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj1cIiArIGxldmVsTmFtZSArIFwiO1wiO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgIH1cblxuICAgICAgZnVuY3Rpb24gZ2V0UGVyc2lzdGVkTGV2ZWwoKSB7XG4gICAgICAgICAgdmFyIHN0b3JlZExldmVsO1xuXG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHN0b3JlZExldmVsID0gd2luZG93LmxvY2FsU3RvcmFnZVtzdG9yYWdlS2V5XTtcbiAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG5cbiAgICAgICAgICAvLyBGYWxsYmFjayB0byBjb29raWVzIGlmIGxvY2FsIHN0b3JhZ2UgZ2l2ZXMgdXMgbm90aGluZ1xuICAgICAgICAgIGlmICh0eXBlb2Ygc3RvcmVkTGV2ZWwgPT09IHVuZGVmaW5lZFR5cGUpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgIHZhciBjb29raWUgPSB3aW5kb3cuZG9jdW1lbnQuY29va2llO1xuICAgICAgICAgICAgICAgICAgdmFyIGxvY2F0aW9uID0gY29va2llLmluZGV4T2YoXG4gICAgICAgICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9XCIpO1xuICAgICAgICAgICAgICAgICAgaWYgKGxvY2F0aW9uICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgIHN0b3JlZExldmVsID0gL14oW147XSspLy5leGVjKGNvb2tpZS5zbGljZShsb2NhdGlvbikpWzFdO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGNhdGNoIChpZ25vcmUpIHt9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSWYgdGhlIHN0b3JlZCBsZXZlbCBpcyBub3QgdmFsaWQsIHRyZWF0IGl0IGFzIGlmIG5vdGhpbmcgd2FzIHN0b3JlZC5cbiAgICAgICAgICBpZiAoc2VsZi5sZXZlbHNbc3RvcmVkTGV2ZWxdID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgc3RvcmVkTGV2ZWwgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHN0b3JlZExldmVsO1xuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBjbGVhclBlcnNpc3RlZExldmVsKCkge1xuICAgICAgICAgIGlmICh0eXBlb2Ygd2luZG93ID09PSB1bmRlZmluZWRUeXBlIHx8ICFzdG9yYWdlS2V5KSByZXR1cm47XG5cbiAgICAgICAgICAvLyBVc2UgbG9jYWxTdG9yYWdlIGlmIGF2YWlsYWJsZVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5sb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShzdG9yYWdlS2V5KTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIFVzZSBzZXNzaW9uIGNvb2tpZSBhcyBmYWxsYmFja1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5kb2N1bWVudC5jb29raWUgPVxuICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPTsgZXhwaXJlcz1UaHUsIDAxIEphbiAxOTcwIDAwOjAwOjAwIFVUQ1wiO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgIH1cblxuICAgICAgLypcbiAgICAgICAqXG4gICAgICAgKiBQdWJsaWMgbG9nZ2VyIEFQSSAtIHNlZSBodHRwczovL2dpdGh1Yi5jb20vcGltdGVycnkvbG9nbGV2ZWwgZm9yIGRldGFpbHNcbiAgICAgICAqXG4gICAgICAgKi9cblxuICAgICAgc2VsZi5uYW1lID0gbmFtZTtcblxuICAgICAgc2VsZi5sZXZlbHMgPSB7IFwiVFJBQ0VcIjogMCwgXCJERUJVR1wiOiAxLCBcIklORk9cIjogMiwgXCJXQVJOXCI6IDMsXG4gICAgICAgICAgXCJFUlJPUlwiOiA0LCBcIlNJTEVOVFwiOiA1fTtcblxuICAgICAgc2VsZi5tZXRob2RGYWN0b3J5ID0gZmFjdG9yeSB8fCBkZWZhdWx0TWV0aG9kRmFjdG9yeTtcblxuICAgICAgc2VsZi5nZXRMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICByZXR1cm4gY3VycmVudExldmVsO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5zZXRMZXZlbCA9IGZ1bmN0aW9uIChsZXZlbCwgcGVyc2lzdCkge1xuICAgICAgICAgIGlmICh0eXBlb2YgbGV2ZWwgPT09IFwic3RyaW5nXCIgJiYgc2VsZi5sZXZlbHNbbGV2ZWwudG9VcHBlckNhc2UoKV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBsZXZlbCA9IHNlbGYubGV2ZWxzW2xldmVsLnRvVXBwZXJDYXNlKCldO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHlwZW9mIGxldmVsID09PSBcIm51bWJlclwiICYmIGxldmVsID49IDAgJiYgbGV2ZWwgPD0gc2VsZi5sZXZlbHMuU0lMRU5UKSB7XG4gICAgICAgICAgICAgIGN1cnJlbnRMZXZlbCA9IGxldmVsO1xuICAgICAgICAgICAgICBpZiAocGVyc2lzdCAhPT0gZmFsc2UpIHsgIC8vIGRlZmF1bHRzIHRvIHRydWVcbiAgICAgICAgICAgICAgICAgIHBlcnNpc3RMZXZlbElmUG9zc2libGUobGV2ZWwpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJlcGxhY2VMb2dnaW5nTWV0aG9kcy5jYWxsKHNlbGYsIGxldmVsLCBuYW1lKTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlID09PSB1bmRlZmluZWRUeXBlICYmIGxldmVsIDwgc2VsZi5sZXZlbHMuU0lMRU5UKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gXCJObyBjb25zb2xlIGF2YWlsYWJsZSBmb3IgbG9nZ2luZ1wiO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgXCJsb2cuc2V0TGV2ZWwoKSBjYWxsZWQgd2l0aCBpbnZhbGlkIGxldmVsOiBcIiArIGxldmVsO1xuICAgICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHNlbGYuc2V0RGVmYXVsdExldmVsID0gZnVuY3Rpb24gKGxldmVsKSB7XG4gICAgICAgICAgZGVmYXVsdExldmVsID0gbGV2ZWw7XG4gICAgICAgICAgaWYgKCFnZXRQZXJzaXN0ZWRMZXZlbCgpKSB7XG4gICAgICAgICAgICAgIHNlbGYuc2V0TGV2ZWwobGV2ZWwsIGZhbHNlKTtcbiAgICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnJlc2V0TGV2ZWwgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgc2VsZi5zZXRMZXZlbChkZWZhdWx0TGV2ZWwsIGZhbHNlKTtcbiAgICAgICAgICBjbGVhclBlcnNpc3RlZExldmVsKCk7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLmVuYWJsZUFsbCA9IGZ1bmN0aW9uKHBlcnNpc3QpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKHNlbGYubGV2ZWxzLlRSQUNFLCBwZXJzaXN0KTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuZGlzYWJsZUFsbCA9IGZ1bmN0aW9uKHBlcnNpc3QpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKHNlbGYubGV2ZWxzLlNJTEVOVCwgcGVyc2lzdCk7XG4gICAgICB9O1xuXG4gICAgICAvLyBJbml0aWFsaXplIHdpdGggdGhlIHJpZ2h0IGxldmVsXG4gICAgICB2YXIgaW5pdGlhbExldmVsID0gZ2V0UGVyc2lzdGVkTGV2ZWwoKTtcbiAgICAgIGlmIChpbml0aWFsTGV2ZWwgPT0gbnVsbCkge1xuICAgICAgICAgIGluaXRpYWxMZXZlbCA9IGRlZmF1bHRMZXZlbDtcbiAgICAgIH1cbiAgICAgIHNlbGYuc2V0TGV2ZWwoaW5pdGlhbExldmVsLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLypcbiAgICAgKlxuICAgICAqIFRvcC1sZXZlbCBBUElcbiAgICAgKlxuICAgICAqL1xuXG4gICAgdmFyIGRlZmF1bHRMb2dnZXIgPSBuZXcgTG9nZ2VyKCk7XG5cbiAgICB2YXIgX2xvZ2dlcnNCeU5hbWUgPSB7fTtcbiAgICBkZWZhdWx0TG9nZ2VyLmdldExvZ2dlciA9IGZ1bmN0aW9uIGdldExvZ2dlcihuYW1lKSB7XG4gICAgICAgIGlmICgodHlwZW9mIG5hbWUgIT09IFwic3ltYm9sXCIgJiYgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIpIHx8IG5hbWUgPT09IFwiXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiWW91IG11c3Qgc3VwcGx5IGEgbmFtZSB3aGVuIGNyZWF0aW5nIGEgbG9nZ2VyLlwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBsb2dnZXIgPSBfbG9nZ2Vyc0J5TmFtZVtuYW1lXTtcbiAgICAgICAgaWYgKCFsb2dnZXIpIHtcbiAgICAgICAgICBsb2dnZXIgPSBfbG9nZ2Vyc0J5TmFtZVtuYW1lXSA9IG5ldyBMb2dnZXIoXG4gICAgICAgICAgICBuYW1lLCBkZWZhdWx0TG9nZ2VyLmdldExldmVsKCksIGRlZmF1bHRMb2dnZXIubWV0aG9kRmFjdG9yeSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxvZ2dlcjtcbiAgICB9O1xuXG4gICAgLy8gR3JhYiB0aGUgY3VycmVudCBnbG9iYWwgbG9nIHZhcmlhYmxlIGluIGNhc2Ugb2Ygb3ZlcndyaXRlXG4gICAgdmFyIF9sb2cgPSAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSkgPyB3aW5kb3cubG9nIDogdW5kZWZpbmVkO1xuICAgIGRlZmF1bHRMb2dnZXIubm9Db25mbGljdCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyAhPT0gdW5kZWZpbmVkVHlwZSAmJlxuICAgICAgICAgICAgICAgd2luZG93LmxvZyA9PT0gZGVmYXVsdExvZ2dlcikge1xuICAgICAgICAgICAgd2luZG93LmxvZyA9IF9sb2c7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZGVmYXVsdExvZ2dlcjtcbiAgICB9O1xuXG4gICAgZGVmYXVsdExvZ2dlci5nZXRMb2dnZXJzID0gZnVuY3Rpb24gZ2V0TG9nZ2VycygpIHtcbiAgICAgICAgcmV0dXJuIF9sb2dnZXJzQnlOYW1lO1xuICAgIH07XG5cbiAgICAvLyBFUzYgZGVmYXVsdCBleHBvcnQsIGZvciBjb21wYXRpYmlsaXR5XG4gICAgZGVmYXVsdExvZ2dlclsnZGVmYXVsdCddID0gZGVmYXVsdExvZ2dlcjtcblxuICAgIHJldHVybiBkZWZhdWx0TG9nZ2VyO1xufSkpO1xuIiwiJ3VzZSBzdHJpY3QnO1xyXG5cclxuLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiogTU9EQlVTIFJUVSBGVU5DVElPTlMgRk9SIFNFTkVDQSAqKioqKioqKioqKioqKioqKioqKioqL1xyXG5cclxudmFyIG1vZGJ1cyA9IHJlcXVpcmUoJy4vbW9kYnVzUnR1Jyk7XHJcbnZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgdXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XHJcblxyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcbmNvbnN0IFNFTkVDQV9NQl9TTEFWRV9JRCA9IG1vZGJ1cy5TRU5FQ0FfTUJfU0xBVkVfSUQ7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbi8qXHJcbiAqIE1vZGJ1cyByZWdpc3RlcnMgbWFwLiBFYWNoIHJlZ2lzdGVyIGlzIDIgYnl0ZXMgd2lkZS5cclxuICovXHJcbmNvbnN0IE1TQ1JlZ2lzdGVycyA9IHtcclxuICAgIFNlcmlhbE51bWJlcjogMTAsXHJcbiAgICBDdXJyZW50TW9kZTogMTAwLFxyXG4gICAgTWVhc3VyZUZsYWdzOiAxMDIsXHJcbiAgICBDTUQ6IDEwNyxcclxuICAgIEFVWDE6IDEwOCxcclxuICAgIExvYWRDZWxsTWVhc3VyZTogMTE0LFxyXG4gICAgVGVtcE1lYXN1cmU6IDEyMCxcclxuICAgIFJ0ZFRlbXBlcmF0dXJlTWVhc3VyZTogMTI4LFxyXG4gICAgUnRkUmVzaXN0YW5jZU1lYXN1cmU6IDEzMCxcclxuICAgIEZyZXF1ZW5jeU1lYXN1cmU6IDE2NCxcclxuICAgIE1pbk1lYXN1cmU6IDEzMixcclxuICAgIE1heE1lYXN1cmU6IDEzNCxcclxuICAgIEluc3RhbnRNZWFzdXJlOiAxMzYsXHJcbiAgICBQb3dlck9mZkRlbGF5OiAxNDIsXHJcbiAgICBQb3dlck9mZlJlbWFpbmluZzogMTQ2LFxyXG4gICAgUHVsc2VPRkZNZWFzdXJlOiAxNTAsXHJcbiAgICBQdWxzZU9OTWVhc3VyZTogMTUyLFxyXG4gICAgU2Vuc2liaWxpdHlfdVNfT0ZGOiAxNjYsXHJcbiAgICBTZW5zaWJpbGl0eV91U19PTjogMTY4LFxyXG4gICAgQmF0dGVyeU1lYXN1cmU6IDE3NCxcclxuICAgIENvbGRKdW5jdGlvbjogMTkwLFxyXG4gICAgVGhyZXNob2xkVV9GcmVxOiAxOTIsXHJcbiAgICBHZW5lcmF0aW9uRmxhZ3M6IDIwMixcclxuICAgIEdFTl9DTUQ6IDIwNyxcclxuICAgIEdFTl9BVVgxOiAyMDgsXHJcbiAgICBDdXJyZW50U2V0cG9pbnQ6IDIxMCxcclxuICAgIFZvbHRhZ2VTZXRwb2ludDogMjEyLFxyXG4gICAgTG9hZENlbGxTZXRwb2ludDogMjE2LFxyXG4gICAgVGhlcm1vVGVtcGVyYXR1cmVTZXRwb2ludDogMjIwLFxyXG4gICAgUlREVGVtcGVyYXR1cmVTZXRwb2ludDogMjI4LFxyXG4gICAgUHVsc2VzQ291bnQ6IDI1MixcclxuICAgIEZyZXF1ZW5jeVRJQ0sxOiAyNTQsXHJcbiAgICBGcmVxdWVuY3lUSUNLMjogMjU2LFxyXG4gICAgR2VuVWhpZ2hQZXJjOiAyNjIsXHJcbiAgICBHZW5VbG93UGVyYzogMjY0XHJcbn07XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIHNlcmlhbCBudW1iZXJcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZVNlcmlhbE51bWJlcigpIHtcclxuICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5TZXJpYWxOdW1iZXIpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgbW9kZVxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQ3VycmVudE1vZGUoKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuQ3VycmVudE1vZGUpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgYmF0dGVyeSBsZXZlbFxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQmF0dGVyeUxldmVsKCkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLkJhdHRlcnlNZWFzdXJlKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgcmVnaXN0ZXIgd2l0aCBiYXR0ZXJ5IGxldmVsXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBGQzMgYW5zd2VyIFxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBiYXR0ZXJ5IGxldmVsIGluIFZcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlQmF0dGVyeShidWZmZXIpIHtcclxuICAgIHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHJldHVybiBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVnaXN0ZXJzLCAwKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlIHRoZSBTZW5lY2EgTVNDIHNlcmlhbCBhcyBwZXIgdGhlIFVJIGludGVyZmFjZVxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSBidWZmZXIgbW9kYnVzIGFuc3dlciBwYWNrZXQgKEZDMylcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlU2VyaWFsTnVtYmVyKGJ1ZmZlcikge1xyXG4gICAgdmFyIHJlZ2lzdGVycyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgaWYgKHJlZ2lzdGVycy5sZW5ndGggPCA0KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBzZXJpYWwgbnVtYmVyIHJlc3BvbnNlXCIpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsMSA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMCwgZmFsc2UpO1xyXG4gICAgY29uc3QgdmFsMiA9IHJlZ2lzdGVycy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG4gICAgY29uc3Qgc2VyaWFsID0gKCh2YWwyIDw8IDE2KSArIHZhbDEpLnRvU3RyaW5nKCk7XHJcbiAgICBpZiAoc2VyaWFsLmxlbmd0aCA+IDUpIHtcclxuICAgICAgICByZXR1cm4gc2VyaWFsLnN1YnN0cigwLCA1KSArIFwiX1wiICsgc2VyaWFsLnN1YnN0cig1LCBzZXJpYWwubGVuZ3RoIC0gNSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VyaWFsO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSBzdGF0ZSBvZiB0aGUgbWV0ZXIuIE1heSB0aHJvdy5cclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyIG1vZGJ1cyBhbnN3ZXIgcGFja2V0IChGQzMpXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IGN1cnJlbnRNb2RlIGlmIHRoZSByZWdpc3RlcnMgY29udGFpbnMgYW4gSUdOT1JFIHZhbHVlLCByZXR1cm5zIHRoZSBjdXJyZW50IG1vZGVcclxuICogQHJldHVybnMge0NvbW1hbmRUeXBlfSBtZXRlciBtb2RlXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUN1cnJlbnRNb2RlKGJ1ZmZlciwgY3VycmVudE1vZGUpIHtcclxuICAgIHZhciByZWdpc3RlcnMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIGlmIChyZWdpc3RlcnMubGVuZ3RoIDwgMikge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbW9kZSByZXNwb25zZVwiKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbDEgPSByZWdpc3RlcnMuZ2V0VWludDE2KDAsIGZhbHNlKTtcclxuXHJcbiAgICBpZiAodmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCB8fCB2YWwxID09IENvbW1hbmRUeXBlLlJFU0VSVkVEXzIpIHsgLy8gTXVzdCBiZSBpZ25vcmVkXHJcbiAgICAgICAgcmV0dXJuIGN1cnJlbnRNb2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSB1dGlscy5QYXJzZShDb21tYW5kVHlwZSwgdmFsMSk7XHJcbiAgICBpZiAodmFsdWUgPT0gbnVsbClcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIG1ldGVyIG1vZGUgOiBcIiArIHZhbHVlKTtcclxuXHJcbiAgICByZXR1cm4gdmFsMTtcclxufVxyXG4vKipcclxuICogU2V0cyB0aGUgY3VycmVudCBtb2RlLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ8bnVsbH1cclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNb2RlUmVxdWVzdChtb2RlKSB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IHV0aWxzLlBhcnNlKENvbW1hbmRUeXBlLCBtb2RlKTtcclxuICAgIGNvbnN0IENIQU5HRV9TVEFUVVMgPSAxO1xyXG5cclxuICAgIC8vIEZpbHRlciBpbnZhbGlkIGNvbW1hbmRzXHJcbiAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PSBDb21tYW5kVHlwZS5OT05FX1VOS05PV04pIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBpZiAobW9kZSA+IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiBtb2RlIDw9IENvbW1hbmRUeXBlLk9GRikgeyAvLyBNZWFzdXJlbWVudHNcclxuICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKG1vZGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgbW9kZSA8IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCkgeyAvLyBHZW5lcmF0aW9uc1xyXG4gICAgICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICAgICAgLy8gQ29sZCBqdW5jdGlvbiBub3QgY29uZmlndXJlZFxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgIC8vIEFsbCB0aGUgc2ltcGxlIGNhc2VzIFxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HRU5fQ01ELCBbQ0hBTkdFX1NUQVRVUywgbW9kZV0pO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdoZW4gdGhlIG1ldGVyIGlzIG1lYXN1cmluZywgbWFrZSB0aGUgbW9kYnVzIHJlcXVlc3Qgb2YgdGhlIHZhbHVlXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHBhY2tldFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZU1lYXN1cmVSZXF1ZXN0KG1vZGUpIHtcclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlRlbXBNZWFzdXJlKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF80VzpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLlJ0ZFRlbXBlcmF0dXJlTWVhc3VyZSk7IC8vIFRlbXAtT2htXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lNZWFzdXJlKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5QdWxzZU9GRk1lYXN1cmUpOyAvLyBPTi1PRkZcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkxvYWRDZWxsOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuTG9hZENlbGwpO1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlY6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tVjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNiwgTVNDUmVnaXN0ZXJzLk1pbk1lYXN1cmUpOyAvLyBNaW4tTWF4LU1lYXNcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNb2RlIG5vdCBtYW5hZ2VkIDpcIiArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgbWVhc3VyZSByZWFkIGZyb20gdGhlIG1ldGVyXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlciBtb2RidXMgcnR1IGFuc3dlciAoRkMzKVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlIGN1cnJlbnQgbW9kZSBvZiB0aGUgbWV0ZXJcclxuICogQHJldHVybnMge2FycmF5fSBhbiBhcnJheSB3aXRoIGZpcnN0IGVsZW1lbnQgXCJNZWFzdXJlIG5hbWUgKHVuaXRzKVwiOlZhbHVlLCBzZWNvbmQgVGltZXN0YW1wOmFjcXVpc2l0aW9uXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZU1lYXN1cmUoYnVmZmVyLCBtb2RlKSB7XHJcbiAgICB2YXIgcmVzcG9uc2VGQzMgPSBtb2RidXMucGFyc2VGQzMoYnVmZmVyKTtcclxuICAgIHZhciBtZWFzLCBtZWFzMiwgbWluLCBtYXg7XHJcblxyXG4gICAgLy8gQWxsIG1lYXN1cmVzIGFyZSBmbG9hdFxyXG4gICAgaWYgKHJlc3BvbnNlRkMzID09IG51bGwpXHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUzpcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIHZhciB2YWx1ZSA9IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDBcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiB2YWx1ZSxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfNFc6XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtZWFzMiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTApIC8gMTAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCLCsENcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJSZXNpc3RhbmNlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVZhbHVlXCI6IE1hdGgucm91bmQobWVhczIgKiAxMCkgLyAxMCxcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VW5pdFwiOiBcIk9obXNcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuRnJlcXVlbmN5OlxyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgLy8gU2Vuc2liaWxpdMOgIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5XCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwKSAvIDEwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiSHpcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgbWluID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWF4ID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiQ3VycmVudFwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibUFcIixcclxuICAgICAgICAgICAgICAgIFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5WOlxyXG4gICAgICAgICAgICBtaW4gPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtYXggPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICBtZWFzID0gbW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJWXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubVY6XHJcbiAgICAgICAgICAgIG1pbiA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1heCA9IG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIG1lYXMgPSBtb2RidXMuZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgbWVhcyA9IG1vZGJ1cy5nZXRVaW50MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWVhczIgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIC8vIFNvZ2xpYSBlIHNlbnNpYmlsaXTDoCBtYW5jYW50aVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlB1bHNlIE9OXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IG1lYXMsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJQdWxzZSBPRkZcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VmFsdWVcIjogbWVhczIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVVuaXRcIjogXCJcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTG9hZENlbGw6XHJcbiAgICAgICAgICAgIG1lYXMgPSBNYXRoLnJvdW5kKG1vZGJ1cy5nZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCkgKiAxMDAwKSAvIDEwMDA7XHJcbiAgICAgICAgICAgIC8vIEtnIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIC8vIFNlbnNpYmlsaXTDoCwgdGFyYSwgcG9ydGF0YSBtYW5jYW50aVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkltYmFsYW5jZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBtZWFzLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibVYvVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMDApIC8gMTAwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIj9cIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHN0YXR1cyBmbGFncyBmcm9tIG1lYXN1cmVtZW50IG1vZGVcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlUXVhbGl0eUJpdFJlcXVlc3QobW9kZSkge1xyXG4gICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMSwgTVNDUmVnaXN0ZXJzLk1lYXN1cmVGbGFncyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDaGVja3MgaWYgdGhlIGVycm9yIGJpdCBzdGF0dXNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqIEByZXR1cm5zIHtib29sZWFufSB0cnVlIGlmIHRoZXJlIGlzIG5vIGVycm9yXHJcbiAqL1xyXG5mdW5jdGlvbiBpc1F1YWxpdHlWYWxpZChidWZmZXIpIHtcclxuICAgIHZhciByZXNwb25zZUZDMyA9IG1vZGJ1cy5wYXJzZUZDMyhidWZmZXIpO1xyXG4gICAgcmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDEzKSkgPT0gMCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgZ2VuZXJhdGlvbiBmbGFncyBzdGF0dXMgZnJvbSB0aGUgbWV0ZXJcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlR2VuU3RhdHVzUmVhZChtb2RlKSB7XHJcbiAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuR2VuZXJhdGlvbkZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IGlzIE5PVCBzZXQgaW4gdGhlIGdlbmVyYXRpb24gZmxhZ3NcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VGQzNcclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgdGhlcmUgaXMgbm8gZXJyb3JcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlR2VuU3RhdHVzKGJ1ZmZlciwgbW9kZSkge1xyXG4gICAgdmFyIHJlc3BvbnNlRkMzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgcmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMCkgJiYgLy8gR2VuIGVycm9yXHJcbiAgICAgICAgICAgICAgICAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNCkpID09IDApOyAvLyBTZWxmIGdlbmVyYXRpb24gSSBjaGVja1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJldHVybiAocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMDsgLy8gR2VuIGVycm9yXHJcbiAgICB9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGJ1ZmZlciB3aXRoIHRoZSBtb2RidXMtcnR1IHJlcXVlc3QgdG8gYmUgc2VudCB0byBTZW5lY2FcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBnZW5lcmF0aW9uIG1vZGVcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHRoZSB2YWx1ZSB0byBzZXQgKG1WL1YvQS9Iei/CsEMpIGV4Y2VwdCBmb3IgcHVsc2VzIG51bV9wdWxzZXNcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50MiBmcmVxdWVuY3kgaW4gSHpcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlcXVlc3QobW9kZSwgc2V0cG9pbnQsIHNldHBvaW50Mikge1xyXG4gICAgdmFyIFRFTVAsIHJlZ2lzdGVycztcclxuICAgIHZhciBkdCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIHZhciBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG4gICAgbW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCk7XHJcbiAgICBjb25zdCBzcCA9IFtkdi5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHJcbiAgICB2YXIgZHRJbnQgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICB2YXIgZHZJbnQgPSBuZXcgRGF0YVZpZXcoZHRJbnQpO1xyXG4gICAgbW9kYnVzLnNldFVpbnQzMkxFQlMoZHZJbnQsIDAsIHNldHBvaW50KTtcclxuICAgIGNvbnN0IHNwSW50ID0gW2R2SW50LmdldFVpbnQxNigwLCBmYWxzZSksIGR2SW50LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50LCBzcCk7IC8vIFYgLyBtViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkN1cnJlbnRTZXRwb2ludCwgc3ApOyAvLyBJIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5SVERUZW1wZXJhdHVyZVNldHBvaW50LCBzcCk7IC8vIMKwQyBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQsIHNwKTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuTG9hZENlbGxTZXRwb2ludCwgc3ApOyAvLyBtVi9WIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgICAgICBkdCA9IG5ldyBBcnJheUJ1ZmZlcig4KTsgLy8gMiBVaW50MzJcclxuICAgICAgICAgICAgZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuICAgICAgICAgICAgLy8gU2VlIFNlbmVjYWwgbWFudWFsIG1hbnVhbFxyXG4gICAgICAgICAgICAvLyBNYXggMjBrSFogZ2VuXHJcbiAgICAgICAgICAgIFRFTVAgPSBNYXRoLnJvdW5kKDIwMDAwIC8gc2V0cG9pbnQsIDApO1xyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoMCwgTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzFcclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDQsIFRFTVAgLSBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMlxyXG5cclxuICAgICAgICAgICAgLy8gQnl0ZS1zd2FwcGVkIGxpdHRsZSBlbmRpYW5cclxuICAgICAgICAgICAgcmVnaXN0ZXJzID0gW2R2LmdldFVpbnQxNigyLCBmYWxzZSksIGR2LmdldFVpbnQxNigwLCBmYWxzZSksXHJcbiAgICAgICAgICAgIGR2LmdldFVpbnQxNig2LCBmYWxzZSksIGR2LmdldFVpbnQxNig0LCBmYWxzZSldO1xyXG5cclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSwgcmVnaXN0ZXJzKTtcclxuXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgZHQgPSBuZXcgQXJyYXlCdWZmZXIoMTIpOyAvLyAzIFVpbnQzMiBcclxuICAgICAgICAgICAgZHYgPSBuZXcgRGF0YVZpZXcoZHQpO1xyXG5cclxuICAgICAgICAgICAgLy8gU2VlIFNlbmVjYWwgbWFudWFsIG1hbnVhbFxyXG4gICAgICAgICAgICAvLyBNYXggMjBrSFogZ2VuXHJcbiAgICAgICAgICAgIFRFTVAgPSBNYXRoLnJvdW5kKDIwMDAwIC8gc2V0cG9pbnQyLCAwKTtcclxuXHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMigwLCBzZXRwb2ludCwgZmFsc2UpOyAvLyBOVU1fUFVMU0VTXHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMig0LCBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMVxyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoOCwgVEVNUCAtIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0syXHJcblxyXG4gICAgICAgICAgICByZWdpc3RlcnMgPSBbZHYuZ2V0VWludDE2KDIsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDAsIGZhbHNlKSxcclxuICAgICAgICAgICAgZHYuZ2V0VWludDE2KDYsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDQsIGZhbHNlKSxcclxuICAgICAgICAgICAgZHYuZ2V0VWludDE2KDEwLCBmYWxzZSksIGR2LmdldFVpbnQxNig4LCBmYWxzZSldO1xyXG5cclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5QdWxzZXNDb3VudCwgcmVnaXN0ZXJzKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VVGhyZXNob2xkX0Y6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVGhyZXNob2xkVV9GcmVxLCBzcCk7IC8vIFUgbWluIGZvciBmcmVxIG1lYXN1cmVtZW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2Vuc2l0aXZpdHlfdVM6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuU2Vuc2liaWxpdHlfdVNfT0ZGLFxyXG4gICAgICAgICAgICAgICAgW3NwSW50WzBdLCBzcEludFsxXSwgc3BJbnRbMF0sIHNwSW50WzFdXSk7IC8vIHVWIGZvciBwdWxzZSB0cmFpbiBtZWFzdXJlbWVudCB0byBPTiAvIE9GRlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX0NvbGRKdW5jdGlvbjpcclxuICAgICAgICAgICAgcmV0dXJuIG1vZGJ1cy5tYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Db2xkSnVuY3Rpb24sIHNwKTsgLy8gdW5jbGVhciB1bml0XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWxvdzpcclxuICAgICAgICAgICAgbW9kYnVzLnNldEZsb2F0MzJMRUJTKGR2LCAwLCBzZXRwb2ludCAvIE1BWF9VX0dFTik7IC8vIE11c3QgY29udmVydCBWIGludG8gYSAlIDAuLk1BWF9VX0dFTlxyXG4gICAgICAgICAgICB2YXIgc3AyID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdlblVsb3dQZXJjLCBzcDIpOyAvLyBVIGxvdyBmb3IgZnJlcSAvIHB1bHNlIGdlblxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VoaWdoOlxyXG4gICAgICAgICAgICBtb2RidXMuc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcbiAgICAgICAgICAgIHZhciBzcDIgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR2VuVWhpZ2hQZXJjLCBzcDIpOyAvLyBVIGhpZ2ggZm9yIGZyZXEgLyBwdWxzZSBnZW4gICAgICAgICAgICBcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TaHV0ZG93bkRlbGF5OlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlBvd2VyT2ZmRGVsYXksIHNldHBvaW50KTsgLy8gZGVsYXkgaW4gc2VjXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5PRkY6XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsOyAvLyBObyBzZXRwb2ludFxyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBoYW5kbGVkXCIpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZWFkcyB0aGUgc2V0cG9pbnRcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZVNldHBvaW50UmVhZChtb2RlKSB7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50KTsgLy8gbVYgb3IgViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gbW9kYnVzLm1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQ3VycmVudFNldHBvaW50KTsgLy8gQSBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5SVERUZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UaGVybW9UZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5GcmVxdWVuY3lUSUNLMSk7IC8vIEZyZXF1ZW5jeSBzZXRwb2ludCAoVElDS1MpXHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiBtb2RidXMubWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbFNldHBvaW50KTsgLy8gbVYvViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBoYW5kbGVkXCIpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSBhbnN3ZXIgYWJvdXQgU2V0cG9pbnRSZWFkXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlZ2lzdGVycyBGQzMgcGFyc2VkIGFuc3dlclxyXG4gKiBAcmV0dXJucyB7bnVtYmVyfSB0aGUgbGFzdCBzZXRwb2ludFxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VTZXRwb2ludFJlYWQoYnVmZmVyLCBtb2RlKSB7XHJcbiAgICAvLyBSb3VuZCB0byB0d28gZGlnaXRzXHJcbiAgICB2YXIgcmVnaXN0ZXJzID0gbW9kYnVzLnBhcnNlRkMzKGJ1ZmZlcik7XHJcbiAgICB2YXIgcm91bmRlZCA9IE1hdGgucm91bmQobW9kYnVzLmdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCkgKiAxMDApIC8gMTAwO1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkN1cnJlbnRcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1BXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIlZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJJbWJhbGFuY2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WL1ZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICB2YXIgdGljazEgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZWdpc3RlcnMsIDApO1xyXG4gICAgICAgICAgICB2YXIgdGljazIgPSBtb2RidXMuZ2V0VWludDMyTEVCUyhyZWdpc3RlcnMsIDQpO1xyXG4gICAgICAgICAgICB2YXIgZk9OID0gMC4wO1xyXG4gICAgICAgICAgICB2YXIgZk9GRiA9IDAuMDtcclxuICAgICAgICAgICAgaWYgKHRpY2sxICE9IDApXHJcbiAgICAgICAgICAgICAgICBmT04gPSBNYXRoLnJvdW5kKDEgLyAodGljazEgKiAyIC8gMjAwMDAuMCkgKiAxMC4wKSAvIDEwOyAvLyBOZWVkIG9uZSBkZWNpbWFsIHBsYWNlIGZvciBIWlxyXG4gICAgICAgICAgICBpZiAodGljazIgIT0gMClcclxuICAgICAgICAgICAgICAgIGZPRkYgPSBNYXRoLnJvdW5kKDEgLyAodGljazIgKiAyIC8gMjAwMDAuMCkgKiAxMC4wKSAvIDEwOyAvLyBOZWVkIG9uZSBkZWNpbWFsIHBsYWNlIGZvciBIWlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeSBPTlwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBmT04sXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJIelwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlEZXNjcmlwdGlvblwiOiBcIkZyZXF1ZW5jeSBPRkZcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VmFsdWVcIjogZk9GRixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5VW5pdFwiOiBcIkh6XCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiByb3VuZGVkLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiwrBDXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlVua25vd25cIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIj9cIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgfVxyXG5cclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSB7XHJcbiAgICBNU0NSZWdpc3RlcnMsIG1ha2VTZXJpYWxOdW1iZXIsIG1ha2VDdXJyZW50TW9kZSwgbWFrZUJhdHRlcnlMZXZlbCwgcGFyc2VCYXR0ZXJ5LCBwYXJzZVNlcmlhbE51bWJlcixcclxuICAgIHBhcnNlQ3VycmVudE1vZGUsIG1ha2VNb2RlUmVxdWVzdCwgbWFrZU1lYXN1cmVSZXF1ZXN0LCBwYXJzZU1lYXN1cmUsIG1ha2VRdWFsaXR5Qml0UmVxdWVzdCwgaXNRdWFsaXR5VmFsaWQsXHJcbiAgICBtYWtlR2VuU3RhdHVzUmVhZCwgcGFyc2VHZW5TdGF0dXMsIG1ha2VTZXRwb2ludFJlcXVlc3QsIG1ha2VTZXRwb2ludFJlYWQsIHBhcnNlU2V0cG9pbnRSZWFkfSIsInZhciBjb25zdGFudHMgPSByZXF1aXJlKCcuL2NvbnN0YW50cycpO1xyXG52YXIgQ29tbWFuZFR5cGUgPSBjb25zdGFudHMuQ29tbWFuZFR5cGU7XHJcblxyXG5sZXQgc2xlZXAgPSBtcyA9PiBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxubGV0IHdhaXRGb3IgPSBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yKGYpIHtcclxuICAgIHdoaWxlICghZigpKSBhd2FpdCBzbGVlcCgxMDAgKyBNYXRoLnJhbmRvbSgpICogMjUpO1xyXG4gICAgcmV0dXJuIGYoKTtcclxufTtcclxuXHJcbmxldCB3YWl0Rm9yVGltZW91dCA9IGFzeW5jIGZ1bmN0aW9uIHdhaXRGb3IoZiwgdGltZW91dFNlYykge1xyXG4gICAgdmFyIHRvdGFsVGltZU1zID0gMDtcclxuICAgIHdoaWxlICghZigpICYmIHRvdGFsVGltZU1zIDwgdGltZW91dFNlYyAqIDEwMDApIHtcclxuICAgICAgICB2YXIgZGVsYXlNcyA9IDEwMCArIE1hdGgucmFuZG9tKCkgKiAyNTtcclxuICAgICAgICB0b3RhbFRpbWVNcyArPSBkZWxheU1zO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5TXMpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGYoKTtcclxufTtcclxuXHJcbi8vIFRoZXNlIGZ1bmN0aW9ucyBtdXN0IGV4aXN0IHN0YW5kLWFsb25lIG91dHNpZGUgQ29tbWFuZCBvYmplY3QgYXMgdGhpcyBvYmplY3QgbWF5IGNvbWUgZnJvbSBKU09OIHdpdGhvdXQgdGhlbSFcclxuZnVuY3Rpb24gaXNHZW5lcmF0aW9uKGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGN0eXBlID4gQ29tbWFuZFR5cGUuT0ZGICYmIGN0eXBlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc01lYXN1cmVtZW50KGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGN0eXBlID4gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOICYmIGN0eXBlIDwgQ29tbWFuZFR5cGUuUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzU2V0dGluZyhjdHlwZSkge1xyXG4gICAgcmV0dXJuIChjdHlwZSA9PSBDb21tYW5kVHlwZS5PRkYgfHwgY3R5cGUgPiBDb21tYW5kVHlwZS5TRVRUSU5HX1JFU0VSVkVEKTtcclxufVxyXG5mdW5jdGlvbiBpc1ZhbGlkKGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGlzTWVhc3VyZW1lbnQoY3R5cGUpIHx8IGlzR2VuZXJhdGlvbihjdHlwZSkgfHwgaXNTZXR0aW5nKGN0eXBlKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gY29udmVydCBhIHZhbHVlIGludG8gYW4gZW51bSB2YWx1ZVxyXG4gKiBcclxuICogQHBhcmFtIHt0eXBlfSBlbnVtdHlwZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gZW51bXZhbHVlXHJcbiAqL1xyXG4gZnVuY3Rpb24gUGFyc2UoZW51bXR5cGUsIGVudW12YWx1ZSkge1xyXG4gICAgZm9yICh2YXIgZW51bU5hbWUgaW4gZW51bXR5cGUpIHtcclxuICAgICAgICBpZiAoZW51bXR5cGVbZW51bU5hbWVdID09IGVudW12YWx1ZSkge1xyXG4gICAgICAgICAgICAvKmpzaGludCAtVzA2MSAqL1xyXG4gICAgICAgICAgICByZXR1cm4gZXZhbChbZW51bXR5cGUgKyBcIi5cIiArIGVudW1OYW1lXSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gZHVtcCBhcnJheWJ1ZmZlciBhcyBoZXggc3RyaW5nXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGJ1ZmZlclxyXG4gKi9cclxuIGZ1bmN0aW9uIGJ1ZjJoZXgoYnVmZmVyKSB7IC8vIGJ1ZmZlciBpcyBhbiBBcnJheUJ1ZmZlclxyXG4gICAgcmV0dXJuIFsuLi5uZXcgVWludDhBcnJheShidWZmZXIpXVxyXG4gICAgICAgIC5tYXAoeCA9PiB4LnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKVxyXG4gICAgICAgIC5qb2luKCcgJyk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0geyBzbGVlcCwgd2FpdEZvciwgd2FpdEZvclRpbWVvdXQsIGlzR2VuZXJhdGlvbiwgaXNNZWFzdXJlbWVudCwgaXNTZXR0aW5nLCBpc1ZhbGlkLCBQYXJzZSwgYnVmMmhleCB9OyJdfQ==
