# bt-seneca-msc
A pure Javascript API for the Seneca Multi Smart Calibrator device, using web bluetooth.

It has minimal dependencies (one logger packages), implements modbus RTU FC3/FC16 functions and has been tested with a Seneca MSC device with firmware 1.0.44 ; tested on PC/Windows with Chrome and Edge. Source is Node.js but the distribution versions are CommonJS (browserified with a standalone MSC object).

A sample application is available here: https://pbrunot.github.io/bt-seneca-msc/

## Requirements and limitations
* A recent browser supporting bluetooth
* A Seneca Multi Smart Calibrator device (see https://www.seneca.it/msc/ )
* Not all MSC features are implemented, missing:
** Ramps
** Data-logging
** Clock sync
## How to build

* Install Node.js 
* Checkout the repository
* Run from your command line:
```
    npm install
    npm run dist
    npm run dev
```

## How to use in your application

* For Node.js applications :
```
npm install bt-seneca-msc
```
* For ASPNET.core :
```
libman install bt-seneca-msc --provider jsdelivr
```

## External API

There are 4 operations available:
```
await MSC.Pair(); // bool - Pair to bluetooth
await MSC.Stop(); // bool - Disconnect the bluetooth and stops the polling
await MSC.Execute(MSC.Command); // bool - Execute command. If the device is not paired, an attempt will be made.
await MSC.GetState(); // array - Get the current state
```
### Connecting to the meter

* Call MSC.Pair() while handling a user gesture in the browser (i.e. button-click)
```
 var result = await MSC.Pair(); // true when connection has been established
```
* A dialog will be shown to the user of devices with bluetooth name beginning with MSC
* After pairing, the required bluetooth interfaces for Modbus RTU read and write will be established.
* In case of communication errors after pairing, attempts will be made to reestablish bluetooth interfaces automatically.

### Getting the current state of the meter

* Behind the API, there is a state machine running every 750 ms. 
* When the meter is measuring, measurement and error flag are refreshed at this rate (see: btState.lastMeasure). 
* When the meter is generating, setpoint and error flag is read (see: btState.lastSetpoint).

```
var mstate = MSC.GetState();
mstate.state           // State machine internal status (Ready,Busy,Pairing,...)
mstate.lastSetpoint    // Last executed generation function. Check for error flag. Element at position 0 is the setpoint.
mstate.lastMeasure     // Last measurement. Element at position 0 is the main measurement.
mstate.deviceName     // Name of the bluetooth device paired
mstate.deviceSerial   // Serial number of the MSC device
mstate.deviceMode      // Current mode of the MSC device (see CommandType values)
mstate.stats           // Generic statistics, useful for debugging only.
```
* Internal states reference

```
const State = {
    NOT_CONNECTED: 'Not connected',
    CONNECTING: 'Bluetooth device pairing...',
    DEVICE_PAIRED: 'Device paired',
    SUBSCRIBING: 'Bluetooth interfaces connecting...',
    READY: 'Ready',
    BUSY: 'Busy',
    ERROR: 'Error',
    STOPPING: 'Closing BT interfaces...',
    STOPPED: 'Stopped',
    METER_INIT: 'Acquiring meter state...',
    METER_INITIALIZING: 'Reading meter state...'
};
```

### Sending commands to the meter

The MSC device supports readings and generations. Each function corresponds to a CommandType enum value.
Generations require one or more setpoint, depending on the specific function. 

In all cases, the workflow is the same. 

* Create a Command object
```
```
* Call MSC.Execute() and verify the returned value

If another command is pending execution, Execute() will wait until completion.

The API will put the device in OFF state before writing the setpoint for safety, then apply the new mode settings.

For some functions, statistics reset command will be sent to the meter.

### Various

* Command type int values

```
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
    GEN_PulseTrain: 137
}
```
    
