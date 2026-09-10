import * as config from './config';
import { runCli } from './index';
import * as channel from './channel';
import * as server from './server';

describe('runCli', () => {
  beforeEach(() => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({ bffUrl: 'http://localhost:8090' });
    jest.spyOn(server, 'createServer').mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof server.createServer>);
    jest.spyOn(channel, 'startChannel').mockReturnValue(null);
    // the not-logged-in warning is expected in most cases here; keep it out
    // of the suite's own output (individual tests re-spy to assert on it)
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prints the version and exits without starting the MCP server on --version', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCli(['node', 'actorium-mcp', '--version']);

    expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+\n$/));
    expect(server.createServer).not.toHaveBeenCalled();
  });

  it('starts the stdio MCP server when no subcommand is given', async () => {
    await runCli(['node', 'actorium-mcp']);

    expect(server.createServer).toHaveBeenCalled();
  });

  it('starts the local-agent review channel when running the MCP server', async () => {
    await runCli(['node', 'actorium-mcp']);

    expect(channel.startChannel).toHaveBeenCalledWith(expect.any(Function));
  });

  // A WORKFLOW_TOKEN/credential file whose JWT carries no agent_participant_id
  // claim (or no token at all) is invisible here — startChannel simply finds
  // nothing and sends no presence. Without this warning the only symptom is
  // review tools failing with not_logged_in, which points at the wrong problem.
  it('warns on stderr when there is no usable login for the configured backend', async () => {
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(channel, 'startChannel').mockReturnValue(null);

    await runCli(['node', 'actorium-mcp']);

    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('not logged in for http://localhost:8090'));
    // and it tells the user how to fix it
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Log in via the Actorium VS Code extension'));
  });

  it('stays silent on stdout when not logged in (stdout is the MCP transport)', async () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(channel, 'startChannel').mockReturnValue(null);

    await runCli(['node', 'actorium-mcp']);

    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('does not warn when the channel started', async () => {
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(channel, 'startChannel').mockReturnValue({ stop: jest.fn() });

    await runCli(['node', 'actorium-mcp']);

    expect(stderrWrite).not.toHaveBeenCalled();
  });
});
