import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findWorkspaceManifest } from './workspaceManifest';

describe('findWorkspaceManifest', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-workspace-manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeManifest(dir: string, content: unknown): void {
    const manifestDir = path.join(dir, '.actorium');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'workspace.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf8',
    );
  }

  it('finds the manifest at the starting directory itself', () => {
    writeManifest(tempDir, { workspaceId: 'ws-1', orgId: 'org-1' });
    expect(findWorkspaceManifest(tempDir)).toEqual({ workspaceId: 'ws-1', orgId: 'org-1' });
  });

  it('walks upward through nested subdirectories to find it', () => {
    writeManifest(tempDir, { workspaceId: 'ws-1', orgId: 'org-1' });
    const nested = path.join(tempDir, 'repo-a', 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });

    expect(findWorkspaceManifest(nested)).toEqual({ workspaceId: 'ws-1', orgId: 'org-1' });
  });

  it('returns null when no manifest exists anywhere above the starting directory', () => {
    const nested = path.join(tempDir, 'unrelated', 'dir');
    fs.mkdirSync(nested, { recursive: true });

    expect(findWorkspaceManifest(nested)).toBeNull();
  });

  it('returns null (not a throw) for a malformed manifest file', () => {
    writeManifest(tempDir, '{ not valid json');
    expect(findWorkspaceManifest(tempDir)).toBeNull();
  });

  it('returns null when the manifest is missing required fields', () => {
    writeManifest(tempDir, { workspaceId: 'ws-1' });
    expect(findWorkspaceManifest(tempDir)).toBeNull();
  });

  it('the nearest manifest wins over a further-up one', () => {
    writeManifest(tempDir, { workspaceId: 'outer', orgId: 'org-outer' });
    const nested = path.join(tempDir, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    writeManifest(nested, { workspaceId: 'inner', orgId: 'org-inner' });

    expect(findWorkspaceManifest(nested)).toEqual({ workspaceId: 'inner', orgId: 'org-inner' });
  });
});
