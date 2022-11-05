'use strict';

const log = require("loglevel");
const constants = require('./constants');
const APIState = require('./classes/APIState');
const Command = require('./classes/Command');
const PublicAPI = require('./meterPublicAPI');
const TestData = require('./modbusTestData');

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

