# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a pure JavaScript API for the Seneca Multi Smart Calibrator (MSC) device, using Web Bluetooth. The project implements Modbus RTU over Bluetooth to communicate with industrial measurement and calibration equipment.

## Development Commands

### Testing
- `npm test` - Run Jest tests with coverage reporting
- `npm test -- --verbose` - Run tests with detailed output

### Building
- `npm run dev` - Build unminified browserified version to `dist/bt-seneca-msc.js`
- `npm run dist` - Build minified browserified version to `dist/bt-seneca-msc.min.js`

### Installation
- `npm install` - Install dependencies

## Code Architecture

### Core Structure
- **Entry Point**: `meterApi.js` - Main API exports, re-exports from `meterPublicAPI.js`
- **Public API**: `meterPublicAPI.js` - External-facing API methods (Pair, Execute, GetState, etc.)
- **Core Classes**: Located in `classes/` directory
  - `SenecaMSC.js` - Main Bluetooth communication and Modbus operations
  - `APIState.js` - State management for device connection and operations
  - `Command.js` - Command object structure for device operations
  - `CommandResult.js` - Results handling
  - `MeterState.js` - Device state representation

### Communication Stack
- **Bluetooth Layer**: `bluetooth.js` - Web Bluetooth API wrapper
- **Modbus Layer**: 
  - `modbusRtu.js` - Low-level Modbus RTU protocol implementation
  - `senecaModbus.js` - Seneca MSC-specific Modbus commands and parsing
- **Constants**: `constants.js` - Enums for CommandType, State, ResultCode

### Testing Strategy
The project uses Jest with jsdom environment. Due to Bluetooth hardware requirements, testing uses captured Modbus RTU packet traces (hex format) stored in `modbusTestData.js`. A simulation flag in the bluetooth module allows tests to run with pre-recorded device responses.

### TypeScript Integration
- TypeScript source files expected in `ts/` directory
- Compiled output goes to `js/` directory with source maps
- Target: ES2021, CommonJS modules

### Key Patterns
1. **Asynchronous State Machine**: 750ms polling cycle for device state updates
2. **Command Queue**: Sequential command execution with automatic retry on communication errors
3. **Safety First**: Device automatically set to OFF state before applying new generation setpoints
4. **Error Handling**: Comprehensive error states and recovery mechanisms

### Device Communication Flow
1. Pair via Web Bluetooth (user gesture required)
2. Establish Modbus RTU characteristics
3. Initialize device state reading
4. Enter polling loop (measurements/setpoints + error flags)
5. Queue and execute user commands between polling cycles

### Build Output
- **Development**: Browserified standalone `MSC` object (unminified)
- **Production**: Browserified + uglified standalone `MSC` object
- **TypeScript**: Compiled JS with declarations and source maps

## Important Notes
- Web Bluetooth requires user gesture for initial pairing
- Device communication has ~150ms latency per Modbus roundtrip
- Generation commands include 2-3 second safety delays
- Statistics reset sent 1s after mode changes for certain functions
- Browser compatibility requires recent Chrome/Edge or similar Bluetooth-capable browsers