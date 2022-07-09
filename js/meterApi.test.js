const MSC = require('bt-seneca-msc')

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
})

test('Initial state is not connected', async () => {
    const data = await MSC.GetState();
    expect(data.status).toBe(MSC.State.NOT_CONNECTED);
})

test('Pair fails (not in browser)', async () => {
    const data = await MSC.Pair();
    expect(data).toBeFalsy();
})