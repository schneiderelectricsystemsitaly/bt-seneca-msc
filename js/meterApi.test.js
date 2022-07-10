const MSC = require('bt-seneca-msc')

describe('Basic tests', () => {
    test('API functions exists', () => {
        expect(MSC.Pair).not.toBeNull();
        expect(MSC.Execute).not.toBeNull();
        expect(MSC.Stop).not.toBeNull();
        expect(MSC.GetState).not.toBeNull();
    })
    
    test('Stops succeeds', async () => {
        const data = await MSC.Stop();
        expect(data).toBeTruthy();
    })
    
    test('GetState returns the right properties', async () => {
        const data = await MSC.GetState();
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
})

