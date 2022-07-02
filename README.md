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
await MSC.MeterPair(); // bool - Pair to bluetooth
await MSC.MeterStop(); // bool - Disconnect the bluetooth and stops the polling
await MSC.MeterExecute(MSC.Command); // bool - Execute command. If the device is not paired, an attempt will be made.
await MSC.MeterState(); // APIState - Get the current state
```
### Connecting to the meter

* Call MSC.MeterPair() while handling a user gesture in the browser (i.e. button-click)
```
 var result = await MSC.MeterPair(); // true when connection has been established
```
* A dialog will be shown to the user of devices with bluetooth name beginning with MSC
* After pairing, the required bluetooth interfaces for Modbus RTU read and write will be established.
* In case of communication errors after pairing, attempts will be made to reestablish bluetooth interfaces automatically.

### Getting the current state of the meter

* Behind the API, there is a state machine running every 750 ms. 
* When the meter is measuring, measurement and error flag are refreshed at this rate (see: btState.lastMeasure). 
* When the meter is generating, setpoint and error flag is read (see: btState.lastSetpoint).

```
MSC.btState.state           // State machine internal status (Ready,Busy,Pairing,...)
MSC.btState.lastSetpoint    // Last executed generation function. Check for error flag. Element at position 0 is the setpoint.
MSC.btState.lastMeasure     // Last measurement. Element at position 0 is the main measurement.
MSC.btState.btDevice?.name; // Name of the bluetooth device paired
MSC.btState.meter.serial;   // Serial number of the MSC device
MSC.btState.meter.mode      // Current mode of the MSC device (see CommandType values)
MSC.btState.stats           // Generic statistics, useful for debugging only.
```

### Sending commands to the meter

The MSC device supports readings and generations. Each function corresponds to a CommandType enum value.
Generations require one or more setpoint, depending on the specific function. 

In all cases, the workflow is the same. 

* Create a Command object
```
```
* Call MSC.MeterExecute() and verify the returned value
** If another command is pending execution, MeterExecute will wait until completion-
** The API will put the device in OFF state before writing the setpoint for safety, then apply the new mode settings.
** For some functions, statistics reset command will be sent to the meter.

