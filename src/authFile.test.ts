import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { credentialFilePath, readCredentialFile } from './authFile';

/** Independent re-derivation of the extension's filename hash (see
 * workflow-extension's credentialFile.ts) — asserted against directly so a
 * change to either side's algorithm breaks this test instead of silently
 * losing token lookups in the field. */
function expectedPath(homeDir: string, bffUrl: string): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `auth.${key}.json`);
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
});
