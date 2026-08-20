import * as os from 'os';

import * as config from './config';
import * as deviceFlow from './deviceFlow';
import type { PairingCredentials } from './pairingStore';
import * as pairingStore from './pairingStore';
import { defaultHandle, parseHandle, runPair } from './pair';

const BFF = 'http://bff.example.com';

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 3600,
};

const DEVICE_RESPONSE = {
  device_code: 'device-code-1',
  user_code: 'UC-1234',
  verification_uri: 'https://bff.example.com/device-authorize',
};

function validPairing(overrides: Partial<PairingCredentials> = {}): PairingCredentials {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    tokenType: 'Bearer',
    handle: 'dev-agent',
    clientId: 'actorium-local-agent',
    bffUrl: BFF,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('runPair', () => {
  let stdoutWrite: jest.SpyInstance;
  let loadSpy: jest.SpyInstance;
  let saveSpy: jest.SpyInstance;
  let startSpy: jest.SpyInstance;
  let pollSpy: jest.SpyInstance;
  let refreshSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({ bffUrl: BFF });
    loadSpy = jest.spyOn(pairingStore, 'loadPairing').mockReturnValue(null);
    saveSpy = jest.spyOn(pairingStore, 'savePairing').mockImplementation(() => undefined);
    startSpy = jest.spyOn(deviceFlow, 'start').mockResolvedValue(DEVICE_RESPONSE);
    pollSpy = jest.spyOn(deviceFlow, 'pollAndExchange').mockResolvedValue(TOKENS);
    refreshSpy = jest.spyOn(deviceFlow, 'refresh').mockResolvedValue(TOKENS);
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fresh pairing: starts the grant, prints code + URL, exchanges and saves tokens', async () => {
    await runPair(['--handle', 'my-handle']);

    expect(startSpy).toHaveBeenCalledWith(BFF, { client_id: 'actorium-local-agent', handle: 'my-handle' });
    expect(stdoutWrite).toHaveBeenCalledWith(
      'Open https://bff.example.com/device-authorize and enter code: UC-1234\n',
    );
    expect(pollSpy).toHaveBeenCalledWith(BFF, 'device-code-1', 'actorium-local-agent', expect.anything());
    expect(saveSpy).toHaveBeenCalledWith(
      BFF,
      expect.objectContaining({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        handle: 'my-handle',
        clientId: 'actorium-local-agent',
        bffUrl: BFF,
      }),
    );
  });

  it('uses the default handle when --handle is omitted', async () => {
    await runPair([]);

    expect(startSpy).toHaveBeenCalledWith(BFF, {
      client_id: 'actorium-local-agent',
      handle: defaultHandle(),
    });
  });

  it('skip-if-paired: a valid pairing prints status and never starts a grant', async () => {
    loadSpy.mockReturnValue(validPairing());

    await runPair([]);

    expect(startSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith('Paired as @dev-agent\n');
  });

  it('skip-if-paired: an expired pairing is refreshed and re-saved without a new grant', async () => {
    loadSpy.mockReturnValue(validPairing({ updatedAt: Date.now() - 7_200_000 }));

    await runPair([]);

    expect(refreshSpy).toHaveBeenCalledWith(BFF, 'refresh-1');
    expect(startSpy).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalledWith(
      BFF,
      expect.objectContaining({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
    );
  });

  it('falls through to a fresh grant when the refresh fails (e.g. revoked)', async () => {
    loadSpy.mockReturnValue(validPairing({ updatedAt: Date.now() - 7_200_000 }));
    refreshSpy.mockRejectedValue(new deviceFlow.DeviceFlowError('invalid_grant', 'invalid_grant'));

    await runPair(['--handle', 'replacement']);

    expect(startSpy).toHaveBeenCalledWith(BFF, {
      client_id: 'actorium-local-agent',
      handle: 'replacement',
    });
    expect(pollSpy).toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
  });
});

describe('parseHandle', () => {
  it('parses --handle <value>', () => {
    expect(parseHandle(['--handle', 'my-handle'])).toBe('my-handle');
  });

  it('parses --handle=<value>', () => {
    expect(parseHandle(['--handle=my-handle'])).toBe('my-handle');
  });

  it('returns undefined when no handle is given', () => {
    expect(parseHandle([])).toBeUndefined();
  });

  it('returns undefined for a dangling --handle flag', () => {
    expect(parseHandle(['--handle'])).toBeUndefined();
  });
});

describe('defaultHandle', () => {
  it('returns the OS username', () => {
    expect(defaultHandle()).toBe(os.userInfo().username);
  });
});
