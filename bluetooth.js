
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
        btState.meter.serial = seneca.parseSerialNumber(modbus.parseFC3(response));
        log.info('\t\tSerial number:' + btState.meter.serial);

        response = await SendAndResponse(seneca.makeCurrentMode());
        btState.meter.mode = seneca.parseCurrentMode(modbus.parseFC3(response), CommandType.NONE_UNKNOWN);
        log.debug('\t\tCurrent mode:' + btState.meter.mode);

        response = await SendAndResponse(seneca.makeBatteryLevel());
        btState.meter.battery = Math.round(seneca.parseBattery(modbus.parseFC3(response)) * 100) / 100;

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
        var mode = seneca.parseCurrentMode(modbus.parseFC3(response), btState.meter.mode);

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
    var valid = seneca.isQualityValid(modbus.parseFC3(response));

    // Read measure
    response = await SendAndResponse(seneca.makeMeasureRequest(btState.meter.mode));
    var meas = seneca.parseMeasure(modbus.parseFC3(response), btState.meter.mode);
    meas["error"] = !valid;

    btState.lastMeasure = meas;
}

/**
 * Gets the current values for the generated U,I from the device
 * */
async function refreshGeneration() {
    var response = await SendAndResponse(seneca.makeSetpointRead(btState.meter.mode));
    if (response != null) {
        var results = seneca.parseSetpointRead(modbus.parseFC3(response), btState.meter.mode);

        response = await SendAndResponse(seneca.makeGenStatusRead());
        results["error"] = !seneca.parseGenStatus(modbus.parseFC3(response), btState.meter.mode);

        btState.lastSetpoint = results;
    }
}

module.exports = {stateMachine};