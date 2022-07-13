# bt-seneca-msc project

A pure Javascript API for the Seneca Multi Smart Calibrator device, using web bluetooth.

It has minimal dependencies (one logger packages), implements modbus RTU FC3/FC16 functions and has been tested with a Seneca MSC device with firmware 1.0.44 ; tested on PC/Windows with Chrome and Edge. Source is Node.js but the distribution versions are CommonJS (browserified with a standalone MSC object).

A sample application is available here: https://pbrunot.github.io/bt-seneca-msc/

## Requirements and limitations

* A recent browser supporting bluetooth
* A Seneca Multi Smart Calibrator device (see https://www.seneca.it/msc/ )
* MSC features status:

| Measurements | Implementation | Data returned |
| --- | --- | --- |
| V, mV readings                | Done and tested           | Only Instantaneous, min, max values (no avg) |
| mA active/passive readings    | Done and tested           | Only Instantaneous, min, max values (no avg) |
| RTD readings                  | Done and tested 2W        | Instantaneous RTD °C and Ohms values |
| Thermocouples 2W/3W/4W read   | Done *not tested*         | Instantaneous °C value |
| Frequency reading             | Done and tested           | Frequency of leading and falling edges |
| Pulse count reading           | Done and tested 0-10kHz   | Counts of leading and falling edges |
| Frequency reading             | Done and tested           | Tested with square wave 0-10 kHz |
| Load cell                     | Done *not tested*         | Imbalance mV/V |

| Generation | Implementation | Setpoint |
| --- | --- | --- |
| V, mV                         | Done and tested           | 1 Setpoint (mV/V) |
| mA active/passive             | Done *basic testing*      | 1 Setpoint (mA) |
| RTD 2W                        | Done *not tested*         | 1 Setpoint RTD °C |
| Thermocouples                 | Done *not tested*         | 1 Setpoint °C value *no Cold junction* |
| Frequency (square waves)      | Done and tested 0-10kHz   | 2 Setpoints: LE and FE f (Hz) |
| Pulses count generation       | Done and tested 1 kHz     | 2 Setpoints: LE and FE f (Hz) |
| Load cell                     | Done *not tested*         | 1 Setpoint : Imbalance mV/V |

| Settings | Implementation | Notes |
| --- | --- | --- |
| Low level for pulse/square wave generation | CommandType.SET_Ulow | Voltage 0-27 V (tested)
| High level for pulse/square wave generation | CommandType.SET_Uhigh | Voltage 0-27 V (tested)
| Minimum pulse width in microsec | CommandType.SET_Sensitivity_uS | Unknown range 1-??? uS *not tested*
| Tension threshold for frequency/pulse measurement | CommandType.SET_UThreshold_F | Voltage 0-27 V *not tested*

| Others | Status |
| --- | --- |
| Ramps editing          | Not implemented, not planned |
| Ramps application      | Not implemented, not planned |
| Data logging start/stop| Not implemented, not planned |
| Logged data retrieval  | Not implemented, not planned |
| Clock read/sync        | Not implemented |
| Firmware version read  | Not implemented |
| Battery level          | Read once at connection |
| Setting of min us for pulses | Implemented (same threshold ON/OFF) |
| Setting of cold junction compensation | Implemented  *not tested* |
| Setting of min V for f measurement | Implemented *not tested* |
| Conversion of mV/V to kg | Calculation not implemented |

## How to build

* Install Node.js 
* Checkout the repository
* Run from your command line:

```bash
    npm install
    npm run dist
    npm run dev
```

## How to use in your application

* For Node.js applications :

```bash
npm install bt-seneca-msc
```

* For ASPNET.core :

```powershell
libman install bt-seneca-msc --provider jsdelivr
```

## External API

There are 4 operations available:

```js
await MSC.Pair(); // bool - Pair to bluetooth
await MSC.Stop(); // bool - Disconnect the bluetooth and stops the polling
await MSC.Execute(MSC.Command); // bool - Execute command. If the device is not paired, an attempt will be made.
await MSC.GetState(); // array - Get the current state
```

### Connecting to the meter

* Call MSC.Pair() while handling a user gesture in the browser (i.e. button-click)

```js
 var result = await MSC.Pair(); // true when connection has been established
```

* A dialog will be shown to the user of devices with bluetooth name beginning with MSC
* After pairing, the required bluetooth interfaces for Modbus RTU read and write will be established.
* In case of communication errors after pairing, attempts will be made to reestablish bluetooth interfaces automatically.

### Getting the current state of the meter

* Behind the API, there is a state machine running every 750 ms. 
* If there is no command pending from API, read requests will be done to refresh the state at this frequency.
* When the meter is measuring, measurement and error flag are refreshed at this rate (see: btState.lastMeasure). 
* When the meter is generating, setpoint and error flag is read (see: btState.lastSetpoint).

```js

var mstate = await MSC.GetState();
mstate.status         // State machine internal status (Ready,Busy,Pairing,...)
mstate.lastSetpoint   // Last executed generation function. Element at position 0 is the setpoint.
mstate.lastMeasure    // Last measurement. Element at position 0 is the main measurement.
mstate.deviceName     // Name of the bluetooth device paired
mstate.deviceSerial   // Serial number of the MSC device
mstate.deviceMode     // Current mode of the MSC device (see CommandType values)
mstate.stats          // Generic statistics, useful for debugging only.
mstate.ready          // The meter is ready to execute commands
mstate.initializing   // The meter is initializing bluetooth
mstate.batteryLevel   // Internal battery level in Volts
```

* Internal states reference

The state property returned by GetState() can have the following values (see MSC.State enum)

| Constant | Value | Meaning | Next |
| --- | --- | --- | --- |
 NOT_CONNECTED     | 'Not connected'                     | Initial state (before Pair())        | CONNECTING
 CONNECTING        | 'Bluetooth device pairing...'       | Waiting for pairing to complete      | DEVICE_PAIRED
 DEVICE_PAIRED     | 'Device paired'                     | Pairing completed, no BT interface   | SUBSCRIBING
 SUBSCRIBING       | 'Bluetooth interfaces connecting...'| Waiting for BT interfaces            | METER_INIT
 IDLE | 'Idle' | Ready to execute commands            | BUSY
 BUSY              | 'Busy'                              | Executing command or refreshing data | IDLE,ERROR
 ERROR             | 'Error'                             | An exception has occured (BT or data)| METER_INIT
 STOPPING          | 'Closing BT interfaces...'          | Processing Stop request from UI      | STOPPED
 STOPPED           | 'Stopped'                           | Everything has stopped               | -
 METER_INIT        | 'Meter connected'                   | State after SUBSCRIBING              | METER_INITIALIZING
 METER_INITIALIZING| 'Reading meter state...'            | State after METER_INIT (reading data)| IDLE

### Sending commands to the meter

The MSC device supports readings and generations. Each function corresponds to a CommandType enum value.
Generations require one or more setpoint, depending on the specific function.

In all cases, the workflow is the same.

* Read example

```js
var command = new MSC.Command(MSC.CommandType.mV); // Read mV
var result = await MSC.Execute(command);
if (result.error) {
    // Something happened with command execution (device off, comm error...)
    return;
}
var measure = await MSC.GetState().lastMeasure;
if (measure.error) {
    // Measure is not valid ; should retry 
}
else {
    console.log(measure); // Print the measurements
}
```

* Generation example

```js
var command = new MSC.Command(MSC.CommandType.GEN_V, 5.2); // Generate 5.2 V
var result = await MSC.Execute(command);
if (result.error) {
    // Something happened with command execution (device off, comm error...)
    return;
}
var sp = MSC.GetState().lastSetpoint;
if (sp.error) {
    // Generation has error (e.g. short circuit, wrong connections...) 
}
else {
    console.log(sp); // Print the setpoint
}

```

* If another command is pending execution, Execute() will wait until completion.

* If the state machine is stopped, an attempt will be made to start the machine.

* API will try to re-execute the command if communication breaks during execution (see internal states above).

* The API will put the device in OFF state before writing setpoints (for safety), then apply the new mode settings after a slight delay.

* For specific functions (mV/V/mA/Pulses), a statistics reset command will be sent to the meter 1s after mode change.

* To get the expected setpoints for a specific command type, use Command.defaultSetpoint(). This is used in the demo page in order to present to the user the right input boxes with meaningful descriptions.

```js
// Create a temporary command
const command = new MSC.Command(ctype);
// Get the default setpoint for this command type
const setpoints = command.defaultSetpoint();
// Inspect setpoints array to get information about units, setpoint required...
const howmany = Object.keys(setpoints).length;
```

### Various

* Command type int values

```js
const CommandType = {
    mA_passive: 1,
    mA_active: 2,
    V: 3,
    mV: 4,
    THERMO_J: 5, 
    THERMO_K: 6,
    THERMO_T: 7,
    THERMO_E: 8,
    THERMO_L: 9,
    THERMO_N: 10,
    THERMO_R: 11,
    THERMO_S: 12,
    THERMO_B: 13,
    PT100_2W: 14, 
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
    LoadCell: 35,   
    Frequency: 36,  
    PulseTrain: 37, 
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
    SET_UThreshold_F: 1001,
    SET_Sensitivity_uS: 1002,
    SET_ColdJunction: 1003
}
```

## Branches & development info

* Pushes to main will trigger GitHub actions for CI and NPM package update. If the package.json has a new version respect to NPM repository, it will be published automatically. Also, pushes to main branch update the Github pages with the sample application.
* Most development shall happen in development branch, then PR to main once ready.
* Testing is difficult without a real device due to the bluetooth interface. Only basic API tests are covered by JEST package. To run tests:

```bash
npm test
```

* The CommonJS files can be generated in two ways, minified ("dist") or normal ("dev") :

```bash
npm run dev
npm run dist 
```
