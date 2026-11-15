// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The local socket the engine connects back to. Electron's main process can't
// read a stdin pipe on Windows, so the wire runs over this in both directions.

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { posix } from "node:path";

const WINDOWS_PIPES = "\\\\.\\pipe\\";

/** A named pipe on Windows, a Unix socket in the temp folder elsewhere. */
export function enginePipePath(
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
  tag: string = randomBytes(8).toString("hex"),
  tmp: string = tmpdir(),
): string {
  const name = `safelight-engine-${pid}-${tag}`;
  return platform === "win32" ? `${WINDOWS_PIPES}${name}` : posix.join(tmp, `${name}.sock`);
}

export interface EnginePipe {
  readonly path: string;
  /** The first connection made; any later one is refused. */
  readonly connection: Promise<Socket>;
  /** Stops listening. A connection already made stays open. */
  close(): void;
}

/** Resolves once `path` is listening. */
export function listenForEngine(path: string): Promise<EnginePipe> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      server.close();
      if (!path.startsWith(WINDOWS_PIPES)) rmSync(path, { force: true });
    };
    const connection = new Promise<Socket>((accept) => {
      server.on("connection", (socket) => {
        if (closed) {
          socket.destroy();
          return;
        }
        close();
        accept(socket);
      });
    });
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.on("error", close);
      resolve({ path, connection, close });
    });
  });
}
