import * as childProcess from 'child_process';
import * as os from 'os';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

import * as config from './config';
import * as deviceFlow from './deviceFlow';
import type { PairingCredentials } from './pairingStore';
import * as pairingStore from './pairingStore';
import * as pair from './pair';
import { defaultHandle, openBrowser, parseApiUrl, parseHandle, parseNoOpen, runPair } from './pair';

const BFF = 'http://bff.example.com';
const API_FLAG = '--api-url';

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 3600,
};

const DEVICE_RESPONSE = {
  device_code: 'device-code-1',
  user_code: 'UC-1234',
  verification_uri: 'https://app.example.com/device-authorize',
  verification_uri_complete: 'https://app.example.com/device-authorize?user_code=UC-1234',
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
  let openSpy: jest.Mock;

  beforeEach(() => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({ bffUrl: BFF });
    loadSpy = jest.spyOn(pairingStore, 'loadPairing').mockReturnValue(null);
    saveSpy = jest.spyOn(pairingStore, 'savePairing').mockImplementation(() => undefined);
    startSpy = jest.spyOn(deviceFlow, 'start').mockResolvedValue(DEVICE_RESPONSE);
    pollSpy = jest.spyOn(deviceFlow, 'pollAndExchange').mockResolvedValue(TOKENS);
    refreshSpy = jest.spyOn(deviceFlow, 'refresh').mockResolvedValue(TOKENS);
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // never actually launch a browser from the suite
    openSpy = jest.fn().mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fresh pairing: starts the grant, prints code + URL, exchanges and saves tokens', async () => {
    await runPair([API_FLAG, BFF, '--handle', 'my-handle']);

    expect(startSpy).toHaveBeenCalledWith(BFF, { client_id: 'actorium-local-agent', handle: 'my-handle' });
    expect(stdoutWrite).toHaveBeenCalledWith('Open https://app.example.com/device-authorize?user_code=UC-1234\n');
    expect(stdoutWrite).toHaveBeenCalledWith('and enter code: UC-1234\n');
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
    await runPair([API_FLAG, BFF]);

    expect(startSpy).toHaveBeenCalledWith(BFF, {
      client_id: 'actorium-local-agent',
      handle: defaultHandle(),
    });
  });

  // `pair` always starts a fresh grant now. Reusing a cached credential made it
  // a silent no-op whenever the local file and the server disagreed: the file
  // says paired, the server has no record, and re-running only reprinted the
  // stale credential with no way to recover.
  it('always starts a fresh grant, even when a valid pairing is cached', async () => {
    loadSpy.mockReturnValue(validPairing());

    await runPair([API_FLAG, BFF], { open: jest.fn() });

    expect(startSpy).toHaveBeenCalledWith(BFF, expect.objectContaining({ client_id: 'actorium-local-agent' }));
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
  });

  it('does not reprint a cached pairing instead of pairing', async () => {
    loadSpy.mockReturnValue(validPairing());

    await runPair([API_FLAG, BFF], { open: jest.fn() });

    expect(stdoutWrite).not.toHaveBeenCalledWith(expect.stringContaining('Already paired'));
  });

  it('falls through to a fresh grant when the refresh fails (e.g. revoked)', async () => {
    loadSpy.mockReturnValue(validPairing({ updatedAt: Date.now() - 7_200_000 }));
    refreshSpy.mockRejectedValue(new deviceFlow.DeviceFlowError('invalid_grant', 'invalid_grant'));

    await runPair([API_FLAG, BFF, '--handle', 'replacement']);

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

describe('browser auto-open', () => {
  let stdoutWrite: jest.SpyInstance;
  let openSpy: jest.Mock;

  beforeEach(() => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({ bffUrl: BFF });
    jest.spyOn(pairingStore, 'loadPairing').mockReturnValue(null);
    jest.spyOn(pairingStore, 'savePairing').mockImplementation(() => undefined);
    jest.spyOn(deviceFlow, 'start').mockResolvedValue(DEVICE_RESPONSE);
    jest.spyOn(deviceFlow, 'pollAndExchange').mockResolvedValue(TOKENS);
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    openSpy = jest.fn().mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens the pre-filled approval URL so the human types nothing', async () => {
    await runPair([API_FLAG, BFF], { open: openSpy });
    expect(openSpy).toHaveBeenCalledWith('https://app.example.com/device-authorize?user_code=UC-1234');
  });

  it('does not open the browser when --no-open is passed', async () => {
    await runPair([API_FLAG, BFF, '--no-open'], { open: openSpy });
    expect(openSpy).not.toHaveBeenCalled();
    // the url is still printed — that is the whole fallback
    expect(stdoutWrite).toHaveBeenCalledWith('Open https://app.example.com/device-authorize?user_code=UC-1234\n');
  });

  it('still prints the URL and code when the browser could not be opened', async () => {
    openSpy.mockReturnValue(false);
    await runPair([API_FLAG, BFF], { open: openSpy });
    expect(stdoutWrite).toHaveBeenCalledWith('Open https://app.example.com/device-authorize?user_code=UC-1234\n');
    expect(stdoutWrite).toHaveBeenCalledWith('and enter code: UC-1234\n');
    expect(stdoutWrite).not.toHaveBeenCalledWith(expect.stringContaining('Opening your browser'));
  });

  it('falls back to verification_uri when the server sends no complete URL', async () => {
    jest.spyOn(deviceFlow, 'start').mockResolvedValue({
      device_code: 'device-code-1',
      user_code: 'UC-1234',
      verification_uri: 'https://app.example.com/device-authorize',
    });
    await runPair([API_FLAG, BFF], { open: openSpy });
    expect(openSpy).toHaveBeenCalledWith('https://app.example.com/device-authorize');
  });
});

describe('openBrowser', () => {
  // Never let the suite actually launch a browser.
  const spawnMock = childProcess.spawn as unknown as jest.Mock;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: jest.fn(), unref: jest.fn() });
  });

  // A relative verification_uri is exactly the bug this guards: `open` would
  // treat it as a local path rather than a URL.
  it('refuses to open a non-absolute URL', () => {
    expect(openBrowser('/device-authorize')).toBe(false);
    expect(openBrowser('')).toBe(false);
    expect(openBrowser('javascript:alert(1)')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the platform launcher for an absolute URL', () => {
    const url = 'https://app.example.com/device-authorize?user_code=UC-1234';

    expect(openBrowser(url, 'darwin')).toBe(true);
    expect(spawnMock).toHaveBeenLastCalledWith('open', [url], expect.anything());

    expect(openBrowser(url, 'linux')).toBe(true);
    expect(spawnMock).toHaveBeenLastCalledWith('xdg-open', [url], expect.anything());

    // the empty title argument matters — without it `start` eats the url
    expect(openBrowser(url, 'win32')).toBe(true);
    expect(spawnMock).toHaveBeenLastCalledWith('cmd', ['/c', 'start', '', url], expect.anything());
  });

  it('detaches and never blocks the CLI on the launcher', () => {
    const child = { on: jest.fn(), unref: jest.fn() };
    spawnMock.mockReturnValue(child);

    openBrowser('https://app.example.com/device-authorize', 'darwin');

    expect(spawnMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { stdio: 'ignore', detached: true });
    expect(child.unref).toHaveBeenCalled();
    // a missing launcher arrives as an async 'error' event, which would be an
    // unhandled throw if nothing consumed it
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('reports false when the launcher cannot be spawned', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(openBrowser('https://app.example.com/device-authorize', 'linux')).toBe(false);
  });
});

describe('parseNoOpen', () => {
  it('detects --no-open', () => {
    expect(parseNoOpen(['--no-open'])).toBe(true);
    expect(parseNoOpen(['--handle', 'x', '--no-open'])).toBe(true);
  });

  it('is false when absent', () => {
    expect(parseNoOpen([])).toBe(false);
    expect(parseNoOpen(['--handle', 'x'])).toBe(false);
  });
});

describe('parseApiUrl', () => {
  it('parses --api-url <value> and --api-url=<value>', () => {
    expect(parseApiUrl(['--api-url', 'http://localhost:8090'])).toBe('http://localhost:8090');
    expect(parseApiUrl(['--api-url=https://api.example.com'])).toBe('https://api.example.com');
  });

  it('returns undefined when absent or dangling', () => {
    expect(parseApiUrl([])).toBeUndefined();
    expect(parseApiUrl(['--handle', 'x'])).toBeUndefined();
    expect(parseApiUrl(['--api-url', '--no-open'])).toBeUndefined();
  });
});

describe('runPair backend selection', () => {
  let stdoutWrite: jest.SpyInstance;
  let stderrWrite: jest.SpyInstance;
  let startSpy: jest.SpyInstance;
  let saveSpy: jest.SpyInstance;
  const originalApiUrl = process.env.API_URL;

  beforeEach(() => {
    delete process.env.API_URL;
    jest.spyOn(pairingStore, 'loadPairing').mockReturnValue(null);
    saveSpy = jest.spyOn(pairingStore, 'savePairing').mockImplementation(() => undefined);
    startSpy = jest.spyOn(deviceFlow, 'start').mockResolvedValue(DEVICE_RESPONSE);
    jest.spyOn(deviceFlow, 'pollAndExchange').mockResolvedValue(TOKENS);
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = originalApiUrl;
    process.exitCode = undefined;
  });

  it('pairs against the --api-url backend and names it', async () => {
    await runPair(['--api-url', 'https://api.example.com'], { open: jest.fn() });

    expect(startSpy).toHaveBeenCalledWith('https://api.example.com', expect.anything());
    // the pairing file is keyed by this url, so it must be stated
    expect(stdoutWrite).toHaveBeenCalledWith('Pairing with https://api.example.com\n');
    expect(saveSpy).toHaveBeenCalledWith('https://api.example.com', expect.anything());
  });

  // Required rather than defaulted: a silently-inferred backend is what makes a
  // pairing/server mismatch invisible until a review fails.
  it('refuses to pair when --api-url is missing', async () => {
    await runPair([], { open: jest.fn() });

    expect(startSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('--api-url is required'));
    expect(process.exitCode).toBe(1);
  });

  it('does not fall back to API_URL', async () => {
    process.env.API_URL = 'https://api.example.com';

    await runPair([], { open: jest.fn() });

    expect(startSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-absolute --api-url instead of pairing against nonsense', async () => {
    await runPair(['--api-url', 'localhost:8090'], { open: jest.fn() });

    expect(startSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('absolute http(s) url'));
    expect(process.exitCode).toBe(1);
  });
});


