import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { accountCredentialFilePath, credentialFilePath, readCredentialFile } from './authFile';

/** Independent re-derivation of the extension's filename hash (see
 * workflow-extension's credentialFile.ts) — asserted against directly so a
 * change to either side's algorithm breaks this test instead of silently
 * losing token lookups in the field. */
function expectedPath(homeDir: string, bffUrl: string): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `auth.${key}.json`);
}

function expectedAccountPath(homeDir: string, bffUrl: string, accountKey: string): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `auth.${key}.${accountKey}.json`);
}

const PROD_URL = 'https://api.actorium.ai';
const LOCAL_URL = 'http://localhost:8090';

describe('authFile', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-authfile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function writeCredsFor(bffUrl: string, creds: Record<string, unknown>): void {
    const filePath = expectedPath(tempHome, bffUrl);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(creds), 'utf8');
  }

  it('derives the same path the extension writes to for a given bffUrl', () => {
    expect(credentialFilePath(PROD_URL, tempHome)).toBe(expectedPath(tempHome, PROD_URL));
  });

  it('reads a valid credential file for the matching bffUrl', () => {
    writeCredsFor(PROD_URL, {
      accessToken: 'jwt-abc',
      orgId: 'org-1',
      workspaceId: 'ws-1',
      bffUrl: PROD_URL,
      updatedAt: 123,
    });

    expect(readCredentialFile(PROD_URL, tempHome)).toEqual({
      accessToken: 'jwt-abc',
      orgId: 'org-1',
      workspaceId: 'ws-1',
      bffUrl: PROD_URL,
      updatedAt: 123,
    });
  });

  it("a different bffUrl reads its own file, not another backend's", () => {
    writeCredsFor(PROD_URL, { accessToken: 'prod-token', updatedAt: 1 });
    writeCredsFor(LOCAL_URL, { accessToken: 'local-token', updatedAt: 2 });

    expect(readCredentialFile(PROD_URL, tempHome)?.accessToken).toBe('prod-token');
    expect(readCredentialFile(LOCAL_URL, tempHome)?.accessToken).toBe('local-token');
  });

  it('returns null when no file exists for this bffUrl, even if another backend has one', () => {
    writeCredsFor(PROD_URL, { accessToken: 'prod-token', updatedAt: 1 });

    expect(readCredentialFile(LOCAL_URL, tempHome)).toBeNull();
  });

  it('returns null on missing accessToken', () => {
    writeCredsFor(PROD_URL, { orgId: 'org-1', updatedAt: 1 });
    expect(readCredentialFile(PROD_URL, tempHome)).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', () => {
    const filePath = expectedPath(tempHome, PROD_URL);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not valid json', 'utf8');

    expect(readCredentialFile(PROD_URL, tempHome)).toBeNull();
  });

  it('returns null when the file is missing entirely', () => {
    expect(readCredentialFile(PROD_URL, tempHome)).toBeNull();
  });

  it('defaults homeDir to os.homedir() when not passed', () => {
    expect(credentialFilePath(PROD_URL)).toBe(expectedPath(os.homedir(), PROD_URL));
  });

  describe('account-scoped credential file', () => {
    const ACCOUNT_A = 'account-key-a';
    const ACCOUNT_B = 'account-key-b';

    function writeAccountCredsFor(bffUrl: string, accountKey: string, creds: Record<string, unknown>): void {
      const filePath = expectedAccountPath(tempHome, bffUrl, accountKey);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(creds), 'utf8');
    }

    it('derives the same account-scoped path the extension writes to', () => {
      expect(accountCredentialFilePath(PROD_URL, ACCOUNT_A, tempHome)).toBe(
        expectedAccountPath(tempHome, PROD_URL, ACCOUNT_A),
      );
    });

    it('reads the account-scoped file when accountKey is given and the file exists', () => {
      writeCredsFor(PROD_URL, { accessToken: 'legacy-token', updatedAt: 1 });
      writeAccountCredsFor(PROD_URL, ACCOUNT_A, { accessToken: 'account-a-token', updatedAt: 2 });

      expect(readCredentialFile(PROD_URL, tempHome, ACCOUNT_A)?.accessToken).toBe('account-a-token');
    });

    it('two accounts on the same backend read their own files, not each other\'s', () => {
      writeAccountCredsFor(PROD_URL, ACCOUNT_A, { accessToken: 'token-a', updatedAt: 1 });
      writeAccountCredsFor(PROD_URL, ACCOUNT_B, { accessToken: 'token-b', updatedAt: 2 });

      expect(readCredentialFile(PROD_URL, tempHome, ACCOUNT_A)?.accessToken).toBe('token-a');
      expect(readCredentialFile(PROD_URL, tempHome, ACCOUNT_B)?.accessToken).toBe('token-b');
    });

    it('falls back to the legacy bffUrl-only file when the account-scoped file is missing', () => {
      writeCredsFor(PROD_URL, { accessToken: 'legacy-token', updatedAt: 1 });

      expect(readCredentialFile(PROD_URL, tempHome, ACCOUNT_A)?.accessToken).toBe('legacy-token');
    });

    it('ignores accountKey entirely when not provided (back-compat, unchanged default)', () => {
      writeCredsFor(PROD_URL, { accessToken: 'legacy-token', updatedAt: 1 });
      writeAccountCredsFor(PROD_URL, ACCOUNT_A, { accessToken: 'account-a-token', updatedAt: 2 });

      expect(readCredentialFile(PROD_URL, tempHome)?.accessToken).toBe('legacy-token');
    });

    it('carries accountEmail/accountDisplayName through when present', () => {
      writeAccountCredsFor(PROD_URL, ACCOUNT_A, {
        accessToken: 'account-a-token',
        updatedAt: 2,
        accountEmail: 'dev@example.com',
        accountDisplayName: 'Dev Person',
      });

      const result = readCredentialFile(PROD_URL, tempHome, ACCOUNT_A);
      expect(result?.accountEmail).toBe('dev@example.com');
      expect(result?.accountDisplayName).toBe('Dev Person');
    });
  });
});
