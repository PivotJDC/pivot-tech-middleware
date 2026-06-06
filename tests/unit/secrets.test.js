jest.mock('@aws-sdk/client-secrets-manager', () => {
  const send = jest.fn();
  return {
    mockSend: send,
    SecretsManagerClient: jest.fn(() => ({ send })),
    GetSecretValueCommand: jest.fn((input) => input),
  };
});

const sdk = require('@aws-sdk/client-secrets-manager');
const { loadSecrets } = require('../../src/config/secrets');

const TEST_ARN = 'arn:aws:secretsmanager:us-east-1:430155298813:secret:pivot-tech-middleware-AbCdEf';

describe('loadSecrets', () => {
  const envKeys = ['SECRETS_ARN', 'TEST_SECRET_A', 'TEST_SECRET_B', 'TEST_EXISTING'];
  let consoleLog;

  beforeEach(() => {
    jest.clearAllMocks();
    envKeys.forEach((key) => delete process.env[key]);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    envKeys.forEach((key) => delete process.env[key]);
    consoleLog.mockRestore();
  });

  it('is a no-op when SECRETS_ARN is unset', async () => {
    const result = await loadSecrets();

    expect(result).toEqual({ loaded: false, injected: 0 });
    expect(sdk.mockSend).not.toHaveBeenCalled();
  });

  it('fetches the secret by ARN and injects keys into process.env', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    sdk.mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ TEST_SECRET_A: 'value-a', TEST_SECRET_B: 'value-b' }),
    });

    const result = await loadSecrets();

    expect(sdk.GetSecretValueCommand).toHaveBeenCalledWith({ SecretId: TEST_ARN });
    expect(process.env.TEST_SECRET_A).toBe('value-a');
    expect(process.env.TEST_SECRET_B).toBe('value-b');
    expect(result).toEqual({ loaded: true, injected: 2 });
  });

  it('never overwrites values already present in the environment', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    process.env.TEST_EXISTING = 'from-platform';
    sdk.mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ TEST_EXISTING: 'from-secret', TEST_SECRET_A: 'value-a' }),
    });

    const result = await loadSecrets();

    expect(process.env.TEST_EXISTING).toBe('from-platform');
    expect(process.env.TEST_SECRET_A).toBe('value-a');
    expect(result).toEqual({ loaded: true, injected: 1 });
  });

  it('logs key names and counts but never secret values', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    process.env.TEST_EXISTING = 'from-platform';
    sdk.mockSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ TEST_EXISTING: 'sw-secret-value', TEST_SECRET_A: 'value-a' }),
    });

    await loadSecrets();

    const logged = consoleLog.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('injected 1 value(s)');
    expect(logged).toContain('TEST_EXISTING');
    expect(logged).not.toContain('sw-secret-value');
    expect(logged).not.toContain('value-a');
  });

  it('throws when the secret value is not valid JSON', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    sdk.mockSend.mockResolvedValueOnce({ SecretString: 'not-json' });

    await expect(loadSecrets()).rejects.toThrow('secret value is not valid JSON');
  });

  it('throws when the secret parses to a non-object', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    sdk.mockSend.mockResolvedValueOnce({ SecretString: '["a","b"]' });

    await expect(loadSecrets()).rejects.toThrow('must be a JSON object');
  });

  it('throws when the secret has no SecretString', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    sdk.mockSend.mockResolvedValueOnce({});

    await expect(loadSecrets()).rejects.toThrow('binary secrets are not supported');
  });

  it('propagates SDK errors (bad ARN, missing IAM permission)', async () => {
    process.env.SECRETS_ARN = TEST_ARN;
    sdk.mockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));

    await expect(loadSecrets()).rejects.toThrow('AccessDeniedException');
  });
});
