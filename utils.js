var constants = require("./constants");
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
	return (ctype > CommandType.NONE_UNKNOWN && ctype < CommandType.RESERVED || ctype == CommandType.Continuity);
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
			return enumtype[enumName];
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
		.map(x => x.toString(16).padStart(2, "0"))
		.join(" ");
}

function hex2buf(input) {
	if (typeof input !== "string") {
		throw new TypeError("Expected input to be a string");
	}
	var hexstr = input.replace(/\s+/g, "");
	if ((hexstr.length % 2) !== 0) {
		throw new RangeError("Expected string to be an even number of characters");
	}

	const view = new Uint8Array(hexstr.length / 2);

	for (let i = 0; i < hexstr.length; i += 2) {
		view[i / 2] = parseInt(hexstr.substring(i, i + 2), 16);
	}

	return view.buffer;
}

module.exports = { sleep, waitFor, waitForTimeout, isGeneration, isMeasurement, isSetting, isValid, Parse, buf2hex, hex2buf };