(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.MSC = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
 /************************************************** BLUETOOTH HANDLING FUNCTIONS *****************************************************/

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
            sleep(DELAY_MS).then(() => stateMachine()); // Recheck status in DELAY_MS ms
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
            packet = makeModeRequest(CommandType.OFF);
            await SendAndResponse(packet);
            await sleep(100);

            // Now write the setpoint or setting
            if (isGeneration(command.type) || isSetting(command.type) && command.type != CommandType.OFF) {
                log.debug("\t\tWriting setpoint :" + command.setpoint);
                response = await SendAndResponse(makeSetpointRequest(command.type, command.setpoint, command.setpoint2));
                if (response != null && !parseFC16checked(response, 0)) {
                    throw new Error("Setpoint not correctly written");
                }
                switch (command.type) {
                    case CommandType.SET_ShutdownDelay:
                        startGen = makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CMD, [RESET_POWER_OFF]);
                        response = await SendAndResponse(startGen);
                        if (!parseFC16checked(response, 1)) {
                            command.error = true;
                            command.pending = false;
                            throw new Error("Failure to set poweroff timer.");
                        }
                        break;
                    default:
                        break;
                }
            }

            if (!isSetting(command.type) && isValid(command.type) && command.type != CommandType.OFF)  // IF this is a setting, we're done.
            {
                // Now write the mode set 
                log.debug("\t\tSetting new mode :" + command.type);
                packet = makeModeRequest(command.type);
                if (packet == null) {
                    command.error = true;
                    command.pending = false;
                    log.error("Could not generate modbus packet for command", command);
                    return;
                }

                response = await SendAndResponse(packet);
                command.request = packet;
                command.answer = response;

                if (!parseFC16checked(response, 0)) {
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
                        await sleep(1000);
                        // Reset the min/max/avg value
                        log.debug("\t\tResetting statistics");
                        startGen = makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CMD, [CLEAR_AVG_MIN_MAX]);
                        response = await SendAndResponse(startGen);
                        if (!parseFC16checked(response, 1)) {
                            command.error = true;
                            command.pending = false;
                            throw new Error("Failure to reset stats.");
                        }
                        break;
                    case CommandType.GEN_PulseTrain:
                        await sleep(1000);
                        log.debug("\t\tResetting statistics");
                        startGen = makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GEN_CMD, [PULSE_CMD, 2]); // Start with low
                        response = await SendAndResponse(startGen);
                        if (!parseFC16checked(response, 2)) {
                            command.error = true;
                            command.pending = false;
                            throw new Error("Not all registers were written");
                        }
                        break;
                    case CommandType.GEN_Frequency:
                        await sleep(1000);
                        log.debug("\t\tResetting statistics");
                        startGen = makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GEN_CMD, [PULSE_CMD, 1]); // start gen
                        response = await SendAndResponse(startGen);
                        if (!parseFC16checked(response, 2)) {
                            command.error = true;
                            command.pending = false;
                            throw new Error("Not all registers were written");
                        }
                        break;
                } // switch

                // Disable auto power off
                log.debug("\t\tDisabling power off");
                startGen = makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CMD, [RESET_POWER_OFF]);
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
            if (err instanceof ModbusError)
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
            response = await SendAndResponse(makeSerialNumber());
            btState.meter.serial = parseSerialNumber(parseFC3(response));
            log.info('\t\tSerial number:' + btState.meter.serial);

            response = await SendAndResponse(makeCurrentMode());
            btState.meter.mode = parseCurrentMode(parseFC3(response), CommandType.NONE_UNKNOWN);
            log.debug('\t\tCurrent mode:' + btState.meter.mode);

            response = await SendAndResponse(makeBatteryLevel());
            btState.meter.battery = Math.round(parseBattery(parseFC3(response)) * 100) / 100;

            btState.state = State.IDLE;
        }
        catch (err) {
            log.warn("Error while initializing meter :" + err);
            btState.stats["exceptions"]++;
            btState.state = State.DEVICE_PAIRED;
            if (err instanceof ModbusError)
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
            await sleep(500);
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
                        await sleep(100);
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
            await sleep(50);
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
            var response = await SendAndResponse(makeCurrentMode());
            var mode = parseCurrentMode(parseFC3(response), btState.meter.mode);

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
            if (err instanceof ModbusError)
                btState.stats["modbus_errors"]++;
        }
    }

    /**
     * Read the last measure and update btState.lastMeasure property
     * */
    async function refreshMeasure() {
        // Read quality
        var response = await SendAndResponse(makeQualityBitRequest());
        var valid = isQualityValid(parseFC3(response));

        // Read measure
        response = await SendAndResponse(makeMeasureRequest(btState.meter.mode));
        var meas = parseMeasure(parseFC3(response), btState.meter.mode);
        meas["error"] = !valid;

        btState.lastMeasure = meas;
    }

    /**
     * Gets the current values for the generated U,I from the device
     * */
    async function refreshGeneration() {
        var response = await SendAndResponse(makeSetpointRead(btState.meter.mode));
        if (response != null) {
            var results = parseSetpointRead(parseFC3(response), btState.meter.mode);

            response = await SendAndResponse(makeGenStatusRead());
            results["error"] = !parseGenStatus(parseFC3(response), btState.meter.mode);

            btState.lastSetpoint = results;
        }
    }
},{}],2:[function(require,module,exports){

// Current state of the bluetooth
class APIState {
    constructor() {
        this.state = State.NOT_CONNECTED;
        this.prev_state = State.NOT_CONNECTED;
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
},{}],3:[function(require,module,exports){
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
        return "Type: " + Parse(CommandType, this.type) + ", setpoint:" + this.setpoint + ", setpoint2: " + this.setpoint2 + ", pending:" + this.pending + ", error:" + this.error;
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
        return isGeneration(this.type);
    }
    isMeasurement() {
        return isMeasurement(this.type);
    }
    isSetting() {
        return isSetting(this.type);
    }
    isValid() {
        return (isMeasurement(this.type) || isGeneration(this.type) || isSetting(this.type));
    }
}


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

},{}],4:[function(require,module,exports){
/**
 * Current state of the meter
 * */
 class MeterState {
    constructor() {
        this.firmware = ""; // Firmware version
        this.serial = ""; // Serial number
        this.mode = CommandType.NONE_UNKNOWN;
        this.battery = 0.0;
    }

    isMeasurement() {
        return this.mode > CommandType.NONE_UNKNOWN && this.mode < CommandType.OFF;
    }

    isGeneration() {
        return this.mode > CommandType.OFF && this.mode < CommandType.GEN_RESERVED;
    }
}
},{}],5:[function(require,module,exports){
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


/*
 * Bluetooth constants
 */
const BlueToothMSC = {
    ServiceUuid: '0003cdd0-0000-1000-8000-00805f9b0131', // bluetooth modbus RTU service for Seneca MSC
    ModbusAnswerUuid: '0003cdd1-0000-1000-8000-00805f9b0131',     // modbus RTU answers
    ModbusRequestUuid: '0003cdd2-0000-1000-8000-00805f9b0131'    // modbus RTU requests
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
},{}],6:[function(require,module,exports){
'use strict';

const log = require("loglevel");

require('./constants');
require('./classes/APIState');
require('./classes/Command');
require('./classes/MeterState');
require('./modbusRtu');
require('./senecaModbus');
require('./meterPublicAPI');
require('./bluetooth');
require('./utils');

/**
 * The main object with the state of meter, bluetooth, command...
 * */
let btState = new APIState();

module.exports = { Stop, Pair, Execute, GetState, State, CommandType, Command, Parse, log, GetStateJSON, ExecuteJSON };

},{"./bluetooth":1,"./classes/APIState":2,"./classes/Command":3,"./classes/MeterState":4,"./constants":5,"./meterPublicAPI":7,"./modbusRtu":8,"./senecaModbus":10,"./utils":11,"loglevel":9}],7:[function(require,module,exports){
/*
 * This file contains the public API of the meter, i.e. the functions designed
 * to be called from third party code.
 * 1- Pair() : bool
 * 2- Execute(Command) : bool + JSON version
 * 3- Stop() : bool
 * 4- GetState() : array + JSON version
 * 5- SimpleExecute(Command) : returns the updated measurement or null
 */

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
        await waitForTimeout(() => !command.pending || btState.state == State.STOPPED, SIMPLE_EXECUTE_TIMEOUT_S);
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
        await sleep(1000);
        cpt++;
    }
    log.info("Setting new command :" + command);
    btState.command = command;

    // Start the regular state machine
    if (!btState.started) {
        btState.state = State.NOT_CONNECTED;
        await stateMachine();
    }

    // Wait for completion of the command, or halt of the state machine
    if (command != null) {
        await waitFor(() => !command.pending || btState.state == State.STOPPED);
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
        stateMachine(); // Start it
    }
    else if (btState.state == State.ERROR) {
        btState.state = State.NOT_CONNECTED; // Try to restart
    }
    await waitFor(() => btState.state == State.IDLE || btState.state == State.STOPPED);
    log.info("Pairing completed, state :", btState.state);
    return (btState.state != State.STOPPED);
}

/**
 * Stops the state machine and disconnects bluetooth.
 * */
async function Stop() {
    log.info("Stop request received");

    btState.stopRequest = true;
    await sleep(100);

    while(btState.started || (btState.state != State.STOPPED && btState.state != State.NOT_CONNECTED))
    {
        btState.stopRequest = true;    
        await sleep(100);
    }

    btState.stopRequest = false;
    log.warn("Stopped on request.");
    return true;
}
},{}],8:[function(require,module,exports){
const SENECA_MB_SLAVE_ID = 25; // Modbus RTU slave ID

/******************************** MODBUS STUFF ***********************************************/
class CommandResult
{
    value = 0.0;
    result = false;
    message = "";
}

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
 * Helper function to dump arraybuffer as hex string
 * @param {ArrayBuffer} buffer
 */
function buf2hex(buffer) { // buffer is an ArrayBuffer
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join(' ');
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

},{}],9:[function(require,module,exports){
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

},{}],10:[function(require,module,exports){
/******************************* MODBUS RTU FUNCTIONS FOR SENECA **********************/

var MAX_U_GEN = 27.0; // maximum voltage 

/**
 * Generate the modbus RTU packet to read the serial number
 * */
 function makeSerialNumber() {
    return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.SerialNumber);
}

/**
 * Generate the modbus RTU packet to read the current mode
 * */
function makeCurrentMode() {
    return makeFC3(SENECA_MB_SLAVE_ID, 1, MSCRegisters.CurrentMode);
}

/**
 * Generate the modbus RTU packet to read the current battery level
 * */
function makeBatteryLevel() {
    return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.BatteryMeasure);
}

/**
 * Parses the register with battery level
 * @param {ArrayBuffer} responseFC3 
 * @returns {number} battery level in V
 */
function parseBattery(responseFC3) {
    return getFloat32LEBS(responseFC3, 0);
}

/**
 * Parse the Seneca MSC serial as per the UI interface
 * @param {DataView} registers values of the registers
 */
function parseSerialNumber(registers) {
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
 * @param {ArrayBuffer} registers register value
 * @param {CommandType} currentMode if the registers contains an IGNORE value, returns the current mode
 * @returns {CommandType} meter mode
 */
function parseCurrentMode(registers, currentMode) {
    if (registers.length < 2) {
        throw new Error("Invalid mode response");
    }
    const val1 = registers.getUint16(0, false);

    if (val1 == CommandType.RESERVED || val1 == CommandType.GEN_RESERVED || val1 == CommandType.RESERVED_2) { // Must be ignored
        return currentMode;
    }
    const value = Parse(CommandType, val1);
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
    const value = Parse(CommandType, mode);
    const CHANGE_STATUS = 1;

    // Filter invalid commands
    if (value == null || value == CommandType.NONE_UNKNOWN) {
        return null;
    }

    if (mode > CommandType.NONE_UNKNOWN && mode <= CommandType.OFF) { // Measurements
        return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CMD, [CHANGE_STATUS, mode]);
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
                return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GEN_CMD, [CHANGE_STATUS, mode]);
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
                return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GEN_CMD, [CHANGE_STATUS, mode]);
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
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.TempMeasure);
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
            return makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.RtdTemperatureMeasure); // Temp-Ohm
        case CommandType.Frequency:
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.FrequencyMeasure);
        case CommandType.PulseTrain:
            return makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.PulseOFFMeasure); // ON-OFF
        case CommandType.LoadCell:
            return makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.LoadCell);
        case CommandType.mA_passive:
        case CommandType.mA_active:
        case CommandType.V:
        case CommandType.mV:
            return makeFC3(SENECA_MB_SLAVE_ID, 6, MSCRegisters.MinMeasure); // Min-Max-Meas
        default:
            throw new Error("Mode not managed :" + btState.meter.mode);
    }
}

/**
 * Parse the measure read from the meter
 * @param {ArrayBuffer} responseFC3 registers values from parsed modbus answer
 * @param {CommandType} mode current mode of the meter
 * @returns {array} an array with first element "Measure name (units)":Value, second Timestamp:acquisition
 */
function parseMeasure(responseFC3, mode) {
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
            meas = getFloat32LEBS(responseFC3, 0);
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
            meas = getFloat32LEBS(responseFC3, 0);
            meas2 = getFloat32LEBS(responseFC3, 4);
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
            meas = getFloat32LEBS(responseFC3, 0);
            // Sensibilità mancanti
            return {
                "Description": "Frequency",
                "Value": Math.round(meas * 10) / 10,
                "Unit": "Hz",
                "Timestamp": new Date().toISOString()
            };
        case CommandType.mA_active:
        case CommandType.mA_passive:
            min = getFloat32LEBS(responseFC3, 0);
            max = getFloat32LEBS(responseFC3, 4);
            meas = getFloat32LEBS(responseFC3, 8);
            return {
                "Description": "Current",
                "Value": Math.round(meas * 100) / 100,
                "Unit": "mA",
                "Minimum": Math.round(min * 100) / 100,
                "Maximum": Math.round(max * 100) / 100,
                "Timestamp": new Date().toISOString()
            };
        case CommandType.V:
            min = getFloat32LEBS(responseFC3, 0);
            max = getFloat32LEBS(responseFC3, 4);
            meas = getFloat32LEBS(responseFC3, 8);
            return {
                "Description": "Voltage",
                "Value": Math.round(meas * 100) / 100,
                "Unit": "V",
                "Minimum": Math.round(min * 100) / 100,
                "Maximum": Math.round(max * 100) / 100,
                "Timestamp": new Date().toISOString()
            };
        case CommandType.mV:
            min = getFloat32LEBS(responseFC3, 0);
            max = getFloat32LEBS(responseFC3, 4);
            meas = getFloat32LEBS(responseFC3, 8);
            return {
                "Description": "Voltage",
                "Value": Math.round(meas * 100) / 100,
                "Unit": "mV",
                "Minimum": Math.round(min * 100) / 100,
                "Maximum": Math.round(max * 100) / 100,
                "Timestamp": new Date().toISOString()
            };
        case CommandType.PulseTrain:
            meas = getUint32LEBS(responseFC3, 0);
            meas2 = getUint32LEBS(responseFC3, 4);
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
            meas = Math.round(getFloat32LEBS(responseFC3, 0) * 1000) / 1000;
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
    return makeFC3(SENECA_MB_SLAVE_ID, 1, MSCRegisters.MeasureFlags);
}

/**
 * Checks if the error bit status
 * @param {ArrayBuffer} responseFC3
 * @returns {boolean} true if there is no error
 */
function isQualityValid(responseFC3) {
    return ((responseFC3.getUint16(0, false) & (1 << 13)) == 0);
}

/**
 * Reads the generation flags status from the meter
 * @param {CommandType} mode
 * @returns {ArrayBuffer} modbus RTU request to send
 */
function makeGenStatusRead(mode) {
    return makeFC3(SENECA_MB_SLAVE_ID, 1, MSCRegisters.GenerationFlags);
}

/**
 * Checks if the error bit is NOT set in the generation flags
 * @param {ArrayBuffer} responseFC3
 * @returns {boolean} true if there is no error
 */
function parseGenStatus(responseFC3, mode) {
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

    setFloat32LEBS(dv, 0, setpoint);
    const sp = [dv.getUint16(0, false), dv.getUint16(2, false)];

    var dtInt = new ArrayBuffer(4);
    var dvInt = new DataView(dtInt);
    setUint32LEBS(dvInt, 0, setpoint);
    const spInt = [dvInt.getUint16(0, false), dvInt.getUint16(2, false)];

    switch (mode) {
        case CommandType.GEN_V:
        case CommandType.GEN_mV:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.VoltageSetpoint, sp); // V / mV setpoint
        case CommandType.GEN_mA_active:
        case CommandType.GEN_mA_passive:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.CurrentSetpoint, sp); // I setpoint
        case CommandType.GEN_Cu50_3W:
        case CommandType.GEN_Cu50_2W:
        case CommandType.GEN_Cu100_2W:
        case CommandType.GEN_Ni100_2W:
        case CommandType.GEN_Ni120_2W:
        case CommandType.GEN_PT100_2W:
        case CommandType.GEN_PT500_2W:
        case CommandType.GEN_PT1000_2W:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.RTDTemperatureSetpoint, sp); // °C setpoint
        case CommandType.GEN_THERMO_B:
        case CommandType.GEN_THERMO_E:
        case CommandType.GEN_THERMO_J:
        case CommandType.GEN_THERMO_K:
        case CommandType.GEN_THERMO_L:
        case CommandType.GEN_THERMO_N:
        case CommandType.GEN_THERMO_R:
        case CommandType.GEN_THERMO_S:
        case CommandType.GEN_THERMO_T:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ThermoTemperatureSetpoint, sp); // °C setpoint
        case CommandType.GEN_LoadCell:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.LoadCellSetpoint, sp); // mV/V setpoint
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

            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.FrequencyTICK1, registers);

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

            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.PulsesCount, registers);
        case CommandType.SET_UThreshold_F:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ThresholdU_Freq, sp); // U min for freq measurement
        case CommandType.SET_Sensitivity_uS:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.Sensibility_uS_OFF,
                [spInt[0], spInt[1], spInt[0], spInt[1]]); // uV for pulse train measurement to ON / OFF
        case CommandType.SET_ColdJunction:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.ColdJunction, sp); // unclear unit
        case CommandType.SET_Ulow:
            setFloat32LEBS(dv, 0, setpoint / MAX_U_GEN); // Must convert V into a % 0..MAX_U_GEN
            var sp2 = [dv.getUint16(0, false), dv.getUint16(2, false)];
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GenUlowPerc, sp2); // U low for freq / pulse gen
        case CommandType.SET_Uhigh:
            setFloat32LEBS(dv, 0, setpoint / MAX_U_GEN); // Must convert V into a % 0..MAX_U_GEN
            var sp2 = [dv.getUint16(0, false), dv.getUint16(2, false)];
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.GenUhighPerc, sp2); // U high for freq / pulse gen            
        case CommandType.SET_ShutdownDelay:
            return makeFC16(SENECA_MB_SLAVE_ID, MSCRegisters.PowerOffDelay, setpoint); // delay in sec
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
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.VoltageSetpoint); // mV or V setpoint
        case CommandType.GEN_mA_active:
        case CommandType.GEN_mA_passive:
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.CurrentSetpoint); // A setpoint
        case CommandType.GEN_Cu50_3W:
        case CommandType.GEN_Cu50_2W:
        case CommandType.GEN_Cu100_2W:
        case CommandType.GEN_Ni100_2W:
        case CommandType.GEN_Ni120_2W:
        case CommandType.GEN_PT100_2W:
        case CommandType.GEN_PT500_2W:
        case CommandType.GEN_PT1000_2W:
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.RTDTemperatureSetpoint); // °C setpoint
        case CommandType.GEN_THERMO_B:
        case CommandType.GEN_THERMO_E:
        case CommandType.GEN_THERMO_J:
        case CommandType.GEN_THERMO_K:
        case CommandType.GEN_THERMO_L:
        case CommandType.GEN_THERMO_N:
        case CommandType.GEN_THERMO_R:
        case CommandType.GEN_THERMO_S:
        case CommandType.GEN_THERMO_T:
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.ThermoTemperatureSetpoint); // °C setpoint
        case CommandType.GEN_Frequency:
        case CommandType.GEN_PulseTrain:
            return makeFC3(SENECA_MB_SLAVE_ID, 4, MSCRegisters.FrequencyTICK1); // Frequency setpoint (TICKS)
        case CommandType.GEN_LoadCell:
            return makeFC3(SENECA_MB_SLAVE_ID, 2, MSCRegisters.LoadCellSetpoint); // mV/V setpoint
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
function parseSetpointRead(registers, mode) {
    // Round to two digits
    var rounded = Math.round(getFloat32LEBS(registers, 0) * 100) / 100;

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
            var tick1 = getUint32LEBS(registers, 0);
            var tick2 = getUint32LEBS(registers, 4);
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
},{}],11:[function(require,module,exports){
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


},{}]},{},[6])(6)
});

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJibHVldG9vdGguanMiLCJjbGFzc2VzL0FQSVN0YXRlLmpzIiwiY2xhc3Nlcy9Db21tYW5kLmpzIiwiY2xhc3Nlcy9NZXRlclN0YXRlLmpzIiwiY29uc3RhbnRzLmpzIiwibWV0ZXJBcGkuanMiLCJtZXRlclB1YmxpY0FQSS5qcyIsIm1vZGJ1c1J0dS5qcyIsIm5vZGVfbW9kdWxlcy9sb2dsZXZlbC9saWIvbG9nbGV2ZWwuanMiLCJzZW5lY2FNb2RidXMuanMiLCJ1dGlscy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbGpCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDalJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2bUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpe2Z1bmN0aW9uIHIoZSxuLHQpe2Z1bmN0aW9uIG8oaSxmKXtpZighbltpXSl7aWYoIWVbaV0pe3ZhciBjPVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmU7aWYoIWYmJmMpcmV0dXJuIGMoaSwhMCk7aWYodSlyZXR1cm4gdShpLCEwKTt2YXIgYT1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK2krXCInXCIpO3Rocm93IGEuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixhfXZhciBwPW5baV09e2V4cG9ydHM6e319O2VbaV1bMF0uY2FsbChwLmV4cG9ydHMsZnVuY3Rpb24ocil7dmFyIG49ZVtpXVsxXVtyXTtyZXR1cm4gbyhufHxyKX0scCxwLmV4cG9ydHMscixlLG4sdCl9cmV0dXJuIG5baV0uZXhwb3J0c31mb3IodmFyIHU9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWlyZSYmcmVxdWlyZSxpPTA7aTx0Lmxlbmd0aDtpKyspbyh0W2ldKTtyZXR1cm4gb31yZXR1cm4gcn0pKCkiLCIgLyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqIEJMVUVUT09USCBIQU5ETElORyBGVU5DVElPTlMgKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBNYWluIGxvb3Agb2YgdGhlIG1ldGVyIGhhbmRsZXIuXHJcbiAgICAgKiAqL1xyXG4gICAgIGFzeW5jIGZ1bmN0aW9uIHN0YXRlTWFjaGluZSgpIHtcclxuICAgICAgICB2YXIgbmV4dEFjdGlvbjtcclxuICAgICAgICBjb25zdCBERUxBWV9NUyA9IDc1MDtcclxuICAgICAgICBjb25zdCBUSU1FT1VUX01TID0gMzAwMDA7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGFydGVkID0gdHJ1ZTtcclxuXHJcbiAgICAgICAgbG9nLmRlYnVnKFwiQ3VycmVudCBzdGF0ZTpcIiArIGJ0U3RhdGUuc3RhdGUpO1xyXG5cclxuICAgICAgICAvLyBDb25zZWN1dGl2ZSBzdGF0ZSBjb3VudGVkLiBDYW4gYmUgdXNlZCB0byB0aW1lb3V0LlxyXG4gICAgICAgIGlmIChidFN0YXRlLnN0YXRlID09IGJ0U3RhdGUucHJldl9zdGF0ZSkge1xyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCsrO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGVfY3B0ID0gMDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIFN0b3AgcmVxdWVzdCBmcm9tIEFQSVxyXG4gICAgICAgIGlmIChidFN0YXRlLnN0b3BSZXF1ZXN0KSB7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVE9QUElORztcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIlxcU3RhdGU6XCIgKyBidFN0YXRlLnN0YXRlKTtcclxuICAgICAgICBzd2l0Y2ggKGJ0U3RhdGUuc3RhdGUpIHtcclxuICAgICAgICAgICAgY2FzZSBTdGF0ZS5OT1RfQ09OTkVDVEVEOiAvLyBpbml0aWFsIHN0YXRlIG9uIFN0YXJ0KClcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBidFBhaXJEZXZpY2U7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBTdGF0ZS5DT05ORUNUSU5HOiAvLyB3YWl0aW5nIGZvciBjb25uZWN0aW9uIHRvIGNvbXBsZXRlXHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgU3RhdGUuREVWSUNFX1BBSVJFRDogLy8gY29ubmVjdGlvbiBjb21wbGV0ZSwgYWNxdWlyZSBtZXRlciBzdGF0ZVxyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IGJ0U3Vic2NyaWJlO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6IC8vIHdhaXRpbmcgZm9yIEJsdWV0b290aCBpbnRlcmZhY2VzXHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuc3RhdGVfY3B0ID4gKFRJTUVPVVRfTVMgLyBERUxBWV9NUykpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgICAgICBsb2cud2FybihcIlRpbWVvdXQgaW4gU1VCU0NSSUJJTkdcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVDogLy8gcmVhZHkgdG8gY29tbXVuaWNhdGUsIGFjcXVpcmUgbWV0ZXIgc3RhdHVzXHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gbWV0ZXJJbml0O1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVElBTElaSU5HOiAvLyByZWFkaW5nIHRoZSBtZXRlciBzdGF0dXNcclxuICAgICAgICAgICAgICAgIGlmIChidFN0YXRlLnN0YXRlX2NwdCA+IChUSU1FT1VUX01TIC8gREVMQVlfTVMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbG9nLndhcm4oXCJUaW1lb3V0IGluIE1FVEVSX0lOSVRJQUxJWklOR1wiKTtcclxuICAgICAgICAgICAgICAgICAgICAvLyBUaW1lb3V0LCB0cnkgdG8gcmVzdWJzY3JpYmVcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gYnRTdWJzY3JpYmU7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZV9jcHQgPSAwO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbmV4dEFjdGlvbiA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIFN0YXRlLklETEU6IC8vIHJlYWR5IHRvIHByb2Nlc3MgY29tbWFuZHMgZnJvbSBBUElcclxuICAgICAgICAgICAgICAgIGlmIChidFN0YXRlLmNvbW1hbmQgIT0gbnVsbClcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gcHJvY2Vzc0NvbW1hbmQ7XHJcbiAgICAgICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gcmVmcmVzaDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIFN0YXRlLkVSUk9SOiAvLyBhbnl0aW1lIGFuIGVycm9yIGhhcHBlbnNcclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBkaXNjb25uZWN0O1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgU3RhdGUuQlVTWTogLy8gd2hpbGUgYSBjb21tYW5kIGluIGdvaW5nIG9uXHJcbiAgICAgICAgICAgICAgICBpZiAoYnRTdGF0ZS5zdGF0ZV9jcHQgPiAoVElNRU9VVF9NUyAvIERFTEFZX01TKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiVGltZW91dCBpbiBCVVNZXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIFRpbWVvdXQsIHRyeSB0byByZXN1YnNjcmliZVxyXG4gICAgICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSBidFN1YnNjcmliZTtcclxuICAgICAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRlX2NwdCA9IDA7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgU3RhdGUuU1RPUFBJTkc6XHJcbiAgICAgICAgICAgICAgICBuZXh0QWN0aW9uID0gZGlzY29ubmVjdDtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIFN0YXRlLlNUT1BQRUQ6IC8vIGFmdGVyIGEgZGlzY29ubmVjdG9yIG9yIFN0b3AoKSByZXF1ZXN0LCBzdG9wcyB0aGUgc3RhdGUgbWFjaGluZS5cclxuICAgICAgICAgICAgICAgIG5leHRBY3Rpb24gPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgYnRTdGF0ZS5wcmV2X3N0YXRlID0gYnRTdGF0ZS5zdGF0ZTtcclxuXHJcbiAgICAgICAgaWYgKG5leHRBY3Rpb24gIT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdEV4ZWN1dGluZzpcIiArIG5leHRBY3Rpb24ubmFtZSk7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBuZXh0QWN0aW9uKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgICAgIGxvZy5lcnJvcihcIkV4Y2VwdGlvbiBpbiBzdGF0ZSBtYWNoaW5lXCIsIGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQpIHtcclxuICAgICAgICAgICAgc2xlZXAoREVMQVlfTVMpLnRoZW4oKCkgPT4gc3RhdGVNYWNoaW5lKCkpOyAvLyBSZWNoZWNrIHN0YXR1cyBpbiBERUxBWV9NUyBtc1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKFwiXFx0VGVybWluYXRpbmcgU3RhdGUgbWFjaGluZVwiKTtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGFydGVkID0gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQ2FsbGVkIGZyb20gc3RhdGUgbWFjaGluZSB0byBleGVjdXRlIGEgc2luZ2xlIGNvbW1hbmQgZnJvbSBidFN0YXRlLmNvbW1hbmQgcHJvcGVydHlcclxuICAgICAqICovXHJcbiAgICBhc3luYyBmdW5jdGlvbiBwcm9jZXNzQ29tbWFuZCgpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICB2YXIgY29tbWFuZCA9IGJ0U3RhdGUuY29tbWFuZDtcclxuICAgICAgICAgICAgdmFyIHBhY2tldCwgcmVzcG9uc2UsIHN0YXJ0R2VuO1xyXG4gICAgICAgICAgICBjb25zdCBSRVNFVF9QT1dFUl9PRkYgPSA2O1xyXG4gICAgICAgICAgICBjb25zdCBTRVRfUE9XRVJfT0ZGID0gNztcclxuICAgICAgICAgICAgY29uc3QgQ0xFQVJfQVZHX01JTl9NQVggPSA1O1xyXG4gICAgICAgICAgICBjb25zdCBQVUxTRV9DTUQgPSA5O1xyXG5cclxuICAgICAgICAgICAgaWYgKGNvbW1hbmQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5CVVNZO1xyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wiY29tbWFuZHNcIl0rKztcclxuXHJcbiAgICAgICAgICAgIGxvZy5pbmZvKCdcXHRcXHRFeGVjdXRpbmcgY29tbWFuZCAnICsgY29tbWFuZCk7XHJcblxyXG4gICAgICAgICAgICAvLyBGaXJzdCBzZXQgTk9ORSBiZWNhdXNlIHdlIGRvbid0IHdhbnQgdG8gd3JpdGUgbmV3IHNldHBvaW50cyB3aXRoIGFjdGl2ZSBnZW5lcmF0aW9uXHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFNldHRpbmcgbWV0ZXIgdG8gT0ZGXCIpO1xyXG4gICAgICAgICAgICBwYWNrZXQgPSBtYWtlTW9kZVJlcXVlc3QoQ29tbWFuZFR5cGUuT0ZGKTtcclxuICAgICAgICAgICAgYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHBhY2tldCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHNsZWVwKDEwMCk7XHJcblxyXG4gICAgICAgICAgICAvLyBOb3cgd3JpdGUgdGhlIHNldHBvaW50IG9yIHNldHRpbmdcclxuICAgICAgICAgICAgaWYgKGlzR2VuZXJhdGlvbihjb21tYW5kLnR5cGUpIHx8IGlzU2V0dGluZyhjb21tYW5kLnR5cGUpICYmIGNvbW1hbmQudHlwZSAhPSBDb21tYW5kVHlwZS5PRkYpIHtcclxuICAgICAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFdyaXRpbmcgc2V0cG9pbnQgOlwiICsgY29tbWFuZC5zZXRwb2ludCk7XHJcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9IGF3YWl0IFNlbmRBbmRSZXNwb25zZShtYWtlU2V0cG9pbnRSZXF1ZXN0KGNvbW1hbmQudHlwZSwgY29tbWFuZC5zZXRwb2ludCwgY29tbWFuZC5zZXRwb2ludDIpKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZXNwb25zZSAhPSBudWxsICYmICFwYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAwKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlNldHBvaW50IG5vdCBjb3JyZWN0bHkgd3JpdHRlblwiKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHN3aXRjaCAoY29tbWFuZC50eXBlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2h1dGRvd25EZWxheTpcclxuICAgICAgICAgICAgICAgICAgICAgICAgc3RhcnRHZW4gPSBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5DTUQsIFtSRVNFVF9QT1dFUl9PRkZdKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIXBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLmVycm9yID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmQucGVuZGluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbHVyZSB0byBzZXQgcG93ZXJvZmYgdGltZXIuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoIWlzU2V0dGluZyhjb21tYW5kLnR5cGUpICYmIGlzVmFsaWQoY29tbWFuZC50eXBlKSAmJiBjb21tYW5kLnR5cGUgIT0gQ29tbWFuZFR5cGUuT0ZGKSAgLy8gSUYgdGhpcyBpcyBhIHNldHRpbmcsIHdlJ3JlIGRvbmUuXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIC8vIE5vdyB3cml0ZSB0aGUgbW9kZSBzZXQgXHJcbiAgICAgICAgICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRTZXR0aW5nIG5ldyBtb2RlIDpcIiArIGNvbW1hbmQudHlwZSk7XHJcbiAgICAgICAgICAgICAgICBwYWNrZXQgPSBtYWtlTW9kZVJlcXVlc3QoY29tbWFuZC50eXBlKTtcclxuICAgICAgICAgICAgICAgIGlmIChwYWNrZXQgPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbW1hbmQucGVuZGluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgICAgIGxvZy5lcnJvcihcIkNvdWxkIG5vdCBnZW5lcmF0ZSBtb2RidXMgcGFja2V0IGZvciBjb21tYW5kXCIsIGNvbW1hbmQpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9IGF3YWl0IFNlbmRBbmRSZXNwb25zZShwYWNrZXQpO1xyXG4gICAgICAgICAgICAgICAgY29tbWFuZC5yZXF1ZXN0ID0gcGFja2V0O1xyXG4gICAgICAgICAgICAgICAgY29tbWFuZC5hbnN3ZXIgPSByZXNwb25zZTtcclxuXHJcbiAgICAgICAgICAgICAgICBpZiAoIXBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDApKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29tbWFuZC5lcnJvciA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgY29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGFsbCByZWdpc3RlcnMgd2VyZSB3cml0dGVuXCIpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgICAgIC8vIFNvbWUgY29tbWFuZHMgcmVxdWlyZSBTVEFSVCBjb21tYW5kIHRvIGJlIGdpdmVuXHJcbiAgICAgICAgICAgICAgICBzd2l0Y2ggKGNvbW1hbmQudHlwZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuICAgICAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlB1bHNlVHJhaW46XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHNsZWVwKDEwMDApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBSZXNldCB0aGUgbWluL21heC9hdmcgdmFsdWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0UmVzZXR0aW5nIHN0YXRpc3RpY3NcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXJ0R2VuID0gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ01ELCBbQ0xFQVJfQVZHX01JTl9NQVhdKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIXBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDEpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLmVycm9yID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmQucGVuZGluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRmFpbHVyZSB0byByZXNldCBzdGF0cy5cIik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlc2V0dGluZyBzdGF0aXN0aWNzXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzdGFydEdlbiA9IG1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtQVUxTRV9DTUQsIDJdKTsgLy8gU3RhcnQgd2l0aCBsb3dcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2Uoc3RhcnRHZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIXBhcnNlRkMxNmNoZWNrZWQocmVzcG9uc2UsIDIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLmVycm9yID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmQucGVuZGluZyA9IGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGFsbCByZWdpc3RlcnMgd2VyZSB3cml0dGVuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdFJlc2V0dGluZyBzdGF0aXN0aWNzXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzdGFydEdlbiA9IG1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtQVUxTRV9DTUQsIDFdKTsgLy8gc3RhcnQgZ2VuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKHN0YXJ0R2VuKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFwYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCAyKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tbWFuZC5lcnJvciA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kLnBlbmRpbmcgPSBmYWxzZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBhbGwgcmVnaXN0ZXJzIHdlcmUgd3JpdHRlblwiKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH0gLy8gc3dpdGNoXHJcblxyXG4gICAgICAgICAgICAgICAgLy8gRGlzYWJsZSBhdXRvIHBvd2VyIG9mZlxyXG4gICAgICAgICAgICAgICAgbG9nLmRlYnVnKFwiXFx0XFx0RGlzYWJsaW5nIHBvd2VyIG9mZlwiKTtcclxuICAgICAgICAgICAgICAgIHN0YXJ0R2VuID0gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ01ELCBbUkVTRVRfUE9XRVJfT0ZGXSk7XHJcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9IGF3YWl0IFNlbmRBbmRSZXNwb25zZShzdGFydEdlbik7XHJcblxyXG4gICAgICAgICAgICB9IC8vIGlmICghaXNTZXR0aW5nKGNvbW1hbmQudHlwZSkgJiYgaXNWYWxpZChjb21tYW5kLnR5cGUpKSlcclxuXHJcbiAgICAgICAgICAgIGNvbW1hbmQuZXJyb3IgPSBmYWxzZTtcclxuICAgICAgICAgICAgY29tbWFuZC5wZW5kaW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcblxyXG4gICAgICAgICAgICAvLyBDYWxsZXIgZXhwZWN0cyBhIHZhbGlkIHByb3BlcnR5IGluIEdldFN0YXRlKCkgb25jZSBjb21tYW5kIGlzIGV4ZWN1dGVkLlxyXG4gICAgICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWZyZXNoaW5nIGN1cnJlbnQgc3RhdGVcIik7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlZnJlc2goKTtcclxuXHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRDb21wbGV0ZWQgY29tbWFuZCBleGVjdXRlZFwiKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICBsb2cuZXJyb3IoXCIqKiBlcnJvciB3aGlsZSBleGVjdXRpbmcgY29tbWFuZDogXCIgKyBlcnIpO1xyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIE1vZGJ1c0Vycm9yKVxyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIm1vZGJ1c19lcnJvcnNcIl0rKztcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFNlbmQgdGhlIG1lc3NhZ2UgdXNpbmcgQmx1ZXRvb3RoIGFuZCB3YWl0IGZvciBhbiBhbnN3ZXJcclxuICAgICAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IGNvbW1hbmQgbW9kYnVzIFJUVSBwYWNrZXQgdG8gc2VuZFxyXG4gICAgICogQHJldHVybnMge0FycmF5QnVmZmVyfSB0aGUgbW9kYnVzIFJUVSBhbnN3ZXJcclxuICAgICAqL1xyXG4gICAgYXN5bmMgZnVuY3Rpb24gU2VuZEFuZFJlc3BvbnNlKGNvbW1hbmQpIHtcclxuXHJcbiAgICAgICAgaWYgKGNvbW1hbmQgPT0gbnVsbClcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcblxyXG4gICAgICAgIGxvZy5kZWJ1ZyhcIj4+IFwiICsgYnVmMmhleChjb21tYW5kKSk7XHJcblxyXG4gICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJyZXF1ZXN0c1wiXSsrO1xyXG5cclxuICAgICAgICB2YXIgc3RhcnRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICAgICAgYXdhaXQgYnRTdGF0ZS5jaGFyV3JpdGUud3JpdGVWYWx1ZVdpdGhvdXRSZXNwb25zZShjb21tYW5kKTtcclxuICAgICAgICB3aGlsZSAoYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5NRVRFUl9JTklUSUFMSVpJTkcgfHxcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5CVVNZKSB7XHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLnJlc3BvbnNlICE9IG51bGwpIGJyZWFrO1xyXG4gICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzUpKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHZhciBlbmRUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcblxyXG4gICAgICAgIHZhciBhbnN3ZXIgPSBidFN0YXRlLnJlc3BvbnNlPy5zbGljZSgpO1xyXG4gICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSBudWxsO1xyXG5cclxuICAgICAgICBidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VUaW1lXCJdID0gTWF0aC5yb3VuZCgoMS4wICogYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlVGltZVwiXSAqIChidFN0YXRlLnN0YXRzW1wicmVzcG9uc2VzXCJdICUgNTAwKSArIChlbmRUaW1lIC0gc3RhcnRUaW1lKSkgLyAoKGJ0U3RhdGUuc3RhdHNbXCJyZXNwb25zZXNcIl0gJSA1MDApICsgMSkpO1xyXG4gICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJsYXN0UmVzcG9uc2VUaW1lXCJdID0gTWF0aC5yb3VuZChlbmRUaW1lIC0gc3RhcnRUaW1lKSArIFwiIG1zXCI7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcInJlc3BvbnNlc1wiXSsrO1xyXG5cclxuICAgICAgICByZXR1cm4gYW5zd2VyO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQWNxdWlyZSB0aGUgY3VycmVudCBtb2RlIGFuZCBzZXJpYWwgbnVtYmVyIG9mIHRoZSBkZXZpY2UuXHJcbiAgICAgKiAqL1xyXG4gICAgYXN5bmMgZnVuY3Rpb24gbWV0ZXJJbml0KCkge1xyXG4gICAgICAgIHZhciByZXNwb25zZTtcclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk1FVEVSX0lOSVRJQUxJWklORztcclxuICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2UobWFrZVNlcmlhbE51bWJlcigpKTtcclxuICAgICAgICAgICAgYnRTdGF0ZS5tZXRlci5zZXJpYWwgPSBwYXJzZVNlcmlhbE51bWJlcihwYXJzZUZDMyhyZXNwb25zZSkpO1xyXG4gICAgICAgICAgICBsb2cuaW5mbygnXFx0XFx0U2VyaWFsIG51bWJlcjonICsgYnRTdGF0ZS5tZXRlci5zZXJpYWwpO1xyXG5cclxuICAgICAgICAgICAgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2UobWFrZUN1cnJlbnRNb2RlKCkpO1xyXG4gICAgICAgICAgICBidFN0YXRlLm1ldGVyLm1vZGUgPSBwYXJzZUN1cnJlbnRNb2RlKHBhcnNlRkMzKHJlc3BvbnNlKSwgQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKTtcclxuICAgICAgICAgICAgbG9nLmRlYnVnKCdcXHRcXHRDdXJyZW50IG1vZGU6JyArIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcblxyXG4gICAgICAgICAgICByZXNwb25zZSA9IGF3YWl0IFNlbmRBbmRSZXNwb25zZShtYWtlQmF0dGVyeUxldmVsKCkpO1xyXG4gICAgICAgICAgICBidFN0YXRlLm1ldGVyLmJhdHRlcnkgPSBNYXRoLnJvdW5kKHBhcnNlQmF0dGVyeShwYXJzZUZDMyhyZXNwb25zZSkpICogMTAwKSAvIDEwMDtcclxuXHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5JRExFO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgIGxvZy53YXJuKFwiRXJyb3Igd2hpbGUgaW5pdGlhbGl6aW5nIG1ldGVyIDpcIiArIGVycik7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgTW9kYnVzRXJyb3IpXHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKlxyXG4gICAgICogQ2xvc2UgdGhlIGJsdWV0b290aCBpbnRlcmZhY2UgKHVucGFpcilcclxuICAgICAqICovXHJcbiAgICBhc3luYyBmdW5jdGlvbiBkaXNjb25uZWN0KCkge1xyXG4gICAgICAgIGJ0U3RhdGUuY29tbWFuZCA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnREZXZpY2U/LmdhdHQ/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGxvZy53YXJuKFwiKiBDYWxsaW5nIGRpc2Nvbm5lY3Qgb24gYnRkZXZpY2VcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gQXZvaWQgdGhlIGV2ZW50IGZpcmluZyB3aGljaCBtYXkgbGVhZCB0byBhdXRvLXJlY29ubmVjdFxyXG4gICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnREZXZpY2UucmVtb3ZlRXZlbnRMaXN0ZW5lcignZ2F0dHNlcnZlcmRpc2Nvbm5lY3RlZCcsIG9uRGlzY29ubmVjdGVkKTtcclxuICAgICAgICAgICAgICAgICAgICBidFN0YXRlLmJ0RGV2aWNlLmdhdHQuZGlzY29ubmVjdCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2ggeyB9XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLlNUT1BQRUQ7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBFdmVudCBjYWxsZWQgYnkgYnJvd3NlciBCVCBhcGkgd2hlbiB0aGUgZGV2aWNlIGRpc2Nvbm5lY3RcclxuICAgICAqICovXHJcbiAgICBhc3luYyBmdW5jdGlvbiBvbkRpc2Nvbm5lY3RlZCgpIHtcclxuICAgICAgICBsb2cud2FybihcIiogR0FUVCBTZXJ2ZXIgZGlzY29ubmVjdGVkIGV2ZW50LCB3aWxsIHRyeSB0byByZWNvbm5lY3QgKlwiKTtcclxuICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0c1tcIkdBVFQgZGlzY29ubmVjdHNcIl0rKztcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuREVWSUNFX1BBSVJFRDsgLy8gVHJ5IHRvIGF1dG8tcmVjb25uZWN0IHRoZSBpbnRlcmZhY2VzIHdpdGhvdXQgcGFpcmluZ1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogSm9pbnMgdGhlIGFyZ3VtZW50cyBpbnRvIGEgc2luZ2xlIGJ1ZmZlclxyXG4gICAgICogQHJldHVybnMge0J1ZmZlcn0gY29uY2F0ZW5hdGVkIGJ1ZmZlclxyXG4gICAgICovXHJcbiAgICBmdW5jdGlvbiBhcnJheUJ1ZmZlckNvbmNhdCgpIHtcclxuICAgICAgICB2YXIgbGVuZ3RoID0gMDtcclxuICAgICAgICB2YXIgYnVmZmVyID0gbnVsbDtcclxuXHJcbiAgICAgICAgZm9yICh2YXIgaSBpbiBhcmd1bWVudHMpIHtcclxuICAgICAgICAgICAgYnVmZmVyID0gYXJndW1lbnRzW2ldO1xyXG4gICAgICAgICAgICBsZW5ndGggKz0gYnVmZmVyLmJ5dGVMZW5ndGg7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB2YXIgam9pbmVkID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcclxuICAgICAgICB2YXIgb2Zmc2V0ID0gMDtcclxuXHJcbiAgICAgICAgZm9yIChpIGluIGFyZ3VtZW50cykge1xyXG4gICAgICAgICAgICBidWZmZXIgPSBhcmd1bWVudHNbaV07XHJcbiAgICAgICAgICAgIGpvaW5lZC5zZXQobmV3IFVpbnQ4QXJyYXkoYnVmZmVyKSwgb2Zmc2V0KTtcclxuICAgICAgICAgICAgb2Zmc2V0ICs9IGJ1ZmZlci5ieXRlTGVuZ3RoO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIGpvaW5lZC5idWZmZXI7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBFdmVudCBjYWxsZWQgYnkgYmx1ZXRvb3RoIGNoYXJhY3RlcmlzdGljcyB3aGVuIHJlY2VpdmluZyBkYXRhXHJcbiAgICAgKiBAcGFyYW0ge2FueX0gZXZlbnRcclxuICAgICAqL1xyXG4gICAgZnVuY3Rpb24gaGFuZGxlTm90aWZpY2F0aW9ucyhldmVudCkge1xyXG4gICAgICAgIGxldCB2YWx1ZSA9IGV2ZW50LnRhcmdldC52YWx1ZTtcclxuICAgICAgICBpZiAodmFsdWUgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoJzw8ICcgKyBidWYyaGV4KHZhbHVlLmJ1ZmZlcikpO1xyXG4gICAgICAgICAgICBpZiAoYnRTdGF0ZS5yZXNwb25zZSAhPSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gYXJyYXlCdWZmZXJDb25jYXQoYnRTdGF0ZS5yZXNwb25zZSwgdmFsdWUuYnVmZmVyKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGJ0U3RhdGUucmVzcG9uc2UgPSB2YWx1ZS5idWZmZXIuc2xpY2UoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFRoaXMgZnVuY3Rpb24gd2lsbCBzdWNjZWVkIG9ubHkgaWYgY2FsbGVkIGFzIGEgY29uc2VxdWVuY2Ugb2YgYSB1c2VyLWdlc3R1cmVcclxuICAgICAqIEUuZy4gYnV0dG9uIGNsaWNrLiBUaGlzIGlzIGR1ZSB0byBCbHVlVG9vdGggQVBJIHNlY3VyaXR5IG1vZGVsLlxyXG4gICAgICogKi9cclxuICAgIGFzeW5jIGZ1bmN0aW9uIGJ0UGFpckRldmljZSgpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuQ09OTkVDVElORztcclxuICAgICAgICB2YXIgZm9yY2VTZWxlY3Rpb24gPSBidFN0YXRlLm9wdGlvbnNbXCJmb3JjZURldmljZVNlbGVjdGlvblwiXTtcclxuICAgICAgICBsb2cuZGVidWcoXCJidFBhaXJEZXZpY2UoXCIgKyBmb3JjZVNlbGVjdGlvbiArIFwiKVwiKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBpZiAodHlwZW9mIChuYXZpZ2F0b3IuYmx1ZXRvb3RoPy5nZXRBdmFpbGFiaWxpdHkpID09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJpbGl0eSA9IGF3YWl0IG5hdmlnYXRvci5ibHVldG9vdGguZ2V0QXZhaWxhYmlsaXR5KCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWF2YWlsYWJpbGl0eSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGxvZy5lcnJvcihcIkJsdWV0b290aCBub3QgYXZhaWxhYmxlIGluIGJyb3dzZXIuXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkJyb3dzZXIgZG9lcyBub3QgcHJvdmlkZSBibHVldG9vdGhcIik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdmFyIGRldmljZSA9IG51bGw7XHJcblxyXG4gICAgICAgICAgICAvLyBEbyB3ZSBhbHJlYWR5IGhhdmUgcGVybWlzc2lvbj9cclxuICAgICAgICAgICAgaWYgKHR5cGVvZiAobmF2aWdhdG9yLmJsdWV0b290aD8uZ2V0RGV2aWNlcykgPT0gJ2Z1bmN0aW9uJ1xyXG4gICAgICAgICAgICAgICAgJiYgIWZvcmNlU2VsZWN0aW9uKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhdmFpbGFibGVEZXZpY2VzID0gYXdhaXQgbmF2aWdhdG9yLmJsdWV0b290aC5nZXREZXZpY2VzKCk7XHJcbiAgICAgICAgICAgICAgICBhdmFpbGFibGVEZXZpY2VzLmZvckVhY2goZnVuY3Rpb24gKGRldiwgaW5kZXgpIHtcclxuICAgICAgICAgICAgICAgICAgICBsb2cuZGVidWcoXCJGb3VuZCBhdXRob3JpemVkIGRldmljZSA6XCIgKyBkZXYubmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRldi5uYW1lLnN0YXJ0c1dpdGgoXCJNU0NcIikpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRldmljZSA9IGRldjtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgbG9nLmRlYnVnKFwibmF2aWdhdG9yLmJsdWV0b290aC5nZXREZXZpY2VzKCk9XCIgKyBkZXZpY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vIElmIG5vdCwgcmVxdWVzdCBmcm9tIHVzZXJcclxuICAgICAgICAgICAgaWYgKGRldmljZSA9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZXZpY2UgPSBhd2FpdCBuYXZpZ2F0b3IuYmx1ZXRvb3RoXHJcbiAgICAgICAgICAgICAgICAgICAgLnJlcXVlc3REZXZpY2Uoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhY2NlcHRBbGxEZXZpY2VzOiBmYWxzZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsdGVyczogW3sgbmFtZVByZWZpeDogJ01TQycgfV0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsU2VydmljZXM6IFtCbHVlVG9vdGhNU0MuU2VydmljZVV1aWRdXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnRTdGF0ZS5idERldmljZSA9IGRldmljZTtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgICAgIGxvZy5pbmZvKFwiQmx1ZXRvb3RoIGRldmljZSBcIiArIGRldmljZS5uYW1lICsgXCIgY29ubmVjdGVkLlwiKTtcclxuICAgICAgICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICBsb2cud2FybihcIioqIGVycm9yIHdoaWxlIGNvbm5lY3Rpbmc6IFwiICsgZXJyLm1lc3NhZ2UpO1xyXG4gICAgICAgICAgICBidFN0YXRlLmJ0U2VydmljZSA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChidFN0YXRlLmNoYXJSZWFkICE9IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZC5zdG9wTm90aWZpY2F0aW9ucygpO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQgPSBudWxsO1xyXG4gICAgICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IG51bGw7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5FUlJPUjtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImV4Y2VwdGlvbnNcIl0rKztcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBPbmNlIHRoZSBkZXZpY2UgaXMgYXZhaWxhYmxlLCBpbml0aWFsaXplIHRoZSBzZXJ2aWNlIGFuZCB0aGUgMiBjaGFyYWN0ZXJpc3RpY3MgbmVlZGVkLlxyXG4gICAgICogKi9cclxuICAgIGFzeW5jIGZ1bmN0aW9uIGJ0U3Vic2NyaWJlKCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5TVUJTQ1JJQklORztcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcInN1YmNyaWJlc1wiXSsrO1xyXG4gICAgICAgICAgICBsZXQgZGV2aWNlID0gYnRTdGF0ZS5idERldmljZTtcclxuICAgICAgICAgICAgbGV0IHNlcnZlciA9IG51bGw7XHJcblxyXG4gICAgICAgICAgICBpZiAoIWRldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgICAgICBsb2cuZGVidWcoYENvbm5lY3RpbmcgdG8gR0FUVCBTZXJ2ZXIgb24gJHtkZXZpY2UubmFtZX0uLi5gKTtcclxuICAgICAgICAgICAgICAgIGRldmljZS5hZGRFdmVudExpc3RlbmVyKCdnYXR0c2VydmVyZGlzY29ubmVjdGVkJywgb25EaXNjb25uZWN0ZWQpO1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoYnRTdGF0ZS5idFNlcnZpY2U/LmNvbm5lY3RlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBidFN0YXRlLmJ0U2VydmljZS5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuYnRTZXJ2aWNlID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgc2xlZXAoMTAwKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHsgfVxyXG5cclxuICAgICAgICAgICAgICAgIHNlcnZlciA9IGF3YWl0IGRldmljZS5nYXR0LmNvbm5lY3QoKTtcclxuICAgICAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBHQVRUIHNlcnZlcicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgbG9nLmRlYnVnKCdHQVRUIGFscmVhZHkgY29ubmVjdGVkJyk7XHJcbiAgICAgICAgICAgICAgICBzZXJ2ZXIgPSBkZXZpY2UuZ2F0dDtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgYnRTdGF0ZS5idFNlcnZpY2UgPSBhd2FpdCBzZXJ2ZXIuZ2V0UHJpbWFyeVNlcnZpY2UoQmx1ZVRvb3RoTVNDLlNlcnZpY2VVdWlkKTtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuYnRTZXJ2aWNlID09IG51bGwpXHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHQVRUIFNlcnZpY2UgcmVxdWVzdCBmYWlsZWRcIik7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCBTZXJpYWwgc2VydmljZScpO1xyXG4gICAgICAgICAgICBidFN0YXRlLmNoYXJXcml0ZSA9IGF3YWl0IGJ0U3RhdGUuYnRTZXJ2aWNlLmdldENoYXJhY3RlcmlzdGljKEJsdWVUb290aE1TQy5Nb2RidXNSZXF1ZXN0VXVpZCk7XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZygnPiBGb3VuZCB3cml0ZSBjaGFyYWN0ZXJpc3RpYycpO1xyXG4gICAgICAgICAgICBidFN0YXRlLmNoYXJSZWFkID0gYXdhaXQgYnRTdGF0ZS5idFNlcnZpY2UuZ2V0Q2hhcmFjdGVyaXN0aWMoQmx1ZVRvb3RoTVNDLk1vZGJ1c0Fuc3dlclV1aWQpO1xyXG4gICAgICAgICAgICBsb2cuZGVidWcoJz4gRm91bmQgcmVhZCBjaGFyYWN0ZXJpc3RpYycpO1xyXG4gICAgICAgICAgICBidFN0YXRlLnJlc3BvbnNlID0gbnVsbDtcclxuICAgICAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZC5hZGRFdmVudExpc3RlbmVyKCdjaGFyYWN0ZXJpc3RpY3ZhbHVlY2hhbmdlZCcsIGhhbmRsZU5vdGlmaWNhdGlvbnMpO1xyXG4gICAgICAgICAgICBidFN0YXRlLmNoYXJSZWFkLnN0YXJ0Tm90aWZpY2F0aW9ucygpO1xyXG4gICAgICAgICAgICBsb2cuaW5mbygnPiBCbHVldG9vdGggaW50ZXJmYWNlcyByZWFkeS4nKTtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0c1tcImxhc3RfY29ubmVjdFwiXSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgICAgICAgICAgYXdhaXQgc2xlZXAoNTApO1xyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTUVURVJfSU5JVDtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICBsb2cud2FybihcIioqIGVycm9yIHdoaWxlIHN1YnNjcmliaW5nOiBcIiArIGVyci5tZXNzYWdlKTtcclxuICAgICAgICAgICAgaWYgKGJ0U3RhdGUuY2hhclJlYWQgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoYnRTdGF0ZS5idERldmljZT8uZ2F0dD8uY29ubmVjdGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ0U3RhdGUuY2hhclJlYWQuc3RvcE5vdGlmaWNhdGlvbnMoKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgYnRTdGF0ZS5idERldmljZT8uZ2F0dC5kaXNjb25uZWN0KCk7XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikgeyB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYnRTdGF0ZS5jaGFyUmVhZCA9IG51bGw7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuY2hhcldyaXRlID0gbnVsbDtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkRFVklDRV9QQUlSRUQ7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdHNbXCJleGNlcHRpb25zXCJdKys7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogV2hlbiBpZGxlLCB0aGlzIGZ1bmN0aW9uIGlzIGNhbGxlZFxyXG4gICAgICogKi9cclxuICAgIGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2goKSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLkJVU1k7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgLy8gQ2hlY2sgdGhlIG1vZGUgZmlyc3RcclxuICAgICAgICAgICAgdmFyIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKG1ha2VDdXJyZW50TW9kZSgpKTtcclxuICAgICAgICAgICAgdmFyIG1vZGUgPSBwYXJzZUN1cnJlbnRNb2RlKHBhcnNlRkMzKHJlc3BvbnNlKSwgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHJcbiAgICAgICAgICAgIGlmIChtb2RlICE9IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTikge1xyXG4gICAgICAgICAgICAgICAgYnRTdGF0ZS5tZXRlci5tb2RlID0gbW9kZTtcclxuXHJcbiAgICAgICAgICAgICAgICBpZiAoYnRTdGF0ZS5tZXRlci5pc0dlbmVyYXRpb24oKSlcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCByZWZyZXNoR2VuZXJhdGlvbigpO1xyXG5cclxuICAgICAgICAgICAgICAgIGlmIChidFN0YXRlLm1ldGVyLmlzTWVhc3VyZW1lbnQoKSlcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCByZWZyZXNoTWVhc3VyZSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhcIlxcdFxcdEZpbmlzaGVkIHJlZnJlc2hpbmcgY3VycmVudCBzdGF0ZVwiKTtcclxuICAgICAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLklETEU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgICAgbG9nLndhcm4oXCJFcnJvciB3aGlsZSByZWZyZXNoaW5nIG1lYXN1cmVcIiArIGVycik7XHJcbiAgICAgICAgICAgIGJ0U3RhdGUuc3RhdGUgPSBTdGF0ZS5ERVZJQ0VfUEFJUkVEO1xyXG4gICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wiZXhjZXB0aW9uc1wiXSsrO1xyXG4gICAgICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgTW9kYnVzRXJyb3IpXHJcbiAgICAgICAgICAgICAgICBidFN0YXRlLnN0YXRzW1wibW9kYnVzX2Vycm9yc1wiXSsrO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIFJlYWQgdGhlIGxhc3QgbWVhc3VyZSBhbmQgdXBkYXRlIGJ0U3RhdGUubGFzdE1lYXN1cmUgcHJvcGVydHlcclxuICAgICAqICovXHJcbiAgICBhc3luYyBmdW5jdGlvbiByZWZyZXNoTWVhc3VyZSgpIHtcclxuICAgICAgICAvLyBSZWFkIHF1YWxpdHlcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2UobWFrZVF1YWxpdHlCaXRSZXF1ZXN0KCkpO1xyXG4gICAgICAgIHZhciB2YWxpZCA9IGlzUXVhbGl0eVZhbGlkKHBhcnNlRkMzKHJlc3BvbnNlKSk7XHJcblxyXG4gICAgICAgIC8vIFJlYWQgbWVhc3VyZVxyXG4gICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKG1ha2VNZWFzdXJlUmVxdWVzdChidFN0YXRlLm1ldGVyLm1vZGUpKTtcclxuICAgICAgICB2YXIgbWVhcyA9IHBhcnNlTWVhc3VyZShwYXJzZUZDMyhyZXNwb25zZSksIGJ0U3RhdGUubWV0ZXIubW9kZSk7XHJcbiAgICAgICAgbWVhc1tcImVycm9yXCJdID0gIXZhbGlkO1xyXG5cclxuICAgICAgICBidFN0YXRlLmxhc3RNZWFzdXJlID0gbWVhcztcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEdldHMgdGhlIGN1cnJlbnQgdmFsdWVzIGZvciB0aGUgZ2VuZXJhdGVkIFUsSSBmcm9tIHRoZSBkZXZpY2VcclxuICAgICAqICovXHJcbiAgICBhc3luYyBmdW5jdGlvbiByZWZyZXNoR2VuZXJhdGlvbigpIHtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBhd2FpdCBTZW5kQW5kUmVzcG9uc2UobWFrZVNldHBvaW50UmVhZChidFN0YXRlLm1ldGVyLm1vZGUpKTtcclxuICAgICAgICBpZiAocmVzcG9uc2UgIT0gbnVsbCkge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0cyA9IHBhcnNlU2V0cG9pbnRSZWFkKHBhcnNlRkMzKHJlc3BvbnNlKSwgYnRTdGF0ZS5tZXRlci5tb2RlKTtcclxuXHJcbiAgICAgICAgICAgIHJlc3BvbnNlID0gYXdhaXQgU2VuZEFuZFJlc3BvbnNlKG1ha2VHZW5TdGF0dXNSZWFkKCkpO1xyXG4gICAgICAgICAgICByZXN1bHRzW1wiZXJyb3JcIl0gPSAhcGFyc2VHZW5TdGF0dXMocGFyc2VGQzMocmVzcG9uc2UpLCBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG5cclxuICAgICAgICAgICAgYnRTdGF0ZS5sYXN0U2V0cG9pbnQgPSByZXN1bHRzO1xyXG4gICAgICAgIH1cclxuICAgIH0iLCJcclxuLy8gQ3VycmVudCBzdGF0ZSBvZiB0aGUgYmx1ZXRvb3RoXHJcbmNsYXNzIEFQSVN0YXRlIHtcclxuICAgIGNvbnN0cnVjdG9yKCkge1xyXG4gICAgICAgIHRoaXMuc3RhdGUgPSBTdGF0ZS5OT1RfQ09OTkVDVEVEO1xyXG4gICAgICAgIHRoaXMucHJldl9zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7XHJcbiAgICAgICAgdGhpcy5zdGF0ZV9jcHQgPSAwO1xyXG5cclxuICAgICAgICB0aGlzLnN0YXJ0ZWQgPSBmYWxzZTsgLy8gU3RhdGUgbWFjaGluZSBzdGF0dXNcclxuICAgICAgICB0aGlzLnN0b3BSZXF1ZXN0ID0gZmFsc2U7IC8vIFRvIHJlcXVlc3QgZGlzY29ubmVjdFxyXG4gICAgICAgIHRoaXMubGFzdE1lYXN1cmUgPSB7fTsgLy8gQXJyYXkgd2l0aCBcIk1lYXN1cmVOYW1lXCIgOiB2YWx1ZVxyXG4gICAgICAgIHRoaXMubGFzdFNldHBvaW50ID0ge307IC8vIEFycmF5IHdpdGggXCJTZXRwb2ludFR5cGVcIiA6IHZhbHVlXHJcblxyXG4gICAgICAgIC8vIHN0YXRlIG9mIGNvbm5lY3RlZCBtZXRlclxyXG4gICAgICAgIHRoaXMubWV0ZXIgPSBuZXcgTWV0ZXJTdGF0ZSgpO1xyXG5cclxuICAgICAgICAvLyBsYXN0IG1vZGJ1cyBSVFUgY29tbWFuZFxyXG4gICAgICAgIHRoaXMuY29tbWFuZCA9IG51bGw7XHJcblxyXG4gICAgICAgIC8vIGxhc3QgbW9kYnVzIFJUVSBhbnN3ZXJcclxuICAgICAgICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcclxuXHJcbiAgICAgICAgLy8gYmx1ZXRvb3RoIHByb3BlcnRpZXNcclxuICAgICAgICB0aGlzLmNoYXJSZWFkID0gbnVsbDtcclxuICAgICAgICB0aGlzLmNoYXJXcml0ZSA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5idFNlcnZpY2UgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuYnREZXZpY2UgPSBudWxsO1xyXG5cclxuICAgICAgICAvLyBnZW5lcmFsIHN0YXRpc3RpY3MgZm9yIGRlYnVnZ2luZ1xyXG4gICAgICAgIHRoaXMuc3RhdHMgPSB7XHJcbiAgICAgICAgICAgIFwicmVxdWVzdHNcIjogMCxcclxuICAgICAgICAgICAgXCJyZXNwb25zZXNcIjogMCxcclxuICAgICAgICAgICAgXCJtb2RidXNfZXJyb3JzXCI6IDAsXHJcbiAgICAgICAgICAgIFwiR0FUVCBkaXNjb25uZWN0c1wiOiAwLFxyXG4gICAgICAgICAgICBcImV4Y2VwdGlvbnNcIjogMCxcclxuICAgICAgICAgICAgXCJzdWJjcmliZXNcIjogMCxcclxuICAgICAgICAgICAgXCJjb21tYW5kc1wiOiAwLFxyXG4gICAgICAgICAgICBcInJlc3BvbnNlVGltZVwiOiAwLjAsXHJcbiAgICAgICAgICAgIFwibGFzdFJlc3BvbnNlVGltZVwiOiAwLjAsXHJcbiAgICAgICAgICAgIFwibGFzdF9jb25uZWN0XCI6IG5ldyBEYXRlKDIwMjAsIDEsIDEpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0aGlzLm9wdGlvbnMgPSB7XHJcbiAgICAgICAgICAgIFwiZm9yY2VEZXZpY2VTZWxlY3Rpb25cIiA6IHRydWVcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn0iLCIvKipcclxuICogQ29tbWFuZCB0byB0aGUgbWV0ZXIsIG1heSBpbmNsdWRlIHNldHBvaW50XHJcbiAqICovXHJcbiBjbGFzcyBDb21tYW5kIHtcclxuICAgIC8qKlxyXG4gICAgICogQ3JlYXRlcyBhIG5ldyBjb21tYW5kXHJcbiAgICAgKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjdHlwZVxyXG4gICAgICovXHJcbiAgICBjb25zdHJ1Y3RvcihjdHlwZSA9IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTikge1xyXG4gICAgICAgIHRoaXMudHlwZSA9IHBhcnNlSW50KGN0eXBlKTtcclxuICAgICAgICB0aGlzLnNldHBvaW50ID0gbnVsbDtcclxuICAgICAgICB0aGlzLnNldHBvaW50MiA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5lcnJvciA9IGZhbHNlO1xyXG4gICAgICAgIHRoaXMucGVuZGluZyA9IHRydWU7XHJcbiAgICAgICAgdGhpcy5yZXF1ZXN0ID0gbnVsbDtcclxuICAgICAgICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBzdGF0aWMgQ3JlYXRlTm9TUChjdHlwZSlcclxuICAgIHtcclxuICAgICAgICB2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG4gICAgICAgIHJldHVybiBjbWQ7XHJcbiAgICB9XHJcbiAgICBzdGF0aWMgQ3JlYXRlT25lU1AoY3R5cGUsIHNldHBvaW50KVxyXG4gICAge1xyXG4gICAgICAgIHZhciBjbWQgPSBuZXcgQ29tbWFuZChjdHlwZSk7XHJcbiAgICAgICAgY21kLnNldHBvaW50ID0gcGFyc2VGbG9hdChzZXRwb2ludCk7XHJcbiAgICAgICAgcmV0dXJuIGNtZDtcclxuICAgIH1cclxuICAgIHN0YXRpYyBDcmVhdGVUd29TUChjdHlwZSwgc2V0MSwgc2V0MilcclxuICAgIHtcclxuICAgICAgICB2YXIgY21kID0gbmV3IENvbW1hbmQoY3R5cGUpO1xyXG4gICAgICAgIGNtZC5zZXRwb2ludCA9IHBhcnNlRmxvYXQoc2V0MSk7XHJcbiAgICAgICAgY21kLnNldHBvaW50MiA9IHBhcnNlRmxvYXQoc2V0Mik7O1xyXG4gICAgICAgIHJldHVybiBjbWQ7XHJcbiAgICB9XHJcblxyXG4gICAgdG9TdHJpbmcoKSB7XHJcbiAgICAgICAgcmV0dXJuIFwiVHlwZTogXCIgKyBQYXJzZShDb21tYW5kVHlwZSwgdGhpcy50eXBlKSArIFwiLCBzZXRwb2ludDpcIiArIHRoaXMuc2V0cG9pbnQgKyBcIiwgc2V0cG9pbnQyOiBcIiArIHRoaXMuc2V0cG9pbnQyICsgXCIsIHBlbmRpbmc6XCIgKyB0aGlzLnBlbmRpbmcgKyBcIiwgZXJyb3I6XCIgKyB0aGlzLmVycm9yO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogR2V0cyB0aGUgZGVmYXVsdCBzZXRwb2ludCBmb3IgdGhpcyBjb21tYW5kIHR5cGVcclxuICAgICAqIEByZXR1cm5zIHtBcnJheX0gc2V0cG9pbnQocykgZXhwZWN0ZWRcclxuICAgICAqL1xyXG4gICAgZGVmYXVsdFNldHBvaW50KCkge1xyXG4gICAgICAgIHN3aXRjaCAodGhpcy50eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1RlbXBlcmF0dXJlICjCsEMpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1Y6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVm9sdGFnZSAoViknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbVY6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVm9sdGFnZSAobVYpJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdDdXJyZW50IChtQSknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnSW1iYWxhbmNlIChtVi9WKSc6IDAuMCB9O1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnRnJlcXVlbmN5IChIeiknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdQdWxzZXMgY291bnQnOiAwLCAnRnJlcXVlbmN5IChIeiknOiAwLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVVRocmVzaG9sZF9GOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1V0aHJlc2hvbGQgKFYpJzogMi4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NlbnNpdGl2aXR5X3VTOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1NlbnNpYmlsaXR5ICh1UyknOiAyLjAgfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfQ29sZEp1bmN0aW9uOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ0NvbGQganVuY3Rpb24gY29tcGVuc2F0aW9uJzogMC4wIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1Vsb3c6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4geyAnVSBsb3cgKFYpJzogMC4wIC8gTUFYX1VfR0VOIH07XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1VoaWdoOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJ1UgaGlnaCAoViknOiA1LjAgLyBNQVhfVV9HRU4gfTtcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfU2h1dGRvd25EZWxheTpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7ICdEZWxheSAocyknOiA2MCAqIDUgfTtcclxuICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgIHJldHVybiB7fTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpc0dlbmVyYXRpb24oKSB7XHJcbiAgICAgICAgcmV0dXJuIGlzR2VuZXJhdGlvbih0aGlzLnR5cGUpO1xyXG4gICAgfVxyXG4gICAgaXNNZWFzdXJlbWVudCgpIHtcclxuICAgICAgICByZXR1cm4gaXNNZWFzdXJlbWVudCh0aGlzLnR5cGUpO1xyXG4gICAgfVxyXG4gICAgaXNTZXR0aW5nKCkge1xyXG4gICAgICAgIHJldHVybiBpc1NldHRpbmcodGhpcy50eXBlKTtcclxuICAgIH1cclxuICAgIGlzVmFsaWQoKSB7XHJcbiAgICAgICAgcmV0dXJuIChpc01lYXN1cmVtZW50KHRoaXMudHlwZSkgfHwgaXNHZW5lcmF0aW9uKHRoaXMudHlwZSkgfHwgaXNTZXR0aW5nKHRoaXMudHlwZSkpO1xyXG4gICAgfVxyXG59XHJcblxyXG5cclxuLy8gVGhlc2UgZnVuY3Rpb25zIG11c3QgZXhpc3Qgc3RhbmQtYWxvbmUgb3V0c2lkZSBDb21tYW5kIG9iamVjdCBhcyB0aGlzIG9iamVjdCBtYXkgY29tZSBmcm9tIEpTT04gd2l0aG91dCB0aGVtIVxyXG5mdW5jdGlvbiBpc0dlbmVyYXRpb24oY3R5cGUpIHtcclxuICAgIHJldHVybiAoY3R5cGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgY3R5cGUgPCBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzTWVhc3VyZW1lbnQoY3R5cGUpIHtcclxuICAgIHJldHVybiAoY3R5cGUgPiBDb21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgY3R5cGUgPCBDb21tYW5kVHlwZS5SRVNFUlZFRCk7XHJcbn1cclxuZnVuY3Rpb24gaXNTZXR0aW5nKGN0eXBlKSB7XHJcbiAgICByZXR1cm4gKGN0eXBlID09IENvbW1hbmRUeXBlLk9GRiB8fCBjdHlwZSA+IENvbW1hbmRUeXBlLlNFVFRJTkdfUkVTRVJWRUQpO1xyXG59XHJcbmZ1bmN0aW9uIGlzVmFsaWQoY3R5cGUpIHtcclxuICAgIHJldHVybiAoaXNNZWFzdXJlbWVudChjdHlwZSkgfHwgaXNHZW5lcmF0aW9uKGN0eXBlKSB8fCBpc1NldHRpbmcoY3R5cGUpKTtcclxufVxyXG4iLCIvKipcclxuICogQ3VycmVudCBzdGF0ZSBvZiB0aGUgbWV0ZXJcclxuICogKi9cclxuIGNsYXNzIE1ldGVyU3RhdGUge1xyXG4gICAgY29uc3RydWN0b3IoKSB7XHJcbiAgICAgICAgdGhpcy5maXJtd2FyZSA9IFwiXCI7IC8vIEZpcm13YXJlIHZlcnNpb25cclxuICAgICAgICB0aGlzLnNlcmlhbCA9IFwiXCI7IC8vIFNlcmlhbCBudW1iZXJcclxuICAgICAgICB0aGlzLm1vZGUgPSBDb21tYW5kVHlwZS5OT05FX1VOS05PV047XHJcbiAgICAgICAgdGhpcy5iYXR0ZXJ5ID0gMC4wO1xyXG4gICAgfVxyXG5cclxuICAgIGlzTWVhc3VyZW1lbnQoKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubW9kZSA+IENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTiAmJiB0aGlzLm1vZGUgPCBDb21tYW5kVHlwZS5PRkY7XHJcbiAgICB9XHJcblxyXG4gICAgaXNHZW5lcmF0aW9uKCkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLm1vZGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgdGhpcy5tb2RlIDwgQ29tbWFuZFR5cGUuR0VOX1JFU0VSVkVEO1xyXG4gICAgfVxyXG59IiwiLyoqXHJcbiAqIENvbW1hbmQgdHlwZSwgYWthIG1vZGUgdmFsdWUgdG8gYmUgd3JpdHRlbiBpbnRvIE1TQyBjdXJyZW50IHN0YXRlIHJlZ2lzdGVyXHJcbiAqICovXHJcbiBjb25zdCBDb21tYW5kVHlwZSA9IHtcclxuICAgIE5PTkVfVU5LTk9XTjogMCwgLyoqKiBNRUFTVVJJTkcgRkVBVFVSRVMgQUZURVIgVEhJUyBQT0lOVCAqKioqKioqL1xyXG4gICAgbUFfcGFzc2l2ZTogMSxcclxuICAgIG1BX2FjdGl2ZTogMixcclxuICAgIFY6IDMsXHJcbiAgICBtVjogNCxcclxuICAgIFRIRVJNT19KOiA1LCAvLyBUZXJtb2NvcHBpZVxyXG4gICAgVEhFUk1PX0s6IDYsXHJcbiAgICBUSEVSTU9fVDogNyxcclxuICAgIFRIRVJNT19FOiA4LFxyXG4gICAgVEhFUk1PX0w6IDksXHJcbiAgICBUSEVSTU9fTjogMTAsXHJcbiAgICBUSEVSTU9fUjogMTEsXHJcbiAgICBUSEVSTU9fUzogMTIsXHJcbiAgICBUSEVSTU9fQjogMTMsXHJcbiAgICBQVDEwMF8yVzogMTQsIC8vIFJURCAyIGZpbGlcclxuICAgIFBUMTAwXzNXOiAxNSxcclxuICAgIFBUMTAwXzRXOiAxNixcclxuICAgIFBUNTAwXzJXOiAxNyxcclxuICAgIFBUNTAwXzNXOiAxOCxcclxuICAgIFBUNTAwXzRXOiAxOSxcclxuICAgIFBUMTAwMF8yVzogMjAsXHJcbiAgICBQVDEwMDBfM1c6IDIxLFxyXG4gICAgUFQxMDAwXzRXOiAyMixcclxuICAgIEN1NTBfMlc6IDIzLFxyXG4gICAgQ3U1MF8zVzogMjQsXHJcbiAgICBDdTUwXzRXOiAyNSxcclxuICAgIEN1MTAwXzJXOiAyNixcclxuICAgIEN1MTAwXzNXOiAyNyxcclxuICAgIEN1MTAwXzRXOiAyOCxcclxuICAgIE5pMTAwXzJXOiAyOSxcclxuICAgIE5pMTAwXzNXOiAzMCxcclxuICAgIE5pMTAwXzRXOiAzMSxcclxuICAgIE5pMTIwXzJXOiAzMixcclxuICAgIE5pMTIwXzNXOiAzMyxcclxuICAgIE5pMTIwXzRXOiAzNCxcclxuICAgIExvYWRDZWxsOiAzNSwgICAvLyBDZWxsZSBkaSBjYXJpY29cclxuICAgIEZyZXF1ZW5jeTogMzYsICAvLyBGcmVxdWVuemFcclxuICAgIFB1bHNlVHJhaW46IDM3LCAvLyBDb250ZWdnaW8gaW1wdWxzaVxyXG4gICAgUkVTRVJWRUQ6IDM4LFxyXG4gICAgUkVTRVJWRURfMjogNDAsXHJcbiAgICBPRkY6IDEwMCwgLy8gKioqKioqKioqIEdFTkVSQVRJT04gQUZURVIgVEhJUyBQT0lOVCAqKioqKioqKioqKioqKioqKi9cclxuICAgIEdFTl9tQV9wYXNzaXZlOiAxMDEsXHJcbiAgICBHRU5fbUFfYWN0aXZlOiAxMDIsXHJcbiAgICBHRU5fVjogMTAzLFxyXG4gICAgR0VOX21WOiAxMDQsXHJcbiAgICBHRU5fVEhFUk1PX0o6IDEwNSxcclxuICAgIEdFTl9USEVSTU9fSzogMTA2LFxyXG4gICAgR0VOX1RIRVJNT19UOiAxMDcsXHJcbiAgICBHRU5fVEhFUk1PX0U6IDEwOCxcclxuICAgIEdFTl9USEVSTU9fTDogMTA5LFxyXG4gICAgR0VOX1RIRVJNT19OOiAxMTAsXHJcbiAgICBHRU5fVEhFUk1PX1I6IDExMSxcclxuICAgIEdFTl9USEVSTU9fUzogMTEyLFxyXG4gICAgR0VOX1RIRVJNT19COiAxMTMsXHJcbiAgICBHRU5fUFQxMDBfMlc6IDExNCxcclxuICAgIEdFTl9QVDUwMF8yVzogMTE3LFxyXG4gICAgR0VOX1BUMTAwMF8yVzogMTIwLFxyXG4gICAgR0VOX0N1NTBfMlc6IDEyMyxcclxuICAgIEdFTl9DdTEwMF8yVzogMTI2LFxyXG4gICAgR0VOX05pMTAwXzJXOiAxMjksXHJcbiAgICBHRU5fTmkxMjBfMlc6IDEzMixcclxuICAgIEdFTl9Mb2FkQ2VsbDogMTM1LFxyXG4gICAgR0VOX0ZyZXF1ZW5jeTogMTM2LFxyXG4gICAgR0VOX1B1bHNlVHJhaW46IDEzNyxcclxuICAgIEdFTl9SRVNFUlZFRDogMTM4LFxyXG4gICAgLy8gU3BlY2lhbCBzZXR0aW5ncyBiZWxvdyB0aGlzIHBvaW50c1xyXG4gICAgU0VUVElOR19SRVNFUlZFRDogMTAwMCxcclxuICAgIFNFVF9VVGhyZXNob2xkX0Y6IDEwMDEsXHJcbiAgICBTRVRfU2Vuc2l0aXZpdHlfdVM6IDEwMDIsXHJcbiAgICBTRVRfQ29sZEp1bmN0aW9uOiAxMDAzLFxyXG4gICAgU0VUX1Vsb3c6IDEwMDQsXHJcbiAgICBTRVRfVWhpZ2g6IDEwMDUsXHJcbiAgICBTRVRfU2h1dGRvd25EZWxheTogMTAwNlxyXG59O1xyXG5cclxuLypcclxuICogTW9kYnVzIHJlZ2lzdGVycyBtYXAuIEVhY2ggcmVnaXN0ZXIgaXMgMiBieXRlcyB3aWRlLlxyXG4gKi9cclxuY29uc3QgTVNDUmVnaXN0ZXJzID0ge1xyXG4gICAgU2VyaWFsTnVtYmVyOiAxMCxcclxuICAgIEN1cnJlbnRNb2RlOiAxMDAsXHJcbiAgICBNZWFzdXJlRmxhZ3M6IDEwMixcclxuICAgIENNRDogMTA3LFxyXG4gICAgQVVYMTogMTA4LFxyXG4gICAgTG9hZENlbGxNZWFzdXJlOiAxMTQsXHJcbiAgICBUZW1wTWVhc3VyZTogMTIwLFxyXG4gICAgUnRkVGVtcGVyYXR1cmVNZWFzdXJlOiAxMjgsXHJcbiAgICBSdGRSZXNpc3RhbmNlTWVhc3VyZTogMTMwLFxyXG4gICAgRnJlcXVlbmN5TWVhc3VyZTogMTY0LFxyXG4gICAgTWluTWVhc3VyZTogMTMyLFxyXG4gICAgTWF4TWVhc3VyZTogMTM0LFxyXG4gICAgSW5zdGFudE1lYXN1cmU6IDEzNixcclxuICAgIFBvd2VyT2ZmRGVsYXk6IDE0MixcclxuICAgIFBvd2VyT2ZmUmVtYWluaW5nOiAxNDYsXHJcbiAgICBQdWxzZU9GRk1lYXN1cmU6IDE1MCxcclxuICAgIFB1bHNlT05NZWFzdXJlOiAxNTIsXHJcbiAgICBTZW5zaWJpbGl0eV91U19PRkY6IDE2NixcclxuICAgIFNlbnNpYmlsaXR5X3VTX09OOiAxNjgsXHJcbiAgICBCYXR0ZXJ5TWVhc3VyZTogMTc0LFxyXG4gICAgQ29sZEp1bmN0aW9uOiAxOTAsXHJcbiAgICBUaHJlc2hvbGRVX0ZyZXE6IDE5MixcclxuICAgIEdlbmVyYXRpb25GbGFnczogMjAyLFxyXG4gICAgR0VOX0NNRDogMjA3LFxyXG4gICAgR0VOX0FVWDE6IDIwOCxcclxuICAgIEN1cnJlbnRTZXRwb2ludDogMjEwLFxyXG4gICAgVm9sdGFnZVNldHBvaW50OiAyMTIsXHJcbiAgICBMb2FkQ2VsbFNldHBvaW50OiAyMTYsXHJcbiAgICBUaGVybW9UZW1wZXJhdHVyZVNldHBvaW50OiAyMjAsXHJcbiAgICBSVERUZW1wZXJhdHVyZVNldHBvaW50OiAyMjgsXHJcbiAgICBQdWxzZXNDb3VudDogMjUyLFxyXG4gICAgRnJlcXVlbmN5VElDSzE6IDI1NCxcclxuICAgIEZyZXF1ZW5jeVRJQ0syOiAyNTYsXHJcbiAgICBHZW5VaGlnaFBlcmM6IDI2MixcclxuICAgIEdlblVsb3dQZXJjOiAyNjRcclxufTtcclxuXHJcblxyXG4vKlxyXG4gKiBCbHVldG9vdGggY29uc3RhbnRzXHJcbiAqL1xyXG5jb25zdCBCbHVlVG9vdGhNU0MgPSB7XHJcbiAgICBTZXJ2aWNlVXVpZDogJzAwMDNjZGQwLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMScsIC8vIGJsdWV0b290aCBtb2RidXMgUlRVIHNlcnZpY2UgZm9yIFNlbmVjYSBNU0NcclxuICAgIE1vZGJ1c0Fuc3dlclV1aWQ6ICcwMDAzY2RkMS0wMDAwLTEwMDAtODAwMC0wMDgwNWY5YjAxMzEnLCAgICAgLy8gbW9kYnVzIFJUVSBhbnN3ZXJzXHJcbiAgICBNb2RidXNSZXF1ZXN0VXVpZDogJzAwMDNjZGQyLTAwMDAtMTAwMC04MDAwLTAwODA1ZjliMDEzMScgICAgLy8gbW9kYnVzIFJUVSByZXF1ZXN0c1xyXG59O1xyXG5cclxuLypcclxuICogSW50ZXJuYWwgc3RhdGUgbWFjaGluZSBkZXNjcmlwdGlvbnNcclxuICovXHJcbmNvbnN0IFN0YXRlID0ge1xyXG4gICAgTk9UX0NPTk5FQ1RFRDogJ05vdCBjb25uZWN0ZWQnLFxyXG4gICAgQ09OTkVDVElORzogJ0JsdWV0b290aCBkZXZpY2UgcGFpcmluZy4uLicsXHJcbiAgICBERVZJQ0VfUEFJUkVEOiAnRGV2aWNlIHBhaXJlZCcsXHJcbiAgICBTVUJTQ1JJQklORzogJ0JsdWV0b290aCBpbnRlcmZhY2VzIGNvbm5lY3RpbmcuLi4nLFxyXG4gICAgSURMRTogJ0lkbGUnLFxyXG4gICAgQlVTWTogJ0J1c3knLFxyXG4gICAgRVJST1I6ICdFcnJvcicsXHJcbiAgICBTVE9QUElORzogJ0Nsb3NpbmcgQlQgaW50ZXJmYWNlcy4uLicsXHJcbiAgICBTVE9QUEVEOiAnU3RvcHBlZCcsXHJcbiAgICBNRVRFUl9JTklUOiAnTWV0ZXIgY29ubmVjdGVkJyxcclxuICAgIE1FVEVSX0lOSVRJQUxJWklORzogJ1JlYWRpbmcgbWV0ZXIgc3RhdGUuLi4nXHJcbn07IiwiJ3VzZSBzdHJpY3QnO1xyXG5cclxuY29uc3QgbG9nID0gcmVxdWlyZShcImxvZ2xldmVsXCIpO1xyXG5cclxucmVxdWlyZSgnLi9jb25zdGFudHMnKTtcclxucmVxdWlyZSgnLi9jbGFzc2VzL0FQSVN0YXRlJyk7XHJcbnJlcXVpcmUoJy4vY2xhc3Nlcy9Db21tYW5kJyk7XHJcbnJlcXVpcmUoJy4vY2xhc3Nlcy9NZXRlclN0YXRlJyk7XHJcbnJlcXVpcmUoJy4vbW9kYnVzUnR1Jyk7XHJcbnJlcXVpcmUoJy4vc2VuZWNhTW9kYnVzJyk7XHJcbnJlcXVpcmUoJy4vbWV0ZXJQdWJsaWNBUEknKTtcclxucmVxdWlyZSgnLi9ibHVldG9vdGgnKTtcclxucmVxdWlyZSgnLi91dGlscycpO1xyXG5cclxuLyoqXHJcbiAqIFRoZSBtYWluIG9iamVjdCB3aXRoIHRoZSBzdGF0ZSBvZiBtZXRlciwgYmx1ZXRvb3RoLCBjb21tYW5kLi4uXHJcbiAqICovXHJcbmxldCBidFN0YXRlID0gbmV3IEFQSVN0YXRlKCk7XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IHsgU3RvcCwgUGFpciwgRXhlY3V0ZSwgR2V0U3RhdGUsIFN0YXRlLCBDb21tYW5kVHlwZSwgQ29tbWFuZCwgUGFyc2UsIGxvZywgR2V0U3RhdGVKU09OLCBFeGVjdXRlSlNPTiB9O1xyXG4iLCIvKlxyXG4gKiBUaGlzIGZpbGUgY29udGFpbnMgdGhlIHB1YmxpYyBBUEkgb2YgdGhlIG1ldGVyLCBpLmUuIHRoZSBmdW5jdGlvbnMgZGVzaWduZWRcclxuICogdG8gYmUgY2FsbGVkIGZyb20gdGhpcmQgcGFydHkgY29kZS5cclxuICogMS0gUGFpcigpIDogYm9vbFxyXG4gKiAyLSBFeGVjdXRlKENvbW1hbmQpIDogYm9vbCArIEpTT04gdmVyc2lvblxyXG4gKiAzLSBTdG9wKCkgOiBib29sXHJcbiAqIDQtIEdldFN0YXRlKCkgOiBhcnJheSArIEpTT04gdmVyc2lvblxyXG4gKiA1LSBTaW1wbGVFeGVjdXRlKENvbW1hbmQpIDogcmV0dXJucyB0aGUgdXBkYXRlZCBtZWFzdXJlbWVudCBvciBudWxsXHJcbiAqL1xyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgYSBjb3B5IG9mIHRoZSBjdXJyZW50IHN0YXRlXHJcbiAqIEByZXR1cm5zIHthcnJheX0gc3RhdHVzIG9mIG1ldGVyXHJcbiAqL1xyXG4gYXN5bmMgZnVuY3Rpb24gR2V0U3RhdGUoKSB7XHJcbiAgICBsZXQgcmVhZHkgPSBmYWxzZTtcclxuICAgIGxldCBpbml0aWFsaXppbmcgPSBmYWxzZTtcclxuICAgIHN3aXRjaCAoYnRTdGF0ZS5zdGF0ZSkge1xyXG4gICAgICAgIC8vIFN0YXRlcyByZXF1aXJpbmcgdXNlciBpbnB1dFxyXG4gICAgICAgIGNhc2UgU3RhdGUuRVJST1I6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5TVE9QUEVEOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuTk9UX0NPTk5FQ1RFRDpcclxuICAgICAgICAgICAgcmVhZHkgPSBmYWxzZTtcclxuICAgICAgICAgICAgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuQlVTWTpcclxuICAgICAgICBjYXNlIFN0YXRlLklETEU6XHJcbiAgICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcclxuICAgICAgICAgICAgaW5pdGlhbGl6aW5nID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGNhc2UgU3RhdGUuQ09OTkVDVElORzpcclxuICAgICAgICBjYXNlIFN0YXRlLkRFVklDRV9QQUlSRUQ6XHJcbiAgICAgICAgY2FzZSBTdGF0ZS5NRVRFUl9JTklUOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuTUVURVJfSU5JVElBTElaSU5HOlxyXG4gICAgICAgIGNhc2UgU3RhdGUuU1VCU0NSSUJJTkc6XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IHRydWU7XHJcbiAgICAgICAgICAgIHJlYWR5ID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJlYWR5ID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGluaXRpYWxpemluZyA9IGZhbHNlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBcImxhc3RTZXRwb2ludFwiOiBidFN0YXRlLmxhc3RTZXRwb2ludCxcclxuICAgICAgICBcImxhc3RNZWFzdXJlXCI6IGJ0U3RhdGUubGFzdE1lYXN1cmUsXHJcbiAgICAgICAgXCJkZXZpY2VOYW1lXCI6IGJ0U3RhdGUuYnREZXZpY2UgPyBidFN0YXRlLmJ0RGV2aWNlLm5hbWUgOiBcIlwiLFxyXG4gICAgICAgIFwiZGV2aWNlU2VyaWFsXCI6IGJ0U3RhdGUubWV0ZXI/LnNlcmlhbCxcclxuICAgICAgICBcInN0YXRzXCI6IGJ0U3RhdGUuc3RhdHMsXHJcbiAgICAgICAgXCJkZXZpY2VNb2RlXCI6IGJ0U3RhdGUubWV0ZXI/Lm1vZGUsXHJcbiAgICAgICAgXCJzdGF0dXNcIjogYnRTdGF0ZS5zdGF0ZSxcclxuICAgICAgICBcImJhdHRlcnlMZXZlbFwiOiBidFN0YXRlLm1ldGVyPy5iYXR0ZXJ5LFxyXG4gICAgICAgIFwicmVhZHlcIjogcmVhZHksXHJcbiAgICAgICAgXCJpbml0aWFsaXppbmdcIjogaW5pdGlhbGl6aW5nXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKipcclxuICogUHJvdmlkZWQgZm9yIGNvbXBhdGliaWxpdHkgd2l0aCBCbGF6b3JcclxuICogQHJldHVybnMge3N0cmluZ30gSlNPTiBzdGF0ZSBvYmplY3RcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEdldFN0YXRlSlNPTigpIHtcclxuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBHZXRTdGF0ZSgpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4ZWN1dGUgY29tbWFuZCB3aXRoIHNldHBvaW50cywgSlNPTiB2ZXJzaW9uXHJcbiAqIEBwYXJhbSB7c3RyaW5nfSBqc29uQ29tbWFuZCB0aGUgY29tbWFuZCB0byBleGVjdXRlXHJcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEpTT04gY29tbWFuZCBvYmplY3RcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEV4ZWN1dGVKU09OKGpzb25Db21tYW5kKSB7XHJcbiAgICBsZXQgY29tbWFuZCA9IEpTT04ucGFyc2UoanNvbkNvbW1hbmQpO1xyXG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGF3YWl0IEV4ZWN1dGUoY29tbWFuZCkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBTaW1wbGVFeGVjdXRlSlNPTihqc29uQ29tbWFuZCkge1xyXG4gICAgbGV0IGNvbW1hbmQgPSBKU09OLnBhcnNlKGpzb25Db21tYW5kKTtcclxuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhd2FpdCBTaW1wbGVFeGVjdXRlKGNvbW1hbmQpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4ZWN1dGUgYSBjb21tYW5kIGFuZCByZXR1cm5zIHRoZSBtZWFzdXJlbWVudCBvciBzZXRwb2ludCB3aXRoIGVycm9yIGZsYWcgYW5kIG1lc3NhZ2VcclxuICogQHBhcmFtIHtDb21tYW5kfSBjb21tYW5kXHJcbiAqL1xyXG4gYXN5bmMgZnVuY3Rpb24gU2ltcGxlRXhlY3V0ZShjb21tYW5kKSB7XHJcbiAgICBjb25zdCBTSU1QTEVfRVhFQ1VURV9USU1FT1VUX1MgPSA0MDtcclxuICAgIHZhciBjciA9IG5ldyBDb21tYW5kUmVzdWx0KCk7XHJcblxyXG4gICAgbG9nLmluZm8oXCJTaW1wbGVFeGVjdXRlIGNhbGxlZC4uLlwiKTtcclxuXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKVxyXG4gICAgICAgIGNvbW1hbmQucGVuZGluZyA9IHRydWU7IC8vIEluIGNhc2UgY2FsbGVyIGRvZXMgbm90IHNldCBwZW5kaW5nIGZsYWdcclxuXHJcbiAgICAvLyBGYWlscyBpZiBub3QgcGFpcmVkLlxyXG4gICAgaWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuICAgICAgICBjci5lcnJvciA9IHRydWU7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiRGV2aWNlIGlzIG5vdCBwYWlyZWRcIjtcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQW5vdGhlciBjb21tYW5kIG1heSBiZSBwZW5kaW5nLlxyXG4gICAgdmFyIGRlbGF5UyA9IDA7XHJcbiAgICBpZiAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcpIHtcclxuICAgICAgICBjci5lcnJvciA9IHRydWU7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiQW5vdGhlciBjb21tYW5kIGlzIHBlbmRpbmdcIjtcclxuICAgICAgICBsb2cud2Fybihjci5tZXNzYWdlKTtcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG4gICAgYnRTdGF0ZS5jb21tYW5kID0gY29tbWFuZDsgXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvclRpbWVvdXQoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQsIFNJTVBMRV9FWEVDVVRFX1RJTUVPVVRfUyk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKGNvbW1hbmQuZXJyb3IgfHwgY29tbWFuZC5wZW5kaW5nKSAgLy8gQ2hlY2sgaWYgZXJyb3Igb3IgdGltZW91dHNcclxuICAgIHtcclxuICAgICAgICBjci5lcnJvciA9IHRydWU7XHJcbiAgICAgICAgY3IubWVzc2FnZSA9IFwiRXJyb3Igd2hpbGUgZXhlY3V0aW5nIHRoZSBjb21tYW5kLlwiXHJcbiAgICAgICAgbG9nLndhcm4oY3IubWVzc2FnZSk7XHJcbiAgICAgICAgXHJcbiAgICAgICAgLy8gUmVzZXQgdGhlIGFjdGl2ZSBjb21tYW5kXHJcbiAgICAgICAgYnRTdGF0ZS5jb21tYW5kID0gbnVsbDtcclxuICAgICAgICBcclxuICAgICAgICByZXR1cm4gY3I7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3RhdGUgaXMgdXBkYXRlZCBieSBleGVjdXRlIGNvbW1hbmRcclxuICAgIGlmIChpc0dlbmVyYXRpb24oY29tbWFuZC50eXBlKSlcclxuICAgIHtcclxuICAgICAgICBjci52YWx1ZSA9IGJ0U3RhdGUubGFzdFNldHBvaW50W1wiVmFsdWVcIl07XHJcbiAgICB9XHJcbiAgICBlbHNlIGlmIChpc01lYXN1cmVtZW50KGNvbW1hbmQudHlwZSkpXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSBidFN0YXRlLmxhc3RNZWFzdXJlW1wiVmFsdWVcIl07XHJcbiAgICB9XHJcbiAgICBlbHNlXHJcbiAgICB7XHJcbiAgICAgICAgY3IudmFsdWUgPSAwLjA7IC8vIFNldHRpbmdzLlxyXG4gICAgfVxyXG4gICAgY3IubWVzc2FnZSA9IFwiQ29tbWFuZCBleGVjdXRlZCBzdWNjZXNzZnVsbHlcIjtcclxuICAgIHJldHVybiBjcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEV4dGVybmFsIGludGVyZmFjZSB0byByZXF1aXJlIGEgY29tbWFuZCB0byBiZSBleGVjdXRlZC5cclxuICogVGhlIGJsdWV0b290aCBkZXZpY2UgcGFpcmluZyB3aW5kb3cgd2lsbCBvcGVuIGlmIGRldmljZSBpcyBub3QgY29ubmVjdGVkLlxyXG4gKiBUaGlzIG1heSBmYWlsIGlmIGNhbGxlZCBvdXRzaWRlIGEgdXNlciBnZXN0dXJlLlxyXG4gKiBAcGFyYW0ge0NvbW1hbmR9IGNvbW1hbmRcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIEV4ZWN1dGUoY29tbWFuZCkge1xyXG4gICAgbG9nLmluZm8oXCJFeGVjdXRlIGNhbGxlZC4uLlwiKTtcclxuXHJcbiAgICBpZiAoY29tbWFuZCAhPSBudWxsKVxyXG4gICAgICAgIGNvbW1hbmQucGVuZGluZyA9IHRydWU7XHJcblxyXG4gICAgdmFyIGNwdCA9IDA7XHJcbiAgICB3aGlsZSAoYnRTdGF0ZS5jb21tYW5kICE9IG51bGwgJiYgYnRTdGF0ZS5jb21tYW5kLnBlbmRpbmcgJiYgY3B0IDwgMzApIHtcclxuICAgICAgICBsb2cuZGVidWcoXCJXYWl0aW5nIGZvciBjdXJyZW50IGNvbW1hbmQgdG8gY29tcGxldGUuLi5cIik7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMTAwMCk7XHJcbiAgICAgICAgY3B0Kys7XHJcbiAgICB9XHJcbiAgICBsb2cuaW5mbyhcIlNldHRpbmcgbmV3IGNvbW1hbmQgOlwiICsgY29tbWFuZCk7XHJcbiAgICBidFN0YXRlLmNvbW1hbmQgPSBjb21tYW5kO1xyXG5cclxuICAgIC8vIFN0YXJ0IHRoZSByZWd1bGFyIHN0YXRlIG1hY2hpbmVcclxuICAgIGlmICghYnRTdGF0ZS5zdGFydGVkKSB7XHJcbiAgICAgICAgYnRTdGF0ZS5zdGF0ZSA9IFN0YXRlLk5PVF9DT05ORUNURUQ7XHJcbiAgICAgICAgYXdhaXQgc3RhdGVNYWNoaW5lKCk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gV2FpdCBmb3IgY29tcGxldGlvbiBvZiB0aGUgY29tbWFuZCwgb3IgaGFsdCBvZiB0aGUgc3RhdGUgbWFjaGluZVxyXG4gICAgaWYgKGNvbW1hbmQgIT0gbnVsbCkge1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoKCkgPT4gIWNvbW1hbmQucGVuZGluZyB8fCBidFN0YXRlLnN0YXRlID09IFN0YXRlLlNUT1BQRUQpO1xyXG4gICAgfVxyXG4gICAgLy8gUmV0dXJuIHRoZSBjb21tYW5kIG9iamVjdCByZXN1bHRcclxuICAgIHJldHVybiBjb21tYW5kO1xyXG59XHJcblxyXG4vKipcclxuICogTVVTVCBCRSBDQUxMRUQgRlJPTSBBIFVTRVIgR0VTVFVSRSBFVkVOVCBIQU5ETEVSXHJcbiAgKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiBtZXRlciBpcyByZWFkeSB0byBleGVjdXRlIGNvbW1hbmRcclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gUGFpcihmb3JjZVNlbGVjdGlvbj1mYWxzZSkge1xyXG4gICAgbG9nLmluZm8oXCJQYWlyKFwiK2ZvcmNlU2VsZWN0aW9uK1wiKSBjYWxsZWQuLi5cIik7XHJcbiAgICBcclxuICAgIGJ0U3RhdGUub3B0aW9uc1tcImZvcmNlRGV2aWNlU2VsZWN0aW9uXCJdID0gZm9yY2VTZWxlY3Rpb247XHJcblxyXG4gICAgaWYgKCFidFN0YXRlLnN0YXJ0ZWQpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDtcclxuICAgICAgICBzdGF0ZU1hY2hpbmUoKTsgLy8gU3RhcnQgaXRcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuRVJST1IpIHtcclxuICAgICAgICBidFN0YXRlLnN0YXRlID0gU3RhdGUuTk9UX0NPTk5FQ1RFRDsgLy8gVHJ5IHRvIHJlc3RhcnRcclxuICAgIH1cclxuICAgIGF3YWl0IHdhaXRGb3IoKCkgPT4gYnRTdGF0ZS5zdGF0ZSA9PSBTdGF0ZS5JRExFIHx8IGJ0U3RhdGUuc3RhdGUgPT0gU3RhdGUuU1RPUFBFRCk7XHJcbiAgICBsb2cuaW5mbyhcIlBhaXJpbmcgY29tcGxldGVkLCBzdGF0ZSA6XCIsIGJ0U3RhdGUuc3RhdGUpO1xyXG4gICAgcmV0dXJuIChidFN0YXRlLnN0YXRlICE9IFN0YXRlLlNUT1BQRUQpO1xyXG59XHJcblxyXG4vKipcclxuICogU3RvcHMgdGhlIHN0YXRlIG1hY2hpbmUgYW5kIGRpc2Nvbm5lY3RzIGJsdWV0b290aC5cclxuICogKi9cclxuYXN5bmMgZnVuY3Rpb24gU3RvcCgpIHtcclxuICAgIGxvZy5pbmZvKFwiU3RvcCByZXF1ZXN0IHJlY2VpdmVkXCIpO1xyXG5cclxuICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlO1xyXG4gICAgYXdhaXQgc2xlZXAoMTAwKTtcclxuXHJcbiAgICB3aGlsZShidFN0YXRlLnN0YXJ0ZWQgfHwgKGJ0U3RhdGUuc3RhdGUgIT0gU3RhdGUuU1RPUFBFRCAmJiBidFN0YXRlLnN0YXRlICE9IFN0YXRlLk5PVF9DT05ORUNURUQpKVxyXG4gICAge1xyXG4gICAgICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSB0cnVlOyAgICBcclxuICAgICAgICBhd2FpdCBzbGVlcCgxMDApO1xyXG4gICAgfVxyXG5cclxuICAgIGJ0U3RhdGUuc3RvcFJlcXVlc3QgPSBmYWxzZTtcclxuICAgIGxvZy53YXJuKFwiU3RvcHBlZCBvbiByZXF1ZXN0LlwiKTtcclxuICAgIHJldHVybiB0cnVlO1xyXG59IiwiY29uc3QgU0VORUNBX01CX1NMQVZFX0lEID0gMjU7IC8vIE1vZGJ1cyBSVFUgc2xhdmUgSURcclxuXHJcbi8qKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgU1RVRkYgKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiovXHJcbmNsYXNzIENvbW1hbmRSZXN1bHRcclxue1xyXG4gICAgdmFsdWUgPSAwLjA7XHJcbiAgICByZXN1bHQgPSBmYWxzZTtcclxuICAgIG1lc3NhZ2UgPSBcIlwiO1xyXG59XHJcblxyXG5jbGFzcyBNb2RidXNFcnJvciBleHRlbmRzIEVycm9yIHtcclxuICAgIC8qKlxyXG4gICAgICogQ3JlYXRlcyBhIG5ldyBtb2RidXMgZXJyb3JcclxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBtZXNzYWdlIG1lc3NhZ2VcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBmYyBmdW5jdGlvbiBjb2RlXHJcbiAgICAgKi9cclxuICAgIGNvbnRydWN0b3IobWVzc2FnZSwgZmMpIHtcclxuICAgICAgICB0aGlzLm1lc3NhZ2UgPSBtZXNzYWdlO1xyXG4gICAgICAgIHRoaXMuZmMgPSBmYztcclxuICAgIH1cclxufVxyXG4vKipcclxuICogUmV0dXJucyB0aGUgNCBieXRlcyBDUkMgY29kZSBmcm9tIHRoZSBidWZmZXIgY29udGVudHNcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBjcmMxNihidWZmZXIpIHtcclxuICAgIHZhciBjcmMgPSAweEZGRkY7XHJcbiAgICB2YXIgb2RkO1xyXG5cclxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgY3JjID0gY3JjIF4gYnVmZmVyW2ldO1xyXG5cclxuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IDg7IGorKykge1xyXG4gICAgICAgICAgICBvZGQgPSBjcmMgJiAweDAwMDE7XHJcbiAgICAgICAgICAgIGNyYyA9IGNyYyA+PiAxO1xyXG4gICAgICAgICAgICBpZiAob2RkKSB7XHJcbiAgICAgICAgICAgICAgICBjcmMgPSBjcmMgXiAweEEwMDE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGNyYztcclxufVxyXG5cclxuLyoqXHJcbiAqIE1ha2UgYSBNb2RidXMgUmVhZCBIb2xkaW5nIFJlZ2lzdGVycyAoRkM9MDMpIHRvIHNlcmlhbCBwb3J0XHJcbiAqIFxyXG4gKiBAcGFyYW0ge251bWJlcn0gSUQgc2xhdmUgSURcclxuICogQHBhcmFtIHtudW1iZXJ9IGNvdW50IG51bWJlciBvZiByZWdpc3RlcnMgdG8gcmVhZFxyXG4gKiBAcGFyYW0ge251bWJlcn0gcmVnaXN0ZXIgc3RhcnRpbmcgcmVnaXN0ZXJcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VGQzMoSUQsIGNvdW50LCByZWdpc3Rlcikge1xyXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKDgpO1xyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhidWZmZXIpO1xyXG4gICAgdmlldy5zZXRVaW50OCgwLCBJRCk7XHJcbiAgICB2aWV3LnNldFVpbnQ4KDEsIDMpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoMiwgcmVnaXN0ZXIsIGZhbHNlKTtcclxuICAgIHZpZXcuc2V0VWludDE2KDQsIGNvdW50LCBmYWxzZSk7XHJcbiAgICB2YXIgY3JjID0gY3JjMTYobmV3IFVpbnQ4QXJyYXkoYnVmZmVyLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmlldy5zZXRVaW50MTYoNiwgY3JjLCB0cnVlKTtcclxuICAgIHJldHVybiBidWZmZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXcml0ZSBhIE1vZGJ1cyBcIlByZXNldCBNdWx0aXBsZSBSZWdpc3RlcnNcIiAoRkM9MTYpIHRvIHNlcmlhbCBwb3J0LlxyXG4gKlxyXG4gKiBAcGFyYW0ge251bWJlcn0gYWRkcmVzcyB0aGUgc2xhdmUgdW5pdCBhZGRyZXNzLlxyXG4gKiBAcGFyYW0ge251bWJlcn0gZGF0YUFkZHJlc3MgdGhlIERhdGEgQWRkcmVzcyBvZiB0aGUgZmlyc3QgcmVnaXN0ZXIuXHJcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IHRoZSBhcnJheSBvZiB2YWx1ZXMgdG8gd3JpdGUgdG8gcmVnaXN0ZXJzLlxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUZDMTYoYWRkcmVzcywgZGF0YUFkZHJlc3MsIGFycmF5KSB7XHJcbiAgICBjb25zdCBjb2RlID0gMTY7XHJcblxyXG4gICAgLy8gc2FuaXR5IGNoZWNrXHJcbiAgICBpZiAodHlwZW9mIGFkZHJlc3MgPT09IFwidW5kZWZpbmVkXCIgfHwgdHlwZW9mIGRhdGFBZGRyZXNzID09PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGxldCBkYXRhTGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xyXG5cclxuICAgIGNvbnN0IGNvZGVMZW5ndGggPSA3ICsgMiAqIGRhdGFMZW5ndGg7XHJcbiAgICBjb25zdCBidWYgPSBuZXcgQXJyYXlCdWZmZXIoY29kZUxlbmd0aCArIDIpOyAvLyBhZGQgMiBjcmMgYnl0ZXNcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1Zik7XHJcblxyXG4gICAgZHYuc2V0VWludDgoMCwgYWRkcmVzcyk7XHJcbiAgICBkdi5zZXRVaW50OCgxLCBjb2RlKTtcclxuICAgIGR2LnNldFVpbnQxNigyLCBkYXRhQWRkcmVzcywgZmFsc2UpO1xyXG4gICAgZHYuc2V0VWludDE2KDQsIGRhdGFMZW5ndGgsIGZhbHNlKTtcclxuICAgIGR2LnNldFVpbnQ4KDYsIGRhdGFMZW5ndGggKiAyKTtcclxuXHJcbiAgICAvLyBjb3B5IGNvbnRlbnQgb2YgYXJyYXkgdG8gYnVmXHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGFMZW5ndGg7IGkrKykge1xyXG4gICAgICAgIGR2LnNldFVpbnQxNig3ICsgMiAqIGksIGFycmF5W2ldLCBmYWxzZSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gYWRkIGNyYyBieXRlcyB0byBidWZmZXJcclxuICAgIGR2LnNldFVpbnQxNihjb2RlTGVuZ3RoLCBjcmMxNihidWYuc2xpY2UoMCwgLTIpKSwgdHJ1ZSk7XHJcbiAgICByZXR1cm4gYnVmO1xyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgcmVnaXN0ZXJzIHZhbHVlcyBmcm9tIGEgRkMwMyBhbnN3ZXIgYnkgUlRVIHNsYXZlXHJcbiAqIFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VGQzMocmVzcG9uc2UpIHtcclxuICAgIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHJlc3BvbnNlKTtcclxuICAgIHZhciBjb250ZW50cyA9IFtdO1xyXG5cclxuICAgIC8vIEludmFsaWQgbW9kYnVzIHBhY2tldFxyXG4gICAgaWYgKHJlc3BvbnNlLmxlbmd0aCA8IDUpXHJcbiAgICAgICAgcmV0dXJuO1xyXG5cclxuICAgIHZhciBjb21wdXRlZF9jcmMgPSBjcmMxNihuZXcgVWludDhBcnJheShyZXNwb25zZS5zbGljZSgwLCAtMikpKTtcclxuICAgIHZhciBhY3R1YWxfY3JjID0gdmlldy5nZXRVaW50MTYodmlldy5ieXRlTGVuZ3RoIC0gMiwgdHJ1ZSk7XHJcblxyXG4gICAgaWYgKGNvbXB1dGVkX2NyYyAhPSBhY3R1YWxfY3JjKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1vZGJ1c0Vycm9yKFwiV3JvbmcgQ1JDXCIsIDMpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50OCgwKTtcclxuICAgIGlmIChhZGRyZXNzICE9IFNFTkVDQV9NQl9TTEFWRV9JRCkge1xyXG4gICAgICAgIHRocm93IG5ldyBNb2RidXNFcnJvcihcIldyb25nIHNsYXZlIElEIDpcIiArIGFkZHJlc3MsIDMpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcbiAgICBpZiAoZmMgPiAxMjgpIHtcclxuICAgICAgICB2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gYnkgc2xhdmU6XCIgKyBleHAsIDMpO1xyXG4gICAgfVxyXG4gICAgaWYgKGZjICE9IDMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIExlbmd0aCBpbiBieXRlcyBmcm9tIHNsYXZlIGFuc3dlclxyXG4gICAgdmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDgoMik7XHJcblxyXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKGxlbmd0aCk7XHJcbiAgICBjb25zdCByZWdpc3RlcnMgPSBuZXcgRGF0YVZpZXcoYnVmZmVyKTtcclxuXHJcbiAgICBmb3IgKHZhciBpID0gMzsgaSA8IHZpZXcuYnl0ZUxlbmd0aCAtIDI7IGkgKz0gMikge1xyXG4gICAgICAgIHZhciByZWcgPSB2aWV3LmdldEludDE2KGksIGZhbHNlKTtcclxuICAgICAgICByZWdpc3RlcnMuc2V0SW50MTYoaSAtIDMsIHJlZywgZmFsc2UpO1xyXG4gICAgICAgIHZhciBpZHggPSAoKGkgLSAzKSAvIDIgKyAxKTtcclxuICAgICAgICBsb2cuZGVidWcoXCJcXHRcXHRSZWdpc3RlciBcIiArIGlkeCArIFwiL1wiICsgKGxlbmd0aCAvIDIpICsgXCIgPSBcIiArIHJlZyk7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIHJlZ2lzdGVycztcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIGlmIHRoZSBGQzE2IHJlc3BvbnNlIGlzIGNvcnJlY3QgKENSQywgcmV0dXJuIGNvZGUpIEFORCBvcHRpb25hbGx5IG1hdGNoaW5nIHRoZSByZWdpc3RlciBsZW5ndGggZXhwZWN0ZWRcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2UgbW9kYnVzIHJ0dSByYXcgb3V0cHV0XHJcbiAqIEBwYXJhbSB7bnVtYmVyfSBleHBlY3RlZCBudW1iZXIgb2YgZXhwZWN0ZWQgd3JpdHRlbiByZWdpc3RlcnMgZnJvbSBzbGF2ZS4gSWYgPD0wLCBpdCB3aWxsIG5vdCBiZSBjaGVja2VkLlxyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiBhbGwgcmVnaXN0ZXJzIGhhdmUgYmVlbiB3cml0dGVuXHJcbiAqL1xyXG5mdW5jdGlvbiBwYXJzZUZDMTZjaGVja2VkKHJlc3BvbnNlLCBleHBlY3RlZCkge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBwYXJzZUZDMTYocmVzcG9uc2UpO1xyXG4gICAgICAgIHJldHVybiAoZXhwZWN0ZWQgPD0gMCB8fCByZXN1bHRbMV0gPT09IGV4cGVjdGVkKTsgLy8gY2hlY2sgaWYgbGVuZ3RoIGlzIG1hdGNoaW5nXHJcbiAgICB9XHJcbiAgICBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbG9nLmVycm9yKFwiRkMxNiBhbnN3ZXIgZXJyb3JcIiwgZXJyKTtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQYXJzZSB0aGUgYW5zd2VyIHRvIHRoZSB3cml0ZSBtdWx0aXBsZSByZWdpc3RlcnMgZnJvbSB0aGUgc2xhdmVcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlRkMxNihyZXNwb25zZSkge1xyXG4gICAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhyZXNwb25zZSk7XHJcbiAgICB2YXIgY29udGVudHMgPSBbXTtcclxuXHJcbiAgICBpZiAocmVzcG9uc2UubGVuZ3RoIDwgMylcclxuICAgICAgICByZXR1cm47XHJcblxyXG4gICAgdmFyIHNsYXZlID0gdmlldy5nZXRVaW50OCgwKTtcclxuXHJcbiAgICBpZiAoc2xhdmUgIT0gU0VORUNBX01CX1NMQVZFX0lEKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBmYyA9IHZpZXcuZ2V0VWludDgoMSk7XHJcbiAgICBpZiAoZmMgPiAxMjgpIHtcclxuICAgICAgICB2YXIgZXhwID0gdmlldy5nZXRVaW50OCgyKTtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJFeGNlcHRpb24gOlwiICsgZXhwLCAxNik7XHJcbiAgICB9XHJcbiAgICBpZiAoZmMgIT0gMTYpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBGQyA6XCIgKyBmYywgZmMpO1xyXG4gICAgfVxyXG4gICAgdmFyIGNvbXB1dGVkX2NyYyA9IGNyYzE2KG5ldyBVaW50OEFycmF5KHJlc3BvbnNlLnNsaWNlKDAsIC0yKSkpO1xyXG4gICAgdmFyIGFjdHVhbF9jcmMgPSB2aWV3LmdldFVpbnQxNih2aWV3LmJ5dGVMZW5ndGggLSAyLCB0cnVlKTtcclxuXHJcbiAgICBpZiAoY29tcHV0ZWRfY3JjICE9IGFjdHVhbF9jcmMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTW9kYnVzRXJyb3IoXCJXcm9uZyBDUkNcIiwgMTYpO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBhZGRyZXNzID0gdmlldy5nZXRVaW50MTYoMiwgZmFsc2UpO1xyXG4gICAgdmFyIGxlbmd0aCA9IHZpZXcuZ2V0VWludDE2KDQsIGZhbHNlKTtcclxuICAgIHJldHVybiBbYWRkcmVzcywgbGVuZ3RoXTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEhlbHBlciBmdW5jdGlvbiB0byBkdW1wIGFycmF5YnVmZmVyIGFzIGhleCBzdHJpbmdcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gYnVmZmVyXHJcbiAqL1xyXG5mdW5jdGlvbiBidWYyaGV4KGJ1ZmZlcikgeyAvLyBidWZmZXIgaXMgYW4gQXJyYXlCdWZmZXJcclxuICAgIHJldHVybiBbLi4ubmV3IFVpbnQ4QXJyYXkoYnVmZmVyKV1cclxuICAgICAgICAubWFwKHggPT4geC50b1N0cmluZygxNikucGFkU3RhcnQoMiwgJzAnKSlcclxuICAgICAgICAuam9pbignICcpO1xyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIENvbnZlcnRzIHdpdGggYnl0ZSBzd2FwIEFCIENEIC0+IENEIEFCIC0+IGZsb2F0XHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG4gZnVuY3Rpb24gZ2V0RmxvYXQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0SW50MTYoMCwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0ICsgMiwgZmFsc2UpLCBmYWxzZSk7XHJcbiAgICBkdi5zZXRJbnQxNigyLCBkYXRhVmlldy5nZXRJbnQxNihvZmZzZXQsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgcmV0dXJuIGR2LmdldEZsb2F0MzIoMCwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gVWludDMyXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSBmbG9hdCBpbnRvIHRoZSBidWZmZXJcclxuICogQHJldHVybnMge251bWJlcn0gY29udmVydGVkIHZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRVaW50MzJMRUJTKGRhdGFWaWV3LCBvZmZzZXQpIHtcclxuICAgIGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICBjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuICAgIGR2LnNldEludDE2KDAsIGRhdGFWaWV3LmdldEludDE2KG9mZnNldCArIDIsIGZhbHNlKSwgZmFsc2UpO1xyXG4gICAgZHYuc2V0SW50MTYoMiwgZGF0YVZpZXcuZ2V0SW50MTYob2Zmc2V0LCBmYWxzZSksIGZhbHNlKTtcclxuICAgIHJldHVybiBkdi5nZXRVaW50MzIoMCwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgLT4gZmxvYXRcclxuICogQHBhcmFtIHtEYXRhVmlld30gZGF0YVZpZXcgYnVmZmVyIHZpZXcgdG8gcHJvY2Vzc1xyXG4gKiBAcGFyYW0ge251bWJlcn0gb2Zmc2V0IGJ5dGUgbnVtYmVyIHdoZXJlIGZsb2F0IGludG8gdGhlIGJ1ZmZlclxyXG4gKiBAcGFyYW0ge3ZhbHVlfSBudW1iZXIgdmFsdWUgdG8gc2V0XHJcbiAqL1xyXG5mdW5jdGlvbiBzZXRGbG9hdDMyTEVCUyhkYXRhVmlldywgb2Zmc2V0LCB2YWx1ZSkge1xyXG4gICAgY29uc3QgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIGNvbnN0IGR2ID0gbmV3IERhdGFWaWV3KGJ1ZmYpO1xyXG4gICAgZHYuc2V0RmxvYXQzMigwLCB2YWx1ZSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0LCBkdi5nZXRJbnQxNigyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGRhdGFWaWV3LnNldEludDE2KG9mZnNldCArIDIsIGR2LmdldEludDE2KDAsIGZhbHNlKSwgZmFsc2UpO1xyXG59XHJcblxyXG4vKipcclxuICogQ29udmVydHMgd2l0aCBieXRlIHN3YXAgQUIgQ0QgLT4gQ0QgQUIgXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IGRhdGFWaWV3IGJ1ZmZlciB2aWV3IHRvIHByb2Nlc3NcclxuICogQHBhcmFtIHtudW1iZXJ9IG9mZnNldCBieXRlIG51bWJlciB3aGVyZSB1aW50MzIgaW50byB0aGUgYnVmZmVyXHJcbiAqIEBwYXJhbSB7bnVtYmVyfSB2YWx1ZSB2YWx1ZSB0byBzZXRcclxuICovXHJcbmZ1bmN0aW9uIHNldFVpbnQzMkxFQlMoZGF0YVZpZXcsIG9mZnNldCwgdmFsdWUpIHtcclxuICAgIGNvbnN0IGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIoNCk7XHJcbiAgICBjb25zdCBkdiA9IG5ldyBEYXRhVmlldyhidWZmKTtcclxuICAgIGR2LnNldFVpbnQzMigwLCB2YWx1ZSwgZmFsc2UpO1xyXG4gICAgZGF0YVZpZXcuc2V0SW50MTYob2Zmc2V0LCBkdi5nZXRJbnQxNigyLCBmYWxzZSksIGZhbHNlKTtcclxuICAgIGRhdGFWaWV3LnNldEludDE2KG9mZnNldCArIDIsIGR2LmdldEludDE2KDAsIGZhbHNlKSwgZmFsc2UpO1xyXG59XHJcbiIsIi8qXG4qIGxvZ2xldmVsIC0gaHR0cHM6Ly9naXRodWIuY29tL3BpbXRlcnJ5L2xvZ2xldmVsXG4qXG4qIENvcHlyaWdodCAoYykgMjAxMyBUaW0gUGVycnlcbiogTGljZW5zZWQgdW5kZXIgdGhlIE1JVCBsaWNlbnNlLlxuKi9cbihmdW5jdGlvbiAocm9vdCwgZGVmaW5pdGlvbikge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGlmICh0eXBlb2YgZGVmaW5lID09PSAnZnVuY3Rpb24nICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKGRlZmluaXRpb24pO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIG1vZHVsZSA9PT0gJ29iamVjdCcgJiYgbW9kdWxlLmV4cG9ydHMpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBkZWZpbml0aW9uKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcm9vdC5sb2cgPSBkZWZpbml0aW9uKCk7XG4gICAgfVxufSh0aGlzLCBmdW5jdGlvbiAoKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICAvLyBTbGlnaHRseSBkdWJpb3VzIHRyaWNrcyB0byBjdXQgZG93biBtaW5pbWl6ZWQgZmlsZSBzaXplXG4gICAgdmFyIG5vb3AgPSBmdW5jdGlvbigpIHt9O1xuICAgIHZhciB1bmRlZmluZWRUeXBlID0gXCJ1bmRlZmluZWRcIjtcbiAgICB2YXIgaXNJRSA9ICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlKSAmJiAodHlwZW9mIHdpbmRvdy5uYXZpZ2F0b3IgIT09IHVuZGVmaW5lZFR5cGUpICYmIChcbiAgICAgICAgL1RyaWRlbnRcXC98TVNJRSAvLnRlc3Qod2luZG93Lm5hdmlnYXRvci51c2VyQWdlbnQpXG4gICAgKTtcblxuICAgIHZhciBsb2dNZXRob2RzID0gW1xuICAgICAgICBcInRyYWNlXCIsXG4gICAgICAgIFwiZGVidWdcIixcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgIFwid2FyblwiLFxuICAgICAgICBcImVycm9yXCJcbiAgICBdO1xuXG4gICAgLy8gQ3Jvc3MtYnJvd3NlciBiaW5kIGVxdWl2YWxlbnQgdGhhdCB3b3JrcyBhdCBsZWFzdCBiYWNrIHRvIElFNlxuICAgIGZ1bmN0aW9uIGJpbmRNZXRob2Qob2JqLCBtZXRob2ROYW1lKSB7XG4gICAgICAgIHZhciBtZXRob2QgPSBvYmpbbWV0aG9kTmFtZV07XG4gICAgICAgIGlmICh0eXBlb2YgbWV0aG9kLmJpbmQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiBtZXRob2QuYmluZChvYmopO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gRnVuY3Rpb24ucHJvdG90eXBlLmJpbmQuY2FsbChtZXRob2QsIG9iaik7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgLy8gTWlzc2luZyBiaW5kIHNoaW0gb3IgSUU4ICsgTW9kZXJuaXpyLCBmYWxsYmFjayB0byB3cmFwcGluZ1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEZ1bmN0aW9uLnByb3RvdHlwZS5hcHBseS5hcHBseShtZXRob2QsIFtvYmosIGFyZ3VtZW50c10pO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBUcmFjZSgpIGRvZXNuJ3QgcHJpbnQgdGhlIG1lc3NhZ2UgaW4gSUUsIHNvIGZvciB0aGF0IGNhc2Ugd2UgbmVlZCB0byB3cmFwIGl0XG4gICAgZnVuY3Rpb24gdHJhY2VGb3JJRSgpIHtcbiAgICAgICAgaWYgKGNvbnNvbGUubG9nKSB7XG4gICAgICAgICAgICBpZiAoY29uc29sZS5sb2cuYXBwbHkpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZy5hcHBseShjb25zb2xlLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBJbiBvbGQgSUUsIG5hdGl2ZSBjb25zb2xlIG1ldGhvZHMgdGhlbXNlbHZlcyBkb24ndCBoYXZlIGFwcGx5KCkuXG4gICAgICAgICAgICAgICAgRnVuY3Rpb24ucHJvdG90eXBlLmFwcGx5LmFwcGx5KGNvbnNvbGUubG9nLCBbY29uc29sZSwgYXJndW1lbnRzXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbnNvbGUudHJhY2UpIGNvbnNvbGUudHJhY2UoKTtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCB0aGUgYmVzdCBsb2dnaW5nIG1ldGhvZCBwb3NzaWJsZSBmb3IgdGhpcyBlbnZcbiAgICAvLyBXaGVyZXZlciBwb3NzaWJsZSB3ZSB3YW50IHRvIGJpbmQsIG5vdCB3cmFwLCB0byBwcmVzZXJ2ZSBzdGFjayB0cmFjZXNcbiAgICBmdW5jdGlvbiByZWFsTWV0aG9kKG1ldGhvZE5hbWUpIHtcbiAgICAgICAgaWYgKG1ldGhvZE5hbWUgPT09ICdkZWJ1ZycpIHtcbiAgICAgICAgICAgIG1ldGhvZE5hbWUgPSAnbG9nJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uc29sZSA9PT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyBObyBtZXRob2QgcG9zc2libGUsIGZvciBub3cgLSBmaXhlZCBsYXRlciBieSBlbmFibGVMb2dnaW5nV2hlbkNvbnNvbGVBcnJpdmVzXG4gICAgICAgIH0gZWxzZSBpZiAobWV0aG9kTmFtZSA9PT0gJ3RyYWNlJyAmJiBpc0lFKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhY2VGb3JJRTtcbiAgICAgICAgfSBlbHNlIGlmIChjb25zb2xlW21ldGhvZE5hbWVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBiaW5kTWV0aG9kKGNvbnNvbGUsIG1ldGhvZE5hbWUpO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbnNvbGUubG9nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBiaW5kTWV0aG9kKGNvbnNvbGUsICdsb2cnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBub29wO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gVGhlc2UgcHJpdmF0ZSBmdW5jdGlvbnMgYWx3YXlzIG5lZWQgYHRoaXNgIHRvIGJlIHNldCBwcm9wZXJseVxuXG4gICAgZnVuY3Rpb24gcmVwbGFjZUxvZ2dpbmdNZXRob2RzKGxldmVsLCBsb2dnZXJOYW1lKSB7XG4gICAgICAgIC8qanNoaW50IHZhbGlkdGhpczp0cnVlICovXG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbG9nTWV0aG9kcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdmFyIG1ldGhvZE5hbWUgPSBsb2dNZXRob2RzW2ldO1xuICAgICAgICAgICAgdGhpc1ttZXRob2ROYW1lXSA9IChpIDwgbGV2ZWwpID9cbiAgICAgICAgICAgICAgICBub29wIDpcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGhvZEZhY3RvcnkobWV0aG9kTmFtZSwgbGV2ZWwsIGxvZ2dlck5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRGVmaW5lIGxvZy5sb2cgYXMgYW4gYWxpYXMgZm9yIGxvZy5kZWJ1Z1xuICAgICAgICB0aGlzLmxvZyA9IHRoaXMuZGVidWc7XG4gICAgfVxuXG4gICAgLy8gSW4gb2xkIElFIHZlcnNpb25zLCB0aGUgY29uc29sZSBpc24ndCBwcmVzZW50IHVudGlsIHlvdSBmaXJzdCBvcGVuIGl0LlxuICAgIC8vIFdlIGJ1aWxkIHJlYWxNZXRob2QoKSByZXBsYWNlbWVudHMgaGVyZSB0aGF0IHJlZ2VuZXJhdGUgbG9nZ2luZyBtZXRob2RzXG4gICAgZnVuY3Rpb24gZW5hYmxlTG9nZ2luZ1doZW5Db25zb2xlQXJyaXZlcyhtZXRob2ROYW1lLCBsZXZlbCwgbG9nZ2VyTmFtZSkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSB1bmRlZmluZWRUeXBlKSB7XG4gICAgICAgICAgICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwodGhpcywgbGV2ZWwsIGxvZ2dlck5hbWUpO1xuICAgICAgICAgICAgICAgIHRoaXNbbWV0aG9kTmFtZV0uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBCeSBkZWZhdWx0LCB3ZSB1c2UgY2xvc2VseSBib3VuZCByZWFsIG1ldGhvZHMgd2hlcmV2ZXIgcG9zc2libGUsIGFuZFxuICAgIC8vIG90aGVyd2lzZSB3ZSB3YWl0IGZvciBhIGNvbnNvbGUgdG8gYXBwZWFyLCBhbmQgdGhlbiB0cnkgYWdhaW4uXG4gICAgZnVuY3Rpb24gZGVmYXVsdE1ldGhvZEZhY3RvcnkobWV0aG9kTmFtZSwgbGV2ZWwsIGxvZ2dlck5hbWUpIHtcbiAgICAgICAgLypqc2hpbnQgdmFsaWR0aGlzOnRydWUgKi9cbiAgICAgICAgcmV0dXJuIHJlYWxNZXRob2QobWV0aG9kTmFtZSkgfHxcbiAgICAgICAgICAgICAgIGVuYWJsZUxvZ2dpbmdXaGVuQ29uc29sZUFycml2ZXMuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBMb2dnZXIobmFtZSwgZGVmYXVsdExldmVsLCBmYWN0b3J5KSB7XG4gICAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgICB2YXIgY3VycmVudExldmVsO1xuICAgICAgZGVmYXVsdExldmVsID0gZGVmYXVsdExldmVsID09IG51bGwgPyBcIldBUk5cIiA6IGRlZmF1bHRMZXZlbDtcblxuICAgICAgdmFyIHN0b3JhZ2VLZXkgPSBcImxvZ2xldmVsXCI7XG4gICAgICBpZiAodHlwZW9mIG5hbWUgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgc3RvcmFnZUtleSArPSBcIjpcIiArIG5hbWU7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBuYW1lID09PSBcInN5bWJvbFwiKSB7XG4gICAgICAgIHN0b3JhZ2VLZXkgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIHBlcnNpc3RMZXZlbElmUG9zc2libGUobGV2ZWxOdW0pIHtcbiAgICAgICAgICB2YXIgbGV2ZWxOYW1lID0gKGxvZ01ldGhvZHNbbGV2ZWxOdW1dIHx8ICdzaWxlbnQnKS50b1VwcGVyQ2FzZSgpO1xuXG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIC8vIFVzZSBsb2NhbFN0b3JhZ2UgaWYgYXZhaWxhYmxlXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZVtzdG9yYWdlS2V5XSA9IGxldmVsTmFtZTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIFVzZSBzZXNzaW9uIGNvb2tpZSBhcyBmYWxsYmFja1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHdpbmRvdy5kb2N1bWVudC5jb29raWUgPVxuICAgICAgICAgICAgICAgIGVuY29kZVVSSUNvbXBvbmVudChzdG9yYWdlS2V5KSArIFwiPVwiICsgbGV2ZWxOYW1lICsgXCI7XCI7XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgfVxuXG4gICAgICBmdW5jdGlvbiBnZXRQZXJzaXN0ZWRMZXZlbCgpIHtcbiAgICAgICAgICB2YXIgc3RvcmVkTGV2ZWw7XG5cbiAgICAgICAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gdW5kZWZpbmVkVHlwZSB8fCAhc3RvcmFnZUtleSkgcmV0dXJuO1xuXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgc3RvcmVkTGV2ZWwgPSB3aW5kb3cubG9jYWxTdG9yYWdlW3N0b3JhZ2VLZXldO1xuICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cblxuICAgICAgICAgIC8vIEZhbGxiYWNrIHRvIGNvb2tpZXMgaWYgbG9jYWwgc3RvcmFnZSBnaXZlcyB1cyBub3RoaW5nXG4gICAgICAgICAgaWYgKHR5cGVvZiBzdG9yZWRMZXZlbCA9PT0gdW5kZWZpbmVkVHlwZSkge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgdmFyIGNvb2tpZSA9IHdpbmRvdy5kb2N1bWVudC5jb29raWU7XG4gICAgICAgICAgICAgICAgICB2YXIgbG9jYXRpb24gPSBjb29raWUuaW5kZXhPZihcbiAgICAgICAgICAgICAgICAgICAgICBlbmNvZGVVUklDb21wb25lbnQoc3RvcmFnZUtleSkgKyBcIj1cIik7XG4gICAgICAgICAgICAgICAgICBpZiAobG9jYXRpb24gIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgc3RvcmVkTGV2ZWwgPSAvXihbXjtdKykvLmV4ZWMoY29va2llLnNsaWNlKGxvY2F0aW9uKSlbMV07XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGlnbm9yZSkge31cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBJZiB0aGUgc3RvcmVkIGxldmVsIGlzIG5vdCB2YWxpZCwgdHJlYXQgaXQgYXMgaWYgbm90aGluZyB3YXMgc3RvcmVkLlxuICAgICAgICAgIGlmIChzZWxmLmxldmVsc1tzdG9yZWRMZXZlbF0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICBzdG9yZWRMZXZlbCA9IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gc3RvcmVkTGV2ZWw7XG4gICAgICB9XG5cbiAgICAgIGZ1bmN0aW9uIGNsZWFyUGVyc2lzdGVkTGV2ZWwoKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09IHVuZGVmaW5lZFR5cGUgfHwgIXN0b3JhZ2VLZXkpIHJldHVybjtcblxuICAgICAgICAgIC8vIFVzZSBsb2NhbFN0b3JhZ2UgaWYgYXZhaWxhYmxlXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKHN0b3JhZ2VLZXkpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuXG4gICAgICAgICAgLy8gVXNlIHNlc3Npb24gY29va2llIGFzIGZhbGxiYWNrXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgd2luZG93LmRvY3VtZW50LmNvb2tpZSA9XG4gICAgICAgICAgICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHN0b3JhZ2VLZXkpICsgXCI9OyBleHBpcmVzPVRodSwgMDEgSmFuIDE5NzAgMDA6MDA6MDAgVVRDXCI7XG4gICAgICAgICAgfSBjYXRjaCAoaWdub3JlKSB7fVxuICAgICAgfVxuXG4gICAgICAvKlxuICAgICAgICpcbiAgICAgICAqIFB1YmxpYyBsb2dnZXIgQVBJIC0gc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9waW10ZXJyeS9sb2dsZXZlbCBmb3IgZGV0YWlsc1xuICAgICAgICpcbiAgICAgICAqL1xuXG4gICAgICBzZWxmLm5hbWUgPSBuYW1lO1xuXG4gICAgICBzZWxmLmxldmVscyA9IHsgXCJUUkFDRVwiOiAwLCBcIkRFQlVHXCI6IDEsIFwiSU5GT1wiOiAyLCBcIldBUk5cIjogMyxcbiAgICAgICAgICBcIkVSUk9SXCI6IDQsIFwiU0lMRU5UXCI6IDV9O1xuXG4gICAgICBzZWxmLm1ldGhvZEZhY3RvcnkgPSBmYWN0b3J5IHx8IGRlZmF1bHRNZXRob2RGYWN0b3J5O1xuXG4gICAgICBzZWxmLmdldExldmVsID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgIHJldHVybiBjdXJyZW50TGV2ZWw7XG4gICAgICB9O1xuXG4gICAgICBzZWxmLnNldExldmVsID0gZnVuY3Rpb24gKGxldmVsLCBwZXJzaXN0KSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBsZXZlbCA9PT0gXCJzdHJpbmdcIiAmJiBzZWxmLmxldmVsc1tsZXZlbC50b1VwcGVyQ2FzZSgpXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIGxldmVsID0gc2VsZi5sZXZlbHNbbGV2ZWwudG9VcHBlckNhc2UoKV07XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0eXBlb2YgbGV2ZWwgPT09IFwibnVtYmVyXCIgJiYgbGV2ZWwgPj0gMCAmJiBsZXZlbCA8PSBzZWxmLmxldmVscy5TSUxFTlQpIHtcbiAgICAgICAgICAgICAgY3VycmVudExldmVsID0gbGV2ZWw7XG4gICAgICAgICAgICAgIGlmIChwZXJzaXN0ICE9PSBmYWxzZSkgeyAgLy8gZGVmYXVsdHMgdG8gdHJ1ZVxuICAgICAgICAgICAgICAgICAgcGVyc2lzdExldmVsSWZQb3NzaWJsZShsZXZlbCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmVwbGFjZUxvZ2dpbmdNZXRob2RzLmNhbGwoc2VsZiwgbGV2ZWwsIG5hbWUpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgPT09IHVuZGVmaW5lZFR5cGUgJiYgbGV2ZWwgPCBzZWxmLmxldmVscy5TSUxFTlQpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBcIk5vIGNvbnNvbGUgYXZhaWxhYmxlIGZvciBsb2dnaW5nXCI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBcImxvZy5zZXRMZXZlbCgpIGNhbGxlZCB3aXRoIGludmFsaWQgbGV2ZWw6IFwiICsgbGV2ZWw7XG4gICAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgc2VsZi5zZXREZWZhdWx0TGV2ZWwgPSBmdW5jdGlvbiAobGV2ZWwpIHtcbiAgICAgICAgICBkZWZhdWx0TGV2ZWwgPSBsZXZlbDtcbiAgICAgICAgICBpZiAoIWdldFBlcnNpc3RlZExldmVsKCkpIHtcbiAgICAgICAgICAgICAgc2VsZi5zZXRMZXZlbChsZXZlbCwgZmFsc2UpO1xuICAgICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHNlbGYucmVzZXRMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBzZWxmLnNldExldmVsKGRlZmF1bHRMZXZlbCwgZmFsc2UpO1xuICAgICAgICAgIGNsZWFyUGVyc2lzdGVkTGV2ZWwoKTtcbiAgICAgIH07XG5cbiAgICAgIHNlbGYuZW5hYmxlQWxsID0gZnVuY3Rpb24ocGVyc2lzdCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoc2VsZi5sZXZlbHMuVFJBQ0UsIHBlcnNpc3QpO1xuICAgICAgfTtcblxuICAgICAgc2VsZi5kaXNhYmxlQWxsID0gZnVuY3Rpb24ocGVyc2lzdCkge1xuICAgICAgICAgIHNlbGYuc2V0TGV2ZWwoc2VsZi5sZXZlbHMuU0lMRU5ULCBwZXJzaXN0KTtcbiAgICAgIH07XG5cbiAgICAgIC8vIEluaXRpYWxpemUgd2l0aCB0aGUgcmlnaHQgbGV2ZWxcbiAgICAgIHZhciBpbml0aWFsTGV2ZWwgPSBnZXRQZXJzaXN0ZWRMZXZlbCgpO1xuICAgICAgaWYgKGluaXRpYWxMZXZlbCA9PSBudWxsKSB7XG4gICAgICAgICAgaW5pdGlhbExldmVsID0gZGVmYXVsdExldmVsO1xuICAgICAgfVxuICAgICAgc2VsZi5zZXRMZXZlbChpbml0aWFsTGV2ZWwsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKlxuICAgICAqXG4gICAgICogVG9wLWxldmVsIEFQSVxuICAgICAqXG4gICAgICovXG5cbiAgICB2YXIgZGVmYXVsdExvZ2dlciA9IG5ldyBMb2dnZXIoKTtcblxuICAgIHZhciBfbG9nZ2Vyc0J5TmFtZSA9IHt9O1xuICAgIGRlZmF1bHRMb2dnZXIuZ2V0TG9nZ2VyID0gZnVuY3Rpb24gZ2V0TG9nZ2VyKG5hbWUpIHtcbiAgICAgICAgaWYgKCh0eXBlb2YgbmFtZSAhPT0gXCJzeW1ib2xcIiAmJiB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIikgfHwgbmFtZSA9PT0gXCJcIikge1xuICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJZb3UgbXVzdCBzdXBwbHkgYSBuYW1lIHdoZW4gY3JlYXRpbmcgYSBsb2dnZXIuXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGxvZ2dlciA9IF9sb2dnZXJzQnlOYW1lW25hbWVdO1xuICAgICAgICBpZiAoIWxvZ2dlcikge1xuICAgICAgICAgIGxvZ2dlciA9IF9sb2dnZXJzQnlOYW1lW25hbWVdID0gbmV3IExvZ2dlcihcbiAgICAgICAgICAgIG5hbWUsIGRlZmF1bHRMb2dnZXIuZ2V0TGV2ZWwoKSwgZGVmYXVsdExvZ2dlci5tZXRob2RGYWN0b3J5KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbG9nZ2VyO1xuICAgIH07XG5cbiAgICAvLyBHcmFiIHRoZSBjdXJyZW50IGdsb2JhbCBsb2cgdmFyaWFibGUgaW4gY2FzZSBvZiBvdmVyd3JpdGVcbiAgICB2YXIgX2xvZyA9ICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlKSA/IHdpbmRvdy5sb2cgOiB1bmRlZmluZWQ7XG4gICAgZGVmYXVsdExvZ2dlci5ub0NvbmZsaWN0ID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygd2luZG93ICE9PSB1bmRlZmluZWRUeXBlICYmXG4gICAgICAgICAgICAgICB3aW5kb3cubG9nID09PSBkZWZhdWx0TG9nZ2VyKSB7XG4gICAgICAgICAgICB3aW5kb3cubG9nID0gX2xvZztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBkZWZhdWx0TG9nZ2VyO1xuICAgIH07XG5cbiAgICBkZWZhdWx0TG9nZ2VyLmdldExvZ2dlcnMgPSBmdW5jdGlvbiBnZXRMb2dnZXJzKCkge1xuICAgICAgICByZXR1cm4gX2xvZ2dlcnNCeU5hbWU7XG4gICAgfTtcblxuICAgIC8vIEVTNiBkZWZhdWx0IGV4cG9ydCwgZm9yIGNvbXBhdGliaWxpdHlcbiAgICBkZWZhdWx0TG9nZ2VyWydkZWZhdWx0J10gPSBkZWZhdWx0TG9nZ2VyO1xuXG4gICAgcmV0dXJuIGRlZmF1bHRMb2dnZXI7XG59KSk7XG4iLCIvKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKiBNT0RCVVMgUlRVIEZVTkNUSU9OUyBGT1IgU0VORUNBICoqKioqKioqKioqKioqKioqKioqKiovXHJcblxyXG52YXIgTUFYX1VfR0VOID0gMjcuMDsgLy8gbWF4aW11bSB2b2x0YWdlIFxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBzZXJpYWwgbnVtYmVyXHJcbiAqICovXHJcbiBmdW5jdGlvbiBtYWtlU2VyaWFsTnVtYmVyKCkge1xyXG4gICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuU2VyaWFsTnVtYmVyKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEdlbmVyYXRlIHRoZSBtb2RidXMgUlRVIHBhY2tldCB0byByZWFkIHRoZSBjdXJyZW50IG1vZGVcclxuICogKi9cclxuZnVuY3Rpb24gbWFrZUN1cnJlbnRNb2RlKCkge1xyXG4gICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuQ3VycmVudE1vZGUpO1xyXG59XHJcblxyXG4vKipcclxuICogR2VuZXJhdGUgdGhlIG1vZGJ1cyBSVFUgcGFja2V0IHRvIHJlYWQgdGhlIGN1cnJlbnQgYmF0dGVyeSBsZXZlbFxyXG4gKiAqL1xyXG5mdW5jdGlvbiBtYWtlQmF0dGVyeUxldmVsKCkge1xyXG4gICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuQmF0dGVyeU1lYXN1cmUpO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2VzIHRoZSByZWdpc3RlciB3aXRoIGJhdHRlcnkgbGV2ZWxcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VGQzMgXHJcbiAqIEByZXR1cm5zIHtudW1iZXJ9IGJhdHRlcnkgbGV2ZWwgaW4gVlxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VCYXR0ZXJ5KHJlc3BvbnNlRkMzKSB7XHJcbiAgICByZXR1cm4gZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIFNlbmVjYSBNU0Mgc2VyaWFsIGFzIHBlciB0aGUgVUkgaW50ZXJmYWNlXHJcbiAqIEBwYXJhbSB7RGF0YVZpZXd9IHJlZ2lzdGVycyB2YWx1ZXMgb2YgdGhlIHJlZ2lzdGVyc1xyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VTZXJpYWxOdW1iZXIocmVnaXN0ZXJzKSB7XHJcbiAgICBpZiAocmVnaXN0ZXJzLmxlbmd0aCA8IDQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHNlcmlhbCBudW1iZXIgcmVzcG9uc2VcIik7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWwxID0gcmVnaXN0ZXJzLmdldFVpbnQxNigwLCBmYWxzZSk7XHJcbiAgICBjb25zdCB2YWwyID0gcmVnaXN0ZXJzLmdldFVpbnQxNigyLCBmYWxzZSk7XHJcbiAgICBjb25zdCBzZXJpYWwgPSAoKHZhbDIgPDwgMTYpICsgdmFsMSkudG9TdHJpbmcoKTtcclxuICAgIGlmIChzZXJpYWwubGVuZ3RoID4gNSkge1xyXG4gICAgICAgIHJldHVybiBzZXJpYWwuc3Vic3RyKDAsIDUpICsgXCJfXCIgKyBzZXJpYWwuc3Vic3RyKDUsIHNlcmlhbC5sZW5ndGggLSA1KTtcclxuICAgIH1cclxuICAgIHJldHVybiBzZXJpYWw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBIZWxwZXIgZnVuY3Rpb24gdG8gY29udmVydCBhIHZhbHVlIGludG8gYW4gZW51bSB2YWx1ZVxyXG4gKiBcclxuICogQHBhcmFtIHt0eXBlfSBlbnVtdHlwZVxyXG4gKiBAcGFyYW0ge251bWJlcn0gZW51bXZhbHVlXHJcbiAqL1xyXG5mdW5jdGlvbiBQYXJzZShlbnVtdHlwZSwgZW51bXZhbHVlKSB7XHJcbiAgICBmb3IgKHZhciBlbnVtTmFtZSBpbiBlbnVtdHlwZSkge1xyXG4gICAgICAgIGlmIChlbnVtdHlwZVtlbnVtTmFtZV0gPT0gZW51bXZhbHVlKSB7XHJcbiAgICAgICAgICAgIC8qanNoaW50IC1XMDYxICovXHJcbiAgICAgICAgICAgIHJldHVybiBldmFsKFtlbnVtdHlwZSArIFwiLlwiICsgZW51bU5hbWVdKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgc3RhdGUgb2YgdGhlIG1ldGVyLiBNYXkgdGhyb3cuXHJcbiAqIEBwYXJhbSB7QXJyYXlCdWZmZXJ9IHJlZ2lzdGVycyByZWdpc3RlciB2YWx1ZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBjdXJyZW50TW9kZSBpZiB0aGUgcmVnaXN0ZXJzIGNvbnRhaW5zIGFuIElHTk9SRSB2YWx1ZSwgcmV0dXJucyB0aGUgY3VycmVudCBtb2RlXHJcbiAqIEByZXR1cm5zIHtDb21tYW5kVHlwZX0gbWV0ZXIgbW9kZVxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VDdXJyZW50TW9kZShyZWdpc3RlcnMsIGN1cnJlbnRNb2RlKSB7XHJcbiAgICBpZiAocmVnaXN0ZXJzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIG1vZGUgcmVzcG9uc2VcIik7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWwxID0gcmVnaXN0ZXJzLmdldFVpbnQxNigwLCBmYWxzZSk7XHJcblxyXG4gICAgaWYgKHZhbDEgPT0gQ29tbWFuZFR5cGUuUkVTRVJWRUQgfHwgdmFsMSA9PSBDb21tYW5kVHlwZS5HRU5fUkVTRVJWRUQgfHwgdmFsMSA9PSBDb21tYW5kVHlwZS5SRVNFUlZFRF8yKSB7IC8vIE11c3QgYmUgaWdub3JlZFxyXG4gICAgICAgIHJldHVybiBjdXJyZW50TW9kZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbHVlID0gUGFyc2UoQ29tbWFuZFR5cGUsIHZhbDEpO1xyXG4gICAgaWYgKHZhbHVlID09IG51bGwpXHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBtZXRlciBtb2RlIDogXCIgKyB2YWx1ZSk7XHJcblxyXG4gICAgcmV0dXJuIHZhbDE7XHJcbn1cclxuLyoqXHJcbiAqIFNldHMgdGhlIGN1cnJlbnQgbW9kZS5cclxuICogQHBhcmFtIHtudW1iZXJ9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfG51bGx9XHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlTW9kZVJlcXVlc3QobW9kZSkge1xyXG4gICAgY29uc3QgdmFsdWUgPSBQYXJzZShDb21tYW5kVHlwZSwgbW9kZSk7XHJcbiAgICBjb25zdCBDSEFOR0VfU1RBVFVTID0gMTtcclxuXHJcbiAgICAvLyBGaWx0ZXIgaW52YWxpZCBjb21tYW5kc1xyXG4gICAgaWYgKHZhbHVlID09IG51bGwgfHwgdmFsdWUgPT0gQ29tbWFuZFR5cGUuTk9ORV9VTktOT1dOKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKG1vZGUgPiBDb21tYW5kVHlwZS5OT05FX1VOS05PV04gJiYgbW9kZSA8PSBDb21tYW5kVHlwZS5PRkYpIHsgLy8gTWVhc3VyZW1lbnRzXHJcbiAgICAgICAgcmV0dXJuIG1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkNNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuICAgIH1cclxuICAgIGVsc2UgaWYgKG1vZGUgPiBDb21tYW5kVHlwZS5PRkYgJiYgbW9kZSA8IENvbW1hbmRUeXBlLkdFTl9SRVNFUlZFRCkgeyAvLyBHZW5lcmF0aW9uc1xyXG4gICAgICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICAgICAgLy8gQ29sZCBqdW5jdGlvbiBub3QgY29uZmlndXJlZFxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLkdFTl9DTUQsIFtDSEFOR0VfU1RBVFVTLCBtb2RlXSk7XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfM1c6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgLy8gQWxsIHRoZSBzaW1wbGUgY2FzZXMgXHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuR0VOX0NNRCwgW0NIQU5HRV9TVEFUVVMsIG1vZGVdKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXaGVuIHRoZSBtZXRlciBpcyBtZWFzdXJpbmcsIG1ha2UgdGhlIG1vZGJ1cyByZXF1ZXN0IG9mIHRoZSB2YWx1ZVxyXG4gKiBAcGFyYW0ge0NvbW1hbmRUeXBlfSBtb2RlXHJcbiAqIEByZXR1cm5zIHtBcnJheUJ1ZmZlcn0gbW9kYnVzIFJUVSBwYWNrZXRcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VNZWFzdXJlUmVxdWVzdChtb2RlKSB7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgMiwgTVNDUmVnaXN0ZXJzLlRlbXBNZWFzdXJlKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF80VzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwMF80VzpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCA0LCBNU0NSZWdpc3RlcnMuUnRkVGVtcGVyYXR1cmVNZWFzdXJlKTsgLy8gVGVtcC1PaG1cclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5TWVhc3VyZSk7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5QdWxzZU9GRk1lYXN1cmUpOyAvLyBPTi1PRkZcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkxvYWRDZWxsOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbCk7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5tQV9wYXNzaXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLm1WOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDYsIE1TQ1JlZ2lzdGVycy5NaW5NZWFzdXJlKTsgLy8gTWluLU1heC1NZWFzXHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTW9kZSBub3QgbWFuYWdlZCA6XCIgKyBidFN0YXRlLm1ldGVyLm1vZGUpO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUGFyc2UgdGhlIG1lYXN1cmUgcmVhZCBmcm9tIHRoZSBtZXRlclxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZUZDMyByZWdpc3RlcnMgdmFsdWVzIGZyb20gcGFyc2VkIG1vZGJ1cyBhbnN3ZXJcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBjdXJyZW50IG1vZGUgb2YgdGhlIG1ldGVyXHJcbiAqIEByZXR1cm5zIHthcnJheX0gYW4gYXJyYXkgd2l0aCBmaXJzdCBlbGVtZW50IFwiTWVhc3VyZSBuYW1lICh1bml0cylcIjpWYWx1ZSwgc2Vjb25kIFRpbWVzdGFtcDphY3F1aXNpdGlvblxyXG4gKi9cclxuZnVuY3Rpb24gcGFyc2VNZWFzdXJlKHJlc3BvbnNlRkMzLCBtb2RlKSB7XHJcbiAgICB2YXIgbWVhcywgbWVhczIsIG1pbiwgbWF4O1xyXG5cclxuICAgIC8vIEFsbCBtZWFzdXJlcyBhcmUgZmxvYXRcclxuICAgIGlmIChyZXNwb25zZUZDMyA9PSBudWxsKVxyXG4gICAgICAgIHJldHVybiB7fTtcclxuXHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlRIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuVEhFUk1PX1M6XHJcbiAgICAgICAgICAgIG1lYXMgPSBnZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIHZhciB2YWx1ZSA9IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDBcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJUZW1wZXJhdHVyZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiB2YWx1ZSxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1NTBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkN1MTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuQ3UxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5pMTIwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuTmkxMjBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUMTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQxMDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlBUNTAwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUFQ1MDBfNFc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfM1c6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5QVDEwMDBfNFc6XHJcbiAgICAgICAgICAgIG1lYXMgPSBnZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1lYXMyID0gZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlRlbXBlcmF0dXJlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwKSAvIDEwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiwrBDXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUmVzaXN0YW5jZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMyICogMTApIC8gMTAsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVVuaXRcIjogXCJPaG1zXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkZyZXF1ZW5jeTpcclxuICAgICAgICAgICAgbWVhcyA9IGdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgLy8gU2Vuc2liaWxpdMOgIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiRnJlcXVlbmN5XCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwKSAvIDEwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiSHpcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfYWN0aXZlOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgbWluID0gZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtYXggPSBnZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgNCk7XHJcbiAgICAgICAgICAgIG1lYXMgPSBnZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgOCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiQ3VycmVudFwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBNYXRoLnJvdW5kKG1lYXMgKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibUFcIixcclxuICAgICAgICAgICAgICAgIFwiTWluaW11bVwiOiBNYXRoLnJvdW5kKG1pbiAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIk1heGltdW1cIjogTWF0aC5yb3VuZChtYXggKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5WOlxyXG4gICAgICAgICAgICBtaW4gPSBnZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCk7XHJcbiAgICAgICAgICAgIG1heCA9IGdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA0KTtcclxuICAgICAgICAgICAgbWVhcyA9IGdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCA4KTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJWb2x0YWdlXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCJWXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUubVY6XHJcbiAgICAgICAgICAgIG1pbiA9IGdldEZsb2F0MzJMRUJTKHJlc3BvbnNlRkMzLCAwKTtcclxuICAgICAgICAgICAgbWF4ID0gZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICBtZWFzID0gZ2V0RmxvYXQzMkxFQlMocmVzcG9uc2VGQzMsIDgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogTWF0aC5yb3VuZChtZWFzICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WXCIsXHJcbiAgICAgICAgICAgICAgICBcIk1pbmltdW1cIjogTWF0aC5yb3VuZChtaW4gKiAxMDApIC8gMTAwLFxyXG4gICAgICAgICAgICAgICAgXCJNYXhpbXVtXCI6IE1hdGgucm91bmQobWF4ICogMTAwKSAvIDEwMCxcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuUHVsc2VUcmFpbjpcclxuICAgICAgICAgICAgbWVhcyA9IGdldFVpbnQzMkxFQlMocmVzcG9uc2VGQzMsIDApO1xyXG4gICAgICAgICAgICBtZWFzMiA9IGdldFVpbnQzMkxFQlMocmVzcG9uc2VGQzMsIDQpO1xyXG4gICAgICAgICAgICAvLyBTb2dsaWEgZSBzZW5zaWJpbGl0w6AgbWFuY2FudGlcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJQdWxzZSBPTlwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBtZWFzLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeURlc2NyaXB0aW9uXCI6IFwiUHVsc2UgT0ZGXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVZhbHVlXCI6IG1lYXMyLFxyXG4gICAgICAgICAgICAgICAgXCJTZWNvbmRhcnlVbml0XCI6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkxvYWRDZWxsOlxyXG4gICAgICAgICAgICBtZWFzID0gTWF0aC5yb3VuZChnZXRGbG9hdDMyTEVCUyhyZXNwb25zZUZDMywgMCkgKiAxMDAwKSAvIDEwMDA7XHJcbiAgICAgICAgICAgIC8vIEtnIG1hbmNhbnRpXHJcbiAgICAgICAgICAgIC8vIFNlbnNpYmlsaXTDoCwgdGFyYSwgcG9ydGF0YSBtYW5jYW50aVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkltYmFsYW5jZVwiLFxyXG4gICAgICAgICAgICAgICAgXCJWYWx1ZVwiOiBtZWFzLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwibVYvVlwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IE1hdGgucm91bmQobWVhcyAqIDEwMDApIC8gMTAwMCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIj9cIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHN0YXR1cyBmbGFncyBmcm9tIG1lYXN1cmVtZW50IG1vZGVcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZVxyXG4gKiBAcmV0dXJucyB7QXJyYXlCdWZmZXJ9IG1vZGJ1cyBSVFUgcmVxdWVzdCB0byBzZW5kXHJcbiAqL1xyXG5mdW5jdGlvbiBtYWtlUXVhbGl0eUJpdFJlcXVlc3QobW9kZSkge1xyXG4gICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuTWVhc3VyZUZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IHN0YXR1c1xyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZXNwb25zZUZDM1xyXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gdHJ1ZSBpZiB0aGVyZSBpcyBubyBlcnJvclxyXG4gKi9cclxuZnVuY3Rpb24gaXNRdWFsaXR5VmFsaWQocmVzcG9uc2VGQzMpIHtcclxuICAgIHJldHVybiAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxMykpID09IDApO1xyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIGdlbmVyYXRpb24gZmxhZ3Mgc3RhdHVzIGZyb20gdGhlIG1ldGVyXHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3QgdG8gc2VuZFxyXG4gKi9cclxuZnVuY3Rpb24gbWFrZUdlblN0YXR1c1JlYWQobW9kZSkge1xyXG4gICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAxLCBNU0NSZWdpc3RlcnMuR2VuZXJhdGlvbkZsYWdzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrcyBpZiB0aGUgZXJyb3IgYml0IGlzIE5PVCBzZXQgaW4gdGhlIGdlbmVyYXRpb24gZmxhZ3NcclxuICogQHBhcmFtIHtBcnJheUJ1ZmZlcn0gcmVzcG9uc2VGQzNcclxuICogQHJldHVybnMge2Jvb2xlYW59IHRydWUgaWYgdGhlcmUgaXMgbm8gZXJyb3JcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlR2VuU3RhdHVzKHJlc3BvbnNlRkMzLCBtb2RlKSB7XHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9hY3RpdmU6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fbUFfcGFzc2l2ZTpcclxuICAgICAgICAgICAgcmV0dXJuICgocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMCkgJiYgLy8gR2VuIGVycm9yXHJcbiAgICAgICAgICAgICAgICAoKHJlc3BvbnNlRkMzLmdldFVpbnQxNigwLCBmYWxzZSkgJiAoMSA8PCAxNCkpID09IDApOyAvLyBTZWxmIGdlbmVyYXRpb24gSSBjaGVja1xyXG4gICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgIHJldHVybiAocmVzcG9uc2VGQzMuZ2V0VWludDE2KDAsIGZhbHNlKSAmICgxIDw8IDE1KSkgPT0gMDsgLy8gR2VuIGVycm9yXHJcbiAgICB9XHJcbn1cclxuXHJcblxyXG4vKipcclxuICogUmV0dXJucyBhIGJ1ZmZlciB3aXRoIHRoZSBtb2RidXMtcnR1IHJlcXVlc3QgdG8gYmUgc2VudCB0byBTZW5lY2FcclxuICogQHBhcmFtIHtDb21tYW5kVHlwZX0gbW9kZSBnZW5lcmF0aW9uIG1vZGVcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50IHRoZSB2YWx1ZSB0byBzZXQgKG1WL1YvQS9Iei/CsEMpIGV4Y2VwdCBmb3IgcHVsc2VzIG51bV9wdWxzZXNcclxuICogQHBhcmFtIHtudW1iZXJ9IHNldHBvaW50MiBmcmVxdWVuY3kgaW4gSHpcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlcXVlc3QobW9kZSwgc2V0cG9pbnQsIHNldHBvaW50Mikge1xyXG4gICAgdmFyIFRFTVAsIHJlZ2lzdGVycztcclxuICAgIHZhciBkdCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIHZhciBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG4gICAgc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50KTtcclxuICAgIGNvbnN0IHNwID0gW2R2LmdldFVpbnQxNigwLCBmYWxzZSksIGR2LmdldFVpbnQxNigyLCBmYWxzZSldO1xyXG5cclxuICAgIHZhciBkdEludCA9IG5ldyBBcnJheUJ1ZmZlcig0KTtcclxuICAgIHZhciBkdkludCA9IG5ldyBEYXRhVmlldyhkdEludCk7XHJcbiAgICBzZXRVaW50MzJMRUJTKGR2SW50LCAwLCBzZXRwb2ludCk7XHJcbiAgICBjb25zdCBzcEludCA9IFtkdkludC5nZXRVaW50MTYoMCwgZmFsc2UpLCBkdkludC5nZXRVaW50MTYoMiwgZmFsc2UpXTtcclxuXHJcbiAgICBzd2l0Y2ggKG1vZGUpIHtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50LCBzcCk7IC8vIFYgLyBtViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuQ3VycmVudFNldHBvaW50LCBzcCk7IC8vIEkgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzNXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1NTBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3UxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTmkxMjBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQ1MDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fUFQxMDAwXzJXOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuUlREVGVtcGVyYXR1cmVTZXRwb2ludCwgc3ApOyAvLyDCsEMgc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fQjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fRTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fSzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTDpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fUzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9USEVSTU9fVDpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlRoZXJtb1RlbXBlcmF0dXJlU2V0cG9pbnQsIHNwKTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fTG9hZENlbGw6XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Mb2FkQ2VsbFNldHBvaW50LCBzcCk7IC8vIG1WL1Ygc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9GcmVxdWVuY3k6XHJcbiAgICAgICAgICAgIGR0ID0gbmV3IEFycmF5QnVmZmVyKDgpOyAvLyAyIFVpbnQzMlxyXG4gICAgICAgICAgICBkdiA9IG5ldyBEYXRhVmlldyhkdCk7XHJcblxyXG4gICAgICAgICAgICAvLyBTZWUgU2VuZWNhbCBtYW51YWwgbWFudWFsXHJcbiAgICAgICAgICAgIC8vIE1heCAyMGtIWiBnZW5cclxuICAgICAgICAgICAgVEVNUCA9IE1hdGgucm91bmQoMjAwMDAgLyBzZXRwb2ludCwgMCk7XHJcbiAgICAgICAgICAgIGR2LnNldFVpbnQzMigwLCBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMVxyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoNCwgVEVNUCAtIE1hdGguZmxvb3IoVEVNUCAvIDIpLCBmYWxzZSk7IC8vIFRJQ0syXHJcblxyXG4gICAgICAgICAgICAvLyBCeXRlLXN3YXBwZWQgbGl0dGxlIGVuZGlhblxyXG4gICAgICAgICAgICByZWdpc3RlcnMgPSBbZHYuZ2V0VWludDE2KDIsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDAsIGZhbHNlKSxcclxuICAgICAgICAgICAgZHYuZ2V0VWludDE2KDYsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDQsIGZhbHNlKV07XHJcblxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMTYoU0VORUNBX01CX1NMQVZFX0lELCBNU0NSZWdpc3RlcnMuRnJlcXVlbmN5VElDSzEsIHJlZ2lzdGVycyk7XHJcblxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIGR0ID0gbmV3IEFycmF5QnVmZmVyKDEyKTsgLy8gMyBVaW50MzIgXHJcbiAgICAgICAgICAgIGR2ID0gbmV3IERhdGFWaWV3KGR0KTtcclxuXHJcbiAgICAgICAgICAgIC8vIFNlZSBTZW5lY2FsIG1hbnVhbCBtYW51YWxcclxuICAgICAgICAgICAgLy8gTWF4IDIwa0haIGdlblxyXG4gICAgICAgICAgICBURU1QID0gTWF0aC5yb3VuZCgyMDAwMCAvIHNldHBvaW50MiwgMCk7XHJcblxyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoMCwgc2V0cG9pbnQsIGZhbHNlKTsgLy8gTlVNX1BVTFNFU1xyXG4gICAgICAgICAgICBkdi5zZXRVaW50MzIoNCwgTWF0aC5mbG9vcihURU1QIC8gMiksIGZhbHNlKTsgLy8gVElDSzFcclxuICAgICAgICAgICAgZHYuc2V0VWludDMyKDgsIFRFTVAgLSBNYXRoLmZsb29yKFRFTVAgLyAyKSwgZmFsc2UpOyAvLyBUSUNLMlxyXG5cclxuICAgICAgICAgICAgcmVnaXN0ZXJzID0gW2R2LmdldFVpbnQxNigyLCBmYWxzZSksIGR2LmdldFVpbnQxNigwLCBmYWxzZSksXHJcbiAgICAgICAgICAgIGR2LmdldFVpbnQxNig2LCBmYWxzZSksIGR2LmdldFVpbnQxNig0LCBmYWxzZSksXHJcbiAgICAgICAgICAgIGR2LmdldFVpbnQxNigxMCwgZmFsc2UpLCBkdi5nZXRVaW50MTYoOCwgZmFsc2UpXTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5QdWxzZXNDb3VudCwgcmVnaXN0ZXJzKTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VVGhyZXNob2xkX0Y6XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5UaHJlc2hvbGRVX0ZyZXEsIHNwKTsgLy8gVSBtaW4gZm9yIGZyZXEgbWVhc3VyZW1lbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9TZW5zaXRpdml0eV91UzpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzE2KFNFTkVDQV9NQl9TTEFWRV9JRCwgTVNDUmVnaXN0ZXJzLlNlbnNpYmlsaXR5X3VTX09GRixcclxuICAgICAgICAgICAgICAgIFtzcEludFswXSwgc3BJbnRbMV0sIHNwSW50WzBdLCBzcEludFsxXV0pOyAvLyB1ViBmb3IgcHVsc2UgdHJhaW4gbWVhc3VyZW1lbnQgdG8gT04gLyBPRkZcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9Db2xkSnVuY3Rpb246XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Db2xkSnVuY3Rpb24sIHNwKTsgLy8gdW5jbGVhciB1bml0XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5TRVRfVWxvdzpcclxuICAgICAgICAgICAgc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcbiAgICAgICAgICAgIHZhciBzcDIgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HZW5VbG93UGVyYywgc3AyKTsgLy8gVSBsb3cgZm9yIGZyZXEgLyBwdWxzZSBnZW5cclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLlNFVF9VaGlnaDpcclxuICAgICAgICAgICAgc2V0RmxvYXQzMkxFQlMoZHYsIDAsIHNldHBvaW50IC8gTUFYX1VfR0VOKTsgLy8gTXVzdCBjb252ZXJ0IFYgaW50byBhICUgMC4uTUFYX1VfR0VOXHJcbiAgICAgICAgICAgIHZhciBzcDIgPSBbZHYuZ2V0VWludDE2KDAsIGZhbHNlKSwgZHYuZ2V0VWludDE2KDIsIGZhbHNlKV07XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5HZW5VaGlnaFBlcmMsIHNwMik7IC8vIFUgaGlnaCBmb3IgZnJlcSAvIHB1bHNlIGdlbiAgICAgICAgICAgIFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuU0VUX1NodXRkb3duRGVsYXk6XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMxNihTRU5FQ0FfTUJfU0xBVkVfSUQsIE1TQ1JlZ2lzdGVycy5Qb3dlck9mZkRlbGF5LCBzZXRwb2ludCk7IC8vIGRlbGF5IGluIHNlY1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuT0ZGOlxyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDsgLy8gTm8gc2V0cG9pbnRcclxuICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgaGFuZGxlZFwiKTtcclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogUmVhZHMgdGhlIHNldHBvaW50XHJcbiAqIEBwYXJhbSB7Q29tbWFuZFR5cGV9IG1vZGVcclxuICogQHJldHVybnMge0FycmF5QnVmZmVyfSBtb2RidXMgUlRVIHJlcXVlc3RcclxuICovXHJcbmZ1bmN0aW9uIG1ha2VTZXRwb2ludFJlYWQobW9kZSkge1xyXG4gICAgc3dpdGNoIChtb2RlKSB7XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tVjpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuVm9sdGFnZVNldHBvaW50KTsgLy8gbVYgb3IgViBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5DdXJyZW50U2V0cG9pbnQpOyAvLyBBIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8zVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTUwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0N1MTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX05pMTIwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUNTAwXzJXOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1BUMTAwMF8yVzpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuUlREVGVtcGVyYXR1cmVTZXRwb2ludCk7IC8vIMKwQyBzZXRwb2ludFxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19COlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19FOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19KOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19LOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19MOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19OOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19SOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19TOlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1RIRVJNT19UOlxyXG4gICAgICAgICAgICByZXR1cm4gbWFrZUZDMyhTRU5FQ0FfTUJfU0xBVkVfSUQsIDIsIE1TQ1JlZ2lzdGVycy5UaGVybW9UZW1wZXJhdHVyZVNldHBvaW50KTsgLy8gwrBDIHNldHBvaW50XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fRnJlcXVlbmN5OlxyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX1B1bHNlVHJhaW46XHJcbiAgICAgICAgICAgIHJldHVybiBtYWtlRkMzKFNFTkVDQV9NQl9TTEFWRV9JRCwgNCwgTVNDUmVnaXN0ZXJzLkZyZXF1ZW5jeVRJQ0sxKTsgLy8gRnJlcXVlbmN5IHNldHBvaW50IChUSUNLUylcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIG1ha2VGQzMoU0VORUNBX01CX1NMQVZFX0lELCAyLCBNU0NSZWdpc3RlcnMuTG9hZENlbGxTZXRwb2ludCk7IC8vIG1WL1Ygc2V0cG9pbnRcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk5PTkVfVU5LTk9XTjpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLk9GRjpcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgaGFuZGxlZFwiKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFBhcnNlcyB0aGUgYW5zd2VyIGFib3V0IFNldHBvaW50UmVhZFxyXG4gKiBAcGFyYW0ge0FycmF5QnVmZmVyfSByZWdpc3RlcnMgRkMzIHBhcnNlZCBhbnN3ZXJcclxuICogQHJldHVybnMge251bWJlcn0gdGhlIGxhc3Qgc2V0cG9pbnRcclxuICovXHJcbmZ1bmN0aW9uIHBhcnNlU2V0cG9pbnRSZWFkKHJlZ2lzdGVycywgbW9kZSkge1xyXG4gICAgLy8gUm91bmQgdG8gdHdvIGRpZ2l0c1xyXG4gICAgdmFyIHJvdW5kZWQgPSBNYXRoLnJvdW5kKGdldEZsb2F0MzJMRUJTKHJlZ2lzdGVycywgMCkgKiAxMDApIC8gMTAwO1xyXG5cclxuICAgIHN3aXRjaCAobW9kZSkge1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21BX2FjdGl2ZTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9tQV9wYXNzaXZlOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIkN1cnJlbnRcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1BXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9WOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIlZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX21WOlxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgXCJEZXNjcmlwdGlvblwiOiBcIlZvbHRhZ2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WXCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9Mb2FkQ2VsbDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJJbWJhbGFuY2VcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIm1WL1ZcIixcclxuICAgICAgICAgICAgICAgIFwiVGltZXN0YW1wXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIGNhc2UgQ29tbWFuZFR5cGUuR0VOX0ZyZXF1ZW5jeTpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QdWxzZVRyYWluOlxyXG4gICAgICAgICAgICB2YXIgdGljazEgPSBnZXRVaW50MzJMRUJTKHJlZ2lzdGVycywgMCk7XHJcbiAgICAgICAgICAgIHZhciB0aWNrMiA9IGdldFVpbnQzMkxFQlMocmVnaXN0ZXJzLCA0KTtcclxuICAgICAgICAgICAgdmFyIGZPTiA9IDAuMDtcclxuICAgICAgICAgICAgdmFyIGZPRkYgPSAwLjA7XHJcbiAgICAgICAgICAgIGlmICh0aWNrMSAhPSAwKVxyXG4gICAgICAgICAgICAgICAgZk9OID0gTWF0aC5yb3VuZCgxIC8gKHRpY2sxICogMiAvIDIwMDAwLjApICogMTAuMCkgLyAxMDsgLy8gTmVlZCBvbmUgZGVjaW1hbCBwbGFjZSBmb3IgSFpcclxuICAgICAgICAgICAgaWYgKHRpY2syICE9IDApXHJcbiAgICAgICAgICAgICAgICBmT0ZGID0gTWF0aC5yb3VuZCgxIC8gKHRpY2syICogMiAvIDIwMDAwLjApICogMTAuMCkgLyAxMDsgLy8gTmVlZCBvbmUgZGVjaW1hbCBwbGFjZSBmb3IgSFpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3kgT05cIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogZk9OLFxyXG4gICAgICAgICAgICAgICAgXCJVbml0XCI6IFwiSHpcIixcclxuICAgICAgICAgICAgICAgIFwiU2Vjb25kYXJ5RGVzY3JpcHRpb25cIjogXCJGcmVxdWVuY3kgT0ZGXCIsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVZhbHVlXCI6IGZPRkYsXHJcbiAgICAgICAgICAgICAgICBcIlNlY29uZGFyeVVuaXRcIjogXCJIelwiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fQ3U1MF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9DdTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9OaTEyMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDUwMF8yVzpcclxuICAgICAgICBjYXNlIENvbW1hbmRUeXBlLkdFTl9QVDEwMDBfMlc6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0U6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0o6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0s6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX0w6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX046XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1I6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1M6XHJcbiAgICAgICAgY2FzZSBDb21tYW5kVHlwZS5HRU5fVEhFUk1PX1Q6XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBcIkRlc2NyaXB0aW9uXCI6IFwiVGVtcGVyYXR1cmVcIixcclxuICAgICAgICAgICAgICAgIFwiVmFsdWVcIjogcm91bmRlZCxcclxuICAgICAgICAgICAgICAgIFwiVW5pdFwiOiBcIsKwQ1wiLFxyXG4gICAgICAgICAgICAgICAgXCJUaW1lc3RhbXBcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIFwiRGVzY3JpcHRpb25cIjogXCJVbmtub3duXCIsXHJcbiAgICAgICAgICAgICAgICBcIlZhbHVlXCI6IHJvdW5kZWQsXHJcbiAgICAgICAgICAgICAgICBcIlVuaXRcIjogXCI/XCIsXHJcbiAgICAgICAgICAgICAgICBcIlRpbWVzdGFtcFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuICAgICAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbn0iLCJsZXQgc2xlZXAgPSBtcyA9PiBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxuICAgIGxldCB3YWl0Rm9yID0gYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihmKSB7XHJcbiAgICAgICAgd2hpbGUgKCFmKCkpIGF3YWl0IHNsZWVwKDEwMCArIE1hdGgucmFuZG9tKCkgKiAyNSk7XHJcbiAgICAgICAgcmV0dXJuIGYoKTtcclxuICAgIH07XHJcblxyXG4gICAgbGV0IHdhaXRGb3JUaW1lb3V0ID0gYXN5bmMgZnVuY3Rpb24gd2FpdEZvcihmLCB0aW1lb3V0U2VjKSB7XHJcbiAgICAgICAgdmFyIHRvdGFsVGltZU1zID0gMDtcclxuICAgICAgICB3aGlsZSAoIWYoKSAmJiB0b3RhbFRpbWVNcyA8IHRpbWVvdXRTZWMgKiAxMDAwKSB7XHJcbiAgICAgICAgICAgIHZhciBkZWxheU1zID0gMTAwICsgTWF0aC5yYW5kb20oKSAqIDI1O1xyXG4gICAgICAgICAgICB0b3RhbFRpbWVNcyArPSBkZWxheU1zO1xyXG4gICAgICAgICAgICBhd2FpdCBzbGVlcChkZWxheU1zKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGYoKTtcclxuICAgIH07XHJcblxyXG4iXX0=
