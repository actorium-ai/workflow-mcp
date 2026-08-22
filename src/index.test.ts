import * as config from './config';
import { runCli } from './index';
import * as channel from './channel';
import * as pair from './pair';
import * as server from './server';

describe('runCli', () => {
  beforeEach(() => {
    jest.spyOn(pair, 'runPair').mockResolvedValue(undefined);
    jest.spyOn(config, 'loadConfig').mockReturnValue({ bffUrl: 'http://localhost:8090' });
    jest.spyOn(server, 'createServer').mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof server.createServer>);
    jest.spyOn(channel, 'startChannel').mockReturnValue(null);
    // the unpaired-backend warning is expected in most cases here; keep it out
    // of the suite's own output (individual tests re-spy to assert on it)
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches the pair subcommand to runPair and does not start the MCP server', async () => {
    await runCli(['node', 'actorium-mcp', 'pair', '--handle', 'my-handle']);

    expect(pair.runPair).toHaveBeenCalledWith(['--handle', 'my-handle']);
    expect(server.createServer).not.toHaveBeenCalled();
  });

  it('prints the version and exits without starting the MCP server on --version', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCli(['node', 'actorium-mcp', '--version']);

    expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+\n$/));
    expect(server.createServer).not.toHaveBeenCalled();
    expect(pair.runPair).not.toHaveBeenCalled();
  });

  it('starts the stdio MCP server when no subcommand is given', async () => {
    await runCli(['node', 'actorium-mcp']);

    expect(server.createServer).toHaveBeenCalled();
    expect(pair.runPair).not.toHaveBeenCalled();
  });

  it('starts the paired-agent review channel when running the MCP server', async () => {
    await runCli(['node', 'actorium-mcp']);

    expect(channel.startChannel).toHaveBeenCalledWith(
      expect.objectContaining({ bffUrl: 'http://localhost:8090' }),
    );
  });

  it('does not start the review channel for the pair subcommand', async () => {
    await runCli(['node', 'actorium-mcp', 'pair']);

    expect(channel.startChannel).not.toHaveBeenCalled();
  });
  // A pairing made against a different API_URL is invisible here — pairing
  // files are keyed by backend url, so the server simply finds nothing and
  // sends no presence. Without this warning the only symptom is the review UI
  // saying "paired but unreachable", which points at the wrong problem.
  it('warns on stderr when no pairing exists for the configured backend', async () => {
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(channel, 'startChannel').mockReturnValue(null);

    await runCli(['node', 'actorium-mcp']);

    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('no local-agent pairing found for http://localhost:8090'));
    // and it tells the user the exact command that fixes it
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('pair --api-url http://localhost:8090'));
  });

  it('stays silent on stdout when the pairing is missing (stdout is the MCP transport)', async () => {
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
  it('dispatches the pairings subcommand without starting the MCP server', async () => {
    const runPairings = jest.spyOn(pair, 'runPairings').mockImplementation(() => undefined);

    await runCli(['node', 'actorium-mcp', 'pairings']);

    expect(runPairings).toHaveBeenCalled();
    expect(server.createServer).not.toHaveBeenCalled();
    expect(channel.startChannel).not.toHaveBeenCalled();
  });
});
