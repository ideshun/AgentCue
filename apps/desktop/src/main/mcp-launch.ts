import { existsSync } from 'node:fs';
import path from 'node:path';

export interface DesktopMcpLaunch {
  command: string;
  args: string[];
  commandReady: boolean;
}

/** @description: Build an absolute launch configuration using the desktop's bundled runtime. */
export function desktopMcpLaunch(options: {
  executablePath: string;
  appPath: string;
  isPackaged: boolean;
}): DesktopMcpLaunch {
  const command = path.resolve(options.executablePath);
  return {
    command,
    args: options.isPackaged ? ['--mcp-stdio'] : [path.resolve(options.appPath), '--mcp-stdio'],
    commandReady:
      existsSync(command) &&
      existsSync(path.join(options.appPath, 'dist/resources/mcp-stdio/stdio.js')),
  };
}
