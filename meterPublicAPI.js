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
        cr.unit = btState.lastMeasure["Unit"];
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