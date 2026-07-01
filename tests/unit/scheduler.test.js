jest.mock('../../src/config', () => ({ usage: { pollIntervalHours: 4 } }));
jest.mock('../../src/services/usageService');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const usageService = require('../../src/services/usageService');
const scheduler = require('../../src/scheduler');

const FOUR_HOURS = 4 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  usageService.pollAllActiveAccounts.mockResolvedValue({ polled: 1, succeeded: 1, failed: 0 });
});

afterEach(() => {
  scheduler.stop();
  jest.useRealTimers();
});

describe('scheduler', () => {
  it('does not poll immediately, then polls every interval', () => {
    scheduler.start();
    expect(usageService.pollAllActiveAccounts).not.toHaveBeenCalled();

    jest.advanceTimersByTime(FOUR_HOURS);
    expect(usageService.pollAllActiveAccounts).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(FOUR_HOURS);
    expect(usageService.pollAllActiveAccounts).toHaveBeenCalledTimes(2);
  });

  it('start is idempotent (a second call does not double-schedule)', () => {
    scheduler.start();
    scheduler.start();
    jest.advanceTimersByTime(FOUR_HOURS);
    expect(usageService.pollAllActiveAccounts).toHaveBeenCalledTimes(1);
  });

  it('stop cancels the timer', () => {
    scheduler.start();
    scheduler.stop();
    jest.advanceTimersByTime(FOUR_HOURS * 3);
    expect(usageService.pollAllActiveAccounts).not.toHaveBeenCalled();
  });

  it('runPoll swallows errors and resolves null', async () => {
    usageService.pollAllActiveAccounts.mockRejectedValueOnce(new Error('BICS down'));
    await expect(scheduler.runPoll()).resolves.toBeNull();
  });

  it('runPoll returns the summary on success', async () => {
    await expect(scheduler.runPoll()).resolves.toEqual({ polled: 1, succeeded: 1, failed: 0 });
  });
});
