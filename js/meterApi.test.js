const MSC = require('bt-seneca-msc');
const { CommandType } = require('./meterApi');

describe('Basic tests', () => {
    test('API functions exists', () => {
        expect(MSC.Pair).not.toBeNull();
        expect(MSC.Execute).not.toBeNull();
        expect(MSC.Stop).not.toBeNull();
        expect(MSC.GetState).not.toBeNull();
    })
    
    test('API exports exists', () => {
        expect(MSC.Command).not.toBeNull();
        expect(MSC.CommandType).not.toBeNull();
        expect(MSC.log).not.toBeNull();
    })
    test('GetState returns the right properties', async () => {
        let data = await MSC.GetState();
        expect(data).not.toBeNull();
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('lastSetpoint');
        expect(data).toHaveProperty('lastMeasure');
        expect(data).toHaveProperty('deviceName');
        expect(data).toHaveProperty('deviceSerial');
        expect(data).toHaveProperty('deviceMode');
        expect(data).toHaveProperty('stats');
        expect(data).toHaveProperty('ready');
        expect(data).toHaveProperty('initializing');
        expect(data).toHaveProperty('batteryLevel');

        let datajson = await MSC.GetStateJSON();
        data = JSON.parse(datajson);
        expect(data).not.toBeNull();
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('lastSetpoint');
        expect(data).toHaveProperty('lastMeasure');
        expect(data).toHaveProperty('deviceName');
        expect(data).toHaveProperty('deviceSerial');
        expect(data).toHaveProperty('deviceMode');
        expect(data).toHaveProperty('stats');
        expect(data).toHaveProperty('ready');
        expect(data).toHaveProperty('initializing');
        expect(data).toHaveProperty('batteryLevel');
    })

    test('Initial state is not connected', async () => {
        const data = await MSC.GetState();
        expect(data.status).toBe(MSC.State.NOT_CONNECTED);
        expect(data.ready).toBeFalsy();
        expect(data.initializing).toBeFalsy();
    })

    test('Stops succeeds', async () => {
        const result = await MSC.Stop();
        expect(result).toBeTruthy();

        const data = await MSC.GetState();
        expect(data.status).toBe(MSC.State.NOT_CONNECTED);
        expect(data.ready).toBeFalsy();
        expect(data.initializing).toBeFalsy();
    })
        
    test('Pair fails (not in browser)', async () => {
        const result = await MSC.Pair();
        // Will fail without navigator object
        expect(result).toBeFalsy();

        const data = await MSC.GetState();
        expect(data.status).toBe(MSC.State.STOPPED);
        expect(data.ready).toBeFalsy();
        expect(data.initializing).toBeFalsy();
    })
    
    test('Measurement execution fails', async () => {
        const command = new MSC.Command(MSC.CommandType.V);
        const result = await MSC.Execute(command);
        expect(result).not.toBeNull();
        // Will stay pending since the state machine is not running
        expect(result.pending).toBeTruthy();
    })
    
    test('Generation execution fails', async () => {
        const command = new MSC.Command(MSC.CommandType.GEN_V, 1.23);
        const result = await MSC.Execute(command);
        expect(result).not.toBeNull();
        // Will stay pending since the state machine is not running
        expect(result.pending).toBeTruthy();
    })   

    test('Command.getDefaultSetpoint and Command properties', async () => {
        for(var ctype in CommandType) {
            const command = new MSC.Command(CommandType[ctype]);
            const info = command.defaultSetpoint();
            expect(info).not.toBeNull();
            const test = command.isGeneration() || command.isMeasurement() || command.isSetting() || !command.isValid();
            expect(test).toBeTruthy();
        }
        var comm = new MSC.Command(MSC.CommandType.GEN_V);
        expect(comm.isGeneration()).toBeTruthy();
        comm = new MSC.Command(MSC.CommandType.mA_passive);
        expect(comm.isMeasurement()).toBeTruthy();
        comm = new MSC.Command(MSC.CommandType.SET_Ulow);
        expect(comm.isSetting()).toBeTruthy();

    })

    test('Non-null refreshed properties of GetState', async () => {
        const data = await MSC.GetState();
        expect(data.lastMeasure).not.toBeNull();
        expect(data.lastSetpoint).not.toBeNull();
        expect(Array.isArray(data.lastMeasure)).toBeTruthy();
        expect(Array.isArray(data.lastSetpoint)).toBeTruthy();
    })

    test('JSON Execute works', async () => {
        var comm = new MSC.Command(MSC.CommandType.GEN_V);
        var setpoint = 5.0;
        var result = JSON.parse(await MSC.ExecuteJSON(JSON.stringify(comm), JSON.stringify(setpoint)));
        expect(result).toHaveProperty('error');
        expect(result).toHaveProperty('pending');
        expect(result.pending).toBeTruthy();

        comm = new MSC.Command(MSC.CommandType.GEN_PulseTrain);
        setpoint = [5,10];
        result = JSON.parse(await MSC.ExecuteJSON(JSON.stringify(comm), JSON.stringify(setpoint)));

        expect(result).toHaveProperty('error');
        expect(result).toHaveProperty('pending');
        expect(result.pending).toBeTruthy();

        result = JSON.parse(await MSC.ExecuteJSON(JSON.stringify(comm), JSON.stringify(setpoint)));
    });
})

