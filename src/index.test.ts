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
});
