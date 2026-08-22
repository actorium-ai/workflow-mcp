import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { credentialFilePath } from './authFile';
import { listPairings, loadPairing, PairingCredentials, pairingPath, savePairing } from './pairingStore';

/** Independent re-derivation of the filename hash — same derivation as
 * authFile.ts (sha256 of bffUrl, first 16 hex chars) with the pairing prefix. */
function expectedPath(homeDir: string, bffUrl: string): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `pairing.${key}.json`);
}

const PROD_URL = 'https://api.actorium.ai';
const LOCAL_URL = 'http://localhost:8090';

describe('pairingStore', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-pairingstore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('pairingPath', () => {
    it('derives pairing.<sha256(bffUrl)[:16]>.json', () => {
      expect(pairingPath(PROD_URL, tempHome)).toBe(expectedPath(tempHome, PROD_URL));
    });

    it('uses a distinct filename from the extension auth file for the same backend', () => {
      expect(pairingPath(PROD_URL, tempHome)).not.toBe(credentialFilePath(PROD_URL, tempHome));
      expect(path.basename(pairingPath(PROD_URL, tempHome))).toBe(
        path.basename(expectedPath(tempHome, PROD_URL)),
      );
    });

    it('keys a different backend to a different file', () => {
      expect(pairingPath(PROD_URL, tempHome)).not.toBe(pairingPath(LOCAL_URL, tempHome));
    });

    it('defaults homeDir to os.homedir() when not passed', () => {
      expect(pairingPath(PROD_URL)).toBe(expectedPath(os.homedir(), PROD_URL));
    });
  });

  describe('savePairing / loadPairing', () => {
    it('round-trips the full credential record', () => {
      const creds = {
        accessToken: 'jwt-abc',
        refreshToken: 'refresh-xyz',
        expiresIn: 3600,
        tokenType: 'Bearer',
        handle: 'dev-agent',
        clientId: 'actorium-local-agent',
        bffUrl: PROD_URL,
        updatedAt: 123,
      };

      savePairing(PROD_URL, creds, tempHome);

      expect(loadPairing(PROD_URL, tempHome)).toEqual(creds);
    });

    it('writes the file with mode 0600', () => {
      savePairing(PROD_URL, { accessToken: 'a', refreshToken: 'r', updatedAt: 1 }, tempHome);
      const mode = fs.statSync(pairingPath(PROD_URL, tempHome)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('re-tightens an existing loose-permissioned file to 0600 on save', () => {
      const filePath = pairingPath(PROD_URL, tempHome);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{}', { mode: 0o644 });

      savePairing(PROD_URL, { accessToken: 'a', refreshToken: 'r', updatedAt: 1 }, tempHome);

      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('never writes the extension auth file', () => {
      savePairing(PROD_URL, { accessToken: 'a', refreshToken: 'r', updatedAt: 1 }, tempHome);

      expect(fs.existsSync(credentialFilePath(PROD_URL, tempHome))).toBe(false);
    });

    it('returns null when no pairing file exists', () => {
      expect(loadPairing(PROD_URL, tempHome)).toBeNull();
    });

    it('returns null on malformed JSON rather than throwing', () => {
      const filePath = pairingPath(PROD_URL, tempHome);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{not valid json', 'utf8');

      expect(loadPairing(PROD_URL, tempHome)).toBeNull();
    });

    function writePairingFile(bffUrl: string, content: unknown): void {
      const filePath = pairingPath(bffUrl, tempHome);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(content), 'utf8');
    }

    it('returns null when the refresh token is missing (not a usable pairing)', () => {
      writePairingFile(PROD_URL, { accessToken: 'a', updatedAt: 1 });

      expect(loadPairing(PROD_URL, tempHome)).toBeNull();
    });

    it('returns null when the access token is missing', () => {
      writePairingFile(PROD_URL, { refreshToken: 'r', updatedAt: 1 });

      expect(loadPairing(PROD_URL, tempHome)).toBeNull();
    });
  });
});

describe('listPairings', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-list-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function creds(bffUrl: string, handle: string, updatedAt: number): PairingCredentials {
    return {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      handle,
      clientId: 'actorium-local-agent',
      bffUrl,
      updatedAt,
    };
  }

  it('returns an empty list when nothing is paired', () => {
    expect(listPairings(tempHome)).toEqual([]);
  });

  it('returns an empty list when the directory does not exist', () => {
    expect(listPairings(path.join(tempHome, 'nope'))).toEqual([]);
  });

  // Pairings are per-backend by design; this is what makes that visible.
  it('lists one pairing per backend, newest first', () => {
    savePairing('http://localhost:8090', creds('http://localhost:8090', 'local', 1000), tempHome);
    savePairing('https://api.example.com', creds('https://api.example.com', 'prod', 3000), tempHome);
    savePairing('https://staging.example.com', creds('https://staging.example.com', 'staging', 2000), tempHome);

    const all = listPairings(tempHome);

    expect(all.map((p) => p.handle)).toEqual(['prod', 'staging', 'local']);
    expect(all.map((p) => p.bffUrl)).toEqual([
      'https://api.example.com',
      'https://staging.example.com',
      'http://localhost:8090',
    ]);
  });

  it('skips unrelated and unreadable files rather than failing the listing', () => {
    savePairing('http://localhost:8090', creds('http://localhost:8090', 'local', 1000), tempHome);
    const dir = path.join(tempHome, '.actorium');
    fs.writeFileSync(path.join(dir, 'auth.abc123.json'), '{"accessToken":"x"}');
    fs.writeFileSync(path.join(dir, 'pairing.broken.json'), 'not json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');

    const all = listPairings(tempHome);

    expect(all).toHaveLength(1);
    expect(all[0].handle).toBe('local');
  });
});
