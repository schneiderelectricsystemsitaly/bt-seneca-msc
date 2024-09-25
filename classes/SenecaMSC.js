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