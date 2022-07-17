# bt-seneca-msc project

A pure Javascript API for the Seneca Multi Smart Calibrator device, using web bluetooth.

This package has only one logger package as dependency, it implements modbus RTU FC3/FC16 functions. The reason is that most modbus implementations I found are requiring Node.js environment, whereas my goal was to run in a pure browser environment.
This oackage has been tested with a Seneca MSC device with firmware 1.0.44 ; testing was performed on PC/Windows with Chrome and Edge and Android Samsung S10 phone.
The distribution versions are CommonJS (browserified with a standalone MSC object) ; examples below.
This package can probably be adapted from Bluetooth to serial comm with little effort, but at the time I don't need it.

* A sample application is available here: :point_right: https://pbrunot.github.io/bt-seneca-msc/ :point_left:

## Requirements and limitations

* A recent browser supporting bluetooth
* A Seneca Multi Smart Calibrator device (see https://www.seneca.it/msc/ )
* MSC features status:

| Measurements | Implementation | Data returned |
| --- | --- | --- |
| V, mV readings                | Done and tested           | Only Instantaneous, min, max values (no avg) |
| mA active/passive readings    | Done and tested           | Only Instantaneous, min, max values (no avg) |
| RTD readings                  | Done and tested 2W        | Instantaneous RTD °C and Ohms values |
| Thermocouples 2W/3W/4W read   | Done :grey_exclamation: *not tested*  | Instantaneous °C value |
| Frequency reading             | Done and tested           | Frequency of leading and falling edges |
| Pulse count reading           | Done and tested 0-10kHz   | Counts of leading and falling edges |
| Frequency reading             | Done and tested           | Tested with square wave 0-10 kHz |
| Load cell                     | Done :grey_exclamation: *not tested* | Imbalance mV/V |

| Generation | Implementation | Setpoint |
| --- | --- | --- |
| V, mV                         | Done and tested           | 1 Setpoint (mV/V) |
| mA active/passive             | Done *basic testing*      | 1 Setpoint (mA) |
| RTD 2W                        | Done :grey_exclamation: *not tested*  | 1 Setpoint RTD °C |
| Thermocouples                 | Done :grey_exclamation: *not tested* | 1 Setpoint °C value *no Cold junction* |
| Frequency (square waves)      | Done and tested 0-10kHz   | 2 Setpoints: LE and FE f (Hz) |
| Pulses count generation       | Done and tested 1 kHz     | 2 Setpoints: LE and FE f (Hz) |
| Load cell                     | Done :grey_exclamation: *not tested* | 1 Setpoint : Imbalance mV/V |

| Others features | Status |
| --- | --- |
| Ramps editing          | Not implemented, not planned |
| Ramps application      | Not implemented, not planned |
| Data logging start/stop| Not implemented, not planned |
| Logged data retrieval  | Not implemented, not planned |
| Clock read/sync        | Not implemented |
| Firmware version read  | Not implemented |
| Battery level          | Read once, after pairing |
| Conversion of mV/V to kg | Calculation not implemented |
| Automatic switch off delay | Not implemented |

| Settings of measures/generation modes| Implementation | Notes |
| --- | --- | --- |
| Low level for pulse/square wave generation | CommandType.SET_Ulow | Voltage 0-27 V (tested)
| High level for pulse/square wave generation | CommandType.SET_Uhigh | Voltage 0-27 V (tested)
| Minimum pulse width in microsec | CommandType.SET_Sensitivity_uS | Unknown range 1-??? uS *not tested* same threshold for LE/FE
| Tension threshold for frequency/pulse measurement | CommandType.SET_UThreshold_F | Voltage 0-27 V *not tested* 
| Setting of cold junction compensation | CommandType.SET_ColdJunction |Implemented  *not tested* |

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
await MSC.Execute(MSC.Command); // Execute command. If the device is not paired, an attempt will be made. Command is returned with updated properties.
await MSC.GetState(); // array - Get the current state
```

* JSON versions are available for ASPNET.core interop

```js
await MSC.ExecuteJSON(jsonCommand); // Expects a json string (Command) and returns a json string (update Command object)
await MSC.GetStateJSON(); // returns a json string with the same properties as GetState()
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
mstate.ready          // The meter is ready to execute commands
mstate.initializing   // The meter is initializing bluetooth
mstate.status         // State machine internal status (Ready,Busy,Pairing,...)
mstate.lastSetpoint   // Last executed generation function. Element at position 0 is the setpoint.
mstate.lastMeasure    // Last measurement. Element at position 0 is the main measurement.
mstate.deviceName     // Name of the bluetooth device paired
mstate.deviceSerial   // Serial number of the MSC device
mstate.deviceMode     // Current mode of the MSC device (see CommandType values)
mstate.stats          // Generic statistics, useful for debugging only.
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

* Command class

```js
var comm = new MSC.Command(CommandType.<function>, null|setpoint|[setpoint1, setpoint2])
comm.error // true if the Execute method has failed 
comm.type  // type of the command
comm.setpoint  // copy of setpoints
comm.defaultSetpoint() // see below
```

* Read example

```js
var state = await MSC.GetState();
if (state.ready) { // Check that the meter is ready
    var command = new MSC.Command(MSC.CommandType.mV); // Read mV function
    var result = await MSC.Execute(command);
    if (result.error) { // Check the error property of returned Command
        // Something happened with command execution (device off, comm error...)
    }
    var measure = await MSC.GetState().lastMeasure; // This property will update approx. every second
    if (measure.error) { // Meter is signalling an error with the measurement. E.g. overcurrent.
        // Measure is not valid ; should retry 
    }
    else {
        console.log(measure); // Print the measurements
        // Note that the raw value will always be measure[0]
    }
}
else {
    if (state.initializing) {
        // Wait some more, the meter is connecting
    } else {
        // Not connected, ask the user to pair again
    }
}
```

* Generation example 

```js
var state = await MSC.GetState();
if (state.ready) {
    var command = new MSC.Command(MSC.CommandType.GEN_V, 5.2); // Generate 5.2 V
    var result = await MSC.Execute(command);
    if (result.error) { // Check the error property of returned Command
        // Something happened with command execution (device off, comm error...)
    }
    var sp = MSC.GetState().lastSetpoint;
    if (sp.error) {
        // Generation has error (e.g. short circuit, wrong connections...) 
    }
    else {
        console.log(sp); // Print the setpoint
    }
}
else {
    if (state.initializing) {
        // Wait some more
    } else {
        // Not connected, ask the user to pair again
    }
}
```

* Generating 100 pulses of 50 ms each, with low = 0 V and high = 5 V

```js
// Assuming meter.ready

var command1 = new MSC.Command(MSC.CommandType.SET_Ulow, 0.0); 
var result1 = await MSC.Execute(command1);
if (result1.error) { // Check the error property of returned Command
    // Something happened with command execution (device off, comm error...)
}
var command2 = new MSC.Command(MSC.CommandType.SET_Uhigh, 5.0); 
var result2 = await MSC.Execute(command2);
if (result2.error) { // Check the error property of returned Command
    // Something happened with command execution (device off, comm error...)
}
var command3 = new MSC.Command(MSC.CommandType.GEN_PulseTrain, [100, 1000/50]]); 
var result3 = await MSC.Execute(command3);
if (result3.error) { // Check the error property of returned Command
    // Something happened with command execution (device off, comm error...)
} else {
    // MSC is now generating the pulses
}
```

* If another command is pending execution, Execute() will wait until completion of the previous command.
* If the state machine is stopped, an attempt will be made to start the machine. This may require to Pair the device and it will fail if Execute is not called from a user-gesture handling function in the browser.
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

### :alarm_clock: Response times observed

| Operation | Typical time observed | Notes
| --- | --- | --- |
| Pair the device | 20-40s | It takes several tries to establish bluetooth characteristics
| Execute generation | 2-3s | From command to device output
| Execute measurement | 2-3s | From command to device reading
| Refresh measurement | 1s | To get updated min/max/current values and error flag
| Refresh generation stats | 1s | To get updated generation setpoint and error flag
| Modbus roundtrip | approx 150ms | From command to answer

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

## C# bindings

* The following classes can be json-serialized/deserialized with their equivalent JS versions.

```C#
    
/// <summary>
/// Statistics returned by GetState()
/// </summary>
public class MSCStats
{
    public int requests = 0;
    public int responses = 0;
    public int modbus_errors = 0;
    [JsonProperty("GATT disconnects")]
    public int GATT_disconnects = 0;
    public int exceptions = 0;
    public int subcribes = 0;
    public int commands = 0;
    public float responseTime = 0;
    public string lastResponseTime = "";
    public DateTime last_connect;
    public override string ToString()
    {
        return $"exceptions={exceptions}, GATT disconnects={GATT_disconnects}, subscribes={subcribes}, requests={requests}, responses={responses}, response time={responseTime}, " +
                $"last response time = {lastResponseTime}, last connect = {last_connect.ToLocalTime()}, modbus errors = {modbus_errors}";
    }
}

/// <summary>
/// Represents a generation setpoint or measurement results
/// </summary>
public class Measurement
{
    [JsonProperty("error")]
    public bool Error = false;
    
    public DateTime Timestamp = new DateTime(2020,1,1);
    public float? Value = 0.0f;
    public string Unit = "";
    public string Description ="";

    // Some measure have min/max statistics returned by JS
    public float? Minimum = null;
    public float? Maximum = null;

    // Some measurement returns several values, e.g. °C and ohms.
    public float? SecondaryValue = null;
    public string SecondaryUnit = "";
    public string SecondaryDescription = "";

    public override string ToString()
    {
        var output = $"{Description}={Value} {Unit} ({Timestamp.ToLocalTime()}), error:{Error}";
        if (this.Minimum !=null || this.Maximum != null)
        {
            output += $", Maximum={this.Maximum}, Minimum={this.Minimum}";
        }
        if (!String.IsNullOrEmpty(SecondaryDescription) || SecondaryValue != null)
        {
            output += $", Secondary data: {SecondaryDescription}={SecondaryValue} {SecondaryUnit}";
        }
        return output;
    }
}

/// <summary>
/// Mapping of JS bt-seneca-msc State class to c#
/// </summary>
public class MSCState
{
    /// <summary>
    /// True if the meter can execute commands
    /// </summary>
    public bool ready = false;
    /// <summary>
    /// True if the meter is initializing bluetooth
    /// </summary>
    public bool initializing = false;
    /// <summary>
    /// Internal state of the state machine for debugging
    /// </summary>
    public string status;
    /// <summary>
    /// Last refreshed setpoint (valid only when generating)
    /// </summary>
    public Measurement lastSetpoint = new Measurement();
    /// <summary>
    /// Last refreshed measurement (valid only when measuring)
    /// </summary>
    public Measurement lastMeasure = new Measurement();
    /// <summary>
    /// Bluetooth device name
    /// </summary>
    public string deviceName = "";
    /// <summary>
    /// Device serial number
    /// </summary>
    public string deviceSerial = "";
    /// <summary>
    /// Current mode of the device
    /// </summary>
    public int deviceMode;
    /// <summary>
    /// Statistics for communications with the devices
    /// </summary>
    public MSCStats stats = new MSCStats();
    /// <summary>
    /// Internal battery level in volts
    /// </summary>
    public float batteryLevel = 0.0f;

    public override string ToString()
    {
        return $"Ready:{ready}, Initializing:{initializing}, Status:{status}, Device name:{deviceName}, Device serial:{deviceSerial}, Mode: {(CommandType)this.deviceMode}, Battery level:{batteryLevel}, " +
            $"Last setpoint: {lastSetpoint}, Last measure: {lastMeasure}, stats: {stats}";
    }
}

/// <summary>
/// Mapping of JS bt-seneca-msc Command class to c# 
/// </summary>
public class MSCCommand
{
    public int type;
    public dynamic setpoint;
    public bool error = false;
    public bool pending = true;
    public MSCCommand() { this.type = (int)CommandType.NONE_UNKNOWN; }
    public MSCCommand(CommandType type)
    {
        this.type = (int)type;
    }
    public MSCCommand(CommandType type, float setpoint)
    {
        this.type = (int)type;
        this.setpoint = setpoint;
    }
    public MSCCommand(CommandType type, float[] setpoints)
    {
        this.type = (int)type;
        this.setpoint = setpoints;
    }
    public override string ToString()
    {
        return $"Type:{(CommandType)type}, Setpoint:{setpoint}, pending:{pending}, error:{error}";
    }
}

/// <summary>
/// Modes of the meter
/// </summary>
public enum CommandType : int
{
    NONE_UNKNOWN= 0, /*** MEASURING FEATURES AFTER THIS POINT *******/
    mA_passive= 1,
    mA_active= 2,
    V= 3,
    mV= 4,
    THERMO_J= 5, // Termocoppie
    THERMO_K= 6,
    THERMO_T= 7,
    THERMO_E= 8,
    THERMO_L= 9,
    THERMO_N= 10,
    THERMO_R= 11,
    THERMO_S= 12,
    THERMO_B= 13,
    PT100_2W= 14, // RTD 2 fili
    PT100_3W= 15,
    PT100_4W= 16,
    PT500_2W= 17,
    PT500_3W= 18,
    PT500_4W= 19,
    PT1000_2W= 20,
    PT1000_3W= 21,
    PT1000_4W= 22,
    Cu50_2W= 23,
    Cu50_3W= 24,
    Cu50_4W= 25,
    Cu100_2W= 26,
    Cu100_3W= 27,
    Cu100_4W= 28,
    Ni100_2W= 29,
    Ni100_3W= 30,
    Ni100_4W= 31,
    Ni120_2W= 32,
    Ni120_3W= 33,
    Ni120_4W= 34,
    LoadCell= 35,   // Celle di carico
    Frequency= 36,  // Frequenza
    PulseTrain= 37, // Conteggio impulsi
    RESERVED= 38,
    RESERVED_2= 40,
    OFF= 100, // ********* GENERATION AFTER THIS POINT *****************/
    GEN_mA_passive= 101,
    GEN_mA_active= 102,
    GEN_V= 103,
    GEN_mV= 104,
    GEN_THERMO_J= 105,
    GEN_THERMO_K= 106,
    GEN_THERMO_T= 107,
    GEN_THERMO_E= 108,
    GEN_THERMO_L= 109,
    GEN_THERMO_N= 110,
    GEN_THERMO_R= 111,
    GEN_THERMO_S= 112,
    GEN_THERMO_B= 113,
    GEN_PT100_2W= 114,
    GEN_PT500_2W= 117,
    GEN_PT1000_2W= 120,
    GEN_Cu50_2W= 123,
    GEN_Cu100_2W= 126,
    GEN_Ni100_2W= 129,
    GEN_Ni120_2W= 132,
    GEN_LoadCell= 135,
    GEN_Frequency= 136,
    GEN_PulseTrain= 137,
    GEN_RESERVED= 138,
    // Special settings below this point
    SETTING_RESERVED= 1000,
    SET_UThreshold_F= 1001,
    SET_Sensitivity_uS= 1002,
    SET_ColdJunction= 1003,
    SET_Ulow= 1004,
    SET_Uhigh= 1005,
};
```