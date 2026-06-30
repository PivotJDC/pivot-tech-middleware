const mockSend = jest.fn();
const mockConfig = {
  email: { from: 'noreply@test.io', enabled: true },
  aws: { region: 'us-east-1' },
};

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn(() => ({ send: mockSend })),
  SendEmailCommand: jest.fn((input) => ({ __command: 'SendEmail', input })),
}));
jest.mock('../../src/config', () => mockConfig);
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const { SendEmailCommand } = require('@aws-sdk/client-ses');
const email = require('../../src/integrations/email');

beforeEach(() => {
  mockSend.mockReset();
  SendEmailCommand.mockClear();
  email.resetClient();
  mockConfig.email.enabled = true;
  mockConfig.email.from = 'noreply@test.io';
});

describe('sendEmail', () => {
  it('sends via SES with the configured from + recipient when enabled', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'msg-1' });

    const res = await email.sendEmail({
      to: 'jane@example.com',
      subject: 'Hello',
      textBody: 'plain',
      htmlBody: '<b>rich</b>',
    });

    expect(res).toEqual({ sent: true, messageId: 'msg-1' });
    expect(mockSend).toHaveBeenCalledTimes(1);

    const input = SendEmailCommand.mock.calls[0][0];
    expect(input.Source).toBe('noreply@test.io');
    expect(input.Destination.ToAddresses).toEqual(['jane@example.com']);
    expect(input.Message.Subject.Data).toBe('Hello');
    expect(input.Message.Body.Text.Data).toBe('plain');
    expect(input.Message.Body.Html.Data).toBe('<b>rich</b>');
  });

  it('omits a body part that was not provided', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'msg-2' });
    await email.sendEmail({ to: 'a@b.co', subject: 'S', textBody: 'only text' });
    const input = SendEmailCommand.mock.calls[0][0];
    expect(input.Message.Body.Text).toBeDefined();
    expect(input.Message.Body.Html).toBeUndefined();
  });

  it('logs instead of sending when EMAIL_ENABLED is false', async () => {
    mockConfig.email.enabled = false;
    const res = await email.sendEmail({ to: 'a@b.co', subject: 'S', textBody: 't' });
    expect(res).toEqual({ sent: false, skipped: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws when no recipient is given', async () => {
    await expect(email.sendEmail({ subject: 'S' })).rejects.toThrow(/to/i);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
