# bt-seneca-msc

[![npm version](https://badge.fury.io/js/bt-seneca-msc.svg)](https://badge.fury.io/js/bt-seneca-msc)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A pure JavaScript API for the Seneca Multi Smart Calibrator (MSC) device, using Web Bluetooth from modern browsers.

**🚀 [Live Demo](https://schneiderelectricsystemsitaly.github.io/bt-seneca-msc/)**

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [API Reference](#api-reference)
- [Usage Examples](#usage-examples)
- [Device Features](#device-features)
- [Performance](#performance)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Overview

This package provides a complete JavaScript interface for the Seneca Multi Smart Calibrator device via Web Bluetooth. It implements Modbus RTU FC3/FC16 functions specifically designed to run in pure browser environments without Node.js dependencies.

**Key Features:**
- Pure browser implementation using Web Bluetooth API
- Modbus RTU protocol over Bluetooth
- Real-time measurement and generation capabilities
- Automatic device state management
- Comprehensive error handling and recovery

**Tested with:**
- Seneca MSC device firmware 1.0.44
- Chrome and Edge browsers on Windows PC
- Android Samsung S10 phone

## Prerequisites

### Browser Requirements
- **Chrome 56+** or **Edge 79+** with Web Bluetooth support
- **Android Chrome 56+** on supported devices
- **Experimental Web Platform Features** may need to be enabled

### Hardware Requirements
- Seneca Multi Smart Calibrator device ([MSC series](https://www.seneca.it/msc/))
- Bluetooth-enabled device
- User gesture required for initial pairing (browser security requirement)

### Browser Compatibility Check
```javascript
if (!navigator.bluetooth) {
    console.error('Web Bluetooth is not supported in this browser');
}
```

## Quick Start

### 1. Include the Library
```html
<!-- CDN -->
<script src="https://cdn.jsdelivr.net/npm/bt-seneca-msc@latest/dist/bt-seneca-msc.min.js"></script>

<!-- Or local -->
<script src="path/to/bt-seneca-msc.min.js"></script>
```

### 2. Pair and Connect
```javascript
// Must be called from a user gesture (button click, etc.)
document.getElementById('connectBtn').addEventListener('click', async () => {
    try {
        const paired = await MSC.Pair(true);
        if (paired) {
            console.log('Device connected successfully!');
        }
    } catch (error) {
        console.error('Pairing failed:', error);
    }
});
```

### 3. Take a Measurement
```javascript
async function measureVoltage() {
    const state = await MSC.GetState();
    if (state.ready) {
        const command = MSC.Command.CreateNoSP(MSC.CommandType.V);
        const result = await MSC.SimpleExecute(command);
        
        if (!result.error) {
            console.log(`Voltage: ${result.value} V`);
        }
    }
}
```

## Installation

### NPM (Node.js/Webpack/Bundlers)
```bash
npm install bt-seneca-msc
```

```javascript
import MSC from 'bt-seneca-msc';
// or
const MSC = require('bt-seneca-msc');
```

### CDN (Browser)
```html
<script src="https://cdn.jsdelivr.net/npm/bt-seneca-msc@latest/dist/bt-seneca-msc.min.js"></script>
```

### LibMan (ASP.NET Core)
```powershell
libman install bt-seneca-msc --provider jsdelivr
```

### Manual Download
Download from the [releases page](https://github.com/schneiderelectricsystemsitaly/bt-seneca-msc/releases) and include the `dist/bt-seneca-msc.min.js` file.

## API Reference

### Core Methods

#### `MSC.Pair(force: boolean): Promise<boolean>`
Pairs with a Bluetooth MSC device.
- `force`: If true, always shows device picker; if false, reconnects to last device
- **Returns:** Promise resolving to connection success
- **Note:** Must be called from user gesture

#### `MSC.Stop(): Promise<boolean>`
Disconnects Bluetooth and stops polling.
- **Returns:** Promise resolving to disconnection success

#### `MSC.Execute(command: Command): Promise<Command>`
Executes a command and returns updated command object.
- `command`: Command object created with `MSC.Command.CreateXXX()` methods
- **Returns:** Promise resolving to updated command with results

#### `MSC.SimpleExecute(command: Command): Promise<CommandResult>`
Executes command and returns simple result value.
- **Returns:** Promise resolving to `{error: boolean, value: any, message: string}`

#### `MSC.GetState(): Promise<MeterState>`
Gets current device state and measurements.
- **Returns:** Promise resolving to complete device state

### JSON API (ASP.NET Core Interop)

#### `MSC.SimpleExecuteJSON(jsonCommand: string): Promise<string>`
JSON version of SimpleExecute.

#### `MSC.ExecuteJSON(jsonCommand: string): Promise<string>`
JSON version of Execute.

#### `MSC.GetStateJSON(): Promise<string>`
JSON version of GetState.

### Command Creation

#### `MSC.Command.CreateNoSP(type: CommandType): Command`
Creates command with no setpoints (measurements).

#### `MSC.Command.CreateOneSP(type: CommandType, setpoint: number): Command`
Creates command with one setpoint (single value generation).

#### `MSC.Command.CreateTwoSP(type: CommandType, setpoint1: number, setpoint2: number): Command`
Creates command with two setpoints (dual value generation).

### State Properties

```javascript
const state = await MSC.GetState();

// Connection status
state.ready           // boolean: Device ready for commands
state.initializing    // boolean: Device initializing
state.status          // string: Current state machine status

// Data
state.lastMeasure     // array: Latest measurement data
state.lastSetpoint    // array: Latest generation setpoint data

// Device info
state.deviceName      // string: Bluetooth device name
state.deviceSerial    // string: MSC device serial number
state.deviceMode      // string: Current device mode
state.batteryLevel    // number: Battery voltage
state.stats           // object: Debug statistics
```

### Device States

| State | Description | Next State |
|-------|-------------|------------|
| `NOT_CONNECTED` | Initial state before pairing | `CONNECTING` |
| `CONNECTING` | Waiting for pairing to complete | `DEVICE_PAIRED` |
| `DEVICE_PAIRED` | Pairing completed, no BT interface | `SUBSCRIBING` |
| `SUBSCRIBING` | Waiting for BT interfaces | `METER_INIT` |
| `METER_INIT` | Connected, initializing meter | `METER_INITIALIZING` |
| `METER_INITIALIZING` | Reading initial meter state | `IDLE` |
| `IDLE` | Ready to execute commands | `BUSY` |
| `BUSY` | Executing command or refreshing data | `IDLE`, `ERROR` |
| `ERROR` | Exception occurred | `METER_INIT` |
| `STOPPING` | Processing stop request | `STOPPED` |
| `STOPPED` | Everything stopped | - |

## Usage Examples

### Basic Voltage Measurement
```javascript
async function measureVoltage() {
    try {
        // Check if device is ready
        const state = await MSC.GetState();
        if (!state.ready) {
            throw new Error('Device not ready');
        }

        // Create measurement command
        const command = MSC.Command.CreateNoSP(MSC.CommandType.V);
        const result = await MSC.SimpleExecute(command);
        
        if (result.error) {
            console.error('Measurement failed:', result.message);
        } else {
            console.log(`Voltage: ${result.value} V`);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}
```

### Voltage Generation
```javascript
async function generateVoltage(voltage) {
    try {
        const state = await MSC.GetState();
        if (!state.ready) {
            throw new Error('Device not ready');
        }

        // Create generation command
        const command = MSC.Command.CreateOneSP(MSC.CommandType.GEN_V, voltage);
        const result = await MSC.Execute(command);
        
        if (result.error) {
            console.error('Generation failed');
        } else {
            console.log(`Generating ${voltage}V`);
            
            // Monitor generation status
            const newState = await MSC.GetState();
            if (newState.lastSetpoint.error) {
                console.error('Generation error detected');
            }
        }
    } catch (error) {
        console.error('Error:', error);
    }
}
```

### Pulse Generation
```javascript
async function generatePulses(count, frequency) {
    try {
        // Set voltage levels first
        await MSC.Execute(MSC.Command.CreateOneSP(MSC.CommandType.SET_Ulow, 0.0));
        await MSC.Execute(MSC.Command.CreateOneSP(MSC.CommandType.SET_Uhigh, 5.0));
        
        // Generate pulses (count, frequency in Hz)
        const command = MSC.Command.CreateTwoSP(MSC.CommandType.GEN_PulseTrain, count, frequency);
        const result = await MSC.Execute(command);
        
        if (!result.error) {
            console.log(`Generating ${count} pulses at ${frequency} Hz`);
        }
    } catch (error) {
        console.error('Pulse generation failed:', error);
    }
}
```

### Continuous Monitoring
```javascript
async function startMonitoring() {
    setInterval(async () => {
        try {
            const state = await MSC.GetState();
            
            if (state.ready && state.lastMeasure && !state.lastMeasure.error) {
                console.log('Current measurement:', state.lastMeasure[0]);
            }
            
            if (state.lastSetpoint && !state.lastSetpoint.error) {
                console.log('Current setpoint:', state.lastSetpoint[0]);
            }
        } catch (error) {
            console.error('Monitoring error:', error);
        }
    }, 1000);
}
```

## Device Features

### Measurements

| Function | Status | Data Returned |
|----------|--------|---------------|
| V, mV readings | ✅ Tested | Instantaneous, min, max values |
| mA active/passive | ✅ Tested | Instantaneous, min, max values |
| RTD 2W readings | ✅ Tested | Temperature (°C) and resistance (Ω) |
| Thermocouples 2W/3W/4W | ✅ Not tested | Temperature (°C) |
| Frequency reading | ✅ Tested | Leading/falling edge frequency |
| Pulse counting | ✅ Tested 0-10kHz | Leading/falling edge counts |
| Load cell | ✅ Not tested | Imbalance mV/V |

### Generation

| Function | Status | Setpoint |
|----------|--------|----------|
| V, mV generation | ✅ Tested | Voltage (mV/V) |
| mA active/passive | ⚠️ Basic testing | Current (mA) |
| RTD 2W simulation | ✅ Not tested | Temperature (°C) |
| Thermocouple simulation | ✅ Not tested | Temperature (°C) |
| Frequency generation | ✅ Tested 0-10kHz | LE and FE frequency (Hz) |
| Pulse generation | ✅ Tested 1kHz | LE and FE frequency (Hz) |
| Load cell simulation | ✅ Not tested | Imbalance mV/V |

### Configuration Settings

| Setting | Command | Range | Status |
|---------|---------|-------|--------|
| Low level voltage | `SET_Ulow` | 0-27V | ✅ Tested |
| High level voltage | `SET_Uhigh` | 0-27V | ✅ Tested |
| Pulse width threshold | `SET_Sensitivity_uS` | 1-∞ μs | ⚠️ Not tested |
| Voltage threshold | `SET_UThreshold_F` | 0-27V | ⚠️ Not tested |
| Cold junction compensation | `SET_ColdJunction` | Various | ⚠️ Not tested |

### Not Implemented Features

- Ramps editing and application
- Data logging start/stop
- Logged data retrieval
- Clock read/sync
- Firmware version read
- mV/V to kg conversion
- Automatic switch off delay

## Performance

| Operation | Typical Time | Notes |
|-----------|--------------|-------|
| Device pairing | 20-40s | Multiple attempts to establish characteristics |
| Command execution | 2-3s | From command to device response |
| Measurement refresh | ~1s | Updated min/max/current values |
| Generation refresh | ~1s | Updated setpoint and error status |
| Modbus roundtrip | ~150ms | Single command/response cycle |

**Polling Frequency:** 750ms automatic state refresh when idle

## Development

### Building

```bash
# Install dependencies
npm install

# Development build (unminified)
npm run dev

# Production build (minified)
npm run dist
```

### Testing

```bash
# Run tests with coverage
npm test

# Verbose test output
npm test -- --verbose
```

**Note:** Tests use captured Modbus RTU packet traces in hex format for simulation, allowing comprehensive testing without physical hardware.

### Project Structure

```
src/
├── classes/           # Core classes
│   ├── SenecaMSC.js      # Main Bluetooth/Modbus operations
│   ├── APIState.js       # State management
│   ├── Command.js        # Command structure
│   └── ...
├── bluetooth.js       # Web Bluetooth wrapper
├── modbusRtu.js      # Modbus RTU protocol
├── senecaModbus.js   # Seneca-specific commands
└── constants.js      # Enums and constants
```

### CI/CD

- **Main branch:** Triggers GitHub Actions for CI and NPM publishing
- **Development branch:** Use for feature development, PR to main when ready
- **GitHub Pages:** Sample application updates on main branch pushes
- **NPM:** Automatic publishing when package.json version changes

## Troubleshooting

### Common Issues

#### "Web Bluetooth is not available"
- Ensure you're using a supported browser (Chrome 56+, Edge 79+)
- Check that Bluetooth is enabled on your device
- Try enabling "Experimental Web Platform Features" in Chrome flags

#### "User cancelled the requestDevice() chooser"
- User must manually select device from browser dialog
- Ensure MSC device is powered on and discoverable
- Device name should start with "MSC"

#### "Device pairing takes too long"
- This is normal (20-40s typical)
- Ensure MSC device remains powered during pairing
- Try moving closer to the device

#### "Commands fail after successful pairing"
- Check device battery level (`state.batteryLevel`)
- Verify device is not in error state
- Try disconnecting and reconnecting

#### "Measurements show error flag"
- Check device connections and probes
- Verify measurement range is appropriate
- Check for overcurrent/overvoltage conditions

### Debug Information

Enable debug logging:
```javascript
const state = await MSC.GetState();
console.log('Debug stats:', state.stats);
```

### Getting Help

- Check the [live demo](https://schneiderelectricsystemsitaly.github.io/bt-seneca-msc/) for working examples
- Review browser console for error messages  
- Ensure proper user gesture handling for pairing
- Verify device compatibility and firmware version

## Contributing

1. Fork the repository
2. Create a feature branch from `development`
3. Make your changes with tests
4. Submit a pull request to `development` branch

### Development Workflow

- Use `development` branch for features
- PR to `main` when ready for release
- Tests must pass and maintain coverage
- Follow existing code style and patterns

## License

MIT License - see LICENSE file for details.

---

**Seneca MSC Device Information:** https://www.seneca.it/msc/