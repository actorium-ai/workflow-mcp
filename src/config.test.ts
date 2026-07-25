import { loadConfig } from './config';
import * as authFile from './authFile';
import * as workspaceManifest from './workspaceManifest';

describe('loadConfig', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    jest.spyOn(authFile, 'readCredentialFile').mockReturnValue(null);
    jest.spyOn(workspaceManifest, 'findWorkspaceManifest').mockReturnValue(null);
  });

  afterEach(() => {
    process.env = origEnv;
    jest.restoreAllMocks();
  });

  it('uses default BFF URL when API_URL is not set', () => {
    delete process.env.API_URL;
    const config = loadConfig();
    expect(config.bffUrl).toBe('http://localhost:8090');
  });

  it('uses API_URL from env when set', () => {
    process.env.API_URL = 'https://bff.example.com';
    const config = loadConfig();
    expect(config.bffUrl).toBe('https://bff.example.com');
  });

  it('returns bearerToken from WORKFLOW_TOKEN when set', () => {
    process.env.WORKFLOW_TOKEN = 'jwt-abc';
    const config = loadConfig();
    expect(config.bearerToken).toBe('jwt-abc');
  });

  it('falls back to the shared credential file when no env vars are set', () => {
    delete process.env.WORKFLOW_TOKEN;
    jest.spyOn(authFile, 'readCredentialFile').mockReturnValue({
      accessToken: 'file-token',
      workspaceId: 'ws-1',
      orgId: 'org-1',
      updatedAt: 123,
    });

    const config = loadConfig();
    expect(config.bearerToken).toBe('file-token');
    expect(config.defaultWorkspaceId).toBe('ws-1');
  });

  it('prefers the env var over the credential file when both are present', () => {
    process.env.WORKFLOW_TOKEN = 'env-token';
    jest.spyOn(authFile, 'readCredentialFile').mockReturnValue({
      accessToken: 'file-token',
      workspaceId: 'ws-1',
      updatedAt: 123,
    });

    const config = loadConfig();
    expect(config.bearerToken).toBe('env-token');
    expect(config.defaultWorkspaceId).toBeUndefined();
  });

  it('returns no bearerToken/defaultWorkspaceId when neither env nor file is present', () => {
    delete process.env.WORKFLOW_TOKEN;
    const config = loadConfig();
    expect(config.bearerToken).toBeUndefined();
    expect(config.defaultWorkspaceId).toBeUndefined();
  });

  it('the cwd-based workspace manifest wins over the credential file', () => {
    delete process.env.WORKFLOW_TOKEN;
    jest.spyOn(authFile, 'readCredentialFile').mockReturnValue({
      accessToken: 'file-token',
      workspaceId: 'ws-from-file',
      orgId: 'org-from-file',
      updatedAt: 123,
    });
    jest
      .spyOn(workspaceManifest, 'findWorkspaceManifest')
      .mockReturnValue({ workspaceId: 'ws-from-cwd', orgId: 'org-from-cwd' });

    const config = loadConfig();
    expect(config.bearerToken).toBe('file-token');
    expect(config.defaultWorkspaceId).toBe('ws-from-cwd');
    expect(config.defaultOrgId).toBe('org-from-cwd');
  });

  it('falls back to the credential file when no manifest is found in cwd', () => {
    delete process.env.WORKFLOW_TOKEN;
    jest.spyOn(authFile, 'readCredentialFile').mockReturnValue({
      accessToken: 'file-token',
      workspaceId: 'ws-from-file',
      orgId: 'org-from-file',
      updatedAt: 123,
    });

    const config = loadConfig();
    expect(config.defaultWorkspaceId).toBe('ws-from-file');
    expect(config.defaultOrgId).toBe('org-from-file');
  });

  it('the cwd-based manifest still applies even when an explicit bearer token env var is set', () => {
    process.env.WORKFLOW_TOKEN = 'env-token';
    jest
      .spyOn(workspaceManifest, 'findWorkspaceManifest')
      .mockReturnValue({ workspaceId: 'ws-from-cwd', orgId: 'org-from-cwd' });

    const config = loadConfig();
    expect(config.bearerToken).toBe('env-token');
    expect(config.defaultWorkspaceId).toBe('ws-from-cwd');
    expect(config.defaultOrgId).toBe('org-from-cwd');
  });
});
