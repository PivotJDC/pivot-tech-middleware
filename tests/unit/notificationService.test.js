const notificationService = require('../../src/services/notificationService');

describe('notificationService.notify (stub)', () => {
  it('resolves successfully and echoes the event', async () => {
    const result = await notificationService.notify({ id: 'acc-1' }, 'port.completed', { x: 1 });
    expect(result).toEqual({ stubbed: true, event: 'port.completed' });
  });

  it('tolerates a missing account', async () => {
    const result = await notificationService.notify(undefined, 'port.failed');
    expect(result.stubbed).toBe(true);
  });
});
